/**
 * Remote-player interpolation.
 *
 * Snapshots arrive at a fixed rate, so the remote player is rendered slightly in
 * the past and interpolated between the two samples that bracket the render
 * time. That trades a small constant latency for completely smooth motion.
 */

import type { PlayerTransform } from '../../shared/types.js';

/** How far behind real time we render remote entities, in seconds. */
const INTERP_DELAY = 0.11;
const MAX_BUFFER = 24;
/** Beyond this gap we treat the sample as a teleport and snap. */
const SNAP_DISTANCE = 12;

interface Sample {
  time: number;
  transform: PlayerTransform;
  crouching: boolean;
  sprinting: boolean;
  speed: number;
}

export interface InterpolatedState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouching: boolean;
  sprinting: boolean;
  speed: number;
  /** 0 when the remote player has no recent samples, 1 when fully present. */
  presence: number;
}

function shortestAngle(from: number, to: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

export class RemoteInterpolator {
  private readonly buffer: Sample[] = [];
  private clock = 0;
  private presence = 0;
  private readonly state: InterpolatedState = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    crouching: false,
    sprinting: false,
    speed: 0,
    presence: 0,
  };

  /** Feeds a snapshot sample. Pass `null` when the opponent is not perceivable. */
  push(
    transform: PlayerTransform | null,
    crouching: boolean,
    sprinting: boolean,
    speed: number,
  ): void {
    if (!transform) return;
    const last = this.buffer[this.buffer.length - 1];
    if (last && Math.hypot(transform.x - last.transform.x, transform.z - last.transform.z) > SNAP_DISTANCE) {
      // A large jump means they left and re-entered view; discard stale history.
      this.buffer.length = 0;
    }
    this.buffer.push({
      time: this.clock,
      transform: { ...transform },
      crouching,
      sprinting,
      speed,
    });
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
  }

  update(dt: number, visible: boolean): InterpolatedState {
    this.clock += dt;

    // Presence fades the remote player in and out instead of popping.
    const targetPresence = visible ? 1 : 0;
    const rate = visible ? 9 : 5;
    this.presence += (targetPresence - this.presence) * Math.min(1, rate * dt);
    if (this.presence < 0.002) this.presence = 0;
    this.state.presence = this.presence;

    const renderTime = this.clock - INTERP_DELAY;

    // Drop samples older than the one we still need to interpolate from.
    while (this.buffer.length > 2 && this.buffer[1].time <= renderTime) {
      this.buffer.shift();
    }

    if (this.buffer.length === 0) return this.state;

    if (this.buffer.length === 1) {
      const only = this.buffer[0];
      this.state.x = only.transform.x;
      this.state.y = only.transform.y;
      this.state.z = only.transform.z;
      this.state.yaw = only.transform.yaw;
      this.state.pitch = only.transform.pitch;
      this.state.crouching = only.crouching;
      this.state.sprinting = only.sprinting;
      this.state.speed = only.speed;
      return this.state;
    }

    const a = this.buffer[0];
    const b = this.buffer[1];
    const span = b.time - a.time;
    const t = span > 1e-5 ? Math.max(0, Math.min(1, (renderTime - a.time) / span)) : 1;

    this.state.x = a.transform.x + (b.transform.x - a.transform.x) * t;
    this.state.y = a.transform.y + (b.transform.y - a.transform.y) * t;
    this.state.z = a.transform.z + (b.transform.z - a.transform.z) * t;
    this.state.yaw = a.transform.yaw + shortestAngle(a.transform.yaw, b.transform.yaw) * t;
    this.state.pitch = a.transform.pitch + (b.transform.pitch - a.transform.pitch) * t;
    this.state.crouching = t < 0.5 ? a.crouching : b.crouching;
    this.state.sprinting = t < 0.5 ? a.sprinting : b.sprinting;
    this.state.speed = a.speed + (b.speed - a.speed) * t;

    return this.state;
  }

  reset(): void {
    this.buffer.length = 0;
    this.clock = 0;
    this.presence = 0;
    this.state.presence = 0;
  }

  get bufferSize(): number {
    return this.buffer.length;
  }
}
