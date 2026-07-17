import { anatomyDocFromCenterlines, type RawCenterlineTree } from "../sim/anatomy-loader";
import { validateSimulatorReadyAnatomyDoc } from "../sim/anatomyDoc";
import type { AnatomyDoc } from "../sim/anatomyDoc";
import type { CtVolume } from "./dicom-volume";
import type {
  LocalDicomSummary,
  SegmentationBrushMode,
  VesselSegmentationSettings,
  VoxelSeed
} from "./types";

interface SliceCandidate {
  slice: number;
  row: number;
  column: number;
  seedIndex: number;
  areaMm2: number;
  radiusMm: number;
  meanHu: number;
  fill: number;
  localScore: number;
  score: number;
  previous?: SliceCandidate;
}

export type ComponentRowSpan = [row: number, firstColumn: number, lastColumn: number];

export interface SegmentedComponent {
  sliceIndex: number;
  spans: ComponentRowSpan[];
}

export interface SegmentedCenterline {
  pointsLpsMm: [number, number, number][];
  radiiMm: number[];
  voxelPoints: VoxelSeed[];
  sliceIndices: number[];
  components: SegmentedComponent[];
  seed: VoxelSeed | null;
  confidence: "low" | "medium" | "high";
  warnings: string[];
}

const MAX_CANDIDATES_PER_SLICE = 48;
const MAX_CONTINUITY_CANDIDATES_PER_SLICE = 16;

export class VesselProposalUnavailableError extends Error {
  override name = "VesselProposalUnavailableError";
}

function validateSettings(settings: VesselSegmentationSettings): void {
  if (!Number.isFinite(settings.huMin) || !Number.isFinite(settings.huMax) || settings.huMin >= settings.huMax) {
    throw new Error("Segmentation: HU minimum must be lower than HU maximum");
  }
  if (
    !Number.isFinite(settings.minAreaMm2) ||
    !Number.isFinite(settings.maxAreaMm2) ||
    settings.minAreaMm2 <= 0 ||
    settings.maxAreaMm2 <= settings.minAreaMm2
  ) {
    throw new Error("Segmentation: invalid component-area limits");
  }
  if (!Number.isFinite(settings.maxCenterJumpMm) || settings.maxCenterJumpMm <= 0) {
    throw new Error("Segmentation: maximum center jump must be positive and finite");
  }
}

function candidateSetForSlice(
  volume: CtVolume,
  sliceIndex: number,
  settings: VesselSegmentationSettings,
  requiredSeedIndex?: number,
  preferredCenters: readonly Pick<SliceCandidate, "row" | "column">[] = []
): { candidates: SliceCandidate[]; anchor?: SliceCandidate } {
  const { rows, columns, rowSpacingMm, columnSpacingMm } = volume;
  const pixels = volume.getSlice(sliceIndex).pixelsHu;
  if (
    requiredSeedIndex !== undefined &&
    (requiredSeedIndex < 0 ||
      requiredSeedIndex >= pixels.length ||
      pixels[requiredSeedIndex] < settings.huMin ||
      pixels[requiredSeedIndex] > settings.huMax)
  ) {
    throw new Error("Segmentation: seed is outside the selected HU range");
  }

  const visited = new Uint8Array(pixels.length);
  const queue = new Int32Array(pixels.length);
  const pixelArea = rowSpacingMm * columnSpacingMm;
  const candidates: SliceCandidate[] = [];
  let anchor: SliceCandidate | undefined;
  let anchorInvalidReason: string | undefined;

  for (let seedIndex = 0; seedIndex < pixels.length; seedIndex++) {
    if (visited[seedIndex]) continue;
    const hu = pixels[seedIndex];
    if (hu < settings.huMin || hu > settings.huMax) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = seedIndex;
    visited[seedIndex] = 1;
    let count = 0;
    let rowSum = 0;
    let columnSum = 0;
    let huSum = 0;
    let minRow = rows;
    let maxRow = 0;
    let minColumn = columns;
    let maxColumn = 0;
    let touchesBorder = false;
    let containsRequiredSeed = false;

    while (head < tail) {
      const index = queue[head++];
      const row = Math.floor(index / columns);
      const column = index - row * columns;
      count++;
      rowSum += row;
      columnSum += column;
      huSum += pixels[index];
      containsRequiredSeed ||= index === requiredSeedIndex;
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
      minColumn = Math.min(minColumn, column);
      maxColumn = Math.max(maxColumn, column);
      if (row === 0 || row === rows - 1 || column === 0 || column === columns - 1) touchesBorder = true;

      const neighbours = [index - 1, index + 1, index - columns, index + columns];
      for (let n = 0; n < neighbours.length; n++) {
        const next = neighbours[n];
        if (next < 0 || next >= pixels.length || visited[next]) continue;
        if (n === 0 && column === 0) continue;
        if (n === 1 && column === columns - 1) continue;
        const nextHu = pixels[next];
        if (nextHu < settings.huMin || nextHu > settings.huMax) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }

    const areaMm2 = count * pixelArea;
    const bboxArea = (maxRow - minRow + 1) * (maxColumn - minColumn + 1);
    const fill = count / Math.max(1, bboxArea);
    if (touchesBorder || areaMm2 < settings.minAreaMm2 || areaMm2 > settings.maxAreaMm2 || fill < 0.22) {
      if (containsRequiredSeed) {
        anchorInvalidReason = touchesBorder
          ? "seeded component touches the image border"
          : areaMm2 < settings.minAreaMm2
            ? "seeded component is below the minimum area"
            : areaMm2 > settings.maxAreaMm2
              ? "seeded component exceeds the maximum area"
              : "seeded component is not sufficiently compact";
      }
      continue;
    }

    const row = rowSum / count;
    const column = columnSum / count;
    const normalizedCenterDistance = Math.hypot(
      (column - columns / 2) / Math.max(1, columns / 2),
      (row - rows / 2) / Math.max(1, rows / 2)
    );
    const radiusMm = Math.sqrt(areaMm2 / Math.PI);
    const localScore =
      5 +
      Math.min(1, fill) * 2.5 +
      Math.min(2, Math.log1p(areaMm2 / Math.max(1, settings.minAreaMm2))) -
      normalizedCenterDistance * 1.8;
    const candidate: SliceCandidate = {
      slice: sliceIndex,
      row,
      column,
      seedIndex,
      areaMm2,
      radiusMm,
      meanHu: huSum / count,
      fill,
      localScore,
      score: localScore
    };
    candidates.push(candidate);
    if (containsRequiredSeed) anchor = candidate;
  }

  if (requiredSeedIndex !== undefined && !anchor) {
    throw new Error(`Segmentation: ${anchorInvalidReason ?? "seed is not inside a valid connected component"}`);
  }
  const limited = [...candidates].sort((a, b) => b.localScore - a.localScore).slice(0, MAX_CANDIDATES_PER_SLICE);
  if (preferredCenters.length > 0) {
    const continuityCandidates = candidates
      .map((candidate) => ({
        candidate,
        distance: Math.min(
          ...preferredCenters.map((center) =>
            Math.hypot(
              (candidate.row - center.row) * volume.rowSpacingMm,
              (candidate.column - center.column) * volume.columnSpacingMm
            )
          )
        )
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_CONTINUITY_CANDIDATES_PER_SLICE);
    for (const { candidate } of continuityCandidates) if (!limited.includes(candidate)) limited.push(candidate);
  }
  // A human-selected component must never disappear merely because 48 other candidates scored higher.
  if (anchor && !limited.includes(anchor)) limited.push(anchor);
  return { candidates: limited, anchor };
}

function distanceMm(a: SliceCandidate, b: SliceCandidate, volume: CtVolume): number {
  return Math.hypot(
    (a.row - b.row) * volume.rowSpacingMm,
    (a.column - b.column) * volume.columnSpacingMm,
    (a.slice - b.slice) * volume.sliceSpacingMm
  );
}

function transitionScore(
  candidate: SliceCandidate,
  previous: SliceCandidate,
  previousScore: number,
  gap: number,
  volume: CtVolume,
  settings: VesselSegmentationSettings
): number | null {
  const jump = distanceMm(candidate, previous, volume);
  const allowed = settings.maxCenterJumpMm + gap * volume.sliceSpacingMm;
  if (jump > allowed) return null;
  const radiusRatio =
    Math.max(candidate.radiusMm, previous.radiusMm) /
    Math.max(1, Math.min(candidate.radiusMm, previous.radiusMm));
  if (radiusRatio > 2.8) return null;
  return previousScore + candidate.localScore - jump * 0.14 - (gap - 1) * 4;
}

function componentSpans(
  volume: CtVolume,
  candidate: SliceCandidate,
  settings: VesselSegmentationSettings
): ComponentRowSpan[] {
  const { rows, columns } = volume;
  const pixels = volume.getSlice(candidate.slice).pixelsHu;
  const visited = new Uint8Array(pixels.length);
  const queue = new Int32Array(pixels.length);
  let head = 0;
  let tail = 0;
  queue[tail++] = candidate.seedIndex;
  visited[candidate.seedIndex] = 1;
  while (head < tail) {
    const index = queue[head++];
    const row = Math.floor(index / columns);
    const column = index - row * columns;
    const neighbours = [index - 1, index + 1, index - columns, index + columns];
    for (let n = 0; n < neighbours.length; n++) {
      const next = neighbours[n];
      if (next < 0 || next >= pixels.length || visited[next]) continue;
      if (n === 0 && column === 0) continue;
      if (n === 1 && column === columns - 1) continue;
      const hu = pixels[next];
      if (hu < settings.huMin || hu > settings.huMax) continue;
      visited[next] = 1;
      queue[tail++] = next;
    }
  }
  const spans: ComponentRowSpan[] = [];
  for (let row = 0; row < rows; row++) {
    let column = 0;
    while (column < columns) {
      while (column < columns && visited[row * columns + column] === 0) column++;
      if (column >= columns) break;
      const first = column;
      while (column + 1 < columns && visited[row * columns + column + 1] !== 0) column++;
      spans.push([row, first, column]);
      column++;
    }
  }
  return spans;
}

function finalizePath(
  volume: CtVolume,
  path: SliceCandidate[],
  settings: VesselSegmentationSettings,
  seed: VoxelSeed | null
): SegmentedCenterline {
  const minimumPath = Math.max(8, Math.ceil(volume.sliceCount * 0.08));
  if (path.length < minimumPath) {
    const message = `Segmentation: only ${path.length} coherent slices found; adjust the HU range or choose another vascular seed`;
    if (seed === null) throw new VesselProposalUnavailableError(message);
    throw new Error(message);
  }

  const firstLps = volume.voxelCenterLps(path[0].slice, path[0].row, path[0].column);
  const lastCandidate = path[path.length - 1];
  const lastLps = volume.voxelCenterLps(lastCandidate.slice, lastCandidate.row, lastCandidate.column);
  if (firstLps[2] > lastLps[2]) path.reverse();

  const smooth = (index: number, pick: (candidate: SliceCandidate) => number): number => {
    let total = 0;
    let weight = 0;
    for (let offset = -2; offset <= 2; offset++) {
      const candidate = path[index + offset];
      if (!candidate) continue;
      const w = 3 - Math.abs(offset);
      total += pick(candidate) * w;
      weight += w;
    }
    return total / weight;
  };

  const voxelPoints = path.map((candidate, index) => ({
    sliceIndex: candidate.slice,
    row: smooth(index, (item) => item.row),
    column: smooth(index, (item) => item.column)
  }));
  const pointsLpsMm = voxelPoints.map((point) =>
    volume.voxelCenterLps(point.sliceIndex, point.row, point.column)
  );
  const radiiMm = path.map((_, index) => smooth(index, (candidate) => candidate.radiusMm));
  const sliceIndices = path.map((candidate) => candidate.slice);
  const { warnings, confidence } = summarizeTrackedPath(volume, sliceIndices, seed);
  return {
    pointsLpsMm,
    radiiMm,
    voxelPoints,
    sliceIndices,
    components: path.map((candidate) => ({
      sliceIndex: candidate.slice,
      spans: componentSpans(volume, candidate, settings)
    })),
    seed,
    confidence,
    warnings
  };
}

function summarizeTrackedPath(
  volume: CtVolume,
  sliceIndices: readonly number[],
  seed: VoxelSeed | null,
  operatorWarnings: readonly string[] = []
): Pick<SegmentedCenterline, "warnings" | "confidence"> {
  const coverage = sliceIndices.length / volume.sliceCount;
  const gaps = sliceIndices.reduce((count, sliceIndex, index) => {
    if (index === 0) return 0;
    return count + (Math.abs(sliceIndex - sliceIndices[index - 1]) > 1 ? 1 : 0);
  }, 0);
  const warnings: string[] = [
    seed
      ? "Seed-confirmed threshold tracking still follows one bright tubular trunk; review every overlay slice."
      : "Automatic proposal only: place a seed on the intended vessel before loading.",
    ...operatorWarnings
  ];
  if (coverage < 0.25) warnings.push("Low slice coverage: the extracted path spans less than 25% of the series.");
  if (volume.sliceSpacingMm > 2) warnings.push("Slice spacing exceeds 2 mm; centerline and radius detail may be limited.");
  if (gaps > Math.max(1, sliceIndices.length * 0.05)) warnings.push("The extracted path contains several skipped slices.");
  return {
    warnings,
    confidence: coverage >= 0.55 && gaps <= 1 ? "high" : coverage >= 0.25 ? "medium" : "low"
  };
}

function geometryFromReviewedComponents(
  volume: CtVolume,
  components: readonly SegmentedComponent[]
): Pick<SegmentedCenterline, "pointsLpsMm" | "radiiMm" | "voxelPoints" | "sliceIndices"> {
  const raw = components.map((component) => {
    let count = 0;
    let rowSum = 0;
    let columnSum = 0;
    for (const [row, firstColumn, lastColumn] of component.spans) {
      const length = lastColumn - firstColumn + 1;
      count += length;
      rowSum += row * length;
      columnSum += ((firstColumn + lastColumn) * length) / 2;
    }
    if (count === 0) throw new Error("Segmentation: cannot retain an empty reviewed component");
    return {
      sliceIndex: component.sliceIndex,
      row: rowSum / count,
      column: columnSum / count,
      radiusMm: Math.sqrt((count * volume.rowSpacingMm * volume.columnSpacingMm) / Math.PI)
    };
  });
  const smooth = (index: number, pick: (item: (typeof raw)[number]) => number): number => {
    let total = 0;
    let weight = 0;
    for (let offset = -2; offset <= 2; offset++) {
      const item = raw[index + offset];
      if (!item) continue;
      const w = 3 - Math.abs(offset);
      total += pick(item) * w;
      weight += w;
    }
    return total / weight;
  };
  const voxelPoints = raw.map((item, index) => ({
    sliceIndex: item.sliceIndex,
    row: smooth(index, (candidate) => candidate.row),
    column: smooth(index, (candidate) => candidate.column)
  }));
  return {
    voxelPoints,
    pointsLpsMm: voxelPoints.map((point) =>
      volume.voxelCenterLps(point.sliceIndex, point.row, point.column)
    ),
    radiiMm: raw.map((_, index) => smooth(index, (candidate) => candidate.radiusMm)),
    sliceIndices: raw.map((item) => item.sliceIndex)
  };
}

export interface SegmentationBrushResult {
  segmentation: SegmentedCenterline;
  affectedSliceCount: number;
  changedVoxelCount: number;
}

function componentMask(
  component: SegmentedComponent,
  rows: number,
  columns: number
): Uint8Array {
  const mask = new Uint8Array(rows * columns);
  for (const [row, firstColumn, lastColumn] of component.spans) {
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(firstColumn) ||
      !Number.isInteger(lastColumn) ||
      row < 0 ||
      row >= rows ||
      firstColumn < 0 ||
      lastColumn >= columns ||
      firstColumn > lastColumn
    ) {
      throw new Error("Segmentation: reviewed labelmap contains an invalid voxel span");
    }
    mask.fill(1, row * columns + firstColumn, row * columns + lastColumn + 1);
  }
  return mask;
}

function spansFromMask(mask: Uint8Array, rows: number, columns: number): ComponentRowSpan[] {
  const spans: ComponentRowSpan[] = [];
  for (let row = 0; row < rows; row++) {
    let column = 0;
    while (column < columns) {
      while (column < columns && mask[row * columns + column] === 0) column++;
      if (column >= columns) break;
      const firstColumn = column;
      while (column + 1 < columns && mask[row * columns + column + 1] !== 0) column++;
      spans.push([row, firstColumn, column]);
      column++;
    }
  }
  return spans;
}

/** Apply one bounded physical sphere to the reviewed sparse labelmap without creating a second volume. */
export function applySegmentationBrush(
  volume: CtVolume,
  segmentation: SegmentedCenterline,
  center: VoxelSeed,
  mode: SegmentationBrushMode,
  radiusMm: number
): SegmentationBrushResult {
  if (mode !== "add" && mode !== "remove") {
    throw new Error("Segmentation: invalid brush mode");
  }
  if (!Number.isFinite(radiusMm) || radiusMm < 0.5 || radiusMm > 10) {
    throw new Error("Segmentation: brush radius must be between 0.5 and 10 mm");
  }
  if (
    !Number.isInteger(center.sliceIndex) ||
    !Number.isFinite(center.row) ||
    !Number.isFinite(center.column) ||
    center.sliceIndex < 0 ||
    center.sliceIndex >= volume.sliceCount ||
    center.row < 0 ||
    center.row >= volume.rows ||
    center.column < 0 ||
    center.column >= volume.columns
  ) {
    throw new Error("Segmentation: brush center is outside the CT volume");
  }
  if (!segmentation.seed) {
    throw new Error("Segmentation: a seed-confirmed trunk is required before brush editing");
  }
  if (!segmentation.components.some((component) => component.sliceIndex === center.sliceIndex)) {
    throw new Error("Segmentation: brush center must be on a tracked source slice");
  }

  const normalizedCenter: VoxelSeed = {
    sliceIndex: center.sliceIndex,
    row: Math.floor(center.row),
    column: Math.floor(center.column)
  };
  let affectedSliceCount = 0;
  let changedVoxelCount = 0;
  const components = segmentation.components.map((component) => {
    const sliceDistanceMm =
      Math.abs(component.sliceIndex - normalizedCenter.sliceIndex) * volume.sliceSpacingMm;
    if (sliceDistanceMm > radiusMm) return component;
    const inPlaneRadiusMm = Math.sqrt(Math.max(0, radiusMm * radiusMm - sliceDistanceMm * sliceDistanceMm));
    const rowRadius = inPlaneRadiusMm / volume.rowSpacingMm;
    const columnRadius = inPlaneRadiusMm / volume.columnSpacingMm;
    const firstRow = Math.max(0, Math.floor(normalizedCenter.row - rowRadius));
    const lastRow = Math.min(volume.rows - 1, Math.ceil(normalizedCenter.row + rowRadius));
    const firstColumn = Math.max(0, Math.floor(normalizedCenter.column - columnRadius));
    const lastColumn = Math.min(volume.columns - 1, Math.ceil(normalizedCenter.column + columnRadius));
    const mask = componentMask(component, volume.rows, volume.columns);
    let sliceChanged = 0;
    for (let row = firstRow; row <= lastRow; row++) {
      const rowDistanceMm = (row - normalizedCenter.row) * volume.rowSpacingMm;
      for (let column = firstColumn; column <= lastColumn; column++) {
        const columnDistanceMm = (column - normalizedCenter.column) * volume.columnSpacingMm;
        if (
          sliceDistanceMm * sliceDistanceMm +
            rowDistanceMm * rowDistanceMm +
            columnDistanceMm * columnDistanceMm >
          radiusMm * radiusMm + 1e-9
        ) continue;
        const index = row * volume.columns + column;
        const next = mode === "add" ? 1 : 0;
        if (mask[index] === next) continue;
        mask[index] = next;
        sliceChanged++;
      }
    }
    if (sliceChanged === 0) return component;
    if (
      component.sliceIndex === segmentation.seed!.sliceIndex &&
      mask[Math.floor(segmentation.seed!.row) * volume.columns + Math.floor(segmentation.seed!.column)] === 0
    ) {
      throw new Error("Segmentation: brush removal would erase the confirmed vascular seed");
    }
    const spans = spansFromMask(mask, volume.rows, volume.columns);
    if (spans.length === 0) {
      throw new Error("Segmentation: brush removal would erase an entire tracked source-slice component");
    }
    affectedSliceCount++;
    changedVoxelCount += sliceChanged;
    return { sliceIndex: component.sliceIndex, spans };
  });
  if (changedVoxelCount === 0) {
    throw new Error(`Segmentation: ${mode} brush does not change the reviewed labelmap`);
  }

  const geometry = geometryFromReviewedComponents(volume, components);
  const evidence = summarizeTrackedPath(volume, geometry.sliceIndices, segmentation.seed, [
    `Operator ${mode === "add" ? "added" : "removed"} ${changedVoxelCount} reviewed voxel(s) with a ${radiusMm.toFixed(1)} mm 3D brush across ${affectedSliceCount} tracked slice(s).`
  ]);
  return {
    segmentation: {
      ...segmentation,
      ...geometry,
      components,
      warnings: evidence.warnings,
      confidence: evidence.confidence
    },
    affectedSliceCount,
    changedVoxelCount
  };
}

/** Retain one acquisition-slice range around the original seed and recompute reviewed geometry. */
export function trimSegmentedCenterline(
  volume: CtVolume,
  segmentation: SegmentedCenterline,
  sliceIndex: number,
  side: "before" | "after"
): SegmentedCenterline {
  if (side !== "before" && side !== "after") {
    throw new Error("Segmentation: invalid trim side");
  }
  if (!Number.isInteger(sliceIndex) || sliceIndex < 0 || sliceIndex >= volume.sliceCount) {
    throw new Error("Segmentation: trim boundary is outside the CT volume");
  }
  if (!segmentation.seed) throw new Error("Segmentation: a seed-confirmed trunk is required before trimming");
  if (!segmentation.components.some((component) => component.sliceIndex === sliceIndex)) {
    throw new Error("Segmentation: trim boundary must be a tracked source slice");
  }
  if (side === "before" && sliceIndex > segmentation.seed.sliceIndex) {
    throw new Error("Segmentation: trimming before this slice would remove the confirmed seed");
  }
  if (side === "after" && sliceIndex < segmentation.seed.sliceIndex) {
    throw new Error("Segmentation: trimming after this slice would remove the confirmed seed");
  }
  const currentMin = Math.min(...segmentation.sliceIndices);
  const currentMax = Math.max(...segmentation.sliceIndices);
  if ((side === "before" && sliceIndex === currentMin) || (side === "after" && sliceIndex === currentMax)) {
    throw new Error("Segmentation: trim boundary does not remove any tracked slices");
  }
  const components = segmentation.components.filter((component) =>
    side === "before" ? component.sliceIndex >= sliceIndex : component.sliceIndex <= sliceIndex
  );
  const minimumPath = Math.max(8, Math.ceil(volume.sliceCount * 0.08));
  if (components.length < minimumPath) {
    throw new Error(`Segmentation: trimming would retain only ${components.length} slices; keep a longer reviewed trunk`);
  }
  const geometry = geometryFromReviewedComponents(volume, components);
  const retainedMin = Math.min(...geometry.sliceIndices);
  const retainedMax = Math.max(...geometry.sliceIndices);
  const evidence = summarizeTrackedPath(volume, geometry.sliceIndices, segmentation.seed, [
    `Operator-trimmed scope: only tracked source slices ${retainedMin + 1}–${retainedMax + 1} are retained.`
  ]);
  return {
    ...segmentation,
    ...geometry,
    components,
    warnings: evidence.warnings,
    confidence: evidence.confidence
  };
}

/** Build the automatic proposal shown before the operator places a seed. */
export function segmentAorticCenterline(
  volume: CtVolume,
  settings: VesselSegmentationSettings,
  onSlice?: (completed: number, total: number) => void
): SegmentedCenterline {
  validateSettings(settings);
  const bySlice: SliceCandidate[][] = [];
  let best: SliceCandidate | undefined;
  for (let slice = 0; slice < volume.sliceCount; slice++) {
    const current = candidateSetForSlice(volume, slice, settings).candidates;
    bySlice.push(current);
    for (const candidate of current) {
      for (let gap = 1; gap <= 2; gap++) {
        for (const previous of bySlice[slice - gap] ?? []) {
          const score = transitionScore(candidate, previous, previous.score, gap, volume, settings);
          if (score !== null && score > candidate.score) {
            candidate.score = score;
            candidate.previous = previous;
          }
        }
      }
      if (!best || candidate.score > best.score) best = candidate;
    }
    onSlice?.(slice + 1, volume.sliceCount);
  }
  if (!best) {
    throw new VesselProposalUnavailableError(
      "Segmentation: no contrast-enhanced tubular structure found in the selected HU range"
    );
  }
  const path: SliceCandidate[] = [];
  for (let cursor: SliceCandidate | undefined = best; cursor; cursor = cursor.previous) path.push(cursor);
  path.reverse();
  return finalizePath(volume, path, settings, null);
}

interface TrackState {
  candidate: SliceCandidate;
  score: number;
  previous?: TrackState;
}

function anchoredHalf(
  bySlice: SliceCandidate[][],
  anchor: SliceCandidate,
  direction: -1 | 1,
  volume: CtVolume,
  settings: VesselSegmentationSettings
): SliceCandidate[] {
  const statesBySlice: Map<SliceCandidate, TrackState>[] = Array.from(
    { length: bySlice.length },
    () => new Map()
  );
  const anchorState: TrackState = { candidate: anchor, score: anchor.localScore };
  statesBySlice[anchor.slice].set(anchor, anchorState);
  let best = anchorState;
  for (
    let slice = anchor.slice + direction;
    slice >= 0 && slice < bySlice.length;
    slice += direction
  ) {
    for (const candidate of bySlice[slice]) {
      let state: TrackState | undefined;
      for (let gap = 1; gap <= 2; gap++) {
        const priorSlice = slice - direction * gap;
        if (priorSlice < 0 || priorSlice >= bySlice.length) continue;
        for (const prior of statesBySlice[priorSlice].values()) {
          const score = transitionScore(candidate, prior.candidate, prior.score, gap, volume, settings);
          if (score !== null && (!state || score > state.score)) state = { candidate, score, previous: prior };
        }
      }
      if (state) {
        statesBySlice[slice].set(candidate, state);
        if (state.score > best.score) best = state;
      }
    }
  }
  const half: SliceCandidate[] = [];
  for (let state: TrackState | undefined = best; state; state = state.previous) half.push(state.candidate);
  if (direction === 1) half.reverse();
  return half;
}

/** Track a connected tubular path in both directions from an explicit operator-selected component. */
export function segmentAorticCenterlineFromSeed(
  volume: CtVolume,
  settings: VesselSegmentationSettings,
  seed: VoxelSeed,
  onSlice?: (completed: number, total: number) => void
): SegmentedCenterline {
  validateSettings(settings);
  if (
    !Number.isInteger(seed.sliceIndex) ||
    !Number.isFinite(seed.row) ||
    !Number.isFinite(seed.column) ||
    seed.sliceIndex < 0 ||
    seed.sliceIndex >= volume.sliceCount ||
    seed.row < 0 ||
    seed.row >= volume.rows ||
    seed.column < 0 ||
    seed.column >= volume.columns
  ) {
    throw new Error("Segmentation: seed is outside the CT volume");
  }
  const row = Math.floor(seed.row);
  const column = Math.floor(seed.column);
  const normalizedSeed: VoxelSeed = { sliceIndex: seed.sliceIndex, row, column };
  const requiredSeedIndex = row * volume.columns + column;
  const bySlice: SliceCandidate[][] = Array.from({ length: volume.sliceCount }, () => []);
  const anchorSet = candidateSetForSlice(volume, seed.sliceIndex, settings, requiredSeedIndex);
  bySlice[seed.sliceIndex] = anchorSet.candidates;
  const anchor = anchorSet.anchor;
  let completed = 1;
  onSlice?.(completed, volume.sliceCount);
  if (!anchor) throw new Error("Segmentation: seeded component could not be resolved");
  for (const direction of [-1, 1] as const) {
    for (
      let slice = seed.sliceIndex + direction;
      slice >= 0 && slice < volume.sliceCount;
      slice += direction
    ) {
      const preferred = [
        ...(bySlice[slice - direction] ?? []),
        ...(bySlice[slice - direction * 2] ?? [])
      ];
      bySlice[slice] = candidateSetForSlice(volume, slice, settings, undefined, preferred).candidates;
      completed++;
      onSlice?.(completed, volume.sliceCount);
    }
  }
  const backward = anchoredHalf(bySlice, anchor, -1, volume, settings);
  const forward = anchoredHalf(bySlice, anchor, 1, volume, settings);
  const path = [...backward.slice(0, -1), ...forward];
  return finalizePath(volume, path, settings, normalizedSeed);
}

/** Replace one reviewed sparse-labelmap slice with the threshold-connected component at a new seed. */
export function replaceSegmentedSliceComponent(
  volume: CtVolume,
  segmentation: SegmentedCenterline,
  settings: VesselSegmentationSettings,
  seed: VoxelSeed
): SegmentedCenterline {
  validateSettings(settings);
  if (
    !Number.isInteger(seed.sliceIndex) ||
    !Number.isFinite(seed.row) ||
    !Number.isFinite(seed.column) ||
    seed.sliceIndex < 0 ||
    seed.sliceIndex >= volume.sliceCount ||
    seed.row < 0 ||
    seed.row >= volume.rows ||
    seed.column < 0 ||
    seed.column >= volume.columns
  ) {
    throw new Error("Segmentation: edit seed is outside the CT volume");
  }
  const index = segmentation.voxelPoints.findIndex((point) => point.sliceIndex === seed.sliceIndex);
  if (index < 0) {
    throw new Error("Segmentation: this source slice is outside the tracked trunk; re-track from a new seed instead");
  }
  const row = Math.floor(seed.row);
  const column = Math.floor(seed.column);
  const requiredSeedIndex = row * volume.columns + column;
  const replacement = candidateSetForSlice(volume, seed.sliceIndex, settings, requiredSeedIndex).anchor;
  if (!replacement) throw new Error("Segmentation: edited component could not be resolved");
  const replacementPoint: VoxelSeed = {
    sliceIndex: seed.sliceIndex,
    row: replacement.row,
    column: replacement.column
  };
  return {
    ...segmentation,
    pointsLpsMm: segmentation.pointsLpsMm.map((point, pointIndex) =>
      pointIndex === index
        ? volume.voxelCenterLps(replacement.slice, replacement.row, replacement.column)
        : point
    ),
    radiiMm: segmentation.radiiMm.map((radius, radiusIndex) =>
      radiusIndex === index ? replacement.radiusMm : radius
    ),
    voxelPoints: segmentation.voxelPoints.map((point, pointIndex) =>
      pointIndex === index ? replacementPoint : point
    ),
    components: segmentation.components.map((component) =>
      component.sliceIndex === seed.sliceIndex
        ? { sliceIndex: seed.sliceIndex, spans: componentSpans(volume, replacement, settings) }
        : component
    )
  };
}

function lpsToSimulator(point: [number, number, number]): [number, number, number] {
  return [point[0] / 10, point[2] / 10, -point[1] / 10];
}

/** Convert transient PHI-bearing geometry into an identifier-free in-memory simulator document. */
export function centerlineToLocalAnatomy(segmentation: SegmentedCenterline): AnatomyDoc {
  const simulatorPoints = segmentation.pointsLpsMm.map(lpsToSimulator);
  const centerX = simulatorPoints.reduce((sum, point) => sum + point[0], 0) / simulatorPoints.length;
  const centerZ = simulatorPoints.reduce((sum, point) => sum + point[2], 0) / simulatorPoints.length;
  const minY = Math.min(...simulatorPoints.map((point) => point[1]));
  for (const point of simulatorPoints) {
    point[0] -= centerX;
    point[1] -= minY;
    point[2] -= centerZ;
  }
  const first = simulatorPoints[0];
  const second = simulatorPoints[Math.min(1, simulatorPoints.length - 1)];
  const direction: [number, number, number] = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
  const directionLength = Math.hypot(...direction) || 1;
  direction[0] /= directionLength;
  direction[1] /= directionLength;
  direction[2] /= directionLength;
  const last = simulatorPoints[simulatorPoints.length - 1];
  const tree: RawCenterlineTree = {
    id: `local-dicom-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    name: "Local DICOM anatomy",
    branches: [
      {
        id: "segmented_trunk",
        name: "Seeded vascular trunk",
        points: simulatorPoints,
        radii: segmentation.radiiMm.map((radius) => Math.max(0.12, Math.min(3.5, radius / 10))),
        attenuation: 0.75
      }
    ],
    access: [{ id: "local_access", name: "Inferior access", onBranch: "segmented_trunk", at: "start", dir: direction }],
    targets: [
      {
        id: "local_target",
        name: "Superior target",
        via: "segmented_trunk",
        pos: last,
        acceptance: Math.max(0.35, Math.min(1.5, segmentation.radiiMm.at(-1)! / 10))
      }
    ],
    provenance: {
      source: "Processed locally from operator-selected DICOM CT slices",
      license: "User-supplied; not redistributed by IRsim",
      note:
        "Session-only derived geometry. No patient, study, series, file or DICOM identifiers are retained. " +
        "Operator-seeded single-trunk threshold segmentation; not validated for diagnosis or clinical decisions."
    }
  };
  return validateSimulatorReadyAnatomyDoc(anatomyDocFromCenterlines(tree));
}

export function buildLocalDicomSummary(
  volume: CtVolume,
  segmentation: SegmentedCenterline,
  inputFileCount: number,
  settings: VesselSegmentationSettings,
  decodeFailures: number
): LocalDicomSummary {
  const warnings = [...segmentation.warnings];
  if (decodeFailures > 0) warnings.push(`${decodeFailures} selected file(s) were not usable CT slices.`);
  return {
    inputFileCount,
    selectedSliceCount: volume.sliceCount,
    ignoredFileCount: decodeFailures,
    dimensions: [volume.columns, volume.rows, volume.sliceCount],
    spacingMm: [volume.columnSpacingMm, volume.rowSpacingMm, volume.sliceSpacingMm],
    segmentedSliceCount: segmentation.pointsLpsMm.length,
    coveragePercent: (segmentation.pointsLpsMm.length / volume.sliceCount) * 100,
    confidence: segmentation.confidence,
    warnings,
    settings: { ...settings },
    segmentationOverlayAvailable: true,
    suggestedSliceIndex:
      segmentation.sliceIndices[Math.floor(segmentation.sliceIndices.length / 2)] ??
      Math.floor(volume.sliceCount / 2)
  };
}

export function buildSourceReviewSummary(
  volume: CtVolume,
  inputFileCount: number,
  settings: VesselSegmentationSettings,
  decodeFailures: number
): LocalDicomSummary {
  const warnings = ["No automatic proposal was available; place a seed on the intended contrast-filled vessel."];
  if (decodeFailures > 0) warnings.push(`${decodeFailures} selected file(s) were not usable CT slices.`);
  return {
    inputFileCount,
    selectedSliceCount: volume.sliceCount,
    ignoredFileCount: decodeFailures,
    dimensions: [volume.columns, volume.rows, volume.sliceCount],
    spacingMm: [volume.columnSpacingMm, volume.rowSpacingMm, volume.sliceSpacingMm],
    segmentedSliceCount: 0,
    coveragePercent: 0,
    confidence: "low",
    warnings,
    settings: { ...settings },
    segmentationOverlayAvailable: false,
    suggestedSliceIndex: Math.floor(volume.sliceCount / 2)
  };
}
