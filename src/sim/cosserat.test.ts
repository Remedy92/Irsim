import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { CosseratRod, GUIDEWIRE } from "./cosserat";
import type { Anatomy } from "./types";

/** A single straight, very wide tube along +y so the rod is effectively free
 * (lumen containment never engages) — lets us test the rod physics in isolation. */
function freeTube(): Anatomy {
  const points = [];
  for (let i = 0; i <= 12; i++) points.push({ pos: new Vector3(0, -2 + i * 4, 0), radius: 5, s: i * 4 });
  return {
    id: "t",
    name: "free tube",
    branches: [{ id: "tube", name: "tube", attenuation: 1, points }],
    access: [{ id: "a", name: "a", pos: new Vector3(0, -2, 0), dir: new Vector3(0, 1, 0), branchId: "tube" }],
    targets: [],
    provenance: { source: "test", license: "test", note: "test" }
  };
}

function run(rod: CosseratRod, steps: number) {
  for (let i = 0; i < steps; i++) rod.step(1 / 60);
}

function allFinite(rod: CosseratRod): boolean {
  for (const p of rod.x) if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
  for (const q of rod.q) if (!Number.isFinite(q.x) || !Number.isFinite(q.w)) return false;
  return true;
}

describe("CosseratRod", () => {
  it("stays finite and stable over many steps", () => {
    const rod = new CosseratRod(freeTube(), "a");
    rod.input = { deployed: 20, steer: 0.6, torque: 1.0 };
    run(rod, 400);
    expect(allFinite(rod)).toBe(true);
  });

  it("keeps all quaternions normalized", () => {
    const rod = new CosseratRod(freeTube(), "a");
    rod.input = { deployed: 22, steer: 0.7, torque: 0.8 };
    run(rod, 200);
    for (const q of rod.q) expect(q.length()).toBeCloseTo(1, 3);
  });

  it("is inextensible: segment lengths track the rest length", () => {
    const rod = new CosseratRod(freeTube(), "a");
    rod.input = { deployed: 20, steer: 0, torque: 0 };
    run(rod, 200);
    const l0 = 20 / GUIDEWIRE.segments;
    let maxDev = 0;
    for (let i = 0; i < rod.n - 1; i++) {
      maxDev = Math.max(maxDev, Math.abs(rod.x[i + 1].distanceTo(rod.x[i]) - l0));
    }
    expect(maxDev).toBeLessThan(0.15 * l0);
  });

  it("a straight rod (no tip curve) stays straight along the insertion axis", () => {
    const rod = new CosseratRod(freeTube(), "a");
    rod.input = { deployed: 20, steer: 0, torque: 0 };
    run(rod, 200);
    const tip = rod.tip();
    expect(Math.abs(tip.x)).toBeLessThan(0.6);
    expect(Math.abs(tip.z)).toBeLessThan(0.6);
    // advanced roughly `deployed` up the axis from the base at y=-2
    expect(tip.y).toBeGreaterThan(-2 + 0.7 * 20);
  });

  it("a pre-shaped tip deflects laterally (bend coupling)", () => {
    const rod = new CosseratRod(freeTube(), "a");
    rod.input = { deployed: 20, steer: 0.9, torque: 0 };
    run(rod, 300);
    const tip = rod.tip();
    const lateral = Math.hypot(tip.x, tip.z);
    expect(lateral).toBeGreaterThan(0.1);
  });

  it("rolling the handle (torque) rotates the tip deflection azimuth (twist propagation)", () => {
    const rod = new CosseratRod(freeTube(), "a");
    rod.input = { deployed: 20, steer: 0.9, torque: 0 };
    run(rod, 300);
    const t0 = rod.tip();
    const az0 = Math.atan2(t0.z, t0.x);

    rod.input.torque = Math.PI / 2;
    run(rod, 300);
    const t1 = rod.tip();
    const az1 = Math.atan2(t1.z, t1.x);

    let d = az1 - az0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    // torque must clearly rotate where the tip points (allowing for transmission lag)
    expect(Math.abs(d)).toBeGreaterThan(0.4);
  });

  it("advances further with greater deployed length", () => {
    const a = new CosseratRod(freeTube(), "a");
    a.input = { deployed: 10, steer: 0, torque: 0 };
    run(a, 150);
    const b = new CosseratRod(freeTube(), "a");
    b.input = { deployed: 30, steer: 0, torque: 0 };
    run(b, 150);
    expect(b.tip().y).toBeGreaterThan(a.tip().y + 5);
  });
});
