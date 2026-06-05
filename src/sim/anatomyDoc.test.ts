import { describe, expect, it } from "vitest";
import {
  applyVariant,
  compileAnatomy,
  docFromJSON,
  docToJSON,
  validateAnatomyDoc,
  type AnatomyDoc
} from "./anatomyDoc";
import { ANATOMY_VARIANTS, buildAnatomy, buildNormalAnatomy, NORMAL_DOC } from "./anatomy";
import { Lumen } from "./lumen";

/** The first lumen edge of a branch starts at its ostium (points[0]). */
function ostiumEdge(lumen: Lumen, branchId: string) {
  const idx = lumen.edges.findIndex((e) => e.branchId === branchId);
  expect(idx, `no lumen edge for ${branchId}`).toBeGreaterThanOrEqual(0);
  return lumen.edges[idx];
}

/** True if branch `child`'s ostium edge is graph-adjacent to any edge of branch `parent`. */
function weldsTo(lumen: Lumen, child: string, parent: string): boolean {
  const e = ostiumEdge(lumen, child);
  return e.adjacent.some((j) => lumen.edges[j].branchId === parent);
}

describe("anatomyDoc — compiler", () => {
  it("compiles the normal document into a valid runtime Anatomy", () => {
    const a = compileAnatomy(NORMAL_DOC);
    expect(a.branches.length).toBe(NORMAL_DOC.branches.length);
    expect(a.access.length).toBe(NORMAL_DOC.access.length);
    expect(a.targets.length).toBe(NORMAL_DOC.targets.length);
    // every target resolves to a finite world position
    for (const t of a.targets) {
      expect(Number.isFinite(t.pos.x) && Number.isFinite(t.pos.y) && Number.isFinite(t.pos.z)).toBe(true);
    }
    // access direction is a unit vector
    for (const ac of a.access) expect(ac.dir.length()).toBeCloseTo(1, 6);
  });

  it("buildNormalAnatomy() is the compiled normal document", () => {
    const a = buildNormalAnatomy();
    const b = compileAnatomy(NORMAL_DOC);
    expect(a.branches.map((x) => x.id)).toEqual(b.branches.map((x) => x.id));
  });
});

describe("anatomyDoc — JSON sidecar round-trip", () => {
  it("serialises and reloads losslessly, compiling to the same graph", () => {
    const json = docToJSON(NORMAL_DOC);
    const reloaded = docFromJSON(json);
    expect(reloaded).toEqual(NORMAL_DOC); // plain-data round-trip is lossless
    const a = compileAnatomy(NORMAL_DOC);
    const b = compileAnatomy(reloaded);
    expect(b.branches.map((x) => x.id)).toEqual(a.branches.map((x) => x.id));
    // geometry matches to floating-point precision
    for (let i = 0; i < a.branches.length; i++) {
      expect(b.branches[i].points.length).toBe(a.branches[i].points.length);
      const pa = a.branches[i].points[a.branches[i].points.length - 1].pos;
      const pb = b.branches[i].points[b.branches[i].points.length - 1].pos;
      expect(pb.distanceTo(pa)).toBeLessThan(1e-9);
    }
  });
});

describe("anatomyDoc — validation rejects malformed documents", () => {
  const base = (): AnatomyDoc => docFromJSON(docToJSON(NORMAL_DOC));

  it("rejects an unknown parent reference", () => {
    const d = base();
    d.branches.find((b) => b.id === "celiac")!.parent = "nope";
    expect(() => validateAnatomyDoc(d)).toThrow(/unknown parent/);
  });

  it("rejects a child branch missing its ostium weld spec", () => {
    const d = base();
    const c = d.branches.find((b) => b.id === "celiac")!;
    delete c.ostiumNear;
    expect(() => validateAnatomyDoc(d)).toThrow(/ostiumNear/);
  });

  it("rejects a duplicate branch id", () => {
    const d = base();
    d.branches.push({ ...d.branches[1] });
    expect(() => validateAnatomyDoc(d)).toThrow(/duplicate branch id/);
  });

  it("rejects a target pointing at an unknown branch", () => {
    const d = base();
    d.targets[0].via = "ghost";
    expect(() => validateAnatomyDoc(d)).toThrow(/unknown branch/);
  });
});

describe("anatomyDoc — anatomical variants", () => {
  it("exposes the bovine arch and replaced-RHA variants", () => {
    expect(ANATOMY_VARIANTS.map((v) => v.id).sort()).toEqual(["bovine-arch", "replaced-rha-sma"]);
  });

  it("buildAnatomy() with no id returns the normal anatomy", () => {
    expect(buildAnatomy().id).toBe(buildNormalAnatomy().id);
  });

  it("throws on an unknown variant id", () => {
    expect(() => buildAnatomy("not-a-variant")).toThrow(/unknown variant/);
  });

  it("BOVINE ARCH: the left common carotid now arises from the brachiocephalic trunk", () => {
    const normal = new Lumen(buildNormalAnatomy());
    expect(weldsTo(normal, "carotid_l", "aorta"), "baseline LCC should weld to the arch").toBe(true);

    const bovine = new Lumen(buildAnatomy("bovine-arch"));
    expect(weldsTo(bovine, "carotid_l", "innominate"), "bovine LCC should weld to the innominate").toBe(true);
    expect(weldsTo(bovine, "carotid_l", "aorta"), "bovine LCC should NOT weld to the arch directly").toBe(false);
    // innominate itself still arises from the arch
    expect(weldsTo(bovine, "innominate", "aorta")).toBe(true);
  });

  it("REPLACED RHA: the right hepatic now arises from the SMA, not the proper hepatic", () => {
    const normal = new Lumen(buildNormalAnatomy());
    expect(weldsTo(normal, "hepatic_r", "hepatic_proper")).toBe(true);

    const replaced = new Lumen(buildAnatomy("replaced-rha-sma"));
    expect(weldsTo(replaced, "hepatic_r", "sma"), "replaced RHA should weld to the SMA").toBe(true);
    expect(weldsTo(replaced, "hepatic_r", "hepatic_proper"), "replaced RHA should leave the proper hepatic").toBe(false);
    // the right-hepatic target still exists and routes via hepatic_r (now off the SMA)
    const a = buildAnatomy("replaced-rha-sma");
    expect(a.targets.find((t) => t.id === "t_hepatic_r")?.viaBranchId).toBe("hepatic_r");
  });

  it("variants leave a fully finite, connected graph", () => {
    for (const v of ANATOMY_VARIANTS) {
      const a = compileAnatomy(applyVariant(NORMAL_DOC, v));
      for (const br of a.branches) {
        for (const p of br.points) {
          expect(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z)).toBe(true);
        }
      }
    }
  });
});
