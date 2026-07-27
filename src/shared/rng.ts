/**
 * Deterministic pseudo-random numbers. Every gameplay and layout decision routes
 * through here so a seed fully reproduces a match. `Math.random` must never
 * appear in shared, server or gameplay client code.
 */

export interface Rng {
  (): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** Returns a new array; does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[];
  bool(chance: number): boolean;
}

export function createRng(seed: number): Rng {
  let state = (seed >>> 0) || 0x9e3779b9;

  const next = (() => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;

  next.range = (min, max) => min + next() * (max - min);
  next.int = (min, max) => Math.floor(min + next() * (max - min + 1));
  next.pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  next.shuffle = <T,>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  };
  next.bool = (chance) => next() < chance;

  return next;
}

/** Stable 32-bit hash so string keys can seed sub-generators. */
export function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function randomSeed(): number {
  // Seeds themselves may come from entropy; everything downstream is deterministic.
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}
