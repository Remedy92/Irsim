import type { Anatomy } from "./types";
import {
  compileAnatomy,
  docFromJSON,
  docToJSON,
  validateAnatomyDoc,
  type AnatomyDoc,
  type BranchSpec,
  type CtrlSpec,
  type AccessSpec,
  type TargetSpec
} from "./anatomyDoc";

/**
 * Runtime bridge for loading anatomy from an EXTERNAL source, and the converter that turns raw
 * segmentation/VMTK centerline output into the declarative `AnatomyDoc` the compiler consumes.
 *
 * Two entry points, two jobs:
 *
 *   1. `loadAnatomyFromSidecar(url)` — fetch a JSON sidecar (the lossless serialisation of an
 *      `AnatomyDoc`), validate it, and compile it to a runtime `Anatomy`. This is the seam the app
 *      will use to swap in an externally-authored / pipeline-emitted anatomy without recompiling.
 *      `fetchImpl` is injectable so this is unit-testable with a fake fetch (no browser, no network).
 *
 *   2. `anatomyDocFromCenterlines(tree)` — convert raw per-branch centerlines (the shape a
 *      TotalSegmentator → VMTK pipeline emits: dense polylines + per-point radii + a parent graph)
 *      into a validated `AnatomyDoc`. The crux is DECIMATION: VMTK centerlines carry hundreds of
 *      points per branch, far more control points than the centripetal Catmull-Rom loft needs. We
 *      reduce each branch to a compact control set while preserving the geometry the downstream
 *      lumen graph depends on — crucially the FIRST point of every child (its ostium), so the
 *      compiler's nearest-parent-sample weld still lands on the parent and `buildAdjacency`
 *      (exact-coincidence, tol 1e-3 in lumen.ts) still connects the branches.
 *
 * UNITS: centimetres throughout. Body frame +y cranial, +x patient-left, +z anterior — matching
 * `anatomyDoc.ts` and `types.ts`. This module deliberately holds NO three.js / DOM dependencies so
 * it stays pure and fast (the conversion is plain arithmetic on tuples).
 */

// ---------------------------------------------------------------------------
// Raw centerline input — the shape a VMTK / TotalSegmentator pipeline emits.
// ---------------------------------------------------------------------------

/**
 * One raw branch of a segmented centerline tree. `points`/`radii` are PARALLEL arrays (radii[i] is
 * the lumen radius at points[i]); the converter carries the radius through decimation so it is never
 * lost. A branch with no `parentId` is a root (e.g. the aorta); otherwise it welds onto `parentId`
 * at its own first point.
 */
export interface RawCenterlineBranch {
  id: string;
  name: string;
  /** Parent branch id (omit for a root). The branch's first point is its ostium onto the parent. */
  parentId?: string;
  /** Fluoroscopy attenuation weight; defaults to `DEFAULT_ATTENUATION` when absent. */
  attenuation?: number;
  /** Dense centerline positions (cm), proximal → distal. */
  points: [number, number, number][];
  /** Lumen radius (cm) at each position; parallel to `points`. */
  radii: number[];
}

/** A raw access site, passed through to the document essentially unchanged. */
export interface RawAccessSite {
  id: string;
  name: string;
  onBranch: string;
  at?: "start" | "end";
  dir: [number, number, number];
}

/** A raw target, passed through to the document essentially unchanged. */
export interface RawTarget {
  id: string;
  name: string;
  via: string;
  ostiumOf?: string;
  pos?: [number, number, number];
  acceptance: number;
}

/** The full raw tree the converter consumes. */
export interface RawCenterlineTree {
  id: string;
  name: string;
  branches: RawCenterlineBranch[];
  access?: RawAccessSite[];
  targets?: RawTarget[];
  provenance?: { source: string; license: string; note: string };
}

// ---------------------------------------------------------------------------
// Tunables (exported so callers/tests can reason about the conversion budget).
// ---------------------------------------------------------------------------

/** Default attenuation for a branch that does not specify one. */
export const DEFAULT_ATTENUATION = 0.6;

/** Target upper bound on control points per branch after decimation (endpoints always kept). */
export const MAX_CONTROLS_PER_BRANCH = 12;

/** Lower/upper clamp on the per-branch `samples` the compiler lofts (lumen-edge density). */
export const MIN_SAMPLES = 24;
export const MAX_SAMPLES = 64;

/**
 * Ramer–Douglas–Peucker base tolerance (cm). The simplifier drops any point whose perpendicular
 * deviation from the chord spanning a sub-polyline is below this. ~0.5 mm is well under the radius
 * of even the smallest modelled artery, so the simplified centerline is geometrically faithful while
 * collapsing the long near-straight runs VMTK over-samples.
 */
export const RDP_EPSILON_CM = 0.05;

// ---------------------------------------------------------------------------
// Sidecar loader.
// ---------------------------------------------------------------------------

/**
 * Fetch a JSON sidecar from `url`, validate it as an `AnatomyDoc`, and compile it to a runtime
 * `Anatomy`. Errors are thrown with the URL named so a failure is actionable from a log line alone:
 * a bad HTTP status, a JSON parse failure, and a structural-validation failure are reported
 * distinctly. `fetchImpl` defaults to the global `fetch` but is injectable for tests.
 */
export async function loadAnatomyFromSidecar(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<Anatomy> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    throw new Error(`loadAnatomyFromSidecar: network error fetching "${url}": ${describe(cause)}`, {
      cause
    });
  }

  if (!response.ok) {
    throw new Error(
      `loadAnatomyFromSidecar: HTTP ${response.status} ${response.statusText} fetching "${url}"`
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new Error(`loadAnatomyFromSidecar: failed reading body of "${url}": ${describe(cause)}`, {
      cause
    });
  }

  let doc: AnatomyDoc;
  try {
    // docFromJSON parses AND validates; separate the two failure modes for a clearer message.
    doc = docFromJSON(text);
  } catch (cause) {
    const kind = cause instanceof SyntaxError ? "invalid JSON" : "invalid anatomy document";
    throw new Error(`loadAnatomyFromSidecar: ${kind} from "${url}": ${describe(cause)}`, { cause });
  }

  try {
    return compileAnatomy(doc);
  } catch (cause) {
    throw new Error(
      `loadAnatomyFromSidecar: failed to compile anatomy from "${url}": ${describe(cause)}`,
      { cause }
    );
  }
}

/** Serialise a converted document back to a sidecar string (symmetric with `loadAnatomyFromSidecar`). */
export function anatomyDocToSidecar(doc: AnatomyDoc): string {
  return docToJSON(doc);
}

/**
 * Parse a JSON string the operator dropped in, auto-detecting the two formats the ingestion pipeline
 * can hand us, and return a validated `AnatomyDoc`:
 *   - a compiled `AnatomyDoc` SIDECAR (branches carry `controls: {p,r}[]`), or
 *   - raw VMTK-style CENTERLINES (branches carry parallel `points` + `radii`), converted on the fly.
 * This lets a user load either the pipeline's final sidecar OR its intermediate centerline export.
 */
export function parseAnatomyInput(json: string): AnatomyDoc {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (cause) {
    throw new Error(`parseAnatomyInput: invalid JSON: ${describe(cause)}`, { cause });
  }
  const branches = (obj as { branches?: unknown }).branches;
  const first = Array.isArray(branches) ? (branches[0] as Record<string, unknown> | undefined) : undefined;
  if (first && Array.isArray(first.points) && Array.isArray(first.radii)) {
    return anatomyDocFromCenterlines(obj as RawCenterlineTree);
  }
  // Fall through to AnatomyDoc validation (gives a precise structural error if it is neither shape).
  return validateAnatomyDoc(obj as AnatomyDoc);
}

// Re-export for callers that already hold a doc and want the raw serialiser.
export { docToJSON, docFromJSON };

// ---------------------------------------------------------------------------
// Centerline → AnatomyDoc conversion.
// ---------------------------------------------------------------------------

/**
 * Convert a raw centerline tree into a validated `AnatomyDoc`.
 *
 * Per-branch decimation (see `decimateBranch`) reduces dense VMTK polylines to a compact control
 * set. Root branches emit the full decimated `controls`; child branches set `parent`/`ostiumNear`/
 * `ostiumR` from their FIRST raw point so the compiler welds them onto the nearest parent sample —
 * and the ostium is NOT duplicated into `controls` (the compiler prepends the welded ostium itself).
 *
 * The result is validated before return, so an unknown `parentId` (or any other structural fault)
 * surfaces here as a thrown error rather than at compile time downstream.
 */
export function anatomyDocFromCenterlines(input: RawCenterlineTree): AnatomyDoc {
  if (!input || typeof input !== "object") {
    throw new Error("anatomyDocFromCenterlines: input is not an object");
  }
  if (!Array.isArray(input.branches) || input.branches.length === 0) {
    throw new Error("anatomyDocFromCenterlines: input needs a non-empty branches[]");
  }

  const branches: BranchSpec[] = input.branches.map((raw) => convertBranch(raw));

  const access: AccessSpec[] = (input.access ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    onBranch: a.onBranch,
    ...(a.at !== undefined ? { at: a.at } : {}),
    dir: a.dir
  }));

  const targets: TargetSpec[] = (input.targets ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    via: t.via,
    ...(t.ostiumOf !== undefined ? { ostiumOf: t.ostiumOf } : {}),
    ...(t.pos !== undefined ? { pos: t.pos } : {}),
    acceptance: t.acceptance
  }));

  const doc: AnatomyDoc = {
    id: input.id,
    name: input.name,
    branches,
    access,
    targets,
    provenance: input.provenance ?? {
      source: "Converted from segmentation/VMTK centerlines (anatomy-loader)",
      license: "unknown — set by the ingestion pipeline",
      note:
        "Converted from centerlines; generic, not patient-specific. Decimated control points; verify " +
        "license + clinical credibility before any shipped/labelled use."
    }
  };

  // Validate here so an unknown parentId etc. is an actionable error at conversion time.
  return validateAnatomyDoc(doc);
}

/** Convert one raw branch into a `BranchSpec`, decimating its centerline. */
function convertBranch(raw: RawCenterlineBranch): BranchSpec {
  if (!raw.id) throw new Error("anatomyDocFromCenterlines: a branch is missing an id");
  if (!Array.isArray(raw.points) || raw.points.length < 2) {
    throw new Error(
      `anatomyDocFromCenterlines: branch "${raw.id}" needs ≥2 centerline points, got ${
        raw.points?.length ?? 0
      }`
    );
  }
  if (!Array.isArray(raw.radii) || raw.radii.length !== raw.points.length) {
    throw new Error(
      `anatomyDocFromCenterlines: branch "${raw.id}" radii length (${
        raw.radii?.length ?? 0
      }) must equal points length (${raw.points.length})`
    );
  }

  const decimated = decimateBranch(raw.points, raw.radii);
  const attenuation = raw.attenuation ?? DEFAULT_ATTENUATION;
  // Samples scale with kept-control count to keep lumen-edge density reasonable; clamped to a band.
  const samples = clamp(decimated.length * 8, MIN_SAMPLES, MAX_SAMPLES);

  if (raw.parentId === undefined) {
    // Root branch: the full decimated control list (must be ≥2, guaranteed: endpoints are kept).
    return {
      id: raw.id,
      name: raw.name,
      attenuation,
      samples,
      controls: decimated
    };
  }

  // Child branch: first raw point is the ostium (welded onto the parent by the compiler). The
  // ostium is NOT included in `controls` — the compiler prepends the welded point. We pass the
  // DECIMATED downstream points (excluding the first/ostium); a single remaining point is valid
  // because the compiler prepends the ostium, yielding ≥2 controls for the loft.
  const [ostium, ...downstream] = decimated;
  if (downstream.length === 0) {
    throw new Error(
      `anatomyDocFromCenterlines: child branch "${raw.id}" decimated to a single point; needs ≥1 ` +
        `downstream control beyond its ostium`
    );
  }
  return {
    id: raw.id,
    name: raw.name,
    attenuation,
    samples,
    parent: raw.parentId,
    ostiumNear: ostium.p,
    ostiumR: ostium.r,
    controls: downstream
  };
}

// ---------------------------------------------------------------------------
// Decimation — Ramer–Douglas–Peucker on the polyline, carrying radius.
// ---------------------------------------------------------------------------

/**
 * Decimate a dense centerline to a compact control set, ALWAYS keeping the first and last point.
 *
 * Method: Ramer–Douglas–Peucker (RDP). RDP is curvature-adaptive by construction — it keeps points
 * where the polyline bends (large perpendicular deviation from the chord) and drops them along
 * straight runs — which is exactly the right bias for a vessel centerline, where the navigation-
 * relevant geometry is the curves and ostia, and the long straight aortic runs are pure
 * over-sampling. We then enforce a hard cap (`MAX_CONTROLS_PER_BRANCH`) by raising the tolerance and
 * re-running, so even a pathologically wiggly branch yields a compact `controls` list. Radius rides
 * along on the kept indices (RDP keeps original points, so each kept radius is an exact sample, not
 * an interpolation).
 *
 * Returns ≥2 controls (endpoints) for any input of ≥2 points.
 */
export function decimateBranch(
  points: [number, number, number][],
  radii: number[]
): CtrlSpec[] {
  const n = points.length;
  if (n <= 2) {
    return points.map((p, i) => ({ p, r: radii[i] }));
  }

  // Start at the base tolerance; if still over the cap, grow it geometrically until under cap.
  let epsilon = RDP_EPSILON_CM;
  let kept = rdpIndices(points, epsilon);
  let guard = 32;
  while (kept.length > MAX_CONTROLS_PER_BRANCH && guard-- > 0) {
    epsilon *= 1.6;
    kept = rdpIndices(points, epsilon);
  }
  // Final safety net: if RDP still can't hit the cap (degenerate geometry), enforce it by an
  // arc-length-uniform stride that keeps both endpoints.
  if (kept.length > MAX_CONTROLS_PER_BRANCH) {
    kept = strideIndices(n, MAX_CONTROLS_PER_BRANCH);
  }

  return kept.map((i) => ({ p: points[i], r: radii[i] }));
}

/**
 * Indices of the points RDP keeps for tolerance `epsilon` (always includes 0 and n-1). Iterative
 * stack-based RDP to avoid deep recursion on long polylines.
 */
function rdpIndices(points: [number, number, number][], epsilon: number): number[] {
  const n = points.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const eps2 = epsilon * epsilon;

  // Each stack frame is an inclusive index range [lo, hi] whose interior we test against the chord.
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue; // no interior points
    let maxD2 = -1;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d2 = perpDistSq(points[i], points[lo], points[hi]);
      if (d2 > maxD2) {
        maxD2 = d2;
        idx = i;
      }
    }
    if (maxD2 > eps2 && idx >= 0) {
      keep[idx] = 1;
      stack.push([lo, idx]);
      stack.push([idx, hi]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Squared perpendicular distance from point `p` to the 3D segment [a,b]. (Distance to the infinite
 * line is the standard RDP measure; for a near-degenerate chord we fall back to distance to `a`.)
 */
function perpDistSq(
  p: [number, number, number],
  a: [number, number, number],
  b: [number, number, number]
): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const ab2 = abx * abx + aby * aby + abz * abz;
  if (ab2 < 1e-12) {
    return apx * apx + apy * apy + apz * apz;
  }
  // cross(ap, ab); |cross|^2 / |ab|^2 is the squared perpendicular distance to the line.
  const cx = apy * abz - apz * aby;
  const cy = apz * abx - apx * abz;
  const cz = apx * aby - apy * abx;
  return (cx * cx + cy * cy + cz * cz) / ab2;
}

/** Evenly-strided indices over [0, n-1] of length `count`, always including both endpoints. */
function strideIndices(n: number, count: number): number[] {
  if (count >= n) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    out.push(Math.round((k * (n - 1)) / (count - 1)));
  }
  // Dedupe (rounding can collide on short polylines) while preserving order.
  return out.filter((v, i) => i === 0 || v !== out[i - 1]);
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Stringify an unknown thrown value for an error message without leaking object internals. */
function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
