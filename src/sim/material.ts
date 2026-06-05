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
  /** Mass density proxy → inverse mass in scene units (Stage 3+; unused in the elastic core). */
  density: number;
}

/** A per-segment material field, parallel to restLen[]. perSegment[0] is the proximal end. */
export interface MaterialField {
  perSegment: MaterialProfile[];
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
 * Region tables (scene-unit starting points, NOT SI ground truth — finalized by the
 * validation rigs). EI/GJ are given in N·cm² (already ×1e4 from the SI doc table via
 * eiSiToCm); EA in N. Chosen mid-range from docs/physics-design-cosserat-xpbd.md §4.
 *
 * The grading is the whole point: α_b(tip) ≫ α_b(transition) ≫ α_b(shaft).
 */
export const REGION = {
  /** 0.035" guidewire floppy distal tip — measured tips are roughly 0.05-0.15 N*cm^2. */
  wireFloppyTip: {
    rodRadius: 0.05,
    eiCm: eiSiToCm(1.0e-5), // ≈ 0.1 N*cm^2
    gjCm: eiSiToCm(7.5e-6),
    eaN: 1.0e4,
    muStatic: 0.08,
    muKinetic: 0.04,
    muRoll: 0.04,
    muIo: 0.06
  },
  /** Transition region between tip and shaft. */
  wireTransition: {
    rodRadius: 0.05,
    eiCm: eiSiToCm(3.0e-4), // ≈ 3.0 N·cm²
    gjCm: eiSiToCm(2.25e-4),
    eaN: 2.0e4,
    muStatic: 0.08,
    muKinetic: 0.04,
    muRoll: 0.04,
    muIo: 0.06
  },
  /** Supportive shaft — stiff column that carries push. */
  wireShaft: {
    rodRadius: 0.05,
    eiCm: eiSiToCm(1.2e-3), // ≈ 12 N·cm²
    gjCm: eiSiToCm(9.0e-4),
    eaN: 2.5e4,
    muStatic: 0.1,
    muKinetic: 0.05,
    muRoll: 0.05,
    muIo: 0.06
  },
  /** 5–6 Fr sheath / catheter supportive shaft — stiffer and larger radius than a wire. */
  sheathShaft: {
    rodRadius: 0.1, // ~6 Fr OD ≈ 2 mm → r ≈ 0.1 cm
    eiCm: eiSiToCm(6.0e-3), // ≈ 60 N·cm²
    gjCm: eiSiToCm(3.0e-3),
    eaN: 3.0e4,
    muStatic: 0.25,
    muKinetic: 0.12,
    muRoll: 0.12,
    muIo: 0.06
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
    muIo: spec.muIo
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

/** A single shaft profile for prepend-on-feed (Stage 2 injection). */
export function shaftProfile(ellCm: number): MaterialProfile {
  return profileFromRegion(REGION.wireShaft, ellCm);
}
