/**
 * Runtime guards for every inbound socket payload. Anything arriving from a
 * client is untrusted: wrong types, NaN, Infinity, oversized arrays and unknown
 * action kinds are all rejected before touching match state.
 */

import { MAX_INPUT_BACKLOG, MAX_INPUT_DT, MAX_NAME_LENGTH, ROOM_CODE_LENGTH } from './constants.js';
import type { ActionCommand, ActionKind, InputCommand } from './types.js';
import type { CreateRoomPayload, JoinRoomPayload, SetReadyPayload } from './protocol.js';

const ACTION_KINDS: readonly ActionKind[] = [
  'interact',
  'interactStop',
  'primary',
  'secondary',
  'ability1',
  'ability2',
  'reload',
  'struggle',
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drops control characters and angle brackets, then trims to the display limit. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    if (ch === '<' || ch === '>') continue;
    cleaned += ch;
  }
  return cleaned.trim().slice(0, MAX_NAME_LENGTH);
}

export function sanitizeRoomCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function parseCreateRoom(payload: unknown): CreateRoomPayload | null {
  if (!isRecord(payload)) return null;
  const name = sanitizeName(payload.name);
  if (!name) return null;
  const seedRaw = payload.seed;
  const seed = isFiniteNumber(seedRaw) ? Math.abs(Math.floor(seedRaw)) % 0xffffffff : undefined;
  return seed === undefined ? { name } : { name, seed };
}

export function parseJoinRoom(payload: unknown): JoinRoomPayload | null {
  if (!isRecord(payload)) return null;
  const name = sanitizeName(payload.name);
  const code = sanitizeRoomCode(payload.code);
  if (!name || code.length !== ROOM_CODE_LENGTH) return null;
  return { name, code };
}

export function parseSetReady(payload: unknown): SetReadyPayload | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.ready !== 'boolean') return null;
  return { ready: payload.ready };
}

export function parseInputCommand(payload: unknown): InputCommand | null {
  if (!isRecord(payload)) return null;
  const { seq, dt, mx, mz, yaw, pitch } = payload;
  if (
    !isFiniteNumber(seq) ||
    !isFiniteNumber(dt) ||
    !isFiniteNumber(mx) ||
    !isFiniteNumber(mz) ||
    !isFiniteNumber(yaw) ||
    !isFiniteNumber(pitch)
  ) {
    return null;
  }
  if (seq < 0 || seq > Number.MAX_SAFE_INTEGER) return null;
  return {
    seq: Math.floor(seq),
    dt: clamp(dt, 0, MAX_INPUT_DT),
    mx: clamp(mx, -1, 1),
    mz: clamp(mz, -1, 1),
    yaw: clamp(yaw, -Math.PI * 4, Math.PI * 4),
    pitch: clamp(pitch, -1.5, 1.5),
    sprint: payload.sprint === true,
    crouch: payload.crouch === true,
    vault: payload.vault === true,
  };
}

/** Accepts a batch of inputs, dropping malformed entries and capping the size. */
export function parseInputBatch(payload: unknown): InputCommand[] | null {
  if (!Array.isArray(payload)) return null;
  if (payload.length === 0 || payload.length > MAX_INPUT_BACKLOG) return null;
  const out: InputCommand[] = [];
  for (const entry of payload) {
    const parsed = parseInputCommand(entry);
    if (parsed) out.push(parsed);
  }
  return out.length > 0 ? out : null;
}

export function parseAction(payload: unknown): ActionCommand | null {
  if (!isRecord(payload)) return null;
  const kind = payload.kind;
  if (typeof kind !== 'string' || !ACTION_KINDS.includes(kind as ActionKind)) return null;
  const yaw = isFiniteNumber(payload.yaw) ? clamp(payload.yaw, -Math.PI * 4, Math.PI * 4) : 0;
  const pitch = isFiniteNumber(payload.pitch) ? clamp(payload.pitch, -1.5, 1.5) : 0;
  const seq = isFiniteNumber(payload.seq) ? Math.max(0, Math.floor(payload.seq)) : 0;
  return { kind: kind as ActionKind, yaw, pitch, seq };
}
