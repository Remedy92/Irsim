import { Vector3 } from "three";
import type { Contact } from "./types";
import type { NodeContactTarget } from "./contact";

/**
 * Coaxial (inner-in-outer) contact + friction (design doc §6).
 *
 * A sheath/catheter ("outer") slides over a guidewire ("inner"). They are modelled as TWO
 * independent rods — centerlines are never merged. The coupling is pure contact + friction:
 *
 *   1. INNER-IN-OUTER NORMAL contact (bilateral, mass-weighted). For an inner node p_in inside
 *      outer segment k, the closest point on the outer centerline is
 *          x_o(u) = (1−u)·p_k^o + u·p_{k+1}^o
 *      with outer tangent t_o; the PERPENDICULAR offset is
 *          r_⊥ = (I − t_o t_oᵀ)(p_in − x_o(u)),   ρ = |r_⊥|,   n = r_⊥/ρ.
 *      The inner must stay inside the outer LUMEN minus its own radius:
 *          C_io = R_outer,lumen − r_inner − ρ ≥ 0
 *      with gradients ∇_{p_in} C = −n, ∇_{p_k^o} C = (1−u)·n, ∇_{p_{k+1}^o} C = u·n.
 *      Solved as a 3-BODY distribution: the inner moves inward and the outer endpoints get the
 *      equal-and-opposite support by their inverse masses. THIS is how catheter-over-wire
 *      support emerges — no hand-coded stiffness tie.
 *
 *   2. COAX FRICTION with tangent basis T = [t_o, n×t_o]. The FIRST axis (along the outer
 *      tangent) resists AXIAL sliding; the SECOND (circumferential) resists rubbing. Persistent
 *      coax anchors give stick-slip just like the wall. μ_io is LOWER than wall friction
 *      (lubricated). CRUCIALLY there is NO axial DISTANCE constraint — the inner slides freely
 *      along the outer except for this Coulomb friction (design doc top-pitfall #9).
 *
 *   3. OPEN PORTAL at the outer tip: an inner node whose closest outer point is at/over the outer
 *      tip is NOT contained against the outer lumen (it has exited into the vessel lumen). The
 *      containment ramps off over a 1–2 segment blend by axial distance past the outer tip, so
 *      the inner exits smoothly with no fake obstruction (design doc §6). The catheter tip is
 *      never capped.
 *
 *   4. Optional soft lateral CENTERING in tightly-overlapped regions (high compliance, no axial
 *      or torsional tie): C_center = (I − t_o t_oᵀ)(p_in − x_o(u)) = 0. Off by default; enabled
 *      via a small bilateral pull so a small-clearance system tracks the outer centerline.
 *
 * UNITS: centimetres; time SI (Δt_s). α̃ = α/Δt_s². Allocation-free: all temporaries are
 * module-level scratch. The solvers operate on two NodeContactTargets (inner + outer) so the
 * logic is decoupled from CosseratRod and unit-testable.
 */

const _xo = new Vector3();
const _to = new Vector3();
const _rel = new Vector3();
const _perp = new Vector3();
const _n = new Vector3();
const _t1 = new Vector3();
const _t2 = new Vector3();
const _slip = new Vector3();
const _ab = new Vector3();
const _ap = new Vector3();

/** A coaxial contact pairing one inner node to one outer segment (the closest one). */
export interface CoaxContact extends Contact {
  kind: "coax";
  /** Outer segment index k (the contact is against outer endpoints k, k+1). */
  outerSegment: number;
  /** Barycentric closest-point parameter u ∈ [0,1] along the outer segment. */
  outerU: number;
}

/**
 * Closest point of outer segment [a,b] to p, into `out`; returns the clamped parameter u∈[0,1].
 */
function closestOnSeg(p: Vector3, a: Vector3, b: Vector3, out: Vector3): number {
  _ab.subVectors(b, a);
  _ap.subVectors(p, a);
  const len2 = _ab.lengthSq() || 1e-12;
  const u = Math.max(0, Math.min(1, _ap.dot(_ab) / len2));
  out.copy(a).addScaledVector(_ab, u);
  return u;
}

/** Allocate a fresh persistent coax contact (zeroed multipliers, no anchor). */
export function makeCoaxContact(
  innerNode: number,
  outerSegment: number,
  muStatic: number,
  muKinetic: number,
  muRoll: number,
  alphaN: number,
  alphaT: number,
  alphaRoll: number
): CoaxContact {
  return {
    instrumentId: "inner",
    node: innerNode,
    segment: innerNode,
    center: new Vector3(),
    normal: new Vector3(),
    allowedRadius: 0,
    vesselTangent: new Vector3(),
    lambdaN: 0,
    lambdaT: { x: 0, y: 0 },
    lambdaRoll: 0,
    hasAnchor: false,
    anchor: new Vector3(),
    rollAnchor: 0,
    alphaN,
    alphaT,
    alphaRoll,
    muStatic,
    muKinetic,
    muRoll,
    kind: "coax",
    outerInstrumentId: "outer",
    outerSegment,
    outerU: 0
  };
}

/**
 * Find the closest OUTER segment to inner node `node`, and how far PAST the outer tip the inner
 * node sits (open-portal blend). Returns the chosen outer segment index and writes the closest
 * point, tangent, and perpendicular distance into the scratch; or −1 if the outer rod is empty.
 *
 * `segHint` (the contact's last outer segment, −1 = unknown) seeds a local search; we still scan
 * a small window around it so the pairing tracks as the inner slides along the outer.
 */
export interface CoaxClosest {
  segment: number;
  u: number;
  rho: number;
  /** axial distance of the inner node PAST the outer tip (>0 ⇒ exited; ≤0 ⇒ inside). */
  pastTip: number;
}

/**
 * Geometric pairing: closest outer segment to an inner node. Scans all outer segments (the rods
 * are short, ≤ a few hundred nodes; a windowed search is a later optimization). Fills `out` and
 * leaves the closest-point/tangent in module scratch via a fresh computation in the solver.
 */
export function closestOuterSegment(inner: Vector3, outer: NodeContactTarget, out: CoaxClosest): boolean {
  const ox = outer.x;
  const segs = ox.length - 1;
  if (segs < 1) return false;
  let bestSeg = -1;
  let bestU = 0;
  let bestPerp = Infinity;
  for (let k = 0; k < segs; k++) {
    const u = closestOnSeg(inner, ox[k], ox[k + 1], _xo);
    // perpendicular distance to the outer centerline (the containment radius coordinate)
    _to.subVectors(ox[k + 1], ox[k]);
    const tl = _to.length();
    if (tl > 1e-9) _to.multiplyScalar(1 / tl);
    _rel.subVectors(inner, _xo);
    _perp.copy(_rel).addScaledVector(_to, -_rel.dot(_to));
    const perp = _perp.length();
    if (perp < bestPerp) {
      bestPerp = perp;
      bestSeg = k;
      bestU = u;
    }
  }
  if (bestSeg < 0) return false;
  // axial distance past the outer TIP: only the last segment's far end (u→1) is the open portal.
  // pastTip > 0 means the inner node's closest point is at the very tip end AND it projects beyond.
  const tipSeg = segs - 1;
  closestOnSeg(inner, ox[tipSeg], ox[tipSeg + 1], _xo);
  _to.subVectors(ox[tipSeg + 1], ox[tipSeg]);
  const tipLen = _to.length();
  if (tipLen > 1e-9) _to.multiplyScalar(1 / tipLen);
  _rel.subVectors(inner, ox[tipSeg + 1]); // relative to the outer tip node
  const past = _rel.dot(_to); // >0 ⇒ axially beyond the tip
  out.segment = bestSeg;
  out.u = bestU;
  out.rho = bestPerp;
  out.pastTip = bestSeg === tipSeg && bestU >= 0.999 ? Math.max(0, past) : -1;
  return true;
}

/**
 * Open-portal blend weight ∈ [0,1] for an inner node at axial distance `pastTip` past the outer
 * tip, over a blend length `blend` (cm). 1 = fully contained by the outer; 0 = fully exited (the
 * inner is now governed by the VESSEL lumen, not the outer). Ramps linearly across the portal so
 * there is no step discontinuity / fake obstruction at the catheter tip.
 */
export function portalWeight(pastTip: number, blend: number): number {
  if (pastTip <= 0) return 1;
  if (pastTip >= blend) return 0;
  return 1 - pastTip / blend;
}

/**
 * Solve the inner-in-outer NORMAL inequality for one coax contact (3-body, mass-weighted).
 *
 *   C_io = R_outer,lumen − r_inner − ρ ≥ 0,  ρ = |r_⊥|,  n = r_⊥/ρ
 *   ∇_{inner} C = −n,  ∇_{outer,k} C = (1−u)·n,  ∇_{outer,k+1} C = u·n
 *   Δλ = −(C + α̃λ) / (w_in·1 + w_ok·(1−u)² + w_ok1·u² + α̃),  λ = max(0, λ+Δλ)
 *   inner += w_in·(−n)·Δλ ;  outer_k += w_ok·(1−u)·n·Δλ ;  outer_{k+1} += w_ok1·u·n·Δλ
 *
 * `allowedRadius` = R_outer,lumen − r_inner (the outer LUMEN radius is the inner clearance, not
 * the outer's own collision radius). `portal` ∈ [0,1] scales the whole constraint off as the
 * inner exits the open portal. `outerMassScale` ∈ [0,1] scales the OUTER inverse mass used for
 * the bilateral distribution: the sheath is the heavier/stiffer SUPPORT, so it takes a smaller
 * share of the correction (1 = equal masses, true symmetric distribution; <1 = the inner takes
 * most of the move, which both matches the physics and keeps the near-concentric pair stable —
 * the inner is the one being supported). It is NOT an axial tie and does not change the sliding.
 * Returns the (signed) λ_n change applied for diagnostics.
 */
export function solveCoaxialNormalContact(
  inner: NodeContactTarget,
  outer: NodeContactTarget,
  c: CoaxContact,
  allowedRadius: number,
  portal: number,
  dtSeconds: number,
  outerMassScale = 1
): void {
  const k = c.outerSegment;
  if (k < 0 || k + 1 >= outer.x.length) return;
  const pIn = inner.x[c.node];
  const a = outer.x[k];
  const b = outer.x[k + 1];
  const u = closestOnSeg(pIn, a, b, _xo);
  c.outerU = u;
  // perpendicular offset r_⊥ = (I − t t^T)(p_in − x_o)
  _to.subVectors(b, a);
  const tl = _to.length();
  if (tl > 1e-9) _to.multiplyScalar(1 / tl);
  _rel.subVectors(pIn, _xo);
  _perp.copy(_rel).addScaledVector(_to, -_rel.dot(_to));
  const rho = _perp.length();
  c.center.copy(_xo);
  c.vesselTangent.copy(_to);
  if (rho < 1e-9) {
    c.normal.copy(_to); // degenerate (on the axis) — keep a sane normal
    return;
  }
  _n.copy(_perp).multiplyScalar(1 / rho);
  c.normal.copy(_n);
  if (portal <= 0) {
    // fully exited the portal: no outer containment at all
    c.lambdaN = 0;
    return;
  }
  const Cn = (allowedRadius - rho) * portal; // scale the violation by the portal blend
  if (Cn >= 0 && c.lambdaN <= 0) return; // separated AND no stored load (true inequality)
  const wIn = inner.invMassAt(c.node);
  const wa = outer.invMassAt(k) * outerMassScale;
  const wb = outer.invMassAt(k + 1) * outerMassScale;
  const om = 1 - u;
  // gradient-mass = w_in·|−n|² + w_a·|(1−u)n|² + w_b·|u n|²  (|n|=1)
  const gradMass = wIn + wa * om * om + wb * u * u;
  if (gradMass <= 0) return;
  const aTilde = c.alphaN / (dtSeconds * dtSeconds);
  let dL = -(Cn + aTilde * c.lambdaN) / (gradMass + aTilde);
  const old = c.lambdaN;
  c.lambdaN = Math.max(0, c.lambdaN + dL);
  dL = c.lambdaN - old;
  // inner moves inward (−n), outer endpoints get the equal-and-opposite support (+n weighted)
  pIn.addScaledVector(_n, -wIn * dL);
  a.addScaledVector(_n, wa * om * dL);
  b.addScaledVector(_n, wb * u * dL);
}

/**
 * Coax Coulomb friction for one contact. Tangent basis T = [t_o, n×t_o]:
 *   - t1 = outer tangent  → resists AXIAL sliding (but only via μ_io·λ_n; NO distance tie)
 *   - t2 = n × t_o        → resists circumferential rubbing
 * Persistent coax anchor (the inner-node position at stick). Stick while |λ_t| ≤ μ_io,s·λ_n,
 * else slip to μ_io,k·λ_n and slide the anchor. The correction is applied to the INNER node
 * (the outer is the heavier support; distributing translational friction to the outer too would
 * over-couple — the inner is what we want to grip). Drops the anchor when λ_n ≤ 0.
 */
export function solveCoaxialFriction(
  inner: NodeContactTarget,
  c: CoaxContact,
  dtSeconds: number
): void {
  if (c.lambdaN <= 0) {
    c.hasAnchor = false;
    c.lambdaT.x = 0;
    c.lambdaT.y = 0;
    return;
  }
  const p = inner.x[c.node];
  const w = inner.invMassAt(c.node);
  if (w <= 0) return;
  // t1 = outer tangent projected off the normal; t2 = n × t1
  _t1.copy(c.vesselTangent);
  _t1.addScaledVector(c.normal, -_t1.dot(c.normal));
  if (_t1.lengthSq() < 1e-12) {
    _t1.set(1, 0, 0).addScaledVector(c.normal, -c.normal.x);
    if (_t1.lengthSq() < 1e-12) _t1.set(0, 1, 0).addScaledVector(c.normal, -c.normal.y);
  }
  _t1.normalize();
  _t2.crossVectors(c.normal, _t1).normalize();

  if (!c.hasAnchor) {
    c.anchor.copy(p);
    c.hasAnchor = true;
    c.lambdaT.x = 0;
    c.lambdaT.y = 0;
    return;
  }

  _slip.subVectors(p, c.anchor);
  const ctx = _slip.dot(_t1);
  const cty = _slip.dot(_t2);
  const aTilde = c.alphaT / (dtSeconds * dtSeconds);
  const dLx = -(ctx + aTilde * c.lambdaT.x) / (w + aTilde);
  const dLy = -(cty + aTilde * c.lambdaT.y) / (w + aTilde);
  const trialX = c.lambdaT.x + dLx;
  const trialY = c.lambdaT.y + dLy;
  const trialMag = Math.hypot(trialX, trialY);
  const staticLimit = c.muStatic * c.lambdaN;

  if (trialMag <= staticLimit || trialMag < 1e-12) {
    c.lambdaT.x = trialX;
    c.lambdaT.y = trialY;
    p.addScaledVector(_t1, w * dLx);
    p.addScaledVector(_t2, w * dLy);
  } else {
    const kineticMag = c.muKinetic * c.lambdaN;
    const newX = (trialX / trialMag) * kineticMag;
    const newY = (trialY / trialMag) * kineticMag;
    const sx = newX - c.lambdaT.x;
    const sy = newY - c.lambdaT.y;
    c.lambdaT.x = newX;
    c.lambdaT.y = newY;
    p.addScaledVector(_t1, w * sx);
    p.addScaledVector(_t2, w * sy);
    c.anchor.copy(p);
  }
}

/**
 * Optional SOFT lateral centering (design doc §6): C_center = (I − t_o t_oᵀ)(p_in − x_o(u)) = 0,
 * pulling the inner toward the outer centerline with HIGH compliance and NO axial/torsional tie.
 * Used in tightly-overlapped regions to firm up catheter-over-wire tracking. Bilateral (the outer
 * gets the mass-weighted opposite pull) so it does not inject net momentum. `gain` ∈ [0,1] is a
 * direct compliant fraction (small) and `portal` ramps it off at the open tip. No multiplier is
 * stored (this is a soft auxiliary spring, not a load-bearing constraint).
 */
export function solveCoaxialCentering(
  inner: NodeContactTarget,
  outer: NodeContactTarget,
  c: CoaxContact,
  gain: number,
  portal: number,
  _dtSeconds: number,
  outerMassScale = 1
): void {
  if (gain <= 0 || portal <= 0) return;
  const k = c.outerSegment;
  if (k < 0 || k + 1 >= outer.x.length) return;
  const pIn = inner.x[c.node];
  const a = outer.x[k];
  const b = outer.x[k + 1];
  const u = closestOnSeg(pIn, a, b, _xo);
  _to.subVectors(b, a);
  const tl = _to.length();
  if (tl > 1e-9) _to.multiplyScalar(1 / tl);
  // C = perpendicular offset (vector); pull the inner toward x_o along −C, share with the outer
  _rel.subVectors(pIn, _xo);
  _perp.copy(_rel).addScaledVector(_to, -_rel.dot(_to)); // perpendicular offset vector
  const wIn = inner.invMassAt(c.node);
  const wa = outer.invMassAt(k) * outerMassScale;
  const wb = outer.invMassAt(k + 1) * outerMassScale;
  const om = 1 - u;
  const wSum = wIn + wa * om * om + wb * u * u;
  if (wSum <= 0) return;
  const g = (gain * portal) / wSum;
  // inner -= w_in·g·perp ;  outer endpoints += weighted g·perp (bilateral, momentum-neutral)
  pIn.addScaledVector(_perp, -wIn * g);
  a.addScaledVector(_perp, wa * om * g);
  b.addScaledVector(_perp, wb * u * g);
}
