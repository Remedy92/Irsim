import { describe, expect, it } from "vitest";
import { forceFromLambda, solveXPBDScalar } from "./xpbd";

/**
 * XPBD compliance core (Macklin et al. 2016). The defining update for a scalar
 * constraint C with multiplier λ, gradient-mass term Σw|∇C|², compliance α, substep Δt_s:
 *   Δλ = -(C + α̃λ)/(Σw|∇C|² + α̃),  α̃ = α/Δt_s²
 */
describe("XPBD core", () => {
  it("reduces to the rigid PBD projection as α → 0", () => {
    // Single particle (w=1), unit gradient, C = 0.3 displacement to remove. With α=0 the
    // rigid PBD projection is Δλ = -C/(w·1) and the position moves by w·∇C·Δλ = -C.
    const C = 0.3;
    const w = 1;
    const wGradSq = w * 1; // |∇C|² = 1
    const dtS = 1 / 240;

    const dlRigid = solveXPBDScalar(C, 0, wGradSq, 0, dtS);
    expect(dlRigid).toBeCloseTo(-C / wGradSq, 12); // = -0.3
    // applying x += w·∇C·Δλ (∇C = +1) fully removes the violation in one step
    const xCorr = w * 1 * dlRigid;
    expect(C + xCorr).toBeCloseTo(0, 12);

    // A tiny but nonzero compliance must stay extremely close to the rigid projection.
    // (At α=1e-12, Δt_s=1/240 ⇒ α̃≈5.8e-8, so the relative deviation is ~1e-7.)
    const dlStiff = solveXPBDScalar(C, 0, wGradSq, 1e-12, dtS);
    expect(dlStiff).toBeCloseTo(dlRigid, 6);
  });

  it("softens (smaller |Δλ|, partial correction) as α grows", () => {
    const C = 0.3;
    const wGradSq = 1;
    const dtS = 1 / 240;
    const rigid = Math.abs(solveXPBDScalar(C, 0, wGradSq, 0, dtS));
    const soft = Math.abs(solveXPBDScalar(C, 0, wGradSq, 1e-3, dtS));
    const softer = Math.abs(solveXPBDScalar(C, 0, wGradSq, 1e-1, dtS));
    expect(soft).toBeLessThan(rigid);
    expect(softer).toBeLessThan(soft);
  });

  it("force estimate F ≈ λ/Δt_s² matches an analytic linear spring", () => {
    // A compliant constraint at equilibrium accumulates λ such that C + α̃λ = 0 ⇒
    // λ = -C/α̃ = -C·Δt_s²/α. The force estimate F = λ/Δt_s² = -C/α. For a linear spring
    // of stiffness k = 1/α stretched by C, the restoring "force" magnitude is k·C = C/α.
    const C = 0.25;
    const alpha = 2e-3;
    const dtS = 1 / 200;
    const aTilde = alpha / (dtS * dtS);
    const lambdaEq = -C / aTilde; // multiplier at static equilibrium of this one constraint
    const F = forceFromLambda(lambdaEq, dtS);
    const kSpring = 1 / alpha;
    expect(Math.abs(F)).toBeCloseTo(kSpring * C, 9);
  });

  it("α̃ = α/Δt_s² scales correctly across two substep sizes", () => {
    // Halving Δt_s quarters Δt_s², so α̃ quadruples and the *same* α behaves stiffer.
    const C = 0.4;
    const wGradSq = 1;
    const alpha = 5e-3;
    const dtA = 1 / 120;
    const dtB = dtA / 2; // half the substep
    const dlA = Math.abs(solveXPBDScalar(C, 0, wGradSq, alpha, dtA));
    const dlB = Math.abs(solveXPBDScalar(C, 0, wGradSq, alpha, dtB));
    // smaller substep ⇒ larger α̃ ⇒ more compliant ⇒ smaller correction this iteration
    expect(dlB).toBeLessThan(dlA);

    // explicit α̃ ratio: α̃(dtB)/α̃(dtA) = (dtA/dtB)² = 4
    const aTildeA = alpha / (dtA * dtA);
    const aTildeB = alpha / (dtB * dtB);
    expect(aTildeB / aTildeA).toBeCloseTo(4, 9);
  });

  it("is allocation-light: returns a finite number for degenerate denominators", () => {
    // both wGradSq and α̃ ~ 0 → guarded to 0, never NaN/Inf
    expect(solveXPBDScalar(1, 0, 0, 0, 1 / 60)).toBe(0);
  });
});
