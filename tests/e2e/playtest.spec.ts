/**
 * Bot playtest and render health.
 *
 * A game that renders beautifully but cannot be progressed by scripted input is
 * not release-ready. This drives a long scripted session through the real client
 * and asserts the loop stays healthy: frames advance, transforms stay finite and
 * in-bounds, cooldowns never go negative, entity counts stay bounded, and the
 * canvas keeps producing non-blank frames.
 */

import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createRoom,
  move,
  openClient,
  look,
  state,
  snapshot,
  stopMoving,
  transform,
  waitForActive,
  type Client,
} from './helpers.js';

const ARTIFACTS = path.resolve('artifacts/playtest');

test.describe('bot playtest', () => {
  test('a scripted session sustains a healthy loop for 60 seconds', async ({ browser }) => {
    test.setTimeout(180_000);
    const client: Client = await openClient(browser, 'playtest');

    try {
      await createRoom(client.page, 'Playtest', 12345);
      // The practice bot fills the other slot, so this exercises a real match.
      await client.page.evaluate(() => window.__VEIL_HUNT_TEST__!.lobby.addBot());
      await client.page.waitForTimeout(400);
      await client.page.evaluate(() => window.__VEIL_HUNT_TEST__!.lobby.ready(true));
      await waitForActive(client.page);

      const samples: {
        t: number;
        x: number;
        y: number;
        z: number;
        frames: number;
        timeRemaining: number;
        minCooldown: number;
        entityTotal: number;
        nonBlank: boolean;
        pendingInputs: number;
        geometries: number;
        textures: number;
      }[] = [];

      // A sweeping script: rotate through headings, sprint, crouch, vault and
      // fire abilities so every subsystem gets exercised.
      const headings = [0, 0.9, 1.9, 2.8, -2.5, -1.6, -0.7];
      const abilities = ['ability1', 'ability2', 'primary', 'secondary', 'reload'];
      const steps = 30;

      for (let step = 0; step < steps; step += 1) {
        await look(client.page, headings[step % headings.length]);
        await move(client.page, step % 5 === 0 ? 1 : 0, 1, {
          sprint: step % 3 === 0,
          crouch: step % 7 === 0,
        });
        if (step % 4 === 0) {
          await client.page.evaluate(() => window.__VEIL_HUNT_TEST__!.input.vault());
        }
        if (step % 3 === 1) {
          const kind = abilities[step % abilities.length];
          await client.page.evaluate((k) => window.__VEIL_HUNT_TEST__!.input.action(k), kind);
        }
        if (step % 6 === 2) {
          await client.page.evaluate(() => window.__VEIL_HUNT_TEST__!.input.interact(true));
        }
        if (step % 6 === 4) {
          await client.page.evaluate(() => window.__VEIL_HUNT_TEST__!.input.interact(false));
        }

        await client.page.waitForTimeout(2000);

        const reading = await client.page.evaluate(() => {
          const api = window.__VEIL_HUNT_TEST__!;
          const s = api.state();
          const snap = api.snapshot();
          const t = api.transform();
          const cooldowns = s.cooldowns ?? {};
          const entities = snap
            ? snap.decoys.length +
              snap.smokes.length +
              snap.wards.length +
              snap.snares.length +
              snap.bolts.length +
              snap.revealedTraces.length +
              snap.banners.length
            : 0;
          const renderer = api.renderer();
          const net = api.net();
          return {
            x: t?.x ?? Number.NaN,
            y: t?.y ?? Number.NaN,
            z: t?.z ?? Number.NaN,
            frames: s.frames,
            timeRemaining: s.timeRemaining ?? Number.NaN,
            minCooldown: Math.min(0, ...Object.values(cooldowns)),
            entityTotal: entities,
            nonBlank: api.canvas().nonBlank,
            pendingInputs: net?.pending ?? 0,
            geometries: renderer.geometries ?? 0,
            textures: renderer.textures ?? 0,
            phase: s.phase,
          };
        });

        samples.push({ t: step * 2, ...reading });

        // --- Hard invariants, checked every step ---------------------------
        expect(Number.isFinite(reading.x), `NaN x at step ${step}`).toBe(true);
        expect(Number.isFinite(reading.y), `NaN y at step ${step}`).toBe(true);
        expect(Number.isFinite(reading.z), `NaN z at step ${step}`).toBe(true);
        expect(Math.abs(reading.x), `left the map on x at step ${step}`).toBeLessThan(67);
        expect(Math.abs(reading.z), `left the map on z at step ${step}`).toBeLessThan(67);
        expect(reading.y, `fell through the floor at step ${step}`).toBeGreaterThan(-1);
        expect(reading.y, `launched out of the world at step ${step}`).toBeLessThan(20);
        expect(reading.minCooldown, `negative cooldown at step ${step}`).toBeGreaterThanOrEqual(0);
        expect(reading.entityTotal, `entity growth at step ${step}`).toBeLessThan(200);
        // A runaway input backlog means commands are never reaching the server,
        // so reconciliation drags the player backwards every snapshot and they
        // feel stuck. This is what shipped broken above ~120 fps.
        expect(
          reading.pendingInputs,
          `input backlog running away at step ${step}`,
        ).toBeLessThan(60);

        if (reading.phase === 'results') break;
      }

      await stopMoving(client.page);

      // --- Aggregate health --------------------------------------------------
      const first = samples[0];
      const last = samples[samples.length - 1];

      // The loop kept running.
      expect(last.frames).toBeGreaterThan(first.frames + 100);

      // The timer actually advanced (it is not frozen).
      expect(last.timeRemaining).toBeLessThan(first.timeRemaining - 20);

      // Scripted input produced real movement, not a stuck player.
      let distance = 0;
      for (let i = 1; i < samples.length; i += 1) {
        distance += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
      }
      expect(distance, 'scripted input produced no movement').toBeGreaterThan(20);

      // Softlock detection: windows where frames advanced under held input but
      // the player did not move at all.
      let softlockWindows = 0;
      for (let i = 1; i < samples.length; i += 1) {
        const moved = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
        const framesAdvanced = samples[i].frames > samples[i - 1].frames;
        if (framesAdvanced && moved < 0.25) softlockWindows += 1;
      }

      // Resource counts must not creep upward across the session (leak check).
      const geometryGrowth = last.geometries - first.geometries;
      const textureGrowth = last.textures - first.textures;
      expect(geometryGrowth, 'geometry leak').toBeLessThan(120);
      expect(textureGrowth, 'texture leak').toBeLessThan(30);

      // The canvas kept drawing throughout.
      const blankSamples = samples.filter((s) => !s.nonBlank).length;
      expect(blankSamples, 'canvas went blank during play').toBe(0);

      const report = {
        seed: 12345,
        steps: samples.length,
        framesAdvanced: last.frames - first.frames,
        distanceTravelled: Number(distance.toFixed(2)),
        secondsElapsed: Number((first.timeRemaining - last.timeRemaining).toFixed(1)),
        softlockWindows,
        maxEntityTotal: Math.max(...samples.map((s) => s.entityTotal)),
        minCooldownSeen: Math.min(...samples.map((s) => s.minCooldown)),
        geometryGrowth,
        textureGrowth,
        blankSamples,
        maxPendingInputs: Math.max(...samples.map((x) => x.pendingInputs)),
        consoleErrors: client.errors,
        samples,
      };

      await mkdir(ARTIFACTS, { recursive: true });
      await writeFile(path.join(ARTIFACTS, 'bot-playtest.json'), JSON.stringify(report, null, 2));

      // Repeated softlock windows mean the player gets stuck on geometry.
      expect(softlockWindows, 'player repeatedly stuck on scenery').toBeLessThan(
        Math.ceil(samples.length * 0.5),
      );
      expect(client.errors, `errors during playtest:\n${client.errors.join('\n')}`).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test('renderer stays within the desktop draw-call and triangle budget', async ({ browser }) => {
    test.setTimeout(120_000);
    const client = await openClient(browser, 'budget');
    try {
      await createRoom(client.page, 'Budget', 12345);
      await client.page.evaluate(() => window.__VEIL_HUNT_TEST__!.lobby.addBot());
      await client.page.waitForTimeout(400);
      await client.page.evaluate(() => window.__VEIL_HUNT_TEST__!.lobby.ready(true));
      await waitForActive(client.page);

      // Move around so the worst-case view is sampled, not just the spawn.
      const readings: { calls: number; triangles: number }[] = [];
      for (let i = 0; i < 8; i += 1) {
        await look(client.page, (i / 8) * Math.PI * 2);
        await move(client.page, 0, 1, { sprint: true });
        await client.page.waitForTimeout(1200);
        const stats = await client.page.evaluate(() => window.__VEIL_HUNT_TEST__!.renderer());
        readings.push({ calls: stats.calls ?? 0, triangles: stats.triangles ?? 0 });
      }
      await stopMoving(client.page);

      const worstCalls = Math.max(...readings.map((r) => r.calls));
      const worstTriangles = Math.max(...readings.map((r) => r.triangles));

      await mkdir(ARTIFACTS, { recursive: true });
      await writeFile(
        path.join(ARTIFACTS, 'render-budget.json'),
        JSON.stringify({ worstCalls, worstTriangles, readings }, null, 2),
      );

      expect(worstCalls, `draw calls over budget: ${worstCalls}`).toBeLessThanOrEqual(300);
      expect(worstTriangles, `triangles over budget: ${worstTriangles}`).toBeLessThanOrEqual(750_000);
    } finally {
      await client.close();
    }
  });

  test('the canvas produces non-blank frames in menu and in play', async ({ browser }) => {
    test.setTimeout(120_000);
    const client = await openClient(browser, 'canvas');
    try {
      await client.page.waitForTimeout(1500);

      await createRoom(client.page, 'Pixels', 12345);
      await client.page.evaluate(() => window.__VEIL_HUNT_TEST__!.lobby.addBot());
      await client.page.waitForTimeout(400);
      await client.page.evaluate(() => window.__VEIL_HUNT_TEST__!.lobby.ready(true));
      await waitForActive(client.page);
      await move(client.page, 0, 1);
      await client.page.waitForTimeout(2000);
      await stopMoving(client.page);

      const inPlay = await client.page.evaluate(() => window.__VEIL_HUNT_TEST__!.canvas());
      expect(inPlay.nonBlank, 'canvas is blank during gameplay').toBe(true);
      // A real scene has plenty of distinct colour, not a flat fill.
      expect(inPlay.uniqueColors).toBeGreaterThan(60);
      // And it must be legible, not pitch black.
      expect(inPlay.meanLuminance).toBeGreaterThan(6);

      const snap = await snapshot(client.page);
      expect(snap).not.toBeNull();
      const pos = await transform(client.page);
      expect(pos).not.toBeNull();
      expect((await state(client.page)).phase).toBe('active');
    } finally {
      await client.close();
    }
  });
});
