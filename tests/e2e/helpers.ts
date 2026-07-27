import type { Browser, BrowserContext, ConsoleMessage, Page } from '@playwright/test';

export interface Client {
  context: BrowserContext;
  page: Page;
  errors: string[];
  close(): Promise<void>;
}

/** A game client in its own browser context — separate storage, separate socket. */
export async function openClient(browser: Browser, label: string): Promise<Client> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(`[${label}] console: ${msg.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`[${label}] pageerror: ${String(error)}`));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? '';
    // Socket.IO polling upgrades legitimately abort; that is not a failure.
    if (failure.includes('ERR_ABORTED')) return;
    errors.push(`[${label}] requestfailed: ${request.url()} ${failure}`);
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => window.__VEIL_HUNT_TEST__ !== undefined, undefined, {
      timeout: 30_000,
    });
  } catch (error) {
    // Surface why the client never booted instead of a bare timeout.
    const diagnosis = await page.evaluate(() => ({
      bootError: document.getElementById('boot-error')?.textContent ?? null,
      hasCanvas: !!document.getElementById('scene'),
      webglOk: (() => {
        try {
          const c = document.createElement('canvas');
          return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
        } catch {
          return false;
        }
      })(),
    }));
    throw new Error(
      `[${label}] test hooks never installed. bootError=${diagnosis.bootError} ` +
        `canvas=${diagnosis.hasCanvas} webgl=${diagnosis.webglOk}. Original: ${String(error)}`,
    );
  }

  return {
    context,
    page,
    errors,
    async close() {
      await context.close();
    },
  };
}

export async function state(page: Page) {
  return page.evaluate(() => window.__VEIL_HUNT_TEST__!.state());
}

export async function transform(page: Page) {
  return page.evaluate(() => window.__VEIL_HUNT_TEST__!.transform());
}

export async function snapshot(page: Page) {
  return page.evaluate(() => window.__VEIL_HUNT_TEST__!.snapshot());
}

export async function debugForce(page: Page, kind: string, value?: number): Promise<void> {
  await page.evaluate(
    ([k, v]) => window.__VEIL_HUNT_TEST__!.debug(k as string, v as number | undefined),
    [kind, value] as const,
  );
}

export async function createRoom(page: Page, name: string, seed = 12345): Promise<string> {
  await page.evaluate(
    ([n, s]) => window.__VEIL_HUNT_TEST__!.lobby.create(n as string, s as number),
    [name, seed] as const,
  );
  await page.waitForFunction(() => window.__VEIL_HUNT_TEST__!.state().roomCode !== null, undefined, {
    timeout: 20_000,
  });
  const code = (await state(page)).roomCode;
  if (!code) throw new Error('Room code was never assigned');
  return code;
}

export async function joinRoom(page: Page, name: string, code: string): Promise<void> {
  await page.evaluate(
    ([n, c]) => window.__VEIL_HUNT_TEST__!.lobby.join(n as string, c as string),
    [name, code] as const,
  );
  await page.waitForFunction(
    (expected) => window.__VEIL_HUNT_TEST__!.state().roomCode === expected,
    code,
    { timeout: 20_000 },
  );
}

export async function ready(page: Page): Promise<void> {
  await page.evaluate(() => window.__VEIL_HUNT_TEST__!.lobby.ready(true));
}

/** Waits for the match to reach the active phase and dismisses the tutorial. */
export async function waitForActive(page: Page, timeout = 45_000): Promise<void> {
  await page.waitForFunction(() => window.__VEIL_HUNT_TEST__!.state().role !== null, undefined, {
    timeout,
  });
  await page.evaluate(() => window.__VEIL_HUNT_TEST__!.lobby.dismissTutorial());
  await page.waitForFunction(
    () => window.__VEIL_HUNT_TEST__!.state().phase === 'active',
    undefined,
    { timeout },
  );
}

/** Drives two clients from the title screen into a live match. */
export async function startMatch(
  hostPage: Page,
  guestPage: Page,
  seed = 12345,
): Promise<{ code: string; hostRole: string; guestRole: string }> {
  const code = await createRoom(hostPage, 'Ash', seed);
  await joinRoom(guestPage, 'Vex', code);
  await ready(hostPage);
  await ready(guestPage);
  await Promise.all([waitForActive(hostPage), waitForActive(guestPage)]);
  const hostRole = (await state(hostPage)).role!;
  const guestRole = (await state(guestPage)).role!;
  return { code, hostRole, guestRole };
}

export function pagesByRole(
  a: { page: Page; role: string },
  b: { page: Page; role: string },
): { hunter: Page; runner: Page } {
  return a.role === 'hunter' ? { hunter: a.page, runner: b.page } : { hunter: b.page, runner: a.page };
}

export async function pressAction(page: Page, kind: string): Promise<void> {
  await page.evaluate((k) => window.__VEIL_HUNT_TEST__!.input.action(k), kind);
}

export async function setInteract(page: Page, held: boolean): Promise<void> {
  await page.evaluate((h) => window.__VEIL_HUNT_TEST__!.input.interact(h), held);
}

export async function move(
  page: Page,
  mx: number,
  mz: number,
  opts: { sprint?: boolean; crouch?: boolean } = {},
): Promise<void> {
  await page.evaluate(
    ([x, z, o]) =>
      window.__VEIL_HUNT_TEST__!.input.move(x as number, z as number, o as { sprint?: boolean }),
    [mx, mz, opts] as const,
  );
}

export async function look(page: Page, yaw: number, pitch = 0): Promise<void> {
  await page.evaluate(
    ([y, p]) => window.__VEIL_HUNT_TEST__!.input.look(y as number, p as number),
    [yaw, pitch] as const,
  );
}

export async function stopMoving(page: Page): Promise<void> {
  await page.evaluate(() => window.__VEIL_HUNT_TEST__!.input.stop());
}

/** Collects console/page errors from every client, ignoring benign noise. */
export function collectErrors(...clients: Client[]): string[] {
  return clients.flatMap((c) => c.errors);
}
