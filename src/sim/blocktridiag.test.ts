import { describe, expect, it } from "vitest";
import { BlockTridiagSolver } from "./blocktridiag";

/**
 * Unit tests for the generic block-tridiagonal direct solver. The kernel is verified to MACHINE
 * PRECISION against an independent dense Gaussian-elimination reference (the same discipline
 * beam.test.ts uses for the banded Cholesky), across block sizes B=1..6 and various N, including the
 * strongly diagonally-dominant regime the real beam tangent (M/Δt² mass term) sits in. The beam
 * physics depends on this being exact, so it is tested in isolation before anything is built on it.
 */

// ---- deterministic PRNG so the test is reproducible (no Math.random flakiness) ----
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Build a random block-tridiagonal system; if `dominant`, make diagonal blocks strongly dominant. */
function randomSystem(n: number, b: number, rnd: () => number, dominant: boolean) {
  const lower: Float64Array[] = [];
  const diag: Float64Array[] = [];
  const upper: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    const lo = new Float64Array(b * b);
    const di = new Float64Array(b * b);
    const up = new Float64Array(b * b);
    for (let k = 0; k < b * b; k++) {
      lo[k] = (rnd() - 0.5) * 2;
      di[k] = (rnd() - 0.5) * 2;
      up[k] = (rnd() - 0.5) * 2;
    }
    // boost the diagonal so the system is well-conditioned (mirrors the real M/Δt² + K tangent)
    const boost = dominant ? 10 * b : 3 * b;
    for (let r = 0; r < b; r++) di[r * b + r] += boost;
    lower.push(lo);
    diag.push(di);
    upper.push(up);
  }
  return { lower, diag, upper };
}

/** Dense reference: assemble the full N·B square matrix and solve by Gaussian elimination w/ pivot. */
function denseSolve(
  n: number,
  b: number,
  lower: Float64Array[],
  diag: Float64Array[],
  upper: Float64Array[],
  rhs: Float64Array
): Float64Array {
  const m = n * b;
  const A = new Float64Array(m * m);
  const set = (blk: Float64Array, bi: number, bj: number) => {
    for (let r = 0; r < b; r++) for (let c = 0; c < b; c++) A[(bi * b + r) * m + (bj * b + c)] = blk[r * b + c];
  };
  for (let i = 0; i < n; i++) {
    set(diag[i], i, i);
    if (i > 0) set(lower[i], i, i - 1);
    if (i < n - 1) set(upper[i], i, i + 1);
  }
  // Gaussian elimination with partial pivoting on the augmented system
  const x = new Float64Array(rhs); // working RHS copy
  const piv = new Int32Array(m);
  for (let i = 0; i < m; i++) piv[i] = i;
  for (let k = 0; k < m; k++) {
    let p = k;
    let max = Math.abs(A[k * m + k]);
    for (let r = k + 1; r < m; r++) {
      const v = Math.abs(A[r * m + k]);
      if (v > max) {
        max = v;
        p = r;
      }
    }
    if (p !== k) {
      for (let c = 0; c < m; c++) {
        const t = A[k * m + c];
        A[k * m + c] = A[p * m + c];
        A[p * m + c] = t;
      }
      const tb = x[k];
      x[k] = x[p];
      x[p] = tb;
    }
    const akk = A[k * m + k];
    for (let r = k + 1; r < m; r++) {
      const f = A[r * m + k] / akk;
      for (let c = k; c < m; c++) A[r * m + c] -= f * A[k * m + c];
      x[r] -= f * x[k];
    }
  }
  const out = new Float64Array(m);
  for (let i = m - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < m; j++) s -= A[i * m + j] * out[j];
    out[i] = s / A[i * m + i];
  }
  return out;
}

function maxAbsDiff(a: Float64Array, b: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** Residual ‖A·x − rhs‖∞ computed block-wise, an independent correctness check. */
function residualInf(
  n: number,
  b: number,
  lower: Float64Array[],
  diag: Float64Array[],
  upper: Float64Array[],
  x: Float64Array,
  rhs: Float64Array
): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < b; r++) {
      let s = 0;
      for (let c = 0; c < b; c++) {
        s += diag[i][r * b + c] * x[i * b + c];
        if (i > 0) s += lower[i][r * b + c] * x[(i - 1) * b + c];
        if (i < n - 1) s += upper[i][r * b + c] * x[(i + 1) * b + c];
      }
      m = Math.max(m, Math.abs(s - rhs[i * b + r]));
    }
  }
  return m;
}

describe("BlockTridiagSolver", () => {
  const solver = new BlockTridiagSolver();

  it("matches a dense reference to machine precision across block sizes and N", () => {
    const rnd = lcg(12345);
    for (const b of [1, 2, 3, 6]) {
      for (const n of [1, 2, 5, 20, 64]) {
        const { lower, diag, upper } = randomSystem(n, b, rnd, false);
        const rhs = new Float64Array(n * b);
        for (let i = 0; i < rhs.length; i++) rhs[i] = (rnd() - 0.5) * 4;
        const out = new Float64Array(n * b);
        const ok = solver.solve(n, b, lower, diag, upper, rhs, out);
        expect(ok).toBe(true);
        const ref = denseSolve(n, b, lower, diag, upper, rhs);
        const scale = Math.max(1, Math.max(...Array.from(ref, Math.abs)));
        expect(maxAbsDiff(out, ref) / scale).toBeLessThan(1e-9);
        // independent residual check
        expect(residualInf(n, b, lower, diag, upper, out, rhs)).toBeLessThan(1e-7 * scale);
      }
    }
  });

  it("is exact on a strongly diagonally-dominant system (the real beam-tangent regime)", () => {
    const rnd = lcg(98765);
    const b = 6;
    const n = 100;
    const { lower, diag, upper } = randomSystem(n, b, rnd, true);
    const rhs = new Float64Array(n * b);
    for (let i = 0; i < rhs.length; i++) rhs[i] = (rnd() - 0.5) * 4;
    const out = new Float64Array(n * b);
    expect(solver.solve(n, b, lower, diag, upper, rhs, out)).toBe(true);
    expect(residualInf(n, b, lower, diag, upper, out, rhs)).toBeLessThan(1e-9);
  });

  it("solves a scalar (B=1) tridiagonal system identically to the classic Thomas algorithm", () => {
    // 1D Poisson-like: [-1, 2, -1] tridiagonal, rhs of ones → known symmetric hump
    const n = 7;
    const b = 1;
    const lower: Float64Array[] = [];
    const diag: Float64Array[] = [];
    const upper: Float64Array[] = [];
    for (let i = 0; i < n; i++) {
      lower.push(new Float64Array([i === 0 ? 0 : -1]));
      diag.push(new Float64Array([2]));
      upper.push(new Float64Array([i === n - 1 ? 0 : -1]));
    }
    const rhs = new Float64Array(n).fill(1);
    const out = new Float64Array(n);
    expect(solver.solve(n, b, lower, diag, upper, rhs, out)).toBe(true);
    const ref = denseSolve(n, b, lower, diag, upper, rhs);
    expect(maxAbsDiff(out, ref)).toBeLessThan(1e-12);
    // symmetric about the centre
    for (let i = 0; i < n; i++) expect(Math.abs(out[i] - out[n - 1 - i])).toBeLessThan(1e-12);
  });

  it("reports failure on a singular pivot block instead of returning garbage", () => {
    const n = 3;
    const b = 2;
    const lower = [new Float64Array(4), new Float64Array(4), new Float64Array(4)];
    const upper = [new Float64Array(4), new Float64Array(4), new Float64Array(4)];
    // first diagonal block is all zeros → singular
    const diag = [new Float64Array(4), new Float64Array([1, 0, 0, 1]), new Float64Array([1, 0, 0, 1])];
    const rhs = new Float64Array(n * b).fill(1);
    const out = new Float64Array(n * b);
    expect(solver.solve(n, b, lower, diag, upper, rhs, out)).toBe(false);
  });

  it("reuses scratch across repeated solves without corruption (grow-only buffers)", () => {
    const rnd = lcg(555);
    const b = 3;
    for (let t = 0; t < 5; t++) {
      const n = 4 + t * 7;
      const { lower, diag, upper } = randomSystem(n, b, rnd, false);
      const rhs = new Float64Array(n * b);
      for (let i = 0; i < rhs.length; i++) rhs[i] = (rnd() - 0.5) * 4;
      const out = new Float64Array(n * b);
      expect(solver.solve(n, b, lower, diag, upper, rhs, out)).toBe(true);
      expect(residualInf(n, b, lower, diag, upper, out, rhs)).toBeLessThan(1e-8);
    }
  });
});
