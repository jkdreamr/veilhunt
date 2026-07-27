import { describe, expect, it } from 'vitest';
import {
  parseAction,
  parseCreateRoom,
  parseInputBatch,
  parseInputCommand,
  parseJoinRoom,
  parseSetReady,
  sanitizeName,
  sanitizeRoomCode,
} from '../../src/shared/validation.js';
import { MAX_INPUT_BACKLOG, MAX_INPUT_DT, MAX_NAME_LENGTH } from '../../src/shared/constants.js';
import { isValidRoomCode, makeRoomCode, makeUniqueRoomCode } from '../../src/server/roomCode.js';
import { createRng } from '../../src/shared/rng.js';

describe('name sanitisation', () => {
  it('trims and caps length', () => {
    expect(sanitizeName('  Vesper  ')).toBe('Vesper');
    expect(sanitizeName('x'.repeat(50))).toHaveLength(MAX_NAME_LENGTH);
  });

  it('strips control characters and angle brackets', () => {
    expect(sanitizeName('Ve\u0000s\u001fper')).toBe('Vesper');
    expect(sanitizeName('<script>hi</script>')).toBe('scripthi/scrip');
  });

  it('rejects non-strings', () => {
    expect(sanitizeName(42)).toBe('');
    expect(sanitizeName(null)).toBe('');
    expect(sanitizeName(undefined)).toBe('');
    expect(sanitizeName({})).toBe('');
  });
});

describe('room codes', () => {
  it('generates codes only from the unambiguous alphabet', () => {
    const rng = createRng(7);
    for (let i = 0; i < 200; i += 1) {
      const code = makeRoomCode(rng);
      expect(isValidRoomCode(code)).toBe(true);
      // Ambiguous glyphs must never appear.
      expect(code).not.toMatch(/[0O1I5S2Z8B]/);
    }
  });

  it('never collides with an already-taken code', () => {
    const rng = createRng(11);
    const taken = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const code = makeUniqueRoomCode(rng, taken);
      expect(taken.has(code)).toBe(false);
      taken.add(code);
    }
    expect(taken.size).toBe(400);
  });

  it('normalises user input', () => {
    expect(sanitizeRoomCode(' ab-cd ')).toBe('ABCD');
    expect(sanitizeRoomCode('abcdefgh')).toHaveLength(4);
    expect(sanitizeRoomCode(123)).toBe('');
  });

  it('rejects malformed codes', () => {
    expect(isValidRoomCode('AB')).toBe(false);
    expect(isValidRoomCode('ABCDE')).toBe(false);
    expect(isValidRoomCode('OOOO')).toBe(false); // O is not in the alphabet
  });
});

describe('payload rejection', () => {
  it('rejects malformed create/join payloads', () => {
    expect(parseCreateRoom(null)).toBeNull();
    expect(parseCreateRoom('nope')).toBeNull();
    expect(parseCreateRoom({})).toBeNull();
    expect(parseCreateRoom({ name: '   ' })).toBeNull();
    expect(parseCreateRoom({ name: 'Ok' })).toEqual({ name: 'Ok' });
    expect(parseCreateRoom({ name: 'Ok', seed: 123 })).toEqual({ name: 'Ok', seed: 123 });
    expect(parseCreateRoom({ name: 'Ok', seed: Number.NaN })).toEqual({ name: 'Ok' });

    expect(parseJoinRoom({ name: 'Ok' })).toBeNull();
    expect(parseJoinRoom({ name: 'Ok', code: 'AB' })).toBeNull();
    expect(parseJoinRoom({ name: 'Ok', code: 'acdf' })).toEqual({ name: 'Ok', code: 'ACDF' });
  });

  it('rejects a non-boolean ready flag', () => {
    expect(parseSetReady({ ready: 'yes' })).toBeNull();
    expect(parseSetReady({ ready: 1 })).toBeNull();
    expect(parseSetReady({ ready: true })).toEqual({ ready: true });
  });

  it('rejects NaN and Infinity in input commands', () => {
    const good = { seq: 1, dt: 0.033, mx: 0, mz: 1, yaw: 0, pitch: 0 };
    expect(parseInputCommand(good)).not.toBeNull();
    expect(parseInputCommand({ ...good, dt: Number.NaN })).toBeNull();
    expect(parseInputCommand({ ...good, mx: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseInputCommand({ ...good, yaw: Number.NEGATIVE_INFINITY })).toBeNull();
    expect(parseInputCommand({ ...good, seq: -1 })).toBeNull();
    expect(parseInputCommand({ ...good, seq: 'x' })).toBeNull();
  });

  it('clamps oversized movement and dt so a client cannot buy extra distance', () => {
    const parsed = parseInputCommand({ seq: 5, dt: 99, mx: 50, mz: -50, yaw: 0, pitch: 99 });
    expect(parsed).not.toBeNull();
    expect(parsed!.dt).toBe(MAX_INPUT_DT);
    expect(parsed!.mx).toBe(1);
    expect(parsed!.mz).toBe(-1);
    expect(parsed!.pitch).toBeLessThanOrEqual(1.5);
  });

  it('coerces missing booleans to false rather than undefined', () => {
    const parsed = parseInputCommand({ seq: 1, dt: 0.01, mx: 0, mz: 0, yaw: 0, pitch: 0 })!;
    expect(parsed.sprint).toBe(false);
    expect(parsed.crouch).toBe(false);
    expect(parsed.vault).toBe(false);
  });

  it('rejects oversized or empty input batches', () => {
    const one = { seq: 1, dt: 0.03, mx: 0, mz: 0, yaw: 0, pitch: 0 };
    expect(parseInputBatch([])).toBeNull();
    expect(parseInputBatch('nope')).toBeNull();
    expect(parseInputBatch(new Array(MAX_INPUT_BACKLOG + 1).fill(one))).toBeNull();
    expect(parseInputBatch([one])).toHaveLength(1);
  });

  it('drops malformed entries but keeps a valid batch', () => {
    const good = { seq: 1, dt: 0.03, mx: 0, mz: 0, yaw: 0, pitch: 0 };
    const batch = parseInputBatch([good, { seq: 'bad' }, { ...good, seq: 2 }]);
    expect(batch).toHaveLength(2);
  });

  it('rejects unknown action kinds', () => {
    expect(parseAction({ kind: 'launchNukes', yaw: 0, pitch: 0, seq: 1 })).toBeNull();
    expect(parseAction({ kind: 123 })).toBeNull();
    expect(parseAction(null)).toBeNull();
    expect(parseAction({ kind: 'primary', yaw: 0, pitch: 0, seq: 1 })?.kind).toBe('primary');
  });

  it('defaults action aim values when they are missing or invalid', () => {
    const parsed = parseAction({ kind: 'interact', yaw: Number.NaN, seq: -5 })!;
    expect(parsed.yaw).toBe(0);
    expect(parsed.pitch).toBe(0);
    expect(parsed.seq).toBe(0);
  });
});
