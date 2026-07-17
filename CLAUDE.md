# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

IRsim is a web-first interventional radiology navigation trainer: push a guidewire + sheath
from femoral access to named arterial targets, rendered in **both** an interactive 3D scene
**and** a stylized 2D fluoroscopy image from the same geometry and camera. Client-side only —
there is no backend in this repo. `.archive/prototype-v0/` is dead reference material, never
part of the build/test path.

## Commands

```bash
npm install
npm run dev          # Vite dev server on 127.0.0.1:5173
npm run typecheck    # tsc --noEmit
npm test             # vitest run (whole suite)
npm run build        # typecheck THEN vite build — the release gate
npm run browser:physics   # headless physics smoke (scripts/browser-physics-smoke.mjs → output/)
npm run browser:dicom     # local-DICOM review/privacy acceptance smoke (→ output/)
npm run browser:dicom:j2k # generated JPEG 2000 Lossless decode/review/privacy smoke (→ output/)
npm run fixture:dicom:j2k:fetch -- --accept-license # fetch hash-pinned DCMTK/GDCM real-pixel objects
npm run fixture:dicom:j2k:verify                   # independent HU/geometry + BOT/fragment/truncation gate
npm run fixture:dicom:fetch -- --accept-license  # fetch + verify the optional public real-CT fixture
npm run browser:dicom:real # real-pixel/source-review gate; requires the fixture and a running dev server
npm run fixture:cta:fetch -- --accept-license    # range-fetch pinned AortaSeg-60 Young_05 source entries
npm run fixture:cta:derive                       # deterministic identifier-neutral NIfTI → DICOM
npm run fixture:cta:verify                       # production decode/track + support-scoped mask overlap
npm run fixture:cta:budget                       # lazy 538-slice production-intake resource ceiling
npm run browser:dicom:cta                        # arterial CTA browser gate; requires fixture + dev server
```

There is **no lint script.** Typecheck + tests are the verification baseline.

Local imaging accepts uncompressed single-frame monochrome CT plus JPEG 2000 Lossless transfer syntax
`1.2.840.10008.1.2.4.90`. The latter is decoded through the exact-pinned, worker-only
`@cornerstonejs/codec-openjpeg/decode` Adapter. Keep it lazy and decode into the one canonical HU
representation; do not add a parallel Cornerstone or ITK full-volume cache. DICOM Pixel Data must
contain the raw codestream, not a JP2 file wrapper. Per PS3.5, preflighted SIZ precision/sign control
decompression when header pixel attributes disagree; matrix/component/reversibility remain bounded
and fail closed.

CI (`.github/workflows/ci.yml`, Node 22) runs `npm ci && npm run typecheck && npm test && npm run build`
in that order. Reproduce that sequence locally before calling a change done.

Single test:
```bash
npm exec vitest run src/sim/cosserat.test.ts
npm exec vitest run src/sim/cosserat.test.ts -t "twist propagation"   # filter by test name
```
Vitest only collects `src/**/*.test.ts` (`vite.config.ts`, node environment) — keep new sim
tests in that pattern or they won't run.

## Architecture

### Engine loop and state contract
`src/sim/store.ts` (zustand `useSim`) is the control/telemetry seam. `src/app.tsx` owns UI
panels + keyboard bindings and writes **intent** (C-arm angles, deployed length, steering,
torque, injection, target) into the store. `src/three/Viewport.tsx` owns the render loop
(`useFrame`) and is the bridge: state → physics step → rendering → metrics, writing computed
metrics (depth, tip-to-target, reached, contrast) back into the store for `App` to display.

### One camera, two views (the core design bet)
Both the `3d` and `fluoro` views render the *same* geometry through *one* shared C-arm camera,
in `Viewport.tsx`. 3D is lit meshes. Fluoro is a two-pass render: attenuation materials
(`src/three/fluoro.ts`) accumulate optical depth (`I = exp(−Σσ·t)`, Beer–Lambert) into a float
render target, then a fullscreen tone-map shader converts depth → grayscale with vignette +
grain. **The two modes are intentionally coupled — any change to geometry or camera math must
be validated in both.**

### Physics layers (this is where the complexity lives)
- **`src/sim/cosserat.ts` — the active runtime physics.** Orientation-based Cosserat/XPBD rod
  (`CosseratRod`), driven via `CoaxialAssembly` (guidewire inner + sheath outer) from
  `Viewport`. Shipped presets `GUIDEWIRE` / `SHEATH` live here so the app and integration tests
  exercise the identical path. Supporting modules: `units.ts`, `xpbd.ts`, `material.ts` (graded
  `MaterialProfile`/field), `insertion.ts` (material-injection inlet BC), `contact.ts` (in-loop
  normal + stick-slip + spin friction), `lumen.ts` (capsule-chain SDF + branch hysteresis),
  `coax.ts` (coaxial coupling). Design: `docs/physics-design-cosserat-xpbd.md`.
- **`src/sim/beamfem/` — the shipped dynamic co-rotational beam FEM.** This is **not** a separate
  runtime; it is wired *into* `CosseratRod` as the only elastic lane after the Phase-H deletion of
  the legacy XPBD rod solve. It provides real EI, substep-invariant integration, and dynamic twist.
  `beamfem/dynamic.ts` is the implicit backward-Euler step; `beamfem/integration.ts` adapts the
  rod's `MaterialField` compliances ↔ the beam's per-element rigidities + lumped mass + nodal
  frames; `element.ts`/`mass.ts`/`so3.ts`/`blocktridiag.ts` are the FEM kernels. Design:
  `docs/physics-design-dynamic-corotational-beam.md`.
- `src/sim/rod.ts` (dormant legacy PBD rod) and `src/sim/beam.ts`/`beam.test.ts` (the experimental
  `beamGain` O(N) banded shaft-fairing) were **deleted at the Phase-G flip** — both were dead/uncalibrated
  and not on the shipped path.

The math is subtle and reference-derived (the design docs cite Kugelstadt & Schömer, Bender,
Crisfield/Battini). Several fixes are load-bearing and called out in code comments — e.g. the
backward-Euler **increment** form in `dynamic.ts`, the **banded numerical Jacobian** tangent
(an analytic-transformK-only tangent left the cantilever ~12× too stiff and killed twist).
Read the relevant design doc before touching solver internals, and lean on the calibrated gates
(`cosserat.test.ts`, `beamfem/*.test.ts`, `validation_calibrated.test.ts`) to catch regressions.

### Anatomy boundary
`src/sim/types.ts` is the stable domain contract (`Anatomy`, branches, centerlines + per-point
lumen radius, targets, access/provenance). `src/sim/anatomy.ts` currently *generates* procedural
placeholder anatomy implementing it. Downstream code depends only on the `Anatomy` interface, so
the planned asset pipeline (CTA → TotalSegmentator → VMTK → glTF) swaps in locally.

### Local imaging boundary
`src/imaging/local-dicom.ts` exposes the `LocalDicomSession` Interface. The dedicated worker owns the
only canonical diagnostic-volume Interface, automatic proposal, editable sparse labelmap, and unified axial/
patient-LPS source-plane renderer; React receives only an identifier-free summary, one requested RGBA frame with
an opaque bounded mapping token, bounded
edit/topology review metadata, and a topology-passing `AnatomyDoc`. Files are read sequentially inside
the worker. Source selection is mapped back to the canonical voxel inside the worker; patient geometry
does not cross into React, frame mappings are bounded, and every segmentation revision invalidates them.
The editable sparse labelmap is the sole owner of the current reviewed overlay. One-slice component
replacement, bounded 0.5–10 mm physical 3D add/remove brushing on
tracked slices, seed-preserving endpoint trimming, and undo retain
identifier-free session provenance and rebuild topology/document/checkpoints inside the worker. An
automatic proposal is never loadable, and a topology-blocked revision carries no simulator document:
seed-confirmed tracking, passing topology, rendered first/quartile/last/seed axial frames plus
seed-aligned patient-coronal/patient-sagittal context for the current revision, and the separate review attestation in
`review-gate.ts` are required. Edit,
undo, and re-track results reset checkpoint evidence and approval. Dispose the session on every
close/retry/load/pagehide path, and do not add network,
browser-storage, identifier, or second-volume Adapters to this Module. `CONTEXT.md` defines these
domain terms; `docs/ARCHITECTURE.md` is the status and roadmap source of truth.

The current patient axial/coronal/sagittal views are fixed LPS reformats with bounded isotropic grids,
trilinear HU, nearest-neighbour sparse-labelmap membership, explicit R/L/A/P/H/F labels, tilted-stack
padding rejection, and exact canonical voxel mapping behind an opaque token. They are intentionally
not described as a diagnostic workstation or arbitrary oblique/curved MPR. They never satisfy an
acquisition-source checkpoint; both seed-aligned longitudinal planes are separate, additional
revision-bound obligations before attestation.

## Gotchas
- `src/main.tsx` deliberately omits React `StrictMode` — dev double-mount duplicates WebGL
  resources. Keep it off unless full resource disposal is implemented.
- `Viewport` rebuilds the wire `TubeGeometry` every frame and disposes the previous one. Preserve
  that dispose-before-replace behavior when editing that path.
- The shipped guidewire uses the compliant force-capped inlet motor. Live navigation still depends
  on heavy translational mass conditioning and staggered contact rather than the planned coupled
  Schur contact/friction solve; honest coax escape and tip-azimuth fidelity remain explicit test
  tripwires. The built-in normal anatomy also has a narrowly scoped first-pass aortoiliac transition
  stabilizer. Treat it as a real-time engineering guard, not general-topology or clinical validation;
  see `docs/ARCHITECTURE.md` for its exact boundary and replacement work.

## Reference docs
`docs/ARCHITECTURE.md` is the central source of truth for the local-DICOM architecture, delivery
status, and ordered next work. `ROADMAP.md` (phase gates, standing risks) and `docs/` hold the wider
research + design rationale. The
**live** docs are: `physics-fidelity-refactor-progress.md` (the refactor tracker — single source of
truth for remaining physics work), `coax-containment-and-stiffness-progress.md` (newest physics-state
record: the live-EI/coax-containment findings), `physics-design-dynamic-corotational-beam.md` (the
shipped solver's design), `hyperrealism-refactor-plan.md` (cross-cutting done/remaining map),
`dicom-anatomy-pipeline.md` (asset pipeline), and `anatomy-realism-roadmap.md` (anatomy Phases 3–5;
its Phase 0–2 recommendations are shipped — see its status banner). Historical decision records live in
`docs/archive/` (`physics-review-guidewire-sheath-options.md`, `physics-beam-integration-architecture-plan.md`,
`physics-design-cosserat-xpbd.md` — the last still documents the contact/lumen/coax derivations that remain
live on both lanes). `AGENTS.md` is the WARP-oriented sibling of this file; it predates the `beamfem`
integration, so trust this file's physics-layer description where they differ.
