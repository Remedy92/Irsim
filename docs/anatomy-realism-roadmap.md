# IRsim Anatomy Realism & Vessel-Coverage Roadmap

> **STATUS BANNER (updated 2026-06-16) — read before trusting the body.** This roadmap's founding
> premise and its Phase 0/1/2 recommendations are now **shipped**, so the body over-states what is
> missing. Already done in committed code: `NORMAL_DOC` is a **25-branch** declarative `AnatomyDoc`
> (aortoiliac + arch great vessels + asymmetric renals + full visceral/mesenteric tree + pelvic UFE
> path), **not** the 8-branch placeholder the body describes; the visceral/mesenteric core, per-branch
> contrast bolus propagation, DSA/roadmap/bone-background fluoro, the centerline/sidecar ingestion
> bridge (`anatomy-loader.ts` with the ostium weld), pathology + variant scenarios, and a synthetic
> Murray's-law distal-tree generator all ship. The **still-governing, not-started** material is:
> **§3d** (venous / right-heart subsystem), **§4c–e** (carina contact-path, off-axis lumen, tortuosity
> descriptor — the last gated on the chirality fix / Workstream X), **§6** (license verdicts — but see
> `dicom-anatomy-pipeline.md`, which supersedes §6b and corrects three license claims), and **§8**
> (small-caliber contact-clamp). Remaining open work = anatomy **Phases 3–5** (venous, off-axis,
> small-caliber); the morphometry-calibration slice (aortic-bifurcation / renal-asymmetry) feeds the
> physics refactor's Workstream AC. Treat line-number code claims below as **as-of-2026-06-05** and
> re-verify against current source.

### A decision-grade plan to make IRsim's anatomy clinically faithful and grow it to real IR breadth

*Prepared for the IRsim owner. Clinical numbers and license verdicts are sourced from the research bundle; where a license or a measurement is unconfirmed, it is flagged. Every code claim below was verified against the current source (`src/sim/types.ts`, `anatomy.ts`, `lumen.ts`, `cosserat.ts`, `src/three/Viewport.tsx`, `fluoro.ts`) — line numbers are cited so the owner can check them. Shipped-asset recommendations respect the hard constraint that anything baked into the MIT repo must be permissive/public-domain and redistributable.*

---

## 1. Executive Summary

### What IRsim already does well (and the draft-stage report got wrong)

Before proposing changes, two features the engine **already ships** must be credited, because over-selling them as new work would cost the report its credibility:

- **The fluoro view already renders faint walls + a contrast bolus.** `Viewport.tsx:273` computes per-frame wall sigma as `(0.05 + contrast.current * 2.6) * ud.atten`. Walls are *already* near-invisible pre-contrast (floor 0.05) and fill dark on injection. A contrast ramp/decay state machine *already* exists: `contrast.current` (`:163`) is set to 1 on an `injectSeq` event (`:246-250`) and decays at `h*0.13`/frame (`:248`). The per-branch `attenuation` scalar is therefore *already* a multiplier on a contrast-modulated sigma, **not** a static tissue density. So "split attenuation + add a bolus" is **largely done**, not a new high-leverage win.
- **The carina's trainable tie-break already exists.** `lumen.query()` (`lumen.ts:266`) already lets the wire's position+history pick a branch via `differentBranch()`/`nearOstium()` and a hysteresis margin (`:295-299`). At a junction the wire does *not* blindly snap to the nearest edge; branch-switching is gated.

The genuine fluoro gaps are narrower and the genuine carina gap is different from what a naive read suggests — both are scoped correctly below.

### The realism gap today

IRsim's engine is architecturally sound and ready to scale, but its anatomy is a thin, hand-coded, anatomically-*plausible* placeholder. `buildNormalAnatomy()` ships **8 branches** (aorta, two common iliacs, two renals, brachiocephalic, left common carotid, left subclavian — each sampled at `samples=64`, so ~**576 lumen edges** total, not "~512"). Three things hold back realism:

1. **Coverage is shallow.** The 8 branches unlock essentially one family of navigation tasks (aortoiliac access + a few ostial engagements). The highest-volume IR territories — visceral (TACE/Y90, UFE, PAE, GI-bleed), peripheral runoff (BTK), the entire venous tree (TIPS, PE, IVC filter), and dialysis access — are unreachable because the celiac, SMA, IMA, internal iliacs, distal runoff, and every vein are absent.

2. **Geometry is too symmetric and too perpendicular.** Renals take off near-perpendicular (`[-0.2,13.5,0.6]→[2.0,13.8,0.2]`) vs a population-mean coronal takeoff of **~54°**, caudal+lateral. The right renal main is genuinely longer (~42 mm) than the left (~32 mm); the current symmetric renals erase this. The infrarenal aorta is ~10–15% too wide (current `r=0.9–1.05 cm` → 18–21 mm; CT mean ~15.5 mm → r≈0.77 cm). The aortic bifurcation is mirror-symmetric when it should not be.

3. **The fluoro view, while faint-walled and bolus-aware, is still a single global wash on a blank field.** The real gaps (see §4f): the bolus is one **global scalar**, not per-branch and not propagating outward from the access site, so there is **no arterial-fill sweep to interpret**; there is **no bone/spine/pelvis background**; **no DSA subtraction mode**; **no roadmap overlay**.

### The highest-leverage moves (in order)

| Move | Why it's highest-leverage | Effort | Engine touch |
|---|---|---|---|
| **A. Calibrate existing geometry + add celiac trunk (→ splenic/CHA/LGA) + SMA + IMA** | Unlocks selective-celiac→hepatic navigation (the TACE/Y90 *navigation* skill), splenic/GI-bleed targeting, and Michels-variant scenarios. Pure `anatomy.ts` data; **zero physics/lumen changes**. | Low | none |
| **B. Make the existing bolus *propagate per-branch* + add bone background** | The bolus state machine exists but is global; per-branch arrival delays create the fill **sweep** trainees must read. Bone background is the single biggest *missing* fluoro element. | Low–Med | shader + per-branch fill state |
| **C. Add DSA subtraction + roadmap overlay modes** | Roadmap is the most-used DSA mode in real selective cannulation; both build on the existing attenuation buffer. | Med | render targets |
| **D. Add `tortuosity` + `Stenosis`/`Aneurysm` (concentric) descriptors** | Tortuosity is the highest-ROI realism upgrade for wire-skill training; concentric stenosis/aneurysm are the difficulty axis. Build-time radius/centerline modification. **Needs an empirical chirality+stability check (§4d).** | Med | build-time only* |
| **E. JSON sidecar + loader, with synthetic distal trees** | Decouples data from code, enables a scenario library. The data model and physics are already generic over `Anatomy` — but the loader **must weld synthetic ostia** to parents or adjacency silently breaks (§7). | Med | loader + weld step |

\*Eccentric stenosis, CTO/dissection dual-lumen, and the carina-physics upgrade are **not** build-time-only — they are reclassified as engine subsystems below.

The recurring theme remains true and is the load-bearing strategic fact: **IRsim's physics, lumen, and fluoro pipeline are generic over the `Anatomy` interface, so the visceral-core-first, zero-engine-change sequencing is correct.** But four specific items the draft treated as data/tuning are actually engine subsystems, and the report now says so explicitly: **carina physics, venous/right-heart geometry, TIPS portal puncture, and small-caliber instrument support.**

---

## 2. What "Realistic + More Vessels" Means for an IR Trainer

Two orthogonal axes. Conflating them is the trap: rich vessel count with cartoon geometry teaches wrong intuitions; exquisite geometry on 8 vessels teaches too few procedures.

**A standing honesty constraint (applies to every procedure named in this report):** IRsim is a **catheter-navigation** trainer. It models wire/sheath advancement, torque, branch selection, and the resulting fluoro image. It does **not** model embolic delivery, reflux, coil/flow-diverter deployment, balloon sizing, microcatheter exchange as a distinct skill, or clinical decision-making. Therefore every procedure below is scoped to its **navigation sub-skill** — e.g. "selective celiac→RHA cannulation under roadmap," *not* "TACE." This is the exact line the owner's hard constraint draws (simulated relative metrics, generic anatomy, not a medical device).

### Axis 1 — Clinical COVERAGE (territories × navigation sub-skills)

- **Aortoiliac & peripheral:** retrograde/antegrade femoral access; the **contralateral up-and-over crossover** (wire reverses ~180° plus the CIA takeoff; total bend 130–155°); SFA/popliteal CTO *crossing-plane navigation*; **BTK trifurcation cannulation** (ATA's ~90° interosseous takeoff); EVAR sheath-path tracking + contralateral-gate *cannulation*. ⚠️ **The confirmed chirality bug already degrades every left-sided selective task today** — see §8 risk note.
- **Visceral/abdominal:** celiac engagement + hepatic-bifurcation subselection (TACE/Y90 *navigation*); the **tortuous splenic artery** (tortuous in 54% of cadavers [bundle: splenic-morphometry source — get inline handle before teaching]); GDA navigation; SMA/IMA selective cannulation (GI-bleed); renal ostial *seating*; **UFE** uterine-artery cannulation (obtuse ~132° takeoff, Waltman loop); **PAE** prostatic-artery cannulation (1.5–2.5 mm — see small-caliber prerequisite, §8); BAE navigation with spinal-artery-territory awareness.
- **Neuro/arch:** arch-type recognition (I/II/III) and Simmons-reform navigation; bovine-arch withdrawal-to-engage; carotid-access navigation; ICA-siphon/M1 *microcatheter navigation* (LVO access path). **Requires a sub-mm instrument class (§8) — not a tuning pass.**
- **Venous & right-heart:** IVC-filter zone recognition; **TIPS** access-vein navigation; right-heart RA→RV→PA *valve-crossing navigation*; right adrenal vein cannulation (the hardest single cannulation in IR); IPSS; May-Thurner. **This is a separate geometry+interaction subsystem (§3d), not a tuning delta.**

### Axis 2 — Geometric & visual FIDELITY (per-vessel realism)

- **Per-vessel geometry:** diameter taper, length, takeoff angle, cross-section, **calibrated tortuosity** (TI = arc/chord; normal aortoiliac 1.0–1.2, "hostile" >1.4).
- **Bifurcation/ostium realism:** an explicit carina (flow divider). **Important correction:** today's tangent-based tie-break is in `query()` (`lumen.ts:266-299`) and already works; what is missing is a carina that the wire physically *feels* — which the contact path does **not** currently provide (§4c).
- **Pathology layer:** concentric stenosis (free), eccentric stenosis + CTO + dissection (architecture — §4e), aneurysm, FMD, vasospasm, calcification.
- **Fluoroscopy fidelity:** propagating per-branch contrast (partial today), bone background, DSA subtraction, roadmap overlay, foreshortening cue, quantum mottle, wire radiopacity (already present at sigma 7).

**The discipline:** every coverage addition ships with the minimum fidelity needed for its training value — adding the splenic artery is worthless for tortuosity training unless its TI is set high; adding the celiac is worthless for Michels training unless the variants are authorable.

---

## 3. Vessel-Coverage Roadmap, Tiered by Territory

Tiers: **Core** (unlocks a flagship navigation skill or is on every access path), **Important** (a distinct skill or common variant), **Distal/Future** (small-caliber or specialized; gated on the small-caliber instrument prerequisite). Diameters are luminal; lengths/angles are bundle population means. **Prevalence/measurement claims that lack a per-claim source handle in the bundle are marked `[cite]` — the owner explicitly wants citations, and these must get an inline source before any teaching use.**

> **Existing 8** (aorta, both common iliacs, both renals, brachiocephalic, LCC, LSA) already exist. Below is what to **add**, plus §4 calibration fixes.

### 3a. Aortoiliac & Peripheral

| Vessel | Tier | Ø (mm) | Length (cm) | Parent / ostium | Unlocks (navigation skill) |
|---|---|---|---|---|---|
| External iliac a. | Core | 7–9 | ~11 | Common iliac | Tracking segment; EVAR access |
| Internal iliac a. | Important | 5–8 | 3–5 | Common iliac | IIA cannulation; gateway to uterine/prostatic |
| Common femoral a. | Core | 7.8–10.0 | 2–5 | External iliac | Universal access; SFA-vs-profunda discrimination |
| Profunda femoris | Important | 5.0–5.4 | ~20–25 [est] | Common femoral | Antegrade trajectory recognition |
| Superficial femoral a. | Core | 5–7 | ~50 | Common femoral | Femoropopliteal navigation; CTO crossing-plane |
| Popliteal a. | Core | 6–8 | ~15–20 | SFA | BTK landing; P2 flexion-zone awareness |
| Tibioperoneal trunk | Important | 3.5–5.0 | 2.0–6.7 | Popliteal | BTK roadmap landmark |
| Anterior tibial a. | Distal | 2.5–4.2 | ~25–35 | Popliteal | ~90° takeoff — canonical BTK challenge **(small-caliber prereq)** |
| Posterior tibial a. | Distal | 2.5–4.9 | ~30–35 | Tibioperoneal trunk | BTK; aplastic 3.9–5.1% `[cite]` **(prereq)** |
| Peroneal/fibular a. | Distal | 2.5–4.0 | ~25–30 | Tibioperoneal trunk | Dominant in diabetic CLI **(prereq)** |

*Aortic-bifurcation calibration:* total interiliac angle mean **41.8°** `[cite]` (EVAR-geometry median 52.3°, IQR 46–59°); bifurcation at L4 in 68.5% `[cite]`; CIA per-side **23–26°**.

### 3b. Visceral

| Vessel | Tier | Ø (mm) | Length (cm) | Parent / ostium | Unlocks |
|---|---|---|---|---|---|
| Celiac trunk | Core | 7.2–8.1 | 2.3–2.8 | Aorta (T12–L1) | Visceral gateway; MALS |
| Splenic a. | Core | 5.9±1.0 | 9.3–14.7 | Celiac | Best tortuosity-training vessel (tortuous 54% `[cite]`) |
| Common hepatic a. | Core | 5.2±1.2 | 2.7±1.1 | Celiac | Hepatic backbone |
| Proper hepatic a. | Core | 4.8±1.2 | 1.9±0.9 | Common hepatic | Splits to RHA/LHA |
| Right hepatic a. | Core | 2.9 | ~3–4 [est] | Proper hepatic | Right-lobe selective cannulation |
| Left hepatic a. | Core | 2.5 | ~2–3 [est] | Proper hepatic | Left-lobe selective cannulation |
| Left gastric a. | Core | 3.6±0.8 | 3.0±0.9 | Celiac | Replaced/accessory LHA origin |
| Gastroduodenal a. | Core | 4.1±0.8 | 2.6±1.0 | Common hepatic | GDA navigation |
| SMA | Core | 5.7±1.0 | ~15–20 | Aorta (L1) | GI-bleed; replaced-RHA host; ~67° takeoff |
| Ileocolic a. | Important | ~3–4 [est] | ~8–12 | SMA | Right-sided lower-GI-bleed target |
| Middle colic a. | Important | ~2–4 | ~5–8 | SMA | Arc of Riolan / Drummond collateral; absent 4–20% `[cite]` |
| IMA | Core | 4.1±0.9 | 3.6±1.0 | Aorta (L3) | Lower-GI-bleed; ~60–90° takeoff |
| Left colic a. | Important | ~2–3 | ~4–6 | IMA | Splenic-flexure watershed |
| Superior rectal a. | Important | ~2–3 | ~8–15 | IMA | Non-target risk in PAE |
| Uterine a. | Core | 3.2–3.4 | ~7 | Anterior IIA | UFE cannulation (~132° takeoff, Waltman loop) |
| Prostatic a. | Distal | 1.5–2.5 | variable | Anterior IIA (5 origin types) | PAE cannulation **(small-caliber prereq)** |
| Ovarian/gonadal a. | Important | ~2–3 | ~20–25 | Aorta (L2) | Fibroid parasitization; PCS |
| Bronchial aa. | Distal | <1.5 / >3 | variable | Descending aorta (T5–6) | BAE **(prereq)**; spinal-territory awareness |

### 3c. Neuro / Arch

Arch great vessels exist; the cerebrovascular extension is missing. **All vessels in this table are sub-4 mm and gated on the small-caliber instrument prerequisite (§8).**

| Vessel | Tier | Ø (mm) | Parent / ostium | Unlocks |
|---|---|---|---|---|
| Right CCA | Important | 6.5±1.0 | Brachiocephalic | Right 6-vessel study |
| Right subclavian | Important | 8–12 | Brachiocephalic | Right VA gateway; lusoria variant |
| External carotid a. | Important | 3.5–5.0 | CCA bifurcation | Wire-park; MMA territory |
| ICA cervical (C1) | Core | 4.67–7.59 | CCA bifurcation | Access navigation |
| ICA siphon (C2–C4) | Core | 4.27–4.53 | continuous | Siphon microcatheter navigation |
| ICA supraclinoid (C5–C7) | Core | 2.71–4.15 | continuous | Distal access path |
| MCA M1 | Core | 2.54–3.10 | ICA terminus | LVO access (~35–40% of LVO `[cite]`) |
| Vertebral a. V1–V4 | Core | 3.2–3.7 | Subclavian (or arch ~6.2%) | Posterior-circulation access; V3 loop |
| Basilar a. | Core | 2.7–3.6 | VA confluence | Basilar access |

*Arch calibration:* types I ~42–48% / II ~34–45% / III ~12–20% `[cite]`; bovine ~12.9% `[cite]`; left VA from arch ~6.2% `[cite]`; lusoria ~1.2% `[cite]`. Default the arch to **Type II**; expose `archType` as a generation parameter.

### 3d. Venous & Right-Heart — *a new geometry + interaction subsystem, not a tuning phase*

**Honest engine reality (verified):** the lumen is a variable-radius **capsule-chain SDF** with one rigid per-edge radius (`lumen.ts:56-191`); contact is **one-sided** (wall pushes the rod inward, `cosserat.ts:773-786`). There is **no compliance, no valve geometry, no flow, no blood-column/buoyancy effect**. Consequences:

- The IVC/RA is ~22–26 mm — **3–5× the arterial calibers the solver is tuned for**. Catheter slack, looping, and flow-directed behavior in a large compliant chamber are **qualitatively different mechanics**, not a parameter pass.
- **An atrium is not a tube.** A capsule-chain SDF cannot represent a chamber; RA/RV/PA navigation needs a genuinely different lumen primitive (e.g. a closed mesh SDF or a fitted ellipsoid chamber), plus two-sided/compliant contact.
- **TIPS's transhepatic portal puncture has *no* representation path in a centerline-following lumen model.** It is an **out-of-lumen needle pass between two separate vascular trees** (hepatic vein → through parenchyma → portal vein). This requires a fundamentally different interaction model (a needle that leaves the lumen, a parenchymal target volume, a success/miss criterion) — naming "TIPS" as a deliverable without this is overreach.

The venous vessels below are therefore listed for completeness and *territory planning*, but Phase 4 is scoped as **subsystem work** (§8), not "venous tuning."

| Vessel/structure | Tier | Ø (mm) | Parent / ostium | Subsystem need |
|---|---|---|---|---|
| Infrarenal / suprarenal IVC | Core | 22–26 | Iliac confluence / above | Large-caliber + compliant contact |
| Iliac/femoral veins | Core | 10–18 | confluence | Large-caliber tubes (tractable) |
| Renal veins (R/L; circumaortic/retroaortic variant) | Core | 10.5 / 8.8 | IVC | Filter-zone; **circumaortic L renal vein variant** (AVS/filter-critical) |
| Hepatic veins (R/M/L) | Core | 11–15 | Retrohepatic IVC | TIPS access vein |
| Portal vein | Core | 13–16 | SMV+splenic confluence | **TIPS target — needs out-of-lumen needle subsystem** |
| SVC / brachiocephalic / IJV | Core | 10–20 | confluence | CVC/IPSS access |
| RA / RV / main PA | Core | chambers / 25–29 | venous inflow | **Chamber SDF + valve-crossing model (new primitive)** |
| Right adrenal v. | Important | 2–4 | Posterolateral IVC | Hardest cannulation (AVS) **(small-caliber prereq)** |
| Gonadal vv. | Important | <3 | L renal v. / IVC | Varicocele/PCS **(prereq)** |

### Recommended order to add — and why

1. **Visceral core first** (celiac→hepatic/splenic/LGA/GDA → SMA → IMA). Highest clinical volume, *zero engine changes*, unlocks the 27%-prevalence hepatic variants `[cite]`. Bundle "Priority 1."
2. **Aortoiliac/peripheral proximal extension** (EIA→CFA→SFA→popliteal). Completes the half-modeled territory; unlocks crossover. **Tibial trifurcation is deferred to the small-caliber prerequisite** (2.5–4.9 mm).
3. **Internal iliac → uterine** (UFE). **Prostatic deferred** to small-caliber prereq.
4. **Cerebrovascular** — entirely gated on the sub-mm instrument class.
5. **Venous tree** — scheduled as the dedicated **venous/chamber subsystem** phase, with TIPS-portal-puncture as a further out-of-lumen extension.

---

## 4. Geometric & Visual Realism Upgrades

Each mapped to actual code, with effort honestly classified.

### 4a. Calibrate the existing geometry (do first — free and load-bearing)

- **Infrarenal aorta ~10–15% too wide.** Current `r=0.9–1.05 cm`; CT mean ~15.5 mm (r≈0.77 cm), tapering from ~1.0 cm suprarenal. Reduce infrarenal control radii in `anatomy.ts`. **This changes the lumen SDF — regression-test navigation after.**
- **Renal takeoffs too perpendicular.** Mean ~54°, caudal/lateral; right renal main longer (~42 mm) than left (~32 mm). Adjust each renal's 2nd/3rd control points.
- **Aortic bifurcation symmetric; shouldn't be.** Right CIA longer; left CIA shallower takeoff. The mirror-image iliacs (`±2.2,±3.4,±3.8`) erase this.
- **Common iliac radius** (`r=0.55 cm` = 11 mm vs CT 10.5 mm) and **arch branch radii** (BCT 0.45, LCC 0.34, LSA 0.38 cm) are well-calibrated — leave them. Default arch to **Type II**.

> ⚠️ The exact numeric R-vs-L CIA takeoff angle from a >100-patient CT study was **not** in accessible literature; the 1978 cadaver source gives only qualitative asymmetry. Use EVAR/bovine distributions as a proxy and **mark for clinician sign-off.**

### 4b. Cross-section: optional elliptical ostium (rendering-only)

Add optional `radiusMinor?`/`tiltAngle?` to `CenterlinePoint`, used **only in the mesh loft**, never in `lumen.ts` collision (physics stays on the minor/circular radius — conservative). Zero physics impact; minor vertex cost. Circular assumption otherwise introduces ~5–10% diameter error at bifurcations per the bundle's vessel-lumen literature.

### 4c. The carina — corrected mechanism, honest effort

**What the draft got wrong:** an `smin(φ_parent, φ_daughter, k)` blend will change the **lofted mesh** and the **`phi()` sign tests** — but it will **not** change the physics the wire feels. Verified: `phi()`/`smoothMin()` exist (`lumen.ts:200-205, 363`) but are used **only** by `phi()`/`phiHard()`/`inside()` and the test suite. The **contact path the solver actually runs** (`cosserat.ts:773-786, 835-848`) consumes `lumen.query()`, which returns a **single nearest edge's `radiusAt(u)`** — a hard per-capsule cylinder radius (`lumen.ts:351`). It **never evaluates `phi()`**.

**What is already done:** the trainable tangent-tie-break at a carina (approach vector + history deciding the branch) is already implemented in `query()` via `differentBranch()`/`nearOstium()`/hysteresis (`:295-299`). So §4c is **not** a novel "restore selective-cannulation difficulty" win — that difficulty exists today.

**The genuine, correctly-scoped options:**

1. **Mesh-only carina (low risk, real visual win):** apply `smin` at flagged junctions so the **lofted mesh** shows a bulging flow divider instead of the Minkowski pinch. Add `carinaAtStart?: boolean` to `VesselBranch`. **No physics change, no claim of one.**
2. **Tighten the existing tie-break (low risk, small behavior win):** reduce the hysteresis margin (`hysteresisFrac`, default 0.5, `lumen.ts:266`) at flagged carinae so the tangent decides more crisply. This *does* affect behavior because it's on the `query()` path.
3. **Make the wire physically feel the divider (real subsystem work — scope honestly or defer):** re-plumb contact resolution to sample `phi()` (or an explicit carina capsule) instead of the single nearest-edge radius. This is a **non-trivial change to `cosserat.ts:773-848`** affecting every contact, with its own stability/perf re-validation. **Do not bundle this as "low-risk additive."** Recommend deferring until after the visceral-core phase, behind the same regression harness as the aorta-radius change.

> ⚠️ The `smin` `k` and the carina hysteresis margin are empirical — tune in-sim (too sticky vs branch-jumping).

### 4d. Tortuosity (highest single ROI — but verify, don't assert)

Add a per-branch `tortuosity` scalar (1.0→1.3→1.5). Apply 1–3 sinusoidal harmonics **after** building straight control points, then **resample to arc length** (note: resampling changes edge count/density — feeds the `buildAdjacency` cost in §7). For TI=1.3, P=5 cm, A≈1.1 cm.

The draft claimed "**No physics-code changes** — the XPBD rod reproduces buckling/coiling/prolapse for free." This is **plausible but unverified**, and two known facts make it risky: the **confirmed chirality bug** (left-curving vessels navigate worse; project memory) and the **left-climbs-half-as-far** evidence show the solver's curvature response is **already asymmetric**. A TI=1.5 vessel (A≈1.1 cm at P=5 cm) imposes tight curvature that may trip the same handedness/under-damping issue.

**Required gate (named work-item, not a footnote):** before stating tortuosity as a free win, run an empirical check — does a wire advance through a TI=1.5 test vessel **without exploding or stalling, on BOTH chiralities**? If it fails on the left, tortuosity inherits the chirality bug and must wait for (or be restricted around) the core-solver fix.

### 4e. Pathology descriptors — corrected effort classification

| Descriptor | Representation | Effort — corrected |
|---|---|---|
| **Concentric stenosis** `{sStart,sEnd,peakDegree}` | Cosine-bell radius dip | **Free** — capsule SDF handles symmetric variable radius; fluoro brightens the lumen column automatically |
| **Eccentric stenosis** `{...,eccentric:Vector3}` | Lumen center off the mesh axis | **NOT free.** The single-radius capsule SDF is **symmetric about the centerline** — there is no off-axis lumen. Eccentricity requires either moving the **centerline points** (which moves the mesh too) or a **new asymmetric cross-section in the SDF**. Reclassify as architecture, alongside CTO/dissection. |
| **Aneurysm** `{sNeck,sSac,maxDiameter,thrombusFraction}` | Cosine-bell bulge; inner (wire) radius = outer·(1−thrombusFraction) | Outer radius drives attenuation, inner drives physics — both concentric, so **free** |
| **CTO (dual-lumen)** | True-lumen radius→0 + parallel **subintimal ghost branch** offset by wall thickness | **Architecture.** A parallel off-axis channel is the same off-axis problem as eccentric stenosis — not a radius modifier. Highest-value scenario; schedule with dissection. |
| **Calcification** `{...,attenuationMultiplier,bumpAmplitude}` | Wall-stiffness flag + render-only bumps | 1.5–3× attenuation; mostly free |
| **FMD** | `R(s)=R·(1+A·sin(2π·s/λ))`, A≈0.25, λ≈8–12 mm | **Free** — concentric radius profile + low-stiffness wall |
| **Vasospasm** | Time-dependent radius reduction at tip, recovers on withdrawal | State machine (resting→spasm→recovery) |

**Net correction:** concentric narrowing/bulging (stenosis, aneurysm, FMD) is free; **eccentric stenosis, CTO, and dissection all need the same off-axis-lumen architecture** and must not be sold as free radius modifiers.

### 4f. Fluoroscopy as vessel count grows — crediting what ships, scoping the real deltas

The Beer-Lambert front/back-face line-integral in `fluoro.ts` is physically correct (consistent with GPU-DRR literature) — do **not** change the accumulation architecture. **Already shipped (do not re-propose):** faint walls + contrast-modulated sigma (`Viewport.tsx:273`), an `injectSeq`-triggered ramp/decay bolus (`:163, :246-250`), and dark instruments (wire sigma 7.0, sheath 4.5). The per-branch `attenuation` is already a multiplier on a contrast-modulated sigma, so **adding new branches is already automatically fluoro-correct** — small distal vessels read faint from small radius/path-length alone, no per-branch sigma tuning needed.

**The genuine deltas, in priority order:**

1. **Propagating per-branch contrast fill (the real high-leverage change).** Today `contrast.current` is a **single global scalar** — every vessel fills simultaneously, so there is no sweep to read. Replace it with **per-branch fill state** `uContrastFill_b(t)`, seeded at the access site and propagating outward with a per-hop delay (~0.5–1.0 s/hop, ~1.5 s ramp, then plateau) using the existing adjacency graph. **This** is what teaches the arterial-fill sweep — and it is genuinely missing.
2. **Bone background (the biggest *missing* element).** Add procedural lumbar-spine + pelvis meshes (sigma ~0.5) to the attenuation pass. Operators navigate against bone, not a blank field. Spine overlies the aorta ~y=0 (L4) to ~y=28 (T12); pelvis wings ~x=±10.
3. **DSA subtraction mode.** Zero the bone/background term, scale noise by √2 (subtraction doubles noise), render only contrast on black (~5-line shader change on the existing pass).
4. **Roadmap overlay.** Snapshot the peak-contrast attenuation buffer to a render target; composite at ~0.3 opacity under live frames. The most-used DSA mode in selective cannulation. Wire always on top.
5. **Per-segment attenuation as a vertex attribute** so stenosis (bright)/calcium (very bright)/thrombus (dark) show with no extra geometry.
6. **Geometry/fill-rate budget as vessel count grows — render concern, but bigger than radial-side LOD.** Verified: each branch builds one `TubeGeometry` at `points.length*2` tubular segments × **14 radial sides** (`Viewport.tsx:92-95`), in a `useMemo` (static — correctly off the hot path). But at 50+ vessels: (a) **each branch is a separate draw call in BOTH passes** — 50+ meshes = 50+ draws, and the fluoro pass is `DoubleSide` additive over **every** surface, so it is **fill-rate bound**; small distal vessels each still cost a full additive pass. (b) An "always coarsest for fluoro" LOD must keep **watertight front/back face pairing** or the Beer-Lambert front-minus-back sum **double-counts at degenerate caps**. **Recommendation:** merge/instance vessel geometry (one merged BufferGeometry, or InstancedMesh for the distal tree) to collapse draw calls, and budget the fluoro pass explicitly as fill-rate — not just radial-side count.
7. **Cheap realism touches:** signal-dependent quantum mottle (`noise *= 0.3 + 0.7·grey`), 4-tap scatter wash (~0.03–0.05), and a **foreshortening cue** (`|dot(tip-tangent, camera-forward)| > 0.6` → UI hint) to teach working-angle.

---

## 5. Anatomical Variants & Pathology Scenario Library

Ordered by training-value density (richness ÷ cost), weighted toward prevalence. Each: representation on IRsim's model, prevalence, value. **Prevalence figures marked `[cite]` need a per-claim source handle before teaching use** (owner's explicit requirement).

| # | Scenario | Prevalence | Representation | Value |
|---|---|---|---|---|
| 1 | Focal ostial renal stenosis (concentric, right) | core lesion | Concentric radius dip at s=0 of `renal_r` | Ostial "no-touch" seating; **free** |
| 2 | Type III aortic arch — LCC cannulation | 12–20% `[cite]` | Drop great-vessel origins below apex (authoring only) | Simmons reform; highest-difficulty arch |
| 3 | SFA CTO, 15 cm, blunt cap | TASC-D ~75% `[cite]` | **Dual-lumen architecture** (true→0 + subintimal ghost, gated at cap) | Subintimal-vs-true navigation; **needs off-axis architecture (§4e)** |
| 4 | Bovine arch (type I) — LCC | ~12.9% `[cite]` | Merge BCT+LCC common-trunk origin (authoring) | Withdrawal-to-engage |
| 5 | **Replaced right hepatic from SMA** (Michels III) | 8.7–13% `[cite]` | Re-parent `RHA` onto SMA | Flagship: right lobe won't fill from celiac — must catheterize SMA |
| 6 | **Replaced common hepatic from SMA** (hepatomesenteric) | Michels IX `[cite]` | Re-parent CHA onto SMA | Distinct from #5 — entire hepatic supply off SMA; **was conflated in prior drafts** |
| 7 | Accessory right hepatic from SMA | Michels VI `[cite]` | Add accessory RHA off SMA alongside celiac RHA | Dual-supply; missed-feeder risk |
| 8 | Replaced/accessory LHA from LGA (Michels II/V) | ~16% any aberrant LHA `[cite]` | Add LHA as sub-branch of LGA | Left-lobe via celiac→LGA |
| 9 | **Celiacomesenteric trunk** (shared celiac+SMA origin) | rare `[cite]` | Single aortic ostium feeding both celiac+SMA | Changes the entire engagement |
| 10 | Accessory renal arteries (polar) | 21–31% `[cite]` | Add 1–2 ARA branches at offset s/angle | Map all feeders; most common variant met |
| 11 | Iliac tortuosity + grade-3 calcium | grade 3 in 3–8% `[cite]` | Sinusoidal control points (TI~1.5) + stiffness flag | **Gated on §4d chirality check** |
| 12 | FMD, right renal ("string of beads") | renal FMD ~4% `[cite]` | Concentric `R(s)=R·(1+0.25·sin(2π·s/10mm))` | Distinguish from ostial atherosclerosis; **free** |
| 13 | AAA, hostile neck (58 mm sac, 75° neck) | hostile subset | Concentric bulge + neck kink + thrombus drag | Why deployment is risky |
| 14 | Type B dissection — true-lumen wire | — | **Dual parallel off-axis branches + tear connectors** | TL-vs-FL recognition; **needs off-axis architecture (§4e)** |
| 15 | Renal vasospasm (accessory artery) | small ARAs vulnerable | Time-dependent radius reduction at tip | Spasm vs organic stenosis |
| 16 | Arteria lusoria (aberrant right SCA) | ~1.2% `[cite]` | RSA branch from descending aorta, retroesophageal | From right radial, wire U-turns at arch |
| 17 | Left VA arising from arch | ~6.2% `[cite]` | Add LVA origin between LCC and LSA on the arch | Common thrombectomy-access surprise |
| 18 | PAE bilateral asymmetric prostatic origins | ~90% asymmetric `[cite]` | Two prostatic branches, different IIA origins | **Gated on small-caliber prereq (§8)** |
| 19 | BTK Type IIIA (aplastic PTA, dominant peroneal) | 3.9–5.1% `[cite]` | Hypoplastic `posterior_tibial`, enlarged `peroneal` | **Gated on small-caliber prereq** |
| 20 | Circumaortic / retroaortic left renal vein | circumaortic ~1–9%, retroaortic ~2–3% `[cite]` | Two/posterior-coursing left renal vein branches | AVS, IVC-filter, gonadal work; **venous subsystem** |
| 21 | Persistent sciatic artery | ~0.05% `[cite]` | Enlarged IIA continuation as dominant limb runoff | Alters runoff + access planning |

**Implementation phasing:** **(A)** authoring-only (2, 4, 5, 6, 7, 8, 9, 16, 17) → **(B)** concentric radius modifiers (1, 10, 12, 13) → **(C)** dynamic (15) → **(D)** off-axis architecture (3, 14, and eccentric stenosis) → **(E)** small-caliber-gated (11 if chirality clears, 18, 19) → **(F)** venous subsystem (20, plus 3d).

---

## 6. Data & Asset Strategy (license-clean)

Hard constraint: anything **baked into the shipped MIT repo must be redistributable, permissive/public-domain, ideally no share-alike, commercial-OK.** An **unresolved license conflict in the canonical record fails this bar until the rights holder clarifies in writing** — shipping under the stricter read does not cure ambiguity, it just picks an interpretation and bakes a contested asset into an MIT repo. The verdicts below apply that standard strictly.

### 6a. Shippable vs reference-only — verified table

| Dataset / tool | Actual license | Ship in MIT? | Use |
|---|---|---|---|
| **AortaSeg-60** | **CONFLICTED record** — Zenodo tag = CC0; README + paper = CC BY 4.0 | **NO — HARD BLOCKER until authors resolve in writing.** Reference-only meanwhile. | The conflict is exactly the case where you do *not* ship. Use for morphometry calibration (measurements, not redistributed geometry) while waiting. |
| **ARCADE** | CC0 1.0 (dataset; CC-BY is the *article* only) | **YES** | 2D coronary X-ray — low 3D relevance; fluoro-annotation only |
| **VascuSynth** (tool) | Apache-2.0; **outputs user-owned** | **YES** (generated data shippable as CC0) | Oxygen-demand distal trees |
| **OpenCCO** (tool) | GPL-3.0 tool; **generated data separable, CC0-shippable** | **YES (data only; tool stays in devDependencies, never bundled)** | CCO distal sub-trees |
| **VMTK / TotalSegmentator (default task) / SimVascular / 3D Slicer / MeshLab** | BSD / Apache-2.0 / BSD / BSD-like / GPL (offline) | **YES (offline tools; outputs inherit the *input* data's license — verify the input)** | Processing pipeline |
| **SynthAorta** | **GPL-3.0 dataset** (CC-BY is paper only) | **NO** — copyleft contaminates MIT | Reference only |
| **Vascular Model Repository** | Custom "All Rights Reserved," research-only | **NO** | Morphometry reference only |
| **AVT (Aortic Vessel Tree)** | Effectively **CC BY-NC-SA** | **NO** — NC + SA both fatal | Reference only |
| **AneuRisk65** | CC BY-NC 3.0 | **NO** — NC | ICA morphology reference only |
| **IntrA** | No license = all rights reserved | **NO** | Do not use |
| **BodyParts3D / Z-Anatomy / IXI** | CC BY-SA | **NO** — share-alike incompatible (Z-Anatomy also bundles NC sub-models) | Reference only |
| **Visible Human** | NLM custom Terms | **NOT A SHIP DECISION YET — verify current T&C in writing before any use.** "Likely yes" ≠ confirmed. | Until confirmed: reference/tracing only, attribute "Courtesy of the U.S. NLM" |
| **TCIA (general)** | Per-collection | **COLLECTION-DEPENDENT — whitelist only confirmed CC BY 3.0/4.0 collections, verify each in writing** | Whitelisted CTA sourcing |

> **TotalSegmentator caveat:** only the **default Apache-2.0 `total`/`total_mr` task** is shippable. The specialized tasks (coronary_arteries, liver_vessels, heartchambers_highres, brain_aneurysm, etc.) are **non-commercial** and several restrict outputs — exclude them. **Renal arteries are not in the default task** (only kidney parenchyma), so renal *vessel* geometry must come from synthetic generation + morphometry calibration.

**Net license posture (corrected to hard blockers):** **no AortaSeg-60-derived geometry, no Visible Human geometry, and no TCIA-collection geometry may be baked into shipped assets until each is confirmed shippable in writing.** Until then they are reference-only for *measurements*. The shippable-today set for actual baked assets is: **synthetic OpenCCO/VascuSynth output (CC0), ARCADE (CC0, limited use), and the offline-tool outputs of license-clean inputs.** This means the **first shipped richer anatomy should be procedurally generated + morphometry-calibrated**, not a redistributed real scan — which also aligns with the "generic, not patient-specific" honesty constraint.

### 6b. Recommended pipeline (license-clean)

1. Source CTA from a **confirmed CC0/CC BY** collection (only after written confirmation; until then, calibrate from published morphometry tables, not redistributed scans).
2. **TotalSegmentator (default Apache task)** → aorta, brachiocephalic, subclavian, carotid, iliac masks.
3. **VMTK** (`vmtkCenterlines` + `vmtkBranchExtractor`) → centerline points, radii, branch IDs (use a **TetGen-free VMTK build** — TetGen is AGPL/commercial-restricted).
4. Export to the **JSON sidecar** matching `Anatomy`, with a full **provenance block** (source, tool versions, license chain, "generic — not patient-specific").
5. Strip all PHI before processing.

### 6c. Synthetic distal-tree + variant generator

**(A) Distal sub-trees → Constrained Constructive Optimization, offline.**
- **First choice: OpenCCO** (GPL tool, CC0 output). Run per territory (hepatic box ~6×5×4 cm at the proper hepatic; renal sub-trees per ostium), parse output, transform to cm-space, **propagate radii with Murray's law γ ≈ 2.7** (pooled empirical exponent ~2.39 for abdominal vessels, not the classical 3.0). Draw asymmetry λ from Beta(3,2) clipped [0.4,0.9] to avoid CCO over-symmetry.
- **For territory-shaped density: VascuSynth** (Apache, user-owned output).
- **For in-browser variants: space colonization** (MIT JS implementations).
- **Skip L-systems; defer generative models** (VesselVAE/diffusion need license-clean training data not yet confirmed + a GPU dependency).
- ⚠️ Generated assets must use γ=2.7 and provenance blocks recording N terminals, perfusion volume, tool+version, and the CC0/procedural statement.

**(B) Population variants → classical PCA SSM**, *if* a permissive abdominal-aorta+celiac centerline training set is confirmed (not yet). Until then, author variants as discrete `buildVariantAnatomy_*()` functions (§7).

---

## 7. IRsim Engine & Data-Model Changes

Anatomy is consumed at 5 sites; XPBD physics is anatomy-agnostic.

### Where anatomy flows today
1. `Viewport.tsx` (~L62–110): one `TubeGeometry` per branch + `makeAttenuationMaterial`.
2. `cosserat.ts` (~L437–448): `new Lumen(anatomy)`; reads `anatomy.access`.
3. `lumen.ts` (~L74–113): one `LumenEdge` per segment; ostia via shared-endpoint detection.
4. `app.tsx`: `anatomy.targets` + `anatomy.access` for pickers.
5. XPBD physics: sees only the `Lumen` interface.

### Minimal (Phase-1, data-driven loading) — ~3 edits + 1 module + 1 weld step

- **NEW `src/sim/anatomy-loader.ts`:** `loadAnatomyFromSidecar(url): Promise<Anatomy>` — parse JSON, walk `parent_id`, return the flat `branches[]`.
- **JSON sidecar:** flat `vessels[]` `{ id, name, parent_id, parent_ostium_index, attenuation, points[] }`; `targets[]`; `accessSites[]`; provenance.
- **Edit `Viewport.tsx`/`app.tsx` L62:** swap `buildNormalAnatomy()` for async load with `buildNormalAnatomy()` as fallback.
- **⚠️ MANDATORY weld step (correctness cliff, not optional).** Verified: `buildAdjacency()` (`lumen.ts:100-113`) is **exact-coincidence endpoint matching at `tol=1e-3` cm** — it relies on a child's `points[0]` being byte-identical to a parent control point. Synthetic OpenCCO/VascuSynth sub-trees are generated **independently** and transformed into cm-space, so their roots will **NOT** share an exact control point with the parent. Without a snap/weld, **adjacency silently fails to connect them → branch-transition gating breaks → the wire can't enter the sub-tree at all.** The loader **must** weld each child root to the nearest parent point (snap `points[0]` onto the parent, or insert a shared node) before `Lumen` is constructed. This is a hard requirement of the synthetic pipeline.

### Ideal (Phase-2) — additive data-model extensions

- **`CenterlinePoint`** optional: `attenuation?`, `radiusMinor?`+`tiltAngle?`, `material_props?`. Backward-compatible.
- **`VesselBranch`** optional: `parent_id?`, `carinaAtStart?`, `tortuosity?`, `stenoses?`, `aneurysm?`, `calcifications?`, and **per-branch contrast-fill seed/delay** (for §4f.1). Keep `attenuation` as-is (it already works as a contrast multiplier — do **not** split it as if it were static tissue density; the split the draft proposed is already effectively present).
- **Lumen scaling — `buildAdjacency` O(E²) is real (verified `lumen.ts:105-107`):**
  - Baseline today is **~576 edges** (9 branches × 64 samples), not 512.
  - **The synthetic pipeline pushes this hard:** a hepatic CCO sub-tree alone, dozens of segments each densely resampled at 64 samples, plus distal renal/mesenteric trees, realistically reaches **thousands** of edges. At 3000 edges the double loop is **9M Vector3 distance ops at startup.** The earlier "~10–40 ms at 3–4k edges" figure had **no stated basis** and should be treated as unverified; with the dense resampling the synthetic trees produce, the >100 ms trigger may arrive sooner.
  - **Recommendation (do this proactively, not "only if >100 ms"):** replace the exact-match double loop with a **spatial-hash endpoint match** — it is the same data structure the weld step needs, so build it once and use it for both adjacency and welding. This also removes the `tol=1e-3` brittleness.
  - **Per-frame query cost stays flat** (graph-local search + rare grid fallback, `lumen.ts:266-351`) — 50 vessels do not breach 16.7 ms on the hot path. Mesh build is static (`useMemo`).
- **Tortuosity resampling note:** §4d's arc-length resample **increases edge density**, feeding directly into the cost above — count it.
- **`CaseConfig` type:** one object driving `{ archType, tortuosity, renalAngle, stenoses, aneurysm, variant }` → an `Anatomy`. This is the "case editor" product feature commercial simulators monetize.
- **Variant functions** (bridge before SSM): `buildVariantAnatomy_bovineArchI()`, `_michelsIII()`, etc.

### Validation tooling
A TS JSON-schema + runtime checker catching missing ostia, broken `parent_id`, **unwelded child roots** (distance from parent > tol), radius inversions, and unit mistakes. Document the sidecar in `docs/asset-pipeline.md` as the contributor contract.

---

## 8. Phased Implementation Plan

Front-loads zero-engine-change wins; explicitly separates the four engine subsystems from data work.

### Phase 0 — Calibration & carina-mesh (no new vessels)
- Fix infrarenal aorta radius (→r≈0.77 cm taper), renal angles (~54°, R>L length), bifurcation asymmetry.
- Add `carinaAtStart` for the **mesh-only** `smin` divider + tighten `hysteresisFrac` at carinae (§4c options 1–2). **Do NOT claim the wire feels a new flow divider** — that is the deferred contact-path migration (option 3).
- **Exit:** navigation regression-tested after the SDF-affecting aorta change; carina mesh looks like a divider; tie-break crispness tuned.

### Phase 1 — Visceral core + fluoro deltas (data + shader; no physics changes)
- Add celiac→(splenic/CHA→PHA→RHA/LHA, GDA)/LGA → SMA → IMA (bundle Priority-1): celiac ~y=17 (L1), r≈0.40 cm, length 2.8 cm; SMA ~1 cm below, r≈0.35 cm, ~67°.
- **Make the existing bolus propagate per-branch** (§4f.1); add **bone background** (§4f.2); add **DSA + roadmap** (§4f.3–4). (Do not re-implement faint walls / the ramp — already shipped.)
- **Exit (scoped to navigation):** a trainee can perform **selective celiac→hepatic-bifurcation subselection under roadmap** and **splenic-tortuosity navigation**; pre-contrast view shows bone + faint walls; injection produces an **arterial fill *sweep*** (not a global flash). **Not claimed:** "a TACE flow" — embolic delivery/reflux/timing are not modeled.

### Phase 2 — Data-driven loader + scenario library + first variants
- Ship `anatomy-loader.ts` + sidecar **with the mandatory weld step and spatial-hash adjacency**; migrate Phase-0/1 anatomy; keep `buildNormalAnatomy()` fallback.
- Implement authoring-only + concentric-modifier scenarios (1, 2, 4, 5, 6, 7, 8, 9, 10, 12, 13, 16, 17).
- Stand up OpenCCO/VascuSynth offline generator (γ=2.7, provenance, **welded roots**) for hepatic + renal sub-trees.
- **Exit:** ≥10 scenarios load via `CaseConfig`; `buildAdjacency` profiled <100 ms on a 40–50-vessel anatomy **via spatial hash**; one synthetic hepatic sub-tree **connects (weld verified) and navigates**.

### Phase 3 — Off-axis-lumen architecture + dynamic pathology + proximal peripheral
- Build the **off-axis-lumen subsystem** (eccentric stenosis, CTO dual-lumen, dissection — §4e) and vasospasm (15).
- Extend aortoiliac to EIA→CFA→SFA→popliteal (proximal-only — tibials wait for Phase 5).
- Add internal iliac → uterine (UFE navigation). **Prostatic waits for Phase 5.**
- **Exit:** crossover playable; SFA-CTO subintimal-vs-true *navigation* works; type-B-dissection TL/FL *recognition* works.

### Phase 4 — Venous & chamber subsystem (new geometry + interaction)
- Build the **chamber/large-compliant-lumen primitive** (RA/RV/PA cannot be capsule chains) + two-sided/compliant contact for ≥20 mm calibers.
- Add IVC→hepatic/portal vessels and right-heart chambers with **valve-crossing navigation**.
- **TIPS is a further extension, not this phase's exit:** the transhepatic portal puncture needs an **out-of-lumen needle subsystem** (needle leaves the lumen, parenchymal target volume, hit/miss criterion). Scope TIPS as "access-vein navigation now; portal puncture is a separate out-of-lumen work-item."
- **Exit:** RA→RV→PA valve-crossing navigation and right-adrenal/renal-vein cannulation are demonstrable; TIPS-portal-puncture explicitly deferred.

### Phase 5 — Small-caliber instrument class (prerequisite for half the roadmap)
**This is a named work-item, not a risk bullet.** Verified failure mode: the contact clamp `allowed = Math.max(0.02, this.lq.radius - this.params.rodRadius - EPS_C)` (`cosserat.ts:774, 836`) with the only instruments being GUIDEWIRE (`rodRadius:0.05`) and SHEATH (`rodRadius:0.1`). In a 1.5 mm prostatic artery (lumen radius 0.075 cm), `0.075 − 0.05 − 0.005 = 0.020` — already at the clamp floor; any wire wider, or any sub-1.5 mm vessel, gives a **negative allowed radius clamped to 0.02 and the containment math degenerates**. There is **no microwire/microcatheter instrument** in the model.
- Add a **microwire instrument class** (smaller `rodRadius`, e.g. ~0.018–0.025 cm) and **re-examine the contact clamp floor, `EPS_C`, and segment length `h`** for sub-mm calibers.
- **Then** unlock: BTK tibials (2.5–4.9 mm), ICA-siphon/M1 (1–3 mm), prostatic (1.5–2.5 mm), bronchials (<1.5 mm), right adrenal vein (2–4 mm).
- **Exit:** the microwire navigates a 2 mm test vessel stably on **both** chiralities (gated on the chirality fix below).

### Standing risks & open questions (clinician + core-solver review)
- **Chirality bug — degrades the roadmap *today*, before any new anatomy.** Confirmed (project memory): left-curving vessels navigate worse; left climbs ~half as far. This **already undercuts every existing left-sided selective task** (left renal, left subclavian→left VA, left iliac crossover) — not just generated sub-trees. **Sequence the core-solver chirality fix before** Phase-3 left-sided peripheral, Phase-5 small-caliber, and the tortuosity gate (§4d). Until then, restrict generated sub-trees to right-dominant branching.
- **Tortuosity is not yet a confirmed free win** — run the §4d two-chirality TI=1.5 advance/stall test before stating it.
- **Carina contact-path migration (§4c option 3)** — real `cosserat.ts` contact rework; do not bundle as low-risk.
- **`buildAdjacency`/weld** — ship the spatial-hash + weld with the loader, not reactively.
- **License hard blockers** — AortaSeg-60 (conflicted record), Visible Human (unconfirmed Terms), and each TCIA collection are **reference-only until confirmed shippable in writing**; the first shipped richer anatomy should be **procedurally generated + morphometry-calibrated**.
- **Prevalence/measurement `[cite]` rows** — attach a per-claim source handle before any teaching claim (owner's explicit requirement).
- **Clinical-credibility honesty (standing disclaimer to ship with every scenario):** IRsim trains the **catheter-navigation sub-skill only** — generic anatomy, simulated relative metrics, **not patient-specific, not a medical device, not a substitute for procedural training**. No scenario claims to teach embolization, deployment, or clinical decision-making.

### Explicitly out-of-scope-for-now (named so the "real IR breadth" claim is honest)
The following high-yield territories are **deliberately deferred**, with rationale: **dialysis access / fistulagram + AV-fistula/graft declotting** (one of the highest-volume outpatient IR procedures — defer: needs a dedicated upper-limb + graft geometry set, no current access site); **biliary/PTC + nephrostomy/nephroureteral** (percutaneous non-vascular — needs the same out-of-lumen needle subsystem as TIPS portal puncture); **IVC filter *retrieval*** (the harder, more-trained skill vs placement — needs a snare/foreign-body interaction model the engine lacks); **type-II endoleak embolization post-EVAR** (needs a deployed-graft + sac-feeder model); **REBOA aortic balloon occlusion** (needs a balloon-occlusion device model); **PE thrombectomy device mechanics** and **pulmonary AVM** (device-mechanics + chamber subsystem); **portal/mesenteric venous beyond TIPS (BRTO)**; **genicular and emerging embolizations**; **radial access as a first-class site** with the radial-loop/subclavian-tortuosity skill (currently only femoral access sites exist — adding radial is a tractable access-site + upper-limb-vessel addition and is the best near-term candidate to promote from this list). These are out-of-scope because each needs either a new interaction model (needle/snare/balloon/device) or a new territory geometry set, not because they lack training value.