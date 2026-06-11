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
npm run dev          # Vite dev server on 0.0.0.0:5173
npm run typecheck    # tsc --noEmit
npm test             # vitest run (whole suite)
npm run build        # typecheck THEN vite build — the release gate
npm run browser:physics   # headless physics smoke (scripts/browser-physics-smoke.mjs → output/)
```

There is **no lint script.** Typecheck + tests are the verification baseline.

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
- **`src/sim/beamfem/` — dynamic co-rotational beam FEM (active development, flag-gated).** This
  is **not** a separate runtime; it is wired *into* `CosseratRod`. When a rod's
  `params.useDirectSolve` is true, its per-frame elastic+bend solve becomes the dynamic
  co-rotational beam (real EI, substep-invariant, dynamic twist) instead of the XPBD projection.
  `beamfem/dynamic.ts` is the implicit backward-Euler step; `beamfem/integration.ts` adapts the
  rod's `MaterialField` compliances ↔ the beam's per-element rigidities + lumped mass + nodal
  frames; `element.ts`/`mass.ts`/`so3.ts`/`blocktridiag.ts` are the FEM kernels. Design:
  `docs/physics-design-dynamic-corotational-beam.md`. As of the Phase-G flip the **shipped presets are
  direct** (`SHIPPED_GUIDEWIRE = GUIDEWIRE_DIRECT`, `SHIPPED_SHEATH = SHEATH_DIRECT`,
  `useDirectSolve: true`); the legacy XPBD lane in `cosserat.ts` remains for comparison until Phase H
  deletes it.
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

## Gotchas
- `src/main.tsx` deliberately omits React `StrictMode` — dev double-mount duplicates WebGL
  resources. Keep it off unless full resource disposal is implemented.
- `Viewport` rebuilds the wire `TubeGeometry` every frame and disposes the previous one. Preserve
  that dispose-before-replace behavior when editing that path.
- Known live-path deferrals (fuller versions exist and are unit-tested but are off in the live
  assembly): the inlet uses a hard kinematic anchor rather than the compliant force-capped motor;
  coaxial support is one-sided (`COAX_OUTER_MASS_SCALE=0`); orientations are quasi-static (one
  `it.todo` on tip-azimuth whip fidelity).

## Reference docs
`ROADMAP.md` (phase gates, standing risks) and `docs/` hold the research + design rationale —
`physics-review-guidewire-sheath-options.md`, `physics-beam-integration-architecture-plan.md`,
and `anatomy-realism-roadmap.md` are the live ones. `AGENTS.md` is the WARP-oriented sibling of
this file; it predates the `beamfem` integration, so trust this file's physics-layer description
where they differ.
