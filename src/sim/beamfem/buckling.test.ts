import { describe, expect, it } from "vitest";
import { cantileverTipDeflection, geoSignFingerprint, numericPcr } from "./buckling";

/**
 * PHASE-1 GATE (docs/physics-design-dynamic-corotational-beam.md §1.5). The highest-risk gate of the
 * rewrite: it locks the local stiffness and the geometric-stiffness SIGN against analytic targets.
 * Dynamics and contact MUST NOT proceed until every test here is green.
 */

describe("beamfem buckling gate — cantilever (validates K_mat)", () => {
  // Euler-Bernoulli cubic shape functions are EXACT for a tip-loaded cantilever, so δ should match
  // F·L³/(3EI) to solver precision regardless of element count.
  for (const EI of [0.1, 5, 12, 47]) {
    it(`δ = F·L³/(3EI) within 2% for EI=${EI} N·cm²`, () => {
      const L = 5;
      const F = 0.05;
      const M = 4;
      const delta = cantileverTipDeflection(EI, L, M, F);
      const analytic = (F * L * L * L) / (3 * EI);
      expect(Math.abs(delta - analytic) / analytic).toBeLessThan(0.02);
    });
  }

  it("deflection scales linearly with load (small-deflection linearity)", () => {
    const EI = 12, L = 5, M = 4;
    const d1 = cantileverTipDeflection(EI, L, M, 0.05);
    const d2 = cantileverTipDeflection(EI, L, M, 0.10);
    expect(d2 / d1).toBeCloseTo(2, 6);
  });
});

describe("beamfem buckling gate — Euler P_cr (validates K_geo magnitude)", () => {
  it("P_cr → π²EI/(2L)² within 5%, monotone from above on mesh refinement", () => {
    const EI = 12;
    const L = 10;
    const analytic = (Math.PI * Math.PI * EI) / (4 * L * L); // fixed-free, K=2
    const p8 = numericPcr(EI, L, 2, 8);
    const p16 = numericPcr(EI, L, 2, 16);
    const p32 = numericPcr(EI, L, 2, 32);
    // converges from ABOVE (consistent geometric stiffness gives an upper bound)
    expect(p8).toBeGreaterThan(p16 - 1e-6);
    expect(p16).toBeGreaterThan(p32 - 1e-6);
    expect(p32).toBeGreaterThan(analytic - 1e-6);
    // finest mesh within 5% (in practice <1%)
    expect(Math.abs(p32 - analytic) / analytic).toBeLessThan(0.05);
  });

  it("P_cr scales with EI and 1/L² (Lunderquist vs working wire)", () => {
    const Lun = numericPcr(47, 10, 2, 24);
    const wire = numericPcr(12, 10, 2, 24);
    expect(Lun / wire).toBeCloseTo(47 / 12, 1); // ∝ EI
    const short = numericPcr(12, 5, 2, 24);
    const long = numericPcr(12, 10, 2, 24);
    expect(short / long).toBeCloseTo(4, 1); // ∝ 1/L²
  });
});

describe("beamfem buckling gate — K_geo SIGN fingerprint (locks the buckling-critical sign)", () => {
  it("compression buckles, tension never does", () => {
    const fp = geoSignFingerprint(12, 10, 16);
    expect(fp.compressionBuckles).toBe(true);
    expect(fp.tensionBuckles).toBe(false);
  });
});
