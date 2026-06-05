import { describe, expect, it } from "vitest";
import { alphaBend, alphaStretch, eiSiToCm, kappaSiToCm } from "./units";
import { buildGuidewireField, buildSheathField } from "./material";

describe("units converters", () => {
  it("eiSiToCm scales N·m² → N·cm² by 1e4", () => {
    expect(eiSiToCm(1)).toBe(1e4);
    expect(eiSiToCm(2.5e-5)).toBeCloseTo(0.25, 12);
  });

  it("alphaBend is dimensionless and convention-consistent (factor of 4)", () => {
    // α_b = ℓ/(4·EI). For ℓ=0.25 cm and EI=0.25 N·cm² ⇒ 0.25/1 = 0.25.
    expect(alphaBend(0.25, 0.25)).toBeCloseTo(0.25, 12);
    // dimensionless invariance: scaling ℓ and EI together leaves α_b unchanged
    expect(alphaBend(0.5, 0.5)).toBeCloseTo(alphaBend(0.25, 0.25), 12);
  });

  it("alphaStretch = ℓ/EA scales ×100 going from metres to centimetres", () => {
    // Same EA, but ℓ expressed in cm is 100× the metre value ⇒ α_stretch is 100× larger.
    const eaN = 2e4;
    const ellM = 0.0075; // 7.5 mm in metres
    const ellCm = 0.75; // 7.5 mm in cm
    expect(alphaStretch(ellCm, eaN) / alphaStretch(ellM, eaN)).toBeCloseTo(100, 9);
  });

  it("kappaSiToCm divides 1/m by 100", () => {
    expect(kappaSiToCm(39)).toBeCloseTo(0.39, 9);
  });
});

describe("graded material field", () => {
  it("orders bend compliance: floppy tip ≫ transition ≫ stiff shaft", () => {
    const segs = 80;
    const ell = 20 / segs;
    const f = buildGuidewireField(segs, ell, { tipSegments: 8, transitionSegments: 6 });
    const tip = f.perSegment[segs - 1]; // distal tip segment
    const transition = f.perSegment[segs - 1 - 10]; // inside the transition band
    const shaft = f.perSegment[0]; // proximal shaft
    expect(tip.alphaBend1).toBeGreaterThan(transition.alphaBend1);
    expect(transition.alphaBend1).toBeGreaterThan(shaft.alphaBend1);
    // and twist follows the same grading
    expect(tip.alphaTwist).toBeGreaterThan(shaft.alphaTwist);
  });

  it("a sheath is stiffer (lower bend compliance) and fatter than a guidewire shaft", () => {
    const ell = 0.25;
    const wire = buildGuidewireField(80, ell).perSegment[0]; // wire shaft
    const sheath = buildSheathField(80, ell).perSegment[0];
    expect(sheath.alphaBend1).toBeLessThan(wire.alphaBend1);
    expect(sheath.rodRadius).toBeGreaterThan(wire.rodRadius);
  });

  it("advection-safe: prepending shaft material does not smear the distal tip profile", () => {
    // The Lagrangian field is built distally-anchored: the tip occupies the LAST
    // tipSegments entries regardless of how much proximal shaft exists. Growing the rod
    // (more segments = more proximal shaft) must leave the tip α/curvature untouched.
    const ell = 0.25;
    const tipCurvature = 0.2;
    const shortF = buildGuidewireField(40, ell, { tipSegments: 8, transitionSegments: 6, tipCurvature });
    const longF = buildGuidewireField(120, ell, { tipSegments: 8, transitionSegments: 6, tipCurvature });
    for (let k = 0; k < 8; k++) {
      const a = shortF.perSegment[shortF.perSegment.length - 1 - k];
      const b = longF.perSegment[longF.perSegment.length - 1 - k];
      expect(b.alphaBend1).toBeCloseTo(a.alphaBend1, 12);
      expect(b.restCurvature.x).toBeCloseTo(a.restCurvature.x, 12);
    }
    // and the tip carries the commanded precurve, the shaft does not
    expect(longF.perSegment[longF.perSegment.length - 1].restCurvature.x).toBeCloseTo(tipCurvature, 12);
    expect(longF.perSegment[0].restCurvature.x).toBe(0);
  });

  it("keeps the shaped precurve short while the distal tip remains genuinely floppy", () => {
    const ell = 0.25;
    const tipCurvature = 0.1;
    const f = buildGuidewireField(80, ell, { tipSegments: 4, transitionSegments: 4, tipCurvature });
    const curved = f.perSegment.filter((s) => Math.abs(s.restCurvature.x) > 0).length;
    const tip = f.perSegment[f.perSegment.length - 1];
    const transition = f.perSegment[f.perSegment.length - 1 - 5];
    const shaft = f.perSegment[0];

    expect(curved).toBe(4);
    expect(tip.restCurvature.x).toBeCloseTo(tipCurvature, 12);
    expect(f.perSegment[f.perSegment.length - 5].restCurvature.x).toBe(0);
    // Compliance is inverse EI: a 0.1 N*cm^2 floppy tip vs a 12 N*cm^2 shaft is ~120x softer.
    expect(tip.alphaBend1 / shaft.alphaBend1).toBeGreaterThan(80);
    expect(tip.alphaBend1 / shaft.alphaBend1).toBeLessThan(160);
    expect(transition.alphaBend1 / shaft.alphaBend1).toBeGreaterThan(2);
    expect(transition.alphaBend1 / shaft.alphaBend1).toBeLessThan(8);
  });
});
