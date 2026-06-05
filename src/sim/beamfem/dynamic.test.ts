import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { BlockTridiagSolver } from "../blocktridiag";
import { BeamParams, BeamState, staticSolve, stepBeam } from "./dynamic";
import { ElemMat } from "./element";
import { assembleMass } from "./mass";
import { logQuat } from "./so3";

const K0 = { x: 0, y: 0, z: 0 };
const ZERO_MAT: ElemMat = { EA: 0, EIy: 0, EIz: 0, GJ: 0, GAsy: 0, GAsz: 0, kirchhoff: true, kappa0: K0 };
const roundMat = (EI: number): ElemMat => ({ EA: 1e6, EIy: EI, EIz: EI, GJ: 0.77 * EI, GAsy: 0, GAsz: 0, kirchhoff: true, kappa0: { x: 0, y: 0, z: 0 } });

/** Build a straight rod of n nodes along +z at spacing `ell`, identity frames, zero velocity. */
function straightRod(n: number, ell: number, mat: ElemMat, fixedPrefix: number, manualMass?: number): BeamState {
  const x: Vector3[] = [];
  const q: Quaternion[] = [];
  const v: Vector3[] = [];
  const omega: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    x.push(new Vector3(0, 0, i * ell));
    q.push(new Quaternion());
    v.push(new Vector3());
    omega.push(new Vector3());
  }
  const restLen = new Float64Array(n - 1).fill(ell);
  const elem = Array.from({ length: n - 1 }, () => mat);
  let mass;
  if (manualMass !== undefined) {
    mass = { m: new Float64Array(n).fill(manualMass), Jb: new Float64Array(n).fill(0.01 * manualMass), Jt: new Float64Array(n).fill(0.01 * manualMass) };
  } else {
    const radii = new Float64Array(n - 1).fill(0.05);
    const GJ = new Float64Array(n - 1).fill(mat.GJ);
    mass = assembleMass(n, restLen, radii, GJ, 1 / 60 / 4, 1.0); // dts for S=4, R*=1
  }
  return { n, x, q, v, omega, restLen, elem, mass, fixedPrefix };
}

describe("beamfem dynamic — free flight (the increment-form RHS fix)", () => {
  it("a free node with constant velocity advances x = x0 + t·v EXACTLY (no +xⁿ overshoot)", () => {
    const st = straightRod(2, 1, ZERO_MAT, 0, 1.0); // m=1, zero stiffness, unclamped
    const v0 = new Vector3(0.5, -0.2, 0.1);
    st.v[0].copy(v0);
    st.v[1].copy(v0);
    const x00 = st.x[0].clone();
    const params: BeamParams = { substeps: 2, a0: 0, a1: 0, tauOmega: 0, maxNewton: 1 };
    const solver = new BlockTridiagSolver();
    const dt = 1 / 60;
    const frames = 30;
    for (let f = 0; f < frames; f++) stepBeam(st, dt, params, solver);
    const expected = x00.clone().addScaledVector(v0, frames * dt);
    expect(st.x[0].distanceTo(expected)).toBeLessThan(1e-9);
    // velocity preserved (no spurious damping/acceleration)
    expect(st.v[0].distanceTo(v0)).toBeLessThan(1e-9);
  });
});

describe("beamfem dynamic — Rayleigh damping", () => {
  it("free-node velocity decays exp(−a0·t) with a0 = 1/τ", () => {
    const tau = 0.08;
    const a0 = 1 / tau;
    const st = straightRod(2, 1, ZERO_MAT, 0, 1.0);
    const v0 = new Vector3(1, 0, 0);
    st.v[0].copy(v0);
    st.v[1].copy(v0);
    const params: BeamParams = { substeps: 4, a0, a1: 0, tauOmega: 0, maxNewton: 1 };
    const solver = new BlockTridiagSolver();
    const dt = 1 / 60;
    const T = 0.25; // seconds
    const frames = Math.round(T / dt);
    const S = params.substeps;
    const dts = dt / S;
    for (let f = 0; f < frames; f++) stepBeam(st, dt, params, solver);
    // exact backward-Euler velocity decay is (1/(1+a0·dts)) per substep — verify the FORMULA exactly
    const discrete = Math.pow(1 / (1 + a0 * dts), S * frames);
    expect(Math.abs(st.v[0].length() - discrete) / discrete).toBeLessThan(1e-3);
    // and it approximates the felt continuous decay exp(−a0·t) within the BE O(dt) bias
    const continuous = Math.exp(-a0 * frames * dt);
    expect(Math.abs(st.v[0].length() - continuous) / continuous).toBeLessThan(0.12);
  });
});

describe("beamfem dynamic — static cantilever equilibrium (validates the elastic force)", () => {
  // A quasi-static Newton solve (no inertia) directly tests that the co-rotational internal force
  // equilibrates to the analytic cantilever — fast and exact, decoupled from the dynamic transient.
  for (const EI of [5, 12, 47]) {
    it(`static tip deflection = F·L³/(3EI) within 2% for EI=${EI}`, () => {
      const L = 5;
      const M = 6;
      const ell = L / M;
      const st = straightRod(M + 1, ell, roundMat(EI), 1); // clamp node 0 (pos+frame) ⇒ fixed-free
      const F = 0.02; // small ⇒ linear regime
      st.fext = Array.from({ length: M + 1 }, () => new Vector3());
      st.fext[M].set(F, 0, 0); // transverse tip load (global x)
      const solver = new BlockTridiagSolver();
      const res = staticSolve(st, solver, 60);
      const tipDefl = st.x[M].x;
      const analytic = (F * L * L * L) / (3 * EI);
      // eslint-disable-next-line no-console
      if (EI === 12) console.log(`[cantilever-static] tip δ=${tipDefl.toFixed(4)}cm analytic=${analytic.toFixed(4)}cm res=${res.toExponential(1)}`);
      expect(Math.abs(tipDefl - analytic) / analytic).toBeLessThan(0.02);
    });
  }
});

describe("beamfem dynamic — torsional wind-up / whip", () => {
  it("a step hub roll propagates: tip twist lags then settles to the hub angle", () => {
    const EI = 12;
    const L = 8;
    const M = 16;
    const ell = L / M;
    const st = straightRod(M + 1, ell, roundMat(EI), 2);
    const alpha = 0.6; // rad hub roll about the rod axis (world z)
    const qRoll = new Quaternion(0, 0, Math.sin(alpha / 2), Math.cos(alpha / 2));
    st.q[0].copy(qRoll);
    st.q[1].copy(qRoll);
    const params: BeamParams = { substeps: 4, a0: 1 / 0.08, a1: 0, tauOmega: 0.1, maxNewton: 3 };
    const solver = new BlockTridiagSolver();
    const dt = 1 / 60;
    const tipTwist = () => logQuat(st.q[M]).z;
    stepBeam(st, dt, params, solver); // 1 frame: the torsional wave has barely reached the tip
    const early = tipTwist();
    let peak = early;
    for (let f = 0; f < 600; f++) {
      stepBeam(st, dt, params, solver);
      peak = Math.max(peak, tipTwist());
    }
    const settled = tipTwist();
    // eslint-disable-next-line no-console
    console.log(`[twist] early=${early.toFixed(3)} peak=${peak.toFixed(3)} settled=${settled.toFixed(3)} hub=${alpha}`);
    expect(early).toBeLessThan(alpha * 0.6); // tip LAGS the hub (wind-up)
    expect(peak).toBeGreaterThan(alpha * 1.03); // overshoots the hub (whip)
    expect(settled).toBeGreaterThan(alpha * 0.9); // torsion fully propagates: tip reaches the hub angle
    expect(settled).toBeLessThan(alpha * 1.1); // and rings down (does not run away)
  });
});
