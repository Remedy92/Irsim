import { Quaternion, Vector3 } from "three";

/**
 * A single sampled point along a vessel centerline.
 * `radius` is the lumen radius at that point (cm). This is what the guidewire
 * physics collides against, and what the procedural mesh builder lofts a tube around.
 */
export interface CenterlinePoint {
  pos: Vector3;
  radius: number;
  /** Arc length from the start of this branch (cm). Filled in by the builder. */
  s: number;
}

/**
 * One named vessel segment of the anatomy. Branches connect by sharing the
 * world-space position of their first point with a point on the parent.
 * Centerlines are the load-bearing data structure: physics follows them, the
 * mesh is lofted from them, and named targets reference them.
 */
export interface VesselBranch {
  id: string;
  name: string;
  /** Density-weight for the fluoroscopy attenuation of this branch's wall/contrast. */
  attenuation: number;
  points: CenterlinePoint[];
}

/** A named anatomic point the trainee is asked to reach (an ostium, a bifurcation, etc.). */
export interface AnatomyTarget {
  id: string;
  name: string;
  /** World position of the target (typically a branch ostium). */
  pos: Vector3;
  /** Acceptance radius (cm): tip must sit within this of `pos` to count. */
  acceptance: number;
  /** Which branch the tip must have arrived through, to make "reached" gaming-resistant. */
  viaBranchId: string;
}

export interface AccessSite {
  id: string;
  name: string;
  /** World position where the wire/sheath enters (e.g. right common femoral artery). */
  pos: Vector3;
  /** Initial insertion direction (unit). */
  dir: Vector3;
  /** Branch the access path feeds into. */
  branchId: string;
}

export interface Anatomy {
  id: string;
  name: string;
  branches: VesselBranch[];
  targets: AnatomyTarget[];
  access: AccessSite[];
  /** License/provenance manifest — every shipped anatomy must carry one. */
  provenance: { source: string; license: string; note: string };
}

// ---------------------------------------------------------------------------
// Cosserat-XPBD domain types (appended in Stage 1; consumed by later stages).
// These describe instruments, the insertion boundary, frictional contact, and the
// implicit lumen. Geometry is in centimetres; compliances are physical (XPBD). See
// docs/physics-design-cosserat-xpbd.md and src/sim/units.ts.
// ---------------------------------------------------------------------------

export type InstrumentKind = "guidewire" | "catheter" | "sheath";

/** Orthonormal access frame: origin x, axis-in e, two perpendicular basis vectors u,v. */
export interface AccessFrame {
  x: Vector3;
  e: Vector3;
  u: Vector3;
  v: Vector3;
  /** Rotation taking the body e3 axis onto e (the access roll reference). */
  frame: Quaternion;
}

/**
 * Insertion boundary state: the proximal access is a moving material injector, NOT a
 * pinned node. Feed advances inletOffsetTarget; nodes are prepended at fixed rest length
 * `nominalSegmentLength` so no global rest-length growth (no eigenstrain / accordion).
 */
export interface InsertionState {
  /** a ∈ [0,h): distance from the access plane to the first material node (cm). */
  inletOffset: number;
  /** Advanced by v_feed·Δt_s each substep (cm). */
  inletOffsetTarget: number;
  /** Handle roll target (radians). */
  rollTarget: number;
  /** h = FIXED base segment length used for injection (NOT deployed/segments) (cm). */
  nominalSegmentLength: number;
  lambdaFeed: number;
  alphaFeedMotor: number;
  lambdaRoll: number;
  alphaRollMotor: number;
  alphaSleeve: number;
  /** Length of the access sleeve radial-constraint zone (cm). */
  sleeveLength: number;
  /**
   * Feed-force cap in PHYSICAL Newtons (operator push ~0.36–0.81 N; deliverable tip ~1.1–1.6 N). The
   * solver maps the per-substep multiplier λ_feed to a felt force F ≈ λ_feed/Δt_s² in SCALED units
   * (the mean-normalized inverse-mass metric of the absolute mass conditioning — cosserat.ts
   * D_MASS_SCALE_TRANS/TWIST — inflates λ by ~6 orders over strict SI). The
   * cap applied to λ_feed is therefore `forceMax · forceScale · Δt_s²`. forceMax = 0 ⇒ a hard stall.
   */
  forceMax: number;
  /**
   * Newtons → scaled-λ-force conversion for the feed-motor cap (so forceMax can be authored in
   * physical N). Calibrated to the direct lane's λ_feed/Δt_s² readout. 1 keeps the legacy cm-units
   * convention (the legacy lane uses a hard anchor and never reads this).
   */
  forceScale: number;
}

/** Per-frame user input for an instrument (velocity-controlled; Stage 2 maps store→here). */
export interface InstrumentInput {
  feedVelocity: number; // cm/s
  rollVelocity: number; // rad/s
  steer: number; // 0..1 tip precurve scale (back-compat with legacy RodInput)
}

/** A persistent frictional contact with anchors for static friction (Stage 3). */
export interface Contact {
  instrumentId: string;
  node: number;
  segment: number;
  center: Vector3;
  normal: Vector3;
  allowedRadius: number;
  vesselTangent: Vector3;
  lambdaN: number;
  lambdaT: { x: number; y: number };
  lambdaRoll: number;
  hasAnchor: boolean;
  anchor: Vector3;
  rollAnchor: number; // ψ0
  alphaN: number;
  alphaT: number;
  alphaRoll: number;
  muStatic: number;
  muKinetic: number;
  muRoll: number;
  kind: "wall" | "self" | "coax";
  // coax distribution metadata (kind === "coax"): outer endpoints + barycentric u
  outerInstrumentId?: string;
  outerSegment?: number;
  outerU?: number;
}

/** One variable-radius capsule edge of the implicit lumen, with graph adjacency (Stage 4). */
export interface LumenEdge {
  a: Vector3;
  b: Vector3;
  ra: number;
  rb: number;
  branchId: string;
  edgeIndex: number;
  adjacent: number[]; // graph-adjacent edges (ostia)
}

/** Result of a lumen nearest-edge query (Stage 4). */
export interface LumenQuery {
  center: Vector3;
  radius: number;
  tangent: Vector3;
  edgeIndex: number;
  arc: number;
  inside: boolean;
}
