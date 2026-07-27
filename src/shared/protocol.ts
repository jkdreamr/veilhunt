/** Socket.IO event names and payload shapes shared by client and server. */

import type {
  ActionCommand,
  InputCommand,
  MatchResult,
  Role,
  RoomView,
  WorldSnapshot,
} from './types.js';

export const CLIENT_EVENTS = {
  createRoom: 'c:createRoom',
  joinRoom: 'c:joinRoom',
  leaveRoom: 'c:leaveRoom',
  setReady: 'c:setReady',
  input: 'c:input',
  action: 'c:action',
  rematch: 'c:rematch',
  returnToLobby: 'c:returnToLobby',
  addBot: 'c:addBot',
  ping: 'c:ping',
  /**
   * Test-only channel. The server only registers this handler when
   * `VEIL_TEST_HOOKS=1` is set, so it does not exist in a normal production run.
   */
  debug: 'c:debug',
} as const;

export const SERVER_EVENTS = {
  room: 's:room',
  roomError: 's:roomError',
  roleReveal: 's:roleReveal',
  snapshot: 's:snapshot',
  matchStart: 's:matchStart',
  matchEnd: 's:matchEnd',
  opponentLeft: 's:opponentLeft',
  opponentReturned: 's:opponentReturned',
  pong: 's:pong',
} as const;

export interface CreateRoomPayload {
  name: string;
  seed?: number;
}

export interface JoinRoomPayload {
  name: string;
  code: string;
}

export interface SetReadyPayload {
  ready: boolean;
}

export interface RoomErrorPayload {
  code: 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'BAD_PAYLOAD' | 'NOT_IN_ROOM' | 'IN_MATCH' | 'RATE_LIMIT';
  message: string;
}

export interface MatchStartPayload {
  seed: number;
  role: Role;
  round: number;
  opponentName: string;
  /** Server epoch milliseconds when the active phase begins. */
  startsAt: number;
}

export interface RoleRevealPayload {
  role: Role;
  seed: number;
  round: number;
  opponentName: string;
  contract: { id: string; title: string; description: string } | null;
  duration: number;
}

export interface MatchEndPayload {
  result: MatchResult;
  yourRole: Role;
}

export interface ClientToServerEvents {
  [CLIENT_EVENTS.createRoom]: (payload: CreateRoomPayload) => void;
  [CLIENT_EVENTS.joinRoom]: (payload: JoinRoomPayload) => void;
  [CLIENT_EVENTS.leaveRoom]: () => void;
  [CLIENT_EVENTS.setReady]: (payload: SetReadyPayload) => void;
  [CLIENT_EVENTS.input]: (payload: InputCommand[]) => void;
  [CLIENT_EVENTS.action]: (payload: ActionCommand) => void;
  [CLIENT_EVENTS.rematch]: () => void;
  [CLIENT_EVENTS.returnToLobby]: () => void;
  [CLIENT_EVENTS.addBot]: () => void;
  [CLIENT_EVENTS.ping]: (sentAt: number) => void;
  [CLIENT_EVENTS.debug]: (payload: { kind: string; value?: number }) => void;
}

export interface ServerToClientEvents {
  [SERVER_EVENTS.room]: (view: RoomView) => void;
  [SERVER_EVENTS.roomError]: (payload: RoomErrorPayload) => void;
  [SERVER_EVENTS.roleReveal]: (payload: RoleRevealPayload) => void;
  [SERVER_EVENTS.snapshot]: (snapshot: WorldSnapshot) => void;
  [SERVER_EVENTS.matchStart]: (payload: MatchStartPayload) => void;
  [SERVER_EVENTS.matchEnd]: (payload: MatchEndPayload) => void;
  [SERVER_EVENTS.opponentLeft]: (payload: { name: string; graceSeconds: number }) => void;
  [SERVER_EVENTS.opponentReturned]: (payload: { name: string }) => void;
  [SERVER_EVENTS.pong]: (sentAt: number, serverTime: number) => void;
}
