import type { AnatomyDoc } from "../sim/anatomyDoc";

/** HU range and geometric limits for the browser-local prototype segmentation. */
export interface VesselSegmentationSettings {
  huMin: number;
  huMax: number;
  minAreaMm2: number;
  maxAreaMm2: number;
  maxCenterJumpMm: number;
}

export const DEFAULT_VESSEL_SEGMENTATION_SETTINGS: VesselSegmentationSettings = {
  huMin: 160,
  huMax: 650,
  minAreaMm2: 20,
  maxAreaMm2: 5000,
  maxCenterJumpMm: 18
};

export type DicomPipelineStage =
  | "reading"
  | "decoding"
  | "segmenting"
  | "centerline"
  | "validating";

export interface DicomPipelineProgress {
  stage: DicomPipelineStage;
  completed: number;
  total: number;
  message: string;
}

/** Deliberately excludes patient, study, series and file identifiers. */
export interface LocalDicomSummary {
  inputFileCount: number;
  selectedSliceCount: number;
  ignoredFileCount: number;
  dimensions: [columns: number, rows: number, slices: number];
  spacingMm: [column: number, row: number, slice: number];
  segmentedSliceCount: number;
  coveragePercent: number;
  confidence: "low" | "medium" | "high";
  warnings: string[];
  settings: VesselSegmentationSettings;
  segmentationOverlayAvailable: boolean;
  /** Initial acquisition-plane slice chosen from the middle of the proposed path. */
  suggestedSliceIndex: number;
}

export interface VoxelSeed {
  sliceIndex: number;
  row: number;
  column: number;
}

export type AxialOverlayMode = "proposal" | "seeded";

export interface AxialReviewRequest {
  sliceIndex: number;
  windowCenterHu: number;
  windowWidthHu: number;
  overlay: AxialOverlayMode;
  /** Optional uncommitted operator selection rendered as a marker on its source slice. */
  previewSeed?: VoxelSeed;
}

export interface AxialReviewFrame {
  sliceIndex: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  hasOverlay: boolean;
  seed: VoxelSeed | null;
}

export type PatientMprAxis = "axial" | "coronal" | "sagittal";
export type PatientMprReviewPlane = `patient-${PatientMprAxis}`;
export type OrthogonalReviewPlane = "patient-coronal" | "patient-sagittal";
export type SourceReviewPlane = "axial" | PatientMprReviewPlane;

export type PatientMprLocator =
  | { kind: "center" }
  | { kind: "through-voxel"; voxel: VoxelSeed }
  | { kind: "plane-index"; planeIndex: number };

export interface PatientOrientationLabels {
  top: "H" | "F" | "A" | "P" | "L" | "R";
  bottom: "H" | "F" | "A" | "P" | "L" | "R";
  left: "H" | "F" | "A" | "P" | "L" | "R";
  right: "H" | "F" | "A" | "P" | "L" | "R";
}

/** One source/MPR rendering interface; plane geometry and click mapping stay worker-local. */
interface SourceReviewRequestBase {
  windowCenterHu: number;
  windowWidthHu: number;
  overlay: AxialOverlayMode;
  previewSeed?: VoxelSeed;
}

export type SourceReviewRequest =
  | (SourceReviewRequestBase & {
      /** Original acquisition slice; never confused with a patient-axis axial reformat. */
      plane: "axial";
      planeIndex: number;
    })
  | (SourceReviewRequestBase & {
      /** Patient LPS reformat rendered directly from the canonical source volume. */
      plane: PatientMprReviewPlane;
      locator: PatientMprLocator;
    });

/** Identifier-free frame. frameToken is opaque, session-local, bounded, and never persisted. */
export interface SourceReviewFrame {
  frameToken: number;
  plane: SourceReviewPlane;
  planeIndex: number;
  planeCount: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  hasOverlay: boolean;
  seed: VoxelSeed | null;
  /** Present only for fixed patient-axis MPR; contains no patient coordinates. */
  orientationLabels?: PatientOrientationLabels;
  horizontalPixelSpacingMm?: number;
  verticalPixelSpacingMm?: number;
}

export interface SourceReviewPointRequest {
  frameToken: number;
  imageRow: number;
  imageColumn: number;
}

export interface OrthogonalReviewCheckpoint {
  plane: OrthogonalReviewPlane;
  planeIndex: number;
}

export interface SegmentationEditRecord {
  revision: number;
  action: "replace-slice-component" | "brush-add" | "brush-remove" | "trim-before" | "trim-after" | "undo";
  sliceIndex: number;
  brushRadiusMm?: number;
  affectedSliceCount?: number;
  changedVoxelCount?: number;
  brushCenterRow?: number;
  brushCenterColumn?: number;
}

export type SegmentationTrimSide = "before" | "after";
export type SegmentationBrushMode = "add" | "remove";

/** Identifier-free, session-local evidence for the current editable sparse labelmap. */
export interface SegmentationTopologyReview {
  revision: number;
  topologyStatus: "pass" | "block";
  topologyBlockers: string[];
  topologyWarnings: string[];
  /** Bounded acquisition-plane frames that must render for the current revision before attestation. */
  requiredSourceSliceCheckpoints: number[];
  /** Seed-aligned longitudinal context frames that must also render for the current revision. */
  requiredOrthogonalCheckpoints: OrthogonalReviewCheckpoint[];
  editHistory: SegmentationEditRecord[];
  canUndo: boolean;
}

/** A result can replace the simulator anatomy only after an explicit source-image seed. */
export interface LocalDicomResult {
  /** Null whenever the current editable topology is blocked from entering the simulator. */
  doc: AnatomyDoc | null;
  summary: LocalDicomSummary;
  seed: VoxelSeed;
  seedConfirmed: true;
  review: SegmentationTopologyReview;
}
