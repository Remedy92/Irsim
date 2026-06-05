import { Vector3 } from "three";

/**
 * EI-SCALED GLOBAL SHAFT FAIRING SOLVER.
 *
 * The Gauss-Seidel XPBD bend solve propagates bending only ~one node per iteration (Deul et al.
 * 2018), so an 80-100 node stiff rod under-converges its distributed bend in a real-time iteration
 * budget. This helper adds one global, EI-scaled centreline fairing pass for the SHAFT. It finds the
 * centreline that minimises
 *
 *     E(x) = Σ_i (m_i/2)·|x_i − x̂_i|²              (stay near the predicted/contacted position)
 *          + Σ_i (k_i/2)·|x_{i−1} − 2x_i + x_{i+1}|²  (Euler-elastica bending energy ∝ EI·κ²)
 *
 * The minimiser solves the linear system (M + Bᵀ K B) x = M x̂, where B is the discrete
 * second-difference (curvature) operator. M + BᵀKB is a SYMMETRIC POSITIVE-DEFINITE PENTADIAGONAL
 * matrix, so a banded Cholesky solves it exactly in O(N). In the live rod it is used as a pragmatic
 * smoothing/stability pass, then stretch and contact are re-projected by the existing XPBD solver.
 * It improves the felt shaft support, but it is not a calibrated replacement for a direct/dynamic
 * Cosserat or beam solve.
 *
 * Bending is kept straight-preferring here (rest second-difference 0). The pre-shaped distal TIP
 * keeps its rest curvature / steering through the existing quaternion bend-twist; callers exclude the
 * tip nodes from the beam stiffener (per-node k_i = 0 there) so the two mechanisms don't fight.
 *
 * Allocation: the solver works per scalar coordinate over caller-provided scratch arrays; one set is
 * allocated lazily and reused. UNITS: centimetres (consistent with the rest of the sim).
 */

/** Reusable banded-Cholesky workspace, grown as the rod grows. */
interface BeamWork {
  n: number;
  // assembled lower band of A = M + BᵀKB : a0=diag, a1=A[i,i-1], a2=A[i,i-2]
  a0: Float64Array;
  a1: Float64Array;
  a2: Float64Array;
  // Cholesky lower factors (same banded layout)
  l0: Float64Array;
  l1: Float64Array;
  l2: Float64Array;
  // per-coordinate RHS / solution + intermediate
  bx: Float64Array;
  by: Float64Array;
  bz: Float64Array;
  yx: Float64Array;
  yy: Float64Array;
  yz: Float64Array;
}

function makeWork(n: number): BeamWork {
  return {
    n,
    a0: new Float64Array(n),
    a1: new Float64Array(n),
    a2: new Float64Array(n),
    l0: new Float64Array(n),
    l1: new Float64Array(n),
    l2: new Float64Array(n),
    bx: new Float64Array(n),
    by: new Float64Array(n),
    bz: new Float64Array(n),
    yx: new Float64Array(n),
    yy: new Float64Array(n),
    yz: new Float64Array(n)
  };
}

/**
 * One global EI-scaled fairing solve, in place on `x`.
 *
 * @param x         particle positions (length n); the proximal `fixedPrefix` nodes are held as hard
 *                  Dirichlet anchors (the moving insertion boundary + first segment direction).
 * @param k         per-node bending stiffness k_i ≥ 0 (cm-unit; ∝ EI). 0 disables bending at that
 *                  node — set 0 on the pre-shaped tip so the quaternion bend owns the precurve there.
 * @param dataWeight m_i: how strongly node i stays at its predicted/contacted position (>0). Larger
 *                  ⇒ stiffer adherence to contact; the felt bending stiffness is the ratio k/m.
 * @param fixedPrefix number of proximal nodes pinned (≥1; the clamp needs ≥2 for a real slope BC).
 */
export class BeamSolver {
  private work: BeamWork | null = null;

  solve(x: Vector3[], k: number[], dataWeight: number, fixedPrefix: number, d0?: (Vector3 | null)[]): void {
    const n = x.length;
    if (n < fixedPrefix + 2 || n < 4) return; // nothing meaningful to bend
    if (!this.work || this.work.n < n) this.work = makeWork(Math.max(n, (this.work?.n ?? 0) * 2));
    const w = this.work;
    const { a0, a1, a2, l0, l1, l2, bx, by, bz, yx, yy, yz } = w;

    // ---- assemble A = M + BᵀKB (lower band) and RHS b = M·x̂ + k·Dᵀd0 ----
    for (let i = 0; i < n; i++) {
      a0[i] = dataWeight;
      a1[i] = 0;
      a2[i] = 0;
      bx[i] = dataWeight * x[i].x;
      by[i] = dataWeight * x[i].y;
      bz[i] = dataWeight * x[i].z;
    }
    // scatter each interior second-difference stencil [1,-2,1] at nodes (i-1,i,i+1), weighted by k_i
    // (use the middle node's k). Hessian contribution is k·(coef ⊗ coef); the REST second-difference
    // d0_i (the curvature the bend prefers — 0 for straight, or the FAIRED current curvature so only
    // high-frequency wiggle is penalised and the lumen-following large curves are preserved) adds a
    // RHS term k·coef·d0_i. Only the lower triangle (p ≥ q) of A is stored.
    const coef = [1, -2, 1];
    for (let i = 1; i < n - 1; i++) {
      const ki = k[i];
      if (ki <= 0) continue;
      const idx = [i - 1, i, i + 1];
      const t = d0 ? d0[i] : null;
      for (let p = 0; p < 3; p++) {
        const ip = idx[p];
        if (t) {
          bx[ip] += ki * coef[p] * t.x;
          by[ip] += ki * coef[p] * t.y;
          bz[ip] += ki * coef[p] * t.z;
        }
        for (let q = 0; q < 3; q++) {
          const iq = idx[q];
          if (ip < iq) continue; // lower triangle only
          const v = ki * coef[p] * coef[q];
          const d = ip - iq;
          if (d === 0) a0[ip] += v;
          else if (d === 1) a1[ip] += v;
          else if (d === 2) a2[ip] += v;
        }
      }
    }

    // ---- Dirichlet: pin the proximal `fixedPrefix` nodes to their current position ----
    // move their coupling into the RHS of the free rows, then make the pinned rows identity.
    for (let j = fixedPrefix; j < n; j++) {
      if (j - 1 < fixedPrefix) {
        bx[j] -= a1[j] * x[j - 1].x;
        by[j] -= a1[j] * x[j - 1].y;
        bz[j] -= a1[j] * x[j - 1].z;
        a1[j] = 0;
      }
      if (j - 2 < fixedPrefix) {
        bx[j] -= a2[j] * x[j - 2].x;
        by[j] -= a2[j] * x[j - 2].y;
        bz[j] -= a2[j] * x[j - 2].z;
        a2[j] = 0;
      }
    }
    for (let f = 0; f < fixedPrefix; f++) {
      a0[f] = 1;
      a1[f] = 0;
      a2[f] = 0;
      bx[f] = x[f].x;
      by[f] = x[f].y;
      bz[f] = x[f].z;
    }

    // ---- banded Cholesky A = L Lᵀ (bandwidth 2) ----
    for (let i = 0; i < n; i++) {
      const l2i = i >= 2 ? a2[i] / l0[i - 2] : 0;
      const l1i = i >= 1 ? (a1[i] - (i >= 2 ? l2i * l1[i - 1] : 0)) / l0[i - 1] : 0;
      let diag = a0[i] - l1i * l1i - l2i * l2i;
      if (diag < 1e-12) diag = 1e-12; // guard (SPD by construction, but keep numerically safe)
      l0[i] = Math.sqrt(diag);
      l1[i] = l1i;
      l2[i] = l2i;
    }

    // ---- forward solve L y = b, then back solve Lᵀ x = y (per coordinate) ----
    for (let i = 0; i < n; i++) {
      const inv = 1 / l0[i];
      yx[i] = (bx[i] - (i >= 1 ? l1[i] * yx[i - 1] : 0) - (i >= 2 ? l2[i] * yx[i - 2] : 0)) * inv;
      yy[i] = (by[i] - (i >= 1 ? l1[i] * yy[i - 1] : 0) - (i >= 2 ? l2[i] * yy[i - 2] : 0)) * inv;
      yz[i] = (bz[i] - (i >= 1 ? l1[i] * yz[i - 1] : 0) - (i >= 2 ? l2[i] * yz[i - 2] : 0)) * inv;
    }
    for (let i = n - 1; i >= 0; i--) {
      const inv = 1 / l0[i];
      const nx = yx[i] - (i + 1 < n ? l1[i + 1] * x[i + 1].x : 0) - (i + 2 < n ? l2[i + 2] * x[i + 2].x : 0);
      const ny = yy[i] - (i + 1 < n ? l1[i + 1] * x[i + 1].y : 0) - (i + 2 < n ? l2[i + 2] * x[i + 2].y : 0);
      const nz = yz[i] - (i + 1 < n ? l1[i + 1] * x[i + 1].z : 0) - (i + 2 < n ? l2[i + 2] * x[i + 2].z : 0);
      x[i].set(nx * inv, ny * inv, nz * inv);
    }
  }
}
