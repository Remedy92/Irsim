import { Quaternion, Vector3 } from "three";
import { BlockTridiagSolver } from "../blocktridiag";
import { ElemMat, corotKgeoAxial, elementFrame, localDeformation, localStiffness } from "./element";
import { LumpedMass } from "./mass";
import { logQuat, mat3, qExpHalf, quatToMat3 } from "./so3";

/**
 * Dynamic implicit co-rotational beam step (docs/physics-design-dynamic-corotational-beam.md §1.6).
 *
 * Backward-Euler in the INCREMENT form (the FATAL fix): unknown δu = [δp, δφ] (world frame), LHS
 * A = ∂R/∂u = K + M/Δt² + a0·M/Δt (+twist whip-guard), RHS b = −R with
 *   R = M/Δt²·(x−xⁿ−Δt·vⁿ) + a0·M/Δt·(x−xⁿ) + f_int − f_ext.
 * The first Newton iter (x=xⁿ) gives b = f_ext − f_int + (M/Δt)·vⁿ; the absolute (2xⁿ−xⁿ⁻¹) form
 * would double-count state and blow up frame 1 (guarded by the free-flight gate).
 *
 * ELASTIC TANGENT K = ∂f_int/∂u is built by a BANDED NUMERICAL JACOBIAN: the co-rotational internal
 * force is banded (perturbing node j touches only elements j−1, j, hence residual nodes j−1, j, j+1),
 * so the full tangent costs O(N) force evaluations — and it is exact to FD precision, capturing the
 * frame-variation (∂R_e/∂u) coupling that an analytic transformK-only tangent omits (which left the
 * cantilever ~12× too stiff and killed twist propagation). The analytic Crisfield/Battini consistent
 * tangent can later drop in as a pure perf optimization with the same A-assembly contract.
 *
 * Rotations: world increment q ← qExpHalf(δφ)⊗q, Φ = logQuat(q⊗conj(qⁿ)), ω = Φ/Δt. Anisotropic body
 * inertia diag(Jb,Jb,Jt) → world J = Jb·I + (Jt−Jb)·ax⊗ax, ax = R(qⁿ)·e3 (twist axis), frozen at qⁿ
 * each substep. Finite GJ + Jt give torsional wind-up/whip; a Kelvin-Voigt dashpot (Jt/τ_ω) on ax
 * bounds the ring.
 */

export interface BeamParams {
  substeps: number;
  /** Rayleigh mass damping a0 = 1/τ (s⁻¹). */
  a0: number;
  /** Rayleigh stiffness damping a1 (s); 0 by default (folded into the numerical tangent if used). */
  a1: number;
  /** Twist whip-guard dashpot time constant τ_ω (s); ~0.10. 0 disables. */
  tauOmega: number;
  /** Newton iterations per substep. */
  maxNewton: number;
  /** Static (quasi-static) solve: drop all inertia/damping; Newton on f_int = f_ext. */
  static?: boolean;
}

export interface BeamState {
  n: number;
  x: Vector3[];
  q: Quaternion[];
  v: Vector3[];
  omega: Vector3[];
  restLen: Float64Array;
  elem: ElemMat[];
  mass: LumpedMass;
  fixedPrefix: number;
  fext?: Vector3[];
  mext?: Vector3[];
}

export interface BeamPerfCounters {
  tangentAssemblies: number;
  elementForceEvals: number;
}

export interface BeamSubstepSnapshot {
  /** Active node count captured at the beginning of the substep. */
  n: number;
  x: Vector3[];
  q: Quaternion[];
  v: Vector3[];
  omega: Vector3[];
}

const perfCounters: BeamPerfCounters = {
  tangentAssemblies: 0,
  elementForceEvals: 0
};

export function resetBeamPerfCounters(): void {
  perfCounters.tangentAssemblies = 0;
  perfCounters.elementForceEvals = 0;
}

export function readBeamPerfCounters(): BeamPerfCounters {
  return { ...perfCounters };
}

const FD = 1e-6; // finite-difference step for the numerical tangent

/** Advance the beam by one frame of `dtFrame` seconds. */
export function stepBeam(state: BeamState, dtFrame: number, params: BeamParams, solver: BlockTridiagSolver): void {
  const S = Math.max(1, params.substeps);
  const dts = dtFrame / S;
  const snap = snapshotFor(state);
  for (let s = 0; s < S; s++) substep(state, dts, params, solver, snap);
}

/**
 * One backward-Euler substep of duration `dts` (the integration driver calls this once per host
 * substep so it can interleave contact between the beam dynamics and the velocity finalize). After
 * this returns, positions/frames/velocities reflect the elastic dynamics; a caller that projects
 * contact afterward should re-finalize velocities from its own pre-substep snapshot.
 */
export function beamSubstep(state: BeamState, dts: number, params: BeamParams, solver: BlockTridiagSolver): void {
  substep(state, dts, params, solver, snapshotFor(state));
}

/**
 * One backward-Euler substep with a STAGGERED contact callback (Phase 3b containment): the snapshot
 * (xⁿ, vⁿ) is taken once, then each round does {beam Newton solve, `contact()`} so the elastic
 * tangent PROPAGATES the contact projection (a stiff shaft rides the inside of a curve instead of
 * coiling out of the lumen). `contact()` may move state.x / re-detect contacts freely; velocities are
 * finalized ONCE at the end from the snapshot, so the contact displacement is included. params.maxNewton
 * is the number of staggered rounds.
 */
export function beamSubstepWithContact(
  state: BeamState,
  dts: number,
  params: BeamParams,
  solver: BlockTridiagSolver,
  contact: () => void
): void {
  const snap = snapshotFor(state);
  beginBeamSubstep(state, snap);
  const rounds = Math.max(1, params.maxNewton);
  // Full Newton each staggered round (rebuild tangent + residual, then project contact). A frozen
  // tangent was tried for perf but the re-solve overshoots once contact moves nodes (the numerical
  // tangent goes stale) — the correct + cheap fix is the analytic consistent tangent, pending.
  for (let it = 0; it < rounds; it++) {
    beamNewtonRound(state, dts, params, solver, snap);
    contact();
  }
  finalizeBeamSubstep(state, snap, dts);
}

export function createBeamSubstepSnapshot(capacity = 0): BeamSubstepSnapshot {
  const snap: BeamSubstepSnapshot = { n: 0, x: [], q: [], v: [], omega: [] };
  ensureSnapshotCapacity(snap, capacity);
  return snap;
}

/** Capture xⁿ/qⁿ/vⁿ/ωⁿ once, before Newton/contact rounds move the beam. */
export function beginBeamSubstep(state: BeamState, snap: BeamSubstepSnapshot): void {
  const n = state.n;
  ensureScratch(n);
  ensureSnapshotCapacity(snap, n);
  snap.n = n;
  for (let i = 0; i < n; i++) {
    snap.x[i].copy(state.x[i]);
    snap.q[i].copy(state.q[i]);
    snap.v[i].copy(state.v[i]);
    snap.omega[i].copy(state.omega[i]);
  }
}

/** One Newton round: rebuild tangent, solve residual, and update positions/frames only. */
export function beamNewtonRound(
  state: BeamState,
  dts: number,
  params: BeamParams,
  solver: BlockTridiagSolver,
  snap: BeamSubstepSnapshot
): number {
  ensureScratch(state.n);
  assertSnapshotMatches(state, snap);
  return newtonIter(state, dts, params, solver, snap);
}

/** Finalize velocities from the same pre-substep snapshot after all projections are complete. */
export function finalizeBeamSubstep(state: BeamState, snap: BeamSubstepSnapshot, dts: number): void {
  assertSnapshotMatches(state, snap);
  for (let i = 0; i < state.n; i++) {
    state.v[i].subVectors(state.x[i], snap.x[i]).multiplyScalar(1 / dts);
    logQuat(_qrel.copy(state.q[i]).multiply(_qtmp.copy(snap.q[i]).conjugate()), _phi);
    state.omega[i].copy(_phi).multiplyScalar(1 / dts);
  }
}

function substep(
  state: BeamState,
  dts: number,
  params: BeamParams,
  solver: BlockTridiagSolver,
  snap: BeamSubstepSnapshot
): void {
  beginBeamSubstep(state, snap);
  for (let it = 0; it < params.maxNewton; it++) {
    const res = beamNewtonRound(state, dts, params, solver, snap);
    if (res < 1e-10) break;
  }
  finalizeBeamSubstep(state, snap, dts);
}

/** Co-rotational global internal force (12) for element e into `out`. */
function elementForce(state: BeamState, e: number, out: Float64Array): void {
  perfCounters.elementForceEvals++;
  const pi = state.x[e];
  const pj = state.x[e + 1];
  const qi = state.q[e];
  const qj = state.q[e + 1];
  const ell = state.restLen[e];
  const m = state.elem[e];
  elementFrame(pi, pj, qi, qj, _frame);
  localDeformation(_frame.Re, qi, qj, _frame.ln, ell, _def);
  // deformational local rotations: subtract the rest curvature so the precurved tip is strain-free at
  // rest (bending strain = (θ̄_j − θ̄_i) − κ0). Split κ0/2 to each node (symmetric part is a rigid mode).
  const k = m.kappa0;
  _uLoc.fill(0);
  _uLoc[3] = _def.thetaI.x + 0.5 * k.x; _uLoc[4] = _def.thetaI.y + 0.5 * k.y; _uLoc[5] = _def.thetaI.z + 0.5 * k.z;
  _uLoc[8] = _def.ubar;
  _uLoc[9] = _def.thetaJ.x - 0.5 * k.x; _uLoc[10] = _def.thetaJ.y - 0.5 * k.y; _uLoc[11] = _def.thetaJ.z - 0.5 * k.z;
  localStiffness(m, ell, _Kmat);
  for (let a = 0; a < 12; a++) {
    let s = 0;
    for (let b = 0; b < 12; b++) s += _Kmat[a * 12 + b] * _uLoc[b];
    _fLocTmp[a] = s;
  }
  // rotate each 3-subvector by R_e (local → global)
  const Re = _frame.Re;
  for (let g = 0; g < 4; g++) {
    const o = g * 3;
    const x = _fLocTmp[o], y = _fLocTmp[o + 1], z = _fLocTmp[o + 2];
    out[o] = Re[0] * x + Re[1] * y + Re[2] * z;
    out[o + 1] = Re[3] * x + Re[4] * y + Re[5] * z;
    out[o + 2] = Re[6] * x + Re[7] * y + Re[8] * z;
  }
}

/** Accumulate the global internal force (6n) and cache per-element forces in `_fElem`. */
function computeInternalForce(state: BeamState, fInt: Float64Array): void {
  fInt.fill(0);
  for (let e = 0; e < state.n - 1; e++) {
    elementForce(state, e, _fElem[e]);
    for (let a = 0; a < 6; a++) {
      fInt[6 * e + a] += _fElem[e][a];
      fInt[6 * (e + 1) + a] += _fElem[e][6 + a];
    }
  }
}

/** Perturb node j's DOF d by FD, return the recomputed forces of the (≤2) adjacent elements. */
function perturbNodeDof(state: BeamState, j: number, d: number, eps: number): void {
  if (d < 3) {
    state.x[j].setComponent(d, state.x[j].getComponent(d) + eps);
  } else {
    _pe.set(0, 0, 0).setComponent(d - 3, eps);
    state.q[j].copy(qExpHalf(_pe, _qe).multiply(_qtmp.copy(state.q[j]))).normalize();
  }
}

/**
 * Build the (expensive) tangent A = numerical elastic Jacobian K + mass/damping diagonal + Dirichlet
 * A-clamp. This is rebuilt on every staggered round today because the contact projection can move
 * nodes enough to stale the numerical tangent. The counted Phase-0 perf gate makes that cost visible;
 * an analytic consistent tangent is the intended optimization path.
 */
function assembleTangent(state: BeamState, dts: number, params: BeamParams, snap: BeamSubstepSnapshot): void {
  perfCounters.tangentAssemblies++;
  const n = state.n;
  const inv2 = 1 / (dts * dts);
  const inv1 = 1 / dts;
  for (let i = 0; i < n; i++) {
    _diag[i].fill(0);
    _lower[i].fill(0);
    _upper[i].fill(0);
  }
  computeInternalForce(state, _fIntBase); // caches per-element forces (the FD baseline)
  // ---- banded numerical elastic tangent K = ∂f_int/∂u ----
  // Perturbing node j affects elements (j-1) and (j) → residual nodes j-1, j, j+1: fills
  // upper[j-1] (block j-1,j), diag[j] (j,j), lower[j+1] (j+1,j), column 6j+d.
  for (let j = 0; j < n; j++) {
    _saveX.copy(state.x[j]);
    _saveQ.copy(state.q[j]);
    for (let d = 0; d < 6; d++) {
      const eps = FD;
      perturbNodeDof(state, j, d, eps);
      if (j - 1 >= 0) {
        elementForce(state, j - 1, _fPert);
        const base = _fElem[j - 1];
        for (let a = 0; a < 6; a++) {
          _upper[j - 1][a * 6 + d] += (_fPert[a] - base[a]) / eps;
          _diag[j][a * 6 + d] += (_fPert[6 + a] - base[6 + a]) / eps;
        }
      }
      if (j < n - 1) {
        elementForce(state, j, _fPert);
        const base = _fElem[j];
        for (let a = 0; a < 6; a++) {
          _diag[j][a * 6 + d] += (_fPert[a] - base[a]) / eps;
          _lower[j + 1][a * 6 + d] += (_fPert[6 + a] - base[6 + a]) / eps;
        }
      }
      state.x[j].copy(_saveX); // exact restore (no FD drift)
      state.q[j].copy(_saveQ);
    }
  }
  // ---- mass/damping diagonal (constant per substep) or static regularization ----
  if (params.static) {
    for (let i = 0; i < n; i++) for (let d = 0; d < 6; d++) _diag[i][d * 6 + d] += 1e-8;
  } else {
    for (let i = 0; i < n; i++) {
      const m = state.mass.m[i];
      const Jb = state.mass.Jb[i];
      const Jt = state.mass.Jt[i];
      const D = _diag[i];
      const at = m * inv2 + params.a0 * m * inv1;
      D[0] += at; D[7] += at; D[14] += at;
      const Rm = quatToMat3(snap.q[i], _Rm);
      const ax = _ax.set(Rm[2], Rm[5], Rm[8]);
      const cInert = inv2 + params.a0 * inv1;
      const whip = params.tauOmega > 0 ? Jt / (params.tauOmega * dts) : 0;
      addInertiaBlock(D, Jb, Jt - Jb, ax, cInert, whip);
    }
  }
  // ---- Dirichlet A-clamp (the rhs-clamp is applied per round in residualSolveApply) ----
  for (let f = 0; f < state.fixedPrefix; f++) {
    _diag[f].fill(0);
    for (let d = 0; d < 6; d++) _diag[f][d * 6 + d] = 1;
    _lower[f].fill(0);
    _upper[f].fill(0);
    if (f + 1 < n) _lower[f + 1].fill(0);
    if (f > 0) _upper[f - 1].fill(0);
  }
}

/** Build b = −R(u) at the CURRENT iterate, solve A·δu = b with the (possibly frozen) tangent, apply. */
function residualSolveApply(
  state: BeamState,
  dts: number,
  params: BeamParams,
  solver: BlockTridiagSolver,
  snap: BeamSubstepSnapshot
): number {
  const n = state.n;
  const inv2 = 1 / (dts * dts);
  const inv1 = 1 / dts;
  computeInternalForce(state, _fIntBase); // fresh internal force at the current iterate
  if (params.static) {
    for (let i = 0; i < n; i++) {
      let rx = _fIntBase[6 * i], ry = _fIntBase[6 * i + 1], rz = _fIntBase[6 * i + 2];
      let rrx = _fIntBase[6 * i + 3], rry = _fIntBase[6 * i + 4], rrz = _fIntBase[6 * i + 5];
      if (state.fext) { rx -= state.fext[i].x; ry -= state.fext[i].y; rz -= state.fext[i].z; }
      if (state.mext) { rrx -= state.mext[i].x; rry -= state.mext[i].y; rrz -= state.mext[i].z; }
      _rhs[6 * i] = -rx; _rhs[6 * i + 1] = -ry; _rhs[6 * i + 2] = -rz;
      _rhs[6 * i + 3] = -rrx; _rhs[6 * i + 4] = -rry; _rhs[6 * i + 5] = -rrz;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const m = state.mass.m[i];
      const Jb = state.mass.Jb[i];
      const Jt = state.mass.Jt[i];
      const dx = _v3a.subVectors(state.x[i], snap.x[i]);
      const Rt = _v3b.copy(dx).multiplyScalar(m * inv2 + params.a0 * m * inv1).addScaledVector(snap.v[i], -m * inv2 * dts);
      Rt.x += _fIntBase[6 * i]; Rt.y += _fIntBase[6 * i + 1]; Rt.z += _fIntBase[6 * i + 2];
      if (state.fext) Rt.addScaledVector(state.fext[i], -1);
      _rhs[6 * i] = -Rt.x; _rhs[6 * i + 1] = -Rt.y; _rhs[6 * i + 2] = -Rt.z;
      const Rm = quatToMat3(snap.q[i], _Rm);
      const ax = _ax.set(Rm[2], Rm[5], Rm[8]);
      const Phi = logQuat(_qrel.copy(state.q[i]).multiply(_qtmp.copy(snap.q[i]).conjugate()), _phi);
      const cInert = inv2 + params.a0 * inv1;
      const whip = params.tauOmega > 0 ? Jt / (params.tauOmega * dts) : 0;
      const rotCoef = _v3c.copy(Phi).multiplyScalar(cInert).addScaledVector(snap.omega[i], -inv2 * dts);
      const Rr = _v3d.copy(rotCoef).multiplyScalar(Jb).addScaledVector(ax, (Jt - Jb) * ax.dot(rotCoef));
      if (whip > 0) Rr.addScaledVector(ax, whip * ax.dot(Phi));
      Rr.x += _fIntBase[6 * i + 3]; Rr.y += _fIntBase[6 * i + 4]; Rr.z += _fIntBase[6 * i + 5];
      if (state.mext) Rr.addScaledVector(state.mext[i], -1);
      _rhs[6 * i + 3] = -Rr.x; _rhs[6 * i + 4] = -Rr.y; _rhs[6 * i + 5] = -Rr.z;
    }
  }
  for (let f = 0; f < state.fixedPrefix; f++) for (let d = 0; d < 6; d++) _rhs[6 * f + d] = 0; // rhs-clamp
  const ok = solver.solve(n, 6, _lower, _diag, _upper, _rhs, _du);
  if (!ok) return 0;
  let resInf = 0;
  for (let i = 0; i < n; i++) {
    if (i < state.fixedPrefix) continue;
    const dp = _v3a.set(_du[6 * i], _du[6 * i + 1], _du[6 * i + 2]);
    const dphi = _v3b.set(_du[6 * i + 3], _du[6 * i + 4], _du[6 * i + 5]);
    state.x[i].add(dp);
    state.q[i].copy(qExpHalf(dphi, _qe).multiply(_qtmp.copy(state.q[i]))).normalize();
    resInf = Math.max(resInf, dp.length(), dphi.length());
  }
  return resInf;
}

/** One full Newton iteration (rebuild tangent + residual + solve). Used by the non-staggered substep + staticSolve. */
function newtonIter(
  state: BeamState,
  dts: number,
  params: BeamParams,
  solver: BlockTridiagSolver,
  snap: BeamSubstepSnapshot
): number {
  assembleTangent(state, dts, params, snap);
  return residualSolveApply(state, dts, params, solver, snap);
}

/** Quasi-static solve: Newton on f_int = f_ext (no inertia/damping). Returns the final ‖δu‖∞. */
export function staticSolve(state: BeamState, solver: BlockTridiagSolver, maxIters = 40): number {
  ensureScratch(state.n);
  const snap = snapshotFor(state);
  beginBeamSubstep(state, snap);
  const p: BeamParams = { substeps: 1, a0: 0, a1: 0, tauOmega: 0, maxNewton: 1, static: true };
  let res = 0;
  for (let it = 0; it < maxIters; it++) {
    res = newtonIter(state, 1, p, solver, snap);
    if (res < 1e-10) break;
  }
  return res;
}

/** D[3..5,3..5] += c·(Jb·I + dJ·ax⊗ax) + whip·ax⊗ax. */
function addInertiaBlock(D: Float64Array, Jb: number, dJ: number, ax: Vector3, c: number, whip: number): void {
  const a = [ax.x, ax.y, ax.z];
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      let v = (dJ * c + whip) * a[r] * a[col];
      if (r === col) v += c * Jb;
      D[(3 + r) * 6 + (3 + col)] += v;
    }
  }
}

// ---- scratch ----
let _cap = 0;
let _diag: Float64Array[] = [];
let _lower: Float64Array[] = [];
let _upper: Float64Array[] = [];
let _rhs = new Float64Array(0);
let _du = new Float64Array(0);
let _fElem: Float64Array[] = [];
let _fIntBase = new Float64Array(0);
const _compatSnapshots = new WeakMap<BeamState, BeamSubstepSnapshot>();

function ensureScratch(n: number): void {
  if (_cap >= n) return;
  _cap = Math.max(n, _cap * 2);
  _diag = Array.from({ length: _cap }, () => new Float64Array(36));
  _lower = Array.from({ length: _cap }, () => new Float64Array(36));
  _upper = Array.from({ length: _cap }, () => new Float64Array(36));
  _rhs = new Float64Array(6 * _cap);
  _du = new Float64Array(6 * _cap);
  _fElem = Array.from({ length: _cap }, () => new Float64Array(12));
  _fIntBase = new Float64Array(6 * _cap);
}

function snapshotFor(state: BeamState): BeamSubstepSnapshot {
  let snap = _compatSnapshots.get(state);
  if (!snap) {
    snap = createBeamSubstepSnapshot(state.n);
    _compatSnapshots.set(state, snap);
  }
  return snap;
}

function ensureSnapshotCapacity(snap: BeamSubstepSnapshot, n: number): void {
  for (let i = snap.x.length; i < n; i++) {
    snap.x.push(new Vector3());
    snap.q.push(new Quaternion());
    snap.v.push(new Vector3());
    snap.omega.push(new Vector3());
  }
}

function assertSnapshotMatches(state: BeamState, snap: BeamSubstepSnapshot): void {
  if (snap.n !== state.n) {
    throw new Error(`BeamSubstepSnapshot node count mismatch: snapshot=${snap.n}, state=${state.n}`);
  }
}

const _saveX = new Vector3();
const _saveQ = new Quaternion();
const _frame = { Re: mat3(), ln: 0, e3: new Vector3() };
const _def = { ubar: 0, thetaI: new Vector3(), thetaJ: new Vector3() };
const _uLoc = new Float64Array(12);
const _fLocTmp = new Float64Array(12);
const _Kmat = new Float64Array(144);
const _fPert = new Float64Array(12);
const _Rm = mat3();
const _ax = new Vector3();
const _phi = new Vector3();
const _qrel = new Quaternion();
const _qtmp = new Quaternion();
const _qe = new Quaternion();
const _pe = new Vector3();
const _v3a = new Vector3();
const _v3b = new Vector3();
const _v3c = new Vector3();
const _v3d = new Vector3();

// keep imports used (corotKgeoAxial reserved for the analytic-tangent optimization path)
void corotKgeoAxial;
