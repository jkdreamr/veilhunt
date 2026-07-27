/**
 * Development bot: a deterministic simulated second client so the game can be
 * played and tested without a human partner. It runs server-side and emits the
 * same InputCommand / ActionCommand stream a real client would, so it exercises
 * exactly the same authoritative code path.
 */

import { hasLineOfSight } from '../shared/collision.js';
import type { CollisionWorld } from '../shared/collision.js';
import { generateMap } from '../shared/mapgen.js';
import { createRng, type Rng } from '../shared/rng.js';
import { TICK_DT } from '../shared/constants.js';
import type { ActionCommand, InputCommand, MapData } from '../shared/types.js';
import type { Match } from './Match.js';

interface Waypoint {
  x: number;
  z: number;
}

export class Bot {
  readonly id: string;
  readonly name: string;

  private readonly map: MapData;
  private readonly world: CollisionWorld;
  private readonly rng: Rng;

  private seq = 1;
  private yaw = 0;
  private target: Waypoint | null = null;
  private avoidTimer = 0;
  private avoidTurn = 0;
  private stuckTimer = 0;
  private lastX = 0;
  private lastZ = 0;
  private interactHeld = false;
  private repathTimer = 0;
  private wanderTarget: Waypoint | null = null;
  private actionTimer = 0;

  constructor(id: string, name: string, seed: number) {
    this.id = id;
    this.name = name;
    this.map = generateMap(seed);
    this.world = { map: this.map, dynamic: [] };
    this.rng = createRng((seed ^ 0x5bf03635) >>> 0);
  }

  /** Produces one tick of input plus any actions the bot wants to take. */
  update(match: Match, dt: number): { input: InputCommand; actions: ActionCommand[] } {
    const ctx = match.getBotContext(this.id);
    const actions: ActionCommand[] = [];

    if (!ctx) {
      return { input: this.idleInput(), actions };
    }

    const self = ctx.self;
    this.repathTimer -= dt;
    this.actionTimer -= dt;

    // --- Choose a goal -----------------------------------------------------
    if (ctx.role === 'runner') {
      if (ctx.gateOpen) {
        this.target = { x: ctx.gate.x, z: ctx.gate.z };
      } else {
        const pending = ctx.seals.filter((s) => !s.active);
        if (pending.length > 0) {
          let best = pending[0];
          let bestD = Number.POSITIVE_INFINITY;
          for (const seal of pending) {
            const d = Math.hypot(seal.x - self.x, seal.z - self.z);
            if (d < bestD) {
              bestD = d;
              best = seal;
            }
          }
          this.target = { x: best.x, z: best.z };
        } else {
          this.target = { x: ctx.gate.x, z: ctx.gate.z };
        }
      }
    } else {
      // Hunter: chase what it can see, else sweep the unlit seals.
      if (ctx.opponentGuess) {
        this.target = { x: ctx.opponentGuess.x, z: ctx.opponentGuess.z };
      } else {
        const pending = ctx.seals.filter((s) => !s.active);
        if (this.repathTimer <= 0 || !this.wanderTarget) {
          this.repathTimer = 6;
          this.wanderTarget =
            pending.length > 0
              ? { x: pending[this.rng.int(0, pending.length - 1)].x, z: pending[this.rng.int(0, pending.length - 1)].z }
              : { x: this.rng.range(-50, 50), z: this.rng.range(-50, 50) };
        }
        this.target = this.wanderTarget;
      }
    }

    // --- Steering ----------------------------------------------------------
    const goal = this.target ?? { x: 0, z: 0 };
    let desiredYaw = Math.atan2(goal.x - self.x, goal.z - self.z);
    const distToGoal = Math.hypot(goal.x - self.x, goal.z - self.z);

    if (this.avoidTimer > 0) {
      this.avoidTimer -= dt;
      desiredYaw += this.avoidTurn;
    } else {
      // Whisker probes: prefer the clearest of forward / left / right.
      const probe = 3.4;
      const clear = (angle: number): boolean =>
        hasLineOfSight(
          this.world,
          self.x,
          1.2,
          self.z,
          self.x + Math.sin(angle) * probe,
          1.2,
          self.z + Math.cos(angle) * probe,
        );
      if (!clear(desiredYaw)) {
        const left = clear(desiredYaw - 0.9);
        const right = clear(desiredYaw + 0.9);
        if (left && !right) desiredYaw -= 0.9;
        else if (right && !left) desiredYaw += 0.9;
        else {
          this.avoidTimer = 0.9;
          this.avoidTurn = this.rng.bool(0.5) ? 1.5 : -1.5;
          desiredYaw += this.avoidTurn;
        }
      }
    }

    // Smoothly turn instead of snapping, so remote interpolation looks natural.
    let diff = desiredYaw - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += Math.max(-4 * dt, Math.min(4 * dt, diff));

    // --- Stuck detection ---------------------------------------------------
    const moved = Math.hypot(self.x - this.lastX, self.z - this.lastZ);
    this.lastX = self.x;
    this.lastZ = self.z;
    if (moved < 0.02 * (dt / TICK_DT)) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.2) {
        this.stuckTimer = 0;
        this.avoidTimer = 1.2;
        this.avoidTurn = this.rng.range(2.0, 4.2) * (this.rng.bool(0.5) ? 1 : -1);
        this.repathTimer = 0;
      }
    } else {
      this.stuckTimer = 0;
    }

    // --- Interaction -------------------------------------------------------
    const prompt = ctx.prompt;
    const wantsInteract =
      ctx.rooted > 0 ||
      (prompt.kind !== 'none' &&
        !prompt.blocked &&
        (prompt.kind === 'seal' ||
          prompt.kind === 'gate' ||
          prompt.kind === 'snareEscape' ||
          prompt.kind === 'barricade'));

    if (wantsInteract && !this.interactHeld) {
      this.interactHeld = true;
      actions.push({ kind: 'interact', yaw: this.yaw, pitch: 0, seq: this.seq });
    } else if (!wantsInteract && this.interactHeld) {
      this.interactHeld = false;
      actions.push({ kind: 'interactStop', yaw: this.yaw, pitch: 0, seq: this.seq });
    }

    // --- Combat / abilities ------------------------------------------------
    if (this.actionTimer <= 0 && ctx.opponentGuess) {
      const d = Math.hypot(ctx.opponentGuess.x - self.x, ctx.opponentGuess.z - self.z);
      if (ctx.role === 'hunter') {
        if (d < 2.9 && (ctx.cooldowns.blade ?? 0) <= 0) {
          actions.push({ kind: 'primary', yaw: this.yaw, pitch: 0, seq: this.seq });
          this.actionTimer = 0.6;
        } else if (d < 24 && d > 4 && (ctx.cooldowns.crossbow ?? 0) <= 0) {
          actions.push({ kind: 'secondary', yaw: this.yaw, pitch: 0, seq: this.seq });
          this.actionTimer = 1.2;
        }
      } else if (d < 16 && (ctx.cooldowns.smoke ?? 0) <= 0) {
        actions.push({ kind: 'ability2', yaw: this.yaw, pitch: 0, seq: this.seq });
        this.actionTimer = 2;
      } else if (d < 22 && (ctx.cooldowns.decoy ?? 0) <= 0) {
        actions.push({ kind: 'ability1', yaw: this.yaw, pitch: 0, seq: this.seq });
        this.actionTimer = 2;
      }
    } else if (this.actionTimer <= 0 && ctx.role === 'hunter' && (ctx.cooldowns.pulse ?? 0) <= 0) {
      actions.push({ kind: 'ability1', yaw: this.yaw, pitch: 0, seq: this.seq });
      this.actionTimer = 3;
    }

    // Stop walking into the objective while channelling it.
    const channelling = this.interactHeld && (prompt.kind === 'seal' || prompt.kind === 'gate' || prompt.kind === 'barricade');
    const arrived = distToGoal < 1.6;
    const mz = channelling || arrived ? 0 : 1;

    const input: InputCommand = {
      seq: this.seq++,
      dt,
      mx: 0,
      mz,
      yaw: this.yaw,
      pitch: 0,
      sprint: !channelling && distToGoal > 8 && ctx.opponentGuess !== null,
      crouch: false,
      vault: this.stuckTimer > 0.5,
    };

    return { input, actions };
  }

  private idleInput(): InputCommand {
    return {
      seq: this.seq++,
      dt: TICK_DT,
      mx: 0,
      mz: 0,
      yaw: this.yaw,
      pitch: 0,
      sprint: false,
      crouch: false,
      vault: false,
    };
  }
}
