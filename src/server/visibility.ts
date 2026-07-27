/**
 * Perception rules. This module decides what each player is *allowed to know*,
 * and the snapshot builder never sends a transform that fails these checks — so
 * the Hunter's client literally cannot draw a Runner it should not see.
 */

import {
  CLOSE_SIGHT_RANGE,
  FOLIAGE_CONCEAL_RANGE,
  HIDE_SPOT_CONCEAL_RANGE,
  SHADOW_CONCEAL_RANGE,
  SIGHT_RANGE,
} from '../shared/constants.js';
import { hasLineOfSight, hideSpotAt, zoneAt } from '../shared/collision.js';
import type { CollisionWorld } from '../shared/collision.js';
import { eyeHeight } from '../shared/movement.js';
import type { PlayerMotion, SmokeState } from '../shared/types.js';

/**
 * Generous horizontal half-FOV. Wider than the render frustum so anything that
 * could appear on screen is already being sent, avoiding pop-in on fast turns.
 */
export const PERCEPTION_FOV_HALF = 1.9;

export interface PerceptionInput {
  world: CollisionWorld;
  observer: PlayerMotion;
  target: PlayerMotion;
  /** Concealment only applies when the target is the Runner. */
  targetIsRunner: boolean;
  smokes: readonly SmokeState[];
}

function insideSmoke(smokes: readonly SmokeState[], x: number, z: number): boolean {
  for (const smoke of smokes) {
    const dx = x - smoke.x;
    const dz = z - smoke.z;
    if (dx * dx + dz * dz <= smoke.radius * smoke.radius) return true;
  }
  return false;
}

/** True when the straight line between two points passes through a smoke cloud. */
function smokeBlocksLine(
  smokes: readonly SmokeState[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-6) return false;
  for (const smoke of smokes) {
    const t = Math.max(0, Math.min(1, ((smoke.x - ax) * dx + (smoke.z - az) * dz) / lenSq));
    const cx = ax + dx * t;
    const cz = az + dz * t;
    const ddx = cx - smoke.x;
    const ddz = cz - smoke.z;
    // Slightly tighter than the visual radius so the cloud edge stays fair.
    const r = smoke.radius * 0.88;
    if (ddx * ddx + ddz * ddz <= r * r) return true;
  }
  return false;
}

export function canPerceive(input: PerceptionInput): boolean {
  const { world, observer, target, smokes } = input;
  const dx = target.x - observer.x;
  const dz = target.z - observer.z;
  const distSq = dx * dx + dz * dz;
  if (distSq > SIGHT_RANGE * SIGHT_RANGE) return false;

  const dist = Math.sqrt(distSq);
  const observerEye = eyeHeight(observer);
  const targetEye = eyeHeight(target);

  if (!hasLineOfSight(world, observer.x, observerEye, observer.z, target.x, targetEye, target.z)) {
    return false;
  }

  // Point blank: cover cannot save you when the other player is on top of you.
  if (dist <= CLOSE_SIGHT_RANGE) return true;

  // Facing cone.
  if (dist > 1e-4) {
    const fx = Math.sin(observer.yaw);
    const fz = Math.cos(observer.yaw);
    const cos = (dx * fx + dz * fz) / dist;
    if (cos < Math.cos(PERCEPTION_FOV_HALF)) return false;
  }

  // Smoke blinds in both directions and along the sight line.
  if (
    insideSmoke(smokes, target.x, target.z) ||
    insideSmoke(smokes, observer.x, observer.z) ||
    smokeBlocksLine(smokes, observer.x, observer.z, target.x, target.z)
  ) {
    return false;
  }

  if (!input.targetIsRunner) return true;

  // Runner concealment. Hiding is never total — every rule has a range at which
  // the Hunter can close in and check.
  if (hideSpotAt(world.map, target.x, target.z) >= 0 && dist > HIDE_SPOT_CONCEAL_RANGE) {
    return false;
  }
  if (
    target.crouching &&
    zoneAt(world.map, target.x, target.z, 'foliage') &&
    dist > FOLIAGE_CONCEAL_RANGE
  ) {
    return false;
  }
  if (
    target.crouching &&
    !target.sprinting &&
    zoneAt(world.map, target.x, target.z, 'shadow') &&
    dist > SHADOW_CONCEAL_RANGE
  ) {
    return false;
  }

  return true;
}

/** Describes why the Runner is currently hard to see, for their own HUD. */
export function concealmentState(
  world: CollisionWorld,
  motion: PlayerMotion,
  smokes: readonly SmokeState[],
): { hidden: boolean; inSmoke: boolean; concealed: boolean } {
  const hidden = hideSpotAt(world.map, motion.x, motion.z) >= 0;
  const inSmoke = insideSmoke(smokes, motion.x, motion.z);
  const concealed =
    hidden ||
    inSmoke ||
    (motion.crouching && zoneAt(world.map, motion.x, motion.z, 'foliage') !== null) ||
    (motion.crouching && !motion.sprinting && zoneAt(world.map, motion.x, motion.z, 'shadow') !== null);
  return { hidden, inSmoke, concealed };
}

/** Damping factor applied to a tracking pulse passing through smoke. */
export function pulseDampingAt(
  smokes: readonly SmokeState[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  damping: number,
): number {
  return smokeBlocksLine(smokes, ax, az, bx, bz) ? damping : 1;
}
