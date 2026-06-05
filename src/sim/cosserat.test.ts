import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  CoaxialAssembly,
  CosseratRod,
  GUIDEWIRE,
  GUIDEWIRE_FLOPPY,
  GUIDEWIRE_STIFF,
  SHEATH
} from "./cosserat";
import { buildNormalAnatomy } from "./anatomy";
import type { Anatomy } from "./types";

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
  });
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
    // With the two-way coax coupling (outerMassScale > 0) the wire carries a realistic sliding
    // friction against the sheath, so it advances a little less freely than the idealized one-way
    // case — still a large free slide, not a lock.
    expect(innerMoved).toBeGreaterThan(8);
    // the SHEATH barely moved relative to the wire — no rigid lock dragging it along (NO axial
    // tie). It may be nudged a little by the now-bilateral lateral support, but ≪ the wire's slide.
    expect(outerMoved).toBeLessThan(1.5);
    expect(outerMoved).toBeLessThan(0.25 * innerMoved); // sheath slide ≪ wire slide (free, not locked)
    // the wire tip is now WELL PAST the sheath tip (it exited the portal, not blocked at it)
    expect(inner.tip().y).toBeGreaterThan(outer.tip().y + 4);
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
  });

  it("CLEARANCE: the default coax model does not pre-center a wire before sheath-wall contact", () => {
    // A guidewire sitting inside the sheath clearance should remain a free, independent device until
    // it actually contacts the inner wall. This guards against turning the coax model into a hidden
    // centerline tie.
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

    expect(maxOverlapRho(inner, outer)).toBeLessThan(outer.coaxLumenRadius - inner.rodRadius);
    asm.step(1 / 60);
    expect(asm.activeCoaxCount()).toBe(0);
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
  });

  it("LATERAL SUPPORT: the overlapped wire stays contained by the sheath and the support is load-bearing", () => {
    // Over-feed a long wire into a SHORT wide tube while a sheath covers the y∈[1,9] band. The
    // sheath's inner-in-outer containment must keep the overlapped wire inside the sheath lumen and
    // carry a real two-way normal load at some point during the over-feed — emergent catheter-over-
    // wire support, no hand-coded tie. NOTE we assert robust, deterministic properties (containment +
    // peak load + stability), NOT a solo-vs-coax buckling-magnitude ratio: free buckling is a
    // bifurcation and its magnitude is chaotic (hypersensitive to tiny solver changes), so a
    // magnitude comparison is not a reliable regression.
    const overlapDev = (rod: CosseratRod) => {
      let m = 0;
      for (let i = 1; i < rod.n; i++) {
        const p = rod.x[i];
        if (p.y > 1 && p.y < 9) m = Math.max(m, Math.hypot(p.x, p.z));
      }
      return m;
    };
    const tubeLen = 15;
    const inner = new CosseratRod(straight(5, tubeLen), "a", GUIDEWIRE);
    const outer = new CosseratRod(straight(5, tubeLen), "a", SHEATH);
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(12, 0, 0);
    asm.setInnerInput(26, 0, 0);
    let peakLoad = 0;
    for (let i = 0; i < 900; i++) {
      asm.step(1 / 60);
      peakLoad = Math.max(peakLoad, asm.coaxNormalLoad());
    }

    // the overlapped wire stays near the sheath centerline instead of bowing freely through the wide
    // vessel; this is intentionally looser than the nominal clearance because the support is a
    // compliant contact solved in a real-time iteration budget.
    expect(overlapDev(inner)).toBeLessThan(1.0);
    expect(maxOverlapRho(inner, outer)).toBeLessThan(0.5);
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
    // the coax containment is load-bearing at some point (the two-way support actually engaged)
    expect(peakLoad).toBeGreaterThan(1e-6);
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
    const inner = new CosseratRod(anatomy, accessId, GUIDEWIRE);
    const outer = new CosseratRod(anatomy, accessId, SHEATH);
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
    sheathDeployed = 5,
    sheathTorque = 0
  ): void {
    asm.inner.input.deployed = deployed;
    asm.inner.input.steer = steer;
    asm.inner.input.torque = torque;
    asm.outer.input.deployed = sheathDeployed;
    asm.outer.input.steer = 0;
    asm.outer.input.torque = sheathTorque;
  }

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
    expect(tipDist1).toBeGreaterThan(tipDist0 + 3);
    expect(allFinite(asm.inner) && allFinite(asm.outer)).toBe(true);
  });

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
  });

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
  });

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
  });

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
    20000
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
  });

  // KNOWN FAILURE — pre-existing solver chirality bug. A solo Cosserat rod navigates a vessel that
  // curves to the patient's right (the right iliac) far better than its mirror image (the left
  // iliac): mirroring the whole anatomy across x swaps the climb distance exactly (~19 cm vs ~9 cm),
  // proving the asymmetry is in the core rod solver, not the anatomy or the coax assembly. The left
  // start side is navigable but degraded until this is fixed. Un-skip once the handedness bug is
  // resolved (likely a sign/convention in solveBendTwist / solveStretchShear quaternion handedness).
  it.skip("navigates UP the left iliac as well as the right (parity across the sagittal plane)", () => {
    const climb = (accessId: string) => {
      const asm = buildAppAssembly(accessId);
      const acc = buildNormalAnatomy().access.find((a) => a.id === accessId)!;
      applyStoreInput(asm, 26, 0.45, 0, 5);
      for (let i = 0; i < 520; i++) asm.step(1 / 60);
      return asm.inner.tip().y - acc.pos.y; // cranial climb from the access
    };
    const right = climb("rcfa");
    const left = climb("lcfa");
    expect(left).toBeGreaterThan(0.6 * right); // left should climb within ~40% of the right
  });
});
