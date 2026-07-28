import type { WoundLevel } from './constants.js';

export type Role = 'hunter' | 'runner';

export type MatchPhase =
  | 'lobby'
  | 'roleReveal'
  | 'countdown'
  | 'active'
  | 'results';

export type MatchOutcome =
  | 'runnerEscaped'
  | 'runnerCaptured'
  | 'hunterTimeout'
  | 'abandoned';

export interface Vec2 {
  x: number;
  z: number;
}

export interface Vec3 extends Vec2 {
  y: number;
}

// ---------------------------------------------------------------------------
// Map data (deterministic, produced by mapgen from a seed)
// ---------------------------------------------------------------------------

export type WallKind =
  | 'ruinWall'
  | 'chapelWall'
  | 'hedge'
  | 'crypt'
  | 'tower'
  | 'boundary'
  | 'rubble';

/** Axis-aligned-then-rotated box collider, extruded from `base` to `base + height`. */
export interface WallBox {
  id: number;
  x: number;
  z: number;
  /** Half-extent along the box's local X axis. */
  hw: number;
  /** Half-extent along the box's local Z axis. */
  hd: number;
  rot: number;
  base: number;
  height: number;
  kind: WallKind;
  /** Blocks sight as well as movement. */
  opaque: boolean;
}

/** Low obstacle a player can vault over. Blocks movement while grounded. */
export interface VaultBox {
  id: number;
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  height: number;
  kind: 'railing' | 'wall' | 'tomb' | 'cart' | 'log';
}

/** Raised walkable region. Floor height is the max over all containing platforms. */
export interface Platform {
  id: number;
  x: number;
  z: number;
  hw: number;
  hd: number;
  height: number;
}

/** Sloped walkable region rising along its local +X axis from `height0` to `height1`. */
export interface Ramp {
  id: number;
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  height0: number;
  height1: number;
}

export type ZoneKind = 'shadow' | 'foliage' | 'water' | 'mud';

export interface Zone {
  id: number;
  kind: ZoneKind;
  x: number;
  z: number;
  radius: number;
}

export interface HideSpot {
  id: number;
  kind: 'wardrobe' | 'alcove' | 'sarcophagus';
  x: number;
  z: number;
  rot: number;
}

/** Crouch-only opening: blocks anyone standing at full height. */
export interface CrouchGate {
  id: number;
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
}

export interface DoorDef {
  id: number;
  x: number;
  z: number;
  rot: number;
  /** Hinge offset along the door's local X axis. */
  width: number;
}

export interface BarricadeDef {
  id: number;
  x: number;
  z: number;
  rot: number;
  hw: number;
  hd: number;
}

export type PropKind =
  | 'gravestone'
  | 'pillar'
  | 'brazier'
  | 'lantern'
  | 'charm'
  | 'grass'
  | 'rubble'
  | 'root'
  | 'statue'
  | 'urn'
  | 'bench'
  | 'archStone';

export interface PropInstance {
  kind: PropKind;
  x: number;
  z: number;
  y: number;
  rot: number;
  scale: number;
  /** Deterministic per-instance variation in 0..1. */
  variant: number;
}

export interface SealAnchor {
  id: number;
  x: number;
  z: number;
  /** Human-readable landmark used in HUD hints and results. */
  area: string;
}

export interface NoiseObject {
  id: number;
  x: number;
  z: number;
  kind: 'charmCluster' | 'urnStack';
}

export interface MapData {
  seed: number;
  size: number;
  walls: WallBox[];
  vaults: VaultBox[];
  platforms: Platform[];
  ramps: Ramp[];
  zones: Zone[];
  hideSpots: HideSpot[];
  crouchGates: CrouchGate[];
  doors: DoorDef[];
  barricades: BarricadeDef[];
  props: PropInstance[];
  /** Every candidate anchor; `activeSeals` picks the live subset. */
  sealAnchors: SealAnchor[];
  activeSeals: number[];
  noiseObjects: NoiseObject[];
  gate: { x: number; z: number; rot: number };
  shrine: { x: number; z: number };
  runnerSpawn: Vec2;
  hunterSpawn: Vec2;
  fogDensity: number;
}

// ---------------------------------------------------------------------------
// Runtime match state (authoritative, lives on the server)
// ---------------------------------------------------------------------------

export interface PlayerTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface PlayerMotion extends PlayerTransform {
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  crouching: boolean;
  sprinting: boolean;
  /** Horizontal speed last tick, used for footstep cadence and animation. */
  speed: number;
}

export interface SealState {
  id: number;
  x: number;
  z: number;
  area: string;
  progress: number;
  active: boolean;
}

export interface DecoyState {
  id: number;
  x: number;
  z: number;
  yaw: number;
  expiresIn: number;
}

export interface SmokeState {
  id: number;
  x: number;
  z: number;
  radius: number;
  expiresIn: number;
}

export interface WardState {
  id: number;
  x: number;
  z: number;
  armed: boolean;
  triggered: boolean;
}

export interface SnareState {
  id: number;
  x: number;
  z: number;
  armed: boolean;
  triggered: boolean;
}

export interface BoltState {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Spent bolts stick in the world and can be recovered. */
  landed: boolean;
  life: number;
}

export interface FootprintTrace {
  id: number;
  x: number;
  z: number;
  yaw: number;
  age: number;
  role: Role;
  /** Left foot / right foot, for alternating decals. */
  foot: 0 | 1;
}

export interface CooldownMap {
  [key: string]: number;
}

export type SoundKind =
  | 'footstepDirt'
  | 'footstepStone'
  | 'footstepWater'
  | 'footstepGrass'
  | 'decoyStep'
  | 'sealStart'
  | 'sealDone'
  | 'gateOpen'
  | 'gateChannel'
  | 'bladeWindup'
  | 'bladeHit'
  | 'bladeMiss'
  | 'crossbowFire'
  | 'boltImpact'
  | 'smokeDeploy'
  | 'wardTrigger'
  | 'snareTrigger'
  | 'snarePlace'
  | 'breach'
  | 'doorSlam'
  | 'doorCreak'
  | 'charmRattle'
  | 'shrineStart'
  | 'shrineDone'
  | 'wound'
  | 'capture'
  | 'pulse'
  | 'vault'
  | 'breath';

/** A world-space audible event. Sent only to clients within earshot. */
export interface SoundEvent {
  kind: SoundKind;
  x: number;
  z: number;
  /** 0..1 loudness after distance falloff, computed server-side. */
  volume: number;
  /** True when the source is the receiving player themselves. */
  own: boolean;
  seq: number;
}

export interface ContractDef {
  id: string;
  role: Role;
  title: string;
  description: string;
}

export interface MatchStats {
  durationPlayed: number;
  sealsActivated: number;
  woundsTaken: number;
  bladeSwings: number;
  bladeHits: number;
  boltsFired: number;
  boltsHit: number;
  snaresPlaced: number;
  snaresTriggered: number;
  decoysUsed: number;
  smokesUsed: number;
  wardsTriggered: number;
  breaches: number;
  healed: boolean;
  distanceRunner: number;
  distanceHunter: number;
  closestApproach: number;
  timeSpentHidden: number;
}

export interface ContractResult {
  contract: ContractDef;
  complete: boolean;
}

export interface MatchResult {
  outcome: MatchOutcome;
  winner: Role | null;
  reason: string;
  stats: MatchStats;
  contracts: Record<Role, ContractResult | null>;
  hunterName: string;
  runnerName: string;
}

// ---------------------------------------------------------------------------
// Wire payloads
// ---------------------------------------------------------------------------

export interface LobbyPlayerView {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  role: Role | null;
  isHost: boolean;
}

export interface RoomView {
  code: string;
  phase: MatchPhase;
  players: LobbyPlayerView[];
  seed: number;
  /** Round number; roles swap every round. */
  round: number;
  youId: string;
}

/** Input command produced by the client each tick and replayed by the server. */
export interface InputCommand {
  seq: number;
  dt: number;
  /** Normalised move intent in camera space, -1..1. */
  mx: number;
  mz: number;
  yaw: number;
  pitch: number;
  sprint: boolean;
  crouch: boolean;
  vault: boolean;
  /** Hunter holds right mouse to aim the crossbow; primary then fires it. */
  aim: boolean;
}

export type ActionKind =
  | 'interact'
  | 'interactStop'
  | 'primary'
  | 'secondary'
  | 'ability1'
  | 'ability2'
  | 'reload'
  | 'struggle';

export interface ActionCommand {
  kind: ActionKind;
  yaw: number;
  pitch: number;
  /** Client tick sequence the action was issued on. */
  seq: number;
}

/** What a client is currently able to interact with, computed server-side. */
export interface InteractPrompt {
  kind:
    | 'seal'
    | 'gate'
    | 'shrine'
    | 'door'
    | 'barricade'
    | 'hideSpot'
    | 'snareEscape'
    | 'boltPickup'
    | 'noiseObject'
    | 'none';
  id: number;
  label: string;
  progress: number;
  /** True while the prompt is blocked (e.g. gate locked). */
  blocked: boolean;
  blockedReason: string;
}

export interface SelfState {
  role: Role;
  transform: PlayerMotion;
  /** Last input sequence the server has consumed, for reconciliation. */
  ackSeq: number;
  stamina: number;
  staminaLocked: boolean;
  wound: WoundLevel;
  protectionRemaining: number;
  cooldowns: CooldownMap;
  charges: Record<string, number>;
  prompt: InteractPrompt;
  /** Active status effects with remaining seconds. */
  status: {
    rooted: number;
    stunned: number;
    slowed: number;
    hasted: number;
    marked: number;
    breaching: number;
    channeling: number;
    hidden: boolean;
    inSmoke: boolean;
    concealed: boolean;
    healUsed: boolean;
  };
  /** Blade swing timeline, drives client animation. */
  /** True while the Hunter is aiming down the crossbow. */
  aiming: boolean;
  bladePhase: 'idle' | 'windup' | 'active' | 'recovery';
  bladePhaseRemaining: number;
  bolts: number;
  reloading: number;
  /** 0..1 proximity heat for the runner's heartbeat vignette. */
  dread: number;
}

/** What the local client is allowed to know about the other player. */
export interface OpponentView {
  /** True when directly perceivable right now. */
  visible: boolean;
  transform: PlayerTransform | null;
  /** Approximate glowing trail position while marked; coarse, not exact. */
  markedTrail: { x: number; z: number; strength: number } | null;
  crouching: boolean;
  sprinting: boolean;
  wound: WoundLevel;
  speed: number;
}

export interface WorldSnapshot {
  tick: number;
  serverTime: number;
  phase: MatchPhase;
  timeRemaining: number;
  phaseRemaining: number;
  seals: SealState[];
  sealsActivated: number;
  gateOpen: boolean;
  gateProgress: number;
  shrineProgress: number;
  decoys: DecoyState[];
  smokes: SmokeState[];
  wards: WardState[];
  snares: SnareState[];
  bolts: BoltState[];
  doors: { id: number; open: number; disturbed: boolean }[];
  barricades: { id: number; broken: boolean }[];
  /** Footprints revealed by the most recent tracking pulse (hunter only). */
  revealedTraces: FootprintTrace[];
  pulse: { x: number; z: number; radius: number; age: number } | null;
  self: SelfState;
  opponent: OpponentView;
  sounds: SoundEvent[];
  /** Broadcast events both players see, e.g. "seal 2 lit". */
  banners: { id: number; text: string; tone: 'good' | 'bad' | 'neutral' }[];
  fogBoost: number;
}
