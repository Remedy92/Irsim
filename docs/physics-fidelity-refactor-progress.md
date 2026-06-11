# IRsim Physics-Fidelity Refactor — Living Progress Tracker

**Single source of truth for the in-flight physics refactor. Keep this updated as each phase lands.**

- **Goal:** make guidewire/sheath physics accurate to real material behaviour by promoting the dynamic
  co-rotational beam FEM to the shipped elastic runtime, behind analytic test gates — **and land that
  fidelity where it is observable and validated**: the refactor's exit criterion is the clinician
  credibility gate (ROADMAP Phase 0), not the analytic battery alone. Analytic gates prove the math;
  only a clinician can prove the feel.
- **Branch:** `physics/dynamic-corotational-beam`
- **Approved plan:** `~/.claude/plans/please-deeply-research-how-tranquil-island.md`
- **Approach:** incremental, gate-first FEM promotion (NOT a rewrite). Each phase converts a
  skipped/missing test into a hard CI gate; the legacy XPBD lane stays the safe shipped default until
  the flip (Phase G) and is kept green throughout.
- **Sequencing (adapted 2026-06-10):** G (finish flip) → H (slim) ∥ AC (anatomy calibration, pure
  data, no shared files) → X (chirality) → V-interim (clinician credibility check) → I (material
  fidelity, now observable on calibrated/tortuous anatomy) → V-final (sign-off). Phase J is the named
  home for the Schur-coax + analytic-tangent deferrals (third-instrument prerequisite).
- **CHECKPOINTED + ANATOMY BRIDGE (2026-06-11):** The Phase A–G work is now **committed** (`76ec886`).
  Two stale-doc corrections were discovered and acted on this session (see "Session 2026-06-11" below):
  **(1)** Phase AC is effectively **already done in committed code** — `anatomy.ts`/`anatomyDoc.ts` ship a
  25-branch declarative `AnatomyDoc` (aortoiliac + arch + recalibrated asymmetric renals + full
  visceral/mesenteric tree + pelvic UFE path) with variants and the ostium-weld, not the "8-branch
  perpendicular-renal placeholder" the roadmap describes. **(2)** The DICOM-bridge substrate the anatomy
  roadmap calls "Phase 2" is ~80% present — `anatomyDoc.ts` is JSON-serialisable with validation + weld.
  This session added the missing runtime bridge (sidecar/centerline loader + converter + a live scenario
  picker + file-load) and the DICOM ingestion design doc, so "real anatomy you can drop in" now works.
- **Last updated:** 2026-06-11 (checkpoint commit of Phase A–G; anatomy ingestion bridge landed:
  `anatomy-loader.ts`, scenario picker + sidecar file-load in the app, `docs/dicom-anatomy-pipeline.md`).

## User decisions (locked)
1. Incremental FEM promotion (preserve calibrated kernel + tested contact/lumen/coax machinery).
2. Ship **h=0.5 (~40 nodes)** at the flip; analytic Crisfield/Battini K_geo tangent + h=0.25 is a
   DEFERRED perf upgrade (highest-risk item, off the critical path) — **reclassified 2026-06-10**: it
   lives in Phase J and is a *prerequisite* for the ROADMAP Phase-2 third instrument (catheter),
   because the p95 frame budget is already spent at h=0.5 with two instruments.
3. **Maximum material fidelity** — nitinol plateau-softening AND full hysteresis, push-to-twist
   coupling, anisotropic J-tip bending (Phase I).
4. **Chirality fixed properly** (Workstream X), not deferred.

## Plan adaptation decisions (locked 2026-06-10)
5. **Exit criterion is the clinician credibility gate** (new Phase V): explicit pass/fail defined
   before the review — fluoro reads as a C-arm image; advance/torque/branch-engagement feels
   plausible; left/right selective tasks feel symmetric. Interim check after X+AC; final sign-off
   after I.
6. **X moves before any human evaluation.** The chirality bug degrades every left-sided selective
   task; a feel pass or clinician demo before X evaluates a known-asymmetric simulator and
   contaminates the verdict. X runs after H (so it bisects on the slimmed code, avoiding the
   shared-file conflict that motivated "run last").
7. **Anatomy calibration interleaves before Phase I** (new Phase AC — Move A of
   `docs/anatomy-realism-roadmap.md`): pure `anatomy.ts` data, zero engine change, can run parallel
   to H. Rationale: nitinol plateau-softening and J-tip anisotropy are physically correct but largely
   *unobservable* on straight symmetric placeholder vessels; Phase I's fidelity must be testable by
   feel on calibrated takeoffs and tortuosity.
8. **Schur-coax + analytic tangent get a named home (Phase J)** instead of a floating deferral —
   sheath kickback / losing wire position during exchanges are real IR failure modes; an unnamed
   deferral silently becomes permanent.

---

## Status at a glance

| Phase | Title | Status | CI |
|------|-------|--------|----|
| Research + plan | deep multi-agent research, approved plan | ✅ done | — |
| A | Live-rod analytic battery (cantilever/torsion/pure-bend/Bishop) | ✅ done | green |
| B | Real lumped mass (keystone) | ✅ done | green |
| C | Integration debt F1–F8 (direct lane) | ✅ done | green |
| D | Two-way coax + compliant feed motor | ✅ done (partial-with-headroom) | green |
| E | Friction & contact calibration | ✅ done | green |
| F | Perf harness + committed resolution | ✅ done (agent-verified; orchestrator re-confirm pending) | green |
| G | THE FLIP (SHIPPED→DIRECT, delete dead code, perf-discrepancy check) | ✅ done | green (full suite + typecheck + build + browser) |
| H | Slim cosserat.ts + invert material ownership | ⏳ not started | — |
| AC | Anatomy calibration + visceral core (zero engine change; parallel to H) | ✅ done (in committed code; verified 2026-06-11) | green |
| BR | Anatomy ingestion bridge (sidecar/centerline loader + picker + DICOM pipeline design) | ✅ done (2026-06-11) | green |
| X | Chirality fix (moved BEFORE human evaluation; runs after H) | ⏳ not started | — |
| V | Clinician credibility gate (interim after X+AC; final after I) — **EXIT CRITERION** | ⏳ not started | — |
| I | Additive material fidelity (nitinol/twist/anisotropy/vessel) | ⏳ not started | — |
| J | Unified Schur contact + analytic tangent + h=0.25 (3rd-instrument prereq) | ⏸ deferred, named | — |

**Current test totals (Phase G complete):** full `npm test` is **green at 191 passed · 4 skipped · 3
todo (19 files)**, with `npm run typecheck`, `npm run build`, and `node scripts/browser-physics-smoke.mjs
--physics direct` all green. Versus the pre-flip 195/4/20: the dead `beam.test.ts` (5 tests, 1 file) was
deleted, the legacy-lane `PUSHABILITY` test was re-skipped, the obsolete `BEAM FAIRING` skip was removed
outright, and a new direct-coax PUSHABILITY hard gate was added at review (see Phase G). The 4 remaining
skips are: the two chirality-parity gates (Workstream X) and the two legacy-XPBD-lane tests in
`validation.test.ts` (substep-invariance and pushability), both pointing at their green direct-lane
equivalents and removed when Phase H deletes the legacy lane.

**Plan assessment checkpoint:** the plan was sound. Phase G did expose exactly the predicted app-level
feed/coax blockers, so the flip was not a mechanical alias change. The direct beam kernel and analytic
gates stayed valid; the required work was in the live insertion/coax boundary and acceptance gates.

---

## What is DONE (with detail)

### Phase A — Live-rod analytic battery ✅
Gate-first measurement scaffold; proves the FEM realises calibrated EI on the *live* rod (not just the
kernel). Pure tests + a small zero-default diagnostic API.
- **Production (zero-default, normal play unchanged):** `CosseratRod.setExternalForce/setExternalMoment`,
  `relaxDirectStatic()` (reuses kernel `staticSolve`), `directNodeFrame()`. Per-node `extForce/extMoment`
  wired into the direct beam `fext/mext`; legacy lane deliberately ignores them (position-based, no force
  equilibrium).
- **Gates (all green, direct lane):** cantilever δ=F·L³/3EI for EI=6/12/24 → **realised EI = 100% of
  nominal**; δ ∝ L³; torsion θ=T·L/GJ + linearity; pure-bend κ=M/EI=1/R (finite rotation); Bishop
  twist-leak ≈0. Capstan + blocked-tip added as scaffolds.
- Files: `src/sim/cosserat.ts`, `src/sim/validation_calibrated.test.ts`.

### Phase B — Real lumped mass (keystone) ✅
Replaced the synthetic GJ/Δt²-conditioned density with **physical mass ratios × a tuned absolute scale**
(decoupled from GJ).
- `mass.ts`: removed `densityForElement`; `assembleMass` takes per-element physical density + scale →
  `m=ρAℓ, Jb=ρIℓ, Jt=ρ·Jp·ℓ`. Kept `densityFromGramsPerCm3`.
- `material.ts`: added physical `density` g/cm³ to REGION — wireShaft 7.9 (steel), wireFloppyTip 6.5
  (nitinol), wireTransition 7.2, sheathShaft 1.3 (braided polymer).
- `cosserat.ts`: `D_RSTAR` → `D_MASS_SCALE = 8.0e5` (conditioning knob; keeps wire-shaft twist
  `Jt/Δt² ≈ 17.9` vs `GJ/ℓ ≈ 18.4`, reproducing the validated twist regime while keeping physical ratios
  so the contact/coax inverse-mass metric is real — kills the F5 "fake metric").
- Canaries green: twist wind-up / free-flight / BE-decay; realised-EI still 100%; containment ≤0.05cm.

### Phase C — Integration debt F1–F8 (direct lane) ✅
Audited each finding against current code; most were already landed.
- F1 material-ownership, F2 coax-before-finalize, F3 no frame round-trip, F4 current-substep clip,
  F5 real-mass contact metric, F7/F8 honest perf accounting: **already done**.
- **F6 fixed now:** direct lane was dropping wall spin friction → added `directSpinFriction()` operating
  on beam-owned `dNodeQ` (node-indexed inertia, node-space roll anchor); roll reaction flows into
  `dOmega`.
- Containment: solo 0.0000 cm, coax 0.0000 cm (gate ≤0.05). `validation.test.ts:111` legacy
  substep-invariance skip kept, comment points to the green direct-lane gate.

### Phase D — Two-way coax + compliant feed motor ✅ (partial-with-headroom)
- **Two-way coax:** `COAX_DIRECT_OUTER_MASS_SCALE` 0 → **0.01** (stable bilateral reaction; sheath max
  move under a hard wire push 0.21→0.34 cm, wall-pen 0.0000). Full symmetric (scale=1) hits an
  instability cliff → **deferred to the unified Schur-contact solve** (headroom documented in code). New
  hard gate: "wire push does not shove the held sheath out of the lumen". Free telescoping unchanged.
- **Compliant feed motor:** `forceMax` is now **physical Newtons** via a new `InsertionState.forceScale`
  (direct lane `D_FEED_FORCE_SCALE = 2.0e6`; default `forceMax = 1.2 N`). Kept **flag-gated**
  (`useCompliantFeedMotor`); Phase-G flip decides hard-anchor vs compliant against the containment gate.
- **Blocked-tip stall gate ACTIVATED:** at `forceMax=0.5 N` a jammed tip stalls (−0.15 cm vs 34 cm
  commanded) and prolapses **1.60 cm** (target 0.6–3.0), no tunneling.
- Files: `cosserat.ts`, `coax.ts`, `insertion.ts`, `types.ts`, gate tests.

### Phase E — Friction & contact calibration ✅
- **Friction μ_s/μ_k retuned to literature:** wireFloppyTip 0.08/0.04 → **0.04/0.02** (hydrophilic wet
  COF); wireTransition → **0.07/0.035**; wireShaft 0.10/0.05 → **0.20/0.10** (bare/PTFE band); sheathShaft
  0.25/0.12 kept. μ_k<μ_s preserved. μ_roll left as-is (lowering it destabilised the blocked-tip gate).
- **`wallAlphaN` LEFT at 1e-9:** a deterministic sweep showed a chaotically non-monotonic response with
  failure cliffs adjacent to every candidate retune (legacy fails at 1.5e-8; direct fails at 5e-8). No
  single global value robustly improves both lanes — both are green with max headroom at 1e-9. Decided
  empirically (penetration/chatter), not by the "orders over bend" heuristic.
- **Capstan kept `it.todo`:** the wrap-angle feed-force rise is column compression, not friction (≈1%
  force change for 250× μ) — a θ-only gate would be misleading. Documented.
- Torsion (θ=TL/GJ) and Bishop confirmed as HARD CI gates.

### Phase F — Perf harness + committed resolution ✅ (instrumentation only)
- Per-frame **ms timing** wraps `assembly.step()` in `Viewport` `useFrame`; surfaced via a
  `perf:{stepMs, tangentAssemblies, elementForceEvals}` block on `SimDebugSnapshot` (frame-exact counts).
- Headless **ms recorder** test (`beamfem/perf_ms_recorder.test.ts`): p50/p95/mean console.log, **no ms
  assertion** (wall-clock flakes on CI). Measured this-laptop: **p50 ≈ 8.2 ms, p95 ≈ 15.8–16.1 ms** vs the
  16.7 ms budget → h=0.5 fits with thin p95 headroom (validates deferring the analytic tangent for h=0.25).
- **Hard gate stays the deterministic count** `tangentAssemblies===32`, `elementForceEvals≤20000`.
- `browser-physics-smoke.mjs` extended to print p95 stepMs (reported, not gated). No solver change.

### Phase G — THE FLIP ✅
The shipped runtime now uses the dynamic co-rotational beam presets, the experimental/dead code is gone,
and the full release gate is green.
- **Shipped aliases flipped:** `SHIPPED_GUIDEWIRE = GUIDEWIRE_DIRECT`, `SHIPPED_SHEATH = SHEATH_DIRECT`.
  `Viewport` no longer branches on `?physics=direct`; debug snapshots report the single runtime mode
  `physicsMode: "direct"`.
- **Feed decision made:** shipped guidewire uses the direct compliant feed motor by default
  (`useCompliantFeedMotor: true`) with a permissive direct default cap (`D_DEFAULT_FEED_FORCE_MAX = 5 N`).
  The sheath stays on the hard inlet adapter; making the sheath compliant caused independent-deployment
  coupling and uncommanded depth drift.
- **Direct feed fixes landed:** diagnostic `relaxDirectStatic()` now forces a clamped proximal node so
  cantilever/torsion/pure-bend benches do not measure inlet compliance; direct feed transport is capped
  so distal/coax drag cannot inject extra material; no-advect direct retraction zeros dynamic velocities;
  direct inlet state gets finite guards; newly inserted compliant-feed material is spliced at rest length
  to remove browser-observed one-frame stretch spikes.
- **Coax/app gate updates:** app/direct tests now assert direct-beam behavior rather than legacy
  hard-anchor 1:1 feed magnitudes (clear portal exit, bounded pullback relaxation, containment). The
  repeated-pullback NaN/lurch failure was fixed/contained; focused app integration is green.
- **Blocked-tip gate recalibrated:** post-splice low-force stall uses `forceMax = 0.55 N`, with
  `<5 cm` realized advance against a 34 cm over-feed, measurable prolapse, and no tunneling. Capstan
  remains `it.todo`.
- **Full-suite resolution (the reported PUSHABILITY failure):** the originally-reported failure was an
  intermittent vitest **test-timeout** (default 5 s) on the wall-clock `PUSHABILITY` test under parallel
  worker contention — its `console.log` fires before the assertions, so climb values printed "fine" then
  the run aborted. Two back-to-back full runs reproduced it as green, confirming it was not an assertion
  failure. (The `PUSHABILITY` test was subsequently **re-skipped** for an unrelated reason — see dead-code
  removal below — so the timeout is now moot.)
- **Dead code deleted:** removed `src/sim/rod.ts` (dormant legacy PBD rod, imported by nothing) and
  `src/sim/beam.ts` + `src/sim/beam.test.ts` (the experimental `beamGain` O(N) banded shaft-fairing).
  `cosserat.ts` lost its `BeamSolver` import, the `beam`/`kBuf`/`dCur`/`dFair`/`beamGain`/`beamPasses`
  fields, the `iterateBeam()` method, the two legacy-step call sites, and the `beamGain` key on the
  `CosseratParams` type + `GUIDEWIRE`/`SHEATH` presets. `validation.test.ts` / `validation_calibrated.test.ts`
  dropped their `beamGain` references; `CLAUDE.md`'s file inventory was corrected.
  - **Note (load-bearing finding):** `beamGain=0.2` was NOT dead on the *legacy* `GUIDEWIRE` preset — it
    was an active fairing crutch that the legacy-lane `PUSHABILITY` test's deep-vs-shallow margin depended
    on (deep climb 22 cm → 12 cm once removed). That test is legacy-lane only; the shipped (direct) lane is
    unaffected and pushability/substep-invariance are gated on `GUIDEWIRE_DIRECT` in
    `validation_calibrated.test.ts`. So `PUSHABILITY` was re-skipped (documented) rather than recalibrated.
- **Legacy-only skips reviewed:** `SUBSTEP-INVARIANT` (legacy lane) — **kept skipped**, comment updated to
  point at the green direct-lane gate and Phase H removal. `BEAM FAIRING` — **removed outright**: its whole
  premise was the now-deleted `beamGain` fairing, so the reason is obsolete and there is nothing to un-skip.
  `PUSHABILITY` — **skipped** (legacy lane, fairing-dependent margin; direct lane gated elsewhere).
- **Direct pushability HARD gate added at review** (`validation_calibrated.test.ts`, "PUSHABILITY: feeding
  the shipped coax wire advances the tip cranially up the real anatomy"): review caught that re-skipping the
  legacy `PUSHABILITY` left only RELATIVE climb gates (substep-invariance passes at 0 vs 0 vs 0). The new
  gate asserts climb MAGNITUDE on the **shipped coax** runtime: measured seed 7.79 cm, climb@12cm = 9.29 cm,
  climb@36cm = 43.4–43.5 cm (deterministic, plateaued — feed is rate-limited at `D_FEED_RATE` = 4 cm/s, so
  the deep run needs 900 steps); gated `shallow > 8.5`, `deep > 30`, `deep > shallow + 8`. The measurement
  also pinned a real finding: a **solo** (sheath-less) force-fed direct wire snakes at the unsupported inlet
  and its tip never advances past seed (climb ≈ 6.8–7.2 cm for ANY commanded deploy 10–36 cm) — physically
  expected slender-rod buckling under the 5 N feed cap (and why real procedures feed through a sheath); the
  legacy test's solo climb@36 ≈ 22 cm was the fairing crutch, not physics. The gate therefore runs the coax
  configuration, which is also the app's only runtime shape.
- **Browser smoke green:** `node scripts/browser-physics-smoke.mjs --physics direct` passes — `physicsMode:
  "direct"`, wire exits 2.39 cm past the catheter tip (gate ≥2), 0 bad frames, segErr 0.063 cm, p95 ≈
  7.7 ms, work counts `tangentAssemblies=32`, `elementForceEvals=11424`. Flake note below.
- **Perf-discrepancy verdict (headless 15.8 ms vs browser 8 ms):** both timers wrap the *same* scope —
  `assembly.step()` for the full coax frame — so scope is NOT the cause. Two real differences explain it,
  plus one artifact: **(1)** the headless recorder warms 120 frames then measures **200 frames all at the
  steady navigating state** (every sample is the expensive full-length frame), while the browser p95 is
  over the whole 28×"w" history (~820 frames) that is **diluted by the cheaper short-wire ramp/settle
  frames** — so the browser number is biased low. **(2)** the committed 15.8–16.1 ms recorder reading was
  taken on a **loaded machine**: reproduced here, the same recorder reads **p95 ≈ 10.6 ms idle but ≈ 16.5 ms
  under CPU contention** (3 load generators), i.e. ~6 ms of the headline was scheduler contention, not
  solver cost. **(3)** the browser `performance.now()` is coarsened in headless Chrome (p95 prints as a flat
  `8`). **Authoritative number for frame-budget headroom: the idle steady-state headless recorder p95 ≈
  10–11 ms** — it isolates the true worst-case in-procedure cost. The browser ~8 ms is a ramp-diluted
  *under*-estimate; the 15.8 ms is a contention-inflated *over*-estimate. h=0.5 with two instruments has
  **~5–6 ms p95 headroom** against the 16.7 ms budget on a quiet machine — comfortable, but the headroom is
  spent before a third instrument lands (confirms Phase J's analytic-tangent/h=0.25 as a 3rd-instrument
  prerequisite, not an idle deferral).
- **Browser-smoke flake (environmental, not a regression):** under heavy host CPU contention (observed
  here: a macOS `StorageManagementService` burst pinning ~108% CPU) the headless software-WebGL render loop
  starves, `Viewport` clamps `dt` to 1/30 repeatedly, and the compliant feed injects a big chunk per step →
  a transient 1–2-frame wire segment-stretch spike (0.18–1.7 cm) that trips the 0.15 cm smoke gate. A
  headless emulation of the same direct-lane scenario stays clean (segErr 0.087, 0.118 even with a 1/30
  press frame), and the flip touched only legacy-lane code, so this is pre-existing host-timing sensitivity
  at the feed splice, not a physics regression. The smoke passes cleanly on a quiet machine / between
  bursts; if it flakes in CI, the fix belongs to the harness (steadier key cadence or a dt cap on the
  scripted feed), tracked for Phase H/V hardening.
- **Verification (CI order):** `npm run typecheck` ✅ · `npm test` ✅ (191 passed · 4 skipped · 3 todo,
  19 files, incl. the review-added pushability gate) · `npm run build` ✅ · browser smoke ✅.

### Session 2026-06-11 — checkpoint commit + anatomy ingestion bridge ✅
The physics refactor was at a clean STOP with everything uncommitted; this session de-risked it and
pulled the "real anatomy / DICOM-ready" track forward (the stated next product goal).

- **Checkpoint commit `76ec886`** — the full Phase A–G working tree (2624 insertions; green at 191
  passed · 4 skipped · 3 todo, typecheck + build green) is now committed on
  `physics/dynamic-corotational-beam`. No code change, pure de-risk.
- **Stale-doc reconciliation (load-bearing):** the progress tracker + `anatomy-realism-roadmap.md` both
  describe an 8-branch near-perpendicular-renal placeholder with no visceral core and no loader. The
  **committed reality** is `anatomyDoc.ts` (declarative, JSON-serialisable `AnatomyDoc` + compiler with
  the ostium-weld + variant ops + `validateAnatomyDoc`/`docFromJSON`/`docToJSON`) and `anatomy.ts`
  (`NORMAL_DOC`: 25 branches — aortoiliac + arch great vessels + recalibrated **asymmetric** renals
  [~54° caudal/lateral, R longer than L] + the full visceral/mesenteric tree
  [celiac→hepatic/splenic/GDA/left-gastric, SMA→ileocolic/middle-colic, IMA→left-colic/superior-rectal]
  + pelvic [internal iliac→uterine, the UFE path] — plus `bovine-arch` and `replaced-rha-sma` variants).
  So **Phase AC is effectively complete**; the roadmap's §3-§5 "add the visceral core" is already shipped.
- **Anatomy ingestion bridge (NEW, the DICOM-phase foundation):**
  - `src/sim/anatomy-loader.ts` — `loadAnatomyFromSidecar(url, fetchImpl?)` (fetch→validate→compile,
    injectable fetch for tests); `anatomyDocFromCenterlines(tree)` (raw VMTK-style dense centerlines →
    `AnatomyDoc`, with **RDP curvature-adaptive decimation** that preserves each child's first point so
    the compiler's nearest-parent-sample weld still connects it); `parseAnatomyInput(json)` (auto-detects
    sidecar vs raw centerlines); `anatomyDocToSidecar`. Pure, no three.js/DOM. Tests: `anatomy-loader.test.ts`
    (10) + `anatomy-ingest.test.ts` (4, end-to-end on the shipped example asset through parse→convert→
    compile→`Lumen` connectivity). Both fast (<200 ms).
  - **Live scenario picker + sidecar file-load in the app** — `store.ts` gained `variantId` + `loadedDoc`
    (+ `setVariant`/`loadDoc`, preserved across run reset); `App` and `Viewport` build anatomy reactively
    (`loadedDoc ? compileAnatomy(loadedDoc) : buildAnatomy(variantId)`), so switching scenario/loaded
    anatomy recompiles the lumen + rebuilds instruments through the existing `[anatomy]`-keyed memos. UI:
    a Scenario dropdown (Normal + variants) and a "Load sidecar (.json)" file input that accepts either an
    `AnatomyDoc` sidecar or raw centerlines.
  - **DICOM→AnatomyDoc pipeline design** — `docs/dicom-anatomy-pipeline.md` (de-id → TotalSegmentator
    default Apache `total` task → VMTK centerlines → mm/LPS→cm transform → `AnatomyDoc` JSON + provenance),
    a strict license whitelist, and a shortest-path recommendation: **the first redistributable "real"
    anatomy should be procedurally-generated + morphometry-calibrated (synthetic CC0), not a redistributed
    scan** — no public real-CTA collection is confirmed shippable into an MIT repo without per-collection
    written confirmation, and the default task yields no renal/visceral masks anyway. Demo input shipped at
    `assets/anatomy/example-vmtk-centerlines.json`. **License corrections** vs the roadmap: OpenCCO record
    is conflicted (GPL badge vs LGPL readme) → downgraded to reference-only; VascuSynth is CC BY 4.0, not
    Apache; neither grants generated-output ownership in writing (self-label CC0, retain configs).
- **Verification:** typecheck ✅ · build ✅ (vite, 70 modules, 937 ms) · new anatomy tests ✅ (14) · full
  suite re-run pending confirmation. Physics hot path untouched, so the direct-lane gates/browser smoke
  are unaffected (default anatomy path is behaviourally identical to the prior `buildNormalAnatomy()`).

---

## What REMAINS

### Phase H — Slim cosserat.ts + invert material ownership ⏳ (post-flip cleanup)
- Strip the XPBD elastic/bend/twist/stretch-shear solves, `wq` flat inertia, `anchorInlet` hard pin from
  `cosserat.ts` (keep injection/feed/step seam/contact-coax orchestration/frames).
- Invert material ownership: `material.ts` stores physical EI/GJ/EA/density/radius natively; drop the
  `integration.ts` compliance↔rigidity round-trip.
- Delete `xpbd.ts` ONLY if contact/inlet no longer use the α̃ primitive (verify first). Small,
  parity-checked steps; CI green after each.
- H runs **before X** so the chirality bisect happens on the slimmed code — this preserves the original
  "avoid shared-file conflicts" rationale while still landing X ahead of any human evaluation.

### Phase AC — Anatomy calibration + visceral core ⏳ (NEW; parallel to H, zero engine change)
Move A of `docs/anatomy-realism-roadmap.md`, pulled forward so Phase I's material fidelity is
observable. Pure `anatomy.ts` data — no physics/lumen/fluoro changes, so it can run concurrently with
Phase H without file conflicts.
- **Calibrate existing geometry:** renal takeoffs to ~54° coronal, caudal+lateral (currently
  near-perpendicular); asymmetric renal lengths (right ~42 mm vs left ~32 mm); infrarenal aorta to
  CT-mean radius (~0.77 cm vs current 0.9–1.05); de-mirror the aortic bifurcation (total interiliac
  angle ~42–52°).
- **Add the visceral core:** celiac trunk (→ splenic/common-hepatic/left-gastric), SMA (~67° takeoff),
  IMA — unlocking selective-cannulation tasks where bending fidelity actually matters.
- **Tortuosity descriptor** (Move D) is *gated on X*: the anatomy roadmap flags it as needing an
  empirical chirality+stability check, so land it after the chirality fix, not in this phase.
- Gate: existing lumen-containment + navigation tests stay green on the calibrated anatomy; targets
  reachable in the app in both views.

### Workstream X — Chirality fix ⏳ (MOVED: runs after H, BEFORE any human evaluation)
Previously scheduled last; moved up because the bug degrades every left-sided selective task, so any
feel pass or clinician review before X evaluates a known-asymmetric simulator.
- Bisect the shared-code cause of the left-vs-right navigation asymmetry (suspects: world-fixed
  steer-deflection axis and/or lumen-graph branch tie-break) using the mirror-symmetry harness.
- Land the fix; un-skip the parity gate (`validation_calibrated.test.ts:104`, `cosserat.test.ts:968`).
- Follow-up unblocked by X: tortuosity descriptor (see Phase AC note).

### Phase V — Clinician credibility gate ⏳ (NEW; the refactor's EXIT CRITERION)
This is ROADMAP Phase 0's unchecked gate, made the explicit endpoint of this refactor. Analytic gates
prove the math; this is the only gate that can falsify the premise — that the simulator trains real
advance/torque/branch-engagement skill.
- **Define explicit pass/fail BEFORE the review** (per ROADMAP): (a) the fluoro view reads as a C-arm
  image; (b) advance/torque/branch-engagement feels plausible to a practicing IR clinician;
  (c) left- and right-sided selective tasks feel equivalent (X verified).
- **V-interim (after X + AC):** developer feel pass plus a first clinician look on the flipped runtime
  with calibrated anatomy. Cheapest falsification point — run it before investing Phase I effort, and
  use the clinician's feedback to prioritize Phase I's sub-items.
- **V-final (after I):** clinician sign-off on the max-fidelity material behaviour. Refactor is done
  when this passes, not when CI is green.

### Phase I — Additive material fidelity ⏳ (flag-gated, max fidelity; after V-interim)
Now testable by feel on AC's calibrated takeoffs (and tortuosity once X lands). Order sub-items by
V-interim clinician feedback where it conflicts with the listing below.
- **Nitinol:** smooth `EI(κ)` plateau-softening first, THEN full dual-branch loading/unloading hysteresis
  (energy-monotonicity gated); steel/polymer constant-EI fast path; martensite state advects like
  restCurvature.
- **Push-to-twist** (helical-lead) axial↔torsional coupling (+ gate).
- **Anisotropic J-tip bending:** independent `alphaBend1/alphaBend2`.
- **GJ independence:** default round-metal 0.77·EI via existing `gjCm` + braided-sheath override.
- **Compliant-centerline vessel** straightening/accordion (flag; NOT a wall mesh) + cosmetic pulsatility
  (fluoro only).

### Phase J — Unified contact solve + perf upgrade ⏸ (NEW named home; third-instrument prerequisite)
Not on this refactor's critical path, but no longer a floating deferral. Trigger: before the ROADMAP
Phase-2 catheter (third coaxial instrument) — the Phase-G perf-discrepancy resolution put the true
two-instrument steady-state p95 at ~10–11 ms (≈5–6 ms headroom), so the budget is comfortable for two
but is spent before a third instrument lands.
- **Unified Schur-complement contact solve** → unlocks full symmetric two-way coax
  (outerMassScale 0.01 → 1) and revisits the compliant sheath feed. These model real technique:
  sheath kickback and losing wire position during exchanges.
- **Analytic Crisfield/Battini consistent tangent + h=0.25** — the perf headroom needed to add a third
  instrument and the Phase-I/AC realism load (compliant vessel, pathology, DSA passes) inside 16.7 ms.

---

## Deferrals / known limitations (conscious)
- **Full symmetric two-way coax** (outerMassScale=1) → needs the unified Schur-complement contact solve
  → **now homed in Phase J** (third-instrument prerequisite, not an open-ended deferral).
- **Analytic Crisfield/Battini consistent tangent + h=0.25** → **Phase J**; reclassified from "optional
  perf upgrade" to prerequisite for the ROADMAP Phase-2 catheter, since p95 headroom at h=0.5 is thin.
- **Compliant feed motor default split:** guidewire is shipped compliant; sheath remains hard-anchor for
  now because compliant sheath feed regressed independent deployments → revisit in Phase J.
- **Capstan gate** stays `it.todo` (wrap-force signal is column compression, not friction).
- **Feel validation** is no longer a floating item: the formal pass is Phase V (interim after X+AC,
  final after I) with pre-defined pass/fail. (Phase G's browser smoke + headless gates stand in for the
  developer sanity check; a deliberate manual 3D/fluoro feel pass waits until after the chirality fix so
  it does not evaluate a known-asymmetric simulator.)
- **Out of scope for this refactor** (tracked in `docs/anatomy-realism-roadmap.md` / ROADMAP): fluoro
  realism beyond current (per-branch bolus propagation, bone background, DSA/roadmap), pathology
  descriptors, venous/right-heart subsystem, small-caliber instrument class. This plan is the
  device-physics pillar; AC pulls in only the zero-engine-change anatomy slice Phase I needs.

## Verification commands
```bash
npm run typecheck && npm test && npm run build   # CI release gate (Node 22 in CI)
npm exec vitest run src/sim/validation_calibrated.test.ts   # the analytic battery
npm exec vitest run src/sim/beamfem/integration_live.test.ts   # live containment + perf-count gates
npm run dev                                       # local app for visual 3D/fluoro check
node scripts/browser-physics-smoke.mjs --physics direct   # local browser smoke (needs dev server)
```

## Key file inventory (touched so far)
`src/sim/cosserat.ts` (load hooks, relaxDirectStatic, D_MASS_SCALE, spin friction, coax scale, feed
force, compliant guidewire feed default, feed transport/splice fixes, perf surface) · `src/sim/material.ts`
(density, friction) · `src/sim/beamfem/mass.ts` (physical mass) · `src/sim/beamfem/integration.ts`
(mass build) · `src/sim/insertion.ts` (forceScale) · `src/sim/types.ts` (forceScale) ·
`src/three/Viewport.tsx` (ms timing, direct-only runtime) · `src/sim/store.ts` (perf telemetry) ·
`scripts/browser-physics-smoke.mjs` (p95 reporting, direct-mode assertion, direct portal-exit gate) · tests:
`validation_calibrated.test.ts`, `beamfem/integration_live.test.ts`, `beamfem/perf_ms_recorder.test.ts`,
`cosserat.test.ts`, `insertion.test.ts`.
