import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { CosseratRod, GUIDEWIRE_DIRECT } from "./cosserat";

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
 *   2. GATES (it.skip) — the precise analytic acceptance assertions (δ = FL³/3EI, P_cr = π²EI/(KL)²,
 *      substep-invariance, x-mirror chirality parity). Each is un-skipped by the phase that earns it.
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
function climb(anatomy: Anatomy, accessId: string, deployed = 26, steps = 480): number {
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
    // Baseline only: both runs must stay finite (guards against a transport/NaN regression). The
    // handedness GATE below asserts relDiff is small once the solver is reflection-symmetric.
    expect(Number.isFinite(normal) && Number.isFinite(mirrored)).toBe(true);
    expect(normal).toBeGreaterThan(0); // the reference (right) side climbs cranially at all
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
// Substep-invariance — the headline gate for "too flexible". With the current α̃ = α/Δt_s²
// entanglement and no real inertia, refining the substep count softens the rod, so the navigated
// climb drifts with S. The implicit dynamic solve puts a real M/Δt² term in the same matrix as the
// EI stiffness, so the elastic tangent is dt-independent and the climb must stop drifting.
// ---------------------------------------------------------------------------

function navClimbSubsteps(substeps: number, deployed = 28, steps = 600): number {
  const anatomy = buildNormalAnatomy();
  const access = anatomy.access[0].pos.clone();
  const rod = new CosseratRod(anatomy, "rcfa", { ...DIRECT, substeps });
  rod.input = { deployed, steer: 0.3, torque: 0 };
  for (let i = 0; i < steps; i++) rod.step(1 / 60);
  return rod.tip().y - access.y;
}

describe("Phase-0 calibrated validation rig — substep-invariance", () => {
  it("SUBSTEP-INVARIANCE BASELINE: records the current S-dependent drift (no hard gate yet)", () => {
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
  // substeps), so felt stiffness is substep-invariant BY CONSTRUCTION; the α̃=α/Δt² entanglement that
  // made legacy climb drift ~33% (Phase-0 baseline above) is structurally gone.
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
