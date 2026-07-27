/**
 * Client-side module contracts.
 *
 * The world, character, VFX, UI and audio modules are built against these
 * interfaces so they stay decoupled from the netcode and from each other. The
 * app shell owns the loop and calls into them; they never reach back.
 */

import type * as THREE from 'three';
import type { WoundLevel } from '../shared/constants.js';
import type {
  MapData,
  MatchResult,
  Role,
  RoomView,
  SoundKind,
  WorldSnapshot,
} from '../shared/types.js';

export type QualityLevel = 'low' | 'medium' | 'high';

export interface GameSettings {
  masterVolume: number;
  ambienceVolume: number;
  effectsVolume: number;
  muted: boolean;
  mouseSensitivity: number;
  reducedShake: boolean;
  reducedMotion: boolean;
  invertY: boolean;
  quality: QualityLevel;
  showSoundIndicators: boolean;
  highContrastPrompts: boolean;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export interface WorldUpdateContext {
  dt: number;
  elapsed: number;
  cameraPosition: THREE.Vector3;
  /** 0 at match start, 1 at time expiry — drives late-match fog thickening. */
  fogBoost: number;
  reducedMotion: boolean;
  /** World position of the local player, for proximity reactions. */
  playerPosition: THREE.Vector3;
  /** Set when the local player moved fast nearby, for crows/grass reactions. */
  disturbance: number;
}

export interface WorldHandles {
  root: THREE.Group;
  /** Directional moonlight, shared with the renderer for shadow framing. */
  moon: THREE.DirectionalLight;
  fog: THREE.FogExp2;
  update(ctx: WorldUpdateContext): void;
  /** Startles nearby crows and bends grass; called on loud world events. */
  reactAt(x: number, z: number, strength: number): void;
  dispose(): void;
}

export interface BuildWorldOptions {
  map: MapData;
  quality: QualityLevel;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export interface CharacterRig {
  group: THREE.Group;
  /** Drives procedural walk/run/crouch animation. */
  update(dt: number, speed: number, crouching: boolean): void;
  setWound(level: WoundLevel): void;
  setMarked(marked: boolean): void;
  setStunned(stunned: boolean): void;
  /** Plays the blade wind-up → strike animation. */
  playAttack(): void;
  setOpacity(alpha: number): void;
  dispose(): void;
}

export interface CreateCharacterOptions {
  role: Role;
  /** Local player rigs hide the head so the third-person camera stays clear. */
  isLocal: boolean;
  quality: QualityLevel;
}

// ---------------------------------------------------------------------------
// Markers: everything driven directly from snapshot arrays
// ---------------------------------------------------------------------------

export interface MarkerContext {
  snapshot: WorldSnapshot;
  map: MapData;
  dt: number;
  elapsed: number;
  role: Role;
  reducedMotion: boolean;
}

export interface MarkerSystem {
  root: THREE.Group;
  sync(ctx: MarkerContext): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// VFX
// ---------------------------------------------------------------------------

export type VfxKind =
  | 'bladeImpact'
  | 'bladeMiss'
  | 'sealPulse'
  | 'sealComplete'
  | 'gateOpen'
  | 'wardBurst'
  | 'snareSnap'
  | 'boltImpact'
  | 'footDust'
  | 'waterSplash'
  | 'breachDebris'
  | 'healPulse';

export interface VfxSystem {
  root: THREE.Group;
  spawn(kind: VfxKind, x: number, y: number, z: number, strength?: number): void;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface AudioListenerState {
  x: number;
  z: number;
  yaw: number;
}

export interface AudioSystem {
  /** Must be called from a user gesture; safe to call repeatedly. */
  unlock(): Promise<void>;
  readonly running: boolean;
  applySettings(settings: GameSettings): void;
  setListener(state: AudioListenerState): void;
  /** Positional one-shot. `volume` is the server-computed 0..1 falloff. */
  play(kind: SoundKind, x: number, z: number, volume: number, own: boolean): void;
  /** Menu / results stingers with no world position. */
  playUi(kind: 'hover' | 'click' | 'back' | 'ready' | 'victory' | 'defeat' | 'countdown' | 'reveal'): void;
  startMenuAmbience(): void;
  startMatchAmbience(role: Role): void;
  stopAmbience(): void;
  /** 0..1 dread drives heartbeat rate and low-end pressure. */
  setDread(value: number): void;
  /** Wound level drives breathing loop intensity. */
  setWound(level: WoundLevel): void;
  setSprinting(sprinting: boolean): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export type ScreenName =
  | 'boot'
  | 'title'
  | 'connecting'
  | 'lobby'
  | 'roleReveal'
  | 'tutorial'
  | 'match'
  | 'pause'
  | 'results'
  | 'disconnected'
  | 'credits';

/** Everything the UI can ask the app to do. The UI never mutates game state. */
export interface UiActions {
  createRoom(name: string, seed?: number): void;
  joinRoom(name: string, code: string): void;
  setReady(ready: boolean): void;
  addBot(): void;
  leaveRoom(): void;
  rematch(): void;
  returnToLobby(): void;
  dismissTutorial(): void;
  resume(): void;
  quitToTitle(): void;
  updateSettings(patch: Partial<GameSettings>): void;
  requestPointerLock(): void;
  openCredits(): void;
  closeCredits(): void;
}

export interface HudState {
  role: Role;
  snapshot: WorldSnapshot;
  /** Round-trip latency in milliseconds, smoothed. */
  ping: number;
  connected: boolean;
  settings: GameSettings;
  /** Visual sound indicators: direction in radians relative to camera, 0..1 strength. */
  soundPings: { angle: number; strength: number; kind: SoundKind; age: number }[];
}

export interface UiSystem {
  readonly root: HTMLElement;
  setActions(actions: UiActions): void;
  showScreen(name: ScreenName): void;
  readonly currentScreen: ScreenName;
  setRoom(view: RoomView | null): void;
  setConnectionError(message: string | null): void;
  setStatus(message: string | null): void;
  showRoleReveal(payload: {
    role: Role;
    opponentName: string;
    round: number;
    seed: number;
    contract: { title: string; description: string } | null;
    duration: number;
  }): void;
  setCountdown(seconds: number | null): void;
  updateHud(state: HudState): void;
  showResults(result: MatchResult, yourRole: Role): void;
  setSettings(settings: GameSettings): void;
  setOpponentPresence(state: { present: boolean; name: string; graceSeconds: number } | null): void;
  /** Brief centre-screen feedback, e.g. "Cooldown not ready". */
  flashNotice(text: string, tone: 'good' | 'bad' | 'neutral'): void;
  dispose(): void;
}

export const DEFAULT_SETTINGS: GameSettings = {
  masterVolume: 0.8,
  ambienceVolume: 0.65,
  effectsVolume: 0.9,
  muted: false,
  mouseSensitivity: 1,
  reducedShake: false,
  reducedMotion: false,
  invertY: false,
  quality: 'high',
  showSoundIndicators: true,
  highContrastPrompts: false,
};
