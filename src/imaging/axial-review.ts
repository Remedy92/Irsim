export type AxialPhotometricInterpretation = "MONOCHROME1" | "MONOCHROME2";

/** A compact half-open run: [row, startColumnInclusive, endColumnExclusive]. */
export type AxialOverlayRowSpan = readonly [
  row: number,
  startColumnInclusive: number,
  endColumnExclusive: number
];

export interface AxialSeedMarker {
  row: number;
  column: number;
  radius?: number;
}

export interface AxialReviewInput {
  pixels: Int16Array;
  rows: number;
  columns: number;
  photometric: AxialPhotometricInterpretation;
  windowCenter: number;
  windowWidth: number;
  overlaySpans?: readonly AxialOverlayRowSpan[];
  seed?: Readonly<AxialSeedMarker>;
}

const OVERLAY_COLOR = [0, 196, 255] as const;
const OVERLAY_ALPHA = 0.42;
const SEED_COLOR = [255, 184, 0] as const;
const DEFAULT_SEED_RADIUS = 4;

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function validateInput(input: AxialReviewInput): void {
  if (!(input.pixels instanceof Int16Array)) {
    throw new TypeError("pixels must be an Int16Array of HU values.");
  }
  requirePositiveInteger(input.rows, "rows");
  requirePositiveInteger(input.columns, "columns");

  const pixelCount = input.rows * input.columns;
  if (!Number.isSafeInteger(pixelCount) || input.pixels.length !== pixelCount) {
    throw new RangeError("pixels length must exactly match rows times columns.");
  }
  if (input.photometric !== "MONOCHROME1" && input.photometric !== "MONOCHROME2") {
    throw new TypeError("photometric must be MONOCHROME1 or MONOCHROME2.");
  }
  if (!Number.isFinite(input.windowCenter)) {
    throw new RangeError("windowCenter must be finite.");
  }
  if (!Number.isFinite(input.windowWidth) || input.windowWidth < 1) {
    throw new RangeError("windowWidth must be finite and at least 1.");
  }

  for (const span of input.overlaySpans ?? []) {
    if (
      span.length !== 3 ||
      !Number.isInteger(span[0]) ||
      !Number.isInteger(span[1]) ||
      !Number.isInteger(span[2]) ||
      span[0] < 0 ||
      span[0] >= input.rows ||
      span[1] < 0 ||
      span[1] >= span[2] ||
      span[2] > input.columns
    ) {
      throw new RangeError("Every overlay span must be an in-bounds, non-empty half-open row run.");
    }
  }

  if (input.seed) {
    const { row, column } = input.seed;
    const radius = input.seed.radius ?? DEFAULT_SEED_RADIUS;
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      row < 0 ||
      row >= input.rows ||
      column < 0 ||
      column >= input.columns
    ) {
      throw new RangeError("seed row and column must be integer coordinates inside the image.");
    }
    requirePositiveInteger(radius, "seed radius");
  }
}

function windowToByte(value: number, center: number, width: number): number {
  const lower = center - 0.5 - (width - 1) / 2;
  if (value <= lower) return 0;

  const upper = center - 0.5 + (width - 1) / 2;
  if (value > upper) return 255;

  // Width one has no values in the interval between its equal thresholds.
  if (width === 1) return 255;
  return Math.round(((value - (center - 0.5)) / (width - 1) + 0.5) * 255);
}

function setOpaqueColor(
  output: Uint8ClampedArray,
  pixelIndex: number,
  color: readonly [number, number, number]
): void {
  const offset = pixelIndex * 4;
  output[offset] = color[0];
  output[offset + 1] = color[1];
  output[offset + 2] = color[2];
  output[offset + 3] = 255;
}

function blendOpaqueColor(
  output: Uint8ClampedArray,
  pixelIndex: number,
  color: readonly [number, number, number],
  alpha: number
): void {
  const offset = pixelIndex * 4;
  const inverseAlpha = 1 - alpha;
  output[offset] = Math.round(output[offset] * inverseAlpha + color[0] * alpha);
  output[offset + 1] = Math.round(output[offset + 1] * inverseAlpha + color[1] * alpha);
  output[offset + 2] = Math.round(output[offset + 2] * inverseAlpha + color[2] * alpha);
}

function drawSeed(
  output: Uint8ClampedArray,
  rows: number,
  columns: number,
  seed: Readonly<AxialSeedMarker>
): void {
  const radius = seed.radius ?? DEFAULT_SEED_RADIUS;
  const innerRadiusSquared = Math.max(0, radius - 0.5) ** 2;
  const outerRadiusSquared = (radius + 0.5) ** 2;

  const rowStart = Math.max(0, seed.row - radius);
  const rowEnd = Math.min(rows - 1, seed.row + radius);
  const columnStart = Math.max(0, seed.column - radius);
  const columnEnd = Math.min(columns - 1, seed.column + radius);

  for (let row = rowStart; row <= rowEnd; row++) {
    for (let column = columnStart; column <= columnEnd; column++) {
      const deltaRow = row - seed.row;
      const deltaColumn = column - seed.column;
      const distanceSquared = deltaRow * deltaRow + deltaColumn * deltaColumn;
      const onCircle = distanceSquared >= innerRadiusSquared && distanceSquared <= outerRadiusSquared;
      const onCross =
        (deltaRow === 0 && Math.abs(deltaColumn) <= radius) ||
        (deltaColumn === 0 && Math.abs(deltaRow) <= radius);
      if (onCircle || onCross) {
        setOpaqueColor(output, row * columns + column, SEED_COLOR);
      }
    }
  }
}

/**
 * Renders one axial HU plane into a full-resolution, row-major, opaque RGBA frame.
 * The function has no browser, canvas, global-state, or mutation dependencies.
 */
export function renderAxialReview(input: Readonly<AxialReviewInput>): Uint8ClampedArray {
  validateInput(input);

  const output = new Uint8ClampedArray(input.pixels.length * 4);
  const invert = input.photometric === "MONOCHROME1";
  for (let index = 0; index < input.pixels.length; index++) {
    const windowed = windowToByte(input.pixels[index], input.windowCenter, input.windowWidth);
    const displayValue = invert ? 255 - windowed : windowed;
    setOpaqueColor(output, index, [displayValue, displayValue, displayValue]);
  }

  for (const [row, startColumn, endColumn] of input.overlaySpans ?? []) {
    for (let column = startColumn; column < endColumn; column++) {
      blendOpaqueColor(output, row * input.columns + column, OVERLAY_COLOR, OVERLAY_ALPHA);
    }
  }

  if (input.seed) drawSeed(output, input.rows, input.columns, input.seed);
  return output;
}
