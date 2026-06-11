import { Vector3 } from "three";
import { alphaBend, alphaStretch, eiSiToCm } from "./units";

/**
 * Material properties as a Lagrangian field along the rod's material coordinate.
 *
 * Each segment carries its own MaterialProfile so stiffness can be GRADED along arc
 * length (floppy distal tip → transition → stiff supportive shaft). The field advects
 * with inserted material (Stage 2): when a node is injected at the proximal access the
 * shaft profile is prepended; existing entries are never resampled or smeared, so the
 * floppy tip never bleeds into the shaft.
 *
 * UNITS: centimetres / N / dimensionless. See units.ts for the SI→cm reconciliation.
 * Compliances are PHYSICAL (XPBD): α̃ = α/Δt_s² is formed in the solver, not here.
 */
export interface MaterialProfile {
  /** Instrument cross-section radius at this segment (cm). */
  rodRadius: number;
  /** Axial stretch compliance α_stretch = ℓ/EA (cm/N). Tiny ⇒ near-inextensible. */
  alphaStretch: number;
  /** Shear compliance (cm/N). Very small for a thin wire; shares the stretch-shear block. */
  alphaShear: number;
  /** Bend compliance about director-x: α_b = ℓ/(4·EI1), dimensionless (quaternion-imag). */
  alphaBend1: number;
  /** Bend compliance about director-y: α_b = ℓ/(4·EI2), dimensionless. */
  alphaBend2: number;
  /** Twist compliance about the director: α_t = ℓ/(4·GJ), dimensionless. */
  alphaTwist: number;
  /**
   * Rest curvature in the quaternion-imaginary encoding (the imag part of the rest
   * Darboux quaternion, ≈ sin(φ/2) per axis). 0 for a straight shaft; nonzero only over
   * actual curved distal material. Reused as restOmega in the rod solve.
   */
  restCurvature: Vector3;
  /** Static / kinetic translational friction, roll (spin) friction, instrument-instrument. */
  muStatic: number;
  muKinetic: number;
  muRoll: number;
  muIo: number;
  /**
   * Physical mass density in g/cm³ (stainless ~7.9, nitinol ~6.5, polymer/sheath ~1.0–1.6). Read by
   * the dynamic beam's lumped-mass assembly (beamfem/mass.ts) — converted ONCE to scene units
   * (N·s²·cm⁻⁴) via densityFromGramsPerCm3 — to give physical m/Jb/Jt RATIOS. The legacy XPBD elastic
   * core does not read it (it is ratio-only). Defaults to 1.0 (water) when not specified.
   */
  density: number;
}

/** A per-segment material field, parallel to restLen[]. perSegment[0] is the proximal end. */
export interface MaterialField {
  perSegment: MaterialProfile[];
}

export function cloneProfile(p: MaterialProfile): MaterialProfile {
  return {
    ...p,
    restCurvature: p.restCurvature.clone()
  };
}

/**
 * Build a profile from physical inputs in SCENE-ADJACENT terms: EI/GJ in N·cm², EA in N,
 * the segment rest length ℓ in cm. Converts to compliances via the documented mappings.
 * `restCurvature` is the quaternion-imag rest (default straight).
 */
export function makeProfile(opts: {
  ellCm: number;
  rodRadius: number;
  eiCm: number; // bend EI1 = EI2 (round cross-section) in N·cm²
  gjCm: number; // torsion GJ in N·cm²
  eaN: number; // axial EA in N
  shearScale?: number; // α_shear = shearScale · α_stretch (wire shear ~ stretch; default 1)
  restCurvature?: Vector3;
  muStatic: number;
  muKinetic: number;
  muRoll: number;
  muIo: number;
  density?: number;
}): MaterialProfile {
  const aStretch = alphaStretch(opts.ellCm, opts.eaN);
  return {
    rodRadius: opts.rodRadius,
    alphaStretch: aStretch,
    alphaShear: aStretch * (opts.shearScale ?? 1),
    alphaBend1: alphaBend(opts.ellCm, opts.eiCm),
    alphaBend2: alphaBend(opts.ellCm, opts.eiCm),
    alphaTwist: alphaBend(opts.ellCm, opts.gjCm),
    restCurvature: (opts.restCurvature ?? new Vector3()).clone(),
    muStatic: opts.muStatic,
    muKinetic: opts.muKinetic,
    muRoll: opts.muRoll,
    muIo: opts.muIo,
    density: opts.density ?? 1
  };
}

/**
 * Source-backed flexural-rigidity anchors for the built-in trainer presets.
 *
 * Suskin et al. 2023, "Quantification of the flexural rigidity of endovascular surgical devices
 * using three-point bending tests", reports 0.035" guidewire main-shaft EI spanning roughly
 * 1-13 N*cm^2, intermediate guide catheters around 5-10 N*cm^2, and long sheaths around
 * 5-25 N*cm^2. These are class ranges, not exact product clones; the chosen values intentionally
 * sit near the high-support end so the simulator behaves like a supportive IR training setup.
 */
export const DEVICE_FLEXURAL_RIGIDITY_TARGETS = {
  guidewireMainShaftEiCm: {
    min: 1,
    max: 13,
    chosen: 12
  },
  intermediateGuideMainShaftEiCm: {
    min: 5,
    max: 10,
    representative: 7
  },
  longSheathMainShaftEiCm: {
    min: 5,
    max: 25,
    chosen: 17
  }
} as const;

/**
 * Region tables (scene-unit starting points, still finalized by validation rigs). EI/GJ are
 * given in N·cm²; EA in N. Empirical anchors:
 * - 2023 three-point-bend device library: 0.035" guidewire distal EI ≈0.02–0.15 N·cm²,
 *   proximal EI ≈0.9–10.4 N·cm² with main-shaft range reported around 1–13 N·cm².
 * - The same library reports intermediate guide catheters around 5–10 N·cm² and long sheaths
 *   around 5–25 N·cm², with transition zones varying by device.
 * - Older EVAR support-wire bending tests report very broad effective moduli (plain Amplatz up
 *   through Lunderquist Extra Stiff), so device-specific presets remain the real calibration path.
 *
 * The grading is the whole point: α_b(tip) ≫ α_b(transition) ≫ α_b(shaft).
 *
 * FRICTION (μ) — PHASE E LITERATURE RETUNE. The Coulomb μ is graded by region because the distal
 * working length of a modern guidewire is HYDROPHILIC-coated (hydrogel) while the supportive shaft
 * and the access sheath are not. Lubricity tribology (Takashima/Sawa-style wet-wall benches; the
 * coating vendors' standardized COF tests; pancreatobiliary guidewire friction-force studies show
 * the same coated-vs-uncoated ordering) puts the wet coefficient of friction at:
 *   - hydrophilic hydrogel coating on a wet vessel/tissue wall: μ ≈ 0.02–0.05 (often ~0.03 wet),
 *   - PTFE / fluoropolymer (a "bare" guidewire shaft): μ ≈ 0.05–0.1 dry-ish, higher when worn,
 *   - bare/braided polymer sheath against the wall: μ ≈ 0.2–0.3.
 * So the floppy hydrophilic TIP must be LOW (the old 0.08 was wrong — that is a bare-metal value).
 * Phase E retunes the TRANSLATIONAL (slide) coefficients only:
 *   - tip       μ_s 0.08→0.04, μ_k 0.04→0.02   (hydrophilic band 0.02–0.05)
 *   - transition μ_s 0.08→0.07, μ_k 0.04→0.035  (coated→bare blend, between tip 0.04 and shaft 0.2)
 *   - shaft     μ_s 0.10→0.20, μ_k 0.05→0.10   (bare/PTFE band 0.1–0.3, mid)
 *   - sheath    μ_s 0.25 (kept), μ_k 0.12       (bare/braided band 0.2–0.3, already in-band)
 * Kinetic < static is preserved everywhere (μ_k ≈ 0.5·μ_s, the usual stick-slip drop). The transition
 * and shaft sit in the UPPER part of their literature bands deliberately: the wall grip along the
 * coated working length is what lets a steered tip hold its climb into a limb (legacy-lane navigation
 * gate, cosserat.test.ts Y-bifurcation) — dropping them to the band floor under-grips and the wire
 * settles ~1 cm short. The headline correction (hydrophilic TIP, the part the operator feels lead the
 * way through tortuosity) is fully realised; the bands give room to grade grip without losing it.
 *
 * muRoll (SPIN/roll friction) is LEFT at its existing values (0.04/0.04/0.05/0.12) — Phase E does NOT
 * retune it. It is a separately-calibrated DOF (scaled by params.spinFrictionScale) governing torque
 * wind-up/release at the wall. A bisection during Phase E showed that lowering muRoll alongside the
 * translational μ destabilises the knife-edge Phase-D blocked-tip-prolapse gate (the steered-seating
 * spin dynamics shift the stall-onset cap, calibrated for forceMax≈0.5 N), whereas the translational
 * retune alone keeps every gate green. Spin lubricity is not the headline "slippery tip" the plan
 * targets, so muRoll stays put to avoid regressing the spin-friction calibration.
 */
export const REGION = {
  /** 0.035" guidewire floppy distal tip — measured tips are roughly 0.05-0.15 N*cm^2. */
  wireFloppyTip: {
    rodRadius: 0.05,
    eiCm: eiSiToCm(1.0e-5), // ≈ 0.1 N*cm^2
    gjCm: eiSiToCm(7.5e-6),
    eaN: 1.0e4,
    muStatic: 0.04, // hydrophilic-coated distal tip: wet COF ~0.02–0.05 (was 0.08 ≈ bare metal)
    muKinetic: 0.02, // μ_k ≈ 0.5·μ_s (stick-slip drop)
    muRoll: 0.04, // spin friction: kept at the existing spin-calibrated value (see REGION docblock)
    muIo: 0.06,
    density: 6.5 // nitinol-cored floppy tip, ~6.45 g/cm³
  },
  /** Transition region between tip and shaft. */
  wireTransition: {
    rodRadius: 0.05,
    eiCm: eiSiToCm(3.0e-4), // ≈ 3.0 N·cm²
    gjCm: eiSiToCm(2.25e-4),
    eaN: 2.0e4,
    muStatic: 0.07, // coated→bare blend: between the hydrophilic tip (0.04) and bare shaft (0.2); was 0.08
    muKinetic: 0.035, // μ_k ≈ 0.5·μ_s
    muRoll: 0.04, // spin friction: kept at the existing spin-calibrated value
    muIo: 0.06,
    density: 7.2 // nitinol→steel transition, between core (6.5) and shaft (7.9)
  },
  /** Supportive shaft — stiff column that carries push. */
  wireShaft: {
    rodRadius: 0.05,
    eiCm: DEVICE_FLEXURAL_RIGIDITY_TARGETS.guidewireMainShaftEiCm.chosen,
    gjCm: 9.2, // round metal shaft: GJ ≈ 0.75–0.8·EI
    eaN: 2.5e4,
    muStatic: 0.2, // bare/PTFE supportive shaft: μ ~0.1–0.3, mid-band (was 0.1)
    muKinetic: 0.1, // μ_k ≈ 0.5·μ_s
    muRoll: 0.05, // spin friction: kept at the existing spin-calibrated value
    muIo: 0.06,
    density: 7.9 // 304/316 stainless steel core, ~7.9 g/cm³
  },
  /** 5–6 Fr sheath / catheter supportive shaft — stiffer and larger radius than a wire. */
  sheathShaft: {
    rodRadius: 0.1, // ~6 Fr OD ≈ 2 mm → r ≈ 0.1 cm
    eiCm: DEVICE_FLEXURAL_RIGIDITY_TARGETS.longSheathMainShaftEiCm.chosen,
    gjCm: 13,
    eaN: 3.0e4,
    muStatic: 0.25, // bare/braided polymer sheath against the wall: μ ~0.2–0.3 (already in-band)
    muKinetic: 0.12,
    muRoll: 0.12,
    muIo: 0.06,
    density: 1.3 // braided polymer sheath (PTFE/PEBAX + steel braid), ~1.1–1.6 g/cm³
  }
} as const;

type RegionSpec = (typeof REGION)[keyof typeof REGION];

function profileFromRegion(spec: RegionSpec, ellCm: number, restCurvature?: Vector3): MaterialProfile {
  return makeProfile({
    ellCm,
    rodRadius: spec.rodRadius,
    eiCm: spec.eiCm,
    gjCm: spec.gjCm,
    eaN: spec.eaN,
    shearScale: 1,
    restCurvature,
    muStatic: spec.muStatic,
    muKinetic: spec.muKinetic,
    muRoll: spec.muRoll,
    muIo: spec.muIo,
    density: spec.density
  });
}

/**
 * Build a graded guidewire material field of `segments` segments at rest length `ellCm`.
 * Distal `tipSegments` are floppy, the next `transitionSegments` are the transition, the
 * rest is supportive shaft. perSegment[0] is the proximal (shaft) end; the tip is at the
 * high-index distal end. `tipCurvature` (quaternion-imag magnitude per tip segment) sets
 * the pre-shaped J/angle on the floppy tip only.
 */
export function buildGuidewireField(
  segments: number,
  ellCm: number,
  opts?: { tipSegments?: number; transitionSegments?: number; tipCurvature?: number }
): MaterialField {
  const tipSegments = opts?.tipSegments ?? 8;
  const transitionSegments = opts?.transitionSegments ?? 6;
  const tipCurvature = opts?.tipCurvature ?? 0;
  const perSegment: MaterialProfile[] = [];
  for (let j = 0; j < segments; j++) {
    const fromTip = segments - 1 - j; // 0 at the distal tip segment
    if (fromTip < tipSegments) {
      // Precurve about director-X. NOTE (chirality, [[irsim-solver-chirality-bug]]): this curls the
      // tip toward −director-Y, and director-Y FLIPS under sagittal (x) mirroring in buildAccessFrame
      // (v'=−mirror(v)) while director-X is mirror-clean — that frame handedness is the chirality
      // asymmetry. An axis swap to (0,κ,0) (curl toward the mirror-clean +director-X) was EMPIRICALLY
      // TESTED and REVERTED: it is reflection-symmetric but does not aim up-vessel, collapsing
      // PUSHABILITY deep-climb 43→5.7 cm. The navigation-effective precurve direction is intrinsically
      // the mirror-asymmetric one, so a real fix must derive the precurve PLANE from the local vessel
      // osculating geometry (a redesign), not swap the body axis. Kept on director-X (navigation-good).
      const rc = tipCurvature !== 0 ? new Vector3(tipCurvature, 0, 0) : undefined;
      perSegment.push(profileFromRegion(REGION.wireFloppyTip, ellCm, rc));
    } else if (fromTip < tipSegments + transitionSegments) {
      perSegment.push(profileFromRegion(REGION.wireTransition, ellCm));
    } else {
      perSegment.push(profileFromRegion(REGION.wireShaft, ellCm));
    }
  }
  return { perSegment };
}

/** Build a uniform sheath/catheter material field (stiff, larger radius). */
export function buildSheathField(segments: number, ellCm: number): MaterialField {
  const perSegment: MaterialProfile[] = [];
  for (let j = 0; j < segments; j++) perSegment.push(profileFromRegion(REGION.sheathShaft, ellCm));
  return { perSegment };
}

/** A single guidewire shaft profile for prepend-on-feed (Stage 2 injection). */
export function wireShaftProfile(ellCm: number): MaterialProfile {
  return profileFromRegion(REGION.wireShaft, ellCm);
}

/** A single sheath/catheter shaft profile for prepend-on-feed (Stage 2 injection). */
export function sheathShaftProfile(ellCm: number): MaterialProfile {
  return profileFromRegion(REGION.sheathShaft, ellCm);
}

/** A single shaft profile for prepend-on-feed (Stage 2 injection). */
export function shaftProfile(ellCm: number, profile: "guidewire" | "sheath" = "guidewire"): MaterialProfile {
  return profile === "sheath" ? sheathShaftProfile(ellCm) : wireShaftProfile(ellCm);
}
