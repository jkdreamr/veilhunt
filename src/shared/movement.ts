/**
 * The single movement integrator. The server runs it authoritatively and the
 * client runs the exact same function for prediction and re-simulation, so both
 * sides agree without any position data ever being trusted from the client.
 */

import {
  ACCEL_AIR,
  ACCEL_GROUND,
  CROUCH_HEIGHT,
  FRICTION_GROUND,
  GRAVITY,
  HUNTER_SPEED,
  MAX_INPUT_DT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  RUNNER_SPEED,
  STEP_UP_HEIGHT,
  VAULT_IMPULSE,
  WATER_SPEED_SCALE,
  type SpeedTable,
} from './constants.js';
import { collideWorld, findVaultTarget, floorHeightAt, zoneAt } from './collision.js';
import type { CollisionWorld } from './collision.js';
import type { InputCommand, PlayerMotion, Role } from './types.js';

export interface MovementModifiers {
  /** Multiplied into max speed. 1 = unaffected. */
  speedScale: number;
  /** Blocks all horizontal movement while > 0. */
  rooted: boolean;
  /** Blocks input entirely (ward stun). */
  stunned: boolean;
  /** Crouch is forced (e.g. inside a tunnel). */
  forceCrouch: boolean;
  /** Sprint is unavailable (out of stamina, channelling, reloading). */
  sprintLocked: boolean;
  /** Forward lunge velocity applied this tick, world units/second. */
  lunge: number;
}

export const NO_MODIFIERS: MovementModifiers = {
  speedScale: 1,
  rooted: false,
  stunned: false,
  forceCrouch: false,
  sprintLocked: false,
  lunge: 0,
};

export function createMotion(x: number, z: number, yaw: number): PlayerMotion {
  return {
    x,
    y: 0,
    z,
    yaw,
    pitch: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    grounded: true,
    crouching: false,
    sprinting: false,
    speed: 0,
  };
}

export function speedTableFor(role: Role): SpeedTable {
  return role === 'runner' ? RUNNER_SPEED : HUNTER_SPEED;
}

export interface StepResult {
  /** True on the tick a vault actually started, so callers can emit feedback. */
  vaulted: boolean;
  /** True when the player is standing in water this tick. */
  inWater: boolean;
}

/**
 * Integrates one movement tick in place. `dt` is clamped so a malicious or
 * lagging client can never buy extra distance with an oversized delta.
 */
export function stepMovement(
  motion: PlayerMotion,
  input: InputCommand,
  world: CollisionWorld,
  role: Role,
  mods: MovementModifiers,
  dtOverride?: number,
): StepResult {
  const dt = Math.min(Math.max(dtOverride ?? input.dt, 0), MAX_INPUT_DT);
  const result: StepResult = { vaulted: false, inWater: false };
  if (dt <= 0) {
    motion.speed = Math.hypot(motion.vx, motion.vz);
    return result;
  }

  motion.yaw = input.yaw;
  motion.pitch = input.pitch;

  const speeds = speedTableFor(role);
  const wantCrouch = (input.crouch || mods.forceCrouch) && motion.grounded;
  motion.crouching = wantCrouch;

  const stunned = mods.stunned;
  const rooted = mods.rooted;

  let mx = stunned || rooted ? 0 : input.mx;
  let mz = stunned || rooted ? 0 : input.mz;
  const magSq = mx * mx + mz * mz;
  if (magSq > 1) {
    const inv = 1 / Math.sqrt(magSq);
    mx *= inv;
    mz *= inv;
  }
  const moving = magSq > 1e-4;

  const canSprint =
    !mods.sprintLocked && !wantCrouch && motion.grounded && input.sprint && moving && !stunned;
  motion.sprinting = canSprint;

  let maxSpeed = wantCrouch ? speeds.crouch : canSprint ? speeds.sprint : speeds.walk;
  if (!motion.grounded) maxSpeed = Math.max(maxSpeed, speeds.air);
  maxSpeed *= mods.speedScale;

  const inWater = zoneAt(world.map, motion.x, motion.z, 'water') !== null;
  result.inWater = inWater;
  if (inWater) maxSpeed *= WATER_SPEED_SCALE;

  // Camera-relative desired velocity. Input is already in camera space; yaw
  // rotates it into world space.
  //
  // Forward for a given yaw is (sin, cos). The camera sits behind the player
  // looking along that forward, so what the player sees as "right" on screen is
  // (-cos, sin) — the camera's local +X axis, not (cos, -sin). Getting this
  // backwards inverts A and D at every yaw, so `movement.test.ts` pins the
  // strafe direction against a real Three.js camera basis.
  const sinY = Math.sin(motion.yaw);
  const cosY = Math.cos(motion.yaw);
  const wishX = (-mx * cosY + mz * sinY) * maxSpeed;
  const wishZ = (mx * sinY + mz * cosY) * maxSpeed;

  const accel = motion.grounded ? ACCEL_GROUND : ACCEL_AIR;
  if (moving && !rooted && !stunned) {
    motion.vx += (wishX - motion.vx) * Math.min(1, accel * dt);
    motion.vz += (wishZ - motion.vz) * Math.min(1, accel * dt);
  } else if (motion.grounded) {
    const damp = Math.max(0, 1 - FRICTION_GROUND * dt);
    motion.vx *= damp;
    motion.vz *= damp;
    if (Math.abs(motion.vx) < 0.02) motion.vx = 0;
    if (Math.abs(motion.vz) < 0.02) motion.vz = 0;
  }

  if (mods.lunge > 0) {
    motion.vx += sinY * mods.lunge;
    motion.vz += cosY * mods.lunge;
  }

  // Vault: a short upward impulse that carries the player over a low obstacle.
  if (input.vault && motion.grounded && !stunned && !rooted) {
    const target = findVaultTarget(world, motion.x, motion.z, motion.yaw, motion.y);
    if (target) {
      motion.vy = VAULT_IMPULSE;
      motion.grounded = false;
      motion.vx += sinY * 2.6;
      motion.vz += cosY * 2.6;
      result.vaulted = true;
    }
  }

  // Integrate horizontally, then resolve against the world.
  const nextX = motion.x + motion.vx * dt;
  const nextZ = motion.z + motion.vz * dt;
  const standHeight = wantCrouch ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const corrected = collideWorld(world, nextX, nextZ, {
    radius: PLAYER_RADIUS,
    feetY: motion.y,
    standHeight,
    crouching: wantCrouch,
    airborne: !motion.grounded,
  });

  // Kill velocity into the surface we were pushed out of, so we slide rather
  // than jitter against walls.
  const dx = corrected.x - nextX;
  const dz = corrected.z - nextZ;
  if (dx !== 0 || dz !== 0) {
    const len = Math.hypot(dx, dz);
    if (len > 1e-5) {
      const nx = dx / len;
      const nz = dz / len;
      const into = motion.vx * nx + motion.vz * nz;
      if (into < 0) {
        motion.vx -= nx * into;
        motion.vz -= nz * into;
      }
    }
  }
  motion.x = corrected.x;
  motion.z = corrected.z;

  // Vertical: gravity plus floor snapping. The floor is always defined, so the
  // player can never fall out of the world.
  const floor = floorHeightAt(world.map, motion.x, motion.z);
  motion.vy -= GRAVITY * dt;
  motion.y += motion.vy * dt;

  if (motion.y <= floor + 1e-4) {
    motion.y = floor;
    motion.vy = 0;
    motion.grounded = true;
  } else if (motion.grounded && motion.y - floor <= STEP_UP_HEIGHT && motion.vy <= 0) {
    // Small lips and ramp seams are stepped over rather than fallen off.
    motion.y = floor;
    motion.vy = 0;
  } else {
    motion.grounded = false;
  }

  motion.speed = Math.hypot(motion.vx, motion.vz);

  // Defensive: a NaN anywhere would poison the match, so clamp it out at source.
  if (!Number.isFinite(motion.x) || !Number.isFinite(motion.z) || !Number.isFinite(motion.y)) {
    motion.x = 0;
    motion.y = 0;
    motion.z = 0;
    motion.vx = 0;
    motion.vy = 0;
    motion.vz = 0;
    motion.speed = 0;
    motion.grounded = true;
  }

  return result;
}

/** Eye height used for both rendering and line-of-sight tests. */
export function eyeHeight(motion: PlayerMotion): number {
  return motion.y + (motion.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT) * 0.92;
}
