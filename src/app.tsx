import { useEffect, useMemo } from "react";
import { buildNormalAnatomy } from "./sim/anatomy";
import { keyHints, resolveAction } from "./sim/controls";
import { useSim } from "./sim/store";
import { Viewport } from "./three/Viewport";
import "./styles.css";

const KEY_FEED_STEP_CM = 0.4;
const BUTTON_FEED_STEP_CM = 1;
const KEY_TORQUE_STEP_RAD = 0.12;
const BUTTON_TORQUE_STEP_RAD = 0.2;

function Segmented() {
  const view = useSim((s) => s.view);
  const set = useSim((s) => s.set);
  return (
    <div className="seg">
      <button className={view === "3d" ? "on" : ""} onClick={() => set({ view: "3d" })}>
        3D
      </button>
      <button className={view === "fluoro" ? "on" : ""} onClick={() => set({ view: "fluoro" })}>
        Fluoro 2D
      </button>
    </div>
  );
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

function Metric({
  label,
  value,
  unit,
  status,
  live
}: {
  label: string;
  value: string;
  unit: string;
  status?: string;
  live?: boolean;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <b>
        {value}
        <i>{unit}</i>
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

export function App() {
  const anatomy = useMemo(() => buildNormalAnatomy(), []);
  const {
    view,
    rao,
    cranial,
    accessId,
    wire,
    sheath,
    selected,
    layout,
    targetId,
    metrics,
    set,
    setAccess,
    select,
    setLayout,
    advance,
    rotate,
    setSteer,
    inject,
    reset
  } = useSim();

  // Keyboard: the wire and sheath are driven by separate, always-live key clusters (WASD/ZQSD
  // for the wire, arrows for the sheath), resolved through the pure mapping so the active layout
  // is honoured. Registered once; the layout is read live from the store.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return; // never hijack browser chords
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

  const target = anatomy.targets.find((x) => x.id === targetId) ?? anatomy.targets[0];
  const access = anatomy.access.find((a) => a.id === accessId) ?? anatomy.access[0];
  const accessShort = accessId === "lcfa" ? "L common femoral" : "R common femoral";
  const hints = keyHints(layout);

  // The device the side-panel sliders edit. Absolute setters (sliders) clamp the same range as
  // the relative advance() action; both feed the same per-device store state.
  const dev = selected === "wire" ? wire : sheath;
  const patchSelected = (patch: Partial<typeof dev>) =>
    set(selected === "wire" ? { wire: { ...wire, ...patch } } : { sheath: { ...sheath, ...patch } });
  const setDeployed = (v: number) => patchSelected({ deployed: Math.max(2, Math.min(70, v)) });
  const setTorque = (v: number) => patchSelected({ torque: v });
  const selectedName = selected === "wire" ? "Guidewire" : "Sheath";

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span>IR</span>sim
          <small>Navigation Trainer · Phase 0</small>
        </div>
        <div className="case">
          <div>
            <span>Anatomy</span>
            {anatomy.name}
          </div>
          <div>
            <span>Access</span>
            {accessShort}
          </div>
          <div>
            <span>Mode</span>
            {view === "fluoro" ? "Fluoroscopy" : "3D planning"}
          </div>
        </div>
        <div className="disclaimer">
          Educational rehearsal on generic anatomy. Simulated, relative metrics. Not a medical device.
        </div>
      </header>

      <section className="work">
        <aside className="panel left">
          <h3>View</h3>
          <Segmented />

          <h3>Access · start side</h3>
          <div className="seg">
            <button className={accessId === "rcfa" ? "on" : ""} onClick={() => setAccess("rcfa")}>
              Right femoral
            </button>
            <button className={accessId === "lcfa" ? "on" : ""} onClick={() => setAccess("lcfa")}>
              Left femoral
            </button>
          </div>
          <p className="hint">{access.name}. Changing the side restarts the run there.</p>

          <h3>Target</h3>
          <select value={targetId} onChange={(e) => set({ targetId: e.target.value })}>
            {anatomy.targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <h3>C-arm</h3>
          <Slider label="RAO / LAO" min={-90} max={90} step={1} value={rao} fmt={(v) => `${v >= 0 ? "RAO" : "LAO"} ${Math.abs(v).toFixed(0)}°`} onChange={(v) => set({ rao: v })} />
          <Slider label="CRAN / CAUD" min={-50} max={50} step={1} value={cranial} fmt={(v) => `${v >= 0 ? "CRAN" : "CAUD"} ${Math.abs(v).toFixed(0)}°`} onChange={(v) => set({ cranial: v })} />
          <p className="hint">Drag the image to angle the C-arm · scroll to zoom (SID)</p>

          <h3>Instrument</h3>
          <div className="seg">
            <button className={selected === "wire" ? "on" : ""} onClick={() => select("wire")}>
              Guidewire
            </button>
            <button className={selected === "sheath" ? "on" : ""} onClick={() => select("sheath")}>
              Sheath
            </button>
          </div>
          <Slider label={`${selectedName} deployed`} min={2} max={70} step={0.5} value={dev.deployed} fmt={(v) => `${v.toFixed(1)} cm`} onChange={setDeployed} />
          <Slider label={`${selectedName} rotation (torque)`} min={-Math.PI} max={Math.PI} step={0.01} value={dev.torque} fmt={(v) => `${((v * 180) / Math.PI).toFixed(0)}°`} onChange={setTorque} />
          <Slider
            label="Tip tightness"
            min={0}
            max={1}
            step={0.01}
            value={dev.steer}
            disabled={selected === "sheath"}
            onChange={(v) => setSteer(selected, v)}
          />
          {selected === "sheath" ? <p className="hint">The sheath has no pre-shaped tip — tip tightness applies to the guidewire.</p> : null}
        </aside>

        <section className={`viewport ${view === "fluoro" ? "fluoro" : ""}`}>
          <Viewport />
          <div className="frame" aria-hidden="true" />
          <div className={`overlay tl ${view === "fluoro" ? "live" : "plan"}`}>
            {view === "fluoro" ? "LIVE FLUORO" : "3D PLANNING"} · {rao >= 0 ? "RAO" : "LAO"} {Math.abs(rao).toFixed(0)}° / {cranial >= 0 ? "CRAN" : "CAUD"} {Math.abs(cranial).toFixed(0)}°
          </div>
          {metrics.reached ? <div className="overlay reached">● TARGET REACHED</div> : null}
        </section>

        <aside className="panel right">
          <h3>Metrics</h3>
          <Metric label="Wire deployed" value={metrics.depth.toFixed(1)} unit="cm" />
          <Metric
            label="Tip → target"
            value={metrics.tipToTarget.toFixed(1)}
            unit="cm"
            status={metrics.reached ? "In target" : "Navigating"}
            live={metrics.reached}
          />
          <Metric
            label="Contrast"
            value={(metrics.contrast * 100).toFixed(0)}
            unit="%"
            status={metrics.contrast > 0.05 ? "Injecting" : "Idle"}
            live={metrics.contrast > 0.05}
          />
          <div className="target-card">
            <span>Active target</span>
            <b>{target.name}</b>
            <small>Acceptance {target.acceptance.toFixed(1)} cm · via {target.viaBranchId}</small>
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

        <div className="deck-globals">
          <div className="ctl">
            <span>Console</span>
            <div className="caps">
              <button className="keycap wide" title="Toggle view" aria-label="Toggle view" onClick={() => set({ view: view === "3d" ? "fluoro" : "3d" })}>
                {hints.view}
              </button>
              <button className="keycap wide" title="Inject contrast" aria-label="Inject contrast" onClick={() => inject()}>
                {hints.inject}
              </button>
              <button className="keycap wide" title="Reset run" aria-label="Reset run" onClick={() => reset()}>
                {hints.reset}
              </button>
            </div>
          </div>
          <div className="ctl">
            <span>Keyboard</span>
            <div className="seg layout">
              <button className={layout === "qwerty" ? "on" : ""} onClick={() => setLayout("qwerty")}>
                QWERTY
              </button>
              <button className={layout === "azerty" ? "on" : ""} onClick={() => setLayout("azerty")}>
                AZERTY
              </button>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
