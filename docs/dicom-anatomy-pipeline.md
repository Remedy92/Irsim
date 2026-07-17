# DICOM → AnatomyDoc Pipeline — Offline Data & License-Clean Asset Strategy

> **Historical offline asset strategy.** The live local/session-only browser architecture and
> implementation status are now maintained in `docs/ARCHITECTURE.md`. This document remains useful
> for redistributable training-asset licensing; its “never in the browser” runtime decision is
> superseded.

### A decision-grade design for ingesting real-patient CTA geometry into IRsim's `AnatomyDoc` sidecar

*Prepared for the IRsim owner. This doc specifies the OFFLINE pipeline (run on a workstation, never in the browser) that turns a contrast CTA into the JSON sidecar `anatomyDoc.ts` compiles. It does NOT specify runtime TypeScript — the loader/converter is built separately. Every license verdict that carries a SHIP recommendation was verified against the upstream license file or standard in June 2026; citations are inline. This builds on `docs/anatomy-realism-roadmap.md` §6 (Data & Asset Strategy) and §7 (engine/data-model), and corrects three of its license claims where the upstream source disagreed (OpenCCO license, VascuSynth license, and the "outputs user-owned" inference — see §5).*

---

## 0. Scope, output contract, and the honesty frame

**What this pipeline produces.** A single JSON file per anatomy that deserialises into the `AnatomyDoc` TypeScript interface in `src/sim/anatomyDoc.ts` (the *fixed output contract*), then compiles via `compileAnatomy()` into the runtime `Anatomy` graph the physics/lumen/fluoro consume. `src/sim/anatomy.ts` `NORMAL_DOC` is a complete, valid example of that target shape.

**What this pipeline is NOT.** It does not segment in the browser, does not ship DICOM, does not ship any PHI, and does not produce a medical device. IRsim is a **catheter-navigation trainer**: it models wire/sheath advancement, torque, branch selection, and the resulting fluoro image. Every emitted sidecar is **generic — NOT patient-specific** and carries that statement in its provenance block (§4).

**Two hard constraints inherited from the roadmap, applied strictly here:**
1. **License:** anything baked into the shipped MIT repo must be redistributable, permissive/public-domain, with no NC, no share-alike, no all-rights-reserved, and **no unresolved license conflict in the canonical record**. An ambiguous record fails the bar until the rights holder clarifies *in writing* (roadmap §6).
2. **PHI:** de-identification is mandatory and happens **before** any other processing stage touches the data (§2).

**The shortest-path conclusion stated up front (detail in §6):** the first shippable "richer than the placeholder" anatomy should be **procedurally generated + morphometry-calibrated** (synthetic centerlines transformed into IRsim's frame), NOT a redistributed real scan. No public real-CTA collection is confirmed SHIP-able into an MIT repo as of this writing without per-collection written confirmation. A real scan can be *processed* through this pipeline the moment a written license confirmation exists — the pipeline is identical; only the input's redistributability differs.

---

## 1. End-to-end pipeline stages

```
┌─ INPUT: DICOM CTA series (mm, LPS or RAS patient space) ─┐
│                                                          │
▼                                                          │
[1] De-identify (MANDATORY, FIRST)   PS3.15 Annex E        │  offline
▼                                                          │  workstation
[2] Segment       TotalSegmentator default `total` task    │  only — never
▼                                                          │  in browser,
[3] Centerline +  VMTK vmtkCenterlines + vmtkBranchExtractor│  never ships
    radius                                                  │  DICOM/PHI
▼                                                          │
[4] Branch graph + parentage (root vs child-with-ostium)   │
▼                                                          │
[5] Coordinate transform: mm/LPS → cm IRsim body-frame     │
▼                                                          │
[6] Emit AnatomyDoc JSON sidecar + provenance block        │
└──────────────────────────────────────────────────────────┘
   OUTPUT: <anatomy>.json  → deserialises to AnatomyDoc → compileAnatomy()
```

Each stage's outputs inherit the **input data's** license (a tool that merely transforms data does not relicense it). So the license verdict for a baked asset is determined by the CTA collection at stage [0], not by the tools. This is why §5–§6 spend most of their effort on the *input* collections.

### Stage 1 — De-identification (mandatory, runs first)

PHI must be stripped before segmentation, centerline extraction, or anything else — the moment a CTA enters the pipeline. The authoritative standard is **DICOM PS3.15 Annex E, the Basic Application Level Confidentiality Profile**, whose `Table E.1-1` enumerates every attribute to remove or replace; de-identification method codes come from `CID 7050` in PS3.16 ([DICOM PS3.15 Annex E.2](https://dicom.nema.org/medical/dicom/current/output/chtml/part15/sect_E.2.html), [TCIA De-identification Knowledge Base](https://wiki.cancerimagingarchive.net/display/public/de-identification+knowledge+base)).

**Tags that MUST be removed or replaced (non-exhaustive — apply the full Table E.1-1 profile, not just this list):**

| Tag | Name | Action |
|---|---|---|
| (0010,0010) | PatientName | remove / replace with dummy |
| (0010,0020) | PatientID | remove / replace |
| (0010,0030) | PatientBirthDate | remove |
| (0010,1040) | PatientAddress | remove |
| (0010,2154) | PatientTelephoneNumbers | remove |
| (0008,0090) | ReferringPhysicianName | remove |
| (0008,0080) | InstitutionName | remove |
| (0008,0081) | InstitutionAddress | remove |
| (0008,0050) | AccessionNumber | remove / re-hash |
| (0020,000D) | StudyInstanceUID | re-map to fresh UID |
| (0020,000E) | SeriesInstanceUID | re-map to fresh UID |
| (0008,0018) | SOPInstanceUID | re-map to fresh UID |
| (0008,0020/0021/0022/0023) | Study/Series/Acquisition/Content Date | remove or shift consistently |
| (0008,103E) | SeriesDescription | review (can contain a name) |
| — | **Burned-in pixel annotations** | review/blank — text overlaid in the image pixels is NOT covered by tag removal and is the classic leak |

**Named de-id tools (all offline, all PS3.15-aligned):**
- **RSNA MIRC Clinical Trials Processor (CTP) DICOM Anonymizer** — script-driven, default profile is PS3.15 Annex E with CID 7050 codes ([MircWiki: The CTP DICOM Anonymizer](https://mircwiki.rsna.org/index.php?title=The_CTP_DICOM_Anonymizer)).
- **RSNA DICOM Anonymizer** (stand-alone GUI/CLI) ([rsna.github.io/anonymizer](https://rsna.github.io/anonymizer/1_overview.html)).
- **pydicom `deid`** (Python, scriptable into the pipeline) — load/modify/save with a recipe file.

> **Honesty note baked into provenance:** PS3.15 itself states the profile "does not guarantee that all individually identifying information will be removed" and "does not replace a de-identification process, but should be part of it." For a *public* MIT repo, de-id alone is necessary but not sufficient — the upstream collection must ALSO be licensed for redistribution (§5). De-identified ≠ redistributable.

### Stage 2 — Segmentation (TotalSegmentator default `total` task ONLY)

Use **only** the default Apache-2.0 `total` (CT) / `total_mr` (MR) task. TotalSegmentator's core repo is Apache-2.0 ([github.com/wasserth/TotalSegmentator LICENSE](https://github.com/wasserth/TotalSegmentator/blob/master/LICENSE)). **The specialized subtasks are license-gated / non-commercial and are EXCLUDED**: `coronary_arteries`, `heartchambers_highres`, `aortic_sinuses`, `liver_vessels`, `brain_structures`, `vertebrae_body`, `tissue_types`, etc. require a separate (free-for-non-commercial) license and several restrict outputs — they fail the MIT-redistribution bar ([TotalSegmentator subtask licensing](https://github.com/wasserth/TotalSegmentator), [totalsegmentator.com](https://totalsegmentator.com/)).

**Arterial masks the default `total` task actually yields** (verified against the structure list):
- `aorta`
- `iliac_artery_left`, `iliac_artery_right`
- `subclavian_artery_left`, `subclavian_artery_right`
- `common_carotid_artery_left`, `common_carotid_artery_right`
- `brachiocephalic_trunk`
- (plus `pulmonary_artery`/`pulmonary_vein`, and venous structures `superior_vena_cava`, `inferior_vena_cava`, `brachiocephalic_vein_left/right`, `portal_vein_and_splenic_vein` — relevant only if/when the venous subsystem of roadmap §3d is built)

**Critical coverage gap — the masks the default task does NOT contain:**
- **No renal *arteries*** (the default task segments kidney *parenchyma*, not the renal artery). Roadmap §6a/§6b already flags this.
- **No celiac trunk, no SMA, no IMA, no hepatic/splenic/gastric arteries.**
- **No internal iliac, no femoral, no tibial/runoff.**
- **No cerebrovascular (carotid stops at the common carotid; no ICA/MCA/vertebral/basilar).**

**Consequence (load-bearing):** the default task gives you a clean, license-safe **aortoiliac + arch-great-vessel backbone only**. *Every visceral, renal, pelvic, peripheral, and neuro vessel must come from synthetic generation calibrated to published morphometry* (§6, and roadmap §6c). This matches the existing placeholder: `NORMAL_DOC`'s aorta/iliac/arch are "real-shaped," and its renal/celiac/SMA/IMA/uterine trees are morphometry-authored — the pipeline reproduces exactly that division of labour, just with a real backbone where licensing permits.

### Stage 3 — Centerline + radius extraction (VMTK)

VMTK is **BSD-licensed** ([vmtk.org/license.html](http://www.vmtk.org/license.html), [github.com/vmtk/vmtk LICENSE](https://github.com/vmtk/vmtk/blob/master/LICENSE)). Pipeline:
1. Surface the binary mask (marching cubes → triangulated lumen surface).
2. `vmtkCenterlines` — Voronoi-diagram centerline with the **maximum inscribed sphere radius** carried per centerline point. That radius is exactly the per-point `radius` the `AnatomyDoc`/lumen model needs.
3. `vmtkBranchExtractor` — splits the centerline into branches and assigns branch/group IDs, giving the tree topology for stage [4].

> **TetGen-free build caveat (verified):** Use a VMTK build WITHOUT TetGen. TetGen switched from MIT to **AGPL** at version 1.5, and the VMTK maintainers explicitly do **not** bundle TetGen 1.5.x because AGPL is incompatible with VMTK's BSD license ([vmtk-users: TetGen](https://groups.google.com/g/vmtk-users/c/LSsez2k3Rt8), [TetGen license FAQ](https://wias-berlin.de/software/tetgen/1.5/FAQ-license.html)). `vmtkCenterlines` and `vmtkBranchExtractor` do **not** require TetGen (TetGen is only needed for volumetric tetrahedral meshing, which this pipeline never does). Confirm your VMTK install reports no TetGen module, or the AGPL contaminates the toolchain.

### Stage 4 — Branch graph + parentage

`vmtkBranchExtractor` gives branches and connectivity. Convert that into the `AnatomyDoc` parent model:
- One **root** branch (the aorta): `BranchSpec` with no `parent`, carrying the full `controls` list.
- Each **child** branch: `BranchSpec` with `parent` set to its parent's id, `ostiumNear` ≈ the bifurcation point, and `ostiumR` = lumen radius at the ostium. The `anatomyDoc.ts` compiler then **welds** the child onto the nearest parent sample (`nearestPointOn` → `buildBranch` prepends the welded ostium control), guaranteeing graph connectivity — this is the "ostium-weld guarantee" and it is **already implemented in the schema layer**, so the pipeline only has to emit approximate `ostiumNear` coordinates, not byte-exact ones. (This is the correctness cliff the roadmap §7 calls out for synthetic sub-trees; the `AnatomyDoc` schema solves it for both real and synthetic branches.)
- Down-sample VMTK's dense centerline to ~5–12 `controls` per branch (CatmullRom in `sampleCenterline` re-lofts to a dense `samples` count at compile time, so the *control* list stays small; the lumen density is set by `samples`, default 64).

### Stage 5 — Coordinate transform (mm/LPS → cm IRsim body-frame)

See §3 for the exact transform. This stage converts every centerline point and radius from DICOM patient space into IRsim's `+y cranial / +x patient-left / +z anterior` body frame in **centimetres**, and re-origins so the aortoiliac bifurcation sits near `y≈0` (matching `NORMAL_DOC`, whose femoral-access bifurcation is at `[0,0,0]`).

### Stage 6 — Emit `AnatomyDoc` JSON + provenance

Serialise to the `AnatomyDoc` shape (branches/access/targets/provenance). Validate with `validateAnatomyDoc()` semantics (unknown parents/targets/access caught) before declaring the file done. Attach the full provenance block (§4). Author `access[]` (femoral entry points) and `targets[]` (named ostia) by hand or by rule — these are training-design choices, not segmentation outputs.

---

## 2. PHI / de-identification — why it is stage 1 and non-negotiable

De-id is listed as stage [1] and described in §1 above; restating the rule because it is the single most important safety property of this pipeline: **no DICOM, no pixel data, and no DICOM-derived intermediate that could carry residual PHI ever leaves the offline workstation or enters the repo.** Only the final `AnatomyDoc` JSON — abstract centerline points + radii in cm, with no image data and no patient metadata — is a candidate for shipping, and only if the *input collection's license* also permits redistribution. The provenance block must carry an explicit de-identification statement (§4) naming the profile (PS3.15 Annex E) and tool used.

---

## 3. Coordinate handling: DICOM mm/LPS → IRsim cm body-frame

**DICOM patient space.** DICOM voxel→patient coordinates come from `ImagePositionPatient` (0020,0032) + `ImageOrientationPatient` (0020,0037) + `PixelSpacing` (0028,0030), in **millimetres**, in the **LPS** convention: +X = patient **L**eft, +Y = **P**osterior, +Z = **S**uperior (cranial). (NIfTI/3D-Slicer use **RAS**: +X Right, +Y Anterior, +Z Superior — if your segmentation tool emits RAS, account for the flip below.)

**IRsim body-frame** (from `anatomyDoc.ts` header and `NORMAL_DOC`): **centimetres**, `+y = cranial`, `+x = patient-left`, `+z = anterior`.

**The transform (DICOM LPS mm → IRsim cm), axis by axis:**

| IRsim axis | meaning | source | sign | scale |
|---|---|---|---|---|
| `x` | patient-left | LPS **X** (already patient-left) | `+` | ×0.1 |
| `y` | cranial | LPS **Z** (superior = cranial) | `+` | ×0.1 |
| `z` | anterior | LPS **Y** (posterior) → negate for anterior | `−` | ×0.1 |

So, for a point `(Xlps, Ylps, Zlps)` in mm:
```
x_irsim = +0.1 * Xlps
y_irsim = +0.1 * Zlps
z_irsim = -0.1 * Ylps
```
Radius (the inscribed-sphere radius from VMTK, in mm) scales by `×0.1` to cm, no sign.

**If the segmentation/centerline tool emits RAS instead of LPS** (Slicer/NIfTI default): RAS X is patient-**Right**, so `x_irsim = -0.1 * Xras`; RAS Y is **Anterior**, so `z_irsim = +0.1 * Yras`; Z is superior in both, `y_irsim = +0.1 * Zras`. **Record which convention the input used in provenance** — getting this wrong mirrors the anatomy left-for-right, which silently breaks the chirality-sensitive solver (roadmap §8 chirality note).

**Origin placement.** After axis mapping, translate so the **aortoiliac bifurcation** sits at `y ≈ 0` (and roughly `x≈0, z≈0`), to match `NORMAL_DOC` (femoral-access bifurcation at `[0,0,0]`, arch apex near `y≈34`). Concretely: find the aorta centerline's caudal bifurcation point `B`, subtract `B` from every point, so the femoral end is the origin and cranial structures run to `+y`. This keeps emitted sidecars drop-in compatible with the existing access/target conventions and camera framing.

**Sanity gates after transform (cheap, catch the common mistakes):**
- Aorta runs **monotonically in +y** from ~0 (bifurcation) to ~30–34 (arch). If it runs −y, the superior/cranial sign is flipped.
- Renal/celiac/SMA ostia sit at **positive z** offsets (anterior/lateral) and the expected `y` bands (renals ~13–14, celiac ~18, SMA ~16, IMA ~11 in `NORMAL_DOC`'s frame). If z is negative where it should be anterior, the LPS→anterior negation was missed.
- Radii are in the **0.1–1.5 cm** range (not 1–15 — that means mm wasn't scaled).

---

## 4. The provenance block contract (every emitted sidecar MUST carry this)

`AnatomyDoc.provenance` is typed as `{ source: string; license: string; note: string }` in `anatomyDoc.ts`. That is the minimum the compiler requires. **Every pipeline-emitted sidecar MUST populate all three with the following content** (extend `note` to carry the full chain; the three-field shape is fixed by the schema, so the chain lives inside `note` as structured text):

**`source`** — the input collection + identifier:
> `"TCIA collection <NAME> case <ID>"` *(real scan)* or `"Synthetic (OpenCCO/VascuSynth), territory <X>"` *(generated)* or `"Procedural (IRsim parametric generator)"` *(placeholder)*.

**`license`** — the license that governs the OUTPUT (inherited from the input):
> e.g. `"CC0 1.0"` / `"CC BY 4.0 (attribution: <holder>)"` / `"CC0 (synthetic, generated by IRsim)"`. **Never SHIP a sidecar whose `license` is NC, SA, ARR, GPL, or 'conflicted/unconfirmed'.**

**`note`** — the full chain + mandatory honesty statements, as structured text:
> - **Tool versions:** TotalSegmentator `vX.Y.Z` (task=`total`, Apache-2.0); VMTK `vX.Y` (BSD, TetGen-free build); de-id: CTP/pydicom-deid `vX` (PS3.15 Annex E profile).
> - **License chain:** input `<collection license>` → de-identified per PS3.15 Annex E → transformed (tools do not relicense) → output `<license>`.
> - **De-ID statement:** `"De-identified per DICOM PS3.15 Annex E (Basic Application Level Confidentiality Profile); no PHI, no pixel data, no DICOM retained. PS3.15 does not guarantee complete removal; collection was additionally licensed for redistribution."`
> - **Honesty statement (verbatim, required):** `"Generic anatomy — NOT patient-specific. Catheter-navigation trainer only. Not a medical device, not for clinical use, not a substitute for procedural training."`
> - **For synthetic trees:** N terminals, perfusion volume/box, Murray exponent γ used (2.7), generator + version.

The existing `NORMAL_DOC.provenance` (in `anatomy.ts`) is a correct template for the *procedural* case; the pipeline extends it for the *real* and *synthetic* cases.

---

## 5. Tool & dependency list (versions, license, how each stays offline)

All tools run on an **offline workstation**. None is bundled into the IRsim build; the converter/loader (built separately) consumes only the **emitted JSON**, never these tools. **Outputs inherit the input data's license** — the tool license governs the *tool*, not the *data it transforms*.

| Tool | Role | License (verified) | In repo? | Offline note |
|---|---|---|---|---|
| **CTP DICOM Anonymizer** / **pydicom `deid`** / **RSNA DICOM Anonymizer** | Stage 1 de-id (PS3.15 Annex E) | RSNA tools: open / pydicom: MIT-style | **No** | Runs on the workstation; output is de-identified DICOM/NIfTI, never shipped |
| **TotalSegmentator** (default `total`/`total_mr` task only) | Stage 2 segmentation | **Apache-2.0** (core) ([LICENSE](https://github.com/wasserth/TotalSegmentator/blob/master/LICENSE)) — subtasks NC/gated, **excluded** | **No** | CLI; output = masks, inherit input license |
| **VMTK** (TetGen-free build) | Stage 3 centerlines + radii | **BSD** ([vmtk.org/license](http://www.vmtk.org/license.html)) | **No** | `vmtkCenterlines`+`vmtkBranchExtractor`; no TetGen → no AGPL |
| **OpenCCO** | §6 synthetic distal trees | **AMBIGUOUS — GitHub badge GPL-3.0, README says LGPL** ([repo](https://github.com/OpenCCO-team/OpenCCO)) | **No (tool); data only, with caveat below)** | Copyleft either way → tool never bundled; output redistributed |
| **VascuSynth** | §6 synthetic territory-density trees | **CC BY 4.0** (Insight Journal) ([pub 794](https://insight-journal.org/browse/publication/794/)) — **not Apache, correcting roadmap** | **No (tool); data with attribution)** | CLI; output is data |
| **3D Slicer / MeshLab / ITK / VTK** | optional surfacing/QA | BSD / GPL(Slicer modules) / Apache-2.0 / BSD | **No** | Workstation QA only |

> **Three corrections to roadmap §6a/§6c, verified this pass — material for SHIP decisions:**
> 1. **OpenCCO is NOT cleanly "GPL-3.0."** The GitHub license badge says GPL-3.0 while the README declares LGPL ([OpenCCO repo](https://github.com/OpenCCO-team/OpenCCO)). This is itself a *conflicted record*. It does not change the verdict (the tool is copyleft and is never bundled), but the ambiguity should be noted, and a clean alternative preferred where possible.
> 2. **VascuSynth is CC BY 4.0, not Apache-2.0** ([Insight Journal pub 794](https://insight-journal.org/browse/publication/794/)). CC BY is attribution-only (no NC, no SA), so the tool remains usable, but attribution to the authors is required if the tool itself is redistributed.
> 3. **Neither OpenCCO nor VascuSynth carries an explicit written grant that GENERATED OUTPUT is user-owned / CC0.** The roadmap's "outputs user-owned"/"CC0-shippable" is a reasonable *inference* (synthetic geometry from a parametric algorithm seeded by the user is generally the user's) but it is **not a written license term**. **Recommended posture:** treat generated trees as the IRsim project's own work, label them `CC0 (synthetic, generated)` in provenance, retain the generator config that produced them, and — for OpenCCO specifically, given its conflicted/copyleft record — **prefer VascuSynth (CC BY) or an MIT-licensed in-browser generator** (space colonization) for anything baked into the shipped repo, keeping OpenCCO for reference/experimentation only until its license is unambiguous.

**Honesty constraints (restated as pipeline invariants):**
- Catheter-navigation trainer only; not patient-specific; not a medical device.
- License blockers stay **reference-only** (measurements/calibration, never redistributed geometry) until confirmed shippable **in writing**.
- "De-identified" does not imply "redistributable" — both the PHI bar (§2) and the license bar (§6) must pass independently.

---

## 6. License-clean dataset whitelist — verified SHIP / REFERENCE-ONLY / BLOCKED

Refines roadmap §6a. **Standard applied strictly: NC, SA, ARR, GPL/copyleft contamination, or any conflicted/unconfirmed record ⇒ NOT SHIP into the MIT repo.** A SHIP verdict requires a license verified in writing/at source; where verification was not possible this pass, the verdict is REFERENCE-ONLY by default — never SHIP on assumption.

| Source | Type | Actual license (verified where cited) | Verdict | Use in IRsim |
|---|---|---|---|---|
| **Synthetic OpenCCO output** | generated centerlines | tool copyleft & **conflicted record** (GPL/LGPL); output not explicitly granted | **REFERENCE/EXPERIMENT-ONLY until license unambiguous** (downgraded from roadmap's "SHIP data-only") | Prefer VascuSynth/space-colonization for shipped trees |
| **Synthetic VascuSynth output** | generated centerlines | tool **CC BY 4.0** ([pub 794](https://insight-journal.org/browse/publication/794/)); output treated as project's own, labelled CC0 | **SHIP (as IRsim-generated CC0; attribute VascuSynth tool)** | Territory-density distal trees |
| **Space-colonization (MIT JS impls)** | generated centerlines | MIT tool; output the project's own | **SHIP (CC0, IRsim-generated)** | In-browser/offline distal trees; cleanest path |
| **TotalSegmentator default `total`/`total_mr` masks** | processing output | **Apache-2.0** tool; mask inherits *input CTA* license | **SHIP ONLY IF input CTA is SHIP-able** (verify input) | Aortoiliac + arch backbone |
| **VMTK centerlines** | processing output | **BSD** tool ([license](http://www.vmtk.org/license.html)); output inherits input license | **SHIP ONLY IF input is SHIP-able** | Centerline+radius extraction |
| **ARCADE** | 2D coronary X-ray | CC0 1.0 (dataset; CC-BY is the article only) | **SHIP** (limited relevance — 2D fluoro annotation only) | Fluoro-annotation reference |
| **AortaSeg-60** | 3D aorta seg | **CONFLICTED record** — Zenodo tag CC0 vs included README CC BY 4.0 | **BLOCKED as a baked/redistributed asset until authors resolve in writing** | Opt-in, non-redistributed engineering fixture may apply stricter CC BY 4.0 terms; automated mask is not a reference standard |
| **TCIA collection (any)** | real CTA | **per-collection**; most NOT CC0/CC-BY | **REFERENCE-ONLY until the specific collection is confirmed CC BY 3.0/4.0 or CC0 in writing** | Whitelisted-collection sourcing only after written confirmation |
| **Visible Human** | cadaver imaging | NLM custom Terms (unconfirmed for redistribution) | **REFERENCE/TRACING-ONLY until Terms confirmed in writing** | Attribute "Courtesy U.S. NLM" |
| **SynthAorta** | synthetic aorta dataset | **GPL-3.0 dataset** (CC-BY is paper only) | **BLOCKED** (copyleft contaminates MIT) | Reference only |
| **Vascular Model Repository** | real cardiovascular models | custom "All Rights Reserved," research-only | **BLOCKED** | Morphometry reference only |
| **AVT (Aortic Vessel Tree)** | real aorta trees | effectively **CC BY-NC-SA** | **BLOCKED** (NC + SA both fatal) | Reference only |
| **AneuRisk65** | ICA aneurysm geometry | **CC BY-NC 3.0** | **BLOCKED** (NC) | ICA morphology reference only |
| **IntrA** | intracranial aneurysm | no license = ARR | **BLOCKED** | Do not use |
| **BodyParts3D / Z-Anatomy / IXI** | anatomy meshes/atlas | **CC BY-SA** (Z-Anatomy also bundles NC) | **BLOCKED** (SA incompatible) | Reference only |

### 6a. Shortest path to a first REAL (or realistic) redistributable anatomy

The shortest **genuinely redistributable** path is **NOT a redistributed real scan** — it is a **procedurally generated + morphometry-calibrated** anatomy, because:
1. No public real-CTA collection is confirmed CC0/CC-BY *and* redistributable into an MIT repo as of this writing without per-collection written confirmation (every TCIA verdict above is collection-dependent; AortaSeg-60 is conflicted; AVT/AneuRisk/VMR are NC/ARR).
2. The default-`total`-task backbone (aorta + iliac + arch great vessels) is exactly what `NORMAL_DOC` already authors by hand — so even a *real* backbone buys little over the existing placeholder until the visceral/renal/peripheral trees exist, and those must be synthetic regardless (no default-task masks for them).
3. A synthetic + morphometry-calibrated anatomy is also the most *honest* product: it is genuinely generic, satisfies the "NOT patient-specific" constraint by construction, and ships under a clean CC0 self-grant.

**Concrete shortest path (no real scan needed):**
1. Take the existing `NORMAL_DOC` aortoiliac/arch backbone (already morphometry-shaped, already CC0).
2. Generate distal/visceral sub-trees with **VascuSynth or an MIT space-colonization generator** (NOT OpenCCO until its license clears), per territory (hepatic box at the proper hepatic; renal sub-trees per ostium), propagate radii with **Murray's law γ ≈ 2.7** (abdominal-vessel pooled exponent, per roadmap §6c — not the classical 3.0).
3. Transform into IRsim cm body-frame (§3), **weld each child root onto its parent** via the `ostiumNear`/`ostiumR` mechanism the `AnatomyDoc` compiler already provides (`example-vmtk-centerlines.json` in `assets/anatomy/` is a worked input for exactly this step).
4. Emit the sidecar with a CC0 + synthetic provenance block (§4).

### 6b. What a user MUST confirm in writing before any REAL scan is baked in

Before *any* real patient/cadaver scan is processed-and-shipped (as opposed to used only for measurement calibration), the owner must have **written confirmation** of ALL of:
1. **The specific collection's license** permits redistribution of derivatives in a commercial-OK, no-NC, no-SA form (CC0 or CC BY 3.0/4.0). A general "TCIA is public" is not enough — it is per-collection.
2. **De-identification is acceptable to the data-use agreement** of that collection (some DUAs forbid redistribution even of de-identified derivatives).
3. **For AortaSeg-60 specifically:** the authors resolve the Zenodo-CC0 vs README/paper-CC-BY conflict in writing. Until then it is morphometry-reference-only.
4. **For Visible Human:** the current NLM Terms permit the intended redistribution — verified at source, not assumed.

Absent any of these, the source stays **reference-only**: usable to *calibrate measurements* (diameters, lengths, takeoff angles → which feed the synthetic generator), never to *redistribute geometry*.

---

## 7. Open questions for the main thread to verify

1. **OpenCCO license must be resolved before it is used for anything shipped.** The GitHub-badge-vs-README conflict (GPL-3.0 vs LGPL) is unresolved; until then the shipped-tree generator should be VascuSynth (CC BY) or an MIT space-colonization implementation, with OpenCCO reference-only. *(This downgrades roadmap §6a's "OpenCCO … YES (data only)" to reference-only.)*
2. **Synthetic-output ownership has no explicit written grant** from either OpenCCO or VascuSynth. Confirm the project is comfortable self-labelling generated trees CC0 on the (reasonable but un-stated) basis that parametric output is the operator's own work; retain generator configs as evidence.
3. **TCIA collection whitelist is empty until a specific collection is confirmed in writing.** If a real backbone is wanted soon, the action item is: pick one CTA collection, verify its license + DUA at source, document it — then the pipeline runs unchanged.
4. **Input coordinate convention (LPS vs RAS) per tool** must be recorded per run; a silent RAS/LPS mismatch mirrors the anatomy and trips the known chirality sensitivity (roadmap §8).
5. **Renal/celiac/SMA/IMA/peripheral/neuro geometry is synthetic by necessity** (not in the default task) — the clinical-credibility of those trees rests on the morphometry calibration tables, which still carry `[cite]` gaps in roadmap §3; those citations should be attached before any teaching claim.

---

## 8. Summary

- The offline pipeline is **de-id (PS3.15 Annex E) → TotalSegmentator default `total` → VMTK centerlines (TetGen-free) → branch graph → mm/LPS→cm body-frame transform → `AnatomyDoc` JSON + provenance**. It never ships DICOM, PHI, or any of the tools; outputs inherit the input's license.
- The default task gives a **license-safe aortoiliac + arch backbone only** — **no renal arteries, no visceral, no peripheral, no neuro** — so those trees must be **synthetic + morphometry-calibrated**, exactly as the placeholder already does.
- **Shortest path to a redistributable richer anatomy = procedural + morphometry-calibrated** (VascuSynth/space-colonization CC0 trees welded onto the existing backbone), **not** a redistributed real scan.
- **Verified license corrections to the roadmap:** OpenCCO is conflicted (GPL badge vs LGPL README) → reference-only for now; VascuSynth is CC BY 4.0 (not Apache); neither grants output ownership in writing (self-label CC0). TotalSegmentator default-task arterial masks and the TetGen-AGPL/VMTK-BSD caveat are confirmed as the roadmap states.
- **Top license blockers:** AortaSeg-60 (conflicted record), any TCIA collection (per-collection, unconfirmed), Visible Human (NLM Terms unconfirmed) — all reference-only until confirmed **in writing**.
