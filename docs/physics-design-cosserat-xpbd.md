# Physics design: free Cosserat/DER rod with XPBD, friction, and a true insertion BC

> Authoritative design for the IRsim instrument physics (guidewire / sheath / catheter).
> Source: GPT Pro design review answering `docs/physics-question-for-gpt-pro.md`.
> Implement against this. Notation cleaned from the original; cross-check formulas against
> Kugelstadt & Schömer 2016, Macklin et al. XPBD 2016, Deul et al. "Direct Position-Based
> Solver for Stiff Rods", and Bender's PositionBasedDynamics before coding.

The design: a **free Cosserat/DER rod with XPBD compliance, persistent frictional contact,
and a true insertion boundary that injects material at the proximal end**. Use a hybrid only
in the boring sense: constrain the invisible proximal tail / access sleeve, *not* the
intravascular shaft. The intravascular part must remain a **free rod**, otherwise you will
not get mid-shaft prolapse, arch looping, torque storage, or realistic loss of pushability.

The current failure mode is expected: a pinned base + uniform rest-length growth applies an
artificial **eigenstrain** to the whole deployed rod, so the entire rod is born compressed
before the tip has any reason to move.

## 1. Recommended architecture

- **Intravascular deployed portion:** full free orientation-based Cosserat rod (keep the
  Kugelstadt–Schömer quaternion-frame formulation — it represents bend & torsion through
  orientations, exactly what steerable guidewires/catheter torque need), but move from PBD
  stiffness `k` to **XPBD compliance**, and solve wall / coax / self contact *inside* the
  same Gauss–Seidel loop.
- **Proximal boundary:** a kinematic insertion sleeve / material injector. The access point
  is NOT a pinned material node — it is a moving boundary through which new material enters.
- **Contact:** vessel wall, self-contact, and coaxial contact as XPBD inequality constraints
  with **persistent contact anchors** for static friction.
- **Friction:** Coulomb stick-slip at the position level, using XPBD normal multipliers as
  the normal-load estimate. Translational friction handles push/pull stick-slip; add a
  **spin-friction constraint** for stored torque + sudden release.

| Model | Tip advancement | Mid-shaft prolapse / arch loop | Torque storage/release | Browser cost | Recommendation |
|---|---|---|---|---|---|
| Full free Cosserat/DER + contact/friction | Good, if insertion BC is correct | Yes | Yes, with spin friction | 100–300 nodes in WASM; optimized JS may pass | **Use as core** |
| Follow-the-leader / arc-length rail | Very stable | No (unless hand-authored) | Poor | Very cheap | Only for previews / hidden proximal tail |
| Hybrid: free rod in anatomy + constrained proximal access sleeve | Good | Yes, wherever free | Yes | Best realism/cost | **Recommended** |

A follow-the-leader model makes the tip move beautifully but cannot naturally produce a wire
prolapsing into the aortic arch unless the arch portion is free. A rail bakes in the answer.
The product's differentiator is exactly the failure mode — do not rail the clinically
important portion.

## 2. Insertion boundary condition

**The pinned-base, grow-uniform-`l0` scheme is fundamentally unsound.** It is not merely
"missing friction." In a straight frictionless tube, a correctly inserted inextensible rod
should advance without accumulating axial compression. Growing every segment's rest length
while the proximal end is pinned creates compression everywhere at once — the wrong physical
operation.

The physical operation:

    L_inserted(t+Δt) = L_inserted(t) + v_feed·Δt

but **existing material rest lengths do not change**. New material enters at the proximal
boundary; existing segments keep rest length, material properties, rest curvature, twist.

### Best implementation: simulate a proximal tail

Simulate 15–30 cm of straight rod outside the patient in an access sleeve. The user
moves/rolls a proximal clamp; the rod slides through the access collar into the vessel.
The sleeve imposes **radial** constraints, not a fixed material pin, for nodes inside it:

    C_⊥ = P_⊥(p_i − x_A) = 0          (P_⊥ projects out the access-axis component)

while axial motion along the access direction is free except for friction. A compliant
Dirichlet motor drives a few proximal tail nodes:

    C_handle = p_i − (x_H(t) + R_H(t)·p̄_i) = 0
    C_roll   = Im(q_target⁻¹ · q_i) = 0

Cleanest model: no rest-length growth, no artificial compression. If the tip is free the rod
advances; if resisted, compression builds and the shaft buckles where contact/friction/
geometry allow.

### Active-only implementation: local material injection at the access point

Proximal access frame (x_A, e_A, R_A), e_A points into the vessel. Nominal segment length
`h`. Keep an inlet offset `a ∈ [0,h)` = distance from access plane to first material node.
On feed input: `a_target += v_feed·Δt`. When `a_target ≥ h`, **insert a new proximal node**:

    p_new = x_A + (a_target − h)·e_A
    q_new = R_A · Roll(θ_hub)
    prepend it; set the new first segment rest length = h; assign shaft material; a_target −= h

During the solve, apply a compliant **inlet motor** to the first node:

    C_inlet,pos = [ P_⊥(p_0 − x_A) ;  e_A·(p_0 − x_A) − a_target ] = 0

Stiff but not infinite. Its XPBD multiplier gives a feed-force estimate:

    F_feed ≈ λ_feed / Δt_s²

Clamp this force / use it for haptic/UI feedback. Prefer a **velocity-controlled compliant
motor with a force cap** over pure force control (twitchy) or hard Dirichlet (can inject
infinite force).

**The no-buckle-when-free behavior comes from the BC + stiffness, not friction alone.** A
correct insertion BC should advance the tip in a straight low-resistance tube even with μ=0.
Friction is needed for realistic pushability, torque storage, stick-slip, load localization.

## 3. XPBD frictional wall contact

Do **not** do lumen collision as a final projection after the rod solve — that destroys
force estimates and makes Coulomb friction ill-defined. Contact must be **inside** the XPBD
loop.

Allowed centerline radius (ε_c ≈ 0.05–0.20 mm or 0.05r–0.2r):

    R_eff(s) = R_lumen(s) − r_instrument − ε_c

For node p_i, closest compatible centerline point c(s); ρ = |p_i − c(s)|, n = (p_i − c(s))/ρ.
Unilateral inside-lumen constraint:

    C_n = R_eff(s) − ρ ≥ 0 ,     ∇_{p_i} C_n = −n

XPBD (compliance α_n, substep Δt_s, α̃_n = α_n/Δt_s²):

    Δλ_n = −(C_n + α̃_n·λ_n) / (w_i·|∇C_n|² + α̃_n)
    λ_n  = max(0, λ_n + Δλ_n)         (inequality)
    Δλ_n = λ_n_new − λ_n_old
    p_i += w_i·∇C_n·Δλ_n               (∇C_n = −n ⇒ positive Δλ_n moves node inward)

For segment-wall collision, do the same at segment quadrature points / capsule samples and
distribute corrections to endpoints. **Node-only collision is not enough** around tight
curves and bifurcations.

### Static/dynamic translational friction

Each persistent contact stores a wall anchor `a_i` (vessel segment ID, centerline coord,
circumferential angle). Tangent-plane basis T = [t_1, t_2], e.g. t_1 = vessel tangent,
t_2 = n × t_1. Tangential stick constraint:

    C_t = Tᵀ(p_i − a_i) = 0

Vector XPBD:

    Δλ_t = −(Tᵀ M⁻¹ T + α̃_t·I)⁻¹ (C_t + α̃_t·λ_t)
    λ_t* = λ_t + Δλ_t

Stick if |λ_t*| ≤ μ_s·λ_n → apply correction, keep anchor.
Else slip: λ_t_new = −μ_k·λ_n·v̂_t (v̂_t = tangential slip direction over the substep), then
Δλ_t = λ_t_new − λ_t, apply, update λ_t, move anchor to current wall point.

Both λ_n and λ_t are XPBD length-constraint multipliers, so the Coulomb cone is enforced
directly in multiplier space; force ≈ λ/Δt_s². (XPBD removes PBD's timestep/iteration-
dependent stiffness and exposes force estimates — that's why it's the right fit.)

### Spin friction (torque realism)

Translational friction alone does not resist pure rotation of a round rod about its tangent.
For torque storage/release add a rotational surface-slip constraint at wall contacts. ψ_j =
roll angle of frame q_j relative to a wall frame; store ψ_0 at stick. Surface slip length:

    C_ψ = r_rod · wrap(ψ_j − ψ_0)

Scalar XPBD, clamp |λ_ψ| ≤ μ_roll·λ_n; on exceed, slip → update ψ_0. **This one constraint
is the difference between "base roll instantly rotates the tip" and "torque winds up,
sticks, then releases."**

### How friction helps advancement

1. Contact patches shorten the effective free buckling length. Euler load
   `P_cr ≈ π²·EI / (K·L_free)²` — a 30 cm unsupported shaft buckles under tiny load; one
   supported every 3–5 cm carries far more push.
2. Static friction creates temporary anchors; proximal feed loads the rod between anchors
   and the tip instead of letting the whole centerline skate.
3. Friction + torsional compliance stores twist; breaking the cone gives sudden distal
   rotation/whip.

Too much friction → poor pushability + proximal buckling. Too little → fake torque/release.
The correct regime is **stick-slip, not a sticky rail**.

## 4. Material properties & XPBD compliance mapping

Use **SI units internally** (m, N, s). Treat EI(s), GJ(s), EA(s), radius, density, friction,
rest curvature as **material-coordinate fields** that **advect with inserted material** — do
not smear the floppy tip over the whole rod when resampling.

Continuous Cosserat energy:

    U = ½∫ [ EA·ε² + k_s·GA·(σ1²+σ2²) + EI1·(κ1−κ1,0)² + EI2·(κ2−κ2,0)² + GJ·(τ−τ0)² ] ds

For the stretch-shear constraint C_s = (p_{j+1}−p_j)/ℓ_j − d3(q_j) (dimensionless):

    U_s,j = ½·ℓ_j · C_sᵀ · diag(k_s·GA, k_s·GA, EA) · C_s
    ⇒ α_s = diag( 1/(ℓ_j·k_s·GA), 1/(ℓ_j·k_s·GA), 1/(ℓ_j·EA) )

For the bend-twist constraint using the quaternion imaginary part,
C_b = Im(q_j⁻¹·q_{j+1}) − C_b,0, small rotations give Im(q_j⁻¹ q_{j+1}) ≈ ½θ ≈ ½ ℓ_j Ω, so
κ − κ0 ≈ 2·C_b/ℓ_j and:

    U_b,j = ½ · C_bᵀ · diag( 4EI1/ℓ_j, 4EI2/ℓ_j, 4GJ/ℓ_j ) · C_b
    ⇒ α_b = diag( ℓ_j/(4EI1), ℓ_j/(4EI2), ℓ_j/(4GJ) )        [quaternion-imag convention]

If bend/twist is instead written in **Darboux-vector units** C_Ω = Ω − Ω0:

    α_Ω = diag( 1/(ℓ_j·EI1), 1/(ℓ_j·EI2), 1/(ℓ_j·GJ) )

**Do not mix the two forms — the factor of 4 matters.**

Measured guidewire stiffness varies hugely: ~9.5 GPa (plain Amplatz) to ~158 GPa
(Lunderquist Extra Stiff) effective flexural modulus via three-point bending with I=πd⁴/64.
For 0.035″ that is roughly EI ≈ 2.9e−4 to 4.9e−3 N·m² (solid-equivalent). Device-specific
tuning is unavoidable (too low → buckles; too high → injures/resists tortuosity).

Starting table, assuming h = 7.5 mm and the **quaternion-imag** bend constraint:

| Device region | Radius/OD | EI start | GJ start | EA start | α_b = h/(4EI) | α_stretch = h/EA | Friction starts |
|---|---|---|---|---|---|---|---|
| 0.035″ wire, floppy distal 3–8 cm | r≈0.445 mm | 1e−5–5e−5 | 5e−6–3e−5 | 5e3–2e4 | 37.5–187.5 | 3.8e−7–1.5e−6 | μs=0.08, μk=0.04 hydrophilic |
| 0.035″ wire, transition | r≈0.445 mm | 5e−5–5e−4 | 3e−5–4e−4 | 1e4–3e4 | 3.75–37.5 | 2.5e−7–7.5e−7 | same |
| 0.035″ wire, supportive shaft | r≈0.445 mm | 5e−4–2e−3 | 4e−4–1.5e−3 | 1e4–4e4 | 0.94–3.75 | 1.9e−7–7.5e−7 | μs=0.05–0.15, μk=0.02–0.08 |
| 5 Fr catheter, soft distal | OD≈1.67 mm | 5e−4–2e−3 | 2e−4–1e−3 | 5e3–2e4 | 0.94–3.75 | 3.8e−7–1.5e−6 | μs=0.12–0.25, μk=0.06–0.15 |
| 5–6 Fr sheath / supportive shaft | OD≈1.67–2.0 mm | 3e−3–1e−2 | 1e−3–6e−3 | 1e4–5e4 | 0.19–0.625 | 1.5e−7–7.5e−7 | μs=0.15–0.35, μk=0.08–0.20 |
| Instrument–instrument lubricated | clearance-dep. | contact only | spin opt. | no axial tie | — | — | μs=0.04–0.12, μk=0.02–0.08 |

(EI/GJ/EA in N·m², N·m², N; α_b is dimensionless because the bend constraint is; the value
actually used is α̃ = α/Δt_s².)

Tip precurve: set rest curvature directly. A 45° tip over 20 mm: κ0 ≈ 0.785/0.02 ≈ 39 m⁻¹;
with quaternion-imag convention C_b,0 ≈ ½·h·κ0. A J-tip radius 5–15 mm → κ0 ≈ 67–200 m⁻¹,
**only over the actual curved distal material**.

**Switch from PBD stiffness-k to XPBD compliance** (timestep/iteration independent, exposes
force estimates).

## 5. Numerical method

For 80–150 nodes/instrument, **Gauss–Seidel XPBD with substeps is enough** if BC + contact
are correct. Move to a direct rod block solver only if stiff sheaths stay visibly too soft.

| Case | Substeps/frame | Iters/substep | Contact passes | Notes |
|---|---|---|---|---|
| Single guidewire | 4 | 6–8 | every iteration | first target |
| Guidewire + catheter | 4–6 | 8 | every iteration | coax contact dominates |
| Stiff 5–6 Fr sheath | 6–8 | 8–12 | every iteration | or direct rod block + fewer iters |
| Extreme tortuosity / heavy self-contact | 8 | 10–12 | every iteration | WASM preferred |

The **Direct Position-Based Solver for Stiff Rods** (Deul et al.) is worth considering for
stiff sheaths / higher node counts (much better convergence for stiff inextensible XPBD
rods), but it does not remove iterative contact/friction — think of it as a better rod block
inside the contact solver. Projective dynamics / implicit DER are more accurate but heavy
when active contact topology changes every frame — don't start there.

**Quasi-static orientations** (current) are acceptable for a highly damped trainer — stable,
controllable torque propagation. Reintroduce angular velocity only for visible whip/release:

    q̂_j = exp(½·Δt_s·ω_j)·q_j ;  solve;  ω_j^{n+1} = (2/Δt_s)·Log(q_j^{n+1}·(q_j^n)⁻¹)
    damp: ω_j ← e^(−Δt_s/τ_ω)·ω_j ,  τ_ω ≈ 50–200 ms

First production: keep quasi-static orientations + spin friction; add angular velocity later.

## 6. Coaxial / telescoping instruments

Model every instrument as its own rod; **do not merge centerlines**. Coupling = contact +
optional soft support. For inner node p_i^in inside outer segment k, closest point
x_o(u)=(1−u)·p_k^o + u·p_{k+1}^o, outer tangent t_o, r_⊥ = (I − t_o t_oᵀ)(p_i^in − x_o(u)),
ρ=|r_⊥|, n=r_⊥/ρ:

    C_io = R_outer,lumen − r_inner − ρ ≥ 0
    ∇_{p_i^in} C = −n ,  ∇_{p_k^o} C = (1−u)·n ,  ∇_{p_{k+1}^o} C = u·n

Solve as a bilateral distribution (inner moves inward; outer gets equal-and-opposite support
per mass weights) — this is how catheter-over-wire support emerges. **No axial distance
constraint** for sliding; add Coulomb friction at coax contact with tangent basis
T = [t_o, n×t_o] (first resists axial sliding, second circumferential rubbing), μ_io lower
than wall friction for lubricated devices.

At an outer tip the inner exits through an **open portal** — do not cap the catheter tip; use
a 1–2 segment transition zone where the inner switches from "inside outer lumen" to "inside
vessel lumen", else you create a fake obstruction.

For catheter-over-wire stiffness when clearance is small, add a soft lateral centering
constraint in overlapped regions (high compliance, no axial tie, no torsional tie):

    C_center = (I − t_o t_oᵀ)(p_i^in − x_o(u)) = 0

Or locally increase outer effective bending: EI_o^eff(s) = EI_o(s) + η·EI_inner(s),
η ≈ 0.1–0.5 for sliding support, η→1 only for tightly locked systems.

Ordering: (1) predict all rods; (2) solve each rod's stretch/bend; (3) vessel normal contact
for outermost devices; (4) inner-inside-outer normal contact; (5) self/non-coax collisions;
(6) friction for vessel + coax contacts; (7) repeat. **Interleave** — never solve the sheath
fully then the wire once (one-way support artifacts).

## 7. Lumen collision & branching

Nearest-centerline projection is fine only for a first prototype in a single non-branching
tube; it fails at ostia, tight bends, radius changes, loops. Use a **variable-radius
capsule-chain implicit lumen** as the real-time primitive:

    φ(x) = min over edges e of ( d(x, centerline segment e) − R_e(u) )

Inside lumen ⇔ φ(x) ≤ 0; for instrument radius r use R_e(u) − r. BVH/uniform grid over
expanded centerline capsules. Add **topology**: each node stores current vessel edge ID +
arc coord; search current + graph-adjacent edges first; allow branch transitions only near
ostia; use **hysteresis** so nodes don't flip between nearby centerlines each iteration. At
bifurcations use a smooth union of capsules or a precomputed low-res SDF of the lofted lumen
mesh (a plain nearest segment can project into the wrong branch / through the carina).

Also: **segment collision samples** (nodes + 1–2 samples/segment — a segment can cut a wall
even if endpoints are legal); **swept collision or enough substeps**
(|p_pred − p_n| < 0.25·min(R_lumen, h) per substep, or swept sphere-vs-capsule);
**self-collision** for loops/prolapse (non-adjacent segment capsules, ignore neighbors within
2–3 segments, spatial hash). Use the high-res mesh for rendering; capsule-chain/SDF for
physics.

## 8. Real-time budget & validation

Put the solver in **Rust/WASM** once contact/friction is real. TypeScript works for a single
guidewire with structure-of-arrays typed arrays and zero per-frame allocation, but
friction + coax will eat the budget. Target N_total ≈ 250–400 nodes, S = 4–6 substeps,
I = 6–10 iters/substep — a few hundred thousand small projections/frame, feasible in WASM.
WebGPU not needed until many more rods / dense SDF / massive self-contact (and it's awkward
for strict Gauss–Seidel — needs graph coloring / Jacobi batching).

Validation without patient data:
1. **Straight tube:** no distal obstruction → Δx_tip/ΔL_feed ≈ 1 after transient. Immediate
   accordioning here ⇒ BC or stretch stiffness still wrong.
2. **Blocked-tip buckling:** push against a fixed distal stop; compare onset to
   P_cr ≈ π²EI/(K·L_free)²; vary contact spacing/friction → buckling location should move.
3. **180° arch phantom:** feed length to first prolapse loop vs real devices; tune EI, μ_s,
   μ_k, damping until thresholds + loop morphology match.
4. **Torque transfer:** rotate hub 90/180/360°, measure tip delay + sudden release; tune GJ,
   spin friction, torsional damping.
5. **Pull-through friction:** drag samples through silicone/printed tubes; fit μ_k (kinetic),
   μ_s (static breakaway).
6. **Clinician face validity:** rate pushability, torqueability, prolapse tendency,
   catheter-over-wire support. Tune only a small physical knob set: EI(s), GJ(s), μ_s, μ_k,
   contact margin, damping.

## Full solver step pseudocode

```ts
function stepFrame(dt: number, instruments: Instrument[], input: UserInput) {
  const S = chooseSubsteps(dt, instruments, input);   // 4..8
  const hdt = dt / S;

  for (let sub = 0; sub < S; ++sub) {
    // 1. feed targets + local material injection
    for (const inst of instruments) {
      updateInsertionTarget(inst, input.feedVelocity[inst.id] * hdt);
      updateRollTarget(inst, input.rollVelocity[inst.id] * hdt);
      injectOrRetractNodesAtAccess(inst);
    }
    // 2. predict
    for (const inst of instruments) predictRodState(inst, hdt);
    // 3. build/update contacts
    const contacts: Contact[] = [];
    for (const inst of instruments) {
      buildLumenContacts(inst, vesselBVH, contacts);
      buildSelfContacts(inst, contacts);
    }
    buildCoaxialContacts(instruments, contacts);
    buildInstrumentInstrumentContacts(instruments, contacts);
    // 4. init lambdas (elastic reset per substep; friction anchors/lambdas persist)
    for (const inst of instruments) resetElasticLambdas(inst);
    initializeContactLambdas(contacts);
    // 5. nonlinear Gauss-Seidel
    const iterations = chooseIterations(instruments); // 6..12
    for (let it = 0; it < iterations; ++it) {
      for (const inst of instruments) {
        solveInletPositionMotorXPBD(inst, hdt);
        solveInletOrientationMotorXPBD(inst, hdt);
        solveAccessSleeveRadialConstraints(inst, hdt);
      }
      for (const inst of instruments) {
        solveStretchShearXPBD(inst, hdt);
        solveBendTwistXPBD(inst, hdt);
      }
      solveLumenNormalContactsXPBD(contacts, hdt);
      solveCoaxialNormalContactsXPBD(contacts, hdt);
      solveSelfAndExternalNormalContactsXPBD(contacts, hdt);
      for (const inst of instruments) {           // re-solve to propagate contact
        solveStretchShearXPBD(inst, hdt);
        solveBendTwistXPBD(inst, hdt);
      }
      solveTranslationalFrictionXPBD(contacts, hdt);  // uses lambda_n from this iter
      solveSpinFrictionXPBD(contacts, hdt);
    }
    // 6. velocities + damping + renormalize quaternions
    for (const inst of instruments) {
      updateVelocitiesFromDisplacements(inst, hdt);
      applyExponentialDamping(inst, hdt);
      normalizeQuaternions(inst);
    }
    // 7. persist/drop friction anchors
    updateFrictionAnchors(contacts);
  }
}
```

Core XPBD block solver:

```ts
function solveXPBDVector(C, J, alpha, lambda, dt) {
  const A = computeEffectiveMassMatrix(J).add(alpha.scale(1 / (dt * dt))); // J M^-1 J^T + α̃
  const rhs = C.add(alpha.mul(lambda).scale(1 / (dt * dt))).neg();
  const dLambda = solveSmallDense(A, rhs); // 1x1, 2x2, 3x3
  lambda.addInPlace(dLambda);
  for (const block of J) applyWeightedCorrection(block, dLambda); // x += M^-1 J^T dλ
}
```

Insertion update:

```ts
function injectOrRetractNodesAtAccess(inst) {
  const h = inst.nominalBaseSegmentLength;
  while (inst.inletOffsetTarget >= h) {
    const eps = inst.inletOffsetTarget - h;
    const pNew = inst.access.x.add(inst.access.e.scale(eps));
    const qNew = quatFromFrameAndRoll(inst.access.frame, inst.rollTarget);
    inst.prependNode({ p: pNew, pPrev: pNew.sub(inst.access.e.scale(inst.feedVelocity * inst.lastDt)),
                       q: qNew, material: inst.proximalShaftMaterial, radius: inst.radiusAtProximalShaft });
    inst.setRestLength(0, h);
    inst.inletOffsetTarget -= h;
  }
  while (inst.inletOffsetTarget < 0 && inst.nodeCount > inst.minNodes) {
    inst.removeProximalNode();
    inst.inletOffsetTarget += h;
  }
}

function solveInletPositionMotorXPBD(inst, dt) {
  const p0 = inst.p[0], xA = inst.access.x, e = inst.access.e;
  const rel = p0.sub(xA);
  const axial = dot(rel, e);
  const C = new Vec3(dot(rel, inst.access.u), dot(rel, inst.access.v), axial - inst.inletOffsetTarget);
  solveXPBDVector(C, inletJacobian(inst), inst.alphaFeedMotor, inst.lambdaFeed, dt);
  clampFeedForce(inst, dt);
}
```

Normal + translational friction:

```ts
function solveWallNormalContact(c, dt) {
  const p = c.instrument.p[c.node];
  const rhoVec = p.sub(c.center); const rho = length(rhoVec); if (rho < 1e-9) return;
  const n = rhoVec.scale(1 / rho);
  const Cn = c.allowedRadius - rho;            // >= 0 required
  if (Cn >= 0 && c.lambdaN <= 0) return;
  const grad = n.neg();                        // dC/dp = -n
  const w = c.instrument.invMass[c.node];
  const aT = c.alphaN / (dt * dt);
  let dL = -(Cn + aT * c.lambdaN) / (w * dot(grad, grad) + aT);
  const old = c.lambdaN; c.lambdaN = Math.max(0, c.lambdaN + dL); dL = c.lambdaN - old;
  p.addInPlace(grad.scale(w * dL)); c.normal = n;
}

function solveWallFriction(c, dt) {
  if (c.lambdaN <= 0) { c.lambdaT.setZero(); c.hasAnchor = false; return; }
  if (!c.hasAnchor) { c.anchor = currentWallAnchor(c); c.hasAnchor = true;
    c.lambdaT.setZero(); c.lambdaRoll = 0; c.rollAnchor = currentRollAngle(c); return; }
  const p = c.instrument.p[c.node];
  const t1 = c.vesselTangent, t2 = cross(c.normal, t1).normalize();
  const Ct = new Vec2(dot(p.sub(c.anchor), t1), dot(p.sub(c.anchor), t2));
  const w = c.instrument.invMass[c.node]; const aT = c.alphaT / (dt * dt);
  const dL = Ct.add(c.lambdaT.scale(aT)).scale(-1 / (w + aT));
  const trial = c.lambdaT.add(dL); const staticLimit = c.muStatic * c.lambdaN;
  if (length(trial) <= staticLimit) {                         // stick
    c.lambdaT = trial; p.addInPlace(t1.scale(w * dL.x)); p.addInPlace(t2.scale(w * dL.y));
  } else {                                                    // slip
    const dir = tangentSlipDirection(c, t1, t2, dt);
    const lnew = dir.scale(-c.muKinetic * c.lambdaN); const ds = lnew.sub(c.lambdaT);
    c.lambdaT = lnew; p.addInPlace(t1.scale(w * ds.x)); p.addInPlace(t2.scale(w * ds.y));
    c.anchor = currentWallAnchor(c);
  }
}
```

Spin friction:

```ts
function solveSpinFriction(c, dt) {
  if (c.lambdaN <= 0) return;
  const inst = c.instrument, seg = c.segment, q = inst.q[seg];
  const psi = rollAngleRelativeToWall(q, c.normal, c.vesselTangent);
  const C = inst.radius * wrapAngle(psi - c.rollAnchor);   // surface slip length
  const aT = c.alphaRoll / (dt * dt); const wq = inst.invRotMass[seg];
  let dL = -(C + aT * c.lambdaRoll) / (wq * inst.radius * inst.radius + aT);
  let trial = c.lambdaRoll + dL; const limit = c.muRoll * c.lambdaN;
  if (Math.abs(trial) <= limit) { c.lambdaRoll = trial; applyRollCorrection(q, wq * dL * inst.radius); }
  else { const s = Math.sign(trial); const lnew = s * limit; dL = lnew - c.lambdaRoll;
    c.lambdaRoll = lnew; applyRollCorrection(q, wq * dL * inst.radius); c.rollAnchor = psi; }
}
```

## Top pitfalls

1. Changing rest length globally — guarantees artificial compression.
2. Lumen projection AFTER the solve — contact must produce normal multipliers or friction has
   no physical normal load.
3. PBD stiffness-k — chase timestep/iteration artifacts forever; use XPBD compliance.
4. Node-only collision — segments cut corners and bifurcations.
5. Resetting friction anchors every frame — no static friction, torque storage, or stick-slip.
6. Forgetting spin friction — translational wall friction does not resist pure roll.
7. Over-damping — use exponential damping with a time constant, not frame-dependent magic
   numbers; heavy damping hides instability and kills whip/release.
8. Treating nearest centerline segment as ground truth at branches — use graph-aware
   candidate selection + hysteresis.
9. Coupling coaxial rods with axial ties — inner/outer must slide unless friction says
   otherwise.
10. Expecting friction to fix an incorrect insertion BC — it won't. The BC must inject
    material at the proximal end; friction then decides how much input reaches the tip before
    compression / bowing / prolapse / loop formation.

## References

- Macklin, Müller, Chentanez. *XPBD: Position-Based Simulation of Compliant Constrained
  Dynamics* (2016). https://matthias-research.github.io/pages/publications/XPBD.pdf
- Kugelstadt & Schömer. *Position and Orientation Based Cosserat Rods* (SCA 2016).
- Deul et al. *Direct Position-Based Solver for Stiff Rods*.
  https://animation.rwth-aachen.de/publication/0557/
- Bender et al. *PositionBasedDynamics* library.
  https://github.com/InteractiveComputerGraphics/PositionBasedDynamics
- Guidewire stiffness measurements.
  https://reanimateconference.com/wp-content/uploads/2019/08/Guidewire-Stiffness.pdf
