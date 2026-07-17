import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { CosseratRod, GUIDEWIRE_DIRECT, type CosseratParams } from "./cosserat";
import type { Anatomy } from "./types";

/**
 * PHASE-I MATERIAL FIDELITY — scope-declaration + the already-reachable anisotropy/GJ gates.
 *
 * This file declares the CONCRETE intended gates for the Phase-I material-realism work (nonlinear
 * nitinol EI(κ), load/unload hysteresis, push-to-twist helical coupling) as it.skip stubs (NOT it.todo
 * — each names a precise analytic acceptance check and the source hook Phase H/I must add), AND ships
 * the two material-anisotropy gates whose data path is ALREADY plumbed end-to-end:
 *
 *   (4) ANISOTROPIC J-TIP — element.ts/integration.ts already map alphaBend1→EIy and alphaBend2→EIz
 *       INDEPENDENTLY (elemMatFromProfile: EIy=ℓ/4α1, EIz=ℓ/4α2; localStiffness uses them in separate
 *       bend blocks). Only makeProfile's INPUT hardcodes alphaBend2=alphaBend1 (round section), so to
 *       exercise EIz≠EIy without a source edit we mutate rod.material.perSegment[*].alphaBend2 directly
 *       before relaxDirectStatic — ensureDirect() rebuilds the element rigidities from this.material on
 *       every call (cosserat.ts buildElemMats), so the override is picked up. MEASURED: δ-ratio = 1.999
 *       (EIz=2·EIy ⇒ a load that bends about EIy deflects exactly 2× the load that bends about EIz),
 *       isotropic control ratio = 1.000. Authored as a HARD gate (it).
 *
 *   (5) GJ-FRACTION TORSION — gjCm is already a distinct field (material.ts wireShaft.gjCm≈9.2≈0.77·12),
 *       and alphaTwist→GJ is plumbed (elemMatFromProfile GJ=ℓ/4α_twist). A round-wire profile with
 *       gjCm=0.77·eiCm reproduces θ=T·L/GJ. MEASURED: rel error 0.0% at GJ=9.24 (=0.77·12). Authored
 *       as a HARD gate (it) — extends the existing validation_calibrated torsion check with an explicit
 *       GJ-fraction (the realistic round-metal GJ/EI ratio).
 *
 * Both reachable gates use relaxDirectStatic (the inertia-free elastic operator the trusted battery
 * already validates), so they are green TODAY. The three deferred stubs need new Phase-H/I source hooks
 * (a curvature-dependent EI(κ) law, a loading/unloading state variable, and a bend↔twist coupling term);
 * their stub comments name the exact hook.
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

/** UNIFORM-EI direct rod (no graded floppy tip / transition / precurve) so a single EI/GJ applies. */
const UNIFORM_DIRECT: CosseratParams = {
  ...GUIDEWIRE_DIRECT,
  tipNodes: 0,
  transitionNodes: 0,
  tipCurve: 0,
  useCompliantFeedMotor: false // hard anchor ⇒ relaxDirectStatic measures EI/GJ, not inlet compliance
};
const SHAFT_EI = 12; // wireShaft REGION EI the uniform rod assembles (material.ts)

// =============================================================================================
// (4) ANISOTROPIC J-TIP — REACHABLE TODAY, hard gate. (measured δ-ratio 1.999)
// =============================================================================================
describe("Phase-I material fidelity — anisotropic bending (EIy ≠ EIz)", () => {
  /**
   * Build a uniform rod, optionally override alphaBend2 so EIz = 2·EIy (a wireFloppyTip-like
   * anisotropy: stiffer about one transverse axis), apply a tip transverse point load in the chosen
   * plane, statically relax, and return the tip deflection magnitude. A +x load deflects in x and is
   * resisted by the bend rigidity about the OTHER transverse axis governing that plane.
   */
  function measureTipDeflection(load: Vector3, anisotropic: boolean): number {
    const rod = new CosseratRod(wideTube(11), "a", UNIFORM_DIRECT, { deployed: 6, steer: 0, torque: 0 });
    if (anisotropic) {
      // Phase H2 material-ownership flip: the direct beam reads the NATIVE rigidities
      // (integration.ts:elemMatFromProfile reads m.EIz directly, no longer ℓ/(4·alphaBend2)). Double
      // EIz relative to EIy to set up the anisotropy. (alphaBend2 kept in sync for the back-compat rep.)
      for (const p of rod.material.perSegment) {
        p.EIz = 2 * p.EIy;
        p.alphaBend2 = 0.5 * p.alphaBend1;
      }
    }
    const p0 = rod.tip().clone();
    rod.setExternalForce(rod.n - 1, load);
    rod.relaxDirectStatic();
    return rod.tip().clone().sub(p0).length();
  }

  it("EIz = 2·EIy ⇒ the two transverse planes give a tip-deflection ratio ≈ 2 (anisotropy is realised)", () => {
    const F = 0.02;
    const dAboutEIy = measureTipDeflection(new Vector3(F, 0, 0), true); // soft plane (EIy)
    const dAboutEIz = measureTipDeflection(new Vector3(0, 0, F), true); // stiff plane (EIz = 2·EIy)
    const ratio = dAboutEIy / dAboutEIz;

    // ISOTROPIC CONTROL: with alphaBend2 untouched (=alphaBend1 ⇒ EIz=EIy) the planes are identical.
    const dIsoX = measureTipDeflection(new Vector3(F, 0, 0), false);
    const dIsoZ = measureTipDeflection(new Vector3(0, 0, F), false);
    const isoRatio = dIsoX / dIsoZ;

    // δ ∝ 1/EI, so EIz=2·EIy ⇒ the EIz plane deflects half as much ⇒ ratio ≈ 2. Measured 1.999.
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
    // the isotropic control must stay symmetric (sanity that the anisotropy, not a bench artefact, drives it)
    expect(isoRatio).toBeGreaterThan(0.9);
    expect(isoRatio).toBeLessThan(1.1);
  });
});

// =============================================================================================
// (5) GJ-FRACTION TORSION — REACHABLE TODAY, hard gate. (measured rel error 0.0%)
// =============================================================================================
describe("Phase-I material fidelity — GJ-fraction torsion (round wire GJ = 0.77·EI)", () => {
  /**
   * Apply a tip axial moment T to a uniform clamped-free rod whose twist compliance is overridden so
   * GJ = gjFrac·EI(shaft), then statically relax and read the tip-frame roll relative to the base.
   * Pure torsion ⇒ θ = T·L/GJ. The override mirrors what makeProfile already supports via its distinct
   * gjCm input (material.ts wireShaft.gjCm≈9.2≈0.77·12); here we set it explicitly per element.
   */
  function measureTwist(T: number, gjFrac: number): { twist: number; L: number; GJ: number } {
    const rod = new CosseratRod(wideTube(9), "a", UNIFORM_DIRECT, { deployed: 6, steer: 0, torque: 0 });
    const GJ = gjFrac * SHAFT_EI;
    for (let i = 0; i < rod.material.perSegment.length; i++) {
      const ell = rod.restLen[i];
      // Phase H2 material-ownership flip: the direct beam reads the NATIVE GJ directly
      // (integration.ts:elemMatFromProfile reads m.GJ, no longer ℓ/(4·alphaTwist)). Set GJ natively;
      // keep alphaTwist in sync for the back-compat compliance representation.
      rod.material.perSegment[i].GJ = GJ;
      rod.material.perSegment[i].alphaTwist = ell / (4 * GJ); // α_twist = ℓ/(4·GJ)
    }
    const L = (rod.n - 1) * rod.h;
    rod.setExternalMoment(rod.n - 1, new Vector3(0, T, 0)); // axis +y = rod axis
    rod.relaxDirectStatic();
    const qBase = rod.directNodeFrame(0);
    const qTip = rod.directNodeFrame(rod.n - 1);
    const qrel = qTip.clone().multiply(qBase.conjugate());
    const twist = 2 * Math.acos(Math.min(1, Math.abs(qrel.w)));
    return { twist, L, GJ };
  }

  it("a round-wire profile (GJ = 0.77·EI) reproduces θ = T·L/GJ within 5%", () => {
    const T = 0.3;
    const { twist, L, GJ } = measureTwist(T, 0.77);
    const analytic = (T * L) / GJ;
    const rel = Math.abs(twist - analytic) / analytic;
    expect(rel).toBeLessThan(0.05);
  });

  it("twist scales as 1/GJ: halving GJ (stiffer-to-softer torsion) ≈ doubles θ", () => {
    const T = 0.3;
    const tStiff = measureTwist(T, 0.77).twist; // GJ = 9.24
    const tSoft = measureTwist(T, 0.385).twist; // GJ = 4.62 (= half)
    expect(tSoft / tStiff).toBeCloseTo(2, 1);
  });
});

// =============================================================================================
// DEFERRED PHASE-I GATES — it.skip scope declarations. Each names the analytic acceptance check AND
// the concrete source hook Phase H/I must add. NOT it.todo: these are designed gates awaiting the hook.
// =============================================================================================
describe("Phase-I material fidelity — deferred nonlinear material gates (scope declarations)", () => {
  /**
   * (1) NITINOL EI(κ) PLATEAU-SOFTENING — superelastic stress plateau.
   *
   * INTENDED ANALYTIC CHECK: statically relax a 1-element beam under a tip moment that drives the
   * element curvature κ above the superelastic plateau onset κ_plateau. Below onset the realised
   * moment is linear (M = EI·κ); above onset the austenite→martensite plateau softens the response,
   * so the realised moment at κ > κ_plateau must be ≤ 80% of the linear extrapolation EI·κ (i.e. the
   * tangent EI collapses on the plateau). Sweep κ across the onset and assert the realised M/(EI·κ)
   * ratio drops from ≈1.0 (pre-onset) to ≤0.8 (post-onset).
   *
   * SOURCE HOOK Phase H/I MUST ADD: a curvature-dependent bend law in beamfem/element.ts
   * (localStiffness currently uses a CONSTANT EIy/EIz). Either (a) a per-element tangent EI(κ) read
   * from a MaterialProfile.eiCurve hook the Newton round re-evaluates per iteration, or (b) a
   * plateau-moment clamp M_plateau on the element's internal bend moment. Today element.ts is linear,
   * so there is no input that expresses plateau-softening — this stub cannot be made green by a
   * test-only override (unlike the anisotropy/GJ gates, which only needed the EXISTING distinct fields).
   */
  it.skip("(1) nitinol EI(κ): realised moment at κ > κ_plateau is ≤ 80% of linear EI·κ [needs element.ts EI(κ) hook]", () => {
    // requires a nonlinear bend law (MaterialProfile.eiCurve / plateau clamp) — not yet plumbed.
  });

  /**
   * (2) NITINOL LOADING/UNLOADING HYSTERESIS — superelastic stress-strain loop.
   *
   * INTENDED ANALYTIC CHECK: drive a tip transverse load up a ramp then back down, recording the F–δ
   * curve at each step (quasi-static relax at each load level). The loop must enclose POSITIVE area
   * (loading and unloading branches differ — energy dissipated per cycle > 0) AND the unloading branch
   * must lie BELOW the loading branch at every interior load (lower stress on the return, the
   * characteristic superelastic flag). Assert loopArea > 0 and δ_unload(F) ≥ δ_load(F) at the mid-ramp
   * load (more deflection for the same force on the way down).
   *
   * SOURCE HOOK Phase H/I MUST ADD: a per-element STATE VARIABLE (martensite fraction / loading-vs-
   * unloading branch selector) carried across relax calls and a hysteretic EI(κ, branch) law. The
   * current beam is path-independent (purely elastic, no internal state), so it cannot dissipate
   * energy — a test-only override of the existing fields cannot create a hysteresis loop.
   */
  it.skip("(2) nitinol hysteresis: F–δ loop area > 0 and the unloading branch sits below loading [needs element.ts hysteresis state]", () => {
    // requires a per-element loading/unloading state variable + hysteretic law — not yet plumbed.
  });

  /**
   * (3) PUSH-TO-TWIST HELICAL COUPLING — bend↔twist (extension↔torsion) coupling.
   *
   * INTENDED ANALYTIC CHECK: a clamped-free uniform beam under a pure AXIAL tip load P (along the rod
   * axis) must develop a tip TORSION φ = P·L·kCoupling/GJ for a helical/anisotropic coupling constant
   * kCoupling, within 10% — i.e. pushing the wire makes the tip ROLL (the felt "push-to-twist" of a
   * shaped/coiled guidewire). Apply axial P, relax, read the tip-frame roll, assert it matches the
   * coupled prediction within 10% (and is ≈0 when kCoupling=0, the decoupled control).
   *
   * SOURCE HOOK Phase H/I MUST ADD: an off-diagonal axial↔twist coupling term in the element
   * stiffness (beamfem/element.ts localStiffness builds DECOUPLED axial / bend / twist blocks — kt =
   * GJ/ℓ on the twist DOFs only, no coupling to the axial DOF). A MaterialProfile.coupling input would
   * feed a K_axial-twist block. No existing field expresses this, so it cannot be reached by override.
   */
  it.skip("(3) push-to-twist: axial load P ⇒ tip torsion φ = P·L·kCoupling/GJ within 10% [needs element.ts axial↔twist coupling block]", () => {
    // requires an off-diagonal axial↔twist coupling term in localStiffness — not yet plumbed.
  });
});
