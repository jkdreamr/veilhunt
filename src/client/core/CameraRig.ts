/**
 * Third-person orbit camera with damping, wall avoidance and trauma shake.
 *
 * The camera must always show the next decision, so collision pulls it in
 * rather than letting geometry clip through, and shake is capped and decays.
 */

import * as THREE from 'three';
import { hasLineOfSight } from '../../shared/collision.js';
import type { CollisionWorld } from '../../shared/collision.js';

const BASE_DISTANCE = 4.6;
const CROUCH_DISTANCE = 3.9;
const MIN_DISTANCE = 1.2;
const SHOULDER_OFFSET = 0.55;
const HEIGHT_STAND = 1.62;
const HEIGHT_CROUCH = 1.05;
const TRAUMA_DECAY = 1.5;
const MAX_SHAKE_OFFSET = 0.34;
const MAX_SHAKE_ROLL = 0.055;

function pseudoNoise(t: number, seed: number): number {
  const x = Math.sin(t * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export class CameraRig {
  private distance = BASE_DISTANCE;
  private smoothedDistance = BASE_DISTANCE;
  private readonly target = new THREE.Vector3();
  private readonly smoothTarget = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private trauma = 0;
  private shakeTime = 0;
  private baseFov = 62;
  private fovPunch = 0;
  private initialised = false;
  private reducedShake = false;

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    this.baseFov = camera.fov;
  }

  setReducedShake(value: boolean): void {
    this.reducedShake = value;
    if (value) this.trauma = 0;
  }

  addTrauma(amount: number): void {
    if (this.reducedShake) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  punchFov(degrees: number): void {
    this.fovPunch = Math.min(9, this.fovPunch + degrees);
  }

  /** Snaps the camera to the player without interpolation, e.g. on spawn. */
  reset(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.smoothTarget.set(x, y + HEIGHT_STAND, z);
    this.smoothedDistance = BASE_DISTANCE;
    this.trauma = 0;
    this.fovPunch = 0;
    this.initialised = true;
    this.update(0, x, y, z, yaw, pitch, false, null);
  }

  update(
    dt: number,
    px: number,
    py: number,
    pz: number,
    yaw: number,
    pitch: number,
    crouching: boolean,
    world: CollisionWorld | null,
  ): void {
    const headHeight = crouching ? HEIGHT_CROUCH : HEIGHT_STAND;
    this.target.set(px, py + headHeight, pz);

    if (!this.initialised) {
      this.smoothTarget.copy(this.target);
      this.initialised = true;
    } else {
      // Critically-damped follow: fast enough to feel connected, smooth enough
      // that footstep bob does not translate into camera jitter.
      const k = 1 - Math.exp(-16 * dt);
      this.smoothTarget.lerp(this.target, Math.min(1, k));
    }

    this.distance = crouching ? CROUCH_DISTANCE : BASE_DISTANCE;

    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);

    // Offset the pivot to the shoulder so the player model does not sit dead
    // centre and block the view down the corridor they are running.
    const shoulderX = cosYaw * SHOULDER_OFFSET;
    const shoulderZ = -sinYaw * SHOULDER_OFFSET;
    const pivotX = this.smoothTarget.x + shoulderX;
    const pivotY = this.smoothTarget.y;
    const pivotZ = this.smoothTarget.z + shoulderZ;

    // The direction the player is looking. World forward for a given yaw is
    // (sin yaw, cos yaw) — the same convention `stepMovement` uses — so the
    // camera sits at `pivot - lookDir * distance`, i.e. behind the player.
    const dirX = sinYaw * cosPitch;
    const dirY = sinPitch;
    const dirZ = cosYaw * cosPitch;

    let allowed = this.distance;
    if (world) {
      // Probe outward and pull the camera in to the last clear point.
      const steps = 6;
      for (let i = steps; i >= 1; i -= 1) {
        const test = (this.distance * i) / steps;
        const tx = pivotX - dirX * test;
        const ty = pivotY - dirY * test;
        const tz = pivotZ - dirZ * test;
        if (ty > 0.35 && hasLineOfSight(world, pivotX, pivotY, pivotZ, tx, ty, tz)) {
          allowed = test;
          break;
        }
        allowed = MIN_DISTANCE;
      }
    }

    // Pull in quickly (so we never clip), ease out slowly (so it is not jumpy).
    const towards = allowed < this.smoothedDistance ? 26 : 7;
    this.smoothedDistance += (allowed - this.smoothedDistance) * Math.min(1, towards * dt);
    this.smoothedDistance = Math.max(MIN_DISTANCE, this.smoothedDistance);

    this.desired.set(
      pivotX - dirX * this.smoothedDistance,
      Math.max(0.4, pivotY - dirY * this.smoothedDistance),
      pivotZ - dirZ * this.smoothedDistance,
    );

    this.camera.position.copy(this.desired);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.smoothTarget.x, this.smoothTarget.y + 0.12, this.smoothTarget.z);

    // Trauma-squared shake so small events barely register and big ones snap.
    if (this.trauma > 0 && !this.reducedShake) {
      this.shakeTime += dt;
      this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
      const shake = this.trauma * this.trauma;
      const freq = this.shakeTime * 30;
      this.camera.position.x += MAX_SHAKE_OFFSET * shake * pseudoNoise(freq, 1);
      this.camera.position.y += MAX_SHAKE_OFFSET * shake * pseudoNoise(freq, 2);
      this.camera.rotateZ(MAX_SHAKE_ROLL * shake * pseudoNoise(freq, 3));
    }

    if (this.fovPunch > 0.001) {
      this.fovPunch *= Math.exp(-dt / 0.2);
      if (this.fovPunch < 0.001) this.fovPunch = 0;
    }
    const targetFov = this.baseFov + this.fovPunch;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }
  }

  get cameraDistance(): number {
    return this.smoothedDistance;
  }
}
