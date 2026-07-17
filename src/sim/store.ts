import { create } from "zustand";
import { validateSimulatorReadyAnatomyDoc, type AnatomyDoc } from "./anatomyDoc";
import type { GuidewireProfileId } from "./cosserat";
import type { DeviceId, KeyLayout } from "./controls";

export type ViewMode = "3d" | "fluoro";
/**
 * Fluoroscopy acquisition mode:
 *  - live: native fluoroscopy (bone + walls + bolus + instruments).
 *  - dsa: digital subtraction angiography — the static mask (bone + walls) is removed, leaving the
 *    injected contrast column + the moving instruments.
 *  - roadmap: a steady subtracted vessel map (the tree held opacified) with live instruments on top,
 *    so the operator can navigate without continuously re-injecting.
 */
export type FluoroMode = "live" | "dsa" | "roadmap";
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
  contrast: number; // 0..1 injection level (at the catheter tip / bolus source)
  procTime: number; // s, total elapsed run time
  fluoroTime: number; // s, beam-on (fluoroscopy) time
  dose: number; // arbitrary dose-area-product-like accumulation
  sid: number; // cm, source-to-image distance (camera distance)
  mag: number; // magnification factor (×)
  /** Unit screen-space direction from the wire tip to the active target (x right, y down), or
   * null when the target is behind the image plane. Drives the on-image direction cue. */
  tipDir: [number, number] | null;
}

/** A vessel-name callout projected onto the image (x,y in 0..1 viewport fraction). */
export interface VesselLabel {
  name: string;
  x: number;
  y: number;
}

interface SimState {
  view: ViewMode;
  showCenterlines: boolean;

  /** Show vessel-name callouts over the image (the read-the-anatomy navigation aid). */
  showLabels: boolean;
  /** Live projected vessel callouts, recomputed by the Viewport at the metrics cadence. */
  labels: VesselLabel[];

  /** Measurement caliper: when on, two image clicks define a magnification-corrected distance. */
  measureMode: boolean;
  /** The 0–2 caliper endpoints, in 0..1 viewport fraction. */
  measurePts: { x: number; y: number }[];
  /** The measured distance (cm) once two points are placed. */
  measureCm: number;

  /** Fluoroscopy acquisition mode (live vs DSA subtraction). */
  fluoroMode: FluoroMode;
  /** Operator image windowing: brightness shift (−0.5..0.5) and contrast/window (0.4..2.6). */
  fluoroBrightness: number;
  fluoroContrast: number;

  // C-arm geometry
  rao: number; // deg, +RAO / -LAO
  cranial: number; // deg, +CRAN / -CAUD
  /** Table pan: isocenter offset (cm) in the body frame x/y, for examining a region at magnification. */
  panX: number;
  panY: number;

  /** Vascular access site id (e.g. "rcfa" right / "lcfa" left common femoral). Choosing the
   * start side rebuilds the instruments at that femoral artery. */
  accessId: string;
  /** Active anatomy variant id (from ANATOMY_VARIANTS), or undefined for the normal anatomy.
   * Switching it recompiles the anatomy in both panels, which rebuilds the lumen + instruments. */
  variantId: string | undefined;
  /** An externally-loaded anatomy document (a JSON sidecar — the format the DICOM/centerline
   * ingestion pipeline emits). When non-null it supersedes the built-in variant. */
  loadedDoc: AnatomyDoc | null;
  /** Selected guidewire stiffness profile (standard / stiff support / soft). Changing it rebuilds
   * the wire at the new flexural rigidity, so it restarts the run. */
  deviceProfile: GuidewireProfileId;
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
  /** Select an anatomy variant (or undefined for normal); restarts the run on the new anatomy.
   * Clears any externally-loaded sidecar (built-in variants and a loaded doc are exclusive). */
  setVariant: (variantId: string | undefined) => void;
  /** Load an external anatomy sidecar (supersedes the variant), or null to clear it. */
  loadDoc: (doc: AnatomyDoc | null) => void;
  /** Close an in-memory local case and return to the built-in public demo. */
  closeLocalCase: () => void;
  /** Select the guidewire stiffness profile; rebuilds the wire and restarts the run. */
  setDeviceProfile: (id: GuidewireProfileId) => void;
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
  setLabels: (labels: VesselLabel[]) => void;
  /** Add a caliper point (image fraction). `aspect` = viewport W/H, `sid` = source-image distance (cm),
   * used to convert the screen span to a magnification-corrected world distance at the isocenter plane. */
  pushMeasure: (pt: { x: number; y: number }, aspect: number, sid: number) => void;
  /** Toggle the caliper on/off, clearing any in-progress measurement. */
  toggleMeasure: () => void;
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
  showLabels: true,
  measureMode: false,
  fluoroMode: "live" as FluoroMode,
  fluoroBrightness: 0,
  fluoroContrast: 1,
  rao: 0,
  cranial: 0,
  panX: 0,
  panY: 0,
  accessId: "rcfa",
  variantId: undefined as string | undefined,
  loadedDoc: null as AnatomyDoc | null,
  deviceProfile: "standard" as GuidewireProfileId,
  runSeq: 0,
  selected: "wire" as DeviceId,
  layout: "qwerty" as KeyLayout,
  injectSeq: 0,
  targetId: "t_renal_l"
};

const freshMetrics = (): Metrics => ({
  depth: 8,
  tipToTarget: 0,
  reached: false,
  contrast: 0,
  procTime: 0,
  fluoroTime: 0,
  dose: 0,
  sid: 95,
  mag: 1,
  tipDir: null
});

export const useSim = create<SimState>((set) => ({
  ...DEFAULTS,
  ...freshDevices(),
  metrics: freshMetrics(),
  labels: [],
  measurePts: [],
  measureCm: 0,

  set: (p) => set(p),

  // Changing the access side restarts the run there (the rods are reseeded at that femoral
  // artery in the Viewport); keep chrome (view, layout, C-arm, target) but reset device pose.
  setAccess: (accessId) =>
    set((s) => ({ accessId, runSeq: s.runSeq + 1, ...freshDevices(), injectSeq: 0, metrics: freshMetrics() })),

  // Switching anatomy recompiles the lumen + rebuilds the instruments (both panels are keyed on
  // the variant), so start the run fresh — same reseed contract as changing the access side.
  setVariant: (variantId) =>
    set((s) => ({ variantId, loadedDoc: null, runSeq: s.runSeq + 1, ...freshDevices(), injectSeq: 0, metrics: freshMetrics() })),

  loadDoc: (loadedDoc) =>
    set((s) => {
      if (!loadedDoc) {
        return {
          loadedDoc: null,
          variantId: undefined,
          accessId: DEFAULTS.accessId,
          targetId: DEFAULTS.targetId,
          runSeq: s.runSeq + 1,
          ...freshDevices(),
          injectSeq: 0,
          metrics: freshMetrics(),
          labels: [],
          measurePts: [],
          measureCm: 0
        };
      }
      const ready = validateSimulatorReadyAnatomyDoc(loadedDoc);
      return {
        loadedDoc: ready,
        variantId: undefined,
        accessId: ready.access[0].id,
        targetId: ready.targets[0].id,
        runSeq: s.runSeq + 1,
        ...freshDevices(),
        injectSeq: 0,
        metrics: freshMetrics(),
        labels: [],
        measurePts: [],
        measureCm: 0
      };
    }),

  closeLocalCase: () =>
    set((s) => ({
      loadedDoc: null,
      variantId: undefined,
      accessId: DEFAULTS.accessId,
      targetId: DEFAULTS.targetId,
      runSeq: s.runSeq + 1,
      ...freshDevices(),
      injectSeq: 0,
      metrics: freshMetrics(),
      labels: [],
      measurePts: [],
      measureCm: 0
    })),

  setDeviceProfile: (deviceProfile) =>
    set((s) => ({ deviceProfile, runSeq: s.runSeq + 1, ...freshDevices(), injectSeq: 0, metrics: freshMetrics() })),

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
  setLabels: (labels) => set({ labels }),

  pushMeasure: (pt, aspect, sid) =>
    set((s) => {
      const pts = s.measurePts.length >= 2 ? [pt] : [...s.measurePts, pt];
      let measureCm = 0;
      if (pts.length === 2) {
        // vertical world span across the full image height at the isocenter plane (C-arm FOV = 40°)
        const span = 2 * Math.tan((40 * Math.PI) / 180 / 2) * sid;
        const dy = (pts[1].y - pts[0].y) * span;
        const dx = (pts[1].x - pts[0].x) * span * aspect;
        measureCm = Math.hypot(dx, dy);
      }
      return { measurePts: pts, measureCm };
    }),
  toggleMeasure: () => set((s) => ({ measureMode: !s.measureMode, measurePts: [], measureCm: 0 })),

  // Reset the run, preserving the operator's setup choices (access side, anatomy, keyboard layout).
  reset: () =>
    set((s) => ({
      ...DEFAULTS,
      runSeq: s.runSeq + 1,
      accessId: s.accessId,
      variantId: s.variantId,
      loadedDoc: s.loadedDoc,
      deviceProfile: s.deviceProfile,
      layout: s.layout,
      ...freshDevices(),
      metrics: freshMetrics()
    }))
}));
