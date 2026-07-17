import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import type { Anatomy } from "./types";
import { CosseratRod, SHEATH_DIRECT } from "./cosserat";
import {
  buildAccessFrame,
  defaultInsertionState,
  injectOrRetractNodesAtAccess,
  injectedFrame,
  solveInletPositionMotor,
  solveInletOrientationMotor,
  solveAccessSleeveRadial,
  type Injectable
} from "./insertion";

/** Straight tube along +y, access at the bottom. */
function tube(radius: number): Anatomy {
  const points = [];
  for (let i = 0; i <= 12; i++) points.push({ pos: new Vector3(0, -2 + i * 4, 0), radius, s: i * 4 });
  return {
    id: "t",
    name: "tube",
    branches: [{ id: "tube", name: "tube", attenuation: 1, points }],
    access: [{ id: "a", name: "a", pos: new Vector3(0, -2, 0), dir: new Vector3(0, 1, 0), branchId: "tube" }],
    targets: [],
    provenance: { source: "test", license: "test", note: "test" }
  };
}

describe("access frame", () => {
  it("buildAccessFrame is orthonormal with e along the insertion direction", () => {
    const af = buildAccessFrame({ id: "a", name: "a", pos: new Vector3(1, 2, 3), dir: new Vector3(0, 0, 2), branchId: "b" });
    expect(af.e.length()).toBeCloseTo(1, 12);
    expect(af.u.length()).toBeCloseTo(1, 12);
    expect(af.v.length()).toBeCloseTo(1, 12);
    // mutually perpendicular
    expect(af.e.dot(af.u)).toBeCloseTo(0, 12);
    expect(af.e.dot(af.v)).toBeCloseTo(0, 12);
    expect(af.u.dot(af.v)).toBeCloseTo(0, 12);
    // e points along the (normalized) insertion direction
    expect(af.e.x).toBeCloseTo(0, 12);
    expect(af.e.z).toBeCloseTo(1, 12);
  });

  it("injectedFrame maps the body z-axis onto the access axis", () => {
    const af = buildAccessFrame({ id: "a", name: "a", pos: new Vector3(0, 0, 0), dir: new Vector3(0, 1, 0), branchId: "b" });
    const q = injectedFrame(af, 0, new Quaternion());
    const z = new Vector3(0, 0, 1).applyQuaternion(q);
    expect(z.x).toBeCloseTo(af.e.x, 6);
    expect(z.y).toBeCloseTo(af.e.y, 6);
    expect(z.z).toBeCloseTo(af.e.z, 6);
  });
});

/** A minimal Injectable that records prepend/remove, to test the BC logic in isolation. */
class FakeRod implements Injectable {
  n = 3;
  readonly minNodes = 2;
  prepends: { p: Vector3; h: number }[] = [];
  removed = 0;
  prependNode(p: Vector3, _q: Quaternion, h: number): void {
    this.prepends.push({ p: p.clone(), h });
    this.n++;
  }
  removeProximalNode(): void {
    if (this.n <= this.minNodes) return;
    this.removed++;
    this.n--;
  }
}

describe("material-injection insertion BC", () => {
  it("injects exactly one frozen-h node per accumulated h of feed", () => {
    const af = buildAccessFrame({ id: "a", name: "a", pos: new Vector3(0, 0, 0), dir: new Vector3(0, 1, 0), branchId: "b" });
    const h = 0.25;
    const ins = defaultInsertionState(h);
    const rod = new FakeRod();
    // feed 1 cm at 1 cm/s over a full second (dt = 1) ⇒ 1/h = 4 nodes injected
    const injected = injectOrRetractNodesAtAccess(rod, af, ins, 1, 0, 1);
    expect(injected).toBe(4);
    expect(rod.prepends.length).toBe(4);
    // every injected segment has the FIXED base length h (never rescaled)
    for (const pr of rod.prepends) expect(pr.h).toBe(h);
    // residual inlet offset is the sub-h remainder in [0, h)
    expect(ins.inletOffset).toBeGreaterThanOrEqual(0);
    expect(ins.inletOffset).toBeLessThan(h);
  });

  it("retracts (removes proximal nodes) on negative feed, down to minNodes", () => {
    const af = buildAccessFrame({ id: "a", name: "a", pos: new Vector3(0, 0, 0), dir: new Vector3(0, 1, 0), branchId: "b" });
    const h = 0.25;
    const ins = defaultInsertionState(h);
    const rod = new FakeRod();
    rod.n = 6;
    const injected = injectOrRetractNodesAtAccess(rod, af, ins, -1, 0, 1); // pull out 1 cm
    expect(injected).toBeLessThan(0);
    expect(rod.removed).toBeGreaterThan(0);
    // never drops below minNodes
    expect(rod.n).toBeGreaterThanOrEqual(rod.minNodes);
  });
});

describe("compliant inlet motors (Stage-3 wiring; exercised here)", () => {
  const af = () => buildAccessFrame({ id: "a", name: "a", pos: new Vector3(0, 0, 0), dir: new Vector3(0, 1, 0), branchId: "b" });

  it("position motor drives a free node toward the commanded inlet offset along e", () => {
    const access = af();
    const ins = defaultInsertionState(0.25);
    ins.forceMax = 1e12; // unconstrained: this test exercises convergence, not the (physical-N) cap
    ins.inletOffsetTarget = 0.1; // target axial position along e (= +y)
    const p = new Vector3(0.5, 0, -0.5); // off the axis and behind the target
    for (let i = 0; i < 40; i++) solveInletPositionMotor(p, 1, access, ins, 1 / 240);
    // converges to x_A + 0.1·e = (0, 0.1, 0): on-axis (u,v removed) and at the axial target
    expect(Math.hypot(p.x, p.z)).toBeLessThan(0.05);
    expect(p.y).toBeGreaterThan(0.05);
  });

  it("position motor is a no-op for a kinematic node (w=0)", () => {
    const access = af();
    const ins = defaultInsertionState(0.25);
    const p = new Vector3(1, 2, 3);
    solveInletPositionMotor(p, 0, access, ins, 1 / 240);
    expect(p.equals(new Vector3(1, 2, 3))).toBe(true);
  });

  it("orientation motor rotates a free frame toward the rolled access frame", () => {
    const access = af();
    const ins = defaultInsertionState(0.25);
    ins.rollTarget = Math.PI / 3;
    const target = injectedFrame(access, ins.rollTarget, new Quaternion());
    const q = injectedFrame(access, 0, new Quaternion()); // start unrolled
    for (let i = 0; i < 200; i++) solveInletOrientationMotor(q, 1, access, ins, 1 / 240);
    expect(Math.abs(q.dot(target))).toBeGreaterThan(0.95); // converged near the target frame
  });

  it("access-sleeve radial constraint pulls a node in the collar zone back to the axis", () => {
    const access = af();
    const ins = defaultInsertionState(0.25); // sleeveLength = 4h = 1.0
    // a node proximal of the access plane (axial -0.5, inside [-1,0]) and off-axis
    const p = new Vector3(0.4, -0.5, 0.4);
    let applied = false;
    for (let i = 0; i < 60; i++) applied = solveAccessSleeveRadial(p, 1, access, ins, 1 / 240);
    expect(applied).toBe(true);
    expect(Math.hypot(p.x, p.z)).toBeLessThan(0.05); // radial component removed
    expect(p.y).toBeCloseTo(-0.5, 6); // axial position untouched (slides freely)
  });
});

describe("CosseratRod injection on the live rod", () => {
  function run(rod: CosseratRod, steps: number) {
    for (let i = 0; i < steps; i++) rod.step(1 / 60);
  }

  function eiOf(rod: CosseratRod, segment = 0): number {
    return rod.restLen[segment] / (4 * rod.material.perSegment[segment].alphaBend1);
  }

  it("feeding grows the node count; rest lengths stay frozen at h (no rescale)", () => {
    const rod = new CosseratRod(tube(5), "a");
    rod.input = { deployed: 10, steer: 0, torque: 0 };
    run(rod, 200);
    const n0 = rod.n;
    // every rest length is exactly the frozen base length h
    for (const l of rod.restLen) expect(l).toBeCloseTo(rod.h, 9);

    rod.input.deployed = 22;
    run(rod, 400);
    // node count grew with feed (no global rest-length growth — segments were ADDED)
    expect(rod.n).toBeGreaterThan(n0);
    for (const l of rod.restLen) expect(l).toBeCloseTo(rod.h, 9);
    // ~deployed/h segments
    expect(rod.n - 1).toBeGreaterThan(Math.round(20 / rod.h));
  });

  it("prepending feed material immediately creates a full-length proximal segment", () => {
    const rod = new CosseratRod(tube(5), "a");
    const access = rod.access.x.clone();
    for (let i = 0; i < rod.n; i++) {
      rod.x[i].copy(access).addScaledVector(rod.access.e, i * rod.h);
      rod.prev[i].copy(rod.x[i]);
    }
    const tipY0 = rod.tip().y;

    rod.prependNode(rod.access.x, rod.access.frame, rod.h);

    expect(rod.x[0].distanceTo(access)).toBeLessThan(1e-9);
    expect(rod.x[1].distanceTo(rod.x[0])).toBeCloseTo(rod.h, 9);
    expect(rod.tip().y).toBeCloseTo(tipY0 + rod.h, 9);
  });

  it("material advection: injecting proximal shaft never smears the distal tip profile", () => {
    const rod = new CosseratRod(tube(5), "a");
    rod.input = { deployed: 10, steer: 0, torque: 0 };
    run(rod, 200);
    const seg = rod.material.perSegment;
    // snapshot the distal tip segments' bend compliance + rest curvature
    const tipBendBefore = seg[seg.length - 1].alphaBend1;
    const tipCurvBefore = seg[seg.length - 1].restCurvature.x;

    rod.input.deployed = 25; // inject a lot of proximal shaft
    run(rod, 500);
    const seg2 = rod.material.perSegment;
    // the distal tip profile is UNCHANGED (advection-safe Lagrangian field)
    expect(seg2[seg2.length - 1].alphaBend1).toBeCloseTo(tipBendBefore, 9);
    expect(seg2[seg2.length - 1].restCurvature.x).toBeCloseTo(tipCurvBefore, 9);
    // and the proximal end is shaft (zero rest curvature), not the floppy tip
    expect(seg2[0].restCurvature.x).toBe(0);
  });

  it("sheath injection keeps sheath shaft material instead of leaking guidewire shaft properties", () => {
    const sheath = new CosseratRod(tube(5), "a", SHEATH_DIRECT);
    sheath.input = { deployed: 10, steer: 0, torque: 0 };
    run(sheath, 200);
    const shaftEI = eiOf(sheath, 0);
    const shaftRadius = sheath.material.perSegment[0].rodRadius;

    sheath.input.deployed = 24;
    run(sheath, 500);

    for (let i = 0; i < Math.min(12, sheath.material.perSegment.length); i++) {
      expect(eiOf(sheath, i)).toBeCloseTo(shaftEI, 9);
      expect(sheath.material.perSegment[i].rodRadius).toBeCloseTo(shaftRadius, 12);
    }
    expect(shaftRadius).toBeGreaterThan(0.09);
  });

  it("withdrawal advects remaining material backward before dropping the proximal node", () => {
    const rod = new CosseratRod(tube(5), "a");
    const access = rod.access.x.clone();
    for (let i = 0; i < rod.n; i++) {
      rod.x[i].copy(access).addScaledVector(rod.access.e, i * rod.h);
      rod.prev[i].copy(rod.x[i]);
    }
    const n0 = rod.n;
    const tipY0 = rod.tip().y;

    rod.removeProximalNode();

    expect(rod.n).toBe(n0 - 1);
    expect(rod.x[0].distanceTo(access)).toBeLessThan(1e-9);
    expect(rod.tip().y).toBeCloseTo(tipY0 - rod.h, 9);
  });
});
