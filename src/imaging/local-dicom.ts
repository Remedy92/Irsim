import { MAX_DICOM_BYTES, MAX_DICOM_FILES } from "./dicom-volume";
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
import type { LocalDicomWorkerRequest, LocalDicomWorkerResponse } from "./worker-protocol";

export interface OpenLocalDicomOptions {
  settings: VesselSegmentationSettings;
  signal?: AbortSignal;
  onProgress?: (progress: DicomPipelineProgress) => void;
}

export interface LocalDicomSession {
  readonly summary: LocalDicomSummary;
  renderSourcePlane(request: SourceReviewRequest): Promise<SourceReviewFrame>;
  mapSourceReviewPoint(request: SourceReviewPointRequest): Promise<VoxelSeed>;
  segmentFromSeed(
    seed: VoxelSeed,
    settings: VesselSegmentationSettings,
    onProgress?: (progress: DicomPipelineProgress) => void
  ): Promise<LocalDicomResult>;
  replaceSegmentedSliceComponent(
    seed: VoxelSeed,
    settings: VesselSegmentationSettings
  ): Promise<LocalDicomResult>;
  applySegmentationBrush(
    center: VoxelSeed,
    mode: SegmentationBrushMode,
    radiusMm: number
  ): Promise<LocalDicomResult>;
  trimSegmentedTrunk(sliceIndex: number, side: SegmentationTrimSide): Promise<LocalDicomResult>;
  undoLastSegmentationEdit(): Promise<LocalDicomResult>;
  dispose(): void;
}

interface PendingRequest {
  resolve: (message: LocalDicomWorkerResponse) => void;
  reject: (cause: Error) => void;
  onProgress?: (progress: DicomPipelineProgress) => void;
  timeoutId?: number;
}

function abortError(): DOMException {
  return new DOMException("Local DICOM processing was cancelled", "AbortError");
}

class WorkerLocalDicomSession implements LocalDicomSession {
  private _summary: LocalDicomSummary;
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 2;
  private disposed = false;

  constructor(worker: Worker, summary: LocalDicomSummary) {
    this.worker = worker;
    this._summary = summary;
    worker.onmessage = (event: MessageEvent<LocalDicomWorkerResponse>) => this.receive(event.data);
    worker.onerror = () => {
      this.disposed = true;
      this.failAll(new Error("The local DICOM worker stopped unexpectedly"));
      this.worker.terminate();
    };
  }

  get summary(): LocalDicomSummary {
    return this._summary;
  }

  async renderSourcePlane(request: SourceReviewRequest): Promise<SourceReviewFrame> {
    const message = await this.request({
      type: "render-source-plane",
      requestId: this.nextRequestId++,
      request
    });
    if (message.type !== "source-frame") throw new Error("DICOM review: unexpected worker response");
    return message.frame;
  }

  async mapSourceReviewPoint(request: SourceReviewPointRequest): Promise<VoxelSeed> {
    const message = await this.request(
      {
        type: "map-source-point",
        requestId: this.nextRequestId++,
        request
      },
      undefined,
      5_000
    );
    if (message.type !== "source-point") {
      throw new Error("DICOM review: unexpected worker response");
    }
    return message.voxel;
  }

  async segmentFromSeed(
    seed: VoxelSeed,
    settings: VesselSegmentationSettings,
    onProgress?: (progress: DicomPipelineProgress) => void
  ): Promise<LocalDicomResult> {
    const message = await this.request(
      { type: "segment-from-seed", requestId: this.nextRequestId++, seed, settings: { ...settings } },
      onProgress
    );
    if (message.type !== "segmented") throw new Error("DICOM review: unexpected worker response");
    this._summary = message.result.summary;
    return message.result;
  }

  async replaceSegmentedSliceComponent(
    seed: VoxelSeed,
    settings: VesselSegmentationSettings
  ): Promise<LocalDicomResult> {
    const message = await this.request({
      type: "replace-slice-component",
      requestId: this.nextRequestId++,
      seed,
      settings: { ...settings }
    });
    if (message.type !== "segmented") throw new Error("DICOM review: unexpected worker response");
    this._summary = message.result.summary;
    return message.result;
  }

  async applySegmentationBrush(
    center: VoxelSeed,
    mode: SegmentationBrushMode,
    radiusMm: number
  ): Promise<LocalDicomResult> {
    const message = await this.request({
      type: "apply-segmentation-brush",
      requestId: this.nextRequestId++,
      center,
      mode,
      radiusMm
    });
    if (message.type !== "segmented") throw new Error("DICOM review: unexpected worker response");
    this._summary = message.result.summary;
    return message.result;
  }

  async undoLastSegmentationEdit(): Promise<LocalDicomResult> {
    const message = await this.request({
      type: "undo-segmentation-edit",
      requestId: this.nextRequestId++
    });
    if (message.type !== "segmented") throw new Error("DICOM review: unexpected worker response");
    this._summary = message.result.summary;
    return message.result;
  }

  async trimSegmentedTrunk(sliceIndex: number, side: SegmentationTrimSide): Promise<LocalDicomResult> {
    const message = await this.request({
      type: "trim-segmented-trunk",
      requestId: this.nextRequestId++,
      sliceIndex,
      side
    });
    if (message.type !== "segmented") throw new Error("DICOM review: unexpected worker response");
    this._summary = message.result.summary;
    return message.result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error("DICOM review: this local session has been disposed"));
    this.worker.terminate();
  }

  private request(
    request: LocalDicomWorkerRequest,
    onProgress?: (progress: DicomPipelineProgress) => void,
    timeoutMs?: number
  ): Promise<LocalDicomWorkerResponse> {
    if (this.disposed) return Promise.reject(new Error("DICOM review: this local session has been disposed"));
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, onProgress };
      if (timeoutMs !== undefined) {
        pending.timeoutId = window.setTimeout(() => {
          if (!this.pending.delete(request.requestId)) return;
          reject(new Error("DICOM review: source-point mapping timed out; select the current frame again"));
        }, timeoutMs);
      }
      this.pending.set(request.requestId, pending);
      try {
        this.worker.postMessage(request);
      } catch {
        this.pending.delete(request.requestId);
        if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
        reject(new Error("DICOM review: unable to send a request to the local worker"));
      }
    });
  }

  private receive(message: LocalDicomWorkerResponse): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (message.type === "progress") {
      pending.onProgress?.(message.progress);
      return;
    }
    this.pending.delete(message.requestId);
    if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
    if (message.type === "error") pending.reject(new Error(message.error));
    else pending.resolve(message);
  }

  private failAll(cause: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
      pending.reject(cause);
    }
    this.pending.clear();
  }
}

/**
 * Opens a browser-local imaging session. Selected File handles are cloned to one dedicated worker,
 * which reads and decodes one object at a time; only an identifier-free summary, individual RGBA
 * review frames, and the approved AnatomyDoc can cross back to the UI. There is no network or
 * browser-storage Adapter in this Module.
 */
export async function openLocalDicomSession(
  files: readonly File[],
  options: OpenLocalDicomOptions
): Promise<LocalDicomSession> {
  if (files.length < 3) throw new Error("Select at least three DICOM CT slices");
  if (files.length > MAX_DICOM_FILES) throw new Error(`Select no more than ${MAX_DICOM_FILES} files at once`);
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_DICOM_BYTES) {
    throw new Error(`Selected files exceed the ${Math.round(MAX_DICOM_BYTES / 1024 / 1024)} MB browser safety limit`);
  }
  if (options.signal?.aborted) throw abortError();

  const worker = new Worker(new URL("./local-dicom.worker.ts", import.meta.url), { type: "module" });
  return new Promise<LocalDicomSession>((resolve, reject) => {
    const requestId = 1;
    let settled = false;
    const finish = (callback: () => void, terminate: boolean) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (terminate) worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()), true);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.onerror = () => finish(() => reject(new Error("The local DICOM worker stopped unexpectedly")), true);
    worker.onmessage = (event: MessageEvent<LocalDicomWorkerResponse>) => {
      const message = event.data;
      if (message.requestId !== requestId) return;
      if (message.type === "progress") options.onProgress?.(message.progress);
      else if (message.type === "opened") {
        finish(() => resolve(new WorkerLocalDicomSession(worker, message.summary)), false);
      } else if (message.type === "error") finish(() => reject(new Error(message.error)), true);
      else finish(() => reject(new Error("DICOM review: unexpected worker response")), true);
    };
    const request: LocalDicomWorkerRequest = {
      type: "open",
      requestId,
      files: [...files],
      settings: { ...options.settings }
    };
    try {
      worker.postMessage(request);
    } catch {
      finish(() => reject(new Error("DICOM review: unable to start the local worker session")), true);
    }
  });
}
