import { Quaternion, Vector3 } from "three";
import { ElemMat, corotKgeoAxial, elementFrame, localStiffness, transformK } from "./element";

/**
 * Headless analytic validation gate for the co-rotational beam element
 * (docs/physics-design-dynamic-corotational-beam.md §1.5, Phase 1).
 *
 * This is the SINGLE highest-risk gate of the whole rewrite: it proves the local linear stiffness
 * (cantilever δ = F·L³/3EI — exact for tip-loaded Euler-Bernoulli elements) and the geometric
 * stiffness SIGN (Euler buckling P_cr = π²EI/(KL)², and a sign-fingerprint that compression buckles
 * while tension never does). No dynamics, no contact — those phases MUST NOT proceed until this is
 * green. UNITS: cm, N·cm² (EI), N (forces/loads).
 *
 * A straight column of `M` elements is built along global +z with identity nodal frames, so each
 * element frame R_e ≈ I and the gate exercises the local matrices + transform together. Node 0 is
 * fully clamped (fixed-free ⇒ effective-length factor K=2).
 */

/** Build a round-section ElemMat (EIy=EIz=EI, GJ given or 0, Kirchhoff Φ=0) for the gate. */
function roundMat(EI: number, opts?: { GJ?: number; EA?: number }): ElemMat {
  return {
    EA: opts?.EA ?? 1e6, // axially near-rigid; large enough not to pollute the bending gate
    EIy: EI,
    EIz: EI,
    GJ: opts?.GJ ?? 0.77 * EI,
    GAsy: 0,
    GAsz: 0,
    kirchhoff: true
  };
}

/** Assemble the global stiffness (and optional unit-tension geometric stiffness) of a z-column. */
function assembleColumn(M: number, ell: number, m: ElemMat, geometric: boolean): Float64Array {
  const n = 6 * (M + 1);
  const K = new Float64Array(n * n);
  const Kloc = new Float64Array(144);
  const Kglob = new Float64Array(144);
  const frame = { Re: new Float64Array(9), ln: 0, e3: new Vector3() };
  const q = new Quaternion(); // identity frames
  for (let e = 0; e < M; e++) {
    const pi = new Vector3(0, 0, e * ell);
    const pj = new Vector3(0, 0, (e + 1) * ell);
    elementFrame(pi, pj, q, q, frame);
    if (geometric) corotKgeoAxial(1, ell, Kloc); // N = +1 (unit tension) per element
    else localStiffness(m, ell, Kloc);
    transformK(Kloc, frame.Re, Kglob);
    // scatter the 12×12 into global DOFs of nodes e and e+1
    const base = [6 * e, 6 * (e + 1)];
    for (let a = 0; a < 12; a++) {
      const ga = base[Math.floor(a / 6)] + (a % 6);
      for (let b = 0; b < 12; b++) {
        const gb = base[Math.floor(b / 6)] + (b % 6);
        K[ga * n + gb] += Kglob[a * 12 + b];
      }
    }
  }
  return K;
}

/** Extract the free-DOF submatrix (drop the first `clamp` rows/cols — node 0 fully clamped). */
function reduce(A: Float64Array, n: number, clamp: number): { R: Float64Array; nf: number } {
  const nf = n - clamp;
  const R = new Float64Array(nf * nf);
  for (let i = 0; i < nf; i++) for (let j = 0; j < nf; j++) R[i * nf + j] = A[(i + clamp) * n + (j + clamp)];
  return { R, nf };
}

/** In-place lower Cholesky; returns false if not positive-definite (a diagonal ≤ tol). */
function choleskySPD(A: Float64Array, n: number, tol = 1e-12): boolean {
  const L = A; // factor in place (caller passes a copy)
  for (let j = 0; j < n; j++) {
    let d = L[j * n + j];
    for (let k = 0; k < j; k++) d -= L[j * n + k] * L[j * n + k];
    if (d <= tol) return false;
    const ljj = Math.sqrt(d);
    L[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let s = L[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = s / ljj;
    }
  }
  return true;
}

/** Solve A x = b for SPD A (A given as its lower-Cholesky factor from choleskySPD). */
function choleskySolve(L: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

/**
 * Tip transverse deflection of a fixed-free cantilever of `Melems` elements, total length `L` (cm),
 * bending EI (N·cm²), tip point load `F` (N) applied transverse (global-x). Should equal F·L³/(3EI)
 * to solver precision (Euler-Bernoulli cubic shape functions are exact for a tip-loaded cantilever).
 */
export function cantileverTipDeflection(EI: number, L: number, Melems: number, F: number): number {
  const ell = L / Melems;
  const n = 6 * (Melems + 1);
  const K = assembleColumn(Melems, ell, roundMat(EI), false);
  const { R, nf } = reduce(K, n, 6); // clamp node 0
  // tip node = Melems; transverse-x DOF global index = 6*Melems + 0; reduced index − 6
  const tipDof = 6 * Melems + 0 - 6;
  const f = new Float64Array(nf);
  f[tipDof] = F;
  const ok = choleskySPD(R, nf);
  if (!ok) throw new Error("cantilever stiffness not SPD — element/assembly bug");
  const u = choleskySolve(R, nf, f);
  return u[tipDof];
}

/** True iff the column tangent K_mat − load·K_g_unit is positive-definite (load>0 ⇒ compression). */
function columnStable(EI: number, ell: number, M: number, load: number): boolean {
  const n = 6 * (M + 1);
  const Kmat = assembleColumn(M, ell, roundMat(EI), false);
  const Kg = assembleColumn(M, ell, roundMat(EI), true); // unit tension
  // K_t = K_mat − load·K_g_unit  (compression load>0 softens; this is the buckling-critical sign)
  for (let i = 0; i < n * n; i++) Kmat[i] -= load * Kg[i];
  const { R, nf } = reduce(Kmat, n, 6);
  return choleskySPD(R, nf);
}

/**
 * Numerically bisected critical compressive load of a fixed-free column. Compared by the gate to the
 * analytic P_cr = π²EI/(Keff·L)². Converges to the analytic value FROM ABOVE as Melems increases.
 */
export function numericPcr(EI: number, L: number, _Keff: number, Melems: number): number {
  const ell = L / Melems;
  // bracket: grow hi until the column loses stability
  let hi = (Math.PI * Math.PI * EI) / (4 * L * L); // analytic fixed-free estimate as a seed
  let guard = 0;
  while (columnStable(EI, ell, Melems, hi) && guard++ < 60) hi *= 1.5;
  let lo = 0;
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi);
    if (columnStable(EI, ell, Melems, mid)) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Sign fingerprint: with the CORRECT geometric-stiffness sign, a large COMPRESSIVE load buckles the
 * column (loses SPD) while an equal TENSILE load never does. A flipped sign inverts this — the
 * cleanest single check that locks the buckling-critical K_geo sign.
 */
export function geoSignFingerprint(EI: number, L: number, Melems: number): { compressionBuckles: boolean; tensionBuckles: boolean } {
  const ell = L / Melems;
  const big = (10 * Math.PI * Math.PI * EI) / (4 * L * L); // well above P_cr
  return {
    compressionBuckles: !columnStable(EI, ell, Melems, big), // load>0 compression ⇒ should buckle
    tensionBuckles: !columnStable(EI, ell, Melems, -big) // load<0 tension ⇒ should NOT buckle
  };
}
