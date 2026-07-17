import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AxialSeedReview } from "./AxialSeedReview";
import { openLocalDicomSession, type LocalDicomSession } from "./local-dicom";
import { canLoadReviewedLocalDicom } from "./review-gate";
import {
  DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
  type DicomPipelineProgress,
  type LocalDicomResult,
  type LocalDicomSummary,
  type OrthogonalReviewPlane,
  type VesselSegmentationSettings
} from "./types";

export const DicomImportDialog = memo(function DicomImportDialog({
  open,
  onClose,
  onLoad
}: {
  open: boolean;
  onClose: () => void;
  onLoad: (result: LocalDicomResult) => void;
}) {
  const [settings, setSettings] = useState<VesselSegmentationSettings>(
    DEFAULT_VESSEL_SEGMENTATION_SETTINGS
  );
  const [progress, setProgress] = useState<DicomPipelineProgress | null>(null);
  const [summary, setSummary] = useState<LocalDicomSummary | null>(null);
  const [result, setResult] = useState<LocalDicomResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [reviewedCheckpointKeys, setReviewedCheckpointKeys] = useState<Set<string>>(() => new Set());
  const controller = useRef<AbortController | null>(null);
  const session = useRef<LocalDicomSession | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const clearTransient = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    session.current?.dispose();
    session.current = null;
    setProgress(null);
    setSummary(null);
    setResult(null);
    setApproved(false);
    setReviewedCheckpointKeys(new Set());
    setError(null);
    setBusy(false);
  }, []);

  const close = useCallback(() => {
    clearTransient();
    onCloseRef.current();
  }, [clearTransient]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const releaseImagingSession = () => clearTransient();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pagehide", releaseImagingSession);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", releaseImagingSession);
      clearTransient();
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
      previousFocus.current = null;
    };
  }, [open, close, clearTransient]);

  const markCheckpointReviewed = useCallback((sliceIndex: number, revision: number) => {
    setReviewedCheckpointKeys((current) => {
      const key = `${revision}:axial:${sliceIndex}`;
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, []);

  const markOrthogonalCheckpointReviewed = useCallback(
    (plane: OrthogonalReviewPlane, planeIndex: number, revision: number) => {
      setReviewedCheckpointKeys((current) => {
        const key = `${revision}:${plane}:${planeIndex}`;
        if (current.has(key)) return current;
        const next = new Set(current);
        next.add(key);
        return next;
      });
    },
    []
  );

  if (!open) return null;

  const processFiles = async (fileList: FileList | null) => {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0) return;
    clearTransient();
    const nextController = new AbortController();
    controller.current = nextController;
    setBusy(true);
    try {
      const next = await openLocalDicomSession(files, {
        settings,
        signal: nextController.signal,
        onProgress: setProgress
      });
      if (nextController.signal.aborted) {
        next.dispose();
        return;
      }
      session.current = next;
      setSummary(next.summary);
      setProgress(null);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "Local DICOM processing failed");
      }
    } finally {
      if (controller.current === nextController) controller.current = null;
      setBusy(false);
    }
  };

  const percent = progress ? Math.round((progress.completed / Math.max(1, progress.total)) * 100) : 0;
  const reviewSummary = result?.summary ?? summary;
  const requiredCheckpoints = result?.review.requiredSourceSliceCheckpoints ?? [];
  const reviewedCheckpointSlices = result
    ? requiredCheckpoints.filter((sliceIndex) =>
        reviewedCheckpointKeys.has(`${result.review.revision}:axial:${sliceIndex}`)
      )
    : [];
  const requiredOrthogonalCheckpoints = result?.review.requiredOrthogonalCheckpoints ?? [];
  const reviewedOrthogonalCheckpoints = result
    ? requiredOrthogonalCheckpoints.filter((checkpoint) =>
        reviewedCheckpointKeys.has(
          `${result.review.revision}:${checkpoint.plane}:${checkpoint.planeIndex}`
        )
      )
    : [];
  const axialCheckpointReviewComplete =
    requiredCheckpoints.length > 0 && reviewedCheckpointSlices.length === requiredCheckpoints.length;
  const orthogonalCheckpointReviewComplete =
    requiredOrthogonalCheckpoints.length > 0 &&
    reviewedOrthogonalCheckpoints.length === requiredOrthogonalCheckpoints.length;
  const checkpointReviewComplete = axialCheckpointReviewComplete && orthogonalCheckpointReviewComplete;
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        ref={dialog}
        className="dicom-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dicom-dialog-title"
        aria-describedby="dicom-privacy"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            dialog.current?.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
            ) ?? []
          ).filter((element) => element.offsetParent !== null);
          if (focusable.length === 0) {
            event.preventDefault();
            heading.current?.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const active = document.activeElement;
          const activeIsSequential = active instanceof HTMLElement && focusable.includes(active);
          if (event.shiftKey && (active === first || !activeIsSequential)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (active === last || !activeIsSequential)) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <div>
            <small>Session-only imaging</small>
            <h2 id="dicom-dialog-title" ref={heading} tabIndex={-1}>
              Import and review local DICOM CT
            </h2>
          </div>
          <button className="icon-button" onClick={close} aria-label="Close DICOM import">
            ×
          </button>
        </header>

        <div className="privacy-card" id="dicom-privacy">
          <b>Processed in this browser tab</b>
          <p>
            IRsim does not upload selected files or intentionally store them on IRsim servers or in browser storage.
            Pixel data and derived anatomy remain health information; use an approved device and workflow.
          </p>
        </div>

        <fieldset disabled={busy || Boolean(summary)}>
          <legend>Threshold tracking limits</legend>
          <div className="dicom-settings">
            <label>
              <span>Minimum attenuation</span>
              <input
                type="number"
                min={50}
                max={1000}
                step={10}
                value={settings.huMin}
                onChange={(event) => setSettings((current) => ({ ...current, huMin: Number(event.target.value) }))}
              />
              <small>HU · default 160</small>
            </label>
            <label>
              <span>Maximum attenuation</span>
              <input
                type="number"
                min={100}
                max={3000}
                step={10}
                value={settings.huMax}
                onChange={(event) => setSettings((current) => ({ ...current, huMax: Number(event.target.value) }))}
              />
              <small>HU · default 650</small>
            </label>
          </div>
          <p className="dicom-help">
            This prototype accepts uncompressed or JPEG 2000 Lossless single-frame CT and tracks one
            operator-seeded bright tubular trunk. It does not segment a complete vascular tree and is
            not validated for diagnosis or clinical decisions.
          </p>
        </fieldset>

        {!busy && !summary ? (
          <label className="dicom-picker">
            <b>{error ? "Choose another CT series" : "Choose a CT series"}</b>
            <span>Select all slices from one acquisition. Full HU data remains in an isolated worker.</span>
            <input
              type="file"
              multiple
              onChange={(event) => {
                void processFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
        ) : null}

        {busy && progress ? (
          <div className="dicom-progress" role="status" aria-live="polite">
            <div>
              <b>{progress.message}</b>
              <span>{percent}%</span>
            </div>
            <progress value={progress.completed} max={Math.max(1, progress.total)} />
            {controller.current ? (
              <button className="secondary" onClick={() => controller.current?.abort()}>
                Cancel processing
              </button>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="dicom-error" role="alert">
            {error}
          </p>
        ) : null}

        {summary && session.current ? (
          <AxialSeedReview
            session={session.current}
            summary={summary}
            settings={settings}
            result={result}
            disabled={busy}
            onBusyChange={setBusy}
            onProgress={setProgress}
            onResult={(next) => {
              setResult(next);
              setSummary(next.summary);
              setApproved(false);
              setReviewedCheckpointKeys(new Set());
              setError(null);
            }}
            onInvalidate={() => {
              setResult(null);
              setApproved(false);
              setReviewedCheckpointKeys(new Set());
            }}
            onApprovalInvalidate={() => setApproved(false)}
            reviewedCheckpointSlices={reviewedCheckpointSlices}
            onCheckpointFrameReviewed={markCheckpointReviewed}
            reviewedOrthogonalCheckpoints={reviewedOrthogonalCheckpoints}
            onOrthogonalCheckpointFrameReviewed={markOrthogonalCheckpointReviewed}
            onError={setError}
          />
        ) : null}

        {reviewSummary ? (
          <div className="dicom-review">
            <div className="dicom-result-head">
              <div>
                <small>
                  {result
                    ? "Seed-confirmed result"
                    : reviewSummary.segmentationOverlayAvailable
                      ? "Proposal — not loadable"
                      : "Source review — seed required"}
                </small>
                <b>{reviewSummary.segmentedSliceCount} centerline samples</b>
              </div>
              <span className={`confidence ${reviewSummary.confidence}`}>
                {reviewSummary.confidence} confidence
              </span>
            </div>
            <dl>
              <div>
                <dt>CT volume</dt>
                <dd>{reviewSummary.dimensions.join(" × ")}</dd>
              </div>
              <div>
                <dt>Voxel spacing</dt>
                <dd>{reviewSummary.spacingMm.map((value) => value.toFixed(2)).join(" × ")} mm</dd>
              </div>
              <div>
                <dt>Path coverage</dt>
                <dd>{reviewSummary.coveragePercent.toFixed(0)}%</dd>
              </div>
              <div>
                <dt>Ignored files</dt>
                <dd>{reviewSummary.ignoredFileCount}</dd>
              </div>
            </dl>
            <ul className="dicom-warnings">
              {reviewSummary.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>

            {result ? (
              <section
                className={`topology-review ${result.review.topologyStatus}`}
                aria-labelledby="topology-review-title"
              >
                <div>
                  <small>Editable sparse labelmap · revision {result.review.revision}</small>
                  <b id="topology-review-title">
                    {result.review.topologyStatus === "pass"
                      ? "Single-trunk topology checks passed"
                      : "Topology review blocks loading"}
                  </b>
                </div>
                {result.review.topologyBlockers.length > 0 ? (
                  <ul className="topology-blockers">
                    {result.review.topologyBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                  </ul>
                ) : null}
                {result.review.topologyWarnings.length > 0 ? (
                  <ul className="topology-warnings">
                    {result.review.topologyWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                ) : null}
                {result.review.editHistory.length > 0 ? (
                  <details className="segmentation-edit-history">
                    <summary>{result.review.editHistory.length} session edit record(s)</summary>
                    <ol>
                      {result.review.editHistory.map((record) => (
                        <li key={record.revision}>
                          Revision {record.revision}:{" "}
                          {record.action === "undo"
                            ? "undo"
                            : record.action === "replace-slice-component"
                              ? "replaced component"
                              : record.action === "brush-add"
                                ? `added ${record.brushRadiusMm?.toFixed(1)} mm 3D brush across ${record.affectedSliceCount} slice(s) at`
                                : record.action === "brush-remove"
                                  ? `removed ${record.brushRadiusMm?.toFixed(1)} mm 3D brush across ${record.affectedSliceCount} slice(s) at`
                              : record.action === "trim-before"
                                ? "discarded tracked samples before"
                                : "discarded tracked samples after"}{" "}
                          source slice {record.sliceIndex + 1}
                          {record.action === "brush-add" || record.action === "brush-remove"
                            ? `, row ${record.brushCenterRow}, column ${record.brushCenterColumn} (${record.changedVoxelCount} changed voxel(s))`
                            : null}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </section>
            ) : null}

            {result ? (
              <label className="dicom-approval">
                <input
                  type="checkbox"
                  checked={approved}
                  disabled={busy || result.review.topologyStatus === "block" || !checkpointReviewComplete}
                  onChange={(event) => setApproved(event.target.checked)}
                />
                <span>
                  {checkpointReviewComplete
                    ? "I reviewed the required acquisition checkpoints, seed-aligned patient-coronal/patient-sagittal context, and seeded overlays and confirm this is the intended vascular trunk for simulation rehearsal."
                    : `Review all required current-revision frames before attestation (acquisition ${reviewedCheckpointSlices.length}/${requiredCheckpoints.length}; patient MPR ${reviewedOrthogonalCheckpoints.length}/${requiredOrthogonalCheckpoints.length}).`}
                </span>
              </label>
            ) : (
              <p className="seed-required">Place and track a vascular seed before this anatomy can be loaded.</p>
            )}

            <div className="dialog-actions">
              <button className="secondary" disabled={busy} onClick={clearTransient}>
                Try another series
              </button>
              <button
                className="primary"
                disabled={
                  !canLoadReviewedLocalDicom(
                    result,
                    approved,
                    busy,
                    axialCheckpointReviewComplete,
                    orthogonalCheckpointReviewComplete
                  )
                }
                onClick={() => {
                  if (
                    !result ||
                    !canLoadReviewedLocalDicom(
                      result,
                      approved,
                      busy,
                      axialCheckpointReviewComplete,
                      orthogonalCheckpointReviewComplete
                    )
                  ) return;
                  onLoad(result);
                  close();
                }}
              >
                Load reviewed anatomy
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
});
