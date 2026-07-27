/** Drives the PRODUCTION build through the real UI only — no test hooks exist. */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const OUT = path.resolve('artifacts/production-check');
await mkdir(OUT, { recursive: true });

const errors = [], failed = [];
const b = await chromium.launch({ channel: 'chromium', args: ['--use-gl=angle','--mute-audio'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', e => errors.push('pageerror: ' + e));
p.on('requestfailed', r => { const f = r.failure()?.errorText ?? ''; if (!f.includes('ERR_ABORTED')) failed.push(r.url()+' '+f); });

await p.goto('http://127.0.0.1:8787/', { waitUntil: 'load' });
await p.waitForTimeout(1500);

console.log('test hooks present in production build:', await p.evaluate(() => typeof window.__VEIL_HUNT_TEST__ !== 'undefined'));

// Real UI: type a name and create a room.
await p.getByLabel(/your name/i).fill('Joshua');
await p.getByRole('button', { name: /create room/i }).click();
await p.waitForTimeout(1500);
const code = (await p.textContent('body')).match(/\b[ACDEFGHJKLMNPQRTUVWXY34679]{4}\b/);
console.log('room code from UI:', code ? code[0] : 'NOT FOUND');
await p.screenshot({ path: path.join(OUT, 'prod-01-lobby.png') });

// Add the practice bot, then ready up — all via real clicks.
await p.getByRole('button', { name: /bot/i }).click();
await p.waitForTimeout(600);
await p.getByRole('button', { name: /^ready/i }).click();
await p.waitForTimeout(7000);
await p.screenshot({ path: path.join(OUT, 'prod-02-role-reveal.png') });

// Tutorial -> match
const gotIt = p.getByRole('button', { name: /got it|begin|continue|play/i });
if (await gotIt.count()) { await gotIt.first().click(); }
await p.waitForTimeout(9000);
await p.screenshot({ path: path.join(OUT, 'prod-03-countdown-or-active.png') });

// Real keyboard play: click canvas (pointer lock), then move and use abilities.
await p.locator('#scene').click({ position: { x: 640, y: 400 } });
await p.waitForTimeout(500);
const seq = [
  ['KeyW', 1800], ['KeyW', 0], ['KeyA', 900], ['KeyA', 0],
  ['KeyD', 900], ['KeyD', 0], ['Space', 200], ['KeyW', 1500], ['KeyW', 0],
];
for (const [key, hold] of seq) {
  if (hold > 0) { await p.keyboard.down(key); await p.waitForTimeout(hold); await p.keyboard.up(key); }
}
await p.keyboard.down('Shift'); await p.keyboard.down('KeyW');
await p.mouse.move(300, 400); await p.waitForTimeout(1800);
await p.keyboard.up('KeyW'); await p.keyboard.up('Shift');
await p.keyboard.press('KeyQ'); await p.waitForTimeout(700);
await p.keyboard.press('KeyF'); await p.waitForTimeout(700);
await p.mouse.click(640, 400); await p.waitForTimeout(600);
await p.screenshot({ path: path.join(OUT, 'prod-04-gameplay.png') });

// Pixel check via a fresh readback (production has preserveDrawingBuffer off, so
// sample the screenshot instead).
const shot = await p.screenshot({ type: 'png' });
const { PNG } = await import('pngjs');
const png = PNG.sync.read(shot);
let sum = 0, n = 0; const colors = new Set();
for (let i = 0; i < png.data.length; i += 4 * 29) {
  const r = png.data[i], g = png.data[i+1], bl = png.data[i+2];
  sum += 0.2126*r + 0.7152*g + 0.0722*bl; n++;
  colors.add((r>>4<<8)|(g>>4<<4)|(bl>>4));
}
console.log('gameplay frame: meanLum=', (sum/n).toFixed(1), 'distinctColors=', colors.size);

// Pause via Escape, then quit to title.
await p.keyboard.press('Escape');
await p.waitForTimeout(900);
await p.screenshot({ path: path.join(OUT, 'prod-05-pause.png') });
const quit = p.getByRole('button', { name: /quit to title/i });
if (await quit.count()) { await quit.first().click(); await p.waitForTimeout(1200); }
await p.screenshot({ path: path.join(OUT, 'prod-06-back-to-title.png') });
console.log('back at title:', /create room/i.test(await p.textContent('body')));

console.log('\nCONSOLE ERRORS:', errors.length ? errors : 'none');
console.log('FAILED REQUESTS:', failed.length ? failed : 'none');
await b.close();
