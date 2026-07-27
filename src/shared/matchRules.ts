/**
 * Pure match rules. Nothing here touches sockets, Three.js or timers — it is the
 * decision layer the authoritative server calls and the unit tests exercise
 * directly.
 */

import {
  BLADE,
  HIT_PROTECTION,
  SEALS_REQUIRED,
  SEAL_CHANNEL_TIME,
  WOUND_CHANNEL_PENALTY,
  WOUND_LEVELS,
  WOUND_SPEED_PENALTY,
  type WoundLevel,
} from './constants.js';
import type { MatchOutcome, Role, SealState } from './types.js';

export function woundIndex(level: WoundLevel): number {
  return WOUND_LEVELS.indexOf(level);
}

export function nextWound(level: WoundLevel): WoundLevel {
  const i = woundIndex(level);
  return i >= WOUND_LEVELS.length - 1 ? level : WOUND_LEVELS[i + 1];
}

export function previousWound(level: WoundLevel): WoundLevel {
  const i = woundIndex(level);
  return i <= 0 ? level : WOUND_LEVELS[i - 1];
}

export function isCaptureHit(level: WoundLevel): boolean {
  return level === 'cursed';
}

export function channelScaleForWound(level: WoundLevel): number {
  return WOUND_CHANNEL_PENALTY[woundIndex(level)];
}

export function speedScaleForWound(level: WoundLevel): number {
  return WOUND_SPEED_PENALTY[woundIndex(level)];
}

export type BladeRejection =
  | 'ok'
  | 'cooldown'
  | 'outOfRange'
  | 'outOfArc'
  | 'blocked'
  | 'protected'
  | 'wrongRole';

export interface BladeAttempt {
  attackerX: number;
  attackerZ: number;
  attackerYaw: number;
  targetX: number;
  targetZ: number;
  cooldownRemaining: number;
  protectionRemaining: number;
  hasLineOfSight: boolean;
}

/**
 * Validates a blade hit. Range, arc, cooldown, wall occlusion and the
 * post-wound protection window are all enforced here so a client can never
 * land an impossible strike.
 */
export function evaluateBladeHit(attempt: BladeAttempt): BladeRejection {
  if (attempt.cooldownRemaining > 0) return 'cooldown';

  const dx = attempt.targetX - attempt.attackerX;
  const dz = attempt.targetZ - attempt.attackerZ;
  const dist = Math.hypot(dx, dz);
  if (dist > BLADE.range) return 'outOfRange';

  if (dist > 1e-4) {
    const facingX = Math.sin(attempt.attackerYaw);
    const facingZ = Math.cos(attempt.attackerYaw);
    const cosAngle = (dx * facingX + dz * facingZ) / dist;
    if (cosAngle < Math.cos(BLADE.halfAngle)) return 'outOfArc';
  }

  if (!attempt.hasLineOfSight) return 'blocked';
  if (attempt.protectionRemaining > 0) return 'protected';
  return 'ok';
}

export interface WoundApplication {
  wound: WoundLevel;
  captured: boolean;
  protectionRemaining: number;
}

export function applyWound(current: WoundLevel): WoundApplication {
  if (isCaptureHit(current)) {
    return { wound: current, captured: true, protectionRemaining: 0 };
  }
  return {
    wound: nextWound(current),
    captured: false,
    protectionRemaining: HIT_PROTECTION,
  };
}

// ---------------------------------------------------------------------------
// Seals and gate
// ---------------------------------------------------------------------------

export function sealChannelRate(wound: WoundLevel): number {
  return channelScaleForWound(wound) / SEAL_CHANNEL_TIME;
}

export function countActiveSeals(seals: readonly SealState[]): number {
  let n = 0;
  for (const seal of seals) if (seal.active) n += 1;
  return n;
}

export function isGateUnlocked(seals: readonly SealState[]): boolean {
  return countActiveSeals(seals) >= SEALS_REQUIRED;
}

// ---------------------------------------------------------------------------
// Victory
// ---------------------------------------------------------------------------

export interface VictoryCheck {
  runnerEscaped: boolean;
  runnerCaptured: boolean;
  timeRemaining: number;
  abandonedBy: Role | null;
}

export interface VictoryVerdict {
  finished: boolean;
  outcome: MatchOutcome | null;
  winner: Role | null;
  reason: string;
}

export function evaluateVictory(check: VictoryCheck): VictoryVerdict {
  if (check.abandonedBy) {
    const winner: Role = check.abandonedBy === 'runner' ? 'hunter' : 'runner';
    return {
      finished: true,
      outcome: 'abandoned',
      winner,
      reason: `The ${check.abandonedBy} left the ritual. Match abandoned.`,
    };
  }
  if (check.runnerCaptured) {
    return {
      finished: true,
      outcome: 'runnerCaptured',
      winner: 'hunter',
      reason: 'The Hunter struck down a Cursed Runner. Captured.',
    };
  }
  if (check.runnerEscaped) {
    return {
      finished: true,
      outcome: 'runnerEscaped',
      winner: 'runner',
      reason: 'All three seals burned and the Runner slipped through the gate.',
    };
  }
  if (check.timeRemaining <= 0) {
    return {
      finished: true,
      outcome: 'hunterTimeout',
      winner: 'hunter',
      reason: 'The moon set before the Runner escaped. The Hunter holds the ruins.',
    };
  }
  return { finished: false, outcome: null, winner: null, reason: '' };
}

// ---------------------------------------------------------------------------
// Cooldowns
// ---------------------------------------------------------------------------

/** Decrements every cooldown, clamping at zero so values can never go negative. */
export function tickCooldowns(cooldowns: Record<string, number>, dt: number): void {
  for (const key of Object.keys(cooldowns)) {
    const next = cooldowns[key] - dt;
    cooldowns[key] = next > 0 ? next : 0;
  }
}

export function isReady(cooldowns: Record<string, number>, key: string): boolean {
  return (cooldowns[key] ?? 0) <= 0;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export function swapRole(role: Role): Role {
  return role === 'hunter' ? 'runner' : 'hunter';
}

/**
 * Assigns roles for a round. Round 0 uses the seed so the first assignment is
 * not always the same player; every later round swaps, so a rematch always
 * flips who hunts.
 */
export function assignRoles(playerIds: readonly string[], round: number, seed: number): Record<string, Role> {
  if (playerIds.length !== 2) {
    throw new Error(`assignRoles requires exactly 2 players, received ${playerIds.length}`);
  }
  const firstIsHunter = ((seed >>> 0) % 2 === 0) !== (round % 2 === 1);
  return {
    [playerIds[0]]: firstIsHunter ? 'hunter' : 'runner',
    [playerIds[1]]: firstIsHunter ? 'runner' : 'hunter',
  };
}
