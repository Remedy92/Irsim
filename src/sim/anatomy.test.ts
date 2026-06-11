import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { buildAnatomy, buildNormalAnatomy } from "./anatomy";
import { Lumen } from "./lumen";
import type { VesselBranch } from "./types";

/**
 * Anatomy structural + ostium-WELD regression tests.
 *
 * The highest-risk part of growing the anatomy is connectivity: a child branch is only navigable if
 * its ostium coincides (within the lumen's exact-coincidence tolerance, 1e-3 cm) with a sample on its
 * parent, so the lumen graph registers the junction. A silently-unwelded ostium would let a wire reach
 * a branch only by the global-nearest fallback (the "snap across the carina" failure the lumen design
 * exists to prevent). These tests assert every new visceral ostium is graph-connected to its parent.
 */

const VISCERAL_IDS = [
  "celiac",
  "hepatic_common",
  "hepatic_proper",
  "hepatic_r",
  "hepatic_l",
  "gda",
  "splenic",
  "gastric_l",
  "sma",
  "ileocolic",
  "colic_m",
  "ima",
  "colic_l",
  "rectal_sup"
];

/** child branch id -> the parent branch its ostium must weld onto. */
const PARENT_OF: Record<string, string> = {
  // arch great vessels (now welded onto the arch; v0 left carotid/subclavian dangling)
  innominate: "aorta",
  carotid_l: "aorta",
  subclavian_l: "aorta",
  // renals
  renal_l: "aorta",
  renal_r: "aorta",
  // pelvic path (UFE)
  iliac_internal_r: "iliac_r",
  iliac_internal_l: "iliac_l",
  uterine_r: "iliac_internal_r",
  uterine_l: "iliac_internal_l",
  // visceral / mesenteric tree
  celiac: "aorta",
  hepatic_common: "celiac",
  hepatic_proper: "hepatic_common",
  hepatic_r: "hepatic_proper",
  hepatic_l: "hepatic_proper",
  gda: "hepatic_common",
  splenic: "celiac",
  gastric_l: "celiac",
  sma: "aorta",
  ileocolic: "sma",
  colic_m: "sma",
  ima: "aorta",
  colic_l: "ima",
  rectal_sup: "ima"
};

describe("buildNormalAnatomy — structure", () => {
  const anatomy = buildNormalAnatomy();
  const byId = new Map(anatomy.branches.map((b) => [b.id, b]));

  it("ships the aortoiliac/arch core plus the visceral tree and the pelvic path", () => {
    for (const id of [
      "aorta",
      "iliac_r",
      "iliac_l",
      "renal_l",
      "renal_r",
      "innominate",
      "carotid_l",
      "subclavian_l",
      // pelvic path (UFE)
      "iliac_internal_r",
      "iliac_internal_l",
      "uterine_r",
      "uterine_l",
      ...VISCERAL_IDS
    ]) {
      expect(byId.has(id), `missing branch ${id}`).toBe(true);
    }
    expect(anatomy.branches.length).toBe(26);
  });

  it("every centerline point is finite, radius-positive, and arc-length monotonic", () => {
    for (const br of anatomy.branches) {
      let prevS = -Infinity;
      for (const p of br.points) {
        expect(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z)).toBe(true);
        expect(p.radius).toBeGreaterThan(0);
        expect(p.s).toBeGreaterThanOrEqual(prevS); // non-decreasing arc length
        prevS = p.s;
      }
    }
  });

  it("keeps the renal ostia exactly on the aorta renal-level node (targets unchanged)", () => {
    const renalOstium = new Vector3(-0.2, 13.5, 0.6);
    for (const id of ["renal_l", "renal_r"]) {
      expect(byId.get(id)!.points[0].pos.distanceTo(renalOstium)).toBeLessThan(1e-9);
    }
  });

  it("right renal is longer than the left (real asymmetry), both calibrated caudal", () => {
    const arc = (b: VesselBranch) => b.points[b.points.length - 1].s;
    expect(arc(byId.get("renal_r")!)).toBeGreaterThan(arc(byId.get("renal_l")!));
    // each renal descends (caudal takeoff): hilum sits below the ostium.
    for (const id of ["renal_l", "renal_r"]) {
      const b = byId.get(id)!;
      expect(b.points[b.points.length - 1].pos.y).toBeLessThan(b.points[0].pos.y);
    }
  });

  it("exposes selective visceral cannulation targets that reference real branches", () => {
    const ids = new Set(anatomy.targets.map((t) => t.id));
    for (const t of [
      "t_celiac",
      "t_sma",
      "t_ima",
      "t_hepatic",
      "t_splenic",
      "t_hepatic_r",
      "t_uterine_r",
      "t_uterine_l",
      "t_iia_r",
      "t_iia_l"
    ]) {
      expect(ids.has(t), `missing target ${t}`).toBe(true);
    }
    for (const t of anatomy.targets) {
      expect(byId.has(t.viaBranchId), `target ${t.id} via unknown branch ${t.viaBranchId}`).toBe(true);
    }
  });
});

describe("buildNormalAnatomy — ostium welds register in the lumen graph", () => {
  const anatomy = buildNormalAnatomy();
  const lumen = new Lumen(anatomy);

  /** The first lumen edge of a branch starts at its ostium (points[0]). */
  const ostiumEdgeIndex = (branchId: string) =>
    lumen.edges.findIndex((e) => e.branchId === branchId);

  it("connects every visceral ostium to a parent edge (no orphan branches)", () => {
    for (const [child, parent] of Object.entries(PARENT_OF)) {
      const idx = ostiumEdgeIndex(child);
      expect(idx, `no edge for ${child}`).toBeGreaterThanOrEqual(0);
      const ostium = lumen.edges[idx];
      const touchesParent = ostium.adjacent.some((j) => lumen.edges[j].branchId === parent);
      expect(touchesParent, `${child} ostium not welded to ${parent}`).toBe(true);
    }
  });

  it("forms a true celiac trifurcation node (hepatic + splenic + left gastric share the carina)", () => {
    // Each celiac daughter's ostium edge must be adjacent to at least one other celiac daughter,
    // i.e. they all meet at the same junction point rather than dangling off different samples.
    const daughters = ["hepatic_common", "splenic", "gastric_l"];
    for (const d of daughters) {
      const idx = lumen.edges.findIndex((e) => e.branchId === d);
      const ostium = lumen.edges[idx];
      const meetsSibling = ostium.adjacent.some((j) => {
        const id = lumen.edges[j].branchId;
        return daughters.includes(id) && id !== d;
      });
      expect(meetsSibling, `${d} does not share the celiac trifurcation node`).toBe(true);
    }
  });
});

describe("synthetic-hepatic-tree variant — procedurally-grown distal anatomy is connected + navigable", () => {
  const anatomy = buildAnatomy("synthetic-hepatic-tree");
  const synthIds = anatomy.branches.filter((b) => b.id.startsWith("heptree_")).map((b) => b.id);
  const lumen = new Lumen(anatomy);

  it("appends a non-trivial grown sub-tree onto the normal anatomy", () => {
    expect(anatomy.branches.length).toBeGreaterThan(buildNormalAnatomy().branches.length);
    expect(synthIds.length).toBeGreaterThanOrEqual(4); // several bifurcating segmental branches
  });

  it("keeps every grown centerline finite and radius-positive (no NaN from the generator)", () => {
    for (const id of synthIds) {
      const b = anatomy.branches.find((x) => x.id === id)!;
      for (const p of b.points) {
        expect(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z)).toBe(true);
        expect(p.radius).toBeGreaterThan(0);
      }
    }
  });

  it("welds the whole segmental tree into the lumen graph (reachable from the right hepatic)", () => {
    // Each grown branch's ostium edge must touch its parent — either hepatic_r (generation 1) or
    // another grown branch (deeper generations). A single orphan means a wire could never reach it.
    for (const id of synthIds) {
      const idx = lumen.edges.findIndex((e) => e.branchId === id);
      expect(idx, `no edge for grown branch ${id}`).toBeGreaterThanOrEqual(0);
      const ostium = lumen.edges[idx];
      const connected = ostium.adjacent.some((j) => {
        const pid = lumen.edges[j].branchId;
        return pid === "hepatic_r" || pid.startsWith("heptree_");
      });
      expect(connected, `grown branch ${id} is orphaned (no weld to hepatic_r or a sibling)`).toBe(true);
    }
    // At least one generation-1 branch must touch hepatic_r directly (the tree is rooted on it).
    const g1 = synthIds.filter((id) => id.startsWith("heptree_g1_"));
    const rootedOnHepaticR = g1.some((id) => {
      const idx = lumen.edges.findIndex((e) => e.branchId === id);
      return lumen.edges[idx].adjacent.some((j) => lumen.edges[j].branchId === "hepatic_r");
    });
    expect(rootedOnHepaticR, "no generation-1 branch welds onto hepatic_r").toBe(true);
  });

  it("exposes a distal selective target on a real grown branch", () => {
    const target = anatomy.targets.find((t) => t.id === "t_hepatic_seg");
    expect(target, "missing synthetic segmental target").toBeTruthy();
    expect(anatomy.branches.some((b) => b.id === target!.viaBranchId)).toBe(true);
  });
});

describe("pathology variants — disease states compile, stay connected, and take effect", () => {
  const PATHOLOGY = ["aaa-infrarenal", "renal-stenosis-l", "accessory-renal-r", "tortuous-iliac-r"];

  const maxRadius = (b: VesselBranch) => b.points.reduce((m, p) => Math.max(m, p.radius), 0);
  const minRadius = (b: VesselBranch) => b.points.reduce((m, p) => Math.min(m, p.radius), Infinity);

  for (const id of PATHOLOGY) {
    it(`${id}: compiles with finite, radius-positive, arc-monotonic centerlines`, () => {
      const anatomy = buildAnatomy(id);
      for (const br of anatomy.branches) {
        let prevS = -Infinity;
        for (const p of br.points) {
          expect(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z)).toBe(true);
          expect(p.radius).toBeGreaterThan(0);
          expect(p.s).toBeGreaterThanOrEqual(prevS);
          prevS = p.s;
        }
      }
    });

    it(`${id}: keeps every renal/visceral/pelvic ostium welded to its parent (no orphan from the reshape)`, () => {
      const anatomy = buildAnatomy(id);
      const lumen = new Lumen(anatomy);
      for (const [child, parent] of Object.entries(PARENT_OF)) {
        const idx = lumen.edges.findIndex((e) => e.branchId === child);
        expect(idx, `no edge for ${child} in ${id}`).toBeGreaterThanOrEqual(0);
        const touchesParent = lumen.edges[idx].adjacent.some((j) => lumen.edges[j].branchId === parent);
        expect(touchesParent, `${child} ostium not welded to ${parent} in ${id}`).toBe(true);
      }
    });
  }

  it("aaa-infrarenal: the infrarenal aorta is aneurysmal (radius bulges well past normal)", () => {
    const aorta = buildAnatomy("aaa-infrarenal").branches.find((b) => b.id === "aorta")!;
    expect(maxRadius(aorta)).toBeGreaterThan(1.6); // normal abdominal aorta r<=~1.0
    expect(minRadius(aorta)).toBeGreaterThan(0); // necks stay patent
  });

  it("renal-stenosis-l: the left renal lumen pinches to a tight stenosis with patent distal", () => {
    const renal = buildAnatomy("renal-stenosis-l").branches.find((b) => b.id === "renal_l")!;
    expect(minRadius(renal)).toBeLessThan(0.13); // tight ostial/proximal stenosis (~2 mm)
    expect(maxRadius(renal)).toBeGreaterThan(0.22); // post-stenotic dilation / normal distal
  });

  it("accessory-renal-r: adds a separately-cannulated lower-pole renal branch + target, welded to the aorta", () => {
    const anatomy = buildAnatomy("accessory-renal-r");
    expect(anatomy.branches.some((b) => b.id === "renal_r_acc")).toBe(true);
    const target = anatomy.targets.find((t) => t.id === "t_renal_r_acc");
    expect(target, "missing accessory renal target").toBeTruthy();
    expect(target!.viaBranchId).toBe("renal_r_acc");
    const lumen = new Lumen(anatomy);
    const idx = lumen.edges.findIndex((e) => e.branchId === "renal_r_acc");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(lumen.edges[idx].adjacent.some((j) => lumen.edges[j].branchId === "aorta")).toBe(true);
  });

  it("tortuous-iliac-r: the right iliac gains curvature but preserves the femoral access endpoint", () => {
    const normal = buildNormalAnatomy().branches.find((b) => b.id === "iliac_r")!;
    const tort = buildAnatomy("tortuous-iliac-r").branches.find((b) => b.id === "iliac_r")!;
    // a tortuous path is longer than the near-straight normal iliac of the same span
    expect(tort.points[tort.points.length - 1].s).toBeGreaterThan(normal.points[normal.points.length - 1].s);
    // the access endpoint (R common femoral) is preserved
    const tip = tort.points[tort.points.length - 1].pos;
    expect(tip.distanceTo(new Vector3(-3.8, -11.5, -0.2))).toBeLessThan(0.4);
  });

  it("peripheral-runoff-l: the leg tree welds into the lumen graph from the left CFA down to the tibials", () => {
    const anatomy = buildAnatomy("peripheral-runoff-l");
    const lumen = new Lumen(anatomy);
    // each runoff branch's ostium must touch its declared parent (a connected leg, navigable by crossover)
    const PARENT: Record<string, string> = {
      sfa_l: "iliac_l",
      profunda_l: "sfa_l",
      popliteal_l: "sfa_l",
      at_l: "popliteal_l",
      tpt_l: "popliteal_l",
      pt_l: "tpt_l",
      peroneal_l: "tpt_l"
    };
    for (const [child, parent] of Object.entries(PARENT)) {
      const idx = lumen.edges.findIndex((e) => e.branchId === child);
      expect(idx, `no edge for ${child}`).toBeGreaterThanOrEqual(0);
      expect(lumen.edges[idx].adjacent.some((j) => lumen.edges[j].branchId === parent), `${child} not welded to ${parent}`).toBe(true);
    }
    // the runoff reaches the tibial level (well caudal to the femoral access)
    const at = anatomy.branches.find((b) => b.id === "at_l")!;
    expect(at.points[at.points.length - 1].pos.y).toBeLessThan(-44);
    // exposes BTK targets
    for (const t of ["t_popliteal_l", "t_at_l", "t_pt_l"]) {
      expect(anatomy.targets.some((x) => x.id === t), `missing target ${t}`).toBe(true);
    }
  });
});
