import { Quaternion, Vector3 } from "three";
import type { Anatomy, AccessFrame, InsertionState } from "./types";
import {
  buildGuidewireField,
  buildSheathField,
  cloneProfile,
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
  solveInletOrientationMotor,
  solveInletPositionMotor,
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
import { BlockTridiagSolver } from "./blocktridiag";
import {
  beamNewtonRound,
  beginBeamSubstep,
  createBeamSubstepSnapshot,
  finalizeBeamSubstep,
  readBeamPerfCounters,
  resetBeamPerfCounters,
  staticSolve,
  type BeamParams,
  type BeamPerfCounters,
  type BeamState,
  type BeamSubstepSnapshot
} from "./beamfem/dynamic";
import type { ElemMat } from "./beamfem/element";
import type { LumpedMass } from "./beamfem/mass";
import { buildElemMats, buildLumpedMassForRod, nodalFramesFromSegments, segmentFramesFromNodal } from "./beamfem/integration";
import {
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
  /**
   * Exponential velocity damping factor applied to the Verlet predict (0..1). LEGACY: this is a
   * per-substep factor, so the net per-frame damping changed with the substep count (one of the
   * "substeps as a hidden knob" entanglements). Superseded by `dampingTau` when that is set.
   */
  damping: number;
  /**
   * Velocity-damping TIME CONSTANT τ (seconds). The per-substep retention is exp(−Δt_s/τ), so the
   * net per-FRAME damping is exp(−Δt/τ) — INDEPENDENT of the substep count S (design review §1.3,
   * pitfall 7: "use exponential damping with a time constant, not frame-dependent magic numbers").
   * This is what lets Small-Steps add substeps to improve convergence WITHOUT softening the rod.
   * A guidewire in blood is heavily damped, so τ is short (tens of ms). 0 ⇒ fall back to `damping`.
   */
  dampingTau: number;
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
  /**
   * PHASE 3 (docs/physics-design-dynamic-corotational-beam.md): when true, this rod's per-frame
   * elastic + bend solve is the DYNAMIC CO-ROTATIONAL BEAM (real EI, substep-invariant, dynamic
   * twist/whip) instead of the legacy XPBD Gauss-Seidel sweep + curvature-fairing. Per-rod so wire
   * and sheath can flip independently.
   */
  useDirectSolve?: boolean;
  /**
   * Experimental direct-only feed boundary: node 0 is a real beam DOF driven by the compliant,
   * force-capped inlet motor from insertion.ts. Default false until the curved-anatomy direct gates
   * pass; the current direct preset keeps the old hard-inlet adapter.
   */
  useCompliantFeedMotor?: boolean;
}

export const GUIDEWIRE: CosseratParams = {
  segments: 80,
  rodRadius: 0.05,
  referenceLength: 20,
  // ITERATIONS, not substeps, propagate and express bending along this Gauss-Seidel Cosserat
  // chain (an empirical finding: dropping to a few iterations kills precurve expression and
  // shape-holding because GS carries bend information only ~one node per iteration — Deul et al.
  // 2018). So we keep a healthy iteration count for bend propagation; the substep count is for
  // dynamics/contact, not stiffness. Time-constant damping (dampingTau) decouples the felt damping
  // from the substep count so the two knobs no longer fight.
  substeps: 2,
  iterations: 12,
  damping: 0.9, // legacy fallback (unused while dampingTau > 0)
  dampingTau: 0.08, // per-frame damping ≈ the old S=2 value (0.9²≈0.81/frame), now S-independent
  tipNodes: 6,
  transitionNodes: 12,
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
  dampingTau: 0.04, // S=4 ⇒ ≈0.9/substep, matching the original per-frame sheath damping (0.9⁴)
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
const _bodyZ = new Vector3(0, 0, 1);
const _restAxis = new Vector3();
const _advTan = new Vector3();
const _advBaseTan = new Vector3();
const _sample = new Vector3();
const _diagSample = new Vector3();
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

function frameFromTangent(tangent: Vector3, fallback: AccessFrame, out: Quaternion): Quaternion {
  const len = tangent.length();
  if (len <= 1e-9) return out.copy(fallback.frame);
  _advTan.copy(tangent).multiplyScalar(1 / len);
  return out.setFromUnitVectors(_bodyZ, _advTan);
}

function accessPathPoint(anatomy: Anatomy, site: Anatomy["access"][number], distance: number): Vector3 | null {
  const branch = anatomy.branches.find((b) => b.id === site.branchId);
  if (!branch || branch.points.length < 2) return null;

  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < branch.points.length; i++) {
    const d = branch.points[i].pos.distanceToSquared(site.pos);
    if (d < best) {
      best = d;
      idx = i;
    }
  }

  let dir = 1;
  if (idx === branch.points.length - 1) dir = -1;
  else if (idx > 0) {
    const prevDot = _segAb.subVectors(branch.points[idx - 1].pos, branch.points[idx].pos).dot(site.dir);
    const nextDot = _segAp.subVectors(branch.points[idx + 1].pos, branch.points[idx].pos).dot(site.dir);
    dir = prevDot > nextDot ? -1 : 1;
  }

  const p = site.pos.clone();
  let remaining = distance;
  let current = idx;
  while (remaining > 0) {
    const next = current + dir;
    if (next < 0 || next >= branch.points.length) {
      p.addScaledVector(site.dir, remaining);
      break;
    }
    const target = branch.points[next].pos;
    _segAb.subVectors(target, p);
    const segLen = _segAb.length();
    if (segLen <= 1e-9) {
      current = next;
      continue;
    }
    if (remaining <= segLen) {
      p.addScaledVector(_segAb, remaining / segLen);
      break;
    }
    p.copy(target);
    remaining -= segLen;
    current = next;
  }
  return p;
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

  invMassAt(node: number): number {
    if (node < 0 || node >= this.n || this.w[node] <= 0) return 0;
    if (this.params.useDirectSolve && this.directReady && this.dMass && this.dMass.m.length === this.n) {
      const m = this.dMass.m[node];
      return m > 1e-18 && Number.isFinite(m) ? this.dContactMassScale / m : 0;
    }
    return this.w[node];
  }

  invInertiaAt(node: number): number {
    if (node < 0 || node >= this.n) return 0;
    if (this.params.useDirectSolve && this.directReady && this.dMass && this.dMass.Jt.length === this.n) {
      if (this.w[node] <= 0) return 0;
      const jt = this.dMass.Jt[node];
      return jt > 1e-18 && Number.isFinite(jt) ? this.dContactInertiaScale / jt : 0;
    }
    if (this.wq.length === 0) return 0;
    const seg = Math.min(node, this.wq.length - 1);
    return this.wq[seg] ?? 0;
  }

  /** Per-segment rest length (cm). FROZEN at h on injection; never rescaled. */
  restLen: number[];
  /** Lagrangian material field, parallel to restLen[]. perSegment[0] = proximal. */
  material: MaterialField;
  /** Per-rod shaft material injected at the proximal access on feed. */
  private readonly shaftPrototype: MaterialProfile;

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

  /**
   * When this rod is the INNER member of a coaxial pair, proximal material up to this arc length is
   * inside the OUTER device's channel. That material is governed by sheath containment, not direct
   * vessel-wall contact; only the lead-out beyond the outer tip should query the vessel lumen.
   */
  vesselContactClipLength = 0;
  /** Raw lumen radius (cm) used for CFL while the rod is inside the outer channel. */
  vesselContactClipRadius = 0;

  /**
   * Uniform external BODY FORCE per node (cm-units force; applied as acceleration w·F in the
   * Verlet predict). Zero by default — the live trainer drives the rod by feed + contact only,
   * not gravity. This is a hook for future physical forcing (gravity / blood-flow / bench-test
   * loads) once real per-node mass and a calibrated dynamic/direct solve exist. With unit mass it is
   * only a pure acceleration, so the current quasi-static rod should not use it to claim realised EI.
   */
  bodyForce = new Vector3(0, 0, 0);

  /**
   * Per-node external POINT loads (cm-units force / N·cm moment) — the tip point-load hook the
   * validation benches need (validation_calibrated.test.ts header). Zero by default, so normal play
   * is unchanged. Applied as TRUE forces/moments by the DIRECT (dynamic-beam) lane via the implicit
   * residual (fext/mext), so a force-equilibrium static solve realises δ = F·L³/3EI. The legacy XPBD
   * lane is position-based and has no force-equilibrium solve, so it deliberately ignores these (a
   * force-cantilever there would be a damped-acceleration artefact, not realised EI). Set via
   * setExternalForce/setExternalMoment; consumed by relaxDirectStatic for the cantilever / torsion /
   * pure-bend / Bishop analytic gates, and a hook for Phase-D feed-force work.
   */
  private extForce: Vector3[] = [];
  private extMoment: Vector3[] = [];
  /** True iff any extForce/extMoment is nonzero (keeps the zero-load fast path overhead-free). */
  private hasExtLoad = false;

  // ----- Phase-3 dynamic co-rotational beam state (only allocated when params.useDirectSolve) -----
  /** Dynamic-beam NODAL frames (n; the beam owns these — the rod's per-segment q[] is derived). */
  private dNodeQ: Quaternion[] = [];
  /** Per-node linear + angular velocity (cm/s, rad/s) carried across substeps/frames. */
  private dVel: Vector3[] = [];
  private dOmega: Vector3[] = [];
  /** Per-element rigidities + lumped mass, rebuilt from the MaterialField each substep. */
  private dElem: ElemMat[] = [];
  private dMass: LumpedMass | null = null;
  private dRestLen = new Float64Array(0);
  /**
   * The dynamic beam's lumped mass is twist-conditioned for the implicit solve. Contact/coax
   * projections use that mass only as a relative mobility metric, normalized back near the legacy
   * unit inverse-mass scale so the staggered contact pass does not inject artificial velocity.
   */
  private dContactMassScale = 1;
  private dContactInertiaScale = 1;
  private dSolver = new BlockTridiagSolver();
  private readonly dSnapshot: BeamSubstepSnapshot = createBeamSubstepSnapshot();
  private dBeamState: BeamState | null = null;
  /**
   * Node-frame contact target for DIRECT-lane spin friction (F6). The shared solveSpinFriction
   * operates on a NodeContactTarget's q[] frame array indexed by contact.segment; on the direct
   * lane the authoritative spin DOF lives in the NODAL frames dNodeQ (the per-segment q[] is a
   * one-way derived export refreshed only at finalize, so writing roll into it would be discarded
   * — the F3 round-trip hazard). This adapter aliases dNodeQ as q[] and indexes inertia by node,
   * and the direct spin pass calls the contact with segment := node, so the roll correction lands
   * on the beam-owned dNodeQ and is carried into dOmega by finalizeBeamSubstep. No round-trip.
   */
  private dSpinTarget: NodeContactTarget | null = null;
  /** True once the dynamic-beam velocity arrays are initialized (so inject/retract keep them aligned). */
  private directReady = false;
  /** Conditioning + whip knobs for the dynamic beam (design-doc param table). */
  /**
   * The single GJ-DECOUPLED absolute mass-conditioning scale for the PHYSICAL lumped mass
   * (beamfem/mass.ts, Phase B). Physical density gives real m/Jb/Jt RATIOS but a guidewire is
   * genuinely tiny-mass, so strictly-physical M/Δt² at h=0.5, Δt_s=1/240 is ~6 orders below the
   * stiffness K — that would ill-condition Newton AND erase the felt torsional wind-up/whip the
   * trainer wants. We multiply the physical mass by this one absolute knob, chosen so the
   * wire-shaft twist term M/Δt² ≈ GJ/ℓ (steel ρ=7.9, r=0.05, h=0.5 ⇒ physical Jt/Δt² is 8.24e5×
   * smaller than the previously-validated synthetic twist conditioning). 8.0e5 reproduces that
   * validated twist regime (wire-shaft Jt/Δt²≈18 vs GJ/ℓ≈18.4, ratio ≈0.97) while now carrying
   * physical ratios across regions/instruments. Absolute mass is a free knob for a heavily damped
   * trainer; the RATIOS are physics, this absolute level is the tuned knob. NEVER re-couple it to
   * GJ — that GJ-coupling was the old (~38× bend-inertia) defect.
   */
  private static D_MASS_SCALE = 8.0e5;
  /**
   * Newtons → scaled-λ-force conversion for the DIRECT-lane compliant feed motor (insertion.forceScale).
   * The motor's felt force F ≈ λ_feed/Δt_s² is in SCALED units (D_MASS_SCALE inflates λ ~6 orders over
   * strict SI). Measured on curved anatomy, free cranial advancement of the stiff FEM column draws a
   * scaled feed force ~1.4e6 (mean) / ~2.1e6 (peak). With this scale a physical forceMax in the
   * deliverable-tip range (~1.2 N ⇒ 2.4e6 cap) clears the free-advance peak, while a low cap (~0.5 N ⇒
   * 1.0e6) sits BELOW the advance force so a blocked/jammed tip stalls and prolapses instead of
   * tunnelling. The compliant motor stays FLAG-GATED (useCompliantFeedMotor): on curved anatomy the
   * scaled feed-force readout is dominated by column compression, not a clean tip-block signal, so the
   * Phase-G flip must decide hard-anchor vs compliant against the containment gate (see report).
   */
  private static D_FEED_FORCE_SCALE = 2.0e6;
  /** Shipped direct feed cap: permissive enough for normal UI advance; low-cap stall gates override. */
  private static D_DEFAULT_FEED_FORCE_MAX = 5.0;
  private static D_TAU_OMEGA = 0.1;
  private static D_CONTACT_ROUNDS = 4;
  private static D_CONTACT_RELAX_PASSES = 2;
  private static D_RIGID_LUMEN_PASSES = 8;
  /**
   * FIXED internal substep count for the direct path — it deliberately IGNORES params.substeps so the
   * legacy "substeps as a hidden stiffness knob" entanglement is structurally eliminated: the implicit
   * dynamic solver always integrates the frame the same way regardless of the (legacy) substeps param,
   * so felt stiffness is substep-invariant by construction. (4 is needed for coax telescoping; perf
   * at 4 is over budget under the numerical-Jacobian tangent — the analytic consistent tangent is the
   * pending fix that lets this stay at 4 cheaply.)
   */
  private static D_SUBSTEPS = 4;

  /** cm/s rate cap on the legacy-deployed feed adapter (no startup shock). */
  private static FEED_RATE = 35;
  /** Lower cm/s cap for the dynamic beam: avoids injecting a stiff column faster than contact can contain. */
  private static D_FEED_RATE = 4;

  /**
   * Centerline contact margin ε_c (cm): allowed centerline radius R_eff = R_lumen − r − ε_c
   * (design doc §3, ε_c ≈ 0.05–0.20 mm = 0.005–0.02 cm). Small so the rod can still fill a
   * tight lumen, large enough to keep the surface off the wall.
   */
  private static EPS_C = 0.005;
  /**
   * Normal-contact compliance (cm-units). Small ⇒ a near-rigid wall. INSTANCE field so it CAN be
   * tuned, but it is SHARED by BOTH lanes (legacy XPBD shipped + direct beam) — the same field feeds
   * the wall-normal, self-contact, and rigid-lumen-sample projections on both. A more compliant wall
   * would, in principle, let a now-calibrated-EI stiff wire ride curve insides instead of conforming
   * to every lumen wiggle.
   *
   * PHASE E DECISION — LEFT AT 1e-9 (gated purely empirically on penetration ≤0.05 cm + no-chatter
   * for BOTH lanes, per the plan; the "9 orders over bend" framing is deliberately NOT used — only
   * the gates decide). A deterministic sweep against the exact CI containment scenarios showed the
   * response is CHAOTICALLY NON-MONOTONIC, not a smooth trend, with failure cliffs straddling any
   * candidate retune:
   *   - Legacy shipped lane (cosserat.test.ts "advancing the shipped guidewire", gate ≤0.05):
   *     1e-9 → 0.0321 cm (lowest, most headroom); 1e-8 → 0.0341; but 1.5e-8 → 0.0596 cm = GATE FAIL
   *     (reproducible 3/3). A retune to 1e-8 would sit only 1.5× below a shipped-lane penetration
   *     failure with no monotonic margin — an unjustifiable robustness regression of the shipped lane.
   *   - Direct lane (integration_live "curved anatomy envelope", final-frame ≤0.05): final pen is 0
   *     for 1e-9…4e-8 then 0.1177 cm = FAIL at 5e-8; the settling TRANSIENT (not gated) swings 0.57
   *     (1e-9) → ~0 (8e-9–2e-8) → 0.70 (3e-8) → ~0 (4e-8) → 0.67 (5e-8) — clearly chaotic.
   * No single global value robustly improves both lanes without an adjacent cliff. The direct lane's
   * large 1e-9 settling transient is best addressed by the direct-lane's own relaxation/seating logic
   * (not yet shipped — Phase G), NOT by a shared wall compliance that also governs the live legacy
   * wall. So 1e-9 stays: both lanes comfortably green with maximum headroom.
   */
  wallAlphaN = 1e-9;
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

  constructor(anatomy: Anatomy, accessId: string, params: CosseratParams = GUIDEWIRE, initialInput?: Partial<RodInput>) {
    this.params = params;
    this.h = params.referenceLength / params.segments;
    if (initialInput) this.input = { ...this.input, ...initialInput };

    const site = anatomy.access.find((a) => a.id === accessId) ?? anatomy.access[0];
    this.access = buildAccessFrame(site);
    this.insertion = defaultInsertionState(this.h);
    // Direct-lane compliant feed motor: author forceMax in PHYSICAL Newtons by calibrating the
    // N→scaled-λ-force conversion (the legacy default forceScale=1 keeps the hard-anchor lane untouched).
    if (params.useDirectSolve === true) {
      this.insertion.forceScale = CosseratRod.D_FEED_FORCE_SCALE;
      if (params.useCompliantFeedMotor === true) this.insertion.forceMax = CosseratRod.D_DEFAULT_FEED_FORCE_MAX;
    }

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
      const p = accessPathPoint(anatomy, site, i * this.h) ?? this.access.x.clone().addScaledVector(this.access.e, i * this.h);
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

    this.q = [];
    this.wq = [];
    this.restLen = [];
    for (let j = 0; j < segs; j++) {
      const q = new Quaternion();
      frameFromTangent(_segAb.subVectors(this.x[j + 1], this.x[j]), this.access, q);
      this.q.push(q);
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
    this.shaftPrototype = this.scaledProfile(shaftProfile(this.h, params.profile));

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
    // NOTE: advection follows each node's OWN tangent (the rod's curve), which is what makes curved
    // navigation correct — a moving-inlet that advances along the straight access axis kinks the rod
    // where the vessel curves at the access and destabilizes navigation (measured). So the direct
    // path keeps advection too; its straight-tube over-feed snaking is a separate, cosmetic limit.
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
    const prof = cloneProfile(this.shaftPrototype);
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
    // dynamic-beam velocities shift with the material: the new proximal node starts at rest.
    if (this.directReady) {
      this.dNodeQ.unshift(q.clone());
      this.dVel.unshift(new Vector3());
      this.dOmega.unshift(new Vector3());
    }
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
    _advBaseTan.subVectors(this.x[1], this.x[0]);
    const baseLen = _advBaseTan.length();
    if (baseLen > 1e-9) _advBaseTan.multiplyScalar(len / baseLen);
    else _advBaseTan.copy(this.access.e).multiplyScalar(len);
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
    // The old inlet node is also material: after prepend it becomes node 1. Move it into the vessel
    // now so the newly born segment starts near its rest length instead of as a zero-length impulse.
    this.x[0].add(_advBaseTan);
    this.prev[0].copy(this.x[0]);
    if (this.directReady) this.zeroDirectVelocities();
  }

  /** Direct-beam prepend used by the compliant feed motor: no whole-chain kinematic advection. */
  private prependNodeNoAdvect(p: Vector3, q: Quaternion, h: number): void {
    if (this.w.length > 0) this.w[0] = 1;
    if (this.wq.length > 0) this.wq[0] = 1;
    this.x.unshift(p.clone());
    this.prev.unshift(p.clone());
    this.w.unshift(0);
    this.q.unshift(q.clone());
    this.wq.unshift(0);
    this.restLen.unshift(h);
    this.material.perSegment.unshift(cloneProfile(this.shaftPrototype));
    this.contacts.unshift(null);
    for (const c of this.contacts) if (c) c.node += 1;
    this.currentEdge.unshift(-1);
    this.segContacts.unshift(null);
    for (const c of this.segContacts) if (c) c.segment += 1;
    if (this.directReady) {
      this.dNodeQ.unshift(q.clone());
      this.dVel.unshift(new Vector3());
      this.dOmega.unshift(new Vector3());
    }
    this.n = this.x.length;
    this.resizeLambdas();
  }

  /** Remove the proximal-most node + its segment + material (no-op below minNodes). */
  removeProximalNode(): void {
    if (this.n <= this.minNodes) return;
    this.advectBackward(this.h);
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
    if (this.directReady) {
      this.dNodeQ.shift();
      this.dVel.shift();
      this.dOmega.shift();
      this.zeroDirectVelocities();
    }
    this.n = this.x.length;
    this.resizeLambdas();
  }

  /** Direct-beam removal paired with prependNodeNoAdvect: material has already moved by the motor. */
  private removeProximalNodeNoAdvect(): void {
    if (this.n <= this.minNodes) return;
    this.x.shift();
    this.prev.shift();
    this.w.shift();
    this.q.shift();
    this.wq.shift();
    this.restLen.shift();
    this.material.perSegment.shift();
    this.contacts.shift();
    for (const c of this.contacts) if (c) c.node -= 1;
    this.currentEdge.shift();
    this.segContacts.shift();
    for (const c of this.segContacts) if (c) c.segment -= 1;
    if (this.w.length > 0) this.w[0] = 0;
    if (this.wq.length > 0) this.wq[0] = 0;
    if (this.directReady) {
      this.dNodeQ.shift();
      this.dVel.shift();
      this.dOmega.shift();
      this.zeroDirectVelocities();
    }
    this.n = this.x.length;
    this.resizeLambdas();
  }

  /**
   * Advect the chain backward by arc length `len` before a proximal node leaves the access.
   * This is the withdrawal counterpart to advectForward(): the distal tip should retreat with
   * the material instead of leaving the same curled distal node in place and then snapping the
   * new proximal boundary back to the access plane.
   */
  private advectBackward(len: number): void {
    const N = this.x.length;
    if (N < 2 || len <= 0) return;
    for (let i = N - 1; i >= 1; i--) {
      const prevNode = this.x[i - 1];
      const cur = this.x[i];
      _advTan.subVectors(cur, prevNode);
      const l = _advTan.length();
      if (l > 1e-9) _advTan.multiplyScalar(len / l);
      else _advTan.copy(this.access.e).multiplyScalar(len);
      cur.addScaledVector(_advTan, -1);
      this.prev[i].copy(cur);
    }
    if (this.directReady) this.zeroDirectVelocities();
  }

  private zeroDirectVelocities(): void {
    for (const v of this.dVel) v.set(0, 0, 0);
    for (const w of this.dOmega) w.set(0, 0, 0);
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
      if (this.isVesselContactClippedAtNode(i)) {
        this.contacts[i] = null; // inside a sheath/catheter channel: vessel wall is not visible
        continue;
      }
      const p = this.x[i];
      // graph-aware nearest-edge query with hysteresis (lumen.ts); persists the chosen edge.
      this.currentEdge[i] = this.queryLumenForWall(p, this.currentEdge[i] ?? -1, this.lq);
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
      this.wallAlphaN,
      CosseratRod.ALPHA_T,
      CosseratRod.ALPHA_ROLL
    );
  }

  private queryLumenOnEdge(p: Vector3, edgeIndex: number, out: LumenQuery): number {
    const edge = this.lumen.edges[edgeIndex];
    const u = closestOnSeg(p, edge.a, edge.b, out.center);
    out.radius = edge.ra + (edge.rb - edge.ra) * u;
    _segAb.subVectors(edge.b, edge.a);
    if (_segAb.lengthSq() < 1e-12) _segAb.set(0, 0, 1);
    out.tangent.copy(_segAb).normalize();
    out.edgeIndex = edgeIndex;
    out.arc = u;
    out.inside = p.distanceTo(out.center) - out.radius <= 0;
    return edgeIndex;
  }

  private queryLumenForWall(p: Vector3, seed: number, out: LumenQuery): number {
    const prev = seed >= 0 && seed < this.lumen.edges.length ? seed : -1;
    const chosen = this.lumen.query(p, prev, out);
    if (
      this.params.useDirectSolve &&
      prev >= 0 &&
      chosen >= 0 &&
      this.lumen.edges[prev].branchId !== this.lumen.edges[chosen].branchId &&
      !out.inside
    ) {
      return this.queryLumenOnEdge(p, prev, out);
    }
    return chosen;
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
      if (this.isVesselContactClippedAtSegment(s)) {
        this.segContacts[s] = null; // segment is still inside the outer channel
        continue;
      }
      _sample.addVectors(this.x[s], this.x[s + 1]).multiplyScalar(0.5);
      const seed = this.currentEdge[s + 1] ?? this.currentEdge[s] ?? -1;
      this.queryLumenForWall(_sample, seed, this.lq);
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
    const wa = this.invMassAt(a);
    const wb = this.invMassAt(b);
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
    const wa0 = this.invMassAt(a0);
    const wa1 = this.invMassAt(a1);
    const wb0 = this.invMassAt(b0);
    const wb1 = this.invMassAt(b1);
    const wA = 0.25 * (wa0 + wa1);
    const wB = 0.25 * (wb0 + wb1);
    const aTilde = this.wallAlphaN / (dtSeconds * dtSeconds);
    const denom = wA + wB + aTilde;
    if (denom < 1e-12) return;
    let dL = -(Cn + aTilde * sc.lambdaN) / denom;
    const old = sc.lambdaN;
    sc.lambdaN = Math.max(0, sc.lambdaN + dL);
    dL = sc.lambdaN - old;
    // push midpoint A along +n and midpoint B along −n (split to endpoints by their inv-mass)
    this.x[a0].addScaledVector(_selfN, 0.5 * wa0 * dL);
    this.x[a1].addScaledVector(_selfN, 0.5 * wa1 * dL);
    this.x[b0].addScaledVector(_selfN, -0.5 * wb0 * dL);
    this.x[b1].addScaledVector(_selfN, -0.5 * wb1 * dL);
  }

  /**
   * Lumen radius at node `i` for the CFL clamp. Uses the node's already-known current edge if
   * available (no query) and clamps the radius interpolation to that edge; otherwise queries the
   * lumen once. Returns a generous default if no lumen exists (e.g. a free-space test tube).
   */
  private localLumenRadius(i: number): number {
    if (this.isVesselContactClippedAtNode(i) && this.vesselContactClipRadius > 0) {
      return this.vesselContactClipRadius;
    }
    const e = this.currentEdge[i] ?? -1;
    if (e >= 0 && e < this.lumen.edges.length) {
      const edge = this.lumen.edges[e];
      const t = closestOnSeg(this.x[i], edge.a, edge.b, _sample);
      return edge.ra + (edge.rb - edge.ra) * t;
    }
    this.currentEdge[i] = this.queryLumenForWall(this.x[i], -1, this.lq);
    return this.lq.radius;
  }

  /**
   * Diagnostic only: maximum positive vessel-envelope violation (cm) over nodes and segment midpoints.
   * Covered guidewire material clipped into an outer sheath channel is skipped because the vessel wall is
   * intentionally not its active constraint there. Returns 0 when every sampled point is inside.
   */
  maxWallPenetration(): number {
    const q: LumenQuery = {
      center: new Vector3(),
      radius: 1,
      tangent: new Vector3(0, 0, 1),
      edgeIndex: -1,
      arc: 0,
      inside: true
    };
    let maxPen = 0;
    const sample = (p: Vector3, seed: number): void => {
      this.queryLumenForWall(p, seed, q);
      const allowed = Math.max(0.02, q.radius - this.params.rodRadius - CosseratRod.EPS_C);
      maxPen = Math.max(maxPen, p.distanceTo(q.center) - allowed);
    };
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] === 0 || this.isVesselContactClippedAtNode(i)) continue;
      sample(this.x[i], this.currentEdge[i] ?? -1);
    }
    for (let s = 0; s < this.n - 1; s++) {
      if (this.isVesselContactClippedAtSegment(s)) continue;
      _diagSample.addVectors(this.x[s], this.x[s + 1]).multiplyScalar(0.5);
      sample(_diagSample, this.currentEdge[s + 1] ?? this.currentEdge[s] ?? -1);
    }
    return Math.max(0, maxPen);
  }

  private isVesselContactClippedAtNode(i: number): boolean {
    return this.vesselContactClipLength > 0 && i * this.h < this.vesselContactClipLength;
  }

  private isVesselContactClippedAtSegment(s: number): boolean {
    return this.vesselContactClipLength > 0 && (s + 0.5) * this.h < this.vesselContactClipLength;
  }

  private isVesselFrictionMutedAtNode(i: number): boolean {
    return this.vesselContactClipLength > 0 && i * this.h < this.vesselContactClipLength + COAX_PORTAL_BLEND;
  }

  private isVesselFrictionMutedAtSegment(s: number): boolean {
    return (
      this.vesselContactClipLength > 0 &&
      (s + 0.5) * this.h < this.vesselContactClipLength + COAX_PORTAL_BLEND
    );
  }

  private muteWallFriction(c: Contact): void {
    c.hasAnchor = false;
    c.lambdaT.x = 0;
    c.lambdaT.y = 0;
    c.lambdaRoll = 0;
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
    const rate = this.params.useDirectSolve ? CosseratRod.D_FEED_RATE : CosseratRod.FEED_RATE;
    const maxStep = rate * Math.min(dt, 1 / 30);
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
    // Time-constant velocity damping: per-substep retention exp(−Δt_s/τ) ⇒ per-FRAME damping
    // exp(−Δt/τ), independent of the substep count (so Small-Steps does not change the felt
    // damping). Falls back to the legacy per-substep constant when dampingTau is 0/unset.
    const d = this.params.dampingTau > 0 ? Math.exp(-dtSeconds / this.params.dampingTau) : this.params.damping;
    const fdt2 = dtSeconds * dtSeconds; // a·Δt_s² = w·F·Δt_s² added to the Verlet displacement
    const fx = this.bodyForce.x;
    const fy = this.bodyForce.y;
    const fz = this.bodyForce.z;
    const hasForce = fx !== 0 || fy !== 0 || fz !== 0;
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] === 0) continue;
      const x = this.x[i];
      const p = this.prev[i];
      let vx = (x.x - p.x) * d;
      let vy = (x.y - p.y) * d;
      let vz = (x.z - p.z) * d;
      if (hasForce) {
        vx += this.w[i] * fx * fdt2;
        vy += this.w[i] * fy * fdt2;
        vz += this.w[i] * fz * fdt2;
      }
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

    // 3. reset elastic multipliers (XPBD: elastic λ are bilateral, reset each substep). NOTE: a
    //    frame-level warm-start was trialled (accumulate λ across substeps to hold a static load),
    //    but it does NOT cure the "too flexible" creep — that is Gauss-Seidel UNDER-CONVERGENCE of
    //    the distributed bending mode (bend propagates ~1 node/iteration down the chain; Deul 2018),
    //    which needs a better solver (Phase 3), not λ warm-starting — and warm-starting destabilised
    //    the near-concentric coax. So the per-substep reset stands.
    this.resetElasticLambdas();
    this.insertion.lambdaFeed = 0;

    // 4. build / refresh persistent frictional wall contacts (geometry + lifecycle only). Friction
    //    multipliers + anchors PERSIST across substeps/frames; only λ_n is reset per iteration.
    this.buildContacts();
  }

  /**
   * Per-frame hook for future direct/implicit solvers. Elastic multipliers are still reset per
   * substep in beginSubstep; this method intentionally does not warm-start the current XPBD pass.
   */
  beginFrame(): void {
    // Per-frame hook (currently a no-op — elastic λ are reset per substep in beginSubstep). Kept as
    // the place a future direct/implicit solver (Phase 3) would do its once-per-frame setup.
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
    for (const c of this.activeContacts) {
      if (this.isVesselFrictionMutedAtNode(c.node)) {
        this.muteWallFriction(c);
        continue;
      }
      solveTranslationalFriction(this, c, dtSeconds);
      solveSpinFriction(this, c, dtSeconds);
    }
    for (const c of this.activeSegContacts) {
      if (this.isVesselFrictionMutedAtSegment(c.segment)) {
        this.muteWallFriction(c);
        continue;
      }
      solveTranslationalFriction(this, c, dtSeconds);
    }
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

  // ============================ Phase-3 dynamic co-rotational beam path ============================

  /**
   * Lazily size + rebuild the dynamic-beam state for the current node count (called per substep).
   * Mass is now physical (density × geometry × the GJ-decoupled D_MASS_SCALE), so it no longer
   * depends on the substep Δt — the build is dt-independent.
   */
  private ensureDirect(): void {
    const n = this.n;
    const seedFrames = !this.directReady || this.dNodeQ.length !== n;
    if (!this.directReady || this.dVel.length !== n || this.dOmega.length !== n) {
      // first use, or a desync after a non-inject resize: start the beam at rest
      this.dVel = Array.from({ length: n }, () => new Vector3());
      this.dOmega = Array.from({ length: n }, () => new Vector3());
    }
    if (seedFrames) {
      // Seed only on first direct use or an unexpected resize. After that the dynamic beam owns
      // dNodeQ; q[] is just the derived segment/render view and must not overwrite twist/whip state.
      this.dNodeQ = nodalFramesFromSegments(this.q, this.dNodeQ);
    }
    this.directReady = true;
    if (this.dRestLen.length !== this.restLen.length) this.dRestLen = new Float64Array(this.restLen.length);
    for (let e = 0; e < this.restLen.length; e++) this.dRestLen[e] = this.restLen[e];
    this.dElem = buildElemMats(this.material, this.dRestLen, this.input.steer, this.dElem);
    const reuseMass = this.dMass && this.dMass.m.length === n ? this.dMass : undefined;
    this.dMass = buildLumpedMassForRod(n, this.dRestLen, this.material, CosseratRod.D_MASS_SCALE, reuseMass);
    this.updateDirectContactMetricScale();
    this.ensureExtLoadArrays();
    this.dBeamState = {
      n,
      x: this.x,
      q: this.dNodeQ,
      v: this.dVel,
      omega: this.dOmega,
      restLen: this.dRestLen,
      elem: this.dElem,
      mass: this.dMass,
      fixedPrefix: this.usesDirectCompliantFeed() ? 0 : 1,
      // zero-load fast path: only hand the beam the external arrays when something is actually applied
      fext: this.hasExtLoad ? this.extForce : undefined,
      mext: this.hasExtLoad ? this.extMoment : undefined
    };
  }

  /** Grow/trim the external-load arrays to the current node count (preserving by index). */
  private ensureExtLoadArrays(): void {
    while (this.extForce.length < this.n) this.extForce.push(new Vector3());
    while (this.extMoment.length < this.n) this.extMoment.push(new Vector3());
    if (this.extForce.length > this.n) this.extForce.length = this.n;
    if (this.extMoment.length > this.n) this.extMoment.length = this.n;
  }

  private refreshHasExtLoad(): void {
    this.hasExtLoad =
      this.extForce.some((v) => v.lengthSq() > 0) || this.extMoment.some((v) => v.lengthSq() > 0);
  }

  /**
   * Set (or clear, when `force` is null) an external point force at `node` (cm-units force).
   * Diagnostic / bench hook (cantilever realised-EI gates, future feed-force work); zero for play.
   */
  setExternalForce(node: number, force: Vector3 | null): void {
    this.ensureExtLoadArrays();
    if (node < 0 || node >= this.n) return;
    if (force) this.extForce[node].copy(force);
    else this.extForce[node].set(0, 0, 0);
    this.refreshHasExtLoad();
  }

  /** Set (or clear) an external moment at `node` (N·cm). Applied by the direct beam (mext) only. */
  setExternalMoment(node: number, moment: Vector3 | null): void {
    this.ensureExtLoadArrays();
    if (node < 0 || node >= this.n) return;
    if (moment) this.extMoment[node].copy(moment);
    else this.extMoment[node].set(0, 0, 0);
    this.refreshHasExtLoad();
  }

  /** Clear all external point loads. */
  clearExternalLoads(): void {
    for (const v of this.extForce) v.set(0, 0, 0);
    for (const v of this.extMoment) v.set(0, 0, 0);
    this.hasExtLoad = false;
  }

  /**
   * Quasi-static elastic equilibrium of the dynamic co-rotational beam under the CURRENT external
   * loads (node 0 clamped, no inertia/damping/contact/feed) — the force-equilibrium solve the live
   * realised-EI benches need. Returns the final ‖δu‖∞. Publishes the derived segment frames so the
   * public q[] (read by tests/rendering) reflects the solved shape. Direct lane only.
   */
  relaxDirectStatic(maxIters = 80): number {
    this.ensureDirect();
    const state = this.dBeamState!;
    const liveFixedPrefix = state.fixedPrefix;
    // Static bench hooks are calibrated clamped-rod solves (cantilever/torsion/pure-bend gates).
    // The shipped runtime may use the compliant inlet motor, but these diagnostics must keep the
    // proximal node fixed so they measure EI/GJ rather than inlet compliance.
    state.fixedPrefix = 1;
    const res = staticSolve(state, this.dSolver, maxIters);
    state.fixedPrefix = liveFixedPrefix;
    segmentFramesFromNodal(this.dNodeQ, this.q);
    return res;
  }

  /** Read-only dynamic-beam NODAL frame at node i (diagnostic/validation: twist/Bishop gates). */
  directNodeFrame(i: number, out = new Quaternion()): Quaternion {
    const k = Math.max(0, Math.min(this.dNodeQ.length - 1, i));
    return out.copy(this.dNodeQ[k]);
  }

  private updateDirectContactMetricScale(): void {
    if (!this.dMass || this.dMass.m.length !== this.n) {
      this.dContactMassScale = 1;
      this.dContactInertiaScale = 1;
      return;
    }
    let massSum = 0;
    let massCount = 0;
    let inertiaSum = 0;
    let inertiaCount = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] <= 0) continue;
      const m = this.dMass.m[i];
      if (m > 1e-18 && Number.isFinite(m)) {
        massSum += m;
        massCount++;
      }
      const jt = this.dMass.Jt[i];
      if (jt > 1e-18 && Number.isFinite(jt)) {
        inertiaSum += jt;
        inertiaCount++;
      }
    }
    this.dContactMassScale = massCount > 0 ? massSum / massCount : 1;
    this.dContactInertiaScale = inertiaCount > 0 ? inertiaSum / inertiaCount : 1;
  }

  private directActualInletOffset(): number {
    return _segAp.subVectors(this.x[0], this.access.x).dot(this.access.e);
  }

  private usesDirectCompliantFeed(): boolean {
    return this.params.useDirectSolve === true && this.params.useCompliantFeedMotor === true;
  }

  private directInletInvMass(): number {
    if (!this.dMass || this.dMass.m.length === 0) return 1;
    const m = this.dMass.m[0];
    return m > 1e-18 && Number.isFinite(m) ? this.dContactMassScale / m : 0;
  }

  private directInletInvInertia(): number {
    if (!this.dMass || this.dMass.Jt.length === 0) return 1;
    const jt = this.dMass.Jt[0];
    return jt > 1e-18 && Number.isFinite(jt) ? this.dContactInertiaScale / jt : 0;
  }

  private advanceDirectFeedTarget(feedVelocity: number, dts: number): void {
    this.insertion.inletOffsetTarget += feedVelocity * dts;
    this.insertion.inletOffset = Math.max(0, Math.min(this.h, this.directActualInletOffset()));
  }

  /**
   * Compliant direct inlet motor: node 0 is a real beam DOF driven by a finite-force XPBD motor.
   * This is the direct-path replacement for the hard Dirichlet anchor. Node 0 still has legacy
   * w=0 so wall/coax contacts ignore the access boundary; the beam mass is used for the motor.
   */
  private solveDirectInletMotor(dtSeconds: number): void {
    if (!this.dMass || this.dNodeQ.length === 0) return;
    solveInletPositionMotor(this.x[0], this.directInletInvMass(), this.access, this.insertion, dtSeconds);
    solveInletOrientationMotor(this.dNodeQ[0], this.directInletInvInertia(), this.access, this.insertion, dtSeconds);
  }

  private completeDirectFeedTransport(): void {
    const h = this.h;
    const commandedTransportOffset = (): number => {
      const actual = this.directActualInletOffset();
      const target = this.insertion.inletOffsetTarget;
      // The compliant inlet node can be pulled by distal/contact forces. Material transport is
      // still operator-commanded: never let a forward drag inject extra shaft, or a backward drag
      // retract more shaft, beyond the feed target accumulated from RodInput.deployed.
      if (target < 0) return target;
      return Math.max(0, Math.min(actual, target));
    };
    let actual = commandedTransportOffset();
    let guard = 0;
    while (actual >= h && guard < 10000) {
      const eps = actual - h;
      const p = _sample.copy(this.access.x).addScaledVector(this.access.e, eps);
      const q = injectedFrame(this.access, this.insertion.rollTarget, new Quaternion());
      this.prependNodeNoAdvect(p, q, h);
      if (this.n > 1) {
        this.x[1].copy(this.access.x).addScaledVector(this.access.e, eps + h);
        this.prev[1].copy(this.x[1]);
        if (this.dVel.length > 1) this.dVel[1].set(0, 0, 0);
        if (this.dOmega.length > 1) this.dOmega[1].set(0, 0, 0);
      }
      this.insertion.inletOffsetTarget -= h;
      actual = commandedTransportOffset();
      guard++;
    }
    while (actual < 0 && this.n > this.minNodes && guard < 10000) {
      this.removeProximalNodeNoAdvect();
      this.insertion.inletOffsetTarget += h;
      actual = commandedTransportOffset();
      guard++;
    }
    this.insertion.inletOffset = Math.max(0, Math.min(h, actual));
    if (this.insertion.inletOffsetTarget < 0 && this.n <= this.minNodes) this.insertion.inletOffsetTarget = 0;
  }

  /** Zero the driven inlet velocity after finalization; the motor re-applies its target next substep. */
  private settleDirectInletVelocity(): void {
    if (this.dVel.length > 0) this.dVel[0].set(0, 0, 0);
    if (this.dOmega.length > 0) this.dOmega[0].set(0, 0, 0);
  }

  /** Pin the direct inlet in the hard-motor compatibility mode. */
  private anchorInletDirect(): void {
    this.x[0].copy(this.access.x);
    this.settleDirectInletVelocity();
    injectedFrame(this.access, this.insertion.rollTarget, this.dNodeQ[0]);
    if (this.n > 1) {
      this.x[1].copy(this.access.x).addScaledVector(this.access.e, this.restLen[0] ?? this.h);
      if (this.dVel.length > 1) this.dVel[1].set(0, 0, 0);
      if (this.dOmega.length > 1) this.dOmega[1].set(0, 0, 0);
      if (this.dNodeQ.length > 1) injectedFrame(this.access, this.insertion.rollTarget, this.dNodeQ[1]);
    }
  }

  /**
   * Direct-only introducer/access-plane constraint. The deployed intravascular centerline may slide
   * and buckle distal to the access plane, but free material must not flip caudally behind the entry
   * endpoint; in the real setup the introducer/sheath constrains that half-space and material leaves
   * the simulation by retraction, not by looping outside the artery.
   */
  private projectDirectAccessPlane(): void {
    for (let i = 1; i < this.n; i++) {
      if (this.w[i] === 0) continue;
      const axial = _segAp.subVectors(this.x[i], this.access.x).dot(this.access.e);
      if (axial < 0) this.x[i].addScaledVector(this.access.e, -axial);
    }
  }

  /**
   * Direct-only rigid-lumen safety projection. The soft XPBD contact pass provides friction/load
   * estimates, but the experimental direct beam can still leave a curved rigid vessel when beam
   * stiffness, feed transport, and sparse samples fight each other. This pass enforces the current
   * modelling assumption directly: sampled centerline nodes and segment midpoints may not sit outside
   * the rigid lumen envelope. It is deliberately direct-only and remains a safety net until the full
   * Schur contact solve makes this redundant.
   */
  private projectDirectRigidLumenSamples(): void {
    const projectSample = (p: Vector3, seed: number): boolean => {
      this.queryLumenForWall(p, seed, this.lq);
      const allowed = Math.max(0.02, this.lq.radius - this.params.rodRadius - CosseratRod.EPS_C);
      _v.subVectors(p, this.lq.center);
      const rho = _v.length();
      if (rho <= allowed || rho < 1e-9) return false;
      _v.multiplyScalar((allowed - rho) / rho);
      p.add(_v);
      return true;
    };

    for (let pass = 0; pass < CosseratRod.D_RIGID_LUMEN_PASSES; pass++) {
      let changed = false;
      for (let i = 1; i < this.n; i++) {
        if (this.w[i] === 0 || this.isVesselContactClippedAtNode(i)) continue;
        if (projectSample(this.x[i], this.currentEdge[i] ?? -1)) {
          this.currentEdge[i] = this.lq.edgeIndex;
          changed = true;
        }
      }

      for (let s = 0; s < this.n - 1; s++) {
        if (this.isVesselContactClippedAtSegment(s)) continue;
        const wa = this.invMassAt(s);
        const wb = this.invMassAt(s + 1);
        const wSum = wa + wb;
        if (wSum <= 0) continue;
        _sample.addVectors(this.x[s], this.x[s + 1]).multiplyScalar(0.5);
        this.queryLumenForWall(_sample, this.currentEdge[s + 1] ?? this.currentEdge[s] ?? -1, this.lq);
        const allowed = Math.max(0.02, this.lq.radius - this.params.rodRadius - CosseratRod.EPS_C);
        _v.subVectors(_sample, this.lq.center);
        const rho = _v.length();
        if (rho <= allowed || rho < 1e-9) continue;
        _v.multiplyScalar((allowed - rho) / rho);
        this.x[s].addScaledVector(_v, (2 * wa) / wSum);
        this.x[s + 1].addScaledVector(_v, (2 * wb) / wSum);
        this.currentEdge[s] = this.lq.edgeIndex;
        this.currentEdge[s + 1] = this.lq.edgeIndex;
        changed = true;
      }
      if (!changed) break;
    }
  }

  /**
   * Project the rod out of the lumen walls for the direct path: normal inequalities + persistent
   * friction only, WITHOUT the XPBD elastic re-sweep (the beam owns elasticity, so re-running
   * solveStretchShear/solveBendTwist would fight it). This is the simple staggered projection; the
   * Schur-metric coupling (design-doc §1.8) refines it in a later phase.
   */
  private directContactProject(dtSeconds: number): void {
    this.projectDirectAccessPlane();
    if (!this.hasWallContacts()) return;
    for (const c of this.activeContacts) resetNormalLambda(c);
    for (const c of this.activeSegContacts) resetNormalLambda(c);
    for (const sc of this.activeSelfContacts) sc.lambdaN = 0;
    for (const c of this.activeContacts) solveNormalContact(this, c, dtSeconds);
    for (const c of this.activeSegContacts) this.solveSegmentWallContact(c, dtSeconds);
    for (const sc of this.activeSelfContacts) this.solveSelfContact(sc, dtSeconds);
    for (const c of this.activeContacts) solveTranslationalFriction(this, c, dtSeconds);
    for (const c of this.activeSegContacts) solveTranslationalFriction(this, c, dtSeconds);
    this.directSpinFriction(dtSeconds);
    this.projectDirectAccessPlane();
  }

  /**
   * DIRECT-lane wall spin friction (F6). The legacy XPBD wall pass runs solveSpinFriction on the
   * segment frames; the direct path previously dropped it, so torque on a covered/contacting wire
   * could spin the round rod freely at the wall instead of winding up + releasing. We run the SAME
   * stick-slip spin solver, but against the beam-owned NODAL frame dNodeQ[node] (via dSpinTarget)
   * with the node-indexed inverse inertia, so the roll correction is authoritative and survives
   * finalize (which derives dOmega from the dNodeQ change). The roll anchor c.rollAnchor is then
   * consistently measured in node-frame ψ, so wind-up/release is well-defined. Only node wall
   * contacts (which carry a frame) participate; segment-sample contacts have no own spin DOF.
   */
  private directSpinFriction(dtSeconds: number): void {
    if (this.dNodeQ.length !== this.n) return;
    let target = this.dSpinTarget;
    if (!target) {
      // q[] aliases the live dNodeQ; invInertiaAt is already node-indexed on the direct lane.
      target = this.dSpinTarget = {
        x: this.x,
        prev: this.prev,
        q: this.dNodeQ,
        w: this.w,
        wq: this.wq,
        rodRadius: this.params.rodRadius,
        invMassAt: (node: number) => this.invMassAt(node),
        invInertiaAt: (node: number) => this.invInertiaAt(node)
      };
    } else {
      // arrays may have been reallocated on inject/retract — re-point the aliases each call.
      target.x = this.x;
      target.prev = this.prev;
      target.q = this.dNodeQ;
      target.w = this.w;
      target.wq = this.wq;
    }
    for (const c of this.activeContacts) {
      if (c.node < 0 || c.node >= this.dNodeQ.length) continue;
      const savedSeg = c.segment;
      c.segment = c.node; // index the NODAL frame (dNodeQ), not the derived segment export
      solveSpinFriction(target, c, dtSeconds);
      c.segment = savedSeg;
    }
  }

  /** BeamParams for the dynamic path: a0=1/τ velocity-decay match, twist whip guard, staggered rounds. */
  private directParams(): BeamParams {
    return {
      substeps: 1,
      a0: this.params.dampingTau > 0 ? 1 / this.params.dampingTau : 12.5,
      a1: 0,
      tauOmega: CosseratRod.D_TAU_OMEGA,
      maxNewton: CosseratRod.D_CONTACT_ROUNDS
    };
  }

  /** Fixed internal substep count for the direct path (substep-invariant by construction). */
  directSubsteps(): number {
    return CosseratRod.D_SUBSTEPS;
  }

  directContactRounds(): number {
    return Math.max(1, this.directParams().maxNewton);
  }

  private limitDirectMotionFromSnapshot(): void {
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] === 0) continue;
      const snap = this.dSnapshot.x[i];
      if (!snap) continue;
      _segAp.subVectors(this.x[i], snap);
      const step2 = _segAp.lengthSq();
      const rLumen = this.localLumenRadius(i);
      const maxStep = 0.25 * Math.min(rLumen, this.h);
      if (step2 > maxStep * maxStep && step2 > 1e-18) {
        _segAp.multiplyScalar(maxStep / Math.sqrt(step2));
        this.x[i].copy(snap).add(_segAp);
      }
    }
  }

  /**
   * Direct-beam substep prologue: material transport + direct-state refresh + one immutable snapshot.
   * Coax uses this to snapshot both rods before any staggered contact projection is finalized.
   */
  beginDirectSubstep(feedVelocity: number, dts: number): void {
    if (!Number.isFinite(this.insertion.inletOffsetTarget)) this.insertion.inletOffsetTarget = 0;
    if (!Number.isFinite(this.insertion.inletOffset)) this.insertion.inletOffset = 0;
    if (!Number.isFinite(this.insertion.lambdaFeed)) this.insertion.lambdaFeed = 0;
    if (this.usesDirectCompliantFeed()) {
      this.advanceDirectFeedTarget(feedVelocity, dts);
    } else {
      injectOrRetractNodesAtAccess(this, this.access, this.insertion, feedVelocity, 0, dts);
    }
    this.ensureDirect();
    if (!this.usesDirectCompliantFeed()) this.anchorInletDirect();
    this.buildContacts();
    beginBeamSubstep(this.dBeamState!, this.dSnapshot);
  }

  directBeamNewtonRound(dts: number): number {
    const res = beamNewtonRound(this.dBeamState!, dts, this.directParams(), this.dSolver, this.dSnapshot);
    this.limitDirectMotionFromSnapshot();
    return res;
  }

  directProjectContacts(dts: number): void {
    if (this.usesDirectCompliantFeed()) this.solveDirectInletMotor(dts);
    else this.anchorInletDirect();
    for (let pass = 0; pass < CosseratRod.D_CONTACT_RELAX_PASSES; pass++) {
      this.buildContacts();
      this.directContactProject(dts);
      this.projectDirectRigidLumenSamples();
    }
    if (this.usesDirectCompliantFeed()) this.solveDirectInletMotor(dts);
    else this.anchorInletDirect();
    this.projectDirectAccessPlane();
    this.projectDirectRigidLumenSamples();
  }

  directReanchor(dts: number): void {
    if (this.usesDirectCompliantFeed()) this.solveDirectInletMotor(dts);
    else this.anchorInletDirect();
  }

  finalizeDirectSubstep(dts: number): void {
    finalizeBeamSubstep(this.dBeamState!, this.dSnapshot, dts);
    if (this.usesDirectCompliantFeed()) {
      this.settleDirectInletVelocity();
      this.completeDirectFeedTransport();
    } else {
      this.anchorInletDirect();
    }
    segmentFramesFromNodal(this.dNodeQ, this.q);
  }

  /**
   * One dynamic co-rotational beam substep: inject/retract, then a STAGGERED beam-Newton ↔ wall-
   * contact loop (the elastic tangent propagates each contact projection = containment), then publish
   * nodal frames to the rod's per-segment q[]. Public so the CoaxialAssembly coordinator can drive
   * each rod per substep and interleave the coax coupling, exactly as the solo path does here.
   */
  directSubstep(feedVelocity: number, dts: number): void {
    this.beginDirectSubstep(feedVelocity, dts);
    for (let it = 0; it < this.directContactRounds(); it++) {
      this.directBeamNewtonRound(dts);
      this.directProjectContacts(dts);
    }
    this.finalizeDirectSubstep(dts);
  }

  /** Dynamic co-rotational beam frame step (replaces the XPBD substep loop when useDirectSolve). */
  private stepDirect(dt: number): void {
    // FIXED internal substeps (ignore params.substeps) ⇒ substep-invariant by construction.
    const S = CosseratRod.D_SUBSTEPS;
    const dts = dt / S;
    const feedVelocity = this.feedVelocityForFramePublic(dt);
    this.beginFrame();
    for (let sub = 0; sub < S; sub++) this.directSubstep(feedVelocity, dts);
  }

  step(dt: number): void {
    // No elapsed (or non-finite) time ⇒ no physics change. Stepping with dt ≤ 0 would make the
    // XPBD compliance α̃ = α/Δt_s² diverge (Infinity → NaN) and corrupt the rod permanently.
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (this.params.useDirectSolve) return this.stepDirect(dt);
    const S = Math.max(1, this.params.substeps);
    const dtSeconds = this.dtSeconds(dt);
    const feedVelocity = this.feedVelocityForFramePublic(dt);
    const iters = this.params.iterations;

    this.beginFrame();
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

/**
 * DIRECT-SOLVE presets (Phase 3): the dynamic co-rotational beam at a COARSER discretization
 * (h = 0.5 cm, ~half the nodes). Phase-0 verification keeps the numerical-tangent work counted while
 * the analytic consistent tangent remains deferred. The FEM beam captures the shape with fewer elements
 * (legacy needed h = 0.25
 * only because XPBD under-converges), so realised EI is preserved. tipNodes/transitionNodes are halved
 * to keep the SAME physical tip/transition lengths, and tipCurve is doubled to keep the same rest
 * CURVATURE (rad/cm). Full h = 0.25 resolution would need the analytic consistent tangent (deferred).
 */
export const GUIDEWIRE_DIRECT: CosseratParams = {
  ...GUIDEWIRE,
  segments: 40, // h = 20/40 = 0.5 cm
  tipNodes: 3, // 3·0.5 = 1.5 cm (= 6·0.25)
  transitionNodes: 6, // 6·0.5 = 3 cm (= 12·0.25)
  tipCurve: 0.44, // doubled ⇒ same rest curvature (rad/cm) as the h=0.25 preset
  useDirectSolve: true,
  useCompliantFeedMotor: true
};
/** Direct-solve sheath/catheter at the matching coarser discretization. */
export const SHEATH_DIRECT: CosseratParams = { ...SHEATH, segments: 40, useDirectSolve: true };
/** Single source of truth for the currently shipped live app presets. */
export const SHIPPED_GUIDEWIRE = GUIDEWIRE_DIRECT;
export const SHIPPED_SHEATH = SHEATH_DIRECT;

// =============================================================================================
// STAGE 5 — COAXIAL SHEATH OVER WIRE (design doc §6)
// =============================================================================================

/**
 * Coax normal-containment compliance (cm-units). The shipped app treats the catheter lumen as a
 * stiff cylindrical support for the covered wire: the wire may slide axially with friction, but its
 * centerline should not leave the catheter's inner radius before the open portal.
 */
const COAX_ALPHA_N = 1e-8;
const COAX_DIRECT_ALPHA_N = 1e-4;
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
const COAX_DIRECT_MU_STATIC = 0.004;
const COAX_DIRECT_MU_KINETIC = 0.002;
/**
 * Open-portal blend length (cm): an inner node ramps off the outer containment over this axial
 * distance past the outer tip, so the inner exits the catheter tip smoothly (no fake obstruction).
 * ~1.5 segment lengths.
 */
const COAX_PORTAL_BLEND = 0.4;
/**
 * Vessel-wall ownership must not resume before sheath support has meaningfully faded on the direct
 * beam, where material/geometric lag can otherwise create false vessel contacts. The legacy XPBD path
 * keeps the older catheter-tip handoff because broader scalar clipping over-stresses its covered shaft.
 */
const COAX_DIRECT_VESSEL_CLIP_BLEND = COAX_PORTAL_BLEND;
/**
 * Covered wire nodes pair to the catheter lumen near their material coordinate, not to the
 * globally nearest segment. The local window allows axial sliding inside a curved catheter while
 * preventing a protruded/free wire from being tethered to a distant proximal bend.
 */
const COAX_ARC_PAIR_WINDOW_CM = 1.0;
/**
 * How much of the radial coax-normal correction the OUTER sheath absorbs on the LEGACY (XPBD) lane.
 * The legacy lane still uses flat unit inverse-mass (no calibrated per-node masses), so a two-way
 * share there lets the wire shove the catheter sideways instead of staying inside its cylinder. Keep
 * the shipped (legacy) path one-way radially: the sheath is the support surface, the wire is corrected
 * inside it. Axial motion is still untied and only resisted by instrument-instrument friction. The
 * bilateral mechanism (Phase D) is enabled on the DIRECT lane, where real Phase-B masses make it safe;
 * the legacy lane keeps 0 until the Phase-G flip retires it.
 */
const COAX_OUTER_MASS_SCALE = 0;
/**
 * Direct path (Phase D — two-way coax): a SMALL, mass-weighted nonzero so the sheath feels the
 * wire's reaction (Newton's third law) without the lighter wire shoving the heavier/stiffer support
 * cylinder out of the lumen. The 3-body distribution in coax.ts is mass-weighted by invMassAt(), and
 * with real per-node masses (Phase B) the sheath only takes `scale`·(its inverse-mass share) of each
 * radial correction. A coax-stability sweep on curved anatomy under a hard wire push (steer 0.6,
 * torque 0.8) shows monotonic, stable sheath displacement up to ~0.5 cm through scale≈0.03, then a
 * sharp instability cliff under medium load (the near-concentric ~0.04 cm clearance + sustained
 * lateral load is exactly why this was 0). We ship 0.01: the sheath gains a real reaction (its node
 * displacement under load grows ~0.21→0.34 cm vs the one-way baseline) while staying deep inside the
 * lumen (wall penetration stays ~0, ≪ the 0.05 cm gate) with comfortable headroom below the cliff.
 * Free axial telescoping is untouched (the coax coupling has no axial tie — verified ratio≈0). The
 * remaining headroom to a full symmetric (scale=1) flip is documented; it needs the unified Schur
 * contact solve to absorb the accumulated lateral load without the explicit per-round drift.
 */
const COAX_DIRECT_OUTER_MASS_SCALE = 0.01;
/**
 * Gentle sheath-channel centering for the overlapped guidewire. Vessel contact is disabled for
 * covered material, so this low-gain pull makes the wire travel inside the sheath lumen and leave
 * through the sheath portal instead of keeping an independent vessel path. It is deliberately weak:
 * hard containment still comes from the sheath inner-wall normal constraint.
 */
const COAX_CENTERING_GAIN = 0.02;
const COAX_DIRECT_CENTERING_GAIN = 0.02;
const COAX_DIRECT_RIGID_CHANNEL_PASSES = 4;

/**
 * Coaxial assembly: an OUTER device (sheath/catheter) sliding over an INNER device (guidewire).
 * Each is its own free CosseratRod with its own MaterialProfile, access, insertion BC, and wall
 * contact — they are NOT merged (design doc §6). The coupling is purely contact + friction:
 *
 *   - inner-in-outer NORMAL containment — the catheter is currently the radial support cylinder
 *     in both shipped XPBD and experimental direct paths until unified Schur contact lands;
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
  private readonly coaxAlphaN: number;
  private readonly coaxMuStatic: number;
  private readonly coaxMuKinetic: number;
  private readonly centeringOuterMassScale: number;

  /**
   * Soft lateral centering gain ∈ [0,1] for material inside the outer channel. This is not an axial
   * tie: it only damps radial play inside the sheath and is ramped off at the open portal.
   */
  centeringGain = COAX_CENTERING_GAIN;

  /**
   * Outer (sheath) inverse-mass share in the radial coax-normal distribution ∈ [0,1]. The legacy lane
   * keeps 0 (support cylinder); the DIRECT lane uses a small mass-weighted nonzero (Phase D two-way
   * coax) so the sheath feels the wire's reaction without being shoved out of the lumen. Public so
   * experiments and the coax-stability gate can sweep it.
   */
  outerMassScale = COAX_OUTER_MASS_SCALE;

  constructor(outer: CosseratRod, inner: CosseratRod) {
    this.outer = outer;
    this.inner = inner;
    const directCoax = outer.params.useDirectSolve && inner.params.useDirectSolve;
    this.coaxAlphaN = directCoax ? COAX_DIRECT_ALPHA_N : COAX_ALPHA_N;
    this.coaxMuStatic = directCoax ? COAX_DIRECT_MU_STATIC : COAX_MU_STATIC;
    this.coaxMuKinetic = directCoax ? COAX_DIRECT_MU_KINETIC : COAX_MU_KINETIC;
    this.outerMassScale =
      directCoax ? COAX_DIRECT_OUTER_MASS_SCALE : COAX_OUTER_MASS_SCALE;
    this.centeringGain = directCoax ? COAX_DIRECT_CENTERING_GAIN : COAX_CENTERING_GAIN;
    this.centeringOuterMassScale = directCoax ? 0 : 1;
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
   * Locate the sheath/catheter lumen near MATERIAL arc length, not by global nearest segment.
   * A covered guidewire node at arc length s must live inside the local catheter cylinder around
   * s; in a curved vessel, global nearest pairing can attach it to the wrong bend and let the wire
   * appear to come from beside the catheter instead of from inside its lumen.
   */
  private closestOuterAtArc(innerPoint: Vector3, arc: number, out: CoaxClosest): boolean {
    const outer = this.outer;
    const segs = outer.restLen.length;
    if (segs < 1 || outer.x.length < 2) return false;

    const deployed = outer.deployedLength();
    const clampedArc = Math.max(0, Math.min(arc, deployed));
    let s = 0;
    let k = 0;
    while (k < segs - 1 && s + outer.restLen[k] < clampedArc) {
      s += outer.restLen[k];
      k++;
    }

    const windowSegs = Math.max(1, Math.ceil(COAX_ARC_PAIR_WINDOW_CM / outer.h));
    const lo = Math.max(0, k - windowSegs);
    const hi = Math.min(segs - 1, k + windowSegs);
    let bestSeg = -1;
    let bestU = 0;
    let bestRho = Infinity;
    for (let j = lo; j <= hi; j++) {
      const a = outer.x[j];
      const b = outer.x[j + 1];
      const u = closestOnSeg(innerPoint, a, b, _diagSample);
      _segAb.subVectors(b, a);
      const len = _segAb.length();
      if (len <= 1e-9) continue;
      _segAb.multiplyScalar(1 / len);
      _segAp.subVectors(innerPoint, _diagSample);
      _segAp.addScaledVector(_segAb, -_segAp.dot(_segAb));
      const rho = _segAp.length();
      if (rho < bestRho) {
        bestRho = rho;
        bestSeg = j;
        bestU = u;
      }
    }
    if (bestSeg < 0) return false;
    out.segment = bestSeg;
    out.u = bestU;
    out.rho = bestRho;
    out.pastTip = Math.max(0, arc - deployed);
    return true;
  }

  /**
   * Build / refresh the persistent coax contacts for this substep. For each FREE inner node whose
   * material coordinate is still covered by the outer catheter, pair it to the local OUTER lumen
   * near the same material arc length. Nodes beyond the outer tip enter the open-portal blend and
   * then fully become vessel-guided wire. Reuses Contact objects so the coax friction anchors
   * persist. Populates this.activeCoax. Geometry + lifecycle only — projection happens in
   * solveCoaxNormalIteration / solveCoaxFrictionIteration.
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
      const arc = i * inner.h;
      const axialPastTip = arc - outer.deployedLength();
      if (axialPastTip >= COAX_PORTAL_BLEND) {
        this.coax[i] = null;
        continue;
      }
      const paired = this.closestOuterAtArc(inner.x[i], arc, this.closest);
      if (!paired) {
        this.coax[i] = null;
        continue;
      }
      // open portal: fully past the outer tip ⇒ no outer containment (governed by vessel lumen)
      const portal = portalWeight(Math.max(0, axialPastTip), COAX_PORTAL_BLEND);
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
      const needsWallSupport = this.closest.rho >= engageAt;
      const needsLumenCentering = this.centeringGain > 0;
      if (portal > 0 && (needsWallSupport || needsLumenCentering)) {
        let c = this.coax[i];
        if (!c) {
          c = makeCoaxContact(
            i,
            this.closest.segment,
            this.coaxMuStatic,
            this.coaxMuKinetic,
            0,
            this.coaxAlphaN,
            COAX_ALPHA_T,
            this.coaxAlphaN
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
      solveCoaxialNormalContact(inner, outer, c, c.allowedRadius, portal, dtSeconds, this.outerMassScale);
      if (this.centeringGain > 0) {
        solveCoaxialCentering(inner, outer, c, this.centeringGain, portal, dtSeconds, this.centeringOuterMassScale);
      }
    }
  }

  /**
   * Direct-only hard channel safety net: covered guidewire material cannot live outside the
   * sheath/catheter lumen. The soft direct coax normal/centering constraints provide load and slide
   * feel, while this projection enforces the rigid-channel geometry for well-covered nodes. The
   * open-portal blend is left soft so the wire can exit the sheath tip without a fake lip.
   */
  private projectDirectCoveredInnerIntoOuterChannel(): void {
    if (!(this.inner.params.useDirectSolve && this.outer.params.useDirectSolve)) return;
    for (let pass = 0; pass < COAX_DIRECT_RIGID_CHANNEL_PASSES; pass++) {
      let changed = false;
      for (const c of this.activeCoax) {
        if (this.portalFor(c) > 0) continue;
        const k = c.outerSegment;
        if (k < 0 || k + 1 >= this.outer.x.length) continue;
        const pIn = this.inner.x[c.node];
        const a = this.outer.x[k];
        const b = this.outer.x[k + 1];
        closestOnSeg(pIn, a, b, _diagSample);
        _segAb.subVectors(b, a);
        const len = _segAb.length();
        if (len <= 1e-9) continue;
        _segAb.multiplyScalar(1 / len);
        _segAp.subVectors(pIn, _diagSample);
        _segAp.addScaledVector(_segAb, -_segAp.dot(_segAb));
        const rho = _segAp.length();
        if (rho <= c.allowedRadius || rho < 1e-9) continue;
        _segAp.multiplyScalar((c.allowedRadius - rho) / rho);
        pIn.add(_segAp);
        changed = true;
      }
      if (!changed) break;
    }
  }

  /** Solve coax friction for every active contact (uses λ_n from this iteration). */
  private solveCoaxFrictionIteration(dtSeconds: number): void {
    for (const c of this.activeCoax) solveCoaxialFriction(this.inner, c, dtSeconds);
  }

  /**
   * Recompute the open-portal axial distance (cm) of a contact's inner node PAST the outer tip in
   * material coordinates. This matches buildCoaxContacts' arc-length gate and avoids treating a
   * remote exited node as "inside" just because it is geometrically closest to a proximal sheath
   * segment in a curved vessel.
   */
  private portalFor(c: CoaxContact): number {
    return Math.max(0, c.node * this.inner.h - this.outer.deployedLength());
  }

  private outerTipTangent(out: Vector3): Vector3 {
    if (this.outer.n < 2) return out.copy(this.outer.access.e);
    out.subVectors(this.outer.x[this.outer.n - 1], this.outer.x[this.outer.n - 2]);
    if (out.lengthSq() <= 1e-12) return out.copy(this.outer.access.e);
    return out.normalize();
  }

  /**
   * Step the coaxial pair one frame with INTERLEAVED solving (design doc §6 ordering). Both rods
   * use their legacy RodInput (deployed/steer/torque) mapped through their own insertion BC, so a
   * caller can keep driving them exactly like a solo rod. Substeps/iterations are taken from the
   * INNER rod's params (the wire is the limiting stiffness; both share the same frame dt).
   */
  /**
   * Coaxial frame step with the DYNAMIC CO-ROTATIONAL BEAM for both rods (Phase 3). Because the beam
   * step now owns one snapshot per rod, the coordinator can interleave Newton rounds and project wall
   * + coax constraints before either rod finalizes velocity. This fixes the old "late coax projection"
   * ordering where inner↔outer corrections happened after each rod had already published dVel/dOmega.
   */
  private stepDirectCoax(dt: number): void {
    const inner = this.inner;
    const outer = this.outer;
    const COAX_ROUNDS = 4;
    const S = outer.directSubsteps(); // fixed internal substeps (= inner's); substep-invariant
    const dts = dt / S;
    const feedInner = inner.feedVelocityForFramePublic(dt);
    const feedOuter = outer.feedVelocityForFramePublic(dt);
    outer.beginFrame();
    inner.beginFrame();
    for (let sub = 0; sub < S; sub++) {
      // covered inner material is inside the sheath channel until the open portal at the outer tip
      outer.beginDirectSubstep(feedOuter, dts);
      const portalClip = outer.deployedLength() + COAX_DIRECT_VESSEL_CLIP_BLEND;
      inner.vesselContactClipLength = portalClip;
      inner.vesselContactClipRadius = outer.coaxLumenRadius;
      inner.beginDirectSubstep(feedInner, dts);

      this.buildCoaxContacts();
      const rounds = Math.max(outer.directContactRounds(), inner.directContactRounds(), COAX_ROUNDS);
      for (let r = 0; r < rounds; r++) {
        outer.directBeamNewtonRound(dts);
        inner.directBeamNewtonRound(dts);
        outer.directProjectContacts(dts);
        inner.directProjectContacts(dts);
        this.buildCoaxContacts();
        this.solveCoaxNormalIteration(dts);
        this.projectDirectCoveredInnerIntoOuterChannel();
        this.solveCoaxFrictionIteration(dts);
        outer.directReanchor(dts);
        inner.directReanchor(dts);
      }
      outer.finalizeDirectSubstep(dts);
      inner.finalizeDirectSubstep(dts);
      // Compliant feed can insert/retract proximal material during finalization. Re-seat the
      // covered inner nodes against the current sheath channel before the frame is observable.
      this.buildCoaxContacts();
      this.projectDirectCoveredInnerIntoOuterChannel();
    }
  }

  step(dt: number): void {
    // No elapsed (or non-finite) time ⇒ no physics change (see CosseratRod.step): a dt ≤ 0
    // step diverges the XPBD compliance to NaN and permanently corrupts both rods.
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Phase-3: when both rods use the dynamic beam, take the coax direct path.
    if (this.inner.params.useDirectSolve && this.outer.params.useDirectSolve) return this.stepDirectCoax(dt);
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

    outer.beginFrame();
    inner.beginFrame();
    for (let sub = 0; sub < S; sub++) {
      // 1–4. each rod's substep prologue: inject/retract, predict, reset λ, build wall contacts
      outer.beginSubstep(feedOuter, 0, dtOut);
      // Covered inner material is physically inside the sheath/catheter channel. It should not build
      // vessel-wall contacts or choose vessel branches until it reaches the open portal at the outer
      // tip; before that, coax containment owns its path.
      inner.vesselContactClipLength = outer.deployedLength();
      inner.vesselContactClipRadius = outer.coaxLumenRadius;
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

  /** Radial clearance available to the inner wire centerline inside the outer catheter lumen. */
  innerClearance(): number {
    return Math.max(0, this.outer.coaxLumenRadius - this.inner.rodRadius);
  }

  /** Positive distance means the inner wire tip protrudes beyond the open catheter tip. */
  innerExitPastOuterTip(): number {
    return _diagSample.subVectors(this.inner.tip(), this.outer.tip()).dot(this.outerTipTangent(_segAb));
  }

  /** Max radial offset of still-covered inner wire nodes from the same-arc catheter lumen centerline. */
  maxCoveredInnerRho(): number {
    let max = 0;
    const coveredArc = this.outer.deployedLength() - 0.5;
    for (let i = 1; i < this.inner.n - 1; i++) {
      const arc = i * this.inner.h;
      if (arc >= coveredArc) continue;
      if (this.closestOuterAtArc(this.inner.x[i], arc, this.closest)) {
        max = Math.max(max, this.closest.rho);
      }
    }
    return max;
  }

  /** Sum of the stored coax normal multipliers (diagnostics/tests — the support load). */
  coaxNormalLoad(): number {
    let s = 0;
    for (const c of this.activeCoax) s += Math.max(0, c.lambdaN);
    return s;
  }

  /**
   * Phase F performance surface. The deterministic FEM work-counts (tangentAssemblies /
   * elementForceEvals) are the HARD, CI-stable budget gate (asserted in
   * beamfem/integration_live.test.ts); per-frame wall-clock ms is timed in Viewport.tsx and the
   * headless recorder (beamfem/perf_ms_recorder.test.ts) but is REPORTED, never asserted (it flakes
   * on shared runners). COMMITTED SHIPPED RESOLUTION: h=0.5 / ~40 nodes with this numerical-Jacobian
   * tangent (the cost lever is the tangent, not node count). The analytic Crisfield/Battini
   * consistent tangent + h=0.25 is the DEFERRED perf upgrade — not on this phase's path.
   */
  resetDirectPerfCounters(): void {
    resetBeamPerfCounters();
  }

  directPerfCounters(): BeamPerfCounters {
    return readBeamPerfCounters();
  }
}
