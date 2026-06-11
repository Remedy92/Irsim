/**
 * BLOCK-TRIDIAGONAL DIRECT SOLVER (block-Thomas / block-LU), O(N) for a chain.
 *
 * The dynamic co-rotational beam solver (docs/physics-design-dynamic-corotational-beam.md) assembles
 * a global tangent that is BLOCK-TRIDIAGONAL: each node carries a B-dimensional DOF block (B=6 for a
 * 3D beam: 3 translation + 3 rotation), and only adjacent nodes couple (each 2-node element touches
 * blocks (i,i) (i,i+1) (i+1,i) (i+1,i+1)). Such a system is solved EXACTLY in one forward + one back
 * sweep — the block generalization of the Thomas algorithm — at cost O(N·B³), i.e. linear in node
 * count. This is what lets an 80-100 node stiff rod equilibrate its distributed bending in ONE solve
 * (a direct factorization), instead of the ~1-node-per-iteration Gauss-Seidel that under-converges a
 * stiff rod in a real-time budget (Deul et al. 2018).
 *
 * This module is deliberately GENERIC (arbitrary block size B, no beam knowledge) so it can be
 * unit-tested to machine precision against a dense reference (blocktridiag.test.ts) before any beam
 * physics depends on it — the kernel is the part that is easy to get subtly wrong and hard to debug
 * once buried under a co-rotational assembly.
 *
 * Robustness: each pivot block is factored by dense LU with PARTIAL PIVOTING (not Cholesky), because
 * the beam tangent is generally NON-symmetric (co-rotational geometric stiffness + contact rows) and
 * not guaranteed SPD. With a real M/Δt² mass term on the diagonal the blocks are strongly
 * diagonally dominant, so this is well-conditioned in practice; pivoting keeps it safe regardless.
 *
 * Storage convention (caller-owned, reused across frames):
 *   - `lower[i]` (B×B, row-major) = block A[i, i-1]   (lower[0] unused)
 *   - `diag[i]`  (B×B, row-major) = block A[i, i]
 *   - `upper[i]` (B×B, row-major) = block A[i, i+1]   (upper[N-1] unused)
 *   - `rhs`/`out` (length N·B)     = stacked B-vectors b_i / x_i
 * All matrices are row-major: element (r,c) is at index r*B + c.
 */

/** Reusable, grow-only scratch for the block-Thomas sweep. */
interface BTDWork {
  n: number;
  b: number;
  /** C'_i = M_i⁻¹ · upper[i], the modified super-diagonal blocks (N × B*B). */
  cPrime: Float64Array[];
  /** d'_i = M_i⁻¹ · (rhs_i − lower[i]·d'_{i-1}), the modified RHS blocks (N × B). */
  dPrime: Float64Array[];
  /** LU factor of the current pivot block M_i (B*B) + its pivot indices. */
  lu: Float64Array;
  piv: Int32Array;
  /** B-vector temporaries (tmpVec2 distinct so luSolveVec is never aliased on its gather). */
  tmpVec: Float64Array;
  tmpVec2: Float64Array;
}

function makeWork(n: number, b: number): BTDWork {
  const cPrime: Float64Array[] = [];
  const dPrime: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    cPrime.push(new Float64Array(b * b));
    dPrime.push(new Float64Array(b));
  }
  return {
    n,
    b,
    cPrime,
    dPrime,
    lu: new Float64Array(b * b),
    piv: new Int32Array(b),
    tmpVec: new Float64Array(b),
    tmpVec2: new Float64Array(b)
  };
}

/**
 * Dense LU factorization with partial pivoting, in place on `a` (B×B row-major).
 * Writes the row-swap pivots into `piv`. Returns false if the block is singular.
 */
function luFactor(a: Float64Array, b: number, piv: Int32Array): boolean {
  for (let i = 0; i < b; i++) piv[i] = i;
  for (let k = 0; k < b; k++) {
    // find pivot row
    let p = k;
    let max = Math.abs(a[k * b + k]);
    for (let r = k + 1; r < b; r++) {
      const v = Math.abs(a[r * b + k]);
      if (v > max) {
        max = v;
        p = r;
      }
    }
    if (max < 1e-300) return false; // singular
    if (p !== k) {
      // swap rows k and p
      for (let c = 0; c < b; c++) {
        const t = a[k * b + c];
        a[k * b + c] = a[p * b + c];
        a[p * b + c] = t;
      }
      const tp = piv[k];
      piv[k] = piv[p];
      piv[p] = tp;
    }
    const akk = a[k * b + k];
    for (let r = k + 1; r < b; r++) {
      const f = a[r * b + k] / akk;
      a[r * b + k] = f;
      for (let c = k + 1; c < b; c++) a[r * b + c] -= f * a[k * b + c];
    }
  }
  return true;
}

/** Solve L U x = P·rhs for a single B-vector, given the LU factor + pivots. Writes into `x`. */
function luSolveVec(lu: Float64Array, b: number, piv: Int32Array, rhs: Float64Array, x: Float64Array): void {
  // apply permutation: y = P·rhs
  for (let i = 0; i < b; i++) x[i] = rhs[piv[i]];
  // forward solve L y = Pb (unit lower)
  for (let i = 0; i < b; i++) {
    let s = x[i];
    for (let j = 0; j < i; j++) s -= lu[i * b + j] * x[j];
    x[i] = s;
  }
  // back solve U x = y
  for (let i = b - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < b; j++) s -= lu[i * b + j] * x[j];
    x[i] = s / lu[i * b + i];
  }
}

/** dst (B×B) = src (B×B), copy. */
function copyMat(src: Float64Array, dst: Float64Array, bb: number): void {
  for (let i = 0; i < bb; i++) dst[i] = src[i];
}

/**
 * O(N) direct solver for a block-tridiagonal system A·x = rhs with N blocks of size B.
 * Allocation-free across calls once warmed (grow-only scratch). Returns false if a pivot block is
 * singular (caller should fall back / regularize); on success `out` holds the stacked solution.
 */
export class BlockTridiagSolver {
  private work: BTDWork | null = null;

  solve(
    n: number,
    b: number,
    lower: Float64Array[],
    diag: Float64Array[],
    upper: Float64Array[],
    rhs: Float64Array,
    out: Float64Array
  ): boolean {
    if (n <= 0) return true;
    if (!this.work || this.work.n < n || this.work.b !== b) this.work = makeWork(Math.max(n, (this.work?.n ?? 0) * 2), b);
    const w = this.work;
    const bb = b * b;

    // ---- forward sweep: build C'_i = M_i⁻¹ upper[i] and d'_i = M_i⁻¹ (rhs_i − lower[i] d'_{i-1}) ----
    // i = 0: M_0 = diag[0]
    copyMat(diag[0], w.lu, bb);
    if (!luFactor(w.lu, b, w.piv)) return false;
    // C'_0 = M_0⁻¹ upper[0]  (skip if n==1)
    if (n > 1) solveMatColumns(w.lu, b, w.piv, upper[0], w.cPrime[0], w.tmpVec, w.tmpVec2);
    // d'_0 = M_0⁻¹ rhs_0
    for (let r = 0; r < b; r++) w.tmpVec[r] = rhs[r];
    luSolveVec(w.lu, b, w.piv, w.tmpVec, w.dPrime[0]);

    for (let i = 1; i < n; i++) {
      // M_i = diag[i] − lower[i] · C'_{i-1}
      matmulSub(diag[i], lower[i], w.cPrime[i - 1], w.lu, b); // w.lu = diag[i] − lower[i]·C'_{i-1}
      if (!luFactor(w.lu, b, w.piv)) return false;
      // rhs_i − lower[i]·d'_{i-1}  → w.tmpVec
      const off = i * b;
      for (let r = 0; r < b; r++) {
        let s = rhs[off + r];
        const lr = r * b;
        for (let c = 0; c < b; c++) s -= lower[i][lr + c] * w.dPrime[i - 1][c];
        w.tmpVec[r] = s;
      }
      luSolveVec(w.lu, b, w.piv, w.tmpVec, w.dPrime[i]);
      // C'_i = M_i⁻¹ upper[i]  (skip for last block)
      if (i < n - 1) solveMatColumns(w.lu, b, w.piv, upper[i], w.cPrime[i], w.tmpVec, w.tmpVec2);
    }

    // ---- back substitution: x_N-1 = d'_N-1 ; x_i = d'_i − C'_i · x_{i+1} ----
    const last = (n - 1) * b;
    for (let r = 0; r < b; r++) out[last + r] = w.dPrime[n - 1][r];
    for (let i = n - 2; i >= 0; i--) {
      const off = i * b;
      const nxt = (i + 1) * b;
      for (let r = 0; r < b; r++) {
        let s = w.dPrime[i][r];
        const cr = r * b;
        for (let c = 0; c < b; c++) s -= w.cPrime[i][cr + c] * out[nxt + c];
        out[off + r] = s;
      }
    }
    return true;
  }
}

/**
 * Solve M·X = Rhs for X (B×B) column by column, given LU(M); writes X (B×B row-major).
 * `colIn`/`colOut` are caller scratch and MUST be distinct arrays (luSolveVec is not alias-safe on
 * its permutation gather).
 */
function solveMatColumns(
  lu: Float64Array,
  b: number,
  piv: Int32Array,
  rhsMat: Float64Array,
  outMat: Float64Array,
  colIn: Float64Array,
  colOut: Float64Array
): void {
  for (let c = 0; c < b; c++) {
    for (let r = 0; r < b; r++) colIn[r] = rhsMat[r * b + c];
    luSolveVec(lu, b, piv, colIn, colOut);
    for (let r = 0; r < b; r++) outMat[r * b + c] = colOut[r];
  }
}

/** out (B×B) = A − L·C  (all B×B row-major). */
function matmulSub(A: Float64Array, L: Float64Array, C: Float64Array, out: Float64Array, b: number): void {
  for (let r = 0; r < b; r++) {
    for (let c = 0; c < b; c++) {
      let s = A[r * b + c];
      const lr = r * b;
      for (let k = 0; k < b; k++) s -= L[lr + k] * C[k * b + c];
      out[r * b + c] = s;
    }
  }
}
