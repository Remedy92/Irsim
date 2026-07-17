import { useEffect, useRef, useState } from "react";
import type { LocalDicomSession } from "./local-dicom";
import type {
  DicomPipelineProgress,
  AxialOverlayMode,
  LocalDicomResult,
  LocalDicomSummary,
  OrthogonalReviewCheckpoint,
  OrthogonalReviewPlane,
  PatientMprReviewPlane,
  PatientOrientationLabels,
  SegmentationBrushMode,
  SourceReviewPlane,
  VesselSegmentationSettings,
  VoxelSeed
} from "./types";

type ReviewPlane = SourceReviewPlane;

export function AxialSeedReview({
  session,
  summary,
  settings,
  result,
  disabled,
  onBusyChange,
  onProgress,
  onResult,
  onInvalidate,
  onApprovalInvalidate,
  reviewedCheckpointSlices,
  onCheckpointFrameReviewed,
  reviewedOrthogonalCheckpoints,
  onOrthogonalCheckpointFrameReviewed,
  onError
}: {
  session: LocalDicomSession;
  summary: LocalDicomSummary;
  settings: VesselSegmentationSettings;
  result: LocalDicomResult | null;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onProgress: (progress: DicomPipelineProgress | null) => void;
  onResult: (result: LocalDicomResult) => void;
  onInvalidate: () => void;
  onApprovalInvalidate: () => void;
  reviewedCheckpointSlices: readonly number[];
  onCheckpointFrameReviewed: (sliceIndex: number, revision: number) => void;
  reviewedOrthogonalCheckpoints: readonly OrthogonalReviewCheckpoint[];
  onOrthogonalCheckpointFrameReviewed: (
    plane: OrthogonalReviewPlane,
    planeIndex: number,
    revision: number
  ) => void;
  onError: (message: string | null) => void;
}) {
  const [sliceIndex, setSliceIndex] = useState(summary.suggestedSliceIndex);
  const [plane, setPlane] = useState<ReviewPlane>("axial");
  const [patientAxialPlaneIndex, setPatientAxialPlaneIndex] = useState<number | null>(null);
  const [patientCoronalPlaneIndex, setPatientCoronalPlaneIndex] = useState<number | null>(null);
  const [patientSagittalPlaneIndex, setPatientSagittalPlaneIndex] = useState<number | null>(null);
  const [patientPlaneCounts, setPatientPlaneCounts] = useState<Partial<Record<PatientMprReviewPlane, number>>>({});
  const [orientationLabels, setOrientationLabels] = useState<PatientOrientationLabels | null>(null);
  const [windowCenter, setWindowCenter] = useState(300);
  const [windowWidth, setWindowWidth] = useState(700);
  const [brushRadiusMm, setBrushRadiusMm] = useState(2);
  const [seed, setSeed] = useState<VoxelSeed>({
    sliceIndex: summary.suggestedSliceIndex,
    row: Math.floor(summary.dimensions[1] / 2),
    column: Math.floor(summary.dimensions[0] / 2)
  });
  const [seedSelected, setSeedSelected] = useState(false);
  const [mappingSelection, setMappingSelection] = useState(false);
  const [frameState, setFrameState] = useState<"loading" | "ready" | "error">("loading");
  const [renderedFrameKey, setRenderedFrameKey] = useState<string | null>(null);
  const [frameHasOverlay, setFrameHasOverlay] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const renderSequence = useRef(0);
  const currentFrameToken = useRef<number | null>(null);

  const overlay: AxialOverlayMode = result ? "seeded" : "proposal";
  const patientPlaneIndex =
    plane === "patient-axial"
      ? patientAxialPlaneIndex
      : plane === "patient-coronal"
        ? patientCoronalPlaneIndex
        : plane === "patient-sagittal"
          ? patientSagittalPlaneIndex
          : null;
  const requestedPlaneIndex =
    plane === "axial"
      ? sliceIndex
      : (patientPlaneIndex ?? -1);
  const requestedFrameKey = [
    plane,
    requestedPlaneIndex,
    windowCenter,
    windowWidth,
    overlay,
    result?.review.revision ?? "proposal",
    seedSelected ? `${seed.sliceIndex}:${seed.row}:${seed.column}` : "no-seed"
  ].join("|");
  const currentFrameState = renderedFrameKey === requestedFrameKey ? frameState : "loading";
  useEffect(() => {
    const sequence = ++renderSequence.current;
    setFrameState("loading");
    setRenderedFrameKey(requestedFrameKey);
    setFrameHasOverlay(false);
    setOrientationLabels(null);
    currentFrameToken.current = null;
    const sourceRequest =
      plane === "axial"
        ? {
            plane,
            planeIndex: sliceIndex,
            windowCenterHu: windowCenter,
            windowWidthHu: windowWidth,
            overlay,
            previewSeed: seedSelected ? seed : undefined
          }
        : {
            plane,
            locator:
              patientPlaneIndex === null
                ? ({ kind: "through-voxel", voxel: seed } as const)
                : ({ kind: "plane-index", planeIndex: patientPlaneIndex } as const),
            windowCenterHu: windowCenter,
            windowWidthHu: windowWidth,
            overlay,
            previewSeed: seedSelected ? seed : undefined
          };
    void session
      .renderSourcePlane(sourceRequest)
      .then((frame) => {
        if (sequence !== renderSequence.current) return;
        const target = canvas.current;
        const context = target?.getContext("2d");
        if (!target || !context) throw new Error("DICOM review: image canvas is unavailable");
        target.width = frame.width;
        target.height = frame.height;
        context.putImageData(
          new ImageData(frame.rgba as Uint8ClampedArray<ArrayBuffer>, frame.width, frame.height),
          0,
          0
        );
        setFrameHasOverlay(frame.hasOverlay);
        setOrientationLabels(frame.orientationLabels ?? null);
        currentFrameToken.current = frame.frameToken;
        if (frame.plane !== "axial") {
          const patientPlane = frame.plane;
          setPatientPlaneCounts((current) =>
            current[patientPlane] === frame.planeCount
              ? current
              : { ...current, [patientPlane]: frame.planeCount }
          );
          if (frame.plane === "patient-axial") setPatientAxialPlaneIndex(frame.planeIndex);
          if (frame.plane === "patient-coronal") setPatientCoronalPlaneIndex(frame.planeIndex);
          if (frame.plane === "patient-sagittal") setPatientSagittalPlaneIndex(frame.planeIndex);
          const checkpoint = result?.review.requiredOrthogonalCheckpoints.find(
            (item) => item.plane === frame.plane && item.planeIndex === frame.planeIndex
          );
          if (checkpoint && result) {
            onOrthogonalCheckpointFrameReviewed(
              checkpoint.plane,
              frame.planeIndex,
              result.review.revision
            );
          }
        }
        setFrameState("ready");
        if (
          plane === "axial" &&
          result &&
          result.review.requiredSourceSliceCheckpoints.includes(sliceIndex)
        ) {
          onCheckpointFrameReviewed(sliceIndex, result.review.revision);
        }
      })
      .catch((cause) => {
        if (sequence !== renderSequence.current) return;
        setFrameState("error");
        onError(cause instanceof Error ? cause.message : "Unable to render this source image");
      });
    return () => {
      renderSequence.current++;
    };
  }, [
    session,
    plane,
    sliceIndex,
    patientPlaneIndex,
    windowCenter,
    windowWidth,
    overlay,
    seedSelected,
    seed.sliceIndex,
    seed.row,
    seed.column,
    result?.review.revision,
    requestedFrameKey,
    onCheckpointFrameReviewed,
    onOrthogonalCheckpointFrameReviewed,
    onError
  ]);

  const updateSeed = (next: Partial<VoxelSeed>) => {
    const updated = {
      ...seed,
      ...next,
      sliceIndex: plane === "axial" ? sliceIndex : (next.sliceIndex ?? seed.sliceIndex)
    };
    setSeed(updated);
    if (plane === "patient-axial") setPatientAxialPlaneIndex(null);
    if (plane === "patient-coronal") setPatientCoronalPlaneIndex(null);
    if (plane === "patient-sagittal") setPatientSagittalPlaneIndex(null);
    setSeedSelected(true);
    if (result) onApprovalInvalidate();
  };

  const selectOnCanvas = async (clientX: number, clientY: number) => {
    const target = canvas.current;
    const frameToken = currentFrameToken.current;
    if (!target || frameToken === null) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const imageColumn = Math.max(
      0,
      Math.min(target.width - 1, Math.floor(((clientX - rect.left) / rect.width) * target.width))
    );
    const imageRow = Math.max(
      0,
      Math.min(target.height - 1, Math.floor(((clientY - rect.top) / rect.height) * target.height))
    );
    try {
      setMappingSelection(true);
      const selected = await session.mapSourceReviewPoint({ frameToken, imageRow, imageColumn });
      if (currentFrameToken.current !== frameToken) {
        onError("DICOM review: the source frame changed; select the point again on the current frame");
        return;
      }
      setSeed(selected);
      setSeedSelected(true);
      if (result) onApprovalInvalidate();
      onError(null);
    } catch (cause) {
      if (currentFrameToken.current !== frameToken) return;
      onError(cause instanceof Error ? cause.message : "Unable to map this source-image selection");
    } finally {
      setMappingSelection(false);
    }
  };

  const selectPlane = (nextPlane: ReviewPlane) => {
    if (nextPlane === "patient-axial") setPatientAxialPlaneIndex(null);
    if (nextPlane === "patient-coronal") {
      setPatientCoronalPlaneIndex(
        result?.review.requiredOrthogonalCheckpoints.find((item) => item.plane === nextPlane)
          ?.planeIndex ?? null
      );
    }
    if (nextPlane === "patient-sagittal") {
      setPatientSagittalPlaneIndex(
        result?.review.requiredOrthogonalCheckpoints.find((item) => item.plane === nextPlane)
          ?.planeIndex ?? null
      );
    }
    setPlane(nextPlane);
    onError(null);
  };

  const alignRequiredPatientMprPlanes = (next: LocalDicomResult) => {
    setPatientCoronalPlaneIndex(
      next.review.requiredOrthogonalCheckpoints.find((item) => item.plane === "patient-coronal")
        ?.planeIndex ?? null
    );
    setPatientSagittalPlaneIndex(
      next.review.requiredOrthogonalCheckpoints.find((item) => item.plane === "patient-sagittal")
        ?.planeIndex ?? null
    );
  };

  const trackSeed = async () => {
    onError(null);
    onProgress(null);
    if (result) onInvalidate();
    onBusyChange(true);
    try {
      const next = await session.segmentFromSeed(seed, settings, onProgress);
      onResult(next);
      setSeed(next.seed);
      alignRequiredPatientMprPlanes(next);
      setSeedSelected(false);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Unable to track the selected vessel");
    } finally {
      onBusyChange(false);
      onProgress(null);
    }
  };

  const replaceSliceComponent = async () => {
    onError(null);
    onProgress(null);
    onApprovalInvalidate();
    onBusyChange(true);
    try {
      const next = await session.replaceSegmentedSliceComponent(seed, settings);
      onResult(next);
      setSeed(next.seed);
      alignRequiredPatientMprPlanes(next);
      setSeedSelected(false);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Unable to replace the selected slice component");
    } finally {
      onBusyChange(false);
      onProgress(null);
    }
  };

  const applySegmentationBrush = async (mode: SegmentationBrushMode) => {
    onError(null);
    onProgress(null);
    onApprovalInvalidate();
    onBusyChange(true);
    try {
      const next = await session.applySegmentationBrush(seed, mode, brushRadiusMm);
      onResult(next);
      setSeed(next.seed);
      alignRequiredPatientMprPlanes(next);
      setSeedSelected(false);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Unable to apply the 3D segmentation brush");
    } finally {
      onBusyChange(false);
      onProgress(null);
    }
  };

  const undoLastEdit = async () => {
    onError(null);
    onProgress(null);
    onApprovalInvalidate();
    onBusyChange(true);
    try {
      const next = await session.undoLastSegmentationEdit();
      onResult(next);
      setSeed(next.seed);
      alignRequiredPatientMprPlanes(next);
      setSeedSelected(false);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Unable to undo the last segmentation edit");
    } finally {
      onBusyChange(false);
      onProgress(null);
    }
  };

  const trimSegmentedTrunk = async (side: "before" | "after") => {
    onError(null);
    onProgress(null);
    onApprovalInvalidate();
    onBusyChange(true);
    try {
      const next = await session.trimSegmentedTrunk(sliceIndex, side);
      onResult(next);
      setSeed(next.seed);
      alignRequiredPatientMprPlanes(next);
      setSeedSelected(false);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Unable to trim the reviewed trunk");
    } finally {
      onBusyChange(false);
      onProgress(null);
    }
  };

  const firstTrackedSlice = result?.review.requiredSourceSliceCheckpoints[0];
  const lastTrackedSlice = result?.review.requiredSourceSliceCheckpoints.at(-1);
  const canTrimBefore = Boolean(
      result &&
      plane === "axial" &&
      currentFrameState === "ready" &&
      frameHasOverlay &&
      firstTrackedSlice !== undefined &&
      sliceIndex > firstTrackedSlice &&
      sliceIndex <= result.seed.sliceIndex
  );
  const canTrimAfter = Boolean(
      result &&
      plane === "axial" &&
      currentFrameState === "ready" &&
      frameHasOverlay &&
      lastTrackedSlice !== undefined &&
      sliceIndex < lastTrackedSlice &&
      sliceIndex >= result.seed.sliceIndex
  );
  const displayedPlaneIndex = requestedPlaneIndex;
  const displayedPlaneCount =
    plane === "axial" ? summary.dimensions[2] : (patientPlaneCounts[plane] ?? 1);
  const displayedPlaneLabel =
    plane === "axial"
      ? "Source slice"
      : plane === "patient-axial"
        ? "Inferior → superior plane"
        : plane === "patient-coronal"
          ? "Anterior → posterior plane"
          : "Right → left plane";
  const patientFrameReady = plane === "axial" || requestedPlaneIndex >= 0;

  return (
    <section className="axial-review" aria-labelledby="axial-review-title">
      <div className="axial-review-head">
        <div>
          <small>Source acquisition + patient-axis MPR</small>
          <h3 id="axial-review-title">Confirm the intended vascular trunk</h3>
        </div>
        <span className={`review-state ${result ? "confirmed" : "proposal"}`}>
          {result ? "Seed tracked" : summary.segmentationOverlayAvailable ? "Automatic proposal" : "Source review only"}
        </span>
      </div>

      <p className="dicom-help">
        Review the original acquisition image or deterministic patient LPS axial, coronal, and sagittal reformats
        {summary.segmentationOverlayAvailable || result ? " with the same cyan threshold overlay" : ""}.
        {result
          ? " Select a point to replace its source-slice component or apply a bounded physical 3D add/remove brush, use axial source view to trim endpoints, or re-track the whole trunk."
          : " Select a point inside the intended contrast-filled vessel, then track it through the series."}
        {" "}HU is trilinearly sampled at isotropic physical spacing; the discrete cyan labelmap uses nearest-neighbour membership. These engineering review views do not replace a validated diagnostic workstation. Original acquisition checkpoints remain separately mandatory.
      </p>

      <nav className="source-plane-tabs" aria-label="Source review plane">
        {([
          ["axial", "Axial source"],
          ["patient-axial", "Patient axial"],
          ["patient-coronal", "Patient coronal"],
          ["patient-sagittal", "Patient sagittal"]
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={plane === value ? "current" : ""}
            aria-pressed={plane === value}
            disabled={disabled}
            onClick={() => selectPlane(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div
        className="axial-canvas-shell"
        data-state={currentFrameState}
        aria-busy={currentFrameState === "loading"}
      >
        <canvas
          ref={canvas}
          role="img"
          aria-hidden={currentFrameState !== "ready"}
          aria-label={`${plane === "axial" ? "Axial CT source slice" : `${plane.replace("patient-", "Patient ")} LPS reformat`} ${Math.max(0, displayedPlaneIndex) + 1} of ${displayedPlaneCount}${result || summary.segmentationOverlayAvailable ? `; cyan marks the ${result ? "seeded" : "automatic proposal"} overlay` : ""}`}
          onPointerDown={(event) => {
            if (!disabled) void selectOnCanvas(event.clientX, event.clientY);
          }}
        />
        {orientationLabels && currentFrameState === "ready" ? (
          <>
            <span className="mpr-orientation top" aria-hidden="true">{orientationLabels.top}</span>
            <span className="mpr-orientation bottom" aria-hidden="true">{orientationLabels.bottom}</span>
            <span className="mpr-orientation left" aria-hidden="true">{orientationLabels.left}</span>
            <span className="mpr-orientation right" aria-hidden="true">{orientationLabels.right}</span>
          </>
        ) : null}
        {currentFrameState === "loading" ? <span className="axial-canvas-status">Rendering source image…</span> : null}
      </div>

      <label className="axial-slice-control">
        <span>
          {displayedPlaneLabel} <b>{Math.max(0, displayedPlaneIndex) + 1}</b> / {displayedPlaneCount}
        </span>
        <input
          type="range"
          min={0}
          max={displayedPlaneCount - 1}
          step={1}
          value={Math.max(0, displayedPlaneIndex)}
          disabled={disabled || !patientFrameReady}
          onChange={(event) => {
            const nextIndex = Number(event.target.value);
            if (plane === "axial") setSliceIndex(nextIndex);
            else if (plane === "patient-axial") setPatientAxialPlaneIndex(nextIndex);
            else if (plane === "patient-coronal") setPatientCoronalPlaneIndex(nextIndex);
            else setPatientSagittalPlaneIndex(nextIndex);
            onError(null);
          }}
        />
      </label>

      {result ? (
        <section className="review-checkpoints" aria-labelledby="review-checkpoints-title">
          <div>
            <b id="review-checkpoints-title">Required source-image checkpoints</b>
            <small>
              Axial {reviewedCheckpointSlices.length}/{result.review.requiredSourceSliceCheckpoints.length} ·
              patient MPR {reviewedOrthogonalCheckpoints.length}/{result.review.requiredOrthogonalCheckpoints.length} ·
              revision {result.review.revision}
            </small>
          </div>
          <nav aria-label="Required source-image checkpoints">
            {result.review.requiredSourceSliceCheckpoints.map((checkpoint) => {
              const reviewed = reviewedCheckpointSlices.includes(checkpoint);
              return (
                <button
                  key={checkpoint}
                  type="button"
                  className={`${plane === "axial" && checkpoint === sliceIndex ? "current" : ""}${reviewed ? " reviewed" : ""}`}
                  data-slice-index={checkpoint}
                  data-reviewed={reviewed ? "true" : "false"}
                  disabled={disabled}
                  onClick={() => {
                    setPlane("axial");
                    setSliceIndex(checkpoint);
                    onError(null);
                  }}
                >
                  {reviewed ? "✓ " : ""}Slice {checkpoint + 1}
                </button>
              );
            })}
          </nav>
          <nav aria-label="Required patient-MPR checkpoints">
            {result.review.requiredOrthogonalCheckpoints.map((checkpoint) => {
              const reviewed = reviewedOrthogonalCheckpoints.some(
                (item) => item.plane === checkpoint.plane && item.planeIndex === checkpoint.planeIndex
              );
              return (
                <button
                  key={`${checkpoint.plane}:${checkpoint.planeIndex}`}
                  type="button"
                  className={`${plane === checkpoint.plane && displayedPlaneIndex === checkpoint.planeIndex ? "current" : ""}${reviewed ? " reviewed" : ""}`}
                  data-orthogonal-plane={checkpoint.plane}
                  data-plane-index={checkpoint.planeIndex}
                  data-reviewed={reviewed ? "true" : "false"}
                  disabled={disabled}
                  onClick={() => {
                    if (checkpoint.plane === "patient-coronal") {
                      setPatientCoronalPlaneIndex(checkpoint.planeIndex);
                    } else {
                      setPatientSagittalPlaneIndex(checkpoint.planeIndex);
                    }
                    setPlane(checkpoint.plane);
                    onError(null);
                  }}
                >
                  {reviewed ? "✓ " : ""}
                  {checkpoint.plane === "patient-coronal" ? "Patient coronal seed plane" : "Patient sagittal seed plane"}{" "}
                  {checkpoint.planeIndex + 1}
                </button>
              );
            })}
          </nav>
          <p>Open every axial checkpoint and both seed-aligned longitudinal context frames for this exact labelmap revision. Orthogonal reformats add context but do not replace axial review or full-volume clinical sign-off.</p>
        </section>
      ) : null}

      <div className="axial-controls">
        <label>
          <span>Window center</span>
          <input
            type="number"
            min={-1000}
            max={3000}
            step={10}
            value={windowCenter}
            disabled={disabled}
            onChange={(event) => setWindowCenter(Number(event.target.value))}
          />
          <small>HU</small>
        </label>
        <label>
          <span>Window width</span>
          <input
            type="number"
            min={1}
            max={5000}
            step={10}
            value={windowWidth}
            disabled={disabled}
            onChange={(event) => setWindowWidth(Number(event.target.value))}
          />
          <small>HU</small>
        </label>
        <label>
          <span>3D brush radius</span>
          <input
            className="brush-radius-mm"
            type="number"
            min={0.5}
            max={10}
            step={0.5}
            value={brushRadiusMm}
            disabled={disabled}
            onChange={(event) => setBrushRadiusMm(Number(event.target.value))}
          />
          <small>mm</small>
        </label>
        <label>
          <span>Seed row</span>
          <input
            type="number"
            min={0}
            max={summary.dimensions[1] - 1}
            step={1}
            value={seed.row}
            disabled={disabled}
            onChange={(event) => updateSeed({ row: Number(event.target.value) })}
          />
          <small>pixel</small>
        </label>
        <label>
          <span>Seed column</span>
          <input
            type="number"
            min={0}
            max={summary.dimensions[0] - 1}
            step={1}
            value={seed.column}
            disabled={disabled}
            onChange={(event) => updateSeed({ column: Number(event.target.value) })}
          />
          <small>pixel</small>
        </label>
      </div>

      {result ? (
        <div className="segmentation-edit-actions">
          <button
            className="primary replace-slice-component"
            disabled={disabled || currentFrameState !== "ready" || !seedSelected}
            onClick={() => void replaceSliceComponent()}
          >
            Replace selected slice component
          </button>
          <button
            className="secondary add-segmentation-brush"
            disabled={disabled || currentFrameState !== "ready" || !seedSelected}
            title="Add a physical 3D sphere to the reviewed labelmap around the selected source voxel"
            onClick={() => void applySegmentationBrush("add")}
          >
            Add 3D brush
          </button>
          <button
            className="secondary remove-segmentation-brush"
            disabled={disabled || currentFrameState !== "ready" || !seedSelected}
            title="Remove a physical 3D sphere from the reviewed labelmap while preserving the confirmed seed"
            onClick={() => void applySegmentationBrush("remove")}
          >
            Remove 3D brush
          </button>
          <button
            className="secondary undo-segmentation-edit"
            disabled={disabled || !result.review.canUndo}
            onClick={() => void undoLastEdit()}
          >
            Undo last edit
          </button>
          <button
            className="secondary trim-before-slice"
            disabled={disabled || !canTrimBefore}
            title="Discard tracked samples before this source slice while retaining the confirmed seed"
            onClick={() => void trimSegmentedTrunk("before")}
          >
            Keep from this slice
          </button>
          <button
            className="secondary trim-after-slice"
            disabled={disabled || !canTrimAfter}
            title="Discard tracked samples after this source slice while retaining the confirmed seed"
            onClick={() => void trimSegmentedTrunk("after")}
          >
            Keep through this slice
          </button>
          <button
            className="secondary retrack-seed"
            disabled={disabled || currentFrameState !== "ready"}
            onClick={() => void trackSeed()}
          >
            Re-track entire trunk
          </button>
        </div>
      ) : (
        <button
          className="primary track-seed"
          disabled={disabled || currentFrameState !== "ready" || !seedSelected}
          onClick={() => void trackSeed()}
        >
          Track vessel from selected seed
        </button>
      )}
      {seedSelected ? (
        <small className="selected-seed-status">
          Selected seed: slice {seed.sliceIndex + 1}, row {seed.row}, column {seed.column}
        </small>
      ) : null}
      {mappingSelection ? <small className="selected-seed-status">Mapping source selection…</small> : null}
    </section>
  );
}
