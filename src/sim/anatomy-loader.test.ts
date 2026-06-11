import { describe, expect, it } from "vitest";
import {
  loadAnatomyFromSidecar,
  anatomyDocFromCenterlines,
  decimateBranch,
  MAX_CONTROLS_PER_BRANCH,
  type RawCenterlineTree
} from "./anatomy-loader";
import { compileAnatomy, docFromJSON, docToJSON } from "./anatomyDoc";
import { buildNormalAnatomy, NORMAL_DOC } from "./anatomy";
import { Lumen } from "./lumen";

/**
 * Acceptance tests for the anatomy runtime bridge (anatomy-loader.ts):
 *
 *   - JSON sidecar round-trips losslessly through compile.
 *   - `loadAnatomyFromSidecar` works with an INJECTED fake fetch (no network/DOM) and throws clear,
 *     distinct errors for HTTP failure, invalid JSON, and a structurally-invalid document.
 *   - The VMTK/segmentation centerline converter decimates dense polylines AND preserves the ostium
 *     weld, so a converted child branch is still graph-adjacent to its parent through the Lumen.
 *   - An unknown parentId surfaces as a thrown error at conversion time.
 *
 * UNITS: centimetres throughout. Body frame +y cranial, +x patient-left, +z anterior.
 */

/** A minimal `Response`-like stand-in for the injected fetch (only the fields the loader reads). */
function fakeResponse(init: {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText,
    text: async () => init.body
  } as Response;
}

/** A fetch that always resolves the given response, ignoring the URL. */
function fetchReturning(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

describe("loadAnatomyFromSidecar", () => {
  it("compiles a valid sidecar to an Anatomy with the same branches as the built normal", async () => {
    const sidecar = docToJSON(NORMAL_DOC);
    const anatomy = await loadAnatomyFromSidecar(
      "https://example.test/normal.json",
      fetchReturning(fakeResponse({ ok: true, status: 200, statusText: "OK", body: sidecar }))
    );
    const reference = buildNormalAnatomy();
    expect(anatomy.branches.map((b) => b.id)).toEqual(reference.branches.map((b) => b.id));
    expect(anatomy.id).toBe(reference.id);
  });

  it("throws a clear error naming the URL on a non-2xx HTTP status", async () => {
    const url = "https://example.test/missing.json";
    await expect(
      loadAnatomyFromSidecar(
        url,
        fetchReturning(fakeResponse({ ok: false, status: 404, statusText: "Not Found", body: "" }))
      )
    ).rejects.toThrow(/404.*Not Found.*missing\.json/);
  });

  it("throws a clear 'invalid JSON' error on a parse failure", async () => {
    const url = "https://example.test/garbage.json";
    await expect(
      loadAnatomyFromSidecar(
        url,
        fetchReturning(fakeResponse({ ok: true, status: 200, statusText: "OK", body: "{not json" }))
      )
    ).rejects.toThrow(/invalid JSON.*garbage\.json/);
  });

  it("throws a clear 'invalid anatomy document' error on a structurally-invalid doc", async () => {
    const url = "https://example.test/empty.json";
    // Valid JSON, but no branches[] — validateAnatomyDoc must reject it.
    const body = JSON.stringify({ id: "x", name: "x", branches: [], access: [], targets: [] });
    await expect(
      loadAnatomyFromSidecar(
        url,
        fetchReturning(fakeResponse({ ok: true, status: 200, statusText: "OK", body }))
      )
    ).rejects.toThrow(/invalid anatomy document.*empty\.json/);
  });
});

describe("AnatomyDoc JSON round-trip", () => {
  it("compile(docFromJSON(docToJSON(NORMAL_DOC))) matches buildNormalAnatomy()", () => {
    const roundTripped = compileAnatomy(docFromJSON(docToJSON(NORMAL_DOC)));
    const reference = buildNormalAnatomy();
    expect(roundTripped.branches.map((b) => b.id)).toEqual(reference.branches.map((b) => b.id));
    expect(roundTripped.branches.length).toBe(reference.branches.length);
    expect(roundTripped.targets.map((t) => t.id)).toEqual(reference.targets.map((t) => t.id));
    expect(roundTripped.access.map((a) => a.id)).toEqual(reference.access.map((a) => a.id));
  });
});

describe("decimateBranch", () => {
  it("reduces a 200-point straight polyline to ≤MAX controls and keeps both endpoints", () => {
    const points: [number, number, number][] = [];
    const radii: number[] = [];
    for (let i = 0; i < 200; i++) {
      points.push([0, i * 0.1, 0]); // 20 cm straight run along +y
      radii.push(0.9);
    }
    const controls = decimateBranch(points, radii);
    expect(controls.length).toBeGreaterThanOrEqual(2);
    expect(controls.length).toBeLessThanOrEqual(MAX_CONTROLS_PER_BRANCH);
    // Endpoints preserved exactly (RDP keeps original points; radius rides along).
    expect(controls[0].p).toEqual(points[0]);
    expect(controls[controls.length - 1].p).toEqual(points[points.length - 1]);
  });

  it("caps a pathologically wiggly 200-point polyline at MAX controls", () => {
    const points: [number, number, number][] = [];
    const radii: number[] = [];
    for (let i = 0; i < 200; i++) {
      // Alternating zig-zag in z so every interior point deviates from its chord.
      points.push([i % 2 === 0 ? 1 : -1, i * 0.1, 0]);
      radii.push(0.5);
    }
    const controls = decimateBranch(points, radii);
    expect(controls.length).toBeLessThanOrEqual(MAX_CONTROLS_PER_BRANCH);
    expect(controls[0].p).toEqual(points[0]);
    expect(controls[controls.length - 1].p).toEqual(points[points.length - 1]);
  });
});

describe("anatomyDocFromCenterlines", () => {
  /**
   * Build a synthetic 2-branch tree: a straight 200-point "aorta" root along +y, and a "renal" child
   * whose FIRST point sits exactly on an aorta point (so the weld + adjacency must survive decimation).
   */
  function syntheticTree(): { tree: RawCenterlineTree; ostium: [number, number, number] } {
    const aortaPoints: [number, number, number][] = [];
    const aortaRadii: number[] = [];
    for (let i = 0; i < 200; i++) {
      aortaPoints.push([0, i * 0.1, 0]); // 0 .. 19.9 cm
      aortaRadii.push(0.9);
    }
    // Pick an interior aorta point as the renal ostium; the child's first point is exactly it.
    const ostium = aortaPoints[120]; // [0, 12.0, 0]

    const renalPoints: [number, number, number][] = [ostium];
    const renalRadii: number[] = [0.3];
    for (let j = 1; j <= 40; j++) {
      renalPoints.push([j * 0.1, 12.0, 0]); // runs out along +x
      renalRadii.push(0.3 - j * 0.002);
    }

    const tree: RawCenterlineTree = {
      id: "synthetic",
      name: "Synthetic aorta + renal",
      branches: [
        { id: "aorta", name: "Aorta", points: aortaPoints, radii: aortaRadii },
        {
          id: "renal",
          name: "Renal",
          parentId: "aorta",
          points: renalPoints,
          radii: renalRadii
        }
      ]
    };
    return { tree, ostium };
  }

  it("decimates each branch and synthesizes a default provenance", () => {
    const { tree } = syntheticTree();
    const doc = anatomyDocFromCenterlines(tree);
    const aorta = doc.branches.find((b) => b.id === "aorta")!;
    const renal = doc.branches.find((b) => b.id === "renal")!;

    // 200-point straight aorta collapses hard (it is nearly a single chord).
    expect(aorta.controls.length).toBeLessThanOrEqual(MAX_CONTROLS_PER_BRANCH);
    expect(aorta.parent).toBeUndefined();

    // Child carries parent + ostium metadata, and does NOT duplicate the ostium into controls.
    expect(renal.parent).toBe("aorta");
    expect(renal.ostiumNear).toBeDefined();
    expect(renal.ostiumR).toBe(0.3);
    expect(renal.controls.length).toBeLessThanOrEqual(MAX_CONTROLS_PER_BRANCH);

    // Default provenance is synthesized and flags the generic, non-patient-specific nature.
    expect(doc.provenance.note).toMatch(/not patient-specific/i);
  });

  it("preserves graph adjacency (ostium weld) through decimation + compile", () => {
    const { tree } = syntheticTree();
    const anatomy = compileAnatomy(anatomyDocFromCenterlines(tree));
    const lumen = new Lumen(anatomy);

    // Find a renal edge and assert at least one of its graph neighbours is an aorta edge.
    const renalEdges = lumen.edges.filter((e) => e.branchId === "renal");
    expect(renalEdges.length).toBeGreaterThan(0);

    const renalTouchesAorta = renalEdges.some((e) =>
      e.adjacent.some((j) => lumen.edges[j].branchId === "aorta")
    );
    expect(renalTouchesAorta).toBe(true);
  });

  it("throws on a child branch with an unknown parentId", () => {
    const tree: RawCenterlineTree = {
      id: "bad",
      name: "Bad tree",
      branches: [
        {
          id: "aorta",
          name: "Aorta",
          points: [
            [0, 0, 0],
            [0, 1, 0],
            [0, 2, 0]
          ],
          radii: [0.9, 0.9, 0.9]
        },
        {
          id: "renal",
          name: "Renal",
          parentId: "does_not_exist",
          points: [
            [0, 1, 0],
            [1, 1, 0]
          ],
          radii: [0.3, 0.28]
        }
      ]
    };
    expect(() => anatomyDocFromCenterlines(tree)).toThrow(/unknown parent "does_not_exist"/);
  });
});
