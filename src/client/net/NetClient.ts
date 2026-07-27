/**
 * Socket.IO wrapper. Owns the connection lifecycle and turns server events into
 * a small typed callback surface the app shell subscribes to.
 */

import { io, type Socket } from 'socket.io-client';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../shared/protocol.js';
import type {
  ClientToServerEvents,
  MatchEndPayload,
  MatchStartPayload,
  RoleRevealPayload,
  RoomErrorPayload,
  ServerToClientEvents,
} from '../../shared/protocol.js';
import type { ActionCommand, InputCommand, RoomView, WorldSnapshot } from '../../shared/types.js';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface NetHandlers {
  onConnectionState(state: ConnectionState, detail?: string): void;
  onRoom(view: RoomView): void;
  onRoomError(payload: RoomErrorPayload): void;
  onRoleReveal(payload: RoleRevealPayload): void;
  onMatchStart(payload: MatchStartPayload): void;
  onSnapshot(snapshot: WorldSnapshot): void;
  onMatchEnd(payload: MatchEndPayload): void;
  onOpponentLeft(payload: { name: string; graceSeconds: number }): void;
  onOpponentReturned(payload: { name: string }): void;
}

export class NetClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private handlers: NetHandlers | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private smoothedPing = 0;
  private state: ConnectionState = 'idle';

  setHandlers(handlers: NetHandlers): void {
    this.handlers = handlers;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get ping(): number {
    return this.smoothedPing;
  }

  get connected(): boolean {
    return this.socket?.connected === true;
  }

  get socketId(): string | null {
    return this.socket?.id ?? null;
  }

  connect(): void {
    if (this.socket) return;
    this.setState('connecting');

    // Same-origin in production; Vite proxies /socket.io to the game server in dev.
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 12,
      reconnectionDelay: 600,
      reconnectionDelayMax: 4000,
      timeout: 8000,
      autoConnect: true,
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.setState('connected');
      this.startPing();
    });

    socket.on('disconnect', (reason) => {
      this.stopPing();
      // An explicit client-side disconnect is not an error condition.
      if (reason === 'io client disconnect') this.setState('idle');
      else this.setState('reconnecting', 'Connection lost. Trying to reconnect…');
    });

    socket.io.on('reconnect_attempt', () => this.setState('reconnecting'));
    socket.io.on('reconnect', () => this.setState('connected'));
    socket.io.on('reconnect_failed', () =>
      this.setState('failed', 'Could not reach the Veil Hunt server.'),
    );
    socket.on('connect_error', (error: Error) => {
      this.setState(
        this.state === 'connected' ? 'reconnecting' : 'failed',
        `Could not reach the Veil Hunt server (${error.message}).`,
      );
    });

    socket.on(SERVER_EVENTS.room, (view) => this.handlers?.onRoom(view));
    socket.on(SERVER_EVENTS.roomError, (payload) => this.handlers?.onRoomError(payload));
    socket.on(SERVER_EVENTS.roleReveal, (payload) => this.handlers?.onRoleReveal(payload));
    socket.on(SERVER_EVENTS.matchStart, (payload) => this.handlers?.onMatchStart(payload));
    socket.on(SERVER_EVENTS.snapshot, (snapshot) => this.handlers?.onSnapshot(snapshot));
    socket.on(SERVER_EVENTS.matchEnd, (payload) => this.handlers?.onMatchEnd(payload));
    socket.on(SERVER_EVENTS.opponentLeft, (payload) => this.handlers?.onOpponentLeft(payload));
    socket.on(SERVER_EVENTS.opponentReturned, (payload) => this.handlers?.onOpponentReturned(payload));
    socket.on(SERVER_EVENTS.pong, (sentAt) => {
      const rtt = Date.now() - sentAt;
      this.smoothedPing = this.smoothedPing === 0 ? rtt : this.smoothedPing * 0.8 + rtt * 0.2;
    });
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.state = state;
    this.handlers?.onConnectionState(state, detail);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.socket?.emit(CLIENT_EVENTS.ping, Date.now());
    }, 2000);
    this.socket?.emit(CLIENT_EVENTS.ping, Date.now());
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  createRoom(name: string, seed?: number): void {
    this.socket?.emit(CLIENT_EVENTS.createRoom, seed === undefined ? { name } : { name, seed });
  }

  joinRoom(name: string, code: string): void {
    this.socket?.emit(CLIENT_EVENTS.joinRoom, { name, code });
  }

  setReady(ready: boolean): void {
    this.socket?.emit(CLIENT_EVENTS.setReady, { ready });
  }

  addBot(): void {
    this.socket?.emit(CLIENT_EVENTS.addBot);
  }

  leaveRoom(): void {
    this.socket?.emit(CLIENT_EVENTS.leaveRoom);
  }

  rematch(): void {
    this.socket?.emit(CLIENT_EVENTS.rematch);
  }

  returnToLobby(): void {
    this.socket?.emit(CLIENT_EVENTS.returnToLobby);
  }

  sendInput(commands: InputCommand[]): void {
    if (commands.length === 0) return;
    this.socket?.emit(CLIENT_EVENTS.input, commands);
  }

  /** Test-only; the server ignores this unless VEIL_TEST_HOOKS=1. */
  sendDebug(kind: string, value?: number): void {
    this.socket?.emit(CLIENT_EVENTS.debug, value === undefined ? { kind } : { kind, value });
  }

  sendAction(action: ActionCommand): void {
    this.socket?.emit(CLIENT_EVENTS.action, action);
  }

  dispose(): void {
    this.stopPing();
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.handlers = null;
  }
}
