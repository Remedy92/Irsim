# IRsim — Interventional Radiology Navigation Trainer

An open-source, web-first simulator for practicing endovascular navigation: push a
guidewire and sheath from a vascular access point to named anatomic targets, viewed in
**both** an interactive 3D scene **and** a stylized 2D fluoroscopy image rendered from the
same geometry and the same C-arm.

> **Intended use:** educational / cognitive-spatial rehearsal on *generic* anatomy with
> *simulated, relative* metrics. **Not** a medical device, not patient-specific planning,
> not a substitute for supervised clinical training.

This repository was rebuilt from scratch after a research phase (see `ROADMAP.md`). The
prior visual mockup is preserved under `.archive/prototype-v0/`.

## Why this architecture

The single most important decision: **render both views from one shared C-arm camera over
the same vessel + instrument meshes.** The 3D view is lit; the fluoroscopy view is a
Beer–Lambert mesh-attenuation pass (`I = exp(−Σσ·t)`) tone-mapped to grey with film grain
and a collimator vignette. Because both views come from identical geometry and camera, they
are always geometrically consistent — which is exactly what makes the fluoro mode credible,
and is the direct fix for the old prototype's fake grey-orthographic "fluoro".

The guidewire is a real elastic rod (position-based dynamics) constrained inside the vessel
lumen — not a hardcoded path.

## Design decisions (settled with the project owner)

| Decision | Choice |
|---|---|
| Distribution | **Open source**; shipped anatomy assets kept to permissive / public-domain licenses |
| 2D fluoroscopy | **Stylized mesh-attenuation X-ray** (runs everywhere, no CT volume needed) |
| Delivery | **Web-only first** (static URL; Electron desktop is a later, optional path) |
| Physics | **Full Cosserat rod is the goal** — shipped as a stable PBD elastic rod first, with the orientation-coupled bend-twist layered on next, with tests |

## Stack

- **Vite + React 19 + TypeScript** — static-hosted, zero-install.
- **Three.js + @react-three/fiber** — 3D rendering; manual dual-pass render loop.
- **zustand** — simulation/UI state.
- Custom **PBD elastic-rod** physics and custom **fluoro attenuation** shaders (no off-the-shelf web library does either).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build
npm run typecheck
```

### Controls

- **W / S** — advance / retract the wire
- **A / D** (or Q / E) — torque (rotate the tip bending plane)
- **Tip tightness** slider — how sharply the tip deflects
- **C** — inject contrast (fills the lumen on fluoro, then decays)
- **F** — toggle 3D ↔ fluoroscopy
- **Drag the image** — angle the C-arm (RAO/LAO, CRAN/CAUD); **scroll** — zoom (SID)
- **R** — reset

## What works today (Phase 0 foundation)

- Procedural, anatomically-plausible normal arterial anatomy (aorta, arch + great vessels,
  renal arteries, iliacs) with centerlines + per-point lumen radius.
- Shared C-arm camera driving both a lit 3D view and a believable grayscale fluoroscopy view.
- Elastic guidewire that feeds from the femoral access, follows the lumen, buckles, and has a
  torqueable/steerable tip.
- Contrast injection, named targets, and live (simulated) metrics: deployed length,
  tip-to-target distance, target-reached.

## Known limitations (intentional, see ROADMAP)

- Anatomy is a **parametric stand-in**, not a segmented dataset. The asset pipeline
  (license-clean CTA → TotalSegmentator → VMTK centerlines → glTF) replaces it; downstream
  code only depends on the `Anatomy` interface, so the swap is local.
- Physics is a **stable PBD elastic rod**, not yet the full orientation-based Cosserat rod.
  Reliable branch cannulation needs tuning — this is the known #1 engineering risk.
- Fluoro is a **stylized attenuation render**, not a physically rigorous DRR (no scatter /
  beam hardening). DSA mask-subtraction and a true VTK.js DRR are roadmap items.

## Module map

```
src/
  sim/
    types.ts      # Anatomy / centerline / target / access contracts
    anatomy.ts    # procedural normal anatomy (replace via the asset pipeline)
    rod.ts        # PBD elastic guidewire + lumen collision + steerable tip
    store.ts      # zustand sim/UI state
  three/
    fluoro.ts     # attenuation material + fluoroscopy tone-map shader
    Viewport.tsx  # scene build + shared C-arm camera + dual-pass render loop
  app.tsx         # UI shell (panels, controls, metrics, keyboard)
  main.tsx
  styles.css
```
