/**
 * Veil Hunt — the audio system.
 *
 * 100% procedural: every buffer comes from `./synth.js`, nothing is fetched.
 *
 * Mix graph
 * ---------
 *   ambienceBus ─┐
 *   effectsBus ──┼─→ master ─→ limiter (DynamicsCompressor) ─→ destination
 *                │
 *   reverbSend ─→ convolver ─→ reverbReturn ─→ effectsBus
 *
 *   Sources hang off the two buses:
 *     ambienceDuck → ambienceBus   (wind / pad / drone / distant events)
 *     one-shots, UI, heartbeat, breath, exertion → effectsBus
 *
 * Node hygiene
 * ------------
 * A positional one-shot is at most five nodes (source, muffle low-pass, gain,
 * stereo panner, reverb send) and every one of them is disconnected from the
 * `ended` callback. Concurrency is capped at `VOICE_CAP`; when the budget is
 * full the quietest voice is faded out and reclaimed, and a new sound quieter
 * than everything already playing is simply dropped.
 *
 * Determinism
 * -----------
 * Per-playback pitch and timbre jitter comes from a seeded PRNG, never
 * `Math.random`, so bot playtests and screenshot baselines stay reproducible.
 */

import type { WoundLevel } from '../../shared/constants.js';
import { createRng, hashString, type Rng } from '../../shared/rng.js';
import type { Role, SoundKind } from '../../shared/types.js';
import type { AudioListenerState, AudioSystem, GameSettings } from '../contracts.js';
import {
  createReverbBuffer,
  renderExtra,
  renderSound,
  renderUiSound,
  toAudioBuffer,
  type ExtraKind,
  type UiSoundKind,
} from './synth.js';

/** Hard ceiling on simultaneously playing one-shots. */
const VOICE_CAP = 24;
/** How often the single low-rate scheduler wakes, in milliseconds. */
const SCHEDULER_INTERVAL_MS = 100;
/** How far ahead of `currentTime` events are scheduled, in seconds. */
const LOOKAHEAD = 0.25;
/** Ambience fade used by `stopAmbience` and role switches. */
const AMBIENCE_FADE = 0.8;
/** Smoothing constant for settings and continuous-parameter changes. */
const SMOOTH = 0.05;

interface SoundProfile {
  /** Base mix gain relative to other sounds. */
  gain: number;
  /**
   * Loudness floor applied regardless of the server's distance falloff, so
   * map-wide events (a seal lighting, the gate grinding open) still land.
   */
  floor: number;
  /** 0..1 send into the shared reverb. */
  reverb: number;
  /** How many pre-rendered alternate takes exist. */
  variants: number;
  /** Peak playback-rate jitter, as a fraction. */
  jitter: number;
}

const P = (
  gain: number,
  floor: number,
  reverb: number,
  variants: number,
  jitter: number,
): SoundProfile => ({ gain, floor, reverb, variants, jitter });

const PROFILES: Record<SoundKind, SoundProfile> = {
  footstepStone: P(0.55, 0, 0.1, 4, 0.06),
  footstepDirt: P(0.48, 0, 0.06, 4, 0.06),
  footstepGrass: P(0.44, 0, 0.05, 4, 0.06),
  footstepWater: P(0.95, 0, 0.16, 4, 0.06),
  decoyStep: P(0.5, 0, 0.12, 4, 0.06),
  sealStart: P(0.7, 0.1, 0.3, 2, 0.03),
  sealDone: P(1.0, 0.55, 0.55, 1, 0.02),
  gateChannel: P(0.7, 0.12, 0.28, 2, 0.03),
  gateOpen: P(1.0, 0.5, 0.45, 1, 0.02),
  bladeWindup: P(0.7, 0, 0.18, 3, 0.05),
  bladeHit: P(0.95, 0.1, 0.28, 3, 0.05),
  bladeMiss: P(0.6, 0, 0.12, 3, 0.06),
  crossbowFire: P(0.75, 0.05, 0.2, 3, 0.05),
  boltImpact: P(0.7, 0, 0.22, 3, 0.05),
  smokeDeploy: P(0.65, 0.05, 0.2, 2, 0.05),
  wardTrigger: P(0.95, 0.25, 0.4, 2, 0.04),
  snareTrigger: P(0.9, 0.1, 0.3, 2, 0.05),
  snarePlace: P(0.42, 0, 0.12, 3, 0.06),
  breach: P(1.15, 0.35, 0.5, 2, 0.03),
  doorSlam: P(0.85, 0.12, 0.35, 3, 0.04),
  doorCreak: P(0.6, 0.05, 0.3, 3, 0.06),
  charmRattle: P(0.55, 0, 0.25, 4, 0.06),
  shrineStart: P(0.62, 0.06, 0.3, 2, 0.03),
  shrineDone: P(0.85, 0.3, 0.45, 1, 0.02),
  wound: P(0.9, 0.2, 0.25, 3, 0.05),
  capture: P(1.1, 0.6, 0.5, 1, 0.02),
  pulse: P(0.8, 0.2, 0.35, 2, 0.03),
  vault: P(0.55, 0, 0.12, 3, 0.06),
  breath: P(0.55, 0, 0.1, 4, 0.06),
};

const UI_GAIN: Record<UiSoundKind, number> = {
  hover: 0.22,
  click: 0.4,
  back: 0.34,
  ready: 0.45,
  victory: 0.6,
  defeat: 0.6,
  countdown: 0.5,
  reveal: 0.72,
};

/** Rendered once at unlock so the first footstep never stutters. */
const WARM_SOUNDS: SoundKind[] = [
  'footstepStone',
  'footstepDirt',
  'footstepGrass',
  'footstepWater',
  'decoyStep',
  'breath',
];
const WARM_EXTRAS: ExtraKind[] = ['wind', 'heartA', 'heartB'];

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function resolveContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

interface Voice {
  source: AudioBufferSourceNode;
  /** Every node created for this voice, in creation order. */
  chain: AudioNode[];
  gain: GainNode;
  /** Effective loudness; the eviction policy drops the smallest. */
  priority: number;
  released: boolean;
}

interface DeferredTask {
  at: number;
  run(): void;
}

/** A continuous layer (ambience, heartbeat bed, curse tone) that can fade out. */
interface Layer {
  gain: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  stopped: boolean;
}

export function createAudioSystem(): AudioSystem {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let context: AudioContext | null = null;
  let disposed = false;
  let unlocking: Promise<void> | null = null;

  let master: GainNode | null = null;
  let limiter: DynamicsCompressorNode | null = null;
  let ambienceBus: GainNode | null = null;
  let ambienceDuck: GainNode | null = null;
  let effectsBus: GainNode | null = null;
  let reverbSend: GainNode | null = null;
  let reverbReturn: GainNode | null = null;
  let convolver: ConvolverNode | null = null;

  let heartbeatGain: GainNode | null = null;
  let breathGain: GainNode | null = null;
  let sprintGain: GainNode | null = null;

  const buffers = new Map<string, AudioBuffer>();
  const voices: Voice[] = [];
  const deferred: DeferredTask[] = [];
  const layers = new Set<Layer>();

  /** Drives all per-playback variation. Seeded, so replays are identical. */
  const rng: Rng = createRng(hashString('veilhunt.audio.playback'));
  /** Separate stream for ambient scheduling so one-shots cannot perturb it. */
  const ambientRng: Rng = createRng(hashString('veilhunt.audio.ambient'));

  let settings: GameSettings | null = null;
  let listener: AudioListenerState = { x: 0, z: 0, yaw: 0 };
  let forwardX = 0;
  let forwardZ = 1;
  let rightX = 1;
  let rightZ = 0;

  let dread = 0;
  let woundLevel: WoundLevel = 'unmarked';
  let sprinting = false;

  let schedulerId: number | null = null;
  let ambience: { role: Role | 'menu'; layer: Layer } | null = null;
  let curseLayer: Layer | null = null;
  let dreadSub: { layer: Layer; gain: GainNode } | null = null;
  let sprintSource: AudioBufferSourceNode | null = null;

  let nextHeartbeat = 0;
  let nextBreath = 0;
  let nextAmbientEvent = 0;
  let countdownStep = 0;
  let lastCountdownAt = -Infinity;

  const isRunning = (): boolean => !disposed && context !== null && context.state === 'running';

  // -------------------------------------------------------------------------
  // Buffer cache
  // -------------------------------------------------------------------------

  function cached(key: string, build: (ctx: AudioContext) => AudioBuffer): AudioBuffer | null {
    if (!context) return null;
    const hit = buffers.get(key);
    if (hit) return hit;
    try {
      const made = build(context);
      buffers.set(key, made);
      return made;
    } catch {
      return null;
    }
  }

  const soundBuffer = (kind: SoundKind, variant: number): AudioBuffer | null =>
    cached(`s:${kind}:${variant}`, (ctx) => toAudioBuffer(ctx, renderSound(kind, ctx.sampleRate, variant)));

  const uiBuffer = (kind: UiSoundKind): AudioBuffer | null =>
    cached(`u:${kind}`, (ctx) => toAudioBuffer(ctx, renderUiSound(kind, ctx.sampleRate)));

  const extraBuffer = (kind: ExtraKind): AudioBuffer | null =>
    cached(`x:${kind}`, (ctx) => toAudioBuffer(ctx, renderExtra(kind, ctx.sampleRate)));

  // -------------------------------------------------------------------------
  // Voice pool
  // -------------------------------------------------------------------------

  function releaseVoice(voice: Voice): void {
    if (voice.released) return;
    voice.released = true;
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
    voice.source.onended = null;
    try {
      voice.source.stop();
    } catch {
      /* already stopped — the ended handler is the normal path */
    }
    for (const node of voice.chain) {
      try {
        node.disconnect();
      } catch {
        /* a node may already be detached */
      }
    }
    voice.chain.length = 0;
  }

  /** Fades a voice out fast and lets `ended` reclaim it. */
  function evictVoice(voice: Voice): void {
    if (!context) return;
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
    const now = context.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + 0.03);
      voice.source.stop(now + 0.035);
    } catch {
      releaseVoice(voice);
    }
  }

  /**
   * Makes room for a voice of `priority`. Returns false when the newcomer is
   * quieter than everything already playing, in which case it is dropped.
   */
  function reserveVoice(priority: number): boolean {
    if (voices.length < VOICE_CAP) return true;
    let quietest: Voice | null = null;
    for (const voice of voices) {
      if (!quietest || voice.priority < quietest.priority) quietest = voice;
    }
    if (!quietest || quietest.priority >= priority) return false;
    evictVoice(quietest);
    return true;
  }

  interface PlayOpts {
    gain: number;
    rate: number;
    /** −1 hard left, +1 hard right; omitted for centred sounds. */
    pan?: number;
    /** Muffle cutoff in Hz; omitted for a dry, unfiltered path. */
    cutoff?: number;
    reverb?: number;
    /** Absolute context time; 0 (the default) means "as soon as possible". */
    when?: number;
    /** Defaults to the effects bus. */
    target?: AudioNode | null;
  }

  function playBuffer(buffer: AudioBuffer | null, opts: PlayOpts): void {
    const destination = opts.target ?? effectsBus;
    if (!context || !destination || !buffer) return;
    if (opts.gain <= 0.0005) return;
    if (!reserveVoice(opts.gain)) return;

    const ctx = context;
    const chain: AudioNode[] = [];
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = opts.rate;
    chain.push(source);

    let head: AudioNode = source;
    if (opts.cutoff !== undefined && opts.cutoff < 18000) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = clamp(opts.cutoff, 180, 20000);
      filter.Q.value = 0.5;
      head.connect(filter);
      head = filter;
      chain.push(filter);
    }

    const gain = ctx.createGain();
    gain.gain.value = opts.gain;
    head.connect(gain);
    head = gain;
    chain.push(gain);

    if (opts.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(opts.pan, -1, 1);
      head.connect(panner);
      head = panner;
      chain.push(panner);
    }

    head.connect(destination);

    if (opts.reverb && opts.reverb > 0.01 && reverbSend) {
      const send = ctx.createGain();
      send.gain.value = opts.reverb;
      head.connect(send);
      send.connect(reverbSend);
      chain.push(send);
    }

    const voice: Voice = { source, chain, gain, priority: opts.gain, released: false };
    voices.push(voice);
    source.onended = () => releaseVoice(voice);
    try {
      source.start(opts.when ?? 0);
    } catch {
      releaseVoice(voice);
    }
  }

  // -------------------------------------------------------------------------
  // Graph construction
  // -------------------------------------------------------------------------

  function buildGraph(ctx: AudioContext): void {
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.22;
    limiter.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = settings ? (settings.muted ? 0 : clamp(settings.masterVolume, 0, 1)) : 0.8;
    master.connect(limiter);

    ambienceBus = ctx.createGain();
    ambienceBus.gain.value = settings ? clamp(settings.ambienceVolume, 0, 1) : 0.65;
    ambienceBus.connect(master);

    ambienceDuck = ctx.createGain();
    ambienceDuck.gain.value = 1;
    ambienceDuck.connect(ambienceBus);

    effectsBus = ctx.createGain();
    effectsBus.gain.value = settings ? clamp(settings.effectsVolume, 0, 1) : 0.9;
    effectsBus.connect(master);

    convolver = ctx.createConvolver();
    convolver.normalize = true;
    try {
      convolver.buffer = createReverbBuffer(ctx, 1.4);
    } catch {
      convolver = null;
    }
    if (convolver) {
      reverbSend = ctx.createGain();
      reverbSend.gain.value = 1;
      reverbReturn = ctx.createGain();
      reverbReturn.gain.value = 0.5;
      reverbSend.connect(convolver);
      convolver.connect(reverbReturn);
      reverbReturn.connect(effectsBus);
    }

    heartbeatGain = ctx.createGain();
    heartbeatGain.gain.value = 0;
    heartbeatGain.connect(effectsBus);

    breathGain = ctx.createGain();
    breathGain.gain.value = 0.9;
    breathGain.connect(effectsBus);

    sprintGain = ctx.createGain();
    sprintGain.gain.value = 0;
    sprintGain.connect(effectsBus);
  }

  function teardownGraph(): void {
    const nodes: (AudioNode | null)[] = [
      heartbeatGain,
      breathGain,
      sprintGain,
      reverbSend,
      convolver,
      reverbReturn,
      ambienceDuck,
      ambienceBus,
      effectsBus,
      master,
      limiter,
    ];
    for (const node of nodes) {
      if (!node) continue;
      try {
        node.disconnect();
      } catch {
        /* already detached */
      }
    }
    heartbeatGain = null;
    breathGain = null;
    sprintGain = null;
    reverbSend = null;
    convolver = null;
    reverbReturn = null;
    ambienceDuck = null;
    ambienceBus = null;
    effectsBus = null;
    master = null;
    limiter = null;
  }

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------

  function createLayer(destination: AudioNode, initialGain = 0): Layer {
    const ctx = context;
    if (!ctx) throw new Error('no context');
    const gain = ctx.createGain();
    gain.gain.value = initialGain;
    gain.connect(destination);
    const layer: Layer = { gain, nodes: [gain], sources: [], stopped: false };
    layers.add(layer);
    return layer;
  }

  function destroyLayer(layer: Layer): void {
    if (layer.stopped) return;
    layer.stopped = true;
    layers.delete(layer);
    for (const source of layer.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* may never have started */
      }
    }
    for (const node of layer.nodes) {
      try {
        node.disconnect();
      } catch {
        /* already detached */
      }
    }
    layer.sources.length = 0;
    layer.nodes.length = 0;
  }

  /** Ramps a layer to zero and tears it down once the fade has finished. */
  function fadeOutLayer(layer: Layer, seconds: number): void {
    if (!context || layer.stopped) {
      destroyLayer(layer);
      return;
    }
    const now = context.currentTime;
    try {
      layer.gain.gain.cancelScheduledValues(now);
      layer.gain.gain.setValueAtTime(layer.gain.gain.value, now);
      layer.gain.gain.linearRampToValueAtTime(0, now + seconds);
    } catch {
      destroyLayer(layer);
      return;
    }
    deferred.push({ at: now + seconds + 0.05, run: () => destroyLayer(layer) });
  }

  function rampTo(param: AudioParam, value: number, timeConstant = SMOOTH): void {
    if (!context) return;
    const now = context.currentTime;
    try {
      // Clear any pending automation first, otherwise an earlier "pin to zero"
      // event still queued in the future would stamp over this ramp.
      const current = param.value;
      param.cancelScheduledValues(now);
      param.setValueAtTime(current, now);
      param.setTargetAtTime(value, now, timeConstant);
      // setTargetAtTime is asymptotic; pin the value so "silent" really is zero.
      if (value === 0) param.setValueAtTime(0, now + timeConstant * 6);
    } catch {
      param.value = value;
    }
  }

  /** Adds a looping buffer source to a layer, wired through optional nodes. */
  function addLoop(layer: Layer, buffer: AudioBuffer, target: AudioNode, rate = 1, offset = 0): AudioBufferSourceNode | null {
    if (!context) return null;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = rate;
    source.connect(target);
    layer.sources.push(source);
    layer.nodes.push(source);
    try {
      source.start(0, offset % Math.max(0.001, buffer.duration));
    } catch {
      return null;
    }
    return source;
  }

  function addOsc(
    layer: Layer,
    target: AudioNode,
    type: OscillatorType,
    freq: number,
    gainValue: number,
  ): { osc: OscillatorNode; gain: GainNode } | null {
    if (!context) return null;
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = context.createGain();
    gain.gain.value = gainValue;
    osc.connect(gain);
    gain.connect(target);
    layer.sources.push(osc);
    layer.nodes.push(osc, gain);
    try {
      osc.start();
    } catch {
      return null;
    }
    return { osc, gain };
  }

  /** Slow LFO wired onto an AudioParam; lives and dies with the layer. */
  function addLfo(layer: Layer, target: AudioParam, hz: number, depth: number): void {
    if (!context) return;
    const osc = context.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const gain = context.createGain();
    gain.gain.value = depth;
    osc.connect(gain);
    gain.connect(target);
    layer.sources.push(osc);
    layer.nodes.push(osc, gain);
    try {
      osc.start();
    } catch {
      /* context may be closing */
    }
  }

  // -------------------------------------------------------------------------
  // Ambience
  // -------------------------------------------------------------------------

  interface AmbienceProfile {
    /** Overall layer level. */
    level: number;
    windGain: number;
    windCenter: number;
    windQ: number;
    windLfoHz: number;
    windLfoDepth: number;
    /** Playback rate of the wind bed; below 1 reads as heavier and larger. */
    windRate: number;
    droneGain: number;
    droneRoot: number;
    padGain: number;
    /** Seconds between sparse distant events. */
    eventMin: number;
    eventMax: number;
  }

  const AMBIENCE: Record<Role | 'menu', AmbienceProfile> = {
    menu: {
      level: 0.9,
      windGain: 0.34,
      windCenter: 430,
      windQ: 0.85,
      windLfoHz: 0.037,
      windLfoDepth: 260,
      windRate: 0.9,
      droneGain: 0.16,
      droneRoot: 55,
      padGain: 0.3,
      eventMin: 14,
      eventMax: 34,
    },
    // The Hunter sits lower and heavier: the ruins press in around them.
    hunter: {
      level: 0.82,
      windGain: 0.3,
      windCenter: 300,
      windQ: 1.05,
      windLfoHz: 0.045,
      windLfoDepth: 175,
      windRate: 0.84,
      droneGain: 0.3,
      droneRoot: 38.9,
      padGain: 0,
      eventMin: 9,
      eventMax: 22,
    },
    // The Runner is thinner and more exposed: more air, less floor.
    runner: {
      level: 0.96,
      windGain: 0.42,
      windCenter: 620,
      windQ: 0.7,
      windLfoHz: 0.061,
      windLfoDepth: 380,
      windRate: 1.06,
      droneGain: 0.15,
      droneRoot: 46.2,
      padGain: 0,
      eventMin: 7,
      eventMax: 18,
    },
  };

  function buildAmbienceLayer(kind: Role | 'menu'): Layer | null {
    const ctx = context;
    if (!ctx || !ambienceDuck) return null;
    const profile = AMBIENCE[kind];
    const layer = createLayer(ambienceDuck, 0);

    // Wind: one pre-rendered seamless noise bed swept by a slow band-pass.
    const windBuffer = extraBuffer('wind');
    if (windBuffer) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = profile.windCenter;
      filter.Q.value = profile.windQ;
      const gain = ctx.createGain();
      gain.gain.value = profile.windGain;
      filter.connect(gain);
      gain.connect(layer.gain);
      layer.nodes.push(filter, gain);
      addLoop(layer, windBuffer, filter, profile.windRate, ambientRng.range(0, windBuffer.duration));
      addLfo(layer, filter.frequency, profile.windLfoHz, profile.windLfoDepth);
      addLfo(layer, gain.gain, profile.windLfoHz * 0.63, profile.windGain * 0.4);
      // A second, higher band adds the whistle over broken stone.
      const hi = ctx.createBiquadFilter();
      hi.type = 'bandpass';
      hi.frequency.value = profile.windCenter * 3.4;
      hi.Q.value = 2.2;
      const hiGain = ctx.createGain();
      hiGain.gain.value = profile.windGain * 0.22;
      hi.connect(hiGain);
      hiGain.connect(layer.gain);
      layer.nodes.push(hi, hiGain);
      addLoop(layer, windBuffer, hi, profile.windRate * 1.31, ambientRng.range(0, windBuffer.duration));
      addLfo(layer, hi.frequency, profile.windLfoHz * 1.7, profile.windCenter * 1.1);
    }

    // Sub drone: two detuned sines beating against each other, plus a fifth.
    if (profile.droneGain > 0) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 190;
      lp.Q.value = 0.6;
      const gain = ctx.createGain();
      gain.gain.value = profile.droneGain;
      lp.connect(gain);
      gain.connect(layer.gain);
      layer.nodes.push(lp, gain);
      addOsc(layer, lp, 'sine', profile.droneRoot, 0.6);
      addOsc(layer, lp, 'sine', profile.droneRoot * 1.011, 0.45);
      addOsc(layer, lp, 'sine', profile.droneRoot * 1.5, 0.2);
      addLfo(layer, gain.gain, 0.031, profile.droneGain * 0.45);
    }

    // Menu pad: a cold, slowly evolving chord under a breathing low-pass.
    if (profile.padGain > 0) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 780;
      lp.Q.value = 1.4;
      const gain = ctx.createGain();
      gain.gain.value = profile.padGain;
      lp.connect(gain);
      gain.connect(layer.gain);
      layer.nodes.push(lp, gain);
      const voices2: [OscillatorType, number, number, number][] = [
        ['sine', 55, 0.5, 0.019],
        ['sine', 82.4, 0.34, 0.013],
        ['triangle', 110.2, 0.22, 0.023],
        ['sine', 164.5, 0.16, 0.017],
        ['sine', 246.9, 0.09, 0.029],
      ];
      for (const [type, freq, amp, lfoHz] of voices2) {
        const made = addOsc(layer, lp, type, freq, amp);
        // Each partial breathes at its own rate so the chord never repeats.
        if (made) addLfo(layer, made.gain.gain, lfoHz, amp * 0.7);
      }
      addLfo(layer, lp.frequency, 0.047, 340);
    }

    return layer;
  }

  function startAmbience(kind: Role | 'menu'): void {
    if (!isRunning() || !context || !ambienceDuck) return;
    if (ambience && ambience.role === kind) return;
    if (ambience) {
      fadeOutLayer(ambience.layer, 0.45);
      ambience = null;
    }
    const layer = buildAmbienceLayer(kind);
    if (!layer) return;
    ambience = { role: kind, layer };
    rampTo(layer.gain.gain, AMBIENCE[kind].level, 0.5);
    nextAmbientEvent = context.currentTime + ambientRng.range(5, 12);
  }

  // -------------------------------------------------------------------------
  // Dread / wound / sprint layers
  // -------------------------------------------------------------------------

  function ensureDreadSub(): void {
    if (dreadSub || !context || !effectsBus) return;
    const layer = createLayer(effectsBus, 1);
    const lp = context.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 120;
    lp.Q.value = 0.8;
    // The slow swell has to live *upstream* of the dread gain. An LFO connected
    // to an AudioParam is summed on top of that param's automation, so putting
    // it on the dread gain itself would keep leaking signal at dread 0.
    const swell = context.createGain();
    swell.gain.value = 0.88;
    lp.connect(swell);
    const gain = context.createGain();
    gain.gain.value = 0;
    swell.connect(gain);
    gain.connect(layer.gain);
    layer.nodes.push(lp, swell, gain);
    addOsc(layer, lp, 'sine', 41, 0.7);
    addOsc(layer, lp, 'sine', 61.6, 0.28);
    addOsc(layer, lp, 'triangle', 27.5, 0.35);
    addLfo(layer, swell.gain, 0.27, 0.12);
    dreadSub = { layer, gain };
  }

  function ensureCurseLayer(): void {
    if (curseLayer || !context || !effectsBus) return;
    const layer = createLayer(effectsBus, 0);
    const lp = context.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.Q.value = 1.2;
    lp.connect(layer.gain);
    layer.nodes.push(lp);
    // A tritone plus a sour minor second: never resolves, never lets go.
    addOsc(layer, lp, 'sine', 116.5, 0.5);
    addOsc(layer, lp, 'sine', 164.8, 0.34);
    addOsc(layer, lp, 'sine', 174.6, 0.2);
    addOsc(layer, lp, 'triangle', 329.6, 0.09);
    addLfo(layer, lp.frequency, 0.19, 600);
    curseLayer = layer;
    rampTo(layer.gain.gain, 0.085, 1.5);
  }

  // -------------------------------------------------------------------------
  // Scheduler — one low-rate timer drives every continuous layer
  // -------------------------------------------------------------------------

  function runDeferred(now: number): void {
    for (let i = deferred.length - 1; i >= 0; i -= 1) {
      const task = deferred[i];
      if (task.at > now) continue;
      deferred.splice(i, 1);
      try {
        task.run();
      } catch {
        /* a teardown task must never break the scheduler */
      }
    }
  }

  function scheduleHeartbeat(now: number, horizon: number): void {
    if (dread <= 0.001 || !heartbeatGain) {
      // Fully silent at zero dread: nothing is queued at all.
      nextHeartbeat = now + 0.05;
      return;
    }
    const bpm = 60 + 70 * Math.pow(dread, 0.85);
    const interval = 60 / bpm;
    if (nextHeartbeat < now) nextHeartbeat = now + 0.03;
    let guard = 0;
    while (nextHeartbeat < horizon && guard < 8) {
      guard += 1;
      const jitter = 1 + (rng() * 2 - 1) * 0.02;
      playBuffer(extraBuffer('heartA'), {
        gain: 0.95,
        rate: jitter,
        when: nextHeartbeat,
        target: heartbeatGain,
      });
      playBuffer(extraBuffer('heartB'), {
        gain: 0.6,
        rate: jitter * 1.02,
        when: nextHeartbeat + interval * 0.28,
        target: heartbeatGain,
      });
      nextHeartbeat += interval;
    }
  }

  function scheduleBreath(now: number, horizon: number): void {
    if (woundLevel === 'unmarked' || !breathGain) {
      nextBreath = now + 0.05;
      return;
    }
    const cursed = woundLevel === 'cursed';
    if (nextBreath < now) nextBreath = now + 0.2;
    let guard = 0;
    while (nextBreath < horizon && guard < 4) {
      guard += 1;
      const variants = PROFILES.breath.variants;
      playBuffer(soundBuffer('breath', rng.int(0, variants - 1)), {
        gain: cursed ? 0.6 : 0.4,
        // Cursed breathing is faster and more ragged.
        rate: (cursed ? 1.16 : 0.95) * (1 + (rng() * 2 - 1) * (cursed ? 0.1 : 0.05)),
        when: nextBreath,
        target: breathGain,
        reverb: 0.05,
      });
      nextBreath += cursed ? rng.range(1.3, 1.8) : rng.range(2.5, 3.3);
    }
  }

  function scheduleAmbientEvents(now: number, horizon: number): void {
    if (!ambience) {
      nextAmbientEvent = now + 1;
      return;
    }
    const profile = AMBIENCE[ambience.role];
    if (nextAmbientEvent < now) nextAmbientEvent = now + ambientRng.range(profile.eventMin, profile.eventMax);
    let guard = 0;
    while (nextAmbientEvent < horizon && guard < 2) {
      guard += 1;
      const target = ambience.layer.gain;
      const roll = ambientRng();
      const pan = ambientRng.range(-0.85, 0.85);
      if (ambience.role === 'menu' || roll < 0.34) {
        playBuffer(extraBuffer('distantBell'), {
          gain: ambientRng.range(0.16, 0.3),
          rate: ambientRng.range(0.9, 1.12),
          pan,
          cutoff: ambientRng.range(900, 1700),
          when: nextAmbientEvent,
          target,
        });
      } else if (roll < 0.74) {
        playBuffer(extraBuffer('distantCreak'), {
          gain: ambientRng.range(0.2, 0.36),
          rate: ambientRng.range(0.85, 1.15),
          pan,
          cutoff: ambientRng.range(800, 2000),
          when: nextAmbientEvent,
          target,
        });
      } else {
        playBuffer(soundBuffer('charmRattle', ambientRng.int(0, PROFILES.charmRattle.variants - 1)), {
          gain: ambientRng.range(0.1, 0.2),
          rate: ambientRng.range(0.9, 1.1),
          pan,
          cutoff: ambientRng.range(1200, 3000),
          when: nextAmbientEvent,
          target,
        });
      }
      nextAmbientEvent += ambientRng.range(profile.eventMin, profile.eventMax);
    }
  }

  function tick(): void {
    if (disposed || !context) return;
    const now = context.currentTime;
    runDeferred(now);
    if (context.state !== 'running') return;
    const horizon = now + LOOKAHEAD;
    scheduleHeartbeat(now, horizon);
    scheduleBreath(now, horizon);
    scheduleAmbientEvents(now, horizon);
  }

  function startScheduler(): void {
    if (schedulerId !== null || typeof window === 'undefined') return;
    schedulerId = window.setInterval(tick, SCHEDULER_INTERVAL_MS);
  }

  function stopScheduler(): void {
    if (schedulerId === null || typeof window === 'undefined') return;
    window.clearInterval(schedulerId);
    schedulerId = null;
  }

  // -------------------------------------------------------------------------
  // Warm-up
  // -------------------------------------------------------------------------

  let warmed = false;

  /**
   * Pre-renders the repeated sources (footsteps, wind, heartbeat) so nothing
   * builds a node graph or runs DSP during play. Everything else renders once
   * on first use and is cached forever after.
   */
  function warmUp(): void {
    if (warmed || !context) return;
    warmed = true;
    for (const kind of WARM_SOUNDS) {
      const variants = PROFILES[kind].variants;
      for (let v = 0; v < variants; v += 1) soundBuffer(kind, v);
    }
    for (const kind of WARM_EXTRAS) extraBuffer(kind);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  async function unlock(): Promise<void> {
    if (disposed) return;
    if (!unlocking) {
      unlocking = (async () => {
        try {
          if (!context) {
            const Ctor = resolveContextCtor();
            if (!Ctor) return;
            context = new Ctor({ latencyHint: 'interactive' });
            buildGraph(context);
            startScheduler();
          }
          if (context.state !== 'running') await context.resume();
          if (context.state === 'running') warmUp();
        } catch {
          /* unlock must never throw; the caller retries on the next gesture */
        }
      })();
    }
    try {
      await unlocking;
    } catch {
      /* never throw */
    }
    // Cleared so a later gesture can resume a context the browser re-suspended.
    unlocking = null;
  }

  function applySettings(next: GameSettings): void {
    settings = { ...next };
    if (!context || !master || !ambienceBus || !effectsBus) return;
    rampTo(master.gain, next.muted ? 0 : clamp(next.masterVolume, 0, 1));
    rampTo(ambienceBus.gain, clamp(next.ambienceVolume, 0, 1));
    rampTo(effectsBus.gain, clamp(next.effectsVolume, 0, 1));
  }

  function setListener(state: AudioListenerState): void {
    listener.x = state.x;
    listener.z = state.z;
    listener.yaw = state.yaw;
    // Matches shared/movement.ts: forward is (sin yaw, cos yaw).
    forwardX = Math.sin(state.yaw);
    forwardZ = Math.cos(state.yaw);
    rightX = forwardZ;
    rightZ = -forwardX;
  }

  function play(kind: SoundKind, x: number, z: number, volume: number, own: boolean): void {
    if (!isRunning()) return;
    const profile = PROFILES[kind];
    if (!profile) return;
    const variant = profile.variants > 1 ? rng.int(0, profile.variants - 1) : 0;
    const buffer = soundBuffer(kind, variant);
    if (!buffer) return;
    const rate = 1 + (rng() * 2 - 1) * profile.jitter;
    const raw = clamp(volume, 0, 1);
    // Map-wide events keep a loudness floor even at the far edge of the map.
    const level = Math.max(raw, profile.floor);

    if (own) {
      // The local player's own sounds are centred, dry and a touch quieter so
      // they never mask the opponent's.
      playBuffer(buffer, {
        gain: profile.gain * level * 0.72,
        rate,
        reverb: profile.reverb * 0.35,
      });
      return;
    }

    const dx = x - listener.x;
    const dz = z - listener.z;
    const len = Math.hypot(dx, dz);
    let pan = 0;
    let front = 1;
    if (len > 0.001) {
      const nx = dx / len;
      const nz = dz / len;
      pan = nx * rightX + nz * rightZ;
      front = nx * forwardX + nz * forwardZ;
    }
    // 0 directly behind, 1 directly ahead. Rear sounds are duller and slightly
    // quieter — the same cue a real head shadow gives, and the thing that lets
    // the Hunter resolve front from back by ear.
    const frontness = (front + 1) * 0.5;
    const distance = 1 - raw;
    const cutoff = 20000 * Math.pow(0.045, distance) * (0.32 + 0.68 * frontness);

    playBuffer(buffer, {
      gain: profile.gain * level * (0.82 + 0.18 * frontness),
      rate,
      pan: pan * 0.92,
      cutoff,
      reverb: profile.reverb * (0.55 + 0.45 * distance),
    });
  }

  function playUi(kind: UiSoundKind): void {
    if (!isRunning() || !context) return;

    if (kind === 'countdown') {
      const now = context.currentTime;
      // A fresh countdown restarts the sequence; the final beat sits higher.
      if (now - lastCountdownAt > 2.5) countdownStep = 0;
      lastCountdownAt = now;
      countdownStep += 1;
      const isFinal = countdownStep >= 5;
      const buffer = isFinal ? extraBuffer('countdownFinal') : uiBuffer('countdown');
      playBuffer(buffer, {
        gain: UI_GAIN.countdown * (isFinal ? 1.2 : 1),
        // Each tick creeps up in pitch so the sequence tightens.
        rate: isFinal ? 1 : 1 + (countdownStep - 1) * 0.018,
        reverb: isFinal ? 0.2 : 0.05,
      });
      return;
    }

    const reverb = kind === 'reveal' || kind === 'victory' || kind === 'defeat' ? 0.18 : kind === 'ready' ? 0.1 : 0;
    playBuffer(uiBuffer(kind), {
      gain: UI_GAIN[kind],
      rate: 1 + (rng() * 2 - 1) * 0.01,
      reverb,
    });
  }

  function stopAmbience(): void {
    if (ambience) {
      fadeOutLayer(ambience.layer, AMBIENCE_FADE);
      ambience = null;
    }
  }

  function setDread(value: number): void {
    dread = clamp(Number.isFinite(value) ? value : 0, 0, 1);
    if (!isRunning()) return;
    if (dread > 0) ensureDreadSub();
    if (heartbeatGain) rampTo(heartbeatGain.gain, dread <= 0 ? 0 : 0.5 + 0.5 * dread, 0.25);
    if (dreadSub) rampTo(dreadSub.gain.gain, dread <= 0 ? 0 : 0.1 * dread + 0.14 * dread * dread, 0.4);
    // Ambience steps back so the heartbeat has room.
    if (ambienceDuck) rampTo(ambienceDuck.gain, 1 - 0.3 * dread, 0.3);
  }

  function setWound(level: WoundLevel): void {
    if (level === woundLevel) return;
    woundLevel = level;
    if (!isRunning() || !context) return;
    if (level === 'cursed') {
      ensureCurseLayer();
    } else if (curseLayer) {
      fadeOutLayer(curseLayer, 1.2);
      curseLayer = null;
    }
    // Start breathing promptly rather than waiting out the previous interval.
    nextBreath = context.currentTime + (level === 'unmarked' ? 0 : 0.35);
  }

  function setSprinting(value: boolean): void {
    if (value === sprinting) return;
    sprinting = value;
    if (!isRunning() || !context || !sprintGain) return;
    if (value) {
      if (!sprintSource) {
        const buffer = extraBuffer('exertion');
        if (buffer) {
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.loop = true;
          source.playbackRate.value = 1 + (rng() * 2 - 1) * 0.05;
          source.connect(sprintGain);
          try {
            source.start(0, rng.range(0, buffer.duration));
            sprintSource = source;
          } catch {
            try {
              source.disconnect();
            } catch {
              /* already detached */
            }
          }
        }
      }
      rampTo(sprintGain.gain, 0.32, 0.18);
    } else {
      rampTo(sprintGain.gain, 0, 0.14);
      const source = sprintSource;
      if (source) {
        deferred.push({
          at: context.currentTime + 1.1,
          run: () => {
            // Only tear down if the player has not started sprinting again.
            if (sprinting || sprintSource !== source) return;
            sprintSource = null;
            try {
              source.onended = null;
              source.stop();
            } catch {
              /* already stopped */
            }
            try {
              source.disconnect();
            } catch {
              /* already detached */
            }
          },
        });
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopScheduler();
    deferred.length = 0;

    for (const voice of voices.slice()) releaseVoice(voice);
    voices.length = 0;

    for (const layer of Array.from(layers)) destroyLayer(layer);
    layers.clear();
    ambience = null;
    curseLayer = null;
    dreadSub = null;

    if (sprintSource) {
      try {
        sprintSource.onended = null;
        sprintSource.stop();
      } catch {
        /* already stopped */
      }
      try {
        sprintSource.disconnect();
      } catch {
        /* already detached */
      }
      sprintSource = null;
    }

    teardownGraph();
    buffers.clear();

    const ctx = context;
    context = null;
    unlocking = null;
    if (ctx) {
      void ctx.close().catch(() => {
        /* closing an already-closed context is fine */
      });
    }
  }

  return {
    unlock,
    get running(): boolean {
      return isRunning();
    },
    applySettings,
    setListener,
    play,
    playUi,
    startMenuAmbience: () => startAmbience('menu'),
    startMatchAmbience: (role: Role) => startAmbience(role),
    stopAmbience,
    setDread,
    setWound,
    setSprinting,
    dispose,
  };
}
