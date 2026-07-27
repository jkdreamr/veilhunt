#!/usr/bin/env node
/**
 * Development launcher: starts the authoritative game server and the Vite dev
 * server together, then prints the localhost and LAN URLs so a second player on
 * the same Wi-Fi can join from another computer.
 */

import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import process from 'node:process';

const SERVER_PORT = Number(process.env.VEIL_SERVER_PORT ?? 8787);
const CLIENT_PORT = Number(process.env.VEIL_CLIENT_PORT ?? 5188);

const colour = {
  cyan: (t) => `\u001b[36m${t}\u001b[0m`,
  dim: (t) => `\u001b[2m${t}\u001b[0m`,
  green: (t) => `\u001b[32m${t}\u001b[0m`,
  amber: (t) => `\u001b[33m${t}\u001b[0m`,
};

function lanAddresses() {
  const out = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

const children = [];

function run(name, command, args, env) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  children.push(child);

  const prefix = colour.dim(`[${name}]`);
  const pipe = (stream, sink) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length > 0) sink.write(`${prefix} ${line}\n`);
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`${prefix} exited with code ${code}\n`);
      shutdown(code);
    }
  });
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 200).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', process.execPath, ['--import', 'tsx/esm', 'src/server/index.ts'], {
  VEIL_SERVER_PORT: String(SERVER_PORT),
});

run('client', process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--port', String(CLIENT_PORT)], {
  VEIL_SERVER_PORT: String(SERVER_PORT),
});

setTimeout(() => {
  const addresses = lanAddresses();
  process.stdout.write('\n');
  process.stdout.write(`  ${colour.cyan('VEIL HUNT')} ${colour.dim('— development')}\n\n`);
  process.stdout.write(`  ${colour.green('Play here')}      http://localhost:${CLIENT_PORT}\n`);
  if (addresses.length > 0) {
    process.stdout.write(`  ${colour.amber('Second player')}  ${'http://' + addresses[0] + ':' + CLIENT_PORT}\n`);
    for (const address of addresses.slice(1)) {
      process.stdout.write(`  ${colour.dim('also')}           http://${address}:${CLIENT_PORT}\n`);
    }
    process.stdout.write(
      `\n  ${colour.dim('Both computers must be on the same Wi-Fi. Share the LAN URL and the 4-letter room code.')}\n`,
    );
  } else {
    process.stdout.write(`  ${colour.dim('No LAN address detected — local play only.')}\n`);
  }
  process.stdout.write('\n');
}, 2200);
