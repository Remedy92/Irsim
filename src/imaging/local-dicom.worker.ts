/// <reference lib="webworker" />

import { LocalDicomProcessor } from "./process-dicom";
import type { LocalDicomWorkerRequest, LocalDicomWorkerResponse } from "./worker-protocol";

let processor: LocalDicomProcessor | null = null;

function send(message: LocalDicomWorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

self.onmessage = async (event: MessageEvent<LocalDicomWorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case "open": {
        processor?.dispose();
        processor = await LocalDicomProcessor.openFiles(request.files, request.settings, (progress) =>
          send({ type: "progress", requestId: request.requestId, progress })
        );
        send({ type: "opened", requestId: request.requestId, summary: processor.summary });
        return;
      }
      case "render-source-plane": {
        if (!processor) throw new Error("DICOM review: no local session is open");
        const frame = processor.renderSourcePlane(request.request);
        send({ type: "source-frame", requestId: request.requestId, frame }, [frame.rgba.buffer]);
        return;
      }
      case "map-source-point": {
        if (!processor) throw new Error("DICOM review: no local session is open");
        const voxel = processor.mapSourceReviewPoint(request.request);
        send({ type: "source-point", requestId: request.requestId, voxel });
        return;
      }
      case "segment-from-seed": {
        if (!processor) throw new Error("DICOM review: no local session is open");
        const result = processor.segmentFromSeed(request.seed, request.settings, (progress) =>
          send({ type: "progress", requestId: request.requestId, progress })
        );
        send({ type: "segmented", requestId: request.requestId, result });
        return;
      }
      case "replace-slice-component": {
        if (!processor) throw new Error("DICOM review: no local session is open");
        const result = processor.replaceSegmentedSliceComponent(request.seed, request.settings);
        send({ type: "segmented", requestId: request.requestId, result });
        return;
      }
      case "apply-segmentation-brush": {
        if (!processor) throw new Error("DICOM review: no local session is open");
        const result = processor.applySegmentationBrush(request.center, request.mode, request.radiusMm);
        send({ type: "segmented", requestId: request.requestId, result });
        return;
      }
      case "trim-segmented-trunk": {
        if (!processor) throw new Error("DICOM review: no local session is open");
        const result = processor.trimSegmentedTrunk(request.sliceIndex, request.side);
        send({ type: "segmented", requestId: request.requestId, result });
        return;
      }
      case "undo-segmentation-edit": {
        if (!processor) throw new Error("DICOM review: no local session is open");
        const result = processor.undoLastSegmentationEdit();
        send({ type: "segmented", requestId: request.requestId, result });
        return;
      }
    }
  } catch (cause) {
    if (request.type === "open") {
      processor?.dispose();
      processor = null;
    }
    send({
      type: "error",
      requestId: request.requestId,
      error: cause instanceof Error ? cause.message : "Local DICOM processing failed"
    });
  }
};

self.addEventListener("close", () => {
  processor?.dispose();
  processor = null;
});

export {};
