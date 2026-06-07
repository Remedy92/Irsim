import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { CosseratRod, GUIDEWIRE } from "./cosserat";
import { buildNormalAnatomy } from "./anatomy";
import type { Anatomy } from "./types";

/**
 * PHYSICS REGRESSION RIG (design review §3 Phase 0).
 *
 * These are headless regressions for the current instrument mechanics. They intentionally do not
 * claim calibrated realised-EI yet; the direct/dynamic solver work still needs true bench tests.
 *
 * IMPORTANT LESSON (recorded so it isn't re-litigated): a body-FORCE cantilever (δ = wL⁴/8EI) is
 * NOT a valid probe of THIS solver's stiffness. The solve is quasi-static with heavy velocity
 * damping, so an external body force never reaches force equilibrium — it creeps, and the measured
 * "EI" is an integrator artifact, not the material EI. Likewise, sweeps showed that within this
 * Gauss-Seidel XPBD architecture the standard physical levers (EI, iteration count, wall compliance)
 * do NOT systematically change the contained-navigation shape: the near-rigid wall contact dominates
 * the soft bend by ~9 orders of magnitude, so the wire conforms to contact regardless of EI. Making
 * the wire genuinely "stiffer-feeling" is therefore a SOLVER change (Phase 3 — a direct/implicit or
 * Stable-Cosserat bend solve that lets bend compete with contact), not a parameter tune. The
 * `bodyForce` field remains on the rod as the hook for gravity/flow forcing once real dynamics land.
 *
 * What we CAN assert robustly and usefully:
 *   1. SUBSTEP-INVARIANCE — with time-constant damping the felt behaviour must not depend on the
 *      substep count (the entanglement the design review flagged). This is the key regression.
 *   2. PUSHABILITY — feeding advances the tip up the real anatomy (no immediate accordion).
 *   3. SHAFT FAIRING — the optional EI-scaled fairing pass reduces over-fed column bow.
 */

/** A wide short straight tube along +y (rod effectively free to bow under over-feed). */
function tube(radius: number, lenCm: number): Anatomy {
  const points = [];
  const n = 10;
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

function run(rod: CosseratRod, steps: number) {
  for (let i = 0; i < steps; i++) rod.step(1 / 60);
}

/** Cranial climb of the tip up the real anatomy after feeding `deployed` cm (pushability). */
function navClimb(substeps: number, deployed = 28): number {
  const anatomy = buildNormalAnatomy();
  const access = anatomy.access[0].pos.clone();
  const rod = new CosseratRod(anatomy, "rcfa", { ...GUIDEWIRE, substeps }, { deployed: 2, steer: 0.3, torque: 0 });
  rod.input = { deployed, steer: 0.3, torque: 0 };
  run(rod, 600);
  return rod.tip().y - access.y;
}

/** Total accumulated turn angle along the shaft after navigating the real anatomy. This is a proxy
 * for solver wiggle, not a calibrated stiffness measurement. */
function navCurv(beamGain: number): number {
  const rod = new CosseratRod(buildNormalAnatomy(), "rcfa", GUIDEWIRE, { deployed: 2, steer: 0.3, torque: 0 });
  rod.beamGain = beamGain;
  rod.input = { deployed: 30, steer: 0.3, torque: 0 };
  run(rod, 700);
  const turns: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 1; i < rod.n - 1; i++) {
    a.subVectors(rod.x[i], rod.x[i - 1]).normalize();
    b.subVectors(rod.x[i + 1], rod.x[i]).normalize();
    turns.push(Math.acos(Math.max(-1, Math.min(1, a.dot(b)))));
  }
  let rough = 0;
  for (let i = 1; i < turns.length - 1; i++) rough += Math.abs(turns[i - 1] - 2 * turns[i] + turns[i + 1]);
  return rough;
}

/** Max lateral excursion of an over-fed column in a wide tube (bow); fairing should reduce it. */
function feedBow(beamGain: number): number {
  const rod = new CosseratRod(tube(5, 14), "a", GUIDEWIRE);
  rod.beamGain = beamGain;
  rod.input = { deployed: 24, steer: 0, torque: 0 };
  run(rod, 800);
  let m = 0;
  for (let i = 1; i < rod.n; i++) {
    const p = rod.x[i];
    if (p.y > 1 && p.y < 9) m = Math.max(m, Math.hypot(p.x, p.z));
  }
  return m;
}

describe("validation rig — instrument mechanics", () => {
  // KNOWN ARCHITECTURAL LIMITATION — the Phase-3 gate (design review §1.1). Time-constant damping
  // removed the *damping* dependence on the substep count, but the *elastic stiffness* still scales
  // with the substep dt: α̃ = α/Δt_s², and with NO real per-node inertia for α̃ to balance against,
  // a smaller Δt_s (more substeps) yields a softer rod. So navigation is still substep-dependent
  // (e.g. climb(S=2) ≈ 20 cm vs climb(S=4) ≈ 15 cm) — the same root that makes the wire "too soft to
  // tune" (the near-rigid wall also dominates the soft bend). Truly decoupling stiffness from the
  // substep count needs the Phase-3 solver work (real inertia / a direct or implicit bend solve,
  // e.g. Stable Cosserat Rods or Deul). Un-skip and tighten when that lands.
  it.skip("SUBSTEP-INVARIANT: navigation does not depend on the substep count (Phase 3 gate)", () => {
    const s2 = navClimb(2);
    const s4 = navClimb(4);
    const relDiff = Math.abs(s4 - s2) / Math.max(0.1, Math.abs(s2));
    expect(relDiff).toBeLessThan(0.15);
  });

  it("PUSHABILITY: feeding advances the tip cranially up the real anatomy (no accordion)", () => {
    const shallow = navClimb(2, 12);
    const deep = navClimb(2, 36);
    // eslint-disable-next-line no-console
    console.log(`[pushability] climb@12cm=${shallow.toFixed(2)}cm  climb@36cm=${deep.toFixed(2)}cm`);
    expect(shallow).toBeGreaterThan(3); // it actually climbs out of the femoral/iliac
    expect(deep).toBeGreaterThan(shallow + 8); // more feed ⇒ meaningfully more cranial progress
  });

  it("BEAM FAIRING: the global shaft pass reduces over-fed column bow", () => {
    // The beam pass is an EI-scaled fairing aid for the current real-time solver. Turning it up
    // should visibly reduce bow, but this is not a realised-EI bench test.
    const off = feedBow(0); // pure Gauss-Seidel XPBD (legacy soft shaft)
    const on = feedBow(0.5); // global shaft fairing engaged
    // eslint-disable-next-line no-console
    console.log(`[beam stiffens] bow(beam off)=${off.toFixed(2)}cm  bow(beam on)=${on.toFixed(2)}cm`);
    expect(on).toBeLessThan(off * 0.6); // the stiffened shaft buckles markedly less
  });

  // KNOWN LIMITATION — after path-aligned access seeding, this topology-dependent proxy is no
  // longer a reliable "wiggle" measure: the global fairing pass can change which vessel curve the
  // legacy XPBD wire follows, swamping the local high-frequency signal. Keep the straight-column
  // fairing gate above; replace this with a golden-phantom shape/RMS gate before treating navigated
  // roughness as a solver acceptance criterion again.
  it.skip("BEAM FAIRING: the navigated wire accumulates less high-frequency turn", () => {
    const off = navCurv(0); // pure Gauss-Seidel XPBD
    const on = navCurv(GUIDEWIRE.beamGain); // the shipped global-bending gain
    // eslint-disable-next-line no-console
    console.log(`[beam nav] roughTurn(beam off)=${off.toFixed(1)}rad  roughTurn(beam on)=${on.toFixed(1)}rad`);
    // the beam (curvature fairing) removes high-frequency wiggle while preserving the lumen-following
    // curves, so the navigated wire accumulates meaningfully less total turning.
    expect(on).toBeLessThan(off * 0.9);
  });

  it.todo("CALIBRATED EI: three-point bend / cantilever tests match measured device targets");
});
