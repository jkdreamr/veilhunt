#!/usr/bin/env node
/**
 * Canvas inspector: proves the game is actually rendering, measures pixel
 * statistics and compares renderer diagnostics against the render budget.
 *
 * Usage:
 *   node scripts/inspect-canvas.mjs --url http://127.0.0.1:4173 [--state active] [--mobile]
 */

import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PNG } from 'pngjs';

const RENDER_BUDGETS = {
  desktop: { calls: 300, triangles: 750_000, geometries: 300, textures: 60 },
  mobile: { calls: 150, triangles: 300_000, geometries: 200, textures: 40 },
};

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:4173',
    out: 'artifacts/canvas-inspection',
    mobile: false,
    wait: 2500,
    state: null,
    seed: 12345,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--url') args.url = argv[++i];
    else if (value === '--out') args.out = argv[++i];
    else if (value === '--mobile') args.mobile = true;
    else if (value === '--wait') args.wait = Number(argv[++i]);
    else if (value === '--state') args.state = argv[++i];
    else if (value === '--seed') args.seed = Number(argv[++i]);
    else if (value === '-h' || value === '--help') {
      console.log(
        'Usage: inspect-canvas.mjs [--url URL] [--out DIR] [--mobile] [--wait MS] [--state NAME] [--seed N]\n' +
          '  --state one of: menu, lobby, active-runner, active-hunter, seals-lit, results',
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

const round = (v, d) => Number(v.toFixed(d));

/** Objective pixel statistics used as measured evidence in the visual scorecard. */
function computePixelMetrics(png) {
  const stepX = Math.max(1, Math.floor(png.width / 160));
  const stepY = Math.max(1, Math.floor(png.height / 90));
  const cols = Math.floor(png.width / stepX);
  const rows = Math.floor(png.height / stepY);
  const luminance = new Float64Array(cols * rows);
  const buckets = new Map();
  let samples = 0;

  for (let gy = 0; gy < rows; gy += 1) {
    for (let gx = 0; gx < cols; gx += 1) {
      const offset = (gy * stepY * png.width + gx * stepX) * 4;
      const r = png.data[offset];
      const g = png.data[offset + 1];
      const b = png.data[offset + 2];
      luminance[gy * cols + gx] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      samples += 1;
    }
  }

  let entropy = 0;
  let dominant = 0;
  for (const count of buckets.values()) {
    const p = count / samples;
    entropy -= p * Math.log2(p);
    if (count > dominant) dominant = count;
  }

  let edgeHits = 0;
  let edgeSamples = 0;
  for (let gy = 1; gy < rows - 1; gy += 1) {
    for (let gx = 1; gx < cols - 1; gx += 1) {
      const c = luminance[gy * cols + gx];
      const dx = Math.abs(luminance[gy * cols + gx + 1] - c);
      const dy = Math.abs(luminance[(gy + 1) * cols + gx] - c);
      if (Math.hypot(dx, dy) > 12) edgeHits += 1;
      edgeSamples += 1;
    }
  }

  let min = 255;
  let max = 0;
  let sum = 0;
  for (const value of luminance) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }

  return {
    colorEntropyBits: round(entropy, 3),
    dominantColorShare: round(dominant / samples, 3),
    edgeDensity: round(edgeSamples > 0 ? edgeHits / edgeSamples : 0, 4),
    distinctColorBuckets: buckets.size,
    luminance: {
      min: round(min, 1),
      max: round(max, 1),
      mean: round(sum / luminance.length, 1),
      contrast: round(max - min, 1),
    },
  };
}

/** Drives the game into a named state via the deterministic test hooks. */
async function driveToState(page, state, seed) {
  const wait = (ms) => page.waitForTimeout(ms);

  if (state === 'menu' || !state) return;

  await page.waitForFunction(() => window.__VEIL_HUNT_TEST__ !== undefined, { timeout: 20000 });
  // Role assignment is seed-derived, so nudge the seed's parity to choose which
  // role the inspecting client gets.
  let useSeed = seed;
  if (state === 'active-hunter') useSeed = seed % 2 === 0 ? seed : seed + 1;
  if (state === 'active-runner') useSeed = seed % 2 === 1 ? seed : seed + 1;
  await page.evaluate(([s]) => window.__VEIL_HUNT_TEST__.lobby.create('Inspector', s), [useSeed]);
  await page.waitForFunction(() => window.__VEIL_HUNT_TEST__.state().roomCode !== null, { timeout: 15000 });
  if (state === 'lobby') return;

  await page.evaluate(() => window.__VEIL_HUNT_TEST__.lobby.addBot());
  await wait(300);
  await page.evaluate(() => window.__VEIL_HUNT_TEST__.lobby.ready(true));
  await page.waitForFunction(() => window.__VEIL_HUNT_TEST__.state().role !== null, { timeout: 20000 });
  await page.waitForFunction(() => window.__VEIL_HUNT_TEST__.state().phase !== null, { timeout: 30000 });
  await page.evaluate(() => window.__VEIL_HUNT_TEST__.lobby.dismissTutorial());
  await page.waitForFunction(() => window.__VEIL_HUNT_TEST__.state().phase === 'active', { timeout: 30000 });
  await wait(1200);

  if (state === 'active-runner' || state === 'active-hunter') {
    // Move a little so the shot is real gameplay, not a spawn pose.
    await page.evaluate(() => {
      window.__VEIL_HUNT_TEST__.input.move(0, 1, { sprint: true });
    });
    await wait(1600);
    await page.evaluate(() => window.__VEIL_HUNT_TEST__.input.stop());
    await wait(400);
  }
  return;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const context = await browser.newContext(
    args.mobile
      ? { viewport: { width: 414, height: 896 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  );
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('requestfailed', (request) =>
    failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText}`),
  );

  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(args.wait);

  await driveToState(page, args.state, args.seed);
  await page.waitForTimeout(600);

  const gpu = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return { renderer: 'none', vendor: 'none', softwareRendered: true };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    const vendor = ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : 'unknown';
    return {
      renderer,
      vendor,
      softwareRendered: /swiftshader|software|llvmpipe/i.test(renderer),
    };
  });

  const hooks = await page.evaluate(() => {
    const api = window.__VEIL_HUNT_TEST__;
    if (!api) return null;
    return {
      state: api.state(),
      renderer: api.renderer(),
      world: api.world(),
      canvas: api.canvas(),
      errors: api.errors(),
    };
  });

  const suffix = `${args.state ?? 'default'}${args.mobile ? '-mobile' : '-desktop'}`;
  const screenshotPath = path.join(outDir, `canvas-${suffix}.png`);
  const buffer = await page.screenshot({ path: screenshotPath, type: 'png' });
  const png = PNG.sync.read(buffer);
  const metrics = computePixelMetrics(png);

  const tier = args.mobile ? 'mobile' : 'desktop';
  const budget = RENDER_BUDGETS[tier];
  const stats = hooks?.renderer ?? {};
  const renderBudget = Object.entries(budget).map(([key, limit]) => ({
    metric: key,
    actual: stats[key] ?? null,
    budget: limit,
    overBudget: typeof stats[key] === 'number' ? stats[key] > limit : false,
  }));

  const report = {
    url: args.url,
    state: args.state ?? 'default',
    tier,
    gpu,
    hooks,
    metrics,
    renderBudget,
    consoleErrors,
    pageErrors,
    failedRequests,
    screenshot: screenshotPath,
  };

  const reportPath = path.join(outDir, `report-${suffix}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));

  await context.close();
  await browser.close();

  const blank = hooks?.canvas?.nonBlank === false;
  if (blank) {
    console.error('\nFAIL: canvas appears blank');
    process.exit(2);
  }
  if (pageErrors.length > 0) {
    console.error('\nFAIL: page errors detected');
    process.exit(3);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
