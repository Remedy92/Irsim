import { Quaternion, Vector3 } from "three";
import type { Anatomy } from "./types";

/**
 * Orientation-based Cosserat rod (position + per-segment quaternion DOFs).
 *
 * Constraints follow Kugelstadt & Schömer 2016 "Position and Orientation Based
 * Cosserat Rods" and the reference implementation in Bender's PositionBasedDynamics:
 *   - stretch-shear   : C_s = (1/l0)(p_{j+1} - p_j) - d3(q_j)
 *   - bend-twist      : C_b = Im(conj(q_j) q_{j+1}) - s*Omega0   (closest-quaternion s)
 *
 * The defining property for a guidewire: TWIST is a real DOF, so rolling the
 * proximal handle (torque) propagates down the shaft and rotates the pre-shaped
 * tip — the actual mechanism of branch cannulation ("torque control").
 *
 * Solver is position/orientation-based with PBD stiffness (k in [0,1]) and
 * bilateral interleaved Gauss-Seidel sweeps (stable for long chains). Orientation
 * inertia is omitted (quasi-static) for robustness; XPBD compliance + angular
 * velocity are the documented upgrade. See ROADMAP.md.
 */

export interface CosseratParams {
  segments: number;
  rodRadius: number; // cm
  kStretch: number; // 0..1 — inextensibility (keep high)
  kBend: number; // 0..1 — flexural compliance of the shaft
  kTwist: number; // 0..1 — torsional stiffness (torque transmission)
  iterations: number;
  damping: number;
  tipNodes: number; // how many distal nodes form the pre-shaped tip
  tipCurve: number; // max rest bend per tip node (radians) at full tightness
}

export const GUIDEWIRE: CosseratParams = {
  segments: 80,
  rodRadius: 0.05,
  kStretch: 1.0,
  kBend: 0.18,
  kTwist: 0.55,
  iterations: 12,
  damping: 0.9,
  tipNodes: 8,
  tipCurve: 0.22
};

export interface RodInput {
  deployed: number; // cm
  steer: number; // 0..1 tip tightness
  torque: number; // radians, handle roll
}

interface LumenSeg {
  a: Vector3;
  b: Vector3;
  ra: number;
  rb: number;
}

const E3 = new Vector3();
const _v = new Vector3();
const _ab = new Vector3();
const _ap = new Vector3();
const _cp = new Vector3();

function director(q: Quaternion, out: Vector3): Vector3 {
  return out.set(
    2 * (q.x * q.z + q.w * q.y),
    2 * (q.y * q.z - q.w * q.x),
    q.w * q.w - q.x * q.x - q.y * q.y + q.z * q.z
  );
}

/** Hamilton product a*b into out (x,y,z,w order). */
function qmul(a: Quaternion, b: Quaternion, out: Quaternion): Quaternion {
  return out.set(
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  );
}

function closestOnSeg(p: Vector3, a: Vector3, b: Vector3, out: Vector3): number {
  _ab.subVectors(b, a);
  _ap.subVectors(p, a);
  const len2 = _ab.lengthSq() || 1e-9;
  const t = Math.max(0, Math.min(1, _ap.dot(_ab) / len2));
  out.copy(a).addScaledVector(_ab, t);
  return t;
}

export class CosseratRod {
  readonly params: CosseratParams;
  readonly n: number; // particle count = segments + 1
  x: Vector3[]; // particle positions
  prev: Vector3[];
  q: Quaternion[]; // per-segment frames (length = segments)
  w: number[]; // inverse mass per particle
  wq: number[]; // inverse inertia per segment
  restOmega: Vector3[]; // rest Darboux per interior node (length segments-1)
  l0 = 0.4;

  /** Length actually fed in; ramps toward input.deployed at a bounded rate so a
   * large jump can't shock the stretch constraint (you can't insert 20cm in a frame). */
  private deployedEff: number;
  private static FEED_RATE = 35; // cm/s

  private lumen: LumenSeg[] = [];
  private base = new Vector3();
  private baseDir = new Vector3(0, 1, 0);
  private baseQ = new Quaternion();

  input: RodInput = { deployed: 8, steer: 0.45, torque: 0 };

  // scratch quaternions
  private tmpA = new Quaternion();
  private tmpB = new Quaternion();
  private tmpC = new Quaternion();

  constructor(anatomy: Anatomy, accessId: string, params: CosseratParams = GUIDEWIRE) {
    this.params = params;
    const segs = params.segments;
    this.n = segs + 1;

    const access = anatomy.access.find((a) => a.id === accessId) ?? anatomy.access[0];
    this.base.copy(access.pos);
    this.baseDir.copy(access.dir).normalize();

    for (const br of anatomy.branches) {
      for (let i = 0; i < br.points.length - 1; i++) {
        this.lumen.push({ a: br.points[i].pos, b: br.points[i + 1].pos, ra: br.points[i].radius, rb: br.points[i + 1].radius });
      }
    }

    // base frame: director aligned to insertion direction
    this.baseQ.setFromUnitVectors(new Vector3(0, 0, 1), this.baseDir);

    // seed the rod straight, spaced at the initial rest length (so no startup shock)
    this.deployedEff = this.input.deployed;
    const seed = this.deployedEff / segs;
    this.x = [];
    this.prev = [];
    this.w = [];
    for (let i = 0; i < this.n; i++) {
      const p = this.base.clone().addScaledVector(this.baseDir, i * seed);
      this.x.push(p);
      this.prev.push(p.clone());
      this.w.push(i === 0 ? 0 : 1);
    }

    this.q = [];
    this.wq = [];
    for (let j = 0; j < segs; j++) {
      this.q.push(this.baseQ.clone());
      this.wq.push(j === 0 ? 0 : 1);
    }

    this.restOmega = [];
    for (let k = 0; k < segs - 1; k++) this.restOmega.push(new Vector3());
  }

  /** Update the pre-shaped tip's rest curvature from the steer (tightness) input. */
  private updateRestShape(): void {
    const segs = this.params.segments;
    const { tipNodes, tipCurve } = this.params;
    const tight = Math.max(0, Math.min(1, this.input.steer));
    for (let k = 0; k < segs - 1; k++) {
      const fromTip = segs - 2 - k; // 0 at the very tip
      if (fromTip < tipNodes) {
        // bend about the local x axis; magnitude = sin(phi/2)
        const phi = tipCurve * tight;
        this.restOmega[k].set(Math.sin(phi * 0.5), 0, 0);
      } else {
        this.restOmega[k].set(0, 0, 0);
      }
    }
  }

  private updateBaseFrame(): void {
    // director along insertion dir, rolled about it by the torque input
    this.tmpA.setFromUnitVectors(new Vector3(0, 0, 1), this.baseDir);
    this.tmpB.setFromAxisAngle(this.baseDir, this.input.torque);
    this.baseQ.multiplyQuaternions(this.tmpB, this.tmpA);
  }

  private contain(p: Vector3): void {
    let bestD2 = Infinity;
    let bestRadius = 1;
    const best = _v.set(0, 0, 0);
    for (const seg of this.lumen) {
      const t = closestOnSeg(p, seg.a, seg.b, _cp);
      const d2 = p.distanceToSquared(_cp);
      if (d2 < bestD2) {
        bestD2 = d2;
        best.copy(_cp);
        bestRadius = seg.ra + (seg.rb - seg.ra) * t;
      }
    }
    const allowed = Math.max(0.02, bestRadius - this.params.rodRadius);
    const d = Math.sqrt(bestD2);
    if (d > allowed) p.lerp(best, 1 - allowed / Math.max(d, 1e-6));
  }

  private solveStretchShear(j: number): void {
    const a = j;
    const b = j + 1;
    const qj = this.q[j];
    const d3 = director(qj, _v);
    // C = (1/l0)(p_b - p_a) - d3
    const cx = (this.x[b].x - this.x[a].x) / this.l0 - d3.x;
    const cy = (this.x[b].y - this.x[a].y) / this.l0 - d3.y;
    const cz = (this.x[b].z - this.x[a].z) / this.l0 - d3.z;

    const denom = (this.w[a] + this.w[b]) / this.l0 + 4 * this.l0 * this.wq[j] + 1e-6;
    const k = this.params.kStretch;
    const gx = (cx / denom) * k;
    const gy = (cy / denom) * k;
    const gz = (cz / denom) * k;

    this.x[a].x += this.w[a] * gx;
    this.x[a].y += this.w[a] * gy;
    this.x[a].z += this.w[a] * gz;
    this.x[b].x -= this.w[b] * gx;
    this.x[b].y -= this.w[b] * gy;
    this.x[b].z -= this.w[b] * gz;

    if (this.wq[j] > 0) {
      // dq = (2 wq l0) * ( gamma_quat * (q * e3)^conj )
      const qe3bar = this.tmpA.set(qj.z, -qj.y, qj.x, -qj.w);
      const gq = this.tmpB.set(gx, gy, gz, 0);
      const dq = qmul(gq, qe3bar, this.tmpC);
      const s = 2 * this.wq[j] * this.l0;
      qj.set(qj.x + s * dq.x, qj.y + s * dq.y, qj.z + s * dq.z, qj.w + s * dq.w).normalize();
    }
  }

  private solveBendTwist(k: number): void {
    const j = k;
    const jp = k + 1;
    const qj = this.q[j];
    const qjp = this.q[jp];
    // omega = conj(q_j) * q_{j+1}
    const omega = qmul(this.tmpA.copy(qj).conjugate(), qjp, this.tmpB);
    const O0 = this.restOmega[k];

    // closest-quaternion: choose nearest of (omega - O0) / (omega + O0)
    const minusSq =
      (omega.x - O0.x) ** 2 + (omega.y - O0.y) ** 2 + (omega.z - O0.z) ** 2 + omega.w ** 2;
    const plusSq =
      (omega.x + O0.x) ** 2 + (omega.y + O0.y) ** 2 + (omega.z + O0.z) ** 2 + omega.w ** 2;
    let rx: number;
    let ry: number;
    let rz: number;
    if (plusSq < minusSq) {
      rx = omega.x + O0.x;
      ry = omega.y + O0.y;
      rz = omega.z + O0.z;
    } else {
      rx = omega.x - O0.x;
      ry = omega.y - O0.y;
      rz = omega.z - O0.z;
    }

    const denomq = this.wq[j] + this.wq[jp] + 1e-6;
    const kb = this.params.kBend;
    const kt = this.params.kTwist;
    // first two axes = bending, third (along director) = twist
    const corr = this.tmpC.set((rx * kb) / denomq, (ry * kb) / denomq, (rz * kt) / denomq, 0);

    if (this.wq[j] > 0) {
      const dqj = qmul(qjp, corr, this.tmpA);
      qj.set(qj.x + this.wq[j] * dqj.x, qj.y + this.wq[j] * dqj.y, qj.z + this.wq[j] * dqj.z, qj.w + this.wq[j] * dqj.w).normalize();
    }
    if (this.wq[jp] > 0) {
      const dqjp = qmul(qj, corr, this.tmpA);
      qjp.set(qjp.x - this.wq[jp] * dqjp.x, qjp.y - this.wq[jp] * dqjp.y, qjp.z - this.wq[jp] * dqjp.z, qjp.w - this.wq[jp] * dqjp.w).normalize();
    }
  }

  private pinBase(): void {
    this.x[0].copy(this.base);
    this.q[0].copy(this.baseQ);
  }

  step(dt: number): void {
    const segs = this.params.segments;
    // rate-limited feed
    const maxStep = CosseratRod.FEED_RATE * Math.min(dt, 1 / 30);
    const want = this.input.deployed - this.deployedEff;
    this.deployedEff += Math.max(-maxStep, Math.min(maxStep, want));
    this.l0 = this.deployedEff / segs;
    this.updateRestShape();
    this.updateBaseFrame();

    // predict positions (Verlet, no external force; advancing is driven by l0 growth)
    const d = this.params.damping;
    for (let i = 1; i < this.n; i++) {
      const x = this.x[i];
      const p = this.prev[i];
      const vx = (x.x - p.x) * d;
      const vy = (x.y - p.y) * d;
      const vz = (x.z - p.z) * d;
      p.copy(x);
      x.set(x.x + vx, x.y + vy, x.z + vz);
    }

    const iters = this.params.iterations;
    for (let it = 0; it < iters; it++) {
      this.pinBase();
      // bilateral interleaving: forward then backward
      for (let j = 0; j < segs; j++) this.solveStretchShear(j);
      for (let kk = 0; kk < segs - 1; kk++) this.solveBendTwist(kk);
      for (let kk = segs - 2; kk >= 0; kk--) this.solveBendTwist(kk);
      for (let j = segs - 1; j >= 0; j--) this.solveStretchShear(j);
      this.pinBase();
      for (let i = 1; i < this.n; i++) this.contain(this.x[i]);
    }
    this.pinBase();
  }

  tip(): Vector3 {
    return this.x[this.n - 1];
  }

  deployedLength(): number {
    return this.deployedEff;
  }

  /** Max twist (radians) currently expressed at the tip frame — useful for diagnostics/tests. */
  tipRoll(): number {
    // angle between base director-roll and tip frame about the director
    return 2 * Math.acos(Math.min(1, Math.abs(this.q[this.q.length - 1].w)));
  }
}
