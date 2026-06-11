import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import {
  makeWallContact,
  solveNormalContact,
  solveTranslationalFriction,
  solveSpinFriction,
  type NodeContactTarget
} from "./contact";

/**
 * Isolated, deterministic unit tests for the Stage-3 in-loop frictional contact constraints
 * (contact.ts). These exercise the constraint MATH directly (one node, a fixed wall) so the
 * stick-slip + normal-inequality + spin-friction mechanisms are tested without the rod-solver
 * confounds (geometry, advection, convergence). The rod-level qualitative behaviors
 * (blocked-tip buckling, torque transfer with delay) are asserted in cosserat.test.ts.
 *
 * UNITS: cm, time SI. The wall is a sphere/plane at `center` with allowed radius `allowed`.
 */

function singleNode(p: Vector3): NodeContactTarget {
  const w = [1];
  const wq = [1];
  return {
    x: [p],
    prev: [p.clone()],
    q: [new Quaternion()],
    w,
    wq,
    rodRadius: 0.05,
    invMassAt: (node) => w[node] ?? 0,
    invInertiaAt: (node) => wq[node] ?? 0
  };
}

describe("XPBD normal contact (inequality)", () => {
  it("uses the target inverse-mass accessor instead of the raw w array", () => {
    const dt = 1 / 120;
    const p = new Vector3(1.3, 0, 0);
    const rod = singleNode(p);
    rod.w[0] = 0; // raw array says fixed; accessor still exposes the target mass metric
    rod.invMassAt = () => 1;
    const c = makeWallContact("r", 0, 0, 0.1, 0.05, 0.05, 1e-9, 1e-8, 1e-7);
    c.center.set(0, 0, 0);
    c.vesselTangent.set(0, 1, 0);
    c.allowedRadius = 1.0;

    solveNormalContact(rod, c, dt);

    expect(p.length()).toBeLessThan(1.3);
    expect(c.lambdaN).toBeGreaterThan(0);
  });

  it("pushes a penetrating node back to the allowed wall and builds a positive normal load", () => {
    const dt = 1 / 120;
    const center = new Vector3(0, 0, 0);
    const allowed = 1.0;
    const p = new Vector3(1.3, 0, 0); // 0.3 cm past the allowed wall along +x
    const rod = singleNode(p);
    const c = makeWallContact("r", 0, 0, 0.1, 0.05, 0.05, 1e-9, 1e-8, 1e-7);
    c.center.copy(center);
    c.vesselTangent.set(0, 1, 0);
    c.allowedRadius = allowed;
    for (let i = 0; i < 20; i++) solveNormalContact(rod, c, dt);
    // node is pulled back onto (or just inside) the allowed radius (tiny XPBD residual ok)
    expect(p.length()).toBeLessThanOrEqual(allowed + 1e-3);
    expect(p.length()).toBeGreaterThan(allowed - 0.05);
    // a positive normal multiplier (wall reaction estimate) accumulated
    expect(c.lambdaN).toBeGreaterThan(0);
  });

  it("is a true inequality: a node well INSIDE the lumen is untouched (no load)", () => {
    const dt = 1 / 120;
    const p = new Vector3(0.2, 0, 0); // well inside allowed=1.0
    const rod = singleNode(p);
    const c = makeWallContact("r", 0, 0, 0.1, 0.05, 0.05, 1e-9, 1e-8, 1e-7);
    c.center.set(0, 0, 0);
    c.vesselTangent.set(0, 1, 0);
    c.allowedRadius = 1.0;
    for (let i = 0; i < 20; i++) solveNormalContact(rod, c, dt);
    expect(p.equals(new Vector3(0.2, 0, 0))).toBe(true);
    expect(c.lambdaN).toBe(0);
  });
});

describe("translational stick-slip friction (persistent anchor)", () => {
  // A node pressed on a wall (normal +x), with a standing normal load; we then try to drag it
  // tangentially (+y) by moving it and re-solving. Static friction should HOLD it (anchor),
  // and a strong drag should SLIP it (kinetic), sliding the anchor.
  function pressed(muS: number, muK: number, lambdaN: number) {
    const p = new Vector3(1.0, 0, 0);
    const rod = singleNode(p);
    const c = makeWallContact("r", 0, 0, muS, muK, 0.05, 1e-9, 1e-8, 1e-7);
    c.center.set(0, 0, 0);
    c.vesselTangent.set(0, 1, 0); // wall tangent along +y
    c.normal.set(1, 0, 0);
    c.allowedRadius = 1.0;
    c.lambdaN = lambdaN; // standing normal load (as if from the normal solve)
    return { rod, c, p };
  }

  it("STICK: a small tangential nudge under the static cone is pulled back to the anchor", () => {
    const dt = 1 / 120;
    const { rod, c, p } = pressed(0.5, 0.4, 5.0); // big cone (μ_s·λ_n = 2.5)
    solveTranslationalFriction(rod, c, dt); // drops the anchor at the current point
    expect(c.hasAnchor).toBe(true);
    const anchorY = c.anchor.y;
    // nudge tangentially a little, then re-solve: friction should pull it back toward the anchor
    p.y += 0.02;
    solveTranslationalFriction(rod, c, dt);
    expect(Math.abs(p.y - anchorY)).toBeLessThan(0.02); // held near the anchor (resisted)
    expect(Math.hypot(c.lambdaT.x, c.lambdaT.y)).toBeLessThanOrEqual(c.muStatic * c.lambdaN + 1e-9);
  });

  it("SLIP: a tangential drag beyond the static cone slides the anchor with the node", () => {
    const dt = 1 / 120;
    const { rod, c, p } = pressed(0.05, 0.02, 0.01); // tiny cone (μ_s·λ_n = 5e-4)
    solveTranslationalFriction(rod, c, dt); // anchor at 0
    // drag a large tangential distance; the cone is tiny so it must slip and the anchor follows
    for (let i = 0; i < 10; i++) {
      p.y += 0.1;
      solveTranslationalFriction(rod, c, dt);
    }
    // the multiplier is clamped to the kinetic cone (slip), not growing unbounded
    expect(Math.hypot(c.lambdaT.x, c.lambdaT.y)).toBeLessThanOrEqual(c.muKinetic * c.lambdaN + 1e-9);
    // the anchor slid forward with the node (kinetic sliding) rather than staying at 0
    expect(c.anchor.y).toBeGreaterThan(0.5);
  });

  it("releases the anchor when the node separates (λ_n ≤ 0)", () => {
    const dt = 1 / 120;
    const { rod, c } = pressed(0.5, 0.4, 5.0);
    solveTranslationalFriction(rod, c, dt);
    expect(c.hasAnchor).toBe(true);
    c.lambdaN = 0; // separated
    solveTranslationalFriction(rod, c, dt);
    expect(c.hasAnchor).toBe(false);
    expect(c.lambdaT.x).toBe(0);
    expect(c.lambdaT.y).toBe(0);
  });
});

describe("spin friction (torque storage + release)", () => {
  // A frame in firm wall contact; we steadily roll it about its director (the spin DOF) and
  // watch spin friction HOLD the roll (wind-up, λ_roll grows under the cone) then RELEASE
  // (slip once the cone is exceeded). normal = +x, director = body-z (+z for identity).
  function setup(muRoll: number, lambdaN: number) {
    const q = new Quaternion();
    const w = [1];
    const wq = [1];
    const rod: NodeContactTarget = {
      x: [new Vector3()],
      prev: [new Vector3()],
      q: [q],
      w,
      wq,
      rodRadius: 0.05,
      invMassAt: (node) => w[node] ?? 0,
      invInertiaAt: (node) => wq[node] ?? 0
    };
    const c = makeWallContact("r", 0, 0, 0.1, 0.05, muRoll, 1e-9, 1e-8, 1e-9);
    c.normal.set(1, 0, 0);
    c.vesselTangent.set(0, 0, 1);
    c.lambdaN = lambdaN;
    c.hasAnchor = true; // co-located with a translational contact already anchored
    return { rod, c, q };
  }
  // angle of the frame's body-x mark in the wall cross-section plane (here the x-y plane)
  function frameRoll(q: Quaternion): number {
    const x = new Vector3(1, 0, 0).applyQuaternion(q);
    return Math.atan2(x.y, x.x);
  }
  function rollBy(q: Quaternion, d: number): void {
    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), d)).normalize();
  }

  it("WINDS UP then RELEASES: holds the frame while λ_roll < cone, slips once it is exceeded", () => {
    const dt = 1 / 120;
    const cone = 5.0; // μ_roll·λ_n = 1.0·5.0
    const { rod, c, q } = setup(1.0, 5.0);
    solveSpinFriction(rod, c, dt); // set the roll anchor at 0

    let stuckSteps = 0;
    let releasedAngle = 0;
    let released = false;
    for (let k = 0; k < 12; k++) {
      rollBy(q, 0.05); // command a steady hub roll about the director
      solveSpinFriction(rod, c, dt);
      const ang = frameRoll(q);
      if (!released) {
        if (Math.abs(c.lambdaRoll) < cone - 1e-6 && Math.abs(ang) < 0.02) {
          stuckSteps++; // still held near the anchor → torque winding up
        } else if (Math.abs(c.lambdaRoll) >= cone - 1e-6) {
          released = true;
          releasedAngle = ang;
        }
      }
    }
    // wound up for several steps (the frame was HELD while λ_roll climbed to the cone)
    expect(stuckSteps).toBeGreaterThanOrEqual(3);
    // then released and the frame began to rotate (lagged-then-jumped)
    expect(released).toBe(true);
    // after release the frame follows the command (cone-limited multiplier)
    rollBy(q, 0.05);
    solveSpinFriction(rod, c, dt);
    expect(Math.abs(c.lambdaRoll)).toBeLessThanOrEqual(cone + 1e-6);
    expect(frameRoll(q)).toBeGreaterThan(releasedAngle - 1e-6);
  });

  it("does nothing when spin friction is off (μ_roll = 0): the frame rolls freely", () => {
    const dt = 1 / 120;
    const { rod, c, q } = setup(0, 5.0);
    solveSpinFriction(rod, c, dt);
    for (let k = 0; k < 6; k++) {
      rollBy(q, 0.1);
      solveSpinFriction(rod, c, dt);
    }
    // no resistance: the frame is at the full commanded roll, λ_roll never built (±0)
    expect(Math.abs(c.lambdaRoll)).toBe(0);
    expect(frameRoll(q)).toBeCloseTo(0.6, 2);
  });
});
