/**
 * Units reconciliation — the single source of truth for SI ↔ scene-unit conversion.
 *
 * AUTHORITATIVE UNIT DECISION (governs every physics constant in the sim):
 *
 *   Work in CENTIMETERS. The anatomy, access frames, rod radii, and all existing
 *   geometry tests are in cm (see anatomy.ts / types.ts). We DO NOT convert the scene
 *   to SI, and we DO NOT paste the design-doc SI table values raw into cm code.
 *
 * The design doc parameter table (docs/physics-design-cosserat-xpbd.md §4) is in SI
 * (N, N·m², m). We reconcile explicitly here:
 *
 *   - Length: segment rest length ℓ_j in cm (the per-segment restLen[], replacing the
 *     old scalar l0). Rod/lumen radii in cm.
 *
 *   - Time is SI everywhere. The substep is Δt_s = dt / S in SECONDS. We never scale
 *     time. The compliance actually used in the solve is α̃ = α / Δt_s².
 *
 *   - Bend/twist compliance is DIMENSIONLESS in the quaternion-imaginary convention the
 *     repo uses (C_b = Im(conj(q_j) q_{j+1}) ≈ ½θ). The mapping is
 *         α_b = ℓ / (4·EI)
 *     with EI in N·cm². The factor of 4 is BAKED IN by the ½θ convention. EI converts
 *     from SI as EI[N·cm²] = 1e4 · EI[N·m²] (since 1 m² = 1e4 cm²). GJ likewise.
 *     ⚠ If anyone rewrites the bend constraint to the Darboux form C_Ω = Ω − Ω0, the
 *       compliance becomes α_Ω = 1/(ℓ·EI) with NO factor of 4. Do not mix conventions.
 *
 *   - Stretch compliance: α_stretch = ℓ_cm / EA, with EA in N (a force, scale-free).
 *     Units of α_stretch are therefore cm/N. The doc's "h/EA" column uses h in metres,
 *     so it is 100× smaller than ours for the same EA — we recompute from ℓ_cm/EA
 *     rather than copying the SI column.
 *
 *   - Rest curvature: κ0_cm = κ0_SI / 100 (1/cm vs 1/m). A physical precurve feeds
 *     φ = ℓ_cm · κ0_cm into the existing sin(φ/2) per-node encoding (e.g. a 45° tip over
 *     20 mm → κ0 ≈ 0.39 cm⁻¹; a J-tip radius 5–15 mm → 0.67–2.0 cm⁻¹).
 *
 *   - Force: in cm units a constraint multiplier gives F ≈ λ / Δt_s², which is a
 *     cm-unit "force", only meaningful for RATIOS (the Coulomb cone |λ_t| ≤ μ·λ_n and the
 *     feed force cap). `forceScale` is the ONE documented scalar that maps that cm-unit
 *     force estimate to Newtons if/when a real calibration is done. We never claim raw
 *     Newtons without it.
 */

/** Centimetres per metre. 1 m = 100 cm; 1 m² = 1e4 cm². */
export const CM_PER_M = 100;

/**
 * Single documented force-calibration scalar: F[N] ≈ forceScale · (λ / Δt_s²).
 * 1.0 until a pull-through rig calibrates it (design doc §8.5). Kept here so the cone
 * and force-cap logic reference exactly one knob instead of scattering magic factors.
 */
export const forceScale = 1.0;

/** EI or GJ from SI (N·m²) to scene units (N·cm²): ×1e4 because 1 m² = 1e4 cm². */
export function eiSiToCm(eiSi: number): number {
  return eiSi * CM_PER_M * CM_PER_M;
}

/**
 * Bend/twist compliance in the quaternion-imag convention: α_b = ℓ / (4·EI).
 * Dimensionless. `ellCm` in cm, `eiCm` in N·cm² (use eiSiToCm to convert SI input).
 * The factor of 4 is the ½θ convention (see file header) — DO NOT remove it.
 */
export function alphaBend(ellCm: number, eiCm: number): number {
  return ellCm / (4 * eiCm);
}

/** Axial stretch compliance: α_stretch = ℓ_cm / EA. EA in N (scale-free). Units cm/N. */
export function alphaStretch(ellCm: number, eaN: number): number {
  return ellCm / eaN;
}

/** Rest curvature SI (1/m) → scene (1/cm): ÷100. */
export function kappaSiToCm(kappaSi: number): number {
  return kappaSi / CM_PER_M;
}

/**
 * Force estimate from an XPBD multiplier: F ≈ forceScale · λ / Δt_s² (cm units unless
 * forceScale calibrated to N). Used for the Coulomb cone and the feed-force cap.
 */
export function forceFromLambda(lambda: number, dtSeconds: number): number {
  return forceScale * lambda / (dtSeconds * dtSeconds);
}
