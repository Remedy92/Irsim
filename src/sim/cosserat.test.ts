import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  CoaxialAssembly,
  COAX_DIVERGENCE_BREAK_CM,
  COAX_WALL_ESCAPE_TOL_CM,
  CosseratRod,
  GUIDEWIRE,
  GUIDEWIRE_FLOPPY,
  GUIDEWIRE_STIFF,
  SHIPPED_GUIDEWIRE,
  SHIPPED_SHEATH,
  SHEATH
} from "./cosserat";
import { buildNormalAnatomy } from "./anatomy";
import type { Anatomy } from "./types";
import { makeWallContact } from "./contact";

/** A single straight tube along +y. radius=5 makes the rod effectively free (test
 * constraint DOFs in isolation); a narrow radius reflects the real operating
 * condition (a guidewire is always inside a vessel, never free space). */
function tube(radius: number): Anatomy {
  const points = [];
  for (let i = 0; i <= 12; i++) points.push({ pos: new Vector3(0, -2 + i * 4, 0), radius, s: i * 4 });
  return {
    id: "t",
    name: "tube",
    branches: [{ id: "tube", name: "tube", attenuation: 1, points }],
    access: [{ id: "a", name: "a", pos: new Vector3(0, -2, 0), dir: new Vector3(0, 1, 0), branchId: "tube" }],
    targets: [],
    provenance: { source: "test", license: "test", note: "test" }
  };
}
const freeTube = () => tube(5);
const vesselTube = () => tube(0.55);

/** A SHORT straight vessel tube of axial length `lenCm` (capped at the distal end). Feeding a
 * longer rod into it blocks the tip at the distal cap → the shaft must bow/buckle. */
function shortTube(radius: number, lenCm: number): Anatomy {
  const points = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const y = -2 + (i * lenCm) / n;
    points.push({ pos: new Vector3(0, y, 0), radius, s: (i * lenCm) / n });
  }
  return {
    id: "t",
    name: "tube",
    branches: [{ id: "tube", name: "tube", attenuation: 1, points }],
    access: [{ id: "a", name: "a", pos: new Vector3(0, -2, 0), dir: new Vector3(0, 1, 0), branchId: "tube" }],
    targets: [],
    provenance: { source: "test", license: "test", note: "test" }
  };
}

function run(rod: CosseratRod, steps: number) {
  for (let i = 0; i < steps; i++) rod.step(1 / 60);
}

/** Total accumulated bending along the shaft (sum of turn angles between adjacent segments). */
function totalCurvature(rod: CosseratRod): number {
  let s = 0;
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 1; i < rod.n - 1; i++) {
    a.subVectors(rod.x[i], rod.x[i - 1]).normalize();
    b.subVectors(rod.x[i + 1], rod.x[i]).normalize();
    s += Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
  }
  return s;
}

/** The largest +y reached by ANY node — used to assert the tip never tunnels past a cap. */
function maxNodeY(rod: CosseratRod): number {
  let m = -Infinity;
  for (const p of rod.x) m = Math.max(m, p.y);
  return m;
}

function allFinite(rod: CosseratRod): boolean {
  for (const p of rod.x) if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
  for (const q of rod.q) if (!Number.isFinite(q.x) || !Number.isFinite(q.w)) return false;
  return true;
}

function maxNodeDisplacement(from: Vector3[], rod: CosseratRod): number {
  let max = 0;
  for (let i = 0; i < Math.min(from.length, rod.x.length); i++) max = Math.max(max, from[i].distanceTo(rod.x[i]));
  return max;
}

describe("CosseratRod", () => {
  it("segment wall contact distributes correction through the inverse-mass accessor", () => {
    const rod = new CosseratRod(freeTube(), "a");
    rod.x[1].set(1.3, 0, 0);
    rod.x[2].set(1.3, 0.2, 0);
    rod.prev[1].copy(rod.x[1]);
    rod.prev[2].copy(rod.x[2]);
    rod.w[1] = 0;
    rod.w[2] = 0;
    rod.invMassAt = (node) => (node === 1 || node === 2 ? 1 : 0);
    const c = makeWallContact("r", 0, 1, 0.1, 0.05, 0.05, 1e-9, 1e-8, 1e-7);
    c.center.set(0, 0.1, 0);
    c.vesselTangent.set(0, 1, 0);
    c.allowedRadius = 1.0;
    const before = 0.5 * (rod.x[1].x + rod.x[2].x);

    (rod as unknown as { solveSegmentWallContact(c: ReturnType<typeof makeWallContact>, dtSeconds: number): void })
      .solveSegmentWallContact(c, 1 / 120);

    expect(0.5 * (rod.x[1].x + rod.x[2].x)).toBeLessThan(before);
    expect(c.lambdaN).toBeGreaterThan(0);
  });

  it("self-contact distributes correction through the inverse-mass accessor", () => {
    const rod = new CosseratRod(freeTube(), "a");
    rod.x[1].set(0, 0, 0);
    rod.x[2].set(0, 1, 0);
    rod.x[6].set(0.05, 0, 0);
    rod.x[7].set(0.05, 1, 0);
    for (const i of [1, 2, 6, 7]) {
      rod.prev[i].copy(rod.x[i]);
      rod.w[i] = 0;
    }
    rod.invMassAt = (node) => ([1, 2, 6, 7].includes(node) ? 1 : 0);
    const midpointGap = () =>
      new Vector3().addVectors(rod.x[1], rod.x[2]).multiplyScalar(0.5)
        .distanceTo(new Vector3().addVectors(rod.x[6], rod.x[7]).multiplyScalar(0.5));
    const sc = { segA: 1, segB: 6, lambdaN: 0 };
    const before = midpointGap();

    (rod as unknown as { solveSelfContact(sc: { segA: number; segB: number; lambdaN: number }, dtSeconds: number): void })
      .solveSelfContact(sc, 1 / 120);

    expect(midpointGap()).toBeGreaterThan(before);
    expect(sc.lambdaN).toBeGreaterThan(0);
  });

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

  it("stays inside the lumen while feeding (containment holds)", () => {
    const rod = new CosseratRod(vesselTube(), "a");
    rod.input = { deployed: 20, steer: 0, torque: 0 };
    run(rod, 200);
    // every node must remain within the lumen radius of the (straight) centerline
    for (const p of rod.x) expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(0.56);
  });

  it("feeding increases total deployed arc length", () => {
    const short = new CosseratRod(vesselTube(), "a");
    short.input = { deployed: 10, steer: 0, torque: 0 };
    run(short, 200);
    const long = new CosseratRod(vesselTube(), "a");
    long.input = { deployed: 30, steer: 0, torque: 0 };
    run(long, 200);
    const arc = (r: CosseratRod) => {
      let s = 0;
      for (let i = 0; i < r.n - 1; i++) s += r.x[i + 1].distanceTo(r.x[i]);
      return s;
    };
    expect(arc(long)).toBeGreaterThan(arc(short) + 5);
  });

  // STAGE 2: the material-injection insertion BC replaces the unsound uniform-l0 feed.
  // In a straight low-resistance tube the tip must advance ~1:1 with the fed length, with
  // NO accordioning (no segment compressed below its frozen rest length). This is the
  // design-doc validation #1 (docs/physics-design-cosserat-xpbd.md §8) and the core fix.
  it("free-feeding advances the tip ~1:1 without buckling (material-injection BC)", () => {
    const rod = new CosseratRod(freeTube(), "a");
    rod.input = { deployed: 10, steer: 0, torque: 0 };
    run(rod, 250); // settle at 10 cm deployed
    const tipBefore = rod.tip().clone();
    const deployedBefore = rod.deployedLength();

    rod.input.deployed = 25; // feed in 15 cm more
    run(rod, 700); // feed (rate-limited) + settle

    const tipAfter = rod.tip().clone();
    const fed = rod.deployedLength() - deployedBefore;
    const advanced = tipAfter.distanceTo(tipBefore);

    // (tip advance) / (feed length) ≈ 1 after the transient
    const ratio = advanced / fed;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.15);

    // NO accordioning: every segment stays at (within ε of) its FROZEN rest length h.
    // The injection BC freezes restLen[j] = h and never rescales it, so the rod cannot be
    // born compressed (the old eigenstrain failure mode).
    const h = rod.h;
    for (let i = 0; i < rod.n - 1; i++) {
      const segLen = rod.x[i + 1].distanceTo(rod.x[i]);
      expect(segLen).toBeGreaterThan(0.9 * h); // not compressed (no accordion)
      expect(segLen).toBeLessThan(1.1 * h); // not stretched
    }
  });

  it("a pre-shaped tip deflects laterally (bend coupling)", () => {
    const rod = new CosseratRod(freeTube(), "a");
    rod.input = { deployed: 20, steer: 0.9, torque: 0 };
    run(rod, 300);
    const tip = rod.tip();
    const lateral = Math.hypot(tip.x, tip.z);
    // The realistic floppy-tip EI under-expresses free precurve in the current local XPBD solve; this
    // test only guards that rest-curvature coupling is alive. A calibrated free-shape test belongs
    // with the future direct/dynamic rod solve.
    expect(lateral).toBeGreaterThan(0.035);
  });

  it.todo("a realistic floppy pre-shaped tip expresses its free J/angle shape quantitatively");

  it("rolling the handle (torque) propagates twist down the shaft to the tip frame", () => {
    // Twist IS a real DOF and the handle roll propagates to the distal frame: rolling the
    // hub π/2 winds ~π/2 of roll (about the rod axis) into the tip frame relative to the
    // base. (This is the mechanism; turning that frame-roll into a clean rotation of the
    // tip DEFLECTION azimuth additionally needs the precurve to express strongly AND the
    // wind-up/release of spin friction — see the it.todo below.)
    const tipTwist = (rod: CosseratRod) => {
      // roll of the tip frame relative to the base frame, about the rod axis (director z)
      const rel = rod.q[0].clone().conjugate().multiply(rod.q[rod.q.length - 1]);
      return 2 * Math.atan2(Math.abs(rel.z), Math.abs(rel.w));
    };
    const rod = new CosseratRod(freeTube(), "a");
    rod.input = { deployed: 20, steer: 0.9, torque: 0 };
    run(rod, 300);
    const twist0 = tipTwist(rod);

    rod.input.torque = Math.PI / 2;
    run(rod, 300);
    const twist1 = tipTwist(rod);

    // the tip frame's accumulated roll must change clearly when the hub is rolled π/2
    expect(Math.abs(twist1 - twist0)).toBeGreaterThan(0.4);
  });

  // KNOWN LIMITATION (Stage 2 → later): rolling the hub winds the tip FRAME (asserted
  // above), but in the rewritten quasi-static material-injection solver the resulting
  // rotation of the tip DEFLECTION azimuth is weak and trades off against pre-shaped-tip
  // strength (stiffening twist to rotate the azimuth softens the precurve, and vice
  // versa — they cannot both pass simultaneously without the deeper solver work the design
  // doc flags: proper angular dynamics / a direct rod block solver, plus the spin-friction
  // wind-up/release of Stage 3). The frame-roll propagation IS verified; the azimuth-
  // rotation fidelity is deferred. See the Stage-2 report.
  it.todo("rolling the handle clearly rotates the tip DEFLECTION azimuth (needs spin friction / direct rod block)");

  it("bend compliance governs how strongly a pre-shaped tip expresses its rest curvature", () => {
    // Bend STIFFNESS is isolated cleanly by a pre-shaped tip in a FREE straight tube: the only
    // difference between the two rods is bend/twist COMPLIANCE (the graded material field).
    //
    // PHYSICS NOTE (Stage 3): a stiffer tip EXPRESSES its rest curvature MORE — it has the
    // flexural strength to hold the pre-shaped curl against the straightening constraints,
    // so it deflects FURTHER laterally; a floppier tip is too compliant to realize the curl
    // and stays nearly straight. (The Stage-1 rig asserted the reverse "stiffer deflects
    // less" using a tilted-root cantilever, but that separation came entirely from the old
    // post-solve contain() PROJECTION clipping the two rods differently — a true free rod in
    // a gravity-free quasi-static solver has no transverse load to make a straight-rest stiff
    // rod deflect less. With contain() replaced by real in-loop contact (this stage), the
    // honest, robust, contact-free stiffness signature is rest-curvature EXPRESSION.)
    const lateralOf = (rod: CosseratRod) => {
      rod.input = { deployed: 20, steer: 0.9, torque: 0 };
      run(rod, 350);
      const t = rod.tip();
      return Math.hypot(t.x, t.z);
    };
    const stiff = lateralOf(new CosseratRod(freeTube(), "a", GUIDEWIRE_STIFF));
    const floppy = lateralOf(new CosseratRod(freeTube(), "a", GUIDEWIRE_FLOPPY));
    // the stiffer tip holds its curl and deflects measurably MORE than the floppy one
    expect(stiff).toBeGreaterThan(0.1);
    expect(stiff).toBeGreaterThan(floppy * 1.3);
  });
});

// =============================================================================================
// STAGE 3 — IN-LOOP FRICTIONAL WALL CONTACT (design doc §3)
// The post-solve contain() projection is gone; wall contact is now an XPBD INEQUALITY inside
// the Gauss-Seidel loop, producing a real normal multiplier λ_n that feeds Coulomb friction.
// These are the qualitative ROD-LEVEL acceptance behaviors; the isolated constraint math is in
// contact.test.ts.
// =============================================================================================
describe("CosseratRod — in-loop frictional contact (Stage 3)", () => {
  it("BLOCKED-TIP BUCKLING: feed against a distal cap bows the shaft instead of tunnelling", () => {
    // Short capped vessel tube (axial length 12, y = -2..10). Fill it, then keep feeding: the
    // tip is blocked at the distal cap, so the over-fed material has nowhere to go but to BOW
    // the shaft. The design-doc test #2: shaft curvature increases (it buckles) and no node
    // tunnels through the wall.
    const tubeLen = 12; // cap at y = -2 + 12 = 10
    const cap = -2 + tubeLen;
    const rod = new CosseratRod(shortTube(0.55, tubeLen), "a");
    rod.input = { deployed: 11, steer: 0, torque: 0 };
    run(rod, 400); // fill the tube straight
    const curvFilled = totalCurvature(rod);
    expect(curvFilled).toBeLessThan(0.5); // essentially straight when just filled

    rod.input.deployed = 22; // keep feeding ~11 cm more against the blocked tip
    run(rod, 800);
    const curvBuckled = totalCurvature(rod);

    // the shaft bows/buckles: accumulated curvature increases dramatically vs the filled state
    expect(curvBuckled).toBeGreaterThan(curvFilled + 3);
    // and NO node tunnels past the distal cap: the centerline remains inside the last capsule's
    // rounded end (vessel radius minus rod radius/contact margin is just under 0.5 cm here).
    expect(maxNodeY(rod)).toBeLessThan(cap + 0.45);
    // the rod is still finite/stable after sustained over-feed against the wall
    expect(allFinite(rod)).toBe(true);
  });

  it("the wall contains the rod IN-LOOP (no post-solve projection): nodes stay inside the lumen", () => {
    // Same guarantee the old contain() gave, now via the in-loop XPBD normal inequality:
    // a wire fed into a narrow vessel tube never leaves the lumen.
    const rod = new CosseratRod(vesselTube(), "a");
    rod.input = { deployed: 24, steer: 0.8, torque: 0 };
    run(rod, 400);
    for (const p of rod.x) expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(0.56);
  });

  it("TORQUE STORAGE: rolling the hub against the wall winds spin-friction torque (λ_roll), released when off", () => {
    // A wire pressed against a curved vessel wall has wall contacts with a real normal load, so
    // SPIN friction (design doc §3) can store roll torque. We roll the hub against that wall and
    // assert the store-then-release mechanism is ACTIVE: with spin friction the wall contacts
    // accumulate a nonzero roll multiplier λ_roll (= stored surface torque, winding up toward
    // the Coulomb cone μ_roll·λ_n); with spin friction OFF, no roll torque is stored at all.
    //
    // (The rigorous stick→release of the spin constraint itself — frame HELD while λ_roll < cone,
    // then SLIPPING when exceeded — is asserted in contact.test.ts. At the whole-rod level in
    // this QUASI-STATIC solver the strong twist coupling propagates hub roll to the tip frame
    // within a frame's iteration sweep, so the GLOBAL tip-frame roll lag is small; a visibly
    // delayed-then-whipping tip needs the angular-dynamics work the design doc defers, §5. The
    // wall TORQUE STORAGE this test asserts is the real, verifiable Stage-3 mechanism.)
    const planarCurve = (): Anatomy => {
      const points = [];
      const n = 36;
      const R = 10;
      let s = 0;
      let prev: Vector3 | null = null;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * (Math.PI * 0.9); // ~160° planar arc (x-y plane: no geometric torsion)
        const pos = new Vector3(R * (1 - Math.cos(a)), -2 + R * Math.sin(a), 0);
        if (prev) s += pos.distanceTo(prev);
        points.push({ pos, radius: 0.4, s });
        prev = pos;
      }
      return {
        id: "t",
        name: "c",
        branches: [{ id: "tube", name: "c", attenuation: 1, points }],
        access: [{ id: "a", name: "a", pos: points[0].pos.clone(), dir: new Vector3(0, 1, 0), branchId: "tube" }],
        targets: [],
        provenance: { source: "test", license: "test", note: "test" }
      };
    };
    // peek the private persistent contacts (test-only) to read stored normal/roll torque
    const contactsOf = (rod: CosseratRod) =>
      (rod as unknown as { contacts: ({ lambdaN: number; lambdaRoll: number } | null)[] }).contacts;
    const sumLambdaN = (rod: CosseratRod) => {
      let s = 0;
      for (const c of contactsOf(rod)) if (c) s += Math.max(0, c.lambdaN);
      return s;
    };
    const sumLambdaRoll = (rod: CosseratRod) => {
      let s = 0;
      for (const c of contactsOf(rod)) if (c) s += Math.abs(c.lambdaRoll);
      return s;
    };

    const windUp = (spinScale: number) => {
      const rod = new CosseratRod(planarCurve(), "a", { ...GUIDEWIRE, spinFrictionScale: spinScale });
      rod.input = { deployed: 22, steer: 0.2, torque: 0 };
      run(rod, 400); // settle pressed against the curve
      const ln = sumLambdaN(rod);
      // steadily wind the hub roll, then read the torque stored at the wall contacts
      for (let target = 0.5; target <= 2.0; target += 0.5) {
        rod.input.torque = target;
        run(rod, 60);
      }
      return { ln, lr: sumLambdaRoll(rod), finite: allFinite(rod) };
    };

    const withFriction = windUp(20); // firm spin friction
    const without = windUp(0); // spin friction disabled

    // sanity: the wire genuinely presses the wall (nonzero normal load) so friction can bite
    expect(withFriction.ln).toBeGreaterThan(0);
    // WITH spin friction the wall contacts STORE roll torque (λ_roll > 0): torque is winding up
    expect(withFriction.lr).toBeGreaterThan(0);
    // WITHOUT spin friction NO roll torque is stored at all (the round rod spins freely)
    expect(without.lr).toBe(0);
    // both remain finite/stable through the wind-up
    expect(withFriction.finite).toBe(true);
    expect(without.finite).toBe(true);
  });
});

// =============================================================================================
// STAGE 4 — CAPSULE-CHAIN/SDF LUMEN + BRANCH HYSTERESIS + SELF-COLLISION (design doc §7)
// The Stage-3 nearest-single-segment containment stub is replaced by the implicit capsule-chain
// lumen (lumen.ts): graph-aware nearest-edge with hysteresis (no cross-carina snap), segment-
// sample collision, and non-adjacent self-collision. The isolated lumen math is in
// lumen.test.ts; these are the rod-level integration behaviors.
// =============================================================================================
describe("CosseratRod — capsule-chain lumen + branch + self-collision (Stage 4)", () => {
  /**
   * A Y-bifurcation phantom. Branch "main": trunk (0,0)→(0,5) continuing into the LEFT limb
   * toward (+x). Branch "right": from the SHARED ostium (0,5) into the RIGHT limb toward (−x).
   * A wire fed up the trunk follows the (gently-continuing) left limb and must NEVER snap across
   * the carina into the right limb.
   */
  const yBifurcation = (r = 0.45): Anatomy => {
    const main = [] as { pos: Vector3; radius: number; s: number }[];
    for (let i = 0; i <= 5; i++) main.push({ pos: new Vector3(0, i, 0), radius: r, s: i });
    for (let i = 1; i <= 6; i++) main.push({ pos: new Vector3(0.6 * i, 5 + i, 0), radius: r, s: 5 + i });
    const right = [] as { pos: Vector3; radius: number; s: number }[];
    right.push({ pos: new Vector3(0, 5, 0), radius: r, s: 0 });
    for (let i = 1; i <= 6; i++) right.push({ pos: new Vector3(-0.6 * i, 5 + i, 0), radius: r, s: i });
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
  };

  const lumenOf = (rod: CosseratRod) =>
    (rod as unknown as { lumen: { phiHard(x: Vector3): number } }).lumen;

  it("a wire fed up the trunk stays inside the lumen and does NOT straddle the carina", () => {
    const rod = new CosseratRod(yBifurcation(), "a");
    rod.input = { deployed: 13, steer: 0, torque: 0 };
    run(rod, 700);
    const lumen = lumenOf(rod);
    // every node must stay inside the implicit lumen (φ ≤ a small contact margin; r_rod=0.05).
    for (let i = 1; i < rod.n; i++) {
      expect(lumen.phiHard(rod.x[i])).toBeLessThanOrEqual(0.06);
    }
    // A straight wire commits to ONE limb at the bifurcation (either is physically valid). The
    // Stage-4 guarantee is that it does NOT STRADDLE the carina: the distal nodes (above the
    // ostium) must all sit on a SINGLE side of the centerplane, never some in the left limb and
    // others in the right limb (which would mean a mid-wire cross-carina snap). The limbs are at
    // x≈±0.6·(y−5), so |x| grows with height; a node in the wrong limb would flip sign.
    const distalX: number[] = [];
    for (let i = 1; i < rod.n; i++) {
      const p = rod.x[i];
      if (p.y > 6.5) distalX.push(p.x);
    }
    expect(distalX.length).toBeGreaterThan(3); // the wire did reach a limb
    const anyLeft = distalX.some((x) => x > 0.3);
    const anyRight = distalX.some((x) => x < -0.3);
    // committed to exactly one limb (not straddling both across the carina)
    expect(anyLeft && anyRight).toBe(false);
    expect(allFinite(rod)).toBe(true);
  });

  /** A short capped pocket of radius `radius`, axial length `len`, capped at the distal end. */
  const pocket = (radius: number, len: number): Anatomy => {
    const points = [];
    const n = 10;
    for (let i = 0; i <= n; i++) {
      const y = -2 + (i * len) / n;
      points.push({ pos: new Vector3(0, y, 0), radius, s: (i * len) / n });
    }
    return {
      id: "t",
      name: "pocket",
      branches: [{ id: "tube", name: "pocket", attenuation: 1, points }],
      access: [{ id: "a", name: "a", pos: new Vector3(0, -2, 0), dir: new Vector3(0, 1, 0), branchId: "tube" }],
      targets: [],
      provenance: { source: "test", license: "test", note: "test" }
    };
  };
  /** Minimum distance between NON-adjacent segment midpoints (ignore neighbours within 3 segs). */
  const minNonAdjacent = (rod: CosseratRod): number => {
    const mid = (i: number) => new Vector3().addVectors(rod.x[i], rod.x[i + 1]).multiplyScalar(0.5);
    const segs = rod.n - 1;
    let minD = Infinity;
    for (let a = 0; a < segs; a++) {
      for (let b = a + 4; b < segs; b++) minD = Math.min(minD, mid(a).distanceTo(mid(b)));
    }
    return minD;
  };

  it("FORCED LOOP: heavy over-feed folds the shaft without self-interpenetration", () => {
    // A short capped pocket (R=0.6, length 5): filling it then massively over-feeding (to 30 cm)
    // forces the shaft to fold/coil back on itself inside the pocket. Self-collision must keep
    // non-adjacent segments from passing THROUGH each other — the minimum non-adjacent
    // segment-midpoint distance must stay ≥ ~2·r_rod (the rod diameter).
    const rod = new CosseratRod(pocket(0.6, 5), "a");
    rod.input = { deployed: 5, steer: 0, torque: 0 };
    run(rod, 300); // fill
    rod.input.deployed = 30; // massively over-feed → the shaft folds/coils inside the pocket
    run(rod, 1200);

    const r = GUIDEWIRE.rodRadius;
    const minD = minNonAdjacent(rod);
    // the rod genuinely folded so non-adjacent segments lie close (within a few diameters) ...
    expect(minD).toBeLessThan(8 * r);
    // ... but self-collision kept them from interpenetrating: ≥ ~2·r (the diameter). Without the
    // self-collision constraint the folded coils pass through each other and minD drops well
    // below the diameter (verified ~0.074 < 0.1); WITH it the coils self-support at ~0.117.
    expect(minD).toBeGreaterThanOrEqual(2 * r - 0.01);
    expect(allFinite(rod)).toBe(true);
  }, 60_000);
});

// =============================================================================================
// STAGE 5 — COAXIAL SHEATH OVER WIRE (design doc §6)
// A second instrument (sheath/catheter) slides over the guidewire. Each is its own free rod with
// its own MaterialProfile; CoaxialAssembly couples them with inner-in-outer normal containment +
// coax friction (NO axial tie) + an open portal at the outer tip, solved INTERLEAVED. The isolated
// constraint math is in coax.test.ts; these are the rod-level acceptance behaviors.
// =============================================================================================
describe("CoaxialAssembly — sheath over wire (Stage 5)", () => {
  /** A straight tube along +y of axial length `len`, width `radius`, access at the bottom. */
  const straight = (radius: number, len: number): Anatomy => {
    const points = [];
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const y = -2 + (i * len) / n;
      points.push({ pos: new Vector3(0, y, 0), radius, s: (i * len) / n });
    }
    return {
      id: "t",
      name: "tube",
      branches: [{ id: "tube", name: "tube", attenuation: 1, points }],
      access: [{ id: "a", name: "a", pos: new Vector3(0, -2, 0), dir: new Vector3(0, 1, 0), branchId: "tube" }],
      targets: [],
      provenance: { source: "test", license: "test", note: "test" }
    };
  };

  const rhoToOuter = (p: Vector3, outer: CosseratRod): number => {
    const ab = new Vector3();
    const ap = new Vector3();
    const closest = new Vector3();
    const rel = new Vector3();
    const perp = new Vector3();
    let best = Infinity;
    for (let k = 0; k < outer.x.length - 1; k++) {
      const a = outer.x[k];
      const b = outer.x[k + 1];
      ab.subVectors(b, a);
      ap.subVectors(p, a);
      const len2 = ab.lengthSq() || 1e-12;
      const u = Math.max(0, Math.min(1, ap.dot(ab) / len2));
      closest.copy(a).addScaledVector(ab, u);
      const len = Math.sqrt(len2);
      if (len > 1e-9) ab.multiplyScalar(1 / len);
      rel.subVectors(p, closest);
      perp.copy(rel).addScaledVector(ab, -rel.dot(ab));
      best = Math.min(best, perp.length());
    }
    return best;
  };

  const maxOverlapRho = (inner: CosseratRod, outer: CosseratRod): number => {
    let max = 0;
    const coveredArc = outer.deployedLength() - 0.5;
    for (let i = 1; i < inner.n - 1; i++) {
      if (i * inner.h < coveredArc) max = Math.max(max, rhoToOuter(inner.x[i], outer));
    }
    return max;
  };

  it("AXIAL SLIDE / OPEN PORTAL: the wire advances out of the sheath tip with the sheath held (no rigid lock)", () => {
    // Sheath deployed 15 and HELD; wire starts at 10 (fully inside), then advances to 25 — 10 cm of
    // which must exit past the sheath tip through the OPEN PORTAL with no fake obstruction. The
    // sheath must NOT be dragged along (the wire slides freely relative to it: no axial tie).
    const outer = new CosseratRod(straight(0.55, 48), "a", SHEATH);
    const inner = new CosseratRod(straight(0.55, 48), "a", GUIDEWIRE);
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(15, 0, 0);
    asm.setInnerInput(10, 0, 0);
    for (let i = 0; i < 300; i++) asm.step(1 / 60);
    const innerTip0 = inner.tip().clone();
    const outerTip0 = outer.tip().clone();

    asm.setInnerInput(25, 0, 0); // advance the wire 15 cm (sheath input unchanged → held)
    for (let i = 0; i < 700; i++) asm.step(1 / 60);
    const innerMoved = inner.tip().distanceTo(innerTip0);
    const outerMoved = outer.tip().distanceTo(outerTip0);

    // the WIRE advanced substantially (it slid freely through the sheath + out the open portal).
    // The catheter applies radial containment + sliding friction, but there is no axial distance
    // tie — this is a large free slide, not a rigid lock.
    expect(innerMoved).toBeGreaterThan(8);
    // the SHEATH barely moved relative to the wire — no rigid lock dragging it along (NO axial
    // tie). The shipped radial support treats the catheter as the cylinder, so sheath slide stays ≪
    // the wire's slide.
    expect(outerMoved).toBeLessThan(1.5);
    expect(outerMoved).toBeLessThan(0.25 * innerMoved); // sheath slide ≪ wire slide (free, not locked)
    // the wire tip is now WELL PAST the sheath tip (it exited the portal, not blocked at it)
    expect(inner.tip().y).toBeGreaterThan(outer.tip().y + 4);
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
  });

  it("SHEATH CHANNEL: covered guidewire material is governed by the sheath, not the vessel wall", () => {
    // A guidewire sitting inside the sheath should travel in the sheath channel and leave through
    // the open portal. The overlapped section gets a weak radial channel constraint even before hard
    // wall contact; only the lead-out beyond the sheath tip is a free vessel-navigating wire.
    const outer = new CosseratRod(straight(2, 30), "a", SHEATH);
    const inner = new CosseratRod(straight(2, 30), "a", GUIDEWIRE);
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(12, 0, 0);
    asm.setInnerInput(12, 0, 0);
    for (let i = 0; i < 120; i++) asm.step(1 / 60);

    const offset = 0.03; // inside the sheath clearance: 0.09 - 0.05 = 0.04 cm
    for (let i = 1; i < inner.n - 1; i++) {
      if (inner.x[i].y < outer.tip().y - 0.5) {
        inner.x[i].x += offset;
        inner.prev[i].x += offset;
      }
    }

    const before = maxOverlapRho(inner, outer);
    expect(before).toBeLessThan(outer.coaxLumenRadius - inner.rodRadius);
    asm.step(1 / 60);
    expect(asm.activeCoaxCount()).toBeGreaterThan(0);
    expect(maxOverlapRho(inner, outer)).toBeLessThan(before);
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
  });

  it("LATERAL SUPPORT: the overlapped wire is restored into the sheath channel", () => {
    // Over-feed a long wire into a SHORT wide tube while a sheath covers the y∈[1,9] band. Improved
    // feed transport keeps this much straighter than the old compressed-inlet artifact, so we then
    // apply a controlled covered-wire lateral offset. The sheath channel must restore the overlapped
    // wire toward the catheter centerline without relying on vessel-wall contact or a rigid tie.
    const tubeLen = 15;
    const inner = new CosseratRod(straight(5, tubeLen), "a", GUIDEWIRE);
    const outer = new CosseratRod(straight(5, tubeLen), "a", SHEATH);
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(12, 0, 0);
    asm.setInnerInput(26, 0, 0);
    for (let i = 0; i < 900; i++) asm.step(1 / 60);

    const contactNode = Math.min(20, inner.n - 2, outer.n - 2);
    expect(contactNode * inner.h).toBeLessThan(outer.deployedLength() - 0.5);
    for (let i = contactNode - 3; i <= contactNode + 3; i++) {
      inner.x[i].copy(outer.x[i]).add(new Vector3(0.2, 0, 0));
      inner.prev[i].copy(inner.x[i]);
    }
    const displaced = maxOverlapRho(inner, outer);
    expect(displaced).toBeGreaterThan(asm.innerClearance() + 0.05);

    for (let i = 0; i < 80; i++) asm.step(1 / 60);

    // The relevant invariant is relative: the covered guidewire stays inside the sheath channel
    // instead of following an independent vessel path. The absolute vessel-frame bow can be large
    // because the catheter channel is still solved as contact/friction, not as a merged centerline.
    expect(asm.activeCoaxCount()).toBeGreaterThan(0);
    expect(maxOverlapRho(inner, outer)).toBeLessThan(asm.innerClearance() + 0.02);
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
  });

  it("stays finite + stable over many frames with both instruments fed and rolled", () => {
    const outer = new CosseratRod(straight(0.55, 48), "a", SHEATH);
    const inner = new CosseratRod(straight(0.55, 48), "a", GUIDEWIRE);
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(18, 0, 0.5);
    asm.setInnerInput(14, 0.5, 1.0);
    for (let i = 0; i < 500; i++) asm.step(1 / 60);
    // the wire reached close to its commanded deployed length (it was not locked in place)
    expect(inner.deployedLength()).toBeGreaterThan(12);
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
    for (const q of inner.q) expect(q.length()).toBeCloseTo(1, 3);
    for (const q of outer.q) expect(q.length()).toBeCloseTo(1, 3);
  });
});

/**
 * Stage 6 — APP INTEGRATION. The live app (src/three/Viewport.tsx) drives a CoaxialAssembly
 * (guidewire inner + sheath outer) on the real procedural anatomy at a chosen femoral access,
 * mapping the store's per-device inputs onto the two rods INDEPENDENTLY — the wire and the sheath
 * are advanced/retracted/rolled separately and there is NO slaving between them; the only coupling
 * is physical, emerging from coax contact + friction. The app reads back
 * {depth = inner.deployedLength(), tipToTarget, reached, contrast} for the metrics HUD. These tests
 * exercise that exact input→step→metric path headlessly (the React/Three render layer is verified
 * visually by the human) so the integration cannot silently regress: the wire must advance/steer/roll
 * in the anatomy, the metrics must be finite + sane, the two devices must stay decoupled, and the
 * assembly must stay stable even when their deployments diverge to the extremes the UI allows.
 */
describe("CoaxialAssembly — app integration on real anatomy (Stage 6)", () => {
  /** Build the assembly exactly as Viewport.tsx does (default right-femoral access). */
  function buildAppAssembly(accessId = "rcfa"): CoaxialAssembly {
    const anatomy = buildNormalAnatomy();
    const inner = new CosseratRod(anatomy, accessId, SHIPPED_GUIDEWIRE, { deployed: 8, steer: 0.35, torque: 0 });
    const outer = new CosseratRod(anatomy, accessId, SHIPPED_SHEATH, { deployed: 6.5, steer: 0, torque: 0 });
    return new CoaxialAssembly(outer, inner);
  }

  /**
   * Apply the store → instrument input mapping that Viewport.tsx performs each frame. The wire and
   * sheath are driven INDEPENDENTLY (mirroring the decoupled live mapping): `deployed`/`steer`/
   * `torque` set the wire; `sheathDeployed`/`sheathTorque` set the sheath separately (steer is a
   * guidewire-only control — the sheath has no pre-shaped tip). `sheathDeployed` defaults to the
   * store's fresh sheath depth (5 cm) so the existing single-instrument assertions keep a realistic
   * trailing sheath without any deployed-length slaving.
   */
  function applyStoreInput(
    asm: CoaxialAssembly,
    deployed: number,
    steer: number,
    torque: number,
    sheathDeployed = 6.5,
    sheathTorque = 0
  ): void {
    asm.inner.input.deployed = deployed;
    asm.inner.input.steer = steer;
    asm.inner.input.torque = torque;
    asm.outer.input.deployed = sheathDeployed;
    asm.outer.input.steer = 0;
    asm.outer.input.torque = sheathTorque;
  }

  it("starts the shipped app assembly inside the access vessel without a large settling impulse", () => {
    const asm = buildAppAssembly();
    applyStoreInput(asm, 8, 0.35, 0, 6.5);
    const inner0 = asm.inner.x.map((p) => p.clone());
    const outer0 = asm.outer.x.map((p) => p.clone());

    expect(asm.inner.maxWallPenetration()).toBe(0);
    expect(asm.outer.maxWallPenetration()).toBe(0);

    for (let i = 0; i < 120; i++) asm.step(1 / 60);

    expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);
    expect(asm.inner.maxWallPenetration()).toBeLessThanOrEqual(0.05);
    expect(asm.outer.maxWallPenetration()).toBeLessThanOrEqual(0.05);
    expect(maxNodeDisplacement(inner0, asm.inner)).toBeLessThan(1);
    expect(maxNodeDisplacement(outer0, asm.outer)).toBeLessThan(1);
  }, 20000);

  it("advancing the shipped guidewire from app defaults stays contained without stretch spikes", () => {
    const asm = buildAppAssembly();
    applyStoreInput(asm, 8, 0.35, 0, 6.5);
    for (let i = 0; i < 120; i++) asm.step(1 / 60);

    applyStoreInput(asm, 16, 0.35, 0, 6.5);
    let maxWirePen = 0;
    let maxSheathPen = 0;
    let maxWireSegErr = 0;
    let maxSheathSegErr = 0;
    for (let i = 0; i < 240; i++) {
      asm.step(1 / 60);
      maxWirePen = Math.max(maxWirePen, asm.inner.maxWallPenetration());
      maxSheathPen = Math.max(maxSheathPen, asm.outer.maxWallPenetration());
      for (let s = 0; s < asm.inner.restLen.length; s++) {
        maxWireSegErr = Math.max(
          maxWireSegErr,
          Math.abs(asm.inner.x[s + 1].distanceTo(asm.inner.x[s]) - asm.inner.restLen[s])
        );
      }
      for (let s = 0; s < asm.outer.restLen.length; s++) {
        maxSheathSegErr = Math.max(
          maxSheathSegErr,
          Math.abs(asm.outer.x[s + 1].distanceTo(asm.outer.x[s]) - asm.outer.restLen[s])
        );
      }
    }

    expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);
    expect(asm.inner.deployedLength()).toBeCloseTo(16, 1);
    expect(maxWirePen).toBeLessThanOrEqual(0.05);
    expect(maxSheathPen).toBeLessThanOrEqual(0.05);
    expect(maxWireSegErr).toBeLessThan(0.15);
    expect(maxSheathSegErr).toBeLessThan(0.15);
  }, 30000);

  it("feeds the guidewire from inside the catheter cylinder and out through the catheter tip", () => {
    const asm = buildAppAssembly();
    applyStoreInput(asm, 8, 0.35, 0, 6.5);
    for (let i = 0; i < 120; i++) asm.step(1 / 60);

    applyStoreInput(asm, 19.2, 0.35, 0, 6.5);
    for (let i = 0; i < 360; i++) asm.step(1 / 60);

    // Shipped direct uses a force-capped compliant feed motor, so the stiff wire no longer
    // kinematically over-advances 1:1 through the curved held sheath. The hard requirement is that
    // it exits the open portal cleanly and stays contained in the covered section.
    expect(asm.innerExitPastOuterTip()).toBeGreaterThan(2);
    // maxCoveredInnerRho is now the TRUE clamped distance of covered nodes to the sheath (not the
    // perpendicular offset to the segment's infinite line). This is the honest containment metric:
    // it can no longer read ≈clearance while a node has axially escaped its paired segment. Covered
    // material here is genuinely inside the channel and stays within the clearance budget. The budget
    // is clearance + 0.03 (vs the old +0.02 against the perpendicular metric): near the OPEN PORTAL
    // the lead-out node angles out of the sheath tip, so its CLAMPED distance to the tip segment picks
    // up a small honest axial component (~0.026 cm over clearance here) that the old infinite-line
    // perpendicular metric simply discarded. This is the metric becoming honest, not a containment
    // regression — div=0 confirms nothing actually escaped.
    expect(asm.maxCoveredInnerRho()).toBeLessThanOrEqual(asm.innerClearance() + 0.03);
    expect(asm.divergedCoaxCount()).toBe(0); // nothing broke containment in the benign feed case
    expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);
  }, 30000);

  it("advances the guidewire into the anatomy as the store deployed length increases", () => {
    const asm = buildAppAssembly();
    const anatomy = buildNormalAnatomy();
    const access = anatomy.access[0].pos;

    // settle at the default deployed length, then command a deeper advance (as pressing W does)
    applyStoreInput(asm, 8, 0.45, 0);
    for (let i = 0; i < 120; i++) asm.step(1 / 60);
    const depth0 = asm.inner.deployedLength();
    const tipDist0 = asm.inner.tip().distanceTo(access);

    applyStoreInput(asm, 30, 0.45, 0);
    for (let i = 0; i < 400; i++) asm.step(1 / 60);
    const depth1 = asm.inner.deployedLength();
    const tipDist1 = asm.inner.tip().distanceTo(access);

    // the wire fed in (more deployed material) and the tip travelled further from the access — it
    // navigated into the vessel rather than buckling at the inlet.
    expect(depth1).toBeGreaterThan(depth0 + 8);
    // The direct FEM path advances as a stiff contained column rather than the legacy kinematic rail;
    // require meaningful forward tip travel without reintroducing the old 1:1 feed expectation.
    expect(tipDist1).toBeGreaterThan(tipDist0 + 0.8);
    expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);
  }, 45000);

  it("rolling the hub (torque) and steering stay finite and rotate the tip frame", () => {
    const asm = buildAppAssembly();
    applyStoreInput(asm, 16, 0.6, 0);
    for (let i = 0; i < 200; i++) asm.step(1 / 60);
    // command a hub roll (as pressing D repeatedly does)
    applyStoreInput(asm, 16, 0.6, 1.4);
    for (let i = 0; i < 200; i++) asm.step(1 / 60);
    // the tip frame picked up twist from the hub roll (the cannulation mechanism)
    expect(asm.inner.tipRoll()).toBeGreaterThan(0.05);
    expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);
    for (const q of asm.inner.q) expect(q.length()).toBeCloseTo(1, 3);
  }, 20000);

  it("produces a finite, sane metrics block (the values the HUD reads back)", () => {
    const asm = buildAppAssembly();
    const anatomy = buildNormalAnatomy();
    const target = anatomy.targets.find((t) => t.id === "t_renal_l") ?? anatomy.targets[0];

    applyStoreInput(asm, 24, 0.5, 0.3);
    for (let i = 0; i < 300; i++) asm.step(1 / 60);

    // the exact metric expressions Viewport.tsx feeds to setMetrics()
    const depth = asm.inner.deployedLength();
    const tipToTarget = asm.inner.tip().distanceTo(target.pos);
    const reached = tipToTarget < target.acceptance;

    expect(Number.isFinite(depth)).toBe(true);
    expect(depth).toBeGreaterThan(0);
    expect(Number.isFinite(tipToTarget)).toBe(true);
    expect(tipToTarget).toBeGreaterThanOrEqual(0);
    expect(typeof reached).toBe("boolean");
  }, 20000);

  it("retracting (lowering deployed) shrinks the wire without exploding", () => {
    const asm = buildAppAssembly();
    applyStoreInput(asm, 28, 0.4, 0);
    for (let i = 0; i < 350; i++) asm.step(1 / 60);
    const deep = asm.inner.deployedLength();

    applyStoreInput(asm, 8, 0.4, 0);
    for (let i = 0; i < 350; i++) asm.step(1 / 60);
    const shallow = asm.inner.deployedLength();

    expect(deep).toBeGreaterThan(shallow + 6); // material was withdrawn
    expect(asm.inner.n).toBeGreaterThanOrEqual(3); // never collapses below the minimum node count
    expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);
  }, 20000);

  it("repeated pullback after a curled/deep wire does not lurch the tip forward", () => {
    const asm = buildAppAssembly();
    const access = buildNormalAnatomy().access.find((a) => a.id === "rcfa")!.pos;

    applyStoreInput(asm, 30, 0.85, 1.1, 7);
    for (let i = 0; i < 450; i++) asm.step(1 / 60);
    let lastDeepTipDistance = asm.inner.tip().distanceTo(access);
    expect(asm.inner.deployedLength()).toBeGreaterThan(20);

    for (let cycle = 0; cycle < 3; cycle++) {
      applyStoreInput(asm, 8, 0.85, 1.1, 7);
      for (let i = 0; i < 500; i++) asm.step(1 / 60);
      const shallowTipDistance = asm.inner.tip().distanceTo(access);
      const shallowDepth = asm.inner.deployedLength();
      expect(shallowDepth).toBeCloseTo(8, 1);
      // Direct compliant pullback can relax a curled tip by ~1-1.5 cm as stored bend unloads; keep
      // the gate focused on preventing large forward lurches/regressions.
      expect(shallowTipDistance).toBeLessThanOrEqual(lastDeepTipDistance + 2);

      const heldBefore = asm.inner.tip().distanceTo(access);
      for (let i = 0; i < 140; i++) asm.step(1 / 60);
      const heldAfter = asm.inner.tip().distanceTo(access);
      expect(heldAfter).toBeLessThanOrEqual(heldBefore + 0.5);
      expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);

      applyStoreInput(asm, 24, 0.85, 1.1, 7);
      for (let i = 0; i < 360; i++) asm.step(1 / 60);
      lastDeepTipDistance = asm.inner.tip().distanceTo(access);
      expect(asm.inner.deployedLength()).toBeGreaterThan(20);
    }
  }, 90000);

  it(
    "drives the wire and sheath to independent deployments without coupling or exploding",
    () => {
      const asm = buildAppAssembly();

      // settle with the soft wire leading and the stiff sheath trailing behind it (the usual order)
      applyStoreInput(asm, 18, 0.4, 0, 6);
      for (let i = 0; i < 240; i++) asm.step(1 / 60);
      const wireLead = asm.inner.deployedLength();
      const sheathTrail = asm.outer.deployedLength();
      expect(wireLead).toBeGreaterThan(sheathTrail); // wire tip leads

      // advance ONLY the sheath out past the wire while holding the wire command fixed. With no
      // slaving the wire's deployed length must NOT follow the sheath, and both rods must stay
      // finite as the sheath runs ahead (coax open portal / inner fully contained in the channel).
      applyStoreInput(asm, 18, 0.4, 0, 24);
      for (let i = 0; i < 300; i++) asm.step(1 / 60);
      const wireHeld = asm.inner.deployedLength();
      const sheathAdvanced = asm.outer.deployedLength();
      expect(sheathAdvanced).toBeGreaterThan(sheathTrail + 8); // the sheath advanced on its own
      expect(Math.abs(wireHeld - wireLead)).toBeLessThan(3); // the wire did not move with it
      expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);

      // and the inverse: retract ONLY the wire deep inside the now-long sheath (sheath leads, wire
      // mostly contained) — the sheath must hold its depth while the wire withdraws independently.
      applyStoreInput(asm, 6, 0.4, 0, 24);
      for (let i = 0; i < 300; i++) asm.step(1 / 60);
      expect(asm.inner.deployedLength()).toBeLessThan(wireHeld - 6); // wire withdrew on its own
      expect(asm.outer.deployedLength()).toBeGreaterThan(sheathAdvanced - 5); // sheath held depth
      expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);
    },
    90_000
  );

  /**
   * HONEST per-node wall penetration over ALL non-kinematic nodes, IGNORING the channel clip — the
   * primitive the clip cannot re-blind. maxWallPenetration() skips clipped covered material (and a
   * once-diverged node whose flag heals is re-clipped), so steady-state safety must be asserted on
   * THIS metric, never on the reported one.
   */
  const honestMaxWallPen = (rod: CosseratRod): number => {
    let m = 0;
    for (let i = 1; i < rod.n - 1; i++) m = Math.max(m, rod.wallPenetrationAtNode(i));
    return Math.max(0, m);
  };

  /** Drive the audit reproduction: hold the wire at 8, run the sheath 6.5 → 14 → 20 over it. */
  const runSheathAdvanceEscape = (asm: CoaxialAssembly) => {
    applyStoreInput(asm, 8, 0.35, 0, 6.5);
    for (let i = 0; i < 120; i++) asm.step(1 / 60);
    let maxHonestPen = 0;
    let sawDivergence = false;
    for (const sheath of [14, 20]) {
      applyStoreInput(asm, 8, 0.35, 0, sheath);
      for (let i = 0; i < 300; i++) {
        asm.step(1 / 60);
        maxHonestPen = Math.max(maxHonestPen, honestMaxWallPen(asm.inner));
        if (asm.divergedCoaxCount() > 0) sawDivergence = true;
      }
    }
    for (let i = 0; i < 200; i++) asm.step(1 / 60); // settle
    return { maxHonestPen, sawDivergence };
  };

  // COAX CONTAINMENT HONESTY — advancing the sheath far past a held wire (the reproduction of the
  // previously-blind geometric escape). What this gate asserts (all measured, all true): the guard
  // FIRES, the honest diagnostic SEES the gross through-wall excursion the old clip hid, and the
  // guard CAPS the dragging near the wall-escape trigger instead of the old unbounded ≈47 cm. What it
  // does NOT claim: that the wire ends up fully inside the vessel — the settled state still hides a
  // few cm of penetration just BELOW the trigger (re-clipped, invisible to maxWallPenetration); that
  // residual is the documented-red it.fails gate below. The sheath's OWN navigation is a later
  // (bilateral-coupling) work item: assertions are scoped to the WIRE.
  it(
    "keeps covered-wire containment HONEST and caps the escape as the sheath advances past the held wire",
    () => {
      const asm = buildAppAssembly("rcfa");
      const { maxHonestPen, sawDivergence } = runSheathAdvanceEscape(asm);

      // The wire command was held — it did not get telescoped along by the sheath.
      expect(asm.inner.deployedLength()).toBeLessThan(12);
      expect(asm.outer.deployedLength()).toBeGreaterThan(16);

      // HONESTY OF THE TRANSIENT: this scenario IS the audit bug, so the guard MUST engage and the
      // honest wall-penetration metric MUST surface the gross excursion the old clip hid. A run where
      // the guard never fires and the honest peak stays ≈0 would mean the old lie is back — so we
      // assert the OPPOSITE of the old silent-0. (Regression canary for "containment went blind".)
      expect(sawDivergence).toBe(true);
      expect(maxHonestPen).toBeGreaterThan(0.05);

      // THE CAP (what the guard actually delivers today, measured): the previously UNBOUNDED ≈47 cm
      // through-wall dragging now peaks ≈8 cm and the settled honest penetration hovers just below the
      // COAX_WALL_ESCAPE_TOL trigger (measured ≈5.3 cm — out-of-sheath covered material pinned on the
      // sheath's extended line, re-clipped below the trigger). Bounded ≈9× better than the bug, but
      // NOT full containment — see the documented-red gate below for the remaining honest deficit.
      expect(maxHonestPen).toBeLessThan(2 * COAX_WALL_ESCAPE_TOL_CM);
      expect(honestMaxWallPen(asm.inner)).toBeLessThan(COAX_WALL_ESCAPE_TOL_CM + 1);

      expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);
    },
    60_000
  );

  // DOCUMENTED RED (`it.fails`, repo precedent: dynamic_recovery.test.ts) — the honest steady-state
  // containment deficit after a sheath-advance escape. The guard caps the dragging near the
  // COAX_WALL_ESCAPE_TOL trigger, but covered material that has left the sheath and sits BELOW the
  // trigger is re-clipped: it keeps ≈5.3 cm of clip-hidden wall penetration in the settled state
  // (maxWallPenetration reads 0.000 there — blind by design of the clip). This gate asserts the REAL
  // requirement on the honest primitive; it is expected to FAIL until the bilateral-coupling work item
  // (sheath follows wire) removes the escape at its source, or a spacing-aware escape metric lets the
  // trigger drop. CI goes RED the day this starts passing — then promote it to a hard gate.
  it.fails(
    "DOCUMENTED RED: settled honest wall penetration after a sheath-advance escape is within the 0.05 cm budget",
    () => {
      const asm = buildAppAssembly("rcfa");
      runSheathAdvanceEscape(asm);
      expect(honestMaxWallPen(asm.inner)).toBeLessThanOrEqual(0.05);
    },
    60_000
  );

  // DOCUMENTED RED (`it.fails`) — the over-fed covered prolapse hides ≈4 cm of wall penetration BELOW
  // the guard trigger. Deploying the standard wire to 24 cm over a held 6.5 cm sheath drives the
  // covered base ≈4 cm through the vessel wall while it remains channel-clipped (the guard's
  // COAX_WALL_ESCAPE_TOL = 6 cm deliberately does not fire there: releasing those nodes destabilizes
  // the calibrated push/chirality trajectories, and the over-feed keeps pushing them out regardless).
  // This encodes that known deferred harm as a RED gate on the honest primitive instead of a comment:
  // it is expected to FAIL until bilateral coupling cures the prolapse-through-wall at its source.
  it.fails(
    "DOCUMENTED RED: over-fed covered wire (deploy 24 over held 6.5 sheath) stays inside the vessel",
    () => {
      const asm = buildAppAssembly("rcfa");
      applyStoreInput(asm, 24, 0.3, 0, 6.5);
      let maxHonest = 0;
      let maxUncontained = 0;
      for (let i = 0; i < 600; i++) {
        asm.step(1 / 60);
        maxHonest = Math.max(maxHonest, honestMaxWallPen(asm.inner));
        maxUncontained = Math.max(maxUncontained, asm.maxUncontainedWallPenetration());
      }
      // Honest all-node penetration must stay within the navigation budget (measured: ≈4 cm — RED),
      // and the report-only uncontained diagnostic must agree that no out-of-sheath covered material
      // is through the wall.
      expect(Math.max(maxHonest, maxUncontained)).toBeLessThanOrEqual(0.05);
    },
    90_000
  );

  // The divergence guard must actually FIRE on a sustained gross escape (a covered node both far from
  // the sheath AND dragged through the vessel wall) and then RECOVER substantially. We sustain a hard
  // outward displacement of covered mid-wire nodes for several frames — far outside the vessel — so the
  // guard's actual-harm trigger (true distance > break AND wall penetration > tol) is unambiguously
  // met; the guard flags them and restores vessel contact, and once we release the perturbation the
  // wire relaxes back TOWARD the vessel. Measured truth (post both-trigger-retention fix): forced
  // honest penetration ≈1.9 cm relaxes to a stable ≈0.7 cm residual (out-of-sheath covered material
  // below the wall trigger) — substantial recovery, NOT yet full containment; the strict ≤0.05 honest
  // steady state is the same residual class as the documented-red sheath-advance gate above.
  it(
    "the divergence guard fires on a sustained covered-wire escape and recovers substantially",
    () => {
      const asm = buildAppAssembly("rcfa");
      applyStoreInput(asm, 8, 0.35, 0, 6.5);
      for (let i = 0; i < 120; i++) asm.step(1 / 60);
      applyStoreInput(asm, 8, 0.35, 0, 20);
      for (let i = 0; i < 300; i++) asm.step(1 / 60);

      // Sustain a large lateral shove of the covered mid-wire nodes (well outside the vessel) for a few
      // frames so the escape is unambiguous and the guard's wall-penetration trigger is met.
      const lo = 3;
      const hi = Math.min(10, asm.inner.n - 1);
      let firedDuringForce = false;
      for (let f = 0; f < 8; f++) {
        for (let i = lo; i < hi; i++) {
          asm.inner.x[i].x += 8;
          asm.inner.prev[i].x += 8;
        }
        asm.step(1 / 60);
        if (asm.divergedCoaxCount() > 0) firedDuringForce = true;
      }
      // The guard engaged on the forced gross escape, and the honest metric saw the gap.
      expect(firedDuringForce).toBe(true);
      expect(asm.maxCoveredTrueDistance()).toBeGreaterThan(COAX_DIVERGENCE_BREAK_CM);
      const forcedPen = honestMaxWallPen(asm.inner); // honest primitive — the clip cannot hide it
      expect(forcedPen).toBeGreaterThan(1); // the forced escape really drove the wire through the wall

      // Release the perturbation and settle: with vessel contact restored (the guard exempted the
      // escaped nodes from the channel clip), the wire relaxes back toward the vessel. Assert the
      // HONEST recovery (per-node penetration ignoring the clip — maxWallPenetration() would read 0
      // here simply because healed/sub-trigger material is re-clipped, which proves nothing):
      // substantial (well under the forced depth), bounded (≈0.7 cm measured residual), and the
      // per-node divergence flags healed (each flagged node got back under both repair thresholds).
      for (let i = 0; i < 500; i++) asm.step(1 / 60);
      const settledHonest = honestMaxWallPen(asm.inner);
      expect(settledHonest).toBeLessThan(forcedPen); // it recovered, not worsened
      expect(settledHonest).toBeLessThanOrEqual(1.2); // bounded residual (measured ≈0.7)
      expect(asm.divergedCoaxCount()).toBe(0); // flags healed (both triggers back under repair)
      expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);
    },
    60_000
  );

  it("rebuilds the assembly at the left common femoral access and stays stable", () => {
    // The start-side selector swaps the access id; the assembly is rebuilt there. This guards the
    // rebuild path: material feeds in and the rods stay finite from the lcfa entry. (How FAR it
    // climbs is asserted by the skipped parity test below — blocked on the solver chirality bug.)
    const asm = buildAppAssembly("lcfa");
    const anatomy = buildNormalAnatomy();
    const access = anatomy.access.find((a) => a.id === "lcfa");
    expect(access).toBeTruthy();

    applyStoreInput(asm, 8, 0.45, 0, 5);
    for (let i = 0; i < 120; i++) asm.step(1 / 60);
    const depth0 = asm.inner.deployedLength();
    applyStoreInput(asm, 24, 0.45, 0, 5);
    for (let i = 0; i < 300; i++) asm.step(1 / 60);

    expect(asm.inner.deployedLength()).toBeGreaterThan(depth0 + 6); // material fed in
    expect(asm.inner.n).toBeGreaterThanOrEqual(3);
    expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);
  }, 20000);

  // SOLVER MIRROR-EQUIVARIANCE (the "chirality" property) — RESOLVED 2026-06-11. The rigorous probe
  // (reflect the whole anatomy across x, drive the same access with the same input, expect identical
  // cranial climb) is the canonical CHIRALITY PARITY gate in validation_calibrated.test.ts. The
  // shipped coax assembly is mirror-equivariant across the realistic envelope (L/R diff 0.0% at
  // 12/18 cm, 1.6% at 24 cm, 3.8% at 30 cm); the dramatic asymmetry seen earlier was a post-buckling
  // over-push artifact (deploy 36 cm), not a solver sign bug. The old skipped lcfa-vs-rcfa parity test
  // that lived here was a weaker probe (it conflated solver handedness with real L/R anatomical
  // asymmetry) and is superseded by that x-mirror gate.
});
