import { Quaternion, Vector3 } from "three";
import type { AccessFrame, AccessSite, InsertionState } from "./types";
import { solveXPBDVectorDiagonal } from "./xpbd";

/**
 * Insertion boundary condition — the proximal access as a MOVING MATERIAL INJECTOR.
 *
 * This is the core fix for the accordioning/buckling-on-feed failure (design doc §2).
 * The old scheme pinned the base node and grew every segment's rest length on feed,
 * which applies an artificial EIGENSTRAIN to the whole deployed rod (it is born
 * compressed). Instead:
 *
 *   - Per-segment rest length is FROZEN at the nominal base length h. It never changes
 *     for existing material.
 *   - Feed advances an inlet offset a ∈ [0,h). When a ≥ h a NEW node is injected at the
 *     access plane (carrying shaft material + rest curvature), a -= h. When a < 0 the
 *     proximal node is removed. Existing rest lengths / material / curvature are never
 *     resampled — the floppy tip never smears into the shaft.
 *   - The proximal node is driven by a COMPLIANT velocity-controlled inlet position motor
 *     (with a force cap) + an orientation (roll) motor, plus an access-sleeve radial
 *     constraint on the nodes still inside the collar. There is NO hard material pin.
 *
 * UNITS: centimetres. Time is SI (Δt_s seconds); α̃ = α/Δt_s² is formed in the solve.
 * Allocation-free: all Vector3/Quaternion temporaries are module-level scratch.
 */

const _rel = new Vector3();
const _e3 = new Vector3(0, 0, 1);
const _dlam = { x: 0, y: 0, z: 0 };
const _perp = new Vector3();
const _qInv = new Quaternion();
const _qErr = new Quaternion();

/**
 * Build an orthonormal access frame (u, v, e) from an access site. `e` points into the
 * vessel (the insertion direction); u, v span the access plane. `frame` rotates the body
 * e3 axis onto e and is the roll reference for injected node orientations.
 */
export function buildAccessFrame(site: AccessSite): AccessFrame {
  const e = site.dir.clone().normalize();
  // pick a stable perpendicular: cross with whichever world axis is least parallel to e
  const ref = Math.abs(e.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const u = new Vector3().crossVectors(ref, e).normalize();
  const v = new Vector3().crossVectors(e, u).normalize();
  const frame = new Quaternion().setFromUnitVectors(_e3, e);
  return { x: site.pos.clone(), e, u, v, frame };
}

/** Quaternion for an injected node: access frame rolled about its axis by `roll`. */
export function injectedFrame(access: AccessFrame, roll: number, out: Quaternion): Quaternion {
  // R_roll(e, roll) · R_A   — roll about the insertion axis e, applied to the access frame
  _qErr.setFromAxisAngle(access.e, roll);
  return out.multiplyQuaternions(_qErr, access.frame);
}

/**
 * A minimal interface the injector needs from the rod. The concrete rod (cosserat.ts /
 * instrument.ts) implements these; this keeps insertion logic decoupled from the rod
 * internals and unit-testable on its own.
 */
export interface Injectable {
  /** Particle count = restLen.length + 1. */
  readonly n: number;
  /** Minimum particle count to keep when retracting. */
  readonly minNodes: number;
  /** Prepend a new proximal node at world position p with frame q; sets restLen[0] = h. */
  prependNode(p: Vector3, q: Quaternion, h: number): void;
  /** Remove the proximal-most node (and its segment/material). No-op below minNodes. */
  removeProximalNode(): void;
}

/**
 * Advance the feed/roll targets and inject or retract material nodes at the access plane.
 * `dtSeconds` is the substep Δt_s. Mutates `ins.inletOffsetTarget` and `ins.rollTarget`
 * and the rod's node list. Returns the signed number of nodes injected (+) / removed (-).
 *
 *   a_target += v_feed·Δt_s ;  θ_hub += v_roll·Δt_s
 *   while a_target ≥ h: prepend node at x_A + (a_target − h)·e_A ; restLen[0]=h ; a_target -= h
 *   while a_target < 0 and n > minNodes: removeProximalNode ; a_target += h
 */
export function injectOrRetractNodesAtAccess(
  rod: Injectable,
  access: AccessFrame,
  ins: InsertionState,
  feedVelocity: number,
  rollVelocity: number,
  dtSeconds: number
): number {
  const h = ins.nominalSegmentLength;
  ins.inletOffsetTarget += feedVelocity * dtSeconds;
  ins.rollTarget += rollVelocity * dtSeconds;

  let injected = 0;
  let guard = 0;
  // The proximal boundary node sits at the access plane x_A (axial 0). The inlet offset
  // accumulates feed; once a full base length h has entered, a NEW boundary node is born at
  // x_A and the previous boundary node (now node 1) is left coincident with it. Its segment
  // rest length is h, so the stretch constraint advances the chain forward by h on the next
  // solve — the rod ADVANCES without any rest-length growth (no eigenstrain / accordion).
  while (ins.inletOffsetTarget >= h && guard < 10000) {
    const p = access.x.clone(); // new boundary node at the access plane
    const q = injectedFrame(access, ins.rollTarget, new Quaternion());
    rod.prependNode(p, q, h);
    ins.inletOffsetTarget -= h;
    injected++;
    guard++;
  }
  while (ins.inletOffsetTarget < 0 && rod.n > rod.minNodes && guard < 10000) {
    rod.removeProximalNode();
    ins.inletOffsetTarget += h;
    injected--;
    guard++;
  }
  ins.inletOffset = ins.inletOffsetTarget;
  return injected;
}

/**
 * Compliant inlet POSITION motor on the proximal node (XPBD vector block).
 *
 *   C_inlet = [ u·(p0 − x_A) ; v·(p0 − x_A) ; e·(p0 − x_A) − a_target ] = 0
 *
 * Drives p0 to the commanded inlet offset along e while pinning it to the access axis in
 * the perpendicular plane — but COMPLIANTLY (α_feedMotor), not as a hard Dirichlet pin.
 * The multiplier λ_feed gives a feed-force estimate F ≈ λ_feed/Δt_s²; the axial component
 * is clamped to the force cap so the motor can never inject infinite force (it stalls and
 * lets the shaft compress/buckle instead of tunnelling).
 *
 * `p0` is mutated in place; `ins.lambdaFeed` accumulates the axial multiplier (force est).
 * `w0` is the proximal node inverse mass (>0 — the node is FREE, driven only by this motor).
 */
export function solveInletPositionMotor(
  p0: Vector3,
  w0: number,
  access: AccessFrame,
  ins: InsertionState,
  dtSeconds: number
): void {
  if (w0 <= 0) return;
  _rel.subVectors(p0, access.x);
  const cu = _rel.dot(access.u);
  const cv = _rel.dot(access.v);
  const ce = _rel.dot(access.e) - ins.inletOffsetTarget;

  // diagonal block: |∇C|² = 1 per axis (orthonormal frame), gradient-mass = w0
  solveXPBDVectorDiagonal(cu, cv, ce, 0, 0, ins.lambdaFeed, w0, ins.alphaFeedMotor, dtSeconds, _dlam);

  // force cap on the AXIAL feed multiplier: |λ_feed_axial| ≤ F_max·Δt_s²
  const lamAxialTrial = ins.lambdaFeed + _dlam.z;
  const cap = ins.forceMax * dtSeconds * dtSeconds;
  let dz = _dlam.z;
  if (Math.abs(lamAxialTrial) > cap) {
    const clamped = Math.sign(lamAxialTrial) * cap;
    dz = clamped - ins.lambdaFeed;
    ins.lambdaFeed = clamped;
  } else {
    ins.lambdaFeed = lamAxialTrial;
  }

  // apply corrections along the orthonormal access basis (x += w·∇C·Δλ; ∇C = +axis here)
  p0.addScaledVector(access.u, w0 * _dlam.x);
  p0.addScaledVector(access.v, w0 * _dlam.y);
  p0.addScaledVector(access.e, w0 * dz);
}

/**
 * Inlet ORIENTATION (roll) motor on the proximal segment frame.
 *   C_roll = Im(q_target⁻¹ · q0)   (small-angle ≈ ½·axis·angle)
 * Solved as a scalar XPBD per imaginary axis, applied as a quaternion nudge toward
 * q_target = injectedFrame(access, rollTarget). Compliant (α_rollMotor) so torque winds
 * up rather than snapping the whole shaft instantly.
 */
export function solveInletOrientationMotor(
  q0: Quaternion,
  wq0: number,
  access: AccessFrame,
  ins: InsertionState,
  dtSeconds: number
): void {
  if (wq0 <= 0) return;
  injectedFrame(access, ins.rollTarget, _qErr); // q_target into scratch
  _qInv.copy(q0).conjugate();
  // err = q0⁻¹ · q_target  (rotation taking q0 to the target)
  const ex = _qInv.w * _qErr.x + _qInv.x * _qErr.w + _qInv.y * _qErr.z - _qInv.z * _qErr.y;
  const ey = _qInv.w * _qErr.y - _qInv.x * _qErr.z + _qInv.y * _qErr.w + _qInv.z * _qErr.x;
  const ez = _qInv.w * _qErr.z + _qInv.x * _qErr.y - _qInv.y * _qErr.x + _qInv.z * _qErr.w;
  const ew = _qInv.w * _qErr.w - _qInv.x * _qErr.x - _qInv.y * _qErr.y - _qInv.z * _qErr.z;
  // closest-quaternion sign so we rotate the short way
  const sgn = ew < 0 ? -1 : 1;
  const aTilde = ins.alphaRollMotor / (dtSeconds * dtSeconds);
  const gain = wq0 / (wq0 + aTilde);
  // Apply a compliant fraction `gain` of the rotation error as a true small rotation:
  //   q0 := q0 · exp(½ gain·err_imag)   (renormalized)
  const hx = 0.5 * gain * sgn * ex;
  const hy = 0.5 * gain * sgn * ey;
  const hz = 0.5 * gain * sgn * ez;
  _qErr.set(hx, hy, hz, 1).normalize();
  q0.multiply(_qErr).normalize();
}

/**
 * Access-sleeve radial constraint: nodes whose axial coordinate lies inside the sleeve
 * zone [−L_sleeve, 0] (proximal of the access plane) are constrained to the access axis
 * radially (C_⊥ = P_⊥(p_i − x_A) = 0), but slide freely axially. Compliant (α_sleeve).
 *
 * In the active-injection model used here the deployed shaft is distal of the plane, so
 * this mainly keeps the just-injected proximal node from flaring sideways. Returns true if
 * the node was inside the sleeve zone and corrected.
 */
export function solveAccessSleeveRadial(
  p: Vector3,
  w: number,
  access: AccessFrame,
  ins: InsertionState,
  dtSeconds: number
): boolean {
  if (w <= 0) return false;
  _rel.subVectors(p, access.x);
  const axial = _rel.dot(access.e);
  if (axial > 0 || axial < -ins.sleeveLength) return false; // outside the collar zone
  const cu = _rel.dot(access.u);
  const cv = _rel.dot(access.v);
  const aTilde = ins.alphaSleeve / (dtSeconds * dtSeconds);
  const gain = w / (w + aTilde);
  // move the node toward the axis radially (remove the u,v components), compliantly
  _perp.copy(access.u).multiplyScalar(-gain * cu);
  _perp.addScaledVector(access.v, -gain * cv);
  p.add(_perp);
  return true;
}

/** Sensible default insertion state for a guidewire at nominal segment length h (cm). */
export function defaultInsertionState(h: number): InsertionState {
  return {
    inletOffset: 0,
    inletOffsetTarget: 0,
    rollTarget: 0,
    nominalSegmentLength: h,
    lambdaFeed: 0,
    // Compliant but firm motor (cm-units). Tuned so the proximal node tracks the commanded
    // inlet offset within a few iterations but can still stall at the force cap.
    alphaFeedMotor: 1e-8,
    lambdaRoll: 0,
    alphaRollMotor: 1e-4,
    alphaSleeve: 1e-8,
    sleeveLength: 4 * h,
    // Feed-force cap (cm-units · forceScale). Large enough that it never binds during free
    // advancement (the motor must be able to hold the proximal node); Stage 3 tunes it down
    // and exercises the cap against a blocked tip / wall.
    forceMax: 1e12
  };
}
