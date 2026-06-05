import { Quaternion } from "three";
import type { MaterialField, MaterialProfile } from "../material";
import { assembleMass, LumpedMass } from "./mass";
import { ElemMat } from "./element";

/**
 * Adapter between the existing Cosserat rod's per-segment MaterialField (compliances) and the dynamic
 * co-rotational beam's per-element ElemMat (rigidities) + lumped mass + nodal frames
 * (docs/physics-design-dynamic-corotational-beam.md §1.1, §3a).
 *
 * The MaterialField stores XPBD COMPLIANCES (α_bend = ℓ/(4·EI), α_stretch = ℓ/EA, α_twist = ℓ/(4·GJ));
 * the beam needs the RIGIDITIES, recovered by inverting those exact mappings (units.ts):
 *   EI = ℓ/(4·α_bend),  GJ = ℓ/(4·α_twist),  EA = ℓ/α_stretch.
 * This round-trips the REGION-table targets exactly (shaft EI≈12, tip≈0.1, …), so the calibrated
 * cantilever/buckling gates assert the SAME constants the solver assembles from.
 *
 * REPRESENTATION BRIDGE: the rod carries one quaternion PER SEGMENT (n−1 frames); the beam carries
 * one PER NODE (n frames). The beam owns nodal frames as authoritative; positions x[] are shared with
 * the rod. Helpers convert both ways so contact/coax/rendering that read segment frames stay coherent.
 */

/** Recover element rigidities (EA/EIy/EIz/GJ) + precurve from a segment's XPBD compliances. */
export function elemMatFromProfile(m: MaterialProfile, ell: number, steer = 0, kirchhoff = true): ElemMat {
  const s = Math.max(0, Math.min(1, steer));
  return {
    EA: ell / Math.max(1e-12, m.alphaStretch),
    EIy: ell / (4 * Math.max(1e-12, m.alphaBend1)),
    EIz: ell / (4 * Math.max(1e-12, m.alphaBend2)),
    GJ: ell / (4 * Math.max(1e-12, m.alphaTwist)),
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

/** Lumped per-node mass/inertia from the rod's material + geometry, twist-conditioned (R*). */
export function buildLumpedMassForRod(
  n: number,
  restLen: Float64Array | number[],
  material: MaterialField,
  dts: number,
  Rstar: number,
  out?: LumpedMass
): LumpedMass {
  const segs = material.perSegment.length;
  const rl = restLen instanceof Float64Array ? restLen : Float64Array.from(restLen);
  const radii = new Float64Array(segs);
  const GJ = new Float64Array(segs);
  for (let e = 0; e < segs; e++) {
    radii[e] = material.perSegment[e].rodRadius;
    GJ[e] = rl[e] / (4 * Math.max(1e-12, material.perSegment[e].alphaTwist));
  }
  return assembleMass(n, rl, radii, GJ, dts, Rstar, out);
}

/**
 * Build n NODAL frames from n−1 SEGMENT frames: interior node i = shortest-arc midpoint slerp of its
 * two bracketing segments; the end nodes take their single adjacent segment frame. Reflection-stable.
 */
export function nodalFramesFromSegments(segQ: Quaternion[], out?: Quaternion[]): Quaternion[] {
  const segs = segQ.length;
  const n = segs + 1;
  const arr = out ?? Array.from({ length: n }, () => new Quaternion());
  if (arr.length !== n) arr.length = n;
  arr[0] = (arr[0] ?? new Quaternion()).copy(segQ[0]);
  arr[n - 1] = (arr[n - 1] ?? new Quaternion()).copy(segQ[segs - 1]);
  for (let i = 1; i < n - 1; i++) {
    const a = segQ[i - 1];
    const b = segQ[i];
    const bAligned = (arr[i] ?? new Quaternion()).copy(b);
    if (a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0) bAligned.set(-b.x, -b.y, -b.z, -b.w);
    arr[i] = (arr[i] ?? new Quaternion()).copy(a).slerp(bAligned, 0.5);
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
    const bAligned = (arr[j] ?? new Quaternion()).copy(b);
    if (a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0) bAligned.set(-b.x, -b.y, -b.z, -b.w);
    arr[j] = (arr[j] ?? new Quaternion()).copy(a).slerp(bAligned, 0.5);
  }
  return arr;
}
