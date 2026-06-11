# Dynamic Beam Integration Layer — Higher-Architecture Fix Plan

Status: **working refactor plan with Phases 1-4 partially landed and the production ship decision
made.** The current shipped app path remains the calibrated XPBD `SHIPPED_*` presets; the dynamic co-rotational beam FEM
(`src/sim/beamfem/*`) is the long-term physics base but is still experimental until performance,
browser/app feel, and app-level alias gates clear. Scope: the integration /
adapter boundary between the beam kernel and the host `CosseratRod` / `CoaxialAssembly`
(`src/sim/cosserat.ts`). Companion to `physics-design-dynamic-corotational-beam.md` (the kernel spec).

This plan was produced by adversarially verifying the 8 review findings against the actual code
(all 8 confirmed real), grouping them by **root cause**, designing one ownership boundary that
dissolves whole classes, and then stress-testing that design with an adversarial critic. The
critic's must-fix corrections are folded into the phases below and called out separately in §6.

---

## 0. Central execution tracker

This is the source-of-truth phase list for the beam-integration repair. The goal is to keep every
phase small enough to review, with the Phase-0 gates proving exactly which defect each later phase
turns green.

### Phase 0 — Verification scaffold (landed; expected red baselines)

Status: **done in working tree.**

Purpose:
- Make the live app presets a single source of truth: `SHIPPED_GUIDEWIRE`, `SHIPPED_SHEATH`.
- Point Viewport and app-integration tests at those aliases.
- Add diagnostics for vessel-envelope penetration and numerical-tangent work.
- Create red baselines for the frame-ownership and containment defects.

Current expected verification state:
- `npm run typecheck`, `npm test`, and `npm run build` pass on the shipped XPBD path.
- The short-feed direct curved-anatomy containment probes are now normal green regressions for both
  solo guidewire and short-sheath coax cases.
- The existing large-chunk Vite warning remains unrelated to the physics path.

Exit criteria already satisfied:
- Shipped presets are centralized.
- The real app path is under test.
- Direct-path containment/perf are observable.

### Phase 1 — Material ownership (fixes F1)

Status: **done in working tree.**

Purpose:
- Ensure injected material keeps the rod's declared region identity. A sheath must inject sheath
  shaft material; a wire must inject wire shaft material.

Implementation tasks:
- In `material.ts`, export `cloneProfile(profile)` with a deep `restCurvature.clone()`. **Done.**
- Export a sheath shaft profile helper, or a generic region-backed shaft profile helper, so
  `cosserat.ts` does not reach into `REGION`. **Done.**
- In `CosseratRod`, capture a rod-specific shaft prototype at construction from `params.profile`.
  **Done.**
- Replace `prependNode()`'s global `shaftProfile(h)` call with `cloneProfile(this.shaftPrototype)`.
  **Done.**
- Keep `bendComplianceScale` behavior identical for injected material. **Done.**

Tests to add:
- Feed many segments into `SHEATH_DIRECT`; assert injected segments keep sheath EI/GJ/radius/friction.
- Feed many segments into `SHIPPED_GUIDEWIRE`; assert guidewire injection remains wire shaft material.
- Mutate one injected segment's `restCurvature`; assert no other segment/prototype aliases it.

Expected result:
- F1 green.
- The Phase-0 containment red baseline may shift numerically because sheath radius/mass become correct,
  but it is not expected to turn green yet.

### Phase 2 — Frame ownership (fixes F3 red baseline)

Status: **done in working tree.**

Purpose:
- Make `dNodeQ[]` the persistent beam-owned orientation state.
- Demote `q[]` to a one-way segment-frame export for contact/rendering.

Implementation tasks:
- In `ensureDirect()`, only seed `dNodeQ` from segment frames on first direct use or true resize.
  **Done.**
- On prepend/retract, splice `dNodeQ` alongside `dVel`/`dOmega`. **Done.**
- Keep `segmentFramesFromNodal(dNodeQ, q)` as the only steady-state writer to `q[]`. **Done.**
- Stop reading `q[]` back into `dNodeQ` during the direct steady loop. **Done.**
- Reconcile frame persistence with `advectForward(h)` so injected/advected positions and frames remain
  coherent. **Done.**

Tests to add or turn green:
- Turn the Phase-0 repeated bridge red baseline green.
- Add a direct-path twist-retention-after-stop test through `CosseratRod`, not only standalone `stepBeam`.
- Add invariants: `dNodeQ.length === n`, normalized frames, no steady-loop `nodalFramesFromSegments`
  rebuild.

Expected result:
- F3 green.
- Dynamic twist becomes meaningfully testable through the live adapter path.

### Phase 3 — Beam inverse-mass metric for contact/coax (fixes F5 groundwork)

Status: **done in working tree for the projection metric; full direct Schur coupling remains Phase 5+.**

Purpose:
- Make wall/contact/coax projection use `NodeContactTarget` inverse-mass/inertia accessors instead of
  directly reading legacy `w[]` 0/1 weights.

Implementation tasks:
- Extend `NodeContactTarget` with `invMassAt(node)` and `invInertiaAt(node)`. **Done.**
- Implement direct accessors from `dMass`; fall back to legacy `w[]`/`wq[]` if direct mass is unbuilt
  or `useDirectSolve` is false. **Done.**
- Migrate wall normal, translational friction, segment-wall contact, self-contact, coax normal, and
  coax centering to the accessor metric. **Done.**
- Keep `outerMassScale` in the coax API for legacy callers. The current direct path deliberately keeps
  radial support effectively one-way (`outerMassScale = 0`) until the coupled Schur contact model can
  solve the sheath and wire in one system. **Done / intentionally conservative.**
- Defer direct spin-friction migration to Phase 4, where node-frame roll anchors are redesigned.

Tests to add:
- Legacy coax suite still green.
- Coax accessor tests cover inverse-mass reads and one-way centering support for the direct path.
- Guard `invMassAt`/`invInertiaAt` on legacy rods before `dMass` exists.
- Segment-wall and coax-centering use the same accessor surface as coax normal.

Expected result:
- F5 substantially reduced and ready for the unified driver.
- Phase-0 containment may improve, but final containment is expected in Phase 4.

### Phase 4 — Unified staggered direct driver (fixes F2, F4, F6; likely containment)

Status: **partially started; highest-risk phase.** The `dynamic.ts` substep lifecycle is split
around per-state snapshots, and the direct wire/sheath coordinator now finalizes both rods after
wall + coax projections. Schur-style contact compliance and direct-path spin friction remain pending.

Purpose:
- Replace the current atomic `beamSubstepWithContact()` + after-the-fact coax projection with one
  coordinator-owned lifecycle:
  `snapshot once → beam Newton rounds → all constraints in one metric → finalize velocities once`.

Implementation tasks:
- In `beamfem/dynamic.ts`, add per-`BeamState` `SubstepSnapshot`. **Done.**
- Split dynamic stepping into:
  - `beginBeamSubstep(state, snap)` **Done.**
  - `beamNewtonRound(state, dts, params, solver, snap)` **Done.**
  - `finalizeBeamSubstep(state, snap, dts)` **Done.**
- Thread the per-rod snapshot into residual assembly and twist-axis freeze, not only finalization.
  **Done.**
- In `cosserat.ts`, add the direct driver used by both solo rods and coax assemblies. **Done.**
- Compute portal/clip length after fresh outer feed and use that same fresh deployment for wall
  clipping and coax pairing. **Done for the direct coordinator.**
- Move wall normal, wall friction, coax normal, coax friction, and centering inside the staggered
  rounds before finalization. **Done.** Direct-path node-space spin friction remains pending.
- Finalize `dVel`/`dOmega` exactly once for each rod after all projections. **Done.**
- Re-zero inlet velocity/angular velocity after finalization. **Done.**
- Re-zero direct beam velocity/angular velocity after legacy-style material transport
  (`prependNode`/`removeProximalNode` + advection). **Done.** This prevents stale dynamic velocities
  from riding along with kinematic insertion/retraction edits, but it is adapter hygiene rather than
  a full app-level fix.

Tests to add or turn green:
- Coax projection enters `dVel` for the corrected direct rod. **Done.**
- Short-sheath direct coax curved-anatomy containment during app-style feed. **Done after lowering
  the direct feed rate and pairing covered wire nodes by same-arc sheath coordinates.**
- Solo direct curved-anatomy containment during the same short app-style feed. **Done with a
  direct-only rigid-lumen safety projection and branch-preserving direct wall ownership.**
- Covered direct guidewire material remains inside the sheath channel while the open portal stays
  soft. **Done with a direct-only rigid-channel safety projection.**
- Commanded direct guidewire advance exits well past a held sheath tip without rigidly dragging the
  sheath. **Done.**
- Repeated direct pullback/re-feed no longer lets geometrically sheathed wire build vessel contacts
  ahead of the soft portal blend. **Done by clipping vessel ownership through
  `outer.deployedLength() + COAX_PORTAL_BLEND`; covered-wire clearance and vessel-envelope
  penetration are active regressions.**
- Repeated shipped-XPBD pullback/re-feed no longer lets stale vessel-friction anchors in the
  sheath-tip transition pull the wire forward after retract. **Done by muting vessel friction, but
  not vessel normal containment, over the portal blend.** This avoids the stretch spike caused by
  broad scalar vessel clipping on the legacy lane.
- Single-substep portal consistency: no newly covered/exposed node gets neither vessel nor sheath
  containment.
- Direct-path spin wind-up/release with node-space roll anchors.
- Cross-rod snapshot isolation with very different masses.
- Solo direct path behavior preserved.
- Turn the Phase-0 curved-anatomy containment red baseline green, or document and tighten the next
  remaining blocker if penetration is still above the threshold.

Expected result:
- F2, F4, and F6 green.
- F5 fully expressed through the new driver.
- The direct path should finally behave like one coupled dynamic system instead of two solved rods plus
  a late position correction.

### Phase 5 — Verification cleanup and ship decision

Status: **ship default on the calibrated XPBD lane; keep direct experimental.** An attempted `SHIPPED_* → *_DIRECT` flip after the
Phase-4 coordinator split still failed app-level curved-anatomy containment and pullback checks.
Increasing direct contact rounds made the path slower without fixing the failure. The compliant
force-capped feed motor now exists as an opt-in direct path (`useCompliantFeedMotor`) and is covered
by straight-tube feed/stall tests, but a `SHIPPED_* → *_DIRECT + compliant feed` probe still failed
curved-anatomy containment. That specific short-feed containment blocker is now green for both solo
direct guidewire and short-sheath direct coax: the direct wall query preserves established branch
ownership instead of reacquiring to an outside side branch, a direct-only rigid-lumen safety pass keeps
solo samples inside the vessel envelope, and a direct-only rigid-channel pass keeps covered wire
samples inside the sheath lumen while leaving the open portal soft. Direct coax now also asserts that
a commanded wire advance exits well past a held sheath tip without rigidly dragging the sheath, and
that repeated pullback/re-feed keeps lagging, geometrically covered wire out of vessel-wall ownership
until it clears the soft portal blend. The shipped XPBD lane keeps vessel normal contact at the
catheter tip but releases portal-zone vessel friction anchors, which fixes the original repeated
pullback lurch without reintroducing covered-shaft stretch. This does **not** make the direct aliases
shippable yet: the direct aliases still need browser/app feel gates, and the numerical tangent remains
over budget until the analytic tangent or a cheaper contact coupling lands.

Current app-level evidence:
- The dev runtime now supports `?physics=direct` for debug/browser verification while production and
  normal users remain locked to the shipped XPBD aliases.
- `node scripts/browser-physics-smoke.mjs --physics direct` exercises the actual UI/debug path and
  currently fails the direct lane. The failure is specific and actionable: in the wire-forward smoke,
  direct mode stayed finite and vessel-contained but reached `wireMaxSegErr ≈ 2.16 cm`,
  `sheathMaxSegErr ≈ 0.34 cm`, and `wireExitPastOuterTipFinal ≈ 0.22 cm`. In the sheath-forward
  smoke, the direct lane reached `wireMaxSegErr ≈ 1.83 cm` and `sheathMaxSegErr ≈ 0.58 cm`.
  Segment stretch is still far above the shipped browser tolerance, so the direct aliases must stay
  behind the dev-only `?physics=direct` lane.
- A naive direct rest-length projection inside the staggered contact rounds was rejected: it reduced
  the app-level stretch symptom but broke direct curved-anatomy containment (`maxWirePen ≈ 0.36 cm`
  in the short-sheath gate, worse in repeated pullback). The next fix needs coupled inextensibility
  inside the direct solve/contact system, not an after-the-fact position cleanup.
- A later direct-only length safety pass paired with vessel/channel projection was also rejected for
  the ship window: it restored some length locally but corrupted branch/lumen ownership in the solo
  and repeated-pullback direct regressions. Do not revive local length cleanup as a shipping shortcut.

Purpose:
- Convert the temporary red-baseline labels into normal regression gates and decide whether the direct
  beam remains the default shipped path.

Implementation tasks:
- Rename `RED BASELINE` tests once green.
- Re-run and update the plan's expected verification state.
- Add a short browser/manual feel checklist for wire/sheath interactions:
  - sheath advance remains sheath-stiff
  - covered wire exits only through sheath portal
  - direct path contains on curved anatomy
  - torque feels like wind-up/release rather than instant or dead
  - frame rate feels acceptable in 3D and fluoro
- Keep counted perf gate; add browser wall-clock profiling notes if available.
- Turn `scripts/browser-physics-smoke.mjs --physics direct` green before flipping
  `SHIPPED_* → *_DIRECT`.
- Decide whether the analytic consistent tangent is required before calling the direct path fully shipped.

Expected result:
- All CI tests green except explicitly deferred chirality/todos.
- The default `SHIPPED_*` presets either stay direct with confidence or remain on the legacy lane with
  the red gates documenting why. Current state: **remain legacy until browser/app feel and perf gates
  prove the direct aliases in the app path**.

### Explicitly out of scope for this phase sequence

- Chirality parity fix.
- Analytic consistent tangent implementation.
- Force-capped/back-pressure feed motor. **Opt-in direct implementation landed; calibration and
  curved-anatomy coupling remain part of the ship gate.**
- Full Schur-complement contact coupling.
- Removing the segment-frame store entirely.

---

## 1. Diagnosis — eight symptoms, one structural defect

The direct (dynamic-beam) path was bolted onto the legacy XPBD `CosseratRod` by **re-using
XPBD-era data structures as if they were the beam's authoritative state**, when the beam actually
owns a different, richer state:

| XPBD-era structure (re-used) | Beam's real authoritative state |
|---|---|
| per-**segment** frames `this.q[]` (n−1) | per-**node** frames `dNodeQ[]` (n) |
| unit inverse-mass `w[]`, `wq[]` (0/1) | lumped mass `dMass.{m,Jb,Jt}` (real radius/GJ) |
| single scalar `rodRadius` per region | per-element `dElem` rigidities + radii |
| global `shaftProfile()` free-function | the rod's own declared material region |

Wherever the two representations meet, **ownership is ambiguous and the wrong one wins**. Every
finding is one such collision:

| # | Finding | Verdict | Sev | Shipped? | Root cause |
|---|---------|---------|-----|----------|-----------|
| **F1** | Advancing the sheath injects guidewire material | real | **high** | yes | material-ownership |
| **F2** | Coax contact runs *after* beam velocity finalize → reaction never enters `v` | real | **high** | yes | solve-order |
| **F3** | Live path round-trips nodal→segment→nodal each substep → twist bleeds | real | **high** | yes | frame-ownership |
| **F4** | Vessel clip uses stale (prev-substep) sheath length | real | **low** | yes | solve-order |
| **F5** | Contact/coax distribute by fake 0/1 metric + tuned `outerMassScale`, not real mass | real | **medium** | yes | mass-metric |
| **F6** | Direct path drops wall spin friction | real | **medium** | yes | missing-physics |
| **F7** | Shipped DIRECT/coax path is untested; containment assertion is 4× too loose | real | **medium** | yes | verification-debt |
| **F8** | "Under 60fps" is unbenchmarked and contradicted by the code's own comments | real | **medium** | yes | verification-debt |

Notes from verification:
- **F1** is end-to-end on the shipped `SHEATH_DIRECT` path: `prependNode` (`cosserat.ts:576`)
  always prepends `REGION.wireShaft` (EI≈12, r=0.05) even though the rod was built with
  `REGION.sheathShaft` (currently EI≈17, r=0.1 after source-backed recalibration). The leaked
  profile feeds **both** `dElem` (stiffness) and `dMass` (radius² → ~4× lighter). A fully deployed
  sheath becomes ~all wire.
- **F4** downgraded to **low**: the lag is sub-node (~0.15–0.29 cm vs h=0.5) and self-corrects next
  substep — but it exposes a real **split-time portal**: the wall clip is sampled before
  `outer.directSubstep`, while `buildCoaxContacts` samples the fresh deployment, so a newly
  (un)covered node can get *neither* containment for one substep. Fixing it is a free side-effect of
  the Phase-4 lifecycle.
- **F8**: the shipped coax path rebuilds the full banded numerical tangent **32×/frame**
  (4 substeps × 2 rods × 4 contact rounds), and the code itself says this config is "over budget"
  (`cosserat.ts:439-441`) — directly contradicting the "under the 60fps budget" prose.

---

## 2. The target architecture — one ownership boundary

> **The dynamic beam is the authoritative dynamical system. `CosseratRod` is a host adapter that
> provides boundary conditions, contact geometry, and a derived render view. Every shared quantity
> crosses the boundary exactly once.**

**Beam owns (authoritative dynamical state):**
- `x[]` — shared array, but the beam is the **sole writer** during a substep's Newton + contact solve.
- `dNodeQ[]` — nodal frames, **persistent across substeps**: seeded once in `ensureDirect` on first
  use / resize, spliced node-by-node on inject/retract, **never rebuilt from segments mid-run**.
- `dVel` / `dOmega` — finalized **exactly once per substep**, by the coordinator, from the
  pre-substep snapshot.
- `dMass.{m,Jb,Jt}` — the **single source of truth for inverse mass**, used by both the dynamics and
  the contact projection.
- `dElem`, internal force, and precurve `kappa0` (re-seeded each substep from material — correct).

**Host adapter owns:**
- The feed boundary condition (`injectOrRetractNodesAtAccess` + the node-0 anchor at the moving
  access frame).
- **Material region identity** — a per-rod `shaftPrototype: MaterialProfile` captured at construction
  from the same `REGION` used to build the field (sheath→`sheathShaft`, wire→`wireShaft`),
  *transported* on every prepend, never re-named.
- Contact **geometry** (`buildContacts`, lumen radius, the coax portal length computed **once** per
  substep).
- The **render / segment view**: `this.q[]` becomes a **one-way derived export**, computed once per
  substep via `segmentFramesFromNodal` *after* all solving, consumed only by contact build / coax
  pairing / rendering, and **never read back into the beam**.

**Contact uses an accessor metric:** `NodeContactTarget` gains `invMassAt(node)` /
`invInertiaAt(node)` so wall normal/friction/spin and coax constraints stop reading legacy `w[]`
directly. The direct path still keeps coax radial support one-way with `outerMassScale = 0` until
Schur contact can couple wire and sheath without destabilizing containment.

### The unified staggered substep driver

A single coordinator-owned driver subsumes both `beamSubstepWithContact` (1 rod) and `stepDirectCoax`
(pair). Today's defect is that `beamSubstepWithContact` bundles **dynamics + contact + velocity
finalize** into one atomic call whose finalize boundary is correct for a solo rod but wrong the moment
a coordinator wants to project an *additional* (coax) constraint afterward.

New low-level primitives in `beamfem/dynamic.ts` (snapshot lives in a **per-`BeamState`
`SubstepSnapshot`**, not module-level scratch):

```
beginBeamSubstep(state, snap)            // copy x,q,v,omega → snap
beamNewtonRound(state, dts, params, sol) // ONE Newton iter (tangent + residual); positions/frames only
finalizeBeamSubstep(state, snap, dts)    // v=(x−xN)/dts, omega=logQuat(q·conj(qN))/dts
```

Coordinator (`cosserat.ts`) — solo passes `[rod]`, coax passes `[outer, inner] + coupling`:

```
runStaggeredSubstep(rods, feeds, dts, coax?)
  1. per rod: inject/retract → ensureDirect (seed dNodeQ only on resize) → anchorInletDirect → beginBeamSubstep(snap[r])
  2. compute the coax portal ONCE from the FRESH outer.deployedLength(); set inner wall-clip from the
     SAME value; build each rod's wall contacts; if coax, buildCoaxContacts once   ← kills F4
  3. for round in 0..R-1:
       a. per rod: beamNewtonRound(r)                          // real-mass dynamics advance x/dNodeQ
       b. project ALL constraints in the beam inverse-mass metric:
            each rod: wall normal + segment + self → translational friction → SPIN friction on dNodeQ
            if coax: solveCoaxialNormalContact + friction (+ centering)   ← runs BEFORE any finalize → kills F2
          re-apply anchorInletDirect
  4. per rod: finalizeBeamSubstep(r, snap[r], dts) ONCE → re-zero dVel[0]/dOmega[0] → segmentFramesFromNodal(dNodeQ→q)
```

Because the snapshot is **per-`BeamState`**, the module-level `_xN/_qN` scratch that forced "finalize
each rod fully before coax" is gone, so interleaving is legal and the bilateral coax reaction enters
**both** rods' velocities at step 4. `directSubstep` and `stepDirectCoax` collapse to thin wrappers;
the solo path is the degenerate `rods.length === 1` case (behavior-preserving).

---

## 3. Phased plan

Every phase re-runs the Phase-0 gates **and** the unchanged legacy Stage-5 XPBD coax suite as the
"legacy-green" keep-gate.

### Phase 0 — Verification scaffold first (F7, F8)
Make the shipped path the tested path and define the assertions that guard every later phase, before
touching physics.
- Keep `SHIPPED_GUIDEWIRE` / `SHIPPED_SHEATH` as the single live-app source of truth; point
  `Viewport.tsx` **and** every integration suite at the same symbols.
- The attempted direct alias flip is now a Phase-5 ship decision gated on compliant feed plus coupled
  direct contact; app-level Stage-6 tests remain "exactly as Viewport does" on the current shipped
  aliases.
- Add `rod.maxWallPenetration()` / `assertContained()` from `R_eff = R_lumen − rodRadius − EPS_C`.
- Add the tightened containment gate **on curved `buildNormalAnatomy`** (a new `CoaxialAssembly`
  DIRECT test), **not** on the straight over-feed tube (see §6 — straight-tube buckling is a deferred
  feed-model issue and would stay red after all phases).
- Fix the false "once per substep" docstring (`dynamic.ts:191-197`); soften the unbenchmarked 60fps
  prose (`Viewport.tsx:75`, `cosserat.ts:1470`).
- Add a per-frame **counter** (tangent assemblies, element-force evals) on the assembly + a vitest
  microbench that pins `assemblies/frame === 32` and `evals ≤ K` (a count gate is CI-stable where
  wall-clock ms is not).
- Add the **failing-baseline red tests** that the physics phases turn green: a direct-path
  twist-retention-after-stop test (F3) and the curved-anatomy containment test (F1/F5).

*Risk:* the new gates may go red immediately — desired. *Rollback:* presets are pure aliases.

### Phase 1 — Material ownership (F1), cheap early win
- `material.ts`: export `cloneProfile(p)` that **deep-copies `restCurvature`** (a `Vector3` — see §6),
  and `sheathShaftProfile(h)` so `REGION` never leaks into `cosserat.ts`.
- Constructor: set `this.shaftPrototype` from the rod's profile (sheath vs wire), `applyComplianceScale`
  applied once.
- `prependNode:576`: replace `scaledProfile(shaftProfile(h))` with `cloneProfile(this.shaftPrototype)`.
- Tests: feed 50 segments into a `SHEATH_DIRECT` rod, assert every non-tip
  `material.perSegment[k]` EI/GJ/rodRadius/muStatic equals the `sheathShaft` constants; same for
  guidewire (no regression); a no-aliasing test (mutate one segment's `restCurvature`, assert others
  unchanged).

*Hazard (from critique):* sheath radius 0.05→0.1 makes the sheath ~4× heavier and changes coax
clearance one phase before the metric fix. Re-baseline the `integration_live` telescoping ratios after
this phase — the new balance is *more* correct, but its numbers shift.

### Phase 2 — Frame ownership (F3)
- `ensureDirect:1339`: guard the `nodalFramesFromSegments` rebuild behind
  `(!directReady || dVel.length !== n)` so a steady substep reuses the beam-advanced `dNodeQ`.
- `prependNode:589` / `removeProximalNode:640`: **splice `dNodeQ`** (unshift `injectedFrame` / shift)
  alongside `dVel`/`dOmega`, so length tracks `n` without a rebuild.
- Keep `segmentFramesFromNodal` at `directSubstep:1417` as the **sole** `q[]` writer; assert no
  `nodalFramesFromSegments` remains in the steady loop.
- **Reconcile `advectForward` with frame persistence** (critique gap): `advectForward` slides
  positions by `h` each inject; decide whether persisted nodal frames are advected/rotated alongside
  or accept a documented one-substep frame lag — add a frame-vs-position coherence assertion after an
  inject, plus a `dNodeQ.length === n` + identity-stable invariant test.
- Tests: twist-retention-after-stop on the **direct** path (turns the Phase-0 red green).

### Phase 3 — Mass metric (F5)
- `contact.ts` `NodeContactTarget`: add `invMassAt(node)`, `invInertiaAt(node)`.
- Rewrite `solveNormalContact` / `solveTranslationalFriction` (`contact.ts:133/167`) and
  `solveCoaxialNormalContact` (`coax.ts:241`) to read the accessor instead of `rod.w[]`. **Also migrate
  `solveCoaxialCentering`** (`coax.ts:359`) — otherwise the two coax constraints distribute by
  inconsistent metrics (critique gap); and the 2-endpoint `solveSegmentWallContact` distribution.
- `CosseratRod.invMassAt`: `if (!useDirectSolve || !directReady) return w[node]` (resp. `wq`) so the
  **legacy path never dereferences an unbuilt `dMass`** (critique: this is the legacy crash hole);
  direct path returns `node < fixedPrefix ? 0 : 1/dMass.m[node]`. `invInertiaAt` must index `dMass.Jt`
  by **node index**, not segment index (critique: index-space bug).
- **Keep the `outerMassScale` parameter** on `solveCoaxialNormalContact` (default 1.0); the direct
  path currently passes `0` to keep the sheath as the radial support surface until Schur contact
  lands, while the legacy call site keeps passing `COAX_OUTER_MASS_SCALE`. (Deleting the param breaks
  the legacy coax call site — see §6.)
- Re-tune `COAX_ALPHA_N` — and budget for **conditioning**, not just convergence rate: a near-rigid
  3-body coax normal is ill-conditioned by design (`cosserat.ts:1491-1498`), and `gradMass` shifts by
  ~1/m (potentially 1–2 orders).
- **Defer the `solveSpinFriction` metric swap to Phase 4** (where spin friction is actually wired into
  the direct path) — changing it here only touches the legacy path and risks a silent legacy
  regression with no direct-path coverage yet (critique ordering hazard).

### Phase 4 — Unified staggered driver (F2, F4, F6) — *riskiest phase*
- `dynamic.ts`: add `beginBeamSubstep`/`beamNewtonRound`/`finalizeBeamSubstep` with a **per-`BeamState`
  `SubstepSnapshot`**, and thread that snapshot into `assembleTangent` (twist-axis freeze at `_qN`)
  and `residualSolveApply` (`_xN/_qN/_vN/_wN`) — **not just `finalizeVelocities`** (critique: a
  finalize-only snapshot lets interleaved `newtonRound(outer)`/`newtonRound(inner)` cross-contaminate
  each rod's inertia residual). **Done; the direct coordinator consumes these primitives.**
- `cosserat.ts`: add `runStaggeredSubstep`; `directSubstep` → `wrapper([this])`, `stepDirectCoax` →
  `wrapper([outer, inner] + coupling)`. Compute the coax portal once in `buildCoaxContacts`; the inner
  wall-clip reads the same value (**F4 dissolved**). Move coax projection **inside** the staggered
  rounds before any finalize, finalize both rods once, re-zero inlet v/ω (**F2 fixed**).
- Add `solveSpinFriction` to the contact block operating on **`dNodeQ`** via `invInertiaAt` (**F6**) —
  but **redefine the roll anchor/angle in node-frame space first** (critique: the existing
  `solveSpinFriction` references the segment-frame director and stores `c.rollAnchor` in segment-psi;
  passing `dNodeQ` in unchanged measures wind-up against a moving reference). Add a spin-friction
  reference-frame equivalence test.
- Resolve **frozen-vs-per-round tangent on correctness, not the perf gate** (critique): folding spin +
  coax into the between-rounds projection moves *more* nodes against a tangent the code already warns
  goes stale and overshoots. Add a penetration-vs-tangent-freshness test and let *it* gate the freeze
  decision; reassemble per round if freezing increases penetration.
- Tests: coax-reaction-enters-`v` (F2), single-substep portal consistency (F4), direct-path
  spin wind-up/release (F6), solo-path behavior-preserved, **cross-rod snapshot-isolation** (coax with
  very different masses → each rod's velocity equals a solo reference within tol).

---

## 4. Sequencing rationale

- **Verification first (Phase 0).** Making `stepDirectCoax` the tested path and defining the
  real-envelope containment + counted-perf gates means every later phase is regression-guarded and
  several physics bugs surface as red tests the physics phases turn green. Threaded through, not dumped
  at the end.
- **Material (Phase 1) early** — isolated, high-value, and it corrects the sheath radius feeding coax
  clearance and lumped mass, so the Phase-3 coax tuning tunes against the right geometry.
- **Frames (Phase 2) before metric (Phase 3)** — `dMass`-weighted spin/coax corrections to `dNodeQ`
  are pointless while a lossy round-trip clobbers them.
- **Metric (Phase 3) before the driver (Phase 4)** — the unified driver projects spin + coax *in the
  beam metric*, which must exist first.
- **Legacy XPBD path (`useDirectSolve:false`) stays green at every phase by construction:** Phase 1
  only changes the direct prepend prototype; Phase 2 lives behind `directReady`; Phase 3's accessor
  returns the legacy `w`/`wq` (and the `outerMassScale` param is preserved); Phase 4 adds a new driver
  the legacy `step`/`stepCoaxial` never call.

---

## 5. Explicitly deferred

- **Chirality** (left-curving vessels navigate worse than right) — intentionally **not** auto-fixed
  (prior project decision; guarded by the existing skipped parity test).
- **Analytic Crisfield/Battini consistent tangent** — the real cure for the dominant per-frame FD
  cost; `assembleTangent` keeps the banded numerical Jacobian with the same A-assembly contract. Only
  a CI **counted** microbench is in scope for F8.
- **A true browser wall-clock 60fps gate** — CI ms is noisy; the counted complexity gate is the stable
  proxy.
- **Full Schur-complement contact coupling** (design-doc §1.8) — the diagonal inverse-mass metric is
  the 90% fix without a new solver.
- **Deleting the segment-frame store outright** — this plan only demotes `this.q[]` to a one-way
  derived export; removing it from the direct hot loop entirely is a later cleanup.
- **Straight-tube over-feed buckling** (direct tip not advancing 1:1) — a separate feed-model issue
  (force-capped feed motor), which is why the containment gate goes on curved anatomy, not the
  straight tube.

---

## 6. Adversarial-review must-fixes (folded into the phases above)

The first design pass failed the critic on these — they are corrected in §3 but listed here so they
are not lost in implementation:

1. **`MaterialProfile.clone()` does not exist.** It is a plain interface; `restCurvature` is a
   `Vector3`. Write `cloneProfile()` with a deep `restCurvature.clone()` or every injected segment
   aliases the prototype's `Vector3` and a steer mutation corrupts the shared shaft. *(Phase 1)*
2. **The per-instance snapshot must thread into the Newton residual + twist-axis freeze, not just
   `finalizeVelocities`.** Otherwise interleaved `newtonRound` calls solve each rod against the other
   rod's snapshot. *(Phase 4)*
3. **Do not delete the `outerMassScale` parameter** from `solveCoaxialNormalContact` — the legacy
   `stepCoaxial` still passes it, and the direct path intentionally uses it to keep radial support
   one-way until coupled contact lands. As originally written this was a compile/runtime break of the
   legacy coax path, so the "legacy stays green by construction" claim was **false**. *(Phase 3)*
4. **Spin-friction on `dNodeQ` is not a drop-in** — the roll angle, director reference, and
   `c.rollAnchor` are defined in segment-frame space. Redefine them in node space and add an
   equivalence test. *(Phase 4)*

Plus: guard `invMassAt`/`invInertiaAt` for unbuilt `dMass` on legacy rods; fix `invInertiaAt`
node-vs-segment index space; migrate `solveCoaxialCentering` and `solveSegmentWallContact` to the same
metric; put the tightened containment gate on curved anatomy; let a penetration test (not
`assemblies===32`) decide the frozen-tangent question; reconcile `advectForward` with persisted frames.

**Critic's verdict:** *the four-step lifecycle (snapshot → beam Newton → all-contacts-in-one-metric →
finalize once) is the right shape and correctly diagnoses the single ownership defect; it is a solid
implementation guide once the four must-fixes land. Phase 4 carries essentially all the residual risk.*
