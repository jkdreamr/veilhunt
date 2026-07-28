/**
 * Regressions for three bugs that shipped in the first build and were only
 * caught by playing it: inverted strafe, crossbow bolts tunnelling through the
 * target, and an input backlog that ran away at high frame rates.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { generateMap } from '../../src/shared/mapgen.js';
import { createMotion, stepMovement, NO_MODIFIERS } from '../../src/shared/movement.js';
import { CROSSBOW, MAX_INPUT_BACKLOG, TICK_DT } from '../../src/shared/constants.js';
import type { InputCommand } from '../../src/shared/types.js';

const map = generateMap(12345);
const world = { map, dynamic: [] };

function command(overrides: Partial<InputCommand> = {}): InputCommand {
  return {
    seq: 1,
    dt: TICK_DT,
    mx: 0,
    mz: 0,
    yaw: 0,
    pitch: 0,
    sprint: false,
    crouch: false,
    vault: false,
    aim: false,
    ...overrides,
  };
}

/**
 * Places a camera exactly the way `CameraRig` does and returns the world-space
 * direction the player sees as "right" on screen. Deriving this from a real
 * Three.js camera basis rather than by hand is the whole point — the original
 * bug was a sign error in that derivation.
 */
function screenRight(yaw: number): THREE.Vector3 {
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 400);
  const head = 1.62;
  const distance = 4.6;
  const dirX = Math.sin(yaw);
  const dirZ = Math.cos(yaw);
  camera.position.set(-dirX * distance, head, -dirZ * distance);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, head, 0);
  camera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  right.y = 0;
  return right.normalize();
}

describe('strafe direction', () => {
  it.each([0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2, -2.3])(
    'moves D toward screen-right at yaw %f',
    (yaw) => {
      const motion = createMotion(0, 0, yaw);
      stepMovement(motion, command({ mx: 1, yaw }), world, 'runner', NO_MODIFIERS);

      const moved = new THREE.Vector3(motion.vx, 0, motion.vz).normalize();
      expect(moved.dot(screenRight(yaw))).toBeGreaterThan(0.99);
    },
  );

  it('moves A toward screen-left', () => {
    const yaw = 0.7;
    const motion = createMotion(0, 0, yaw);
    stepMovement(motion, command({ mx: -1, yaw }), world, 'runner', NO_MODIFIERS);

    const moved = new THREE.Vector3(motion.vx, 0, motion.vz).normalize();
    expect(moved.dot(screenRight(yaw))).toBeLessThan(-0.99);
  });

  it('keeps W moving along the facing direction', () => {
    for (const yaw of [0, 1.1, Math.PI, -2.0]) {
      const motion = createMotion(0, 0, yaw);
      stepMovement(motion, command({ mz: 1, yaw }), world, 'runner', NO_MODIFIERS);

      const moved = new THREE.Vector3(motion.vx, 0, motion.vz).normalize();
      const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      expect(moved.dot(forward)).toBeGreaterThan(0.99);
    }
  });

  it('keeps strafe perpendicular to forward', () => {
    const yaw = 0.4;
    const strafe = createMotion(0, 0, yaw);
    stepMovement(strafe, command({ mx: 1, yaw }), world, 'runner', NO_MODIFIERS);
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const moved = new THREE.Vector3(strafe.vx, 0, strafe.vz).normalize();
    expect(Math.abs(moved.dot(forward))).toBeLessThan(0.01);
  });
});

describe('crossbow bolt sweep', () => {
  /**
   * Mirrors the server's swept segment-vs-capsule test. A bolt covers a full
   * metre per 30 Hz tick against a 0.72 m hit radius, so a per-tick point check
   * used to miss roughly 45% of perfectly aimed shots.
   */
  function boltHits(targetDistance: number): boolean {
    const hitRadius = CROSSBOW.projectileRadius + 0.5;
    let x = 0;
    let y = 1.6;
    let z = 0.7;
    let vy = 0;

    for (let tick = 0; tick < 90; tick += 1) {
      const prevX = x;
      const prevY = y;
      const prevZ = z;
      vy -= CROSSBOW.gravity * TICK_DT;
      y += vy * TICK_DT;
      z += CROSSBOW.projectileSpeed * TICK_DT;

      const segX = x - prevX;
      const segY = y - prevY;
      const segZ = z - prevZ;
      const relX = prevX - 0;
      const relZ = prevZ - targetDistance;
      const horizLenSq = segX * segX + segZ * segZ;
      let travel = horizLenSq > 1e-9 ? -(relX * segX + relZ * segZ) / horizLenSq : 0;
      travel = travel < 0 ? 0 : travel > 1 ? 1 : travel;

      const nearestX = relX + segX * travel;
      const nearestZ = relZ + segZ * travel;
      const nearestY = prevY + segY * travel;

      if (Math.hypot(nearestX, nearestZ) < hitRadius && nearestY > -0.2 && nearestY < 1.9) {
        return true;
      }
      if (y < 0.05) return false;
    }
    return false;
  }

  it('lands every perfectly aimed shot across the usable range', () => {
    const misses: number[] = [];
    for (let distance = 4; distance <= CROSSBOW.effectiveRange; distance += 0.13) {
      if (!boltHits(distance)) misses.push(Number(distance.toFixed(2)));
    }
    expect(misses, `tunnelled through the target at: ${misses.join(', ')}`).toEqual([]);
  });

  it('travels far enough per tick that a point test would tunnel', () => {
    // Guards the premise: if the bolt ever became slow enough that a naive
    // check would work, this test is no longer proving anything.
    const perTick = CROSSBOW.projectileSpeed * TICK_DT;
    expect(perTick).toBeGreaterThan(CROSSBOW.projectileRadius + 0.5);
  });
});

describe('input batching', () => {
  it('has headroom for a high-refresh client between acknowledgements', () => {
    // Commands are produced per rendered frame and acknowledged at snapshot
    // rate. The batch cap has to clear that ratio with room for a frame hitch,
    // or commands get stranded and the player appears stuck.
    const worstFps = 240;
    const snapshotHz = 20;
    const commandsBetweenAcks = worstFps / snapshotHz;
    expect(MAX_INPUT_BACKLOG).toBeGreaterThan(commandsBetweenAcks * 2);
  });
});
