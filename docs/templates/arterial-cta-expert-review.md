# Arterial CTA engineering-fixture expert review

> **Template status:** unsigned worksheet. Completing this document can establish bounded expert
> expectations for one engineering fixture; it does not validate IRsim for patient care. Store the
> signed record in the controlled quality system, not in a public repository if reviewer identity or
> other confidential information is included.

## 1. Fixture and software identity

| Field | Value |
|---|---|
| Fixture | AortaSeg-60 v1.1 `Young_05` |
| Source record | <https://zenodo.org/records/18147026> |
| Source manifest | `fixtures/real-dicom/aortaseg60-young05-source.json` |
| Derived manifest | `fixtures/real-dicom/aortaseg60-young05-derived.json` |
| Source image SHA-256 | `18873d751917e113428b9e5b8a49084ceb2c6418636c2b22b684109555c70723` |
| Source mask SHA-256 | `aeb86208207bf45ad21a916031f97c1204b437444348cf5247597c24653418e5` |
| Derived DICOM content SHA-256 | `62db825384883737f13ca039de225fa2b02263330de0e1329e7ad62c0afc59db` |
| Dimensions / spacing | 512 × 512 × 538 / 0.490234 × 0.490234 × 1.25 mm |
| Software commit / build | _record exact Git commit and production artifact identity_ |
| Review workstation / display | _record approved workstation, browser, display and calibration_ |
| Evidence directory | `output/browser-aortaseg-cta-checkpoint-review/source-checkpoints/` |
| Orthogonal context directory | `output/browser-aortaseg-cta-checkpoint-review/source-reformats/` |

License note: the Zenodo metadata says CC0, while the included README says CC BY 4.0. IRsim applies
the stricter CC BY 4.0 attribution policy. Resolve the discrepancy with the publisher before any
redistribution decision.

## 2. Reviewer

| Field | Reviewer entry |
|---|---|
| Name / controlled identifier | |
| Credentials and specialty | |
| Interventional territory experience | |
| Institution / role | |
| Review date (UTC) | |
| Conflict-of-interest statement | |

## 3. Source acquisition review

Record pass/fail and a concise rationale for each item.

| Question | Pass / fail | Rationale / excluded slices |
|---|---|---|
| The series is arterial-phase CTA suitable for the intended aortoiliac engineering assertions. | | |
| Stored axial orientation is conventional radiological display and left/right is correct. | | |
| Cranial/caudal slice ordering and 1.25 mm spacing are correct. | | |
| Patient axial/coronal/sagittal LPS views have the expected R/L/A/P/H/F orientation, physical aspect, seed location, and black padding where the tilted source volume has no samples; they are not treated as a diagnostic workstation. | | |
| Aortic lumen enhancement supports the configured 160–650 HU threshold on the asserted region. | | |
| Motion, metal, truncation, calcium, streak, or partial-volume artifact does not invalidate each accepted assertion. | | |
| The automated aorta mask's known errors and omissions have been identified. | | |

## 4. Current seeded-trunk checkpoint review

The current deterministic track contains 325 samples over displayed source slices 1–326. The
automated aorta mask exists over displayed slices 191–498. Therefore slices 1–190 of the track have
no aorta-mask identity evidence, and the superior aorta above slice 326 is omitted. Do not approve a
whole-aorta, whole-tree, or branch-identity claim from this track.

Review the exact PNG hashes recorded in `browser-real-dicom-smoke.json` and the interactive source
volume. The report includes six acquisition checkpoints plus seed-aligned patient-coronal and patient-sagittal context
frames. A rendered checkpoint only proves that the frame was opened; the reviewer must record the
anatomical judgment below.

If an endpoint is outside the intended trunk, navigate to a tracked source slice and use **Keep from
this slice** or **Keep through this slice**. The application will not allow a trim that removes the
original seed or leaves an unsafe short path. Record the chosen boundary and repeat every acquisition
and patient-MPR review obligation for the resulting revision; trimming does not establish anatomical identity by itself.

For a local false-negative/false-positive on the retained trunk, select its source voxel in any plane
and use the bounded physical **Add 3D brush** or **Remove 3D brush**. Record mode, center source voxel,
radius, affected slices, and changed voxel count from the session provenance. Disconnected regions,
invalid spans, seed removal, and empty components fail closed. Repeat the complete six-plus-two review
for the resulting revision. This sparse correction is not a diagnostic contouring workstation.

| Displayed slice | Role | Intended anatomy / landmark | Overlay follows intended contrast lumen? | Artifact / correction / exclusion |
|---:|---|---|---|---|
| 1 | Track inferior endpoint; outside aorta-mask extent | _reviewer identifies structure_ | | |
| 82 | Inferior quartile; outside aorta-mask extent | _reviewer identifies structure_ | | |
| 163 | Midpoint / automatic-proposal regression; outside aorta-mask extent | _proposal is not a vascular oracle_ | | |
| 244 | Superior quartile; inside aorta-mask extent | _reviewer identifies structure_ | | |
| 301 | Explicit seed; inside aorta-mask extent | Abdominal aortic lumen candidate | | |
| 326 | Track superior endpoint; inside aorta-mask extent | _reviewer identifies stop reason_ | | |

The patient-MPR context frames are fixed LPS reformats of the same HU volume and sparse overlay.
Trilinear HU and nearest-neighbour labelmap membership help expose longitudinal discontinuity and
adjacent anatomy. They are separate required context frames for each revision, but do not satisfy the
six acquisition checkpoint obligations or provide arbitrary oblique, curved, or diagnostic MPR.

| Context frame | Expected source selection | Anatomical continuity / adjacent false-positive review | Accept / reject |
|---|---|---|---|
| Patient-coronal LPS MPR | seed-aligned plane with H/F and R/L edge labels; marker maps to slice 301 / row 284 / column 291 | | |
| Patient-sagittal LPS MPR | seed-aligned plane with H/F and A/P edge labels; marker maps to slice 301 / row 284 / column 291 | | |

## 5. Landmark and topology expectations

Record non-identifying, bounded assertions suitable for a future manifest. Use explicit slice ranges
and millimetre tolerances. Do not use an anatomical label unless it is confirmed here.

| Assertion | Expected slice/range | Expected location/radius/topology | Tolerance | Accept / reject |
|---|---|---|---|---|
| Seed lies in intended arterial lumen | 301 | row 284, column 291 | _define_ | |
| Inferior tracked endpoint identity | 1 | _define or exclude_ | _define_ | |
| Aortic bifurcation | | | | |
| Renal / visceral landmark visibility | | | | |
| Superior tracked endpoint and omission | 326–498 | _define acceptable scope or reject_ | | |
| Adjacent venous/bone false-positive risk | | | | |
| Centerline location within accepted aorta segment | | | | |
| Radius bounds within accepted aorta segment | | | | |
| Required manual component corrections | | | | |

## 6. Decision

- [ ] Accept only the listed bounded source-rendering assertions as an engineering regression.
- [ ] Accept the listed seeded-trunk assertions after the specified corrections are implemented.
- [ ] Reject this case/track for seeded-trunk acceptance; reason below.
- [ ] Require independent corrected aorta/branch annotation before any further claim.
- [ ] Confirm that no statement here supports clinical use, whole-aorta completeness, branch-tree
      accuracy, pathology performance, or device–vessel prediction.

Decision rationale and mandatory follow-up:

_enter controlled rationale_

Reviewer signature / controlled approval: ____________________  Date: __________

Engineering witness: _________________________________________  Date: __________
