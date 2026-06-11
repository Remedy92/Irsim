/**
 * Section geometry + PHYSICAL lumped nodal mass/inertia for the dynamic beam
 * (docs/physics-design-dynamic-corotational-beam.md §1.7, Phase 2 → Phase B real-mass keystone).
 *
 * UNITS (the single FATAL-fixed convention): density ρ in N·s²·cm⁻⁴, so a lumped nodal mass
 * m = ρ·A·ℓ is N·s²·cm⁻¹ and M/Δt² comes out in N/cm NATIVELY — dynamic nodal forces are Newtons
 * with NO scale factor and NO forceScale (forceScale is the ratio-only XPBD λ-path, not a mass map).
 *
 * WHAT CHANGED (Phase B). The old path used a SYNTHETIC twist-conditioned per-element density
 * ρ_e = R*·GJ·Δt_s²/(J_p·ℓ²): it pinned each element's twist M/Δt² to its own GJ/ℓ but, because the
 * density was a function of GJ, it (a) destroyed the real mass RATIOS between regions/instruments
 * (every region got the same conditioning regardless of its stiffness/material) and (b) left bend
 * vs twist conditioning ~38× apart across the device. That made the contact/coax inverse-mass metric
 * a fake (GJ-derived, not material-derived) number and made two-way coax / mass-scaled damping unsafe.
 *
 * Now mass is PHYSICAL: distinct translational m, bending inertia Jb and twist inertia Jt come from
 * real section geometry × real material density (stainless ~7.9, nitinol ~6.5, polymer/sheath
 * ~1.0–1.6 g/cm³, converted ONCE via densityFromGramsPerCm3):
 *   m = ρ·A·ℓ,   Jb = ρ·I·ℓ,   Jt = ρ·J_p·ℓ.
 * The wire↔sheath mobility ratio and the contact/coax inverse-mass metric are now real physics.
 *
 * THE CONDITIONING SCALE (the "trap", resolved per the Phase-B plan). A real guidewire is genuinely
 * tiny-mass: strictly-physical M/Δt² at h=0.5, Δt_s=1/240 is ~6 orders below the stiffness K, which
 * would (i) ill-condition Newton and (ii) erase the felt torsional wind-up/whip the trainer wants.
 * The resolution is to keep the physical mass RATIOS (above) but multiply by a SINGLE tuned absolute
 * conditioning scale `MASS_SCALE`, DECOUPLED from GJ. The scale is chosen (see cosserat.ts D_MASS_SCALE)
 * so the wire-shaft twist term M/Δt² ≈ GJ/ℓ — i.e. it reproduces the previous, validated twist
 * conditioning regime while now carrying physical ratios. Absolute mass is a free knob for a heavily
 * damped trainer; the ratios are physics, the absolute level is the tuned knob. NEVER re-couple the
 * scale to GJ — that GJ-coupling was the old defect.
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

/** Convert a physical g/cm³ density to scene units, ONCE (1 N = 1e5 g·cm/s² ⇒ ×1e-5). */
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
 * Half-segment PHYSICAL lumped mass: each element contributes m=ρAℓ, Jb=ρIℓ, Jt=ρ·J_p·ℓ from its
 * real section (radii[e]) and real per-element density (rho[e], already in N·s²·cm⁻⁴), split equally
 * to its two nodes. The single absolute `scale` (the GJ-DECOUPLED conditioning knob — see file header)
 * multiplies every term, preserving the physical m/Jb/Jt ratios while lifting M/Δt² to be comparable
 * to the stiffness K. `radii[e]`, `rho[e]`, `restLen[e]` are per-element (length n-1).
 */
export function assembleMass(
  n: number,
  restLen: Float64Array,
  radii: Float64Array,
  rho: Float64Array,
  scale: number,
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
    const rhoS = rho[e] * scale; // physical density × the single GJ-decoupled conditioning scale
    const me = rhoS * sec.A * restLen[e]; // element translational mass  (= ρ·A·ℓ)
    const jbe = rhoS * sec.I * restLen[e]; // bending inertia (diametral 2nd moment, = ρ·I·ℓ)
    const jte = rhoS * sec.Jp * restLen[e]; // twist inertia (polar, = ρ·J_p·ℓ)
    const half = 0.5;
    m[e] += half * me; m[e + 1] += half * me;
    Jb[e] += half * jbe; Jb[e + 1] += half * jbe;
    Jt[e] += half * jte; Jt[e + 1] += half * jte;
  }
  return { m, Jb, Jt };
}
