import type { CtVolume } from "./dicom-volume";
import { patientMprPlaneIndexForVoxel } from "./patient-mpr";
import {
  applySegmentationBrush,
  replaceSegmentedSliceComponent,
  trimSegmentedCenterline,
  type SegmentedCenterline
} from "./vessel-segmentation";
import type {
  SegmentationEditRecord,
  SegmentationBrushMode,
  SegmentationTopologyReview,
  SegmentationTrimSide,
  VesselSegmentationSettings,
  VoxelSeed
} from "./types";

interface SegmentationSnapshot {
  segmentation: SegmentedCenterline;
  sliceIndex: number;
  settings: VesselSegmentationSettings;
}

const MAX_SEGMENTATION_REVIEW_ACTIONS = 512;

function reviewedComponentRegionCount(component: SegmentedCenterline["components"][number], volume: CtVolume): number {
  const spans = component.spans;
  const parents = spans.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const join = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  let currentRow = -1;
  let previousRow = -2;
  let currentRowSpanIndices: number[] = [];
  let previousRowSpanIndices: number[] = [];
  let previousRowCursor = 0;
  let lastColumnOnCurrentRow = -2;
  for (let index = 0; index < spans.length; index++) {
    const [row, firstColumn, lastColumn] = spans[index];
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(firstColumn) ||
      !Number.isInteger(lastColumn) ||
      row < 0 ||
      row >= volume.rows ||
      firstColumn < 0 ||
      lastColumn >= volume.columns ||
      firstColumn > lastColumn
    ) return -1;
    if (row !== currentRow) {
      if (row < currentRow) return -1;
      previousRow = currentRow;
      previousRowSpanIndices = currentRowSpanIndices;
      currentRow = row;
      currentRowSpanIndices = [];
      previousRowCursor = 0;
      lastColumnOnCurrentRow = -2;
    } else if (firstColumn <= lastColumnOnCurrentRow + 1) {
      return -1;
    }
    if (row === previousRow + 1) {
      while (
        previousRowCursor < previousRowSpanIndices.length &&
        spans[previousRowSpanIndices[previousRowCursor]][2] < firstColumn
      ) {
        previousRowCursor++;
      }
      for (let cursor = previousRowCursor; cursor < previousRowSpanIndices.length; cursor++) {
        const prior = previousRowSpanIndices[cursor];
        const [, priorFirst, priorLast] = spans[prior];
        if (priorFirst > lastColumn) break;
        if (firstColumn <= priorLast) join(index, prior);
      }
    }
    currentRowSpanIndices.push(index);
    lastColumnOnCurrentRow = lastColumn;
  }
  return new Set(spans.map((_, index) => find(index))).size;
}

/** First/quartiles/last plus the explicit seed, deduplicated in acquisition-slice order. */
export function requiredSourceSliceCheckpoints(segmentation: SegmentedCenterline): number[] {
  const slices = [...new Set(segmentation.components.map((component) => component.sliceIndex))].sort(
    (a, b) => a - b
  );
  if (slices.length === 0) return [];
  const checkpoints = [0, 0.25, 0.5, 0.75, 1].map(
    (fraction) => slices[Math.round((slices.length - 1) * fraction)]
  );
  if (segmentation.seed) checkpoints.push(segmentation.seed.sliceIndex);
  return [...new Set(checkpoints)].sort((a, b) => a - b);
}

/** Seed-aligned patient-coronal/sagittal context required in addition to source checkpoints. */
export function requiredOrthogonalCheckpoints(
  volume: CtVolume,
  segmentation: SegmentedCenterline
): SegmentationTopologyReview["requiredOrthogonalCheckpoints"] {
  if (!segmentation.seed) return [];
  return [
    {
      plane: "patient-coronal",
      planeIndex: patientMprPlaneIndexForVoxel(volume, "patient-coronal", segmentation.seed)
    },
    {
      plane: "patient-sagittal",
      planeIndex: patientMprPlaneIndexForVoxel(volume, "patient-sagittal", segmentation.seed)
    }
  ];
}

function topologyReview(
  volume: CtVolume,
  segmentation: SegmentedCenterline,
  settings: VesselSegmentationSettings,
  revision: number,
  editHistory: readonly SegmentationEditRecord[],
  canUndo: boolean
): SegmentationTopologyReview {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const sampleCount = segmentation.pointsLpsMm.length;
  if (
    sampleCount !== segmentation.radiiMm.length ||
    sampleCount !== segmentation.voxelPoints.length ||
    sampleCount !== segmentation.components.length
  ) {
    blockers.push("Edited trunk has inconsistent centerline, radius, or labelmap sample counts.");
  }

  const seenSlices = new Set<number>();
  for (const component of segmentation.components) {
    if (seenSlices.has(component.sliceIndex)) {
      blockers.push("Edited trunk contains more than one reviewed component on a source slice.");
      break;
    }
    seenSlices.add(component.sliceIndex);
    if (component.spans.length === 0) {
      blockers.push("Edited trunk contains an empty reviewed source-slice component.");
      break;
    }
    const regionCount = reviewedComponentRegionCount(component, volume);
    if (regionCount < 0) {
      blockers.push("Edited trunk contains an invalid or overlapping reviewed voxel span.");
      break;
    }
    if (regionCount > 1) {
      blockers.push("Edited trunk contains more than one disconnected reviewed region on a source slice.");
      break;
    }
  }

  let nearLimit = false;
  let rapidRadiusChange = false;
  for (let index = 1; index < sampleCount; index++) {
    const previous = segmentation.pointsLpsMm[index - 1];
    const current = segmentation.pointsLpsMm[index];
    const jump = Math.hypot(
      current[0] - previous[0],
      current[1] - previous[1],
      current[2] - previous[2]
    );
    if (jump > settings.maxCenterJumpMm) {
      blockers.push("Edited trunk has a centerline jump above the configured continuity limit.");
      break;
    }
    nearLimit ||= jump > settings.maxCenterJumpMm * 0.75;

    const previousRadius = segmentation.radiiMm[index - 1];
    const currentRadius = segmentation.radiiMm[index];
    const ratio = Math.max(previousRadius, currentRadius) / Math.max(0.001, Math.min(previousRadius, currentRadius));
    if (ratio > 2.8) {
      blockers.push("Edited trunk has an abrupt lumen-radius change above the topology limit.");
      break;
    }
    rapidRadiusChange ||= ratio > 1.8;

    const sliceGap = Math.abs(
      segmentation.voxelPoints[index].sliceIndex - segmentation.voxelPoints[index - 1].sliceIndex
    );
    if (sliceGap > 2) {
      blockers.push("Edited trunk contains an unreviewed source-slice gap above the topology limit.");
      break;
    }
  }
  if (nearLimit) warnings.push("A reviewed centerline transition is close to the configured continuity limit.");
  if (rapidRadiusChange) warnings.push("A reviewed lumen-radius transition changes rapidly between source slices.");

  return {
    revision,
    topologyStatus: blockers.length === 0 ? "pass" : "block",
    topologyBlockers: blockers,
    topologyWarnings: warnings,
    requiredSourceSliceCheckpoints: requiredSourceSliceCheckpoints(segmentation),
    requiredOrthogonalCheckpoints: requiredOrthogonalCheckpoints(volume, segmentation),
    editHistory: editHistory.map((record) => ({ ...record })),
    canUndo
  };
}

/**
 * Worker-local owner of the editable sparse labelmap, edit provenance, undo snapshots, and topology
 * gate. Callers never need to understand span mutation or continuity calculations.
 */
export class EditableSegmentationReview {
  private segmentation: SegmentedCenterline;
  private settings: VesselSegmentationSettings;
  private revision = 0;
  private readonly snapshots: SegmentationSnapshot[] = [];
  private readonly records: SegmentationEditRecord[] = [];

  constructor(
    private readonly volume: CtVolume,
    segmentation: SegmentedCenterline,
    settings: VesselSegmentationSettings
  ) {
    this.segmentation = segmentation;
    this.settings = { ...settings };
  }

  get current(): SegmentedCenterline {
    return this.segmentation;
  }

  get activeSettings(): VesselSegmentationSettings {
    return { ...this.settings };
  }

  get review(): SegmentationTopologyReview {
    return topologyReview(
      this.volume,
      this.segmentation,
      this.settings,
      this.revision,
      this.records,
      this.snapshots.length > 0
    );
  }

  replaceSliceComponent(seed: VoxelSeed, settings: VesselSegmentationSettings): SegmentedCenterline {
    if (this.records.length >= MAX_SEGMENTATION_REVIEW_ACTIONS) {
      throw new Error("DICOM review: the session edit limit was reached; start a new local review session");
    }
    const previous = this.segmentation;
    const next = replaceSegmentedSliceComponent(this.volume, previous, settings, seed);
    this.snapshots.push({ segmentation: previous, sliceIndex: seed.sliceIndex, settings: this.settings });
    this.segmentation = next;
    this.settings = { ...settings };
    this.records.push({ revision: ++this.revision, action: "replace-slice-component", sliceIndex: seed.sliceIndex });
    return next;
  }

  applyBrush(center: VoxelSeed, mode: SegmentationBrushMode, radiusMm: number): SegmentedCenterline {
    if (this.records.length >= MAX_SEGMENTATION_REVIEW_ACTIONS) {
      throw new Error("DICOM review: the session edit limit was reached; start a new local review session");
    }
    const previous = this.segmentation;
    const result = applySegmentationBrush(this.volume, previous, center, mode, radiusMm);
    this.snapshots.push({ segmentation: previous, sliceIndex: center.sliceIndex, settings: this.settings });
    this.segmentation = result.segmentation;
    this.records.push({
      revision: ++this.revision,
      action: mode === "add" ? "brush-add" : "brush-remove",
      sliceIndex: center.sliceIndex,
      brushRadiusMm: radiusMm,
      affectedSliceCount: result.affectedSliceCount,
      changedVoxelCount: result.changedVoxelCount,
      brushCenterRow: Math.floor(center.row),
      brushCenterColumn: Math.floor(center.column)
    });
    return this.segmentation;
  }

  trimAtSlice(sliceIndex: number, side: SegmentationTrimSide): SegmentedCenterline {
    if (this.records.length >= MAX_SEGMENTATION_REVIEW_ACTIONS) {
      throw new Error("DICOM review: the session edit limit was reached; start a new local review session");
    }
    const previous = this.segmentation;
    const next = trimSegmentedCenterline(this.volume, previous, sliceIndex, side);
    this.snapshots.push({ segmentation: previous, sliceIndex, settings: this.settings });
    this.segmentation = next;
    this.records.push({ revision: ++this.revision, action: side === "before" ? "trim-before" : "trim-after", sliceIndex });
    return next;
  }

  undo(): SegmentedCenterline {
    const snapshot = this.snapshots.pop();
    if (!snapshot) throw new Error("DICOM review: there is no segmentation edit to undo");
    this.segmentation = snapshot.segmentation;
    this.settings = snapshot.settings;
    this.records.push({ revision: ++this.revision, action: "undo", sliceIndex: snapshot.sliceIndex });
    return this.segmentation;
  }
}
