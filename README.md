# IRsim — Interventional Radiology Navigation Trainer

[![CI](https://github.com/Remedy92/Irsim/actions/workflows/ci.yml/badge.svg)](https://github.com/Remedy92/Irsim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Repository:** https://github.com/Remedy92/Irsim  
**Live demo:** _(deploying — see Vercel link below)_

An open-source, web-first simulator for practicing endovascular navigation: push a
guidewire and sheath from a vascular access point to named anatomic targets, viewed in
**both** an interactive 3D scene **and** a stylized 2D fluoroscopy image rendered from the
same geometry and the same C-arm. It includes a built-in public demo and a prototype,
session-only local DICOM CT → segmentation → simulator workflow.

> **Intended use:** educational / cognitive-spatial rehearsal with *simulated, relative*
> metrics. The local DICOM feature is a non-validated, single-trunk prototype. **Not** a
> medical device, not clinical planning, and not a substitute for supervised training.

This repository was rebuilt from scratch after a research phase (see `ROADMAP.md`). The
prior visual mockup is preserved under `.archive/prototype-v0/`.

## Why this architecture

The single most important decision: **render both views from one shared C-arm camera over
the same vessel + instrument meshes.** The 3D view is lit; the fluoroscopy view is a
Beer–Lambert mesh-attenuation pass (`I = exp(−Σσ·t)`) tone-mapped to grey with film grain
and a collimator vignette. Because both views come from identical geometry and camera, they
are always geometrically consistent — which is exactly what makes the fluoro mode credible,
and is the direct fix for the old prototype's fake grey-orthographic "fluoro".

The guidewire and sheath are dynamic co-rotational beam rods constrained by vessel-wall and coaxial
contact — not hardcoded paths. The viewport advances that solver at a fixed 60 Hz independent of the
display refresh rate.

## Design decisions (settled with the project owner)

| Decision | Choice |
|---|---|
| Distribution | **Open source**; shipped anatomy assets kept to permissive / public-domain licenses |
| 2D fluoroscopy | **Stylized mesh-attenuation X-ray** (runs everywhere, no CT volume needed) |
| Delivery | **Web-only first** (static URL; Electron desktop is a later, optional path) |
| Physics | **Dynamic co-rotational beam / Cosserat runtime** with orientation-coupled bend/twist, vessel and coax contact, and calibrated regression gates |

## Stack

- **Vite + React 19 + TypeScript** — static-hosted, zero-install.
- **Three.js + @react-three/fiber** — 3D rendering; manual dual-pass render loop.
- **zustand** — simulation/UI state.
- **dicom-parser + a dedicated stateful Web Worker** — sequential local CT decoding, acquisition-source
  and patient-axis MPR review, operator-seeded tracking, sparse labelmap edits, topology
  gating, and identifier-free runtime conversion.
- Custom **dynamic beam/Cosserat** physics and custom **fluoro attenuation** shaders.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build
npm run typecheck
npm run browser:dicom
npm run browser:dicom:j2k

# Optional content-pinned real-pixel JPEG 2000 interoperability gate. These are
# DCMTK/GDCM transcodes, not scanner-originated vendor-compression evidence.
npm run fixture:dicom:j2k:fetch -- --accept-license
npm run fixture:dicom:j2k:verify

# Optional real contrast-CT gate. Review the linked TCIA/CC BY 3.0 terms first.
npm run fixture:dicom:fetch -- --accept-license
npm run browser:dicom:real

# Optional arterial CTA engineering gate. Applies the stricter CC BY 4.0 source terms;
# the automated aorta mask is not expert-corrected clinical ground truth.
npm run fixture:cta:fetch -- --accept-license
npm run fixture:cta:derive
npm run fixture:cta:j2k:derive
npm run fixture:cta:j2k:verify
npm run fixture:cta:verify
npm run fixture:cta:budget
npm run browser:dicom:cta
npm run browser:dicom:cta:j2k:benchmark
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
- Dynamic guidewire/sheath rods that feed independently from femoral access, follow the lumen,
  interact coaxially, buckle, and expose torqueable/steerable wire-tip control.
- Contrast injection, named targets, and live (simulated) metrics: deployed length,
  tip-to-target distance, target-reached.
- Local multi-file DICOM CT import in the browser, original acquisition-image/window-level review plus
  physically isotropic patient axial/coronal/sagittal LPS views with trilinear HU, discrete overlays,
  fixed orientation labels, tilted-stack padding rejection, and exact worker-side
  source-voxel mapping through opaque bounded frame tokens,
  operator-seeded deterministic single-trunk tracking, per-slice component correction, bounded
  physical add/remove 3D brush correction from any source plane, seed-preserving
  endpoint trimming with undo/session provenance, topology-blocked fail-closed review, revision-specific first/quartile/last/seed
  axial checkpoints plus seed-aligned patient-coronal/patient-sagittal obligations, a separate review attestation, and conversion to a variable-radius
  simulator lumen.
- Manifest-pinned, opt-in portal-venous real-DICOM and arterial CTA-derived gates complement the
  generated DICOM series without checking medical images into the repository. They verify source
  rendering, bounded overlay/seed behavior, production decoding, seeded topology/attestation,
  network silence, and zero browser storage. The arterial gate also records support-scoped overlap
  with an uncorrected automated aorta mask; this is engineering evidence, not clinical validation.
- A separate opt-in JPEG 2000 gate pins two real-pixel CT objects written by DCMTK/GDCM, exact file/
  frame/fragment hashes, a paired uncompressed HU oracle, an independently decoded HU digest,
  populated/empty BOTs, a three-fragment derivative, and truncation failures. These are transcodes,
  not proof of scanner-vendor compression. A lazy 538-slice production-processor gate also pins broad
  native-study runtime/memory ceilings and verifies every prior raw source buffer is cleared. A
  deterministic 538-slice JPEG 2000 derivative has its own exact production-decoder/MPR preflight and
  sampled real-browser-worker benchmark command; same-family encoding is throughput evidence only.
- A dedicated close-case action that returns to the public demo and clears application-level
  in-memory case state; no upload, analytics, or browser-storage path exists.

## Known limitations (intentional, see ROADMAP)

- Built-in anatomy is parametric. Local DICOM v1 supports uncompressed or JPEG 2000 Lossless,
  single-frame CT and
  original acquisition review plus fixed patient-axis MPR. The reformats are deterministic engineering
  context views, not a diagnostic/oblique/curved MPR workstation. It tracks one contrast-enhanced trunk and can
  still bridge adjacent bright anatomy. Its editable representation is a sparse single-trunk
  per-slice labelmap with component replacement, bounded brush edits on tracked slices, and endpoint
  trimming—not a full dense voxel mask or contour editor; broader compressed-codec coverage,
  diagnostic MPR tooling, multi-branch segmentation, and CT-derived DRR remain next steps. The native
  and JPEG 2000 decoders sit behind one worker-owned canonical-volume Interface and never introduce a
  parallel full pixel cache.
- Physics is not yet a clinically validated predictive model. The documented unilateral
  outer-follows-inner coupling gap and multi-centimetre stress cases remain expected-failure gates;
  realistic branch cannulation and device-specific validation are still major engineering work.
- Fluoro is a **stylized attenuation render**, not a physically rigorous DRR (no scatter /
  beam hardening). DSA mask-subtraction ships in the fluoro view; a **CT-derived / true VTK.js DRR**
  (patient bone and soft tissue replacing the procedural skeleton) remains a roadmap item.

## Module map

```
src/
  imaging/
    local-dicom.ts        # cancellable browser-local imaging interface
    local-dicom.worker.ts # dedicated decode/segmentation worker
    worker-protocol.ts    # request-correlated identifier-free worker boundary
    dicom-volume.ts       # CT Part 10 decode + patient-space volume ordering
    axial-review.ts       # window/level + exact overlay + seed rendering
    patient-mpr.ts        # fixed LPS MPR + source-voxel mapping
    vessel-segmentation.ts# deterministic extraction + physical 3D brush/geometry rebuild
    segmentation-review.ts# sparse labelmap edits + undo provenance + connectivity/topology gate
    review-gate.ts        # seed + topology + attestation commit invariant
  sim/
    types.ts              # Anatomy / centerline / target / access contracts
    anatomy.ts            # built-in public anatomy
    anatomyDoc.ts         # strict external-anatomy validation + compiler
    cosserat.ts           # active guidewire/sheath mechanics
    store.ts              # zustand sim/UI state
  three/
    fluoro.ts             # attenuation material + fluoroscopy tone-map shader
    vesselGeometry.ts     # variable-radius lumen mesh loft
    Viewport.tsx          # shared C-arm camera + simulation/render bridge
  app.tsx                 # UI shell and anatomy-source workflow
  main.tsx
  styles.css
```
