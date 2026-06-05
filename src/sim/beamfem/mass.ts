/**
 * Section geometry + per-element density + lumped nodal mass/inertia for the dynamic beam
 * (docs/physics-design-dynamic-corotational-beam.md §1.7, Phase 2).
 *
 * UNITS (the single FATAL-fixed convention): density ρ in N·s²·cm⁻⁴, so a lumped nodal mass
 * m = ρ·A·ℓ is N·s²·cm⁻¹ and M/Δt² comes out in N/cm NATIVELY — dynamic nodal forces are Newtons
 * with NO scale factor and NO forceScale (forceScale is the ratio-only XPBD λ-path, not a mass map).
 *
 * Absolute mass is a free scale for a heavily-damped trainer; we condition it so M/Δt² is comparable
 * to the stiffness K. Conditioning is done on the TWIST DOF (the required felt mode), since a single
 * per-element ρ cannot make both bend- and twist-conditioning O(1) (they differ ~38× for the wire):
 *   ρ_e = R*·GJ_e·Δt_s² / (J_p,e · ℓ_e²),   R* ≈ 1.
 */

export interface Section {
  /** Cross-section area A = πr² (cm²). */
  A: number;
  /** Second moment of area I = πr⁴/4 (cm⁴) — bending. */
  I: number;
  /** Polar second moment J_p = 2I = πr⁴/2 (cm⁴) — torsion. */
  Jp: number;
}

/** Solid round section properties from radius (cm). */
export function computeSection(rCm: number): Section {
  const r2 = rCm * rCm;
  const A = Math.PI * r2;
  const I = (Math.PI * r2 * r2) / 4;
  return { A, I, Jp: 2 * I };
}

/**
 * Twist-conditioned per-element density (N·s²·cm⁻⁴): ρ_e = R*·GJ·Δt_s²/(J_p·ℓ²). With R*≈1 this puts
 * the twist M/Δt² term ≈ the twist stiffness GJ/ℓ, so the dynamic twist is well-resolved and
 * substep-invariant. Bend conditioning then falls out (≈38× different for the wire — accepted).
 */
export function densityForElement(GJ: number, Jp: number, ell: number, dts: number, Rstar: number): number {
  return (Rstar * GJ * dts * dts) / (Jp * ell * ell);
}

/** If a physical g/cm³ density is ever ingested, convert ONCE here (1 N = 1e5 g·cm/s²). */
export function densityFromGramsPerCm3(rhoGramsPerCm3: number): number {
  return rhoGramsPerCm3 * 1e-5; // → N·s²·cm⁻⁴
}

export interface LumpedMass {
  /** Per-node translational mass (N·s²·cm⁻¹), length n. */
  m: Float64Array;
  /** Per-node bending rotational inertia (N·s²·cm), length n. */
  Jb: Float64Array;
  /** Per-node twist rotational inertia (N·s²·cm), length n. */
  Jt: Float64Array;
}

/**
 * Half-segment lumped mass: each element splits its mass/inertia equally to its two nodes.
 * `radii[e]`, `GJ[e]`, `restLen[e]` are per-element (length n-1); ρ is computed per element from the
 * twist conditioning. dts = substep Δt (s), Rstar the conditioning target.
 */
export function assembleMass(
  n: number,
  restLen: Float64Array,
  radii: Float64Array,
  GJ: Float64Array,
  dts: number,
  Rstar: number,
  out?: LumpedMass
): LumpedMass {
  const m = out?.m ?? new Float64Array(n);
  const Jb = out?.Jb ?? new Float64Array(n);
  const Jt = out?.Jt ?? new Float64Array(n);
  m.fill(0);
  Jb.fill(0);
  Jt.fill(0);
  for (let e = 0; e < n - 1; e++) {
    const sec = computeSection(radii[e]);
    const rho = densityForElement(GJ[e], sec.Jp, restLen[e], dts, Rstar);
    const me = rho * sec.A * restLen[e]; // element mass
    const jbe = rho * sec.I * restLen[e]; // bending inertia (diametral 2nd moment)
    const jte = rho * sec.Jp * restLen[e]; // twist inertia (polar)
    const half = 0.5;
    m[e] += half * me; m[e + 1] += half * me;
    Jb[e] += half * jbe; Jb[e + 1] += half * jbe;
    Jt[e] += half * jte; Jt[e + 1] += half * jte;
  }
  return { m, Jb, Jt };
}
