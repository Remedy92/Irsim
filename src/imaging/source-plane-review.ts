import { renderAxialReview } from "./axial-review";
import type { CtVolume } from "./dicom-volume";
import {
  renderPatientMprReview,
  sourceVoxelFromPatientMprPoint,
  type PatientMprFrameMapping
} from "./patient-mpr";
import type {
  SourceReviewFrame,
  SourceReviewPointRequest,
  SourceReviewRequest,
  VoxelSeed
} from "./types";
import type { SegmentedCenterline } from "./vessel-segmentation";

export type SourceReviewFrameMapping =
  | {
      plane: "axial";
      sliceIndex: number;
      width: number;
      height: number;
    }
  | {
      plane: "patient-axial" | "patient-coronal" | "patient-sagittal";
      frame: PatientMprFrameMapping;
    };

export interface RenderedSourceReview {
  frame: SourceReviewFrame;
  mapping: SourceReviewFrameMapping;
}

function requireFrameToken(frameToken: number): void {
  if (!Number.isSafeInteger(frameToken) || frameToken <= 0) {
    throw new Error("DICOM review: invalid source-frame token");
  }
}

/**
 * Render any currently supported review plane from the same canonical scalar store. This is the
 * single projection seam that will gain patient-space and oblique MPR; callers do not branch on
 * axial versus reformat geometry.
 */
export function renderSourceReview(
  volume: CtVolume,
  segmentation: SegmentedCenterline | null,
  request: SourceReviewRequest,
  frameToken: number
): RenderedSourceReview {
  requireFrameToken(frameToken);
  if (request.plane === "axial") {
    if (
      !Number.isInteger(request.planeIndex) ||
      request.planeIndex < 0 ||
      request.planeIndex >= volume.sliceCount
    ) {
      throw new Error("DICOM review: slice is outside the CT volume");
    }
    const component = segmentation?.components.find(
      (item) => item.sliceIndex === request.planeIndex
    );
    const slice = volume.getSlice(request.planeIndex);
    const rgba = renderAxialReview({
      pixels: slice.pixelsHu,
      rows: volume.rows,
      columns: volume.columns,
      photometric: slice.photometricInterpretation,
      windowCenter: request.windowCenterHu,
      windowWidth: request.windowWidthHu,
      overlaySpans: component?.spans.map(
        ([row, first, last]) => [row, first, last + 1] as const
      ),
      seed:
        request.previewSeed?.sliceIndex === request.planeIndex
          ? { row: request.previewSeed.row, column: request.previewSeed.column }
          : segmentation?.seed?.sliceIndex === request.planeIndex
            ? { row: segmentation.seed.row, column: segmentation.seed.column }
            : undefined
    });
    return {
      frame: {
        frameToken,
        plane: "axial",
        planeIndex: request.planeIndex,
        planeCount: volume.sliceCount,
        width: volume.columns,
        height: volume.rows,
        rgba,
        hasOverlay: Boolean(component),
        seed: request.previewSeed ?? segmentation?.seed ?? null
      },
      mapping: {
        plane: "axial",
        sliceIndex: request.planeIndex,
        width: volume.columns,
        height: volume.rows
      }
    };
  }

  const patientMpr = renderPatientMprReview(volume, segmentation, {
    plane: request.plane,
    locator: request.locator,
    windowCenterHu: request.windowCenterHu,
    windowWidthHu: request.windowWidthHu,
    previewSeed: request.previewSeed
  });
  return {
    frame: {
      frameToken,
      ...patientMpr.frame
    },
    mapping: {
      plane: request.plane,
      frame: patientMpr.mapping
    }
  };
}

/** Map an opaque rendered-frame point back to the canonical source voxel inside the worker. */
export function sourceVoxelFromRenderedFrame(
  volume: CtVolume,
  mapping: SourceReviewFrameMapping,
  request: SourceReviewPointRequest
): VoxelSeed {
  requireFrameToken(request.frameToken);
  if (!Number.isFinite(request.imageRow) || !Number.isFinite(request.imageColumn)) {
    throw new Error("DICOM review: invalid source-image selection");
  }
  if (mapping.plane !== "axial") {
    return sourceVoxelFromPatientMprPoint(
      volume,
      mapping.frame,
      request.imageRow,
      request.imageColumn
    );
  }
  return {
    sliceIndex: mapping.sliceIndex,
    row: Math.max(0, Math.min(mapping.height - 1, Math.floor(request.imageRow))),
    column: Math.max(0, Math.min(mapping.width - 1, Math.floor(request.imageColumn)))
  };
}
