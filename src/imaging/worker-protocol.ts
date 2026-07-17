import type {
  DicomPipelineProgress,
  LocalDicomResult,
  LocalDicomSummary,
  SegmentationBrushMode,
  SegmentationTrimSide,
  SourceReviewFrame,
  SourceReviewPointRequest,
  SourceReviewRequest,
  VesselSegmentationSettings,
  VoxelSeed
} from "./types";

/** Internal request-correlated protocol. Patient identifiers are forbidden in every response. */
export type LocalDicomWorkerRequest =
  | {
      type: "open";
      requestId: number;
      files: File[];
      settings: VesselSegmentationSettings;
    }
  | { type: "render-source-plane"; requestId: number; request: SourceReviewRequest }
  | { type: "map-source-point"; requestId: number; request: SourceReviewPointRequest }
  | {
      type: "segment-from-seed";
      requestId: number;
      seed: VoxelSeed;
      settings: VesselSegmentationSettings;
    }
  | {
      type: "replace-slice-component";
      requestId: number;
      seed: VoxelSeed;
      settings: VesselSegmentationSettings;
    }
  | {
      type: "apply-segmentation-brush";
      requestId: number;
      center: VoxelSeed;
      mode: SegmentationBrushMode;
      radiusMm: number;
    }
  | {
      type: "trim-segmented-trunk";
      requestId: number;
      sliceIndex: number;
      side: SegmentationTrimSide;
    }
  | { type: "undo-segmentation-edit"; requestId: number };

export type LocalDicomWorkerResponse =
  | { type: "progress"; requestId: number; progress: DicomPipelineProgress }
  | { type: "opened"; requestId: number; summary: LocalDicomSummary }
  | { type: "source-frame"; requestId: number; frame: SourceReviewFrame }
  | { type: "source-point"; requestId: number; voxel: VoxelSeed }
  | { type: "segmented"; requestId: number; result: LocalDicomResult }
  | { type: "error"; requestId: number; error: string };
