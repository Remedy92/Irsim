import { Quaternion, Vector3 } from "three";
import type { Contact } from "./types";

/**
 * In-loop XPBD frictional contact (design doc §3).
 *
 * This is the Stage-3 replacement for the post-solve lumen projection antipattern. Contact
 * is solved INSIDE the Gauss-Seidel loop so it produces a real normal multiplier λ_n, which
 * is the physical normal load that the Coulomb friction cone needs. Three constraints:
 *
 *   1. NORMAL inequality  C_n = R_eff − ρ ≥ 0,  λ_n = max(0, λ_n + Δλ_n)
 *      — pushes a node back inside the lumen; the multiplier is the wall reaction force est.
 *   2. TRANSLATIONAL stick-slip with a PERSISTENT wall anchor. Stick while
 *      |λ_t| ≤ μ_s·λ_n (the Coulomb cone in multiplier space); on exceed, slip to
 *      −μ_k·λ_n·v̂_t and slide the anchor. This is what lets proximal feed load the rod
 *      between temporary anchors (and the tip) instead of the whole centerline skating.
 *   3. SPIN friction  C_ψ = r_rod·wrap(ψ − ψ0), stick/slip vs μ_roll·λ_n. THIS is the
 *      difference between "hub roll instantly rotates the tip" and "torque winds up, sticks,
 *      then releases" — pure roll of a round rod is not resisted by translational friction.
 *
 * UNITS: centimetres; time SI (Δt_s). α̃ = α/Δt_s². Forces are cm-unit (F ≈ λ/Δt_s²), only
 * used as RATIOS for the cone (see units.ts forceScale). Allocation-free: all temporaries
 * are module-level scratch.
 *
 * The solvers operate on a minimal NodeContactTarget interface (positions + inverse mass +
 * per-segment frames + inverse inertia) so the contact logic is decoupled from the concrete
 * rod and unit-testable. The owning rod builds Contact records each substep, persists their
 * friction multipliers + anchors across frames, and resets only the NORMAL multiplier per
 * iteration (friction λ/anchors persist — that is the static-friction state).
 */

const _rho = new Vector3();
const _t1 = new Vector3();
const _t2 = new Vector3();
const _slip = new Vector3();
const _qRel = new Quaternion();
const _refX = new Vector3();
const _wallY = new Vector3();
const _wallX = new Vector3();

/** Minimal rod surface the contact solvers need (implemented by CosseratRod). */
export interface NodeContactTarget {
  x: Vector3[];
  prev: Vector3[];
  q: Quaternion[];
  w: number[];
  wq: number[];
  rodRadius: number;
  invMassAt(node: number): number;
  invInertiaAt(node: number): number;
}

/** Wrap an angle to (−π, π]. */
function wrapAngle(a: number): number {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

/**
 * Build (or refresh) a wall Contact for node `node` against its nearest lumen point.
 * `center` is the closest centerline point, `allowedRadius = R_lumen − r_inst − ε_c`,
 * `tangent` the vessel tangent at that point. Reuses an existing Contact object so the
 * friction multipliers + anchor persist across frames (do NOT new one up per frame).
 */
export function refreshWallContact(
  c: Contact,
  center: Vector3,
  tangent: Vector3,
  allowedRadius: number
): void {
  c.center.copy(center);
  c.vesselTangent.copy(tangent).normalize();
  c.allowedRadius = allowedRadius;
}

/**
 * Make a fresh persistent wall contact with zeroed multipliers + no anchor. Called once when
 * a node first comes into contact range; thereafter refreshWallContact updates geometry only.
 */
export function makeWallContact(
  instrumentId: string,
  node: number,
  segment: number,
  muStatic: number,
  muKinetic: number,
  muRoll: number,
  alphaN: number,
  alphaT: number,
  alphaRoll: number
): Contact {
  return {
    instrumentId,
    node,
    segment,
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
    kind: "wall"
  };
}

/**
 * XPBD NORMAL inequality contact for one node. C_n = R_eff − ρ ≥ 0, ∇C_n = −n. Pushes the
 * node back to the allowed radius and accumulates λ_n ≥ 0 (the wall reaction estimate).
 * Resets λ_n to 0 at the start of each iteration via resetNormalLambda() — only the normal
 * multiplier is per-iteration; friction λ/anchors persist (static-friction state).
 */
export function solveNormalContact(rod: NodeContactTarget, c: Contact, dtSeconds: number): void {
  const p = rod.x[c.node];
  _rho.subVectors(p, c.center);
  const rho = _rho.length();
  if (rho < 1e-9) {
    c.normal.copy(c.vesselTangent); // degenerate; keep a sane normal
    return;
  }
  c.normal.copy(_rho).multiplyScalar(1 / rho);
  const Cn = c.allowedRadius - rho; // ≥ 0 required (inside the lumen)
  // Early-out: separated AND no stored normal load ⇒ nothing to do (true inequality).
  if (Cn >= 0 && c.lambdaN <= 0) return;
  const w = rod.invMassAt(c.node);
  if (w <= 0) return;
  const aTilde = c.alphaN / (dtSeconds * dtSeconds);
  // ∇C_n = −n ⇒ |∇C_n|² = 1; gradient-mass = w.
  let dL = -(Cn + aTilde * c.lambdaN) / (w + aTilde);
  const old = c.lambdaN;
  c.lambdaN = Math.max(0, c.lambdaN + dL);
  dL = c.lambdaN - old;
  // x += w·∇C·Δλ = w·(−n)·Δλ ⇒ positive Δλ_n moves the node inward (−n points inward).
  p.addScaledVector(c.normal, -w * dL);
}

/** Reset only the NORMAL multiplier (called per iteration; friction λ/anchors persist). */
export function resetNormalLambda(c: Contact): void {
  c.lambdaN = 0;
}

/**
 * Translational Coulomb stick-slip with a PERSISTENT wall anchor (design doc §3). Uses the
 * normal multiplier λ_n from this iteration as the normal load. Stick while the trial
 * tangential multiplier is inside the static cone |λ_t| ≤ μ_s·λ_n; otherwise slip to the
 * kinetic cone and slide the anchor to the current wall point. Drops the anchor only when
 * the node separates (λ_n ≤ 0). 2D tangent basis T = [t1, t2], t1 = vessel tangent,
 * t2 = n × t1.
 */
export function solveTranslationalFriction(rod: NodeContactTarget, c: Contact, dtSeconds: number): void {
  if (c.lambdaN <= 0) {
    // separated: release the anchor + tangential load (no static friction off-wall)
    c.hasAnchor = false;
    c.lambdaT.x = 0;
    c.lambdaT.y = 0;
    return;
  }
  const p = rod.x[c.node];
  const w = rod.invMassAt(c.node);
  if (w <= 0) return;

  // tangent-plane basis: t1 = vessel tangent (projected off the current normal), t2 = n×t1
  _t1.copy(c.vesselTangent);
  _t1.addScaledVector(c.normal, -_t1.dot(c.normal)); // project off normal
  if (_t1.lengthSq() < 1e-12) {
    // tangent parallel to normal (rare) — pick any perpendicular
    _t1.set(1, 0, 0).addScaledVector(c.normal, -c.normal.x);
    if (_t1.lengthSq() < 1e-12) _t1.set(0, 1, 0).addScaledVector(c.normal, -c.normal.y);
  }
  _t1.normalize();
  _t2.crossVectors(c.normal, _t1).normalize();

  if (!c.hasAnchor) {
    // first contact: drop the anchor at the current node position, zero the tangential load
    c.anchor.copy(p);
    c.hasAnchor = true;
    c.lambdaT.x = 0;
    c.lambdaT.y = 0;
    return;
  }

  // C_t = Tᵀ(p − anchor) — tangential drift from the anchor
  _slip.subVectors(p, c.anchor);
  const ctx = _slip.dot(_t1);
  const cty = _slip.dot(_t2);
  const aTilde = c.alphaT / (dtSeconds * dtSeconds);
  // diagonal block: |∇C|² = 1 per tangent axis ⇒ Δλ = −(C + α̃λ)/(w + α̃)
  const dLx = -(ctx + aTilde * c.lambdaT.x) / (w + aTilde);
  const dLy = -(cty + aTilde * c.lambdaT.y) / (w + aTilde);
  const trialX = c.lambdaT.x + dLx;
  const trialY = c.lambdaT.y + dLy;
  const trialMag = Math.hypot(trialX, trialY);
  const staticLimit = c.muStatic * c.lambdaN;

  if (trialMag <= staticLimit || trialMag < 1e-12) {
    // STICK: accept the trial multiplier, hold the anchor, apply the correction
    c.lambdaT.x = trialX;
    c.lambdaT.y = trialY;
    p.addScaledVector(_t1, w * dLx);
    p.addScaledVector(_t2, w * dLy);
  } else {
    // SLIP: clamp to the kinetic cone along the slip direction, slide the anchor
    const kineticMag = c.muKinetic * c.lambdaN;
    const newX = (trialX / trialMag) * kineticMag;
    const newY = (trialY / trialMag) * kineticMag;
    const sx = newX - c.lambdaT.x;
    const sy = newY - c.lambdaT.y;
    c.lambdaT.x = newX;
    c.lambdaT.y = newY;
    p.addScaledVector(_t1, w * sx);
    p.addScaledVector(_t2, w * sy);
    // move the anchor to the current wall point (kinetic sliding resets the stick origin)
    c.anchor.copy(p);
  }
}

const _dir = new Vector3();

/**
 * Director (body-z axis) of a frame — the rod's local tangent / spin axis. */
function directorOf(q: Quaternion, out: Vector3): Vector3 {
  return out.set(
    2 * (q.x * q.z + q.w * q.y),
    2 * (q.y * q.z - q.w * q.x),
    q.w * q.w - q.x * q.x - q.y * q.y + q.z * q.z
  );
}

/**
 * Roll angle of a per-segment frame about its OWN director (the rod axis = the spin DOF),
 * measured against a wall-fixed circumferential reference. Returns ψ ∈ (−π, π].
 *
 * The spin DOF is rotation about the frame director d (body-z). The reference plane is the
 * cross-section plane ⊥ d, spanned by:
 *   ŵ1 = P_⊥d(normal)  (the contact normal projected into the cross-section — a wall-fixed
 *        circumferential mark; the normal is ~radial so this is stable), ŵ2 = d × ŵ1.
 * The material mark is the frame's body-x director; ψ = atan2(bodyX·ŵ2, bodyX·ŵ1). Rolling
 * the rod about d sweeps body-x around (ŵ1, ŵ2), so ψ tracks the roll cleanly and is
 * INVARIANT to the tangent/director not being exactly aligned (we use the true director).
 */
function rollAngleAgainstWall(q: Quaternion, normal: Vector3, _tangent: Vector3): number {
  directorOf(q, _dir).normalize();
  // wall-fixed reference in the cross-section plane: normal projected ⊥ director
  _wallX.copy(normal).addScaledVector(_dir, -normal.dot(_dir));
  if (_wallX.lengthSq() < 1e-12) {
    // normal parallel to the director (degenerate) — pick any perpendicular
    _wallX.set(1, 0, 0).addScaledVector(_dir, -_dir.x);
    if (_wallX.lengthSq() < 1e-12) _wallX.set(0, 1, 0).addScaledVector(_dir, -_dir.y);
  }
  _wallX.normalize();
  _wallY.crossVectors(_dir, _wallX).normalize();
  // body-x director of the frame (a material mark fixed to the rod cross-section)
  _refX.set(
    q.w * q.w + q.x * q.x - q.y * q.y - q.z * q.z,
    2 * (q.x * q.y + q.w * q.z),
    2 * (q.x * q.z - q.w * q.y)
  );
  const cx = _refX.dot(_wallX);
  const cy = _refX.dot(_wallY);
  return Math.atan2(cy, cx);
}

/** Apply a small roll correction `dPsi` (radians) to a frame about ITS OWN director axis. */
function applyRollCorrection(q: Quaternion, _normal: Vector3, dPsi: number): void {
  directorOf(q, _dir).normalize();
  // q := exp(½ dPsi · d) · q   (rotate about the rod axis = the spin DOF)
  const half = 0.5 * dPsi;
  const s = Math.sin(half);
  _qRel.set(_dir.x * s, _dir.y * s, _dir.z * s, Math.cos(half));
  q.premultiply(_qRel).normalize();
}

/**
 * SPIN friction (design doc §3). Resists pure rotation of the round rod about its tangent at
 * a wall contact, with the same stick-slip + persistent anchor logic as translational
 * friction but on the roll DOF. C_ψ = r_rod·wrap(ψ − ψ0); stick while |λ_roll| ≤ μ_roll·λ_n,
 * else slip and reset ψ0. The surface-slip length r_rod·Δψ couples roll to the same cm-unit
 * force scale as the translational constraint, so the cone is consistent.
 *
 * THIS constraint is what makes torque WIND UP (tip lags the hub) then RELEASE (sudden tip
 * rotation when the cone breaks) rather than the tip tracking the hub instantly.
 */
export function solveSpinFriction(rod: NodeContactTarget, c: Contact, dtSeconds: number): void {
  if (c.lambdaN <= 0) {
    c.lambdaRoll = 0;
    return;
  }
  const seg = c.segment;
  if (seg < 0 || seg >= rod.q.length) return;
  const q = rod.q[seg];
  const wq = rod.invInertiaAt(seg);
  if (wq <= 0) return;
  const r = rod.rodRadius;
  const psi = rollAngleAgainstWall(q, c.normal, c.vesselTangent);

  if (!c.hasAnchor) {
    // share the translational anchor lifecycle: if not yet anchored, set the roll anchor now
    c.rollAnchor = psi;
    c.lambdaRoll = 0;
    return;
  }

  const C = r * wrapAngle(psi - c.rollAnchor); // surface-slip length (cm)
  const aTilde = c.alphaRoll / (dtSeconds * dtSeconds);
  // gradient of C wrt the roll DOF is r ⇒ |∇C|² = r²; gradient-mass = wq·r²
  const denom = wq * r * r + aTilde;
  if (denom < 1e-12) return;
  let dL = -(C + aTilde * c.lambdaRoll) / denom;
  const trial = c.lambdaRoll + dL;
  const limit = c.muRoll * c.lambdaN;

  if (Math.abs(trial) <= limit) {
    // STICK: hold the roll anchor; the correction Δψ = wq·(∂C/∂ψ)·Δλ = wq·r·Δλ drives ψ→ψ0
    // (Δλ < 0 for C > 0, so the frame is rotated back toward the anchor — it is HELD, not free)
    c.lambdaRoll = trial;
    applyRollCorrection(q, c.normal, wq * r * dL);
  } else {
    // SLIP: clamp to the kinetic roll cone, then slide the roll anchor to the current angle
    const lnew = Math.sign(trial) * limit;
    dL = lnew - c.lambdaRoll;
    c.lambdaRoll = lnew;
    applyRollCorrection(q, c.normal, wq * r * dL);
    c.rollAnchor = psi;
  }
}
