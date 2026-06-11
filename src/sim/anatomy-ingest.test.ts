import { describe, expect, it } from "vitest";
import exampleCenterlines from "../../assets/anatomy/example-vmtk-centerlines.json";
import { compileAnatomy, docFromJSON, docToJSON } from "./anatomyDoc";
import { anatomyDocToSidecar, MAX_CONTROLS_PER_BRANCH, parseAnatomyInput } from "./anatomy-loader";
import { Lumen } from "./lumen";

/**
 * End-to-end proof of the DICOM ingestion bridge on the ACTUAL shipped example asset.
 *
 * `assets/anatomy/example-vmtk-centerlines.json` is the raw, densely-sampled centerline export the
 * offline pipeline (DICOM → TotalSegmentator → VMTK) produces. This test drives it through the exact
 * path the app's file-load uses — `parseAnatomyInput` (auto-detect raw centerlines, decimate, convert
 * to an `AnatomyDoc`) → `compileAnatomy` → `Lumen` — and asserts the result is a connected, navigable
 * anatomy. If decimation or the ostium-weld regressed, the child would fail to connect and this fails.
 */

// The shipped example is imported as JSON (resolveJsonModule) and re-stringified, so the test drives
// the exact `parseAnatomyInput(text)` path the app's file-load uses — no node:fs / @types/node needed.
const EXAMPLE = JSON.stringify(exampleCenterlines);

/** Branch ids that an edge of `branchId` is graph-adjacent to (via the lumen's shared-endpoint graph). */
function adjacentBranchIds(lumen: Lumen, branchId: string): Set<string> {
  const out = new Set<string>();
  for (const e of lumen.edges) {
    if (e.branchId !== branchId) continue;
    for (const j of e.adjacent) out.add(lumen.edges[j].branchId);
  }
  return out;
}

describe("DICOM ingestion bridge (shipped example centerlines)", () => {
  const raw = JSON.parse(EXAMPLE) as { branches: { id: string; points: unknown[] }[] };

  it("auto-detects raw centerlines and converts them to a valid AnatomyDoc", () => {
    const doc = parseAnatomyInput(EXAMPLE);
    // Same branch set as the raw input (nothing dropped during conversion).
    expect(doc.branches.map((b) => b.id).sort()).toEqual(raw.branches.map((b) => b.id).sort());
    // docFromJSON re-validates; a structurally-invalid conversion would throw here.
    expect(() => docFromJSON(anatomyDocToSidecar(doc))).not.toThrow();
  });

  it("decimates the dense centerlines under the per-branch control cap", () => {
    const doc = parseAnatomyInput(EXAMPLE);
    const aorta = doc.branches.find((b) => b.id === "aorta")!;
    const rawAorta = raw.branches.find((b) => b.id === "aorta")!;
    expect(rawAorta.points.length).toBeGreaterThan(50); // input really is densely sampled
    // A root branch's controls are the decimated list; a child's exclude the welded ostium.
    expect(aorta.controls.length).toBeLessThanOrEqual(MAX_CONTROLS_PER_BRANCH);
    expect(aorta.controls.length).toBeGreaterThanOrEqual(2);
  });

  it("compiles to a lumen where the child welds onto and connects to its parent", () => {
    const anatomy = compileAnatomy(parseAnatomyInput(EXAMPLE));
    const lumen = new Lumen(anatomy);
    // The renal child must be graph-adjacent to the aorta — i.e. decimation + the nearest-parent-
    // sample weld kept its ostium exactly coincident with an aorta sample (lumen tol 1e-3 cm).
    const child = anatomy.branches.find((b) => b.id !== "aorta")!;
    expect(adjacentBranchIds(lumen, child.id).has("aorta")).toBe(true);
  });

  it("round-trips the converted document through the sidecar serialiser losslessly", () => {
    const doc = parseAnatomyInput(EXAMPLE);
    const reparsed = docFromJSON(docToJSON(doc));
    expect(reparsed.branches.length).toBe(doc.branches.length);
    expect(compileAnatomy(reparsed).branches.length).toBe(doc.branches.length);
  });
});
