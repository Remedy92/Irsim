import { Quaternion, Vector3 } from "three";
import type { Anatomy, AccessFrame, InsertionState } from "./types";
import {
  buildGuidewireField,
  buildSheathField,
  shaftProfile,
  type MaterialField,
  type MaterialProfile
} from "./material";
import { solveXPBDScalar } from "./xpbd";
import {
  buildAccessFrame,
  defaultInsertionState,
  injectOrRetractNodesAtAccess,
  injectedFrame,
  type Injectable
} from "./insertion";
import {
  makeWallContact,
  refreshWallContact,
  resetNormalLambda,
  solveNormalContact,
  solveSpinFriction,
  solveTranslationalFriction,
  type NodeContactTarget
} from "./contact";
import { Lumen } from "./lumen";
import {
  closestOuterSegment,
  makeCoaxContact,
  portalWeight,
  solveCoaxialCentering,
  solveCoaxialFriction,
  solveCoaxialNormalContact,
  type CoaxClosest,
  type CoaxContact
} from "./coax";
import type { Contact, LumenQuery } from "./types";

/**
 * Orientation-based Cosserat rod (position + per-segment quaternion DOFs).
 *
 * Constraints follow Kugelstadt & Schömer 2016 "Position and Orientation Based
 * Cosserat Rods" and Bender's PositionBasedDynamics:
 *   - stretch-shear : C_s = (1/ℓ_j)(p_{j+1} - p_j) - d3(q_j)
 *   - bend-twist    : C_b = Im(conj(q_j) q_{j+1}) - s·Ω0   (closest-quaternion s)
 *
 * TWIST is a real DOF, so rolling the proximal handle (torque) propagates down the
 * shaft and rotates the pre-shaped tip — the mechanism of branch cannulation.
 *
 * STAGE 1 — PBD stiffness-k → XPBD compliance (per-segment Lagrangian MaterialField).
 *
 * STAGE 2 — MATERIAL-INJECTION INSERTION BC (this rewrite). The old pinned-base +
 * grow-uniform-ℓ0 feed was unsound: growing every segment's rest length while the base
 * is pinned applies an artificial EIGENSTRAIN, so the whole rod is born compressed and
 * a pushed free rod accordions instead of advancing the tip (design doc §2). Replaced by:
 *
 *   - restLen[j] is FROZEN at the nominal base length h. Existing material is never
 *     rescaled, so there is no global rest-length growth → no eigenstrain → no accordion.
 *   - Feed advances an inlet offset; nodes are INJECTED at the proximal access plane
 *     (carrying shaft material + rest curvature) and removed on retract. The MaterialField
 *     advects with the material (prepend shaft profile on inject, drop on retract) — the
 *     floppy tip never smears into the shaft.
 *   - The proximal node is FREE, driven by a compliant velocity-controlled INLET POSITION
 *     MOTOR (with a force cap) + an inlet ORIENTATION (roll) motor + an access-sleeve
 *     radial constraint, instead of a hard pinBase(). The motor's multiplier is a
 *     feed-force estimate (F ≈ λ_feed/Δt_s²); it stalls at the cap rather than tunnelling.
 *   - Rest curvature is MATERIAL-BOUND: each segment's MaterialProfile.restCurvature holds
 *     the (steer-scaled) precurve, so it advects with the distal tip material rather than
 *     being rewritten at a fixed index-from-tip each frame.
 *
 *   UNITS: centimetres. EI/GJ in N·cm², EA in N → α via units.ts. Time is SI (Δt_s).
 *   Quaternion-imag bend convention ⇒ α_b = ℓ/(4·EI). Orientation inertia omitted
 *   (quasi-static); angular velocity is a later stage.
 *
 * STAGE 3 — IN-LOOP FRICTIONAL WALL CONTACT (this rewrite). The old post-solve contain()
 * projection (the design-doc antipattern, §3) is GONE. Wall contact is now solved INSIDE the
 * Gauss-Seidel loop as an XPBD inequality (contact.ts), so it produces a real normal
 * multiplier λ_n — the physical normal load the Coulomb friction cone needs. Added:
 *
 *   - NORMAL inequality contact C_n = R_eff − ρ ≥ 0 (λ_n ≥ 0), solved each iteration after
 *     the elastic solve, then the rod is re-solved so the correction propagates (this is what
 *     makes a blocked tip BOW/BUCKLE between supports instead of tunnelling through the wall).
 *   - TRANSLATIONAL stick-slip friction with PERSISTENT per-node wall anchors. Stick inside
 *     the static cone |λ_t| ≤ μ_s·λ_n, slip to the kinetic cone otherwise. Anchors persist
 *     across frames; elastic λ reset per substep.
 *   - SPIN friction C_ψ = r·wrap(ψ − ψ0), stick/slip vs μ_roll·λ_n — torque WINDS UP at the
 *     wall (tip roll lags the hub) and RELEASES when the cone breaks.
 *
 * STAGE 4 — CAPSULE-CHAIN/SDF LUMEN + BRANCH HYSTERESIS + SELF-COLLISION (this rewrite,
 * design doc §7). The Stage-3 nearest-single-segment containment stub is GONE. Containment now
 * uses the variable-radius capsule-chain implicit lumen (lumen.ts), which the rod queries
 * GRAPH-AWARELY with hysteresis so a node cannot snap across a bifurcation carina into a branch
 * it never entered. Added:
 *
 *   - Each node tracks its CURRENT vessel edge; Lumen.query searches that edge + graph-adjacent
 *     edges first and only allows a branch transition near a shared ostium, with a hysteresis
 *     margin before switching (no per-iteration flip-flop between near-parallel centerlines).
 *   - SEGMENT-SAMPLE collision: 1–2 samples per segment (not node-only) get their own wall
 *     contacts, with the normal correction DISTRIBUTED to the two segment endpoints by the
 *     barycentric weight — a segment can cut a corner even when both endpoints are legal.
 *   - SELF-COLLISION: non-adjacent segment midpoints (ignoring neighbours within
 *     SELF_SKIP segments) are kept ≥ 2·r_rod apart via the same C_n ≥ 0 inequality + their own
 *     persistent friction anchors, found with a uniform spatial hash. This lets an arch loop /
 *     prolapse self-support without self-intersecting.
 *   - SWEPT-SAFETY / CFL: each substep the per-node position change is CLAMPED to
 *     0.25·min(R_lumen, h) so a fast feed cannot tunnel through the wall between contact builds
 *     (the cheap alternative to true swept collision; the design doc allows either, §7).
 *
 * Public surface (kept for back-compat with the live tests and app):
 *   CosseratRod, GUIDEWIRE, CosseratParams, RodInput; x, q, n, input; step, tip,
 *   deployedLength, tipRoll.  `n` is now mutable (the rod grows/shrinks with feed).
 *   Also implements NodeContactTarget (x, prev, q, w, wq, rodRadius) for contact.ts.
 */

export type RodProfileKind = "guidewire" | "sheath";

export interface CosseratParams {
  /** Segment count at the REFERENCE deployed length (sets the fixed base length h). */
  segments: number;
  rodRadius: number; // cm
  /**
   * Reference deployed length (cm). With `segments` it fixes the nominal base segment
   * length h = referenceLength / segments. h is FROZEN — feed injects/removes h-length
   * segments; it never rescales existing rest lengths.
   */
  referenceLength: number;
  /** Number of substeps per frame (XPBD). */
  substeps: number;
  /** Solver iterations per substep. */
  iterations: number;
  /** Exponential velocity damping factor applied to the Verlet predict (0..1). */
  damping: number;
  /** Distal nodes forming the pre-shaped, floppy tip. */
  tipNodes: number;
  /** Transition-region segment count between tip and shaft. */
  transitionNodes: number;
  /** Max rest bend per tip node (radians) at full steer tightness. */
  tipCurve: number;
  /** Which graded material field to build. */
  profile: RodProfileKind;
  /**
   * Optional uniform multiplier on every bend/twist compliance, for experiments and
   * tests (stiffer = smaller, floppier = larger). 1 = use the material table as-is.
   */
  bendComplianceScale: number;
  /**
   * Multiplier on the per-contact spin (roll) friction coefficient μ_roll. 1 = use the
   * material table; 0 = disable spin friction entirely (the tip then tracks the hub roll
   * with no wall-induced lag/storage — used to demonstrate the spin-friction effect in
   * tests, design doc §3). Larger ⇒ more torque wind-up before release.
   */
  spinFrictionScale: number;
  /**
   * Coaxial INNER-CHANNEL radius (cm) when this device is the OUTER member of a coaxial pair
   * (sheath/catheter over a wire). An inner instrument is contained inside this radius minus
   * its own radius (design doc §6 R_outer,lumen). Default ≈ rodRadius (thin wall). Unused when
   * the device is the inner member or runs solo.
   */
  coaxLumenRadius: number;
}

export const GUIDEWIRE: CosseratParams = {
  segments: 80,
  rodRadius: 0.05,
  referenceLength: 20,
  // 2 substeps: enough solver passes for clean 1:1 advancement (the Stage-2 goal) while the
  // quasi-static elastic stiffness (α̃ = α/Δt_s²) stays soft enough for the pre-shaped tip to
  // express its rest curvature. (S≥4 makes the floppy-tip bend so compliant the precurve
  // barely shows; S=1 under-advances. See the Stage-2 report for the full trade-off.)
  substeps: 2,
  iterations: 12,
  damping: 0.9,
  tipNodes: 8,
  transitionNodes: 6,
  tipCurve: 0.22,
  profile: "guidewire",
  bendComplianceScale: 1,
  spinFrictionScale: 1,
  coaxLumenRadius: 0.05
};

/** A stiffer, larger-radius coaxial device (catheter / sheath). */
export const SHEATH: CosseratParams = {
  segments: 80,
  rodRadius: 0.1,
  referenceLength: 20,
  substeps: 4,
  iterations: 12,
  damping: 0.9,
  tipNodes: 0,
  transitionNodes: 0,
  tipCurve: 0,
  profile: "sheath",
  bendComplianceScale: 1,
  spinFrictionScale: 1,
  // 6 Fr sheath: OD ≈ 0.1 cm radius, inner channel ≈ 0.09 cm. Admits a 0.05 cm wire with ~0.04 cm
  // radial clearance — enough that a straight wire in a straight sheath does not spuriously press
  // the channel wall at the rod's segment resolution, but tight enough to contain a bowing tip.
  coaxLumenRadius: 0.09
};

export interface RodInput {
  deployed: number; // cm
  steer: number; // 0..1 tip tightness
  torque: number; // radians, handle roll
}

const _v = new Vector3();
const _restAxis = new Vector3();
const _advTan = new Vector3();
const _sample = new Vector3();
const _selfP = new Vector3();
const _selfQ = new Vector3();
const _selfN = new Vector3();
const _segAb = new Vector3();
const _segAp = new Vector3();

/**
 * A self-collision pair between two non-adjacent segment midpoints. The minimum-distance pair
 * is kept ≥ 2·r_rod apart by an XPBD normal inequality distributed equally to the four
 * endpoints. Lightweight (no persistent friction anchor — self-support, not stick-slip).
 */
interface SelfContact {
  segA: number;
  segB: number;
  lambdaN: number;
}

function director(q: Quaternion, out: Vector3): Vector3 {
  return out.set(
    2 * (q.x * q.z + q.w * q.y),
    2 * (q.y * q.z - q.w * q.x),
    q.w * q.w - q.x * q.x - q.y * q.y + q.z * q.z
  );
}

/** Hamilton product a*b into out (x,y,z,w order). */
function qmul(a: Quaternion, b: Quaternion, out: Quaternion): Quaternion {
  return out.set(
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  );
}

/** Closest point of segment [a,b] to p, into `out`; returns the clamped parameter t ∈ [0,1]. */
function closestOnSeg(p: Vector3, a: Vector3, b: Vector3, out: Vector3): number {
  _segAb.subVectors(b, a);
  _segAp.subVectors(p, a);
  const len2 = _segAb.lengthSq() || 1e-9;
  const t = Math.max(0, Math.min(1, _segAp.dot(_segAb) / len2));
  out.copy(a).addScaledVector(_segAb, t);
  return t;
}

export class CosseratRod implements Injectable, NodeContactTarget {
  readonly params: CosseratParams;
  /** Particle count = segments + 1. MUTABLE: the rod grows/shrinks as material is fed. */
  n: number;
  x: Vector3[]; // particle positions (index 0 = proximal/access, last = tip)
  prev: Vector3[];
  q: Quaternion[]; // per-segment frames (length = segments)
  w: number[]; // inverse mass per particle
  wq: number[]; // inverse inertia per segment

  /** Cross-section radius (cm) exposed for the contact solvers (NodeContactTarget). */
  get rodRadius(): number {
    return this.params.rodRadius;
  }

  /** Inner-channel radius (cm) when this rod is the OUTER member of a coaxial pair (design §6). */
  get coaxLumenRadius(): number {
    return this.params.coaxLumenRadius;
  }

  /** Per-segment rest length (cm). FROZEN at h on injection; never rescaled. */
  restLen: number[];
  /** Lagrangian material field, parallel to restLen[]. perSegment[0] = proximal. */
  material: MaterialField;

  /** Fixed nominal base segment length h (cm). h = referenceLength / segments. */
  readonly h: number;
  /** Minimum particle count to keep when retracting. */
  readonly minNodes = 3;

  /** Access frame + insertion-boundary state (replaces the old pinned base). */
  readonly access: AccessFrame;
  readonly insertion: InsertionState;

  /** XPBD multipliers, reset each substep. Sized lazily to the current segment count.
   * Stretch-shear is a 3-vector constraint → three SIGNED per-axis multipliers (x,y,z). */
  private lambdaStretchX: number[];
  private lambdaStretchY: number[];
  private lambdaStretchZ: number[];
  private lambdaBend1: number[];
  private lambdaBend2: number[];
  private lambdaTwist: number[];

  /** Variable-radius capsule-chain implicit lumen (Stage 4) — graph-aware nearest-edge query. */
  private readonly lumen: Lumen;
  /** Reusable LumenQuery result (allocation-free queries). */
  private readonly lq: LumenQuery = {
    center: new Vector3(),
    radius: 1,
    tangent: new Vector3(0, 0, 1),
    edgeIndex: -1,
    arc: 0,
    inside: true
  };
  /** Per-node current vessel edge id (−1 = unknown). Carries the hysteresis state; shifts with
   * the node on inject/retract so a node keeps its containing edge across renumbering. */
  private currentEdge: number[] = [];

  /**
   * Persistent frictional wall contacts, indexed by node. A Contact is created the first time
   * a node enters contact range and REUSED thereafter so its friction multipliers + anchor
   * survive across frames (the static-friction / torque-storage state). The map is pruned /
   * re-keyed as nodes are injected/removed (node indices shift on inject/retract). null = the
   * node is not currently in contact range.
   */
  private contacts: (Contact | null)[] = [];
  /** Scratch list of the ACTIVE node wall contacts for this substep (those within range). */
  private activeContacts: Contact[] = [];

  /**
   * Per-segment-sample wall contacts (Stage 4). One contact per interior segment, anchored at
   * the segment MIDPOINT sample; the normal correction is distributed to both endpoints. A
   * segment can cut a corner even when both endpoints are legal, so node-only collision is not
   * enough around tight bends (design doc §7). Indexed by segment; pruned on inject/retract.
   */
  private segContacts: (Contact | null)[] = [];
  private activeSegContacts: Contact[] = [];

  /**
   * Persistent SELF-collision contacts (Stage 4). Non-adjacent segment midpoints kept ≥ 2·r_rod
   * apart so an arch loop / prolapse self-supports without self-intersecting. Rebuilt each
   * substep via a uniform spatial hash; the anchors do not persist across the rebuild (the pair
   * indices change as the rod moves), which is acceptable for self-support.
   */
  private activeSelfContacts: SelfContact[] = [];
  private selfPool: SelfContact[] = [];
  /** Uniform spatial hash buckets for self-collision broad phase (rebuilt each substep). */
  private selfHash = new Map<number, number[]>();

  input: RodInput = { deployed: 8, steer: 0.45, torque: 0 };

  /** cm/s rate cap on the legacy-deployed feed adapter (no startup shock). */
  private static FEED_RATE = 35;

  /**
   * Centerline contact margin ε_c (cm): allowed centerline radius R_eff = R_lumen − r − ε_c
   * (design doc §3, ε_c ≈ 0.05–0.20 mm = 0.005–0.02 cm). Small so the rod can still fill a
   * tight lumen, large enough to keep the surface off the wall.
   */
  private static EPS_C = 0.005;
  /** Normal-contact compliance (cm-units). Small ⇒ a near-rigid wall. */
  private static ALPHA_N = 1e-9;
  /** Translational-friction compliance (cm-units). */
  private static ALPHA_T = 1e-8;
  /** Spin-friction compliance (cm-units). */
  private static ALPHA_ROLL = 1e-7;
  /**
   * Self-collision: ignore segment pairs whose midpoint indices are within SELF_SKIP of each
   * other (adjacent material is always "touching"; only a folded-back loop is a real collision).
   */
  private static SELF_SKIP = 3;

  // scratch quaternions
  private tmpA = new Quaternion();
  private tmpB = new Quaternion();
  private tmpC = new Quaternion();

  constructor(anatomy: Anatomy, accessId: string, params: CosseratParams = GUIDEWIRE) {
    this.params = params;
    this.h = params.referenceLength / params.segments;

    const site = anatomy.access.find((a) => a.id === accessId) ?? anatomy.access[0];
    this.access = buildAccessFrame(site);
    this.insertion = defaultInsertionState(this.h);

    // Stage 4: variable-radius capsule-chain implicit lumen with graph adjacency + a spatial
    // grid (lumen.ts). Replaces the old inline nearest-single-segment capsule list.
    this.lumen = new Lumen(anatomy);

    // Seed the rod straight along the access axis, spaced at the FIXED rest length h, with
    // exactly round(deployed/h) segments (so the legacy deployed input maps to a node count
    // without any startup shock and without rescaling rest lengths later).
    const segs = Math.max(this.minNodes - 1, Math.round(this.input.deployed / this.h));
    this.n = segs + 1;
    this.x = [];
    this.prev = [];
    this.w = [];
    for (let i = 0; i < this.n; i++) {
      const p = this.access.x.clone().addScaledVector(this.access.e, i * this.h);
      this.x.push(p);
      this.prev.push(p.clone());
      // The proximal node (index 0) is the KINEMATIC insertion boundary: it is held at the
      // moving inlet point each substep (w=0), NOT a fixed material pin — material is
      // injected through it and existing rest lengths stay frozen. The intravascular shaft
      // (i≥1) is a free rod. (insertion.ts also provides a compliant velocity-motor + force
      // cap; Stage 3 wires that in for blocked-tip stall. For free advancement the moving
      // Dirichlet boundary is the stable, equivalent limit and is what keeps the rod from
      // accumulating rigid-body drift.)
      this.w.push(i === 0 ? 0 : 1);
    }

    const baseQ = injectedFrame(this.access, 0, new Quaternion());
    this.q = [];
    this.wq = [];
    this.restLen = [];
    for (let j = 0; j < segs; j++) {
      this.q.push(baseQ.clone());
      this.wq.push(j === 0 ? 0 : 1); // proximal frame kinematic = access frame (rolled by hub)
      this.restLen.push(this.h);
    }

    // Graded material field at the FIXED base length h. tipCurve is baked into the distal
    // segments' restCurvature (advection-safe); steer scales it in the solve.
    this.material =
      params.profile === "sheath"
        ? buildSheathField(segs, this.h)
        : buildGuidewireField(segs, this.h, {
            tipSegments: params.tipNodes,
            transitionSegments: params.transitionNodes,
            tipCurvature: params.tipCurve
          });
    this.applyComplianceScale(this.material.perSegment);

    this.lambdaStretchX = [];
    this.lambdaStretchY = [];
    this.lambdaStretchZ = [];
    this.lambdaBend1 = [];
    this.lambdaBend2 = [];
    this.lambdaTwist = [];
    this.resizeLambdas();

    // per-node hysteresis state (current vessel edge), unknown until the first query
    this.currentEdge = new Array(this.n).fill(-1);
  }

  // ----- Injectable interface (material injection at the proximal access) -----

  /** Prepend a new proximal node at p with frame q; freeze restLen[0] = h; advect material. */
  prependNode(p: Vector3, q: Quaternion, h: number): void {
    // MATERIAL ADVECTION (the heart of the insertion BC): a length h of new material has
    // entered at the back, so every existing material point moves FORWARD by h along the
    // rod's own arc. We advect positions by h along each node's local tangent BEFORE adding
    // the new back node. This is what makes Δx_tip/ΔL_feed ≈ 1 without relying on the
    // Gauss-Seidel push propagating the full length each frame, and it is NOT a rail: the
    // rod is still free and the elastic solve immediately re-relaxes curvature/buckling.
    // Frames advect with the material the same way (q[i] ← q[i-1]); the proximal-most frame
    // becomes the access frame. Rest lengths and the material field are FROZEN (no rescale).
    this.advectForward(h);

    // the new node 0 is the kinematic boundary; the OLD node 0 (now index 1) is free
    if (this.w.length > 0) this.w[0] = 1;
    if (this.wq.length > 0) this.wq[0] = 1;
    this.x.unshift(p.clone());
    this.prev.unshift(p.clone());
    this.w.unshift(0); // kinematic insertion boundary
    this.q.unshift(q.clone());
    this.wq.unshift(0); // kinematic frame = access frame (rolled by hub)
    this.restLen.unshift(h);
    // the injected proximal segment carries SHAFT properties (frozen), never resampled — so
    // the distal tip profile (α, rest curvature) is untouched (advection-safe).
    const prof = this.scaledProfile(shaftProfile(h));
    this.material.perSegment.unshift(prof);
    // contacts are keyed by node index; a new proximal node shifts every existing node up by
    // one, so the persistent contacts (and their friction anchors) must shift with the
    // material to stay attached to the same physical node. The new proximal node has none yet.
    this.contacts.unshift(null);
    for (const c of this.contacts) if (c) c.node += 1;
    // per-node hysteresis state shifts the same way; the new proximal node's edge is unknown.
    this.currentEdge.unshift(-1);
    // a new proximal SEGMENT is created too (index 0); its sample contact + segment refs shift.
    this.segContacts.unshift(null);
    for (const c of this.segContacts) if (c) c.segment += 1;
    this.n = this.x.length;
    this.resizeLambdas();
  }

  /**
   * Advect the whole chain forward by arc length `len` along each node's local tangent.
   * Each material point slides forward along the rod by `len`, modelling the existing
   * material being pushed in as new material enters at the access. Allocation-light (one
   * scratch Vector3). Frames are left as-is (the elastic solve re-aligns them); the position
   * advection is what carries the tip advance.
   */
  private advectForward(len: number): void {
    const N = this.x.length;
    if (N < 2 || len <= 0) return;
    // local forward tangent per node (central where possible, one-sided at the ends)
    for (let i = N - 1; i >= 1; i--) {
      const prevNode = this.x[i - 1];
      const cur = this.x[i];
      _advTan.subVectors(cur, prevNode); // proximal→this segment direction
      const l = _advTan.length();
      if (l > 1e-9) _advTan.multiplyScalar(len / l);
      else _advTan.copy(this.access.e).multiplyScalar(len);
      cur.addScaledVector(_advTan, 1);
      this.prev[i].copy(cur); // advection is a kinematic transport, not a velocity
    }
  }

  /** Remove the proximal-most node + its segment + material (no-op below minNodes). */
  removeProximalNode(): void {
    if (this.n <= this.minNodes) return;
    this.x.shift();
    this.prev.shift();
    this.w.shift();
    this.q.shift();
    this.wq.shift();
    this.restLen.shift();
    this.material.perSegment.shift();
    // drop the proximal node's contact and shift the rest down to track the renumbering
    this.contacts.shift();
    for (const c of this.contacts) if (c) c.node -= 1;
    // per-node hysteresis state + the proximal segment's sample contact shift down too
    this.currentEdge.shift();
    this.segContacts.shift();
    for (const c of this.segContacts) if (c) c.segment -= 1;
    // the new proximal node + frame become the kinematic boundary
    if (this.w.length > 0) this.w[0] = 0;
    if (this.wq.length > 0) this.wq[0] = 0;
    this.n = this.x.length;
    this.resizeLambdas();
  }

  private resizeLambdas(): void {
    const segs = this.q.length;
    const fit = (arr: number[], len: number) => {
      arr.length = Math.max(0, len);
      arr.fill(0);
    };
    fit(this.lambdaStretchX, segs);
    fit(this.lambdaStretchY, segs);
    fit(this.lambdaStretchZ, segs);
    fit(this.lambdaBend1, Math.max(0, segs - 1));
    fit(this.lambdaBend2, Math.max(0, segs - 1));
    fit(this.lambdaTwist, Math.max(0, segs - 1));
  }

  private applyComplianceScale(profiles: MaterialProfile[]): void {
    const s = this.params.bendComplianceScale;
    if (s === 1) return;
    for (const m of profiles) {
      m.alphaBend1 *= s;
      m.alphaBend2 *= s;
      m.alphaTwist *= s;
    }
  }

  private scaledProfile(p: MaterialProfile): MaterialProfile {
    const s = this.params.bendComplianceScale;
    if (s !== 1) {
      p.alphaBend1 *= s;
      p.alphaBend2 *= s;
      p.alphaTwist *= s;
    }
    return p;
  }

  // ----- elastic constraints (XPBD compliance) -----

  /**
   * XPBD stretch-shear for segment j. C_s = (1/ℓ)(p_b - p_a) - d3(q_j). As α_stretch → 0
   * this reduces to the rigid PBD projection (inextensibility test relies on this). The
   * Cosserat shear coupling also rotates the segment frame to follow the position.
   */
  private solveStretchShear(j: number, dtSeconds: number): void {
    const a = j;
    const b = j + 1;
    const qj = this.q[j];
    const l0 = this.restLen[j];
    const d3 = director(qj, _v);
    const cx = (this.x[b].x - this.x[a].x) / l0 - d3.x;
    const cy = (this.x[b].y - this.x[a].y) / l0 - d3.y;
    const cz = (this.x[b].z - this.x[a].z) / l0 - d3.z;

    const denomGeom = (this.w[a] + this.w[b]) / l0 + 4 * l0 * this.wq[j] + 1e-6;
    const alpha = this.material.perSegment[j].alphaStretch;
    const aTilde = alpha / (dtSeconds * dtSeconds);
    const denom = denomGeom + aTilde;
    // SIGNED per-axis XPBD: Δλ = -(C + α̃·λ)/denom, λ += Δλ. (The previous code accumulated
    // Math.hypot — always positive — so λ ran away and the α̃·λ regularization injected an
    // ever-growing phantom force that diverged at high α̃ i.e. ≥4 substeps. Signed
    // accumulation is the correct XPBD form and is stable for any substep count.)
    const gx = -(cx + aTilde * this.lambdaStretchX[j]) / denom;
    const gy = -(cy + aTilde * this.lambdaStretchY[j]) / denom;
    const gz = -(cz + aTilde * this.lambdaStretchZ[j]) / denom;
    this.lambdaStretchX[j] += gx;
    this.lambdaStretchY[j] += gy;
    this.lambdaStretchZ[j] += gz;

    this.x[a].x -= this.w[a] * gx;
    this.x[a].y -= this.w[a] * gy;
    this.x[a].z -= this.w[a] * gz;
    this.x[b].x += this.w[b] * gx;
    this.x[b].y += this.w[b] * gy;
    this.x[b].z += this.w[b] * gz;

    if (this.wq[j] > 0) {
      const qe3bar = this.tmpA.set(qj.z, -qj.y, qj.x, -qj.w);
      const gq = this.tmpB.set(gx, gy, gz, 0);
      const dq = qmul(gq, qe3bar, this.tmpC);
      const s = 2 * this.wq[j] * l0;
      qj.set(qj.x - s * dq.x, qj.y - s * dq.y, qj.z - s * dq.z, qj.w - s * dq.w).normalize();
    }
  }

  /**
   * Steer-scaled rest curvature (quaternion-imag) for interior node k (between segments
   * k and k+1), read from the MATERIAL field (advection-safe). The material stores the
   * full-steer precurve angle per axis; we scale by the steer input and encode sin(φ/2).
   */
  private restOmega(k: number, out: Vector3): Vector3 {
    // use the distal segment's material curvature so the tip's precurve is what bends
    const angleAxis = this.material.perSegment[k + 1].restCurvature;
    const tight = Math.max(0, Math.min(1, this.input.steer));
    const ax = angleAxis.x * tight;
    const ay = angleAxis.y * tight;
    const az = angleAxis.z * tight;
    const phi = Math.hypot(ax, ay, az);
    if (phi < 1e-9) return out.set(0, 0, 0);
    const s = Math.sin(0.5 * phi) / phi;
    return out.set(ax * s, ay * s, az * s);
  }

  /**
   * XPBD bend-twist between segments k and k+1. C_b = Im(conj(q_k) q_{k+1}) - s·Ω0 with the
   * closest-quaternion sign s. Bending uses α_b = ℓ/(4·EI); twist uses α_t = ℓ/(4·GJ).
   */
  private solveBendTwist(k: number, dtSeconds: number): void {
    const j = k;
    const jp = k + 1;
    const qj = this.q[j];
    const qjp = this.q[jp];
    const omega = qmul(this.tmpA.copy(qj).conjugate(), qjp, this.tmpB);
    const O0 = this.restOmega(k, _restAxis);

    const minusSq =
      (omega.x - O0.x) ** 2 + (omega.y - O0.y) ** 2 + (omega.z - O0.z) ** 2 + omega.w ** 2;
    const plusSq =
      (omega.x + O0.x) ** 2 + (omega.y + O0.y) ** 2 + (omega.z + O0.z) ** 2 + omega.w ** 2;
    const sign = plusSq < minusSq ? 1 : -1;
    const cx = omega.x + sign * O0.x;
    const cy = omega.y + sign * O0.y;
    const cz = omega.z + sign * O0.z;

    const wGradSq = this.wq[j] + this.wq[jp] + 1e-9;
    const mj = this.material.perSegment[j];
    const mjp = this.material.perSegment[jp];
    const aBend1 = 0.5 * (mj.alphaBend1 + mjp.alphaBend1);
    const aBend2 = 0.5 * (mj.alphaBend2 + mjp.alphaBend2);
    const aTwist = 0.5 * (mj.alphaTwist + mjp.alphaTwist);

    const dl1 = solveXPBDScalar(cx, this.lambdaBend1[k], wGradSq, aBend1, dtSeconds);
    const dl2 = solveXPBDScalar(cy, this.lambdaBend2[k], wGradSq, aBend2, dtSeconds);
    const dl3 = solveXPBDScalar(cz, this.lambdaTwist[k], wGradSq, aTwist, dtSeconds);
    this.lambdaBend1[k] += dl1;
    this.lambdaBend2[k] += dl2;
    this.lambdaTwist[k] += dl3;

    const corr = this.tmpC.set(dl1, dl2, dl3, 0);
    if (this.wq[j] > 0) {
      const dqj = qmul(qjp, corr, this.tmpA);
      qj.set(qj.x - this.wq[j] * dqj.x, qj.y - this.wq[j] * dqj.y, qj.z - this.wq[j] * dqj.z, qj.w - this.wq[j] * dqj.w).normalize();
    }
    if (this.wq[jp] > 0) {
      const dqjp = qmul(qj, corr, this.tmpA);
      qjp.set(qjp.x + this.wq[jp] * dqjp.x, qjp.y + this.wq[jp] * dqjp.y, qjp.z + this.wq[jp] * dqjp.z, qjp.w + this.wq[jp] * dqjp.w).normalize();
    }
  }

  /**
   * Build / refresh the persistent frictional NODE wall contacts for this substep (design doc
   * §3 + §7). For each node the implicit lumen is queried GRAPH-AWARELY with hysteresis: the
   * search starts from the node's current vessel edge + its graph neighbours and only switches
   * branch near a shared ostium, so a node cannot snap across a bifurcation carina. The query
   * returns the closest centerline point, the lumen radius there, the vessel tangent, and the
   * chosen edge id (stored back into this.currentEdge[i] for the next query). A node within a
   * build band of the wall gets a persistent Contact (reused so its friction λ + anchor persist);
   * a node deep inside the lumen has its contact dropped. The proximal kinematic node (w=0) never
   * contacts. Populates this.activeContacts.
   *
   * NOTE this only updates contact GEOMETRY + lifecycle — it does not move nodes or touch the
   * normal/friction multipliers. The actual projection happens inside the Gauss-Seidel loop.
   */
  private buildContacts(): void {
    this.activeContacts.length = 0;
    if (this.contacts.length !== this.n) this.contacts.length = this.n;
    if (this.currentEdge.length !== this.n) {
      // defensive resize (inject/retract maintain it; an external resize would desync)
      while (this.currentEdge.length < this.n) this.currentEdge.push(-1);
      this.currentEdge.length = this.n;
    }
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] === 0) {
        this.contacts[i] = null; // kinematic boundary: no wall contact
        continue;
      }
      const p = this.x[i];
      // graph-aware nearest-edge query with hysteresis (lumen.ts); persists the chosen edge.
      this.currentEdge[i] = this.lumen.query(p, this.currentEdge[i] ?? -1, this.lq);
      const allowed = Math.max(0.02, this.lq.radius - this.params.rodRadius - CosseratRod.EPS_C);
      const d = p.distanceTo(this.lq.center);
      const band = 0.5 * Math.max(this.params.rodRadius, this.h);
      if (d >= allowed - band) {
        let c = this.contacts[i];
        if (!c) {
          c = this.makeContactFor(i, Math.min(i, this.q.length - 1));
          this.contacts[i] = c;
        } else {
          c.node = i;
          c.segment = Math.min(i, this.q.length - 1);
        }
        refreshWallContact(c, this.lq.center, this.lq.tangent, allowed);
        this.activeContacts.push(c);
      } else {
        this.contacts[i] = null;
      }
    }
    this.buildSegmentContacts();
    this.buildSelfContacts();
  }

  /** Allocate a fresh persistent wall contact carrying node `i`'s material friction. */
  private makeContactFor(node: number, segment: number): Contact {
    const m = this.material.perSegment[Math.min(node, this.material.perSegment.length - 1)];
    return makeWallContact(
      "rod",
      node,
      segment,
      m.muStatic,
      m.muKinetic,
      m.muRoll * this.params.spinFrictionScale,
      CosseratRod.ALPHA_N,
      CosseratRod.ALPHA_T,
      CosseratRod.ALPHA_ROLL
    );
  }

  /**
   * SEGMENT-SAMPLE wall contacts (design doc §7): a segment can cut a corner even when both its
   * endpoints sit legally inside the lumen, so we also test a MIDPOINT sample per segment. The
   * sample inherits the segment's containing edge (seeded from its endpoint's hysteresis state),
   * and a normal correction is later distributed to BOTH endpoints by the barycentric weight
   * (here the midpoint ⇒ 0.5/0.5). Stored persistently per segment so friction anchors carry.
   */
  private buildSegmentContacts(): void {
    this.activeSegContacts.length = 0;
    const segs = this.q.length;
    if (this.segContacts.length !== segs) this.segContacts.length = segs;
    for (let s = 0; s < segs; s++) {
      // skip segments incident to the kinematic boundary node (their motion is prescribed)
      if (this.w[s] === 0 || this.w[s + 1] === 0) {
        this.segContacts[s] = null;
        continue;
      }
      _sample.addVectors(this.x[s], this.x[s + 1]).multiplyScalar(0.5);
      const seed = this.currentEdge[s + 1] ?? this.currentEdge[s] ?? -1;
      this.lumen.query(_sample, seed, this.lq);
      const allowed = Math.max(0.02, this.lq.radius - this.params.rodRadius - CosseratRod.EPS_C);
      const d = _sample.distanceTo(this.lq.center);
      const band = 0.5 * Math.max(this.params.rodRadius, this.h);
      if (d >= allowed - band) {
        let c = this.segContacts[s];
        if (!c) {
          c = this.makeContactFor(s, s);
          this.segContacts[s] = c;
        } else {
          c.node = s;
          c.segment = s;
        }
        refreshWallContact(c, this.lq.center, this.lq.tangent, allowed);
        this.activeSegContacts.push(c);
      } else {
        this.segContacts[s] = null;
      }
    }
  }

  /**
   * SELF-COLLISION broad+narrow phase (design doc §7): non-adjacent segment MIDPOINTS are kept
   * ≥ 2·r_rod apart so an arch loop / prolapse self-supports without self-intersecting. Adjacent
   * material (within SELF_SKIP segments) is always "touching" and is ignored. A uniform spatial
   * hash on the midpoints gives the broad phase; each surviving pair becomes a SelfContact solved
   * by the C_n ≥ 0 inequality. Rebuilt each substep (pair indices change as the rod moves).
   */
  private buildSelfContacts(): void {
    this.activeSelfContacts.length = 0;
    const segs = this.q.length;
    if (segs < 2 * CosseratRod.SELF_SKIP + 2) return;
    const diameter = 2 * this.params.rodRadius;
    const cell = Math.max(diameter, 0.5 * this.h);
    const inv = 1 / cell;
    this.selfHash.clear();
    const key = (x: number, y: number, z: number) =>
      ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;
    // insert each segment midpoint into its hash cell
    for (let s = 0; s < segs; s++) {
      _selfP.addVectors(this.x[s], this.x[s + 1]).multiplyScalar(0.5);
      const cx = Math.floor(_selfP.x * inv);
      const cy = Math.floor(_selfP.y * inv);
      const cz = Math.floor(_selfP.z * inv);
      const k = key(cx, cy, cz);
      let bucket = this.selfHash.get(k);
      if (!bucket) {
        bucket = [];
        this.selfHash.set(k, bucket);
      }
      bucket.push(s);
    }
    // narrow phase: for each segment, test the 27-cell neighbourhood for close non-adjacent mates
    let poolIdx = 0;
    for (let s = 0; s < segs; s++) {
      _selfP.addVectors(this.x[s], this.x[s + 1]).multiplyScalar(0.5);
      const cx = Math.floor(_selfP.x * inv);
      const cy = Math.floor(_selfP.y * inv);
      const cz = Math.floor(_selfP.z * inv);
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const bucket = this.selfHash.get(key(cx + dx, cy + dy, cz + dz));
            if (!bucket) continue;
            for (const t of bucket) {
              if (t <= s + CosseratRod.SELF_SKIP) continue; // adjacent or already-paired
              _selfQ.addVectors(this.x[t], this.x[t + 1]).multiplyScalar(0.5);
              if (_selfP.distanceToSquared(_selfQ) > diameter * diameter) continue;
              const sc = this.selfPool[poolIdx] ?? { segA: 0, segB: 0, lambdaN: 0 };
              sc.segA = s;
              sc.segB = t;
              sc.lambdaN = 0;
              this.selfPool[poolIdx] = sc;
              poolIdx++;
              this.activeSelfContacts.push(sc);
            }
          }
    }
  }

  /**
   * Solve a segment-sample wall normal inequality, distributing the correction to BOTH segment
   * endpoints (barycentric 0.5/0.5 at the midpoint). C_n = R_eff − ρ ≥ 0, ∇C = −n on the
   * sample; the endpoints share it by their inverse masses. Then runs the same persistent
   * translational + spin friction on the sample (anchored at the midpoint).
   */
  private solveSegmentWallContact(c: Contact, dtSeconds: number): void {
    const a = c.segment;
    const b = a + 1;
    const wa = this.w[a];
    const wb = this.w[b];
    const wSum = wa + wb;
    if (wSum <= 0) return;
    _sample.addVectors(this.x[a], this.x[b]).multiplyScalar(0.5);
    _v.subVectors(_sample, c.center);
    const rho = _v.length();
    if (rho < 1e-9) return;
    c.normal.copy(_v).multiplyScalar(1 / rho);
    const Cn = c.allowedRadius - rho;
    if (Cn >= 0 && c.lambdaN <= 0) return;
    const aTilde = c.alphaN / (dtSeconds * dtSeconds);
    // sample position is (xa+xb)/2 ⇒ ∂sample/∂xa = ∂sample/∂xb = 1/2; |∇C|² mass = wSum/4.
    const gradMass = 0.25 * wSum;
    let dL = -(Cn + aTilde * c.lambdaN) / (gradMass + aTilde);
    const old = c.lambdaN;
    c.lambdaN = Math.max(0, c.lambdaN + dL);
    dL = c.lambdaN - old;
    // x_a += w_a·(−n)·(1/2)·Δλ ; x_b likewise (positive Δλ moves the sample inward).
    this.x[a].addScaledVector(c.normal, -0.5 * wa * dL);
    this.x[b].addScaledVector(c.normal, -0.5 * wb * dL);
  }

  /**
   * Solve one self-collision pair: keep two non-adjacent segment midpoints ≥ 2·r_rod apart with
   * an XPBD normal inequality. The correction is split equally to all four endpoints by mass.
   */
  private solveSelfContact(sc: SelfContact, dtSeconds: number): void {
    const a0 = sc.segA;
    const a1 = sc.segA + 1;
    const b0 = sc.segB;
    const b1 = sc.segB + 1;
    _selfP.addVectors(this.x[a0], this.x[a1]).multiplyScalar(0.5);
    _selfQ.addVectors(this.x[b0], this.x[b1]).multiplyScalar(0.5);
    _selfN.subVectors(_selfP, _selfQ);
    const rho = _selfN.length();
    if (rho < 1e-9) return;
    _selfN.multiplyScalar(1 / rho); // n = (P − Q)/ρ, points A away from B
    const minDist = 2 * this.params.rodRadius;
    // unilateral separation constraint C_n = ρ − minDist ≥ 0 (overlapping ⇒ C_n < 0). ∇_A C = +n,
    // ∇_B C = −n. Early-out when separated AND no stored load (true inequality).
    const Cn = rho - minDist;
    if (Cn >= 0 && sc.lambdaN <= 0) return;
    // each midpoint depends on its two endpoints with weight 1/2 ⇒ gradient-mass = (Σw)/4.
    const wA = 0.25 * (this.w[a0] + this.w[a1]);
    const wB = 0.25 * (this.w[b0] + this.w[b1]);
    const aTilde = CosseratRod.ALPHA_N / (dtSeconds * dtSeconds);
    const denom = wA + wB + aTilde;
    if (denom < 1e-12) return;
    let dL = -(Cn + aTilde * sc.lambdaN) / denom;
    const old = sc.lambdaN;
    sc.lambdaN = Math.max(0, sc.lambdaN + dL);
    dL = sc.lambdaN - old;
    // push midpoint A along +n and midpoint B along −n (split to endpoints by their inv-mass)
    this.x[a0].addScaledVector(_selfN, 0.5 * this.w[a0] * dL);
    this.x[a1].addScaledVector(_selfN, 0.5 * this.w[a1] * dL);
    this.x[b0].addScaledVector(_selfN, -0.5 * this.w[b0] * dL);
    this.x[b1].addScaledVector(_selfN, -0.5 * this.w[b1] * dL);
  }

  /**
   * Lumen radius at node `i` for the CFL clamp. Uses the node's already-known current edge if
   * available (no query) and clamps the radius interpolation to that edge; otherwise queries the
   * lumen once. Returns a generous default if no lumen exists (e.g. a free-space test tube).
   */
  private localLumenRadius(i: number): number {
    const e = this.currentEdge[i] ?? -1;
    if (e >= 0 && e < this.lumen.edges.length) {
      const edge = this.lumen.edges[e];
      const t = closestOnSeg(this.x[i], edge.a, edge.b, _sample);
      return edge.ra + (edge.rb - edge.ra) * t;
    }
    this.currentEdge[i] = this.lumen.query(this.x[i], -1, this.lq);
    return this.lq.radius;
  }

  private resetElasticLambdas(): void {
    this.lambdaStretchX.fill(0);
    this.lambdaStretchY.fill(0);
    this.lambdaStretchZ.fill(0);
    this.lambdaBend1.fill(0);
    this.lambdaBend2.fill(0);
    this.lambdaTwist.fill(0);
  }

  /**
   * Hard inlet anchor: place the kinematic proximal node at the MOVING inlet point
   * (x_A + inletOffsetTarget·e_A) and set the proximal frame to the access frame rolled by
   * the hub angle. This is the stiff-motor limit of solveInletPositionMotor /
   * solveInletOrientationMotor (insertion.ts) — a MOVING Dirichlet boundary, not a fixed
   * material pin: rest lengths stay frozen and material is injected through it. It is the
   * stable anchor that prevents rigid-body drift; Stage 3 swaps in the compliant motor +
   * force cap so a blocked tip stalls instead of injecting infinite force.
   */
  private anchorInlet(): void {
    // boundary node fixed at the access plane (axial 0); material is injected through it and
    // the stretch constraint advances the chain — node 0 itself does not translate with feed
    this.x[0].copy(this.access.x);
    this.prev[0].copy(this.x[0]); // kinematic: no Verlet velocity on the boundary node
    injectedFrame(this.access, this.insertion.rollTarget, this.q[0]);
  }

  /** Current deployed (intravascular) arc length ≈ injected segments × h + inlet offset. */
  deployedLength(): number {
    return (this.n - 1) * this.h + this.insertion.inletOffset;
  }

  /**
   * Convert the legacy RodInput.deployed/torque into the velocity-controlled insertion BC:
   * a rate-limited feed velocity that drives deployedLength() toward input.deployed, and a
   * roll target from input.torque. Returns the per-substep feed velocity (cm/s).
   */
  private feedVelocityForFrame(dt: number): number {
    const want = this.input.deployed - this.deployedLength();
    const maxStep = CosseratRod.FEED_RATE * Math.min(dt, 1 / 30);
    const stepLen = Math.max(-maxStep, Math.min(maxStep, want));
    return stepLen / Math.max(dt, 1e-6); // cm/s
  }

  /**
   * Substep Δt_s in seconds for this frame: dt / S. The elastic compliance enters as
   * α̃ = α/Δt_s² (units.ts/xpbd.ts). NOTE the substep count is a real STIFFNESS knob for this
   * quasi-static rod (the doc allows quasi-static orientations for a highly damped trainer, §5):
   * more substeps ⇒ smaller Δt_s ⇒ larger α̃ ⇒ softer elastic response. S=2 (GUIDEWIRE) is tuned
   * so the rod both advances ~1:1 and the floppy tip still expresses its pre-shaped rest curvature.
   */
  dtSeconds(dt: number): number {
    return dt / Math.max(1, this.params.substeps);
  }

  /**
   * Begin one substep (design doc step-1..4): inject/retract material at the access plane,
   * predict positions (damped Verlet + CFL clamp), reset the elastic multipliers, and rebuild
   * the persistent wall/segment/self contacts. Split out of step() so a multi-instrument
   * coordinator (stepCoaxial) can drive both rods' substep prologue before the interleaved solve.
   */
  beginSubstep(feedVelocity: number, rollVelocity: number, dtSeconds: number): void {
    // 1. feed targets + material injection/retraction at the access plane (frozen rest length h;
    //    no global rest-length growth → no eigenstrain → no accordion)
    injectOrRetractNodesAtAccess(this, this.access, this.insertion, feedVelocity, rollVelocity, dtSeconds);

    // 2. predict positions (damped Verlet; no external force — the feed drives motion). The
    //    kinematic boundary node (w=0) is left to anchorInlet(). The velocity is re-read each
    //    substep so a perturbation is damped S× per frame rather than amplified once.
    //
    //    SWEPT-SAFETY / CFL CLAMP (Stage 4, design doc §7): a node's per-substep position change
    //    is clamped to 0.25·min(R_lumen, h) so a fast feed/relaxation cannot tunnel a node THROUGH
    //    a wall between contact builds (the cheap alternative to true swept collision).
    const d = this.params.damping;
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] === 0) continue;
      const x = this.x[i];
      const p = this.prev[i];
      let vx = (x.x - p.x) * d;
      let vy = (x.y - p.y) * d;
      let vz = (x.z - p.z) * d;
      const step2 = vx * vx + vy * vy + vz * vz;
      const rLumen = this.localLumenRadius(i);
      const maxStep = 0.25 * Math.min(rLumen, this.h);
      if (step2 > maxStep * maxStep && step2 > 1e-18) {
        const s = maxStep / Math.sqrt(step2);
        vx *= s;
        vy *= s;
        vz *= s;
      }
      p.copy(x);
      x.set(x.x + vx, x.y + vy, x.z + vz);
    }

    // 3. reset elastic multipliers (XPBD: elastic λ are bilateral, reset each substep)
    this.resetElasticLambdas();
    this.insertion.lambdaFeed = 0;

    // 4. build / refresh persistent frictional wall contacts (geometry + lifecycle only). Friction
    //    multipliers + anchors PERSIST across substeps/frames; only λ_n is reset per iteration.
    this.buildContacts();
  }

  /** One elastic Gauss-Seidel iteration: anchor the inlet, symmetric stretch/bend sweep, anchor. */
  iterateElastic(dtSeconds: number): void {
    const segs = this.q.length;
    // proximal boundary: hard moving inlet anchor (stiff-motor limit; see anchorInlet)
    this.anchorInlet();
    // elastic: bilateral interleaving (forward then backward) for symmetric convergence
    for (let j = 0; j < segs; j++) this.solveStretchShear(j, dtSeconds);
    for (let kk = 0; kk < segs - 1; kk++) this.solveBendTwist(kk, dtSeconds);
    for (let kk = segs - 2; kk >= 0; kk--) this.solveBendTwist(kk, dtSeconds);
    for (let j = segs - 1; j >= 0; j--) this.solveStretchShear(j, dtSeconds);
    this.anchorInlet();
  }

  /** True if this rod currently has any active wall/segment/self contact to solve. */
  hasWallContacts(): boolean {
    return (
      this.activeContacts.length > 0 ||
      this.activeSegContacts.length > 0 ||
      this.activeSelfContacts.length > 0
    );
  }

  /**
   * One IN-LOOP wall/self contact iteration (design doc §3 ordering + §7): reset λ_n, solve the
   * normal inequalities (NODE walls → SEGMENT-sample walls → SELF-collision), re-solve the rod so
   * the correction propagates, then translational + spin friction. The normal multiplier is reset
   * here each iteration (re-evaluated inequality); friction λ + anchors carry over (persistent
   * static friction / torque storage). No-op (and so the symmetric free advancement is preserved)
   * when nothing is in contact range. Returns whether any contact was solved.
   */
  iterateWallContact(dtSeconds: number): boolean {
    if (!this.hasWallContacts()) return false;
    const segs = this.q.length;
    for (const c of this.activeContacts) resetNormalLambda(c);
    for (const c of this.activeSegContacts) resetNormalLambda(c);
    for (const sc of this.activeSelfContacts) sc.lambdaN = 0;
    for (const c of this.activeContacts) solveNormalContact(this, c, dtSeconds);
    for (const c of this.activeSegContacts) this.solveSegmentWallContact(c, dtSeconds);
    for (const sc of this.activeSelfContacts) this.solveSelfContact(sc, dtSeconds);

    // re-solve the rod so the contact correction propagates through stretch/bend (symmetric)
    for (let j = 0; j < segs; j++) this.solveStretchShear(j, dtSeconds);
    for (let kk = 0; kk < segs - 1; kk++) this.solveBendTwist(kk, dtSeconds);
    for (let kk = segs - 2; kk >= 0; kk--) this.solveBendTwist(kk, dtSeconds);
    for (let j = segs - 1; j >= 0; j--) this.solveStretchShear(j, dtSeconds);
    this.anchorInlet();

    // friction uses λ_n from THIS iteration as the normal load (node + segment contacts)
    for (const c of this.activeContacts) solveTranslationalFriction(this, c, dtSeconds);
    for (const c of this.activeContacts) solveSpinFriction(this, c, dtSeconds);
    for (const c of this.activeSegContacts) solveTranslationalFriction(this, c, dtSeconds);
    return true;
  }

  /** Final inlet anchor at the end of a substep (the kinematic boundary settles). */
  finishSubstep(): void {
    this.anchorInlet();
  }

  /**
   * Map the legacy RodInput.deployed/torque into this frame's feed velocity + roll target, then
   * return the feed velocity (cm/s). Public so the CoaxialAssembly coordinator can prime each
   * rod's per-frame feed exactly like the solo step() does.
   */
  feedVelocityForFramePublic(dt: number): number {
    this.insertion.rollTarget = this.input.torque;
    return this.feedVelocityForFrame(dt);
  }

  step(dt: number): void {
    // No elapsed (or non-finite) time ⇒ no physics change. Stepping with dt ≤ 0 would make the
    // XPBD compliance α̃ = α/Δt_s² diverge (Infinity → NaN) and corrupt the rod permanently.
    if (!Number.isFinite(dt) || dt <= 0) return;
    const S = Math.max(1, this.params.substeps);
    const dtSeconds = this.dtSeconds(dt);
    const feedVelocity = this.feedVelocityForFramePublic(dt);
    const iters = this.params.iterations;

    for (let sub = 0; sub < S; sub++) {
      this.beginSubstep(feedVelocity, 0, dtSeconds);
      for (let it = 0; it < iters; it++) {
        this.iterateElastic(dtSeconds);
        this.iterateWallContact(dtSeconds);
      }
      this.finishSubstep();
    }
  }

  tip(): Vector3 {
    return this.x[this.n - 1];
  }

  /** Max twist (radians) currently expressed at the tip frame — useful for diagnostics/tests. */
  tipRoll(): number {
    return 2 * Math.acos(Math.min(1, Math.abs(this.q[this.q.length - 1].w)));
  }
}

/** A floppier guidewire (higher bend compliance) for comparison tests. */
export const GUIDEWIRE_FLOPPY: CosseratParams = { ...GUIDEWIRE, bendComplianceScale: 8 };
/** A stiffer guidewire (lower bend compliance) for comparison tests. */
export const GUIDEWIRE_STIFF: CosseratParams = { ...GUIDEWIRE, bendComplianceScale: 0.05 };

// =============================================================================================
// STAGE 5 — COAXIAL SHEATH OVER WIRE (design doc §6)
// =============================================================================================

/**
 * Coax normal-containment compliance (cm-units). DELIBERATELY softer than the rigid vessel wall
 * (CosseratRod.ALPHA_N = 1e-9): the sheath gives SLIDING lateral SUPPORT, not a hard wall (design
 * doc §6 uses high-compliance support, η≈0.1–0.5). A near-rigid coax normal on a nearly-concentric
 * pair is ill-conditioned (the 3-body distribution feeds back into both rods' elastic solves and
 * buckles them near the access); a compliant support is stable AND is what physically firms up the
 * wire in a curve without a hand-coded tie.
 */
const COAX_ALPHA_N = 1e-4;
/** Coax friction compliance (cm-units). */
const COAX_ALPHA_T = 1e-6;
/**
 * Lubricated instrument-instrument friction (design doc §4 last row): μ_io is LOWER than the
 * wall (the wire/sheath interface is hydrophilic-coated). Kept light so the wire SLIDES freely
 * (the operator easily overcomes it) — the lateral SUPPORT comes from the normal containment,
 * not from gripping the wire. The persistent coax anchor still gives a little stick-slip feel.
 */
const COAX_MU_STATIC = 0.04;
const COAX_MU_KINETIC = 0.02;
/**
 * Open-portal blend length (cm): an inner node ramps off the outer containment over this axial
 * distance past the outer tip, so the inner exits the catheter tip smoothly (no fake obstruction).
 * ~1.5 segment lengths.
 */
const COAX_PORTAL_BLEND = 0.4;
/**
 * How much of the bilateral coax-normal correction the OUTER sheath absorbs (its inverse-mass
 * scale in the 3-body distribution). The sheath is the heavier/stiffer SUPPORT, so it takes a
 * small share and the contained inner takes most of the move (design doc §6 mass-weighted
 * distribution, with the sheath as the support). This is NOT an axial tie — it only weights the
 * lateral support — and it keeps a near-concentric pair stable (an equal-mass distribution shoves
 * the advection-driven outer sideways faster than it can recover, crumpling both rods).
 */
const COAX_OUTER_MASS_SCALE = 0.0;

/**
 * Coaxial assembly: an OUTER device (sheath/catheter) sliding over an INNER device (guidewire).
 * Each is its own free CosseratRod with its own MaterialProfile, access, insertion BC, and wall
 * contact — they are NOT merged (design doc §6). The coupling is purely contact + friction:
 *
 *   - inner-in-outer NORMAL containment (bilateral, 3-body, mass-weighted) — this is where
 *     catheter-over-wire SUPPORT emerges with no hand-coded stiffness tie;
 *   - coax Coulomb FRICTION (μ_io < wall), with NO axial distance constraint, so the inner
 *     slides freely along the outer except for friction;
 *   - an OPEN PORTAL at the outer tip (the inner exits with no fake obstruction).
 *
 * The substep ordering INTERLEAVES the two rods (design doc §6 ordering, top-pitfall #9 / the
 * "never solve the sheath fully then the wire once" rule): per iteration we solve each rod's
 * elastic block, then ALL normal contacts (wall + coax), then friction — repeating — so support
 * is two-way each iteration rather than a one-way artifact.
 */
export class CoaxialAssembly {
  readonly outer: CosseratRod;
  readonly inner: CosseratRod;

  /** Persistent coax contacts indexed by INNER node (anchors persist across frames). */
  private coax: (CoaxContact | null)[] = [];
  private activeCoax: CoaxContact[] = [];
  private readonly closest: CoaxClosest = { segment: -1, u: 0, rho: 0, pastTip: -1 };

  /**
   * Soft lateral centering gain ∈ [0,1] in tightly-overlapped regions (design doc §6). 0 = off
   * (rely on the normal containment alone — sufficient when clearance is moderate). A small
   * positive value firms up small-clearance tracking. Public so experiments/tests can tune it.
   */
  centeringGain = 0;

  constructor(outer: CosseratRod, inner: CosseratRod) {
    this.outer = outer;
    this.inner = inner;
  }

  /** Convenience: set the legacy deployed/steer/torque input on the inner wire. */
  setInnerInput(deployed: number, steer: number, torque: number): void {
    this.inner.input = { deployed, steer, torque };
  }
  /** Convenience: set the legacy deployed/steer/torque input on the outer sheath. */
  setOuterInput(deployed: number, steer: number, torque: number): void {
    this.outer.input = { deployed, steer, torque };
  }

  /**
   * Build / refresh the persistent coax contacts for this substep. For each FREE inner node we
   * pair it to the closest OUTER segment; a node whose closest point is at/over the outer tip is
   * in the open-portal blend (containment ramps off — never a hard cap). Reuses Contact objects so
   * the coax friction anchors persist. Populates this.activeCoax. Geometry + lifecycle only — the
   * projection happens in solveCoaxNormalIteration / solveCoaxFrictionIteration.
   */
  private buildCoaxContacts(): void {
    this.activeCoax.length = 0;
    const inner = this.inner;
    const outer = this.outer;
    if (this.coax.length !== inner.n) this.coax.length = inner.n;
    for (let i = 0; i < inner.n; i++) {
      if (inner.w[i] === 0) {
        this.coax[i] = null; // kinematic boundary node: no coax contact
        continue;
      }
      if (!closestOuterSegment(inner.x[i], outer, this.closest)) {
        this.coax[i] = null;
        continue;
      }
      // open portal: fully past the outer tip ⇒ no outer containment (governed by vessel lumen)
      const portal = portalWeight(this.closest.pastTip, COAX_PORTAL_BLEND);
      // allowed inner clearance: R_outer,lumen − r_inner. A contact is engaged ONLY when the inner
      // node is at or beyond the outer channel wall (ρ ≥ allowed): a node sitting comfortably inside
      // (ρ < allowed) needs no support and gets NO contact. This matters because the channel
      // clearance is genuinely tiny vs the segment length, so creating contacts for nominally-
      // concentric nodes (and relying on the inequality early-out) injects spurious 3-body
      // corrections that crumple BOTH rods back toward the access. A small hysteresis keeps an
      // already-engaged contact alive a little past the wall so it doesn't chatter on/off.
      const allowed = Math.max(0.0, outer.coaxLumenRadius - inner.rodRadius);
      const already = this.coax[i] != null;
      const engageAt = already ? allowed - 0.5 * allowed : allowed;
      if (portal > 0 && this.closest.rho >= engageAt) {
        let c = this.coax[i];
        if (!c) {
          c = makeCoaxContact(
            i,
            this.closest.segment,
            COAX_MU_STATIC,
            COAX_MU_KINETIC,
            0,
            COAX_ALPHA_N,
            COAX_ALPHA_T,
            COAX_ALPHA_N
          );
          this.coax[i] = c;
        } else {
          c.node = i;
          c.segment = i;
          c.outerSegment = this.closest.segment;
        }
        c.allowedRadius = allowed;
        this.activeCoax.push(c);
      } else {
        this.coax[i] = null;
      }
    }
  }

  /** Reset + solve the inner-in-outer NORMAL inequality for every active coax contact. */
  private solveCoaxNormalIteration(dtSeconds: number): void {
    const inner = this.inner;
    const outer = this.outer;
    for (const c of this.activeCoax) {
      c.lambdaN = 0; // normal multiplier is per-iteration (re-evaluated inequality)
      const portal = portalWeight(this.portalFor(c), COAX_PORTAL_BLEND);
      solveCoaxialNormalContact(inner, outer, c, c.allowedRadius, portal, dtSeconds, COAX_OUTER_MASS_SCALE);
      if (this.centeringGain > 0) {
        solveCoaxialCentering(inner, outer, c, this.centeringGain, portal, dtSeconds);
      }
    }
  }

  /** Solve coax friction for every active contact (uses λ_n from this iteration). */
  private solveCoaxFrictionIteration(dtSeconds: number): void {
    for (const c of this.activeCoax) solveCoaxialFriction(this.inner, c, dtSeconds);
  }

  /**
   * Recompute the open-portal axial distance (cm) of a contact's inner node PAST the outer tip
   * (cheap, no alloc). >0 ⇒ the node has projected beyond the outer tip node along the tip
   * segment direction (exiting the portal); ≤0 ⇒ still inside the outer. Only meaningful when the
   * contact is paired to the LAST outer segment.
   */
  private portalFor(c: CoaxContact): number {
    const ox = this.outer.x;
    const tipSeg = ox.length - 2;
    if (tipSeg < 0) return 0;
    if (c.outerSegment < tipSeg) return -1;
    const a = ox[tipSeg];
    const b = ox[ox.length - 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz) || 1e-9;
    const p = this.inner.x[c.node];
    const past = ((p.x - b.x) * dx + (p.y - b.y) * dy + (p.z - b.z) * dz) / len;
    return Math.max(0, past);
  }

  /**
   * Step the coaxial pair one frame with INTERLEAVED solving (design doc §6 ordering). Both rods
   * use their legacy RodInput (deployed/steer/torque) mapped through their own insertion BC, so a
   * caller can keep driving them exactly like a solo rod. Substeps/iterations are taken from the
   * INNER rod's params (the wire is the limiting stiffness; both share the same frame dt).
   */
  step(dt: number): void {
    // No elapsed (or non-finite) time ⇒ no physics change (see CosseratRod.step): a dt ≤ 0
    // step diverges the XPBD compliance to NaN and permanently corrupts both rods.
    if (!Number.isFinite(dt) || dt <= 0) return;
    const inner = this.inner;
    const outer = this.outer;
    const S = Math.max(1, inner.params.substeps);
    const dtIn = inner.dtSeconds(dt);
    const dtOut = outer.dtSeconds(dt);
    // legacy input → per-rod feed velocity + roll target (same adapter the solo step uses)
    const feedInner = inner.feedVelocityForFramePublic(dt);
    const feedOuter = outer.feedVelocityForFramePublic(dt);
    const itersInner = inner.params.iterations;
    const itersOuter = outer.params.iterations;
    const iters = Math.max(itersInner, itersOuter);

    for (let sub = 0; sub < S; sub++) {
      // 1–4. each rod's substep prologue: inject/retract, predict, reset λ, build wall contacts
      outer.beginSubstep(feedOuter, 0, dtOut);
      inner.beginSubstep(feedInner, 0, dtIn);
      // coax pairing (after both predicted, before the interleaved solve)
      this.buildCoaxContacts();

      // 5. interleaved nonlinear Gauss-Seidel. Per iteration: each rod's elastic block, then ALL
      //    normal contacts (each rod's wall + the coax inner-in-outer), then friction. Never solve
      //    one rod fully then the other once (the one-way support artifact, top-pitfall #9).
      for (let it = 0; it < iters; it++) {
        outer.iterateElastic(dtOut);
        inner.iterateElastic(dtIn);
        // normal contacts: vessel walls for both, then inner-in-outer coax (bilateral support)
        outer.iterateWallContact(dtOut);
        inner.iterateWallContact(dtIn);
        this.solveCoaxNormalIteration(dtIn);
        // friction phase: coax sliding friction (wall friction already ran inside iterateWallContact)
        this.solveCoaxFrictionIteration(dtIn);
      }
      outer.finishSubstep();
      inner.finishSubstep();
    }
  }

  /** Number of coax contacts currently active (diagnostics/tests). */
  activeCoaxCount(): number {
    return this.activeCoax.length;
  }
  /** Sum of the stored coax normal multipliers (diagnostics/tests — the support load). */
  coaxNormalLoad(): number {
    let s = 0;
    for (const c of this.activeCoax) s += Math.max(0, c.lambdaN);
    return s;
  }
}
