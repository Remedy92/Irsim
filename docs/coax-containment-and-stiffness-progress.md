# Coax containment + wire stiffness: audit findings and implementation progress

**Date:** 2026-06-12. **Status:** items 1–3 of 4 landed (uncommitted in the working tree); item 4
(bilateral coax coupling) specified but **not started** — execution stopped by user before launch.

This document records (a) the verified root-cause audit behind the work, (b) exactly what was
implemented and how it was verified, (c) the honest residuals now encoded as documented-red gates,
and (d) the full spec for the remaining item so it can be picked up cold.

---

## 1. The audit (all findings adversarially verified; several reproduced empirically)

User-reported symptoms: (1) the guidewire does not appear to sit inside the sheath and exit its
tip; (2) the wire curls far too easily / does not feel stiff.

### Symptom 1 — wire/sheath separation

| # | Root cause | Status |
|---|---|---|
| 1 | **No outer-follows-inner coupling.** Every coax constraint moves the wire toward the sheath (`COAX_DIRECT_OUTER_MASS_SCALE = 0.01`; centering outer share 0 on the direct lane; the rigid channel projection moves only the inner). An advancing sheath navigates the vessel independently, including branch selection. Reproduced: wire→24 then sheath→18 gives **42 cm tip separation**, wire tip 28.5 cm *behind* the sheath tip, while `maxCoveredInnerRho` read 0.040 ("contained"). | **Open — item 4 (not started)** |
| 2 | **Containment blind to geometric escape.** Coverage was material-arc bookkeeping; the distance metric stripped the axial component (perpendicular offset to the paired segment's *infinite line*); covered nodes had vessel contact disabled; `maxWallPenetration` skipped covered nodes. Reproduced: sheath 6.5→20 over held wire 8 → true distance 14.7 cm, wire dragged through walls, all diagnostics green, test gate green. | **Fixed — item 3 (landed)** |
| 3 | **No tip-ring/funnel at the sheath exit** (0.4 cm material-arc blend, soft-only containment, 0.218 cm covered drift in the benign case). | Mitigated visually (item 2 covered-wire clamp); physics-side still open (subsumed by item 4's rail constraint). |
| — | Solver ordering/frequency explicitly **ruled out** (coax solved after wall contact, every Newton round of every substep, post-finalize re-seat). | n/a |
| 4 | **Rendering made containment illegible**: wire drawn at 0.08 cm (physics 0.05) vs sheath 0.15 with 6 radial segments → ~100 µm worst-case visual margin; independent Catmull-Rom curves diverge ~0.010 cm between nodes; translucent solid grey sheath (no mouth, doesn't hide wire); fluoro sigmas density-inverted (sheath τ=1.35 darker than wire τ=1.12). | **Fixed — item 2 (landed)** |

### Symptom 2 — floppiness

**Not a material-constant bug.** Shaft EI = 12 N·cm² (1.2e-3 N·m²) round-trips exactly through
`units.ts` ↔ `beamfem/integration.ts` (verified by the calibrated cantilever gates) and is in fact
*stiffer* than a real 0.035″ workhorse wire. The cause is dynamic: `D_MASS_SCALE = 8.0e5` (tuned
only for twist conditioning Jt/Δt² ≈ GJ/ℓ) inflated translational mass uniformly → bending modes
~894× slower, overdamped under a0 = 1/dampingTau = 12.5 s⁻¹ → shape-recovery τ ≈ minutes. Static
EI gates pass because `relaxDirectStatic` drops inertia/damping; the live `stepDirect` path never
expressed the calibrated EI. → **Item 1 (landed, with a major scope discovery — see §2.1).**

### Literature calibration targets (cross-verified, for future preset work)

- Workhorse 0.035″ shaft EI ≈ **3e-4 N·m²** (Harrison 2011, J Endovasc Ther — plain Amplatz
  9.5 GPa effective modulus; ladder 2.9e-4 → 4.9e-3 N·m² Lunderquist). Current preset 1.2e-3 is
  stiff-support-wire territory.
- Floppy tip EI ≈ **5e-7 N·m²** over 3–5 cm soft + 15–25 cm graded transition (Schröder 1993 d⁴
  core-taper law; Qiu 2023 transition measurements). Current: 1e-5 over 1.5 cm + 3 cm.
- 5–6F sheath EI ≈ **1e-3 N·m²** (current 1.7e-3 acceptable).
- GJ ≈ 0.77·EI (derived; no measured SI source). Friction CoF: hydrophilic wet 0.03, PTFE 0.10,
  bare 0.2–0.3 (Schröder Part III ratios). Linear mass ~4 g/m (derived, low confidence).

---

## 2. What was implemented (all uncommitted in the working tree)

Execution model: orchestrated multi-agent loop (`/team-implement`); each physics item was
implemented by a model-tiered agent and independently adversarially reviewed; the orchestrator
re-ran gates itself. Verification baseline per CLAUDE.md: `npm run typecheck && npm test && npm run build`.

### 2.1 Item 1 — anisotropic mass-conditioning split (fable; fable review: ACCEPT)

**Files:** `src/sim/beamfem/mass.ts`, `src/sim/beamfem/integration.ts`, `src/sim/cosserat.ts`,
`src/sim/types.ts`, `src/sim/beamfem/dynamic.test.ts`, `src/sim/beamfem/integration_live.test.ts`,
**new** `src/sim/dynamic_recovery.test.ts`, `docs/physics-design-dynamic-corotational-beam.md`
(param table updated).

- `D_MASS_SCALE` (8.0e5 uniform on m, Jb, Jt) split into `D_MASS_SCALE_TRANS` (m + Jb) and
  `D_MASS_SCALE_TWIST` (Jt). **Both ship at 8.0e5 — bit-for-bit behaviorally identical to before**
  (reviewer-verified, same float association).
- The bending-true value `TRANS = 8.0e2` is fully derived and bench-validated: 115 % of analytic
  cantilever deflection expressed dynamically (vs **1 %** at 8e5), 93.9 % spring-back in 1 s,
  t₉₀ = 0.85 s, zero overshoot.
- **Headline discovery: the flip is currently unshippable.** Shipped navigation is load-bearing on
  the artificial translational inertia: the calibrated pushability climb gate (≥8.5 at deploy 12)
  collapses 9.30 → 0.45 cm at 8e2 (sweep: 8e5→9.30 ✓, 1e5→0.09, 2e4→0.04, 5e3→0.59 — a regime
  cliff in (1e5, 8e5], not a tuning pocket). The sweep methodology was independently verified
  clean (the contact mass metric is mean-normalized and scale-invariant; endpoints re-measured by
  the reviewer). The wire's transport mechanism is inertia-powered; wall stick-slip cannot hold a
  springy wire. **Sub-second bending feel therefore requires contact/friction (Schur-complement
  coupling) work first.** The audit's suggested 5e3–1e4 band is *frequency-bounded* — provably
  unable to reach ≤1 s recovery even with optimal damping (t₉₀ ≥ 1.8 s at 5e3) — so no damping
  retune was shipped either.
- Bring-up protections (node-0 motion limit, introducer backstop on the compliant-feed inlet) are
  in place, armed only when `directBendingTrueMass()` (TRANS < TWIST) — dormant at shipped values.
- **`src/sim/dynamic_recovery.test.ts`**: live-dynamics gate on the real `stepDirect` path, shipped
  as documented-red `it.fails` (2 cases) + a plain stability companion (finiteness, bounded
  displacement) so a NaN blowup cannot hide behind `it.fails`. CI flips red the day live dynamics
  start expressing calibrated EI → forces an honest promotion.
- **The flip is a one-line change** (`D_MASS_SCALE_TRANS = 8.0e2`) once contact work lands; the
  dampingTau→a0 mapping must be retuned together with it.

### 2.2 Item 2 — rendering legibility (sonnet; orchestrator diff review: ACCEPT)

**File:** `src/three/Viewport.tsx`.

1. Wire render radius 0.08 → `inner.rodRadius` (0.05); containment invariant comment
   (`wireR + 0.04 < sheathR·cos(π/12)`: 0.09 < 0.145).
2. `rebuildTube`: radialSegments 6 → 12; tubularSegments → 3× node count. Dispose-before-replace
   preserved.
3. Sheath 3D material opaque dark blue-grey (0x3d5a73) — contained wire is hidden; only the
   protruding wire shows.
4. Sheath tip-mouth ring (dark torus at the tip node, oriented along tip tangent, rebuilt/disposed
   per-frame; hidden in the DSA mask pass with the instruments).
5. Covered-wire render clamp: wire nodes with arc < sheath deployed length are drawn on the sheath
   centerline curve, with a 1 cm blend before the tip — the rendered wire can never poke through
   the sheath wall regardless of physics transients. Scratch arrays, no per-frame alloc (except
   2–3 blend-zone nodes, noted for a future pass).
6. Fluoro sigmas: sheath 4.5 → **1.2**, wire 7.0 → **10.0** (both creation and per-frame re-set);
   ordering now covered-region darkest > bare wire > faint sheath; stale comment fixed.

Verified: typecheck clean; `npm run browser:physics` all 3 scenarios pass (wall-pen ~0, segment
error 0.063 < 0.15, step p95 7.6 ms < 16.7 budget).

### 2.3 Item 3 — honest coax containment + divergence guard (opus; fable review round 1: ACCEPT-WITH-FIXES; round 2: ACCEPTED)

**Files:** `src/sim/cosserat.ts`, `src/sim/coax.ts`, `src/sim/cosserat.test.ts`,
`src/sim/coax.test.ts`, `src/sim/beamfem/integration_live.test.ts`.

- **True distance:** `closestOuterAtArc` (and `coax.ts closestOuterSegment`) now return both the
  windowed perpendicular `rho` (still drives engagement/calibration — projecting on true distance
  would inject an illegal axial tie and stall telescoping; reviewer agreed) **and** a global-min
  clamped `trueDist` used for honesty.
- **Divergence guard** (in `buildCoaxContacts`): ENTER when `trueDist > COAX_DIVERGENCE_BREAK
  (0.5 cm)` AND `wall pen > COAX_WALL_ESCAPE_TOL (6.0 cm)`; RETAIN until **both** heal below the
  repair band (`COAX_DIVERGENCE_REPAIR = 0.03`) — the round-1 implementation cleared on *either*
  heal (code/comment inversion), which let the wire park 1.05 cm through-wall while reporting
  0.000; the reviewer caught it and round 2 fixed it. Diverged nodes are exempted from the vessel
  contact clip (per-node `coaxDiverged[]` mask) and become visible to `maxWallPenetration`.
- **Why 6.0 cm:** empirically necessary corrective debt. Tightening to 1.0 explodes the
  chirality-parity canary (relDiff 10.04 vs 0.12 envelope — trajectory bifurcation) and reds the
  device-stiffness gate; reviewer reproduced this independently. The guard catches the
  catastrophic regime (measured 47 cm through-wall drag, now capped at ~8 cm peak), not mid-range.
- **Honest diagnostics:** `maxCoveredTrueDistance()`, `maxUncontainedWallPenetration()`
  (report-only, clip-ignoring, covered nodes with trueDist > break), `maxCoveredPerpRho()` (the
  old windowed radial metric, kept as a binding bound), `wallPenetrationAtNode(i)`,
  `divergedCoaxCount()`. `maxCoveredInnerRho` is now honest.
- **Gates:** the old blind containment gate strengthened (budget clearance+0.03, justified by a
  real ~0.026 cm axial portal component the old metric discarded, with div==0 asserted); a
  sheath-advance-over-held-wire scenario gate; a forced-escape guard-fires-and-recovers gate;
  integration_live re-asserts the original binding radial bound via `maxCoveredPerpRho()`
  alongside honest true-distance assertions; safety assertions use the honest per-node primitive
  (`honestMaxWallPen`), not the clippable aggregate.
- **Documented-red `it.fails` gates encoding residual harms** (promote to hard `it` when item 4
  lands and they flip green):
  1. sheath-advance settled honest penetration ≈ **5.3 cm** — *sub-trigger escape*: material that
     never crosses the 6.0 cm trigger hovers below it, pinned on the paired segment's extended
     line (trueDist ≈ 5.35, perp ≈ 0.04). The guard is a **cap, not a cure**.
  2. over-fed covered wire (wire 24 over held 6.5 sheath) ≈ **4 cm** honest penetration.
- **Known blindness (documented in-code):** `wallPenetrationAtNode` re-acquires the globally
  nearest lumen edge, so registered penetration is capped by inter-vessel spacing — the 6.0
  trigger can be unreachable in the vessel-dense visceral region. Needs a spacing-aware metric
  eventually; the catastrophic case is caught because it crosses empty space.
- **Re-derivation notes** on both guard constants: tuned in the heavy-inertia regime
  (TRANS = 8e5); re-derive at 8e2 and when bilateral coupling lands.

---

## 3. Verification state at stop

### 3.1 Incident at stop time (resolved)

The item-4 agent had **already started and partially implemented** the wire-rail constraint when
its launch was rejected/killed: orphaned, unreviewed edits to `cosserat.ts` (a
`projectDirectOuterOntoWireRail` projection, `closestInnerAtArc` pairing, `COAX_RAIL_*` constants,
branch-sharing accessors, two call sites) plus a scratch test
(`src/sim/__otw_scratch.test.ts`) were left in the tree, mid-tuning, and broke **14 tests across 3
files** (incl. pushability collapse to 0.04 and chirality parity 0.29 — catastrophic, not flaky).
All of those edits were surgically excised and the scratch file deleted; the three files then
re-ran at exactly their accepted green counts. Two takeaways preserved for the item-4 implementer:
the killed agent's design direction (per-node wire-leads rail, distal-window-only railing, engage
break = divergence break, tip margin, rate cap, branch adoption) looked sound and its constant
derivation comments were thorough — but its mid-flight state failed pushability/chirality, so the
calibration interaction is the hard part, exactly as §4.1 warns. Do not assume the design is
disproven; it was simply unfinished.

### 3.2 Final verified state (after excision)

Per-file gates (each run standalone):
- `npm run typecheck` — clean.
- `src/sim/cosserat.test.ts` — 32 passed | 2 expected fail (the documented-reds) | 2 todo.
- `src/sim/coax.test.ts` — 13 passed.
- `src/sim/validation_calibrated.test.ts` — 17 passed | 1 todo (chirality canary GREEN;
  pushability healthy).
- `src/sim/beamfem/integration_live.test.ts` — 14 passed (incl. restored radial bound).
- `src/sim/dynamic_recovery.test.ts` — 1 passed | 2 expected fail (documented-reds).
- **Final full CI gate (post-excision): `npm test` exit 0 — 243 passed | 4 expected fail (the
  documented-reds: 2× dynamic_recovery, 2× coax containment) | 2 skipped (pre-existing) | 3 todo;
  `npm run build` exit 0; `npm run typecheck` clean.** The full CLAUDE.md release sequence passes.
- `npm run browser:physics` — all scenarios green (post item 2).

Everything is **uncommitted**. `output/*` churn is smoke-test regeneration.

---

## 4. Remaining work (in priority order)

### 4.1 Item 4 — bilateral coax coupling (NOT STARTED; fable-tier)

**Goal:** an advancing sheath must thread over the deployed wire instead of navigating
independently. This cures audit root cause 1 (the 42 cm divergence), should flip both
documented-red containment gates green (→ promote them to hard gates), and makes the divergence
guard's catastrophic regime unreachable.

Recommended direction (from the audit; implementer judges):
- When `outer.deployedLength() < inner.deployedLength()` (wire leads), add a **wire-rail
  constraint**: pair each outer node near the tip to the inner's same-material-arc point and
  project the OUTER within clearance — the mirror of the existing inner-in-outer channel, active
  only in the wire-leads regime so it cannot fight existing containment.
- And/or **kinematically route newly advanced outer material along the inner's centerline**, the
  way `insertion.ts` routes injected nodes along the access path (simpler and stable for the
  advance itself; may still need the rail to prevent later lateral peel-off).
- **Share branch-selection state** (lumen.ts branch hysteresis): the threading sheath must inherit
  the wire's branch choice.
- Known dead end: raising `COAX_DIRECT_OUTER_MASS_SCALE` beyond ~0.01 breaks containment
  (in-code comment; do not retry).

Definition of done: over-the-wire repro (wire 8→24, sheath 6.5→18) tip separation ~0 (±2 cm) and
innerExitPastOuterTip ≈ +6 cm; both documented-red gates flip green and are promoted; all gates in
§3 stay green (chirality canary is the coax canary); update the guard-constant re-derivation
notes; add a threading regression gate.

### 4.2 Stiffness feel flip (blocked on contact/friction work)

`D_MASS_SCALE_TRANS = 8.0e2` is validated and one line away, but requires Schur-style
contact/friction coupling so stick-slip can hold a springy wire (transport is currently
inertia-powered; climb gate collapses otherwise). When flipped: retune dampingTau→a0 together,
re-derive the coax guard constants and the integration_live sheath-move bound (~4.0 measured
plateau 2.65–2.67 cm, noted in the test), and the dynamic_recovery `it.fails` gates flip green →
promote.

### 4.3 Smaller follow-ups

- Preset realism pass against §1 literature targets (softer workhorse shaft EI 3e-4 N·m², longer
  graded tip, d⁴ taper law, friction CoFs) — only after 4.2, since feel is currently
  dynamics-dominated.
- Spacing-aware wall-penetration metric (lumen global-reacquire blindness).
- Physics-side tip funnel/ring if any exit-zone artifacts remain after item 4.
- Pre-allocate the blend-zone scratch Vector3 in Viewport's covered-wire clamp (micro).

---

## 5. Process notes

Implemented via the `/team-implement` orchestration loop: per-item model tiers
(sonnet/opus/fable), self-contained worker prompts carrying the audit evidence, independent
adversarial review at ≥ implementer tier for solver changes, orchestrator-run gates after every
round. Two review rounds were needed for item 3 (hysteresis inversion caught by review and proved
with instrumented probes — exactly the failure class the review step exists for). All temporary
probe files used for empirical verification were deleted; the tree contains only the intended
changes listed in §2.
