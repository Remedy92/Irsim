# IRsim Roadmap

Derived from the multi-agent research + adversarial critique phase. Phases are gated:
each one's exit criteria must hold before committing to the next.

## Phase 0 — De-risk (current)

Prove the make-or-break bets on real hardware before locking architecture.

- [x] Shared C-arm camera renders the same geometry as both a lit 3D view and a grayscale
      mesh-attenuation fluoroscopy view.
- [x] Stable elastic guidewire that feeds from access, follows the lumen, and has a
      torqueable/steerable tip.
- [x] Contrast injection, named targets, simulated metrics, runnable static web app.
- [ ] **Clinician credibility gate:** a practicing IR clinician confirms (a) the fluoro view
      reads as a C-arm image, and (b) advance/torque/branch-engagement feels plausible.
      Define explicit pass/fail before the review.
- [ ] Portability: confirm WebGL2 baseline on a clinic laptop; verify the iPad/iOS Safari
      fluoro path (test `EXT_float_blend`; add a half-float accumulation fallback if absent).

## Phase 1 — MVP (10–14 weeks)

A clinician pushes a wire + sheath from femoral access to **one** named arterial target,
sees it in both views, and gets a debrief — on generic anatomy, honestly framed.

- Asset pipeline run end-to-end on one license-clean CTA (TotalSegmentator → VMTK centerlines
  + radii → glTF + targets JSON sidecar + provenance/license manifest; strip PHI). Replaces
  `sim/anatomy.ts`.
- Second concentric instrument (sheath) as a coaxial rail over the wire; device-active switching.
- Gaming-resistant "target reached" (stable tip dwell in the ostium, arrived via the correct vessel).
- C-arm angulation + one contrast run; DSA mask-subtraction if time allows.
- Debrief screen (procedure time, simulated fluoro time, path efficiency, wall-contact count)
  + deterministic input-and-state replay.
- In-app intended-use statement on every session.

## Phase 2 — Credible trainer

- **Full orientation-based Cosserat rod** (position + quaternion DOFs, stretch-shear +
  bend-twist constraints) layered behind the validated PBD model, **with constraint unit
  tests**. Introduce only if Phase 0/1 show rod feel is the limiting factor.
- Catheter as a third concentric instrument; device-exchange workflow; opt-in gamepad input.
- Scenario library + data-driven authoring (aortoiliac crossover, selective visceral
  cannulation, arch/carotid). 2–3 anatomy variants from additional license-clean CTs.
- Guided mode + free-practice sandbox; richer debrief; consented lightweight telemetry.
- Performance pass (in-place wire geometry updates / instancing); optional WebGPU compute for
  constraint projection only if instrument/DOF load demands it.

## Phase 3 — Fidelity & reach (demand-driven)

- True VTK.js RADON/absorption **DRR from real CT** if radiograph-grade fluoro is required
  (mesh mode stays the everywhere baseline).
- Electron desktop build (offline, local DICOM, rendering parity) if clinic IT or haptics need it.
- SOFA + BeamAdapter offline **oracle** to calibrate the web rod and pre-bake ideal
  trajectories for scoring; optional gVXR validated radiographs.
- Cheap USB roller-encoder input (advance + rotation) via the input-abstraction layer.
- Instructor/cohort mode → triggers a formal intended-use / regulatory review before any
  sale or any move toward patient-specific use.

## Standing risks

- **Physics feel** is the top engineering risk. No browser GPU-Cosserat exists (proven work
  is desktop CUDA), so keep the stable model as the floor and add fidelity behind it.
- **Anatomy pipeline** is an owned sub-project: pin tool versions, script regeneration, keep a
  per-asset provenance/license manifest. Stay on large reliable vessels early.
- **Licensing**: shipped assets must stay permissive/public-domain; research-only and
  share-alike atlases are reference/validation only, never baked into shipped assets.
- **Training validity**: keep claims to education/rehearsal on generic anatomy. Consider
  making fluoro the *primary* navigation view (3D as a debrief aid) so we don't train the
  wrong skill — real IR navigation is fluoro-only.
