import { renderAxialReview, type AxialOverlayRowSpan } from "./axial-review";
import type { CtSliceView, CtVolume } from "./dicom-volume";
import type {
  PatientMprLocator,
  PatientMprReviewPlane,
  PatientOrientationLabels,
  SourceReviewFrame,
  VoxelSeed
} from "./types";
import type { SegmentedCenterline } from "./vessel-segmentation";

const MAX_MPR_DIMENSION = 2048;

type Point3 = readonly [number, number, number];

interface AxisGrid {
  start: number;
  count: number;
}

interface PatientBounds {
  minimum: [number, number, number];
  maximum: [number, number, number];
}

interface PatientGrid {
  bounds: PatientBounds;
  spacingMm: number;
  x: AxisGrid;
  y: AxisGrid;
  z: AxisGrid;
}

interface PlaneDefinition {
  horizontalAxis: 0 | 1 | 2;
  verticalAxis: 0 | 1 | 2;
  planeAxis: 0 | 1 | 2;
  horizontalDirection: 1 | -1;
  verticalDirection: 1 | -1;
  labels: PatientOrientationLabels;
}

export interface PatientMprFrameMapping {
  plane: PatientMprReviewPlane;
  planeIndex: number;
  planeCount: number;
  width: number;
  height: number;
  spacingMm: number;
  originLps: [number, number, number];
  horizontalDirectionLps: [number, number, number];
  verticalDirectionLps: [number, number, number];
}

export interface RenderPatientMprRequest {
  plane: PatientMprReviewPlane;
  locator: PatientMprLocator;
  windowCenterHu: number;
  windowWidthHu: number;
  previewSeed?: VoxelSeed;
}

export interface RenderedPatientMpr {
  frame: Omit<SourceReviewFrame, "frameToken">;
  mapping: PatientMprFrameMapping;
}

interface ContinuousSourceCoordinate {
  lowSliceIndex: number;
  highSliceIndex: number;
  sliceFraction: number;
  row: number;
  column: number;
}

function dot(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function addScaled(target: [number, number, number], direction: Point3, scale: number): void {
  target[0] += direction[0] * scale;
  target[1] += direction[1] * scale;
  target[2] += direction[2] * scale;
}

function axisVector(axis: 0 | 1 | 2, direction: 1 | -1): [number, number, number] {
  const vector: [number, number, number] = [0, 0, 0];
  vector[axis] = direction;
  return vector;
}

function planeDefinition(plane: PatientMprReviewPlane): PlaneDefinition {
  switch (plane) {
    case "patient-axial":
      return {
        horizontalAxis: 0,
        verticalAxis: 1,
        planeAxis: 2,
        horizontalDirection: 1,
        verticalDirection: 1,
        labels: { top: "A", bottom: "P", left: "R", right: "L" }
      };
    case "patient-coronal":
      return {
        horizontalAxis: 0,
        verticalAxis: 2,
        planeAxis: 1,
        horizontalDirection: 1,
        verticalDirection: -1,
        labels: { top: "H", bottom: "F", left: "R", right: "L" }
      };
    case "patient-sagittal":
      return {
        horizontalAxis: 1,
        verticalAxis: 2,
        planeAxis: 0,
        horizontalDirection: 1,
        verticalDirection: -1,
        labels: { top: "H", bottom: "F", left: "A", right: "P" }
      };
    default:
      throw new Error("DICOM review: unsupported patient MPR plane");
  }
}

function slicePositions(volume: CtVolume): number[] {
  return Array.from({ length: volume.sliceCount }, (_, sliceIndex) =>
    dot(volume.getSlice(sliceIndex).imagePositionLps, volume.normalDirectionLps)
  );
}

/** Include the physical half-voxel/slab extents of every accepted source slice. */
function patientBounds(volume: CtVolume): PatientBounds {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const positions = slicePositions(volume);
  for (let sliceIndex = 0; sliceIndex < volume.sliceCount; sliceIndex++) {
    const origin = volume.getSlice(sliceIndex).imagePositionLps;
    const lowerSliceExtent =
      sliceIndex === 0
        ? (positions[1] - positions[0]) / 2
        : (positions[sliceIndex] - positions[sliceIndex - 1]) / 2;
    const upperSliceExtent =
      sliceIndex === volume.sliceCount - 1
        ? (positions.at(-1)! - positions.at(-2)!) / 2
        : (positions[sliceIndex + 1] - positions[sliceIndex]) / 2;
    for (const column of [-0.5, volume.columns - 0.5]) {
      for (const row of [-0.5, volume.rows - 0.5]) {
        for (const normalOffset of [-lowerSliceExtent, upperSliceExtent]) {
          const point: [number, number, number] = [...origin];
          addScaled(point, volume.rowDirectionLps, column * volume.columnSpacingMm);
          addScaled(point, volume.columnDirectionLps, row * volume.rowSpacingMm);
          addScaled(point, volume.normalDirectionLps, normalOffset);
          for (let axis = 0; axis < 3; axis++) {
            minimum[axis] = Math.min(minimum[axis], point[axis]);
            maximum[axis] = Math.max(maximum[axis], point[axis]);
          }
        }
      }
    }
  }
  return { minimum, maximum };
}

function paddedGrid(minimum: number, maximum: number, spacingMm: number): AxisGrid {
  const span = maximum - minimum;
  const count = Math.min(MAX_MPR_DIMENSION, Math.max(2, Math.ceil(span / spacingMm)));
  const centerSpan = Math.max(0, span - spacingMm);
  const padding = Math.max(0, ((count - 1) * spacingMm - centerSpan) / 2);
  return { start: minimum + spacingMm / 2 - padding, count };
}

function patientGrid(volume: CtVolume): PatientGrid {
  const bounds = patientBounds(volume);
  const maximumSpan = Math.max(
    bounds.maximum[0] - bounds.minimum[0],
    bounds.maximum[1] - bounds.minimum[1],
    bounds.maximum[2] - bounds.minimum[2]
  );
  const spacingMm = Math.max(
    Math.min(volume.rowSpacingMm, volume.columnSpacingMm, volume.sliceSpacingMm),
    maximumSpan / (MAX_MPR_DIMENSION - 1)
  );
  return {
    bounds,
    spacingMm,
    x: paddedGrid(bounds.minimum[0], bounds.maximum[0], spacingMm),
    y: paddedGrid(bounds.minimum[1], bounds.maximum[1], spacingMm),
    z: paddedGrid(bounds.minimum[2], bounds.maximum[2], spacingMm)
  };
}

function gridForAxis(grid: PatientGrid, axis: 0 | 1 | 2): AxisGrid {
  return axis === 0 ? grid.x : axis === 1 ? grid.y : grid.z;
}

function coordinateAt(grid: AxisGrid, spacingMm: number, index: number, direction: 1 | -1): number {
  return direction === 1
    ? grid.start + index * spacingMm
    : grid.start + (grid.count - 1 - index) * spacingMm;
}

function closestGridIndex(grid: AxisGrid, spacingMm: number, coordinate: number): number {
  return Math.max(0, Math.min(grid.count - 1, Math.round((coordinate - grid.start) / spacingMm)));
}

class CanonicalVolumeSampler {
  private readonly slices: CtSliceView[];
  private readonly positions: number[];

  constructor(private readonly volume: CtVolume) {
    this.slices = Array.from({ length: volume.sliceCount }, (_, index) => volume.getSlice(index));
    this.positions = this.slices.map((slice) => dot(slice.imagePositionLps, volume.normalDirectionLps));
  }

  sampleLinearHu(point: Point3): number | null {
    const source = this.continuousCoordinate(point);
    if (!source) return null;
    const low = this.sampleBilinear(this.slices[source.lowSliceIndex], source.row, source.column);
    const high = this.sampleBilinear(this.slices[source.highSliceIndex], source.row, source.column);
    return low + (high - low) * source.sliceFraction;
  }

  nearestVoxel(point: Point3): VoxelSeed | null {
    const source = this.continuousCoordinate(point);
    if (!source) return null;
    const candidates = [...new Set([source.lowSliceIndex, source.highSliceIndex])]
      .map((sliceIndex) => this.nearestVoxelOnSlice(point, sliceIndex))
      .filter((candidate): candidate is { voxel: VoxelSeed; distanceSquared: number } => Boolean(candidate));
    candidates.sort((left, right) => left.distanceSquared - right.distanceSquared);
    return candidates[0]?.voxel ?? null;
  }

  private continuousCoordinate(point: Point3): ContinuousSourceCoordinate | null {
    const pointPosition = dot(point, this.volume.normalDirectionLps);
    const firstSpacing = this.positions[1] - this.positions[0];
    const lastSpacing = this.positions.at(-1)! - this.positions.at(-2)!;
    if (
      pointPosition < this.positions[0] - firstSpacing / 2 ||
      pointPosition > this.positions.at(-1)! + lastSpacing / 2
    ) {
      return null;
    }

    let lowSliceIndex = 0;
    let highSliceIndex = 0;
    let sliceFraction = 0;
    if (pointPosition >= this.positions.at(-1)!) {
      lowSliceIndex = this.positions.length - 1;
      highSliceIndex = lowSliceIndex;
    } else if (pointPosition > this.positions[0]) {
      let low = 0;
      let high = this.positions.length - 1;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (this.positions[middle] <= pointPosition) low = middle;
        else high = middle;
      }
      lowSliceIndex = low;
      highSliceIndex = high;
      sliceFraction =
        (pointPosition - this.positions[low]) / (this.positions[high] - this.positions[low]);
    }

    const lowOrigin = this.slices[lowSliceIndex].imagePositionLps;
    const highOrigin = this.slices[highSliceIndex].imagePositionLps;
    const origin: [number, number, number] = [
      lowOrigin[0] + (highOrigin[0] - lowOrigin[0]) * sliceFraction,
      lowOrigin[1] + (highOrigin[1] - lowOrigin[1]) * sliceFraction,
      lowOrigin[2] + (highOrigin[2] - lowOrigin[2]) * sliceFraction
    ];
    const relative: [number, number, number] = [
      point[0] - origin[0],
      point[1] - origin[1],
      point[2] - origin[2]
    ];
    const row = dot(relative, this.volume.columnDirectionLps) / this.volume.rowSpacingMm;
    const column = dot(relative, this.volume.rowDirectionLps) / this.volume.columnSpacingMm;
    if (
      row < -0.5 ||
      row > this.volume.rows - 0.5 ||
      column < -0.5 ||
      column > this.volume.columns - 0.5
    ) {
      return null;
    }
    return { lowSliceIndex, highSliceIndex, sliceFraction, row, column };
  }

  private sampleBilinear(slice: CtSliceView, sourceRow: number, sourceColumn: number): number {
    const row = Math.max(0, Math.min(this.volume.rows - 1, sourceRow));
    const column = Math.max(0, Math.min(this.volume.columns - 1, sourceColumn));
    const firstRow = Math.floor(row);
    const lastRow = Math.min(this.volume.rows - 1, firstRow + 1);
    const firstColumn = Math.floor(column);
    const lastColumn = Math.min(this.volume.columns - 1, firstColumn + 1);
    const rowFraction = row - firstRow;
    const columnFraction = column - firstColumn;
    const pixels = slice.pixelsHu;
    const topLeft = pixels[firstRow * this.volume.columns + firstColumn];
    const topRight = pixels[firstRow * this.volume.columns + lastColumn];
    const bottomLeft = pixels[lastRow * this.volume.columns + firstColumn];
    const bottomRight = pixels[lastRow * this.volume.columns + lastColumn];
    const top = topLeft + (topRight - topLeft) * columnFraction;
    const bottom = bottomLeft + (bottomRight - bottomLeft) * columnFraction;
    return top + (bottom - top) * rowFraction;
  }

  private nearestVoxelOnSlice(
    point: Point3,
    sliceIndex: number
  ): { voxel: VoxelSeed; distanceSquared: number } | null {
    const origin = this.slices[sliceIndex].imagePositionLps;
    const relative: [number, number, number] = [
      point[0] - origin[0],
      point[1] - origin[1],
      point[2] - origin[2]
    ];
    const sourceRow = dot(relative, this.volume.columnDirectionLps) / this.volume.rowSpacingMm;
    const sourceColumn = dot(relative, this.volume.rowDirectionLps) / this.volume.columnSpacingMm;
    if (
      sourceRow < -0.5 ||
      sourceRow > this.volume.rows - 0.5 ||
      sourceColumn < -0.5 ||
      sourceColumn > this.volume.columns - 0.5
    ) {
      return null;
    }
    const row = Math.max(0, Math.min(this.volume.rows - 1, Math.round(sourceRow)));
    const column = Math.max(0, Math.min(this.volume.columns - 1, Math.round(sourceColumn)));
    const center: [number, number, number] = [...origin];
    addScaled(center, this.volume.rowDirectionLps, column * this.volume.columnSpacingMm);
    addScaled(center, this.volume.columnDirectionLps, row * this.volume.rowSpacingMm);
    return {
      voxel: { sliceIndex, row, column },
      distanceSquared:
        (point[0] - center[0]) ** 2 +
        (point[1] - center[1]) ** 2 +
        (point[2] - center[2]) ** 2
    };
  }
}

function planeMapping(
  grid: PatientGrid,
  plane: PatientMprReviewPlane,
  planeIndex: number
): PatientMprFrameMapping {
  const definition = planeDefinition(plane);
  const horizontalGrid = gridForAxis(grid, definition.horizontalAxis);
  const verticalGrid = gridForAxis(grid, definition.verticalAxis);
  const planeGrid = gridForAxis(grid, definition.planeAxis);
  const originLps: [number, number, number] = [0, 0, 0];
  originLps[definition.horizontalAxis] = coordinateAt(
    horizontalGrid,
    grid.spacingMm,
    0,
    definition.horizontalDirection
  );
  originLps[definition.verticalAxis] = coordinateAt(
    verticalGrid,
    grid.spacingMm,
    0,
    definition.verticalDirection
  );
  originLps[definition.planeAxis] = coordinateAt(planeGrid, grid.spacingMm, planeIndex, 1);
  return {
    plane,
    planeIndex,
    planeCount: planeGrid.count,
    width: horizontalGrid.count,
    height: verticalGrid.count,
    spacingMm: grid.spacingMm,
    originLps,
    horizontalDirectionLps: axisVector(definition.horizontalAxis, definition.horizontalDirection),
    verticalDirectionLps: axisVector(definition.verticalAxis, definition.verticalDirection)
  };
}

function pointAt(mapping: PatientMprFrameMapping, imageRow: number, imageColumn: number): [number, number, number] {
  const point: [number, number, number] = [...mapping.originLps];
  addScaled(point, mapping.horizontalDirectionLps, imageColumn * mapping.spacingMm);
  addScaled(point, mapping.verticalDirectionLps, imageRow * mapping.spacingMm);
  return point;
}

function selectedPlaneIndex(
  volume: CtVolume,
  grid: PatientGrid,
  plane: PatientMprReviewPlane,
  locator: PatientMprLocator
): number {
  const definition = planeDefinition(plane);
  const planeGrid = gridForAxis(grid, definition.planeAxis);
  if (locator.kind === "center") return Math.floor((planeGrid.count - 1) / 2);
  if (locator.kind === "through-voxel") {
    const point = volume.voxelCenterLps(locator.voxel.sliceIndex, locator.voxel.row, locator.voxel.column);
    return closestGridIndex(planeGrid, grid.spacingMm, point[definition.planeAxis]);
  }
  if (
    !Number.isInteger(locator.planeIndex) ||
    locator.planeIndex < 0 ||
    locator.planeIndex >= planeGrid.count
  ) {
    throw new Error("DICOM review: patient MPR plane is outside the CT volume");
  }
  return locator.planeIndex;
}

function overlayMembership(segmentation: SegmentedCenterline | null) {
  const rowsBySlice = new Map<number, Map<number, Array<readonly [number, number]>>>();
  for (const component of segmentation?.components ?? []) {
    const rows = new Map<number, Array<readonly [number, number]>>();
    for (const [row, firstColumn, lastColumn] of component.spans) {
      const spans = rows.get(row) ?? [];
      spans.push([firstColumn, lastColumn]);
      rows.set(row, spans);
    }
    rowsBySlice.set(component.sliceIndex, rows);
  }
  return (voxel: VoxelSeed): boolean =>
    Boolean(
      rowsBySlice
        .get(voxel.sliceIndex)
        ?.get(voxel.row)
        ?.some(([firstColumn, lastColumn]) =>
          voxel.column >= firstColumn && voxel.column <= lastColumn
        )
    );
}

/** Plane index used by revision-bound seed-aligned patient-MPR review obligations. */
export function patientMprPlaneIndexForVoxel(
  volume: CtVolume,
  plane: PatientMprReviewPlane,
  voxel: VoxelSeed
): number {
  const grid = patientGrid(volume);
  return selectedPlaneIndex(volume, grid, plane, { kind: "through-voxel", voxel });
}

/**
 * Render one patient-axis plane directly from the sole canonical HU volume.
 * The temporary scalar plane and validity mask are cleared before returning the RGBA frame.
 */
export function renderPatientMprReview(
  volume: CtVolume,
  segmentation: SegmentedCenterline | null,
  request: RenderPatientMprRequest
): RenderedPatientMpr {
  const grid = patientGrid(volume);
  const definition = planeDefinition(request.plane);
  const planeIndex = selectedPlaneIndex(volume, grid, request.plane, request.locator);
  const mapping = planeMapping(grid, request.plane, planeIndex);
  const sampler = new CanonicalVolumeSampler(volume);
  const pixels = new Int16Array(mapping.width * mapping.height);
  const valid = new Uint8Array(pixels.length);
  const overlaySpans: AxialOverlayRowSpan[] = [];
  const hasOverlayAt = overlayMembership(segmentation);

  for (let imageRow = 0; imageRow < mapping.height; imageRow++) {
    let overlayStart = -1;
    for (let imageColumn = 0; imageColumn < mapping.width; imageColumn++) {
      const offset = imageRow * mapping.width + imageColumn;
      const patientPoint = pointAt(mapping, imageRow, imageColumn);
      const hu = sampler.sampleLinearHu(patientPoint);
      const voxel = hu === null ? null : sampler.nearestVoxel(patientPoint);
      if (hu !== null && voxel) {
        valid[offset] = 1;
        pixels[offset] = Math.max(-32768, Math.min(32767, Math.round(hu)));
      }
      const overlay = Boolean(voxel && hasOverlayAt(voxel));
      if (overlay && overlayStart < 0) overlayStart = imageColumn;
      if (!overlay && overlayStart >= 0) {
        overlaySpans.push([imageRow, overlayStart, imageColumn]);
        overlayStart = -1;
      }
    }
    if (overlayStart >= 0) overlaySpans.push([imageRow, overlayStart, mapping.width]);
  }

  const activeSeed = request.previewSeed ?? segmentation?.seed ?? null;
  let seedMarker: { row: number; column: number } | undefined;
  if (activeSeed) {
    const point = volume.voxelCenterLps(activeSeed.sliceIndex, activeSeed.row, activeSeed.column);
    const planeGrid = gridForAxis(grid, definition.planeAxis);
    const activePlaneIndex = closestGridIndex(planeGrid, grid.spacingMm, point[definition.planeAxis]);
    if (activePlaneIndex === planeIndex) {
      const relative: [number, number, number] = [
        point[0] - mapping.originLps[0],
        point[1] - mapping.originLps[1],
        point[2] - mapping.originLps[2]
      ];
      const row = Math.round(dot(relative, mapping.verticalDirectionLps) / mapping.spacingMm);
      const column = Math.round(dot(relative, mapping.horizontalDirectionLps) / mapping.spacingMm);
      if (row >= 0 && row < mapping.height && column >= 0 && column < mapping.width) {
        seedMarker = { row, column };
      }
    }
  }

  const rgba = renderAxialReview({
    pixels,
    rows: mapping.height,
    columns: mapping.width,
    photometric: volume.getSlice(0).photometricInterpretation,
    windowCenter: request.windowCenterHu,
    windowWidth: request.windowWidthHu,
    overlaySpans,
    seed: seedMarker
  });
  for (let offset = 0; offset < valid.length; offset++) {
    if (valid[offset]) continue;
    const rgbaOffset = offset * 4;
    rgba[rgbaOffset] = 0;
    rgba[rgbaOffset + 1] = 0;
    rgba[rgbaOffset + 2] = 0;
    rgba[rgbaOffset + 3] = 255;
  }
  pixels.fill(0);
  valid.fill(0);

  return {
    frame: {
      plane: request.plane,
      planeIndex,
      planeCount: mapping.planeCount,
      width: mapping.width,
      height: mapping.height,
      rgba,
      hasOverlay: overlaySpans.length > 0,
      seed: activeSeed ? { ...activeSeed } : null,
      orientationLabels: definition.labels,
      horizontalPixelSpacingMm: mapping.spacingMm,
      verticalPixelSpacingMm: mapping.spacingMm
    },
    mapping
  };
}

/** Map a patient-MPR pixel back to the nearest valid canonical source voxel. */
export function sourceVoxelFromPatientMprPoint(
  volume: CtVolume,
  mapping: PatientMprFrameMapping,
  imageRow: number,
  imageColumn: number
): VoxelSeed {
  planeDefinition(mapping.plane);
  if (
    !Number.isFinite(imageRow) ||
    !Number.isFinite(imageColumn) ||
    !Number.isInteger(mapping.width) ||
    !Number.isInteger(mapping.height) ||
    mapping.width < 1 ||
    mapping.height < 1 ||
    imageRow < 0 ||
    imageRow >= mapping.height ||
    imageColumn < 0 ||
    imageColumn >= mapping.width
  ) {
    throw new Error("DICOM review: invalid patient-MPR image selection");
  }
  const point = pointAt(mapping, Math.floor(imageRow), Math.floor(imageColumn));
  const voxel = new CanonicalVolumeSampler(volume).nearestVoxel(point);
  if (!voxel) throw new Error("DICOM review: selection is outside sampled CT anatomy");
  return voxel;
}
