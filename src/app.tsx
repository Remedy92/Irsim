import { useCallback, useEffect, useMemo, useState } from "react";
import { ANATOMY_VARIANTS, buildAnatomy } from "./sim/anatomy";
import { compileAnatomy } from "./sim/anatomyDoc";
import { GUIDEWIRE_PROFILE_IDS, GUIDEWIRE_PROFILES } from "./sim/cosserat";
import { parseAnatomyInput } from "./sim/anatomy-loader";
import { keyHints, resolveAction } from "./sim/controls";
import { useSim } from "./sim/store";
import { DicomImportDialog } from "./imaging/DicomImportDialog";
import type { LocalDicomResult, LocalDicomSummary } from "./imaging/types";
import { Viewport } from "./three/Viewport";
import "./styles.css";

const KEY_FEED_STEP_CM = 0.4;
const BUTTON_FEED_STEP_CM = 1;
const KEY_TORQUE_STEP_RAD = 0.12;
const BUTTON_TORQUE_STEP_RAD = 0.2;
const CARM_STEP_DEG = 5;

const clampRao = (v: number) => Math.max(-90, Math.min(90, v));
const clampCran = (v: number) => Math.max(-50, Math.min(50, v));

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  fmt,
  disabled,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  fmt?: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className={`slider${disabled ? " disabled" : ""}`}>
      <span>
        {label}
        <b>{fmt ? fmt(value) : value.toFixed(2)}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** A C-arm angulation axis: a labelled readout, a fine slider, and ±5° quick-step buttons. */
function CArmAxis({
  label,
  value,
  min,
  max,
  neg,
  pos,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  neg: string;
  pos: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="carm-axis">
      <div className="carm-head">
        <span>{label}</span>
        <b>
          {value >= 0 ? pos : neg} {Math.abs(value).toFixed(0)}°
        </b>
      </div>
      <div className="carm-row">
        <button className="step" title={`−${CARM_STEP_DEG}°`} onClick={() => onChange(value - CARM_STEP_DEG)}>
          −
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button className="step" title={`+${CARM_STEP_DEG}°`} onClick={() => onChange(value + CARM_STEP_DEG)}>
          +
        </button>
      </div>
    </div>
  );
}

/** One cell of the horizontal navigation metrics bar below the image. */
function MetricCell({
  label,
  value,
  unit,
  status,
  live
}: {
  label: string;
  value: string;
  unit?: string;
  status?: string;
  live?: boolean;
}) {
  return (
    <div className="mcell">
      <span>{label}</span>
      <b>
        {value}
        {unit ? <i>{unit}</i> : null}
      </b>
      {status ? <small className={live ? "live" : ""}>{status}</small> : null}
    </div>
  );
}

/** A clickable keycap chip showing one key glyph (the on-screen mirror of the physical key). */
function KeyCap({ glyph, title, onClick }: { glyph: string; title: string; onClick: () => void }) {
  return (
    <button className="keycap" title={title} aria-label={title} onClick={onClick}>
      {glyph}
    </button>
  );
}

/**
 * One device's control cluster in the bottom deck: a Feed pair and a Torque pair of keycaps,
 * labelled by function. Clicking the cluster (or any keycap in it) focuses that device; the
 * keycaps also drive it. The active device is highlighted.
 */
function DeviceDeck({
  name,
  glyphs,
  active,
  onSelect,
  onAdvance,
  onRetract,
  onTorqueMinus,
  onTorquePlus
}: {
  name: string;
  glyphs: { advance: string; retract: string; torqueMinus: string; torquePlus: string };
  active: boolean;
  onSelect: () => void;
  onAdvance: () => void;
  onRetract: () => void;
  onTorqueMinus: () => void;
  onTorquePlus: () => void;
}) {
  return (
    <div className={`dev-group${active ? " on" : ""}`} onClick={onSelect}>
      <span className="lab">{name}</span>
      <div className="ctl">
        <span>Feed</span>
        <div className="caps">
          <KeyCap glyph={glyphs.advance} title={`${name}: advance`} onClick={onAdvance} />
          <KeyCap glyph={glyphs.retract} title={`${name}: retract`} onClick={onRetract} />
        </div>
      </div>
      <div className="ctl">
        <span>Torque</span>
        <div className="caps">
          <KeyCap glyph={glyphs.torqueMinus} title={`${name}: torque −`} onClick={onTorqueMinus} />
          <KeyCap glyph={glyphs.torquePlus} title={`${name}: torque +`} onClick={onTorquePlus} />
        </div>
      </div>
    </div>
  );
}

/** A small approach compass: arrow toward the target in image space + distance + reached state. */
function Compass({ dir, dist, reached }: { dir: [number, number] | null; dist: number; reached: boolean }) {
  const angle = dir ? (Math.atan2(dir[1], dir[0]) * 180) / Math.PI : 0;
  return (
    <div className={`compass${reached ? " reached" : ""}`}>
      <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
        <circle cx="24" cy="24" r="21" className="ring" />
        {reached ? (
          <circle cx="24" cy="24" r="6" className="hit" />
        ) : dir ? (
          <g transform={`rotate(${angle} 24 24)`}>
            <line x1="24" y1="24" x2="41" y2="24" className="arrow" />
            <polygon points="41,24 35,20 35,28" className="head" />
          </g>
        ) : null}
      </svg>
      <div className="compass-read">
        <b>{dist.toFixed(1)}</b>
        <i>cm</i>
      </div>
    </div>
  );
}

export function App() {
  const {
    view,
    fluoroMode,
    fluoroBrightness,
    fluoroContrast,
    showLabels,
    labels,
    measureMode,
    measurePts,
    measureCm,
    pushMeasure,
    toggleMeasure,
    rao,
    cranial,
    accessId,
    variantId,
    loadedDoc,
    deviceProfile,
    wire,
    sheath,
    selected,
    layout,
    targetId,
    metrics,
    set,
    setAccess,
    setVariant,
    loadDoc,
    closeLocalCase,
    setDeviceProfile,
    select,
    setLayout,
    advance,
    rotate,
    setSteer,
    inject,
    reset
  } = useSim();
  // Recompiled when the operator picks a different scenario or loads a sidecar; the Viewport is
  // keyed on the same store state. A loaded sidecar supersedes the built-in variant.
  const anatomy = useMemo(
    () => (loadedDoc ? compileAnatomy(loadedDoc) : buildAnatomy(variantId)),
    [loadedDoc, variantId]
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(true);
  const [dicomOpen, setDicomOpen] = useState(false);
  const [localSummary, setLocalSummary] = useState<LocalDicomSummary | null>(null);
  const closeDicomDialog = useCallback(() => setDicomOpen(false), []);
  const loadReviewedDicom = useCallback(
    (result: LocalDicomResult) => {
      if (!result.doc) return;
      loadDoc(result.doc);
      setLocalSummary(result.summary);
      setLoadError(null);
    },
    [loadDoc]
  );

  // Load anatomy (.json) the operator drops in — the manual stand-in for the DICOM→centerline
  // ingestion pipeline output. Accepts either a compiled AnatomyDoc sidecar OR raw VMTK-style
  // centerlines (auto-detected + converted), validating before swapping the live anatomy.
  const onLoadSidecar = async (file: File | undefined) => {
    if (!file) return;
    try {
      const doc = parseAnatomyInput(await file.text());
      loadDoc(doc);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  // Keyboard: the wire and sheath are driven by separate, always-live key clusters (WASD/ZQSD
  // for the wire, arrows for the sheath), resolved through the pure mapping so the active layout
  // is honoured. Registered once; the layout is read live from the store.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return; // never hijack browser chords
      if (document.querySelector('[aria-modal="true"]')) return; // modal owns the keyboard while open
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
      const st = useSim.getState();
      const action = resolveAction(st.layout, e.key);
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case "device":
          if (action.control === "feed") st.advance(action.device, action.sign * KEY_FEED_STEP_CM);
          else st.rotate(action.device, action.sign * KEY_TORQUE_STEP_RAD);
          break;
        case "view":
          st.set({ view: st.view === "3d" ? "fluoro" : "3d" });
          break;
        case "inject":
          st.inject();
          break;
        case "reset":
          st.reset();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Prevent the browser back/forward cache from restoring patient-derived in-memory geometry.
  useEffect(() => {
    const clearSession = () => {
      if (useSim.getState().loadedDoc) useSim.getState().closeLocalCase();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) clearSession();
    };
    window.addEventListener("pagehide", clearSession);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", clearSession);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  const target = anatomy.targets.find((x) => x.id === targetId) ?? anatomy.targets[0];
  const selectedAccess = anatomy.access.find((a) => a.id === accessId) ?? anatomy.access[0];
  const accessShort = selectedAccess.name;
  // Path efficiency = straight-line access→target chord ÷ wire length used (1 = perfectly direct).
  const accessPos = selectedAccess.pos;
  const pathEfficiency = metrics.depth > 0 ? Math.min(1, accessPos.distanceTo(target.pos) / metrics.depth) : 0;
  const hints = keyHints(layout);
  const isFluoro = view === "fluoro";
  const fluoroLabel = fluoroMode === "dsa" ? "DSA" : fluoroMode === "roadmap" ? "Roadmap" : "Live";

  // The device the side-panel sliders edit. Absolute setters (sliders) clamp the same range as
  // the relative advance() action; both feed the same per-device store state.
  const dev = selected === "wire" ? wire : sheath;
  const patchSelected = (patch: Partial<typeof dev>) =>
    set(selected === "wire" ? { wire: { ...wire, ...patch } } : { sheath: { ...sheath, ...patch } });
  const setDeployed = (v: number) => patchSelected({ deployed: Math.max(2, Math.min(70, v)) });
  const setTorque = (v: number) => patchSelected({ torque: v });
  const selectedName = selected === "wire" ? "Guidewire" : "Sheath";

  return (
    <>
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span>IR</span>sim
          <small>Navigation Trainer</small>
        </div>
        <div className="case">
          <div>
            <span>Anatomy</span>
            {anatomy.name.replace(/\s*\(.*\)\s*$/, "")}
          </div>
          <div>
            <span>Access</span>
            {accessShort}
          </div>
          <div>
            <span>Mode</span>
            {isFluoro ? `Fluoro · ${fluoroLabel}` : "3D planning"}
          </div>
        </div>
        <div className="disclaimer">
          {loadedDoc
            ? "LOCAL CASE · IN MEMORY ONLY · NOT UPLOADED · PROTOTYPE REHEARSAL"
            : "Educational rehearsal on generic anatomy. Simulated, relative metrics. Not a medical device."}
        </div>
      </header>

      <section className="work">
        <aside className="panel left">
          {/* ---- View / acquisition ---- */}
          <h3>View</h3>
          <div className="seg">
            <button className={view === "3d" ? "on" : ""} onClick={() => set({ view: "3d" })}>
              3D
            </button>
            <button className={isFluoro ? "on" : ""} onClick={() => set({ view: "fluoro" })}>
              Fluoro
            </button>
          </div>
          {isFluoro ? (
            <div className="seg sub">
              <button className={fluoroMode === "live" ? "on" : ""} onClick={() => set({ fluoroMode: "live" })}>
                Live
              </button>
              <button className={fluoroMode === "dsa" ? "on" : ""} onClick={() => set({ fluoroMode: "dsa" })}>
                DSA
              </button>
              <button className={fluoroMode === "roadmap" ? "on" : ""} onClick={() => set({ fluoroMode: "roadmap" })}>
                Roadmap
              </button>
            </div>
          ) : null}

          {/* ---- Target ---- */}
          <h3>Target vessel</h3>
          <select value={targetId} onChange={(e) => set({ targetId: e.target.value })}>
            {anatomy.targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          {/* ---- C-arm ---- */}
          <h3>C-arm</h3>
          <CArmAxis label="RAO / LAO" value={rao} min={-90} max={90} neg="LAO" pos="RAO" onChange={(v) => set({ rao: clampRao(v) })} />
          <CArmAxis label="Cranial / Caudal" value={cranial} min={-50} max={50} neg="CAUD" pos="CRAN" onChange={(v) => set({ cranial: clampCran(v) })} />

          {/* ---- Image (fluoro windowing) ---- */}
          {isFluoro ? (
            <>
              <h3>Image</h3>
              <Slider label="Brightness" min={-0.4} max={0.4} step={0.01} value={fluoroBrightness} fmt={(v) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2))} onChange={(v) => set({ fluoroBrightness: v })} />
              <Slider label="Contrast (window)" min={0.4} max={2.6} step={0.02} value={fluoroContrast} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => set({ fluoroContrast: v })} />
              <label className="field">
                <span>Vessel labels</span>
                <div className="seg">
                  <button className={showLabels ? "on" : ""} onClick={() => set({ showLabels: true })}>
                    On
                  </button>
                  <button className={!showLabels ? "on" : ""} onClick={() => set({ showLabels: false })}>
                    Off
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Caliper{measureMode ? " · click two points" : measureCm > 0 ? ` · ${measureCm.toFixed(1)} cm` : ""}</span>
                <div className="seg">
                  <button className={measureMode ? "on" : ""} onClick={() => { if (!measureMode) toggleMeasure(); }}>
                    Measure
                  </button>
                  <button className={!measureMode ? "on" : ""} onClick={() => { if (measureMode) toggleMeasure(); }}>
                    Off
                  </button>
                </div>
              </label>
            </>
          ) : null}

          {/* ---- Instrument ---- */}
          <h3>Instrument</h3>
          <label className="field">
            <span>Wire type · {GUIDEWIRE_PROFILES[deviceProfile].shaftEiCm} N·cm² EI</span>
            <div className="seg">
              {GUIDEWIRE_PROFILE_IDS.map((id) => (
                <button
                  key={id}
                  className={deviceProfile === id ? "on" : ""}
                  title={GUIDEWIRE_PROFILES[id].name}
                  onClick={() => setDeviceProfile(id)}
                >
                  {GUIDEWIRE_PROFILES[id].short}
                </button>
              ))}
            </div>
          </label>
          <div className="seg">
            <button className={selected === "wire" ? "on" : ""} onClick={() => select("wire")}>
              Guidewire
            </button>
            <button className={selected === "sheath" ? "on" : ""} onClick={() => select("sheath")}>
              Sheath
            </button>
          </div>
          <Slider label={`${selectedName} deployed`} min={2} max={70} step={0.5} value={dev.deployed} fmt={(v) => `${v.toFixed(1)} cm`} onChange={setDeployed} />
          <Slider label={`${selectedName} rotation`} min={-Math.PI} max={Math.PI} step={0.01} value={dev.torque} fmt={(v) => `${((v * 180) / Math.PI).toFixed(0)}°`} onChange={setTorque} />
          <Slider label="Tip tightness" min={0} max={1} step={0.01} value={dev.steer} disabled={selected === "sheath"} onChange={(v) => setSteer(selected, v)} />

          {/* ---- Setup (collapsible) ---- */}
          <button
            className={`disclosure${setupOpen ? " open" : ""}`}
            aria-expanded={setupOpen}
            onClick={() => setSetupOpen((o) => !o)}
          >
            <span>Setup</span>
            <small>
              {accessShort} · {anatomy.name.replace(/\s*\(.*\)\s*$/, "")}
            </small>
          </button>
          {setupOpen ? (
            <div className="disclosure-body">
              <label className="field">
                <span>Access · start site</span>
                <div className="seg access-options">
                  {anatomy.access.map((access) => (
                    <button
                      key={access.id}
                      className={accessId === access.id ? "on" : ""}
                      aria-pressed={accessId === access.id}
                      onClick={() => setAccess(access.id)}
                    >
                      {access.name}
                    </button>
                  ))}
                </div>
              </label>
              <label className="field">
                <span>Scenario · anatomy</span>
                <select
                  value={loadedDoc ? "loaded" : variantId ?? "normal"}
                  onChange={(e) => setVariant(e.target.value === "normal" ? undefined : e.target.value)}
                >
                  <option value="normal">Normal anatomy</option>
                  {ANATOMY_VARIANTS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                  {loadedDoc ? <option value="loaded">Loaded · {loadedDoc.name}</option> : null}
                </select>
              </label>
              <div className="source-card">
                <span>Anatomy source</span>
                {loadedDoc ? (
                  <>
                    <b>Local case · session only</b>
                    {localSummary ? (
                      <small>
                        {localSummary.selectedSliceCount} CT slices · {localSummary.confidence} extraction confidence
                      </small>
                    ) : (
                      <small>Advanced local anatomy document</small>
                    )}
                    <button
                      className="secondary"
                      onClick={() => {
                        closeLocalCase();
                        setLocalSummary(null);
                      }}
                    >
                      Close case & clear session
                    </button>
                  </>
                ) : (
                  <>
                    <b>Built-in public demo</b>
                    <small>Always available · no files required</small>
                    <button className="primary" onClick={() => setDicomOpen(true)}>
                      Import local DICOM CT
                    </button>
                  </>
                )}
              </div>
              <details className="advanced-import">
                <summary>Advanced anatomy JSON</summary>
                <label className="loadrow">
                  <span>Load sidecar (.json)</span>
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={(e) => {
                      void onLoadSidecar(e.target.files?.[0]);
                      setLocalSummary(null);
                      e.target.value = "";
                    }}
                  />
                </label>
              </details>
              {loadError ? <p className="hint err">Could not load anatomy: {loadError}</p> : null}
              <label className="field">
                <span>Keyboard layout</span>
                <div className="seg">
                  <button className={layout === "qwerty" ? "on" : ""} onClick={() => setLayout("qwerty")}>
                    QWERTY
                  </button>
                  <button className={layout === "azerty" ? "on" : ""} onClick={() => setLayout("azerty")}>
                    AZERTY
                  </button>
                </div>
              </label>
            </div>
          ) : null}
        </aside>

        <div className="center">
          <section className={`viewport ${isFluoro ? "fluoro" : ""}`}>
            <Viewport />
            <div className="frame" aria-hidden="true" />
            {isFluoro && showLabels ? (
              <div className="labels" aria-hidden="true">
                {labels.map((l, i) => (
                  <span key={`${l.name}-${i}`} style={{ left: `${l.x * 100}%`, top: `${l.y * 100}%` }}>
                    {l.name}
                  </span>
                ))}
              </div>
            ) : null}
            {isFluoro && measureMode ? (
              <div
                className="measure-layer"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = (e.clientX - rect.left) / rect.width;
                  const y = (e.clientY - rect.top) / rect.height;
                  pushMeasure({ x, y }, rect.width / Math.max(1, rect.height), metrics.sid);
                }}
              >
                {measurePts.map((p, i) => (
                  <span className="mpt" key={i} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} />
                ))}
                {measurePts.length === 2 ? (
                  <>
                    <svg className="mline" viewBox="0 0 100 100" preserveAspectRatio="none">
                      <line
                        x1={measurePts[0].x * 100}
                        y1={measurePts[0].y * 100}
                        x2={measurePts[1].x * 100}
                        y2={measurePts[1].y * 100}
                      />
                    </svg>
                    <span
                      className="mlabel"
                      style={{
                        left: `${((measurePts[0].x + measurePts[1].x) / 2) * 100}%`,
                        top: `${((measurePts[0].y + measurePts[1].y) / 2) * 100}%`
                      }}
                    >
                      {measureCm.toFixed(1)} cm
                    </span>
                  </>
                ) : null}
              </div>
            ) : null}
            <div className={`overlay tl ${isFluoro ? "live" : "plan"}`}>
              {isFluoro ? fluoroLabel.toUpperCase() : "3D PLANNING"} · {rao >= 0 ? "RAO" : "LAO"} {Math.abs(rao).toFixed(0)}° / {cranial >= 0 ? "CRAN" : "CAUD"} {Math.abs(cranial).toFixed(0)}°
            </div>
            {metrics.reached ? <div className="overlay reached">● TARGET REACHED</div> : null}
            {/* burned-in C-arm corner data (authentic acquisition readouts) */}
            <div className="overlay bl">
              SID {metrics.sid.toFixed(0)} cm · {metrics.mag.toFixed(2)}×
            </div>
            <div className="overlay br">
              DAP {metrics.dose.toFixed(1)} · FL {fmtTime(metrics.fluoroTime)}
            </div>
          </section>

          <div className="metrics-bar">
            <MetricCell label="Wire depth" value={metrics.depth.toFixed(1)} unit="cm" />
            <MetricCell
              label="Tip → target"
              value={metrics.tipToTarget.toFixed(1)}
              unit="cm"
              status={metrics.reached ? "In target" : "Navigating"}
              live={metrics.reached}
            />
            <MetricCell
              label="Contrast"
              value={(metrics.contrast * 100).toFixed(0)}
              unit="%"
              status={metrics.contrast > 0.05 ? "Injecting" : "Idle"}
              live={metrics.contrast > 0.05}
            />
            <MetricCell label="Procedure" value={fmtTime(metrics.procTime)} />
            <MetricCell label="Fluoro time" value={fmtTime(metrics.fluoroTime)} />
            <MetricCell label="Dose (DAP)" value={metrics.dose.toFixed(1)} />
          </div>
        </div>

        <aside className="panel right">
          <h3>Approach</h3>
          <div className="approach">
            <Compass dir={metrics.tipDir} dist={metrics.tipToTarget} reached={metrics.reached} />
            <div className="approach-state">
              <b>{metrics.reached ? "In target" : metrics.tipToTarget < target.acceptance * 2 ? "Closing" : "Navigating"}</b>
              <small>acceptance {target.acceptance.toFixed(1)} cm</small>
            </div>
          </div>
          <div className="target-card">
            <span>Active target</span>
            <b>{target.name}</b>
            <small>via {target.viaBranchId}</small>
          </div>

          {metrics.reached ? (
            <>
              <h3>Run debrief</h3>
              <div className="debrief">
                <div>
                  <span>Procedure</span>
                  <b>{fmtTime(metrics.procTime)}</b>
                </div>
                <div>
                  <span>Fluoro time</span>
                  <b>{fmtTime(metrics.fluoroTime)}</b>
                </div>
                <div>
                  <span>Dose (DAP)</span>
                  <b>{metrics.dose.toFixed(1)}</b>
                </div>
                <div>
                  <span>Wire used</span>
                  <b>
                    {metrics.depth.toFixed(1)}
                    <i>cm</i>
                  </b>
                </div>
                <div>
                  <span>Path efficiency</span>
                  <b>{(pathEfficiency * 100).toFixed(0)}%</b>
                </div>
              </div>
            </>
          ) : null}

          <h3>Console</h3>
          <div className="console-keys">
            <button onClick={() => set({ view: isFluoro ? "3d" : "fluoro" })}>
              View <kbd>{hints.view}</kbd>
            </button>
            <button onClick={() => inject()}>
              Inject <kbd>{hints.inject}</kbd>
            </button>
            <button onClick={() => reset()}>
              Reset <kbd>{hints.reset}</kbd>
            </button>
          </div>
        </aside>
      </section>

      <footer className="toolbar deck">
        <DeviceDeck
          name="Wire"
          glyphs={hints.wire}
          active={selected === "wire"}
          onSelect={() => select("wire")}
          onAdvance={() => advance("wire", BUTTON_FEED_STEP_CM)}
          onRetract={() => advance("wire", -BUTTON_FEED_STEP_CM)}
          onTorqueMinus={() => rotate("wire", -BUTTON_TORQUE_STEP_RAD)}
          onTorquePlus={() => rotate("wire", BUTTON_TORQUE_STEP_RAD)}
        />
        <DeviceDeck
          name="Sheath"
          glyphs={hints.sheath}
          active={selected === "sheath"}
          onSelect={() => select("sheath")}
          onAdvance={() => advance("sheath", BUTTON_FEED_STEP_CM)}
          onRetract={() => advance("sheath", -BUTTON_FEED_STEP_CM)}
          onTorqueMinus={() => rotate("sheath", -BUTTON_TORQUE_STEP_RAD)}
          onTorquePlus={() => rotate("sheath", BUTTON_TORQUE_STEP_RAD)}
        />
        <p className="deck-hint">Drag to angle the C-arm · shift-drag to pan · scroll to zoom (SID)</p>
      </footer>
    </main>
    <DicomImportDialog
      open={dicomOpen}
      onClose={closeDicomDialog}
      onLoad={loadReviewedDicom}
    />
    </>
  );
}
