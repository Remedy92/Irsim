import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { CosseratRod, GUIDEWIRE_DIRECT, type CosseratParams } from "./cosserat";
import type { Anatomy } from "./types";

/**
 * LIVE-DYNAMICS bending gate — DOCUMENTED RED (`it.fails`): the audited curl-memory defect.
 *
 * Every other calibrated EI gate measures the rod through `relaxDirectStatic`, which sets
 * params.static and DROPS all inertia/damping — so none of them can see this defect: the uniform
 * mass-conditioning scale (D_MASS_SCALE_TRANS = 8e5, tuned only for twist) puts the translational
 * term m/Δt² ≈ 14,300 N/cm ~12× ABOVE the transverse bend stiffness 12EI/ℓ³ ≈ 1,152 N/cm, so on the
 * REAL `stepDirect` path every bending mode is overdamped to near-stasis (a 10 cm span's slow-root
 * shape-recovery time is ~7 MINUTES at a0 = 1/τ = 12.5 s⁻¹). The live wire holds every
 * contact-imprinted curl and a tip force expresses only ~1% of the calibrated cantilever δ in 1.5 s.
 *
 * THE FIX IS THREADED BUT NOT SHIPPABLE YET (cosserat.ts D_MASS_SCALE_TRANS comment, 2026-06-12):
 * at the bending-true trans scale 8.0e2 this file's assertions PASS handsomely (115% of analytic δ
 * expressed dynamically; 93.9% spring-back in 1 s, t₉₀ = 0.85 s, zero overshoot) — but shipped-coax
 * NAVIGATION collapses (shallow climb 9.30 → 0.45 cm), because the wall friction stack cannot hold
 * a springy wire: spring-back and pushability ride the SAME bending modes, and today's navigation
 * is load-bearing on the artificial translational inertia. Until the contact/friction work lands,
 * these gates are `it.fails`: CI goes RED the day the live dynamics start expressing calibrated EI,
 * forcing this file to be flipped to hard gates in the same change.
 */

/** A straight, wide vessel tube along +y. Radius is large so no wall contact perturbs the bench. */
function wideTube(lenCm: number, radius = 5): Anatomy {
  const points = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    points.push({ pos: new Vector3(0, -2 + (i * lenCm) / n, 0), radius, s: (i * lenCm) / n });
  }
  return {
    id: "wt",
    name: "wide-tube",
    branches: [{ id: "wt", name: "wt", attenuation: 1, points }],
    access: [{ id: "a", name: "a", pos: new Vector3(0, -2, 0), dir: new Vector3(0, 1, 0), branchId: "wt" }],
    targets: [],
    provenance: { source: "test", license: "test", note: "test" }
  };
}

/**
 * Uniform-EI direct rod (no graded tip/precurve so the shaft EI=12 applies end-to-end) on the HARD
 * inlet anchor: the compliant feed motor is a separate boundary-condition under test elsewhere; this
 * bench isolates the bending DYNAMICS. The hard anchor pins nodes 0 AND 1 (anchorInletDirect), so the
 * effective cantilever is rooted at node 1: L_eff = (n−2)·h.
 */
const UNIFORM_DYNAMIC: CosseratParams = {
  ...GUIDEWIRE_DIRECT,
  tipNodes: 0,
  transitionNodes: 0,
  tipCurve: 0,
  useCompliantFeedMotor: false
};
const SHAFT_EI = 12;

function allFinite(rod: CosseratRod): boolean {
  for (const p of rod.x) if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
  for (const q of rod.q) if (!Number.isFinite(q.x) || !Number.isFinite(q.w)) return false;
  return true;
}

describe("live direct dynamics — a deflected span expresses EI and recovers shape (stepDirect, NOT relaxDirectStatic)", () => {
  // DOCUMENTED RED — see file header. Passes at D_MASS_SCALE_TRANS = 8e2 (measured 115% / 93.9%).
  it.fails("10 cm span: dynamic load reaches the static cantilever δ, then springs back ≥90% within 1 s", () => {
    const rod = new CosseratRod(wideTube(16), "a", UNIFORM_DYNAMIC, { deployed: 10, steer: 0, torque: 0 });
    const dt = 1 / 60; // shipped frame dt; stepDirect uses its own fixed internal substeps (4)
    // settle any seeding transient at the unloaded equilibrium (straight along +y)
    for (let i = 0; i < 30; i++) rod.step(dt);
    const tipEq = rod.tip().clone();
    const tipIdx = rod.n - 1;
    const Leff = (rod.n - 2) * rod.h; // hard inlet anchors nodes 0 AND 1 ⇒ cantilever rooted at node 1
    const F = 0.03; // N ⇒ δ ≈ 0.03·L³/36 ≈ 0.71 cm at L≈9.5 (δ/L ≈ 7%, near-linear regime)
    const analytic = (F * Leff * Leff * Leff) / (3 * SHAFT_EI);

    // PHASE 1 — LOAD, on the live dynamic path. 1.5 s ≫ the bending-true t₉₀ ≈ 0.7 s, so the loaded
    // shape must have settled onto the static cantilever. At the shipped uniform 8e5 scale this
    // reaches only ~1% of δ (the inertia term masks EI) — the defect this red gate documents.
    rod.setExternalForce(tipIdx, new Vector3(F, 0, 0));
    for (let i = 0; i < 90; i++) {
      rod.step(dt);
      expect(allFinite(rod), `non-finite state during load at frame ${i}`).toBe(true);
    }
    const defl = rod.tip().x - tipEq.x;
    // eslint-disable-next-line no-console
    console.log(
      `[live-dyn load] δ_dyn=${defl.toFixed(4)}cm analytic=${analytic.toFixed(4)}cm ` +
        `(${((defl / analytic) * 100).toFixed(0)}% expressed) L_eff=${Leff}cm`
    );
    expect(defl).toBeGreaterThan(0.8 * analytic);
    expect(defl).toBeLessThan(1.2 * analytic);

    // PHASE 2 — RELEASE: spring-back on the live dynamic path.
    rod.clearExternalLoads();
    let maxExcursionBeyondEq = 0; // overshoot past equilibrium (−x side): ringing/divergence guard
    let t90Frame = -1;
    const frames = 60; // 1.0 s of sim time
    for (let i = 0; i < frames; i++) {
      rod.step(dt);
      expect(allFinite(rod), `non-finite state during recovery at frame ${i}`).toBe(true);
      const ex = rod.tip().x - tipEq.x;
      if (ex < 0) maxExcursionBeyondEq = Math.max(maxExcursionBeyondEq, -ex);
      if (t90Frame < 0 && rod.tip().distanceTo(tipEq) <= 0.1 * defl) t90Frame = i + 1;
    }
    const residual = rod.tip().distanceTo(tipEq);
    const recovery = 1 - residual / defl;
    // eslint-disable-next-line no-console
    console.log(
      `[live-dyn recovery] recovery=${(recovery * 100).toFixed(1)}% after 1s  t90=${
        t90Frame < 0 ? ">60" : t90Frame
      } frames (${t90Frame < 0 ? "n/a" : (t90Frame / 60).toFixed(2) + "s"})  overshoot=${maxExcursionBeyondEq.toFixed(4)}cm`
    );
    // headline gate: ≥90% of the deflection recovered within 1 s of LIVE sim time
    expect(recovery).toBeGreaterThanOrEqual(0.9);
    expect(t90Frame).toBeGreaterThan(0);
    // no oscillation divergence: ζ ≈ 1.14 ⇒ essentially no overshoot; generous bound at 15% of δ
    expect(maxExcursionBeyondEq).toBeLessThan(0.15 * defl);
  }, 60000);

  // DOCUMENTED RED — see file header. Passes at D_MASS_SCALE_TRANS = 8e2 (maxDev 6% of δ).
  it.fails("recovered shape is globally straight again (not just the tip): max node deviation ≤10% of δ", () => {
    const rod = new CosseratRod(wideTube(16), "a", UNIFORM_DYNAMIC, { deployed: 10, steer: 0, torque: 0 });
    const dt = 1 / 60;
    for (let i = 0; i < 30; i++) rod.step(dt);
    const eq = rod.x.map((p) => p.clone());
    rod.setExternalForce(rod.n - 1, new Vector3(0.03, 0, 0));
    for (let i = 0; i < 90; i++) rod.step(dt);
    const defl = Math.abs(rod.tip().x - eq[eq.length - 1].x);
    rod.clearExternalLoads();
    for (let i = 0; i < 60; i++) rod.step(dt);
    expect(allFinite(rod)).toBe(true);
    let maxDev = 0;
    for (let i = 0; i < rod.n && i < eq.length; i++) maxDev = Math.max(maxDev, rod.x[i].distanceTo(eq[i]));
    // eslint-disable-next-line no-console
    console.log(`[live-dyn shape] δ=${defl.toFixed(4)}cm maxNodeDev after 1s=${maxDev.toFixed(4)}cm`);
    // the LOAD must have deflected the wire at all for the recovery ratio to mean anything — at the
    // shipped heavy scale even this load expression fails (δ ≈ 1% of analytic), keeping this red.
    expect(defl).toBeGreaterThan(0.5);
    expect(maxDev).toBeLessThanOrEqual(0.1 * defl);
  }, 60000);

  // Stability companion (always hard-pass). The it.fails gates above stay green for ANY failure mode —
  // including a NaN/Inf blowup that would trivially satisfy "defl not > 0.5". This test catches that:
  // after the same load+release run, every node position and orientation must be finite and the maximum
  // node displacement must be bounded by a generous multiple of the analytic deflection.
  it("10 cm span: all nodes remain finite and displacement stays bounded throughout load+release (stability)", () => {
    const rod = new CosseratRod(wideTube(16), "a", UNIFORM_DYNAMIC, { deployed: 10, steer: 0, torque: 0 });
    const dt = 1 / 60;
    // settle transient
    for (let i = 0; i < 30; i++) rod.step(dt);
    const tipEq = rod.tip().clone();
    const tipIdx = rod.n - 1;
    const Leff = (rod.n - 2) * rod.h;
    const F = 0.03;
    const analytic = (F * Leff * Leff * Leff) / (3 * SHAFT_EI);
    // generous bound: a non-diverging solver cannot displace the tip more than 50× the static δ
    const DIVERGENCE_BOUND = 50 * analytic;

    // PHASE 1 — LOAD
    rod.setExternalForce(tipIdx, new Vector3(F, 0, 0));
    for (let i = 0; i < 90; i++) {
      rod.step(dt);
      expect(allFinite(rod), `non-finite state during load at frame ${i}`).toBe(true);
      expect(rod.tip().distanceTo(tipEq), `tip diverged during load at frame ${i}`).toBeLessThan(DIVERGENCE_BOUND);
    }

    // PHASE 2 — RELEASE
    rod.clearExternalLoads();
    for (let i = 0; i < 60; i++) {
      rod.step(dt);
      expect(allFinite(rod), `non-finite state during release at frame ${i}`).toBe(true);
      expect(rod.tip().distanceTo(tipEq), `tip diverged during release at frame ${i}`).toBeLessThan(DIVERGENCE_BOUND);
    }
    expect(allFinite(rod)).toBe(true);
  }, 60000);
});
