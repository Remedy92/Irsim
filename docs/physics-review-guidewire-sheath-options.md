# IRsim guidewire/sheath physics — options & recommendations

**Status:** decision-grade external review for the IRsim maintainer
**Date:** 2026-06-04
**Scope:** the three maintainer complaints — (1) wire too flexible, (2) wire does not exit the sheath as an independent device, (3) doesn't feel like real endovascular navigation — diagnosed against the actual code in `src/sim/` and benchmarked against the physics literature, commercial/academic simulators, and available libraries.

**One-paragraph verdict.** The Cosserat + XPBD + frictional-contact + material-injection architecture in the design doc is the *right* family — it is what the open published state of the art (VCSim3, SOFA BeamAdapter, the Imperial CoRdE line) uses, and IRsim's EI *targets* for the shaft are physically correct. The three complaints are **solver-regime and coupling bugs, not material-parameter or architecture bugs**. You can fix the two headline problems (too-flexible wire, broken telescoping) cheaply and in place. A medium-term solver upgrade (small-steps XPBD + real inertia, or a direct stiff-rod solver) makes the stiffness physically honest. One thing the whole review must flag honestly: **torque/twist feel is out of scope of every recommendation below and will remain unrealistic** until twist is made a real dynamic DOF — the recommended changes fix bending and telescoping, not wind-up/whip.

---

## 1. Diagnosis — why it feels wrong

All three complaints trace to three independent root causes in the *solver*, plus a cluster of feel-killers. The material targets are mostly fine; the solver does not realize them.

### 1.1 "The wire is too flexible" — the bend constraint is massively under-converged

The XPBD bend update is

```
Δλ = -(C + α̃·λ) / (∇C·M⁻¹·∇Cᵀ + α̃),   α̃ = α / Δt_s²
```

with the bend compliance `α_b = ℓ/(4·EI)` (`units.ts:63-65`; the factor 4 is the correct consequence of the ½θ quaternion-imaginary convention — **this formula is right**, not a bug). The defect is everything *around* it:

- **All inverse masses are 1** (`cosserat.ts:406, 415`: `w=1, wq=1` for every free node/segment). So the geometric denominator `∇C·M⁻¹·∇Cᵀ` collapses to a **fixed constant (= 2 for bend)** — there is no inertial/mass scale for `α̃` to regularize against. This defeats the exact mechanism XPBD was invented to provide (timestep/iteration-independent stiffness *at the converged fixed point*). The pathology is documented in the XPBD/iMSTK literature: "given enough iterations PBD converges to infinitely stiff, overriding the stiffness values" — independence is a property of *convergence*, and with unit masses + a quasi-static integrator the rod never converges for stiff bend.

- **Stiff Cosserat bend converges extremely slowly under Gauss-Seidel.** Deul, Kugelstadt, Weiler & Bender 2018 ("Direct Position-Based Solver for Stiff Rods", CGF) state it verbatim: *"this solver requires many iterations to converge … and if convergence is not reached, the material becomes too soft."* On their tree benchmark the iterative position-and-orientation Cosserat rod (the *same* free-Cosserat+quaternion architecture IRsim uses) needs **>100,000 iterations** to reach what their direct solver reaches in one — a convergence-cost ratio, not a generic "100× slower for everything", but decisive here. Gauss-Seidel propagates a tip load only ~one node per pass, so for an **80–100 node** chain the distal half acts as a free, unsupported chain within the 12-iteration budget. That is why the symptom is worst distally — exactly where the lead-out wire lives.

- **Reproduced numerically** with IRsim's exact constants (`h = referenceLength/segments = 20/80 = 0.25 cm`, `dt = 1/60`):

  | Region | α_b | α̃ | correction/pass | residual after 12 passes |
  |---|---|---|---|---|
  | shaft EI=12, **S=2** | 5.21e-3 | 75.0 | **2.60 %** | **72.9 %** |
  | shaft EI=12, **S=4** | 5.21e-3 | 300.0 | 0.66 % | 92.3 % |
  | sheath EI=60, S=4 | 1.04e-3 | 60.0 | 3.23 % | 67.5 % |

  The shaft removes only ~27 % of its bend error per frame. *(Caveat — confidence medium: this single-constraint geometric-decay residual is illustrative. A single isolated XPBD constraint actually hits its λ fixed point in one step; the real rod softness comes from the **coupled** Gauss-Seidel chain propagation above. Treat "~15–27 % realized" as a directional estimate; the cantilever rig in Fix 0 is the true measurement of realized EI.)*

- **Substeps are an (admitted, intentional) stiffness knob.** `cosserat.ts:973-977` says it verbatim: *"more substeps ⇒ smaller Δt_s ⇒ larger α̃ ⇒ softer elastic response."* Doubling S from 2→4 quadruples α̃ (75→300) and *drops* per-pass correction from 2.60 %→0.66 %. **Fairness note:** the code flags this as a *deliberate tradeoff the design doc allows* for a highly-damped trainer. So this is a tradeoff to **reverse**, not an unrecognized defect.

- **Wrong regime.** IRsim runs `{substeps:2, iterations:12}` (wire) / `{4,12}` (sheath) — the *inverse* of the published recipe. Macklin et al. 2019 ("Small Steps in Physics Simulation") show n substeps × 1 iteration beats 1 step × n iterations because position error scales with Δt² (their headline experiment is 150k-particle cloth, 1×30 vs 20×1 substeps at equal ~13.5 ms; *the "~20 substeps recommended by Müller" attribution is **confidence:low / not in a primary source** — "start 16–25" is reasonable engineering, not a cited number*). IRsim's 2–4 × 12 with λ reset per substep is the worst middle: neither the substep Δt² benefit nor convergence.

**Crucially the EI values are right.** Shaft EI ≈ 12 N·cm² brackets a real Amplatz Extra/Super Stiff support wire (Harrison 2011 three-point bending: Amplatz Extra Stiff 8.95, Super Stiff 18.5 N·cm²; conversions reproduce to 2 sig figs). Stretch is effectively rigid (`α_stretch ≈ 2e-5`), so the wire is inextensible but bend-floppy — which matches "it noodles, doesn't stretch." **The target is fine; the solve doesn't deliver it.**

### 1.2 "The wire does not exit the sheath only" — one-way coax coupling

`COAX_OUTER_MASS_SCALE = 0.0` (`cosserat.ts:1171`), applied at `coax.ts:242-256`. With the scale at 0:

- `wa = outer.w[k]·0 = 0`, `wb = 0` → the outer endpoints contribute nothing to `gradMass`, and the outer corrections `a.addScaledVector(_n, wa·…)`, `b.addScaledVector(_n, wb·…)` are **both zero**.
- The **sheath never receives reaction from the wire** — a Newton's-third-law violation. Per canonical XPBD, a zero-inverse-mass partner is immovable and receives no impulse, so the documented bilateral 3-body containment collapses to a **unilateral kinematic push on the wire alone**. A stiff wire can never straighten, drag, or telescope the sheath, and the wire gets no *bilateral* lateral support. The header comment rationalizes 0.0 as "the sheath takes a smaller share" — but 0.0 is *no* share.

This contradicts **every** real reference. The Imperial CoRdE catheter/guidewire model couples the two rods with explicit two-way "binding constraints" (zero-rest-length distance constraints) plus contact. SOFA's `AdaptiveBeamSlidingConstraint` is a two-way `PairInteractionConstraint`. The SofaDefrost Cosserat plugin uses bilateral concentric constraints. VCSim3's concentric constraints "generate velocity changes (impulses) perpendicular to the centrelines between **all** the mass points of the guidewire inside the catheter and the two nearest corresponding points on the catheter" — symmetric.

**What already works (so the fix is small).** The lead-out *plumbing* is correct and should be preserved:
- **No axial tie** — the wire genuinely slides freely; only Coulomb friction `μ_io` resists (`coax.ts:26-27`). ✓ matches VCSim3/BeamAdapter.
- **Open portal** with arc-length gating: coax contact drops once `axialPastTip ≥ COAX_PORTAL_BLEND` (`cosserat.ts:1247-1251`); `portalWeight` ramps containment across the 0.4 cm tip blend. ✓
- The arc-length gate correctly stops a far-exited wire node from re-tethering to a proximal sheath segment in a curve. ✓

So the wire *can* geometrically exit; it exits **without the sheath ever having supported or been deflected by it** — which is why telescoping doesn't feel like a real over-the-wire system. Give the outer a nonzero mass scale and the architecture is sound.

### 1.3 "Doesn't feel like real navigation" — the sum, plus feel-killers

- **3a — Inverted tip stiffness (now partially corrected in the worktree).** Before the current fixes, tip `eiCm ≈ 0.5 N·cm²` (`material.ts:94-103`). Real floppy 0.035" tips measure **~0.02–0.15 N·cm²** (Qiu 2023 three-point-bend library — open-access, reproduced exactly: Glidewire 0.06, Bentson 0.02, Jwire 0.15). The worktree now uses a `0.1 N·cm²` floppy-tip target, but the remaining solver under-convergence can still mask/warp the felt tip-vs-shaft grading.

- **3b — The feed-force stall path is dead code.** `solveInletPositionMotor`/`solveInletOrientationMotor`/`solveAccessSleeveRadial` (`insertion.ts:132, 173, 210`) are **never called** in the rod step path — only in a comment and tests. The rod uses `anchorInlet()` (`cosserat.ts:947-953`), a hard Dirichlet pin, twice per elastic iteration. Therefore `forceMax = 1e12` (`insertion.ts:250`) is irrelevant — **there is no active compliant feed motor and no stall logic at all.** A blocked tip cannot stall the feed; the chain advances by injection + advection regardless of distal resistance. The operator feels **zero back-pressure**; failed cannulations don't fail; the wire bulldozes. Real push forces are sub-Newton (0.36–0.81 N, Synchro-Select MCA/ICA tortuosity models) and excess push should manifest as **0.6–3.0 cm proximal kickback/prolapse**, not unlimited advance.

- **3c — Push-energy bleed.** `damping = 0.9` per substep (`cosserat.ts:173, 188, 1001-1019`): `v = (x − prev)·0.9` multiplies push energy by 0.9^S = 0.81 (wire) to 0.66 (sheath) per frame, on top of the numerical damping the quasi-static solve already adds. Because the solve is quasi-static this bleed has **no physical basis**; it kills pushability.

- **3d — No physics-validation regression.** No cantilever (δ = FL³/3EI), buckling (P_cr = π²EI/(KL)²), three-point-bend, or substep-invariance test exists. The stiffness regression went undetected because **nothing measures realized-EI vs nominal-EI.**

- **3e — Geometry is partly wrong.** Wire `r = 0.05 cm` → 0.039" (a 0.038" wire; a real 0.035" is `r ≈ 0.044 cm`). The sheath OD `r = 0.10 cm` / inner channel `r = 0.09 cm` is a 0.1 mm wall — too thin to be a braided sheath and too small to coaxially hold a 0.035" wire **and** a catheter. (French sizing: 1 Fr = 1/3 mm OD; sheath label = ID. The old "+2 Fr OD" rule of thumb is **dated** — modern thin-wall sheaths have ~1 Fr ID→OD gap; make wall thickness a parameter, not a fixed offset.)

- **3f — Torque/twist is absent entirely (the biggest uncovered dimension).** Torquing a J-tip into an ostium is *the* core IR skill. IRsim integrates **no angular velocity** (orientations evolve only through constraint corrections), so it cannot store torsional strain energy and **cannot produce wind-up-and-release ("whip")** — the clinically defining torque behavior (lag = tip rotation < input; whip = the lag suddenly recovers). Even the gold-standard open sim VCSim3 *failed* here: a validation tester said "the guidewire torque was not realistic … very heavy", and its authors set the shear modulus G "to the highest possible numerically stable value" rather than optimizing it. **Counterpoint (Sharei review, for fairness):** "some studies assumed perfect torque control (torsion coefficient infinite) … close enough to reality" — i.e. *infinite-GJ, tip-rotation = input-rotation instantly* is a defensible deliberate simplification. But that is the **opposite** extreme from lag/whip; IRsim currently has **neither**. **None of the recommended fixes below add torque realism** — including "Stable Cosserat Rods", which explicitly keeps the quasi-static-orientation premise. This must be a conscious, separate decision.

---

## 2. Options — cheapest to most ambitious

Effort/risk are engineering estimates. Browser feasibility is judged against the budget: 60 fps = 16.7 ms/frame for ~80–100 nodes × 2–3 instruments — ~30× looser than the 0.5–1 kHz haptic budget that VCSim3 (2×512 nodes, ~1.44 ms *with collision on a separate thread*) and the Imperial GPU work already meet. **Compute is not the limiter for any option here; correctness is.**

### Group A — Tune/fix the existing XPBD Cosserat solver in place

**A0 — Validation rig first: cantilever + buckling + three-point-bend + substep-invariance (Vitest).**
*What:* headless tests — (a) clamp proximal node, apply tip force F, assert δ ≈ FL³/(3EI) per region; (b) push a straight column, assert straight below P_cr = π²EI/(KL)² (K = 2 fixed-free, 1 pinned-pinned, 0.7 fixed-pinned, 0.5 fixed-fixed) and buckled above; (c) three-point bend (40 mm span, back out EI = L³·ΔF/(48·ΔD), assert within ±15 % of target); (d) **substep-invariance**: tip deflection must NOT change when S doubles.
*Realism gain:* none directly — it **measures** the gap and turns "floppy" into a realized-EI/nominal-EI ratio. Test (d) currently *fails hard* (the table in §1.1 predicts it). *Feasibility:* runs in Node in ms. *Effort:* low. *Risk:* none. *License:* n/a. **Do this first** so every later change is verified, not felt.

**A1 — Make coax coupling two-way (`COAX_OUTER_MASS_SCALE > 0`).**
*What:* change `COAX_OUTER_MASS_SCALE` from `0.0` to a real outer inverse-mass share. The worktree uses a conservative `0.05` to avoid turning lateral support into an axial-feeling lock in the current unit-mass regime; once A3 lands, re-sweep toward a mass-derived value. This restores the bilateral 3-body containment already coded at `coax.ts:246-256`.
*Realism gain:* **high for complaint #2** — the sheath feels the wire (straightens/telescopes), the wire gets bilateral lateral support. *Feasibility:* one-line change to existing tested machinery; >60 fps. *Effort:* low. *Risk:* medium — two-way reaction on a near-concentric pair can oscillate (the reason the comment cites for 0.0). Mitigate with the existing `COAX_ALPHA_N = 1e-4` compliant support and interleaved Gauss-Seidel; raise the scale gradually. *License:* n/a.

**A2 — Decouple stiffness from dt/substeps (Small-Steps regime, fixed physical α).**
*What:* stop using S as a stiffness knob. Move to many substeps × ~1 iteration, λ reset per substep, holding the *physical* α fixed (`α_b = ℓ/(4·EI)` at the substep dt). Start S = 8–16; profile. Then doubling S no longer softens.
*Realism gain:* **high for complaint #1** — attacks the 2.6 %-per-pass under-convergence at its root; the published cure. *Feasibility:* >60 fps if the contact broad-phase is **amortized across substeps** (predict contacts once, reuse — Macklin 2019 §4); the bottleneck is contact rebuild, not the elastic pass. *Effort:* low-medium. *Risk:* medium — ~8× more contact builds unless amortized; the **logged chirality bug lives in the same orientation solve** and may interact with a changed iteration cadence. *License:* n/a.

**A3 — Give real mass/inertia from the unused `density` field.**
*What:* set `w_i = 1/m_i`, `wq_j = 1/I_j` from `MaterialProfile.density` (`material.ts:41`, currently confirmed unused) + cross-section, and add light velocity integration so `α̃` has a *physical* geometric denominator instead of the constant 2.
*Realism gain:* medium-high — this is what makes XPBD's stiffness-decoupling guarantee actually hold; heavier shaft resists buckling, makes A1's coax reaction physically meaningful, helps "feel real". *Feasibility:* non-unit scalars in the same loop; >60 fps. *Effort:* medium. *Risk:* medium — touches core mass handling and damping; adopt mass first, full angular dynamics later. *License:* n/a.

**A4 — Drop tip EI to 0.05–0.15 N·cm² + real pre-curve (Ω₀).**
*What:* lower `REGION.wireFloppyTip.eiCm` ~4–10×; transition EI linearly to shaft over **15–25 cm** (not abruptly); bake rest curvature into the bend-twist Ω₀ — J-tip = arc of radius 1.5 or 3 mm, angled = single bend, straight = 0, over the distal 1–8 cm.
*Realism gain:* medium — corrects the inverted profile so the tip flops into ostia and prolapses correctly. *Feasibility:* trivial; Ω₀ path already exists. *Effort:* low. *Risk:* low — but **only meaningful after A2** (otherwise the too-stiff tip is hidden by under-convergence); pre-curve interacts with the logged chirality bug; a real J-tip wants *anisotropic* bending (preferred plane) which the isotropic rod only approximates. *License:* n/a.

**A5 — Activate the compliant feed motor + finite force cap; cut damping.**
*What:* replace/supplement the hard `anchorInlet()` with the already-written-but-never-called `solveInletPositionMotor`; set `forceMax` ~0.5–2.0 N (working wire ~0.8 N, stiff support ~1.8 N buckling onset — Sarkissian 2011); drop `damping` from 0.9 toward physical.
*Realism gain:* medium-high for complaint #3 — back-pressure returns; a blocked tip stalls the feed and the shaft buckles/kicks back (target 0.6–3.0 cm) instead of bulldozing; removing the bleed restores pushability. *Feasibility:* trivial. *Effort:* low-medium. *Risk:* medium — land **after A2–A3**; without a converged, inertial column, removing damping lets the rod jitter and a low cap feels "stuck". Cap should scale with shaft EI. *License:* n/a.

**A6 — Real device parameter table + family selector.**
*What:* replace ad-hoc EI with measured values (N·cm²): tip 0.05–0.15; transition over 15–25 cm; shaft per family — working wire (Glidewire) ~2–5, stiff support (Amplatz Super Stiff) ~12–20, ultra (Lunderquist) ~45–49; catheter shaft ~5–10; long sheath ~6–17. Three friction coefficients: wall hydrophilic μ ≈ 0.08–0.10 *(rigid wall; an elastic wall drops to ~0.05/0.01 — same FE source)*, wall uncoated/PTFE ~0.25–0.35 *(coating CoF 0.01–0.05/0.3–0.4 are vendor values, confidence:medium)*, coax μ_io ~0.02–0.05. Expose a device dropdown.
*Realism gain:* medium — makes "too flexible/too stiff" a per-device, citable choice. *Feasibility:* pure data; zero perf cost. *Effort:* low. *Risk:* low — but **only sticks after A2** (otherwise re-tuning substeps re-breaks it). *License:* n/a.

**A7 — Fix radii/French geometry.**
*What:* wire `r ≈ 0.044 cm`; for wire-in-catheter-in-sheath, sheath ID ≥ 0.11 cm (6–7 Fr ID), OD ≈ 0.13–0.15 cm; use `I = πd⁴/64` consistently so EI and radius stay coupled. Make wall thickness configurable.
*Realism gain:* low-medium — makes coaxial containment geometrically possible. *Feasibility:* constants. *Effort:* low. *Risk:* low — changing radii shifts the CFL clamp (`0.25·min(R_lumen,h)`) and contact; re-tune. *License:* n/a.

### Group B — Upgrade the solver algorithm (still pure-TS, port the math)

**B1 — Stable Cosserat Rods orientation update (Hsu/Wang/Wu/Yuksel, SIGGRAPH 2025).**
*What:* keep IRsim's exact Kugelstadt-Schömer quaternion-orientation discretization and quasi-static premise, but replace the unstable XPBD quaternion projection with the paper's **split position/rotation** scheme + **closed-form Gauss-Seidel orientation update** (adjoint variable from the unit-quaternion constraint). Stiffness from physical EI/GJ; substeps control accuracy only.
*Realism gain:* high for #1 — stiffness becomes dt-independent and stable at large timesteps. *Feasibility:* the reference is an explicit "simple CPU implementation"; closed-form local updates, no linear solver to write; trivially real-time at IRsim's node counts. *Effort:* medium. *Risk:* medium — newest (Aug 2025), fewer reimplementations to cross-check; the orientation Gauss-Seidel ordering may interact with the **logged chirality bug**. **Honest caveats:** the reference repo (github.com/jerry060599/StableCosseratRods, **MIT**, C++/CUDA) ships **only cantilever/bridge/slingshot/tree examples — no contact, no friction, no coaxial, no injection BC.** So it is the **lowest-risk *orientation-solver* swap that fixes bending stiffness — NOT a drop-in full-feel fix**: all of IRsim's contact/friction/coax/injection stack must be re-integrated against the new split solve. It also **preserves the quasi-static orientation premise, so it does NOT add torque wind-up/whip.** Headline perf is GPU parallelism (2M DOF @ 4 fps RTX 3090); "46× vs DER, ≥18× per-iteration vs augmented VBD, orders-of-magnitude vs XPBD" — do **not** cite a precise "18× vs XPBD" number. *License:* paper CC BY 4.0; CPU ref MIT (GPU "YarnBall" is GPLv3 — use only the MIT CPU ref).

**B2 — Deul 2018 Direct Position-Based Solver for Stiff Rods.**
*What:* replace the per-constraint Gauss-Seidel elastic pass with a **direct linear-time solve** of the whole acyclic chain (Baraff-style banded LDLᵀ / tree-KKT, XPBD compliance K⁻¹ = diag(1/EI₁,1/EI₂,1/GJ)) inside a few Newton iterations; solves all stretch/shear/bend/twist simultaneously.
*Realism gain:* high for #1 — stiffness becomes **iteration-count independent and length-independent**; reaches high stiffness in a few Newton iterations where iterative needs ~10⁵. *Feasibility:* banded solve over ~100 nodes is O(N), trivial on CPU; pure JS >60 fps (WASM optional headroom only). *Effort:* high — must implement banded factorization + Newton loop in JS; contacts/coax remain iterative and must interleave; the **moving inlet/per-substep injection resizes the matrix** and needs care. *Risk:* high — touches the most code. **Caveat:** Deul models rods as *rigid segments* (per-segment orientation), not IRsim's exact particle+quaternion split, and the "~100×/2-orders" figure is a specific tree-benchmark vs local GS — present as "order-of-magnitude, benchmark-dependent." *License:* reference in Bender's **PositionBasedDynamics (MIT)**.

**B3 — Implicit co-rotational Timoshenko beam FEM with O(n) block-tridiagonal solve (SOFA BeamAdapter style).**
*What:* per-beam 6×6 local stiffness from real section geometry+material (E, A, Iy, Iz, G, J, shear areas), assemble the block-tri-diagonal system, solve implicitly with a Thomas-style block sweep (BTD). Stiffness becomes a true E·I quantity, unconditionally stable.
*Realism gain:* high/gold-standard — used by validated medical simulators; high E·I does not blow up the timestep. *Feasibility:* BTD is O(n); VCSim3 proved 2×512 at ~700 Hz on CPU, so ~100 nodes at 60 fps is comfortable. *Effort:* very-high — matrix assembly + banded solver + implicit integrator (Euler-implicit + Rayleigh damping) + friction layered as constraint correction. *Risk:* high — largest departure from the current XPBD constraint set. **Note:** BeamAdapter is **Kirchhoff-FEM per its README**; the "Timoshenko/co-rotational" label is a correct *inference* from its shear-area members (`_Asy/_Asz`) and adjoint frames, not a self-description. *License:* SOFA/BeamAdapter is **LGPL-2.1** (not GPL) — C++, not browser-portable; **port the algorithm, do not vendor.**

**B4 — Composite single-beam architecture (SOFA/Lenoir model) — the structural fix for #1+#2 together.**
*What:* replace the two-independent-rods + coax-contact design with **one** Cosserat rod whose per-arc-length MaterialField is the **parallel-stiffness sum** of whichever devices overlap there (EI_total = ΣEI_device). Each device has a tip arc-length (xtip) = its `deployed`; the overlap region uses summed stiffness, the wire-only region past the sheath tip uses wire stiffness, only the vessel lumen constrains past the tip. Telescoping = move one xtip relative to the other.
*Realism gain:* **highest** — makes all three complaints *structurally impossible*: the wire is automatically a stiff rail (summed EI), a stiff wire straightens the sheath (shared centerline — the exact "straightening effect" Scarponi et al. 2024 render and validate to 2.4 mm), the wire exiting is intrinsic (property transfer, no portal hack), and one-way coupling cannot exist (single body). This is the peer-reviewed canonical approach (Lenoir/Cotin/Duriez 2006 "composite model"; SOFA `InterventionalRadiologyController`). *Feasibility:* fewer DOFs and no inner/outer contact pairs ⇒ **often faster** than two rods + contact *(estimate, not benchmarked)*; pure CPU JS >60 fps. *Effort:* high — large refactor of `cosserat.ts`/`coax.ts`/`insertion.ts`; needs a MaterialField-combination rule and a dual visual representation (draw wire and sheath as offset tubes around the shared centerline). *Risk:* medium-high — wire and sheath share one centerline in the overlap, so clearance/play between them is *approximated*, not resolved (correct for a snug wire, lossy for a loose one). *License:* port the architecture (LGPL-2.1 SOFA reference); your engine stays Cosserat/XPBD.

### Group C — Adopt/port an external library

Ranked by viability. **Verdict up front: no library drops in.** Keep the hand-written TS Cosserat rod — it is the right architecture and the only thing that hits 60 fps as pure JS today.

| Rank | Library | What you'd get | WASM/browser path | Verdict |
|---|---|---|---|---|
| 1 | **PositionBasedDynamics (Bender, MIT, C++/Eigen)** | Reference for the Deul direct stiff-rod solver and Cosserat constraints | Either hand-port the algorithm to TS (B2), **or** a focused Emscripten build of *just* the stiff-rod solver (sidesteps a TS reimplementation of banded factorization) | **Best borrow.** The thin-WASM-module path is an under-weighed option *(confidence:medium, not benchmarked)* if the no-WASM rule relaxes. |
| 2 | **StableCosseratRods (Utah/Lightspeed, MIT CPU ref)** | The B1 orientation update | Port to TS (no contact/coax/injection in the repo) | **Best for #1 stiffness.** Algorithm-only; not a full system. |
| 3 | **SOFA + BeamAdapter (LGPL-2.1, C++)** | Gold-standard coaxial IR deployment, validated | **No WASM build exists or is practical** (full framework dependency graph). Server-side streaming only — defeats the web-first/offline premise | **Reference oracle only.** Port the composite-beam architecture (B4) and the radial-only sliding constraint; do not vendor. |
| 4 | **PyElastica (GazzolaLab, MIT, Python+Numba)** | Full dynamic Cosserat rods | Pyodide can't JIT Numba; multi-MB runtime, not 60 fps | **Offline ground-truth oracle only** (see §5). |
| 5 | **Jolt (MIT, ships WASM)** | Cosserat rods added v5.4.0 | Not exposed in JoltPhysics.js IDL; the "Cosserat rod" is a cheap vegetation stick-with-orientation, no tunable EI/GJ | Use for **rigid anatomy collision only**, not the instrument. Adds a WASM boundary the project avoids. |
| 6 | **Project Chrono (BSD-3, C++)** | `ChElementBeamANCF` (shear-deformable beam, real EI/GJ/torsion) + documented Emscripten/WASM path | WASM build large; no interactive-guidewire-at-60-fps-in-browser evidence | **Performance-risky, very-high effort.** Borrow the ANCF formulation at most. (`ChElementCableANCF` neglects shear/twist — use the full beam element.) |
| — | **Rapier / Ammo.js-Bullet / cannon-es / three.js ropes** | — | Ship WASM/JS at 60 fps | **Reject as instrument solvers.** Rapier rope joint = max-distance limit (no bend/twist); Bullet/Ammo ropes are mass-spring with **no torsion**; Verlet ropes get stiffness only by adding iterations (the same entanglement IRsim is escaping). Fine for non-instrument props. |
| — | **NVIDIA Warp / Flex** | GPU rods | No WASM/WebGPU browser target (Warp = CUDA JIT; Flex = closed-source CUDA) | **Not deployable to a browser.** |

### Group D — Data-driven / hybrid

**D1 — Hybrid stiff-shaft Cosserat + dedicated generalized-bending tip (Tang et al. 2012, IEEE TBME).**
*What:* full Cosserat stretch-shear + bend-twist on the supportive shaft; a separate cheaper generalized-bending model on the short floppy/pre-shaped tip — mirroring a real welded floppy tip on a stiff core. Phantom-validated to **~1.34 mm avg / 1.66 mm RMS** (the authors call it "near sub-millimetre" — *do not say "sub-mm"*).
*Realism gain:* medium — captures the characteristic tip-flops/shaft-drives behavior. *Feasibility:* CPU-feasible, tip model is cheaper, net perf-neutral. *Effort:* medium. *Risk:* junction can introduce a stiffness-discontinuity artifact. *License:* n/a (port concept). **Note:** IRsim already grades one continuous EI field, which is the same idea more cheaply — this is an upgrade only if the graded field can't capture the tip transition.

**D2 — Neural surrogate of wire dynamics. → Reject.**
No released endovascular dynamics surrogate exists; autoregressive surrogates "degenerate over longer horizons due to distribution drift"; there is no patient-independent training corpus for wire dynamics. The 2022–2025 "neural" endovascular work is navigation *policies* (RL/imitation) and *perception* (tip tracking/segmentation), not physics replacement. **Do not pursue; reserve ML strictly for perception/eval.** Likewise **do not adopt CathSim's MuJoCo rigid-chain** (80 revolute-jointed rigid bodies; user-rated only **3.86/5** on navigation realism) as a fidelity reference — it would regress IRsim.

**D3 — Blood-flow forcing on the floppy tip. → Deferred decision, not omission.**
Cai et al. 2017 improved phantom RMS from 4.81 → 2.14 mm by adding Poiseuille blood-flow forcing — a >2× gain — and the Sharei review calls flow "an understudied area … neglected in most studies." Likely out of scope for a navigation trainer, but record it as an **explicit deferred decision.**

---

## 3. Recommended path (phased)

The ordering is forced by interaction risk and by the deferred **chirality bug** (left-curving vessels navigate worse; guarded by a skipped parity test), which lives in the same orientation solve that Phases 2–3 touch.

### Phase 0 — Measure (days; do before touching the solver)
1. **A0** validation rigs (cantilever, buckling, three-point-bend, **substep-invariance**). Substep-invariance will fail today — that is the proof of the entanglement.
2. **Treat the chirality bug as a gating prerequisite**, not an afterthought: add/un-skip its parity test alongside A0 so that any Phase-2 orientation-solve change is checked for chirality regression *as it lands*, not after.

### Phase 1 — Stop the bleeding, cheapest first (low effort, high payoff)
3. **A1** — flip `COAX_OUTER_MASS_SCALE` to a real value. The worktree starts conservatively at 0.05; re-sweep after real per-node mass lands. *(Complaint #2.)*
4. **A6 + A7** — load the real EI table, the three friction coefficients, the family selector, and corrected radii/wall. *(Complaint #1 targets + #3e geometry.)*
5. **A4** — pre-curve + transition over 15–25 cm (lands now but only *felt* after Phase 2).

### Phase 2 — Make stiffness physically honest (the real fix for "too flexible")
6. **A2** — flip to Small-Steps (S = 8–16 × ~1 iter, λ reset per substep, physical α fixed), **amortizing the contact set across substeps.** Verify A0's substep-invariance test now passes. *(Complaint #1.)*
7. **A3** — real mass/inertia from `density`; light velocity integration. Re-confirm A1's two-way coax is now physically meaningful and stable.
8. **A5** — activate the compliant feed motor, finite `forceMax` (0.5–2 N, scaled to shaft EI), cut `damping` toward physical. *(Complaint #3 — back-pressure, prolapse, pushability.)*
9. **A4** tip EI now reads correctly (was masked by under-convergence).
   *Decision gate:* if iterative XPBD still can't reach shaft stiffness within budget after A2–A3, escalate to Phase 3.

### Phase 3 — Solver upgrade (medium-term, only if Phase 2 falls short)
10. **B1 (Stable Cosserat Rods orientation update)** — lowest-risk algorithmic swap, closest to the current architecture; re-integrate contact/coax/injection. Watch chirality. **OR B2 (Deul direct solver)** if you want guaranteed length-independent stiffness and accept the banded-solver implementation cost.

### Phase 4 — Ambitious / structural (if you want the canonical model)
11. **B4 composite single-beam** — makes #1 and #2 structurally impossible and matches the peer-reviewed canonical approach; large refactor. Consider only if the two-rod model keeps fighting you on telescoping stability.

### Explicit non-goals (decide consciously)
- **Torque/twist (wind-up/whip):** out of scope of Phases 0–4. To add it you must make twist a *dynamic* DOF (store torsional strain energy, finite GJ, angular-velocity integration) — the dynamic-Cosserat / CoRdE lineage (Wang 2010, Tang 2012), **not** Stable Cosserat Rods. If you don't want that, adopt the *infinite-GJ, tip = input* simplification deliberately rather than leaving the current no-angular-dynamics gap.
- **Deformable vessel walls:** rigid walls are the right call for a navigation trainer (Sharei review confirms rigid models "performed better in guidewire navigation and catheter stability"), but state it as a *deliberate simplification with a known limitation* — a very stiff Lunderquist-class wire *does* deform real vessels in tortuous iliacs.
- **Blood-flow forcing (D3), neural surrogate (D2):** deferred / rejected as above.

### Parameter table (targets for the MaterialField and tests)

| Quantity | Value | Source / note |
|---|---|---|
| Wire floppy tip EI | **0.05–0.15 N·cm²** | Qiu 2023 (Glidewire 0.06, Bentson 0.02, Jwire 0.15) — worktree target: 0.1 |
| Wire shaft EI — working (Glidewire) | ~2–5 N·cm² | Qiu 2023 shaft range ~1–13 |
| Wire shaft EI — stiff support (Amplatz Super Stiff) | **~12–20 N·cm²** | Harrison 2011: Extra Stiff 8.95, Super Stiff 18.5 — IRsim's 12 is already correct |
| Wire shaft EI — ultra (Lunderquist) | ~45–49 N·cm² | Harrison 2011: 48.6 |
| Tip→shaft transition zone | over **15–25 cm** from tip | Qiu 2023 |
| Pre-curve Ω₀ | J-tip arc radius **1.5 or 3 mm**; angled = single bend; over distal **1–8 cm** | Terumo Glidewire tip lengths 1/3/5/8 cm |
| Catheter shaft EI | ~5–10 N·cm² | Qiu 2023 6F SOFIA shaft 7.54 |
| Long sheath shaft EI | ~6–17 N·cm² | Qiu 2023 (Neuron Max 16.2, Ballast 17.0) — IRsim's 60 is high; consider lowering |
| GJ (torsion) | **GJ = EI/(1+ν) ≈ 0.77·EI** at ν=0.3 | isotropic circular rod (NOT "EI·G/E"); expose GJ separately; consider preferred-bend plane for J-tips |
| μ wall, hydrophilic (rigid wall) | 0.08–0.10 (static 0.10 / kinetic 0.09) | FE study; **elastic wall ≈ 0.05/0.01** (same source) |
| μ wall, uncoated/PTFE | ~0.25–0.35 | coating CoF 0.01–0.05 / 0.3–0.4 vendor (confidence:medium) |
| μ coax wire-in-catheter | **0.02–0.05** | lubricated lumen; lower than wall (matches current design intent) |
| Feed force cap | **0.5–2.0 N** (working ~0.8, stiff support ~1.8) | Sarkissian 2011 buckling; Synchro-Select push 0.36–0.81 N — replace 1e12 |
| Target kickback/prolapse on over-push | **0.6–3.0 cm** | Synchro-Select MCA/ICA models |
| Wire radius | **r ≈ 0.044 cm** (0.035") | currently 0.05 = 0.039" |
| Sheath (for wire+catheter coax) | ID ≥ 0.11 cm (6–7 Fr ID), OD ≈ 0.13–0.15 cm | French sizing; configurable wall, not fixed +2 Fr |
| Substeps × iterations | **S = 8–16 × ~1 iter** (λ reset/substep), contact amortized | Macklin 2019 Small Steps |

### Acceptance / bench tests (Vitest, headless)
1. **Three-point bend** — 40 mm span; back out EI = L³·ΔF/(48·ΔD); assert within ±15 % of target per region.
2. **Cantilever** — δ ≈ FL³/(3EI) per region (tip/transition/shaft).
3. **Shaft buckling onset** — ~1.8 N stiff support / ~0.8 N working wire (Sarkissian).
4. **Euler buckling** — straight below P_cr = π²EI/(KL)², buckled above.
5. **Tip bending-force ranking** — floppy tip << shaft.
6. **180° arch-phantom prolapse threshold** — fixed golden geometry.
7. **Pull-through friction** — force vs μ.
8. **Telescoping** — wire leads past sheath tip; sheath *visibly deflects* when a stiff wire is pushed through it (regression for A1).
9. **Substep-invariance** — deflection unchanged when S doubles (catches re-entanglement automatically).
10. **Torque transfer (if/when twist is added)** — 1:1 lag/whip, turns-in vs turns-out per ASTM F2394.
11. **Golden arch-shape** — equilibrium centreline RMS vs reference (VCSim3 1.66 mm / Luboz 2.27 mm as scale anchors) — once stiffness is dt-decoupled.

---

## 4. Comparison table — rod-model / library options

| Model / library | Stiffness fidelity | Real-time cost (IRsim scale) | Browser feasibility | License | Effort |
|---|---|---|---|---|---|
| **Current: free-Cosserat XPBD, unit mass, quasi-static** | Poor (entangled w/ dt & S; under-converged) | Cheap | Pure TS ✓ | (IRsim) | — (baseline) |
| **A: same + Small-Steps + real mass/inertia** | Good (honest EI if converged; still GS) | Cheap (contact amortized) | Pure TS ✓ | n/a | Low–med |
| **B1: Stable Cosserat Rods orientation update** | High, dt-independent, stable at large dt | Cheap | Pure TS ✓ (MIT CPU ref) | paper CC BY 4.0 / ref MIT | Medium |
| **B2: Deul direct stiff-rod solver** | High, iteration- & length-independent | Cheap (O(N) banded) | Pure TS ✓ (WASM optional) | ref MIT (PBD lib) | High |
| **B3: implicit co-rotational Timoshenko beam FEM (BeamAdapter)** | Gold-standard, unconditionally stable | Cheap (O(N) BTD) | Reimpl. in TS ✓; SOFA itself ✗ | SOFA LGPL-2.1 (don't vendor) | Very high |
| **B4: composite single-beam (Lenoir/SOFA)** | High; #1+#2 structurally solved | Cheap; often faster than 2-rod *(est.)* | Pure TS ✓ | port architecture | High |
| **D1: hybrid Cosserat shaft + generalized tip (Tang 2012)** | Good; phantom-validated 1.66 mm RMS | Cheap (tip cheaper) | Pure TS ✓ | n/a | Medium |
| **PyElastica** | High (full dynamic Cosserat) | Offline only | ✗ (Numba/Pyodide) | MIT | Oracle only |
| **SOFA BeamAdapter (whole)** | Gold-standard, validated | Server-class | ✗ (no WASM) | LGPL-2.1 | Server/oracle |
| **Jolt** | None for rods (vegetation stick) | Cheap | WASM ✓ | MIT | (anatomy only) |
| **Rapier / Bullet-Ammo / Verlet ropes** | None (no bend/twist) | Cheap | WASM/JS ✓ | various | Reject (instrument) |
| **Project Chrono ANCF beam** | High (full beam el.) | Unproven in browser | WASM (large) | BSD-3 | Very high |
| **CathSim (MuJoCo rigid chain)** | Low (3.86/5 nav realism) | 40–80 fps | (server) | CC BY-NC-SA | Reject (fidelity ref) |
| **Neural surrogate** | N/A (drifts; none exists) | — | — | — | Reject |

---

## 5. Confidence & sources

### What is solid (build on these)
- **Code diagnosis** — every in-repo claim verified at file:line at the time of review: substep-as-stiffness admission, unit masses, unused `density`, one-way coax, dead feed motor vs hard anchor, damping bleed, inverted tip EI, portal/lead-out logic that *works*. Some line numbers drift as fixes land; the diagnosis remains the strongest, most actionable part of the review.
- **EI numeric backbone** — Qiu 2023 (open-access tip-vs-shaft library, reproduced exactly) and Harrison 2011 (EI conversions reproduce to 2 sig figs). **High.**
- **The "too soft because under-converged" thesis** — Deul et al. 2018 verbatim; the bend-compliance mapping `α_b = ℓ/(4·EI)` is the correct ½θ-convention form of `α = K⁻¹`. **High.**
- **One-way coax violates Newton's third law; every reference uses two-way coupling** — VCSim3 concentric constraints, Imperial CoRdE binding constraints, SOFA `AdaptiveBeamSlidingConstraint` (radial-only, free axial). **High.**
- **Compute is not the limiter** — VCSim3 2×512 nodes ~1.44 ms (collision on a separate thread); IRsim's ~100 nodes at 60 fps is ~30× looser than haptic. **High.**

### Corrections folded in (do not repeat the earlier errors)
- **SOFA/BeamAdapter is LGPL-2.1**, not GPL-3.0 / LGPL-3.0. BeamAdapter is **Kirchhoff-FEM** per its README (the "Timoshenko/co-rotational" label is an inference from its members).
- **Friction is regime-dependent**, not one number: rigid-wall 0.10/0.09 vs elastic-wall 0.05/0.01 (same FE source); coating CoF figures are vendor values (confidence:medium).
- **μ = 0.62 + Signorini + rigid walls** is *not one source* — μ=0.62 comes from Pescio et al. (deformable phantom); the "rigid walls, empty lumen" quote is a different paper (arXiv 2406.12499) with no μ. Don't conflate.
- **Tang 2012 accuracy is 1.34 mm avg / 1.66 mm RMS**, not "sub-mm".
- **Stable Cosserat Rods perf** — "46× vs DER, ≥18× per-iteration vs augmented VBD, orders-of-magnitude vs XPBD"; do not write "18× vs XPBD"; its repo has **no contact/coax/injection** and it **preserves quasi-static orientation (no wind-up/whip).**
- **Deul** models rigid segments (not IRsim's exact split); its "~100×" is a tree-benchmark vs local GS — "order-of-magnitude, benchmark-dependent."
- **French sheath offset** — the "+2 Fr OD" rule is dated; use configurable wall thickness. **GJ = EI/(1+ν)**, not "EI·G/E".

### Marked low-confidence / unverified
- The **"~15–27 % realized stiffness per frame"** numbers are an *illustrative* single-constraint estimate; the cantilever rig (A0) is the actual measurement. (medium)
- **"~20 substeps recommended by Müller"** — not in a primary source; "start 16–25" is engineering judgment. (low)
- Wang 2010 "dynamic-centreline / quasi-static-deformation" framing — paywalled, unverified (but the same Imperial lineage's VCSim3 *does* model twist dynamically). (low)
- ImaGiNe "28 patient datasets / force-and-flexibility measurements"; Mentice "proprietary patented engine" — unverified in a primary source; Mentice/Simbionix engines are **undocumented**, so borrow the *open* VCSim3/SOFA/Tang/Wang approach, not theirs. (low)
- Coating CoF (0.01–0.05 / 0.3–0.4), Harrison rig sub-details (40 mm span etc.), Wünsche 2002 anisotropy citation — (medium/low; anisotropy itself corroborated by Ceschinski 2000).
- The dropped **Clayman 2004 "4-axis rig"** citation does not resolve to a guidewire-mechanics paper — **do not cite it**; use Sarkissian 2011 alone for buckling/puncture targets.
- stEVE/CathAction license strings and the "composite-beam is faster than 2-rod" and "≥60 fps in browser" perf figures are **engineering estimates, not benchmarks.** (medium)

### Key sources (inline)
Deul/Kugelstadt/Weiler/Bender 2018 *Direct Position-Based Solver for Stiff Rods* (CGF); Macklin/Müller/Chentanez 2016 *XPBD*; Macklin et al. 2019 *Small Steps in Physics Simulation*; Hsu/Wang/Wu/Yuksel 2025 *Stable Cosserat Rods* (SIGGRAPH; github.com/jerry060599/StableCosseratRods, MIT CPU ref); Bergou et al. 2008/2010 *Discrete Elastic Rods*; Tang et al. 2012 (IEEE TBME, PMID 22614515) and **VCSim3** (Tang et al. 2017, Int J CARS, PMC5754385); Luboz et al. 2011 (mass-spring, 2.27 mm); Cai et al. 2017 (Kirchhoff+blood-flow, 4.81→2.14 mm); Lenoir/Cotin/Duriez 2006 *composite catheter+guidewire*; Scarponi/Cotin 2024 (*FBG-driven simulation…*, Healthcare Technology Letters 11(6):392-401, DOI 10.1049/htl2.12108 — straightening effect, 2.4 mm); **SOFA BeamAdapter** (LGPL-2.1, Kirchhoff-FEM, `InterventionalRadiologyController`/`AdaptiveBeamSlidingConstraint`) and SofaDefrost/Cosserat (Renda PCS, LGPL); Imperial CoRdE / *Massively-Parallel Inextensible Elastic Rods* (arXiv 2509.04277); Sharei et al. 2018 review (J Med Imaging, PMC5787668); Qiu et al. 2023 (three-point-bend library, PMC10760252); Harrison et al. 2011 (J Endovasc Ther 18:797-801); Sarkissian et al. 2011 (Urology, PMID 22173176); Synchro-Select study (PMC12213524); Ceschinski 2000 (PMID 10950205) / Brecher 2014 (DOI 10.1515/bmt-2013-0027); CathSim, stEVE, CathAction (validation assets, perception-only). Bender **PositionBasedDynamics** (MIT). NVIDIA Warp/Flex, Jolt (MIT), Rapier, Project Chrono (BSD-3), PyElastica (MIT) as surveyed in §2 Group C.
