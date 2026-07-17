import { Quaternion } from "three";
import type { MaterialField, MaterialProfile } from "../material";
import { assembleMass, densityFromGramsPerCm3, LumpedMass } from "./mass";
import { ElemMat } from "./element";

const _bridgeTarget = new Quaternion();

function alignTo(reference: Quaternion, q: Quaternion, out: Quaternion): Quaternion {
  out.copy(q);
  if (reference.x * q.x + reference.y * q.y + reference.z * q.z + reference.w * q.w < 0) {
    out.set(-q.x, -q.y, -q.z, -q.w);
  }
  return out;
}

function slerpShortest(a: Quaternion, b: Quaternion, t: number, out: Quaternion): Quaternion {
  alignTo(a, b, _bridgeTarget);
  return out.copy(a).slerp(_bridgeTarget, t).normalize();
}

/**
 * Adapter between the existing Cosserat rod's per-segment MaterialField and the dynamic co-rotational
 * beam's per-element ElemMat (rigidities) + lumped mass + nodal frames
 * (docs/physics-design-dynamic-corotational-beam.md §1.1, §3a).
 *
 * MATERIAL OWNERSHIP (Phase H2 flip): the MaterialProfile now stores the RIGIDITIES NATIVELY
 * (EA/EIy/EIz/GJ); the beam reads them DIRECTLY with no compliance↔rigidity round-trip. Previously
 * this adapter recovered them by inverting the XPBD α-* compliances:
 *   EA = ℓ/α_stretch,  EIy = ℓ/(4·α_bend1),  EIz = ℓ/(4·α_bend2),  GJ = ℓ/(4·α_twist).
 * Those mappings were lossless by construction, so reading the native fields is byte-identical:
 * it still round-trips the REGION-table targets exactly (shaft EI≈12, tip≈0.1, …), so the calibrated
 * cantilever/buckling gates assert the SAME constants the solver assembles from. `ell` is no longer
 * needed for the rigidities (they are intrinsic per-element values, not compliances).
 *
 * REPRESENTATION BRIDGE: the rod carries one quaternion PER SEGMENT (n−1 frames); the beam carries
 * one PER NODE (n frames). The beam owns nodal frames as authoritative; positions x[] are shared with
 * the rod. Helpers convert both ways so contact/coax/rendering that read segment frames stay coherent.
 */

/** Read element rigidities (EA/EIy/EIz/GJ) NATIVELY from the profile + decode precurve. */
export function elemMatFromProfile(m: MaterialProfile, _ell: number, steer = 0, kirchhoff = true): ElemMat {
  const s = Math.max(0, Math.min(1, steer));
  return {
    EA: m.EA,
    EIy: m.EIy,
    EIz: m.EIz,
    GJ: m.GJ,
    GAsy: 0,
    GAsz: 0,
    kirchhoff,
    // precurve = steer·restCurvature (RAW RADIANS, the FATAL-fixed decode — no 2·asin)
    kappa0: { x: m.restCurvature.x * s, y: m.restCurvature.y * s, z: m.restCurvature.z * s }
  };
}

/** Per-element ElemMat[] for the whole rod (length = restLen.length = n−1). `steer` scales precurve. */
export function buildElemMats(material: MaterialField, restLen: Float64Array | number[], steer = 0, out?: ElemMat[]): ElemMat[] {
  const segs = material.perSegment.length;
  const arr = out ?? new Array(segs);
  for (let e = 0; e < segs; e++) arr[e] = elemMatFromProfile(material.perSegment[e], restLen[e], steer);
  return arr;
}

/**
 * Element rest curvature as a rotation-vector (RAW RADIANS — the FATAL-fixed decode): the stored
 * restCurvature is raw axis-angle radians (material.ts: tipCurve≈0.22 rad), scaled live by steer.
 * NO 2·asin, NO factor-2/4 — that would double the J-tip curl. Returns steer·restCurvature.
 */
export function kappa0ForElement(m: MaterialProfile, steer: number, out = new Quaternion()): { x: number; y: number; z: number } {
  void out;
  const s = Math.max(0, Math.min(1, steer));
  return { x: m.restCurvature.x * s, y: m.restCurvature.y * s, z: m.restCurvature.z * s };
}

/**
 * PHYSICAL lumped per-node mass/inertia from the rod's real section geometry × real material density
 * (g/cm³ from each segment's MaterialProfile.density, converted ONCE to scene units), with the
 * GJ-DECOUPLED ANISOTROPIC conditioning scales (see beamfem/mass.ts header + cosserat.ts
 * D_MASS_SCALE_TRANS / D_MASS_SCALE_TWIST): `scaleTrans` on m+Jb (bending dynamics), `scaleTwist` on
 * Jt (the validated twist-feel conditioning). This carries physical RATIOS within each DOF family
 * (wire↔sheath mobility, contact/coax inverse-mass metric) while keeping the twist term Jt/Δt² ≈ GJ/ℓ
 * felt; a bending-true `scaleTrans` additionally lets bending modes recover shape on sub-second
 * timescales (see cosserat.ts D_MASS_SCALE_TRANS for the shipped value and its empirical blocker).
 */
export function buildLumpedMassForRod(
  n: number,
  restLen: Float64Array | number[],
  material: MaterialField,
  scaleTrans: number,
  scaleTwist: number,
  out?: LumpedMass
): LumpedMass {
  const segs = material.perSegment.length;
  const rl = restLen instanceof Float64Array ? restLen : Float64Array.from(restLen);
  const radii = new Float64Array(segs);
  const rho = new Float64Array(segs);
  for (let e = 0; e < segs; e++) {
    radii[e] = material.perSegment[e].rodRadius;
    // physical density g/cm³ → scene units (N·s²·cm⁻⁴), ONCE; NOT GJ-derived (the old defect).
    rho[e] = densityFromGramsPerCm3(material.perSegment[e].density);
  }
  return assembleMass(n, rl, radii, rho, scaleTrans, scaleTwist, out);
}

/**
 * Build n NODAL frames from n−1 SEGMENT frames. Segment frames are element-midpoint samples; nodal
 * frames are boundary samples reconstructed so that midpointing node j,j+1 recovers segment j for a
 * smooth twist field. This avoids turning segment↔nodal bridging into a low-pass filter that bleeds
 * torsional gradients every direct-beam substep.
 */
export function nodalFramesFromSegments(segQ: Quaternion[], out?: Quaternion[]): Quaternion[] {
  const segs = segQ.length;
  const n = segs + 1;
  const arr = out ?? Array.from({ length: n }, () => new Quaternion());
  if (arr.length !== n) arr.length = n;
  if (segs === 0) return arr;
  if (segs === 1) {
    arr[0] = (arr[0] ?? new Quaternion()).copy(segQ[0]);
    arr[1] = (arr[1] ?? new Quaternion()).copy(segQ[0]);
    return arr;
  }
  // Back-extrapolate half a segment from the first two midpoint frames to get the proximal boundary.
  arr[0] = slerpShortest(segQ[0], segQ[1], -0.5, arr[0] ?? new Quaternion());
  for (let j = 0; j < segs; j++) {
    // Choose node j+1 so midpoint(node j, node j+1) is segment j.
    arr[j + 1] = slerpShortest(arr[j], segQ[j], 2, arr[j + 1] ?? new Quaternion());
  }
  return arr;
}

/** Build n−1 SEGMENT frames from n NODAL frames: segment j = shortest-arc midpoint of nodes j, j+1. */
export function segmentFramesFromNodal(nodeQ: Quaternion[], out?: Quaternion[]): Quaternion[] {
  const n = nodeQ.length;
  const segs = n - 1;
  const arr = out ?? Array.from({ length: segs }, () => new Quaternion());
  if (arr.length !== segs) arr.length = segs;
  for (let j = 0; j < segs; j++) {
    const a = nodeQ[j];
    const b = nodeQ[j + 1];
    arr[j] = slerpShortest(a, b, 0.5, arr[j] ?? new Quaternion());
  }
  return arr;
}
