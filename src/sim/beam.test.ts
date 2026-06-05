import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { BeamSolver } from "./beam";

function line(n: number): Vector3[] {
  const x: Vector3[] = [];
  for (let i = 0; i < n; i++) x.push(new Vector3(0, i, 0));
  return x;
}
function totalCurv(x: Vector3[]): number {
  let s = 0;
  for (let i = 1; i < x.length - 1; i++) {
    s += new Vector3().addVectors(x[i - 1], x[i + 1]).addScaledVector(x[i], -2).length();
  }
  return s;
}

describe("BeamSolver — global implicit bending", () => {
  it("leaves an already-straight clamped rod straight (the minimiser is the rest state)", () => {
    const x = line(20);
    const k = new Array(20).fill(5);
    new BeamSolver().solve(x, k, 1, 2);
    for (let i = 0; i < 20; i++) {
      expect(Math.abs(x[i].x)).toBeLessThan(1e-9);
      expect(Math.abs(x[i].z)).toBeLessThan(1e-9);
      expect(x[i].y).toBeCloseTo(i, 9); // straight line preserved exactly
    }
  });

  it("pins the proximal fixedPrefix nodes exactly (Dirichlet clamp)", () => {
    const x = line(20);
    x[10].x = 2; // a spike the solve will smooth
    const before0 = x[0].clone();
    const before1 = x[1].clone();
    new BeamSolver().solve(x, new Array(20).fill(10), 1, 2);
    expect(x[0].distanceTo(before0)).toBeLessThan(1e-12);
    expect(x[1].distanceTo(before1)).toBeLessThan(1e-12);
  });

  it("SMOOTHS a kink, and a stiffer rod (higher k) smooths it more (global propagation)", () => {
    const make = () => {
      const x = line(30);
      x[15].x = 1; // a single-node lateral spike (sharp kink)
      return x;
    };
    const soft = make();
    const stiff = make();
    new BeamSolver().solve(soft, new Array(30).fill(2), 1, 2);
    new BeamSolver().solve(stiff, new Array(30).fill(50), 1, 2);

    // the spike is reduced and spread; stiffer ⇒ the peak is pulled in further and curvature lower
    expect(stiff[15].x).toBeLessThan(soft[15].x);
    expect(totalCurv(stiff)).toBeLessThan(totalCurv(soft));
    // and the deflection is SPREAD across many nodes, not localised (global bending, not a local fix)
    let spread = 0;
    for (let i = 5; i < 25; i++) spread += Math.abs(stiff[i].x);
    expect(spread).toBeGreaterThan(stiff[15].x * 1.5);
  });

  it("a very stiff rod pulls a displaced free tip strongly back toward the clamp axis", () => {
    const x = line(25);
    for (let i = 2; i < 25; i++) x[i].x = 3; // contact 'wants' the whole shaft displaced 3cm
    new BeamSolver().solve(x, new Array(25).fill(80), 1, 2);
    // a stiff clamped rod resists the uniform sideways push: the tip is pulled well back toward axis
    expect(x[24].x).toBeLessThan(3);
    expect(Number.isFinite(x[24].x)).toBe(true);
  });
});
