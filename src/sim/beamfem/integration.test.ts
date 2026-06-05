import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { buildGuidewireField, makeProfile } from "../material";
import { eiSiToCm } from "../units";
import { buildElemMats, elemMatFromProfile, kappa0ForElement, nodalFramesFromSegments, segmentFramesFromNodal } from "./integration";

describe("beamfem integration — material → ElemMat (recovers the EI targets exactly)", () => {
  it("inverts the XPBD compliances back to EI/GJ/EA", () => {
    const ell = 0.25;
    const eiCm = eiSiToCm(1.2e-3); // ≈ 12 N·cm² (wire shaft)
    const gjCm = eiSiToCm(9.0e-4); // ≈ 9
    const eaN = 2.5e4;
    const profile = makeProfile({ ellCm: ell, rodRadius: 0.05, eiCm, gjCm, eaN, muStatic: 0.1, muKinetic: 0.05, muRoll: 0.05, muIo: 0.06 });
    const m = elemMatFromProfile(profile, ell);
    expect(m.EIy).toBeCloseTo(eiCm, 6);
    expect(m.EIz).toBeCloseTo(eiCm, 6);
    expect(m.GJ).toBeCloseTo(gjCm, 6);
    expect(m.EA).toBeCloseTo(eaN, 3);
  });

  it("recovers the graded guidewire field: stiff shaft, floppy tip, GJ≈0.77·EI", () => {
    const ell = 0.25;
    const field = buildGuidewireField(80, ell, { tipSegments: 6, transitionSegments: 12, tipCurvature: 0.22 });
    const mats = buildElemMats(field, new Float64Array(80).fill(ell));
    // perSegment[0] is the proximal SHAFT; the distal end (high index) is the floppy tip
    const shaft = mats[0];
    const tip = mats[mats.length - 1];
    expect(shaft.EIy).toBeCloseTo(eiSiToCm(1.2e-3), 4); // ≈ 12
    expect(tip.EIy).toBeCloseTo(eiSiToCm(1.0e-5), 6); // ≈ 0.1
    expect(shaft.EIy).toBeGreaterThan(tip.EIy * 50); // stiff shaft ≫ floppy tip
    // GJ ≈ 0.77·EI per the region table (gjCm = 0.75·eiCm there)
    expect(shaft.GJ / shaft.EIy).toBeCloseTo(0.75, 1);
  });
});

describe("beamfem integration — precurve κ0 is RAW RADIANS (the FATAL fix, no 2·asin doubling)", () => {
  it("κ0 = steer·restCurvature, scaled linearly by steer, not asin-inflated", () => {
    const profile = makeProfile({
      ellCm: 0.25,
      rodRadius: 0.05,
      eiCm: 0.1,
      gjCm: 0.075,
      eaN: 1e4,
      restCurvature: new Vector3(0.22, 0, 0), // raw radians (the stored convention)
      muStatic: 0.08,
      muKinetic: 0.04,
      muRoll: 0.04,
      muIo: 0.06
    });
    const full = kappa0ForElement(profile, 1);
    const half = kappa0ForElement(profile, 0.5);
    expect(full.x).toBeCloseTo(0.22, 9); // exactly the stored radians, NOT 2·asin(sin(0.11))≈0.44
    expect(half.x).toBeCloseTo(0.11, 9); // linear in steer
    expect(full.x).not.toBeCloseTo(0.44, 2); // explicitly NOT doubled
  });
});

describe("beamfem integration — segment ↔ nodal frame bridge", () => {
  it("round-trips a uniform field and recovers a smooth twist gradient", () => {
    // n=5 nodes, 4 segments, identity frames → nodal frames identity
    const segQ = Array.from({ length: 4 }, () => new Quaternion());
    const nodeQ = nodalFramesFromSegments(segQ);
    expect(nodeQ.length).toBe(5);
    for (const q of nodeQ) expect(q.length()).toBeCloseTo(1, 9);
    // a twist gradient on segments → nodal frames interpolate it monotonically
    for (let j = 0; j < 4; j++) {
      const a = (j + 1) * 0.1;
      segQ[j].set(0, 0, Math.sin(a / 2), Math.cos(a / 2));
    }
    const nq = nodalFramesFromSegments(segQ);
    const twist = (q: Quaternion) => 2 * Math.atan2(q.z, q.w);
    for (let i = 0; i < nq.length - 1; i++) expect(twist(nq[i])).toBeLessThanOrEqual(twist(nq[i + 1]) + 1e-9);
    // segment-from-nodal is a (smoothing) bridge, not an exact inverse: it must stay normalized and
    // preserve the monotonic twist gradient + bracket the original range — that is all the integration
    // needs (the beam owns nodal frames; segment frames are derived for coax/diagnostics).
    const back = segmentFramesFromNodal(nq);
    expect(back.length).toBe(4);
    for (const q of back) expect(q.length()).toBeCloseTo(1, 9);
    for (let j = 0; j < back.length - 1; j++) expect(twist(back[j])).toBeLessThanOrEqual(twist(back[j + 1]) + 1e-9);
    expect(twist(back[0])).toBeGreaterThan(twist(segQ[0]) - 1e-6);
    expect(twist(back[back.length - 1])).toBeLessThan(twist(segQ[segQ.length - 1]) + 1e-6);
  });

  it("RED BASELINE: repeated segment↔nodal frame bridging does not bleed a twist gradient", () => {
    let segQ = Array.from({ length: 8 }, (_, j) => {
      const a = (j + 1) * 0.12;
      return new Quaternion(0, 0, Math.sin(a / 2), Math.cos(a / 2));
    });
    const twist = (q: Quaternion) => 2 * Math.atan2(q.z, q.w);
    const initialSpan = twist(segQ[segQ.length - 1]) - twist(segQ[0]);
    for (let r = 0; r < 20; r++) segQ = segmentFramesFromNodal(nodalFramesFromSegments(segQ));
    const finalSpan = twist(segQ[segQ.length - 1]) - twist(segQ[0]);
    expect(finalSpan / initialSpan).toBeGreaterThan(0.95);
  });
});
