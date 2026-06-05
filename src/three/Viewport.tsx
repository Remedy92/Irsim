import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  AmbientLight,
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
import { buildNormalAnatomy } from "../sim/anatomy";
import { CoaxialAssembly, CosseratRod, SHIPPED_GUIDEWIRE, SHIPPED_SHEATH } from "../sim/cosserat";
import { useSim } from "../sim/store";
import { makeAttenuationMaterial, makeTonemapMaterial } from "./fluoro";

const ISO = new Vector3(0, 14, 0);

interface MeshMaterials {
  mat3d: Material;
  fluoro: ShaderMaterial;
  atten: number;
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

function Engine() {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);

  const anatomy = useMemo(() => buildNormalAnatomy(), []);

  // The chosen access side (right/left common femoral). Reactive so picking a different start
  // rebuilds the instruments at that artery.
  const accessId = useSim((s) => s.accessId);

  // New Cosserat-XPBD instruments: a guidewire (inner) sliding inside a sheath (outer), both
  // entering at the selected femoral access. The wire and sheath are driven independently (see
  // useFrame), but covered guidewire material is routed through the sheath channel: it does not
  // choose vessel-wall contacts/branches until it exits the sheath portal. Replaces legacy rod.ts.
  const assembly = useMemo(() => {
    const startId = anatomy.access.some((a) => a.id === accessId) ? accessId : anatomy.access[0].id;
    // Shipped presets live in cosserat.ts so the app and integration tests exercise the same path.
    const inner = new CosseratRod(anatomy, startId, SHIPPED_GUIDEWIRE);
    const outer = new CosseratRod(anatomy, startId, SHIPPED_SHEATH);
    return new CoaxialAssembly(outer, inner);
  }, [anatomy, accessId]);

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

    for (const br of anatomy.branches) {
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
      mesh.userData = { mat3d, fluoro, atten: br.attenuation } satisfies MeshMaterials;
      scene.add(mesh);
      meshes.push(mesh);
    }

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
    sheath.userData = { mat3d: sheathMat3d, fluoro: sheathFluoro, atten: 1 } satisfies MeshMaterials;
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
    wire.userData = { mat3d: wireMat3d, fluoro: wireFluoro, atten: 1 } satisfies MeshMaterials;
    wire.frustumCulled = false;
    scene.add(wire);
    meshes.push(wire);

    // target marker: bright white (the single high-salience signal, matching the UI accent).
    const target = new Mesh(
      new SphereGeometry(0.5, 20, 16),
      new MeshBasicMaterial({ color: 0xf2f6f9, transparent: true, opacity: 0.9 })
    );
    scene.add(target);

    const rt = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      depthBuffer: false
    });
    const tonemap = makeTonemapMaterial();
    const postScene = new Scene();
    postScene.add(new Mesh(new PlaneGeometry(2, 2), tonemap));
    const postCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

    return { scene, camera, meshes, sheath, wire, target, rt, tonemap, postScene, postCam };
  }, [anatomy]);

  const dist = useRef(95);
  const contrast = useRef(0);
  const lastSeq = useRef(0);
  const reachedFor = useRef(0);
  const clock = useRef(0);
  const reportAt = useRef(0);

  useEffect(() => {
    const dpr = Math.min(window.devicePixelRatio, 2);
    rig.rt.setSize(Math.max(1, Math.floor(size.width * dpr)), Math.max(1, Math.floor(size.height * dpr)));
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
      st.set({
        rao: Math.max(-90, Math.min(90, st.rao + (e.clientX - lx) * 0.4)),
        cranial: Math.max(-50, Math.min(50, st.cranial - (e.clientY - ly) * 0.3))
      });
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
    if (h > 0) assembly.step(h);

    // contrast injection ramp/decay
    if (s.injectSeq !== lastSeq.current) {
      lastSeq.current = s.injectSeq;
      contrast.current = 1;
    }
    contrast.current = Math.max(0, contrast.current - h * 0.13);

    // rebuild the instrument tubes from the live Cosserat node positions
    rebuildTube(rig.sheath, outer.x, outer.rodRadius + 0.05);
    rebuildTube(rig.wire, inner.x, 0.08);

    // shared C-arm camera
    const rao = (s.rao * Math.PI) / 180;
    const cran = (s.cranial * Math.PI) / 180;
    const cosC = Math.cos(cran);
    rig.camera.position.set(
      ISO.x + dist.current * Math.sin(rao) * cosC,
      ISO.y + dist.current * Math.sin(cran),
      ISO.z + dist.current * Math.cos(rao) * cosC
    );
    rig.camera.up.set(0, 1, 0);
    rig.camera.lookAt(ISO);

    // per-frame attenuation: walls faint, contrast fills lumen dark, instruments always dark
    for (const m of rig.meshes) {
      const ud = m.userData as MeshMaterials;
      if (m === rig.wire) ud.fluoro.uniforms.uSigma.value = 7.0;
      else if (m === rig.sheath) ud.fluoro.uniforms.uSigma.value = 4.5;
      else ud.fluoro.uniforms.uSigma.value = (0.05 + contrast.current * 2.6) * ud.atten;
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
      gl.setRenderTarget(rig.rt);
      gl.setClearColor(0x000000, 1);
      gl.clear(true, true, false);
      gl.render(rig.scene, rig.camera);
      gl.setRenderTarget(null);
      rig.tonemap.uniforms.tDepth.value = rig.rt.texture;
      gl.render(rig.postScene, rig.postCam);
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
        contrast: contrast.current
      });
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
