import { Vector3 } from "three";

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
