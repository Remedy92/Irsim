# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project scope
- IRsim is a web-first interventional radiology navigation simulator built with Vite + React + TypeScript + Three.js.
- Runtime is client-side; there is no backend service in this repo.
- `.archive/prototype-v0/` is legacy reference material and not part of the active build/test path.

## Required command lane
- Install deps: `npm install`
- Dev server: `npm run dev` (Vite on `0.0.0.0:5173`)
- Typecheck: `npm run typecheck`
- Test suite: `npm test`
- Build: `npm run build` (runs typecheck first, then Vite build)
- Preview production build: `npm run preview`

### Single-test commands (Vitest)
- Single file: `npm exec vitest run src/sim/cosserat.test.ts`
- Single test case by name: `npm exec vitest run src/sim/cosserat.test.ts -t "rolling the handle (torque) rotates the tip deflection azimuth (twist propagation)"`

## CI contract
- CI (`.github/workflows/ci.yml`) runs: `npm ci`, `npm run typecheck`, `npm test`, `npm run build` on Node 22.
- Match this sequence locally before concluding a change is ready.
- There is currently no dedicated lint script; use typecheck + tests as the verification baseline.

## High-level architecture (read this before making changes)
### Core simulation flow
1. `src/app.tsx` owns UI controls and keyboard bindings and writes intent into Zustand (`useSim`).
2. `src/three/Viewport.tsx` owns the render/engine loop (`useFrame`) and is the bridge from state -> physics -> rendering -> metrics.
3. `src/sim/store.ts` is the control/telemetry contract:
   - inputs: C-arm angles, deployed length, steering, torque, injections, target
   - outputs: depth, tip-to-target, reached status, contrast level
4. `Viewport` writes computed metrics back into the store; `App` reads them for HUD/panels.

### Shared-camera dual-view rendering model
- The key design decision is one shared C-arm camera and geometry for both views (`3d` and `fluoro`), implemented in `src/three/Viewport.tsx`.
- 3D mode: vessel + wire meshes rendered with lit materials.
- Fluoro mode:
  - attenuation pass materials from `src/three/fluoro.ts` accumulate optical depth into a float render target,
  - fullscreen tone-map shader converts depth to grayscale fluoroscopy with vignette/grain.
- If geometry/camera math changes, validate both modes because they are intentionally coupled.

### Anatomy and physics boundaries
- `src/sim/types.ts` defines the stable domain contract (`Anatomy`, branches, centerlines, targets, access/provenance).
- `src/sim/anatomy.ts` currently generates procedural placeholder anatomy implementing that contract.
- `src/sim/cosserat.ts` (orientation-based Cosserat/XPBD rod) is the **active runtime physics**, driven via `CoaxialAssembly` (guidewire inside sheath) in `Viewport`. Supporting modules: `units.ts`, `xpbd.ts`, `material.ts` (graded `MaterialProfile`/field), `insertion.ts` (material-injection BC), `contact.ts` (in-loop normal + stick-slip + spin friction), `lumen.ts` (capsule-chain SDF + branch hysteresis), `coax.ts` (coaxial coupling). Design: `docs/physics-design-cosserat-xpbd.md`.
- `src/sim/rod.ts` is the **legacy PBD rod, now dormant** (imported by nothing). Kept for reference; do not extend.
- Known live-path deferrals (see workflow review): inlet uses a hard kinematic anchor rather than the compliant force-capped motor; coaxial support is one-sided (outer treated as rigid, `COAX_OUTER_MASS_SCALE=0`); orientations are quasi-static (no angular-velocity whip — one `it.todo` on tip-azimuth fidelity). The fuller implementations exist and are unit-tested but are off in the live assembly.

## Codebase-specific gotchas
- `src/main.tsx` intentionally omits React StrictMode to avoid dev double-mount WebGL resource duplication; keep this behavior unless resource disposal is explicitly implemented.
- `Viewport` rebuilds wire `TubeGeometry` every frame and disposes previous geometry; preserve disposal behavior when touching this path.
- Test files are configured by Vite/Vitest as `src/**/*.test.ts` (`vite.config.ts`), so keep new simulation tests in that pattern.
