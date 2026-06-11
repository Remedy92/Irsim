import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import {
  Mat3,
  applyRotationIncrement,
  expSO3,
  leftJacobianSO3,
  logQuat,
  logSO3,
  mat3,
  mat3Mul,
  mat3ToQuat,
  quatToMat3,
  TinvSO3
} from "./so3";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A random rotation vector with |v| ≈ maxAngle·rnd, uniformly-ish oriented. */
function randomRotVec(rnd: () => number, maxAngle: number): Vector3 {
  const v = new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
  if (v.length() < 1e-9) v.set(1, 0, 0);
  v.normalize().multiplyScalar(maxAngle * rnd());
  return v;
}

function randomUnitQuat(rnd: () => number): Quaternion {
  return new Quaternion(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
}

function maxMatDiff(a: Mat3, b: Mat3): number {
  let m = 0;
  for (let i = 0; i < 9; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

const I3 = (() => {
  const m = mat3();
  m[0] = m[4] = m[8] = 1;
  return m;
})();

describe("so3 — log/exp maps", () => {
  it("logSO3 ∘ expSO3 round-trips to machine precision over random angles", () => {
    const rnd = lcg(7);
    for (let t = 0; t < 500; t++) {
      const v = randomRotVec(rnd, 3.0); // up to ~0.95π
      const back = logSO3(expSO3(v));
      expect(back.distanceTo(v)).toBeLessThan(1e-9);
    }
  });

  it("handles the φ→0 small-angle branch", () => {
    const v = new Vector3(1e-10, -2e-10, 5e-11);
    const back = logSO3(expSO3(v));
    expect(back.distanceTo(v)).toBeLessThan(1e-18);
  });

  it("handles the φ→π branch (axis recovered, sign from the antisymmetric part)", () => {
    for (const axis of [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(1, 1, 1).normalize()]) {
      const v = axis.clone().multiplyScalar(Math.PI - 1e-3);
      const back = logSO3(expSO3(v));
      expect(back.distanceTo(v)).toBeLessThan(1e-4); // near π is intrinsically less precise
    }
  });

  it("expSO3 produces an orthonormal, det=+1 rotation", () => {
    const rnd = lcg(11);
    for (let t = 0; t < 50; t++) {
      const R = expSO3(randomRotVec(rnd, 2.5));
      // RᵀR = I
      const RtR = mat3Mul(transpose(R), R);
      expect(maxMatDiff(RtR, I3)).toBeLessThan(1e-12);
      expect(det(R)).toBeCloseTo(1, 12);
    }
  });
});

describe("so3 — quaternion bridges", () => {
  it("quatToMat3 / mat3ToQuat round-trip (up to sign) to machine precision", () => {
    const rnd = lcg(13);
    for (let t = 0; t < 300; t++) {
      const q = randomUnitQuat(rnd);
      const q2 = mat3ToQuat(quatToMat3(q));
      // quaternion double-cover: q and −q are the same rotation
      const same = Math.min(
        new Vector3(q.x - q2.x, q.y - q2.y, q.z - q2.z).length() + Math.abs(q.w - q2.w),
        new Vector3(q.x + q2.x, q.y + q2.y, q.z + q2.z).length() + Math.abs(q.w + q2.w)
      );
      expect(same).toBeLessThan(1e-9);
    }
  });

  it("logQuat agrees with logSO3(quatToMat3(q))", () => {
    const rnd = lcg(17);
    for (let t = 0; t < 300; t++) {
      const q = randomUnitQuat(rnd);
      const a = logQuat(q);
      const b = logSO3(quatToMat3(q));
      expect(a.distanceTo(b)).toBeLessThan(1e-9);
    }
  });
});

describe("so3 — ½θ convention write-back", () => {
  it("qExpHalf gives Im(conj(q_i)·q_j) = sin(angle/2) exactly", () => {
    const rnd = lcg(19);
    for (let t = 0; t < 300; t++) {
      const qi = randomUnitQuat(rnd);
      const theta = randomRotVec(rnd, 2.5);
      const qj = applyRotationIncrement(qi, theta);
      // rel = conj(q_i) ⊗ q_j should equal qExpHalf(theta)
      const rel = qi.clone().conjugate().multiply(qj);
      const imag = Math.hypot(rel.x, rel.y, rel.z);
      const angle = theta.length();
      expect(imag).toBeCloseTo(Math.sin(angle / 2), 9);
      // and the imag axis aligns with θ̂
      const axisDot =
        (rel.x * theta.x + rel.y * theta.y + rel.z * theta.z) / (imag * angle || 1);
      expect(Math.abs(axisDot)).toBeCloseTo(1, 9);
    }
  });

  it("applyRotationIncrement keeps the quaternion unit-normalized", () => {
    const rnd = lcg(23);
    let q = randomUnitQuat(rnd);
    for (let t = 0; t < 200; t++) {
      q = applyRotationIncrement(q, randomRotVec(rnd, 0.3));
      expect(q.length()).toBeCloseTo(1, 12);
    }
  });
});

describe("so3 — Jacobians", () => {
  it("TinvSO3(θ)·J_left(θ) = I to machine precision", () => {
    const rnd = lcg(29);
    for (let t = 0; t < 300; t++) {
      const theta = randomRotVec(rnd, 3.0);
      const prod = mat3Mul(TinvSO3(theta), leftJacobianSO3(theta));
      expect(maxMatDiff(prod, I3)).toBeLessThan(1e-8);
    }
  });

  it("small-angle TinvSO3 ≈ I − ½[θ]_× + (1/12)[θ]_×²", () => {
    const theta = new Vector3(1e-7, 2e-7, -1e-7);
    const Tinv = TinvSO3(theta);
    // leading order: diagonal ≈ 1, and the ½[θ]_× term dominates the off-diagonal
    expect(Tinv[0]).toBeCloseTo(1, 10);
    expect(Tinv[1]).toBeCloseTo(0.5 * theta.z, 10); // −½·(−θ.z) at (0,1)
  });
});

describe("so3 — mirror antisymmetry (the chirality-clean property)", () => {
  it("logSO3(S·R·S) = (Θx, −Θy, −Θz) under x-reflection S = diag(−1,1,1)", () => {
    const rnd = lcg(31);
    const S = (R: Mat3): Mat3 => {
      // (S R S)[r,c] = sgn(r)·sgn(c)·R[r,c], sgn(0)=−1, sgn(1)=sgn(2)=+1
      const out = mat3();
      const sgn = [-1, 1, 1];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = sgn[r] * sgn[c] * R[r * 3 + c];
      return out;
    };
    for (let t = 0; t < 200; t++) {
      const v = randomRotVec(rnd, 2.5);
      const Theta = logSO3(expSO3(v)); // = v
      const mirrored = logSO3(S(expSO3(v)));
      expect(mirrored.x).toBeCloseTo(Theta.x, 9);
      expect(mirrored.y).toBeCloseTo(-Theta.y, 9);
      expect(mirrored.z).toBeCloseTo(-Theta.z, 9);
    }
  });
});

// ---- local test helpers (independent of so3's internals) ----
function transpose(a: Mat3): Mat3 {
  const o = mat3();
  o[0] = a[0]; o[1] = a[3]; o[2] = a[6];
  o[3] = a[1]; o[4] = a[4]; o[5] = a[7];
  o[6] = a[2]; o[7] = a[5]; o[8] = a[8];
  return o;
}
function det(a: Mat3): number {
  return (
    a[0] * (a[4] * a[8] - a[5] * a[7]) -
    a[1] * (a[3] * a[8] - a[5] * a[6]) +
    a[2] * (a[3] * a[7] - a[4] * a[6])
  );
}
