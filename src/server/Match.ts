/**
 * The authoritative match simulation.
 *
 * Everything that decides the outcome of a round lives here: movement
 * integration, ability cooldowns, attack validation, seals, the gate, wounds and
 * victory. Clients only ever send intent; this class decides what actually
 * happened and hands each player a snapshot filtered to what they may know.
 */

import {
  BLADE,
  BREACH,
  COUNTDOWN_DURATION,
  CROSSBOW,
  DECOY,
  FOOTPRINT_LIFETIME,
  FOOTSTEP_INTERVAL,
  FOOTSTEP_NOISE_RADIUS,
  GATE_CHANNEL_TIME,
  GATE_DECAY_RATE,
  GATE_INTERACT_RANGE,
  HEARTBEAT_RANGE,
  HUNTER_STAMINA,
  MATCH_DURATION,
  MAX_FOOTPRINTS,
  PULSE,
  RUNNER_STAMINA,
  SEALS_REQUIRED,
  SEAL_CHANNEL_TIME,
  SEAL_DECAY_RATE,
  SEAL_INTERACT_RANGE,
  SHRINE_CHANNEL_TIME,
  SHRINE_DECAY_RATE,
  SHRINE_INTERACT_RANGE,
  SMOKE,
  SNARE,
  TICK_DT,
  WARD,
  WOUND_BREATH_RADIUS,
  type WoundLevel,
} from '../shared/constants.js';
import {
  canReach,
  floorHeightAt,
  hasLineOfSight,
  hideSpotAt,
  surfaceAt,
} from '../shared/collision.js';
import type { CollisionWorld, DynamicBlocker } from '../shared/collision.js';
import { generateMap } from '../shared/mapgen.js';
import { createMotion, eyeHeight, stepMovement } from '../shared/movement.js';
import type { MovementModifiers } from '../shared/movement.js';
import {
  applyWound,
  channelScaleForWound,
  countActiveSeals,
  evaluateBladeHit,
  evaluateVictory,
  previousWound,
  speedScaleForWound,
  tickCooldowns,
  woundIndex,
} from '../shared/matchRules.js';
import { createRng, type Rng } from '../shared/rng.js';
import {
  assignContracts,
  createContractProgress,
  evaluateContract,
  type ContractProgress,
} from '../shared/contracts.js';
import type {
  ActionCommand,
  BoltState,
  DecoyState,
  FootprintTrace,
  InputCommand,
  InteractPrompt,
  MapData,
  MatchResult,
  MatchStats,
  OpponentView,
  PlayerMotion,
  Role,
  SealState,
  SelfState,
  SmokeState,
  SnareState,
  SoundEvent,
  SoundKind,
  WardState,
  WorldSnapshot,
} from '../shared/types.js';
import { canPerceive, concealmentState, pulseDampingAt } from './visibility.js';

type ChannelKind = 'seal' | 'gate' | 'shrine' | 'snareEscape' | 'breach' | 'door' | 'none';

interface Channel {
  kind: ChannelKind;
  id: number;
  progress: number;
}

interface PlayerRuntime {
  id: string;
  name: string;
  role: Role;
  motion: PlayerMotion;
  connected: boolean;
  isBot: boolean;
  inputs: InputCommand[];
  ackSeq: number;
  stamina: number;
  staminaDelay: number;
  sprintLocked: boolean;
  cooldowns: Record<string, number>;
  wound: WoundLevel;
  protection: number;
  rooted: number;
  stunned: number;
  slowed: number;
  slowFactor: number;
  hasted: number;
  marked: number;
  stunImmunity: number;
  bolts: number;
  reloading: number;
  snareCharges: number;
  wardCharges: number;
  bladePhase: 'idle' | 'windup' | 'active' | 'recovery';
  bladeTimer: number;
  bladeConsumed: boolean;
  breachRecovery: number;
  channel: Channel;
  interactHeld: boolean;
  prompt: InteractPrompt;
  footstepTimer: number;
  footprintTimer: number;
  footprintFoot: 0 | 1;
  breathTimer: number;
  healUsed: boolean;
  carriesBolt: boolean;
  distance: number;
  hiddenTime: number;
  sounds: SoundEvent[];
}

interface DoorRuntime {
  id: number;
  x: number;
  z: number;
  rot: number;
  width: number;
  open: number;
  target: number;
  disturbed: boolean;
}

interface BarricadeRuntime {
  id: number;
  x: number;
  z: number;
  rot: number;
  hw: number;
  hd: number;
  broken: boolean;
}

interface DecoyRuntime extends DecoyState {
  vx: number;
  vz: number;
  stepTimer: number;
}

export interface MatchOptions {
  seed: number;
  round: number;
  players: { id: string; name: string; role: Role; isBot: boolean }[];
}

const EMPTY_PROMPT: InteractPrompt = {
  kind: 'none',
  id: 0,
  label: '',
  progress: 0,
  blocked: false,
  blockedReason: '',
};

export class Match {
  readonly seed: number;
  readonly round: number;
  readonly map: MapData;

  private readonly rng: Rng;
  private readonly players = new Map<string, PlayerRuntime>();
  private readonly doors: DoorRuntime[] = [];
  private readonly barricades: BarricadeRuntime[] = [];
  private readonly world: CollisionWorld;

  private seals: SealState[] = [];
  private gateProgress = 0;
  private shrineProgress = 0;
  private gateOpen = false;

  private decoys: DecoyRuntime[] = [];
  private smokes: SmokeState[] = [];
  private wards: WardState[] = [];
  private snares: SnareState[] = [];
  private bolts: BoltState[] = [];
  private footprints: FootprintTrace[] = [];

  private pulse: { x: number; z: number; radius: number; age: number; owner: string } | null = null;
  private revealedTraces: FootprintTrace[] = [];

  private banners: { id: number; text: string; tone: 'good' | 'bad' | 'neutral'; life: number }[] = [];
  private bannerId = 1;
  private soundSeq = 1;
  private entityId = 1;

  private phase: 'countdown' | 'active' | 'finished' = 'countdown';
  private phaseTimer = COUNTDOWN_DURATION;
  private timeRemaining = MATCH_DURATION;
  private tickCount = 0;

  private captured = false;
  private escaped = false;
  private abandonedBy: Role | null = null;

  private stats: MatchStats = {
    durationPlayed: 0,
    sealsActivated: 0,
    woundsTaken: 0,
    bladeSwings: 0,
    bladeHits: 0,
    boltsFired: 0,
    boltsHit: 0,
    snaresPlaced: 0,
    snaresTriggered: 0,
    decoysUsed: 0,
    smokesUsed: 0,
    wardsTriggered: 0,
    breaches: 0,
    healed: false,
    distanceRunner: 0,
    distanceHunter: 0,
    closestApproach: Number.POSITIVE_INFINITY,
    timeSpentHidden: 0,
  };

  private contractProgress: ContractProgress = createContractProgress();
  private result: MatchResult | null = null;

  constructor(options: MatchOptions) {
    this.seed = options.seed;
    this.round = options.round;
    this.rng = createRng((options.seed ^ (options.round * 0x1b873593)) >>> 0);
    this.map = generateMap(options.seed);
    this.world = { map: this.map, dynamic: [] };

    for (const door of this.map.doors) {
      this.doors.push({ ...door, open: 0, target: 0, disturbed: false });
    }
    for (const barricade of this.map.barricades) {
      this.barricades.push({ ...barricade, broken: false });
    }

    this.seals = this.map.activeSeals.map((id) => {
      const anchor = this.map.sealAnchors.find((a) => a.id === id)!;
      return { id, x: anchor.x, z: anchor.z, area: anchor.area, progress: 0, active: false };
    });

    for (const p of options.players) {
      this.players.set(p.id, this.createPlayer(p.id, p.name, p.role, p.isBot));
    }
    this.rebuildDynamicBlockers();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private createPlayer(id: string, name: string, role: Role, isBot: boolean): PlayerRuntime {
    const spawn = role === 'runner' ? this.map.runnerSpawn : this.map.hunterSpawn;
    const yaw = role === 'runner' ? Math.PI : 0;
    return {
      id,
      name,
      role,
      motion: createMotion(spawn.x, spawn.z, yaw),
      connected: true,
      isBot,
      inputs: [],
      ackSeq: 0,
      stamina: role === 'runner' ? RUNNER_STAMINA.max : HUNTER_STAMINA.max,
      staminaDelay: 0,
      sprintLocked: false,
      cooldowns: {
        blade: 0,
        crossbow: 0,
        pulse: 0,
        snare: 0,
        breach: 0,
        decoy: 0,
        smoke: 0,
        ward: 0,
        throw: 0,
      },
      wound: 'unmarked',
      protection: 0,
      rooted: 0,
      stunned: 0,
      slowed: 0,
      slowFactor: 1,
      hasted: 0,
      marked: 0,
      stunImmunity: 0,
      bolts: CROSSBOW.maxBolts,
      reloading: 0,
      snareCharges: SNARE.totalCharges,
      wardCharges: WARD.charges,
      bladePhase: 'idle',
      bladeTimer: 0,
      bladeConsumed: false,
      breachRecovery: 0,
      channel: { kind: 'none', id: 0, progress: 0 },
      interactHeld: false,
      prompt: { ...EMPTY_PROMPT },
      footstepTimer: 0,
      footprintTimer: 0,
      footprintFoot: 0,
      breathTimer: 0,
      healUsed: false,
      carriesBolt: false,
      distance: 0,
      hiddenTime: 0,
      sounds: [],
    };
  }

  private rebuildDynamicBlockers(): void {
    const dynamic: DynamicBlocker[] = [];
    for (const door of this.doors) {
      if (door.open >= 0.5) continue;
      dynamic.push({
        x: door.x + Math.cos(door.rot) * door.width * 0.5,
        z: door.z + Math.sin(door.rot) * door.width * 0.5,
        hw: door.width * 0.5,
        hd: 0.16,
        rot: door.rot,
        base: 0,
        height: 3,
        opaque: true,
      });
    }
    for (const barricade of this.barricades) {
      if (barricade.broken) continue;
      dynamic.push({
        x: barricade.x,
        z: barricade.z,
        hw: barricade.hw,
        hd: barricade.hd,
        rot: barricade.rot,
        base: 0,
        height: 2.6,
        opaque: true,
      });
    }
    this.world.dynamic = dynamic;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get isFinished(): boolean {
    return this.phase === 'finished';
  }

  get matchResult(): MatchResult | null {
    return this.result;
  }

  getPlayerIds(): string[] {
    return [...this.players.keys()];
  }

  getRole(id: string): Role | null {
    return this.players.get(id)?.role ?? null;
  }

  getMotion(id: string): PlayerMotion | null {
    return this.players.get(id)?.motion ?? null;
  }

  private other(player: PlayerRuntime): PlayerRuntime | null {
    for (const p of this.players.values()) if (p.id !== player.id) return p;
    return null;
  }

  private get runner(): PlayerRuntime | null {
    for (const p of this.players.values()) if (p.role === 'runner') return p;
    return null;
  }

  private get hunter(): PlayerRuntime | null {
    for (const p of this.players.values()) if (p.role === 'hunter') return p;
    return null;
  }

  // -------------------------------------------------------------------------
  // Input intake
  // -------------------------------------------------------------------------

  enqueueInput(playerId: string, commands: InputCommand[]): void {
    const player = this.players.get(playerId);
    if (!player) return;
    for (const cmd of commands) {
      if (cmd.seq <= player.ackSeq) continue;
      player.inputs.push(cmd);
    }
    // Bound the queue so a client cannot bank motion and burst it later.
    if (player.inputs.length > 24) player.inputs.splice(0, player.inputs.length - 24);
  }

  setConnected(playerId: string, connected: boolean): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = connected;
    if (!connected) {
      player.inputs.length = 0;
      player.interactHeld = false;
      player.channel = { kind: 'none', id: 0, progress: 0 };
    }
  }

  abandon(role: Role): void {
    if (this.phase === 'finished') return;
    this.abandonedBy = role;
    this.finish();
  }

  // -------------------------------------------------------------------------
  // Simulation tick
  // -------------------------------------------------------------------------

  tick(dt: number): void {
    if (this.phase === 'finished') return;
    this.tickCount += 1;

    if (this.phase === 'countdown') {
      this.phaseTimer -= dt;
      // Players may look around during the countdown but not move.
      for (const player of this.players.values()) this.consumeLookOnly(player);
      if (this.phaseTimer <= 0) {
        this.phase = 'active';
        this.phaseTimer = 0;
      }
      return;
    }

    this.timeRemaining = Math.max(0, this.timeRemaining - dt);
    this.stats.durationPlayed += dt;

    for (const player of this.players.values()) {
      this.tickPlayerTimers(player, dt);
      this.consumeInputs(player);
      this.tickChannel(player, dt);
      this.tickFootsteps(player, dt);
    }

    this.tickBlade(dt);
    this.tickDecoys(dt);
    this.tickSmokes(dt);
    this.tickBolts(dt);
    this.tickTraps(dt);
    this.tickDoors(dt);
    this.tickFootprints(dt);
    this.tickPulse(dt);
    this.tickBanners(dt);
    this.tickStats(dt);

    const verdict = evaluateVictory({
      runnerEscaped: this.escaped,
      runnerCaptured: this.captured,
      timeRemaining: this.timeRemaining,
      abandonedBy: this.abandonedBy,
    });
    if (verdict.finished) this.finish();
  }

  /** During the countdown only camera orientation is accepted. */
  private consumeLookOnly(player: PlayerRuntime): void {
    const last = player.inputs[player.inputs.length - 1];
    if (last) {
      player.motion.yaw = last.yaw;
      player.motion.pitch = last.pitch;
      player.ackSeq = last.seq;
      player.inputs.length = 0;
    }
  }

  private tickPlayerTimers(player: PlayerRuntime, dt: number): void {
    tickCooldowns(player.cooldowns, dt);
    player.protection = Math.max(0, player.protection - dt);
    player.rooted = Math.max(0, player.rooted - dt);
    player.stunned = Math.max(0, player.stunned - dt);
    player.slowed = Math.max(0, player.slowed - dt);
    player.hasted = Math.max(0, player.hasted - dt);
    player.marked = Math.max(0, player.marked - dt);
    player.stunImmunity = Math.max(0, player.stunImmunity - dt);
    player.breachRecovery = Math.max(0, player.breachRecovery - dt);
    if (player.slowed <= 0) player.slowFactor = 1;

    if (player.reloading > 0) {
      player.reloading = Math.max(0, player.reloading - dt);
      if (player.reloading === 0) player.bolts = CROSSBOW.maxBolts;
    }

    const table = player.role === 'runner' ? RUNNER_STAMINA : HUNTER_STAMINA;
    if (player.motion.sprinting) {
      player.stamina = Math.max(0, player.stamina - table.drain * dt);
      player.staminaDelay = table.regenDelay;
      if (player.stamina <= 0) player.sprintLocked = true;
    } else {
      player.staminaDelay = Math.max(0, player.staminaDelay - dt);
      if (player.staminaDelay <= 0) {
        player.stamina = Math.min(table.max, player.stamina + table.regen * dt);
      }
      if (player.sprintLocked && player.stamina >= table.unlockAt) player.sprintLocked = false;
    }

    // Wounded breathing is an audible tell the Hunter can home in on.
    if (player.role === 'runner' && woundIndex(player.wound) > 0) {
      player.breathTimer -= dt;
      if (player.breathTimer <= 0) {
        player.breathTimer = player.wound === 'cursed' ? 2.1 : 3.0;
        this.emitSound('breath', player.motion.x, player.motion.z, WOUND_BREATH_RADIUS[woundIndex(player.wound)], player.id);
      }
    }
  }

  private movementModifiers(player: PlayerRuntime): MovementModifiers {
    let scale = 1;
    if (player.role === 'runner') scale *= speedScaleForWound(player.wound);
    if (player.slowed > 0) scale *= player.slowFactor;
    if (player.hasted > 0) scale *= WARD.runnerHasteFactor;
    if (player.breachRecovery > 0) scale *= BREACH.recoverySlow;
    if (player.channel.kind !== 'none' && player.channel.kind !== 'snareEscape') scale *= 0.35;

    const lunge =
      player.bladePhase === 'active' && !player.bladeConsumed ? BLADE.lungeSpeed * TICK_DT * 6 : 0;

    return {
      speedScale: scale,
      rooted: player.rooted > 0,
      stunned: player.stunned > 0,
      forceCrouch: false,
      sprintLocked:
        player.sprintLocked ||
        player.channel.kind !== 'none' ||
        player.reloading > 0 ||
        player.bladePhase === 'windup',
      lunge,
    };
  }

  private consumeInputs(player: PlayerRuntime): void {
    const mods = this.movementModifiers(player);
    const before = { x: player.motion.x, z: player.motion.z };

    if (player.inputs.length === 0) {
      // No input this tick: keep physics alive so gravity and friction apply.
      const idle: InputCommand = {
        seq: player.ackSeq,
        dt: TICK_DT,
        mx: 0,
        mz: 0,
        yaw: player.motion.yaw,
        pitch: player.motion.pitch,
        sprint: false,
        crouch: player.motion.crouching,
        vault: false,
      };
      stepMovement(player.motion, idle, this.world, player.role, mods);
    } else {
      for (const cmd of player.inputs) {
        const step = stepMovement(player.motion, cmd, this.world, player.role, mods);
        if (step.vaulted) {
          this.emitSound('vault', player.motion.x, player.motion.z, 14, player.id);
        }
        player.ackSeq = cmd.seq;
      }
      player.inputs.length = 0;
    }

    const moved = Math.hypot(player.motion.x - before.x, player.motion.z - before.z);
    player.distance += moved;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  handleAction(playerId: string, action: ActionCommand): void {
    const player = this.players.get(playerId);
    if (!player || this.phase !== 'active') return;
    if (player.stunned > 0 && action.kind !== 'struggle') return;

    switch (action.kind) {
      case 'interact':
        player.interactHeld = true;
        break;
      case 'interactStop':
        // Keep the channel record so `decayChannel` can bleed the progress away
        // instead of freezing it at whatever the player reached.
        player.interactHeld = false;
        break;
      case 'primary':
        if (player.role === 'hunter') this.startBlade(player);
        else this.throwNoise(player);
        break;
      case 'secondary':
        if (player.role === 'hunter') this.fireCrossbow(player);
        else this.placeWard(player);
        break;
      case 'ability1':
        if (player.role === 'hunter') this.trackingPulse(player);
        else this.throwDecoy(player);
        break;
      case 'ability2':
        if (player.role === 'hunter') this.placeSnare(player);
        else this.deploySmoke(player);
        break;
      case 'reload':
        if (player.role === 'hunter') this.reload(player);
        break;
      case 'struggle':
        if (player.rooted > 0) player.rooted = Math.max(0, player.rooted - 0.18);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Hunter kit
  // -------------------------------------------------------------------------

  private startBlade(player: PlayerRuntime): void {
    if (player.cooldowns.blade > 0 || player.bladePhase !== 'idle') return;
    if (player.channel.kind !== 'none') return;
    player.bladePhase = 'windup';
    player.bladeTimer = BLADE.windup;
    player.bladeConsumed = false;
    player.cooldowns.blade = BLADE.windup + BLADE.active + BLADE.recovery + BLADE.cooldown;
    this.stats.bladeSwings += 1;
    this.emitSound('bladeWindup', player.motion.x, player.motion.z, 16, player.id);
  }

  private tickBlade(dt: number): void {
    const hunter = this.hunter;
    if (!hunter) return;
    if (hunter.bladePhase === 'idle') return;

    hunter.bladeTimer -= dt;
    if (hunter.bladePhase === 'windup' && hunter.bladeTimer <= 0) {
      hunter.bladePhase = 'active';
      hunter.bladeTimer = BLADE.active;
    } else if (hunter.bladePhase === 'active') {
      if (!hunter.bladeConsumed) this.resolveBladeHit(hunter);
      if (hunter.bladeTimer <= 0) {
        hunter.bladePhase = 'recovery';
        hunter.bladeTimer = BLADE.recovery;
        if (!hunter.bladeConsumed) {
          this.emitSound('bladeMiss', hunter.motion.x, hunter.motion.z, 13, hunter.id);
        }
      }
    } else if (hunter.bladePhase === 'recovery' && hunter.bladeTimer <= 0) {
      hunter.bladePhase = 'idle';
      hunter.bladeTimer = 0;
    }
  }

  private resolveBladeHit(hunter: PlayerRuntime): void {
    const runner = this.runner;
    if (!runner) return;

    const los = hasLineOfSight(
      this.world,
      hunter.motion.x,
      eyeHeight(hunter.motion),
      hunter.motion.z,
      runner.motion.x,
      eyeHeight(runner.motion),
      runner.motion.z,
    );

    const verdict = evaluateBladeHit({
      attackerX: hunter.motion.x,
      attackerZ: hunter.motion.z,
      attackerYaw: hunter.motion.yaw,
      targetX: runner.motion.x,
      targetZ: runner.motion.z,
      // Cooldown is already spent by startBlade; the swing itself is legal here.
      cooldownRemaining: 0,
      protectionRemaining: runner.protection,
      hasLineOfSight: los,
    });

    if (verdict !== 'ok') return;

    hunter.bladeConsumed = true;
    this.stats.bladeHits += 1;
    const outcome = applyWound(runner.wound);
    this.emitSound('bladeHit', runner.motion.x, runner.motion.z, 24, hunter.id);

    if (outcome.captured) {
      this.captured = true;
      const inChapel = Math.abs(runner.motion.x) < 16 && Math.abs(runner.motion.z - 2) < 12;
      this.contractProgress.capturedInChapel = inChapel;
      this.emitSound('capture', runner.motion.x, runner.motion.z, 999, hunter.id);
      this.pushBanner('The Runner has been taken.', 'bad');
      return;
    }

    runner.wound = outcome.wound;
    runner.protection = outcome.protectionRemaining;
    runner.channel = { kind: 'none', id: 0, progress: 0 };
    this.stats.woundsTaken += 1;
    this.emitSound('wound', runner.motion.x, runner.motion.z, 26, runner.id);
    this.pushBanner(
      runner.wound === 'cursed' ? 'The Runner is Cursed.' : 'The Runner is Wounded.',
      'bad',
    );
  }

  private fireCrossbow(player: PlayerRuntime): void {
    if (player.cooldowns.crossbow > 0 || player.reloading > 0 || player.bolts <= 0) return;
    if (player.bladePhase !== 'idle') return;
    player.bolts -= 1;
    player.cooldowns.crossbow = CROSSBOW.fireCooldown;
    this.stats.boltsFired += 1;

    const yaw = player.motion.yaw;
    const pitch = player.motion.pitch;
    const cosP = Math.cos(pitch);
    this.bolts.push({
      id: this.entityId++,
      x: player.motion.x + Math.sin(yaw) * 0.7,
      y: eyeHeight(player.motion) - 0.15,
      z: player.motion.z + Math.cos(yaw) * 0.7,
      vx: Math.sin(yaw) * cosP * CROSSBOW.projectileSpeed,
      vy: Math.sin(pitch) * CROSSBOW.projectileSpeed,
      vz: Math.cos(yaw) * cosP * CROSSBOW.projectileSpeed,
      landed: false,
      life: CROSSBOW.projectileLife,
    });
    this.emitSound('crossbowFire', player.motion.x, player.motion.z, 22, player.id);
  }

  private reload(player: PlayerRuntime): void {
    if (player.reloading > 0 || player.bolts >= CROSSBOW.maxBolts) return;
    player.reloading = CROSSBOW.reloadTime;
  }

  private trackingPulse(player: PlayerRuntime): void {
    if (player.cooldowns.pulse > 0) return;
    player.cooldowns.pulse = PULSE.cooldown;
    this.pulse = { x: player.motion.x, z: player.motion.z, radius: PULSE.radius, age: 0, owner: player.id };

    const traces: FootprintTrace[] = [];
    for (const print of this.footprints) {
      if (print.age > PULSE.maxTraceAge) continue;
      const dx = print.x - player.motion.x;
      const dz = print.z - player.motion.z;
      const dist = Math.hypot(dx, dz);
      const damping = pulseDampingAt(
        this.smokes,
        player.motion.x,
        player.motion.z,
        print.x,
        print.z,
        SMOKE.pulseDamping,
      );
      if (dist > PULSE.radius * damping) continue;
      traces.push({ ...print });
    }
    this.revealedTraces = traces;
    this.emitSound('pulse', player.motion.x, player.motion.z, 30, player.id);
  }

  private placeSnare(player: PlayerRuntime): void {
    if (player.cooldowns.snare > 0 || player.snareCharges <= 0) return;
    const active = this.snares.filter((s) => !s.triggered).length;
    if (active >= SNARE.maxActive) return;

    player.snareCharges -= 1;
    player.cooldowns.snare = SNARE.placeCooldown;
    this.stats.snaresPlaced += 1;
    this.contractProgress.snaresPlaced += 1;

    const yaw = player.motion.yaw;
    this.snares.push({
      id: this.entityId++,
      x: player.motion.x + Math.sin(yaw) * 1.2,
      z: player.motion.z + Math.cos(yaw) * 1.2,
      armed: false,
      triggered: false,
    });
    this.emitSound('snarePlace', player.motion.x, player.motion.z, 10, player.id);
  }

  // -------------------------------------------------------------------------
  // Runner kit
  // -------------------------------------------------------------------------

  private throwDecoy(player: PlayerRuntime): void {
    if (player.cooldowns.decoy > 0) return;
    player.cooldowns.decoy = DECOY.cooldown;
    this.stats.decoysUsed += 1;

    const yaw = player.motion.yaw;
    this.decoys.push({
      id: this.entityId++,
      x: player.motion.x + Math.sin(yaw) * 1.4,
      z: player.motion.z + Math.cos(yaw) * 1.4,
      yaw,
      expiresIn: DECOY.lifetime,
      vx: Math.sin(yaw) * DECOY.speed,
      vz: Math.cos(yaw) * DECOY.speed,
      stepTimer: 0,
    });
  }

  private deploySmoke(player: PlayerRuntime): void {
    if (player.cooldowns.smoke > 0) return;
    player.cooldowns.smoke = SMOKE.cooldown;
    this.stats.smokesUsed += 1;
    this.smokes.push({
      id: this.entityId++,
      x: player.motion.x,
      z: player.motion.z,
      radius: SMOKE.radius,
      expiresIn: SMOKE.lifetime,
    });
    this.emitSound('smokeDeploy', player.motion.x, player.motion.z, 18, player.id);
  }

  private placeWard(player: PlayerRuntime): void {
    if (player.cooldowns.ward > 0 || player.wardCharges <= 0) return;
    player.cooldowns.ward = WARD.cooldown;
    player.wardCharges -= 1;
    const yaw = player.motion.yaw;
    this.wards.push({
      id: this.entityId++,
      x: player.motion.x + Math.sin(yaw) * 1.1,
      z: player.motion.z + Math.cos(yaw) * 1.1,
      armed: false,
      triggered: false,
    });
  }

  private throwNoise(player: PlayerRuntime): void {
    if (player.cooldowns.throw > 0) return;
    player.cooldowns.throw = 3.2;
    const yaw = player.motion.yaw;
    // A thrown stone makes noise where it lands, not where the Runner stands.
    const dist = 13;
    const x = player.motion.x + Math.sin(yaw) * dist;
    const z = player.motion.z + Math.cos(yaw) * dist;
    this.emitSound('charmRattle', x, z, 26, null);
  }

  // -------------------------------------------------------------------------
  // Entity ticks
  // -------------------------------------------------------------------------

  private tickDecoys(dt: number): void {
    for (let i = this.decoys.length - 1; i >= 0; i -= 1) {
      const decoy = this.decoys[i];
      decoy.expiresIn -= dt;
      if (decoy.expiresIn <= 0) {
        this.decoys.splice(i, 1);
        continue;
      }

      const nextX = decoy.x + decoy.vx * dt;
      const nextZ = decoy.z + decoy.vz * dt;
      // Bounce off geometry so the decoy keeps moving instead of grinding a wall.
      const clear = hasLineOfSight(this.world, decoy.x, 1.0, decoy.z, nextX, 1.0, nextZ);
      if (clear) {
        decoy.x = nextX;
        decoy.z = nextZ;
      } else {
        const turn = this.rng.range(2.1, 4.2);
        const cos = Math.cos(turn);
        const sin = Math.sin(turn);
        const vx = decoy.vx * cos - decoy.vz * sin;
        const vz = decoy.vx * sin + decoy.vz * cos;
        decoy.vx = vx;
        decoy.vz = vz;
        decoy.yaw = Math.atan2(vx, vz);
      }

      decoy.stepTimer -= dt;
      if (decoy.stepTimer <= 0) {
        decoy.stepTimer = DECOY.stepInterval;
        this.emitSound('decoyStep', decoy.x, decoy.z, DECOY.noiseRadius, null);
        this.addFootprint(decoy.x, decoy.z, decoy.yaw, 'runner');
      }

      // A decoy can spring the Hunter's own snare — one of the Runner contracts.
      for (const snare of this.snares) {
        if (snare.triggered || !snare.armed) continue;
        if (Math.hypot(decoy.x - snare.x, decoy.z - snare.z) <= SNARE.radius) {
          snare.triggered = true;
          this.contractProgress.decoyTriggeredSnare = true;
          this.stats.snaresTriggered += 1;
          this.emitSound('snareTrigger', snare.x, snare.z, 30, null);
          this.pushBanner('A snare snapped shut on nothing.', 'neutral');
        }
      }
    }
  }

  private tickSmokes(dt: number): void {
    for (let i = this.smokes.length - 1; i >= 0; i -= 1) {
      this.smokes[i].expiresIn -= dt;
      if (this.smokes[i].expiresIn <= 0) this.smokes.splice(i, 1);
    }
  }

  private tickBolts(dt: number): void {
    const runner = this.runner;
    const hunter = this.hunter;

    for (let i = this.bolts.length - 1; i >= 0; i -= 1) {
      const bolt = this.bolts[i];
      if (bolt.landed) {
        bolt.life -= dt;
        if (bolt.life <= 0) {
          this.bolts.splice(i, 1);
          continue;
        }
        // Spent bolts can be walked over and recovered.
        for (const player of this.players.values()) {
          const d = Math.hypot(player.motion.x - bolt.x, player.motion.z - bolt.z);
          if (d > CROSSBOW.pickupRadius) continue;
          if (player.role === 'hunter') {
            player.bolts = Math.min(CROSSBOW.maxBolts, player.bolts + 1);
            this.bolts.splice(i, 1);
          } else {
            player.carriesBolt = true;
            this.bolts.splice(i, 1);
          }
          break;
        }
        continue;
      }

      bolt.life -= dt;
      const prevX = bolt.x;
      const prevY = bolt.y;
      const prevZ = bolt.z;
      bolt.vy -= 9.2 * dt;
      bolt.x += bolt.vx * dt;
      bolt.y += bolt.vy * dt;
      bolt.z += bolt.vz * dt;

      let stop = false;

      if (runner) {
        const d = Math.hypot(bolt.x - runner.motion.x, bolt.z - runner.motion.z);
        const withinHeight =
          bolt.y > runner.motion.y - 0.2 && bolt.y < runner.motion.y + (runner.motion.crouching ? 1.2 : 1.9);
        if (d < CROSSBOW.projectileRadius + 0.5 && withinHeight) {
          runner.marked = CROSSBOW.markDuration;
          runner.slowed = CROSSBOW.slowDuration;
          runner.slowFactor = CROSSBOW.slowFactor;
          this.stats.boltsHit += 1;
          this.contractProgress.marksLanded += 1;
          this.emitSound('boltImpact', bolt.x, bolt.z, 20, null);
          this.pushBanner('The Runner is marked.', 'bad');
          this.bolts.splice(i, 1);
          continue;
        }
      }

      const floor = floorHeightAt(this.map, bolt.x, bolt.z);
      if (bolt.y <= floor + 0.05) {
        bolt.y = floor + 0.05;
        stop = true;
      } else if (!hasLineOfSight(this.world, prevX, prevY, prevZ, bolt.x, bolt.y, bolt.z)) {
        bolt.x = prevX;
        bolt.y = prevY;
        bolt.z = prevZ;
        stop = true;
      }

      if (stop) {
        bolt.landed = true;
        bolt.vx = 0;
        bolt.vy = 0;
        bolt.vz = 0;
        // Spent bolts persist long enough to be worth walking back for.
        bolt.life = 45;
        this.emitSound('boltImpact', bolt.x, bolt.z, 16, null);
      } else if (bolt.life <= 0) {
        this.bolts.splice(i, 1);
      }
    }

    // Auto-start a reload so the Hunter is never softlocked without ammo.
    // Pressing R just starts the same reload sooner.
    if (hunter && hunter.bolts <= 0 && hunter.reloading <= 0) {
      hunter.reloading = CROSSBOW.reloadTime;
    }
  }

  private tickTraps(dt: number): void {
    const runner = this.runner;
    const hunter = this.hunter;

    for (let i = this.snares.length - 1; i >= 0; i -= 1) {
      const snare = this.snares[i];
      if (snare.triggered) continue;
      if (!snare.armed) {
        snare.armed = true;
        continue;
      }
      if (!runner) continue;
      if (Math.hypot(runner.motion.x - snare.x, runner.motion.z - snare.z) > SNARE.radius) continue;
      if (!runner.motion.grounded) continue;

      snare.triggered = true;
      runner.rooted = SNARE.rootDuration;
      runner.slowed = SNARE.slowDuration;
      runner.slowFactor = SNARE.slowFactor;
      runner.channel = { kind: 'none', id: 0, progress: 0 };
      this.stats.snaresTriggered += 1;
      this.emitSound('snareTrigger', snare.x, snare.z, 34, null);
      this.pushBanner('A snare has caught the Runner.', 'bad');
    }

    for (const ward of this.wards) {
      if (ward.triggered) continue;
      if (!ward.armed) {
        ward.armed = true;
        continue;
      }
      if (!hunter || !runner) continue;
      if (Math.hypot(hunter.motion.x - ward.x, hunter.motion.z - ward.z) > WARD.radius) continue;
      if (hunter.stunImmunity > 0) continue;

      ward.triggered = true;
      hunter.stunned = WARD.stunDuration;
      hunter.stunImmunity = WARD.stunImmunity;
      hunter.bladePhase = 'idle';
      hunter.bladeTimer = 0;
      hunter.channel = { kind: 'none', id: 0, progress: 0 };
      runner.hasted = WARD.runnerHasteDuration;
      this.stats.wardsTriggered += 1;
      this.emitSound('wardTrigger', ward.x, ward.z, 34, null);
      this.pushBanner('A Flash Ward detonates.', 'neutral');
    }

    // Clean up long-dead trap markers so entity arrays cannot grow unbounded.
    if (this.snares.length > 12) this.snares.splice(0, this.snares.length - 12);
    if (this.wards.length > 8) this.wards.splice(0, this.wards.length - 8);
    void dt;
  }

  private tickDoors(dt: number): void {
    let changed = false;
    for (const door of this.doors) {
      if (Math.abs(door.open - door.target) < 1e-3) continue;
      const before = door.open >= 0.5;
      const speed = door.target > door.open ? 1.1 : 1.6;
      door.open += Math.sign(door.target - door.open) * speed * dt;
      door.open = Math.max(0, Math.min(1, door.open));
      if (before !== door.open >= 0.5) changed = true;
    }
    if (changed) this.rebuildDynamicBlockers();
  }

  private tickFootprints(dt: number): void {
    for (let i = this.footprints.length - 1; i >= 0; i -= 1) {
      this.footprints[i].age += dt;
      if (this.footprints[i].age > FOOTPRINT_LIFETIME) this.footprints.splice(i, 1);
    }
    for (const trace of this.revealedTraces) trace.age += dt;
  }

  private tickPulse(dt: number): void {
    if (!this.pulse) return;
    this.pulse.age += dt;
    if (this.pulse.age > PULSE.duration) {
      this.pulse = null;
      this.revealedTraces = [];
    }
  }

  private tickBanners(dt: number): void {
    for (let i = this.banners.length - 1; i >= 0; i -= 1) {
      this.banners[i].life -= dt;
      if (this.banners[i].life <= 0) this.banners.splice(i, 1);
    }
  }

  private tickStats(dt: number): void {
    const runner = this.runner;
    const hunter = this.hunter;
    if (runner) this.stats.distanceRunner = runner.distance;
    if (hunter) this.stats.distanceHunter = hunter.distance;
    if (runner && hunter) {
      const d = Math.hypot(runner.motion.x - hunter.motion.x, runner.motion.z - hunter.motion.z);
      if (d < this.stats.closestApproach) this.stats.closestApproach = d;
      const conceal = concealmentState(this.world, runner.motion, this.smokes);
      if (conceal.concealed) {
        runner.hiddenTime += dt;
        this.stats.timeSpentHidden = runner.hiddenTime;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Footsteps and traces
  // -------------------------------------------------------------------------

  private tickFootsteps(player: PlayerRuntime, dt: number): void {
    const speed = player.motion.speed;
    if (!player.motion.grounded || speed < 0.6) {
      player.footstepTimer = 0;
      return;
    }

    const gait = player.motion.crouching ? 'crouch' : player.motion.sprinting ? 'sprint' : 'walk';
    player.footstepTimer -= dt;
    if (player.footstepTimer > 0) return;
    player.footstepTimer = FOOTSTEP_INTERVAL[gait];

    const surface = surfaceAt(this.map, player.motion.x, player.motion.z);
    const kind: SoundKind =
      surface === 'water'
        ? 'footstepWater'
        : surface === 'grass'
          ? 'footstepGrass'
          : surface === 'dirt'
            ? 'footstepDirt'
            : 'footstepStone';

    // Water is loud no matter how carefully you move — a real risk to cross.
    const radius = FOOTSTEP_NOISE_RADIUS[gait] * (surface === 'water' ? 1.5 : 1);
    this.emitSound(kind, player.motion.x, player.motion.z, radius, player.id);

    if (surface === 'dirt' || surface === 'grass') {
      player.footprintFoot = player.footprintFoot === 0 ? 1 : 0;
      this.addFootprint(player.motion.x, player.motion.z, player.motion.yaw, player.role, player.footprintFoot);
    }
  }

  private addFootprint(x: number, z: number, yaw: number, role: Role, foot: 0 | 1 = 0): void {
    this.footprints.push({ id: this.entityId++, x, z, yaw, age: 0, role, foot });
    if (this.footprints.length > MAX_FOOTPRINTS) {
      this.footprints.splice(0, this.footprints.length - MAX_FOOTPRINTS);
    }
  }

  private emitSound(
    kind: SoundKind,
    x: number,
    z: number,
    radius: number,
    sourcePlayerId: string | null,
  ): void {
    const seq = this.soundSeq++;
    for (const listener of this.players.values()) {
      const own = listener.id === sourcePlayerId;
      const dist = Math.hypot(listener.motion.x - x, listener.motion.z - z);
      if (!own && dist > radius) continue;
      const volume = own ? 1 : Math.max(0, 1 - dist / Math.max(radius, 0.001)) ** 1.4;
      if (!own && volume < 0.03) continue;
      listener.sounds.push({ kind, x, z, volume, own, seq });
      if (listener.sounds.length > 24) listener.sounds.shift();
    }
  }

  private pushBanner(text: string, tone: 'good' | 'bad' | 'neutral'): void {
    this.banners.push({ id: this.bannerId++, text, tone, life: 4 });
  }

  // -------------------------------------------------------------------------
  // Interaction / channels
  // -------------------------------------------------------------------------

  private tickChannel(player: PlayerRuntime, dt: number): void {
    const prompt = this.resolvePrompt(player);
    player.prompt = prompt;

    if (!player.interactHeld || prompt.kind === 'none' || prompt.blocked) {
      this.decayChannel(player, dt);
      return;
    }

    // Switching target resets the channel.
    if (player.channel.kind !== prompt.kind || player.channel.id !== prompt.id) {
      player.channel = { kind: prompt.kind as ChannelKind, id: prompt.id, progress: 0 };
    }

    switch (prompt.kind) {
      case 'seal':
        this.channelSeal(player, dt);
        break;
      case 'gate':
        this.channelGate(player, dt);
        break;
      case 'shrine':
        this.channelShrine(player, dt);
        break;
      case 'snareEscape':
        this.channelSnareEscape(player, dt);
        break;
      case 'barricade':
        this.channelBreach(player, dt);
        break;
      case 'door':
        this.channelDoor(player, dt);
        break;
      case 'hideSpot':
      case 'boltPickup':
      case 'noiseObject':
        this.channelInstant(player, prompt.kind, prompt.id);
        break;
      default:
        break;
    }
    player.prompt = { ...player.prompt, progress: player.channel.progress };
  }

  private decayChannel(player: PlayerRuntime, dt: number): void {
    if (player.channel.kind === 'none') return;
    const rate =
      player.channel.kind === 'seal'
        ? SEAL_DECAY_RATE
        : player.channel.kind === 'gate'
          ? GATE_DECAY_RATE
          : SHRINE_DECAY_RATE;
    player.channel.progress = Math.max(0, player.channel.progress - rate * dt);

    if (player.channel.kind === 'seal') {
      const seal = this.seals.find((s) => s.id === player.channel.id);
      if (seal && !seal.active) seal.progress = player.channel.progress;
    } else if (player.channel.kind === 'gate') {
      this.gateProgress = player.channel.progress;
    } else if (player.channel.kind === 'shrine') {
      this.shrineProgress = player.channel.progress;
    }

    if (player.channel.progress <= 0) player.channel = { kind: 'none', id: 0, progress: 0 };
  }

  private channelSeal(player: PlayerRuntime, dt: number): void {
    const seal = this.seals.find((s) => s.id === player.channel.id);
    if (!seal || seal.active) return;
    if (player.channel.progress === 0) {
      this.emitSound('sealStart', seal.x, seal.z, 20, player.id);
    }
    const rate = channelScaleForWound(player.wound) / SEAL_CHANNEL_TIME;
    player.channel.progress = Math.min(1, player.channel.progress + rate * dt);
    seal.progress = player.channel.progress;

    if (player.channel.progress >= 1) {
      seal.active = true;
      seal.progress = 1;
      this.stats.sealsActivated += 1;
      if (player.wound === 'cursed') this.contractProgress.sealsLitWhileCursed += 1;
      player.channel = { kind: 'none', id: 0, progress: 0 };
      // The bell is heard everywhere: the Hunter always knows a seal just lit.
      this.emitSound('sealDone', seal.x, seal.z, 999, null);
      const lit = countActiveSeals(this.seals);
      this.pushBanner(`Seal ${lit} of ${SEALS_REQUIRED} burns — ${seal.area}.`, lit >= SEALS_REQUIRED ? 'good' : 'neutral');
      if (lit >= SEALS_REQUIRED) {
        this.gateOpen = true;
        this.contractProgress.allSealsLit = true;
        this.emitSound('gateOpen', this.map.gate.x, this.map.gate.z, 999, null);
        this.pushBanner('The gate has opened.', 'good');
      }
    }
  }

  private channelGate(player: PlayerRuntime, dt: number): void {
    if (!this.gateOpen) return;
    const rate = channelScaleForWound(player.wound) / GATE_CHANNEL_TIME;
    player.channel.progress = Math.min(1, player.channel.progress + rate * dt);
    this.gateProgress = player.channel.progress;
    if (player.channel.progress >= 1) {
      this.escaped = true;
      if (player.carriesBolt) this.contractProgress.boltCarriedToGate = true;
    }
  }

  private channelShrine(player: PlayerRuntime, dt: number): void {
    if (player.healUsed || woundIndex(player.wound) === 0) return;
    if (player.channel.progress === 0) {
      this.emitSound('shrineStart', this.map.shrine.x, this.map.shrine.z, 30, player.id);
    }
    player.channel.progress = Math.min(1, player.channel.progress + dt / SHRINE_CHANNEL_TIME);
    this.shrineProgress = player.channel.progress;
    if (player.channel.progress >= 1) {
      player.wound = previousWound(player.wound);
      player.healUsed = true;
      this.stats.healed = true;
      this.contractProgress.healed = true;
      player.channel = { kind: 'none', id: 0, progress: 0 };
      this.shrineProgress = 0;
      this.emitSound('shrineDone', this.map.shrine.x, this.map.shrine.z, 40, null);
      this.pushBanner('The shrine has taken a wound.', 'good');
    }
  }

  private channelSnareEscape(player: PlayerRuntime, dt: number): void {
    player.channel.progress = Math.min(1, player.channel.progress + dt / SNARE.escapeChannel);
    if (player.channel.progress >= 1) {
      player.rooted = 0;
      player.channel = { kind: 'none', id: 0, progress: 0 };
    }
  }

  private channelBreach(player: PlayerRuntime, dt: number): void {
    const barricade = this.barricades.find((bar) => bar.id === player.channel.id);
    if (!barricade || barricade.broken) return;
    player.channel.progress = Math.min(1, player.channel.progress + dt / BREACH.channel);
    if (player.channel.progress >= 1) {
      barricade.broken = true;
      player.cooldowns.breach = BREACH.cooldown;
      player.breachRecovery = BREACH.recoveryDuration;
      player.channel = { kind: 'none', id: 0, progress: 0 };
      player.interactHeld = false;
      this.stats.breaches += 1;
      this.rebuildDynamicBlockers();
      this.emitSound('breach', barricade.x, barricade.z, 60, player.id);
      this.pushBanner('A barricade has been broken.', 'neutral');
    }
  }

  private channelDoor(player: PlayerRuntime, dt: number): void {
    const door = this.doors.find((d) => d.id === player.channel.id);
    if (!door) return;
    // Barging through at a sprint slams the door: fast, but very loud.
    if (player.motion.sprinting) {
      door.target = door.open >= 0.5 ? 0 : 1;
      door.open = door.target;
      door.disturbed = true;
      player.channel = { kind: 'none', id: 0, progress: 0 };
      player.interactHeld = false;
      this.rebuildDynamicBlockers();
      this.emitSound('doorSlam', door.x, door.z, 42, player.id);
      return;
    }
    player.channel.progress = Math.min(1, player.channel.progress + dt / 1.1);
    if (player.channel.progress >= 1) {
      door.target = door.target >= 0.5 ? 0 : 1;
      door.disturbed = true;
      player.channel = { kind: 'none', id: 0, progress: 0 };
      player.interactHeld = false;
      this.emitSound('doorCreak', door.x, door.z, 12, player.id);
    }
  }

  private channelInstant(player: PlayerRuntime, kind: string, id: number): void {
    player.channel = { kind: 'none', id: 0, progress: 0 };
    player.interactHeld = false;
    if (kind === 'noiseObject') {
      const obj = this.map.noiseObjects.find((n) => n.id === id);
      if (obj) this.emitSound('charmRattle', obj.x, obj.z, 30, player.id);
    } else if (kind === 'boltPickup') {
      const index = this.bolts.findIndex((b) => b.id === id);
      if (index >= 0) {
        if (player.role === 'hunter') player.bolts = Math.min(CROSSBOW.maxBolts, player.bolts + 1);
        else player.carriesBolt = true;
        this.bolts.splice(index, 1);
      }
    }
  }

  /** Picks the single best thing this player can interact with right now. */
  private resolvePrompt(player: PlayerRuntime): InteractPrompt {
    const m = player.motion;
    const eye = eyeHeight(m);

    if (player.role === 'runner' && player.rooted > 0) {
      return {
        kind: 'snareEscape',
        id: 0,
        label: 'Break free',
        progress: player.channel.kind === 'snareEscape' ? player.channel.progress : 0,
        blocked: false,
        blockedReason: '',
      };
    }

    let best: InteractPrompt | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    const consider = (
      kind: InteractPrompt['kind'],
      id: number,
      label: string,
      x: number,
      z: number,
      range: number,
      blocked = false,
      blockedReason = '',
      targetY = 1.0,
    ): void => {
      const dist = Math.hypot(m.x - x, m.z - z);
      if (dist > range || dist >= bestDist) return;
      if (!canReach(this.world, m.x, eye, m.z, x, targetY, z, range)) return;
      bestDist = dist;
      best = {
        kind,
        id,
        label,
        progress: player.channel.kind === kind && player.channel.id === id ? player.channel.progress : 0,
        blocked,
        blockedReason,
      };
    };

    if (player.role === 'runner') {
      for (const seal of this.seals) {
        if (seal.active) continue;
        consider('seal', seal.id, `Channel the seal — ${seal.area}`, seal.x, seal.z, SEAL_INTERACT_RANGE);
      }
      const litCount = countActiveSeals(this.seals);
      consider(
        'gate',
        0,
        this.gateOpen ? 'Escape through the gate' : 'The gate is sealed',
        this.map.gate.x,
        this.map.gate.z,
        GATE_INTERACT_RANGE,
        !this.gateOpen,
        `${SEALS_REQUIRED - litCount} seal${SEALS_REQUIRED - litCount === 1 ? '' : 's'} remaining`,
      );
      if (woundIndex(player.wound) > 0 && !player.healUsed) {
        consider('shrine', 0, 'Mend at the shrine', this.map.shrine.x, this.map.shrine.z, SHRINE_INTERACT_RANGE);
      }
      const spot = hideSpotAt(this.map, m.x, m.z);
      if (spot >= 0) {
        const hs = this.map.hideSpots.find((h) => h.id === spot);
        if (hs) consider('hideSpot', hs.id, 'Hidden', hs.x, hs.z, 1.2);
      }
    } else {
      for (const barricade of this.barricades) {
        if (barricade.broken) continue;
        consider(
          'barricade',
          barricade.id,
          'Breach the barricade',
          barricade.x,
          barricade.z,
          BREACH.range,
          player.cooldowns.breach > 0,
          'Breach recharging',
        );
      }
    }

    for (const door of this.doors) {
      consider(
        'door',
        door.id,
        door.open >= 0.5 ? 'Close the door' : 'Open the door',
        door.x + Math.cos(door.rot) * door.width * 0.5,
        door.z + Math.sin(door.rot) * door.width * 0.5,
        2.4,
      );
    }
    for (const bolt of this.bolts) {
      if (!bolt.landed) continue;
      consider('boltPickup', bolt.id, 'Recover bolt', bolt.x, bolt.z, CROSSBOW.pickupRadius, false, '', bolt.y);
    }
    for (const obj of this.map.noiseObjects) {
      consider('noiseObject', obj.id, 'Rattle the charms', obj.x, obj.z, 2.2, false, '', 2.4);
    }

    return best ?? { ...EMPTY_PROMPT };
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  buildSnapshot(playerId: string): WorldSnapshot | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    const opponent = this.other(player);

    const conceal = concealmentState(this.world, player.motion, this.smokes);
    const isHunter = player.role === 'hunter';

    let opponentView: OpponentView = {
      visible: false,
      transform: null,
      markedTrail: null,
      crouching: false,
      sprinting: false,
      wound: 'unmarked',
      speed: 0,
    };

    if (opponent) {
      const visible = canPerceive({
        world: this.world,
        observer: player.motion,
        target: opponent.motion,
        targetIsRunner: opponent.role === 'runner',
        smokes: this.smokes,
      });

      // Marked Runners leave a coarse trail: direction, not a pinpoint.
      let trail: OpponentView['markedTrail'] = null;
      if (isHunter && opponent.role === 'runner' && opponent.marked > 0) {
        const strength = opponent.marked / CROSSBOW.markDuration;
        const grid = 3.5;
        trail = {
          x: Math.round(opponent.motion.x / grid) * grid,
          z: Math.round(opponent.motion.z / grid) * grid,
          strength,
        };
      }

      opponentView = {
        visible,
        transform: visible
          ? {
              x: opponent.motion.x,
              y: opponent.motion.y,
              z: opponent.motion.z,
              yaw: opponent.motion.yaw,
              pitch: opponent.motion.pitch,
            }
          : null,
        markedTrail: trail,
        crouching: visible ? opponent.motion.crouching : false,
        sprinting: visible ? opponent.motion.sprinting : false,
        wound: visible || (isHunter && opponent.marked > 0) ? opponent.wound : 'unmarked',
        speed: visible ? opponent.motion.speed : 0,
      };
    }

    // Dread rises as the Hunter closes in; it carries no direction, so it
    // pressures the Runner without giving the position away.
    let dread = 0;
    if (player.role === 'runner' && opponent) {
      const d = Math.hypot(player.motion.x - opponent.motion.x, player.motion.z - opponent.motion.z);
      dread = Math.max(0, 1 - d / HEARTBEAT_RANGE);
    }

    const self: SelfState = {
      role: player.role,
      transform: { ...player.motion },
      ackSeq: player.ackSeq,
      stamina: player.stamina,
      staminaLocked: player.sprintLocked,
      wound: player.wound,
      protectionRemaining: player.protection,
      cooldowns: { ...player.cooldowns },
      charges: {
        bolts: player.bolts,
        snares: player.snareCharges,
        wards: player.wardCharges,
      },
      prompt: player.prompt,
      status: {
        rooted: player.rooted,
        stunned: player.stunned,
        slowed: player.slowed,
        hasted: player.hasted,
        marked: player.marked,
        breaching: player.channel.kind === 'breach' ? player.channel.progress : 0,
        channeling: player.channel.kind !== 'none' ? player.channel.progress : 0,
        hidden: conceal.hidden,
        inSmoke: conceal.inSmoke,
        concealed: conceal.concealed,
        healUsed: player.healUsed,
      },
      bladePhase: player.bladePhase,
      bladePhaseRemaining: player.bladeTimer,
      bolts: player.bolts,
      reloading: player.reloading,
      dread,
    };

    const sounds = player.sounds.slice();
    player.sounds.length = 0;

    // Seal channel progress is public: both players see the ritual advancing.
    const seals: SealState[] = this.seals.map((s) => ({ ...s }));

    const snapshot: WorldSnapshot = {
      tick: this.tickCount,
      serverTime: Date.now(),
      phase: this.phase === 'countdown' ? 'countdown' : this.phase === 'active' ? 'active' : 'results',
      timeRemaining: this.timeRemaining,
      phaseRemaining: Math.max(0, this.phaseTimer),
      seals,
      sealsActivated: countActiveSeals(this.seals),
      gateOpen: this.gateOpen,
      gateProgress: this.gateProgress,
      shrineProgress: this.shrineProgress,
      // Decoys are visible to the Hunter (that is the point) and to the Runner
      // who threw them, so both see the deception play out.
      decoys: this.decoys.map((d) => ({ id: d.id, x: d.x, z: d.z, yaw: d.yaw, expiresIn: d.expiresIn })),
      smokes: this.smokes.map((s) => ({ ...s })),
      // The Runner sees their own wards; the Hunter only sees a ward once it fires.
      wards: this.wards
        .filter((w) => player.role === 'runner' || w.triggered)
        .map((w) => ({ ...w })),
      // The Hunter sees their own snares; the Runner must spot them in-world.
      snares: this.snares
        .filter((s) => player.role === 'hunter' || s.triggered)
        .map((s) => ({ ...s })),
      bolts: this.bolts.map((b) => ({ ...b })),
      doors: this.doors.map((d) => ({ id: d.id, open: d.open, disturbed: d.disturbed })),
      barricades: this.barricades.map((b) => ({ id: b.id, broken: b.broken })),
      revealedTraces: isHunter ? this.revealedTraces.map((t) => ({ ...t })) : [],
      pulse: isHunter && this.pulse ? { x: this.pulse.x, z: this.pulse.z, radius: this.pulse.radius, age: this.pulse.age } : null,
      self,
      opponent: opponentView,
      sounds,
      banners: this.banners.map((b) => ({ id: b.id, text: b.text, tone: b.tone })),
      fogBoost: 1 - this.timeRemaining / MATCH_DURATION,
    };

    return snapshot;
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  private finish(): void {
    if (this.phase === 'finished') return;
    this.phase = 'finished';

    const verdict = evaluateVictory({
      runnerEscaped: this.escaped,
      runnerCaptured: this.captured,
      timeRemaining: this.timeRemaining,
      abandonedBy: this.abandonedBy,
    });

    if (this.stats.closestApproach === Number.POSITIVE_INFINITY) this.stats.closestApproach = 0;

    const contracts = assignContracts(this.seed, this.round);
    const hunter = this.hunter;
    const runner = this.runner;

    this.result = {
      outcome: verdict.outcome ?? 'abandoned',
      winner: verdict.winner,
      reason: verdict.reason,
      stats: { ...this.stats },
      contracts: {
        hunter: {
          contract: contracts.hunter,
          complete: evaluateContract(contracts.hunter, this.contractProgress, this.stats, verdict.winner),
        },
        runner: {
          contract: contracts.runner,
          complete: evaluateContract(contracts.runner, this.contractProgress, this.stats, verdict.winner),
        },
      },
      hunterName: hunter?.name ?? 'Hunter',
      runnerName: runner?.name ?? 'Runner',
    };
  }

  // -------------------------------------------------------------------------
  // Bot support
  // -------------------------------------------------------------------------

  /** Read-only world view the development bot steers with. */
  getBotContext(botId: string): {
    self: PlayerMotion;
    role: Role;
    seals: SealState[];
    gateOpen: boolean;
    gate: { x: number; z: number };
    opponentGuess: { x: number; z: number } | null;
    wound: WoundLevel;
    rooted: number;
    prompt: InteractPrompt;
    cooldowns: Record<string, number>;
  } | null {
    const player = this.players.get(botId);
    if (!player) return null;
    const opponent = this.other(player);
    const visible =
      opponent &&
      canPerceive({
        world: this.world,
        observer: player.motion,
        target: opponent.motion,
        targetIsRunner: opponent.role === 'runner',
        smokes: this.smokes,
      });
    return {
      self: player.motion,
      role: player.role,
      seals: this.seals.map((s) => ({ ...s })),
      gateOpen: this.gateOpen,
      gate: { x: this.map.gate.x, z: this.map.gate.z },
      opponentGuess: visible && opponent ? { x: opponent.motion.x, z: opponent.motion.z } : null,
      wound: player.wound,
      rooted: player.rooted,
      prompt: player.prompt,
      cooldowns: { ...player.cooldowns },
    };
  }

  /** Test-only: forces state so end conditions can be exercised deterministically. */
  debugForce(command: { kind: string; value?: number }): void {
    switch (command.kind) {
      case 'activateAllSeals':
        for (const seal of this.seals) {
          seal.active = true;
          seal.progress = 1;
        }
        this.stats.sealsActivated = this.seals.length;
        this.gateOpen = true;
        this.contractProgress.allSealsLit = true;
        break;
      case 'setTimeRemaining':
        this.timeRemaining = Math.max(0, command.value ?? 0);
        break;
      case 'skipCountdown':
        this.phaseTimer = 0;
        this.phase = 'active';
        break;
      case 'woundRunner': {
        const runner = this.runner;
        if (runner) {
          const applied = applyWound(runner.wound);
          if (applied.captured) this.captured = true;
          else {
            runner.wound = applied.wound;
            runner.protection = 0;
          }
        }
        break;
      }
      case 'teleportRunnerToGate': {
        const runner = this.runner;
        if (runner) {
          runner.motion.x = this.map.gate.x;
          runner.motion.z = this.map.gate.z + 2;
          runner.motion.vx = 0;
          runner.motion.vz = 0;
        }
        break;
      }
      case 'teleportRunnerToSeal': {
        const runner = this.runner;
        const seal = this.seals.find((s) => !s.active) ?? this.seals[0];
        if (runner && seal) {
          runner.motion.x = seal.x;
          runner.motion.z = seal.z + 1.2;
          runner.motion.vx = 0;
          runner.motion.vz = 0;
        }
        break;
      }
      case 'placeAdjacent': {
        // Puts the Hunter in blade range, facing the Runner, on open ground so
        // range/arc/line-of-sight are all satisfied.
        const runner = this.runner;
        const hunter = this.hunter;
        if (runner && hunter) {
          runner.motion.x = 16;
          runner.motion.z = 42;
          runner.motion.y = 0;
          runner.motion.vx = 0;
          runner.motion.vz = 0;
          hunter.motion.x = 16;
          hunter.motion.z = 42 - 1.8;
          hunter.motion.y = 0;
          hunter.motion.yaw = 0;
          hunter.motion.vx = 0;
          hunter.motion.vz = 0;
        }
        break;
      }
      case 'separatePlayers': {
        const runner = this.runner;
        const hunter = this.hunter;
        if (runner && hunter) {
          runner.motion.x = 52;
          runner.motion.z = 52;
          hunter.motion.x = -52;
          hunter.motion.z = -52;
          hunter.motion.yaw = Math.PI * 0.75;
        }
        break;
      }
      case 'clearProtection': {
        const runner = this.runner;
        if (runner) runner.protection = 0;
        break;
      }
      default:
        break;
    }
  }

  /** Test-only inspection of internals that are deliberately hidden in play. */
  debugState(): Record<string, unknown> {
    return {
      phase: this.phase,
      tick: this.tickCount,
      timeRemaining: this.timeRemaining,
      seals: this.seals.map((s) => ({ id: s.id, active: s.active, progress: s.progress })),
      gateOpen: this.gateOpen,
      gateProgress: this.gateProgress,
      captured: this.captured,
      escaped: this.escaped,
      entityCounts: {
        decoys: this.decoys.length,
        smokes: this.smokes.length,
        wards: this.wards.length,
        snares: this.snares.length,
        bolts: this.bolts.length,
        footprints: this.footprints.length,
        banners: this.banners.length,
      },
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        role: p.role,
        wound: p.wound,
        x: p.motion.x,
        y: p.motion.y,
        z: p.motion.z,
        cooldowns: { ...p.cooldowns },
      })),
    };
  }
}
