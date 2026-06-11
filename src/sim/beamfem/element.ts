import { Quaternion, Vector3 } from "three";
import { Mat3, logSO3, mat3, mat3ToQuat, quatToMat3 } from "./so3";

/**
 * Per-element co-rotational 3D beam kinematics + local linear stiffness + geometric (stress)
 * stiffness (docs/physics-design-dynamic-corotational-beam.md §1.2, §1.4, §1.5).
 *
 * CONVENTION (fixed across beamfem): the element's LOCAL AXIAL axis is local-z (= the chord = the
 * 3rd column of the element frame R_e). Bending plane "y" = transverse deflection along local-x with
 * rotation about local-y (coupling sign s=+1); bending plane "z" = deflection along local-y with
 * rotation about local-x (s=−1). DOF order per node [dx,dy,dz, rx,ry,rz]; per element
 * [d_i(0..2), θ_i(3..5), d_j(6..8), θ_j(9..11)] (node i proximal, j distal). Row-major 12×12.
 *
 * Phase 1 ships the LINEAR local stiffness K_loc and the axial-force geometric stiffness K_g (the
 * buckling-critical part) plus the element frame extraction. These are validated by the analytic
 * cantilever (δ=FL³/3EI) and Euler buckling (P_cr=π²EI/(KL)²) gates in buckling.ts BEFORE any
 * dynamics or contact is wired. The consistent nonlinear co-rotational tangent (the moment part of
 * K_geo, the variation of R_e) is Phase 2 — the linearized gates do not need it.
 *
 * UNITS: cm, N·cm² (EI/GJ), N (EA/GA_s). EI = ℓ/(4·alphaBend1) is fed in directly; the factor-4 of
 * the ½θ convention lives only in the XPBD compliance, never in these stiffness matrices.
 */

/** Per-element section stiffnesses (already in N·cm² / N; derived from the MaterialField). */
export interface ElemMat {
  /** Axial rigidity EA (N). */
  EA: number;
  /** Bending rigidity, plane y (deflection local-x, rotation local-y), N·cm². */
  EIy: number;
  /** Bending rigidity, plane z (deflection local-y, rotation local-x), N·cm². */
  EIz: number;
  /** Torsional rigidity GJ (N·cm²). */
  GJ: number;
  /** Shear rigidity GA_s, plane y (N). Ignored when `kirchhoff` (Φ=0). */
  GAsy: number;
  /** Shear rigidity GA_s, plane z (N). Ignored when `kirchhoff`. */
  GAsz: number;
  /** Kirchhoff (Φ=0, no shear deformation) — the default for a thin wire. */
  kirchhoff: boolean;
  /**
   * Rest curvature (precurve) as the rest rotation-vector across the element (RAW RADIANS, in the
   * element/director frame): the total bend the unloaded element holds. The bending strain is the
   * relative nodal rotation MINUS this, so a J/angled tip expresses its shape with zero internal
   * moment at rest. {0,0,0} = straight. Recomputed per frame from steer·restCurvature.
   */
  kappa0: { x: number; y: number; z: number };
}

/**
 * Co-rotational element frame R_e = [r1 | r2 | e3] (row-major), where e3 is the chord
 * (proximal→distal) and r1 is the mean section director Gram-Schmidt'd against the chord (roll).
 * Returns the current chord length ℓ_n and e3 too. Reflection-equivariant (no world-axis fallback).
 */
export function elementFrame(
  pi: Vector3,
  pj: Vector3,
  qi: Quaternion,
  qj: Quaternion,
  out: { Re: Mat3; ln: number; e3: Vector3 } = { Re: mat3(), ln: 0, e3: new Vector3() }
): { Re: Mat3; ln: number; e3: Vector3 } {
  const e3 = out.e3.subVectors(pj, pi);
  const ln = e3.length();
  e3.multiplyScalar(1 / (ln || 1));

  // mean section frame (shortest-arc slerp)
  const qjAligned = _qj.copy(qj);
  if (qi.x * qj.x + qi.y * qj.y + qi.z * qj.z + qi.w * qj.w < 0) {
    qjAligned.set(-qj.x, -qj.y, -qj.z, -qj.w);
  }
  const qm = _qm.copy(qi).slerp(qjAligned, 0.5);
  const Rm = quatToMat3(qm, _Rm);
  // first/second director = first/second column of Rm
  const g1 = _g1.set(Rm[0], Rm[3], Rm[6]);

  // r1 = Gram-Schmidt of g1 against e3
  const d1 = g1.dot(e3);
  const r1 = _r1.copy(g1).addScaledVector(e3, -d1);
  if (r1.lengthSq() > 1e-12) {
    r1.normalize();
  } else {
    // degenerate g1 ∥ e3 → use the second director g2
    const g2 = _g2.set(Rm[1], Rm[4], Rm[7]);
    const r2tmp = _r2.copy(g2).addScaledVector(e3, -g2.dot(e3));
    if (r2tmp.lengthSq() > 1e-12) {
      r2tmp.normalize();
      r1.crossVectors(r2tmp, e3).normalize(); // r1 = r2 × e3
    } else {
      // double-degenerate (float drift): pick any vector ⊥ e3 deterministically (roll irrelevant
      // for isotropic EI). Use the least-aligned canonical axis to stay reflection-stable per-axis.
      const ax = Math.abs(e3.x) <= Math.abs(e3.y) && Math.abs(e3.x) <= Math.abs(e3.z)
        ? _ex.set(1, 0, 0)
        : Math.abs(e3.y) <= Math.abs(e3.z)
          ? _ex.set(0, 1, 0)
          : _ex.set(0, 0, 1);
      r1.copy(ax).addScaledVector(e3, -ax.dot(e3)).normalize();
    }
  }
  const r2 = _r2.crossVectors(e3, r1); // r2 = e3 × r1 (right-handed, det +1)

  const Re = out.Re;
  Re[0] = r1.x; Re[1] = r2.x; Re[2] = e3.x;
  Re[3] = r1.y; Re[4] = r2.y; Re[5] = e3.y;
  Re[6] = r1.z; Re[7] = r2.z; Re[8] = e3.z;
  out.ln = ln;
  return out;
}

/**
 * Local deformational DOFs relative to R_e: axial stretch ū = ℓ_n − ℓ_e, and the nodal rotation
 * vectors θ̄_i = logSO3(R_eᵀ R(q_i)), θ̄_j = logSO3(R_eᵀ R(q_j)). κ0 (rest curvature) is handled by
 * the caller's internal-force evaluation (subtracted from the relative rotation), so it is NOT baked
 * in here. Used by the Phase-2 nonlinear internal force; the Phase-1 gates use straight rest frames.
 */
export function localDeformation(
  Re: Mat3,
  qi: Quaternion,
  qj: Quaternion,
  ln: number,
  ellRest: number,
  out: { ubar: number; thetaI: Vector3; thetaJ: Vector3 } = { ubar: 0, thetaI: new Vector3(), thetaJ: new Vector3() }
): { ubar: number; thetaI: Vector3; thetaJ: Vector3 } {
  out.ubar = ln - ellRest;
  // θ̄ = logSO3(R_eᵀ R(q)) = log(conj(q_e) · q). Compute conj(q_e) ONCE into its own scratch — do
  // NOT conjugate q_e in place, or the second call sees a double-conjugated (wrong) frame.
  mat3ToQuat(Re, _qe);
  _qeConj.copy(_qe).conjugate();
  logSO3(quatToMat3(_relI.copy(_qeConj).multiply(qi), _tmpM), out.thetaI);
  logSO3(quatToMat3(_relJ.copy(_qeConj).multiply(qj), _tmpM2), out.thetaJ);
  return out;
}

/** Scatter a symmetric 4×4 sub-block (DOF order [v_i, θ_i, v_j, θ_j]) into the 12×12 K (row-major). */
function scatter4(K: Float64Array, dof: [number, number, number, number], m: number[][]): void {
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      K[dof[a] * 12 + dof[b]] += m[a][b];
    }
  }
}

/**
 * Linear local element stiffness K_loc (12×12, row-major), Euler-Bernoulli when kirchhoff (Φ=0),
 * Timoshenko (shear-flexible) otherwise. Axial along local-z, torsion about local-z, the two bending
 * planes with coupling signs s=+1 (plane y) and s=−1 (plane z).
 */
export function localStiffness(m: ElemMat, ell: number, out: Float64Array = new Float64Array(144)): Float64Array {
  out.fill(0);
  // axial: local-z translation (dof 2, 8)
  const ka = m.EA / ell;
  out[2 * 12 + 2] += ka; out[8 * 12 + 8] += ka;
  out[2 * 12 + 8] -= ka; out[8 * 12 + 2] -= ka;
  // torsion: local-z rotation (dof 5, 11)
  const kt = m.GJ / ell;
  out[5 * 12 + 5] += kt; out[11 * 12 + 11] += kt;
  out[5 * 12 + 11] -= kt; out[11 * 12 + 5] -= kt;
  // bending plane y: deflection local-x (dof 0,6), rotation local-y (dof 4,10), s=+1
  bendBlock(out, m.EIy, ell, m.kirchhoff ? 0 : 12 * m.EIy / (m.GAsy * ell * ell), [0, 4, 6, 10], 1);
  // bending plane z: deflection local-y (dof 1,7), rotation local-x (dof 3,9), s=−1
  bendBlock(out, m.EIz, ell, m.kirchhoff ? 0 : 12 * m.EIz / (m.GAsz * ell * ell), [1, 3, 7, 9], -1);
  return out;
}

function bendBlock(K: Float64Array, EI: number, ell: number, Phi: number, dof: [number, number, number, number], s: number): void {
  const f = EI / (ell * ell * ell * (1 + Phi));
  const L = ell;
  const L2 = ell * ell;
  // symmetric 4×4 on [v_i, θ_i, v_j, θ_j]
  const m = [
    [12 * f, s * 6 * L * f, -12 * f, s * 6 * L * f],
    [s * 6 * L * f, (4 + Phi) * L2 * f, -s * 6 * L * f, (2 - Phi) * L2 * f],
    [-12 * f, -s * 6 * L * f, 12 * f, -s * 6 * L * f],
    [s * 6 * L * f, (2 - Phi) * L2 * f, -s * 6 * L * f, (4 + Phi) * L2 * f]
  ];
  scatter4(K, dof, m);
}

/**
 * Geometric (stress) stiffness K_g (12×12, row-major) for an axial force N (TENSION POSITIVE). The
 * standard consistent bending-plane geometric stiffness. The tangent is K_t = K_mat + K_g(N); under
 * compression (N<0) it SOFTENS the lateral stiffness and goes singular at the Euler load — so for a
 * compressive load P, K_g(−P) = −P·corotKgeoAxial(N=1), i.e. K_t = K_mat − P·K_g_unit. Getting this
 * SIGN right is the buckling-critical decision the Phase-1 gate locks (a flipped sign makes tension
 * buckle and compression never — caught by buckling.test.ts's sign-fingerprint).
 */
export function corotKgeoAxial(N: number, ell: number, out: Float64Array = new Float64Array(144)): Float64Array {
  out.fill(0);
  geoBlock(out, N, ell, [0, 4, 6, 10], 1); // plane y
  geoBlock(out, N, ell, [1, 3, 7, 9], -1); // plane z
  return out;
}

function geoBlock(K: Float64Array, N: number, ell: number, dof: [number, number, number, number], s: number): void {
  const g = N / ell;
  const L = ell;
  const L2 = ell * ell;
  const m = [
    [6 / 5 * g, s * (L / 10) * g, -6 / 5 * g, s * (L / 10) * g],
    [s * (L / 10) * g, (2 * L2 / 15) * g, -s * (L / 10) * g, -(L2 / 30) * g],
    [-6 / 5 * g, -s * (L / 10) * g, 6 / 5 * g, -s * (L / 10) * g],
    [s * (L / 10) * g, -(L2 / 30) * g, -s * (L / 10) * g, (2 * L2 / 15) * g]
  ];
  scatter4(K, dof, m);
}

/**
 * Transform a local 12×12 (row-major) to global by the element frame R_e: K_glob = T·K_loc·Tᵀ with
 * T = blockdiag(R_e, R_e, R_e, R_e). Equivalently each 3×3 sub-block (I,J) → R_e·K[I,J]·R_eᵀ.
 * For an axis-aligned straight column R_e ≈ I, so this is a no-op there (the gate exploits that).
 */
export function transformK(Kloc: Float64Array, Re: Mat3, out: Float64Array = new Float64Array(144)): Float64Array {
  // out[I,J] (3×3) = Re · Kloc[I,J] · Reᵀ for the 4×4 grid of 3×3 blocks
  for (let I = 0; I < 4; I++) {
    for (let J = 0; J < 4; J++) {
      // first M = Kloc[I,J] · Reᵀ  (3×3), then Re · M
      const r0 = I * 3, c0 = J * 3;
      // extract block
      const tmp = _blk;
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          // (Kloc_block · Reᵀ)[a,b] = Σ_k Kloc[r0+a, c0+k] · Re[b,k]   (Reᵀ[k,b]=Re[b,k])
          let sUm = 0;
          for (let k = 0; k < 3; k++) sUm += Kloc[(r0 + a) * 12 + (c0 + k)] * Re[b * 3 + k];
          tmp[a * 3 + b] = sUm;
        }
      }
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          // (Re · tmp)[a,b] = Σ_k Re[a,k] · tmp[k,b]
          let sUm = 0;
          for (let k = 0; k < 3; k++) sUm += Re[a * 3 + k] * tmp[k * 3 + b];
          out[(r0 + a) * 12 + (c0 + b)] = sUm;
        }
      }
    }
  }
  return out;
}

// module scratch (single-threaded)
const _qj = new Quaternion();
const _qm = new Quaternion();
const _qe = new Quaternion();
const _qeConj = new Quaternion();
const _relI = new Quaternion();
const _relJ = new Quaternion();
const _Rm = mat3();
const _tmpM = mat3();
const _tmpM2 = mat3();
const _g1 = new Vector3();
const _g2 = new Vector3();
const _r1 = new Vector3();
const _r2 = new Vector3();
const _ex = new Vector3();
const _blk = new Float64Array(9);
