import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../shared/constants.js';
import type { Rng } from '../shared/rng.js';

/**
 * Builds a short room code from an unambiguous alphabet (no 0/O, 1/I, 5/S) so
 * players can read it aloud over a call without confusion.
 */
export function makeRoomCode(rng: Rng): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[rng.int(0, ROOM_CODE_ALPHABET.length - 1)];
  }
  return code;
}

/** Retries until the code is unused; falls back to a longer code if saturated. */
export function makeUniqueRoomCode(rng: Rng, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const code = makeRoomCode(rng);
    if (!taken.has(code)) return code;
  }
  let code = makeRoomCode(rng);
  while (taken.has(code)) code += ROOM_CODE_ALPHABET[rng.int(0, ROOM_CODE_ALPHABET.length - 1)];
  return code;
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}
