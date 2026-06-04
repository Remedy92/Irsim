import { useEffect, useMemo } from "react";
import { buildNormalAnatomy } from "./sim/anatomy";
import { useSim } from "./sim/store";
import { Viewport } from "./three/Viewport";
import "./styles.css";

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
  onChange
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  fmt?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider">
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
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Metric({ label, value, unit, status }: { label: string; value: string; unit: string; status?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <b>
        {value}
        <i>{unit}</i>
      </b>
      {status ? <small>{status}</small> : null}
    </div>
  );
}

export function App() {
  const anatomy = useMemo(() => buildNormalAnatomy(), []);
  const { view, rao, cranial, steer, torque, targetId, metrics, set, advance, rotate, inject, reset } = useSim();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      const handled = ["w", "s", "a", "d", "q", "e", "f", "c", "r", "arrowup", "arrowdown", "arrowleft", "arrowright"];
      if (handled.includes(k)) e.preventDefault();
      const st = useSim.getState();
      if (k === "w" || k === "arrowup") st.advance(0.8);
      else if (k === "s" || k === "arrowdown") st.advance(-0.8);
      else if (k === "a" || k === "arrowleft" || k === "q") st.rotate(-0.18);
      else if (k === "d" || k === "arrowright" || k === "e") st.rotate(0.18);
      else if (k === "f") st.set({ view: st.view === "3d" ? "fluoro" : "3d" });
      else if (k === "c") st.inject();
      else if (k === "r") st.reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const target = anatomy.targets.find((x) => x.id === targetId) ?? anatomy.targets[0];

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
            R common femoral
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
          <Slider label="Tip tightness" min={0} max={1} step={0.01} value={steer} onChange={(v) => set({ steer: v })} />
          <Slider label="Tip rotation (torque)" min={-Math.PI} max={Math.PI} step={0.01} value={torque} fmt={(v) => `${((v * 180) / Math.PI).toFixed(0)}°`} onChange={(v) => set({ torque: v })} />
        </aside>

        <section className={`viewport ${view === "fluoro" ? "fluoro" : ""}`}>
          <Viewport />
          <div className="overlay tl">
            {view === "fluoro" ? "LIVE FLUORO" : "3D"} · {rao >= 0 ? "RAO" : "LAO"} {Math.abs(rao).toFixed(0)}° / {cranial >= 0 ? "CRAN" : "CAUD"} {Math.abs(cranial).toFixed(0)}°
          </div>
          {metrics.reached ? <div className="overlay reached">TARGET REACHED</div> : null}
        </section>

        <aside className="panel right">
          <h3>Metrics</h3>
          <Metric label="Wire deployed" value={metrics.depth.toFixed(1)} unit="cm" />
          <Metric label="Tip → target" value={metrics.tipToTarget.toFixed(1)} unit="cm" status={metrics.reached ? "In target" : "Navigating"} />
          <Metric label="Contrast" value={(metrics.contrast * 100).toFixed(0)} unit="%" status={metrics.contrast > 0.05 ? "Injecting" : "—"} />
          <div className="target-card">
            <span>Active target</span>
            <b>{target.name}</b>
            <small>Acceptance {target.acceptance.toFixed(1)} cm · via {target.viaBranchId}</small>
          </div>
        </aside>
      </section>

      <footer className="toolbar">
        <button onClick={() => advance(2)}>Advance <kbd>W</kbd></button>
        <button onClick={() => advance(-2)}>Retract <kbd>S</kbd></button>
        <button onClick={() => rotate(-0.3)}>Torque − <kbd>A</kbd></button>
        <button onClick={() => rotate(0.3)}>Torque + <kbd>D</kbd></button>
        <button onClick={() => inject()}>Inject contrast <kbd>C</kbd></button>
        <button onClick={() => set({ view: view === "3d" ? "fluoro" : "3d" })}>Toggle view <kbd>F</kbd></button>
        <button className="ghost" onClick={() => reset()}>Reset <kbd>R</kbd></button>
      </footer>
    </main>
  );
}
