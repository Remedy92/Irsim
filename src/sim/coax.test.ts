import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import type { NodeContactTarget } from "./contact";
import {
  closestOuterSegment,
  makeCoaxContact,
  portalWeight,
  solveCoaxialCentering,
  solveCoaxialFriction,
  solveCoaxialNormalContact,
  type CoaxClosest
} from "./coax";

/**
 * STAGE 5 — COAXIAL (inner-in-outer) CONTACT, isolated constraint math (design doc §6).
 *
 * These are the rigorous, deterministic mechanism proofs for the pure coax.ts solvers, operating
 * on minimal NodeContactTarget mocks so the constraint behavior is decoupled from the rod dynamics:
 *   - the inner-in-outer NORMAL inequality pushes the inner back inside the outer channel and
 *     distributes the reaction to the outer endpoints (bilateral support), with the open-portal
 *     blend ramping the containment off past the outer tip;
 *   - coax friction is stick-slip with NO axial distance tie (the inner slides freely);
 *   - the soft centering pulls the inner toward the outer axis.
 * Units are centimetres; α̃ = α/Δt_s² (time SI).
 */

/** A minimal mock rod (positions + uniform inverse mass) implementing NodeContactTarget. */
function mockRod(points: Vector3[], w = 1): NodeContactTarget {
  const q: Quaternion[] = [];
  for (let i = 0; i < Math.max(0, points.length - 1); i++) q.push(new Quaternion());
  return {
    x: points,
    prev: points.map((p) => p.clone()),
    q,
    w: points.map(() => w),
    wq: q.map(() => 1),
    rodRadius: 0.05
  };
}

const DT = 1 / 240; // a representative substep Δt_s

describe("coax — open portal blend", () => {
  it("portalWeight is 1 inside, 0 fully past the tip, and ramps linearly across the portal", () => {
    expect(portalWeight(-1, 0.4)).toBe(1); // inside the outer
    expect(portalWeight(0, 0.4)).toBe(1); // exactly at the tip
    expect(portalWeight(0.4, 0.4)).toBe(0); // fully exited
    expect(portalWeight(1.0, 0.4)).toBe(0); // well past
    expect(portalWeight(0.2, 0.4)).toBeCloseTo(0.5, 6); // halfway through the portal
  });
});

describe("coax — closest outer segment pairing", () => {
  it("pairs an inner node to the nearest outer segment and reports its perpendicular offset", () => {
    // outer along +y at x=0; inner node offset +x by 0.3 at mid-height
    const outer = mockRod([new Vector3(0, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 2, 0)]);
    const out: CoaxClosest = { segment: -1, u: 0, rho: 0, pastTip: -1 };
    const ok = closestOuterSegment(new Vector3(0.3, 0.5, 0), outer, out);
    expect(ok).toBe(true);
    expect(out.segment).toBe(0); // first segment owns mid-height of [0,1]
    expect(out.rho).toBeCloseTo(0.3, 6); // perpendicular distance to the axis
    expect(out.pastTip).toBeLessThanOrEqual(0); // not past the outer tip
  });

  it("flags an inner node beyond the outer tip (open portal)", () => {
    const outer = mockRod([new Vector3(0, 0, 0), new Vector3(0, 1, 0)]);
    const out: CoaxClosest = { segment: -1, u: 0, rho: 0, pastTip: -1 };
    closestOuterSegment(new Vector3(0.0, 1.5, 0), outer, out); // 0.5 cm past the tip
    expect(out.pastTip).toBeCloseTo(0.5, 6);
  });
});

describe("coax — inner-in-outer normal containment (bilateral)", () => {
  it("pushes the inner back inside the outer channel and supports the outer (3-body)", () => {
    // outer straight along +y; inner node poking out to +x beyond the channel
    const outer = mockRod([new Vector3(0, 0, 0), new Vector3(0, 1, 0)]);
    const inner = mockRod([new Vector3(0.2, 0.5, 0)]); // 0.2 cm off axis
    const allowed = 0.1; // R_outer,lumen − r_inner = 0.1 cm clearance
    const c = makeCoaxContact(0, 0, 0.04, 0.02, 0, 1e-9, 1e-9, 1e-9);
    c.allowedRadius = allowed;
    const innerBefore = inner.x[0].x;
    const outerMidBefore = 0.5 * (outer.x[0].x + outer.x[1].x);
    // a stiff (small α) containment so it nearly closes the violation in one solve
    solveCoaxialNormalContact(inner, outer, c, allowed, 1, DT);
    // the inner moved INWARD (−x), toward the channel wall
    expect(inner.x[0].x).toBeLessThan(innerBefore);
    // a nonzero normal multiplier was stored (the support load)
    expect(c.lambdaN).toBeGreaterThan(0);
    // and the outer endpoints moved OUTWARD (+x) — the bilateral support reaction
    const outerMidAfter = 0.5 * (outer.x[0].x + outer.x[1].x);
    expect(outerMidAfter).toBeGreaterThan(outerMidBefore);
  });

  it("does nothing when the inner sits comfortably inside the channel (true inequality)", () => {
    const outer = mockRod([new Vector3(0, 0, 0), new Vector3(0, 1, 0)]);
    const inner = mockRod([new Vector3(0.02, 0.5, 0)]); // well within 0.1 clearance
    const c = makeCoaxContact(0, 0, 0.04, 0.02, 0, 1e-9, 1e-9, 1e-9);
    const before = inner.x[0].x;
    solveCoaxialNormalContact(inner, outer, c, 0.1, 1, DT);
    expect(inner.x[0].x).toBeCloseTo(before, 12); // unchanged
    expect(c.lambdaN).toBe(0);
  });

  it("OPEN PORTAL: containment ramps to zero as the inner exits past the outer tip", () => {
    const outer = mockRod([new Vector3(0, 0, 0), new Vector3(0, 1, 0)]);
    const inner = mockRod([new Vector3(0.2, 0.5, 0)]); // same violation as the support test
    const c = makeCoaxContact(0, 0, 0.04, 0.02, 0, 1e-9, 1e-9, 1e-9);
    const before = inner.x[0].x;
    // portal = 0 ⇒ fully exited the open portal ⇒ NO containment (the inner is free to express)
    solveCoaxialNormalContact(inner, outer, c, 0.1, 0, DT);
    expect(inner.x[0].x).toBeCloseTo(before, 12);
    expect(c.lambdaN).toBe(0);
  });
});

describe("coax — friction (stick-slip, NO axial tie)", () => {
  it("STICK: a tiny tangential drift inside the cone is resisted (anchor held)", () => {
    const outer = mockRod([new Vector3(0, 0, 0), new Vector3(0, 1, 0)]);
    const inner = mockRod([new Vector3(0.12, 0.5, 0)]); // just past the 0.1 channel wall ⇒ a load
    const c = makeCoaxContact(0, 0, 0.5, 0.25, 0, 1e-9, 1e-9, 1e-9);
    c.allowedRadius = 0.1;
    // build up a normal load + set the contact geometry (normal/tangent)
    solveCoaxialNormalContact(inner, outer, c, 0.1, 1, DT);
    expect(c.lambdaN).toBeGreaterThan(0);
    // first friction call drops the anchor (no correction yet)
    solveCoaxialFriction(inner, c, DT);
    expect(c.hasAnchor).toBe(true);
    // nudge the inner a tiny amount ALONG the outer tangent (axial), then re-solve friction
    inner.x[0].y += 0.0005; // sub-cone axial drift
    const yBefore = inner.x[0].y;
    solveCoaxialFriction(inner, c, DT);
    // inside the static cone ⇒ the drift is resisted (the node is pulled back toward the anchor)
    expect(inner.x[0].y).toBeLessThan(yBefore);
    expect(Math.hypot(c.lambdaT.x, c.lambdaT.y)).toBeLessThanOrEqual(c.muStatic * c.lambdaN + 1e-9);
  });

  it("SLIP / NO AXIAL TIE: a large axial pull slides the inner freely (no rigid lock)", () => {
    const outer = mockRod([new Vector3(0, 0, 0), new Vector3(0, 1, 0)]);
    const inner = mockRod([new Vector3(0.12, 0.5, 0)]); // just past the channel wall ⇒ a load
    // very low μ_io (lubricated) so the kinetic cone is tiny
    const c = makeCoaxContact(0, 0, 0.04, 0.02, 0, 1e-9, 1e-9, 1e-9);
    c.allowedRadius = 0.1;
    solveCoaxialNormalContact(inner, outer, c, 0.1, 1, DT);
    solveCoaxialFriction(inner, c, DT); // drop the anchor
    // push the inner a LARGE axial distance (operator advancing the wire)
    inner.x[0].y += 1.0;
    const yPushed = inner.x[0].y;
    solveCoaxialFriction(inner, c, DT);
    // the inner barely moves back: the friction cone (μ_io·λ_n) is tiny, so it SLIDES freely.
    // The clawback must be a small fraction of the 1.0 cm push (NO axial distance constraint).
    expect(yPushed - inner.x[0].y).toBeLessThan(0.05);
    // and the multiplier is clamped to the kinetic cone (slip), not unbounded
    expect(Math.hypot(c.lambdaT.x, c.lambdaT.y)).toBeLessThanOrEqual(c.muKinetic * c.lambdaN + 1e-9);
  });

  it("drops the anchor + tangential load when the contact separates (λ_n ≤ 0)", () => {
    const inner = mockRod([new Vector3(0.1, 0.5, 0)]); // friction acts on the inner only
    const c = makeCoaxContact(0, 0, 0.5, 0.25, 0, 1e-9, 1e-9, 1e-9);
    c.hasAnchor = true;
    c.lambdaT.x = 0.01;
    c.lambdaN = 0; // separated
    solveCoaxialFriction(inner, c, DT);
    expect(c.hasAnchor).toBe(false);
    expect(c.lambdaT.x).toBe(0);
    expect(c.lambdaT.y).toBe(0);
  });
});

describe("coax — soft lateral centering", () => {
  it("pulls the inner toward the outer centerline (bilateral, momentum-neutral)", () => {
    const outer = mockRod([new Vector3(0, 0, 0), new Vector3(0, 1, 0)]);
    const inner = mockRod([new Vector3(0.3, 0.5, 0)]);
    const c = makeCoaxContact(0, 0, 0.04, 0.02, 0, 1e-9, 1e-9, 1e-9);
    const innerBefore = inner.x[0].x;
    const outerMidBefore = 0.5 * (outer.x[0].x + outer.x[1].x);
    solveCoaxialCentering(inner, outer, c, 0.5, 1, DT);
    // inner pulled toward the axis (−x); outer pulled the opposite way (the bilateral share)
    expect(inner.x[0].x).toBeLessThan(innerBefore);
    expect(0.5 * (outer.x[0].x + outer.x[1].x)).toBeGreaterThan(outerMidBefore);
  });

  it("is disabled by gain 0 or portal 0", () => {
    const outer = mockRod([new Vector3(0, 0, 0), new Vector3(0, 1, 0)]);
    const inner = mockRod([new Vector3(0.3, 0.5, 0)]);
    const c = makeCoaxContact(0, 0, 0.04, 0.02, 0, 1e-9, 1e-9, 1e-9);
    const before = inner.x[0].x;
    solveCoaxialCentering(inner, outer, c, 0, 1, DT);
    expect(inner.x[0].x).toBe(before);
    solveCoaxialCentering(inner, outer, c, 0.5, 0, DT);
    expect(inner.x[0].x).toBe(before);
  });
});
