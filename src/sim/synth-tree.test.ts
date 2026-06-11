import { describe, expect, it } from "vitest";
import {
  growBifurcatingTree,
  hepaticSubtreeTree,
  attachToParent,
  MURRAY_EXPONENT,
  ASYMMETRY_MIN,
  ASYMMETRY_MAX,
  RADIUS_FLOOR_CM,
  POINTS_PER_BRANCH,
  type GrowOptions
} from "./synth-tree";
import { anatomyDocFromCenterlines, type RawCenterlineBranch, type RawCenterlineTree } from "./anatomy-loader";
import { compileAnatomy } from "./anatomyDoc";
import { Lumen } from "./lumen";

/**
 * Acceptance tests for the deterministic synthetic distal-tree generator (synth-tree.ts):
 *
 *   - DETERMINISM: same seed ⇒ byte-identical output; different seed ⇒ divergent output.
 *   - MURRAY'S LAW: every bifurcation satisfies Rp^γ ≈ R1^γ + R2^γ (γ = 2.7) within tolerance.
 *   - MONOTONIC RADII: a child is strictly thinner than its parent; the radius floor + generation
 *     count are respected; all radii are finite and positive.
 *   - END-TO-END THROUGH THE BRIDGE: a generated sub-tree welded onto a synthetic parent flows
 *     through anatomyDocFromCenterlines → compileAnatomy → new Lumen and the first generation is
 *     graph-adjacent to the parent (connectivity survives generation + conversion + the ostium weld).
 *
 * UNITS: centimetres throughout. Body frame +y cranial, +x patient-left, +z anterior.
 */

const BASE_OPTS: GrowOptions = {
  idPrefix: "t",
  name: "Test tree",
  rootPoint: [0, 0, 0],
  rootDir: [0, 1, 0],
  rootRadius: 0.3,
  generations: 4,
  seed: 12345
};

/** Index a generated tree by id for parent/child lookups. */
function byId(branches: RawCenterlineBranch[]): Map<string, RawCenterlineBranch> {
  return new Map(branches.map((b) => [b.id, b]));
}

/** The lumen radius at a branch's distal (last) point — its tip radius for Murray comparisons. */
function tipRadius(b: RawCenterlineBranch): number {
  return b.radii[b.radii.length - 1];
}

/** The lumen radius at a branch's proximal (first/ostium) point — equals its parent's tip radius. */
function ostiumRadius(b: RawCenterlineBranch): number {
  return b.radii[0];
}

describe("growBifurcatingTree — determinism", () => {
  it("produces byte-identical output for the same seed", () => {
    const a = growBifurcatingTree(BASE_OPTS);
    const b = growBifurcatingTree(BASE_OPTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces different output for a different seed", () => {
    const a = growBifurcatingTree(BASE_OPTS);
    const b = growBifurcatingTree({ ...BASE_OPTS, seed: 999 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("does not depend on Math.random (stable across a perturbed global RNG)", () => {
    const a = growBifurcatingTree(BASE_OPTS);
    // Burn the global RNG; a Math.random-based generator would now diverge.
    for (let i = 0; i < 50; i++) Math.random();
    const b = growBifurcatingTree(BASE_OPTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("growBifurcatingTree — morphometry", () => {
  it("satisfies Murray's law (γ = 2.7) at every bifurcation", () => {
    const branches = growBifurcatingTree(BASE_OPTS);
    const index = byId(branches);

    // Group children by parent id. The two children of a node form one bifurcation; compare the
    // parent's TIP radius (its radius at the bifurcation) with the children's OSTIUM radii.
    const childrenOf = new Map<string, RawCenterlineBranch[]>();
    for (const b of branches) {
      if (b.parentId === undefined) continue;
      const list = childrenOf.get(b.parentId) ?? [];
      list.push(b);
      childrenOf.set(b.parentId, list);
    }

    let checked = 0;
    for (const [parentId, kids] of childrenOf) {
      if (kids.length !== 2) continue; // only full bifurcations are governed by the 2-child law
      const parent = index.get(parentId)!;
      // The lumen is CONTINUOUS across the ostium (a child's ostium radius equals the parent's tip),
      // so a child's Murray-split radius is its DISTAL (tip) radius — the radius at which that child
      // would itself bifurcate. Compare parent tip vs each child's tip.
      const rp = tipRadius(parent);
      const r1 = tipRadius(kids[0]);
      const r2 = tipRadius(kids[1]);
      const lhs = Math.pow(rp, MURRAY_EXPONENT);
      const rhs = Math.pow(r1, MURRAY_EXPONENT) + Math.pow(r2, MURRAY_EXPONENT);
      // Relative error: the split is closed-form so this should be at the floating-point floor.
      expect(Math.abs(lhs - rhs) / lhs).toBeLessThan(1e-9);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("draws asymmetry ratios within [0.4, 0.9] (children differ but both shrink)", () => {
    const branches = growBifurcatingTree(BASE_OPTS);
    const index = byId(branches);
    const childrenOf = new Map<string, RawCenterlineBranch[]>();
    for (const b of branches) {
      if (b.parentId === undefined) continue;
      const list = childrenOf.get(b.parentId) ?? [];
      list.push(b);
      childrenOf.set(b.parentId, list);
    }
    for (const [parentId, kids] of childrenOf) {
      if (kids.length !== 2) continue;
      const parent = index.get(parentId)!;
      // Compare distal (tip) radii — the Murray-split outputs (see the law test above).
      const rp = tipRadius(parent);
      const rLarge = Math.max(tipRadius(kids[0]), tipRadius(kids[1]));
      const rSmall = Math.min(tipRadius(kids[0]), tipRadius(kids[1]));
      // Both children strictly smaller than the parent.
      expect(rLarge).toBeLessThan(rp);
      // Asymmetry λ = rSmall/rLarge stays in the documented band.
      const lambda = rSmall / rLarge;
      expect(lambda).toBeGreaterThanOrEqual(ASYMMETRY_MIN - 1e-9);
      expect(lambda).toBeLessThanOrEqual(ASYMMETRY_MAX + 1e-9);
    }
  });

  it("makes radii strictly decrease parent → child", () => {
    const branches = growBifurcatingTree(BASE_OPTS);
    const index = byId(branches);
    for (const b of branches) {
      if (b.parentId === undefined) continue;
      const parent = index.get(b.parentId);
      if (!parent) continue; // first-gen branches point at the (virtual) host; skip
      // The lumen is continuous at the ostium (child ostium radius == parent tip radius), and the
      // child then TAPERS to a strictly smaller tip — so the child's TIP is strictly below the
      // parent's tip, the meaningful "child is thinner than parent" invariant.
      expect(ostiumRadius(b)).toBeCloseTo(tipRadius(parent), 9);
      expect(tipRadius(b)).toBeLessThan(tipRadius(parent));
      // Each branch tapers along its own length (ostium > tip).
      expect(tipRadius(b)).toBeLessThan(ostiumRadius(b) + 1e-12);
    }
  });

  it("respects the radius floor (no branch thinner than the floor)", () => {
    const branches = growBifurcatingTree({ ...BASE_OPTS, generations: 12 });
    for (const b of branches) {
      for (const r of b.radii) {
        expect(r).toBeGreaterThan(0);
        expect(Number.isFinite(r)).toBe(true);
      }
      // The floor gates which children are GROWN: every emitted ostium radius is ≥ the floor.
      expect(ostiumRadius(b)).toBeGreaterThanOrEqual(RADIUS_FLOOR_CM - 1e-9);
    }
  });

  it("respects the requested generation count", () => {
    const branches = growBifurcatingTree({ ...BASE_OPTS, generations: 3 });
    // Branch ids encode generation as `_gN_`; no branch should exceed the cap.
    const maxGen = Math.max(
      ...branches.map((b) => Number(/_g(\d+)_/.exec(b.id)![1]))
    );
    expect(maxGen).toBeLessThanOrEqual(3);
    expect(maxGen).toBeGreaterThan(0);
  });

  it("emits well-formed polylines (≥4 points, parallel radii, no NaNs, unique ids)", () => {
    const branches = growBifurcatingTree(BASE_OPTS);
    const ids = new Set<string>();
    for (const b of branches) {
      expect(b.points.length).toBeGreaterThanOrEqual(4);
      expect(b.points.length).toBe(POINTS_PER_BRANCH);
      expect(b.radii.length).toBe(b.points.length);
      expect(ids.has(b.id)).toBe(false);
      ids.add(b.id);
      for (const p of b.points) {
        for (const c of p) expect(Number.isFinite(c)).toBe(true);
      }
    }
    expect(branches.length).toBeGreaterThan(0);
  });

  it("returns an empty tree for zero generations", () => {
    expect(growBifurcatingTree({ ...BASE_OPTS, generations: 0 })).toEqual([]);
  });
});

describe("growBifurcatingTree — exact ostium coincidence", () => {
  it("makes every child's first point exactly equal its parent's last point", () => {
    const branches = growBifurcatingTree(BASE_OPTS);
    const index = byId(branches);
    for (const b of branches) {
      if (b.parentId === undefined) continue;
      const parent = index.get(b.parentId);
      if (!parent) continue;
      const first = b.points[0];
      const last = parent.points[parent.points.length - 1];
      // Bit-for-bit equality (not just within tolerance) — the weld must land at distance zero.
      expect(first[0]).toBe(last[0]);
      expect(first[1]).toBe(last[1]);
      expect(first[2]).toBe(last[2]);
    }
  });

  it("starts generation-1 branches exactly at the root point", () => {
    const root: [number, number, number] = [-4.0, 20.6, 4.1];
    const branches = growBifurcatingTree({ ...BASE_OPTS, rootPoint: root, generations: 2 });
    const gen1 = branches.filter((b) => b.parentId === undefined);
    expect(gen1.length).toBeGreaterThan(0);
    for (const b of gen1) {
      expect(b.points[0]).toEqual(root);
    }
  });
});

describe("synth-tree — end-to-end through the ingestion bridge", () => {
  /**
   * Build a 2-point synthetic "parent" branch whose LAST point is the growth root, grow a small tree
   * from that exact point, weld the generated gen-1 branches onto the parent, then push the whole
   * thing through anatomyDocFromCenterlines → compileAnatomy → new Lumen and assert the first
   * generation is graph-adjacent to the parent.
   */
  it("keeps the first generation graph-adjacent to its parent after conversion + weld", () => {
    const root: [number, number, number] = [-4.0, 20.6, 4.1];
    const rootDir: [number, number, number] = [-0.5, 0.8, 0.3];

    const parent: RawCenterlineBranch = {
      id: "parent",
      name: "Synthetic parent",
      // Two points; the LAST equals the growth root so the weld lands exactly.
      points: [
        [-3.0, 19.0, 3.5],
        [root[0], root[1], root[2]]
      ],
      radii: [0.26, 0.22]
    };

    const grown = growBifurcatingTree({
      idPrefix: "sub",
      rootPoint: root,
      rootDir,
      rootRadius: 0.22,
      generations: 3,
      seed: 7
    });
    const welded = attachToParent(grown, "parent");

    const tree: RawCenterlineTree = {
      id: "e2e",
      name: "End-to-end synthetic",
      branches: [parent, ...welded]
    };

    const doc = anatomyDocFromCenterlines(tree);
    const anatomy = compileAnatomy(doc);
    const lumen = new Lumen(anatomy);

    // First-generation branches are exactly those parented onto "parent".
    const gen1Ids = welded.filter((b) => b.parentId === "parent").map((b) => b.id);
    expect(gen1Ids.length).toBeGreaterThan(0);

    for (const gid of gen1Ids) {
      const childEdges = lumen.edges.filter((e) => e.branchId === gid);
      expect(childEdges.length).toBeGreaterThan(0);
      const touchesParent = childEdges.some((e) =>
        e.adjacent.some((j) => lumen.edges[j].branchId === "parent")
      );
      expect(touchesParent).toBe(true);
    }

    // No NaNs anywhere in the compiled centerlines, and every radius is positive.
    for (const br of anatomy.branches) {
      for (const cp of br.points) {
        expect(Number.isFinite(cp.pos.x)).toBe(true);
        expect(Number.isFinite(cp.pos.y)).toBe(true);
        expect(Number.isFinite(cp.pos.z)).toBe(true);
        expect(cp.radius).toBeGreaterThan(0);
      }
    }
  });

  it("hepaticSubtreeTree compiles standalone into a connected lumen with CC0 provenance", () => {
    // Proper-hepatic R/L bifurcation point from anatomy.ts as the growth ostium.
    const tree = hepaticSubtreeTree([-4.0, 20.6, 4.1], [-0.5, 0.8, 0.3]);

    expect(tree.provenance?.license).toBe("CC0-1.0");
    expect(tree.provenance?.note).toMatch(/not patient-specific/i);

    const anatomy = compileAnatomy(anatomyDocFromCenterlines(tree));
    const lumen = new Lumen(anatomy);

    // The first lobar generation must connect to the host stub.
    const hostEdges = lumen.edges.filter((e) => e.branchId === "hepatic_host");
    expect(hostEdges.length).toBeGreaterThan(0);
    const someChildTouchesHost = lumen.edges.some(
      (e) =>
        e.branchId !== "hepatic_host" &&
        e.adjacent.some((j) => lumen.edges[j].branchId === "hepatic_host")
    );
    expect(someChildTouchesHost).toBe(true);

    // Sanity: a non-trivial number of generated branches, all with positive radii.
    expect(anatomy.branches.length).toBeGreaterThan(3);
  });
});
