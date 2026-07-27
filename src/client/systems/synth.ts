/**
 * Veil Hunt — procedural voice rendering.
 *
 * Every sound the game can make is synthesised here into a plain mono
 * `Float32Array` at the destination sample rate. No audio files, no network
 * fetches, no libraries: oscillators, noise, filters and envelopes only.
 *
 * Rendering happens *offline* (straight maths into a typed array) rather than
 * by wiring live Web Audio nodes per hit. That keeps the realtime graph tiny —
 * a one-shot is a single `AudioBufferSourceNode` plus a couple of shaping
 * nodes — which is what makes hundreds of footsteps over a seven minute match
 * cheap and leak-free.
 *
 * Determinism: every recipe draws from a seeded `Rng` derived from the sound
 * name and variant index, so a given build always produces bit-identical
 * buffers. `Math.random` never appears here.
 */

import { createRng, hashString, type Rng } from '../../shared/rng.js';
import type { SoundKind } from '../../shared/types.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Buffer helpers
// ---------------------------------------------------------------------------

export function alloc(sampleRate: number, seconds: number): Float32Array {
  return new Float32Array(Math.max(1, Math.round(sampleRate * seconds)));
}

export function mixInto(dst: Float32Array, src: Float32Array, gain = 1, offset = 0): void {
  const start = Math.max(0, offset | 0);
  const count = Math.min(src.length, dst.length - start);
  for (let i = 0; i < count; i += 1) dst[start + i] += src[i] * gain;
}

export function scaleBuffer(buf: Float32Array, gain: number): void {
  for (let i = 0; i < buf.length; i += 1) buf[i] *= gain;
}

/** Scales so the loudest sample sits at `peak`. Silent buffers are left alone. */
export function normalize(buf: Float32Array, peak = 0.95): void {
  let max = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const a = Math.abs(buf[i]);
    if (a > max) max = a;
  }
  if (max > 1e-6) scaleBuffer(buf, peak / max);
}

/** Forces the buffer edges to zero so playback can never click. */
export function fadeEdges(buf: Float32Array, sampleRate: number, inSec = 0.001, outSec = 0.006): void {
  const n = buf.length;
  const fin = Math.min(n, Math.max(1, Math.round(inSec * sampleRate)));
  const fout = Math.min(n, Math.max(1, Math.round(outSec * sampleRate)));
  for (let i = 0; i < fin; i += 1) buf[i] *= i / fin;
  for (let i = 0; i < fout; i += 1) buf[n - 1 - i] *= i / fout;
}

/** Soft clip. `drive` above 1 adds harmonics and glues transients together. */
export function saturate(buf: Float32Array, drive = 2): void {
  const norm = Math.tanh(drive);
  for (let i = 0; i < buf.length; i += 1) buf[i] = Math.tanh(buf[i] * drive) / norm;
}

/**
 * Turns a buffer into a seamless loop by crossfading its tail back over its
 * head. The result is `fadeSec` shorter than the input.
 */
export function makeSeamless(buf: Float32Array, sampleRate: number, fadeSec: number): Float32Array {
  const fade = Math.min(buf.length >> 1, Math.max(1, Math.round(fadeSec * sampleRate)));
  const len = buf.length - fade;
  const out = new Float32Array(len);
  out.set(buf.subarray(0, len));
  for (let i = 0; i < fade; i += 1) {
    const t = i / fade;
    out[i] = buf[i] * t + buf[len + i] * (1 - t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

export type NoiseColor = 'white' | 'pink' | 'brown';

export function fillNoise(out: Float32Array, rng: Rng, color: NoiseColor = 'white', gain = 1): void {
  if (color === 'white') {
    for (let i = 0; i < out.length; i += 1) out[i] = (rng() * 2 - 1) * gain;
    return;
  }
  if (color === 'brown') {
    let last = 0;
    for (let i = 0; i < out.length; i += 1) {
      const w = rng() * 2 - 1;
      last = (last + 0.028 * w) / 1.028;
      out[i] = last * 3.2 * gain;
    }
    return;
  }
  // Paul Kellet's economical pink filter.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < out.length; i += 1) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.36 * gain;
    b6 = w * 0.115926;
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type BiquadKind = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'notch';

/** Static RBJ biquad, applied in place. */
export function biquad(
  buf: Float32Array,
  sampleRate: number,
  kind: BiquadKind,
  freq: number,
  q = 0.707,
  gainDb = 0,
): void {
  const f = Math.min(Math.max(freq, 10), sampleRate * 0.48);
  const w = (TAU * f) / sampleRate;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const alpha = sw / (2 * Math.max(0.05, q));
  const a = Math.pow(10, gainDb / 40);

  let b0 = 1;
  let b1 = 0;
  let b2 = 0;
  let a0 = 1;
  let a1 = 0;
  let a2 = 0;

  switch (kind) {
    case 'lowpass':
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1;
      b1 = -2 * cw;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * a;
      b1 = -2 * cw;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * cw;
      a2 = 1 - alpha / a;
      break;
  }

  const n0 = b0 / a0;
  const n1 = b1 / a0;
  const n2 = b2 / a0;
  const d1 = a1 / a0;
  const d2 = a2 / a0;

  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const x0 = buf[i];
    const y0 = n0 * x0 + n1 * x1 + n2 * x2 - d1 * y1 - d2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    buf[i] = y0;
  }
}

export type SvfMode = 'lp' | 'hp' | 'bp';

/**
 * Chamberlin state-variable filter with a swept cutoff, applied in place.
 * Unconditionally stable for our cutoff range and much better behaved under
 * modulation than recomputing biquad coefficients per sample.
 */
export function svfSweep(
  buf: Float32Array,
  sampleRate: number,
  mode: SvfMode,
  f0: number,
  f1: number,
  q = 0.9,
  sweepCurve = 1,
): void {
  const n = buf.length;
  if (n === 0) return;
  const ratio = Math.max(1e-4, f1 / Math.max(1e-4, f0));
  const damp = Math.min(1.9, Math.max(0.04, 1 / Math.max(0.1, q)));
  const maxF = sampleRate * 0.22;
  let low = 0;
  let band = 0;
  let f = 0;
  for (let i = 0; i < n; i += 1) {
    if ((i & 15) === 0) {
      const u = n > 1 ? i / (n - 1) : 0;
      const fc = Math.min(maxF, Math.max(12, f0 * Math.pow(ratio, Math.pow(u, sweepCurve))));
      f = Math.min(1.1, 2 * Math.sin((Math.PI * fc) / sampleRate));
    }
    const input = buf[i];
    const high = input - low - damp * band;
    band += f * high;
    low += f * band;
    if (band > 12) band = 12;
    else if (band < -12) band = -12;
    if (low > 12) low = 12;
    else if (low < -12) low = -12;
    buf[i] = mode === 'lp' ? low : mode === 'hp' ? high : band;
  }
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** Attack then power-law decay across the whole buffer; ends at exactly zero. */
export function applyAd(buf: Float32Array, sampleRate: number, attack: number, curve = 2.5): void {
  const n = buf.length;
  const att = Math.max(1, Math.round(attack * sampleRate));
  const tail = Math.max(1, n - att);
  for (let i = 0; i < n; i += 1) {
    let g: number;
    if (i < att) g = Math.pow(i / att, 0.65);
    else g = Math.pow(1 - (i - att) / tail, curve);
    buf[i] *= g;
  }
}

/** Attack / hold / release swell across the whole buffer. */
export function applySwell(
  buf: Float32Array,
  sampleRate: number,
  attack: number,
  hold: number,
  curve = 2,
): void {
  const n = buf.length;
  const att = Math.max(1, Math.round(attack * sampleRate));
  const hld = Math.max(0, Math.round(hold * sampleRate));
  const rel = Math.max(1, n - att - hld);
  for (let i = 0; i < n; i += 1) {
    let g: number;
    if (i < att) g = Math.pow(i / att, 1.4);
    else if (i < att + hld) g = 1;
    else g = Math.pow(1 - (i - att - hld) / rel, curve);
    buf[i] *= g;
  }
}

/** Multiplies in a tremolo whose rate glides from `hz0` to `hz1`. */
export function applyTremolo(
  buf: Float32Array,
  sampleRate: number,
  hz0: number,
  hz1: number,
  depth = 0.5,
): void {
  const n = buf.length;
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const u = n > 1 ? i / (n - 1) : 0;
    phase += (TAU * (hz0 + (hz1 - hz0) * u)) / sampleRate;
    buf[i] *= 1 - depth + depth * (0.5 + 0.5 * Math.sin(phase));
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export type ToneShape = 'sine' | 'tri' | 'saw' | 'square';

export interface ToneOpts {
  freq: number;
  /** Exponential glide target; defaults to `freq`. */
  freqEnd?: number;
  amp?: number;
  dur: number;
  /** Start time in seconds from the head of the buffer. */
  offset?: number;
  attack?: number;
  /** Amplitude decay exponent over `dur`; 0 sustains flat. */
  curve?: number;
  /** Shape of the frequency glide; >1 sweeps late, <1 sweeps early. */
  sweepCurve?: number;
  phase?: number;
  vibratoHz?: number;
  /** Vibrato depth as a fraction of the current frequency. */
  vibratoDepth?: number;
  shape?: ToneShape;
}

/** Adds a (optionally gliding) oscillator into `buf`. */
export function addTone(buf: Float32Array, sampleRate: number, o: ToneOpts): void {
  const start = Math.max(0, Math.round((o.offset ?? 0) * sampleRate));
  const count = Math.min(buf.length - start, Math.max(1, Math.round(o.dur * sampleRate)));
  if (count <= 0) return;

  const amp = o.amp ?? 1;
  const f0 = Math.max(0.01, o.freq);
  const f1 = Math.max(0.01, o.freqEnd ?? o.freq);
  const ratio = f1 / f0;
  const sweepCurve = o.sweepCurve ?? 1;
  const curve = o.curve ?? 2;
  const att = Math.max(1, Math.round((o.attack ?? 0.002) * sampleRate));
  const shape = o.shape ?? 'sine';
  const vibHz = o.vibratoHz ?? 0;
  const vibDepth = o.vibratoDepth ?? 0;

  let p = ((o.phase ?? 0) / TAU) % 1;
  let vp = 0;
  for (let i = 0; i < count; i += 1) {
    const u = count > 1 ? i / (count - 1) : 0;
    let f = f0 * Math.pow(ratio, Math.pow(u, sweepCurve));
    if (vibHz > 0) {
      vp += (TAU * vibHz) / sampleRate;
      f *= 1 + vibDepth * Math.sin(vp);
    }
    p += f / sampleRate;
    if (p >= 1) p -= Math.floor(p);

    let s: number;
    if (shape === 'sine') s = Math.sin(TAU * p);
    else if (shape === 'tri') s = 4 * Math.abs(p - 0.5) - 1;
    else if (shape === 'saw') s = 2 * p - 1;
    else s = p < 0.5 ? 1 : -1;

    const env = (i < att ? i / att : 1) * (curve <= 0 ? 1 : Math.pow(1 - u, curve));
    buf[start + i] += s * amp * env;
  }
}

export interface ModalPartial {
  freq: number;
  amp: number;
  /** −60 dB time in seconds. */
  decay: number;
}

/**
 * Bank of exponentially decaying sinusoids — the workhorse for bells, chimes,
 * glass and struck metal. Uses a two-pole resonator recurrence so each partial
 * costs three multiplies per sample.
 */
export function addModal(
  buf: Float32Array,
  sampleRate: number,
  offset: number,
  partials: readonly ModalPartial[],
  ampScale = 1,
): void {
  const start = Math.max(0, Math.round(offset * sampleRate));
  for (const partial of partials) {
    const w = (TAU * partial.freq) / sampleRate;
    if (w >= Math.PI * 0.98) continue;
    const r = Math.pow(10, -3 / Math.max(1, partial.decay * sampleRate));
    const c = 2 * r * Math.cos(w);
    const d = r * r;
    const count = Math.min(buf.length - start, Math.round(partial.decay * sampleRate * 1.05));
    let prev = 0;
    let cur = partial.amp * ampScale * r * Math.sin(w);
    for (let i = 1; i < count; i += 1) {
      buf[start + i] += cur;
      const next = c * cur - d * prev;
      prev = cur;
      cur = next;
    }
  }
}

/** Karplus–Strong pluck. `bright` 0..1 shapes the excitation, `damp` the loop. */
export function addKarplus(
  buf: Float32Array,
  sampleRate: number,
  offset: number,
  freq: number,
  dur: number,
  damp: number,
  amp: number,
  rng: Rng,
  bright = 0.6,
): void {
  const start = Math.max(0, Math.round(offset * sampleRate));
  const count = Math.min(buf.length - start, Math.max(1, Math.round(dur * sampleRate)));
  const n = Math.max(2, Math.round(sampleRate / Math.max(20, freq)));
  const line = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i += 1) {
    const w = rng() * 2 - 1;
    lp += (w - lp) * (0.15 + 0.85 * bright);
    line[i] = lp;
  }
  const g = Math.min(0.999, Math.max(0.5, damp));
  let idx = 0;
  let last = 0;
  for (let i = 0; i < count; i += 1) {
    const cur = line[idx];
    const filtered = (cur + last) * 0.5 * g;
    last = cur;
    line[idx] = filtered;
    idx = (idx + 1) % n;
    buf[start + i] += cur * amp;
  }
}

/**
 * Impulse train whose rate glides and jitters — the excitation behind grinding
 * stone and stick-slip creaks.
 */
export function fillImpulseTrain(
  out: Float32Array,
  sampleRate: number,
  rate0: number,
  rate1: number,
  jitter: number,
  rng: Rng,
): void {
  const n = out.length;
  let next = 0;
  for (let i = 0; i < n; i += 1) out[i] = 0;
  while (next < n) {
    const u = n > 1 ? next / n : 0;
    const rate = Math.max(1, rate0 + (rate1 - rate0) * u);
    const idx = Math.floor(next);
    if (idx >= 0 && idx < n) out[idx] += 1 - 0.4 * rng();
    next += (sampleRate / rate) * (1 + jitter * (rng() * 2 - 1));
  }
}

// ---------------------------------------------------------------------------
// Reverb (Schroeder comb + allpass, baked straight into the buffer)
// ---------------------------------------------------------------------------

export interface ReverbOpts {
  /** −60 dB time in seconds. */
  decay: number;
  /** 0..1 wet blend added on top of the dry signal. */
  mix: number;
  /** 0..1 high-frequency absorption in the feedback path. */
  damp?: number;
}

export function applyReverb(buf: Float32Array, sampleRate: number, o: ReverbOpts): void {
  const scale = sampleRate / 44100;
  const combLens = [1557, 1617, 1491, 1422, 1277, 1356].map((v) => Math.max(8, Math.round(v * scale)));
  const apLens = [225, 556, 441].map((v) => Math.max(4, Math.round(v * scale)));
  const damp = Math.min(0.95, Math.max(0, o.damp ?? 0.35));
  const n = buf.length;
  const wet = new Float32Array(n);

  for (const len of combLens) {
    const line = new Float32Array(len);
    const delaySec = len / sampleRate;
    const fb = Math.min(0.985, Math.pow(10, (-3 * delaySec) / Math.max(0.05, o.decay)));
    let idx = 0;
    let store = 0;
    for (let i = 0; i < n; i += 1) {
      const out = line[idx];
      wet[i] += out;
      store = out * (1 - damp) + store * damp;
      line[idx] = buf[i] + store * fb;
      idx += 1;
      if (idx >= len) idx = 0;
    }
  }
  scaleBuffer(wet, 1 / combLens.length);

  for (const len of apLens) {
    const line = new Float32Array(len);
    let idx = 0;
    for (let i = 0; i < n; i += 1) {
      const delayed = line[idx];
      const input = wet[i];
      const out = -input + delayed;
      line[idx] = input + delayed * 0.5;
      idx += 1;
      if (idx >= len) idx = 0;
      wet[i] = out;
    }
  }

  for (let i = 0; i < n; i += 1) buf[i] += wet[i] * o.mix;
}

/** Procedural stereo impulse response for the shared realtime reverb send. */
export function renderImpulseResponse(sampleRate: number, seconds: number): [Float32Array, Float32Array] {
  const channels: [Float32Array, Float32Array] = [
    alloc(sampleRate, seconds),
    alloc(sampleRate, seconds),
  ];
  for (let c = 0; c < 2; c += 1) {
    const rng = createRng(hashString(`veilhunt.ir.${c}`));
    const buf = channels[c];
    fillNoise(buf, rng, 'white', 1);
    const n = buf.length;
    for (let i = 0; i < n; i += 1) {
      const t = i / sampleRate;
      buf[i] *= Math.exp(-t * (5.2 / seconds)) * (0.25 + 0.75 * Math.min(1, t * 260));
    }
    // Sparse early reflections give the ruins some geometry.
    for (let k = 0; k < 7; k += 1) {
      const at = Math.round(rng.range(0.004, 0.085) * sampleRate);
      if (at < n) buf[at] += rng.range(0.25, 0.6) * (k % 2 === 0 ? 1 : -1);
    }
    biquad(buf, sampleRate, 'highpass', 190, 0.7);
    biquad(buf, sampleRate, 'lowpass', 5200, 0.7);
    normalize(buf, 0.6);
    fadeEdges(buf, sampleRate, 0.0005, 0.05);
  }
  return channels;
}

// ---------------------------------------------------------------------------
// Compact layer helpers used by the recipes
// ---------------------------------------------------------------------------

export interface NoiseLayerOpts {
  color?: NoiseColor;
  mode?: SvfMode;
  f0?: number;
  f1?: number;
  q?: number;
  sweepCurve?: number;
  attack?: number;
  curve?: number;
  gain?: number;
  /** Static highpass applied after the sweep, to strip rumble. */
  hp?: number;
  /** Static lowpass applied after the sweep. */
  lp?: number;
  /** When set, a swell envelope (attack / hold / release) replaces the AD. */
  hold?: number;
}

/** Renders one enveloped, filtered noise layer as its own buffer. */
export function noiseLayer(
  sampleRate: number,
  seconds: number,
  rng: Rng,
  o: NoiseLayerOpts = {},
): Float32Array {
  const buf = alloc(sampleRate, seconds);
  fillNoise(buf, rng, o.color ?? 'white', 1);
  if (o.f0 !== undefined) {
    svfSweep(buf, sampleRate, o.mode ?? 'lp', o.f0, o.f1 ?? o.f0, o.q ?? 0.9, o.sweepCurve ?? 1);
  }
  if (o.hp !== undefined) biquad(buf, sampleRate, 'highpass', o.hp, 0.7);
  if (o.lp !== undefined) biquad(buf, sampleRate, 'lowpass', o.lp, 0.7);
  if (o.hold !== undefined) applySwell(buf, sampleRate, o.attack ?? 0.01, o.hold, o.curve ?? 2);
  else applyAd(buf, sampleRate, o.attack ?? 0.001, o.curve ?? 2.5);
  if (o.gain !== undefined) scaleBuffer(buf, o.gain);
  return buf;
}

/** Common tail treatment: trim edges and normalise to a predictable peak. */
function finish(buf: Float32Array, sampleRate: number, peak = 0.94): Float32Array {
  fadeEdges(buf, sampleRate, 0.0008, 0.008);
  normalize(buf, peak);
  return buf;
}

// ---------------------------------------------------------------------------
// Recipes — one per SoundKind
// ---------------------------------------------------------------------------

type Recipe = (sr: number, rng: Rng) => Float32Array;

/** Short filtered noise click with a hard transient — boots on flagstone. */
const footstepStone: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.15);
  mixInto(buf, noiseLayer(sr, 0.075, rng, { f0: 2600, f1: 900, mode: 'bp', q: 1.3, curve: 3.4, gain: 1 }));
  mixInto(buf, noiseLayer(sr, 0.13, rng, { f0: 1500, f1: 520, mode: 'lp', q: 0.8, curve: 2.6, gain: 0.55 }));
  addTone(buf, sr, { freq: rng.range(3000, 3500), freqEnd: 1400, amp: 0.35, dur: 0.008, curve: 2 });
  addTone(buf, sr, { freq: rng.range(104, 118), freqEnd: 74, amp: 0.4, dur: 0.05, curve: 3 });
  saturate(buf, 1.6);
  return finish(buf, sr, 0.9);
};

/** Softer, duller, more low-mid — packed earth. */
const footstepDirt: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.19);
  mixInto(buf, noiseLayer(sr, 0.13, rng, { f0: 1100, f1: 380, mode: 'lp', q: 0.9, attack: 0.003, curve: 2.6 }));
  mixInto(buf, noiseLayer(sr, 0.17, rng, { color: 'brown', f0: 460, f1: 200, mode: 'lp', q: 0.7, curve: 2.2, gain: 0.9 }));
  addTone(buf, sr, { freq: rng.range(74, 86), freqEnd: 52, amp: 0.45, dur: 0.07, curve: 2.6 });
  biquad(buf, sr, 'peaking', 300, 1.1, 3);
  return finish(buf, sr, 0.82);
};

/** Brushy high-frequency swish — long grass and dead leaves. */
const footstepGrass: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.26);
  mixInto(buf, noiseLayer(sr, 0.2, rng, { f0: 2600, f1: 6200, mode: 'bp', q: 0.75, attack: 0.014, curve: 2.1 }));
  mixInto(buf, noiseLayer(sr, 0.14, rng, { f0: 4200, f1: 2400, mode: 'hp', q: 0.6, attack: 0.006, curve: 3, gain: 0.6 }), 1, Math.round(0.045 * sr));
  mixInto(buf, noiseLayer(sr, 0.09, rng, { f0: 700, f1: 300, mode: 'lp', curve: 3, gain: 0.28 }));
  biquad(buf, sr, 'highpass', 900, 0.7);
  return finish(buf, sr, 0.78);
};

/** Wet splash with a bright droplet tail. Crossing water must feel dangerous. */
const footstepWater: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.52);
  mixInto(buf, noiseLayer(sr, 0.24, rng, { f0: 5200, f1: 420, mode: 'lp', q: 1.1, curve: 2.2, sweepCurve: 0.55 }));
  mixInto(buf, noiseLayer(sr, 0.34, rng, { f0: 1400, f1: 900, mode: 'bp', q: 1.6, attack: 0.02, curve: 2.4, gain: 0.7 }));
  addTone(buf, sr, { freq: rng.range(380, 460), freqEnd: 88, amp: 0.5, dur: 0.11, curve: 2.4, sweepCurve: 0.7 });
  for (let i = 0; i < 4; i += 1) {
    addTone(buf, sr, {
      freq: rng.range(2300, 4600),
      freqEnd: rng.range(1500, 2600),
      amp: rng.range(0.1, 0.24),
      dur: rng.range(0.03, 0.07),
      offset: rng.range(0.1, 0.33),
      curve: 3.2,
    });
  }
  mixInto(buf, noiseLayer(sr, 0.2, rng, { f0: 3200, f1: 1500, mode: 'bp', q: 2.2, attack: 0.03, curve: 2.6, gain: 0.3 }), 1, Math.round(0.13 * sr));
  saturate(buf, 1.4);
  return finish(buf, sr, 0.98);
};

/** A footstep with a faint spectral shimmer — an attentive Hunter can just tell. */
const decoyStep: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.34);
  mixInto(buf, noiseLayer(sr, 0.11, rng, { f0: 2100, f1: 700, mode: 'bp', q: 1.2, curve: 3 }));
  mixInto(buf, noiseLayer(sr, 0.15, rng, { f0: 900, f1: 340, mode: 'lp', q: 0.8, curve: 2.6, gain: 0.6 }));
  addTone(buf, sr, { freq: rng.range(92, 104), freqEnd: 66, amp: 0.38, dur: 0.055, curve: 2.8 });
  const shimmer = alloc(sr, 0.3);
  addModal(shimmer, sr, 0, [
    { freq: rng.range(4600, 4900), amp: 0.5, decay: 0.26 },
    { freq: rng.range(5800, 6100), amp: 0.36, decay: 0.2 },
    { freq: rng.range(7200, 7500), amp: 0.24, decay: 0.15 },
  ]);
  applyTremolo(shimmer, sr, 21, 27, 0.75);
  applyAd(shimmer, sr, 0.012, 2.2);
  mixInto(buf, shimmer, 0.17, Math.round(0.02 * sr));
  return finish(buf, sr, 0.86);
};

/** Cloth rustle plus a gritty scuff and a short effort grunt. */
const vault: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.66);
  mixInto(buf, noiseLayer(sr, 0.24, rng, { f0: 1800, f1: 4200, mode: 'hp', q: 0.7, attack: 0.02, curve: 2, gain: 0.55 }));
  mixInto(buf, noiseLayer(sr, 0.3, rng, { f0: 1400, f1: 420, mode: 'bp', q: 1.4, attack: 0.01, curve: 2.4, gain: 0.7 }), 1, Math.round(0.12 * sr));
  const grunt = alloc(sr, 0.26);
  addTone(grunt, sr, { freq: rng.range(126, 148), freqEnd: 98, amp: 0.5, dur: 0.24, attack: 0.02, curve: 2.4, shape: 'saw' });
  biquad(grunt, sr, 'bandpass', 640, 2.6);
  const grunt2 = alloc(sr, 0.26);
  fillNoise(grunt2, rng, 'white', 1);
  svfSweep(grunt2, sr, 'bp', 1150, 900, 4);
  applyAd(grunt2, sr, 0.03, 2.4);
  mixInto(grunt, grunt2, 0.35);
  mixInto(buf, grunt, 0.9, Math.round(0.16 * sr));
  return finish(buf, sr, 0.8);
};

/** Rising ritual hum — a stack of fifths climbing under a widening filter. */
const sealStart: Recipe = (sr, rng) => {
  const buf = alloc(sr, 1.9);
  const root = 104 * rng.range(0.985, 1.015);
  for (const [mult, amp] of [[1, 0.5], [1.5, 0.3], [2, 0.22], [3, 0.12], [4, 0.08]] as const) {
    addTone(buf, sr, {
      freq: root * mult,
      freqEnd: root * mult * 1.78,
      amp,
      dur: 1.85,
      attack: 0.32,
      curve: 0.8,
      sweepCurve: 1.6,
      vibratoHz: 4.6,
      vibratoDepth: 0.006,
      shape: mult === 1 ? 'tri' : 'sine',
    });
  }
  mixInto(buf, noiseLayer(sr, 1.9, rng, { color: 'pink', f0: 380, f1: 2600, mode: 'bp', q: 2.4, attack: 0.4, hold: 0.6, curve: 2, gain: 0.5 }));
  svfSweep(buf, sr, 'lp', 700, 3600, 0.8, 1.4);
  applySwell(buf, sr, 0.3, 1.1, 2.2);
  applyReverb(buf, sr, { decay: 1.4, mix: 0.28, damp: 0.4 });
  return finish(buf, sr, 0.88);
};

/** Deep distant bell toll with a long shimmering tail. A map-wide event. */
const sealDone: Recipe = (sr, rng) => {
  const buf = alloc(sr, 4.8);
  const f = 97 * rng.range(0.99, 1.01);
  addModal(buf, sr, 0, [
    { freq: f * 0.5, amp: 0.42, decay: 4.2 },
    { freq: f, amp: 1, decay: 3.8 },
    { freq: f * 2.0, amp: 0.62, decay: 3.0 },
    { freq: f * 2.4, amp: 0.5, decay: 2.4 },
    { freq: f * 3.0, amp: 0.34, decay: 1.9 },
    { freq: f * 4.5, amp: 0.26, decay: 1.4 },
    { freq: f * 5.33, amp: 0.2, decay: 1.1 },
    { freq: f * 6.0, amp: 0.14, decay: 0.8 },
    { freq: f * 8.0, amp: 0.1, decay: 0.55 },
  ]);
  // Strike transient.
  mixInto(buf, noiseLayer(sr, 0.09, rng, { f0: 3800, f1: 900, mode: 'bp', q: 1.1, curve: 3.4, gain: 0.5 }));
  // Shimmer: an octave-and-a-fifth halo with a slow beat.
  const shimmer = alloc(sr, 4.2);
  addModal(shimmer, sr, 0.02, [
    { freq: f * 6.02, amp: 0.4, decay: 3.4 },
    { freq: f * 9.01, amp: 0.28, decay: 2.8 },
    { freq: f * 12.05, amp: 0.18, decay: 2.2 },
    { freq: f * 18.1, amp: 0.1, decay: 1.6 },
  ]);
  applyTremolo(shimmer, sr, 0.7, 2.4, 0.55);
  mixInto(buf, shimmer, 0.34);
  applyReverb(buf, sr, { decay: 3.2, mix: 0.4, damp: 0.5 });
  biquad(buf, sr, 'lowpass', 5200, 0.6);
  fadeEdges(buf, sr, 0.0006, 0.35);
  normalize(buf, 0.96);
  return buf;
};

/** Rising tension drone with a souring minor second and quickening tremolo. */
const gateChannel: Recipe = (sr, rng) => {
  const buf = alloc(sr, 2.4);
  const root = 54 * rng.range(0.99, 1.01);
  addTone(buf, sr, { freq: root, freqEnd: root * 1.52, amp: 0.6, dur: 2.35, attack: 0.25, curve: 0.6, shape: 'saw', sweepCurve: 1.5 });
  addTone(buf, sr, { freq: root * 1.06, freqEnd: root * 1.6, amp: 0.42, dur: 2.35, attack: 0.3, curve: 0.6, shape: 'saw', sweepCurve: 1.5 });
  addTone(buf, sr, { freq: root * 2.02, freqEnd: root * 3.1, amp: 0.22, dur: 2.35, attack: 0.5, curve: 0.6, sweepCurve: 1.7 });
  mixInto(buf, noiseLayer(sr, 2.4, rng, { color: 'brown', f0: 140, f1: 900, mode: 'bp', q: 2.8, attack: 0.6, hold: 0.9, curve: 1.6, gain: 0.7 }));
  applyTremolo(buf, sr, 3.2, 11, 0.3);
  svfSweep(buf, sr, 'lp', 420, 2200, 0.9, 1.5);
  applySwell(buf, sr, 0.35, 1.5, 2);
  saturate(buf, 1.8);
  return finish(buf, sr, 0.9);
};

/** Huge grinding stone-and-iron rise, ending in a boom. */
const gateOpen: Recipe = (sr, rng) => {
  const buf = alloc(sr, 3.4);
  // Grind: an impulse-train-modulated brown noise through a rising resonance.
  const grind = alloc(sr, 3.0);
  fillNoise(grind, rng, 'brown', 1);
  const grain = alloc(sr, 3.0);
  fillImpulseTrain(grain, sr, 26, 74, 0.42, rng);
  svfSweep(grain, sr, 'lp', 220, 220, 0.9);
  normalize(grain, 1);
  for (let i = 0; i < grind.length; i += 1) grind[i] *= 0.35 + 0.9 * grain[i];
  svfSweep(grind, sr, 'bp', 90, 940, 2.6, 1.3);
  applySwell(grind, sr, 0.28, 1.9, 1.6);
  saturate(grind, 3.2);
  mixInto(buf, grind, 0.95);
  // Iron scrape partials riding on top.
  for (let i = 0; i < 6; i += 1) {
    const t = rng.range(0.15, 2.4);
    addModal(buf, sr, t, [
      { freq: rng.range(760, 1900), amp: rng.range(0.06, 0.16), decay: rng.range(0.12, 0.4) },
      { freq: rng.range(2100, 3600), amp: rng.range(0.03, 0.09), decay: rng.range(0.08, 0.22) },
    ]);
  }
  // Sub rumble + the closing slam.
  addTone(buf, sr, { freq: 38, freqEnd: 27, amp: 0.6, dur: 3.2, attack: 0.4, curve: 1.4 });
  addTone(buf, sr, { freq: 86, freqEnd: 31, amp: 0.75, dur: 0.55, offset: 2.55, curve: 2.6 });
  mixInto(buf, noiseLayer(sr, 0.7, rng, { color: 'brown', f0: 900, f1: 120, mode: 'lp', q: 1, curve: 2.4, gain: 0.7 }), 1, Math.round(2.55 * sr));
  applyReverb(buf, sr, { decay: 2.4, mix: 0.3, damp: 0.55 });
  return finish(buf, sr, 0.97);
};

/** Warm restorative hum — consonant, slow, unthreatening. */
const shrineStart: Recipe = (sr, rng) => {
  const buf = alloc(sr, 2.0);
  const root = 174 * rng.range(0.995, 1.005);
  for (const [mult, amp] of [[0.5, 0.4], [1, 0.55], [1.5, 0.3], [2, 0.2], [2.5, 0.1]] as const) {
    addTone(buf, sr, {
      freq: root * mult,
      amp,
      dur: 1.95,
      attack: 0.42,
      curve: 0.7,
      vibratoHz: 3.4,
      vibratoDepth: 0.004,
    });
  }
  mixInto(buf, noiseLayer(sr, 2.0, rng, { color: 'pink', f0: 900, f1: 2200, mode: 'bp', q: 1.4, attack: 0.5, hold: 0.7, curve: 2, gain: 0.3 }));
  biquad(buf, sr, 'lowpass', 2400, 0.7);
  applySwell(buf, sr, 0.45, 0.9, 2.2);
  applyReverb(buf, sr, { decay: 1.6, mix: 0.26, damp: 0.45 });
  return finish(buf, sr, 0.85);
};

/** Bright healing chime — a rising triad of struck glass. */
const shrineDone: Recipe = (sr, rng) => {
  const buf = alloc(sr, 2.8);
  const base = 880 * rng.range(0.995, 1.005);
  const notes = [1, 1.26, 1.5, 2];
  for (let i = 0; i < notes.length; i += 1) {
    const f = base * notes[i];
    addModal(buf, sr, i * 0.085, [
      { freq: f, amp: 0.6 / (1 + i * 0.35), decay: 1.5 - i * 0.2 },
      { freq: f * 2.01, amp: 0.24 / (1 + i * 0.35), decay: 1.0 - i * 0.12 },
      { freq: f * 3.02, amp: 0.11 / (1 + i * 0.35), decay: 0.6 },
      { freq: f * 5.04, amp: 0.05, decay: 0.35 },
    ]);
    mixInto(buf, noiseLayer(sr, 0.04, rng, { f0: 6000, f1: 3000, mode: 'bp', q: 1.4, curve: 3, gain: 0.14 }), 1, Math.round(i * 0.085 * sr));
  }
  // Soft warm swell underneath.
  addTone(buf, sr, { freq: base / 4, amp: 0.22, dur: 2.4, attack: 0.3, curve: 1.6 });
  applyReverb(buf, sr, { decay: 2.0, mix: 0.34, damp: 0.4 });
  fadeEdges(buf, sr, 0.001, 0.2);
  normalize(buf, 0.92);
  return buf;
};

/** Metallic ringing intake — a reversed swell into a bright edge. */
const bladeWindup: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.56);
  const swell = noiseLayer(sr, 0.5, rng, { f0: 700, f1: 5200, mode: 'bp', q: 1.6, attack: 0.42, hold: 0.02, curve: 3.5 });
  mixInto(buf, swell, 0.9);
  const ring = alloc(sr, 0.5);
  const f = rng.range(1520, 1700);
  addTone(ring, sr, { freq: f * 0.72, freqEnd: f, amp: 0.5, dur: 0.48, attack: 0.3, curve: 0.9, sweepCurve: 1.8 });
  addTone(ring, sr, { freq: f * 1.51, freqEnd: f * 2.02, amp: 0.26, dur: 0.48, attack: 0.36, curve: 0.9, sweepCurve: 1.8 });
  addTone(ring, sr, { freq: f * 2.73, freqEnd: f * 3.41, amp: 0.14, dur: 0.48, attack: 0.4, curve: 0.9, sweepCurve: 1.8 });
  applySwell(ring, sr, 0.4, 0.02, 3);
  mixInto(buf, ring, 0.8);
  addTone(buf, sr, { freq: 62, freqEnd: 96, amp: 0.3, dur: 0.5, attack: 0.35, curve: 1.2 });
  return finish(buf, sr, 0.86);
};

/** Heavy impact plus a stylised magical crack. */
const bladeHit: Recipe = (sr, rng) => {
  const buf = alloc(sr, 1.0);
  addTone(buf, sr, { freq: rng.range(160, 178), freqEnd: 46, amp: 0.9, dur: 0.16, curve: 2.6, sweepCurve: 0.6 });
  mixInto(buf, noiseLayer(sr, 0.16, rng, { f0: 2400, f1: 500, mode: 'lp', q: 1.2, curve: 3, gain: 0.8 }));
  mixInto(buf, noiseLayer(sr, 0.3, rng, { color: 'brown', f0: 700, f1: 200, mode: 'lp', q: 0.9, curve: 2.4, gain: 0.55 }));
  // Magical crack: an inharmonic glass burst that smears downward.
  const crack = alloc(sr, 0.75);
  addModal(crack, sr, 0.006, [
    { freq: rng.range(2700, 2950), amp: 0.5, decay: 0.42 },
    { freq: rng.range(4000, 4300), amp: 0.36, decay: 0.3 },
    { freq: rng.range(6100, 6500), amp: 0.24, decay: 0.2 },
    { freq: rng.range(8300, 8900), amp: 0.14, decay: 0.13 },
  ]);
  addTone(crack, sr, { freq: 3400, freqEnd: 620, amp: 0.3, dur: 0.24, offset: 0.02, curve: 2.6, sweepCurve: 0.7 });
  applyTremolo(crack, sr, 16, 44, 0.4);
  mixInto(buf, crack, 0.55);
  saturate(buf, 2.2);
  applyReverb(buf, sr, { decay: 0.9, mix: 0.2, damp: 0.5 });
  return finish(buf, sr, 0.95);
};

/** Air whoosh — no contact, just displaced air. */
const bladeMiss: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.48);
  const air = alloc(sr, 0.46);
  fillNoise(air, rng, 'white', 1);
  svfSweep(air, sr, 'bp', 240, 1900, 2.2, 0.7);
  applySwell(air, sr, 0.13, 0.05, 2.2);
  mixInto(buf, air, 1);
  const air2 = alloc(sr, 0.3);
  fillNoise(air2, rng, 'pink', 1);
  svfSweep(air2, sr, 'bp', 1700, 420, 1.6, 1.2);
  applyAd(air2, sr, 0.05, 2.4);
  mixInto(buf, air2, 0.5, Math.round(0.16 * sr));
  biquad(buf, sr, 'highpass', 180, 0.7);
  return finish(buf, sr, 0.8);
};

/** Sharp mechanical thunk plus the string release. */
const crossbowFire: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.34);
  mixInto(buf, noiseLayer(sr, 0.045, rng, { f0: 2600, f1: 800, mode: 'bp', q: 1.4, curve: 3.6, gain: 0.9 }));
  addTone(buf, sr, { freq: rng.range(150, 168), freqEnd: 62, amp: 0.6, dur: 0.06, curve: 3 });
  addModal(buf, sr, 0.001, [
    { freq: rng.range(1150, 1280), amp: 0.3, decay: 0.07 },
    { freq: rng.range(2350, 2600), amp: 0.18, decay: 0.05 },
  ]);
  addKarplus(buf, sr, 0.004, rng.range(248, 274), 0.16, 0.86, 0.42, rng, 0.85);
  // Bolt zip leaving the rail.
  const zip = alloc(sr, 0.16);
  fillNoise(zip, rng, 'white', 1);
  svfSweep(zip, sr, 'bp', 4200, 1400, 2.4, 1);
  applyAd(zip, sr, 0.004, 2.6);
  mixInto(buf, zip, 0.3, Math.round(0.012 * sr));
  saturate(buf, 1.7);
  return finish(buf, sr, 0.92);
};

/** Solid thud with a small crystalline ring. */
const boltImpact: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.7);
  addTone(buf, sr, { freq: rng.range(122, 138), freqEnd: 54, amp: 0.8, dur: 0.1, curve: 2.8, sweepCurve: 0.6 });
  mixInto(buf, noiseLayer(sr, 0.11, rng, { f0: 1500, f1: 380, mode: 'lp', q: 1.1, curve: 3.2, gain: 0.75 }));
  mixInto(buf, noiseLayer(sr, 0.22, rng, { color: 'brown', f0: 520, f1: 180, mode: 'lp', curve: 2.4, gain: 0.4 }));
  addModal(buf, sr, 0.004, [
    { freq: rng.range(3300, 3600), amp: 0.22, decay: 0.34 },
    { freq: rng.range(4800, 5200), amp: 0.14, decay: 0.24 },
    { freq: rng.range(7000, 7400), amp: 0.08, decay: 0.16 },
  ]);
  saturate(buf, 1.8);
  applyReverb(buf, sr, { decay: 0.7, mix: 0.16, damp: 0.5 });
  return finish(buf, sr, 0.9);
};

/** Visceral stylised magical rend plus a gasp. No gore — it tears, it doesn't squelch. */
const wound: Recipe = (sr, rng) => {
  const buf = alloc(sr, 1.2);
  // The rend: a ripping downward smear.
  const rend = alloc(sr, 0.45);
  fillNoise(rend, rng, 'white', 1);
  const rip = alloc(sr, 0.45);
  fillImpulseTrain(rip, sr, 150, 46, 0.5, rng);
  svfSweep(rip, sr, 'lp', 900, 900, 0.8);
  normalize(rip, 1);
  for (let i = 0; i < rend.length; i += 1) rend[i] *= 0.4 + 0.85 * rip[i];
  svfSweep(rend, sr, 'bp', 3200, 320, 1.8, 0.8);
  applyAd(rend, sr, 0.005, 2.2);
  mixInto(buf, rend, 0.95);
  // Dissonant magical stab (tritone).
  addModal(buf, sr, 0.01, [
    { freq: 186, amp: 0.4, decay: 0.6 },
    { freq: 263, amp: 0.32, decay: 0.5 },
    { freq: 526, amp: 0.16, decay: 0.35 },
    { freq: 1052, amp: 0.07, decay: 0.2 },
  ]);
  addTone(buf, sr, { freq: 96, freqEnd: 40, amp: 0.5, dur: 0.22, curve: 2.6 });
  // Gasp: a formant-shaped noise burst.
  const gasp = alloc(sr, 0.36);
  fillNoise(gasp, rng, 'white', 1);
  svfSweep(gasp, sr, 'bp', 620, 900, 4.5, 1);
  const gasp2 = alloc(sr, 0.36);
  fillNoise(gasp2, rng, 'white', 1);
  svfSweep(gasp2, sr, 'bp', 1180, 1450, 5, 1);
  mixInto(gasp, gasp2, 0.6);
  addTone(gasp, sr, { freq: rng.range(190, 215), freqEnd: 150, amp: 0.18, dur: 0.3, attack: 0.03, curve: 2, shape: 'saw' });
  applySwell(gasp, sr, 0.05, 0.06, 2.2);
  mixInto(buf, gasp, 0.7, Math.round(0.13 * sr));
  applyReverb(buf, sr, { decay: 1.1, mix: 0.2, damp: 0.5 });
  return finish(buf, sr, 0.95);
};

/** Dark, final, dread-laden. The match is over and you lost. */
const capture: Recipe = (sr, rng) => {
  const buf = alloc(sr, 3.2);
  // Reversed swell running into the hit at 0.5s.
  const pre = noiseLayer(sr, 0.5, rng, { color: 'brown', f0: 200, f1: 1400, mode: 'bp', q: 1.4, attack: 0.44, hold: 0.01, curve: 4, gain: 0.5 });
  mixInto(buf, pre, 1);
  const hitAt = 0.5;
  addTone(buf, sr, { freq: 72, freqEnd: 23, amp: 1, dur: 0.75, offset: hitAt, curve: 2, sweepCurve: 0.5 });
  mixInto(buf, noiseLayer(sr, 0.4, rng, { color: 'brown', f0: 1600, f1: 90, mode: 'lp', q: 1.2, curve: 2.4, gain: 0.85 }), 1, Math.round(hitAt * sr));
  // Low minor-second cluster grinding under it.
  addModal(buf, sr, hitAt, [
    { freq: 43.5, amp: 0.55, decay: 2.4 },
    { freq: 46.2, amp: 0.5, decay: 2.2 },
    { freq: 87.3, amp: 0.28, decay: 1.8 },
    { freq: 130.7, amp: 0.14, decay: 1.3 },
  ]);
  // Glassy smear falling away.
  addTone(buf, sr, { freq: rng.range(2600, 2900), freqEnd: 220, amp: 0.16, dur: 1.0, offset: hitAt + 0.02, curve: 2.4, sweepCurve: 0.6 });
  mixInto(buf, noiseLayer(sr, 2.2, rng, { color: 'brown', f0: 180, f1: 60, mode: 'lp', q: 0.8, attack: 0.05, curve: 1.6, gain: 0.45 }), 1, Math.round((hitAt + 0.1) * sr));
  saturate(buf, 2.4);
  biquad(buf, sr, 'lowpass', 3200, 0.6);
  applyReverb(buf, sr, { decay: 2.6, mix: 0.3, damp: 0.6 });
  fadeEdges(buf, sr, 0.001, 0.3);
  normalize(buf, 0.98);
  return buf;
};

/** Sonar-like ping that sweeps outward, with decaying echoes. */
const pulse: Recipe = (sr, rng) => {
  const buf = alloc(sr, 1.8);
  const f = 1260 * rng.range(0.99, 1.01);
  addTone(buf, sr, { freq: f, amp: 0.6, dur: 0.9, attack: 0.003, curve: 2.6 });
  addTone(buf, sr, { freq: f * 1.5, amp: 0.2, dur: 0.5, attack: 0.003, curve: 3 });
  addTone(buf, sr, { freq: f * 0.72, freqEnd: f * 1.68, amp: 0.3, dur: 0.42, curve: 2.2, sweepCurve: 1.4 });
  // Expanding ring of filtered noise.
  const ring = alloc(sr, 1.1);
  fillNoise(ring, rng, 'white', 1);
  svfSweep(ring, sr, 'bp', 900, 4800, 3.2, 1.3);
  applyAd(ring, sr, 0.01, 3);
  mixInto(buf, ring, 0.22);
  // Echoes.
  for (const [t, g] of [[0.23, 0.4], [0.49, 0.2], [0.79, 0.09]] as const) {
    addTone(buf, sr, { freq: f * 0.995, amp: 0.6 * g, dur: 0.7, offset: t, attack: 0.004, curve: 2.8 });
  }
  applyReverb(buf, sr, { decay: 1.8, mix: 0.3, damp: 0.35 });
  fadeEdges(buf, sr, 0.001, 0.15);
  normalize(buf, 0.9);
  return buf;
};

/** Soft pressurised hiss with a low whump. */
const smokeDeploy: Recipe = (sr, rng) => {
  const buf = alloc(sr, 1.5);
  const hiss = alloc(sr, 1.45);
  fillNoise(hiss, rng, 'white', 1);
  svfSweep(hiss, sr, 'hp', 2600, 1100, 0.8, 1.2);
  const drift = alloc(sr, 1.45);
  fillNoise(drift, rng, 'white', 1);
  svfSweep(drift, sr, 'bp', 3400, 1800, 2.2, 1);
  mixInto(hiss, drift, 0.45);
  applySwell(hiss, sr, 0.06, 0.34, 2.4);
  mixInto(buf, hiss, 0.9);
  addTone(buf, sr, { freq: rng.range(68, 78), freqEnd: 34, amp: 0.7, dur: 0.2, curve: 2.4, sweepCurve: 0.6 });
  mixInto(buf, noiseLayer(sr, 0.22, rng, { color: 'brown', f0: 600, f1: 110, mode: 'lp', q: 1, curve: 2.6, gain: 0.6 }));
  applyReverb(buf, sr, { decay: 1.2, mix: 0.16, damp: 0.6 });
  return finish(buf, sr, 0.86);
};

/** Bright glassy detonation with a stunned ringing tail. */
const wardTrigger: Recipe = (sr, rng) => {
  const buf = alloc(sr, 2.4);
  mixInto(buf, noiseLayer(sr, 0.06, rng, { f0: 9000, f1: 3000, mode: 'hp', q: 0.8, curve: 3.4, gain: 0.9 }));
  addModal(buf, sr, 0.002, [
    { freq: rng.range(1080, 1140), amp: 0.7, decay: 0.95 },
    { freq: rng.range(1880, 1960), amp: 0.55, decay: 0.8 },
    { freq: rng.range(2680, 2780), amp: 0.42, decay: 0.62 },
    { freq: rng.range(3860, 3980), amp: 0.3, decay: 0.45 },
    { freq: rng.range(5540, 5700), amp: 0.2, decay: 0.32 },
    { freq: rng.range(7900, 8200), amp: 0.11, decay: 0.2 },
  ]);
  addTone(buf, sr, { freq: 130, freqEnd: 44, amp: 0.5, dur: 0.3, curve: 2.4, sweepCurve: 0.6 });
  // The stun: a pure tinnitus ring that outlives the blast.
  const ring = alloc(sr, 1.9);
  addTone(ring, sr, { freq: 4120, amp: 0.5, dur: 1.85, attack: 0.02, curve: 1.5 });
  addTone(ring, sr, { freq: 6180, amp: 0.2, dur: 1.5, attack: 0.03, curve: 1.6 });
  applyTremolo(ring, sr, 5.5, 2.5, 0.35);
  mixInto(buf, ring, 0.3, Math.round(0.05 * sr));
  mixInto(buf, noiseLayer(sr, 0.9, rng, { f0: 2200, f1: 400, mode: 'lp', q: 1.2, attack: 0.02, curve: 2, gain: 0.25 }), 1, Math.round(0.06 * sr));
  applyReverb(buf, sr, { decay: 1.8, mix: 0.3, damp: 0.35 });
  fadeEdges(buf, sr, 0.0006, 0.25);
  normalize(buf, 0.95);
  return buf;
};

/** Vicious iron snap — the jaws close. */
const snareTrigger: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.6);
  mixInto(buf, noiseLayer(sr, 0.025, rng, { f0: 7000, f1: 2200, mode: 'bp', q: 0.9, curve: 4, gain: 1 }));
  addModal(buf, sr, 0.0008, [
    { freq: rng.range(880, 940), amp: 0.62, decay: 0.2 },
    { freq: rng.range(1440, 1510), amp: 0.5, decay: 0.16 },
    { freq: rng.range(2280, 2380), amp: 0.36, decay: 0.12 },
    { freq: rng.range(3760, 3900), amp: 0.24, decay: 0.09 },
    { freq: rng.range(5900, 6200), amp: 0.12, decay: 0.06 },
  ]);
  addTone(buf, sr, { freq: rng.range(180, 200), freqEnd: 68, amp: 0.55, dur: 0.07, curve: 3 });
  // Chain rattle scattering afterwards.
  for (let i = 0; i < 5; i += 1) {
    const t = rng.range(0.03, 0.3);
    addModal(buf, sr, t, [
      { freq: rng.range(2400, 5200), amp: rng.range(0.05, 0.13), decay: rng.range(0.02, 0.06) },
      { freq: rng.range(6000, 9000), amp: rng.range(0.02, 0.06), decay: 0.02 },
    ]);
  }
  saturate(buf, 2.6);
  applyReverb(buf, sr, { decay: 0.8, mix: 0.18, damp: 0.4 });
  return finish(buf, sr, 0.96);
};

/** Quiet metallic set/click — arming the trap without announcing it. */
const snarePlace: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.26);
  mixInto(buf, noiseLayer(sr, 0.014, rng, { f0: 4200, f1: 1800, mode: 'bp', q: 1.1, curve: 3.6, gain: 0.5 }));
  addModal(buf, sr, 0.0008, [
    { freq: rng.range(1650, 1780), amp: 0.35, decay: 0.09 },
    { freq: rng.range(2960, 3160), amp: 0.2, decay: 0.06 },
  ]);
  addTone(buf, sr, { freq: rng.range(140, 158), freqEnd: 90, amp: 0.2, dur: 0.04, curve: 3 });
  mixInto(buf, noiseLayer(sr, 0.09, rng, { f0: 900, f1: 300, mode: 'lp', curve: 3, gain: 0.15 }), 1, Math.round(0.012 * sr));
  return finish(buf, sr, 0.72);
};

/** Huge splintering wood-and-stone crash. Carries across the map. */
const breach: Recipe = (sr, rng) => {
  const buf = alloc(sr, 2.8);
  mixInto(buf, noiseLayer(sr, 0.035, rng, { f0: 9000, f1: 1200, mode: 'bp', q: 0.7, curve: 3.6, gain: 1 }));
  addTone(buf, sr, { freq: rng.range(88, 98), freqEnd: 29, amp: 1, dur: 0.5, curve: 2, sweepCurve: 0.5 });
  addTone(buf, sr, { freq: 44, freqEnd: 26, amp: 0.6, dur: 1.0, curve: 1.8 });
  mixInto(buf, noiseLayer(sr, 0.3, rng, { f0: 3400, f1: 260, mode: 'lp', q: 1.3, curve: 2.4, gain: 0.9 }));
  // Splinters: bursts of wood cracking outward.
  for (let i = 0; i < 14; i += 1) {
    const t = rng.range(0.0, 0.95);
    const f = rng.range(900, 4600);
    mixInto(
      buf,
      noiseLayer(sr, rng.range(0.02, 0.08), rng, { f0: f, f1: f * 0.45, mode: 'bp', q: rng.range(2, 6), curve: 3.4, gain: rng.range(0.14, 0.4) }),
      1,
      Math.round(t * sr),
    );
    addModal(buf, sr, t, [{ freq: f * 1.6, amp: rng.range(0.03, 0.1), decay: rng.range(0.03, 0.1) }]);
  }
  // Stone rumble and settling debris.
  mixInto(buf, noiseLayer(sr, 1.9, rng, { color: 'brown', f0: 260, f1: 70, mode: 'lp', q: 0.9, attack: 0.02, curve: 1.9, gain: 0.75 }));
  for (let i = 0; i < 9; i += 1) {
    const t = rng.range(0.5, 2.1);
    mixInto(buf, noiseLayer(sr, 0.03, rng, { f0: rng.range(1600, 5200), f1: 800, mode: 'bp', q: 3, curve: 3.4, gain: rng.range(0.04, 0.12) }), 1, Math.round(t * sr));
  }
  saturate(buf, 2.6);
  applyReverb(buf, sr, { decay: 2.2, mix: 0.32, damp: 0.5 });
  fadeEdges(buf, sr, 0.0005, 0.3);
  normalize(buf, 0.99);
  return buf;
};

/** Heavy wooden slam. */
const doorSlam: Recipe = (sr, rng) => {
  const buf = alloc(sr, 0.9);
  addTone(buf, sr, { freq: rng.range(126, 142), freqEnd: 42, amp: 0.9, dur: 0.13, curve: 2.6, sweepCurve: 0.55 });
  mixInto(buf, noiseLayer(sr, 0.05, rng, { f0: 5200, f1: 1400, mode: 'bp', q: 0.8, curve: 3.4, gain: 0.6 }));
  mixInto(buf, noiseLayer(sr, 0.26, rng, { color: 'brown', f0: 900, f1: 160, mode: 'lp', q: 1.1, curve: 2.4, gain: 0.85 }));
  addModal(buf, sr, 0.002, [
    { freq: rng.range(172, 190), amp: 0.4, decay: 0.24 },
    { freq: rng.range(305, 335), amp: 0.26, decay: 0.18 },
    { freq: rng.range(455, 495), amp: 0.16, decay: 0.12 },
    { freq: rng.range(760, 820), amp: 0.08, decay: 0.08 },
  ]);
  saturate(buf, 2.2);
  applyReverb(buf, sr, { decay: 1.3, mix: 0.26, damp: 0.55 });
  return finish(buf, sr, 0.94);
};

/** Slow ominous creak — stick-slip friction through a sliding resonance. */
const doorCreak: Recipe = (sr, rng) => {
  const buf = alloc(sr, 2.0);
  const exc = alloc(sr, 1.9);
  fillImpulseTrain(exc, sr, 34, 92, 0.55, rng);
  // Each stick-slip event excites a high-Q resonance that glides upward.
  svfSweep(exc, sr, 'bp', 420, 1150, 16, 1.2);
  // A second, detuned resonance thickens the timbre.
  const exc2 = alloc(sr, 1.9);
  fillImpulseTrain(exc2, sr, 31, 84, 0.6, rng);
  svfSweep(exc2, sr, 'bp', 690, 1780, 13, 1.2);
  mixInto(exc, exc2, 0.55);
  const grit = noiseLayer(sr, 1.9, rng, { f0: 1600, f1: 3200, mode: 'bp', q: 3, attack: 0.2, hold: 1.0, curve: 2, gain: 0.1 });
  mixInto(exc, grit, 1);
  applySwell(exc, sr, 0.28, 0.9, 2.4);
  applyTremolo(exc, sr, 1.4, 3.6, 0.3);
  mixInto(buf, exc, 1);
  addTone(buf, sr, { freq: 56, freqEnd: 44, amp: 0.12, dur: 1.9, attack: 0.3, curve: 1.4 });
  applyReverb(buf, sr, { decay: 1.6, mix: 0.24, damp: 0.5 });
  return finish(buf, sr, 0.82);
};

/** Delicate bone/bead clatter — the charm strings the Runner brushed. */
const charmRattle: Recipe = (sr, rng) => {
  const buf = alloc(sr, 1.0);
  const count = 14;
  for (let i = 0; i < count; i += 1) {
    // Density falls off across the tail so it settles rather than stops.
    const t = Math.pow(rng(), 1.7) * 0.72;
    const f = rng.range(1500, 4200);
    addModal(buf, sr, t, [
      { freq: f, amp: rng.range(0.18, 0.42), decay: rng.range(0.025, 0.07) },
      { freq: f * rng.range(2.4, 3.1), amp: rng.range(0.06, 0.16), decay: rng.range(0.015, 0.04) },
      { freq: f * rng.range(4.4, 5.6), amp: rng.range(0.02, 0.06), decay: 0.012 },
    ]);
    mixInto(buf, noiseLayer(sr, 0.006, rng, { f0: f * 2, f1: f, mode: 'bp', q: 1.2, curve: 3, gain: 0.1 }), 1, Math.round(t * sr));
  }
  biquad(buf, sr, 'highpass', 700, 0.7);
  applyReverb(buf, sr, { decay: 0.9, mix: 0.2, damp: 0.4 });
  return finish(buf, sr, 0.8);
};

/** Wounded breathing gasp — inhale then a shorter voiced exhale. */
const breath: Recipe = (sr, rng) => {
  const buf = alloc(sr, 1.1);
  const inhale = alloc(sr, 0.4);
  fillNoise(inhale, rng, 'white', 1);
  svfSweep(inhale, sr, 'bp', 420, 1500, 2.6, 1.1);
  const inhale2 = alloc(sr, 0.4);
  fillNoise(inhale2, rng, 'white', 1);
  svfSweep(inhale2, sr, 'bp', 900, 2100, 5, 1);
  mixInto(inhale, inhale2, 0.4);
  applySwell(inhale, sr, 0.19, 0.05, 2.4);
  mixInto(buf, inhale, 0.85);

  const exhale = alloc(sr, 0.42);
  fillNoise(exhale, rng, 'white', 1);
  svfSweep(exhale, sr, 'bp', 1250, 480, 2.2, 1);
  const voiced = alloc(sr, 0.42);
  addTone(voiced, sr, { freq: rng.range(122, 138), freqEnd: 104, amp: 0.3, dur: 0.4, attack: 0.03, curve: 2, shape: 'saw' });
  biquad(voiced, sr, 'bandpass', 700, 3);
  mixInto(exhale, voiced, 0.55);
  applySwell(exhale, sr, 0.05, 0.08, 2.2);
  mixInto(buf, exhale, 0.7, Math.round(0.46 * sr));
  biquad(buf, sr, 'highpass', 190, 0.7);
  return finish(buf, sr, 0.72);
};

/** Exhaustive over `SoundKind` — TypeScript fails the build if one is missed. */
const SOUND_RECIPES: Record<SoundKind, Recipe> = {
  footstepDirt,
  footstepStone,
  footstepWater,
  footstepGrass,
  decoyStep,
  sealStart,
  sealDone,
  gateOpen,
  gateChannel,
  bladeWindup,
  bladeHit,
  bladeMiss,
  crossbowFire,
  boltImpact,
  smokeDeploy,
  wardTrigger,
  snareTrigger,
  snarePlace,
  breach,
  doorSlam,
  doorCreak,
  charmRattle,
  shrineStart,
  shrineDone,
  wound,
  capture,
  pulse,
  vault,
  breath,
};

// ---------------------------------------------------------------------------
// UI stingers
// ---------------------------------------------------------------------------

export type UiSoundKind =
  | 'hover'
  | 'click'
  | 'back'
  | 'ready'
  | 'victory'
  | 'defeat'
  | 'countdown'
  | 'reveal';

/** Small helper for menu blips: a struck tone with a touch of noise attack. */
function blip(
  buf: Float32Array,
  sr: number,
  rng: Rng,
  freq: number,
  amp: number,
  decay: number,
  offset: number,
  noise = 0.12,
): void {
  addModal(buf, sr, offset, [
    { freq, amp, decay },
    { freq: freq * 2.01, amp: amp * 0.3, decay: decay * 0.6 },
    { freq: freq * 3.02, amp: amp * 0.12, decay: decay * 0.35 },
  ]);
  if (noise > 0) {
    mixInto(
      buf,
      noiseLayer(sr, 0.008, rng, { f0: freq * 4, f1: freq * 1.5, mode: 'bp', q: 1.2, curve: 3, gain: amp * noise }),
      1,
      Math.round(offset * sr),
    );
  }
}

const UI_RECIPES: Record<UiSoundKind, Recipe> = {
  hover: (sr, rng) => {
    const buf = alloc(sr, 0.08);
    blip(buf, sr, rng, 1420 * rng.range(0.99, 1.01), 0.5, 0.05, 0, 0.06);
    biquad(buf, sr, 'lowpass', 4200, 0.7);
    return finish(buf, sr, 0.45);
  },
  click: (sr, rng) => {
    const buf = alloc(sr, 0.14);
    blip(buf, sr, rng, 2080 * rng.range(0.995, 1.005), 0.6, 0.07, 0, 0.3);
    blip(buf, sr, rng, 3140, 0.28, 0.045, 0.004, 0);
    addTone(buf, sr, { freq: 320, freqEnd: 180, amp: 0.16, dur: 0.03, curve: 3 });
    return finish(buf, sr, 0.8);
  },
  back: (sr, rng) => {
    const buf = alloc(sr, 0.2);
    blip(buf, sr, rng, 1180 * rng.range(0.995, 1.005), 0.5, 0.07, 0, 0.15);
    blip(buf, sr, rng, 790, 0.42, 0.1, 0.055, 0.08);
    biquad(buf, sr, 'lowpass', 5200, 0.7);
    return finish(buf, sr, 0.7);
  },
  ready: (sr, rng) => {
    const buf = alloc(sr, 0.55);
    blip(buf, sr, rng, 880 * rng.range(0.998, 1.002), 0.6, 0.22, 0, 0.14);
    blip(buf, sr, rng, 1320, 0.55, 0.32, 0.095, 0.1);
    addTone(buf, sr, { freq: 220, amp: 0.14, dur: 0.36, attack: 0.01, curve: 2 });
    applyReverb(buf, sr, { decay: 0.7, mix: 0.18, damp: 0.4 });
    return finish(buf, sr, 0.82);
  },
  victory: (sr, rng) => {
    const buf = alloc(sr, 2.6);
    // G major-ish rising motif with a shimmering octave landing.
    const notes = [392, 494, 587, 784];
    for (let i = 0; i < notes.length; i += 1) {
      const t = i * 0.15;
      const f = notes[i] * rng.range(0.999, 1.001);
      addModal(buf, sr, t, [
        { freq: f, amp: 0.5, decay: 1.5 - i * 0.15 },
        { freq: f * 2.0, amp: 0.2, decay: 1.0 },
        { freq: f * 3.0, amp: 0.09, decay: 0.6 },
        { freq: f * 4.02, amp: 0.04, decay: 0.35 },
      ]);
      addTone(buf, sr, { freq: f / 2, amp: 0.14, dur: 1.2, offset: t, attack: 0.02, curve: 1.8, shape: 'tri' });
    }
    addModal(buf, sr, 0.6, [
      { freq: 1568, amp: 0.22, decay: 1.6 },
      { freq: 2349, amp: 0.12, decay: 1.2 },
      { freq: 3136, amp: 0.06, decay: 0.9 },
    ]);
    // Warm pad underneath.
    addTone(buf, sr, { freq: 98, amp: 0.22, dur: 2.4, attack: 0.15, curve: 1.4, shape: 'tri' });
    addTone(buf, sr, { freq: 147, amp: 0.14, dur: 2.3, attack: 0.25, curve: 1.4 });
    mixInto(buf, noiseLayer(sr, 1.2, rng, { color: 'pink', f0: 2000, f1: 6000, mode: 'bp', q: 1.2, attack: 0.5, hold: 0.2, curve: 2, gain: 0.1 }), 1, Math.round(0.4 * sr));
    applyReverb(buf, sr, { decay: 1.8, mix: 0.28, damp: 0.4 });
    fadeEdges(buf, sr, 0.002, 0.25);
    normalize(buf, 0.88);
    return buf;
  },
  defeat: (sr, rng) => {
    const buf = alloc(sr, 2.9);
    const notes = [294, 247, 220, 147];
    for (let i = 0; i < notes.length; i += 1) {
      const t = i * 0.19;
      const f = notes[i] * rng.range(0.996, 1.004);
      addModal(buf, sr, t, [
        { freq: f, amp: 0.5, decay: 1.6 + i * 0.2 },
        { freq: f * 1.995, amp: 0.16, decay: 1.1 },
        { freq: f * 2.98, amp: 0.06, decay: 0.7 },
      ]);
      addTone(buf, sr, { freq: f * 0.5, freqEnd: f * 0.49, amp: 0.16, dur: 1.6, offset: t, attack: 0.04, curve: 1.5, shape: 'saw' });
    }
    // Sour low drone that outlasts the motif.
    addTone(buf, sr, { freq: 73.4, amp: 0.3, dur: 2.8, attack: 0.2, curve: 1.2 });
    addTone(buf, sr, { freq: 77.8, amp: 0.18, dur: 2.8, attack: 0.35, curve: 1.2 });
    mixInto(buf, noiseLayer(sr, 2.4, rng, { color: 'brown', f0: 300, f1: 90, mode: 'lp', q: 0.8, attack: 0.3, curve: 1.6, gain: 0.28 }));
    svfSweep(buf, sr, 'lp', 4200, 900, 0.8, 1.3);
    applyReverb(buf, sr, { decay: 2.2, mix: 0.26, damp: 0.6 });
    fadeEdges(buf, sr, 0.002, 0.3);
    normalize(buf, 0.9);
    return buf;
  },
  countdown: (sr, rng) => {
    const buf = alloc(sr, 0.24);
    mixInto(buf, noiseLayer(sr, 0.016, rng, { f0: 3600, f1: 1200, mode: 'bp', q: 1.4, curve: 3.4, gain: 0.4 }));
    blip(buf, sr, rng, 880 * rng.range(0.998, 1.002), 0.55, 0.12, 0, 0);
    addTone(buf, sr, { freq: 190, freqEnd: 120, amp: 0.22, dur: 0.05, curve: 3 });
    return finish(buf, sr, 0.78);
  },
  reveal: (sr, rng) => {
    const buf = alloc(sr, 3.4);
    // 1.7s of rising pressure, then the hit.
    const hitAt = 1.75;
    const riser = alloc(sr, hitAt);
    fillNoise(riser, rng, 'pink', 1);
    svfSweep(riser, sr, 'bp', 220, 4200, 2.2, 1.7);
    applySwell(riser, sr, hitAt * 0.92, 0.01, 6);
    mixInto(buf, riser, 0.75);
    for (const mult of [1, 1.5, 2, 3]) {
      addTone(buf, sr, {
        freq: 58 * mult,
        freqEnd: 58 * mult * 1.5,
        amp: 0.3 / mult,
        dur: hitAt,
        attack: hitAt * 0.6,
        curve: 0.4,
        sweepCurve: 2.2,
      });
    }
    // The reveal itself.
    addTone(buf, sr, { freq: 84, freqEnd: 27, amp: 1, dur: 0.8, offset: hitAt, curve: 2, sweepCurve: 0.5 });
    mixInto(buf, noiseLayer(sr, 0.35, rng, { color: 'brown', f0: 2400, f1: 110, mode: 'lp', q: 1.2, curve: 2.4, gain: 0.8 }), 1, Math.round(hitAt * sr));
    addModal(buf, sr, hitAt, [
      { freq: 174, amp: 0.4, decay: 1.5 },
      { freq: 261, amp: 0.28, decay: 1.2 },
      { freq: 1044, amp: 0.14, decay: 1.0 },
      { freq: 1566, amp: 0.08, decay: 0.8 },
      { freq: 2088, amp: 0.05, decay: 0.6 },
    ]);
    saturate(buf, 2);
    applyReverb(buf, sr, { decay: 2.4, mix: 0.3, damp: 0.5 });
    fadeEdges(buf, sr, 0.003, 0.3);
    normalize(buf, 0.95);
    return buf;
  },
};

// ---------------------------------------------------------------------------
// Non-positional support voices: loops, heartbeat, distant ambience one-shots
// ---------------------------------------------------------------------------

export type ExtraKind =
  | 'wind'
  | 'exertion'
  | 'heartA'
  | 'heartB'
  | 'distantBell'
  | 'distantCreak'
  | 'countdownFinal';

const EXTRA_RECIPES: Record<ExtraKind, Recipe> = {
  /** Eight seconds of seamless wind bed; the live graph sweeps a band-pass over it. */
  wind: (sr, rng) => {
    const raw = alloc(sr, 9.0);
    fillNoise(raw, rng, 'brown', 1);
    const gust = alloc(sr, 9.0);
    fillNoise(gust, rng, 'brown', 1);
    biquad(gust, sr, 'lowpass', 0.35, 0.7);
    normalize(gust, 1);
    // Slow gusting: amplitude follows a very low frequency random walk.
    for (let i = 0; i < raw.length; i += 1) raw[i] *= 0.4 + 0.75 * (0.5 + 0.5 * gust[i]);
    const hiss = alloc(sr, 9.0);
    fillNoise(hiss, rng, 'pink', 1);
    biquad(hiss, sr, 'bandpass', 1400, 0.7);
    for (let i = 0; i < hiss.length; i += 1) hiss[i] *= 0.3 + 0.7 * (0.5 + 0.5 * gust[i]);
    mixInto(raw, hiss, 0.5);
    biquad(raw, sr, 'highpass', 60, 0.7);
    normalize(raw, 0.9);
    return makeSeamless(raw, sr, 1.0);
  },
  /** Two-second seamless exertion breathing loop for sprinting. */
  exertion: (sr, rng) => {
    const raw = alloc(sr, 2.6);
    for (let i = 0; i < 3; i += 1) {
      const t = i * 0.8;
      const inh = alloc(sr, 0.3);
      fillNoise(inh, rng, 'white', 1);
      svfSweep(inh, sr, 'bp', 500, 1400, 3, 1.1);
      applySwell(inh, sr, 0.13, 0.03, 2.4);
      mixInto(raw, inh, 0.55, Math.round(t * sr));
      const exh = alloc(sr, 0.34);
      fillNoise(exh, rng, 'white', 1);
      svfSweep(exh, sr, 'bp', 1100, 480, 2.4, 1);
      const voiced = alloc(sr, 0.34);
      addTone(voiced, sr, { freq: rng.range(115, 132), amp: 0.22, dur: 0.3, attack: 0.02, curve: 2, shape: 'saw' });
      biquad(voiced, sr, 'bandpass', 620, 3);
      mixInto(exh, voiced, 0.45);
      applySwell(exh, sr, 0.04, 0.07, 2.2);
      mixInto(raw, exh, 0.5, Math.round((t + 0.34) * sr));
    }
    biquad(raw, sr, 'highpass', 200, 0.7);
    normalize(raw, 0.8);
    return makeSeamless(raw, sr, 0.6);
  },
  /** Heartbeat: the strong first thump. */
  heartA: (sr, rng) => {
    const buf = alloc(sr, 0.38);
    addTone(buf, sr, { freq: rng.range(62, 68), freqEnd: 28, amp: 1, dur: 0.24, attack: 0.004, curve: 2.4, sweepCurve: 0.5 });
    addTone(buf, sr, { freq: 96, freqEnd: 44, amp: 0.3, dur: 0.1, curve: 3 });
    mixInto(buf, noiseLayer(sr, 0.1, rng, { color: 'brown', f0: 320, f1: 80, mode: 'lp', q: 0.9, curve: 2.6, gain: 0.35 }));
    saturate(buf, 1.6);
    return finish(buf, sr, 0.95);
  },
  /** Heartbeat: the softer second thump. */
  heartB: (sr, rng) => {
    const buf = alloc(sr, 0.3);
    addTone(buf, sr, { freq: rng.range(54, 60), freqEnd: 26, amp: 1, dur: 0.19, attack: 0.005, curve: 2.6, sweepCurve: 0.5 });
    mixInto(buf, noiseLayer(sr, 0.08, rng, { color: 'brown', f0: 260, f1: 70, mode: 'lp', q: 0.9, curve: 2.8, gain: 0.25 }));
    return finish(buf, sr, 0.72);
  },
  /** A bell tolling somewhere beyond the ruins. */
  distantBell: (sr, rng) => {
    const buf = alloc(sr, 5.0);
    const f = 148 * rng.range(0.98, 1.02);
    addModal(buf, sr, 0, [
      { freq: f * 0.5, amp: 0.35, decay: 4.4 },
      { freq: f, amp: 0.9, decay: 3.6 },
      { freq: f * 2.02, amp: 0.4, decay: 2.6 },
      { freq: f * 2.41, amp: 0.28, decay: 2.0 },
      { freq: f * 3.03, amp: 0.16, decay: 1.4 },
      { freq: f * 4.52, amp: 0.08, decay: 0.9 },
    ]);
    applyReverb(buf, sr, { decay: 3.4, mix: 0.5, damp: 0.7 });
    biquad(buf, sr, 'lowpass', 1800, 0.6);
    biquad(buf, sr, 'highpass', 110, 0.7);
    fadeEdges(buf, sr, 0.05, 0.5);
    normalize(buf, 0.7);
    return buf;
  },
  /** Something shifting in an empty room, far off. */
  distantCreak: (sr, rng) => {
    const buf = alloc(sr, 2.6);
    const exc = alloc(sr, 2.4);
    fillImpulseTrain(exc, sr, 22, 58, 0.6, rng);
    svfSweep(exc, sr, 'bp', 300, 820, 14, 1.2);
    applySwell(exc, sr, 0.4, 1.1, 2.6);
    applyTremolo(exc, sr, 0.9, 2.4, 0.35);
    mixInto(buf, exc, 1);
    applyReverb(buf, sr, { decay: 2.4, mix: 0.55, damp: 0.7 });
    biquad(buf, sr, 'lowpass', 2200, 0.6);
    fadeEdges(buf, sr, 0.05, 0.3);
    normalize(buf, 0.62);
    return buf;
  },
  /** The final countdown beat, a fifth higher and brighter. */
  countdownFinal: (sr, rng) => {
    const buf = alloc(sr, 0.4);
    mixInto(buf, noiseLayer(sr, 0.02, rng, { f0: 5200, f1: 1800, mode: 'bp', q: 1.2, curve: 3.4, gain: 0.4 }));
    blip(buf, sr, rng, 1320 * rng.range(0.998, 1.002), 0.6, 0.3, 0, 0);
    blip(buf, sr, rng, 1976, 0.25, 0.2, 0.002, 0);
    addTone(buf, sr, { freq: 260, freqEnd: 150, amp: 0.22, dur: 0.06, curve: 3 });
    applyReverb(buf, sr, { decay: 0.8, mix: 0.2, damp: 0.4 });
    return finish(buf, sr, 0.85);
  },
};

// ---------------------------------------------------------------------------
// Public render API
// ---------------------------------------------------------------------------

function render(namespace: string, key: string, recipe: Recipe, sampleRate: number, variant: number): Float32Array {
  const rng = createRng(hashString(`veilhunt.${namespace}.${key}.${variant}`));
  return recipe(sampleRate, rng);
}

/** Renders one positional game sound. `variant` selects a stable alternate take. */
export function renderSound(kind: SoundKind, sampleRate: number, variant = 0): Float32Array {
  return render('sound', kind, SOUND_RECIPES[kind], sampleRate, variant);
}

export function renderUiSound(kind: UiSoundKind, sampleRate: number, variant = 0): Float32Array {
  return render('ui', kind, UI_RECIPES[kind], sampleRate, variant);
}

export function renderExtra(kind: ExtraKind, sampleRate: number, variant = 0): Float32Array {
  return render('extra', kind, EXTRA_RECIPES[kind], sampleRate, variant);
}

/** Every key this module can render — used by tests and the warm-up pass. */
export const ALL_SOUND_KINDS = Object.keys(SOUND_RECIPES) as SoundKind[];
export const ALL_UI_KINDS = Object.keys(UI_RECIPES) as UiSoundKind[];
export const ALL_EXTRA_KINDS = Object.keys(EXTRA_RECIPES) as ExtraKind[];

/** Copies a mono render into a 1-channel `AudioBuffer` at the context rate. */
export function toAudioBuffer(context: BaseAudioContext, data: Float32Array): AudioBuffer {
  const buffer = context.createBuffer(1, Math.max(1, data.length), context.sampleRate);
  buffer.getChannelData(0).set(data);
  return buffer;
}

/** Builds the shared reverb impulse response as a 2-channel `AudioBuffer`. */
export function createReverbBuffer(context: BaseAudioContext, seconds = 1.4): AudioBuffer {
  const [left, right] = renderImpulseResponse(context.sampleRate, seconds);
  const buffer = context.createBuffer(2, left.length, context.sampleRate);
  buffer.getChannelData(0).set(left);
  buffer.getChannelData(1).set(right);
  return buffer;
}
