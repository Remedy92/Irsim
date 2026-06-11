# IRsim → Physician-Grade Hyperrealism — Refactor Blueprint

**Brief:** make IRsim usable by interventional radiologists for intervention planning and practice —
hyperrealistic anatomy, realistic guidewire/sheath behaviour, and a professional minimal UI.

This is the cross-cutting plan that sits above the physics tracker
(`physics-fidelity-refactor-progress.md`), the anatomy roadmap (`anatomy-realism-roadmap.md`), and the
DICOM pipeline (`dicom-anatomy-pipeline.md`). It records the investigation verdict and the prioritised
execution path.

## Verdict: overhaul the perceptual layer, do NOT rewrite the engine

A from-scratch rewrite is the wrong move and would destroy validated work. A three-axis investigation
(anatomy, physics, UI/rendering) found the foundations are strong and the "feels fake" complaints are
mostly **perceptual**, concentrated in what a physician judges first:

- **Physics is not "completely unrealistic."** The shipped runtime is a dynamic co-rotational beam FEM
  with literature-anchored stiffness (EI calibrated to Suskin 2023 device data), real material
  densities, in-loop stick-slip friction, and a passing analytic battery (cantilever / torsion / twist
  propagation at 100% of nominal). The realism *gaps* are specific and additive — load-dependent J-tip
  feel, two-way coaxial coupling, feed-force calibration — not a broken solver. See the physics tracker.
- **Anatomy is far ahead of its reputation.** 26 branches ship (aortoiliac + arch + asymmetric renals +
  full visceral/mesenteric tree + pelvic UFE path), with variants and a *working* centerline/sidecar
  ingestion bridge. All visceral branches render and are selectable targets today (verified in
  `anatomy.ts` + `Viewport`). The gaps: morphometry calibration, skeletal landmarks, more variants, and
  license-clean real patient data.
- **The real "feels fake" culprits were perceptual**: the fluoroscopy view didn't read as a C-arm
  (no DSA, no bone, no windowing, no contrast sweep), and the UI was a developer console, not an IR
  workstation.

So the correct reading of "a complete new application": **keep the validated engine; rebuild everything
the physician sees and feels.** That delivers a genuinely new application where it counts.

## Done — Session 2026-06-11 (perceptual realism slice)

Landed and verified (typecheck + 223 tests + build all green):

### Hyperrealistic fluoroscopy (`src/three/fluoro.ts`, `src/three/Viewport.tsx`, `src/sim/store.ts`)
- **DSA (digital subtraction angiography) mode** — a mask pass (bone + vessel walls, no contrast, no
  instruments) is subtracted from the live pass so only the contrast column and the moving instruments
  survive: the flat-grey field with black vessels that real selective work runs on. Two-pass render
  gated on `fluoroMode === "dsa"`.
- **Skeletal landmarks** — procedural lumbar/thoracic spine, sacrum, iliac wings, and femoral heads in
  the attenuation field (merged into 3 draw calls). Operators navigate *against* bone; DSA exists to
  subtract it back out. This is the single biggest missing real-fluoro cue.
- **Propagating contrast bolus** — injection seeds a front at the catheter tip that sweeps outward
  through the vessel field (per-branch arrival ∝ distance ÷ front speed), with wash-in/wash-out. This
  is the cardinal fluoro reading skill ("which vessel fills first?"), previously a single global scalar.
- **Operator windowing** — brightness + contrast(window) sliders applied in the tone-map (level/width).
- **Dosimetry / geometry readouts** — procedure time, fluoro (beam-on) time, DAP-like dose, SID, and
  magnification, surfaced as burned-in C-arm corner data and in the metrics bar.
- **On-image vessel callouts** — each navigable ostium is projected to the image as a labelled
  callout (de-overlapped, in-frame only), toggleable, so a trainee reads the anatomy off the fluoro
  ("Sup mesenteric", "L renal", "R iliac"…) — the navigation/teaching aid.

### Anatomy breadth: pathology + variant scenarios (`src/sim/anatomyDoc.ts`, `src/sim/anatomy.ts`)
- New `reshape` variant op — replaces a branch's control points in place (works on the root aorta,
  which `reparent` cannot touch), enabling concentric pathology as pure data.
- Four clinically-core scenarios added to the variant library (selectable in the scenario picker):
  **infrarenal AAA** (fusiform sac with necks — EVAR substrate), **ostial left renal artery stenosis**
  (tight pinch + post-stenotic dilation — the renal-stent case), **accessory right renal artery**
  (lower-pole, a separately-cannulated ostium + target), and **tortuous right common iliac** (access
  difficulty). Each preserves the welded ostia + femoral access endpoints.
- **Left lower-extremity runoff** variant (SFA → profunda → popliteal → AT/PT/peroneal trifurcation +
  BTK targets) — the high-volume PAD/CLI territory and the contralateral-crossover skill, previously
  absent. Connectivity-gated (all 7 branches weld; reaches the tibial level). Far caudal to the
  abdomen, so it needs the new table pan to view.
- Gated by `anatomy.test.ts` (compiles, finite/monotonic centerlines, every ostium stays welded, and
  the pathology actually takes — aneurysmal radius bulge, stenotic pinch, tortuous arc length).

### Professional minimal IR-workstation UI (`src/app.tsx`, `src/styles.css`)
- New information architecture: **live controls** (view + fluoro mode, target, C-arm with ±5° quick-step
  buttons, image windowing, instrument) separated from a **collapsible Setup** disclosure (access side,
  scenario/anatomy, sidecar load, keyboard layout).
- **Navigation metrics bar** beneath the image (wire depth, tip→target + status, contrast, procedure
  time, fluoro time, dose) — the workstation pattern, replacing the tall metrics sidebar.
- **Approach panel** with a screen-space compass (arrow toward the target in image space + distance +
  in-target state) driven by a new `metrics.tipDir` projection.
- **Run debrief** (ROADMAP Phase-1 item) — on target-reached, a summary card: procedure time, fluoro
  (beam-on) time, DAP dose, wire length used, and path efficiency (straight-line chord ÷ wire used).
  The practice feedback loop, built entirely from telemetry already tracked.
- **Table pan** — shift-drag shifts the C-arm isocenter (clamped ±22 cm) so the operator can examine a
  region at magnification; the prerequisite for viewing the peripheral runoff below the abdomen.
- **Measurement caliper** — click two image points for a magnification-corrected distance (vessel
  diameter, lesion length, device sizing) computed at the isocenter plane from the SID — the core
  intervention-planning measurement every IR workstation has.
- Console keys (view/inject/reset) moved to a tidy right-panel cluster; hint clutter removed.

### Engineering notes
- Physics hot path **untouched** — `stepMs`, `tangentAssemblies=32`, `elementForceEvals=11424` identical
  to the Phase-G baseline. Per-frame render allocations eliminated (in-place contrast buffer + scratch
  projection vectors); bone merged to 3 draw calls.
- The headless `browser:physics` smoke still exhibits the **documented feed-splice flake** (a
  segment-stretch spike when the software-WebGL loop starves under host CPU load → `dt` clamps → the
  compliant feed injects a big chunk). It passes clean when runs are isolated; the spike runs larger
  under heavy back-to-back load because bone adds software-rasteriser fill cost (irrelevant on a real
  GPU). Proper fix remains harness-side (a `dt` cap on the scripted feed), already tracked for Phase H/V.
  **Re-confirm the smoke on a quiet machine / real GPU.**

## Remaining path to physician-usable (prioritised)

### Near-term, low engine risk
1. **Roadmap / last-image-hold** — freeze a peak-contrast DSA frame and composite it faintly under the
   live image, so the operator navigates a vessel map without re-injecting (the most-used selective DSA
   mode). Reuses the DSA buffers.
2. **Vessel labels on the image** — project branch names to screen (DOM overlay), the navigation/teaching
   cue a trainee reads off the fluoro. Overlay only, no engine change.
3. **Anatomy calibration + more variants** — finish morphometry calibration (renal asymmetry, aortic
   bifurcation) and author the high-yield variant library (Michels I/III/VI, accessory renals, ostial
   stenosis). Pure `AnatomyDoc` data, zero engine change.
4. **Visual verification pass** — capture 3D / live-fluoro / DSA / roadmap screenshots for review (was
   blocked this session by the autonomous browser-permission denial; `npm run dev` shows it live).

### Targeted physics fidelity — adversarial design + EMPIRICAL findings (2026-06-11)

A workflow fanned out one engineer per realism gap, each producing a test-gated proposal, then ran two
adversarial safety reviewers per proposal against the documented stability cliffs + calibrated gates.
The review itself killed two proposals on mechanically-false premises, and the **empirical gates the
spec mandated then killed the two it had passed** — an important result: the shipped constants sit at a
validated frontier, and naive constant-tweaks regress the calibrated gates.

- **Two-way coax bump (`COAX_DIRECT_OUTER_MASS_SCALE` 0.01→0.015)** — REVERTED. Even the de-risked
  0.015 (review rejected 0.02 as a cliff-jump) broke containment: inner-wire wall penetration ~0.39 cm
  (gate 0.05) and PUSHABILITY deep-climb collapsed to ~9 cm. The distribution is a strict linear
  multiplier, so the ~0.04 cm near-concentric clearance is exceeded under real navigating load well
  before the old sweep's 0.03 "ceiling". A stronger sheath-recoil cue genuinely needs the **Phase-J
  unified Schur contact solve**, not a constant.
- **Coax friction `μ_io` 0.004/0.002 → 0.012/0.006** — REVERTED. The 3× bump made the wire stall and
  buckle inside the sheath instead of telescoping through it (deep climb 43 cm → 10 cm; `climb@36 ≈
  climb@12`). The wire↔catheter interface is more lubricated than wire↔wall, so a near-frictionless
  slide is physically correct here.
- **Twist damping `τ_ω` 0.1→0.075** — DEFERRED (proposal was *inverted*: `whip = Jt/(τ_ω·dts)` grows as
  τ_ω shrinks, so lowering it makes the wire feel *more* locked-up, not snappier).
- **Feed-force cap 5 N→1 N** — DEFERRED (under-specified; invents a nonexistent override field; high
  PUSHABILITY risk — a 5× drop with a hard-inlet sheath that can't compensate).

**Conclusion for "wire/sheath feels unrealistic":** the elastic/contact physics is validated and not
improvable by constant tweaks. The real felt-realism levers are structural. One — **device-stiffness
presets** — turned out to be landable safely (below); the others remain gated workstreams: **the
Phase-J Schur contact solve** (true two-way coax + compliant sheath feed) and **load-dependent J-tip**
(Phase I). Neither is safe as a quick change.

### Device-stiffness presets — LANDED (2026-06-11)
The "which wire do I reach for?" decision, now a UI control (Standard / Stiff support / Soft). Built on
the **validated `bendComplianceScale` lever** (α_bend ∝ 1/EI, read by the direct beam through the
material field) rather than new machinery: profiles are `{1, 0.5, 2}` → realised shaft EI `{12, 24, 6}`
N·cm² — exactly the scales the realised-EI cantilever gate **already proves to within 5%**, and inside
the solver's validated conditioning range (the workflow's "6× EI drop is instability territory" concern
was about EI≈2 / scale 6; the soft profile is scale 2 = EI 6, the low end of the 0.035″ band). Plumbed
store → Viewport (rebuilds the wire on change) → app selector, defaulting to Standard so the shipped
behaviour is byte-identical. Gated by a new navigation test: each profile stays finite + contained
(≤0.05 cm) on the real coax, and the support-class wires (standard/stiff) advance past the seed; the
soft wire is gated on stability only (it trades push support for trackability — that asymmetry is the
realism). This is the first felt "material behavior" lever a trainee can actually choose.

### Chirality bug — root cause PINPOINTED (2026-06-11), fix scoped
Left-sided selective tasks navigate worse than right (~19 cm vs ~9 cm climb; x-mirror asymmetry
~27–52% on the direct lane). Root cause located: the tip precurve axis vs `buildAccessFrame`
handedness (`insertion.ts:39`). For the femoral entry `ref = world-X`, so director-X is mirror-clean
(`u'=mirror(u)`) but director-Y flips (`v'=−mirror(v)`); the precurve `(κ,0,0)` curls the tip toward
−director-Y — the flipping axis — so the J points the wrong way in the mirrored system. The obvious
one-line fix (precurve about director-Y, curl toward the mirror-clean +director-X) was **empirically
tested and reverted** — it is reflection-symmetric but does not aim up-vessel (PUSHABILITY deep-climb
43→5.7 cm). So the navigation-effective precurve direction is intrinsically the mirror-asymmetric one;
the real fix must derive the precurve PLANE from the local vessel **osculating geometry** (aims
up-vessel AND mirrors), a redesign. Scoped here + in code comments so the next attempt skips the dead
end. Fix before any clinician feel pass so the evaluation isn't on a known-asymmetric simulator.

### Data + validation (the actual "physician-usable" gate)
9. **License-clean real anatomy** — run the DICOM→TotalSegmentator→VMTK→sidecar pipeline on a confirmed-
   redistributable CTA (or ship morphometry-calibrated synthetic trees until one is confirmed).
10. **Clinician credibility gate** (ROADMAP Phase 0 / physics Phase V) — the real exit criterion:
    a practicing IR confirms the fluoro reads as a C-arm and advance/torque/branch-engagement feels
    plausible. Analytic gates prove the math; only a clinician proves the feel.

**Bottom line:** "physician-usable for planning and practice" is gated on items 9–10 (real licensed
anatomy + clinician sign-off), which need inputs outside the codebase. Everything in the codebase's
control — perceptual fluoro realism, the workstation UI, anatomy breadth, and the additive physics
fidelity — is now either landed or scoped with a clear, low-risk path.
