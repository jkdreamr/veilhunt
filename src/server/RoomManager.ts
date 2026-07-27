/**
 * Room lifecycle: creation, joining, ready state, role assignment, match
 * start/stop, rematch with swapped roles, disconnect grace and cleanup.
 * All of it is authoritative — the client only ever asks.
 */

import {
  COUNTDOWN_DURATION,
  EMPTY_ROOM_TTL,
  RECONNECT_GRACE,
  ROLE_REVEAL_DURATION,
  TICK_DT,
} from '../shared/constants.js';
import { assignRoles } from '../shared/matchRules.js';
import { createRng, randomSeed, type Rng } from '../shared/rng.js';
import type { LobbyPlayerView, MatchPhase, Role, RoomView } from '../shared/types.js';
import { Bot } from './Bot.js';
import { Match } from './Match.js';
import { makeUniqueRoomCode } from './roomCode.js';

export interface RoomPlayer {
  id: string;
  socketId: string | null;
  name: string;
  ready: boolean;
  connected: boolean;
  role: Role | null;
  isHost: boolean;
  isBot: boolean;
  /** Seconds left before a disconnected player is dropped from the room. */
  graceRemaining: number;
}

export interface Room {
  code: string;
  seed: number;
  round: number;
  phase: MatchPhase;
  players: RoomPlayer[];
  match: Match | null;
  bot: Bot | null;
  phaseTimer: number;
  emptyFor: number;
  rematchVotes: Set<string>;
}

export interface RoomEvents {
  onRoomUpdate(room: Room): void;
  onRoleReveal(room: Room): void;
  onMatchStart(room: Room): void;
  onMatchEnd(room: Room): void;
  onOpponentLeft(room: Room, leaver: RoomPlayer): void;
  onOpponentReturned(room: Room, returner: RoomPlayer): void;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly socketToRoom = new Map<string, string>();
  private readonly rng: Rng;

  constructor(
    private readonly events: RoomEvents,
    seed = randomSeed(),
  ) {
    this.rng = createRng(seed);
  }

  // -------------------------------------------------------------------------
  // Room lookup
  // -------------------------------------------------------------------------

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  getRoomForSocket(socketId: string): Room | undefined {
    const code = this.socketToRoom.get(socketId);
    return code ? this.rooms.get(code) : undefined;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  /** Iterates live rooms without exposing the internal map. */
  forEachRoom(visit: (room: Room) => void): void {
    for (const room of this.rooms.values()) visit(room);
  }

  // -------------------------------------------------------------------------
  // Create / join / leave
  // -------------------------------------------------------------------------

  createRoom(socketId: string, name: string, seed?: number): Room {
    const code = makeUniqueRoomCode(this.rng, new Set(this.rooms.keys()));
    const room: Room = {
      code,
      seed: seed ?? randomSeed(),
      round: 0,
      phase: 'lobby',
      players: [
        {
          id: socketId,
          socketId,
          name,
          ready: false,
          connected: true,
          role: null,
          isHost: true,
          isBot: false,
          graceRemaining: 0,
        },
      ],
      match: null,
      bot: null,
      phaseTimer: 0,
      emptyFor: 0,
      rematchVotes: new Set(),
    };
    this.rooms.set(code, room);
    this.socketToRoom.set(socketId, code);
    this.events.onRoomUpdate(room);
    return room;
  }

  joinRoom(
    socketId: string,
    name: string,
    code: string,
  ): { room: Room } | { error: 'ROOM_NOT_FOUND' | 'ROOM_FULL' } {
    const room = this.rooms.get(code);
    if (!room) return { error: 'ROOM_NOT_FOUND' };

    // A returning player reclaims their slot if the grace window is still open.
    const disconnected = room.players.find((p) => !p.connected && p.name === name && !p.isBot);
    if (disconnected) {
      disconnected.socketId = socketId;
      disconnected.id = socketId;
      disconnected.connected = true;
      disconnected.graceRemaining = 0;
      this.socketToRoom.set(socketId, code);
      if (room.match) {
        room.match.setConnected(disconnected.id, true);
      }
      this.events.onOpponentReturned(room, disconnected);
      this.events.onRoomUpdate(room);
      return { room };
    }

    const humanCount = room.players.filter((p) => !p.isBot).length;
    if (humanCount >= 2 || room.players.length >= 2) {
      // Joining a room that only has a bot replaces the bot with the human.
      const bot = room.players.find((p) => p.isBot);
      if (bot && room.phase === 'lobby') {
        this.removePlayer(room, bot.id);
      } else {
        return { error: 'ROOM_FULL' };
      }
    }

    room.players.push({
      id: socketId,
      socketId,
      name,
      ready: false,
      connected: true,
      role: null,
      isHost: false,
      isBot: false,
      graceRemaining: 0,
    });
    this.socketToRoom.set(socketId, code);
    this.events.onRoomUpdate(room);
    return { room };
  }

  addBot(socketId: string): Room | null {
    const room = this.getRoomForSocket(socketId);
    if (!room || room.phase !== 'lobby' || room.players.length >= 2) return null;
    const botId = `bot:${room.code}`;
    room.players.push({
      id: botId,
      socketId: null,
      name: 'Veil Shade',
      ready: true,
      connected: true,
      role: null,
      isHost: false,
      isBot: true,
      graceRemaining: 0,
    });
    room.bot = new Bot(botId, 'Veil Shade', room.seed);
    this.events.onRoomUpdate(room);
    return room;
  }

  setReady(socketId: string, ready: boolean): Room | null {
    const room = this.getRoomForSocket(socketId);
    if (!room) return null;
    const player = room.players.find((p) => p.id === socketId);
    if (!player) return null;
    player.ready = ready;
    this.events.onRoomUpdate(room);
    this.maybeStartMatch(room);
    return room;
  }

  /** Hard leave: the player is removed immediately, no grace period. */
  leaveRoom(socketId: string): void {
    const room = this.getRoomForSocket(socketId);
    this.socketToRoom.delete(socketId);
    if (!room) return;
    const player = room.players.find((p) => p.id === socketId);
    if (!player) return;

    if (room.phase !== 'lobby' && room.match && !room.match.isFinished) {
      const role = player.role;
      if (role) {
        room.match.abandon(role);
        this.endMatch(room);
      }
    }
    this.removePlayer(room, socketId);
    this.events.onRoomUpdate(room);
  }

  /** Soft disconnect: keeps the slot alive so the player can reconnect. */
  handleDisconnect(socketId: string): void {
    const room = this.getRoomForSocket(socketId);
    this.socketToRoom.delete(socketId);
    if (!room) return;
    const player = room.players.find((p) => p.id === socketId);
    if (!player) return;

    player.connected = false;
    player.socketId = null;
    player.ready = false;

    if (room.phase === 'lobby' || room.phase === 'results') {
      this.removePlayer(room, socketId);
      this.events.onRoomUpdate(room);
      return;
    }

    player.graceRemaining = RECONNECT_GRACE;
    room.match?.setConnected(socketId, false);
    this.events.onOpponentLeft(room, player);
    this.events.onRoomUpdate(room);
  }

  private removePlayer(room: Room, playerId: string): void {
    const index = room.players.findIndex((p) => p.id === playerId);
    if (index >= 0) {
      const [removed] = room.players.splice(index, 1);
      if (removed.isBot) room.bot = null;
    }
    room.rematchVotes.delete(playerId);
    if (room.players.length > 0 && !room.players.some((p) => p.isHost)) {
      room.players[0].isHost = true;
    }
  }

  // -------------------------------------------------------------------------
  // Match flow
  // -------------------------------------------------------------------------

  private maybeStartMatch(room: Room): void {
    if (room.phase !== 'lobby') return;
    if (room.players.length !== 2) return;
    if (!room.players.every((p) => p.ready && p.connected)) return;

    const ids = room.players.map((p) => p.id);
    const roles = assignRoles(ids, room.round, room.seed);
    for (const player of room.players) player.role = roles[player.id];

    room.phase = 'roleReveal';
    room.phaseTimer = ROLE_REVEAL_DURATION;
    room.rematchVotes.clear();
    this.events.onRoleReveal(room);
    this.events.onRoomUpdate(room);
  }

  private beginMatch(room: Room): void {
    room.phase = 'countdown';
    room.phaseTimer = COUNTDOWN_DURATION;
    room.match = new Match({
      seed: room.seed,
      round: room.round,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role as Role,
        isBot: p.isBot,
      })),
    });
    this.events.onMatchStart(room);
    this.events.onRoomUpdate(room);
  }

  private endMatch(room: Room): void {
    if (room.phase === 'results') return;
    room.phase = 'results';
    room.phaseTimer = 0;
    room.rematchVotes.clear();
    for (const player of room.players) player.ready = false;
    this.events.onMatchEnd(room);
    this.events.onRoomUpdate(room);
  }

  voteRematch(socketId: string): Room | null {
    const room = this.getRoomForSocket(socketId);
    if (!room || room.phase !== 'results') return null;
    room.rematchVotes.add(socketId);

    const needed = room.players.filter((p) => !p.isBot && p.connected).length;
    const votes = [...room.rematchVotes].filter((id) => room.players.some((p) => p.id === id)).length;
    if (votes < needed || room.players.length !== 2) {
      this.events.onRoomUpdate(room);
      return room;
    }

    // Rematch: next round, which flips role assignment.
    room.round += 1;
    room.match = null;
    room.phase = 'lobby';
    room.rematchVotes.clear();
    for (const player of room.players) {
      player.ready = true;
      player.role = null;
    }
    this.maybeStartMatch(room);
    return room;
  }

  returnToLobby(socketId: string): Room | null {
    const room = this.getRoomForSocket(socketId);
    if (!room) return null;
    room.phase = 'lobby';
    room.match = null;
    room.phaseTimer = 0;
    room.rematchVotes.clear();
    for (const player of room.players) {
      player.ready = false;
      player.role = null;
    }
    this.events.onRoomUpdate(room);
    return room;
  }

  // -------------------------------------------------------------------------
  // Fixed-rate update
  // -------------------------------------------------------------------------

  update(dt: number): void {
    for (const [code, room] of this.rooms) {
      // Drop players whose reconnect grace has expired.
      for (const player of room.players) {
        if (player.connected || player.graceRemaining <= 0) continue;
        player.graceRemaining -= dt;
        if (player.graceRemaining <= 0 && room.match && !room.match.isFinished && player.role) {
          room.match.abandon(player.role);
          this.endMatch(room);
        }
      }

      switch (room.phase) {
        case 'roleReveal':
          room.phaseTimer -= dt;
          if (room.phaseTimer <= 0) this.beginMatch(room);
          break;
        case 'countdown':
        case 'active': {
          const match = room.match;
          if (!match) break;

          if (room.bot) {
            const { input, actions } = room.bot.update(match, dt);
            match.enqueueInput(room.bot.id, [input]);
            for (const action of actions) match.handleAction(room.bot.id, action);
          }

          match.tick(dt);

          if (room.phase === 'countdown') {
            room.phaseTimer -= dt;
            if (room.phaseTimer <= 0) room.phase = 'active';
          }
          if (match.isFinished) this.endMatch(room);
          break;
        }
        default:
          break;
      }

      // Reap rooms that nobody is in.
      const live = room.players.filter((p) => p.connected && !p.isBot).length;
      if (live === 0) {
        room.emptyFor += dt;
        if (room.emptyFor > EMPTY_ROOM_TTL) this.rooms.delete(code);
      } else {
        room.emptyFor = 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  buildRoomView(room: Room, forPlayerId: string): RoomView {
    const players: LobbyPlayerView[] = room.players.map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      connected: p.connected,
      // Roles are only exposed once the reveal has happened.
      role: room.phase === 'lobby' ? null : p.role,
      isHost: p.isHost,
    }));
    return {
      code: room.code,
      phase: room.phase,
      players,
      seed: room.seed,
      round: room.round,
      youId: forPlayerId,
    };
  }

  /** Test-only: the fixed tick used by the server loop. */
  static get tickDt(): number {
    return TICK_DT;
  }
}
