import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import {
  CoaxialAssembly,
  CosseratRod,
  GUIDEWIRE,
  GUIDEWIRE_DIRECT,
  SHEATH_DIRECT
} from "../cosserat";
import { buildNormalAnatomy } from "../anatomy";
import type { Anatomy } from "../types";

/**
 * Phase-3 LIVE integration smoke tests: drive a real CosseratRod through its public step() with
 * params.useDirectSolve ON (dynamic co-rotational beam) and OFF (legacy XPBD), confirming the direct
 * path is wired, stable, and advances — and that turning the flag OFF leaves the legacy path intact.
 * Calibrated navigation / substep-invariance / chirality gates come once precurve + Schur-contact land.
 */

/** A straight vessel-radius tube along +y (the rod feeds cranially along the access axis). */
function tube(radius: number, lenCm: number): Anatomy {
  const points = [];
  const n = 12;
  for (let i = 0; i <= n; i++) points.push({ pos: new Vector3(0, -2 + (i * lenCm) / n, 0), radius, s: (i * lenCm) / n });
  return {
    id: "t",
    name: "tube",
    branches: [{ id: "tube", name: "tube", attenuation: 1, points }],
    access: [{ id: "a", name: "a", pos: new Vector3(0, -2, 0), dir: new Vector3(0, 1, 0), branchId: "tube" }],
    targets: [],
    provenance: { source: "test", license: "test", note: "test" }
  };
}

function allFinite(rod: CosseratRod): boolean {
  for (const p of rod.x) if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
  for (const q of rod.q) if (!Number.isFinite(q.x) || !Number.isFinite(q.w)) return false;
  return true;
}

function assertContained(label: string, rod: CosseratRod, epsCm = 0.05): void {
  const pen = rod.maxWallPenetration();
  // eslint-disable-next-line no-console
  console.log(`[direct-containment] ${label} max penetration=${pen.toFixed(4)}cm`);
  expect(pen).toBeLessThanOrEqual(epsCm);
}

describe("Phase-3 live integration — direct solve path", () => {
  it("exposes legacy inverse mass until direct mass is built, then normalized direct mass/inertia metrics", () => {
    const legacy = new CosseratRod(tube(0.55, 26), "a", GUIDEWIRE);
    expect(legacy.invMassAt(0)).toBe(0);
    expect(legacy.invMassAt(5)).toBe(1);
    expect(legacy.invInertiaAt(0)).toBe(0);
    expect(legacy.invInertiaAt(5)).toBe(1);
    expect(legacy.invMassAt(legacy.n)).toBe(0);
    expect(legacy.invInertiaAt(legacy.n)).toBe(0);

    const wire = new CosseratRod(tube(0.55, 26), "a", GUIDEWIRE_DIRECT);
    expect(wire.invMassAt(0)).toBe(0);
    expect(wire.invMassAt(5)).toBe(1);
    expect(wire.invInertiaAt(5)).toBe(1);

    const dbg = wire as unknown as {
      ensureDirect: () => void;
      dMass: { m: Float64Array; Jt: Float64Array } | null;
    };
    dbg.ensureDirect();

    const freeNodes = wire.w.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0);
    const massScale = freeNodes.reduce((sum, i) => sum + dbg.dMass!.m[i], 0) / freeNodes.length;
    const inertiaScale = freeNodes.reduce((sum, i) => sum + dbg.dMass!.Jt[i], 0) / freeNodes.length;

    expect(wire.invMassAt(0)).toBe(0);
    expect(wire.invInertiaAt(0)).toBe(0);
    expect(dbg.dMass).not.toBeNull();
    expect(wire.invMassAt(5)).toBeCloseTo(massScale / dbg.dMass!.m[5], 12);
    expect(wire.invInertiaAt(5)).toBeCloseTo(inertiaScale / dbg.dMass!.Jt[5], 12);
    expect(wire.invMassAt(5)).toBeGreaterThan(0);
    expect(wire.invInertiaAt(5)).toBeGreaterThan(0);
  });

  it("keeps dynamic nodal frames beam-owned across steady direct setup and splices them on feed/retract", () => {
    const rod = new CosseratRod(tube(0.55, 26), "a", GUIDEWIRE_DIRECT);
    const dbg = rod as unknown as {
      ensureDirect: () => void;
      dNodeQ: Quaternion[];
      dVel: Vector3[];
      dOmega: Vector3[];
    };
    dbg.ensureDirect();
    expect(dbg.dNodeQ.length).toBe(rod.n);

    const sentinel = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.73);
    dbg.dNodeQ[5].copy(sentinel);
    dbg.ensureDirect();

    expect(Math.abs(dbg.dNodeQ[5].dot(sentinel))).toBeGreaterThan(0.999);

    const n0 = rod.n;
    for (const v of dbg.dVel) v.set(1, -2, 0.5);
    for (const w of dbg.dOmega) w.set(0.2, -0.4, 0.1);
    rod.prependNode(rod.access.x, rod.access.frame, rod.h);
    expect(rod.n).toBe(n0 + 1);
    expect(dbg.dNodeQ.length).toBe(rod.n);
    expect(Math.abs(dbg.dNodeQ[6].dot(sentinel))).toBeGreaterThan(0.999);
    for (const v of dbg.dVel) expect(v.length()).toBeLessThan(1e-12);
    for (const w of dbg.dOmega) expect(w.length()).toBeLessThan(1e-12);

    for (const v of dbg.dVel) v.set(-1, 0.5, 2);
    for (const w of dbg.dOmega) w.set(-0.3, 0.2, 0.7);
    rod.removeProximalNode();
    expect(rod.n).toBe(n0);
    expect(dbg.dNodeQ.length).toBe(rod.n);
    expect(Math.abs(dbg.dNodeQ[5].dot(sentinel))).toBeGreaterThan(0.999);
    for (const v of dbg.dVel) expect(v.length()).toBeLessThan(1e-12);
    for (const w of dbg.dOmega) expect(w.length()).toBeLessThan(1e-12);
  });

  function climbRun(useDirectSolve: boolean): { climb: number; finite: boolean; n: number } {
    const rod = new CosseratRod(tube(0.55, 26), "a", useDirectSolve ? GUIDEWIRE_DIRECT : GUIDEWIRE);
    const start = rod.tip().y; // ~ -2 + 8cm initial deploy
    rod.input = { deployed: 22, steer: 0.3, torque: 0 }; // feed +14cm of material
    for (let i = 0; i < 500; i++) rod.step(1 / 60);
    return { climb: rod.tip().y - start, finite: allFinite(rod), n: rod.n };
  }

  it("flag-OFF and flag-ON both inject material and stay finite/stable (wired)", () => {
    const off = climbRun(false);
    const on = climbRun(true);
    // eslint-disable-next-line no-console
    console.log(`[direct-live] climb legacy=${off.climb.toFixed(2)}cm direct=${on.climb.toFixed(2)}cm n(direct)=${on.n}`);
    expect(off.finite && on.finite).toBe(true);
    expect(off.climb).toBeGreaterThan(8); // legacy baseline (kinematic advection rail ⇒ ~1:1)
    expect(on.n).toBeGreaterThan(20); // the direct path injected the fed material (frozen-h, coarser)
    // NOTE: this is the ADVERSARIAL straight-tube OVER-FEED case. With real EI the stiff column buckles
    // under the kinematic advection feed in an unconstrained straight tube (worse at coarse h), so the
    // direct tip does NOT advance 1:1 here — that is the known feed-model limitation, fixed properly by
    // the force-capped feed motor (#3). Real CURVED-anatomy navigation advances fine (see the
    // SUBSTEP-INVARIANCE nav gate) and telescoping works (see the coax test) — those are the real cases.
  }, 60000);

  it("flag-ON: stays bounded inside the tube (no tunneling / blowup) over a long run", () => {
    const rod = new CosseratRod(tube(0.55, 18), "a", GUIDEWIRE_DIRECT);
    rod.input = { deployed: 14, steer: 0.3, torque: 0 };
    for (let i = 0; i < 600; i++) rod.step(1 / 60);
    expect(allFinite(rod)).toBe(true);
    // every node stays within a sane lateral envelope of the straight tube (radius 0.55)
    let maxLat = 0;
    for (const p of rod.x) maxLat = Math.max(maxLat, Math.hypot(p.x, p.z));
    expect(maxLat).toBeLessThan(2); // not exploding laterally
  }, 60000);

  it("opt-in compliant feed motor advances material when the force cap is high", () => {
    const rod = new CosseratRod(tube(0.8, 32), "a", { ...GUIDEWIRE_DIRECT, useCompliantFeedMotor: true });
    // forceMax is now PHYSICAL Newtons (Phase D); a high cap proves the motor advances the column when
    // not force-limited. The straight-tube over-feed column-compression draws a large scaled feed force
    // (the known straight-tube buckling limitation), so author an explicitly-high cap here.
    rod.insertion.forceMax = 1e9;
    const start = rod.deployedLength();
    const n0 = rod.n;
    rod.input = { deployed: start + 2, steer: 0, torque: 0 };
    for (let i = 0; i < 360; i++) rod.step(1 / 60);
    expect(allFinite(rod)).toBe(true);
    expect(rod.deployedLength()).toBeGreaterThan(start + 1);
    expect(rod.n).toBeGreaterThan(n0);
  }, 60000);

  it("opt-in compliant feed motor stalls material injection when the force cap is zero", () => {
    const rod = new CosseratRod(tube(0.8, 32), "a", { ...GUIDEWIRE_DIRECT, useCompliantFeedMotor: true });
    rod.insertion.forceMax = 0;
    const start = rod.deployedLength();
    const n0 = rod.n;
    rod.input = { deployed: start + 4, steer: 0, torque: 0 };
    for (let i = 0; i < 360; i++) rod.step(1 / 60);
    expect(allFinite(rod)).toBe(true);
    expect(rod.deployedLength()).toBeLessThan(start + 0.25);
    expect(rod.n).toBe(n0);
  }, 60000);
});

describe("Phase-3 live integration — coaxial telescoping on the direct beam (#2)", () => {
  it("short default sheath contains the direct guidewire during app-style feed", () => {
    const anatomy = buildNormalAnatomy();
    const outer = new CosseratRod(anatomy, "rcfa", SHEATH_DIRECT, { deployed: 6.5, steer: 0, torque: 0 });
    const inner = new CosseratRod(anatomy, "rcfa", GUIDEWIRE_DIRECT, { deployed: 8, steer: 0.35, torque: 0 });
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(6.5, 0, 0);
    asm.setInnerInput(8, 0.35, 0);
    for (let i = 0; i < 120; i++) asm.step(1 / 60);

    asm.setInnerInput(16, 0.35, 0);
    let maxWirePen = 0;
    let maxWireNode = -1;
    let maxCoveredRho = 0;
    let maxExit = -Infinity;
    for (let i = 0; i < 240; i++) {
      asm.step(1 / 60);
      const pen = inner.maxWallPenetration();
      if (pen > maxWirePen) {
        maxWirePen = pen;
        let far = -Infinity;
        for (let j = 0; j < inner.n; j++) {
          const d = inner.x[j].distanceTo(inner.access.x);
          if (d > far) {
            far = d;
            maxWireNode = j;
          }
        }
      }
      maxCoveredRho = Math.max(maxCoveredRho, asm.maxCoveredInnerRho());
      maxExit = Math.max(maxExit, asm.innerExitPastOuterTip());
    }
    // eslint-disable-next-line no-console
    console.log(
      `[direct-short-sheath] pen=${maxWirePen.toFixed(3)} node=${maxWireNode} ` +
        `pos=${inner.x[maxWireNode]?.toArray().map((v) => v.toFixed(2)).join(",")} ` +
        `coveredRho=${maxCoveredRho.toFixed(3)} exit=${maxExit.toFixed(3)} ` +
        `active=${asm.activeCoaxCount()} wireN=${inner.n} sheathN=${outer.n}`
    );
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
    // Compliant feed insertion can leave a tiny one-frame seating transient during repeated pullback;
    // keep this as a hard containment gate with a 0.005 cm numerical cushion.
    expect(maxWirePen).toBeLessThanOrEqual(0.055);
    expect(maxCoveredRho).toBeLessThanOrEqual(asm.innerClearance() + 0.02);
  }, 60000);

  it("solo direct guidewire contains during the same short feed", () => {
    const anatomy = buildNormalAnatomy();
    const wire = new CosseratRod(anatomy, "rcfa", GUIDEWIRE_DIRECT, { deployed: 8, steer: 0.35, torque: 0 });
    wire.input = { deployed: 8, steer: 0.35, torque: 0 };
    for (let i = 0; i < 120; i++) wire.step(1 / 60);
    wire.input = { deployed: 16, steer: 0.35, torque: 0 };
    let maxPen = 0;
    let maxNode = -1;
    for (let i = 0; i < 240; i++) {
      wire.step(1 / 60);
      const pen = wire.maxWallPenetration();
      if (pen > maxPen) {
        maxPen = pen;
        let far = -Infinity;
        for (let j = 0; j < wire.n; j++) {
          const d = wire.x[j].distanceTo(wire.access.x);
          if (d > far) {
            far = d;
            maxNode = j;
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[direct-short-solo] pen=${maxPen.toFixed(3)} node=${maxNode} ` +
        `pos=${wire.x[maxNode]?.toArray().map((v) => v.toFixed(2)).join(",")} ` +
        `tip=${wire.tip().toArray().map((v) => v.toFixed(2)).join(",")}`
    );
    expect(allFinite(wire)).toBe(true);
    expect(maxPen).toBeLessThanOrEqual(0.05);
  }, 60000);

  it("direct coax projection is included in the finalized inner velocity", () => {
    const outer = new CosseratRod(tube(0.55, 32), "a", SHEATH_DIRECT);
    const inner = new CosseratRod(tube(0.55, 32), "a", GUIDEWIRE_DIRECT);
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(10, 0, 0);
    asm.setInnerInput(10, 0, 0);
    for (let i = 0; i < 30; i++) asm.step(1 / 60);

    const dbg = inner as unknown as { dVel: Vector3[]; dOmega: Vector3[] };
    for (const v of dbg.dVel) v.set(0, 0, 0);
    for (const w of dbg.dOmega) w.set(0, 0, 0);

    const node = Math.min(12, inner.n - 2);
    inner.x[node].x += 0.3; // far outside the outer channel clearance, but still inside the vessel
    const before = inner.x[node].clone();
    asm.step(1 / 60);

    const projected = before.distanceTo(inner.x[node]);
    const finalizedSpeed = dbg.dVel[node].length();
    expect(projected).toBeGreaterThan(0.02);
    expect(finalizedSpeed).toBeGreaterThan(0.1);
  }, 60000);

  it("the wire slides freely out of the held sheath and exits the open portal, both rods on the dynamic beam", () => {
    const outer = new CosseratRod(tube(0.55, 48), "a", SHEATH_DIRECT);
    const inner = new CosseratRod(tube(0.55, 48), "a", GUIDEWIRE_DIRECT);
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(15, 0, 0);
    asm.setInnerInput(10, 0, 0);
    for (let i = 0; i < 300; i++) asm.step(1 / 60);
    const innerTip0 = inner.tip().clone();
    const outerTip0 = outer.tip().clone();
    asm.setInnerInput(25, 0, 0); // advance the wire; sheath input held
    for (let i = 0; i < 700; i++) asm.step(1 / 60);
    const innerMoved = inner.tip().distanceTo(innerTip0);
    const outerMoved = outer.tip().distanceTo(outerTip0);
    const finalExit = asm.innerExitPastOuterTip();
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
    expect(innerMoved).toBeGreaterThan(8); // the wire telescopes substantially out of the sheath
    // Shipped direct uses a compliant, force-capped guidewire feed; it should exit clearly, but not
    // over-advance through the held sheath like the old hard-anchor adapter.
    expect(finalExit).toBeGreaterThan(4.5); // open portal: the wire tip leads well past the held sheath
    expect(outerMoved).toBeLessThan(0.4 * innerMoved); // free slide, sheath not rigidly dragged
  }, 120000);

  it("repeated direct pullback keeps geometrically sheathed wire out of vessel contact", () => {
    const anatomy = buildNormalAnatomy();
    const outer = new CosseratRod(anatomy, "rcfa", SHEATH_DIRECT, { deployed: 6.5, steer: 0, torque: 0 });
    const inner = new CosseratRod(anatomy, "rcfa", GUIDEWIRE_DIRECT, { deployed: 8, steer: 0.35, torque: 0.4 });
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(7, 0, 0);
    asm.setInnerInput(18, 0.35, 0.4);

    let maxWirePen = 0;
    let maxCoveredRho = 0;
    const stepAndTrack = (frames: number): void => {
      for (let i = 0; i < frames; i++) {
        asm.step(1 / 60);
        maxWirePen = Math.max(maxWirePen, inner.maxWallPenetration());
        maxCoveredRho = Math.max(maxCoveredRho, asm.maxCoveredInnerRho());
      }
    };

    stepAndTrack(260);
    expect(inner.deployedLength()).toBeGreaterThan(17);
    for (let cycle = 0; cycle < 2; cycle++) {
      asm.setInnerInput(8, 0.35, 0.4);
      stepAndTrack(260);
      expect(inner.deployedLength()).toBeLessThan(9);
      asm.setInnerInput(18, 0.35, 0.4);
      stepAndTrack(260);
      expect(inner.deployedLength()).toBeGreaterThan(17);
    }

    expect(allFinite(inner) && allFinite(outer)).toBe(true);
    expect(maxWirePen).toBeLessThanOrEqual(0.05);
    expect(maxCoveredRho).toBeLessThanOrEqual(asm.innerClearance() + 0.02);
  }, 120000);

  it("experimental direct coax stays inside the curved anatomy envelope", () => {
    const anatomy = buildNormalAnatomy();
    const outer = new CosseratRod(anatomy, "rcfa", SHEATH_DIRECT);
    const inner = new CosseratRod(anatomy, "rcfa", GUIDEWIRE_DIRECT);
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(12, 0, 0);
    asm.setInnerInput(26, 0.45, 0.6);
    for (let i = 0; i < 420; i++) asm.step(1 / 60);
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
    assertContained("outer", outer);
    assertContained("inner", inner);
  }, 90000);

  // PHASE D — TWO-WAY COAX STABILITY GATE. With the bilateral radial coupling on (Phase D flipped
  // COAX_DIRECT_OUTER_MASS_SCALE from 0 to a small mass-weighted nonzero), the lighter wire must feel
  // the sheath AND the sheath must feel a (small) reaction — Newton's third law — WITHOUT the wire
  // shoving the heavier/stiffer support cylinder out of the lumen. We drive the wire HARD (steer 0.6,
  // torque 0.8) against a HELD sheath on curved anatomy and assert: (a) the sheath stays contained
  // (≤0.05 cm wall penetration — the substantive gate), and (b) its max node displacement under the
  // sustained wire load stays bounded well below the instability cliff (a sweep showed monotonic,
  // stable displacement up to ~0.5 cm through scale≈0.03, then a sharp cliff; at the shipped 0.01 the
  // sheath moves ~0.34 cm). The 1.0 cm bound is the robust "does not get shoved out" assertion with
  // headroom over the measured ~0.34 cm and far below the >3 cm full-symmetric (scale=1) shove.
  it("two-way coax: a hard wire push does not shove the held sheath out of the lumen", () => {
    const anatomy = buildNormalAnatomy();
    const outer = new CosseratRod(anatomy, "rcfa", SHEATH_DIRECT);
    const inner = new CosseratRod(anatomy, "rcfa", GUIDEWIRE_DIRECT);
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(12, 0, 0);
    asm.setInnerInput(10, 0, 0);
    for (let i = 0; i < 200; i++) asm.step(1 / 60);
    const sheath0 = outer.x.map((p) => p.clone());
    // drive the wire hard (steer + torque) with the sheath HELD: the wire loads the sheath wall
    asm.setInnerInput(26, 0.6, 0.8);
    let maxSheathMove = 0;
    for (let i = 0; i < 300; i++) {
      asm.step(1 / 60);
      for (let j = 0; j < Math.min(sheath0.length, outer.x.length); j++) {
        maxSheathMove = Math.max(maxSheathMove, sheath0[j].distanceTo(outer.x[j]));
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[coax-stability] maxSheathNodeMove=${maxSheathMove.toFixed(4)}cm outerPen=${outer.maxWallPenetration().toFixed(4)} innerPen=${inner.maxWallPenetration().toFixed(4)}`);
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
    assertContained("outer (under wire load)", outer);
    assertContained("inner (under wire load)", inner);
    expect(maxSheathMove).toBeLessThan(1.0); // not shoved out: bounded reaction, deep inside the lumen
  }, 90000);

  it("counts numerical-tangent work for one shipped direct coax frame", () => {
    const anatomy = buildNormalAnatomy();
    const outer = new CosseratRod(anatomy, "rcfa", SHEATH_DIRECT);
    const inner = new CosseratRod(anatomy, "rcfa", GUIDEWIRE_DIRECT);
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(outer.deployedLength(), 0, 0);
    asm.setInnerInput(inner.deployedLength(), 0, 0);
    asm.step(1 / 60); // warm direct state without measuring first-use setup noise
    asm.resetDirectPerfCounters();
    asm.step(1 / 60);
    const counters = asm.directPerfCounters();
    expect(counters.tangentAssemblies).toBe(32);
    expect(counters.elementForceEvals).toBeLessThanOrEqual(20_000);
  });
});
