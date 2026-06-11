import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  DirectionalLight,
  HalfFloatType,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  type ShaderMaterial,
  SphereGeometry,
  TubeGeometry,
  Vector3,
  WebGLRenderTarget
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildAnatomy } from "../sim/anatomy";
import { compileAnatomy } from "../sim/anatomyDoc";
import { CoaxialAssembly, CosseratRod, guidewireForProfile, SHIPPED_SHEATH } from "../sim/cosserat";
import type { DeviceId } from "../sim/store";
import { useSim } from "../sim/store";
import { makeAttenuationMaterial, makeTonemapMaterial } from "./fluoro";

const ISO = new Vector3(0, 14, 0);
const DEBUG_HISTORY_LIMIT = 900;
/** Contrast bolus front speed (cm/s): how fast injected contrast sweeps out from the catheter tip
 * through the vessel field. Drives the temporal fill order that is the cardinal fluoro reading skill. */
const BOLUS_FRONT_SPEED = 46;
/** Steady opacification floor for roadmap mode (the held vessel map under the live instruments). */
const ROADMAP_FILL = 0.5;
type PhysicsMode = "direct";
type MeshKind = "vessel" | "bone" | "wire" | "sheath";

interface MeshMaterials {
  mat3d: Material;
  fluoro: ShaderMaterial;
  atten: number;
  kind: MeshKind;
  /** Index into anatomy.branches, for vessel meshes (drives the per-branch contrast sweep). */
  branchIndex?: number;
}

interface RodDebug {
  nodes: number;
  deployed: number;
  commanded: number;
  tip: [number, number, number];
  tipSpeed: number;
  maxWallPenetration: number;
  maxSegmentLengthError: number;
  finite: boolean;
}

interface SimDebugSnapshot {
  frame: number;
  time: number;
  dt: number;
  physicsMode: PhysicsMode;
  view: string;
  accessId: string;
  selected: string;
  targetId: string;
  inputs: {
    wire: { deployed: number; torque: number; steer: number };
    sheath: { deployed: number; torque: number; steer: number };
  };
  metrics: {
    depth: number;
    tipToTarget: number;
    reached: boolean;
    contrast: number;
  };
  rods: {
    wire: RodDebug;
    sheath: RodDebug;
  };
  coax: {
    activeContacts: number;
    normalLoad: number;
    innerExitPastOuterTip: number;
    maxCoveredInnerRho: number;
    innerClearance: number;
  };
  /**
   * Phase F performance instrumentation (reported, never gated in CI — wall-clock flakes on
   * shared runners). `stepMs` is last-frame `assembly.step()` wall time; the deterministic
   * work-counts are the HARD gate (asserted in beamfem/integration_live.test.ts). All zero on the
   * shipped XPBD lane (it assembles no FEM tangents); meaningful only on the direct beam lane.
   */
  perf: {
    stepMs: number;
    tangentAssemblies: number;
    elementForceEvals: number;
  };
}

type SimStoreShape = ReturnType<typeof useSim.getState>;

interface SimDebugApi {
  getSnapshot: () => SimDebugSnapshot | null;
  getHistory: () => SimDebugSnapshot[];
  clearHistory: () => void;
  advance: (device: DeviceId, deltaCm: number) => void;
  setInput: (device: DeviceId, patch: Partial<{ deployed: number; torque: number; steer: number }>) => void;
  /** Patch arbitrary store state (view, fluoroMode, C-arm, target, …) — for automation/screenshots. */
  setState: (patch: Partial<SimStoreShape>) => void;
  inject: () => void;
  reset: () => void;
}

declare global {
  interface Window {
    __IRSIM_DEBUG__?: SimDebugApi;
  }
}

/**
 * Rebuild a TubeGeometry from a Cosserat rod's live node positions. Disposes the previous
 * geometry first. The rod arrays grow/shrink as material is fed, so the curve is rebuilt
 * every frame (Catmull-Rom needs ≥2 points; the rod keeps minNodes=3).
 */
function rebuildTube(mesh: Mesh, nodes: Vector3[], radius: number): void {
  // Guard against a non-finite node: one NaN/undefined position poisons CatmullRomCurve3's
  // arc-length table, so TubeGeometry indexes the point list with NaN and throws
  // ("Cannot read properties of undefined") every frame — permanently wedging the render
  // loop into a black screen. Keep the last good geometry instead of throwing.
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
  }
  mesh.geometry.dispose();
  const pts = nodes.slice();
  const curve = new CatmullRomCurve3(pts);
  mesh.geometry = new TubeGeometry(curve, Math.max(1, pts.length), radius, 6, false);
}

function tuple(p: Vector3): [number, number, number] {
  return [p.x, p.y, p.z];
}

function allFiniteRod(rod: CosseratRod): boolean {
  for (const p of rod.x) if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
  for (const q of rod.q) if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z) || !Number.isFinite(q.w)) return false;
  return true;
}

function maxSegmentLengthError(rod: CosseratRod): number {
  let max = 0;
  for (let i = 0; i < rod.restLen.length; i++) {
    max = Math.max(max, Math.abs(rod.x[i + 1].distanceTo(rod.x[i]) - rod.restLen[i]));
  }
  return max;
}

function rodDebug(rod: CosseratRod, commanded: number, prevTip: Vector3, dt: number): RodDebug {
  const tip = rod.tip();
  const speed = dt > 0 ? tip.distanceTo(prevTip) / dt : 0;
  prevTip.copy(tip);
  return {
    nodes: rod.n,
    deployed: rod.deployedLength(),
    commanded,
    tip: tuple(tip),
    tipSpeed: speed,
    maxWallPenetration: rod.maxWallPenetration(),
    maxSegmentLengthError: maxSegmentLengthError(rod),
    finite: allFiniteRod(rod)
  };
}

/**
 * Contrast bolus envelope: 0 before arrival, fast wash-in, slow wash-out. `tau` is local time
 * since the bolus front reached this point (s). Reproduces the brief opacification + fade that
 * makes the fill SWEEP legible — vessels near the catheter light first, distal ones lag.
 */
function bolus(tau: number): number {
  if (!(tau > 0)) return 0;
  const washIn = Math.min(1, tau / 0.3);
  const washOut = Math.exp(-0.2 * Math.max(0, tau - 0.6));
  return washIn * washOut;
}

/** Compact a target name for an on-image callout ("Left renal ostium" → "L renal"). */
function shortLabel(name: string): string {
  return name
    .replace(/ ostium$/i, "")
    .replace(/ \(selective\)$/i, "")
    .replace(/ artery$/i, "")
    .replace(/\bLeft\b/, "L")
    .replace(/\bRight\b/, "R")
    .replace(/\bSuperior\b/, "Sup")
    .replace(/\bInferior\b/, "Inf")
    .trim();
}

/**
 * Procedural skeletal landmarks for the fluoroscopy field — lumbar/thoracic spine, sacrum, iliac
 * wings and femoral heads, in the anatomy body frame (cm; +y cranial, +x patient-left, +z anterior).
 * Bone is the single biggest missing real-fluoro cue: operators navigate AGAINST the spine and
 * pelvis, and DSA exists precisely to subtract it back out. Each is a closed box/sphere so the
 * DoubleSide attenuation material integrates a correct path length; sigma is tuned so cortical bone
 * reads as a firm grey landmark (well below the near-black of metal instruments).
 */
function addBones(scene: Scene, meshes: Mesh[]): void {
  const bone3d = new MeshStandardMaterial({
    color: 0x8d877b,
    roughness: 0.85,
    metalness: 0,
    transparent: true,
    opacity: 0.14
  });
  // Merge each density group into ONE geometry so the whole skeleton costs 3 draw calls, not ~16
  // (matters on the headless software renderer, where extra draws starve the frame loop).
  const addGroup = (geos: (BoxGeometry | SphereGeometry)[], sigma: number) => {
    const merged = mergeGeometries(geos, false);
    const fluoro = makeAttenuationMaterial(sigma);
    const mesh = new Mesh(merged, fluoro);
    mesh.userData = { mat3d: bone3d, fluoro, atten: 1, kind: "bone" } satisfies MeshMaterials;
    mesh.frustumCulled = false;
    scene.add(mesh);
    meshes.push(mesh);
  };

  // dense midline column: vertebral bodies (L5 up through the thoracic spine) + sacrum
  const column: BoxGeometry[] = [];
  for (let i = 0; i < 10; i++) {
    const g = new BoxGeometry(3.0, 2.4, 2.8);
    g.translate(0, -1 + i * 3.35, -2.4);
    column.push(g);
  }
  const sacrum = new BoxGeometry(2.6, 6.0, 2.0);
  sacrum.translate(0, -6, -2.7);
  column.push(sacrum);
  addGroup(column, 0.5);

  // iliac wings, flared outward
  const ilL = new BoxGeometry(4.6, 5.6, 2.2);
  ilL.rotateZ(0.42);
  ilL.translate(-5.4, -5, -2.3);
  const ilR = new BoxGeometry(4.6, 5.6, 2.2);
  ilR.rotateZ(-0.42);
  ilR.translate(5.4, -5, -2.3);
  addGroup([ilL, ilR], 0.36);

  // femoral heads (at the groin, near the access points)
  const fhL = new SphereGeometry(1.35, 18, 14);
  fhL.translate(-4.2, -10.6, -2.0);
  const fhR = new SphereGeometry(1.35, 18, 14);
  fhR.translate(4.2, -10.6, -2.0);
  addGroup([fhL, fhR], 0.6);
}

function Engine() {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);

  // Reactive on the selected variant / loaded sidecar so switching anatomy recompiles the lumen +
  // rebuilds the scene meshes and instruments (the assembly + rig memos below are keyed on `anatomy`).
  // A loaded sidecar (the ingestion-pipeline output format) supersedes the built-in variant.
  const variantId = useSim((s) => s.variantId);
  const loadedDoc = useSim((s) => s.loadedDoc);
  const anatomy = useMemo(
    () => (loadedDoc ? compileAnatomy(loadedDoc) : buildAnatomy(variantId)),
    [loadedDoc, variantId]
  );
  const physicsMode: PhysicsMode = "direct";

  // The chosen access side (right/left common femoral). Reactive so picking a different start
  // rebuilds the instruments at that artery.
  const accessId = useSim((s) => s.accessId);
  const deviceProfile = useSim((s) => s.deviceProfile);
  const runSeq = useSim((s) => s.runSeq);

  // New Cosserat-XPBD instruments: a guidewire (inner) sliding inside a sheath (outer), both
  // entering at the selected femoral access. The wire and sheath are driven independently (see
  // useFrame), but covered guidewire material is routed through the sheath channel: it does not
  // choose vessel-wall contacts/branches until it exits the sheath portal. Replaces legacy rod.ts.
  const assembly = useMemo(() => {
    const startId = anatomy.access.some((a) => a.id === accessId) ? accessId : anatomy.access[0].id;
    const st = useSim.getState();
    // Shipped presets live in cosserat.ts so the app and integration tests exercise the same path.
    // The guidewire is specialised to the selected stiffness profile (standard/stiff/soft).
    const inner = new CosseratRod(anatomy, startId, guidewireForProfile(deviceProfile), st.wire);
    const outer = new CosseratRod(anatomy, startId, SHIPPED_SHEATH, st.sheath);
    return new CoaxialAssembly(outer, inner);
  }, [anatomy, accessId, deviceProfile, runSeq]);

  const rig = useMemo(() => {
    const scene = new Scene();
    // monochrome planning scene: neutral near-black field, neutral fill + key (no colour cast),
    // so the 3D view reads as part of the same grayscale console as the fluoro chrome.
    scene.background = new Color(0x06080a);
    scene.add(new AmbientLight(0xb8c2cc, 1.1));
    const dir = new DirectionalLight(0xffffff, 1.5);
    dir.position.set(20, 40, 30);
    scene.add(dir);

    const camera = new PerspectiveCamera(40, 1, 1, 500);

    const meshes: Mesh[] = [];

    // skeletal landmarks first (drawn behind the vessels / instruments; additive so order is moot)
    addBones(scene, meshes);

    anatomy.branches.forEach((br, bi) => {
      const meanR = br.points.reduce((a, p) => a + p.radius, 0) / br.points.length;
      const curve = new CatmullRomCurve3(br.points.map((p) => p.pos));
      const geo = new TubeGeometry(curve, br.points.length * 2, meanR, 14, false);
      const fluoro = makeAttenuationMaterial(0);
      // vessel wall: translucent steel-grey (monochrome) rather than anatomical red.
      const mat3d = new MeshStandardMaterial({
        color: 0x6b757d,
        roughness: 0.5,
        metalness: 0.1,
        transparent: true,
        opacity: 0.42
      });
      const mesh = new Mesh(geo, fluoro);
      mesh.userData = { mat3d, fluoro, atten: br.attenuation, kind: "vessel", branchIndex: bi } satisfies MeshMaterials;
      scene.add(mesh);
      meshes.push(mesh);
    });

    // sheath (outer coaxial device) — wider, slightly less radio-dense than the wire.
    const sheathFluoro = makeAttenuationMaterial(4.5);
    const sheathMat3d = new MeshStandardMaterial({
      color: 0xaab3bb,
      metalness: 0.55,
      roughness: 0.4,
      transparent: true,
      opacity: 0.7
    });
    const sheath = new Mesh(new BufferGeometry(), sheathFluoro);
    sheath.userData = { mat3d: sheathMat3d, fluoro: sheathFluoro, atten: 1, kind: "sheath" } satisfies MeshMaterials;
    sheath.frustumCulled = false;
    scene.add(sheath);
    meshes.push(sheath);

    // guidewire (inner) — thin, bright metal, most radio-dense. Geometry rebuilt each frame.
    const wireFluoro = makeAttenuationMaterial(7.0);
    const wireMat3d = new MeshStandardMaterial({
      color: 0xeef3f7,
      metalness: 0.85,
      roughness: 0.25,
      emissive: 0x2a2f33,
      emissiveIntensity: 0.3
    });
    const wire = new Mesh(new BufferGeometry(), wireFluoro);
    wire.userData = { mat3d: wireMat3d, fluoro: wireFluoro, atten: 1, kind: "wire" } satisfies MeshMaterials;
    wire.frustumCulled = false;
    scene.add(wire);
    meshes.push(wire);

    // target marker: bright white (the single high-salience signal, matching the UI accent).
    const target = new Mesh(
      new SphereGeometry(0.5, 20, 16),
      new MeshBasicMaterial({ color: 0xf2f6f9, transparent: true, opacity: 0.9 })
    );
    scene.add(target);

    const rtOpts = { type: HalfFloatType, format: RGBAFormat, depthBuffer: false };
    const rt = new WebGLRenderTarget(1, 1, rtOpts);
    const rtBase = new WebGLRenderTarget(1, 1, rtOpts); // DSA mask buffer
    const tonemap = makeTonemapMaterial();
    const postScene = new Scene();
    postScene.add(new Mesh(new PlaneGeometry(2, 2), tonemap));
    const postCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Per-branch contrast for the fill sweep — filled in place each frame (no per-frame alloc).
    const branchC = new Array<number>(anatomy.branches.length).fill(0);

    return { scene, camera, meshes, sheath, wire, target, rt, rtBase, tonemap, postScene, postCam, branchC };
  }, [anatomy]);

  const dist = useRef(95);
  const lastSeq = useRef(0);
  const injectClock = useRef(Infinity); // s since the last injection; Infinity = no active bolus
  const branchArrival = useRef<number[]>([]); // per-branch bolus arrival time (s)
  const projTip = useRef(new Vector3()); // scratch for screen-space projection (no per-frame alloc)
  const projTgt = useRef(new Vector3());
  const projLabel = useRef(new Vector3());
  const procClock = useRef(0); // total run wall time (s)
  const fluoroClock = useRef(0); // beam-on (fluoroscopy) time (s)
  const doseAcc = useRef(0); // accumulated DAP-like dose
  const reachedFor = useRef(0);
  const clock = useRef(0);
  const reportAt = useRef(0);
  const frame = useRef(0);
  // Phase F: last-frame step wall time (ms) + deterministic FEM work-counts for that frame.
  const stepMs = useRef(0);
  const stepCounts = useRef<{ tangentAssemblies: number; elementForceEvals: number }>({
    tangentAssemblies: 0,
    elementForceEvals: 0
  });
  const debugHistory = useRef<SimDebugSnapshot[]>([]);
  const debugSnapshot = useRef<SimDebugSnapshot | null>(null);
  const prevWireTip = useRef(assembly.inner.tip().clone());
  const prevSheathTip = useRef(assembly.outer.tip().clone());

  useEffect(() => {
    clock.current = 0;
    reportAt.current = 0;
    reachedFor.current = 0;
    injectClock.current = Infinity;
    branchArrival.current = [];
    procClock.current = 0;
    fluoroClock.current = 0;
    doseAcc.current = 0;
    frame.current = 0;
    stepMs.current = 0;
    stepCounts.current = { tangentAssemblies: 0, elementForceEvals: 0 };
    debugHistory.current.length = 0;
    debugSnapshot.current = null;
    prevWireTip.current.copy(assembly.inner.tip());
    prevSheathTip.current.copy(assembly.outer.tip());
  }, [assembly]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const api: SimDebugApi = {
      getSnapshot: () => debugSnapshot.current,
      getHistory: () => debugHistory.current.slice(),
      clearHistory: () => {
        debugHistory.current.length = 0;
      },
      advance: (device, deltaCm) => useSim.getState().advance(device, deltaCm),
      setInput: (device, patch) => {
        const st = useSim.getState();
        const current = st[device];
        st.set(device === "wire" ? { wire: { ...current, ...patch } } : { sheath: { ...current, ...patch } });
      },
      setState: (patch) => useSim.getState().set(patch),
      inject: () => useSim.getState().inject(),
      reset: () => useSim.getState().reset()
    };
    window.__IRSIM_DEBUG__ = api;
    return () => {
      if (window.__IRSIM_DEBUG__ === api) delete window.__IRSIM_DEBUG__;
    };
  }, []);

  useEffect(() => {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, Math.floor(size.width * dpr));
    const h = Math.max(1, Math.floor(size.height * dpr));
    rig.rt.setSize(w, h);
    rig.rtBase.setSize(w, h);
    rig.camera.aspect = size.width / Math.max(1, size.height);
    rig.camera.updateProjectionMatrix();
  }, [rig, size]);

  useEffect(() => {
    const el = gl.domElement;
    let dragging = false;
    let lx = 0;
    let ly = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const st = useSim.getState();
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      if (e.shiftKey) {
        // table pan: shift the isocenter in world x/y (drag moves the field of view)
        const k = dist.current * 0.0015;
        st.set({
          panX: Math.max(-22, Math.min(22, st.panX + dx * k)),
          panY: Math.max(-22, Math.min(22, st.panY - dy * k))
        });
      } else {
        // C-arm angulation
        st.set({
          rao: Math.max(-90, Math.min(90, st.rao + dx * 0.4)),
          cranial: Math.max(-50, Math.min(50, st.cranial - dy * 0.3))
        });
      }
      lx = e.clientX;
      ly = e.clientY;
    };
    const up = (e: PointerEvent) => {
      dragging = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      dist.current = Math.max(45, Math.min(180, dist.current + e.deltaY * 0.06));
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
    };
  }, [gl]);

  useFrame((_, delta) => {
    const s = useSim.getState();
    // R3F can deliver delta = 0 (the first frame, a tab refocus, or two rAFs inside one ms).
    // A non-positive/non-finite step makes the XPBD compliance α̃ = α/Δt_s² blow up to
    // Infinity → NaN and permanently corrupts the rod. Treat it as "no time elapsed": clamp
    // the upper end for stability and skip the physics step (we still render the valid state).
    const h = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 1 / 30) : 0;
    clock.current += h;

    // input -> physics. The wire and sheath are driven INDEPENDENTLY from their own store inputs
    // through each rod's velocity-controlled insertion BC (deployed → feed velocity target,
    // torque → hub roll target, steer → tip precurve scale). The overlapped guidewire is contained
    // by the sheath channel and becomes a free vessel-navigating wire only beyond the sheath tip.
    const inner = assembly.inner;
    const outer = assembly.outer;
    inner.input.deployed = s.wire.deployed;
    inner.input.steer = s.wire.steer;
    inner.input.torque = s.wire.torque;
    // the sheath has no pre-shaped tip, so steer is a guidewire-only control (SHEATH carries
    // tipNodes:0 / tipCurve:0 — any steer input is physically inert); it is otherwise independently
    // advanced/retracted + torqued.
    outer.input.deployed = s.sheath.deployed;
    outer.input.steer = 0;
    outer.input.torque = s.sheath.torque;
    // Phase F: time the elastic+contact step (reported, not gated). Reset the deterministic FEM
    // work-counts immediately before so the post-step read reflects exactly this frame's tangent
    // assemblies / element-force evals (the HARD CI gate lives in integration_live.test.ts). Two
    // performance.now() calls/frame is negligible overhead and only runs when time elapsed (h > 0).
    if (h > 0) {
      assembly.resetDirectPerfCounters();
      const t0 = performance.now();
      assembly.step(h);
      stepMs.current = performance.now() - t0;
      stepCounts.current = assembly.directPerfCounters();
    }
    frame.current += 1;

    // contrast injection: a bolus front leaves the catheter tip and sweeps out through the vessel
    // field. On each new injection, snapshot the per-branch arrival times (distance from the
    // catheter tip ÷ front speed) so distal vessels opacify after proximal ones.
    if (s.injectSeq !== lastSeq.current) {
      lastSeq.current = s.injectSeq;
      injectClock.current = 0;
      const src = outer.tip(); // contrast is delivered at the catheter (sheath) tip
      branchArrival.current = anatomy.branches.map((br) => {
        let best = Infinity;
        for (const p of br.points) {
          const d = src.distanceTo(p.pos);
          if (d < best) best = d;
        }
        return best / BOLUS_FRONT_SPEED;
      });
    }
    injectClock.current += h;
    const injT = injectClock.current;
    const srcContrast = bolus(injT); // opacity at the bolus source (for the metric readout)
    // per-branch contrast for this frame (fill sweep), filled in place to avoid per-frame allocation
    const branchC = rig.branchC;
    for (let i = 0; i < branchC.length; i++) branchC[i] = bolus(injT - (branchArrival.current[i] ?? Infinity));
    // roadmap mode holds the whole tree opacified (a bolus can still brighten it transiently on top)
    if (s.fluoroMode === "roadmap") {
      for (let i = 0; i < branchC.length; i++) branchC[i] = Math.max(ROADMAP_FILL, branchC[i]);
    }

    // rebuild the instrument tubes from the live Cosserat node positions
    rebuildTube(rig.sheath, outer.x, outer.rodRadius + 0.05);
    rebuildTube(rig.wire, inner.x, 0.08);

    // shared C-arm camera. The isocenter is offset by the table pan so the operator can examine a
    // specific region (e.g. the visceral takeoffs) at magnification.
    const rao = (s.rao * Math.PI) / 180;
    const cran = (s.cranial * Math.PI) / 180;
    const cosC = Math.cos(cran);
    const isoX = ISO.x + s.panX;
    const isoY = ISO.y + s.panY;
    const isoZ = ISO.z;
    rig.camera.position.set(
      isoX + dist.current * Math.sin(rao) * cosC,
      isoY + dist.current * Math.sin(cran),
      isoZ + dist.current * Math.cos(rao) * cosC
    );
    rig.camera.up.set(0, 1, 0);
    rig.camera.lookAt(isoX, isoY, isoZ);

    // per-frame attenuation: bone fixed; walls faint; contrast fills the lumen following the sweep;
    // instruments always dense. (Bone sigma is set at build and never touched here.)
    for (const m of rig.meshes) {
      const ud = m.userData as MeshMaterials;
      if (ud.kind === "wire") ud.fluoro.uniforms.uSigma.value = 7.0;
      else if (ud.kind === "sheath") ud.fluoro.uniforms.uSigma.value = 4.5;
      else if (ud.kind === "vessel") {
        const c = ud.branchIndex != null ? branchC[ud.branchIndex] : 0;
        ud.fluoro.uniforms.uSigma.value = (0.05 + c * 2.6) * ud.atten;
      }
    }
    rig.tonemap.uniforms.uTime.value += h;

    // target marker
    const target = anatomy.targets.find((t) => t.id === s.targetId) ?? anatomy.targets[0];
    rig.target.position.copy(target.pos);

    // render: shared geometry + camera, two pipelines
    if (s.view === "3d") {
      for (const m of rig.meshes) m.material = (m.userData as MeshMaterials).mat3d;
      rig.target.visible = true;
      gl.setRenderTarget(null);
      gl.render(rig.scene, rig.camera);
    } else {
      for (const m of rig.meshes) m.material = (m.userData as MeshMaterials).fluoro;
      rig.target.visible = false;
      // DSA and roadmap both subtract the static mask (bone + walls); they differ only in the vessel
      // fill written into branchC above (transient bolus vs held opacification).
      const dsa = s.fluoroMode !== "live";
      if (dsa) {
        // DSA mask pass: bone + vessel walls only — no contrast, no instruments. Subtracted in the
        // tone-map so only the contrast column and the moving instruments remain.
        rig.wire.visible = false;
        rig.sheath.visible = false;
        for (const m of rig.meshes) {
          const ud = m.userData as MeshMaterials;
          if (ud.kind === "vessel") ud.fluoro.uniforms.uSigma.value = 0.05 * ud.atten;
        }
        gl.setRenderTarget(rig.rtBase);
        gl.setClearColor(0x000000, 1);
        gl.clear(true, true, false);
        gl.render(rig.scene, rig.camera);
        // restore the live (contrast + instruments) state for the live pass
        rig.wire.visible = true;
        rig.sheath.visible = true;
        for (const m of rig.meshes) {
          const ud = m.userData as MeshMaterials;
          if (ud.kind === "vessel") {
            const c = ud.branchIndex != null ? branchC[ud.branchIndex] : 0;
            ud.fluoro.uniforms.uSigma.value = (0.05 + c * 2.6) * ud.atten;
          }
        }
      }
      gl.setRenderTarget(rig.rt);
      gl.setClearColor(0x000000, 1);
      gl.clear(true, true, false);
      gl.render(rig.scene, rig.camera);
      gl.setRenderTarget(null);
      rig.tonemap.uniforms.tDepth.value = rig.rt.texture;
      rig.tonemap.uniforms.tBase.value = dsa ? rig.rtBase.texture : null;
      rig.tonemap.uniforms.uMode.value = dsa ? 1 : 0;
      rig.tonemap.uniforms.uBrightness.value = s.fluoroBrightness;
      rig.tonemap.uniforms.uContrast.value = s.fluoroContrast;
      gl.render(rig.postScene, rig.postCam);
    }

    // operator dosimetry / geometry readouts. Fluoroscopy = beam on; dose grows with beam time and
    // magnification (closer detector ⇒ smaller field ⇒ higher entrance dose).
    procClock.current += h;
    const sid = dist.current;
    const mag = 100 / sid;
    if (s.view !== "3d") {
      fluoroClock.current += h;
      doseAcc.current += h * mag * mag * 2.4;
    }

    // on-image direction cue: screen-space unit vector from the wire tip to the active target
    const tipNdc = projTip.current.copy(inner.tip()).project(rig.camera);
    const tgtNdc = projTgt.current.copy(target.pos).project(rig.camera);
    let tipDir: [number, number] | null = null;
    {
      const dx = tgtNdc.x - tipNdc.x;
      const dy = tgtNdc.y - tipNdc.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-4 && tgtNdc.z < 1) tipDir = [dx / len, -dy / len];
    }

    // metrics (throttled) — driven off the navigating guidewire
    const tipToTarget = inner.tip().distanceTo(target.pos);
    if (tipToTarget < target.acceptance) reachedFor.current += h;
    else reachedFor.current = 0;
    if (clock.current - reportAt.current > 0.12) {
      reportAt.current = clock.current;
      s.setMetrics({
        depth: inner.deployedLength(),
        tipToTarget,
        reached: reachedFor.current > 0.4,
        contrast: srcContrast,
        procTime: procClock.current,
        fluoroTime: fluoroClock.current,
        dose: doseAcc.current,
        sid,
        mag,
        tipDir
      });

      // on-image vessel callouts: project each navigable ostium to the viewport, keep in-frame +
      // front-facing ones, and greedily drop near-overlaps so the labels stay legible.
      if (s.showLabels && s.view !== "3d") {
        const out: { name: string; x: number; y: number }[] = [];
        for (const t of anatomy.targets) {
          const ndc = projLabel.current.copy(t.pos).project(rig.camera);
          if (ndc.z >= 1) continue; // behind the image plane
          const x = ndc.x * 0.5 + 0.5;
          const y = 1 - (ndc.y * 0.5 + 0.5);
          if (x < 0.03 || x > 0.97 || y < 0.05 || y > 0.95) continue; // off-frame
          if (out.some((l) => Math.abs(l.x - x) < 0.08 && Math.abs(l.y - y) < 0.03)) continue; // overlap
          out.push({ name: shortLabel(t.name), x, y });
        }
        s.setLabels(out);
      } else if (s.labels.length) {
        s.setLabels([]);
      }
    }

    const snapshot: SimDebugSnapshot = {
      frame: frame.current,
      time: clock.current,
      dt: h,
      physicsMode,
      view: s.view,
      accessId: s.accessId,
      selected: s.selected,
      targetId: s.targetId,
      inputs: {
        wire: { deployed: s.wire.deployed, torque: s.wire.torque, steer: s.wire.steer },
        sheath: { deployed: s.sheath.deployed, torque: s.sheath.torque, steer: s.sheath.steer }
      },
      metrics: {
        depth: inner.deployedLength(),
        tipToTarget,
        reached: reachedFor.current > 0.4,
        contrast: srcContrast
      },
      rods: {
        wire: rodDebug(inner, s.wire.deployed, prevWireTip.current, h),
        sheath: rodDebug(outer, s.sheath.deployed, prevSheathTip.current, h)
      },
      coax: {
        activeContacts: assembly.activeCoaxCount(),
        normalLoad: assembly.coaxNormalLoad(),
        innerExitPastOuterTip: assembly.innerExitPastOuterTip(),
        maxCoveredInnerRho: assembly.maxCoveredInnerRho(),
        innerClearance: assembly.innerClearance()
      },
      perf: {
        stepMs: stepMs.current,
        tangentAssemblies: stepCounts.current.tangentAssemblies,
        elementForceEvals: stepCounts.current.elementForceEvals
      }
    };
    debugSnapshot.current = snapshot;
    debugHistory.current.push(snapshot);
    if (debugHistory.current.length > DEBUG_HISTORY_LIMIT) {
      debugHistory.current.splice(0, debugHistory.current.length - DEBUG_HISTORY_LIMIT);
    }
  }, 1);

  return null;
}

export function Viewport() {
  return (
    <Canvas
      frameloop="always"
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false }}
      style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }}
    >
      <Engine />
    </Canvas>
  );
}
