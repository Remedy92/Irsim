import type { RawCenterlineBranch, RawCenterlineTree } from "./anatomy-loader";

/**
 * Deterministic procedural generator for a SYNTHETIC distal arterial sub-tree, emitted in the
 * `RawCenterlineBranch[]` / `RawCenterlineTree` shape the anatomy ingestion bridge
 * (`anatomy-loader.ts`) consumes.
 *
 * WHY THIS EXISTS (the "shortest path to first redistributable realistic anatomy", per
 * docs/dicom-anatomy-pipeline.md + docs/anatomy-realism-roadmap.md §6c): no public real CTA is
 * MIT-shippable, so realistic distal anatomy is *grown*, not redistributed. This module grows a
 * binary bifurcating tree whose morphometry is calibrated to abdominal vascular literature, so the
 * output is generic / not patient-specific and may carry a CC0 / "procedurally generated" provenance
 * block. It is pure arithmetic on tuples — NO three.js, NO DOM — so it is fast and unit-testable.
 *
 * MORPHOMETRY MODEL
 * -----------------
 * 1. RADIUS SCALING — Murray's law with exponent γ ≈ 2.7 (NOT the classical 3.0). At every
 *    bifurcation the parent radius `Rp` splits into two children so that
 *
 *        Rp^γ = R1^γ + R2^γ                                         (Murray's law)
 *
 *    The classical γ=3 minimises pumping power + wall-material cost for an idealised single
 *    homogeneous bed. Pooled morphometry of ABDOMINAL arteries fits a *lower* exponent (~2.4–2.7);
 *    docs/anatomy-realism-roadmap.md §6c standardises on γ=2.7 for generated assets, so we do too.
 *    To avoid the over-symmetric trees a naive equal split produces, we draw an ASYMMETRY RATIO
 *    λ = R_small / R_large ∈ [0.4, 0.9] per bifurcation (deterministically, see RNG below). Given λ
 *    and Rp, Murray's law has a closed form:
 *
 *        R_large = Rp / (1 + λ^γ)^(1/γ),   R_small = λ · R_large
 *
 *    Both children are therefore strictly smaller than the parent (since (1+λ^γ)^(1/γ) > 1 for
 *    λ > 0), and the pair satisfies Murray's law exactly by construction.
 *
 * 2. BRANCHING ANGLE — each child diverges from the parent tangent by an angle in ~[25°, 45°]
 *    (drawn per child). The two children of a bifurcation are placed on OPPOSITE sides of the
 *    parent within a bifurcation plane whose azimuth is rotated deterministically per node, so the
 *    tree fans out in 3D rather than collapsing into a single plane. The smaller (higher-resistance)
 *    child takes the larger divergence angle, matching the observed tendency of minor branches to
 *    peel off more sharply.
 *
 * 3. SEGMENT LENGTH — decreases geometrically per generation (a child segment is a fixed fraction
 *    of its parent's length), and scales with radius so thin distal twigs are short. Growth stops
 *    when the radius would fall below a floor (default 0.04 cm ≈ 0.8 mm diameter, the small-caliber
 *    limit below which the single-radius capsule lumen is not meaningfully navigable) OR the
 *    requested generation count is reached.
 *
 * EXACT OSTIUM COINCIDENCE (the load-bearing connectivity requirement)
 * -------------------------------------------------------------------
 * `lumen.ts:buildAdjacency()` connects two branches only when they share an endpoint EXACTLY (within
 * 1e-3 cm). The bridge welds a child by snapping its `ostiumNear` to the NEAREST PARENT SAMPLE
 * (`anatomyDoc.ts:nearestPointOn`) and decimation ALWAYS keeps branch endpoints. Therefore, to make
 * the weld land at distance zero, a generated child's FIRST point must equal its parent's TERMINAL
 * point bit-for-bit. We enforce this by literally reusing the parent's last point tuple as the
 * child's `points[0]` — the child grows *from* the exact coordinates the parent ended at, so after
 * conversion the ostium snaps onto a sample that is identical to the child's first point and
 * `buildAdjacency` registers the junction. Every branch carries `parentId` so the bridge welds it.
 *
 * DETERMINISM
 * -----------
 * `Math.random` / `Date.now` are BANNED here (non-reproducible, and bad for tests). All randomness
 * comes from an inline 32-bit LCG seeded by the caller's `seed` mixed with a per-node hash, so the
 * same `opts` always yields byte-identical output and different seeds diverge.
 *
 * UNITS: centimetres. Body frame +y cranial, +x patient-left, +z anterior (matching anatomyDoc.ts).
 */

// ---------------------------------------------------------------------------
// Tunables (exported so callers / tests can reason about the growth budget).
// ---------------------------------------------------------------------------

/** Murray's law exponent for ABDOMINAL pooled morphometry (roadmap §6c) — not the classical 3.0. */
export const MURRAY_EXPONENT = 2.7;

/** Inclusive bounds on the per-bifurcation asymmetry ratio λ = R_small / R_large. */
export const ASYMMETRY_MIN = 0.4;
export const ASYMMETRY_MAX = 0.9;

/** Inclusive bounds (radians) on a child's divergence angle from the parent tangent (~25°–45°). */
export const BRANCH_ANGLE_MIN = (25 * Math.PI) / 180;
export const BRANCH_ANGLE_MAX = (45 * Math.PI) / 180;

/** Radius floor (cm): growth terminates on any child below this. ~0.8 mm diameter. */
export const RADIUS_FLOOR_CM = 0.04;

/** A first-generation segment's length as a multiple of the root radius. */
export const LENGTH_PER_RADIUS = 9;

/** Each generation's segment length is this fraction of its parent's segment length. */
export const LENGTH_DECAY = 0.78;

/** Points per branch polyline (≥4 so the centerline lofts smoothly and decimation has something to do). */
export const POINTS_PER_BRANCH = 5;

// ---------------------------------------------------------------------------
// Vector helpers (plain tuples; no three.js).
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number];

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l < 1e-9) return [0, 1, 0]; // degenerate input → arbitrary but stable unit (+y cranial)
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Any unit vector perpendicular to `t` (assumed unit). Picks the world axis least aligned with `t`
 * to avoid a near-degenerate cross product, so the result is numerically stable for every tangent.
 */
function anyPerp(t: Vec3): Vec3 {
  const ax = Math.abs(t[0]);
  const ay = Math.abs(t[1]);
  const az = Math.abs(t[2]);
  // Choose the axis with the smallest |component| — it is the most orthogonal to t.
  const axis: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return normalize(cross(t, axis));
}

/**
 * Rotate unit vector `v` about unit axis `k` by `theta` radians (Rodrigues' rotation formula).
 * Used to (a) tilt a child tangent off the parent tangent by the branching angle, and (b) spin the
 * bifurcation plane around the parent tangent so successive nodes fan out in 3D.
 */
function rotateAbout(v: Vec3, k: Vec3, theta: number): Vec3 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const kCrossV = cross(k, v);
  const kDotV = dot(k, v);
  return [
    v[0] * c + kCrossV[0] * s + k[0] * kDotV * (1 - c),
    v[1] * c + kCrossV[1] * s + k[1] * kDotV * (1 - c),
    v[2] * c + kCrossV[2] * s + k[2] * kDotV * (1 - c)
  ];
}

// ---------------------------------------------------------------------------
// Deterministic RNG — inline 32-bit LCG + a per-node hash (no Math.random).
// ---------------------------------------------------------------------------

/**
 * A tiny mutable LCG state. We mix the caller seed with a per-node integer key so each node draws
 * from an independent-looking stream while the whole tree stays a pure function of `seed`.
 *
 * Constants are the Numerical-Recipes LCG (m = 2^32 implicit via >>>0). It is not cryptographic —
 * it only needs to be reproducible and well-spread for visual variety, which it is.
 */
interface Rng {
  state: number;
}

/** Hash a node key (generation, sibling index, branch ordinal) + seed into a 32-bit LCG seed. */
function makeRng(seed: number, key: number): Rng {
  // splitmix-style avalanche of (seed, key) so adjacent keys do not produce correlated streams.
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = (h + Math.imul(key, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return { state: h >>> 0 };
}

/** Next float in [0, 1). Advances the LCG state. */
function nextFloat(rng: Rng): number {
  rng.state = (Math.imul(rng.state, 1664525) + 1013904223) >>> 0;
  // Use the top 24 bits for a clean [0,1) mantissa.
  return (rng.state >>> 8) / 0x01000000;
}

/** Uniform draw in [lo, hi). */
function range(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * nextFloat(rng);
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface GrowOptions {
  /** Prefix for every branch id (ids look like `${idPrefix}_gN_kM`). */
  idPrefix: string;
  /** Optional human-readable base name; branches get `${name} gN.M` (defaults to idPrefix). */
  name?: string;
  /** Ostium position the tree grows FROM (cm). Generation-1 branches start exactly here. */
  rootPoint: Vec3;
  /** Initial growth direction (need not be unit; normalised internally). */
  rootDir: Vec3;
  /** Lumen radius (cm) at the root ostium — the parent radius of the first bifurcation. */
  rootRadius: number;
  /** Number of bifurcating generations to grow (generation 1 = the first pair of children). */
  generations: number;
  /** Seed for the deterministic RNG. Same seed ⇒ identical output. */
  seed: number;
  /** Fluoroscopy attenuation weight applied to every generated branch (optional). */
  attenuation?: number;
}

/**
 * Internal description of a growth FRONTIER: a tip we may bifurcate next. It carries the exact
 * coordinates and state needed to spawn children and (critically) the parent's terminal point as a
 * tuple we will REUSE as the child's first point for exact ostium coincidence.
 */
interface Frontier {
  /** Branch id whose distal tip this frontier sits at (the parent of any children grown here). */
  branchId: string;
  /** Exact terminal point of that branch — children start here bit-for-bit. */
  tip: Vec3;
  /** Unit tangent at the tip (the direction the parent was heading). */
  tangent: Vec3;
  /** Lumen radius at the tip — the parent radius for the next Murray split. */
  radius: number;
  /** Length of the segment that produced this tip (next segment decays from it). */
  segLength: number;
  /** Generation index of the parent branch (children are generation+1). */
  generation: number;
  /** Stable integer key identifying this node, hashed into the RNG. */
  nodeKey: number;
}

/**
 * Grow a deterministic binary bifurcating sub-tree and return it as `RawCenterlineBranch[]`.
 *
 * Generation 1's two branches start EXACTLY at `rootPoint` (their `points[0] === rootPoint`), each
 * with no `parentId` set here — the CALLER decides whether the whole sub-tree welds onto a host
 * branch (see `attachToParent` / `hepaticSubtreeTree`) or stands alone. Within the sub-tree, every
 * deeper branch sets `parentId` to its grower and reuses the grower's terminal point as `points[0]`,
 * guaranteeing the exact-coincidence weld `lumen.ts:buildAdjacency` requires.
 */
export function growBifurcatingTree(opts: GrowOptions): RawCenterlineBranch[] {
  const { idPrefix, rootPoint, rootRadius, generations, seed } = opts;
  const baseName = opts.name ?? idPrefix;
  const rootDir = normalize(opts.rootDir);

  if (generations < 1) return [];
  if (rootRadius <= 0) {
    throw new Error(`growBifurcatingTree: rootRadius must be > 0, got ${rootRadius}`);
  }

  const out: RawCenterlineBranch[] = [];

  // Generation-0 is a virtual ostium node at rootPoint: we bifurcate it into the two gen-1 branches.
  // Subsequent frontiers are the distal tips of grown branches.
  let frontier: Frontier[] = [
    {
      branchId: "", // virtual root: gen-1 children carry no parentId (caller wires the host weld)
      tip: [rootPoint[0], rootPoint[1], rootPoint[2]],
      tangent: rootDir,
      radius: rootRadius,
      segLength: rootRadius * LENGTH_PER_RADIUS,
      generation: 0,
      nodeKey: 1
    }
  ];

  for (let gen = 1; gen <= generations; gen++) {
    const next: Frontier[] = [];
    for (let f = 0; f < frontier.length; f++) {
      const node = frontier[f];

      // Murray split of this node's radius into a large + small child.
      const rng = makeRng(seed, node.nodeKey);
      const lambda = clampLambda(range(rng, ASYMMETRY_MIN, ASYMMETRY_MAX));
      const { large, small } = murraySplit(node.radius, lambda);

      // Stop growing this node if even the LARGE child falls below the floor.
      if (large < RADIUS_FLOOR_CM) continue;

      // Bifurcation plane: a perpendicular to the parent tangent, spun by a per-node azimuth so the
      // tree fans out in 3D instead of staying planar.
      const azimuth = range(rng, 0, 2 * Math.PI);
      const perp0 = anyPerp(node.tangent);
      const planeNormal = rotateAbout(perp0, node.tangent, azimuth);

      // The two children diverge on OPPOSITE sides of the parent tangent within that plane. The
      // smaller (higher-resistance) child takes the larger angle.
      const angleLarge = range(rng, BRANCH_ANGLE_MIN, (BRANCH_ANGLE_MIN + BRANCH_ANGLE_MAX) / 2);
      const angleSmall = range(rng, (BRANCH_ANGLE_MIN + BRANCH_ANGLE_MAX) / 2, BRANCH_ANGLE_MAX);

      const children: Array<{ radius: number; angle: number; sign: number; k: number }> = [
        { radius: large, angle: angleLarge, sign: +1, k: 0 },
        { radius: small, angle: angleSmall, sign: -1, k: 1 }
      ];

      const segLength = node.segLength * LENGTH_DECAY;

      for (const child of children) {
        if (child.radius < RADIUS_FLOOR_CM) continue;

        // Child tangent: rotate the parent tangent by ±angle about the bifurcation-plane normal.
        const childTangent = normalize(
          rotateAbout(node.tangent, planeNormal, child.sign * child.angle)
        );

        const id = `${idPrefix}_g${gen}_k${out.length}`;
        const name = `${baseName} g${gen}.${child.k}`;
        const branch = buildBranch(
          id,
          name,
          node.branchId === "" ? undefined : node.branchId,
          node.tip,
          childTangent,
          node.radius,
          child.radius,
          segLength,
          opts.attenuation
        );
        out.push(branch);

        // The child's distal tip seeds the next frontier. nodeKey weaves generation + ordinal so
        // every node hashes to an independent RNG stream deterministically.
        const lastPoint = branch.points[branch.points.length - 1];
        next.push({
          branchId: id,
          tip: [lastPoint[0], lastPoint[1], lastPoint[2]],
          tangent: childTangent,
          radius: child.radius,
          segLength,
          generation: gen,
          nodeKey: hashNodeKey(node.nodeKey, gen, child.k)
        });
      }
    }
    frontier = next;
    if (frontier.length === 0) break; // radius floor terminated the whole front
  }

  return out;
}

/**
 * Wrap a hepatic-territory growth into a standalone `RawCenterlineTree` carrying a CC0 / synthetic
 * provenance block. The single-segment host branch ("hepatic_host") is the proper-hepatic stump the
 * generated lobar tree welds onto: its terminal point is `rootPoint`, and the generated gen-1
 * branches are re-parented onto it at exactly that point (exact coincidence ⇒ a connected lumen).
 *
 * The result can be loaded STANDALONE via `parseAnatomyInput` (host + generated tree compile to a
 * connected `Anatomy`), or the generated `branches` can be appended to NORMAL-style centerlines by a
 * caller that re-parents the gen-1 branches onto a real proper-hepatic branch (see
 * `attachToParent`).
 */
export function hepaticSubtreeTree(rootPoint: Vec3, rootDir: Vec3): RawCenterlineTree {
  const HOST_ID = "hepatic_host";
  const seed = 0x4ed8; // fixed so the shipped hepatic sub-tree is reproducible

  // A short proximal stub representing the proper-hepatic stump; its LAST point is the ostium the
  // lobar tree grows from. Two points are the minimum a RawCenterlineBranch accepts.
  const stubStart: Vec3 = add(rootPoint, scale(normalize(rootDir), -1.2));
  const host: RawCenterlineBranch = {
    id: HOST_ID,
    name: "Hepatic host stub (synthetic)",
    attenuation: 0.6,
    points: [stubStart, [rootPoint[0], rootPoint[1], rootPoint[2]]],
    radii: [0.24, 0.22]
  };

  const grown = growBifurcatingTree({
    idPrefix: "heptree",
    name: "Synthetic hepatic",
    rootPoint,
    rootDir,
    rootRadius: 0.22, // matches the R/L hepatic bifurcation radius in anatomy.ts
    generations: 5,
    seed,
    attenuation: 0.6
  });

  // Re-parent the standalone tree's gen-1 branches (parentId === undefined) onto the host stub.
  const branches = attachToParent(grown, HOST_ID);
  branches.unshift(host);

  return {
    id: "synth_hepatic",
    name: "Synthetic hepatic sub-tree",
    branches,
    provenance: {
      source: "IRsim procedural generator (synth-tree.ts) — Murray's-law bifurcating growth",
      license: "CC0-1.0",
      note:
        "Procedurally generated, generic, NOT patient-specific. Radii propagated by Murray's law " +
        `(γ=${MURRAY_EXPONENT}, abdominal pooled empirical). Deterministic (seed=${seed}). ` +
        "Safe to redistribute under CC0. Verify clinical credibility before any labelled use."
    }
  };
}

/**
 * Re-parent a tree grown standalone (its generation-1 branches have `parentId === undefined`) onto a
 * host branch id, returning a NEW array (inputs untouched). The gen-1 branches already start exactly
 * at the growth root, so for the weld to land we additionally require the host's terminal centerline
 * point to equal that root — which `hepaticSubtreeTree` guarantees by construction, and which a
 * caller appending to NORMAL centerlines must arrange by passing the real parent's terminal point as
 * the growth `rootPoint`.
 */
export function attachToParent(
  branches: RawCenterlineBranch[],
  hostId: string
): RawCenterlineBranch[] {
  return branches.map((b) =>
    b.parentId === undefined ? { ...b, parentId: hostId } : { ...b }
  );
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/** Clamp a drawn asymmetry ratio to the documented band (defensive; the draw is already in-range). */
function clampLambda(lambda: number): number {
  return Math.max(ASYMMETRY_MIN, Math.min(ASYMMETRY_MAX, lambda));
}

/**
 * Split a parent radius into a large + small child satisfying Murray's law exactly for the drawn
 * asymmetry ratio λ = R_small / R_large. Derivation: Murray's law is Rp^γ = Rl^γ + Rs^γ; substitute
 * Rs = λ·Rl ⇒ Rp^γ = Rl^γ(1 + λ^γ) ⇒ Rl = Rp / (1 + λ^γ)^(1/γ), and Rs = λ·Rl. Both are strictly
 * below Rp because (1 + λ^γ)^(1/γ) > 1 for any λ > 0.
 */
function murraySplit(parentRadius: number, lambda: number): { large: number; small: number } {
  const denom = Math.pow(1 + Math.pow(lambda, MURRAY_EXPONENT), 1 / MURRAY_EXPONENT);
  const large = parentRadius / denom;
  const small = lambda * large;
  return { large, small };
}

/**
 * Build one branch polyline of `POINTS_PER_BRANCH` points growing from `tip` along `tangent`, with
 * the lumen radius tapering linearly from `radiusStart` (at the ostium) to `radiusEnd` (at the
 * distal tip). The FIRST point is the parent's terminal `tip` reused bit-for-bit — this is the exact
 * ostium coincidence the weld depends on. The polyline curves gently along its length (a small
 * cubic-ish lateral sag) so the loft is not a dead-straight stick, while keeping the endpoints exact.
 */
function buildBranch(
  id: string,
  name: string,
  parentId: string | undefined,
  tip: Vec3,
  tangent: Vec3,
  radiusStart: number,
  radiusEnd: number,
  segLength: number,
  attenuation?: number
): RawCenterlineBranch {
  const n = POINTS_PER_BRANCH;
  const points: Vec3[] = [];
  const radii: number[] = [];

  // A small consistent lateral curvature so branches read as vessels, not line segments. The
  // direction is the in-plane perpendicular of the tangent; magnitude is a fraction of seg length.
  const lateral = anyPerp(tangent);
  const sag = segLength * 0.06;

  for (let i = 0; i < n; i++) {
    const u = i / (n - 1); // 0 at ostium → 1 at distal tip
    if (i === 0) {
      // EXACT ostium: reuse the parent terminal coordinates bit-for-bit (no arithmetic drift).
      points.push([tip[0], tip[1], tip[2]]);
    } else {
      const along = scale(tangent, segLength * u);
      // sin bump: zero at both ends, peak mid-branch → keeps the distal tip on the straight ray so
      // child frontiers stay easy to reason about while the body of the branch curves.
      const bump = scale(lateral, sag * Math.sin(Math.PI * u));
      points.push(add(add(tip, along), bump));
    }
    radii.push(radiusStart + (radiusEnd - radiusStart) * u);
  }

  const branch: RawCenterlineBranch = {
    id,
    name,
    points,
    radii
  };
  if (parentId !== undefined) branch.parentId = parentId;
  if (attenuation !== undefined) branch.attenuation = attenuation;
  return branch;
}

/** Mix a parent node key with generation + sibling ordinal into a fresh stable node key. */
function hashNodeKey(parentKey: number, generation: number, sibling: number): number {
  let h = (parentKey + 1) >>> 0;
  h = Math.imul(h ^ (generation + 1), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (sibling + 1), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h >>> 0;
}
