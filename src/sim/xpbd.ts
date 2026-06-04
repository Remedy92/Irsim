import { forceScale } from "./units";

/**
 * Generic, allocation-free XPBD primitives (Macklin, Müller, Chentanez 2016).
 *
 * XPBD replaces PBD's timestep/iteration-dependent stiffness `k` with a physical
 * COMPLIANCE α. The per-substep effective compliance is α̃ = α / Δt_s² (time is SI;
 * see units.ts). The defining update for a single constraint C with multiplier λ is:
 *
 *     Δλ = −(C + α̃·λ) / (Σ_i w_i·|∇_i C|² + α̃)
 *     λ  += Δλ
 *     x_i += w_i · ∇_i C · Δλ
 *
 * As α → 0 (α̃ → 0) this reproduces the rigid PBD projection Δλ = −C / Σ w|∇C|²; as α
 * grows the constraint softens. The multiplier λ is a Lagrange multiplier, so a force
 * estimate falls out for free: F ≈ λ / Δt_s² (see forceFromLambda below).
 *
 * These helpers are pure scalar math (no Vector3 alloc) so callers that already hold
 * their gradients as components stay zero-allocation per frame.
 */

/**
 * Scalar XPBD multiplier increment for a constraint with scalar value `C`, accumulated
 * multiplier `lambda`, gradient-mass term `wGradSq` ( = Σ_i w_i·|∇_i C|² ), compliance
 * `alpha`, and substep `dtSeconds`. Returns Δλ; the caller applies x += w·∇C·Δλ and
 * updates λ += Δλ. Allocation-free.
 */
export function solveXPBDScalar(
  C: number,
  lambda: number,
  wGradSq: number,
  alpha: number,
  dtSeconds: number
): number {
  const aTilde = alpha / (dtSeconds * dtSeconds);
  const denom = wGradSq + aTilde;
  if (denom < 1e-12) return 0;
  return -(C + aTilde * lambda) / denom;
}

/**
 * Vector ("block") XPBD for a constraint whose value is a 3-vector (Cx,Cy,Cz) with the
 * SAME gradient magnitude term `wGradSq` on each component (the common diagonal case for
 * rod stretch-shear and inlet motors). Writes Δλ into the supplied `out` triple and
 * returns it. Allocation-free (caller provides `out`).
 *
 * For a truly anisotropic block (different α per axis) call solveXPBDScalar per axis.
 */
export function solveXPBDVectorDiagonal(
  Cx: number,
  Cy: number,
  Cz: number,
  lambdaX: number,
  lambdaY: number,
  lambdaZ: number,
  wGradSq: number,
  alpha: number,
  dtSeconds: number,
  out: { x: number; y: number; z: number }
): { x: number; y: number; z: number } {
  const aTilde = alpha / (dtSeconds * dtSeconds);
  const denom = wGradSq + aTilde;
  if (denom < 1e-12) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  out.x = -(Cx + aTilde * lambdaX) / denom;
  out.y = -(Cy + aTilde * lambdaY) / denom;
  out.z = -(Cz + aTilde * lambdaZ) / denom;
  return out;
}

/** Force estimate from a multiplier: F ≈ forceScale · λ / Δt_s² (see units.ts). */
export function forceFromLambda(lambda: number, dtSeconds: number): number {
  return forceScale * lambda / (dtSeconds * dtSeconds);
}
