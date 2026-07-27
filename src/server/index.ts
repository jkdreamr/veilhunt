/**
 * Veil Hunt server: Express for static hosting plus Socket.IO for the
 * authoritative match loop. In production it serves the built client from
 * dist/client so a single `npm run start` runs the whole game.
 */

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import express from 'express';
import { Server as SocketServer } from 'socket.io';
import type { Socket } from 'socket.io';

import { SNAPSHOT_HZ, TICK_DT } from '../shared/constants.js';
import { assignContracts } from '../shared/contracts.js';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../shared/protocol.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/protocol.js';
import {
  parseAction,
  parseCreateRoom,
  parseInputBatch,
  parseJoinRoom,
  parseSetReady,
} from '../shared/validation.js';
import { RoomManager, type Room, type RoomPlayer } from './RoomManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.VEIL_SERVER_PORT ?? process.env.PORT ?? 8787);
const HOST = process.env.VEIL_HOST ?? '0.0.0.0';
const TEST_HOOKS_ENABLED = process.env.VEIL_TEST_HOOKS === '1';

const app = express();
app.disable('x-powered-by');

const httpServer = createServer(app);
const io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: true, credentials: false },
  pingInterval: 8000,
  pingTimeout: 12000,
});

// --------------------------------------------------------------------------
// Socket plumbing
// --------------------------------------------------------------------------

const socketsById = new Map<string, Socket<ClientToServerEvents, ServerToClientEvents>>();

function emitToPlayer<E extends keyof ServerToClientEvents>(
  player: RoomPlayer,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): void {
  if (!player.socketId) return;
  const socket = socketsById.get(player.socketId);
  if (!socket) return;
  (socket.emit as (e: string, ...a: unknown[]) => void)(event as string, ...args);
}

const manager = new RoomManager({
  onRoomUpdate(room) {
    for (const player of room.players) {
      if (player.isBot || !player.socketId) continue;
      emitToPlayer(player, SERVER_EVENTS.room, manager.buildRoomView(room, player.id));
    }
  },

  onRoleReveal(room) {
    const contracts = assignContracts(room.seed, room.round);
    for (const player of room.players) {
      if (player.isBot || !player.role) continue;
      const opponent = room.players.find((p) => p.id !== player.id);
      const contract = contracts[player.role];
      emitToPlayer(player, SERVER_EVENTS.roleReveal, {
        role: player.role,
        seed: room.seed,
        round: room.round,
        opponentName: opponent?.name ?? 'Unknown',
        contract: contract
          ? { id: contract.id, title: contract.title, description: contract.description }
          : null,
        duration: room.phaseTimer,
      });
    }
  },

  onMatchStart(room) {
    for (const player of room.players) {
      if (player.isBot || !player.role) continue;
      const opponent = room.players.find((p) => p.id !== player.id);
      emitToPlayer(player, SERVER_EVENTS.matchStart, {
        seed: room.seed,
        role: player.role,
        round: room.round,
        opponentName: opponent?.name ?? 'Unknown',
        startsAt: Date.now() + room.phaseTimer * 1000,
      });
    }
  },

  onMatchEnd(room) {
    const result = room.match?.matchResult;
    if (!result) return;
    for (const player of room.players) {
      if (player.isBot || !player.role) continue;
      emitToPlayer(player, SERVER_EVENTS.matchEnd, { result, yourRole: player.role });
    }
  },

  onOpponentLeft(room, leaver) {
    for (const player of room.players) {
      if (player.isBot || player.id === leaver.id) continue;
      emitToPlayer(player, SERVER_EVENTS.opponentLeft, {
        name: leaver.name,
        graceSeconds: leaver.graceRemaining,
      });
    }
  },

  onOpponentReturned(room, returner) {
    for (const player of room.players) {
      if (player.isBot || player.id === returner.id) continue;
      emitToPlayer(player, SERVER_EVENTS.opponentReturned, { name: returner.name });
    }
  },
});

/** Simple per-socket token bucket so a misbehaving client cannot flood the loop. */
class RateLimiter {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  allow(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSecond);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

io.on('connection', (socket) => {
  socketsById.set(socket.id, socket);
  const inputLimiter = new RateLimiter(90, 60);
  const actionLimiter = new RateLimiter(40, 25);
  const lobbyLimiter = new RateLimiter(20, 6);

  const fail = (code: Parameters<ServerToClientEvents['s:roomError']>[0]['code'], message: string): void => {
    socket.emit(SERVER_EVENTS.roomError, { code, message });
  };

  socket.on(CLIENT_EVENTS.createRoom, (raw) => {
    if (!lobbyLimiter.allow()) return fail('RATE_LIMIT', 'Slow down a moment.');
    const payload = parseCreateRoom(raw);
    if (!payload) return fail('BAD_PAYLOAD', 'That name could not be used.');
    if (manager.getRoomForSocket(socket.id)) manager.leaveRoom(socket.id);
    manager.createRoom(socket.id, payload.name, payload.seed);
  });

  socket.on(CLIENT_EVENTS.joinRoom, (raw) => {
    if (!lobbyLimiter.allow()) return fail('RATE_LIMIT', 'Slow down a moment.');
    const payload = parseJoinRoom(raw);
    if (!payload) return fail('BAD_PAYLOAD', 'Enter a name and a 4-character room code.');
    if (manager.getRoomForSocket(socket.id)) manager.leaveRoom(socket.id);
    const outcome = manager.joinRoom(socket.id, payload.name, payload.code);
    if ('error' in outcome) {
      fail(
        outcome.error,
        outcome.error === 'ROOM_NOT_FOUND'
          ? `No room called ${payload.code}. Check the code and try again.`
          : 'That room already has two players.',
      );
    }
  });

  socket.on(CLIENT_EVENTS.setReady, (raw) => {
    if (!lobbyLimiter.allow()) return;
    const payload = parseSetReady(raw);
    if (!payload) return fail('BAD_PAYLOAD', 'Invalid ready state.');
    manager.setReady(socket.id, payload.ready);
  });

  socket.on(CLIENT_EVENTS.addBot, () => {
    if (!lobbyLimiter.allow()) return;
    manager.addBot(socket.id);
  });

  socket.on(CLIENT_EVENTS.input, (raw) => {
    if (!inputLimiter.allow()) return;
    const commands = parseInputBatch(raw);
    if (!commands) return;
    const room = manager.getRoomForSocket(socket.id);
    if (!room?.match || room.match.isFinished) return;
    room.match.enqueueInput(socket.id, commands);
  });

  socket.on(CLIENT_EVENTS.action, (raw) => {
    if (!actionLimiter.allow()) return;
    const action = parseAction(raw);
    if (!action) return;
    const room = manager.getRoomForSocket(socket.id);
    if (!room?.match || room.match.isFinished) return;
    room.match.handleAction(socket.id, action);
  });

  socket.on(CLIENT_EVENTS.rematch, () => {
    if (!lobbyLimiter.allow()) return;
    manager.voteRematch(socket.id);
  });

  socket.on(CLIENT_EVENTS.returnToLobby, () => {
    if (!lobbyLimiter.allow()) return;
    manager.returnToLobby(socket.id);
  });

  socket.on(CLIENT_EVENTS.leaveRoom, () => {
    manager.leaveRoom(socket.id);
  });

  socket.on(CLIENT_EVENTS.ping, (sentAt) => {
    if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) return;
    socket.emit(SERVER_EVENTS.pong, sentAt, Date.now());
  });

  // Deterministic state forcing for automated tests. Registered only when the
  // server is started with VEIL_TEST_HOOKS=1, so a normal production run has no
  // such handler at all.
  if (TEST_HOOKS_ENABLED) {
    socket.on(CLIENT_EVENTS.debug, (raw) => {
      if (typeof raw !== 'object' || raw === null) return;
      const payload = raw as { kind?: unknown; value?: unknown };
      if (typeof payload.kind !== 'string') return;
      const room = manager.getRoomForSocket(socket.id);
      if (!room?.match || room.match.isFinished) return;
      room.match.debugForce({
        kind: payload.kind,
        value: typeof payload.value === 'number' && Number.isFinite(payload.value) ? payload.value : undefined,
      });
    });
  }

  socket.on('disconnect', () => {
    socketsById.delete(socket.id);
    manager.handleDisconnect(socket.id);
  });
});

// --------------------------------------------------------------------------
// Fixed simulation + snapshot loop
// --------------------------------------------------------------------------

const SNAPSHOT_INTERVAL = 1 / SNAPSHOT_HZ;
let snapshotAccumulator = 0;
let accumulator = 0;
let lastTime = Date.now();

function broadcastSnapshots(room: Room): void {
  if (!room.match) return;
  for (const player of room.players) {
    if (player.isBot || !player.socketId) continue;
    const snapshot = room.match.buildSnapshot(player.id);
    if (snapshot) emitToPlayer(player, SERVER_EVENTS.snapshot, snapshot);
  }
}

const loop = setInterval(() => {
  const now = Date.now();
  let frame = (now - lastTime) / 1000;
  lastTime = now;
  // Guard against a suspended process replaying minutes of simulation at once.
  if (frame > 0.25) frame = 0.25;
  accumulator += frame;

  let steps = 0;
  while (accumulator >= TICK_DT && steps < 8) {
    manager.update(TICK_DT);
    accumulator -= TICK_DT;
    steps += 1;
  }
  if (steps >= 8) accumulator = 0;

  snapshotAccumulator += frame;
  if (snapshotAccumulator >= SNAPSHOT_INTERVAL) {
    snapshotAccumulator = 0;
    manager.forEachRoom(broadcastSnapshots);
  }
}, 1000 / 60);

// --------------------------------------------------------------------------
// Static hosting
// --------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: manager.roomCount, uptime: process.uptime() });
});

// Defaults to the production bundle; the E2E harness points this at the
// hook-enabled build so the two can never be confused.
const clientDist = process.env.VEIL_CLIENT_DIR
  ? path.resolve(process.env.VEIL_CLIENT_DIR)
  : path.resolve(__dirname, '../../client');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: 'index.html', maxAge: '1h' }));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

httpServer.listen(PORT, HOST, () => {
  const hosted = existsSync(clientDist);
  const cyan = (t: string): string => `\u001b[36m${t}\u001b[0m`;
  const dim = (t: string): string => `\u001b[2m${t}\u001b[0m`;
  console.log(``);
  console.log(`  ${cyan('VEIL HUNT')} server listening`);
  console.log(`  ${dim('mode:')}    ${hosted ? 'production (serving built client)' : 'development (API only)'}`);
  console.log(`  ${dim('local:')}   http://localhost:${PORT}`);
  for (const address of lanAddresses()) {
    console.log(`  ${dim('network:')} http://${address}:${PORT}`);
  }
  console.log(``);
});

function shutdown(): void {
  clearInterval(loop);
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, httpServer, io };
