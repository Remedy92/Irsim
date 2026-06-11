import { CatmullRomCurve3, Vector3 } from "three";
import type { Anatomy, CenterlinePoint, VesselBranch } from "./types";

/**
 * Declarative, JSON-serialisable anatomy DOCUMENT + a compiler that turns it into the runtime
 * `Anatomy` (centerline graph) the physics/lumen/fluoro consume.
 *
 * Why a document layer? The hand-coded builder in anatomy.ts was the only way to add vessels, and
 * every ostium had to be authored to coincide exactly with a parent sample or the lumen graph
 * silently failed to connect it (docs/anatomy-realism-roadmap.md §7, the "ostium weld" cliff). This
 * module makes anatomy DATA:
 *
 *   - A `BranchSpec` either is a ROOT (absolute control points) or welds onto a `parent` near a
 *     point: the compiler snaps the ostium to the nearest parent SAMPLE, so connectivity is automatic
 *     and robust even for synthetic/segmented sub-trees whose ostia are not exact control points.
 *   - Targets/access reference branches by id (resolved at compile time).
 *   - `VariantSpec` is a list of operations (reparent / add / remove / retag) applied to a base doc,
 *     so anatomical variants (bovine arch, replaced hepatic, …) are data, not bespoke code.
 *
 * The document is plain data (tuples, numbers, strings) → `JSON.stringify`/`parse` round-trips it
 * losslessly, which is the JSON "sidecar" the asset pipeline emits. UNITS: centimetres throughout;
 * body frame +y cranial, +x patient-left, +z anterior.
 */

/** One control point of a centerline: world position (cm) + lumen radius (cm). */
export interface CtrlSpec {
  p: [number, number, number];
  r: number;
}

/**
 * One vessel of the document. A ROOT branch (no `parent`) carries the full control list in
 * `controls`. A CHILD branch welds onto `parent` at the sample nearest `ostiumNear`; the compiler
 * prepends an ostium control `{ p: <welded>, r: ostiumR }` ahead of `controls`.
 */
export interface BranchSpec {
  id: string;
  name: string;
  /** Density weight for the fluoroscopy attenuation of this branch's wall/contrast. */
  attenuation: number;
  /** Centerline samples lofted along the branch (more = smoother, more lumen edges). */
  samples?: number;
  /** Parent branch id to weld the ostium onto (omit for a root branch, e.g. the aorta). */
  parent?: string;
  /** Approximate ostium position; the compiler snaps it to the nearest parent sample. */
  ostiumNear?: [number, number, number];
  /** Lumen radius at the welded ostium. */
  ostiumR?: number;
  /** Downstream control points (for a child) or the full control list (for a root). */
  controls: CtrlSpec[];
}

/** A named access site, resolved to a branch endpoint at compile time. */
export interface AccessSpec {
  id: string;
  name: string;
  onBranch: string;
  /** Which end of the branch the wire/sheath enters (default "end"). */
  at?: "start" | "end";
  /** Initial insertion direction (need not be unit; the compiler normalises). */
  dir: [number, number, number];
}

/** A named target, resolved to a branch ostium (or an absolute point) at compile time. */
export interface TargetSpec {
  id: string;
  name: string;
  /** Branch the tip must have arrived through (gaming-resistant "reached"). */
  via: string;
  /** Target sits at the ostium (points[0]) of this branch. */
  ostiumOf?: string;
  /** …or an explicit world position (used when `ostiumOf` is omitted). */
  pos?: [number, number, number];
  acceptance: number;
}

export interface AnatomyDoc {
  id: string;
  name: string;
  branches: BranchSpec[];
  access: AccessSpec[];
  targets: TargetSpec[];
  provenance: { source: string; license: string; note: string };
}

// ---------------------------------------------------------------------------
// Variants — operations applied to a base document.
// ---------------------------------------------------------------------------

export type VariantOp =
  | {
      op: "reparent";
      branch: string;
      parent: string;
      ostiumNear: [number, number, number];
      ostiumR?: number;
      /** Optional new downstream controls (e.g. re-route a replaced artery from its new origin). */
      controls?: CtrlSpec[];
    }
  | { op: "removeBranch"; branch: string }
  | { op: "addBranch"; spec: BranchSpec }
  | {
      /**
       * Replace a branch's control points in place WITHOUT changing its parentage — for pathology
       * (aneurysmal dilation, stenosis, added tortuosity) on an existing vessel, including the root
       * aorta (which `reparent` cannot touch). `ostiumNear`/`ostiumR` are honoured for a child
       * branch (re-welds the ostium); ignored for a root.
       */
      op: "reshape";
      branch: string;
      controls: CtrlSpec[];
      ostiumNear?: [number, number, number];
      ostiumR?: number;
    }
  | { op: "setAttenuation"; branch: string; value: number }
  | { op: "addTarget"; spec: TargetSpec }
  | { op: "removeTarget"; target: string };

export interface VariantSpec {
  id: string;
  name: string;
  note?: string;
  ops: VariantOp[];
}

// ---------------------------------------------------------------------------
// Centerline sampling (shared with the lumen/mesh: this is the load-bearing geometry).
// ---------------------------------------------------------------------------

/** Loft a smooth, densely-sampled centerline through control points, carrying radius + arc length. */
export function sampleCenterline(controls: CtrlSpec[], samples: number): CenterlinePoint[] {
  if (controls.length < 2) {
    throw new Error(`sampleCenterline needs ≥2 control points, got ${controls.length}`);
  }
  const curve = new CatmullRomCurve3(
    controls.map((c) => new Vector3(...c.p)),
    false,
    "centripetal"
  );
  const points: CenterlinePoint[] = [];
  let s = 0;
  let prev: Vector3 | null = null;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const pos = curve.getPoint(t);
    // Map normalized t onto the control radii (piecewise-linear).
    const f = t * (controls.length - 1);
    const lo = Math.min(controls.length - 1, Math.floor(f));
    const hi = Math.min(controls.length - 1, lo + 1);
    const radius = controls[lo].r + (controls[hi].r - controls[lo].r) * (f - lo);
    if (prev) s += pos.distanceTo(prev);
    points.push({ pos, radius, s });
    prev = pos;
  }
  return points;
}

/**
 * Nearest existing centerline point on a parent's samples to `approx` (cloned). Welds a child
 * ostium exactly onto a parent sample so the lumen graph-adjacency (exact-coincidence, tol 1e-3 in
 * lumen.ts) connects them.
 */
export function nearestPointOn(points: CenterlinePoint[], approx: Vector3): Vector3 {
  let best = points[0].pos;
  let bestD = Infinity;
  for (const cp of points) {
    const d = cp.pos.distanceToSquared(approx);
    if (d < bestD) {
      bestD = d;
      best = cp.pos;
    }
  }
  return best.clone();
}

// ---------------------------------------------------------------------------
// Validation + (de)serialisation — the loader entry points for external JSON.
// ---------------------------------------------------------------------------

/** Throw a descriptive error if `doc` is structurally invalid (unknown parents/targets/access, etc.). */
export function validateAnatomyDoc(doc: AnatomyDoc): AnatomyDoc {
  if (!doc || typeof doc !== "object") throw new Error("anatomy doc: not an object");
  if (!Array.isArray(doc.branches) || doc.branches.length === 0) {
    throw new Error("anatomy doc: needs a non-empty branches[]");
  }
  const ids = new Set<string>();
  for (const b of doc.branches) {
    if (!b.id) throw new Error("anatomy doc: a branch is missing an id");
    if (ids.has(b.id)) throw new Error(`anatomy doc: duplicate branch id "${b.id}"`);
    ids.add(b.id);
    if (b.parent) {
      if (b.ostiumNear === undefined || b.ostiumR === undefined) {
        throw new Error(`anatomy doc: child branch "${b.id}" needs ostiumNear + ostiumR`);
      }
    } else if (!b.controls || b.controls.length < 2) {
      throw new Error(`anatomy doc: root branch "${b.id}" needs ≥2 controls`);
    }
  }
  for (const b of doc.branches) {
    if (b.parent && !ids.has(b.parent)) {
      throw new Error(`anatomy doc: branch "${b.id}" references unknown parent "${b.parent}"`);
    }
  }
  for (const a of doc.access ?? []) {
    if (!ids.has(a.onBranch)) throw new Error(`anatomy doc: access "${a.id}" on unknown branch "${a.onBranch}"`);
  }
  for (const t of doc.targets ?? []) {
    if (!ids.has(t.via)) throw new Error(`anatomy doc: target "${t.id}" via unknown branch "${t.via}"`);
    if (t.ostiumOf && !ids.has(t.ostiumOf)) {
      throw new Error(`anatomy doc: target "${t.id}" ostiumOf unknown branch "${t.ostiumOf}"`);
    }
    if (!t.ostiumOf && !t.pos) throw new Error(`anatomy doc: target "${t.id}" needs ostiumOf or pos`);
  }
  return doc;
}

/** Deep-copy a document (plain JSON data — no Vector3/functions). */
export function cloneDoc(doc: AnatomyDoc): AnatomyDoc {
  return JSON.parse(JSON.stringify(doc)) as AnatomyDoc;
}

export function docToJSON(doc: AnatomyDoc): string {
  return JSON.stringify(doc, null, 2);
}

export function docFromJSON(json: string): AnatomyDoc {
  return validateAnatomyDoc(JSON.parse(json) as AnatomyDoc);
}

// ---------------------------------------------------------------------------
// Variant application.
// ---------------------------------------------------------------------------

/** Apply a variant's operations to a base document, returning a new (validated) document. */
export function applyVariant(base: AnatomyDoc, variant: VariantSpec): AnatomyDoc {
  const doc = cloneDoc(base);
  doc.id = `${base.id}+${variant.id}`;
  doc.name = `${base.name} — ${variant.name}`;
  const findBranch = (id: string) => {
    const b = doc.branches.find((x) => x.id === id);
    if (!b) throw new Error(`variant ${variant.id}: op references unknown branch "${id}"`);
    return b;
  };
  for (const op of variant.ops) {
    switch (op.op) {
      case "reparent": {
        const b = findBranch(op.branch);
        b.parent = op.parent;
        b.ostiumNear = op.ostiumNear;
        if (op.ostiumR !== undefined) b.ostiumR = op.ostiumR;
        if (op.controls) b.controls = op.controls;
        break;
      }
      case "removeBranch": {
        findBranch(op.branch);
        doc.branches = doc.branches.filter((x) => x.id !== op.branch);
        // any branch parented to the removed one is now dangling — surface it at compile time
        break;
      }
      case "addBranch": {
        if (doc.branches.some((x) => x.id === op.spec.id)) {
          throw new Error(`variant ${variant.id}: addBranch duplicate id "${op.spec.id}"`);
        }
        doc.branches.push(op.spec);
        break;
      }
      case "reshape": {
        const b = findBranch(op.branch);
        b.controls = op.controls;
        if (op.ostiumNear) b.ostiumNear = op.ostiumNear;
        if (op.ostiumR !== undefined) b.ostiumR = op.ostiumR;
        break;
      }
      case "setAttenuation": {
        findBranch(op.branch).attenuation = op.value;
        break;
      }
      case "addTarget": {
        if (doc.targets.some((x) => x.id === op.spec.id)) {
          throw new Error(`variant ${variant.id}: addTarget duplicate id "${op.spec.id}"`);
        }
        doc.targets.push(op.spec);
        break;
      }
      case "removeTarget": {
        doc.targets = doc.targets.filter((x) => x.id !== op.target);
        break;
      }
    }
  }
  return validateAnatomyDoc(doc);
}

// ---------------------------------------------------------------------------
// Compiler — document → runtime Anatomy.
// ---------------------------------------------------------------------------

/** Compile a declarative document into the runtime `Anatomy` (centerline graph) the engine consumes. */
export function compileAnatomy(input: AnatomyDoc): Anatomy {
  const doc = validateAnatomyDoc(input);
  const built = new Map<string, VesselBranch>();

  // Build in dependency order: a child can only weld onto an already-sampled parent. Repeat passes
  // until every branch is built; if a pass makes no progress there is a missing/cyclic parent.
  const pending = [...doc.branches];
  let guard = pending.length + 1;
  while (pending.length && guard-- > 0) {
    let progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const spec = pending[i];
      const parent = spec.parent ? built.get(spec.parent) : undefined;
      if (spec.parent && !parent) continue; // parent not built yet
      built.set(spec.id, buildBranch(spec, parent));
      pending.splice(i, 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  if (pending.length) {
    throw new Error(
      `compileAnatomy: could not resolve branch parents (cycle or missing): ${pending
        .map((s) => `${s.id}→${s.parent}`)
        .join(", ")}`
    );
  }

  // Preserve document order for the runtime branch array (deterministic edge indexing).
  const branches = doc.branches.map((s) => built.get(s.id)!);

  const access = doc.access.map((a) => {
    const b = built.get(a.onBranch)!;
    const node = a.at === "start" ? b.points[0] : b.points[b.points.length - 1];
    return {
      id: a.id,
      name: a.name,
      pos: node.pos.clone(),
      dir: new Vector3(...a.dir).normalize(),
      branchId: a.onBranch
    };
  });

  const targets = doc.targets.map((t) => {
    const pos = t.ostiumOf ? built.get(t.ostiumOf)!.points[0].pos.clone() : new Vector3(...t.pos!);
    return { id: t.id, name: t.name, pos, acceptance: t.acceptance, viaBranchId: t.via };
  });

  return { id: doc.id, name: doc.name, branches, targets, access, provenance: doc.provenance };
}

function buildBranch(spec: BranchSpec, parent?: VesselBranch): VesselBranch {
  let controls = spec.controls;
  if (parent) {
    const o = nearestPointOn(parent.points, new Vector3(...spec.ostiumNear!));
    controls = [{ p: [o.x, o.y, o.z], r: spec.ostiumR! }, ...spec.controls];
  }
  return {
    id: spec.id,
    name: spec.name,
    attenuation: spec.attenuation,
    points: sampleCenterline(controls, spec.samples ?? 64)
  };
}
