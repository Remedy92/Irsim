import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { CoaxialAssembly, CosseratRod, GUIDEWIRE, SHEATH } from "../cosserat";
import type { Anatomy } from "../types";

/**
 * Phase-3 LIVE integration smoke tests: drive a real CosseratRod through its public step() with
 * params.useDirectSolve ON (dynamic co-rotational beam) and OFF (legacy XPBD), confirming the direct
 * path is wired, stable, and advances — and that turning the flag OFF leaves the legacy path intact.
 * Calibrated navigation / substep-invariance / chirality gates come once precurve + Schur-contact land.
 */

/** A straight vessel-radius tube along +y (the rod feeds cranially along the access axis). */
function tube(radius: number, lenCm: number): Anatomy {
  const points = [];
  const n = 12;
  for (let i = 0; i <= n; i++) points.push({ pos: new Vector3(0, -2 + (i * lenCm) / n, 0), radius, s: (i * lenCm) / n });
  return {
    id: "t",
    name: "tube",
    branches: [{ id: "tube", name: "tube", attenuation: 1, points }],
    access: [{ id: "a", name: "a", pos: new Vector3(0, -2, 0), dir: new Vector3(0, 1, 0), branchId: "tube" }],
    targets: [],
    provenance: { source: "test", license: "test", note: "test" }
  };
}

function allFinite(rod: CosseratRod): boolean {
  for (const p of rod.x) if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
  for (const q of rod.q) if (!Number.isFinite(q.x) || !Number.isFinite(q.w)) return false;
  return true;
}

describe("Phase-3 live integration — direct solve path", () => {
  function climbRun(useDirectSolve: boolean): { climb: number; finite: boolean; n: number } {
    const rod = new CosseratRod(tube(0.55, 26), "a", { ...GUIDEWIRE, useDirectSolve });
    const start = rod.tip().y; // ~ -2 + 8cm initial deploy
    rod.input = { deployed: 22, steer: 0.3, torque: 0 }; // feed +14cm of material
    for (let i = 0; i < 500; i++) rod.step(1 / 60);
    return { climb: rod.tip().y - start, finite: allFinite(rod), n: rod.n };
  }

  it("flag-OFF and flag-ON both inject material and advance the tip cranially (wired + stable)", () => {
    const off = climbRun(false);
    const on = climbRun(true);
    // eslint-disable-next-line no-console
    console.log(`[direct-live] climb legacy=${off.climb.toFixed(2)}cm direct=${on.climb.toFixed(2)}cm n(direct)=${on.n}`);
    expect(off.finite && on.finite).toBe(true);
    expect(off.climb).toBeGreaterThan(8); // legacy baseline (kinematic advection rail ⇒ ~1:1)
    expect(on.n).toBeGreaterThan(40); // the direct path injected the fed material (frozen-h)
    expect(on.climb).toBeGreaterThan(4); // the dynamic beam advances the tip cranially
    // KNOWN PHASE-3a GAP (not a regression): with REAL EI the stiff column partially buckles under the
    // kinematic advection feed where the under-converged legacy stayed straight, so direct climb < legacy.
    // The fix is the compliant force-capped feed motor (A5 / Phase 5), which drives the column
    // physically instead of a kinematic rail — until then the direct climb is intentionally lower.
  }, 60000);

  it("flag-ON: stays bounded inside the tube (no tunneling / blowup) over a long run", () => {
    const rod = new CosseratRod(tube(0.55, 18), "a", { ...GUIDEWIRE, useDirectSolve: true });
    rod.input = { deployed: 14, steer: 0.3, torque: 0 };
    for (let i = 0; i < 600; i++) rod.step(1 / 60);
    expect(allFinite(rod)).toBe(true);
    // every node stays within a sane lateral envelope of the straight tube (radius 0.55)
    let maxLat = 0;
    for (const p of rod.x) maxLat = Math.max(maxLat, Math.hypot(p.x, p.z));
    expect(maxLat).toBeLessThan(2); // not exploding laterally
  }, 60000);
});

describe("Phase-3 live integration — coaxial telescoping on the direct beam (#2)", () => {
  it("the wire slides freely out of the held sheath (telescopes), both rods on the dynamic beam", () => {
    const outer = new CosseratRod(tube(0.55, 48), "a", { ...SHEATH, useDirectSolve: true });
    const inner = new CosseratRod(tube(0.55, 48), "a", { ...GUIDEWIRE, useDirectSolve: true });
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(15, 0, 0);
    asm.setInnerInput(10, 0, 0);
    for (let i = 0; i < 300; i++) asm.step(1 / 60);
    const innerTip0 = inner.tip().clone();
    const outerTip0 = outer.tip().clone();
    asm.setInnerInput(25, 0, 0); // advance the wire; sheath input held
    for (let i = 0; i < 700; i++) asm.step(1 / 60);
    const innerMoved = inner.tip().distanceTo(innerTip0);
    const outerMoved = outer.tip().distanceTo(outerTip0);
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
    expect(innerMoved).toBeGreaterThan(8); // the wire telescopes substantially out of the sheath
    expect(outerMoved).toBeLessThan(0.4 * innerMoved); // free slide, sheath not rigidly dragged
    expect(inner.tip().y).toBeGreaterThan(outer.tip().y + 4); // wire tip well past the sheath tip
  }, 120000);
});
