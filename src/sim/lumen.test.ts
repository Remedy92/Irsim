import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { Lumen, smoothMin } from "./lumen";
import type { Anatomy, LumenQuery } from "./types";

/**
 * Stage-4 acceptance tests for the variable-radius capsule-chain implicit lumen (lumen.ts):
 * SDF sign + R_eff, graph-aware nearest-edge query, BRANCH HYSTERESIS (no cross-carina snap),
 * and the swept/CFL safety the rod uses. The rod-level integration behaviors (all nodes stay
 * inside, no wrong-branch snap while feeding, forced-loop self-collision) are in cosserat.test.ts.
 *
 * UNITS: centimetres throughout.
 */

function freshQuery(): LumenQuery {
  return {
    center: new Vector3(),
    radius: 1,
    tangent: new Vector3(0, 0, 1),
    edgeIndex: -1,
    arc: 0,
    inside: true
  };
}

/** A single straight tube along +y of constant radius r. */
function straightTube(r: number): Anatomy {
  const points = [];
  for (let i = 0; i <= 10; i++) points.push({ pos: new Vector3(0, i, 0), radius: r, s: i });
  return {
    id: "t",
    name: "tube",
    branches: [{ id: "tube", name: "tube", attenuation: 1, points }],
    access: [{ id: "a", name: "a", pos: new Vector3(0, 0, 0), dir: new Vector3(0, 1, 0), branchId: "tube" }],
    targets: [],
    provenance: { source: "test", license: "test", note: "test" }
  };
}

/**
 * A Y-bifurcation. Branch "main" runs up the trunk (0,0)→(0,5) then bends into the LEFT limb
 * toward (+3,9). Branch "right" starts at the SHARED ostium (0,5) and runs into the RIGHT limb
 * toward (−3,9). The carina is the tissue wedge between the two limbs just above (0,5).
 */
function yBifurcation(r = 0.5): Anatomy {
  const main = [];
  // trunk
  for (let i = 0; i <= 5; i++) main.push({ pos: new Vector3(0, i, 0), radius: r, s: i });
  // left limb (continues the same branch)
  for (let i = 1; i <= 4; i++) main.push({ pos: new Vector3(0.75 * i, 5 + i, 0), radius: r, s: 5 + i });

  const right = [];
  right.push({ pos: new Vector3(0, 5, 0), radius: r, s: 0 }); // SHARED ostium point
  for (let i = 1; i <= 4; i++) right.push({ pos: new Vector3(-0.75 * i, 5 + i, 0), radius: r, s: i });

  return {
    id: "y",
    name: "y",
    branches: [
      { id: "main", name: "main", attenuation: 1, points: main },
      { id: "right", name: "right", attenuation: 1, points: right }
    ],
    access: [{ id: "a", name: "a", pos: new Vector3(0, 0, 0), dir: new Vector3(0, 1, 0), branchId: "main" }],
    targets: [],
    provenance: { source: "test", license: "test", note: "test" }
  };
}

/** A trunk with a narrower side branch for branch-ownership tests near an ostium. */
function narrowSideBranch(): Anatomy {
  const main = [];
  for (let i = 0; i <= 8; i++) main.push({ pos: new Vector3(0, i, 0), radius: 0.3, s: i });
  const side = [
    { pos: new Vector3(0, 5, 0), radius: 0.25, s: 0 },
    { pos: new Vector3(-2, 7, 0), radius: 0.25, s: 2 }
  ];
  return {
    id: "side",
    name: "side",
    branches: [
      { id: "main", name: "main", attenuation: 1, points: main },
      { id: "side", name: "side", attenuation: 1, points: side }
    ],
    access: [{ id: "a", name: "a", pos: new Vector3(0, 0, 0), dir: new Vector3(0, 1, 0), branchId: "main" }],
    targets: [],
    provenance: { source: "test", license: "test", note: "test" }
  };
}

describe("Lumen implicit SDF", () => {
  it("φ sign is negative inside and positive outside the capsule lumen", () => {
    const lumen = new Lumen(straightTube(0.5));
    // a point on the centerline at y=5 is well inside (φ ≈ −R)
    expect(lumen.inside(new Vector3(0, 5, 0))).toBe(true);
    expect(lumen.phiHard(new Vector3(0, 5, 0))).toBeLessThan(0);
    // a point 0.3 cm off the centerline is still inside (R=0.5)
    expect(lumen.inside(new Vector3(0.3, 5, 0))).toBe(true);
    // a point 1 cm off the centerline is OUTSIDE (φ ≈ +0.5)
    expect(lumen.inside(new Vector3(1.0, 5, 0))).toBe(false);
    expect(lumen.phiHard(new Vector3(1.0, 5, 0))).toBeGreaterThan(0);
  });

  it("φ ≈ distance − R at the surface (variable radius honoured)", () => {
    const lumen = new Lumen(straightTube(0.5));
    // exactly on the wall: φ ≈ 0
    expect(Math.abs(lumen.phiHard(new Vector3(0.5, 5, 0)))).toBeLessThan(1e-6);
    // 0.2 outside the wall: φ ≈ 0.2
    expect(lumen.phiHard(new Vector3(0.7, 5, 0))).toBeCloseTo(0.2, 6);
  });

  it("smoothMin is continuous and bounded by the hard min", () => {
    // smooth-min never exceeds the hard min, and approaches it as k → 0
    expect(smoothMin(1, 3, 0.25)).toBeLessThanOrEqual(1);
    expect(smoothMin(1, 3, 1e-9)).toBeCloseTo(1, 6);
    // equal inputs: smooth-min dips slightly below the shared value (the union "fattens")
    expect(smoothMin(2, 2, 0.25)).toBeLessThan(2);
  });
});

describe("Lumen R_eff (allowed centerline radius for an instrument)", () => {
  it("query returns the lumen radius so the caller can subtract r_instrument + ε_c", () => {
    const lumen = new Lumen(straightTube(0.5));
    const q = freshQuery();
    lumen.query(new Vector3(0.1, 4, 0), -1, q);
    expect(q.radius).toBeCloseTo(0.5, 6);
    // R_eff the rod computes: R − r − ε_c (0.5 − 0.05 − 0.005 = 0.445)
    const rEff = q.radius - 0.05 - 0.005;
    expect(rEff).toBeCloseTo(0.445, 6);
    // the closest centerline point is the projection onto the trunk axis
    expect(q.center.x).toBeCloseTo(0, 6);
    expect(q.center.y).toBeCloseTo(4, 6);
  });
});

describe("Lumen graph adjacency + branch hysteresis (no cross-carina snap)", () => {
  it("builds graph adjacency across the shared ostium", () => {
    const lumen = new Lumen(yBifurcation());
    // every edge has at least one neighbour (a chain), and the ostium edges bridge branches
    let crossBranchAdjacency = false;
    for (const e of lumen.edges) {
      for (const j of e.adjacent) {
        if (lumen.edges[j].branchId !== e.branchId) crossBranchAdjacency = true;
      }
    }
    expect(crossBranchAdjacency).toBe(true);
  });

  it("a node deep in the main/left branch is NOT snapped into the right branch", () => {
    const lumen = new Lumen(yBifurcation());
    const q = freshQuery();
    // acquire on the trunk
    let edge = lumen.query(new Vector3(0, 3, 0), -1, q);
    expect(lumen.edges[edge].branchId).toBe("main");
    // walk up into the LEFT limb (positive x). The query must keep us on "main", never jump to
    // the right limb even though geometrically the carina region is between the two limbs.
    const path = [
      new Vector3(0, 4.5, 0),
      new Vector3(0.2, 5.3, 0),
      new Vector3(0.7, 6, 0),
      new Vector3(1.4, 7, 0),
      new Vector3(2.1, 8, 0)
    ];
    for (const p of path) {
      edge = lumen.query(p, edge, q);
      expect(lumen.edges[edge].branchId).toBe("main");
    }
  });

  it("a node in the right branch stays in the right branch", () => {
    const lumen = new Lumen(yBifurcation());
    const q = freshQuery();
    let edge = lumen.query(new Vector3(-1.4, 7, 0), -1, q);
    expect(lumen.edges[edge].branchId).toBe("right");
    const path = [new Vector3(-2.0, 8, 0), new Vector3(-2.5, 8.5, 0)];
    for (const p of path) {
      edge = lumen.query(p, edge, q);
      expect(lumen.edges[edge].branchId).toBe("right");
    }
  });

  it("hysteresis: a point hovering near the carina does NOT flip-flop its edge each query", () => {
    const lumen = new Lumen(yBifurcation());
    const q = freshQuery();
    // sit just above the ostium, slightly toward the left limb; acquire on main
    let edge = lumen.query(new Vector3(0.1, 5.4, 0), -1, q);
    const startBranch = lumen.edges[edge].branchId;
    // re-query the SAME point many times: the chosen edge must be stable (no oscillation)
    let switches = 0;
    let prevEdge = edge;
    for (let i = 0; i < 20; i++) {
      edge = lumen.query(new Vector3(0.1, 5.4, 0), edge, q);
      if (edge !== prevEdge) switches++;
      prevEdge = edge;
    }
    expect(switches).toBe(0);
    expect(lumen.edges[edge].branchId).toBe(startBranch);
  });

  it("does not switch into a side branch while the sample is still outside that branch lumen", () => {
    const lumen = new Lumen(narrowSideBranch());
    const q = freshQuery();
    let edge = lumen.query(new Vector3(0, 4.8, 0), -1, q);
    expect(lumen.edges[edge].branchId).toBe("main");

    // Near the ostium and geometrically closer to the side branch than the trunk, but outside the
    // side branch capsule. Ownership should remain on the current trunk edge until the sample
    // actually enters the branch lumen.
    edge = lumen.query(new Vector3(-0.45, 5.45, 0.35), edge, q);
    expect(lumen.edges[edge].branchId).toBe("main");

    edge = lumen.query(new Vector3(-0.25, 5.25, 0.05), edge, q);
    expect(lumen.edges[edge].branchId).toBe("side");
  });

  it("re-acquires the nearest edge after a long jump (lost node fallback)", () => {
    const lumen = new Lumen(yBifurcation());
    const q = freshQuery();
    // claim we were on edge 0 (bottom of the trunk) but the point is actually far up the right
    // limb — the grid fallback must re-acquire the genuinely nearest edge.
    const edge = lumen.query(new Vector3(-2.5, 8.5, 0), 0, q);
    expect(lumen.edges[edge].branchId).toBe("right");
    expect(q.center.distanceTo(new Vector3(-2.5, 8.5, 0))).toBeLessThan(1.5);
  });
});
