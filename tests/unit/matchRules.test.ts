import { describe, expect, it } from 'vitest';
import {
  applyWound,
  assignRoles,
  countActiveSeals,
  evaluateBladeHit,
  evaluateVictory,
  isCaptureHit,
  isGateUnlocked,
  nextWound,
  previousWound,
  speedScaleForWound,
  channelScaleForWound,
  swapRole,
  tickCooldowns,
  woundIndex,
} from '../../src/shared/matchRules.js';
import { BLADE, HIT_PROTECTION, SEALS_REQUIRED } from '../../src/shared/constants.js';
import type { SealState } from '../../src/shared/types.js';

function seals(activeFlags: boolean[]): SealState[] {
  return activeFlags.map((active, i) => ({
    id: i + 1,
    x: 0,
    z: 0,
    area: `Area ${i}`,
    progress: active ? 1 : 0,
    active,
  }));
}

describe('wound progression', () => {
  it('escalates unmarked -> wounded -> cursed and stops there', () => {
    expect(nextWound('unmarked')).toBe('wounded');
    expect(nextWound('wounded')).toBe('cursed');
    expect(nextWound('cursed')).toBe('cursed');
  });

  it('captures only on a hit against a Cursed runner', () => {
    expect(isCaptureHit('unmarked')).toBe(false);
    expect(isCaptureHit('wounded')).toBe(false);
    expect(isCaptureHit('cursed')).toBe(true);
  });

  it('keeps the protection window longer than a full blade cycle', () => {
    // Otherwise the Hunter could chain two wounds from one engagement.
    const fullCycle = BLADE.windup + BLADE.active + BLADE.recovery + BLADE.cooldown;
    expect(HIT_PROTECTION).toBeGreaterThan(fullCycle);
  });

  it('grants a protection window on every non-capturing wound', () => {
    const first = applyWound('unmarked');
    expect(first.wound).toBe('wounded');
    expect(first.captured).toBe(false);
    expect(first.protectionRemaining).toBe(HIT_PROTECTION);

    const second = applyWound('wounded');
    expect(second.wound).toBe('cursed');
    expect(second.protectionRemaining).toBe(HIT_PROTECTION);

    const third = applyWound('cursed');
    expect(third.captured).toBe(true);
  });

  it('heals exactly one level at the shrine', () => {
    expect(previousWound('cursed')).toBe('wounded');
    expect(previousWound('wounded')).toBe('unmarked');
    expect(previousWound('unmarked')).toBe('unmarked');
  });

  it('slows channels more than movement as wounds escalate', () => {
    expect(channelScaleForWound('unmarked')).toBe(1);
    expect(channelScaleForWound('wounded')).toBeLessThan(1);
    expect(channelScaleForWound('cursed')).toBeLessThan(channelScaleForWound('wounded'));

    // Movement must stay playable even while Cursed.
    expect(speedScaleForWound('cursed')).toBeGreaterThan(0.9);
    expect(woundIndex('cursed')).toBe(2);
  });
});

describe('blade validation', () => {
  const base = {
    attackerX: 0,
    attackerZ: 0,
    attackerYaw: 0, // facing +Z
    targetX: 0,
    targetZ: 2,
    cooldownRemaining: 0,
    protectionRemaining: 0,
    hasLineOfSight: true,
  };

  it('accepts a hit in range, in arc, with line of sight', () => {
    expect(evaluateBladeHit(base)).toBe('ok');
  });

  it('rejects a long-distance attack', () => {
    expect(evaluateBladeHit({ ...base, targetZ: BLADE.range + 0.5 })).toBe('outOfRange');
    expect(evaluateBladeHit({ ...base, targetX: 40, targetZ: 40 })).toBe('outOfRange');
  });

  it('rejects a hit behind the attacker', () => {
    expect(evaluateBladeHit({ ...base, targetZ: -2 })).toBe('outOfArc');
  });

  it('rejects a hit through a wall', () => {
    expect(evaluateBladeHit({ ...base, hasLineOfSight: false })).toBe('blocked');
  });

  it('rejects a hit while the swing is on cooldown', () => {
    expect(evaluateBladeHit({ ...base, cooldownRemaining: 0.4 })).toBe('cooldown');
  });

  it('rejects a second hit inside the protection window', () => {
    expect(evaluateBladeHit({ ...base, protectionRemaining: 1.2 })).toBe('protected');
  });

  it('honours the exact arc boundary', () => {
    const justInside = BLADE.halfAngle - 0.02;
    const justOutside = BLADE.halfAngle + 0.02;
    const at = (angle: number) => ({
      ...base,
      targetX: Math.sin(angle) * 2,
      targetZ: Math.cos(angle) * 2,
    });
    expect(evaluateBladeHit(at(justInside))).toBe('ok');
    expect(evaluateBladeHit(at(justOutside))).toBe('outOfArc');
  });
});

describe('seals and gate', () => {
  it('keeps the gate locked until every seal is lit', () => {
    expect(isGateUnlocked(seals([false, false, false]))).toBe(false);
    expect(isGateUnlocked(seals([true, false, false]))).toBe(false);
    expect(isGateUnlocked(seals([true, true, false]))).toBe(false);
    expect(isGateUnlocked(seals([true, true, true]))).toBe(true);
  });

  it('counts active seals', () => {
    expect(countActiveSeals(seals([true, false, true]))).toBe(2);
    expect(SEALS_REQUIRED).toBe(3);
  });
});

describe('victory conditions', () => {
  const base = { runnerEscaped: false, runnerCaptured: false, timeRemaining: 100, abandonedBy: null };

  it('does not finish while the match is live', () => {
    expect(evaluateVictory(base).finished).toBe(false);
  });

  it('gives the Runner the win on escape', () => {
    const verdict = evaluateVictory({ ...base, runnerEscaped: true });
    expect(verdict.finished).toBe(true);
    expect(verdict.winner).toBe('runner');
    expect(verdict.outcome).toBe('runnerEscaped');
    expect(verdict.reason).toMatch(/gate/i);
  });

  it('gives the Hunter the win on capture', () => {
    const verdict = evaluateVictory({ ...base, runnerCaptured: true });
    expect(verdict.winner).toBe('hunter');
    expect(verdict.outcome).toBe('runnerCaptured');
  });

  it('gives the Hunter the win when time expires', () => {
    const verdict = evaluateVictory({ ...base, timeRemaining: 0 });
    expect(verdict.winner).toBe('hunter');
    expect(verdict.outcome).toBe('hunterTimeout');
  });

  it('prefers capture over a simultaneous timeout', () => {
    const verdict = evaluateVictory({ ...base, runnerCaptured: true, timeRemaining: 0 });
    expect(verdict.outcome).toBe('runnerCaptured');
  });

  it('awards the win to whoever stayed when a player abandons', () => {
    expect(evaluateVictory({ ...base, abandonedBy: 'runner' }).winner).toBe('hunter');
    expect(evaluateVictory({ ...base, abandonedBy: 'hunter' }).winner).toBe('runner');
  });
});

describe('cooldowns', () => {
  it('never lets a cooldown go negative', () => {
    const cooldowns = { blade: 0.1, pulse: 5, snare: 0 };
    tickCooldowns(cooldowns, 1);
    expect(cooldowns.blade).toBe(0);
    expect(cooldowns.snare).toBe(0);
    expect(cooldowns.pulse).toBeCloseTo(4);

    for (let i = 0; i < 100; i += 1) tickCooldowns(cooldowns, 1);
    for (const value of Object.values(cooldowns)) expect(value).toBe(0);
  });
});

describe('role assignment', () => {
  it('always assigns exactly one Hunter and one Runner', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const roles = assignRoles(['a', 'b'], 0, seed);
      const values = Object.values(roles);
      expect(values).toHaveLength(2);
      expect(values.filter((r) => r === 'hunter')).toHaveLength(1);
      expect(values.filter((r) => r === 'runner')).toHaveLength(1);
    }
  });

  it('swaps roles on every subsequent round', () => {
    const seed = 4242;
    const round0 = assignRoles(['a', 'b'], 0, seed);
    const round1 = assignRoles(['a', 'b'], 1, seed);
    const round2 = assignRoles(['a', 'b'], 2, seed);

    expect(round1.a).toBe(swapRole(round0.a));
    expect(round1.b).toBe(swapRole(round0.b));
    expect(round2.a).toBe(round0.a);
  });

  it('is deterministic for the same seed and round', () => {
    expect(assignRoles(['a', 'b'], 3, 99)).toEqual(assignRoles(['a', 'b'], 3, 99));
  });

  it('rejects a player count other than two', () => {
    expect(() => assignRoles(['a'], 0, 1)).toThrow();
    expect(() => assignRoles(['a', 'b', 'c'], 0, 1)).toThrow();
  });
});
