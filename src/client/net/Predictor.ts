/**
 * Client-side prediction and reconciliation.
 *
 * The client runs the exact same `stepMovement` the server runs. Every input is
 * kept until the server acknowledges it; when a snapshot arrives we rewind to
 * the authoritative state and replay the unacknowledged tail. Because both
 * sides run identical pure code, the replay normally lands on the same result
 * and the correction is invisible.
 */

import { MAX_INPUT_BACKLOG } from '../../shared/constants.js';
import type { CollisionWorld } from '../../shared/collision.js';
import { stepMovement, type MovementModifiers } from '../../shared/movement.js';
import type { InputCommand, PlayerMotion, Role, SelfState } from '../../shared/types.js';

/** Beyond this positional error we stop smoothing and snap. */
const SNAP_THRESHOLD = 2.6;
/** Errors under this are ignored entirely to avoid micro-jitter. */
const IGNORE_THRESHOLD = 0.012;

export class Predictor {
  /** The predicted, renderable motion state. */
  readonly motion: PlayerMotion;

  private pending: InputCommand[] = [];
  private nextSeq = 1;
  private lastAck = 0;
  private lastSentSeq = 0;
  private corrections = 0;
  private snaps = 0;
  private lastError = 0;

  constructor(
    initial: PlayerMotion,
    private readonly role: Role,
    private world: CollisionWorld,
  ) {
    this.motion = { ...initial };
  }

  setWorld(world: CollisionWorld): void {
    this.world = world;
  }

  get sequence(): number {
    return this.nextSeq;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get stats(): { corrections: number; snaps: number; error: number; pending: number } {
    return {
      corrections: this.corrections,
      snaps: this.snaps,
      error: this.lastError,
      pending: this.pending.length,
    };
  }

  /**
   * Applies one local input immediately and banks it for replay. Returns the
   * command so the caller can ship it to the server.
   */
  predict(
    dt: number,
    intent: { mx: number; mz: number; sprint: boolean; crouch: boolean; vault: boolean; aim: boolean },
    yaw: number,
    pitch: number,
    mods: MovementModifiers,
  ): InputCommand {
    const command: InputCommand = {
      seq: this.nextSeq++,
      dt,
      mx: intent.mx,
      mz: intent.mz,
      yaw,
      pitch,
      sprint: intent.sprint,
      crouch: intent.crouch,
      vault: intent.vault,
      aim: intent.aim,
    };

    stepMovement(this.motion, command, this.world, this.role, mods);
    this.pending.push(command);
    // Replay buffer only; a long stall should not grow it without bound.
    if (this.pending.length > 240) this.pending.splice(0, this.pending.length - 240);
    return command;
  }

  /**
   * Reconciles against an authoritative snapshot. Inputs the server has already
   * consumed are dropped; the rest are replayed on top of the server state.
   */
  reconcile(self: SelfState, mods: MovementModifiers): void {
    this.lastAck = self.ackSeq;
    // Drop acknowledged inputs.
    let drop = 0;
    while (drop < this.pending.length && this.pending[drop].seq <= self.ackSeq) drop += 1;
    if (drop > 0) this.pending.splice(0, drop);

    const authoritative: PlayerMotion = { ...self.transform };
    const errorBefore = Math.hypot(
      authoritative.x - this.motion.x,
      authoritative.y - this.motion.y,
      authoritative.z - this.motion.z,
    );
    this.lastError = errorBefore;

    if (errorBefore < IGNORE_THRESHOLD && this.pending.length === 0) {
      // Already in agreement; keep the local orientation which is newer.
      this.motion.vx = authoritative.vx;
      this.motion.vy = authoritative.vy;
      this.motion.vz = authoritative.vz;
      this.motion.grounded = authoritative.grounded;
      return;
    }

    // Rewind to the server state, then replay everything it has not seen.
    const localYaw = this.motion.yaw;
    const localPitch = this.motion.pitch;
    this.motion.x = authoritative.x;
    this.motion.y = authoritative.y;
    this.motion.z = authoritative.z;
    this.motion.vx = authoritative.vx;
    this.motion.vy = authoritative.vy;
    this.motion.vz = authoritative.vz;
    this.motion.grounded = authoritative.grounded;
    this.motion.crouching = authoritative.crouching;
    this.motion.sprinting = authoritative.sprinting;

    for (const command of this.pending) {
      stepMovement(this.motion, command, this.world, this.role, mods);
    }

    // Look direction is purely local — never let the network fight the mouse.
    this.motion.yaw = localYaw;
    this.motion.pitch = localPitch;

    if (errorBefore > SNAP_THRESHOLD) this.snaps += 1;
    else if (errorBefore > IGNORE_THRESHOLD) this.corrections += 1;
  }

  /**
   * Returns commands that have not been transmitted yet and marks them sent.
   *
   * This used to return the last N *unacknowledged* commands every tick. Above
   * roughly 120 fps the client produces commands faster than acknowledgements
   * arrive, so the queue outgrew the batch cap and the oldest entries were
   * silently truncated off the front — never sent, therefore never acked,
   * therefore never dropped from the queue. The backlog ran away and the client
   * permanently applied movement the server never saw, so reconciliation yanked
   * the player backwards every snapshot and they appeared stuck.
   *
   * Socket.IO is reliable and ordered, so each command only needs to go once.
   */
  drainUnsent(): InputCommand[] {
    const out: InputCommand[] = [];
    for (const command of this.pending) {
      if (command.seq > this.lastSentSeq) out.push(command);
    }
    if (out.length === 0) return out;
    this.lastSentSeq = out[out.length - 1].seq;
    // A pathological frame hitch could still overflow one batch; prefer the
    // newest commands in that case, since stale motion matters least.
    return out.length > MAX_INPUT_BACKLOG ? out.slice(out.length - MAX_INPUT_BACKLOG) : out;
  }

  get acknowledgedSeq(): number {
    return this.lastAck;
  }

  reset(motion: PlayerMotion): void {
    Object.assign(this.motion, motion);
    this.pending.length = 0;
    this.lastSentSeq = 0;
    this.corrections = 0;
    this.snaps = 0;
    this.lastError = 0;
  }
}
