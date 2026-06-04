import { create } from "zustand";

export type ViewMode = "3d" | "fluoro";

interface Metrics {
  depth: number; // deployed length, cm
  tipToTarget: number; // cm
  reached: boolean;
  contrast: number; // 0..1 injection level
}

interface SimState {
  view: ViewMode;
  showCenterlines: boolean;

  // C-arm geometry
  rao: number; // deg, +RAO / -LAO
  cranial: number; // deg, +CRAN / -CAUD

  // instrument input
  deployed: number; // cm
  steer: number; // 0..1 tip tightness
  torque: number; // radians, bending-plane rotation
  injectSeq: number; // bumped on each contrast injection; the engine ramps+decays it

  targetId: string;
  metrics: Metrics;

  set: (p: Partial<SimState>) => void;
  advance: (d: number) => void;
  rotate: (d: number) => void;
  inject: () => void;
  setMetrics: (m: Metrics) => void;
  reset: () => void;
}

const DEFAULTS = {
  view: "fluoro" as ViewMode,
  showCenterlines: false,
  rao: 0,
  cranial: 0,
  deployed: 8,
  steer: 0.45,
  torque: 0,
  injectSeq: 0,
  targetId: "t_renal_l"
};

export const useSim = create<SimState>((set) => ({
  ...DEFAULTS,
  metrics: { depth: 8, tipToTarget: 0, reached: false, contrast: 0 },
  set: (p) => set(p),
  advance: (d) => set((s) => ({ deployed: Math.max(2, Math.min(70, s.deployed + d)) })),
  rotate: (d) => set((s) => ({ torque: s.torque + d })),
  inject: () => set((s) => ({ injectSeq: s.injectSeq + 1 })),
  setMetrics: (m) => set({ metrics: m }),
  reset: () => set({ ...DEFAULTS, metrics: { depth: 8, tipToTarget: 0, reached: false, contrast: 0 } })
}));
