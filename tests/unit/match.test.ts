/**
 * Integration tests for the authoritative match: these drive the real `Match`
 * class the server runs, so they cover the actual decision code rather than a
 * reimplementation of it.
 */

import { describe, expect, it } from 'vitest';
import { Match } from '../../src/server/Match.js';
import { Bot } from '../../src/server/Bot.js';
import { RoomManager } from '../../src/server/RoomManager.js';
import {
  BLADE,
  CROSSBOW,
  HIT_PROTECTION,
  MATCH_DURATION,
  SEAL_CHANNEL_TIME,
  TICK_DT,
} from '../../src/shared/constants.js';
import type { ActionCommand, InputCommand } from '../../src/shared/types.js';

function makeMatch(seed = 12345) {
  return new Match({
    seed,
    round: 0,
    players: [
      { id: 'H', name: 'Hunter', role: 'hunter', isBot: false },
      { id: 'R', name: 'Runner', role: 'runner', isBot: false },
    ],
  });
}

function idle(seq: number, yaw = 0): InputCommand {
  return { seq, dt: TICK_DT, mx: 0, mz: 0, yaw, pitch: 0, sprint: false, crouch: false, vault: false };
}

function act(kind: ActionCommand['kind'], yaw = 0): ActionCommand {
  return { kind, yaw, pitch: 0, seq: 1 };
}

/** Runs `seconds` of simulation. */
function run(match: Match, seconds: number): void {
  const steps = Math.round(seconds / TICK_DT);
  for (let i = 0; i < steps; i += 1) match.tick(TICK_DT);
}

function state(match: Match) {
  return match.debugState() as {
    phase: string;
    timeRemaining: number;
    seals: { id: number; active: boolean; progress: number }[];
    gateOpen: boolean;
    gateProgress: number;
    captured: boolean;
    escaped: boolean;
    entityCounts: Record<string, number>;
    players: { id: string; role: string; wound: string; x: number; y: number; z: number; cooldowns: Record<string, number> }[];
  };
}

/** Places both players adjacent so blade tests have a legal target. */
function placeAdjacent(match: Match): void {
  const hunter = match.getMotion('H')!;
  const runner = match.getMotion('R')!;
  runner.x = 0;
  runner.z = 44;
  runner.y = 0;
  hunter.x = 0;
  hunter.z = 42.2;
  hunter.y = 0;
  hunter.yaw = 0; // facing +Z, toward the runner
}

describe('match lifecycle', () => {
  it('starts in countdown and refuses movement until it ends', () => {
    const match = makeMatch();
    expect(state(match).phase).toBe('countdown');

    const runner = match.getMotion('R')!;
    const startX = runner.x;
    const startZ = runner.z;

    match.enqueueInput('R', [{ ...idle(1), mz: 1 }]);
    run(match, 0.5);
    expect(runner.x).toBeCloseTo(startX, 4);
    expect(runner.z).toBeCloseTo(startZ, 4);

    match.debugForce({ kind: 'skipCountdown' });
    expect(state(match).phase).toBe('active');
  });

  it('runs the clock down and gives the Hunter a timeout victory', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    match.debugForce({ kind: 'setTimeRemaining', value: 0.5 });
    run(match, 1);

    expect(match.isFinished).toBe(true);
    expect(match.matchResult?.outcome).toBe('hunterTimeout');
    expect(match.matchResult?.winner).toBe('hunter');
    expect(match.matchResult?.reason).toBeTruthy();
  });

  it('starts with the full seven-minute clock', () => {
    const match = makeMatch();
    expect(state(match).timeRemaining).toBe(MATCH_DURATION);
  });
});

describe('movement authority', () => {
  it('moves the runner forward when input is applied', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    const runner = match.getMotion('R')!;
    const startX = runner.x;
    const startZ = runner.z;

    // Yaw PI faces north, the deliberately open heading from the Runner spawn.
    for (let i = 1; i <= 30; i += 1) {
      match.enqueueInput('R', [{ ...idle(i, Math.PI), mz: 1 }]);
      match.tick(TICK_DT);
    }

    expect(runner.z).toBeLessThan(startZ - 1);
    expect(Math.hypot(runner.x - startX, runner.z - startZ)).toBeGreaterThan(1.5);
  });

  it('ignores replayed input sequences so a client cannot double-move', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    const runner = match.getMotion('R')!;

    const command = { ...idle(1, Math.PI), mz: 1 };
    const start = { x: runner.x, z: runner.z };

    match.enqueueInput('R', [command]);
    match.tick(TICK_DT);
    const firstStep = Math.hypot(runner.x - start.x, runner.z - start.z);
    const afterFirst = { x: runner.x, z: runner.z };

    // Replaying the same sequence number must be discarded, so this tick only
    // carries residual velocity — never a second full acceleration step.
    match.enqueueInput('R', [command]);
    match.tick(TICK_DT);
    const secondStep = Math.hypot(runner.x - afterFirst.x, runner.z - afterFirst.z);

    expect(firstStep).toBeGreaterThan(0);
    expect(secondStep).toBeLessThan(firstStep * 1.05);
  });

  it('never produces NaN transforms under sustained random input', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    let seq = 1;
    for (let i = 0; i < 900; i += 1) {
      const yaw = (i * 0.37) % (Math.PI * 2);
      match.enqueueInput('R', [
        { seq: seq++, dt: TICK_DT, mx: Math.sin(i), mz: Math.cos(i), yaw, pitch: 0, sprint: i % 3 === 0, crouch: i % 7 === 0, vault: i % 11 === 0 },
      ]);
      match.tick(TICK_DT);
    }
    for (const p of state(match).players) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });
});

describe('blade, wounds and protection', () => {
  it('advances the wound state exactly once per valid hit', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    placeAdjacent(match);

    expect(state(match).players.find((p) => p.role === 'runner')!.wound).toBe('unmarked');

    match.handleAction('H', act('primary'));
    run(match, BLADE.windup + BLADE.active + 0.05);

    expect(state(match).players.find((p) => p.role === 'runner')!.wound).toBe('wounded');
  });

  it('blocks a second hit inside the protection window', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    placeAdjacent(match);

    match.handleAction('H', act('primary'));
    run(match, BLADE.windup + BLADE.active + 0.05);
    expect(state(match).players.find((p) => p.role === 'runner')!.wound).toBe('wounded');

    // Wait out only the swing cooldown, not the protection window.
    run(match, BLADE.recovery + BLADE.cooldown + 0.05);
    placeAdjacent(match);
    match.handleAction('H', act('primary'));
    run(match, BLADE.windup + BLADE.active + 0.05);

    // Still wounded: the protection window absorbed the second strike.
    expect(state(match).players.find((p) => p.role === 'runner')!.wound).toBe('wounded');
    expect(HIT_PROTECTION).toBeGreaterThan(BLADE.recovery + BLADE.cooldown);
  });

  it('rejects an attack from impossible range', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    const hunter = match.getMotion('H')!;
    const runner = match.getMotion('R')!;
    runner.x = 0;
    runner.z = 44;
    hunter.x = 0;
    hunter.z = 0; // 44 units away
    hunter.yaw = 0;

    match.handleAction('H', act('primary'));
    run(match, BLADE.windup + BLADE.active + 0.05);
    expect(state(match).players.find((p) => p.role === 'runner')!.wound).toBe('unmarked');
  });

  it('captures on the third landed hit and ends the match', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });

    for (let hit = 0; hit < 3; hit += 1) {
      placeAdjacent(match);
      match.handleAction('H', act('primary'));
      run(match, BLADE.windup + BLADE.active + 0.05);
      if (match.isFinished) break;
      // Wait out the protection window before the next swing.
      run(match, HIT_PROTECTION + 0.2);
    }

    expect(match.isFinished).toBe(true);
    expect(match.matchResult?.outcome).toBe('runnerCaptured');
    expect(match.matchResult?.winner).toBe('hunter');
  });

  it('enforces the blade cooldown', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    placeAdjacent(match);

    match.handleAction('H', act('primary'));
    match.tick(TICK_DT);
    const cooldown = state(match).players.find((p) => p.role === 'hunter')!.cooldowns.blade;
    expect(cooldown).toBeGreaterThan(0);

    // A second swing while cooling must not reset or stack the timer.
    match.handleAction('H', act('primary'));
    match.tick(TICK_DT);
    const after = state(match).players.find((p) => p.role === 'hunter')!.cooldowns.blade;
    expect(after).toBeLessThan(cooldown);
  });
});

describe('seals and the gate', () => {
  it('keeps the gate locked and channelling blocked until all seals are lit', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    expect(state(match).gateOpen).toBe(false);

    match.debugForce({ kind: 'teleportRunnerToGate' });
    match.handleAction('R', act('interact'));
    run(match, 8);

    expect(state(match).gateOpen).toBe(false);
    expect(state(match).escaped).toBe(false);
  });

  it('lights a seal after the full channel and opens the gate on the third', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });

    const seals = state(match).seals;
    const runner = match.getMotion('R')!;
    const first = match.map.sealAnchors.find((a) => a.id === seals[0].id)!;
    runner.x = first.x;
    runner.z = first.z;
    runner.y = 0;

    match.handleAction('R', act('interact'));
    run(match, SEAL_CHANNEL_TIME + 0.4);

    const after = state(match);
    expect(after.seals.find((s) => s.id === seals[0].id)!.active).toBe(true);
    expect(after.gateOpen).toBe(false);

    match.debugForce({ kind: 'activateAllSeals' });
    expect(state(match).gateOpen).toBe(true);
  });

  it('decays seal progress when the Runner stops channelling', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    const seals = state(match).seals;
    const runner = match.getMotion('R')!;
    const anchor = match.map.sealAnchors.find((a) => a.id === seals[0].id)!;
    runner.x = anchor.x;
    runner.z = anchor.z;

    match.handleAction('R', act('interact'));
    run(match, 2);
    const peak = state(match).seals[0].progress;
    expect(peak).toBeGreaterThan(0.1);

    match.handleAction('R', act('interactStop'));
    run(match, 2);
    expect(state(match).seals[0].progress).toBeLessThan(peak);
  });

  it('lets the Runner escape once the gate is open, ending the match', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    match.debugForce({ kind: 'activateAllSeals' });
    match.debugForce({ kind: 'teleportRunnerToGate' });

    match.handleAction('R', act('interact'));
    run(match, 9);

    expect(match.isFinished).toBe(true);
    expect(match.matchResult?.outcome).toBe('runnerEscaped');
    expect(match.matchResult?.winner).toBe('runner');
    expect(match.matchResult?.stats.sealsActivated).toBeGreaterThanOrEqual(0);
  });
});

describe('crossbow marking', () => {
  it('marks the Runner and expires after the mark duration', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });

    const hunter = match.getMotion('H')!;
    const runner = match.getMotion('R')!;
    runner.x = 0;
    runner.z = 44;
    hunter.x = 0;
    hunter.z = 38;
    hunter.yaw = 0;
    hunter.pitch = 0;

    match.handleAction('H', act('secondary'));
    run(match, 0.6);

    const marked = match.buildSnapshot('H')!;
    expect(marked.opponent.markedTrail).not.toBeNull();

    run(match, CROSSBOW.markDuration + 0.5);
    const expired = match.buildSnapshot('H')!;
    expect(expired.opponent.markedTrail).toBeNull();
  });

  it('consumes ammunition and reloads', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    const hunter = match.getMotion('H')!;
    hunter.pitch = 0.5; // shoot into the air so nothing is hit

    for (let i = 0; i < CROSSBOW.maxBolts; i += 1) {
      match.handleAction('H', act('secondary'));
      run(match, CROSSBOW.fireCooldown + 0.05);
    }
    expect(match.buildSnapshot('H')!.self.bolts).toBe(0);

    run(match, CROSSBOW.reloadTime + 0.4);
    expect(match.buildSnapshot('H')!.self.bolts).toBe(CROSSBOW.maxBolts);
  });
});

describe('information hiding', () => {
  it('never sends the Runner transform to the Hunter through a wall', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });

    const hunter = match.getMotion('H')!;
    const runner = match.getMotion('R')!;
    // Opposite corners of the map: far apart and definitely occluded.
    hunter.x = -55;
    hunter.z = -55;
    runner.x = 55;
    runner.z = 55;

    const snapshot = match.buildSnapshot('H')!;
    expect(snapshot.opponent.visible).toBe(false);
    expect(snapshot.opponent.transform).toBeNull();
  });

  it('sends the transform when the two players are face to face', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    placeAdjacent(match);

    const snapshot = match.buildSnapshot('H')!;
    expect(snapshot.opponent.visible).toBe(true);
    expect(snapshot.opponent.transform).not.toBeNull();
  });

  it('hides the Hunter snares from the Runner until they fire', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    match.handleAction('H', act('ability2'));
    run(match, 0.2);

    expect(match.buildSnapshot('H')!.snares.length).toBe(1);
    expect(match.buildSnapshot('R')!.snares.length).toBe(0);
  });

  it('hides the Runner wards from the Hunter until they fire', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    match.handleAction('R', act('secondary'));
    run(match, 0.2);

    expect(match.buildSnapshot('R')!.wards.length).toBe(1);
    expect(match.buildSnapshot('H')!.wards.length).toBe(0);
  });

  it('only sends revealed footprint traces to the Hunter', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    match.handleAction('H', act('ability1'));
    run(match, 0.2);

    expect(match.buildSnapshot('R')!.revealedTraces).toHaveLength(0);
    expect(match.buildSnapshot('R')!.pulse).toBeNull();
  });
});

describe('disconnect handling', () => {
  it('ends the match and awards the win to the player who stayed', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    match.abandon('runner');

    expect(match.isFinished).toBe(true);
    expect(match.matchResult?.outcome).toBe('abandoned');
    expect(match.matchResult?.winner).toBe('hunter');
  });

  it('keeps simulating safely after a player disconnects', () => {
    const match = makeMatch();
    match.debugForce({ kind: 'skipCountdown' });
    match.setConnected('R', false);
    expect(() => run(match, 3)).not.toThrow();
    for (const p of state(match).players) expect(Number.isFinite(p.x)).toBe(true);
  });
});

describe('bot soak', () => {
  it('plays a full match without NaN, escapes or unbounded entity growth', () => {
    const match = makeMatch(424242);
    const bots = [new Bot('H', 'HunterBot', 424242), new Bot('R', 'RunnerBot', 424243)];

    let maxEntities = 0;
    let ticks = 0;
    while (!match.isFinished && ticks < 30 * 60 * 8) {
      for (const bot of bots) {
        const { input, actions } = bot.update(match, TICK_DT);
        match.enqueueInput(bot.id, [input]);
        for (const action of actions) match.handleAction(bot.id, action);
      }
      match.tick(TICK_DT);
      ticks += 1;

      if (ticks % 30 === 0) {
        const s = state(match);
        const total = Object.values(s.entityCounts).reduce((a, b) => a + b, 0);
        maxEntities = Math.max(maxEntities, total);
        for (const p of s.players) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
          expect(Math.abs(p.x)).toBeLessThanOrEqual(67);
          expect(Math.abs(p.z)).toBeLessThanOrEqual(67);
          for (const value of Object.values(p.cooldowns)) expect(value).toBeGreaterThanOrEqual(0);
        }
      }
    }

    expect(match.isFinished).toBe(true);
    expect(match.matchResult).not.toBeNull();
    // Pools are bounded; a leak would blow far past this.
    expect(maxEntities).toBeLessThan(300);
  }, 30_000);

  it('makes real objective progress when a bot plays the Runner', () => {
    // A scripted sweep must be able to find and light at least one seal,
    // otherwise the objective is unreachable or unreadable.
    let bestSeals = 0;
    for (const seed of [424242, 12345, 777]) {
      const match = makeMatch(seed);
      const bots = [new Bot('H', 'HunterBot', seed), new Bot('R', 'RunnerBot', seed + 1)];
      let ticks = 0;
      while (!match.isFinished && ticks < 30 * 60 * 8) {
        for (const bot of bots) {
          const { input, actions } = bot.update(match, TICK_DT);
          match.enqueueInput(bot.id, [input]);
          for (const action of actions) match.handleAction(bot.id, action);
        }
        match.tick(TICK_DT);
        ticks += 1;
      }
      const lit = state(match).seals.filter((s) => s.active).length;
      bestSeals = Math.max(bestSeals, lit);
    }
    expect(bestSeals).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

describe('room manager', () => {
  function makeManager() {
    const events = {
      roomUpdates: 0,
      roleReveals: 0,
      matchStarts: 0,
      matchEnds: 0,
      left: 0,
      returned: 0,
    };
    const manager = new RoomManager(
      {
        onRoomUpdate: () => {
          events.roomUpdates += 1;
        },
        onRoleReveal: () => {
          events.roleReveals += 1;
        },
        onMatchStart: () => {
          events.matchStarts += 1;
        },
        onMatchEnd: () => {
          events.matchEnds += 1;
        },
        onOpponentLeft: () => {
          events.left += 1;
        },
        onOpponentReturned: () => {
          events.returned += 1;
        },
      },
      99,
    );
    return { manager, events };
  }

  it('creates a room with a readable code and one host', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('s1', 'Ash');
    expect(room.code).toHaveLength(4);
    expect(room.players).toHaveLength(1);
    expect(room.players[0].isHost).toBe(true);
    expect(room.phase).toBe('lobby');
  });

  it('rejects joining an unknown room and a full room', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('s1', 'Ash');
    expect(manager.joinRoom('s2', 'Vex', 'ZZZZ')).toEqual({ error: 'ROOM_NOT_FOUND' });
    expect(manager.joinRoom('s2', 'Vex', room.code)).toHaveProperty('room');
    expect(manager.joinRoom('s3', 'Third', room.code)).toEqual({ error: 'ROOM_FULL' });
  });

  it('assigns opposing roles once both players ready up', () => {
    const { manager, events } = makeManager();
    const room = manager.createRoom('s1', 'Ash');
    manager.joinRoom('s2', 'Vex', room.code);
    manager.setReady('s1', true);
    manager.setReady('s2', true);

    expect(events.roleReveals).toBe(1);
    expect(room.phase).toBe('roleReveal');
    const roles = room.players.map((p) => p.role);
    expect(new Set(roles)).toEqual(new Set(['hunter', 'runner']));
  });

  it('swaps roles on rematch', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('s1', 'Ash');
    manager.joinRoom('s2', 'Vex', room.code);
    manager.setReady('s1', true);
    manager.setReady('s2', true);

    const before = new Map(room.players.map((p) => [p.id, p.role]));

    // Advance past role reveal into the match, then end it.
    manager.update(10);
    expect(room.match).not.toBeNull();
    room.match!.abandon('runner');
    manager.update(0.05);
    expect(room.phase).toBe('results');

    manager.voteRematch('s1');
    manager.voteRematch('s2');

    expect(room.round).toBe(1);
    for (const player of room.players) {
      expect(player.role).not.toBe(before.get(player.id));
    }
  });

  it('cleans up a lobby disconnect immediately', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('s1', 'Ash');
    manager.joinRoom('s2', 'Vex', room.code);
    expect(room.players).toHaveLength(2);

    manager.handleDisconnect('s2');
    expect(room.players).toHaveLength(1);
    expect(room.players[0].isHost).toBe(true);
  });

  it('holds an in-match disconnect open for a grace period, then ends the match', () => {
    const { manager, events } = makeManager();
    const room = manager.createRoom('s1', 'Ash');
    manager.joinRoom('s2', 'Vex', room.code);
    manager.setReady('s1', true);
    manager.setReady('s2', true);
    manager.update(10);
    expect(room.match).not.toBeNull();

    manager.handleDisconnect('s2');
    expect(events.left).toBe(1);
    expect(room.players).toHaveLength(2); // slot preserved for reconnect
    expect(room.phase).not.toBe('results');

    manager.update(60);
    expect(room.phase).toBe('results');
    expect(events.matchEnds).toBe(1);
  });

  it('lets a disconnected player reclaim their slot within the grace window', () => {
    const { manager, events } = makeManager();
    const room = manager.createRoom('s1', 'Ash');
    manager.joinRoom('s2', 'Vex', room.code);
    manager.setReady('s1', true);
    manager.setReady('s2', true);
    manager.update(10);

    manager.handleDisconnect('s2');
    manager.update(2);
    const result = manager.joinRoom('s2b', 'Vex', room.code);

    expect(result).toHaveProperty('room');
    expect(events.returned).toBe(1);
    expect(room.players.find((p) => p.name === 'Vex')?.connected).toBe(true);
    expect(room.phase).not.toBe('results');
  });

  it('adds a bot that fills the second slot and starts a match', () => {
    const { manager } = makeManager();
    manager.createRoom('s1', 'Ash');
    const room = manager.addBot('s1');
    expect(room).not.toBeNull();
    expect(room!.players).toHaveLength(2);
    expect(room!.bot).not.toBeNull();

    manager.setReady('s1', true);
    expect(room!.phase).toBe('roleReveal');
    manager.update(10);
    expect(room!.match).not.toBeNull();
    expect(() => manager.update(1)).not.toThrow();
  });
});
