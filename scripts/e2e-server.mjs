#!/usr/bin/env node
/**
 * Builds the client with test hooks enabled and serves it together with the
 * authoritative game server on a single port, so Playwright drives the same
 * production code path a player would.
 */

import { spawnSync, spawn } from 'node:child_process';
import process from 'node:process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VEIL_E2E_PORT ?? 4173);

if (process.env.VEIL_E2E_SKIP_BUILD !== '1' || !existsSync(path.join(root, 'dist/e2e-client/index.html'))) {
  process.stdout.write('[e2e] building client (mode=e2e)…\n');
  const build = spawnSync(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'build', '--mode', 'e2e'],
    { cwd: root, stdio: 'inherit' },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);

  process.stdout.write('[e2e] building server…\n');
  const tsc = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
}

const server = spawn(process.execPath, ['dist/server/server/index.js'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VEIL_SERVER_PORT: String(PORT), VEIL_HOST: '127.0.0.1', VEIL_TEST_HOOKS: '1', VEIL_CLIENT_DIR: path.join(root, 'dist/e2e-client') },
});

const stop = () => {
  if (!server.killed) server.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);

server.on('exit', (code) => process.exit(code ?? 0));
