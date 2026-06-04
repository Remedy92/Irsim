import { Vector3 } from "three";
import type { Anatomy } from "./types";

/**
 * Elastic guidewire/sheath model (Phase-0 physics).
 *
 * This is a position-based dynamics (PBD) elastic rod:
 *   - inextensible distance constraints (segment length),
 *   - bending constraints that give the rod column strength (so it can be pushed
 *     and so it straightens), tunable per instrument (a stiff sheath vs a floppy wire),
 *   - lumen containment against the vessel centerline (keeps the wire inside the artery),
 *   - a base "feed" model: advancing grows deployed length and pushes the tip forward,
 *   - a torqueable, steerable angled tip for selecting branches.
 *
 * It is intentionally stable and demonstrable. The roadmap upgrade is a full
 * orientation-based Cosserat rod (position + quaternion DOFs, bend-twist coupling),
 * added behind this with its own constraint unit tests — see ROADMAP.md.
 */

interface LumenSeg {
  a: Vector3;
  b: Vector3;
  ra: number;
  rb: number;
}

export interface RodParams {
  particles: number;
  rodRadius: number; // cm
  bendStiffness: number; // 0..1 — column strength / pushability
  iterations: number;
  damping: number;
  /** how many tip particles respond to steering */
  tipSpan: number;
}

export const GUIDEWIRE: RodParams = {
  particles: 90,
  rodRadius: 0.05,
  bendStiffness: 0.2,
  iterations: 18,
  damping: 0.86,
  tipSpan: 10
};

export interface RodInput {
  /** total deployed length in cm */
  deployed: number;
  /** tip deflection 0..1 (angled/J tip "tightness") */
  steer: number;
  /** rotation of the tip bending plane about the shaft tangent (radians) */
  torque: number;
}

const _ab = new Vector3();
const _ap = new Vector3();
const _tmp = new Vector3();

function closestOnSeg(p: Vector3, a: Vector3, b: Vector3, out: Vector3): number {
  _ab.subVectors(b, a);
  _ap.subVectors(p, a);
  const len2 = _ab.lengthSq() || 1e-9;
  let t = _ap.dot(_ab) / len2;
  t = Math.max(0, Math.min(1, t));
  out.copy(a).addScaledVector(_ab, t);
  return t;
}

export class Rod {
  readonly params: RodParams;
  readonly n: number;
  x: Vector3[];
  prev: Vector3[];
  restLen = 0.4;
  private lumen: LumenSeg[];
  private base = new Vector3();
  private baseDir = new Vector3(0, 1, 0);
  input: RodInput = { deployed: 6, steer: 0.4, torque: 0 };

  constructor(anatomy: Anatomy, accessId: string, params: RodParams = GUIDEWIRE) {
    this.params = params;
    this.n = params.particles;

    const access = anatomy.access.find((a) => a.id === accessId) ?? anatomy.access[0];
    this.base.copy(access.pos);
    this.baseDir.copy(access.dir).normalize();

    // Build the lumen as a flat list of centerline segments with per-end radii.
    this.lumen = [];
    for (const br of anatomy.branches) {
      for (let i = 0; i < br.points.length - 1; i++) {
        this.lumen.push({
          a: br.points[i].pos,
          b: br.points[i + 1].pos,
          ra: br.points[i].radius,
          rb: br.points[i + 1].radius
        });
      }
    }

    // Seed the rod as a short stub pointing from the access into the vessel.
    this.x = [];
    this.prev = [];
    for (let i = 0; i < this.n; i++) {
      const p = this.base.clone().addScaledVector(this.baseDir, i * 0.08);
      this.x.push(p);
      this.prev.push(p.clone());
    }
  }

  /** Nearest lumen radius minus the rod radius — the max allowed offset from the centerline. */
  private contain(p: Vector3): void {
    let bestD2 = Infinity;
    let bestPoint = _tmp;
    let bestRadius = 1;
    const cp = new Vector3();
    for (const seg of this.lumen) {
      const t = closestOnSeg(p, seg.a, seg.b, cp);
      const d2 = p.distanceToSquared(cp);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestPoint = cp.clone();
        bestRadius = seg.ra + (seg.rb - seg.ra) * t;
      }
    }
    const allowed = Math.max(0.02, bestRadius - this.params.rodRadius);
    const d = Math.sqrt(bestD2);
    if (d > allowed) {
      // pull the particle back inside the lumen wall
      p.lerp(bestPoint, 1 - allowed / Math.max(d, 1e-6));
    }
  }

  step(_dt: number): void {
    const { iterations, damping, bendStiffness, tipSpan } = this.params;
    this.restLen = this.input.deployed / (this.n - 1);

    // --- Predict (Verlet) ---
    for (let i = 0; i < this.n; i++) {
      const x = this.x[i];
      const prev = this.prev[i];
      const vx = (x.x - prev.x) * damping;
      const vy = (x.y - prev.y) * damping;
      const vz = (x.z - prev.z) * damping;
      prev.copy(x);
      x.set(x.x + vx, x.y + vy, x.z + vz);
    }

    // Steering target direction: a vector perpendicular to the tip tangent,
    // rotated about the tangent by `torque`. This is the angled/torqueable tip.
    const tangent = _ab.subVectors(this.x[this.n - 1], this.x[this.n - 2]).normalize();
    const ref = Math.abs(tangent.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
    const side = new Vector3().crossVectors(tangent, ref).normalize();
    const up = new Vector3().crossVectors(side, tangent).normalize();
    const deflect = side
      .multiplyScalar(Math.cos(this.input.torque))
      .addScaledVector(up, Math.sin(this.input.torque))
      .normalize();

    for (let iter = 0; iter < iterations; iter++) {
      // Pin the base at the access site, pointing into the vessel.
      this.x[0].copy(this.base);
      this.x[1].copy(this.base).addScaledVector(this.baseDir, this.restLen);

      // Distance (stretch) constraints — inextensible.
      for (let i = 0; i < this.n - 1; i++) {
        const a = this.x[i];
        const b = this.x[i + 1];
        _tmp.subVectors(b, a);
        const d = _tmp.length() || 1e-6;
        const diff = (d - this.restLen) / d;
        const wA = i <= 1 ? 0 : 0.5;
        const wB = 0.5;
        const wn = wA + wB || 1;
        a.addScaledVector(_tmp, (diff * wA) / wn);
        b.addScaledVector(_tmp, (-diff * wB) / wn);
      }

      // Bending constraints — pull each interior node toward the midpoint of its
      // neighbours (collinear rest), giving the rod column strength / pushability.
      for (let i = 1; i < this.n - 1; i++) {
        if (i <= 1) continue;
        const a = this.x[i - 1];
        const c = this.x[i + 1];
        const m = this.x[i];
        _tmp.addVectors(a, c).multiplyScalar(0.5).sub(m);
        m.addScaledVector(_tmp, bendStiffness);
      }

      // Steerable tip: nudge the last `tipSpan` particles toward the deflection
      // direction. Divided by `iterations` so the total per-step displacement is
      // bounded (otherwise it compounds across the solver loop and the rod oscillates).
      const s = this.input.steer;
      for (let k = 0; k < tipSpan; k++) {
        const i = this.n - 1 - k;
        if (i < 2) break;
        const w = (tipSpan - k) / tipSpan;
        this.x[i].addScaledVector(deflect, (s * 0.5 * w) / iterations);
      }

      // Lumen containment last, so the wire always ends an iteration inside the artery.
      for (let i = 2; i < this.n; i++) this.contain(this.x[i]);
    }
  }

  tip(): Vector3 {
    return this.x[this.n - 1];
  }

  /** Arc-length actually inside the vessel from base to tip (cm) — drives "depth" feedback. */
  deployedLength(): number {
    return this.input.deployed;
  }
}
