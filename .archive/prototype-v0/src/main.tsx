import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  RotateCcw,
  SquareActivity
} from "lucide-react";
import { VesselViewport } from "./vessel-viewport";
import "./styles.css";

export type AnatomyId =
  | "standard"
  | "replaced-right"
  | "celiac-stenosis"
  | "tortuous-iliac"
  | "pulmonary-avm";

export type ViewMode = "three-d" | "fluoro";

const variants: Array<{
  id: AnatomyId;
  name: string;
  note: string;
  color: string;
  target: string;
}> = [
  {
    id: "standard",
    name: "Standard hepatic",
    note: "Celiac, CHA, GDA, proper hepatic",
    color: "#ff7b5c",
    target: "Right Hepatic Artery"
  },
  {
    id: "replaced-right",
    name: "Replaced RHA",
    note: "Right hepatic arises from SMA",
    color: "#f2b14a",
    target: "Replaced RHA"
  },
  {
    id: "celiac-stenosis",
    name: "Celiac stenosis",
    note: "Ostial narrowing, GDA arcade",
    color: "#ff5f62",
    target: "Post-stenotic celiac"
  },
  {
    id: "tortuous-iliac",
    name: "Tortuous iliac",
    note: "Angulated iliac-aortic access",
    color: "#6aa2ff",
    target: "Common hepatic"
  },
  {
    id: "pulmonary-avm",
    name: "Pulmonary AVM",
    note: "Feeder, sac, draining vein",
    color: "#9f76ff",
    target: "Segmental AVM"
  }
];

function MetricCard({
  label,
  unit,
  value,
  status
}: {
  label: string;
  unit: string;
  value: string;
  status?: string;
}) {
  return (
    <section className="metric-card">
      <div className="metric-head">
        <span>{label}</span>
        <small>{unit}</small>
      </div>
      <div className="metric-value">{value}</div>
      <div className="sparkline" aria-hidden="true">
        {Array.from({ length: 16 }).map((_, index) => (
          <span
            key={index}
            style={{
              height: `${18 + ((index * 7 + value.length * 9) % 34)}px`
            }}
          />
        ))}
      </div>
      {status ? <p>{status}</p> : null}
    </section>
  );
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  suffix,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider-row">
      <span>
        {label}
        <b>
          {value.toFixed(step < 1 ? 2 : 0)}
          {suffix}
        </b>
      </span>
      <input
        min={min}
        max={max}
        step={step}
        type="range"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function App() {
  const [variant, setVariant] = useState<AnatomyId>("standard");
  const [opacity, setOpacity] = useState(0.62);
  const [stiffness, setStiffness] = useState(0.65);
  const [flowSpeed, setFlowSpeed] = useState(1);
  const [showLabels, setShowLabels] = useState(true);
  const [heatmap, setHeatmap] = useState(false);
  const [progress, setProgress] = useState(0.44);
  const [rotation, setRotation] = useState(0);
  const [steer, setSteer] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("three-d");
  const activeVariant = variants.find((item) => item.id === variant) ?? variants[0];

  const metrics = useMemo(() => {
    const anatomyDifficulty =
      variant === "tortuous-iliac" ? 11 : variant === "celiac-stenosis" ? 8 : variant === "pulmonary-avm" ? 6 : 0;
    const wallContact =
      variant === "tortuous-iliac"
        ? 31 + progress * 19
        : variant === "celiac-stenosis"
          ? 24 + progress * 12
          : 12 + progress * 9;
    const steeringPenalty = Math.abs(steer) * 13;
    const efficiency = Math.max(38, 94 - wallContact * 0.55 - Math.abs(rotation) * 0.05 - steeringPenalty - anatomyDifficulty * 0.35);
    const depth = (variant === "pulmonary-avm" ? 34 : 28) + progress * (variant === "pulmonary-avm" ? 86 : 72);
    const dose = 9 + progress * 22 + flowSpeed * 2.5 + (viewMode === "fluoro" ? 3.2 : 0);

    return {
      wallContact,
      efficiency,
      depth,
      dose
    };
  }, [flowSpeed, progress, rotation, steer, variant, viewMode]);

  const move = (delta: number) => {
    setProgress((current) => Math.min(1, Math.max(0, current + delta / stiffness)));
  };

  const steerWire = (delta: number) => {
    setSteer((current) => Math.min(1, Math.max(-1, current + delta)));
  };

  const resetRun = () => {
    setProgress(0.25);
    setRotation(0);
    setSteer(0);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;

      const key = event.key.toLowerCase();
      if (["w", "s", "a", "d", "q", "e", "r", "t", "f", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        event.preventDefault();
      }

      if (key === "w" || key === "arrowup") move(0.045);
      if (key === "s" || key === "arrowdown") move(-0.045);
      if (key === "a" || key === "arrowleft") steerWire(-0.12);
      if (key === "d" || key === "arrowright") steerWire(0.12);
      if (key === "q") setRotation((current) => current - 8);
      if (key === "e") setRotation((current) => current + 8);
      if (key === "r") resetRun();
      if (key === "t") setProgress(0.84);
      if (key === "f") setViewMode((current) => (current === "three-d" ? "fluoro" : "three-d"));
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span>IR</span>sim
          <small>Interventional Radiology Simulator</small>
        </div>
        <div className="case-strip">
          <div>
            <span>Case</span>
            Hepatic Angiography
          </div>
          <div>
            <span>Patient</span>
            Sim Patient 001
          </div>
          <div>
            <span>Mode</span>
            Practice
          </div>
        </div>
        <div className="run-state">
          <b>{viewMode === "fluoro" ? "Fluoro" : "3D planning"}</b>
          <span>{activeVariant.name}</span>
        </div>
      </header>

      <section className="workbench">
        <aside className="left-panel panel">
          <h2>Anatomy Variant</h2>
          <div className="variant-list">
            {variants.map((item) => (
              <button
                className={`variant-card ${item.id === variant ? "active" : ""}`}
                key={item.id}
                onClick={() => setVariant(item.id)}
                style={{ "--variant-color": item.color } as React.CSSProperties}
              >
                <span className="radio-dot" />
                <span className="vessel-glyph">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  <b>{item.name}</b>
                  <small>{item.note}</small>
                </span>
              </button>
            ))}
          </div>

          <section className="control-stack">
            <h2>Controls</h2>
            <div className="mode-switch" aria-label="Viewport mode">
              <button className={viewMode === "three-d" ? "active" : ""} onClick={() => setViewMode("three-d")}>
                3D
              </button>
              <button className={viewMode === "fluoro" ? "active" : ""} onClick={() => setViewMode("fluoro")}>
                Fluoro 2D
              </button>
            </div>
            <SliderRow label="Vessel opacity" min={0.2} max={0.95} step={0.01} value={opacity} suffix="" onChange={setOpacity} />
            <SliderRow label="Catheter stiffness" min={0.35} max={1.15} step={0.01} value={stiffness} onChange={setStiffness} />
            <SliderRow label="Tip steering" min={-1} max={1} step={0.01} value={steer} onChange={setSteer} />
            <label className="toggle-row">
              Show labels
              <input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} />
            </label>
            <button className={heatmap ? "text-toggle active" : "text-toggle"} onClick={() => setHeatmap((current) => !current)}>
              Contact overlay
            </button>
          </section>
        </aside>

        <section className={`viewport-frame ${viewMode === "fluoro" ? "fluoro-mode" : ""}`}>
          <VesselViewport
            flowSpeed={flowSpeed}
            heatmap={heatmap}
            opacity={opacity}
            progress={progress}
            rotation={rotation}
            showLabels={showLabels}
            steer={steer}
            stiffness={stiffness}
            variant={variant}
            viewMode={viewMode}
          />
          <div className="fluoro-box">
            <span>{viewMode === "fluoro" ? "Live Fluoro" : "Fluoro"}</span>
            <b>RAO {Math.round(20 + rotation / 6)}°</b>
            <b>CAUD {Math.round(10 - steer * 8)}°</b>
            <b>SID {viewMode === "fluoro" ? 104 : 100} cm</b>
          </div>
          <div className="mode-badge">
            <SquareActivity size={16} />
            {viewMode === "fluoro" ? "2D radiography projection" : "3D mouse orbit view"}
          </div>
          <div className="access-box">
            <div className="body-map" />
            <span>Access</span>
            <b>R CFA</b>
            <i />
          </div>
        </section>

        <aside className="right-panel panel">
          <h2>Navigation Metrics</h2>
          <MetricCard label="Tip depth" unit="cm" value={metrics.depth.toFixed(1)} />
          <MetricCard label="Wall contact" unit="%" value={metrics.wallContact.toFixed(0)} status={metrics.wallContact > 35 ? "High friction" : "Moderate"} />
          <MetricCard label="Dose" unit="mGy" value={metrics.dose.toFixed(1)} />
          <MetricCard label="Efficiency" unit="%" value={metrics.efficiency.toFixed(0)} status={metrics.efficiency > 70 ? "Good path" : "Clean up"} />
          <section className="target-card">
            <Crosshair size={34} />
            <div>
              <span>Active Target</span>
              <b>{activeVariant.target}</b>
              <small>Distance {(1.4 - progress).toFixed(1)} cm</small>
            </div>
          </section>
        </aside>
      </section>

      <footer className="bottom-toolbar">
        <button onClick={resetRun}>
          <RotateCcw />
          Reset
          <kbd>R</kbd>
        </button>
        <button onClick={() => move(0.06)}>
          <ArrowRight />
          Advance
          <kbd>W</kbd>
        </button>
        <button onClick={() => move(-0.06)}>
          <ArrowLeft />
          Retract
          <kbd>S</kbd>
        </button>
        <button onClick={() => setProgress(0.84)}>
          <Crosshair />
          Target Mode
          <kbd>T</kbd>
        </button>
        <button onClick={() => setViewMode((current) => (current === "three-d" ? "fluoro" : "three-d"))}>
          <SquareActivity />
          Fluoro
          <kbd>F</kbd>
        </button>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
