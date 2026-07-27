/**
 * Two-client multiplayer end-to-end tests.
 *
 * Every test drives two genuinely independent browser contexts through the same
 * production build a player would run, using only the deterministic test hooks.
 */

import { expect, test } from '@playwright/test';
import {
  collectErrors,
  createRoom,
  debugForce,
  joinRoom,
  look,
  move,
  openClient,
  pagesByRole,
  pressAction,
  ready,
  setInteract,
  snapshot,
  startMatch,
  state,
  stopMoving,
  transform,
  waitForActive,
  type Client,
} from './helpers.js';

test.describe('lobby and match flow', () => {
  let host: Client;
  let guest: Client;

  test.beforeEach(async ({ browser }) => {
    host = await openClient(browser, 'host');
    guest = await openClient(browser, 'guest');
  });

  test.afterEach(async () => {
    await host?.close();
    await guest?.close();
  });

  test('two clients create and join a room, ready up, and receive opposing roles', async () => {
    const code = await createRoom(host.page, 'Ash', 12345);
    expect(code).toHaveLength(4);
    expect(code).toMatch(/^[ACDEFGHJKLMNPQRTUVWXY34679]{4}$/);

    await joinRoom(guest.page, 'Vex', code);
    expect((await state(guest.page)).roomCode).toBe(code);

    await ready(host.page);
    await ready(guest.page);
    await Promise.all([waitForActive(host.page), waitForActive(guest.page)]);

    const hostRole = (await state(host.page)).role;
    const guestRole = (await state(guest.page)).role;

    expect(hostRole).not.toBeNull();
    expect(guestRole).not.toBeNull();
    expect(hostRole).not.toBe(guestRole);
    expect(new Set([hostRole, guestRole])).toEqual(new Set(['hunter', 'runner']));

    // Both clients must agree on the world they are playing in.
    expect((await state(host.page)).seed).toBe((await state(guest.page)).seed);
  });

  test('joining a nonexistent room shows a clear error rather than hanging', async () => {
    await host.page.evaluate(() => window.__VEIL_HUNT_TEST__!.lobby.join('Ash', 'ZZZZ'));
    await host.page.waitForTimeout(1200);
    const screen = (await state(host.page)).screen;
    expect(screen).toBe('title');
    const errorText = await host.page.textContent('body');
    expect(errorText).toMatch(/room|code/i);
  });

  test('both clients receive synchronized match state', async () => {
    await startMatch(host.page, guest.page);

    const a = await snapshot(host.page);
    const b = await snapshot(guest.page);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    // Public match state must agree on both clients.
    expect(a!.sealsActivated).toBe(b!.sealsActivated);
    expect(a!.gateOpen).toBe(b!.gateOpen);
    expect(a!.seals.map((s) => s.id).sort()).toEqual(b!.seals.map((s) => s.id).sort());
    expect(Math.abs(a!.timeRemaining - b!.timeRemaining)).toBeLessThan(2);
  });

  test('movement on one client is visible to the other when in line of sight', async () => {
    const { hostRole, guestRole } = await startMatch(host.page, guest.page);
    const { hunter, runner } = pagesByRole(
      { page: host.page, role: hostRole },
      { page: guest.page, role: guestRole },
    );

    // Put them face to face so perception rules are satisfied.
    await debugForce(hunter, 'placeAdjacent');
    await hunter.waitForTimeout(400);

    await expect
      .poll(async () => (await snapshot(hunter))?.opponent.visible, { timeout: 10_000 })
      .toBe(true);

    const before = (await snapshot(hunter))!.opponent.transform!;

    // Runner strafes; the hunter's client must see the change.
    await move(runner, 1, 0, { sprint: true });
    await runner.waitForTimeout(1200);
    await stopMoving(runner);
    await hunter.waitForTimeout(400);

    const after = (await snapshot(hunter))!.opponent.transform;
    expect(after).not.toBeNull();
    const moved = Math.hypot(after!.x - before.x, after!.z - before.z);
    expect(moved).toBeGreaterThan(0.8);
  });

  test('the local player actually moves and stays inside the map', async () => {
    await startMatch(host.page, guest.page);

    // Sweep several headings and accumulate distance, so the assertion proves
    // input drives movement without depending on which way the spawn faces.
    let travelled = 0;
    let previous = (await transform(host.page))!;

    for (const yaw of [Math.PI, Math.PI / 2, 0, -Math.PI / 2]) {
      await look(host.page, yaw);
      await move(host.page, 0, 1, { sprint: true });
      await host.page.waitForTimeout(1200);
      const now = (await transform(host.page))!;
      travelled += Math.hypot(now.x - previous.x, now.z - previous.z);
      previous = now;
    }
    await stopMoving(host.page);
    await host.page.waitForTimeout(300);

    const after = (await transform(host.page))!;
    expect(travelled, 'scripted input produced no movement').toBeGreaterThan(4);
    expect(Number.isFinite(after.x) && Number.isFinite(after.z)).toBe(true);
    expect(Math.abs(after.x)).toBeLessThan(67);
    expect(Math.abs(after.z)).toBeLessThan(67);
    expect(after.y).toBeGreaterThanOrEqual(-0.01);
  });

  test('collision stops the player from leaving the playfield', async () => {
    await startMatch(host.page, guest.page);

    // Drive hard into the boundary for several seconds from a few angles.
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      await look(host.page, yaw);
      await move(host.page, 0, 1, { sprint: true });
      await host.page.waitForTimeout(2500);
    }
    await stopMoving(host.page);
    await host.page.waitForTimeout(400);

    const pos = (await transform(host.page))!;
    expect(Math.abs(pos.x)).toBeLessThanOrEqual(66);
    expect(Math.abs(pos.z)).toBeLessThanOrEqual(66);
    expect(Number.isFinite(pos.y)).toBe(true);
    // Never fall through the floor.
    expect(pos.y).toBeGreaterThanOrEqual(-0.01);
  });

  test('no console errors occur during the happy path', async () => {
    await startMatch(host.page, guest.page);
    await move(host.page, 0, 1);
    await host.page.waitForTimeout(2000);
    await stopMoving(host.page);

    const errors = collectErrors(host, guest);
    expect(errors, `unexpected errors:\n${errors.join('\n')}`).toEqual([]);

    const hookErrors = await host.page.evaluate(() => window.__VEIL_HUNT_TEST__!.errors());
    expect(hookErrors).toEqual([]);
  });
});

test.describe('combat rules', () => {
  let host: Client;
  let guest: Client;

  test.beforeEach(async ({ browser }) => {
    host = await openClient(browser, 'host');
    guest = await openClient(browser, 'guest');
  });

  test.afterEach(async () => {
    await host?.close();
    await guest?.close();
  });

  test('an invalid long-distance attack is rejected by the server', async () => {
    const { hostRole, guestRole } = await startMatch(host.page, guest.page);
    const { hunter, runner } = pagesByRole(
      { page: host.page, role: hostRole },
      { page: guest.page, role: guestRole },
    );

    await debugForce(hunter, 'separatePlayers');
    await hunter.waitForTimeout(400);
    expect((await state(runner)).wound).toBe('unmarked');

    // Swing from the far corner of the map. It must not land.
    await pressAction(hunter, 'primary');
    await hunter.waitForTimeout(1500);

    expect((await state(runner)).wound).toBe('unmarked');
  });

  test('a valid blade hit advances the wound state exactly once', async () => {
    const { hostRole, guestRole } = await startMatch(host.page, guest.page);
    const { hunter, runner } = pagesByRole(
      { page: host.page, role: hostRole },
      { page: guest.page, role: guestRole },
    );

    expect((await state(runner)).wound).toBe('unmarked');

    await debugForce(hunter, 'placeAdjacent');
    await hunter.waitForTimeout(300);
    await pressAction(hunter, 'primary');

    await expect.poll(async () => (await state(runner)).wound, { timeout: 8000 }).toBe('wounded');
  });

  test('the protection window prevents an immediate second hit', async () => {
    const { hostRole, guestRole } = await startMatch(host.page, guest.page);
    const { hunter, runner } = pagesByRole(
      { page: host.page, role: hostRole },
      { page: guest.page, role: guestRole },
    );

    await debugForce(hunter, 'placeAdjacent');
    await hunter.waitForTimeout(300);
    await pressAction(hunter, 'primary');
    await expect.poll(async () => (await state(runner)).wound, { timeout: 8000 }).toBe('wounded');

    // The protection window (3.2 s) is deliberately longer than a full blade
    // cycle (2.88 s), so there is a window where the blade is ready but the hit
    // must still be refused. Wait for exactly that window rather than guessing.
    await expect
      .poll(async () => (await state(hunter)).cooldowns?.blade ?? 1, { timeout: 8000 })
      .toBeLessThanOrEqual(0);

    const protectionLeft = (await snapshot(runner))!.self.protectionRemaining;
    expect(
      protectionLeft,
      'blade came off cooldown after protection expired; the windows no longer overlap',
    ).toBeGreaterThan(0.15);

    await debugForce(hunter, 'placeAdjacent');
    await pressAction(hunter, 'primary');
    // Long enough for the swing to resolve, short enough to stay inside the
    // protection window we just measured.
    await hunter.waitForTimeout(700);

    expect((await state(runner)).wound).toBe('wounded');
  });

  test('a third landed hit captures the Runner and the Hunter wins', async () => {
    const { hostRole, guestRole } = await startMatch(host.page, guest.page);
    const { hunter, runner } = pagesByRole(
      { page: host.page, role: hostRole },
      { page: guest.page, role: guestRole },
    );

    for (let hit = 0; hit < 3; hit += 1) {
      await debugForce(hunter, 'placeAdjacent');
      await debugForce(hunter, 'clearProtection');
      await hunter.waitForTimeout(250);
      await pressAction(hunter, 'primary');
      await hunter.waitForTimeout(3200);
      if ((await state(hunter)).screen === 'results') break;
    }

    await expect.poll(async () => (await state(hunter)).screen, { timeout: 15_000 }).toBe('results');
    await expect.poll(async () => (await state(runner)).screen, { timeout: 15_000 }).toBe('results');

    const hunterResults = await hunter.textContent('body');
    expect(hunterResults).toMatch(/hunter/i);
    expect(hunterResults).toMatch(/captur/i);
  });
});

test.describe('objectives and endings', () => {
  let host: Client;
  let guest: Client;

  test.beforeEach(async ({ browser }) => {
    host = await openClient(browser, 'host');
    guest = await openClient(browser, 'guest');
  });

  test.afterEach(async () => {
    await host?.close();
    await guest?.close();
  });

  test('the Runner can activate a seal and the Hunter receives the global cue', async () => {
    const { hostRole, guestRole } = await startMatch(host.page, guest.page);
    const { hunter, runner } = pagesByRole(
      { page: host.page, role: hostRole },
      { page: guest.page, role: guestRole },
    );

    expect((await state(runner)).sealsActivated).toBe(0);

    await debugForce(runner, 'teleportRunnerToSeal');
    await runner.waitForTimeout(500);

    await expect
      .poll(async () => (await state(runner)).prompt?.kind, { timeout: 8000 })
      .toBe('seal');

    await setInteract(runner, true);
    await expect
      .poll(async () => (await state(runner)).sealsActivated, { timeout: 25_000 })
      .toBe(1);
    await setInteract(runner, false);

    // The seal bell is map-wide: the Hunter's client must learn a seal was lit.
    await expect
      .poll(async () => (await state(hunter)).sealsActivated, { timeout: 8000 })
      .toBe(1);

    const hunterSnapshot = await snapshot(hunter);
    expect(hunterSnapshot!.banners.length + hunterSnapshot!.seals.filter((s) => s.active).length)
      .toBeGreaterThan(0);
  });

  test('the gate stays locked until all three seals burn, then opens', async () => {
    const { hostRole, guestRole } = await startMatch(host.page, guest.page);
    const { runner } = pagesByRole(
      { page: host.page, role: hostRole },
      { page: guest.page, role: guestRole },
    );

    expect((await state(runner)).gateOpen).toBe(false);

    // Standing at a locked gate must report it as blocked, not silently do nothing.
    await debugForce(runner, 'teleportRunnerToGate');
    await runner.waitForTimeout(600);
    const lockedPrompt = (await state(runner)).prompt;
    expect(lockedPrompt?.kind).toBe('gate');
    expect(lockedPrompt?.blocked).toBe(true);

    await setInteract(runner, true);
    await runner.waitForTimeout(2500);
    await setInteract(runner, false);
    expect((await state(runner)).gateOpen).toBe(false);

    await debugForce(runner, 'activateAllSeals');
    await expect.poll(async () => (await state(runner)).gateOpen, { timeout: 8000 }).toBe(true);
    await expect.poll(async () => (await state(runner)).sealsActivated, { timeout: 8000 }).toBe(3);
  });

  test('the Runner escapes through the open gate and both clients see the result', async () => {
    const { hostRole, guestRole } = await startMatch(host.page, guest.page);
    const { hunter, runner } = pagesByRole(
      { page: host.page, role: hostRole },
      { page: guest.page, role: guestRole },
    );

    await debugForce(runner, 'activateAllSeals');
    await debugForce(runner, 'teleportRunnerToGate');
    await expect.poll(async () => (await state(runner)).gateOpen, { timeout: 8000 }).toBe(true);
    await runner.waitForTimeout(400);

    await setInteract(runner, true);
    await expect.poll(async () => (await state(runner)).screen, { timeout: 25_000 }).toBe('results');
    await setInteract(runner, false);

    await expect.poll(async () => (await state(hunter)).screen, { timeout: 10_000 }).toBe('results');

    const runnerText = await runner.textContent('body');
    const hunterText = await hunter.textContent('body');
    expect(runnerText).toMatch(/runner/i);
    expect(runnerText).toMatch(/escap|gate/i);
    // Results must be synchronised: both see the same winner.
    expect(hunterText).toMatch(/runner/i);
  });

  test('the Hunter wins when the clock runs out', async () => {
    const { hostRole, guestRole } = await startMatch(host.page, guest.page);
    const { hunter, runner } = pagesByRole(
      { page: host.page, role: hostRole },
      { page: guest.page, role: guestRole },
    );

    await debugForce(hunter, 'setTimeRemaining', 1);
    await expect.poll(async () => (await state(hunter)).screen, { timeout: 20_000 }).toBe('results');
    await expect.poll(async () => (await state(runner)).screen, { timeout: 10_000 }).toBe('results');

    const text = await hunter.textContent('body');
    expect(text).toMatch(/hunter/i);
    expect(text).toMatch(/moon|time|clock/i);
  });

  test('a rematch swaps the roles', async () => {
    const { hostRole, guestRole } = await startMatch(host.page, guest.page);

    await debugForce(host.page, 'setTimeRemaining', 1);
    await expect.poll(async () => (await state(host.page)).screen, { timeout: 20_000 }).toBe('results');
    await expect.poll(async () => (await state(guest.page)).screen, { timeout: 10_000 }).toBe('results');

    await host.page.evaluate(() => window.__VEIL_HUNT_TEST__!.lobby.rematch());
    await guest.page.evaluate(() => window.__VEIL_HUNT_TEST__!.lobby.rematch());

    await Promise.all([waitForActive(host.page), waitForActive(guest.page)]);

    const newHostRole = (await state(host.page)).role;
    const newGuestRole = (await state(guest.page)).role;

    expect(newHostRole).not.toBe(hostRole);
    expect(newGuestRole).not.toBe(guestRole);
    expect(newHostRole).not.toBe(newGuestRole);
  });
});

test.describe('disconnect resilience', () => {
  test('a disconnected client produces a clear state rather than crashing the match', async ({
    browser,
  }) => {
    const host = await openClient(browser, 'host');
    const guest = await openClient(browser, 'guest');

    try {
      await startMatch(host.page, guest.page);

      // Hard-close the guest's context: the socket dies with it.
      await guest.close();

      // The surviving client must stay alive, keep rendering, and end cleanly.
      await host.page.waitForTimeout(2500);
      const mid = await state(host.page);
      expect(['match', 'pause', 'results']).toContain(mid.screen);
      expect(mid.frames).toBeGreaterThan(0);

      const framesBefore = mid.frames;
      await host.page.waitForTimeout(1500);
      expect((await state(host.page)).frames).toBeGreaterThan(framesBefore);

      // Eventually the grace period expires and the match resolves.
      await expect
        .poll(async () => (await state(host.page)).screen, { timeout: 70_000 })
        .toBe('results');

      const errors = host.errors.filter((e) => !/websocket|socket|transport|xhr poll/i.test(e));
      expect(errors, `unexpected errors:\n${errors.join('\n')}`).toEqual([]);
    } finally {
      await host.close();
    }
  });
});
