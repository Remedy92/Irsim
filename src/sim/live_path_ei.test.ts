import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  CoaxialAssembly,
  CosseratRod,
  GUIDEWIRE_DIRECT,
  SHEATH_DIRECT,
  type CosseratParams
} from "./cosserat";
import type { Anatomy } from "./types";

/**
 * LIVE-PATH EI CROSS-CHECK — "settled-equals-static" on the shipped dynamic stepDirect path.
 *
 * THE GAP THIS FILE CLOSES. Every calibrated EI gate in validation_calibrated.test.ts routes through
 * CosseratRod.relaxDirectStatic(), which forces fixedPrefix=1 and calls the inertia-FREE staticSolve —
 * so the trusted battery proves the elastic operator in STATICS only. It DROPS the m/Δt² term. The
 * LIVE runtime path is stepDirect (solo) / stepDirectCoax (assembly), where the uniform translational
 * mass-conditioning scale D_MASS_SCALE_TRANS = 8e5 (tuned for twist + navigation friction, NOT bending)
 * sits ~12× above the transverse bend stiffness 12EI/ℓ³, overdamping every bending mode to near-stasis.
 * dynamic_recovery.test.ts already measures the SOLO live path and is RED-by-design. This file adds the
 * missing cross-check that pins the LIVE path to the STATIC battery the same way the static gates are
 * pinned to closed-form EI — on BOTH the solo rod AND the shipped coax assembly (NEW coverage; the
 * existing red gate is solo-only).
 *
 * MEASURED (this rig, D_MASS_SCALE_TRANS = 8e5), authored as DOCUMENTED-RED (it.fails, repo precedent =
 * dynamic_recovery.test.ts), each with an always-pass stability companion so a NaN cannot hide:
 *   SOLO: static δ ≈ 0.83 cm vs live-settled δ ≈ 0.035 cm  ⇒  live/static ≈ 4.2% (tip crawls at
 *         ~0.0026 cm/s — the ~7-minute overdamped shape-recovery time; settled-ish yet ≪ static).
 *   COAX: static δ ≈ 1.42 cm vs live-coax-settled δ ≈ 0.0001 cm ⇒ live/static ≈ 0.01% (even more frozen
 *         inside the assembly; tip speed → 0).
 * Both DISAGREE wildly today, so they are it.fails. They FLIP GREEN at the Phase-J stiffness-flip
 * (D_MASS_SCALE_TRANS 8e5 → 8e2), where dynamic_recovery already measures ~115% of analytic δ expressed
 * dynamically ⇒ live/static ≈ 1.0. The 20% band below is comfortably failed now (4%, 0.01%) and
 * comfortably passed then (~100%); CI goes RED the day the live dynamics start expressing calibrated EI,
 * forcing this file (and dynamic_recovery) to be flipped to hard gates in the same change.
 */

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

/**
 * UNIFORM-EI direct rod (no graded floppy tip / transition / precurve) so the shaft EI=12 applies
 * end-to-end. The HARD inlet anchor (useCompliantFeedMotor:false) pins nodes 0 AND 1, so the live and
 * static benches share the SAME boundary condition and any δ gap is purely the inertia term, not the
 * inlet motor (matches dynamic_recovery.test.ts UNIFORM_DYNAMIC and validation_calibrated UNIFORM_DIRECT).
 */
const UNIFORM_DIRECT: CosseratParams = {
  ...GUIDEWIRE_DIRECT,
  tipNodes: 0,
  transitionNodes: 0,
  tipCurve: 0
};
const UNIFORM_DYNAMIC: CosseratParams = { ...UNIFORM_DIRECT, useCompliantFeedMotor: false };
/** UNIFORM-EI sheath (no tip grading) for the coax outer member. */
const UNIFORM_SHEATH: CosseratParams = { ...SHEATH_DIRECT, tipNodes: 0, transitionNodes: 0, tipCurve: 0 };

const SHAFT_EI = 12; // wireShaft REGION EI the uniform rod assembles (material.ts)
const F = 0.03; // tip transverse load (N): δ/L ≈ 7% on the static cantilever — near-linear regime

function allFinite(rod: CosseratRod): boolean {
  for (const p of rod.x) if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
  for (const q of rod.q) if (!Number.isFinite(q.x) || !Number.isFinite(q.w)) return false;
  return true;
}

/** The static reference deflection for the same setup: relaxDirectStatic (inertia-free, trusted). */
function staticTipDeflection(deployed: number): { dStatic: number; Leff: number; analytic: number } {
  const rod = new CosseratRod(wideTube(deployed + 6), "a", UNIFORM_DYNAMIC, { deployed, steer: 0, torque: 0 });
  const dt = 1 / 60;
  for (let i = 0; i < 30; i++) rod.step(dt); // settle the seeding transient at straight equilibrium
  const Leff = (rod.n - 2) * rod.h; // hard inlet anchors nodes 0 AND 1 ⇒ cantilever rooted at node 1
  const tipEq = rod.tip().clone();
  rod.setExternalForce(rod.n - 1, new Vector3(F, 0, 0));
  rod.relaxDirectStatic();
  const dStatic = rod.tip().x - tipEq.x;
  const analytic = (F * Leff * Leff * Leff) / (3 * SHAFT_EI);
  return { dStatic, Leff, analytic };
}

describe("live-path EI cross-check — SOLO settled stepDirect deflection equals relaxDirectStatic", () => {
  // DOCUMENTED RED (see file header). Drives the rod on the LIVE public step()/stepDirect path (NOT
  // relaxDirectStatic) under a constant tip force until the tip velocity settles, then asserts the
  // settled live deflection matches the trusted static deflection. Measured today: live/static ≈ 4.2%
  // (live δ ≈ 0.035 vs static δ ≈ 0.83) — the inertia term masks EI on the live path. Flips green at the
  // Phase-J stiffness-flip (D_MASS_SCALE_TRANS 8e5 → 8e2; dynamic_recovery measures ~115% expressed there
  // ⇒ live/static ≈ 1.0). The 20% band is comfortably failed now and comfortably passed then.
  it.fails("settled live tip deflection (stepDirect) reaches the static cantilever δ within 20%", () => {
    const deployed = 10;
    const { dStatic } = staticTipDeflection(deployed);

    const rod = new CosseratRod(wideTube(deployed + 6), "a", UNIFORM_DYNAMIC, { deployed, steer: 0, torque: 0 });
    const dt = 1 / 60;
    for (let i = 0; i < 30; i++) rod.step(dt);
    const tipEq = rod.tip().clone();
    const tipIdx = rod.n - 1;

    // LOAD on the LIVE dynamic path; settle until the tip velocity is small (≪ the early transient).
    rod.setExternalForce(tipIdx, new Vector3(F, 0, 0));
    let tipSpeed = 1;
    for (let i = 0; i < 600; i++) {
      const before = rod.tip().clone();
      rod.step(dt);
      tipSpeed = rod.tip().distanceTo(before) / dt;
      expect(allFinite(rod), `non-finite during live load at frame ${i}`).toBe(true);
    }
    const dLive = rod.tip().x - tipEq.x;
    // SETTLED: the tip has stopped advancing fast (the overdamped creep is glacial, ~0.003 cm/s today),
    // so dLive is a fair "settled" reading — the disagreement with static is the EI defect, not transient.
    expect(tipSpeed).toBeLessThan(0.05);
    // SETTLED-EQUALS-STATIC: the live operator must express the same EI the static battery proves.
    expect(Math.abs(dLive - dStatic) / Math.max(1e-6, Math.abs(dStatic))).toBeLessThan(0.2);
  }, 90000);

  // STABILITY COMPANION (always hard-pass). The it.fails above stays green for ANY failure mode —
  // including a NaN/Inf blowup. This catches that: after the same live load run, every node stays finite
  // and the tip displacement stays bounded by a generous multiple of the static deflection.
  it("SOLO stability: live load run stays finite and bounded (no NaN / divergence)", () => {
    const deployed = 10;
    const { dStatic } = staticTipDeflection(deployed);
    const bound = 50 * Math.max(0.01, Math.abs(dStatic));

    const rod = new CosseratRod(wideTube(deployed + 6), "a", UNIFORM_DYNAMIC, { deployed, steer: 0, torque: 0 });
    const dt = 1 / 60;
    for (let i = 0; i < 30; i++) rod.step(dt);
    const tipEq = rod.tip().clone();
    rod.setExternalForce(rod.n - 1, new Vector3(F, 0, 0));
    for (let i = 0; i < 600; i++) {
      rod.step(dt);
      expect(allFinite(rod), `non-finite during live load at frame ${i}`).toBe(true);
      expect(rod.tip().distanceTo(tipEq), `tip diverged at frame ${i}`).toBeLessThan(bound);
    }
    expect(allFinite(rod)).toBe(true);
  }, 90000);
});

describe("live-path EI cross-check — COAX settled stepDirectCoax deflection equals relaxDirectStatic", () => {
  // NEW COVERAGE (dynamic_recovery is solo-only). Same settled-equals-static check, but the inner wire
  // is loaded INSIDE the shipped CoaxialAssembly driven on the live stepDirectCoax path, on a WIDE
  // straight tube (radius 5) so the sheath channel never contacts the inner-wire bend — the gap is pure
  // bending inertia, not coax containment. This anchors the live COAX path to calibrated EI. Measured
  // today: live-coax/static ≈ 0.01% (δ ≈ 0.0001 vs static δ ≈ 1.42) — even more frozen than solo. Flips
  // green at the Phase-J stiffness-flip with the solo gate.
  it.fails("settled live inner-wire deflection (stepDirectCoax) reaches the static cantilever δ within 20%", () => {
    const deployed = 12;
    const { dStatic } = staticTipDeflection(deployed);

    const outer = new CosseratRod(wideTube(deployed + 8, 5), "a", UNIFORM_SHEATH, { deployed, steer: 0, torque: 0 });
    const inner = new CosseratRod(wideTube(deployed + 8, 5), "a", UNIFORM_DIRECT, { deployed, steer: 0, torque: 0 });
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(deployed, 0, 0);
    asm.setInnerInput(deployed, 0, 0);
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) asm.step(dt); // settle the assembly at straight equilibrium
    const tipEq = inner.tip().clone();
    const tipIdx = inner.n - 1;

    // LOAD the inner wire on the LIVE coax path; settle until its tip velocity is small.
    inner.setExternalForce(tipIdx, new Vector3(F, 0, 0));
    let tipSpeed = 1;
    for (let i = 0; i < 600; i++) {
      const before = inner.tip().clone();
      asm.step(dt);
      tipSpeed = inner.tip().distanceTo(before) / dt;
      expect(allFinite(inner) && allFinite(outer), `non-finite during live coax load at frame ${i}`).toBe(true);
    }
    const dLive = inner.tip().x - tipEq.x;
    expect(tipSpeed).toBeLessThan(0.05);
    // settled-equals-static on the LIVE COAX path
    expect(Math.abs(dLive - dStatic) / Math.max(1e-6, Math.abs(dStatic))).toBeLessThan(0.2);
  }, 120000);

  // STABILITY COMPANION (always hard-pass) for the coax path: finite + bounded + contained.
  it("COAX stability: live inner-wire load run stays finite, bounded, and contained (no NaN / divergence)", () => {
    const deployed = 12;
    const { dStatic } = staticTipDeflection(deployed);
    const bound = 50 * Math.max(0.01, Math.abs(dStatic));

    const outer = new CosseratRod(wideTube(deployed + 8, 5), "a", UNIFORM_SHEATH, { deployed, steer: 0, torque: 0 });
    const inner = new CosseratRod(wideTube(deployed + 8, 5), "a", UNIFORM_DIRECT, { deployed, steer: 0, torque: 0 });
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(deployed, 0, 0);
    asm.setInnerInput(deployed, 0, 0);
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) asm.step(dt);
    const tipEq = inner.tip().clone();
    inner.setExternalForce(inner.n - 1, new Vector3(F, 0, 0));
    for (let i = 0; i < 600; i++) {
      asm.step(dt);
      expect(allFinite(inner) && allFinite(outer), `non-finite during live coax load at frame ${i}`).toBe(true);
      expect(inner.tip().distanceTo(tipEq), `inner tip diverged at frame ${i}`).toBeLessThan(bound);
    }
    expect(allFinite(inner) && allFinite(outer)).toBe(true);
    // the inner wire never penetrates the (wide) vessel wall during the load run
    expect(inner.maxWallPenetration()).toBeLessThanOrEqual(0.05);
  }, 120000);
});
