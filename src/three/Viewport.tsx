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
import { GUIDEWIRE, Rod } from "../sim/rod";
import { useSim } from "../sim/store";
import { makeAttenuationMaterial, makeTonemapMaterial } from "./fluoro";

const ISO = new Vector3(0, 14, 0);

interface MeshMaterials {
  mat3d: Material;
  fluoro: ShaderMaterial;
  atten: number;
}

function Engine() {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);

  const anatomy = useMemo(() => buildNormalAnatomy(), []);
  const rod = useMemo(() => new Rod(anatomy, "rcfa", GUIDEWIRE), [anatomy]);

  const rig = useMemo(() => {
    const scene = new Scene();
    scene.background = new Color(0x0a0f14);
    scene.add(new AmbientLight(0x90b0d0, 1.1));
    const dir = new DirectionalLight(0xfff0e0, 1.4);
    dir.position.set(20, 40, 30);
    scene.add(dir);

    const camera = new PerspectiveCamera(40, 1, 1, 500);

    const meshes: Mesh[] = [];

    for (const br of anatomy.branches) {
      const meanR = br.points.reduce((a, p) => a + p.radius, 0) / br.points.length;
      const curve = new CatmullRomCurve3(br.points.map((p) => p.pos));
      const geo = new TubeGeometry(curve, br.points.length * 2, meanR, 14, false);
      const fluoro = makeAttenuationMaterial(0);
      const mat3d = new MeshStandardMaterial({
        color: 0xc0432f,
        roughness: 0.42,
        transparent: true,
        opacity: 0.55
      });
      const mesh = new Mesh(geo, fluoro);
      mesh.userData = { mat3d, fluoro, atten: br.attenuation } satisfies MeshMaterials;
      scene.add(mesh);
      meshes.push(mesh);
    }

    // guidewire — geometry rebuilt each frame from rod nodes
    const wireFluoro = makeAttenuationMaterial(7.0);
    const wireMat3d = new MeshStandardMaterial({
      color: 0xeaf2f6,
      metalness: 0.85,
      roughness: 0.25,
      emissive: 0x223344,
      emissiveIntensity: 0.3
    });
    const wire = new Mesh(new BufferGeometry(), wireFluoro);
    wire.userData = { mat3d: wireMat3d, fluoro: wireFluoro, atten: 1 } satisfies MeshMaterials;
    wire.frustumCulled = false;
    scene.add(wire);
    meshes.push(wire);

    const target = new Mesh(
      new SphereGeometry(0.5, 20, 16),
      new MeshBasicMaterial({ color: 0x49d08b, transparent: true, opacity: 0.85 })
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

    return { scene, camera, meshes, wire, target, rt, tonemap, postScene, postCam };
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
    const h = Math.min(delta, 1 / 30);
    clock.current += h;

    // input -> physics
    rod.input.deployed = s.deployed;
    rod.input.steer = s.steer;
    rod.input.torque = s.torque;
    rod.step(h);

    // contrast injection ramp/decay
    if (s.injectSeq !== lastSeq.current) {
      lastSeq.current = s.injectSeq;
      contrast.current = 1;
    }
    contrast.current = Math.max(0, contrast.current - h * 0.13);

    // rebuild guidewire tube
    rig.wire.geometry.dispose();
    rig.wire.geometry = new TubeGeometry(new CatmullRomCurve3(rod.x.slice()), rod.n, 0.08, 6, false);

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

    // per-frame attenuation: walls faint, contrast fills lumen dark, wire always dark
    for (const m of rig.meshes) {
      const ud = m.userData as MeshMaterials;
      if (m === rig.wire) ud.fluoro.uniforms.uSigma.value = 7.0;
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

    // metrics (throttled)
    const tipToTarget = rod.tip().distanceTo(target.pos);
    if (tipToTarget < target.acceptance) reachedFor.current += h;
    else reachedFor.current = 0;
    if (clock.current - reportAt.current > 0.12) {
      reportAt.current = clock.current;
      s.setMetrics({
        depth: rod.deployedLength(),
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
