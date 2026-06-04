import { Vector3 } from "three";
import type { Anatomy, LumenEdge, LumenQuery } from "./types";

/**
 * Variable-radius capsule-chain implicit lumen (design doc §7).
 *
 * Replaces the Stage-3 nearest-single-segment containment stub. The lumen is the union of
 * variable-radius capsules along every vessel centerline edge:
 *
 *     φ(x) = min over edges e of ( d(x, segment_e) − R_e(u) )      (inside ⇔ φ ≤ 0)
 *
 * For an instrument of radius r the allowed CENTERLINE radius is
 *
 *     R_eff(s) = R_lumen(s) − r − ε_c
 *
 * so the instrument SURFACE (not its centerline) stays off the wall.
 *
 * Why not plain nearest-segment? At an ostium / bifurcation the globally-nearest centerline
 * can belong to the WRONG branch, so a naive projection snaps a wire across the carina into a
 * branch it never entered (design doc top-pitfall #8). We fix this with:
 *
 *   - GRAPH adjacency: each edge knows the edges it shares an endpoint with (ostia). A query
 *     carries the node's CURRENT edge id and searches that edge + its graph neighbours first.
 *   - BRANCH-TRANSITION gating: a query may only switch to a DIFFERENT branch when the node is
 *     near a shared ostium (the only place branches actually connect) — never mid-vessel.
 *   - HYSTERESIS: even an allowed switch is only taken if the candidate edge is closer by more
 *     than a margin Δ_hys (≈ 0.5·R), so a node hovering between two near-parallel centerlines
 *     does not flip-flop its containing edge each iteration.
 *
 * Acceleration: a uniform spatial grid over each capsule's expanded AABB gives O(1)-ish
 * candidate lookup for the global-nearest fallback (used on first acquisition / re-acquisition
 * after a long jump). Steady-state queries hit the cheap local search and never touch the grid.
 *
 * UNITS: centimetres throughout. Allocation-free on the hot path: all Vector3 temporaries are
 * module-level scratch and queries write into a caller-supplied LumenQuery.
 */

const _ab = new Vector3();
const _ap = new Vector3();
const _cp = new Vector3();
const _tan = new Vector3();
const _lo = new Vector3();
const _hi = new Vector3();

/** Closest point of segment [a,b] to p, into `out`; returns the clamped parameter u ∈ [0,1]. */
function closestOnSeg(p: Vector3, a: Vector3, b: Vector3, out: Vector3): number {
  _ab.subVectors(b, a);
  _ap.subVectors(p, a);
  const len2 = _ab.lengthSq() || 1e-12;
  const u = Math.max(0, Math.min(1, _ap.dot(_ab) / len2));
  out.copy(a).addScaledVector(_ab, u);
  return u;
}

/** Radius interpolated along a capsule edge at parameter u. */
function radiusAt(e: LumenEdge, u: number): number {
  return e.ra + (e.rb - e.ra) * u;
}

export class Lumen {
  /** The capsule-chain edges (one per centerline segment), with branch id + graph adjacency. */
  readonly edges: LumenEdge[] = [];

  // ---- uniform spatial grid over expanded-capsule AABBs (for global-nearest fallback) ----
  private cell = 1; // cm
  private inv = 1;
  private gridMin = new Vector3();
  private nx = 1;
  private ny = 1;
  private nz = 1;
  /** grid[cellIndex] = list of edge indices whose expanded AABB overlaps the cell. */
  private grid: number[][] = [];

  constructor(anatomy: Anatomy) {
    // 1. build one capsule edge per centerline segment, tagged with its branch.
    for (const br of anatomy.branches) {
      for (let i = 0; i < br.points.length - 1; i++) {
        this.edges.push({
          a: br.points[i].pos.clone(),
          b: br.points[i + 1].pos.clone(),
          ra: br.points[i].radius,
          rb: br.points[i + 1].radius,
          branchId: br.id,
          edgeIndex: this.edges.length,
          adjacent: []
        });
      }
    }
    this.buildAdjacency();
    this.buildGrid();
  }

  /**
   * Graph adjacency from shared endpoints. Two edges are adjacent when an endpoint of one is
   * (nearly) coincident with an endpoint of the other — i.e. they meet at a vessel junction or
   * a branch ostium. This is what lets a query walk the vessel TREE rather than snapping across
   * a carina by raw Euclidean distance. Branches connect by sharing the world position of their
   * first centerline point with a point on the parent (see anatomy.ts), so ostia register here.
   */
  private buildAdjacency(): void {
    const tol = 1e-3; // cm — anatomy ostia share exact control points
    const tol2 = tol * tol;
    const touches = (p: Vector3, e: LumenEdge) =>
      p.distanceToSquared(e.a) < tol2 || p.distanceToSquared(e.b) < tol2;
    for (let i = 0; i < this.edges.length; i++) {
      const ei = this.edges[i];
      for (let j = 0; j < this.edges.length; j++) {
        if (i === j) continue;
        const ej = this.edges[j];
        if (touches(ei.a, ej) || touches(ei.b, ej)) ei.adjacent.push(j);
      }
    }
  }

  /** Is edge `j` in a DIFFERENT branch than edge `i` (a true branch transition)? */
  private differentBranch(i: number, j: number): boolean {
    return this.edges[i].branchId !== this.edges[j].branchId;
  }

  /**
   * True if querying point `p` is near a shared ostium of edge `i` — i.e. close to one of its
   * endpoints. Branch transitions are only permitted here (never mid-vessel). `nearScale`
   * multiplies the local radius to size the ostium neighbourhood.
   */
  private nearOstium(p: Vector3, i: number, nearScale: number): boolean {
    const e = this.edges[i];
    const rNear = nearScale * Math.max(e.ra, e.rb);
    return p.distanceTo(e.a) < rNear || p.distanceTo(e.b) < rNear;
  }

  // ---- spatial grid ----

  private buildGrid(): void {
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    let maxR = 0.1;
    for (const e of this.edges) {
      maxR = Math.max(maxR, e.ra, e.rb);
      min.min(e.a).min(e.b);
      max.max(e.a).max(e.b);
    }
    if (!Number.isFinite(min.x)) {
      // no edges — degenerate; leave a 1-cell empty grid
      this.gridMin.set(0, 0, 0);
      this.nx = this.ny = this.nz = 1;
      this.grid = [[]];
      return;
    }
    // pad by the largest radius so an expanded capsule always falls in the grid
    min.subScalar(maxR + 1e-3);
    max.addScalar(maxR + 1e-3);
    this.cell = Math.max(0.5, 2 * maxR); // a cell ~ one vessel diameter
    this.inv = 1 / this.cell;
    this.gridMin.copy(min);
    this.nx = Math.max(1, Math.ceil((max.x - min.x) * this.inv));
    this.ny = Math.max(1, Math.ceil((max.y - min.y) * this.inv));
    this.nz = Math.max(1, Math.ceil((max.z - min.z) * this.inv));
    this.grid = new Array(this.nx * this.ny * this.nz);
    for (let c = 0; c < this.grid.length; c++) this.grid[c] = [];
    // insert each edge into every cell its expanded AABB overlaps
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const r = Math.max(e.ra, e.rb);
      _lo.copy(e.a).min(e.b).subScalar(r);
      _hi.copy(e.a).max(e.b).addScalar(r);
      const x0 = this.clampIdx((_lo.x - min.x) * this.inv, this.nx);
      const x1 = this.clampIdx((_hi.x - min.x) * this.inv, this.nx);
      const y0 = this.clampIdx((_lo.y - min.y) * this.inv, this.ny);
      const y1 = this.clampIdx((_hi.y - min.y) * this.inv, this.ny);
      const z0 = this.clampIdx((_lo.z - min.z) * this.inv, this.nz);
      const z1 = this.clampIdx((_hi.z - min.z) * this.inv, this.nz);
      for (let z = z0; z <= z1; z++)
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) this.grid[this.cellIndex(x, y, z)].push(i);
    }
  }

  private clampIdx(f: number, n: number): number {
    return Math.max(0, Math.min(n - 1, Math.floor(f)));
  }

  private cellIndex(x: number, y: number, z: number): number {
    return (z * this.ny + y) * this.nx + x;
  }

  // ---- distance helpers ----

  /** Surface distance of p to edge e: d(p, segment) − R_e(u). Negative = inside that capsule. */
  private edgeSurfaceDistance(p: Vector3, e: LumenEdge): number {
    const u = closestOnSeg(p, e.a, e.b, _cp);
    return p.distanceTo(_cp) - radiusAt(e, u);
  }

  /**
   * Implicit lumen field φ(x): the minimum over all edges of (centerline distance − R_edge).
   * φ ≤ 0 ⇔ inside the (union-of-capsules) lumen. Smooth-min across edges keeps the field
   * CONTINUOUS across a bifurcation carina (a hard min has a crease there). `k` is the
   * smooth-union sharpness in cm; smaller k ⇒ closer to a hard min.
   */
  phi(x: Vector3, k = 0.25): number {
    let best = Infinity;
    for (const e of this.edges) {
      const d = this.edgeSurfaceDistance(x, e);
      // exponential smooth-min (log-sum-exp): −k·log Σ exp(−d/k) ≈ min(d) but C¹-continuous.
      best = best === Infinity ? d : smoothMin(best, d, k);
    }
    return best === Infinity ? 1 : best;
  }

  /** Hard nearest-edge surface distance (no smoothing) — used for sign tests. */
  phiHard(x: Vector3): number {
    let best = Infinity;
    for (const e of this.edges) {
      const d = this.edgeSurfaceDistance(x, e);
      if (d < best) best = d;
    }
    return best === Infinity ? 1 : best;
  }

  /** Inside test using the hard field (robust sign). */
  inside(x: Vector3): boolean {
    return this.phiHard(x) <= 0;
  }

  /** All edge indices overlapping the cell containing `p` (the grid candidate set). */
  private candidatesNear(p: Vector3, out: number[]): void {
    out.length = 0;
    const x = this.clampIdx((p.x - this.gridMin.x) * this.inv, this.nx);
    const y = this.clampIdx((p.y - this.gridMin.y) * this.inv, this.ny);
    const z = this.clampIdx((p.z - this.gridMin.z) * this.inv, this.nz);
    // search the 3×3×3 neighbourhood so a point just outside its own cell still finds edges
    for (let dz = -1; dz <= 1; dz++) {
      const zz = z + dz;
      if (zz < 0 || zz >= this.nz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= this.ny) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= this.nx) continue;
          const list = this.grid[this.cellIndex(xx, yy, zz)];
          for (const ei of list) if (out.indexOf(ei) < 0) out.push(ei);
        }
      }
    }
  }

  private _scratchCandidates: number[] = [];

  /**
   * GRAPH-AWARE nearest-edge query with hysteresis (design doc §7).
   *
   * Finds the lumen edge that contains/owns sample point `center`, writing the closest
   * centerline point, the lumen radius there, the vessel tangent, the chosen edge index and
   * arc parameter, and the inside flag into `out`. Returns the chosen edge index (also in
   * out.edgeIndex), which the caller stores as the node's new `currentEdge` for the next query.
   *
   * `currentEdge` is the node's last containing edge (−1 = unknown / first acquisition):
   *   - If valid, search currentEdge + its graph neighbours and keep the closest. A switch to a
   *     DIFFERENT branch is only accepted when `center` is near a shared ostium AND the candidate
   *     is closer by more than the hysteresis margin Δ_hys = hysteresisFrac·R. Same-branch
   *     neighbours (continuing along the vessel) switch freely.
   *   - If unknown, or if the local search leaves the point far outside the lumen (lost / a long
   *     jump), fall back to the grid global-nearest to re-acquire.
   */
  query(center: Vector3, currentEdge: number, out: LumenQuery, hysteresisFrac = 0.5): number {
    if (this.edges.length === 0) {
      out.center.copy(center);
      out.radius = 1;
      out.tangent.set(0, 0, 1);
      out.edgeIndex = -1;
      out.arc = 0;
      out.inside = true;
      return -1;
    }

    let chosen = -1;
    let chosenU = 0;
    let chosenD = Infinity;

    const consider = (i: number) => {
      const e = this.edges[i];
      const u = closestOnSeg(center, e.a, e.b, _cp);
      const d = center.distanceTo(_cp) - radiusAt(e, u); // surface distance
      if (chosen < 0) {
        chosen = i;
        chosenU = u;
        chosenD = d;
        return;
      }
      if (i === currentEdge) {
        // bias toward staying on the current edge: only beaten by Δ_hys
        return;
      }
      const margin = hysteresisFrac * Math.max(this.edges[i].ra, this.edges[i].rb);
      const isSwitch = currentEdge >= 0 && this.differentBranch(currentEdge, i);
      if (isSwitch) {
        // branch transition: only near a shared ostium, and only if clearly closer
        if (!this.nearOstium(center, currentEdge, 1.5)) return;
        if (d < chosenD - margin) {
          chosen = i;
          chosenU = u;
          chosenD = d;
        }
      } else {
        // same branch (continuing the vessel): a small margin still damps flip-flop
        if (d < chosenD - 1e-4) {
          chosen = i;
          chosenU = u;
          chosenD = d;
        }
      }
    };

    if (currentEdge >= 0 && currentEdge < this.edges.length) {
      // seed with the current edge, then test its graph neighbours
      consider(currentEdge);
      for (const j of this.edges[currentEdge].adjacent) consider(j);
    }

    // (Re)acquire via the grid if we have no edge yet, or the local search left us well outside
    // the lumen (a lost node / long jump): the true nearest edge may be non-adjacent. A lost node
    // re-acquires to the GLOBAL nearest edge UNCONDITIONALLY (the hysteresis/branch gating only
    // governs steady-state tracking of a node that IS inside its current edge — it must never
    // strand a genuinely lost node on the wrong branch).
    const localR = chosen >= 0 ? Math.max(this.edges[chosen].ra, this.edges[chosen].rb) : 1;
    if (chosen < 0 || chosenD > localR) {
      const cand = this._scratchCandidates;
      this.candidatesNear(center, cand);
      const useGrid = cand.length > 0;
      const scanGlobalNearest = (i: number) => {
        const e = this.edges[i];
        const u = closestOnSeg(center, e.a, e.b, _cp);
        const d = center.distanceTo(_cp) - radiusAt(e, u);
        if (chosen < 0 || d < chosenD) {
          chosen = i;
          chosenU = u;
          chosenD = d;
        }
      };
      if (useGrid) for (const i of cand) scanGlobalNearest(i);
      // if the grid produced nothing close (or was empty here), brute-force the whole chain
      if (chosen < 0 || chosenD > localR) {
        for (let i = 0; i < this.edges.length; i++) scanGlobalNearest(i);
      }
    }

    const e = this.edges[chosen];
    closestOnSeg(center, e.a, e.b, _cp);
    out.center.copy(_cp);
    out.radius = radiusAt(e, chosenU);
    _tan.subVectors(e.b, e.a);
    if (_tan.lengthSq() < 1e-12) _tan.set(0, 0, 1);
    out.tangent.copy(_tan).normalize();
    out.edgeIndex = chosen;
    out.arc = chosenU;
    out.inside = chosenD <= 0;
    return chosen;
  }
}

/** Exponential smooth-min of two distances (C¹-continuous union). Smaller `k` ⇒ sharper. */
export function smoothMin(a: number, b: number, k: number): number {
  if (k <= 1e-9) return Math.min(a, b);
  // numerically-stable log-sum-exp around the smaller value
  const m = Math.min(a, b);
  return m - k * Math.log(Math.exp(-(a - m) / k) + Math.exp(-(b - m) / k));
}
