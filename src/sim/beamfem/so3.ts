import { Quaternion, Vector3 } from "three";

/**
 * SO(3) helpers for the dynamic co-rotational beam solver
 * (docs/physics-design-dynamic-corotational-beam.md §1.2, §1.6).
 *
 * The beam works with rotations in three representations and needs exact, numerically-robust maps
 * between them:
 *   - quaternions q_n        — the authoritative per-node section frame (what contact/coax read);
 *   - rotation matrices R_e  — the co-rotational element frame (chord + averaged material roll);
 *   - rotation vectors θ      — axis-angle (rad), the incremental DOF the Newton solve operates on.
 *
 * Conventions (FIXED — see the design doc):
 *   - Mat3 is ROW-MAJOR, 3×3, element (r,c) at r*3+c. (Deliberately NOT three.Matrix3, whose
 *     `.elements` is column-major — that is a recurring sign/transpose trap; we keep one clear
 *     convention across the whole beamfem module.)
 *   - The ½θ quaternion-imag convention: a rotation-increment θ writes back to a quaternion as
 *     dq = (sin(|θ|/2)·θ̂, cos(|θ|/2)), so Im(conj(q_i)·q_j) = sin(angle/2) exactly. The factor 4 of
 *     α_b = ℓ/(4·EI) lives ONLY in the XPBD compliance, never here.
 *   - logSO3 has NO closest-quaternion sign branch, so the curvature measure is exactly
 *     antisymmetric under reflection (the handedness-clean property; see design doc §1.3).
 *
 * All functions take an optional `out` to stay allocation-free on the per-element per-Newton path.
 */

export type Mat3 = Float64Array; // row-major 3×3; (r,c) at r*3+c

export function mat3(): Mat3 {
  return new Float64Array(9);
}

/** Identity into `out`. */
export function mat3Identity(out: Mat3 = mat3()): Mat3 {
  out[0] = 1; out[1] = 0; out[2] = 0;
  out[3] = 0; out[4] = 1; out[5] = 0;
  out[6] = 0; out[7] = 0; out[8] = 1;
  return out;
}

/** Skew-symmetric matrix [v]_× (row-major) such that [v]_×·a = v × a. */
export function skew(v: Vector3, out: Mat3 = mat3()): Mat3 {
  out[0] = 0;     out[1] = -v.z;  out[2] = v.y;
  out[3] = v.z;   out[4] = 0;     out[5] = -v.x;
  out[6] = -v.y;  out[7] = v.x;   out[8] = 0;
  return out;
}

/** C = A·B (all row-major 3×3). `out` must not alias A or B. */
export function mat3Mul(a: Mat3, b: Mat3, out: Mat3 = mat3()): Mat3 {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/** Aᵀ (row-major). `out` may not alias `a`. */
export function mat3Transpose(a: Mat3, out: Mat3 = mat3()): Mat3 {
  out[0] = a[0]; out[1] = a[3]; out[2] = a[6];
  out[3] = a[1]; out[4] = a[4]; out[5] = a[7];
  out[6] = a[2]; out[7] = a[5]; out[8] = a[8];
  return out;
}

/** y = R·v (row-major R). */
export function mat3MulVec(R: Mat3, v: Vector3, out: Vector3 = new Vector3()): Vector3 {
  const x = R[0] * v.x + R[1] * v.y + R[2] * v.z;
  const y = R[3] * v.x + R[4] * v.y + R[5] * v.z;
  const z = R[6] * v.x + R[7] * v.y + R[8] * v.z;
  return out.set(x, y, z);
}

/** Rotation matrix (row-major) of a unit quaternion. */
export function quatToMat3(q: Quaternion, out: Mat3 = mat3()): Mat3 {
  const { x, y, z, w } = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  out[0] = 1 - 2 * (yy + zz); out[1] = 2 * (xy - wz);     out[2] = 2 * (xz + wy);
  out[3] = 2 * (xy + wz);     out[4] = 1 - 2 * (xx + zz); out[5] = 2 * (yz - wx);
  out[6] = 2 * (xz - wy);     out[7] = 2 * (yz + wx);     out[8] = 1 - 2 * (xx + yy);
  return out;
}

/** Unit quaternion from a rotation matrix (row-major), Shepperd's method (numerically robust). */
export function mat3ToQuat(R: Mat3, out: Quaternion = new Quaternion()): Quaternion {
  const m00 = R[0], m01 = R[1], m02 = R[2];
  const m10 = R[3], m11 = R[4], m12 = R[5];
  const m20 = R[6], m21 = R[7], m22 = R[8];
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return out.set(x, y, z, w).normalize();
}

/** Exponential map: rotation vector v (axis-angle, rad) → rotation matrix (row-major), Rodrigues. */
export function expSO3(v: Vector3, out: Mat3 = mat3()): Mat3 {
  const phi = v.length();
  mat3Identity(out);
  if (phi < 1e-8) {
    // R ≈ I + [v]_× + ½[v]_×²  (second order keeps it close to orthonormal for tiny φ)
    const K = skew(v, _kA);
    const K2 = mat3Mul(K, K, _kB);
    for (let i = 0; i < 9; i++) out[i] += K[i] + 0.5 * K2[i];
    return out;
  }
  const a = Math.sin(phi) / phi;
  const b = (1 - Math.cos(phi)) / (phi * phi);
  const K = skew(v, _kA);
  const K2 = mat3Mul(K, K, _kB);
  for (let i = 0; i < 9; i++) out[i] += a * K[i] + b * K2[i];
  return out;
}

/**
 * Logarithm map: rotation matrix (row-major) → rotation vector (axis-angle, rad), φ ∈ [0,π].
 * Robust at φ→0 (½ of the antisymmetric part) and φ→π (axis from the symmetric part).
 * NO closest-quaternion / sign branch — the result is exactly antisymmetric under reflection.
 */
export function logSO3(R: Mat3, out: Vector3 = new Vector3()): Vector3 {
  const trace = R[0] + R[4] + R[8];
  const c = Math.max(-1, Math.min(1, (trace - 1) / 2));
  const phi = Math.acos(c);
  // antisymmetric-part vector (un-scaled): a = [R21-R12, R02-R20, R10-R01]
  const ax = R[7] - R[5];
  const ay = R[2] - R[6];
  const az = R[3] - R[1];
  if (phi < 1e-8) {
    // sinφ/φ ≈ 1 ⇒ axisVec ≈ ½·a
    return out.set(0.5 * ax, 0.5 * ay, 0.5 * az);
  }
  if (phi > Math.PI - 1e-6) {
    // near π: sinφ→0 makes the antisymmetric formula blow up. Extract axis from B=(R+I)/2 ≈ n nᵀ.
    const b00 = (R[0] + 1) / 2, b11 = (R[4] + 1) / 2, b22 = (R[8] + 1) / 2;
    const b01 = (R[1] + R[3]) / 2, b02 = (R[2] + R[6]) / 2, b12 = (R[5] + R[7]) / 2;
    let nx: number, ny: number, nz: number;
    if (b00 >= b11 && b00 >= b22) {
      nx = Math.sqrt(Math.max(b00, 0)); ny = b01 / nx; nz = b02 / nx;
    } else if (b11 >= b22) {
      ny = Math.sqrt(Math.max(b11, 0)); nx = b01 / ny; nz = b12 / ny;
    } else {
      nz = Math.sqrt(Math.max(b22, 0)); nx = b02 / nz; ny = b12 / nz;
    }
    // fix the axis sign from the (vanishing but signed) antisymmetric part
    if (ax * nx + ay * ny + az * nz < 0) {
      nx = -nx; ny = -ny; nz = -nz;
    }
    const n = Math.hypot(nx, ny, nz) || 1;
    return out.set((phi * nx) / n, (phi * ny) / n, (phi * nz) / n);
  }
  const k = phi / (2 * Math.sin(phi));
  return out.set(k * ax, k * ay, k * az);
}

/**
 * Logarithm of a unit quaternion → rotation vector (axis-angle, rad), shortest arc (forces w ≥ 0).
 * Equivalent to logSO3(quatToMat3(q)) but cheaper and used directly for the curvature measure
 * κ_vec = logQuat(conj(q_i)·q_j)/ℓ.
 */
export function logQuat(q: Quaternion, out: Vector3 = new Vector3()): Vector3 {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; } // shortest arc
  const im = Math.hypot(x, y, z);
  if (im < 1e-12) return out.set(2 * x, 2 * y, 2 * z); // angle ≈ 2·imag for tiny rotations
  const angle = 2 * Math.atan2(im, w);
  const s = angle / im;
  return out.set(s * x, s * y, s * z);
}

/**
 * Half-angle quaternion exponential: dq = (sin(|θ|/2)·θ̂, cos(|θ|/2)). This is the ½θ convention
 * write-back — it makes Im(conj(q_i)·(q_i⊗dq)) = sin(angle/2) exactly. Returns a UNIT quaternion.
 */
export function qExpHalf(theta: Vector3, out: Quaternion = new Quaternion()): Quaternion {
  const phi = theta.length();
  if (phi < 1e-9) {
    // (½θ, 1) is unit to O(φ²); normalize to be safe.
    return out.set(0.5 * theta.x, 0.5 * theta.y, 0.5 * theta.z, 1).normalize();
  }
  const half = phi / 2;
  const s = Math.sin(half) / phi; // = sin(φ/2)/φ ⇒ |imag| = sin(φ/2)
  return out.set(s * theta.x, s * theta.y, s * theta.z, Math.cos(half));
}

/**
 * Apply a rotation increment θ (body frame, right-multiply): q_n ← normalize(q_n ⊗ qExpHalf(θ)).
 * The ONLY place a converged Newton rotation increment becomes a frame quaternion.
 */
export function applyRotationIncrement(qn: Quaternion, theta: Vector3, out: Quaternion = new Quaternion()): Quaternion {
  const dq = qExpHalf(theta, _q);
  return out.copy(qn).multiply(dq).normalize();
}

/**
 * Inverse left Jacobian of SO(3): T⁻¹(θ) = I − ½[θ]_× + β·[θ]_×², with
 *   β = 1/φ² − (1+cosφ)/(2φ·sinφ),   β → 1/12 as φ → 0.
 * Maps a rotation-vector rate to a body angular velocity (used by the consistent co-rotational
 * tangent / dynamic rotational residual). `leftJacobianSO3` is its inverse, provided for tests.
 */
export function TinvSO3(theta: Vector3, out: Mat3 = mat3()): Mat3 {
  const phi = theta.length();
  const K = skew(theta, _kA);
  const K2 = mat3Mul(K, K, _kB);
  mat3Identity(out);
  let beta: number;
  if (phi < 1e-6) {
    beta = 1 / 12 + (phi * phi) / 720; // series; 1/12 leading term
  } else {
    beta = 1 / (phi * phi) - (1 + Math.cos(phi)) / (2 * phi * Math.sin(phi));
  }
  for (let i = 0; i < 9; i++) out[i] += -0.5 * K[i] + beta * K2[i];
  return out;
}

/**
 * Left Jacobian of SO(3): J_l(θ) = I + ((1−cosφ)/φ²)[θ]_× + ((φ−sinφ)/φ³)[θ]_×².
 * Provided so tests can assert TinvSO3(θ)·J_l(θ) = I.
 */
export function leftJacobianSO3(theta: Vector3, out: Mat3 = mat3()): Mat3 {
  const phi = theta.length();
  const K = skew(theta, _kA);
  const K2 = mat3Mul(K, K, _kB);
  mat3Identity(out);
  let a: number, b: number;
  if (phi < 1e-6) {
    a = 0.5 - (phi * phi) / 24;
    b = 1 / 6 - (phi * phi) / 120;
  } else {
    a = (1 - Math.cos(phi)) / (phi * phi);
    b = (phi - Math.sin(phi)) / (phi * phi * phi);
  }
  for (let i = 0; i < 9; i++) out[i] += a * K[i] + b * K2[i];
  return out;
}

// module-scratch (single-threaded; functions that use these never alias across one call)
const _kA = mat3();
const _kB = mat3();
const _q = new Quaternion();
