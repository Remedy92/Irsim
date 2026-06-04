import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { AnatomyId, ViewMode } from "./main";

type Props = {
  variant: AnatomyId;
  opacity: number;
  stiffness: number;
  flowSpeed: number;
  showLabels: boolean;
  heatmap: boolean;
  progress: number;
  rotation: number;
  steer: number;
  viewMode: ViewMode;
};

const variantOffsets: Record<AnatomyId, number> = {
  standard: 0,
  "replaced-right": 0.42,
  "celiac-stenosis": -0.32,
  "tortuous-iliac": 0.72,
  "pulmonary-avm": -0.65
};

function curve(points: Array<[number, number, number]>) {
  return new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
}

function tube(path: THREE.CatmullRomCurve3, radius: number, material: THREE.Material) {
  return new THREE.Mesh(new THREE.TubeGeometry(path, 84, radius, 14, false), material);
}

export function VesselViewport({
  flowSpeed,
  heatmap,
  opacity,
  progress,
  rotation,
  showLabels,
  steer,
  stiffness,
  variant,
  viewMode
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const orbitRef = useRef({ dragging: false, lastX: 0, lastY: 0, pitch: -0.04, yaw: 0, zoom: 1 });

  useEffect(() => {
    if (!mountRef.current) return;

    const host = mountRef.current;
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x061119, 8, 19);

    const aspect = host.clientWidth / host.clientHeight;
    const camera =
      viewMode === "fluoro"
        ? new THREE.OrthographicCamera(-5.6 * aspect, 5.6 * aspect, 5.6, -5.6, 0.1, 100)
        : new THREE.PerspectiveCamera(34, aspect, 0.1, 100);
    camera.position.set(0.2, viewMode === "fluoro" ? 0.35 : 1.35, 12.2);
    camera.lookAt(0.2, 0.3, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const root = new THREE.Group();
    root.scale.setScalar(0.84);
    root.position.y = -0.12;
    root.rotation.y = THREE.MathUtils.degToRad(rotation);
    scene.add(root);

    scene.add(new THREE.AmbientLight(0x8fd8ff, 1.1));
    const key = new THREE.PointLight(0x69b8ff, 4.2, 15);
    key.position.set(-3, 4, 7);
    scene.add(key);
    const warm = new THREE.PointLight(0xff7c64, 2.6, 12);
    warm.position.set(4, -1, 4);
    scene.add(warm);

    const grid = new THREE.GridHelper(16, 32, viewMode === "fluoro" ? 0x151c20 : 0x1d4052, viewMode === "fluoro" ? 0x0b1114 : 0x102633);
    grid.position.y = -2.5;
    if (viewMode === "three-d") root.add(grid);

    const vesselColor = viewMode === "fluoro" ? 0xb9c2c5 : heatmap ? 0xff6d4a : 0x58aef4;
    const arteryColor = viewMode === "fluoro" ? 0xdce3e4 : heatmap ? 0xffc04a : 0xff725f;

    const vesselMat = new THREE.MeshStandardMaterial({
      color: vesselColor,
      emissive: viewMode === "fluoro" ? 0x9ba6aa : heatmap ? 0x5c1207 : 0x0b426c,
      emissiveIntensity: viewMode === "fluoro" ? 0.9 : 0.55,
      transparent: true,
      opacity: viewMode === "fluoro" ? 0.62 : Math.min(0.9, opacity + 0.12),
      roughness: viewMode === "fluoro" ? 0.82 : 0.27,
      metalness: 0.02,
      depthWrite: false
    });
    const arteryMat = new THREE.MeshStandardMaterial({
      color: arteryColor,
      emissive: viewMode === "fluoro" ? 0xcfd8da : heatmap ? 0x6c3e00 : 0x68190f,
      emissiveIntensity: viewMode === "fluoro" ? 1.05 : 0.48,
      transparent: true,
      opacity: viewMode === "fluoro" ? 0.72 : Math.min(0.92, opacity + 0.18),
      roughness: viewMode === "fluoro" ? 0.86 : 0.22,
      metalness: 0.02,
      depthWrite: false
    });
    const wireMat = new THREE.MeshStandardMaterial({
      color: viewMode === "fluoro" ? 0xf5f8f8 : 0xdde7ea,
      emissive: viewMode === "fluoro" ? 0xd0d8d9 : 0x000000,
      emissiveIntensity: viewMode === "fluoro" ? 0.8 : 0,
      metalness: viewMode === "fluoro" ? 0.18 : 0.9,
      roughness: viewMode === "fluoro" ? 0.55 : 0.18
    });
    const tipMat = new THREE.MeshStandardMaterial({
      color: viewMode === "fluoro" ? 0xffffff : 0xffdb66,
      emissive: viewMode === "fluoro" ? 0xe4ebed : 0xb25f00,
      emissiveIntensity: viewMode === "fluoro" ? 1.2 : 1.1
    });

    const offset = variantOffsets[variant];
    const segments: Array<{ path: THREE.CatmullRomCurve3; radius: number; material: THREE.Material }> = [];
    const labelDefs: Array<[string, number, number]> = [];
    let catheterPoints: Array<[number, number, number]>;

    const add = (points: Array<[number, number, number]>, radius: number, material: THREE.Material) => {
      segments.push({ path: curve(points), radius, material });
    };

    const addBranchFan = (origin: [number, number, number], branches: Array<[number, number, number]>, radius: number) => {
      branches.forEach((tip, index) => {
        add(
          [
            origin,
            [(origin[0] + tip[0]) / 2 + (index - 1) * 0.12, (origin[1] + tip[1]) / 2 + 0.18, tip[2] * 0.55],
            tip
          ],
          radius,
          arteryMat
        );
      });
    };

    if (variant === "pulmonary-avm") {
      add([[-2.7, -2.6, 0.1], [-2.1, -1.8, 0.0], [-1.35, -1.0, -0.08], [-0.65, -0.35, -0.05], [0.0, 0.02, 0]], 0.09, vesselMat);
      add([[0.0, 0.02, 0], [0.75, 0.38, -0.1], [1.48, 0.88, -0.08], [2.12, 1.22, 0.02]], 0.11, arteryMat);
      add([[0.8, 0.38, -0.1], [1.22, -0.08, 0.0], [1.82, -0.58, 0.08], [2.42, -0.82, 0.0]], 0.062, arteryMat);
      add([[1.48, 0.88, -0.08], [1.52, 1.42, -0.12], [1.34, 1.95, -0.05]], 0.046, arteryMat);
      add([[2.12, 1.22, 0.02], [2.56, 1.34, 0.04], [2.96, 1.26, 0.02]], 0.052, arteryMat);
      add([[2.98, 1.24, 0.02], [3.3, 0.92, -0.04], [3.54, 0.48, -0.05], [3.72, 0.05, -0.02]], 0.078, vesselMat);
      add([[1.1, -0.12, 0.08], [1.58, -0.38, 0.0], [2.16, -0.45, -0.06]], 0.04, arteryMat);
      const avmSac = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 28, 16),
        new THREE.MeshStandardMaterial({
          color: viewMode === "fluoro" ? 0xf1f3f3 : 0xce746f,
          emissive: viewMode === "fluoro" ? 0xbfc7c9 : 0x4b1714,
          emissiveIntensity: viewMode === "fluoro" ? 1.1 : 0.55,
          transparent: true,
          opacity: viewMode === "fluoro" ? 0.74 : 0.82,
          roughness: 0.55,
          depthWrite: false
        })
      );
      avmSac.position.set(2.98, 1.24, 0.02);
      root.add(avmSac);
      catheterPoints = [
        [-3.4, -3.1, 0.48],
        [-2.65, -2.35, 0.3],
        [-1.95, -1.55, 0.16],
        [-1.18, -0.82, 0.03],
        [-0.38, -0.12, 0],
        [0.78 + steer * 0.18, 0.36, -0.08 + steer * 0.12],
        [1.62 + steer * 0.32, 0.95 + Math.abs(steer) * 0.08, -0.08 + steer * 0.24],
        [2.84 + steer * 0.22, 1.2, 0.02]
      ];
      labelDefs.push(["Pulmonary artery", 42, 45], ["AVM sac", 65, 35], ["Draining vein", 72, 48]);
    } else {
      const iliacAccess: Array<[number, number, number]> =
        variant === "tortuous-iliac"
          ? [[-3.9, -3.45, 0.42], [-3.05, -2.95, 0.2], [-2.45, -3.22, 0.1], [-1.7, -2.42, 0], [-0.82, -1.68, -0.08], [-0.12, -0.68, -0.1], [0.0, -0.08, -0.08]]
          : [[-3.75, -3.35, 0.34], [-2.82, -2.75, 0.18], [-1.78, -1.88, 0.04], [-0.72, -0.82, -0.07], [0.0, -0.08, -0.08]];

      add([[0.08, -3.3, -0.18], [0.0, -2.1, -0.18], [0.0, -0.85, -0.16], [0.0, 0.6, -0.14], [0.03, 2.35, -0.16]], 0.14, arteryMat);
      add(iliacAccess, variant === "tortuous-iliac" ? 0.105 : 0.09, arteryMat);
      add([[0.02, -1.12, -0.08], [0.62, -1.16, -0.05], [1.28, -0.88, -0.02], [1.86, -0.35, 0.04], [2.32, 0.28, 0.02]], 0.086, arteryMat);
      add([[2.32, 0.28, 0.02], [2.82, 0.74, 0.04], [3.34, 1.02, 0.02]], 0.046, arteryMat);
      add([[2.32, 0.28, 0.02], [2.84, -0.2, -0.06], [3.3, -0.62, -0.04]], 0.04, arteryMat);

      add([[0.0, 0.18, -0.02], [-0.32, 0.38, 0.0], [-0.62, 0.53, 0.02]], variant === "celiac-stenosis" ? 0.045 : 0.082, arteryMat);
      add([[-0.62, 0.53, 0.02], [-0.92, 1.02, -0.02], [-0.88, 1.6, -0.04]], 0.034, arteryMat);
      add([[-0.62, 0.53, 0.02], [-1.38, 0.4, 0.0], [-2.1, 0.58, 0.08], [-2.8, 0.44, -0.02], [-3.38, 0.58, 0.0]], 0.05, arteryMat);
      add([[-0.62, 0.53, 0.02], [0.02, 0.48, 0.02], [0.74, 0.32, 0.0], [1.28, 0.18, 0.02]], 0.07, arteryMat);
      add([[1.0, 0.26, 0.0], [1.08, -0.36, 0.04], [1.2, -0.96, 0.06], [1.48, -1.42, 0.0]], 0.046, arteryMat);
      add([[1.28, 0.18, 0.02], [1.55, 0.62, 0.02], [1.78, 1.02, 0.04]], 0.062, arteryMat);
      add([[1.78, 1.02, 0.04], [1.38, 1.42, 0.02], [0.86, 1.68, -0.04]], 0.044, arteryMat);

      if (variant === "replaced-right") {
        add([[1.86, -0.35, 0.04], [2.2, 0.22, 0.08], [2.52, 0.86, 0.12], [2.9, 1.26, 0.08]], 0.056, arteryMat);
        addBranchFan([2.9, 1.26, 0.08], [[3.42, 1.48, 0.1], [3.44, 1.1, 0.05], [3.18, 1.76, 0.0]], 0.026);
      } else {
        add([[1.78, 1.02, 0.04], [2.22, 1.18 + offset * 0.12, 0.02], [2.78, 1.2 + offset * 0.16, 0.04], [3.18, 1.38, 0.0]], 0.05, arteryMat);
        addBranchFan([3.18, 1.38, 0.0], [[3.64, 1.62, 0.02], [3.72, 1.24, -0.03], [3.38, 1.82, 0.08]], 0.025);
      }

      add([[1.9, 1.05, 0.04], [2.12, 0.76, -0.08], [2.32, 0.7, -0.14]], 0.024, arteryMat);
      add([[0.0, -1.12, -0.18], [0.56, -0.54, -0.24], [1.08, -0.22, -0.18], [1.38, 0.02, -0.08]], 0.044, vesselMat);
      add([[1.38, 0.02, -0.08], [1.85, 0.62, -0.1], [2.44, 0.98, -0.12]], 0.054, vesselMat);
      add([[1.38, 0.02, -0.08], [0.76, 0.5, -0.18], [0.22, 0.92, -0.16], [-0.22, 1.38, -0.12]], 0.043, vesselMat);

      if (variant === "celiac-stenosis") {
        add([[1.48, -1.42, 0.0], [1.28, -0.78, 0.18], [1.2, -0.18, 0.18], [1.0, 0.26, 0.0]], 0.034, arteryMat);
      }

      catheterPoints = [
        ...iliacAccess,
        [0.4 + steer * 0.14, 0.2, 0.02 + steer * 0.12],
        [1.16 + steer * 0.22, 0.28, 0.02 + steer * 0.18],
        [1.78 + steer * 0.28, 0.88 + Math.abs(steer) * 0.08, 0.04 + steer * 0.22],
        [2.72 + steer * 0.34, 1.18 + offset * 0.24, 0.04 + steer * 0.28]
      ];
      labelDefs.push(["Aorta", 49, 44], ["Celiac axis", 44, 42], ["Common hepatic", 59, 42], ["GDA", 61, 58], ["Guidewire tip", 66, 37]);
    }

    segments.forEach((segment) => root.add(tube(segment.path, segment.radius, segment.material)));

    const catheterFull = curve(catheterPoints);
    const sampled = catheterFull.getPoints(120).slice(0, Math.max(4, Math.round(progress * 120)));
    const catheter = new THREE.CatmullRomCurve3(sampled);
    root.add(tube(catheter, 0.038 + stiffness * 0.01, wireMat));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.082, 24, 24), tipMat);
    tip.position.copy(sampled[sampled.length - 1]);
    root.add(tip);

    const liverShape = new THREE.Mesh(
      new THREE.SphereGeometry(2.9, 48, 24),
      new THREE.MeshPhysicalMaterial({
        color: 0x18334c,
        transparent: true,
        opacity: 0.08,
        roughness: 0.5,
        transmission: 0.18,
        depthWrite: false
      })
    );
    liverShape.scale.set(1.62, 0.86, 0.2);
    liverShape.position.set(-0.45, 0.65, -0.45);
    if (viewMode === "three-d" && variant !== "pulmonary-avm") root.add(liverShape);

    const labels: HTMLDivElement[] = [];
    if (showLabels) {
      labelDefs.forEach(
        ([text, left, top]) => {
          const label = document.createElement("div");
          label.className = "scene-label";
          label.textContent = String(text);
          label.style.left = `${left}%`;
          label.style.top = `${top}%`;
          host.appendChild(label);
          labels.push(label);
        }
      );
    }

    let frame = 0;
    let animationId = 0;
    const animate = () => {
      frame += 0.01 * flowSpeed;
      const orbit = orbitRef.current;
      if (viewMode === "three-d") {
        const yaw = THREE.MathUtils.degToRad(rotation) + orbit.yaw + Math.sin(frame) * 0.025;
        const pitch = orbit.pitch + Math.sin(frame * 0.7) * 0.018;
        const radius = 12.2 * orbit.zoom;
        camera.position.set(Math.sin(yaw) * radius, 1.35 + Math.sin(pitch) * 5.4, Math.cos(yaw) * radius);
        camera.lookAt(0.2, 0.15, 0);
        root.rotation.y = 0;
        root.rotation.x = 0;
      } else {
        root.rotation.y = THREE.MathUtils.degToRad(rotation * 0.3);
        root.rotation.x = 0;
        camera.position.set(0.2 + steer * 0.28, 0.25, 12.2 * orbit.zoom);
        camera.lookAt(0.2 + steer * 0.16, 0.2, 0);
      }
      tip.scale.setScalar(1 + Math.sin(frame * 5) * 0.08);
      renderer.render(scene, camera);
      animationId = window.requestAnimationFrame(animate);
    };
    animate();

    const handlePointerDown = (event: PointerEvent) => {
      host.setPointerCapture(event.pointerId);
      orbitRef.current.dragging = true;
      orbitRef.current.lastX = event.clientX;
      orbitRef.current.lastY = event.clientY;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const orbit = orbitRef.current;
      if (!orbit.dragging) return;
      const deltaX = event.clientX - orbit.lastX;
      const deltaY = event.clientY - orbit.lastY;
      orbit.lastX = event.clientX;
      orbit.lastY = event.clientY;
      orbit.yaw += deltaX * 0.006;
      orbit.pitch = Math.max(-0.65, Math.min(0.55, orbit.pitch + deltaY * 0.004));
    };

    const handlePointerUp = (event: PointerEvent) => {
      orbitRef.current.dragging = false;
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      orbitRef.current.zoom = Math.max(0.72, Math.min(1.45, orbitRef.current.zoom + event.deltaY * 0.0008));
    };

    const resize = () => {
      const nextAspect = host.clientWidth / host.clientHeight;
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = nextAspect;
      } else {
        camera.left = -5.6 * nextAspect;
        camera.right = 5.6 * nextAspect;
      }
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    };
    window.addEventListener("resize", resize);
    host.addEventListener("pointerdown", handlePointerDown);
    host.addEventListener("pointermove", handlePointerMove);
    host.addEventListener("pointerup", handlePointerUp);
    host.addEventListener("pointercancel", handlePointerUp);
    host.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      window.cancelAnimationFrame(animationId);
      window.removeEventListener("resize", resize);
      host.removeEventListener("pointerdown", handlePointerDown);
      host.removeEventListener("pointermove", handlePointerMove);
      host.removeEventListener("pointerup", handlePointerUp);
      host.removeEventListener("pointercancel", handlePointerUp);
      host.removeEventListener("wheel", handleWheel);
      labels.forEach((label) => label.remove());
      renderer.dispose();
      host.replaceChildren();
    };
  }, [flowSpeed, heatmap, opacity, progress, rotation, showLabels, steer, stiffness, variant, viewMode]);

  return <div className="vessel-viewport" ref={mountRef} />;
}
