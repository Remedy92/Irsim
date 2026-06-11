import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { CosseratRod, GUIDEWIRE } from "./cosserat";
import { buildNormalAnatomy } from "./anatomy";
import type { Anatomy } from "./types";
import { buildGuidewireField, buildSheathField, type MaterialProfile } from "./material";
import { cantileverTipDeflection } from "./beamfem/buckling";

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
 *   3. FEED TRANSPORT — insertion itself does not create artificial over-fed column bow.
 *   4. MATERIAL EI — the built-in material table feeds the direct beam stiffness model and matches
 *      analytic cantilever deflection for its source-backed guidewire/sheath EI values.
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

/** Max lateral excursion of an over-fed column in a wide tube (bow). */
function feedBow(): number {
  const rod = new CosseratRod(tube(5, 14), "a", GUIDEWIRE);
  rod.input = { deployed: 24, steer: 0, torque: 0 };
  run(rod, 800);
  let m = 0;
  for (let i = 1; i < rod.n; i++) {
    const p = rod.x[i];
    if (p.y > 1 && p.y < 9) m = Math.max(m, Math.hypot(p.x, p.z));
  }
  return m;
}

function eiOf(profile: MaterialProfile, ellCm: number): number {
  return ellCm / (4 * profile.alphaBend1);
}

describe("validation rig — instrument mechanics", () => {
  // INTENTIONALLY SKIPPED — this exercises the LEGACY XPBD lane (navClimb builds GUIDEWIRE with
  // `substeps` as a knob), which is substep-DEPENDENT by construction and is being retired: α̃ = α/Δt_s²
  // and the legacy lane has no real per-node inertia for α̃ to balance against, so a smaller Δt_s (more
  // substeps) yields a softer rod (e.g. climb(S=2) ≈ 20 cm vs climb(S=4) ≈ 15 cm). Forcing the legacy
  // lane to pass here would be a knowingly-false gate. The REAL substep-invariance proof is GREEN on the
  // DIRECT lane (fixed D_SUBSTEPS implicit dynamic beam): see validation_calibrated.test.ts
  // "SUBSTEP-INVARIANCE: navigated climb does not depend on the substep count" (~line 144, active gate
  // on GUIDEWIRE_DIRECT). Phase G flipped the SHIPPED presets to direct but deliberately kept the legacy
  // XPBD lane in cosserat.ts for comparison; this skip documents that lane's known substep-dependence
  // and is removed when Phase H deletes the legacy lane.
  it.skip("SUBSTEP-INVARIANT: navigation does not depend on the substep count (legacy lane — see direct-lane gate)", () => {
    const s2 = navClimb(2);
    const s4 = navClimb(4);
    const relDiff = Math.abs(s4 - s2) / Math.max(0.1, Math.abs(s2));
    expect(relDiff).toBeLessThan(0.15);
  });

  // INTENTIONALLY SKIPPED — this is a LEGACY-LANE gate (navClimb builds `GUIDEWIRE`, the XPBD preset)
  // whose passing margin depended on the experimental `beamGain` shaft-fairing that ran on the legacy
  // preset (beamGain=0.2). That O(N) banded fairing (beam.ts) was DELETED at the Phase-G flip — it was
  // an uncalibrated crutch, not real EI. Without it the legacy lane still climbs (climb@12cm≈9.8cm,
  // passes >3) but the deep-vs-shallow margin collapses (climb@36cm 22cm→12cm) because the bare
  // Gauss-Seidel XPBD shaft accordions under deep over-feed. NOTE: the same is true of the DIRECT lane
  // when fed SOLO — a bare force-fed wire with no proximal support snakes at the inlet and the tip
  // stalls near its seed (that is real wire mechanics; it is why procedures feed through a sheath), so
  // the ≈22 cm solo-climb expectation this test encoded was a fairing artifact, not physics. The
  // climb-MAGNITUDE hard gate now lives in validation_calibrated.test.ts — "PUSHABILITY: feeding the
  // shipped coax wire advances the tip cranially up the real anatomy" — on the shipped coax
  // (wire-in-sheath) runtime (climb@36cm ≈ 43 cm, gated > 30 with deep > shallow + 8). Removed when
  // Phase H deletes the legacy lane.
  it.skip("PUSHABILITY: feeding advances the tip cranially up the real anatomy (legacy lane — fairing removed; direct coax gate in validation_calibrated)", () => {
    const shallow = navClimb(2, 12);
    const deep = navClimb(2, 36);
    // eslint-disable-next-line no-console
    console.log(`[pushability] climb@12cm=${shallow.toFixed(2)}cm  climb@36cm=${deep.toFixed(2)}cm`);
    expect(shallow).toBeGreaterThan(3); // it actually climbs out of the femoral/iliac
    expect(deep).toBeGreaterThan(shallow + 8); // more feed ⇒ meaningfully more cranial progress
  });

  it("FEED TRANSPORT: insertion itself does not create artificial over-fed column bow", () => {
    // After feed transport moves the old inlet material forward before a new node is born, the
    // pure injected-material path should avoid proximal accordioning.
    const bow = feedBow();
    // eslint-disable-next-line no-console
    console.log(`[feed transport] bow=${bow.toFixed(2)}cm`);
    expect(bow).toBeLessThan(0.35);
  });

  // REMOVED in Phase G — the "BEAM FAIRING" skip compared the experimental beamGain shaft-fairing
  // (off vs on). That O(N) banded fairing path (beam.ts + beamGain) was deleted at the Phase-G flip
  // (the direct co-rotational beam now owns real EI), so the test's premise no longer exists. There is
  // nothing to un-skip: navigated-roughness as a solver acceptance criterion still needs a
  // golden-phantom shape/RMS gate, which is future work, not a beamGain comparison.

  it("CALIBRATED EI: material-table guidewire/sheath shafts match analytic cantilever response", () => {
    const ell = 0.25;
    const L = 5;
    const F = 0.05;
    const elements = 4;
    const guidewireEi = eiOf(buildGuidewireField(80, ell).perSegment[0], ell);
    const sheathEi = eiOf(buildSheathField(80, ell).perSegment[0], ell);
    const guidewireDeflection = cantileverTipDeflection(guidewireEi, L, elements, F);
    const sheathDeflection = cantileverTipDeflection(sheathEi, L, elements, F);
    const analyticGuidewire = (F * L * L * L) / (3 * guidewireEi);
    const analyticSheath = (F * L * L * L) / (3 * sheathEi);

    expect(Math.abs(guidewireDeflection - analyticGuidewire) / analyticGuidewire).toBeLessThan(0.02);
    expect(Math.abs(sheathDeflection - analyticSheath) / analyticSheath).toBeLessThan(0.02);
    expect(sheathDeflection).toBeLessThan(guidewireDeflection);
    expect(guidewireDeflection / sheathDeflection).toBeCloseTo(sheathEi / guidewireEi, 2);
  });
});
