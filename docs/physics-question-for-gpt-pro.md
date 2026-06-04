# Prompt for GPT Pro — realistic real-time guidewire/sheath physics

> Copy everything below the line into GPT Pro.

---

You are an expert in physically-based simulation of slender elastic rods (Cosserat
rods, Discrete Elastic Rods), real-time constraint solvers (PBD / XPBD / projective &
implicit dynamics), frictional contact, and **endovascular/surgical simulation**
(guidewires, catheters, sheaths inside vasculature). I need a concrete, technically
rigorous design — with math, pseudocode, and parameter guidance — not a survey.

## What I'm building

A web-based, real-time interventional-radiology **navigation trainer**. The user pushes
and torques a **guidewire** and a **sheath/catheter** from a vascular access point
(e.g. common femoral artery) through 3D vascular anatomy (aorta, arch, branches) to reach
named anatomic targets (branch ostia). Vessels are represented as **centerlines with a
per-point lumen radius** plus a lofted tube mesh. The instrument behavior must be
**physically realistic** — that is the entire point of the product — while running at
**interactive frame rates (≥ 60 fps) in a browser**.

Runtime constraints:
- TypeScript + three.js today (CPU). I am willing to move hot loops to **Rust/WASM or
  WebGPU compute** if that's what correctness + real-time requires.
- Per instrument: ~80–100 nodes is my current discretization (open to change).
- Up to ~2–3 coaxial instruments simultaneously (wire inside catheter inside sheath).

## What I have already (and what's verified)

I implemented an **orientation-based Cosserat rod** (Kugelstadt & Schömer 2016, cross-checked
against Bender's `PositionBasedDynamics` reference). State = N+1 particle positions `p_i`
(inverse mass `w_i`) + N per-segment unit quaternions `q_j` (scalar inverse inertia `wq_j`).
Two constraints:
- **stretch-shear**: `C_s = (1/l0)(p_{j+1} − p_j) − d3(q_j)` (d3 = rod director),
- **bend-twist**: `C_b = Im(conj(q_j)·q_{j+1}) − s·Ω0` with the closest-quaternion `s`.

Solver details as built:
- **PBD stiffness** form (stiffness k∈[0,1] per constraint), **bilateral interleaved
  Gauss-Seidel**, ~12 iterations/frame.
- **Quasi-static orientations**: I do NOT integrate angular velocity; quaternions evolve
  only through constraint corrections across iterations/frames (chosen for stability).
- **Positions**: Verlet with global damping ~0.9, no external force (no gravity).
- **Lumen containment**: each node is projected to within `(lumenRadius − rodRadius)` of the
  nearest point on the nearest centerline segment (a tube SDF approximated by nearest-segment).
- **Pre-curved tip**: nonzero rest Darboux `Ω0 = sin(φ/2)·x̂` on the distal ~8 nodes → an
  angled/J tip.
- **Feeding (insertion)**: I grow a **uniform rest length** `l0 = deployedLength / N` from a
  **pinned base** (`w_0 = wq_0 = 0`, base frame director = access direction, rolled about
  it by a "torque" input). Advancing increases `deployedLength` (rate-limited).

**Unit tests confirm the constraint solver is correct**: inextensibility holds, the
pre-shaped tip deflects, **torque applied at the base propagates and rotates where the tip
points** (twist transmission works), quaternions stay normalized, it's numerically stable,
and containment keeps nodes inside the lumen.

## The problem I need you to solve

The **feeding/insertion model is wrong**. Pushing the rod by growing rest length from a
pinned base puts the whole rod in **compression**, so inside a tube it **buckles and
accordions against the lumen wall immediately — the tip never advances**. Concretely:
~27 cm of wire piles up in a few cm of vessel near the base, pressed to the wall, instead
of the tip progressing up the lumen. This is Euler buckling with no friction and a too-soft
solve.

I do NOT want to simply force the wire onto a rail. I want the **emergent, correct
behavior**:
- When there's a clear path and the operator pushes, the **tip advances**.
- When the tip meets resistance (tortuosity, a sharp turn, an occlusion, wrong vessel), the
  wire should **store energy, bow, and eventually buckle / prolapse / loop — including
  mid-shaft**, e.g. a wire prolapsing into the aortic arch — which is exactly the loss of
  "pushability" a real operator feels and must manage.
- **Friction** between instrument and vessel wall is clearly central: it's what lets the
  contacted shaft hold so that a push transmits to the tip, and it produces realistic
  stick-slip, stored torque, and sudden release/whip.

## Specific questions (please answer each, concretely)

1. **Overall architecture.** What is the right model to get *emergent, correct* advancement
   AND buckling for a pushed rod in a constraining lumen, in real time in a browser?
   Compare and recommend among: (a) full free Cosserat/DER with **frictional contact +
   an implicit or substepped-XPBD solve**, (b) **follow-the-leader / arc-length insertion**
   with a free elastic distal segment, (c) a hybrid. Which actually reproduces mid-shaft
   prolapse/looping, and at what compute cost? Be specific about why.

2. **Insertion boundary condition.** Exactly how should "feeding length in at the proximal
   end" be modeled so that it (i) advances the tip when there's room, and (ii) produces
   genuine buckling only when resistance warrants — without the spurious immediate buckling
   I have now? (e.g. proximal Dirichlet BC that injects arc length, vs. a velocity/force
   BC, vs. adding nodes at the base. How is the no-buckling-when-free behavior recovered
   physically — is it purely friction + stiffness, or is my pinned-base-grow-l0 scheme
   fundamentally unsound?)

3. **Friction model.** Give a concrete **stick-slip Coulomb friction** formulation for
   instrument-vs-vessel-wall contact compatible with a position-based / XPBD solver
   (tangential contact constraints, the friction cone, how normal force from the lumen
   constraint feeds the tangential limit, ordering vs. the lumen projection). Explain how
   this friction is what makes feeding advance the tip rather than buckle.

4. **Per-material properties.** How do I parameterize and *map real instrument specs* to the
   solver so a **guidewire** (≈0.035", stiff supportive shaft, **soft floppy distal tip**,
   high 1:1 torque transmission) behaves distinctly from a **sheath/catheter** (larger
   bore, stiffer, blunter, less floppy)? Specifically: how to convert **flexural rigidity
   EI** and **torsional rigidity GJ** (and graded stiffness along the length) into
   per-segment **XPBD compliances** (bend vs twist vs stretch), and rough realistic numbers
   for each instrument. Should I switch from PBD stiffness-k to true XPBD compliance for
   this (units, frame-rate independence)?

5. **Numerical method.** For stiff instruments (a sheath is quite stiff), is bilateral
   Gauss-Seidel XPBD with substeps enough, or should I move to the **Direct Position-Based
   Solver for Stiff Rods** (Deul et al.), **projective dynamics**, or an **implicit DER**
   integrator? Should I reintroduce angular velocity (full dynamics) instead of my
   quasi-static orientation scheme — what do I lose/gain? Give the recommended substep /
   iteration counts and stability guidance for a ~100-node stiff rod at 60 fps.

6. **Coaxial / telescoping instruments.** How should a wire-inside-catheter-inside-sheath be
   coupled — relative sliding along a shared lumen, mutual lateral support (a catheter over a
   wire is effectively stiffer), the inner instrument constrained to the outer's lumen, and
   instrument exchanges? Constraint formulation + ordering.

7. **Lumen collision.** Is nearest-centerline-segment projection adequate, or do I need a
   proper signed-distance field / capsule-chain collision with **continuous collision** to
   avoid tunneling at speed, plus **self-collision** so loops/prolapse resolve correctly at
   bifurcations? Recommend an approach that's robust on branching, tortuous centerlines.

8. **Real-time budget & validation.** Given the ≥60 fps browser target, where should the
   work go (CPU JS vs WASM vs WebGPU compute), and what's a sane substep/contact-iteration
   budget? Finally, how would you **tune/validate** the model to feel right (matching real
   guidewire/sheath behavior — face validity) without patient data?

## What I want back

A recommended concrete design (with rationale and the key tradeoffs), the **math and a
pseudocode solver loop** for one full step including feeding + friction + lumen contact +
coaxial coupling, a **parameter table** (starting compliances/stiffnesses/friction for a
0.035" guidewire and a 5–6 Fr sheath), and the **top pitfalls** that would make it look
unrealistic or go unstable. Prioritize physical realism of instrument behavior, but every
recommendation must be feasible at interactive frame rates in a browser (WASM/WebGPU
allowed). Call out explicitly anything that is NOT real-time-feasible in-browser today.
