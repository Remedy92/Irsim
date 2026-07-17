# Real CTA acceptance fixture selection

**Status: one case acquired, deterministically derived, and engineering-gated; expert landmark review remains open.**

IRsim now has two complementary DICOM acceptance needs:

1. Real DICOM objects and real contrast-CT pixels for parser, source-review, privacy, and worker
   behavior.
2. True arterial-phase CTA anatomy with a vascular reference for segmentation and topology behavior.

The opt-in TCIA Pancreas-CT fixture covers the first need. It is portal-venous rather than arterial
phase, so it must not be presented as CTA accuracy evidence.

## Selected next engineering candidate: AortaSeg-60

[AortaSeg-60 version 1.1](https://zenodo.org/records/18147026) is the preferred next source:

- 60 real aortic CT studies across young normal, older normal, aneurysm, dissection, venous, and
  non-contrast categories.
- True thoraco-abdominal CTA is present in the arterial categories.
- The Zenodo record is tagged CC0 1.0 and versioned at DOI `10.5281/zenodo.18147026`, while the
  included README says CC BY 4.0. IRsim records that discrepancy and applies the stricter CC BY 4.0
  attribution policy; written publisher resolution is still required before any redistribution plan.
- Each case has a CT NIfTI volume and an aortic mask. The category archives have published MD5s;
  `Young.zip` is 2.6 GB with MD5 `e9b02228e6c4f4a3e63c181dd2cada91`.

Important limitations:

- The source is NIfTI, not original DICOM. It can validate arterial pixels/anatomy after a
  deterministic DICOM derivation, but it cannot validate vendor DICOM metadata or transfer syntaxes.
- The masks were produced by TotalSegmentator without manual contour correction. Two radiologists
  technically validated curation/category assignment, but the mask is not expert-corrected vascular
  ground truth.
- The full dataset is about 16 GB and category downloads are 2.5–2.8 GB. CI must use one curated,
  content-pinned case rather than downloading a category archive on every run.

## Implemented engineering fixture

`Young_05` is now pinned in `fixtures/real-dicom/aortaseg60-young05-source.json`. The opt-in fetcher
uses HTTP byte ranges to retrieve the included README and only the selected image/mask ZIP entries;
it verifies ZIP offsets, compression method, CRC metadata, sizes, and output SHA-256 values. It does
not claim to verify the published whole-archive MD5 because it intentionally does not download all
2.6 GB.

The derivation command validates the 512 × 512 × 538 signed-int16 NIfTI geometry, affine, HU scaling,
mask voxel count/bounds, and masked-HU median. It then creates deterministic identifier-neutral
single-frame Explicit VR Little Endian CT Part 10 objects. Because the source NIfTI lattice is
left-handed, stored rows are flipped while the LPS origin and column direction are updated; this
preserves physical voxel coordinates and produces a conventional right-handed axial display. The
derived DICOM aggregate fingerprint is pinned in both manifests.

The production decoder/tracker verification proves exact HU equality for all 141,033,472 voxels after
the documented source-row transform and rescale, and currently observes:

- Seed source slice 301, row 284, column 291; decoded seed value 260 HU and inside the automated mask.
- 325 centerline samples across source slices 0–325 (60.41% volume coverage), with passing structural
  single-trunk topology.
- The automated aorta mask exists on source slices 190–497; 135 mask-bearing slices overlap the
  track, or 43.83% of its slice support.
- On those overlapping slices only: reference recall 0.889, Dice 0.880, labelmap precision 0.872,
  and 97.78% of centerline samples inside the mask.
- Whole-mask recall is 0.169. The tracker omits the superior aorta above source slice 325, and the
  path below source slice 190 lies outside this aorta-only reference and therefore has no identity
  claim. The proposal regression on source slice 163 is also outside the mask and is explicitly not
  used as a vascular oracle.
- The browser gate renders all six current-revision review checkpoints (first, quartiles, last, and
  seed) before enabling the still-separate attestation; zero storage and same-origin-worker-only
  traffic remain mandatory. It saves and SHA-256-hashes the raw 512 × 512 checkpoint PNGs under the
  selected output directory's `source-checkpoints/` folder. It also saves seed-aligned 512 × 1370
  patient-coronal/patient-sagittal LPS context frames under `source-reformats/`, proves both
  marker selections map to source voxel slice 300 / row 284 / column 291 (displayed slice 301), and
  requires both frames separately for the same revision without changing or satisfying the axial
  checkpoint obligations.
- The same real-worker gate keeps from displayed source slice 82, reducing the track from 325 to 244
  samples while retaining the seed; the trim forces six new acquisition frames plus both patient-MPR context
  frames. Undo restores all 325 original samples and forces the original six-plus-two review again. This proves scope-control
  mechanics, not that slice 82 is a clinically correct endpoint.

These values are bounded in the derived manifest and emitted to
`output/fixtures/aortaseg60-young05-dicom/REFERENCE-OVERLAP.json`. They detect decoder, orientation,
tracking, and labelmap regressions. They do not turn uncorrected TotalSegmentator output into clinical
ground truth or prove whole-aorta completeness, branch identity, pathology performance, or procedure
planning suitability.

The clinician handoff is `docs/templates/arterial-cta-expert-review.md`. It binds reviewer judgments
to source/derived hashes, the six acquisition checkpoints, two patient-MPR context frames, explicit omitted/unvalidated ranges, and
bounded landmark/topology assertions. An unsigned template or rendered-frame hash is not clinical
sign-off; retain the completed approval in the organization's controlled quality system.

Reproduce locally after reviewing the upstream terms:

```bash
npm run fixture:cta:fetch -- --accept-license
npm run fixture:cta:derive
npm run fixture:cta:verify
npm run browser:dicom:cta  # requires a running dev server
```

## Required curation protocol

1. **Done:** range-fetch and content-pin `Young_05` without placing source or derived pixels in Git.
2. **Done:** record source-entry hashes, geometry, license discrepancy, citation, version, and
   selection rationale beside the fixture manifests.
3. **Done:** convert deterministically to uncompressed Explicit VR Little Endian CT Part 10 objects,
   preserve voxel geometry/HU scaling, use neutral synthetic metadata/fixed derived UIDs, and validate
   the result through the production decoder.
4. **Done as engineering evidence:** gate browser source rendering, seeded tracking, topology,
   attestation, privacy, and support-scoped overlap with the uncorrected automated aorta mask.
5. **Open:** have an interventional radiologist review the chosen CTA and record bounded, non-identifying
   expectations: aortic lumen seeds, arch/visceral/iliac landmarks, expected visible branches,
   known mask errors, and slices unsuitable for assertions.
6. **Open:** obtain an independently corrected aorta/branch reference and gate centerline location,
   radius, completeness, topology, and fail-closed review against expert-approved expectations.
7. **Standing:** retain the TCIA DICOM fixture for original real-object coverage and generated fixtures for edit,
   discontinuity, undo, attestation, identifier-canary, and fallback failure paths.

## Other candidates reviewed

- **Aortic Dissection Dataset and Segmentations** — true type-B dissection CTA with expert true/false
  lumen annotations, CC BY 4.0, DOI `10.6084/m9.figshare.22269091`, 7.28 GB. Strong pathology fixture
  after the normal CTA gate; too large and complex for the first arterial case.
- **AVT (Aortic Vessel Tree)** — 56 multicenter CTA volumes with semi-automatic vessel-tree masks.
  The aggregate Figshare page says CC BY 4.0, but the publication states that component collections
  retain CC BY-NC-SA and EULA terms. Do not use for an enterprise/commercial fixture until per-case
  provenance and redistribution rights are resolved.
- **OsiriX Panoramix CTA** — familiar teaching data, but research/teaching-only terms make it
  unsuitable for enterprise redistribution.

## What this still will not prove

One curated CTA is an engineering regression fixture. Enterprise and clinical evidence still require
multi-vendor, multi-kernel, multi-phase, normal/pathology, and independent-site cases; expert-corrected
branch/topology references; predefined accuracy metrics; blinded review; and traceability into the
risk-management and clinical-validation system.
