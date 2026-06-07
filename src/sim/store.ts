import { create } from "zustand";
import type { DeviceId, KeyLayout } from "./controls";

export type ViewMode = "3d" | "fluoro";
export type { DeviceId, KeyLayout };

/** Per-instrument operator input. The wire and sheath each carry their own, driven separately. */
export interface DeviceState {
  deployed: number; // intravascular length target, cm
  torque: number; // handle roll, radians
  steer: number; // 0..1 tip tightness (precurve scale; only the wire has a pre-shaped tip)
}

interface Metrics {
  depth: number; // wire deployed length, cm
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

  /** Vascular access site id (e.g. "rcfa" right / "lcfa" left common femoral). Choosing the
   * start side rebuilds the instruments at that femoral artery. */
  accessId: string;
  /** Bumped whenever the current run should be rebuilt from fresh device seeds. */
  runSeq: number;

  // Two independently-controlled coaxial instruments.
  wire: DeviceState;
  sheath: DeviceState;
  /** Which device the side-panel sliders edit and the deck highlights. Both are always
   * keyboard-drivable; this is the UI focus, not a control lock. */
  selected: DeviceId;

  /** Active keyboard layout for the wire letter cluster (WASD vs ZQSD). */
  layout: KeyLayout;

  injectSeq: number; // bumped on each contrast injection; the engine ramps+decays it

  targetId: string;
  metrics: Metrics;

  set: (p: Partial<SimState>) => void;
  setAccess: (accessId: string) => void;
  select: (device: DeviceId) => void;
  setLayout: (layout: KeyLayout) => void;
  /** Advance (+) / retract (−) one device's deployed length by `d` cm. */
  advance: (device: DeviceId, d: number) => void;
  /** Roll one device's handle by `d` radians. */
  rotate: (device: DeviceId, d: number) => void;
  /** Set one device's tip tightness (0..1). */
  setSteer: (device: DeviceId, v: number) => void;
  inject: () => void;
  setMetrics: (m: Metrics) => void;
  reset: () => void;
}

const DEPLOY_MIN = 2;
const DEPLOY_MAX = 70;
const clampDeploy = (v: number) => Math.max(DEPLOY_MIN, Math.min(DEPLOY_MAX, v));

/** Fresh device positions for a new run. The shaped wire tip just peeks beyond the sheath. */
const freshDevices = (): { wire: DeviceState; sheath: DeviceState } => ({
  wire: { deployed: 8, torque: 0, steer: 0.35 },
  sheath: { deployed: 6.5, torque: 0, steer: 0 }
});

const DEFAULTS = {
  view: "fluoro" as ViewMode,
  showCenterlines: false,
  rao: 0,
  cranial: 0,
  accessId: "rcfa",
  runSeq: 0,
  selected: "wire" as DeviceId,
  layout: "qwerty" as KeyLayout,
  injectSeq: 0,
  targetId: "t_renal_l"
};

const freshMetrics = (): Metrics => ({ depth: 8, tipToTarget: 0, reached: false, contrast: 0 });

export const useSim = create<SimState>((set) => ({
  ...DEFAULTS,
  ...freshDevices(),
  metrics: freshMetrics(),

  set: (p) => set(p),

  // Changing the access side restarts the run there (the rods are reseeded at that femoral
  // artery in the Viewport); keep chrome (view, layout, C-arm, target) but reset device pose.
  setAccess: (accessId) =>
    set((s) => ({ accessId, runSeq: s.runSeq + 1, ...freshDevices(), injectSeq: 0, metrics: freshMetrics() })),

  select: (device) => set({ selected: device }),
  setLayout: (layout) => set({ layout }),

  advance: (device, d) =>
    set((s) => {
      const dev = s[device];
      const next = { ...dev, deployed: clampDeploy(dev.deployed + d) };
      return device === "wire" ? { wire: next } : { sheath: next };
    }),

  rotate: (device, d) =>
    set((s) => {
      const dev = s[device];
      const next = { ...dev, torque: dev.torque + d };
      return device === "wire" ? { wire: next } : { sheath: next };
    }),

  setSteer: (device, v) =>
    set((s) => {
      const dev = s[device];
      const next = { ...dev, steer: Math.max(0, Math.min(1, v)) };
      return device === "wire" ? { wire: next } : { sheath: next };
    }),

  inject: () => set((s) => ({ injectSeq: s.injectSeq + 1 })),
  setMetrics: (m) => set({ metrics: m }),

  // Reset the run, preserving the operator's setup choices (access side and keyboard layout).
  reset: () =>
    set((s) => ({
      ...DEFAULTS,
      runSeq: s.runSeq + 1,
      accessId: s.accessId,
      layout: s.layout,
      ...freshDevices(),
      metrics: freshMetrics()
    }))
}));
