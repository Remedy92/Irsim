# IRsim Physics-Fidelity Refactor — Living Progress Tracker

**Single source of truth for the in-flight physics refactor. Keep this updated as each phase lands.**

- **Goal:** make guidewire/sheath physics accurate to real material behaviour by promoting the dynamic
  co-rotational beam FEM to the shipped elastic runtime, behind analytic test gates — **and land that
  fidelity where it is observable and validated**: the exit criterion is the clinician credibility gate
  (ROADMAP Phase 0 / Phase V), not the analytic battery alone. Analytic gates prove the math; only a
  clinician proves the feel.
- **Status as of 2026-07-16:** Phases A–H are complete in the current workspace; the dynamic
  co-rotational beam is the sole shipped elastic runtime and the legacy XPBD rod lane is deleted.
  The current engineering release gates pass, including repeated browser physics and local-DICOM
  review/privacy acceptance. **The core live-feel and clinical-validity goals are NOT yet met** — see
  the headline finding and the aortoiliac stability boundary in `docs/ARCHITECTURE.md`.
- **Approach:** incremental, gate-first FEM promotion (NOT a rewrite). Each phase converts a
  skipped/missing test into a hard CI gate.

## ⚠️ Headline finding (this reframes the remaining work)

The Phase-G flip shipped, **but the *live* wire dynamics do not yet express the calibrated stiffness.**
Every green EI/GJ/curvature/Bishop gate routes through `relaxDirectStatic()`, which drops the `m/Δt²`
inertia term — so the suite proves the elastic operator **in statics only**. The shipped *dynamic*
`stepDirect` path is load-bearing on **artificial** translational inertia (`D_MASS_SCALE_TRANS = 8e5`).
The physically-correct value (`8e2`) is bench-validated (115 % of analytic cantilever δ, 0.85 s
spring-back) but **collapses navigation** (pushability climb 9.3 → 0.45 cm) because the wire's transport
is currently *inertia-powered*, not *friction-held*. Source: `docs/coax-containment-and-stiffness-progress.md`.

Consequences:
- The two user-reported complaints — **"wire too floppy"** and **"wire not contained in the sheath"** —
  are **both still open**, and **both blocked on the same prerequisite**: a **Schur-complement
  contact/friction solve** + the **bilateral coax wire-rail** (coax "item 4"). These were previously
  filed as "Phase J — deferred, not on the critical path." **They ARE the critical path** for the
  refactor's own live-feel goal.
- The suite is honestly instrumented for this: **4 documented-red `it.fails` gates** are designed to flip
  green the day the fix lands —
  - floppy wire → `dynamic_recovery.test.ts:67` and `:123` (live dynamics don't reach static δ / don't straighten),
  - wire-not-in-sheath → `cosserat.test.ts:1037` and `:1054` (honest coax wall-penetration ≈ 4–5.3 cm).

## User decisions (locked)
1. Incremental FEM promotion (preserve calibrated kernel + tested contact/lumen/coax machinery).
2. Ship **h=0.5 (~40 nodes)**; analytic Crisfield/Battini tangent + h=0.25 is a deferred perf upgrade
   (Phase J-E), prerequisite for a third instrument.
3. **Maximum material fidelity** — nitinol plateau-softening AND full hysteresis, push-to-twist coupling,
   anisotropic J-tip bending (Phase I).
4. **Chirality fixed properly** (Workstream X), not deferred — before any human evaluation.
5. **Exit criterion is the clinician credibility gate** (Phase V): fluoro reads as a C-arm; advance/
   torque/branch-engagement feels plausible; left/right selective tasks feel symmetric.
6. **Doc cleanup (2026-06-16):** archived `physics-review-guidewire-sheath-options.md`,
   `physics-beam-integration-architecture-plan.md`, `physics-design-cosserat-xpbd.md` to `docs/archive/`;
   deleted `physics-question-for-gpt-pro.md`; banner-updated `anatomy-realism-roadmap.md`; refreshed
   `CLAUDE.md` pointers.
7. **No flag-gating (2026-06-16, user directive).** New fidelity ships **live to production**, not behind
   off-by-default flags. A feature defaulting to "off" means nobody experiences the fidelity — that
   contradicts the fidelity-over-schedule-safety stance. So Phase I material features (nitinol, anisotropy,
   helical, vessel) and any cosmetic realism land **unconditionally on** (with correct material params),
   not behind a `use*` toggle. The remaining `use*` switches that exist are architectural lane selectors
   (`useDirectSolve` — removed by Phase H; `useCompliantFeedMotor` — already ON for the shipped guidewire),
   not feature hides. Test markers (`it.fails`/`it.skip`/`it.todo`) are gates/scope-declarations, not
   production flags, and stay. (Already applied: fluoro pulsatility ships always-on in the fluoro view.)

---

## Status at a glance

| Phase | Title | Status |
|------|-------|--------|
| A–G | FEM promotion to the shipped runtime (battery, mass, integration debt, coax/feed, friction, perf, THE FLIP) | ✅ done, merged to `main` |
| Post-G | mass-conditioning split, honest coax containment + divergence guard, fluoro DSA/bone/contrast/windowing, pathology + variant scenarios, workstation UI, device-stiffness presets, CI hardening, beam singular-pivot fix | ✅ merged |
| AC | Anatomy visceral core (zero engine change) | ✅ done (visceral tree shipped); morphometry-calibration slice ⏳ remains |
| BR | Anatomy ingestion bridge (sidecar/centerline loader + picker + synth generator + DICOM design) | ✅ done |
| **H** | Slim `cosserat.ts` (delete legacy XPBD lane) + invert material ownership | ✅ done in current workspace |
| **X** | Chirality fix (osculating-plane precurve) | ⏳ not started |
| **J** | **Schur contact + mass-flip + bilateral coax rail — THE CRITICAL PATH for live feel** | ⏳ not started |
| **I** | Additive material fidelity (nitinol/twist/anisotropy/vessel) | ⏳ not started (features 4/5/7 nearly free) |
| **V** | Clinician credibility gate — **EXIT CRITERION** (interim after X+J-B; final after I) | ⏳ not started |

**Live test baseline (2026-07-17, current workspace):** `npm test` = **312 passed · 6 expected-fail ·
3 skipped · 3 todo** (324 tests / 34 files), `npm run typecheck` ✅, `npm run build` ✅. The deterministic
physics gate — the work-count/containment battery in `beamfem/integration_live.test.ts` (14 tests) — is
green. The headless **browser** physics smoke (`browser:physics`) is cadence-sensitive and NOT
deterministically green: desktop `requestAnimationFrame` jitter selects whether the first-pass aortoiliac
transient in `wire-forward-28x-w` relaxes or exceeds the 0.15 cm gate (observed ~6–8/10 pass quiet, with
0.15–0.27 cm excursions on failing runs and multi-cm excursions under heavy load). The 0.15 cm gate is
left unchanged; its deterministic-green fix is Phase J. The local-DICOM browser acceptance passes review
invalidation, topology/undo/retrack, zero-storage, same-origin worker, and fallback-return gates.
Expected failures/todos remain research tripwires, not a claim of clinical validity. See
`docs/ARCHITECTURE.md` §8/§11 for the exact evidence and current limitations.

---

## What is DONE

Phases A–G (analytic battery, real lumped mass, integration debt F1–F8, two-way coax + compliant feed,
friction calibration, perf harness, THE FLIP to `GUIDEWIRE_DIRECT`/`SHEATH_DIRECT`) and the post-G wave
are recorded in git history and in `docs/coax-containment-and-stiffness-progress.md` (the authoritative
physics-state record) and `docs/hyperrealism-refactor-plan.md` (the cross-cutting done/remaining map).
Key load-bearing post-G facts:
- **Anisotropic mass-conditioning split:** `D_MASS_SCALE` → `D_MASS_SCALE_TRANS` (m + Jb) + `D_MASS_SCALE_TWIST`
  (Jt), both shipping `8e5` (bit-identical to before). The bending-true `TRANS = 8e2` is validated but
  unshippable until the contact work lands (see headline finding).
- **Honest coax containment + divergence guard:** true-distance metric + `coaxDiverged[]` mask + honest
  penetration accessors; two residual harms encoded as `it.fails` (over-fed / sheath-advance escape).
- **Device-stiffness presets** (Standard/Stiff/Soft) on the validated `bendComplianceScale` lever.
- **Chirality root cause pinpointed:** the tip-precurve axis vs `buildAccessFrame` handedness; the
  one-line axis swap mirrors but stops aiming up-vessel (reverted). Real fix = derive the precurve PLANE
  from local vessel osculating geometry.

---

## What REMAINS — the finishing plan

**The hard physics finish does NOT parallelize.** H, X, and J all edit `cosserat.ts`, and J's sub-steps
are chained through calibration cliffs (pushability fails *abruptly* anywhere in `(1e5, 8e5]`). The
killed "item-4" agent proved mid-flight parallel solver edits break 14 tests. So: **one solver agent at a
time on the spine, adversarially verified by a fan-out (team-implement model-tiered loop), with
independent tracks running alongside.**

### Serial spine (the critical path, on `cosserat.ts`)

**Phase H — completed 2026-07-16 (historical acceptance record)**
- Delete `solveStretchShear` (`cosserat.ts:1011`), `solveBendTwist` (`:1074`), `iterateElastic` (`:1627`),
  `anchorInlet` (`:1514`), `resetElasticLambdas`, `resizeLambdas` λ-fits, the 6 XPBD λ-arrays, the XPBD
  branches of `CosseratRod.step()`/`CoaxialAssembly.step()`, and the `GUIDEWIRE`/`SHEATH` legacy presets
  (migrate tests to `*_DIRECT`).
- **KEEP:** `w[]` (kinematic flag), `wq[]` (NodeContactTarget interface needs the field), all
  `iterateWallContact`/contact/coax primitives, `anchorInletDirect`, and `solveXPBDVectorDiagonal`
  (the inlet motor in `insertion.ts` uses it — relocate it or keep `xpbd.ts` for it; delete only
  `solveXPBDScalar`).
- Invert material ownership: add native `EI/GJ/EA` to `MaterialProfile`, drop the `integration.ts`
  compliance↔rigidity round-trip, move `bendComplianceScale` to scale EI/GJ.
- Gate: every Tier-1–8 numeric gate holds **identical thresholds** (pure deletion); the 2 legacy-lane
  `it.skip` tests are **deleted**, not skipped.

**Phase X — chirality (osculating-plane precurve)** *(medium)*
- In `material.ts:buildGuidewireField` (line ~242, the `new Vector3(tipCurvature,0,0)` at ~:262), replace
  the always-X precurve axis with one derived from the **local vessel osculating plane** (vessel tangent
  `site.dir` × centerline-curvature near the access index), threaded from the `CosseratRod` constructor
  after `buildAccessFrame`. Safe fallback to world-up cross-product at branch ends.
- The kernel is already chirality-clean (`so3.test.ts:159` mirror-antisymmetry); the asymmetry is purely
  in precurve-axis construction. Do NOT re-test the refuted `solveBendTwist` sign hypothesis.
- Gates: `CHIRALITY PARITY` coax gate (`validation_calibrated.test.ts:136`) stays green; `PUSHABILITY`
  (`:236`) stays green (the gate that killed the one-line swap); solo-rod baseline relDiff drops from
  13.5 % toward ~0 %; **add a new LCFA-vs-RCFA pushability parity gate** (relDiff ≤ 0.12).

**Phase J — the live-feel payoff** *(extreme; team-implement adversarial loop)*
- **J-A Schur-complement contact/friction** (new `beamfem/contact_schur.ts`, ~400 lines): after each beam
  Newton round, form the per-contact Schur complement `nᵀA⁻¹n` from the already-factored block-tridiag `A`
  and solve contact forces simultaneously, so stick-slip holds a springy wire **in the same step**
  (staggered XPBD lets it spring back between rounds). Entry: `cosserat.ts:directContactProject` (`:2033`),
  `beamfem/dynamic.ts:assembleTangent` (`:254`).
- **J-B mass flip:** `D_MASS_SCALE_TRANS 8e5→8e2` (`cosserat.ts:608`, one line) + retune `dampingTau→a0`
  *together* + re-derive `COAX_DIVERGENCE_BREAK`/`COAX_WALL_ESCAPE_TOL`. **Only after J-A holds pushability.**
- **J-C bilateral wire-rail** (coax item-4): add `closestInnerAtArc`; when the wire leads, project the
  outer near the sheath tip onto the inner centerline (distal-window-only) so an advancing sheath threads
  over the wire — cures the 42 cm separation. **Measure pushability + chirality canary after every constant
  change** (the killed item-4 agent broke both). Share the lumen branch-hysteresis so the sheath inherits
  the wire's branch.
- **J-D:** promote all 4 `it.fails` to hard gates **in the same commit** as the constant change; add a
  threading regression gate (wire 8→24, sheath 6.5→18 → tip separation ≤2 cm, innerExitPastOuterTip ≈+6 cm).
- **The acceptance crux (this IS the proof):** today no single mass value satisfies both Tier-3 dynamics
  (wants 8e2) and Tier-6 pushability (needs 8e5). The refactor is proven accurate the moment **one
  physical inertia value passes both simultaneously.**
- **J-E (deferred):** analytic Crisfield/Battini consistent tangent + h=0.25 — perf headroom for a third
  instrument; not needed for J-A/B/C correctness.

### Parallel tracks (independent files — run concurrently with the spine)
- **AC morphometry calibration** — `anatomy.ts` data (aortic bifurcation, renal asymmetry). Fully independent.
- **Phase I low-risk features** — anisotropic J-tip (#4: data path already plumbed, just add `eiCm2` input),
  GJ independence (#5: `gjCm` already distinct, add `gjFraction` + gate + doc), fluoro pulsatility (#7:
  render-only). Schedule #4/#5 after H (they share `material.ts`).
- **Gate scaffolding** — `material_nonlinear.test.ts` with `it.skip` stubs declaring Phase I scope; the
  **live-path settled-equals-static cross-check** (solo + coax) closing the #1 verification gap.

### Phase I full (after J + AC)
Nitinol `EI(κ)` plateau-softening then full hysteresis (energy-monotonicity gated, martensite advects like
`restCurvature`); push-to-twist helical coupling; compliant-centerline vessel restoring. These need J-B's
bending-true mass to be *felt* and AC's tortuosity to be *observable*. Author the capstan, floppy-tip, and
tip-azimuth `it.todo`s as hard gates here.

### Phase V — clinician credibility gate (exit criterion)
- **V-interim** after **X + J-B**: developer feel pass + first clinician look on the calibrated, mirror-clean,
  real-stiffness runtime. Cheapest falsification — run before investing full Phase I.
- **V-final** after Phase I: clinician sign-off on max-fidelity behaviour. Refactor done when this passes.

---

## Verification ladder — how we prove it's accurate

The #1 gap: **the live `stepDirect` EI is currently unproven** (only statics are). The ladder closes it.

| Tier | Proves | Where |
|---|---|---|
| 0 Kernel unit | SO3 (incl. mirror-antisymmetry), block-tridiag (singular-pivot report), XPBD limits | `so3/blocktridiag/xpbd.test.ts` |
| 1 Element/adapter analytic | free-flight increment form, Rayleigh decay, Euler P_cr, compliance↔EI inversion, RAW-radian precurve | `beamfem/dynamic/buckling/integration.test.ts` |
| 2 Live-rod **statics** | cantilever/torsion/pure-bend/Bishop ≤5 % (via `relaxDirectStatic`) | `validation_calibrated.test.ts` |
| **3 Live-rod DYNAMICS** | **shipped `stepDirect` reaches static δ + springs back — RED today, the true goal** | `dynamic_recovery.test.ts` |
| 4 Isolated contact/coax | normal inequality, stick-slip, spin friction, bilateral containment | `contact/coax.test.ts` |
| 5 Coax integration | telescoping, **honest** wall-penetration ≤0.05 in over-fed/sheath-advance | `integration_live.test.ts` + 2 coax `it.fails` |
| 6 Navigation + equivariance | pushability magnitude, substep-invariance, device profiles, x-mirror parity | `validation_calibrated.test.ts` |
| 7 Perf | deterministic work-count hard gate (32 / ≤20000); wall-time tracked | `integration_live` + `perf_ms_recorder` |
| 8 Browser smoke | the real app (store→Viewport→physics) reproduces containment/stability | `browser-physics-smoke.mjs` |
| 9 Clinician credibility (**to author**) | golden-trajectory shape/RMS vs reference path; force-vs-displacement envelope; expert pass/fail | new |

**Live-path proof plan:** keep `dynamic_recovery.test.ts` as the canonical live proof (drives the real
`step()→stepDirect`, asserts dynamic δ reaches 0.8–1.2× static `F·L³/3EI` then ≥90 % spring-back in 1 s);
add a **settled-equals-static cross-check** (drive a uniform-EI rod on live `stepDirect` to rest, assert
settled δ = `relaxDirectStatic` δ within ~5 %) on **both** the solo rod AND the coax assembly
(`stepDirectCoax`); wire one browser-smoke settled-shape assertion so the in-app path is covered.

### Per-phase acceptance
- **H:** full suite green with the legacy lane removed; **zero threshold change** in any numeric gate; the
  2 legacy `it.skip` tests deleted.
- **X:** so3 mirror-antisymmetry green; x-mirror parity green (extended past the buckling bifurcation or
  documented as physical); precurve still aims up-vessel (climb@24 > 8.5 cm); new LCFA/RCFA parity gate green.
- **J / stiffness-flip:** the **4 `it.fails` flip green in the same commit** as the constant change, **while**
  pushability / substep-invariance / device-profiles / x-mirror parity **stay green at the new bending-true
  scale** (the simultaneity is the proof); honest containment ≤0.05 cm in over-fed AND sheath-advance regimes;
  work-count perf gate holds (or a re-derived documented budget); browser smoke `badFrameCount===0`.
- **I:** capstan / floppy-tip / tip-azimuth `it.todo`s authored as hard gates; nitinol plateau + hysteresis
  + anisotropy gates anchored to literature values; all Tier 0–8 gates stay green (additive, not loosening).

## Verification commands
```bash
npm run typecheck && npm test && npm run build          # CI release gate (Node 22 / macOS in CI)
npm exec vitest run src/sim/validation_calibrated.test.ts   # the analytic battery (statics)
npm exec vitest run src/sim/dynamic_recovery.test.ts        # the LIVE-dynamics proof (RED today by design)
npm exec vitest run src/sim/beamfem/integration_live.test.ts # live containment + perf-count gates
node scripts/browser-physics-smoke.mjs --physics direct     # local browser smoke (needs dev server)
```
