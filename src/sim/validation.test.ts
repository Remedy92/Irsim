import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { CosseratRod, GUIDEWIRE_DIRECT } from "./cosserat";
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

/** Max lateral excursion of an over-fed column in a wide tube (bow). */
function feedBow(): number {
  const rod = new CosseratRod(tube(5, 14), "a", GUIDEWIRE_DIRECT);
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
  // The two legacy-lane gates that lived here (SUBSTEP-INVARIANT + PUSHABILITY, both built `GUIDEWIRE`
  // with `substeps` as a knob and were kept as it.skip) were DELETED at the Phase-H flip when the legacy
  // XPBD lane was removed from cosserat.ts. Their replacements run GREEN on the shipped direct lane in
  // validation_calibrated.test.ts: "SUBSTEP-INVARIANCE: navigated climb does not depend on the substep
  // count" (direct lane) and "PUSHABILITY: feeding the shipped coax wire advances the tip cranially up
  // the real anatomy" (shipped wire-in-sheath coax).

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
