# Physics Design: Dynamic Co-Rotational 3D Beam Solver (IRsim)

Status: APPROVED architecture, pre-implementation spec. Flag-gated (`params.useDirectSolve`, per-rod, default OFF) so the live XPBD path stays byte-for-byte until every gate is green.

Author: lead consolidation of the verified math spec + adversarial verification. Date: 2026-06-05.

---

## 0. Summary

We replace IRsim's under-converged XPBD elastic/bend sweep with a **fully dynamic, implicit, co-rotational 3D beam FEM** (Crisfield/Battini element-independent co-rotational formulation). Two independent rods are kept (inner wire + outer sheath). Existing frictional contact, the capsule-chain SDF lumen, coaxial coupling, and the material-injection feed boundary are re-integrated on top.

The key behavioral delta vs the prior quasi-static B3 design: **twist is a dynamic DOF**. Rotational inertia, angular-velocity integration, and finite GJ are kept live so torsional wind-up/whip (tip rotation lags the hub, then snaps) **emerges** — it is a required felt behavior, not quasi-static. Translational mass is also real.

### Hard invariants (do not violate)
- Units: **cm** for length, **SI seconds** for time. EI/GJ in **N·cm²** (`EI[N·cm²] = 1e4·EI[N·m²]`). EA in **N**.
- **Density ρ in N·s²·cm⁻⁴** (the cm-consistent mass unit). Then `M_i = ρ·A·ℓ` is N·s²·cm⁻¹ and `M/Δt²` is **N/cm natively** — dynamic nodal forces come out in Newtons with **no scale factor**. `forceScale` (units.ts) is NOT applied to dynamic forces; it stays exclusively on the XPBD λ/Δt² path.
- The repo's ½θ quaternion-imag convention (`alphaBend = ℓ/(4·EI)`, `restCurvature` stored as raw axis-angle radians, encoded `≈ sin(φ/2)` only at read time) must be honored at the q-update boundary that contact/coax read.
- 60 fps budget: 16.7 ms/frame (~80–100 nodes × 2–3 instruments), pure TypeScript, no WASM, Float64 throughout.

### EI targets (assert)
tip 0.05–0.15, transition over 15–25 cm, working-wire shaft 2–5, Amplatz 12–20, Lunderquist 45–49, catheter 5–10, sheath 6–17 N·cm². GJ ≈ 0.77·EI.

---

## 1. Corrected math (authoritative)

This section supersedes all prior drafts. Every adversarial-verifier correction is applied; overrules are noted explicitly.

### 1.1 Units — the single mass convention (FATAL fix)

Three drafts conflicted on mass units (grams + forceScale; massScale=1e-3; ρ in N·s²·cm⁻⁴). The **only** dimensionally consistent choice is:

> **ρ in N·s²·cm⁻⁴.** Then `M_i = ρ·A·ℓ` [N·s²·cm⁻¹], `J_i = ρ·I·ℓ` [N·s²·cm], `M/Δt²` is N/cm and `J/Δt²` is N·cm. Inertial nodal forces are Newtons natively.

The grams-based draft (`F = forceScale·g·cm/s²` with forceScale=1.0) overstated every inertial force by 1e5×. `forceScale` is documented in units.ts as ratio-only (XPBD λ/Δt² → cm-force); it is **not** a mass→force map. If a g/cm³ density is ever ingested, convert once at the read boundary: `ρ[N·s²·cm⁻⁴] = ρ[g/cm³]·1e-5` (since 1 N = 1e5 g·cm/s²). Document that 1e-5 like `CM_PER_M`; never route it through forceScale.

`α_b = ℓ/(4·EI)` has units 1/(N·cm); it pairs with a multiplier λ (N·cm) against the dimensionless quaternion-imag constraint so the product is dimensionless. The FEM uses `EI = ℓ/(4·alphaBend1)` directly. **The factor 4 must not appear in K_mat or K_geo** — it lives only in the XPBD compliance.

### 1.2 Element kinematics (co-rotational)

DOF order per element: `[d_i(3,cm), θ_i(3,rad), d_j(3,cm), θ_j(3,rad)]`, node i proximal, j=i+1 distal. Global `u ∈ R^{6N}`.

Element frame `R_e = [r1 | r2 | e3]`:
- `e3 = (p_j − p_i)/|p_j − p_i|` (chord, proximal→distal). Clamp `ℓ_n ≥ ℓ_min = 0.05·ℓ_e`.
- `r1` = Gram-Schmidt of the mean-frame first director `g1 = R(slerp(q_i,q_j,0.5))·ê1` against `e3`. Flip `q_j → −q_j` if `dot4(q_i,q_j)<0` before slerp (shortest arc — **confirmed reflection-invariant**).
- `r2 = e3 × r1`, det = +1.
- Degenerate `g1 ∥ e3`: fall back to `g2`. Double-degenerate: for the round wire (isotropic EI), **transport the previous element's r1** — do NOT use the world-axis fallback (it is not reflection-equivariant). Roll is irrelevant for isotropic bending.

Local deformational DOFs: `ū = ℓ_n − ℓ_e`; `θ̄_i = logSO3(R_eᵀ R(q_i))`, `θ̄_j = logSO3(R_eᵀ R(q_j))`.

`logSO3(R)`: `c = clamp((tr R − 1)/2, −1, 1)`, `φ = acos(c)`. If `φ < 1e-8`: `axisVec = ½[R32−R23, R13−R31, R21−R12]`. Else `axisVec = (φ/(2 sinφ))·[…]`.

### 1.3 Chirality / curvature measure (mirror proof)

Curvature `κ_vec = logSO3(R(q_i)ᵀ R(q_j))/ℓ_e`, **no closest-quaternion branch**. Under x-reflection `S = diag(−1,1,1)`: `R ↦ S R S`, and using `S [a]_× S = det(S)·[S a]_×`,
```
log(S·R_iᵀR_j·S) = −S·Θ = (Θ_x, −Θ_y, −Θ_z)
```
The in-plane bend is exactly negated, magnitude preserved (confirmed numerically 5/5). κ0 reflects identically, so `κ − κ0` is antisymmetric ⇒ identical energy, opposite-sign bend.

> **OVERRULE / demotion of the chirality fix claim.** The prior draft asserted that removing `solveBendTwist`'s `plusSq<minusSq` sign branch fixes the documented left-vs-right asymmetry. This is **refuted**: that branch uses squared components and is reflection-equivariant (4/4 trials). The co-rotational κ measure removes the *bend measure* as a suspect, but does **not** by itself fix chirality. The real culprit must be bisected (Phase 4): prime suspects are (1) `solveStretchShear` frame-follow `qe3bar` rotation, (2) the hub `injectedFrame`/steer deflection axis (world-fixed vs vessel-adaptive), (3) lumen graph hysteresis at the iliac carina.

### 1.4 Local 12×12 stiffness (Kirchhoff default)

- Axial: `k_a = EA/ℓ` on `(d_i·e3, d_j·e3)`. Torsion: `k_t = GJ/ℓ` on `(θ_i·e3, θ_j·e3)`.
- Bend plane y (deflection e1, rot e2), sign `s = +1`:
```
EI/(ℓ³(1+Φ))·[[12, 6ℓ, −12, 6ℓ],
              [6ℓ, (4+Φ)ℓ², −6ℓ, (2−Φ)ℓ²],
              [−12, −6ℓ, 12, −6ℓ],
              [6ℓ, (2−Φ)ℓ², −6ℓ, (4+Φ)ℓ²]]
```
- Bend plane z (deflection e2, rot e1), `s = −1`: same matrix with the off-diagonal `6ℓ` coupling **sign flipped to −6ℓ**.
- **Kirchhoff Φ=0 for the wire.** At ℓ_e=0.25, r=0.05 the shear parameter `Φ = 12EI/(GA_s ℓ²) ≈ 0.35` is non-negligible (confirmed), so a naive finite-GA_s Timoshenko element would soften the thin wire artificially. Finite-Φ is optional only for the larger sheath where ℓ_e/r is larger.

### 1.5 Co-rotational force and tangent

`f̄ = K̄·p̄_dev` (7-vector reduced local force). `N = f̄[0]` axial internal force (**tension > 0**). `f_int = Bᵀf̄`; `K_mat = BᵀK̄B`; `K_geo = ∂(Bᵀ)/∂u·f̄`.

Axial-N part of K_geo (buckling-critical, fully explicit), coefficient `c = N/ℓ_e`, sign `s` per plane:
```
[[6/5, s·ℓ/10, −6/5, s·ℓ/10],
 [s·ℓ/10, 2ℓ²/15, −s·ℓ/10, −ℓ²/30],
 [−6/5, −s·ℓ/10, 6/5, −s·ℓ/10],
 [s·ℓ/10, −ℓ²/30, −s·ℓ/10, 2ℓ²/15]]
```
The SAME `s = ±1` from K_loc carries into the `ℓ/10` and `ℓ²/30` off-diagonals.

**Sign (the single highest-risk sign in the solver):** `K_t = K_mat − P·K_g_unit` with `K_g_unit` at N=+1. Compression (N<0) softens the lateral tangent toward singularity at `P_cr`. Wrong sign ⇒ tension blows up / compression never buckles (the fingerprint). Confirmed to reproduce Euler buckling to <0.1% with monotone convergence from above.

The **moment part** of K_geo (Battini eq. 22–25) is added in Phase 2 — it is needed for quadratic Newton under large rotation increments but **not** to pass the buckling gate.

### 1.6 Buckling + cantilever validation targets

```
P_cr = π²·EI/(K·L)²          δ_tip = F·L³/(3·EI)
```
`L = (N_nodes−1)·ℓ_e`, `K = 2.0` fixed-free (matches the fixedPrefix=2 clamp). Sanity: wire shaft EI=12, L=10, K=2 → 0.296 N; Lunderquist EI=47 → 1.16 N; cantilever F=0.1, L=5, EI=12 → 0.347 cm (all confirmed).

### 1.7 Dynamic integration (backward-Euler) — FATAL RHS fix

The unknown is the **increment Δu** (then `x += Δp`, `q := exp(½δθ)⊗q`). The RHS must be in **increment form**, NOT the absolute `(2x^n − x^{n-1})` form (which double-counts state by injecting a spurious `(m/Δt²)·x^n` and blows up on frame 1 — verified: a 1-DOF free-flight gives 0.3 instead of 0.2):
```
b_trans_i = f_ext_i − r_int,trans_i + (m_i/Δt_s)·v_i^n        v_i^n = (x_i^n − x_i^{n-1})/Δt_s
b_rot_i   = m_ext_i − r_int,rot_i  + (J_i/Δt_s)·ω_i^n
```
LHS (both blocks): `A_i = M_i/Δt_s² + a0·M_i/Δt_s + (a1/Δt_s)·K_i + K_i` (+ whip-guard diagonal on the twist DOF only).

(Equivalent alternative: keep `(2x^n − x^{n-1})` but solve for **absolute** x^{n+1}, i.e. `x = du` not `x += du`. Pick ONE; this spec ships the increment form.)

### 1.8 Lumped mass and conditioning (the "equivalently" fix)

Section: `A = πr²`, `I = πr⁴/4`, `J = 2I`. Half-segment lumping:
```
m_i        = ρ·½(A_{i-1}ℓ_{i-1} + A_iℓ_i)
J_i^twist  = ρ·½(J_{i-1}ℓ_{i-1} + J_iℓ_i)
J_i^bend   = ρ·½(I_{i-1}ℓ_{i-1} + I_iℓ_i)
M_i = diag(m_i, m_i, m_i, J_i^bend, J_i^bend, J_i^twist)
```

> **Correction.** The prior draft said the bend-conditioned and twist-conditioned ρ are "equivalent." They are NOT: `ρ_bend/ρ_twist = A·ℓ²·(GJ/EI)/J_sec ≈ 38×` for the wire. A single ρ_e cannot make both R_bend and R_twist O(1). The original bring-up therefore used a **synthetic twist-conditioned per-element ρ** (strategy b):
```
ρ_e = R*·GJ_e·Δt_s²/(J_sec,e·ℓ_e²),   R* ≈ 1   (strategy b, per-element — SUPERSEDED in Phase B)
```
accepting whatever R_bend fell out.

> **PHASE B — PHYSICAL MASS (supersedes the synthetic ρ above).** The synthetic ρ_e was GJ-derived, so
> it destroyed the real mass RATIOS between regions/instruments (every region got identical
> conditioning regardless of stiffness/material) and made the contact/coax inverse-mass metric a fake
> number. Phase B replaces it with PHYSICAL lumped mass from real section geometry × real material
> density (`MaterialProfile.density`, g/cm³: stainless ~7.9, nitinol ~6.5, polymer/sheath ~1.0–1.6,
> converted ONCE via `densityFromGramsPerCm3`):
> ```
> m_i = ρ·½(A_{i-1}ℓ_{i-1}+A_iℓ_i),  J_i^bend = ρ·½(I…),  J_i^twist = ρ·½(J_sec…)   — ρ now PHYSICAL
> ```
> A guidewire is genuinely tiny-mass, so strictly-physical M/Δt² at h=0.5, Δt_s=1/240 is ~6 orders
> below the stiffness K — that would ill-condition Newton AND erase the felt wind-up/whip. Resolution:
> keep the physical mass RATIOS, multiply by tuned absolute conditioning scales **DECOUPLED from GJ**
> (`cosserat.ts`). Phase B originally used a single `D_MASS_SCALE = 8.0e5`; a subsequent analysis
> (2026-06-12) showed that uniform lift put the **translational** term m/Δt² ≈ 14,300 N/cm ~12× ABOVE
> the transverse bend stiffness 12EI/ℓ³ ≈ 1,152 N/cm (shaft EI=12), over-damping every bending mode
> to near-stasis (~7 min recovery on a 10 cm span). The scale is therefore **SPLIT** into two
> independent knobs in `CosseratRod`:
>
> - **`D_MASS_SCALE_TWIST = 8.0e5`** — applied only to the torsional inertia Jt.  Unchanged from
>   Phase B: reproduces the validated twist-feel regime (wire-shaft Jt/Δt² ≈ 17.9 vs GJ/ℓ ≈ 18.4,
>   steel ρ=7.9, r=0.05, h=0.5). **NEVER re-couple this to GJ** — that coupling was the old ~38× defect.
>   Canaries: wind-up / whip / BE-decay gates in `beamfem/dynamic.test.ts`.
>
> - **`D_MASS_SCALE_TRANS = 8.0e5`** (shipped; planned drop to **8.0e2** pending contact work) — applied
>   to translational inertia m AND bending-rotational inertia Jb (both mix the same deflection modes, so
>   the pair moves together). The bending-true value is 8.0e2: at shaft EI=12, μ=ρA=6.20e-7 N·s²/cm²,
>   h=0.5, Δt_s=1/240 this gives m/Δt² ≈ 14.3 N/cm ≈ 0.012·(12EI/ℓ³) — inertia no longer masks the
>   calibrated EI, first bending mode ≈5.5 rad/s, ζ≈1.14 (essentially critically damped). EMPIRICAL
>   BLOCKER: with bending-true mass the wall friction stack cannot hold a springy wire against stored
>   bending energy; shipped-coax shallow climb collapses (9.30 → 0.45 cm). The defect is documented-red
>   in `dynamic_recovery.test.ts` (`it.fails`) until the Phase-J contact/friction work lands.
>
> The contact/coax inverse-mass metric is mean-normalized (`dContactMassScale = mean(m)`,
> `invMass = mean/m`) and is invariant to BOTH absolute scales, so the split plumbing is safe regardless
> of whichever value D_MASS_SCALE_TRANS holds. Absolute mass is a free knob for a heavily damped
> trainer; the ratios are physics, the absolute level is the tuned knob.

### 1.9 SO(3) rotational update (½θ boundary)

Body-frame right-multiply from the converged increment `δθ_n`:
```
φ = |δθ|;  if φ<1e-9: dq = (½δθ, 1);  else s = sin(½φ)/φ, dq = (s·δθ, cos(½φ))
q_n ← normalize(q_n ⊗ dq);   reset δθ ← 0;   ω_n^{n+1} = θ_total/Δt_s
```
This produces `Im(conj(q_i)q_j) = sin(angle/2)` exactly (confirmed). **Do not apply an extra ½** — the half-angle is already inside exp(θ/2); the factor-4 lives only in α_b. Contact/coax read the true unit quaternion; never leak raw θ.

### 1.10 Rayleigh damping — a0 fix

> **Correction.** The repo τ (`params.dampingTau ≈ 0.08 s`) is a per-substep **velocity-retention** constant `exp(−Δt_s/τ)`, i.e. a velocity decay rate 1/τ. Mass-proportional Rayleigh gives `v(t) = v0·exp(−a0·t)`, so matching requires
```
a0 = 1/τ = 12.5 s⁻¹   (NOT 2/τ = 25, which over-damps 2× and smothers the whip),  a1 = 0 default
```
Optional two-anchor `(a0, a1)` for anti-ringing: `ζ_n = ½(a0/ω_n + a1·ω_n)`; keep `a1/Δt ≲ 1`.

### 1.11 Dynamic twist / whip

Torsional wave speed `c_t = sqrt(GJ/(ρ·J_sec))` [cm/s]; fundamental (clamped-free quarter-wave) `ω_1 = (π/2)c_t/L`. Whip-guard dashpot on the twist DOF only:
```
M_damp,i^twist = −(J_i^twist/τ_ω)·ω_i^twist
```
adds `(J_i^twist)/(τ_ω·Δt_s)` to A's twist diagonal and `+(J_i^twist/τ_ω)·ω_i^{twist,n}` to the twist RHS. `τ_ω ∈ [0.05, 0.20] s`; `ζ_t ≈ 1/(τ_ω·ω_1)`, target [0.3, 0.9]. **Re-tune via R*** (which moves ω_1 through ρ), not by fighting τ_ω.

> **DELETED: the "Nyquist guarantee."** The prior draft claimed `Δt_s·ω_1 ≤ π` proves dynamic twist cannot destabilize the translational solve. This is a non-sequitur: backward-Euler is A- and L-stable for the linear operator regardless of `Δt·ω`; unresolved high-frequency twist modes are numerically **damped**, not amplified. There is no CFL bound from the integrator. R*≈O(1) is a **felt** requirement (resolve the visible whip), not a stability proof. If aliasing of an unresolved mode is a concern, bound the highest element mode `ω_max ≈ 2·sqrt(GJ/(ρ·J_sec·ℓ²))`, not ω_1.

### 1.12 Staggered Newton–Schur contact — FATAL metric fix

Contacts enter as **nodal loads** (not parallel springs). The active-set reproject:
```
Δλ_n = −(C_n + α̃_N·λ_n)/(w_eff + α̃_N),   α̃_N = α_N/Δt_s²
λ_n ← max(0, λ_n + ω_relax·Δλ_n)
```

> **Correction.** `w_eff` must be the **implicit Schur compliance** `(A⁻¹)_nn` (normal-normal entry of the node's response from the factored block-tridiagonal tangent; units cm/N), **NOT** the PBD kinematic inverse mass `1/m` (units cm/(N·s²) — the two differ by `1/Δt² ≈ 1.5e4`). Using 1/m makes the wall reaction build ~2e4× too slowly (stiff shafts penetrate uncorrected within R_MAX rounds), or causes double-correction chatter if the reproject also moves the position. **Contact is load-only** — delete any `p.addScaledVector` from the staggered path. Re-derive α_N so `α̃_N ≪ w_eff` (α_N must scale with `Δt_s²`, e.g. `α_N ∝ 1e-4·Δt_s²/w_eff`-scale), NOT a fixed 1e-9. Validate the contraction and ≤5-round convergence on the Lunderquist shaft before declaring contact green.

Anti-chatter: enter/exit hysteresis band `band_hys ≈ 0.1·r_rod` + ω-relaxation 0.5 (when the active set changed) + `R_MAX = 5`. Friction cone uses the same-round λ_n (translational → spin → segment-sample), unchanged from current code.

### 1.13 ½θ rest-curvature decode — FATAL fix (verified against repo)

> **Correction.** `MaterialProfile.restCurvature` stores **raw axis-angle in radians**, NOT `sin(φ/2)·axis`. Verified: `material.ts:176` writes `new Vector3(tipCurvature, 0, 0)`; `cosserat.ts:152` documents tipCurve as "Max rest bend per tip node (radians)"; `restOmega` (cosserat.ts:681) scales by `steer` then applies `sin(φ/2)` at read time. The co-rotational κ0 is therefore:
```
Θ0 = clamp(steer, 0, 1)·restCurvature   (rad over the element)
κ0 = Θ0 / ℓ_e
```
**No asin, no factor 2, no factor 4.** The prior `φ = 2·asin(|v|)` decode would double the precurve for small angles and clamp J-tips to π (nonsense). Also fix the contradictory `material.ts:31` doc-comment ("≈ sin(φ/2) per axis") — restCurvature is radians; only restOmega's *output* is sin(φ/2)-encoded.

> **Correction (steer).** κ0 is **steerable** — recompute `κ0 = steer·restCurvature/ℓ` **each frame**, not once at assembly. The precurve magnitude scales with `input.steer` live; freezing it loses the steer DOF the J-tip needs to cannulate. Only the per-segment restCurvature *vector* is constant.

### 1.14 Block-tridiagonal solve — OVERRULE

> **OVERRULE.** The stability verifier flagged `beam.ts:201 luSolveVec(lu,b,piv,col,col)` in-place aliasing as silently corrupting pivoted solves. This is against **stale code**. The current solver is `blocktridiag.ts` (refactored, commit 1278a39); its `solveMatColumns` passes **distinct** `colIn`/`colOut` (`w.tmpVec`, `w.tmpVec2`) and `luSolveVec` carries an explicit "MUST be distinct" guard (confirmed by reading the file). The bug does not exist in the path we will use. We **keep** the recommended swap-pivot regression test as defense, because the co-rotational + K_geo blocks are non-symmetric and will pivot.

---

## 2. Module signatures

```
src/sim/beamfem/so3.ts       — logSO3, expSO3, TinvSO3, qExpHalf, applyRotationIncrement
src/sim/beamfem/element.ts   — elementFrame, localDeformation, localStiffness,
                                elementTangent, corotKgeoAxial; ElemMat carries
                                kappa0 = steer·restCurvature/ℓ (recomputed per frame)
src/sim/beamfem/mass.ts      — computeSection, densityFromGramsPerCm3 (ρ g/cm³→N·s²·cm⁻⁴),
                                assembleMass(…, rho[], scale) (Phase B PHYSICAL half-segment lumping;
                                the synthetic densityForElement was removed)
src/sim/beamfem/assemble.ts  — assembleBeam (INCREMENT-form RHS), foldDirichlet (fixedPrefix=2)
src/sim/beamfem/solve.ts     — newtonSolve, writeBackTheta (only θ→q site), refreshVelocities
src/sim/beamfem/contact.ts   — schurCompliance ((A⁻¹)_nn), staggeredContactLoop (load-only)
src/sim/beamfem/buckling.ts  — cantileverTipDeflection, numericPcr
```

Integration seams in `cosserat.ts`: constructor ~437 (instantiate per-rod when flagged), beginFrame ~1135 (assemble/factor once; rebuild on N-change), iterateElastic ~1141 (replace), iterateBeam ~1202 (no-op when flagged), step inner loop ~1273 (staggered rounds, q write-back after Newton/before next buildContacts), prependNode 509 / removeProximalNode 571 (re-lump end blocks, shift ω[]/v[], full O(N) re-assemble batched once per substep).

---

## 3. Phased, flag-gated, test-gated plan

Each phase is gated; the live sim default flips only after all gates are green.

- **Phase 0 — Scaffolding + flag.** beamfem skeleton, per-rod `useDirectSolve` default OFF, SO(3) helpers unit-tested. Gate: flag-off byte parity with current main.
- **Phase 1 — Static element + buckling gate.** K_mat + axial-N K_geo, cantilever + Euler validation, κ0 = steer·restCurvature/ℓ (raw radians). **Gate: cantilever <2%, P_cr <5% with monotone convergence from above, wrong-sign fingerprint locked.** Contact must NOT proceed until this is green.
- **Phase 2 — Dynamics + dynamic twist.** Lumped mass (ρ in N·s²·cm⁻⁴), increment-form RHS (the FATAL fix), a0=1/τ, moment K_geo, whip-guard dashpot. Gate: free-flight exact, whip visible+decaying, damping matches felt τ, Newton quadratic, PD LHS past buckling.
- **Phase 3 — Contact + BC.** Staggered Newton–Schur with `w_eff = (A⁻¹)_nn` (the FATAL metric fix), load-only reproject, hard-Dirichlet feed first (compliant motor flag OFF), coax per-rod ρ. Gate: ≤5-round convergence on Lunderquist within budget, no penetration.
- **Phase 4 — Chirality bisection + parity gate.** Bisect the real culprit (NOT the bend rewrite), add the strong whole-anatomy-mirror parity test. Gate: node-by-node mirror parity; the documented 19cm-vs-9cm asymmetry collapses to equal.
- **Phase 5 — Default flip + cleanup.** Flip default ON after felt-behavior review + perf budget + full regression green.

---

## 4. Test spec

Static gates (mass-independent): cantilever δ within 2%; numericPcr within 5% with monotone-from-above at M=8,16,32; wrong-sign fingerprint; imperfection-seeded buckling threshold. Precurve: zero rest moment with κ0=steer·restCurvature/ℓ (raw radians), explicit doubling guard, steer-tracking. Dynamics: 1-DOF free-flight exact (guards the increment-form RHS); blocktridiag swap-pivot vs dense reference; twist wind-up one-whip-then-settle; velocity decay exp(−a0·t) at a0=1/τ; Newton quadratic with moment K_geo; PD LHS past buckling. Contact: Schur-metric reaction correctness; Lunderquist ≤5-round convergence in budget; no penetration; no chatter; coax twist independence; N-change re-lump. Handedness: strong node-by-node whole-anatomy mirror (`p_i^mirror.x ≈ −p_i^normal.x`, `κ_e^mirror ≈ (κx,−κy,−κz)`) + rcfa-mirrored ≡ lcfa-normal climb. Perf: <16.7 ms at N≈100×2-3 incl. an injection re-factor frame.

---

## 5. Parameter table

| Parameter | Value | Units | Notes |
|---|---|---|---|
| ρ_e | R*·GJ_e·Δt_s²/(J_sec·ℓ_e²) | N·s²·cm⁻⁴ | M/Δt² is N/cm natively; no forceScale |
| R* | 1.0 | — | condition twist only (R_bend ~38× off) |
| g/cm³→cm-mass | ×1e-5 | — | only at a density-read boundary |
| Φ (wire) | 0 | — | Kirchhoff; finite-Φ optional for sheath |
| a0 | 1/τ = 12.5 | s⁻¹ | velocity-decay match (NOT 2/τ) |
| a1 | 0 | s | default; two-anchor only for anti-ringing |
| τ | 0.08 | s | params.dampingTau |
| τ_ω | 0.10 | s | whip guard; re-tune via R* |
| Newton iters | 2 (1–3) | — | halve Δu on residual rise |
| S (wire / sheath) | 2 / 4 | — | per-rod Δt_s ⇒ per-rod ρ_e |
| Δt | 0.0167 | s | full frame for the implicit Newton |
| fixedPrefix / K | 2 / 2.0 | — | fixed-free clamp |
| R_MAX | 5 | — | profile on Lunderquist |
| w_eff | (A⁻¹)_nn | cm/N | Schur compliance, NOT 1/m |
| α_N | ∝ Δt_s² so α̃_N ≪ w_eff | — | NOT fixed 1e-9 |
| COAX_ALPHA_N | 1e-4 | — | keep compliant |
| band_hys / ω_relax | 0.1·r_rod / 0.5 | cm / — | anti-chatter |
| tol_pen / tol_u | 1e-3 / 1e-3 | — | convergence |
| ℓ_min / h | 0.05·ℓ_e / 0.25 | cm | chord clamp / rest seg |
| forceMax (feed) | 0.5–2 (ship 1) | N | compliant feed, flag OFF |
| pivot guard | diag ≥ 1e-12 | — | detection, not SPD substitute |
| GJ | 0.77·EI | N·cm² | per-element |
| precision | Float64 | — | never float32 |

---

## 6. Remaining risks

Per-element ρ_e makes absolute mass spatially-varying (R_bend varies ~38×) — sanity-check felt whip on a graded wire before locking R*. The felt τ_lag/T_1 depend on live deployed length L and on ρ — validate the 50–200 ms target in a rig, don't assume. Mass-proportional Rayleigh plus BE numerical dissipation may over-damp the stiff shaft. The whip-guard dashpot τ_ω is a feel knob. Chirality: the bend rewrite alone does NOT fix it — bisect the real culprit in Phase 4. Staggered convergence in 5 rounds on the stiffest device and the per-round Schur-compliance cost are unprofiled. K_geo indefiniteness under the prolapsing compliant feed motor — keep that flag OFF until hard-Dirichlet is green. Gyroscopic terms neglected (valid ≲60 rad/s). Full O(N) re-factor on fast feed — batch per substep; adopt distal→proximal sweep + rank-1 prepend only if profiling proves it.
