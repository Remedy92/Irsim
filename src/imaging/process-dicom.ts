import {
  buildCtVolume,
  createCtSliceDecoder,
  type CtVolume,
  type DecodedCtSlice
} from "./dicom-volume";
import { EditableSegmentationReview } from "./segmentation-review";
import {
  renderSourceReview,
  sourceVoxelFromRenderedFrame,
  type SourceReviewFrameMapping
} from "./source-plane-review";
import {
  buildLocalDicomSummary,
  buildSourceReviewSummary,
  centerlineToLocalAnatomy,
  segmentAorticCenterline,
  segmentAorticCenterlineFromSeed,
  type SegmentedCenterline,
  VesselProposalUnavailableError
} from "./vessel-segmentation";
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

const MAX_RETAINED_SOURCE_FRAME_MAPPINGS = 8;

/**
 * Minimal browser/local fixture Seam for sequential source reads.
 *
 * Browser `File` objects satisfy this Interface. Keeping filenames and other file metadata outside
 * it also lets acceptance fixtures exercise the exact production intake path without first loading
 * an entire study into a second in-memory representation.
 */
export interface DicomFileSource {
  arrayBuffer(): Promise<ArrayBuffer>;
}

function reportSegmentationProgress(
  onProgress: ((progress: DicomPipelineProgress) => void) | undefined,
  completed: number,
  total: number
): void {
  if (completed === total || completed % Math.max(1, Math.floor(total / 50)) === 0) {
    onProgress?.({
      stage: "segmenting",
      completed,
      total,
      message: `Segmenting slice ${completed} of ${total}`
    });
  }
}

/**
 * Worker-owned state for one local CT review session. The HU volume is the single canonical pixel
 * representation and is never returned through the public Interface.
 */
export class LocalDicomProcessor {
  private volume: CtVolume | null;
  private proposal: SegmentedCenterline | null;
  private editable: EditableSegmentationReview | null = null;
  private readonly sourceFrameMappings = new Map<number, SourceReviewFrameMapping>();
  private nextSourceFrameToken = 1;
  private readonly inputFileCount: number;
  private readonly decodeFailures: number;
  private _summary: LocalDicomSummary;

  private constructor(
    volume: CtVolume,
    proposal: SegmentedCenterline | null,
    inputFileCount: number,
    decodeFailures: number,
    settings: VesselSegmentationSettings
  ) {
    this.volume = volume;
    this.proposal = proposal;
    this.inputFileCount = inputFileCount;
    this.decodeFailures = decodeFailures;
    this._summary = proposal
      ? buildLocalDicomSummary(volume, proposal, inputFileCount, settings, decodeFailures)
      : buildSourceReviewSummary(volume, inputFileCount, settings, decodeFailures);
  }

  static async open(
    buffers: ArrayBuffer[],
    settings: VesselSegmentationSettings,
    onProgress?: (progress: DicomPipelineProgress) => void
  ): Promise<LocalDicomProcessor> {
    const decoded: DecodedCtSlice[] = [];
    const failures: string[] = [];
    const sliceDecoder = createCtSliceDecoder();
    let intakeCompleted = false;
    try {
      for (let index = 0; index < buffers.length; index++) {
        onProgress?.({
          stage: "decoding",
          completed: index,
          total: buffers.length,
          message: `Decoding CT slice ${index + 1} of ${buffers.length}`
        });
        try {
          decoded.push(await sliceDecoder.decode(buffers[index]));
        } catch (cause) {
          failures.push(cause instanceof Error ? cause.message : "DICOM: unusable file");
        } finally {
          // HU values were copied into the canonical volume. Release the transferred source bytes so
          // the worker does not retain two full study representations.
          new Uint8Array(buffers[index]).fill(0);
          buffers[index] = new ArrayBuffer(0);
        }
      }
      intakeCompleted = true;
    } finally {
      // Codec state is only an intake concern; release it before segmentation and source review.
      sliceDecoder.dispose();
      if (!intakeCompleted) {
        for (const slice of decoded) slice.pixelsHu.fill(0);
        for (let index = 0; index < buffers.length; index++) {
          new Uint8Array(buffers[index]).fill(0);
          buffers[index] = new ArrayBuffer(0);
        }
      }
    }
    return LocalDicomProcessor.fromDecoded(
      decoded,
      buffers.length,
      failures,
      settings,
      onProgress
    );
  }

  /** Production path: read and decode one File at a time so raw study bytes never accumulate. */
  static async openFiles(
    files: readonly DicomFileSource[],
    settings: VesselSegmentationSettings,
    onProgress?: (progress: DicomPipelineProgress) => void
  ): Promise<LocalDicomProcessor> {
    const decoded: DecodedCtSlice[] = [];
    const failures: string[] = [];
    const sliceDecoder = createCtSliceDecoder();
    let intakeCompleted = false;
    try {
      for (let index = 0; index < files.length; index++) {
        onProgress?.({
          stage: "reading",
          completed: index,
          total: files.length,
          message: `Reading local file ${index + 1} of ${files.length}`
        });
        let buffer: ArrayBuffer;
        try {
          buffer = await files[index].arrayBuffer();
        } catch {
          throw new Error("DICOM: unable to read a selected local file");
        }
        try {
          onProgress?.({
            stage: "decoding",
            completed: index,
            total: files.length,
            message: `Decoding CT slice ${index + 1} of ${files.length}`
          });
          try {
            decoded.push(await sliceDecoder.decode(buffer));
          } catch (cause) {
            failures.push(cause instanceof Error ? cause.message : "DICOM: unusable file");
          }
        } finally {
          new Uint8Array(buffer).fill(0);
        }
      }
      intakeCompleted = true;
    } finally {
      sliceDecoder.dispose();
      if (!intakeCompleted) {
        for (const slice of decoded) slice.pixelsHu.fill(0);
      }
    }
    try {
      onProgress?.({
        stage: "reading",
        completed: files.length,
        total: files.length,
        message: "Local files read; raw source bytes released"
      });
      return LocalDicomProcessor.fromDecoded(decoded, files.length, failures, settings, onProgress);
    } catch (cause) {
      // `fromDecoded` releases owned storage on its own failures. Re-zeroing is harmless and also
      // covers a caller progress callback that throws before volume construction.
      for (const slice of decoded) slice.pixelsHu.fill(0);
      throw cause;
    }
  }

  private static fromDecoded(
    decoded: DecodedCtSlice[],
    inputFileCount: number,
    failures: string[],
    settings: VesselSegmentationSettings,
    onProgress?: (progress: DicomPipelineProgress) => void
  ): LocalDicomProcessor {
    if (decoded.length < 3) {
      const reason = failures[0] ? ` ${failures[0]}` : "";
      for (const slice of decoded) slice.pixelsHu.fill(0);
      throw new Error(`DICOM: fewer than three usable CT slices were found.${reason}`);
    }

    let volume: CtVolume;
    try {
      volume = buildCtVolume(decoded);
    } catch (cause) {
      for (const slice of decoded) slice.pixelsHu.fill(0);
      throw cause;
    }
    let proposal: SegmentedCenterline | null = null;
    try {
      onProgress?.({
        stage: "segmenting",
        completed: 0,
        total: volume.sliceCount,
        message: "Building an automatic overlay proposal"
      });
      try {
        proposal = segmentAorticCenterline(volume, settings, (completed, total) =>
          reportSegmentationProgress(onProgress, completed, total)
        );
      } catch (cause) {
        if (!(cause instanceof VesselProposalUnavailableError)) throw cause;
      }
      return new LocalDicomProcessor(volume, proposal, inputFileCount, failures.length, settings);
    } catch (cause) {
      volume.dispose();
      throw cause;
    }
  }

  get summary(): LocalDicomSummary {
    this.requireVolume();
    return this._summary;
  }

  renderSourcePlane(request: SourceReviewRequest): SourceReviewFrame {
    const volume = this.requireVolume();
    const segmentation = request.overlay === "seeded" ? (this.editable?.current ?? null) : this.proposal;
    if (request.overlay === "seeded" && !segmentation) {
      throw new Error("DICOM review: place a valid vascular seed before reviewing the seeded overlay");
    }
    if (this.nextSourceFrameToken >= Number.MAX_SAFE_INTEGER) {
      this.sourceFrameMappings.clear();
      this.nextSourceFrameToken = 1;
    }
    const rendered = renderSourceReview(
      volume,
      segmentation,
      request,
      this.nextSourceFrameToken++
    );
    this.sourceFrameMappings.set(rendered.frame.frameToken, rendered.mapping);
    while (this.sourceFrameMappings.size > MAX_RETAINED_SOURCE_FRAME_MAPPINGS) {
      const oldest = this.sourceFrameMappings.keys().next().value;
      if (oldest === undefined) break;
      this.sourceFrameMappings.delete(oldest);
    }
    return rendered.frame;
  }

  mapSourceReviewPoint(request: SourceReviewPointRequest): VoxelSeed {
    this.requireVolume();
    const mapping = this.sourceFrameMappings.get(request.frameToken);
    if (!mapping) {
      throw new Error("DICOM review: source frame expired; wait for the current frame and select again");
    }
    return sourceVoxelFromRenderedFrame(this.requireVolume(), mapping, request);
  }

  segmentFromSeed(
    seed: VoxelSeed,
    settings: VesselSegmentationSettings,
    onProgress?: (progress: DicomPipelineProgress) => void
  ): LocalDicomResult {
    const volume = this.requireVolume();
    onProgress?.({
      stage: "segmenting",
      completed: 0,
      total: volume.sliceCount,
      message: "Tracking the selected vessel in both directions"
    });
    const segmentation = segmentAorticCenterlineFromSeed(volume, settings, seed, (completed, total) =>
      reportSegmentationProgress(onProgress, completed, total)
    );
    onProgress?.({
      stage: "centerline",
      completed: 0,
      total: 1,
      message: "Building the simulator centerline and lumen radii"
    });
    this.editable = new EditableSegmentationReview(volume, segmentation, settings);
    onProgress?.({
      stage: "validating",
      completed: 1,
      total: 1,
      message: "Seeded anatomy passed structural validation"
    });
    return this.buildReviewedResult(segmentation, settings);
  }

  replaceSegmentedSliceComponent(
    seed: VoxelSeed,
    settings: VesselSegmentationSettings
  ): LocalDicomResult {
    this.requireVolume();
    if (!this.editable) throw new Error("DICOM review: track a vascular seed before editing the segmentation");
    const segmentation = this.editable.replaceSliceComponent(seed, settings);
    return this.buildReviewedResult(segmentation, settings);
  }

  applySegmentationBrush(
    center: VoxelSeed,
    mode: SegmentationBrushMode,
    radiusMm: number
  ): LocalDicomResult {
    this.requireVolume();
    if (!this.editable) throw new Error("DICOM review: track a vascular seed before brush editing");
    const segmentation = this.editable.applyBrush(center, mode, radiusMm);
    return this.buildReviewedResult(segmentation, this.editable.activeSettings);
  }

  trimSegmentedTrunk(sliceIndex: number, side: SegmentationTrimSide): LocalDicomResult {
    this.requireVolume();
    if (!this.editable) throw new Error("DICOM review: track a vascular seed before trimming the segmentation");
    const segmentation = this.editable.trimAtSlice(sliceIndex, side);
    return this.buildReviewedResult(segmentation, this.editable.activeSettings);
  }

  undoLastSegmentationEdit(): LocalDicomResult {
    this.requireVolume();
    if (!this.editable) throw new Error("DICOM review: track a vascular seed before undoing segmentation edits");
    const segmentation = this.editable.undo();
    const settings = this.editable.activeSettings;
    return this.buildReviewedResult(segmentation, settings);
  }

  /** Best-effort release of transient PHI-bearing pixel buffers. JavaScript cannot promise secure erasure. */
  dispose(): void {
    if (!this.volume) return;
    this.volume.dispose();
    this.volume = null;
    this.proposal = null;
    this.editable = null;
    this.sourceFrameMappings.clear();
  }

  private requireVolume(): CtVolume {
    if (!this.volume) throw new Error("DICOM review: this local session has been disposed");
    return this.volume;
  }

  private buildReviewedResult(
    segmentation: SegmentedCenterline,
    settings: VesselSegmentationSettings
  ): LocalDicomResult {
    const volume = this.requireVolume();
    if (!this.editable || !segmentation.seed) {
      throw new Error("DICOM review: a seed-confirmed segmentation is required");
    }
    this.sourceFrameMappings.clear();
    this._summary = buildLocalDicomSummary(
      volume,
      segmentation,
      this.inputFileCount,
      settings,
      this.decodeFailures
    );
    const review = this.editable.review;
    return {
      doc: review.topologyStatus === "pass" ? centerlineToLocalAnatomy(segmentation) : null,
      summary: this._summary,
      seed: { ...segmentation.seed },
      seedConfirmed: true,
      review
    };
  }
}
