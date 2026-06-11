import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import {
  CoaxialAssembly,
  CosseratRod,
  GUIDEWIRE_DIRECT,
  SHIPPED_GUIDEWIRE,
  SHIPPED_SHEATH,
  type CosseratParams
} from "./cosserat";

/** The dynamic co-rotational beam SHIPPING config (coarser h=0.5) — what the calibrated gates validate. */
const DIRECT = GUIDEWIRE_DIRECT;
import { buildNormalAnatomy } from "./anatomy";
import type { Anatomy } from "./types";

/**
 * PHASE-0 CALIBRATED VALIDATION RIG — the falsifiable gates for the dynamic co-rotational beam
 * rewrite (docs/physics-design-dynamic-corotational-beam.md). This file is intentionally separate
 * from validation.test.ts (which regresses the CURRENT XPBD mechanics) so the NEW-solver acceptance
 * gates live in one place and can be flipped on as `params.useDirectSolve` lands, phase by phase.
 *
 * Two kinds of test live here:
 *   1. BASELINE RECORDERS (runnable now) — they navigate the CURRENT solver and console.log the
 *      numbers the rewrite must improve, asserting only finiteness/sign so CI stays green and any
 *      NaN/transport regression is still caught. These give every later phase an auditable "before".
 *   2. HARD GATES — the precise analytic acceptance assertions. The direct-lane elastic gates are NOW
 *      LIVE (un-skipped) and run in CI: realised-EI cantilever δ=F·L³/3EI, substep-invariance, torsion
 *      θ=T·L/GJ (Phase A; HARDENED here in Phase E), pure-bend R=EI/M, Bishop twist-leak (Phase A;
 *      HARDENED here in Phase E), and the Phase-D blocked-tip stall/prolapse. Still deferred: x-mirror
 *      CHIRALITY PARITY (it.skip — Workstream X, a shared-code handedness fix that does not block the
 *      flip) and CAPSTAN (it.todo — the μ-dependence is column-compression-dominated on the raw feed
 *      force; see the capstan-scaffold comment for the empirical Phase-E finding).
 *
 * WHY THE CANTILEVER/BUCKLING BENCHES ARE NOT HERE YET: they need a tip POINT-LOAD hook and a real
 * force-equilibrium solve. The current rod is quasi-static + heavily damped, so a load CREEPS rather
 * than deflecting elastically (validation.test.ts documents this) — a cantilever measured against it
 * is an integrator artifact, not realised EI. Those benches are added with the solver API the
 * implicit dynamic solver exposes; this file ships the architecture-INDEPENDENT gates first.
 */

// ---------------------------------------------------------------------------
// Anatomy x-mirror — the true handedness probe (see [[irsim-solver-chirality-bug]]).
// Reflecting the ENTIRE system (anatomy + access) across the sagittal (x) plane must, for an
// isotropic rod, give an identically-reflected trajectory and therefore an IDENTICAL cranial climb
// (climb is measured in y, which the reflection leaves unchanged). The current Cosserat solve does
// NOT satisfy this — left-curving vessels navigate worse than their right-curving mirror — which
// isolates the asymmetry to the core solver (a sign/handedness in the quaternion bend-twist), not
// the anatomy or the coax coupling. cosserat.test.ts:813's skipped test only compares rcfa-vs-lcfa
// (two different vessels); this is the missing pure-reflection experiment its own comment describes.
// ---------------------------------------------------------------------------

/** Deep-clone an Anatomy and negate every world x-coordinate (reflect across the sagittal plane). */
function mirrorAnatomyX(a: Anatomy): Anatomy {
  const mp = (v: Vector3) => new Vector3(-v.x, v.y, v.z);
  return {
    id: a.id + "-xmirror",
    name: a.name + " (x-mirror)",
    branches: a.branches.map((b) => ({
      id: b.id,
      name: b.name,
      attenuation: b.attenuation,
      points: b.points.map((p) => ({ pos: mp(p.pos), radius: p.radius, s: p.s }))
    })),
    targets: a.targets.map((t) => ({
      id: t.id,
      name: t.name,
      pos: mp(t.pos),
      acceptance: t.acceptance,
      viaBranchId: t.viaBranchId
    })),
    access: a.access.map((ac) => ({
      id: ac.id,
      name: ac.name,
      pos: mp(ac.pos),
      dir: mp(ac.dir).normalize(),
      branchId: ac.branchId
    })),
    provenance: { ...a.provenance }
  };
}

/** Cranial climb (cm) of the tip after navigating `accessId` of `anatomy` with the standard feed. */
function climb(anatomy: Anatomy, accessId: string, deployed = 26, steps = 240): number {
  const access = anatomy.access.find((ac) => ac.id === accessId) ?? anatomy.access[0];
  const rod = new CosseratRod(anatomy, accessId, DIRECT);
  rod.input = { deployed, steer: 0.3, torque: 0 };
  for (let i = 0; i < steps; i++) rod.step(1 / 60);
  return rod.tip().y - access.pos.y;
}

describe("Phase-0 calibrated validation rig — chirality / handedness", () => {
  it("CHIRALITY PARITY BASELINE: records the current x-mirror asymmetry (no hard gate yet)", () => {
    const normal = climb(buildNormalAnatomy(), "rcfa");
    const mirrored = climb(mirrorAnatomyX(buildNormalAnatomy()), "rcfa");
    const relDiff = Math.abs(mirrored - normal) / Math.max(0.1, Math.abs(normal));
    // eslint-disable-next-line no-console
    console.log(
      `[chirality x-mirror] climb(rcfa,normal)=${normal.toFixed(2)}cm  ` +
        `climb(rcfa,x-mirror)=${mirrored.toFixed(2)}cm  relDiff=${(relDiff * 100).toFixed(1)}%`
    );
    // Baseline only: both runs must stay finite and bounded (guards against a transport/NaN regression).
    // The handedness GATE below asserts relDiff is small once the solver is reflection-symmetric.
    expect(Number.isFinite(normal) && Number.isFinite(mirrored)).toBe(true);
    expect(Math.abs(normal)).toBeLessThan(100);
    expect(Math.abs(mirrored)).toBeLessThan(100);
  }, 30000);

  // GATE — STILL DEFERRED (the pre-existing [[irsim-solver-chirality-bug]], not introduced here). The
  // dynamic co-rotational beam IMPROVED x-mirror asymmetry (legacy ~63% → direct ~27-52%) and its
  // logmap curvature is provably mirror-clean (so3.test). A lockstep diagnostic showed the residual
  // divergence is GROSS and EARLY (≈9cm at step 20, mid-iliac, before any bifurcation), so the cause
  // is in SHARED steer/contact/lumen code (world-fixed steer-deflection axis and/or lumen graph
  // tie-break), NOT the new solver. Fixing it is a dedicated effort the owner deferred; un-skip when
  // that handedness source is found. Kept here as the regression guard.
  it.skip("CHIRALITY PARITY: x-mirror of the whole system gives identical cranial climb", () => {
    const normal = climb(buildNormalAnatomy(), "rcfa");
    const mirrored = climb(mirrorAnatomyX(buildNormalAnatomy()), "rcfa");
    const relDiff = Math.abs(mirrored - normal) / Math.max(0.1, Math.abs(normal));
    expect(relDiff).toBeLessThan(0.15);
  });
});

// ---------------------------------------------------------------------------
// Substep-invariance — the headline gate for "too flexible". The legacy XPBD path entangles
// stiffness with α̃ = α/Δt_s² and the requested substep count. The direct beam uses a fixed internal
// substep schedule and a real M/Δt² term in the same matrix as EI, so changing the legacy `substeps`
// field must not change navigated climb.
// ---------------------------------------------------------------------------

function navClimbSubsteps(substeps: number, deployed = 28, steps = 120): number {
  const anatomy = buildNormalAnatomy();
  const access = anatomy.access[0].pos.clone();
  const rod = new CosseratRod(anatomy, "rcfa", { ...DIRECT, substeps });
  rod.input = { deployed, steer: 0.3, torque: 0 };
  for (let i = 0; i < steps; i++) rod.step(1 / 60);
  return rod.tip().y - access.y;
}

describe("Phase-0 calibrated validation rig — substep-invariance", () => {
  it("SUBSTEP-INVARIANCE BASELINE: records direct response across legacy substep settings", () => {
    const s2 = navClimbSubsteps(2);
    const s4 = navClimbSubsteps(4);
    const s8 = navClimbSubsteps(8);
    const drift = Math.abs(s4 - s2) / Math.max(0.1, Math.abs(s2));
    // eslint-disable-next-line no-console
    console.log(
      `[substep-invariance] climb(S=2)=${s2.toFixed(2)}cm  climb(S=4)=${s4.toFixed(2)}cm  ` +
        `climb(S=8)=${s8.toFixed(2)}cm  drift(S2→S4)=${(drift * 100).toFixed(1)}%`
    );
    expect(Number.isFinite(s2) && Number.isFinite(s4) && Number.isFinite(s8)).toBe(true);
  }, 60000);

  // GATE (GREEN) — the dynamic co-rotational beam ignores the legacy `substeps` knob (fixed internal
  // substeps), so felt stiffness is substep-invariant by construction.
  it("SUBSTEP-INVARIANCE: navigated climb does not depend on the substep count", () => {
    const s2 = navClimbSubsteps(2);
    const s4 = navClimbSubsteps(4);
    const s8 = navClimbSubsteps(8);
    const relDiff = Math.abs(s4 - s2) / Math.max(0.1, Math.abs(s2));
    const relDiff8 = Math.abs(s8 - s2) / Math.max(0.1, Math.abs(s2));
    expect(relDiff).toBeLessThan(0.15);
    expect(relDiff8).toBeLessThan(0.15);
  }, 90000);
});

// ---------------------------------------------------------------------------
// Pushability — the climb-MAGNITUDE gate on real anatomy (added at Phase-G review). The
// substep-invariance gate above is RELATIVE only (0 vs 0 vs 0 would pass), so without this gate
// the suite had no assertion that feeding actually advances the tip up the anatomy.
//
// The gate runs the SHIPPED COAX configuration (guidewire inside the sheath) because that is the
// app's only runtime configuration AND because it is what makes deep feed physical: a BARE direct
// wire fed solo from the access has no proximal support, so the compliant feed (force-capped 5 N)
// buckles/snakes it near the inlet and the tip never advances past its seeded position (measured:
// solo climb ≈ 6.8–7.2 cm for ANY commanded deploy 10–36 cm vs a 7.8 cm seed baseline — feeding can
// even lose a little tip height to injected slack). That is expected rod-in-wide-lumen mechanics
// (Euler half-wave at 5 N ≈ 5 cm > placeholder lumen diameter), and exactly why real procedures
// always feed the wire through an introducer/sheath. The legacy validation.test.ts PUSHABILITY
// number (solo climb@36 ≈ 22 cm) was an artifact of the deleted beamGain fairing crutch.
//
// Feed is rate-limited (D_FEED_RATE = 4 cm/s), so +28 cm of commanded deploy needs ≥ 7 s of sim
// time before settling: the deep run uses 900 steps (15 s) — measured plateau (43.49 at 900 vs
// 43.42 at 1200 steps, deterministic across repeats).
// ---------------------------------------------------------------------------

/** Cranial tip climb (cm) of the shipped coax wire after commanding `deployed` cm. */
function coaxNavClimb(deployed: number, steps: number): number {
  const anatomy = buildNormalAnatomy();
  const access = anatomy.access[0].pos.clone();
  const outer = new CosseratRod(anatomy, "rcfa", SHIPPED_SHEATH, { deployed: 6.5, steer: 0, torque: 0 });
  const inner = new CosseratRod(anatomy, "rcfa", SHIPPED_GUIDEWIRE, { deployed: 8, steer: 0.35, torque: 0 });
  const asm = new CoaxialAssembly(outer, inner);
  asm.setOuterInput(6.5, 0, 0);
  asm.setInnerInput(deployed, 0.3, 0);
  for (let i = 0; i < steps; i++) asm.step(1 / 60);
  return inner.tip().y - access.y;
}

describe("Phase-0 calibrated validation rig — pushability (climb magnitude, shipped coax)", () => {
  // GATE (GREEN) — measured on this rig: seed (no feed) ≈ 7.79 cm, shallow climb@12cm ≈ 9.29 cm,
  // deep climb@36cm ≈ 43.4–43.5 cm (tip high in the aorta, y ≈ 32). Thresholds sit with comfortable
  // headroom below the deterministic measured values:
  //   shallow > 8.5  — feeding ADVANCES the tip beyond the 7.8 cm seeded state (a stalled or
  //                    accordioning wire reads ≈ seed or below; solo-wire stall reads ≈ 6.8);
  //   deep > 30      — absolute magnitude, so "wire stalls everywhere" (≈ 7.8) or "stalls at the
  //                    aortic bifurcation" (≈ 11.3, the unconverged/junction signature) cannot pass;
  //   deep > shallow + 8 — the legacy gate's margin shape (measured surplus ≈ 34 cm).
  // 120 s timeout: ~1500 wall-clock-heavy coax steps (~15–25 s solo) — generous so parallel-suite
  // CPU contention cannot re-create the PUSHABILITY test-timeout flake documented in Phase G.
  it("PUSHABILITY: feeding the shipped coax wire advances the tip cranially up the real anatomy", () => {
    const shallow = coaxNavClimb(12, 600);
    const deep = coaxNavClimb(36, 900);
    // eslint-disable-next-line no-console
    console.log(`[pushability direct/coax] climb@12cm=${shallow.toFixed(2)}cm  climb@36cm=${deep.toFixed(2)}cm`);
    expect(shallow).toBeGreaterThan(8.5);
    expect(deep).toBeGreaterThan(30);
    expect(deep).toBeGreaterThan(shallow + 8);
  }, 120000);
});

// =============================================================================================
// PHASE-A LIVE-ROD ANALYTIC BATTERY — realised EI/GJ measured on the actual CosseratRod, not just
// the isolated FEM kernel (buckling.test.ts). The kernel cantilever/Euler gates already pass, yet the
// shipped XPBD rod realises only ~15–27% of nominal EI — so kernel-only validation is the trap. These
// gates drive the LIVE rod's elastic core through the real MaterialField→rigidity adapter
// (integration.ts) and the implicit solver, each anchored to a closed-form benchmark. They are GREEN
// on the direct lane (real EI by construction); the legacy lane is a baseline RECORDER documenting the
// gap. Ships nothing — pure measurement scaffolding for the FEM-promotion phases that follow.
// =============================================================================================

/** A straight, wide vessel tube along +y. Radius is large so no wall contact perturbs the bench. */
function wideTube(lenCm: number, radius = 5): Anatomy {
  const points = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    points.push({ pos: new Vector3(0, -2 + (i * lenCm) / n, 0), radius, s: (i * lenCm) / n });
  }
  return {
    id: "wt",
    name: "wide-tube",
    branches: [{ id: "wt", name: "wt", attenuation: 1, points }],
    access: [{ id: "a", name: "a", pos: new Vector3(0, -2, 0), dir: new Vector3(0, 1, 0), branchId: "wt" }],
    targets: [],
    provenance: { source: "test", license: "test", note: "test" }
  };
}

/** UNIFORM-EI variants (no graded floppy tip / transition / precurve) so a single EI/GJ applies. */
const UNIFORM_DIRECT: CosseratParams = {
  ...GUIDEWIRE_DIRECT,
  tipNodes: 0,
  transitionNodes: 0,
  tipCurve: 0
};
/** wireShaft REGION constants the uniform rod assembles (material.ts): EI = 12, GJ = 9.2 N·cm². */
const SHAFT_EI = 12;
const SHAFT_GJ = 9.2;

/** Build a straight uniform-EI rod of ~`Lcm` clamped at node 0, free at the tip, in free space. */
function uniformRod(params: CosseratParams, Lcm: number): CosseratRod {
  return new CosseratRod(wideTube(Lcm + 6), "a", params, { deployed: Lcm, steer: 0, torque: 0 });
}

/** Effective EI/GJ after a uniform bend/twist compliance scale (α ∝ 1/EI ⇒ EI ÷ scale). */
function eiFor(scale: number): number {
  return SHAFT_EI / scale;
}

describe("Phase-A live-rod analytic battery — realised EI (cantilever δ = F·L³/3EI)", () => {
  // GATE (direct): a uniform-EI beam, clamped-free, tip transverse point load F. The implicit
  // co-rotational solve must realise δ = F·L³/(3EI) — the realised-EI proof on the LIVE rod's adapter
  // (integration.ts compliance→rigidity) + solver. F is chosen so δ/L ≈ 1–2% (co-rotational ≈ linear
  // Euler-Bernoulli there). bendComplianceScale sweeps the realised EI across stiffer/softer wires.
  for (const scale of [1, 0.5, 2]) {
    const EI = eiFor(scale);
    it(`DIRECT: realised δ matches F·L³/3EI within 5% (EI=${EI} N·cm²)`, () => {
      const rod = uniformRod({ ...UNIFORM_DIRECT, bendComplianceScale: scale }, 5);
      const L = (rod.n - 1) * rod.h;
      const F = 0.02 * (EI / SHAFT_EI); // keep δ/L roughly constant (small deflection) across EI
      const p0 = rod.tip().clone();
      rod.setExternalForce(rod.n - 1, new Vector3(F, 0, 0));
      rod.relaxDirectStatic();
      const delta = rod.tip().x - p0.x;
      const analytic = (F * L * L * L) / (3 * EI);
      const realisedEI = (F * L * L * L) / (3 * delta);
      const rel = Math.abs(delta - analytic) / analytic;
      // eslint-disable-next-line no-console
      console.log(
        `[cantilever] EI=${EI} L=${L}cm δ=${delta.toFixed(4)} analytic=${analytic.toFixed(4)} ` +
          `realisedEI=${realisedEI.toFixed(1)} (${((realisedEI / EI) * 100).toFixed(0)}%) rel=${(rel * 100).toFixed(1)}%`
      );
      expect(rel).toBeLessThan(0.05);
    });
  }

  // δ ∝ L³ : the cantilever law's length scaling, a second independent check the realised stiffness is
  // a real EI (not a contact/length artefact). Doubling L must cube the tip deflection (±8%).
  it("DIRECT: tip deflection scales as L³", () => {
    const measure = (Lcm: number): number => {
      const rod = uniformRod(UNIFORM_DIRECT, Lcm);
      const L = (rod.n - 1) * rod.h;
      const F = 0.004; // small enough that δ/L stays ≈1% even at the longer span
      const p0 = rod.tip().clone();
      rod.setExternalForce(rod.n - 1, new Vector3(F, 0, 0));
      rod.relaxDirectStatic();
      return Math.abs(rod.tip().x - p0.x) / (L * L * L);
    };
    const k5 = measure(5);
    const k10 = measure(10);
    // δ/L³ is a constant (= F/3EI) independent of L
    expect(Math.abs(k10 - k5) / k5).toBeLessThan(0.08);
  });

  // NOTE on the legacy lane: a force-cantilever is only physically meaningful on the force-equilibrium
  // (direct) solver. The legacy XPBD lane is position-based with no static force balance, so its
  // realised-EI gap manifests in CHAIN navigation / convergence (Deul 2018), documented by the
  // SUBSTEP-INVARIANCE baseline above and the §1.1 review — not by a single-node force here.
});

describe("Phase-A live-rod analytic battery — torsion θ = T·L/GJ (direct)", () => {
  // GATE (direct): a uniform straight beam, clamped-free, with a tip axial MOMENT T about the rod
  // axis (+y). Pure torsion ⇒ uniform twist θ = T·L/GJ, measured as the roll of the tip nodal frame
  // relative to the clamped base. Linear in T and ∝ 1/GJ.
  function measureTwist(T: number, scale = 1): { twist: number; L: number; GJ: number } {
    const rod = uniformRod({ ...UNIFORM_DIRECT, bendComplianceScale: scale }, 6);
    const L = (rod.n - 1) * rod.h;
    rod.setExternalMoment(rod.n - 1, new Vector3(0, T, 0)); // axis +y = rod axis
    rod.relaxDirectStatic();
    const qBase = rod.directNodeFrame(0);
    const qTip = rod.directNodeFrame(rod.n - 1);
    const qrel = qTip.clone().multiply(qBase.conjugate());
    const twist = 2 * Math.acos(Math.min(1, Math.abs(qrel.w)));
    return { twist, L, GJ: SHAFT_GJ / scale };
  }

  it("realised twist matches T·L/GJ within 10%", () => {
    const T = 0.3;
    const { twist, L, GJ } = measureTwist(T);
    const analytic = (T * L) / GJ;
    const rel = Math.abs(twist - analytic) / analytic;
    // eslint-disable-next-line no-console
    console.log(`[torsion] T=${T} L=${L} GJ=${GJ} θ=${twist.toFixed(4)} analytic=${analytic.toFixed(4)} rel=${(rel * 100).toFixed(1)}%`);
    expect(rel).toBeLessThan(0.1);
  });

  it("twist is linear in applied torque (θ(2T) ≈ 2·θ(T))", () => {
    const t1 = measureTwist(0.2).twist;
    const t2 = measureTwist(0.4).twist;
    expect(t2 / t1).toBeCloseTo(2, 1);
  });
});

describe("Phase-A live-rod analytic battery — pure bending into a circle R = EI/M (direct)", () => {
  // GATE (direct, FINITE rotation): a uniform beam under a constant tip MOMENT M about a transverse
  // axis (+z) takes constant curvature κ = M/EI ⇒ a circular arc of radius R = EI/M and total turn
  // Φ = κ·L = M·L/EI. This is the co-rotational finite-rotation correctness check (distinct from the
  // small-deflection cantilever). Measured from the centerline tangents, so it is frame-convention-free.
  it("realised curvature matches κ = M/EI = 1/R (finite rotation) and the arc stays planar", () => {
    const M = 1.2;
    const rod = uniformRod(UNIFORM_DIRECT, 5);
    const L = (rod.n - 1) * rod.h;
    rod.setExternalMoment(rod.n - 1, new Vector3(0, 0, M)); // bend about +z, in the x-y plane
    rod.relaxDirectStatic();
    const baseT = rod.x[1].clone().sub(rod.x[0]).normalize();
    const tipT = rod.x[rod.n - 1].clone().sub(rod.x[rod.n - 2]).normalize();
    // segment tangents are centered at element midpoints, so the turn spans (L − h), not L.
    const span = L - rod.h;
    const kappa = baseT.angleTo(tipT) / span; // realised constant curvature
    const kappaAnalytic = M / SHAFT_EI; // = 1/R
    const rel = Math.abs(kappa - kappaAnalytic) / kappaAnalytic;
    // arc planarity: no out-of-plane (z) excursion
    let maxZ = 0;
    for (const p of rod.x) maxZ = Math.max(maxZ, Math.abs(p.z));
    // eslint-disable-next-line no-console
    console.log(
      `[pure-bend] M=${M} κ=${kappa.toFixed(4)} analytic=${kappaAnalytic.toFixed(4)} R=${(1 / kappa).toFixed(2)} ` +
        `R_analytic=${(SHAFT_EI / M).toFixed(2)} rel=${(rel * 100).toFixed(1)}% maxZ=${maxZ.toFixed(4)}`
    );
    expect(rel).toBeLessThan(0.05);
    expect(maxZ).toBeLessThan(0.02);
  });
});

describe("Phase-A live-rod analytic battery — Bishop twist-leak (direct)", () => {
  // GATE (direct): bending a straight rod with ZERO applied torque must not generate material twist
  // (the curvature logmap is twist-clean). Bend in the x-y plane with a tip transverse force, then
  // measure the roll of the tip frame's director-1 about the tangent vs its parallel-transported base
  // value: an isotropic rod keeps this ~0 (no bend→twist leak).
  it("planar bending leaks ~no twist about the tangent", () => {
    const rod = uniformRod(UNIFORM_DIRECT, 6);
    rod.setExternalForce(rod.n - 1, new Vector3(0.03, 0, 0)); // clear in-plane (x-y) bend, no torque
    rod.relaxDirectStatic();

    const qBase = rod.directNodeFrame(0);
    const qTip = rod.directNodeFrame(rod.n - 1);
    const ex = new Vector3(1, 0, 0);
    const t0 = rod.x[1].clone().sub(rod.x[0]).normalize();
    const t1 = rod.x[rod.n - 1].clone().sub(rod.x[rod.n - 2]).normalize();
    const e1Base = ex.clone().applyQuaternion(qBase);
    const e1Tip = ex.clone().applyQuaternion(qTip);
    // parallel-transport the base director-1 along the tangent change t0→t1
    const transport = new Quaternion().setFromUnitVectors(t0, t1);
    const e1Transported = e1Base.clone().applyQuaternion(transport);
    // signed roll about t1 between the transported and actual tip director-1
    const cross = e1Transported.clone().cross(e1Tip);
    const twistLeak = Math.atan2(cross.dot(t1), e1Transported.dot(e1Tip));
    // eslint-disable-next-line no-console
    console.log(`[bishop] twist-leak=${twistLeak.toFixed(5)} rad`);
    expect(Math.abs(twistLeak)).toBeLessThan(0.05);
  });
});

describe("Phase-A live-rod analytic battery — capstan & blocked-tip scaffolds", () => {
  // CAPSTAN (loose / monotonic, NOT a tight e^{μθ}): pushing through a total wrap angle θ should
  // amplify the proximal/tip tension ratio with θ AND with μ. PHASE E investigated this with the
  // Phase-D compliant feed motor: advance the direct wire a fixed distance through a circular-arc
  // tube of known wrap θ (forceMax=∞ so it never stalls) and read the steady operator push as
  // F ≈ λ_feed/Δt². RESULT — KEPT it.todo, not authored as a gate, because the μ half is unmeasurable
  // on this readout:
  //   • Feed force DOES rise cleanly with wrap θ (≈230N@0.2rad → 500N@2.4rad), BUT
  //   • it rises essentially IDENTICALLY at near-zero friction (muScale 0.02: 236→466→510N) as at
  //     5× friction (285→471→518N) — i.e. the wrap-θ rise is COLUMN-COMPRESSION (the elastic cost of
  //     bending a stiff EI wire around a tighter arc), not the capstan friction amplification.
  //   • The genuine capstan signal (the μ-dependence at fixed θ) is buried: 250× μ change moves the
  //     feed force ~1% (465.88N → 470.98N at θ=1.6rad). This is exactly the "scaled feed-force readout
  //     is dominated by column compression, not a clean tip-block signal" noted at cosserat.ts
  //     D_FEED_FORCE_SCALE.
  // A gate on the clean θ-rise alone would assert column stiffness while MISLABELLING it "capstan",
  // re-creating test-debt. A faithful capstan gate needs a clean proximal/distal TENSION RATIO probe
  // (a measured distal back-load to divide out column compression), not the raw operator push — that
  // instrumentation is future work. Per the plan, do NOT author a flaky/mislabelled gate.
  it.todo("capstan: proximal/tip tension rises monotonically with wrap angle θ and μ (needs a tension-ratio probe; raw feed force is column-compression-dominated — see comment)");

  // BLOCKED-TIP STALL/PROLAPSE (Phase D — ACTIVATED): a blocked tip must STALL the feed and prolapse
  // (the proximal column bows/slacks inside the vessel) rather than tunnelling through the wall. Uses
  // the force-capped compliant feed motor on the DIRECT lane (the hard-anchor lane has no back-pressure
  // to read — see capstan note above). The motor's forceMax is PHYSICAL Newtons (Phase D forceScale
  // calibration): a LOW cap (~0.5 N, below the ~deliverable-tip 1.1–1.6 N free-advance force) clamps
  // the feed so a jammed tip stalls. Robust assertion per the plan: deployed advance is CAPPED (≪ the
  // commanded over-feed), the wire does NOT tunnel (≤0.05 cm wall penetration), and a measurable
  // prolapse (slack = arc-length − tip-to-access straight distance, beyond the seated bow) accumulates
  // in a measurable band. The band is asserted loosely [0.25, 5.0] cm to stay robust to the sharp
  // stall-onset sensitivity (post-Phase-G rest-length splice sweep: cap 0.55 N → advance ~4.2 cm
  // against a 34 cm over-feed / prolapse ~3.9 cm; lower caps fully stall, higher caps over-feed).
  it("blocked-tip stall: feed caps and the column prolapses, no tunneling", () => {
    const anatomy = buildNormalAnatomy();
    const rod = new CosseratRod(anatomy, "rcfa", { ...GUIDEWIRE_DIRECT, useCompliantFeedMotor: true });
    rod.insertion.forceMax = 0.55; // physical N: below the free-advance force ⇒ a blocked tip stalls
    const arcLen = (): number => {
      let s = 0;
      for (let i = 1; i < rod.n; i++) s += rod.x[i].distanceTo(rod.x[i - 1]);
      return s;
    };
    // seat the wire deep in the tortuous anatomy
    rod.input = { deployed: 16, steer: 0.3, torque: 0 };
    for (let i = 0; i < 360; i++) rod.step(1 / 60);
    const seatedDeployed = rod.deployedLength();
    const seatedBow = arcLen() - rod.tip().distanceTo(rod.access.x);
    // command a large over-feed against the jammed distal tortuosity (effectively a blocked tip)
    rod.input = { deployed: 50, steer: 0.3, torque: 0 };
    let maxBow = 0;
    for (let i = 0; i < 360; i++) {
      rod.step(1 / 60);
      maxBow = Math.max(maxBow, arcLen() - rod.tip().distanceTo(rod.access.x));
    }
    const deployedAdvance = rod.deployedLength() - seatedDeployed;
    const prolapse = maxBow - seatedBow;
    const pen = rod.maxWallPenetration();
    // eslint-disable-next-line no-console
    console.log(
      `[blocked-tip] seatedDeployed=${seatedDeployed.toFixed(2)} deployedAdvance=${deployedAdvance.toFixed(2)} ` +
        `prolapse=${prolapse.toFixed(2)}cm pen=${pen.toFixed(4)}cm (commanded over-feed=34cm)`
    );
    // STALL: the realized deployed advance is a small fraction of the 34 cm commanded over-feed
    expect(deployedAdvance).toBeLessThan(5);
    // NO TUNNELING: the blocked tip does not push through the wall
    expect(pen).toBeLessThanOrEqual(0.05);
    // PROLAPSE: the stalled column bows/slacks inside the vessel in the target band (loose, robust)
    expect(prolapse).toBeGreaterThan(0.25);
    expect(prolapse).toBeLessThan(5.0);
  }, 90000);
});
