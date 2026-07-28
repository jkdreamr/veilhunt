/**
 * In-match controller.
 *
 * Owns the scene for one round: world, characters, markers, VFX, camera and the
 * prediction loop. It reads snapshots and local input, and writes to the
 * renderer, the audio system and the HUD. It never talks to sockets directly.
 */

import * as THREE from 'three';
import {
  BLADE,
  BREACH,
  CROSSBOW,
  DECOY,
  PULSE,
  SMOKE,
  SNARE,
  WARD,
  type WoundLevel,
} from '../shared/constants.js';
import type { CollisionWorld, DynamicBlocker } from '../shared/collision.js';
import { generateMap } from '../shared/mapgen.js';
import { createMotion, type MovementModifiers } from '../shared/movement.js';
import { speedScaleForWound } from '../shared/matchRules.js';
import type {
  ActionCommand,
  ActionKind,
  InputCommand,
  MapData,
  Role,
  SoundKind,
  WorldSnapshot,
} from '../shared/types.js';
import type {
  AudioSystem,
  CharacterRig,
  GameSettings,
  MarkerSystem,
  QualityLevel,
  VfxSystem,
} from './contracts.js';
import { CameraRig } from './core/CameraRig.js';
import type { RenderSystem } from './core/Renderer.js';
import type { InputSnapshot } from './core/Input.js';
import { Predictor } from './net/Predictor.js';
import { RemoteInterpolator } from './net/Interpolator.js';
import { buildWorld, type WorldExtras } from './world/WorldBuilder.js';
import { createCharacter } from './entities/Characters.js';
import { createMarkerSystem } from './entities/Markers.js';
import { createVfxSystem } from './systems/Vfx.js';

export interface SoundPing {
  angle: number;
  strength: number;
  kind: SoundKind;
  age: number;
}

export interface GameClientOptions {
  render: RenderSystem;
  audio: AudioSystem;
  settings: GameSettings;
  seed: number;
  role: Role;
  sendInput(commands: InputCommand[]): void;
  sendAction(action: ActionCommand): void;
  onNotice(text: string, tone: 'good' | 'bad' | 'neutral'): void;
}

/** Sounds that should also produce a visual indicator for low-volume play. */
const INDICATOR_SOUNDS = new Set<SoundKind>([
  'footstepDirt',
  'footstepStone',
  'footstepWater',
  'footstepGrass',
  'decoyStep',
  'bladeWindup',
  'bladeHit',
  'bladeMiss',
  'crossbowFire',
  'boltImpact',
  'snareTrigger',
  'wardTrigger',
  'breach',
  'doorSlam',
  'doorCreak',
  'charmRattle',
  'vault',
  'breath',
  'smokeDeploy',
  'shrineStart',
]);

const COOLDOWN_TOTALS: Record<string, number> = {
  blade: BLADE.windup + BLADE.active + BLADE.recovery + BLADE.cooldown,
  crossbow: CROSSBOW.fireCooldown,
  pulse: PULSE.cooldown,
  snare: SNARE.placeCooldown,
  breach: BREACH.cooldown,
  decoy: DECOY.cooldown,
  smoke: SMOKE.cooldown,
  ward: WARD.cooldown,
  throw: 3.2,
};

export class GameClient {
  readonly map: MapData;
  readonly role: Role;

  private readonly world: WorldExtras;
  private readonly markers: MarkerSystem;
  private readonly vfx: VfxSystem;
  private readonly localRig: CharacterRig;
  private readonly remoteRig: CharacterRig;
  private readonly cameraRig: CameraRig;
  private readonly predictor: Predictor;
  private readonly interpolator = new RemoteInterpolator();
  private readonly collisionWorld: CollisionWorld;

  private snapshot: WorldSnapshot | null = null;
  private previous: WorldSnapshot | null = null;
  private elapsed = 0;
  private inputAccumulator = 0;
  private readonly soundPings: SoundPing[] = [];
  private lastSoundSeq = 0;
  private disposed = false;
  private settings: GameSettings;
  private hitStop = 0;
  private lastWound: WoundLevel = 'unmarked';
  private lastSealsActive = 0;
  private lastGateOpen = false;
  private readonly seenTriggeredWards = new Set<number>();
  private readonly seenTriggeredSnares = new Set<number>();
  private readonly cameraTmp = new THREE.Vector3();
  private readonly playerTmp = new THREE.Vector3();
  private lastReadyFlash: Record<string, boolean> = {};
  private aiming = false;

  constructor(private readonly options: GameClientOptions) {
    this.role = options.role;
    this.settings = options.settings;
    this.map = generateMap(options.seed);

    const quality: QualityLevel = options.settings.quality;
    this.world = buildWorld({ map: this.map, quality });
    this.markers = createMarkerSystem(this.map, quality);
    this.vfx = createVfxSystem(quality);

    this.localRig = createCharacter({ role: options.role, isLocal: true, quality });
    this.remoteRig = createCharacter({
      role: options.role === 'hunter' ? 'runner' : 'hunter',
      isLocal: false,
      quality,
    });
    this.remoteRig.setOpacity(0);

    const scene = options.render.scene;
    scene.fog = this.world.fog;
    scene.add(this.world.root);
    scene.add(this.markers.root);
    scene.add(this.vfx.root);
    scene.add(this.localRig.group);
    scene.add(this.remoteRig.group);

    this.collisionWorld = { map: this.map, dynamic: [] };
    this.rebuildDynamic([], []);

    const spawn = options.role === 'runner' ? this.map.runnerSpawn : this.map.hunterSpawn;
    const yaw = options.role === 'runner' ? Math.PI : 0;
    this.predictor = new Predictor(createMotion(spawn.x, spawn.z, yaw), options.role, this.collisionWorld);

    this.cameraRig = new CameraRig(options.render.camera);
    this.cameraRig.setReducedShake(options.settings.reducedShake);
    this.cameraRig.reset(spawn.x, 0, spawn.z, yaw, 0);

    options.render.installEnvironment();
    options.render.enablePostProcessing();
  }

  /** Initial camera yaw so the player starts facing into the map. */
  get initialYaw(): number {
    return this.role === 'runner' ? Math.PI : 0;
  }

  applySettings(settings: GameSettings): void {
    this.settings = settings;
    this.cameraRig.setReducedShake(settings.reducedShake);
  }

  // -------------------------------------------------------------------------
  // Snapshot intake
  // -------------------------------------------------------------------------

  applySnapshot(snapshot: WorldSnapshot): void {
    if (this.disposed) return;
    this.previous = this.snapshot;
    this.snapshot = snapshot;

    this.predictor.reconcile(snapshot.self, this.movementModifiers());

    this.interpolator.push(
      snapshot.opponent.transform,
      snapshot.opponent.crouching,
      snapshot.opponent.sprinting,
      snapshot.opponent.speed,
    );

    this.rebuildDynamic(snapshot.doors, snapshot.barricades);
    this.consumeSounds(snapshot);
    this.detectEvents(snapshot);
  }

  private rebuildDynamic(
    doors: { id: number; open: number }[],
    barricades: { id: number; broken: boolean }[],
  ): void {
    const dynamic: DynamicBlocker[] = [];
    const openById = new Map(doors.map((d) => [d.id, d.open]));
    for (const door of this.map.doors) {
      const open = openById.get(door.id) ?? 0;
      this.world.setDoorOpen(door.id, open);
      if (open >= 0.5) continue;
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
    const brokenById = new Map(barricades.map((b) => [b.id, b.broken]));
    for (const barricade of this.map.barricades) {
      const broken = brokenById.get(barricade.id) ?? false;
      this.world.setBarricadeBroken(barricade.id, broken);
      if (broken) continue;
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
    this.collisionWorld.dynamic = dynamic;
  }

  private consumeSounds(snapshot: WorldSnapshot): void {
    const motion = this.predictor.motion;
    for (const sound of snapshot.sounds) {
      if (sound.seq <= this.lastSoundSeq) continue;
      this.lastSoundSeq = sound.seq;
      this.options.audio.play(sound.kind, sound.x, sound.z, sound.volume, sound.own);

      if (!sound.own && INDICATOR_SOUNDS.has(sound.kind) && this.settings.showSoundIndicators) {
        const dx = sound.x - motion.x;
        const dz = sound.z - motion.z;
        // Angle relative to where the camera is looking, so the arc points the
        // right way on screen rather than in world space.
        const world = Math.atan2(dx, dz);
        let angle = world - motion.yaw;
        while (angle > Math.PI) angle -= Math.PI * 2;
        while (angle < -Math.PI) angle += Math.PI * 2;
        this.soundPings.push({ angle, strength: sound.volume, kind: sound.kind, age: 0 });
        if (this.soundPings.length > 14) this.soundPings.shift();
      }

      // Loud world events startle the wildlife.
      if (sound.volume > 0.45) this.world.reactAt(sound.x, sound.z, sound.volume);
    }
  }

  /** Diffs consecutive snapshots to fire one-shot feedback. */
  private detectEvents(snapshot: WorldSnapshot): void {
    const self = snapshot.self;

    if (self.wound !== this.lastWound) {
      const worse =
        (self.wound === 'wounded' && this.lastWound === 'unmarked') || self.wound === 'cursed';
      if (worse) {
        this.hitStop = 0.075;
        this.cameraRig.addTrauma(0.45);
        this.cameraRig.punchFov(6);
        this.options.render.punchFlash(0xff4d7a, 0.55, 7);
        this.vfx.spawn('bladeImpact', self.transform.x, self.transform.y + 1.1, self.transform.z, 1.2);
        rumble(240, 0.85, 0.6);
      } else {
        this.options.render.punchFlash(0x7ee6a8, 0.3, 6);
        this.vfx.spawn('healPulse', self.transform.x, self.transform.y + 0.6, self.transform.z, 1);
      }
      this.lastWound = self.wound;
      this.localRig.setWound(self.wound);
      this.options.audio.setWound(self.wound);
    }

    if (snapshot.sealsActivated > this.lastSealsActive) {
      const lit = snapshot.seals.find((s) => s.active);
      if (lit) this.vfx.spawn('sealComplete', lit.x, 0.4, lit.z, 1.4);
      for (const seal of snapshot.seals) {
        if (seal.active) this.vfx.spawn('sealPulse', seal.x, 0.5, seal.z, 0.6);
      }
      this.lastSealsActive = snapshot.sealsActivated;
    }

    if (snapshot.gateOpen && !this.lastGateOpen) {
      this.lastGateOpen = true;
      this.vfx.spawn('gateOpen', this.map.gate.x, 1.2, this.map.gate.z, 1.6);
      this.cameraRig.addTrauma(0.2);
    }

    for (const ward of snapshot.wards) {
      if (!ward.triggered || this.seenTriggeredWards.has(ward.id)) continue;
      this.seenTriggeredWards.add(ward.id);
      this.vfx.spawn('wardBurst', ward.x, 0.8, ward.z, 1.5);
      const dist = Math.hypot(ward.x - self.transform.x, ward.z - self.transform.z);
      if (dist < 8) {
        this.options.render.punchFlash(0xffffff, this.role === 'hunter' ? 0.85 : 0.35, 4);
        this.cameraRig.addTrauma(this.role === 'hunter' ? 0.6 : 0.2);
        if (this.role === 'hunter') rumble(300, 0.9, 0.9);
      }
    }

    for (const snare of snapshot.snares) {
      if (!snare.triggered || this.seenTriggeredSnares.has(snare.id)) continue;
      this.seenTriggeredSnares.add(snare.id);
      this.vfx.spawn('snareSnap', snare.x, 0.25, snare.z, 1.1);
      if (this.role === 'runner') {
        this.cameraRig.addTrauma(0.3);
        rumble(180, 0.5, 0.4);
      }
    }

    const prevBolts = new Set((this.previous?.bolts ?? []).filter((b) => b.landed).map((b) => b.id));
    for (const bolt of snapshot.bolts) {
      if (bolt.landed && !prevBolts.has(bolt.id)) {
        this.vfx.spawn('boltImpact', bolt.x, bolt.y, bolt.z, 0.8);
      }
    }

    // Blade wind-up feedback and a cooldown-ready chime.
    if (self.bladePhase === 'active' && this.previous?.self.bladePhase === 'windup') {
      this.localRig.playAttack();
      this.cameraRig.addTrauma(0.12);
    }
    for (const [key, total] of Object.entries(COOLDOWN_TOTALS)) {
      const remaining = self.cooldowns[key] ?? 0;
      const wasCooling = (this.previous?.self.cooldowns[key] ?? 0) > 0;
      if (wasCooling && remaining <= 0 && total > 4 && !this.lastReadyFlash[key]) {
        this.options.audio.playUi('ready');
        this.lastReadyFlash[key] = true;
      } else if (remaining > 0) {
        this.lastReadyFlash[key] = false;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  private movementModifiers(): MovementModifiers {
    const self = this.snapshot?.self;
    let scale = 1;
    let rooted = false;
    let stunned = false;
    let sprintLocked = false;

    if (self) {
      if (this.role === 'runner') scale *= speedScaleForWound(self.wound);
      if (self.status.slowed > 0) scale *= self.status.marked > 0 ? CROSSBOW.slowFactor : SNARE.slowFactor;
      if (self.status.hasted > 0) scale *= WARD.runnerHasteFactor;
      if (self.status.breaching > 0) scale *= BREACH.recoverySlow;
      if (self.status.channeling > 0) scale *= 0.35;
      if (this.aiming && this.role === 'hunter') scale *= 0.72;
      rooted = self.status.rooted > 0;
      stunned = self.status.stunned > 0;
      sprintLocked = self.staminaLocked || self.status.channeling > 0 || self.reloading > 0;
    }

    return {
      speedScale: scale,
      rooted,
      stunned,
      forceCrouch: false,
      sprintLocked,
      lunge: 0,
    };
  }

  update(dt: number, input: InputSnapshot, inputEnabled: boolean): void {
    if (this.disposed) return;

    // Hitstop scales gameplay time only; feedback keeps running on real time.
    let gameplayDt = dt;
    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - dt);
      gameplayDt = dt * 0.08;
    }
    this.elapsed += dt;

    const mods = this.movementModifiers();
    const snapshot = this.snapshot;
    const canAct = inputEnabled && snapshot?.phase === 'active';

    // --- Local prediction --------------------------------------------------
    const intent = canAct
      ? {
          mx: input.mx,
          mz: input.mz,
          sprint: input.sprint,
          crouch: input.crouch,
          vault: input.vault,
          aim: input.aim && this.role === 'hunter',
        }
      : { mx: 0, mz: 0, sprint: false, crouch: false, vault: false, aim: false };

    this.aiming = intent.aim;
    this.predictor.predict(gameplayDt, intent, input.yaw, input.pitch, mods);

    // --- Send input at a fixed rate ---------------------------------------
    this.inputAccumulator += dt;
    if (this.inputAccumulator >= 1 / 30) {
      this.inputAccumulator = 0;
      this.options.sendInput(this.predictor.drainUnsent());
    }

    if (canAct) {
      for (const action of input.actions) {
        this.dispatchAction(action, input);
      }
    }

    const motion = this.predictor.motion;

    // --- Camera ------------------------------------------------------------
    this.cameraRig.setAiming(this.aiming, dt);
    this.cameraRig.update(
      dt,
      motion.x,
      motion.y,
      motion.z,
      motion.yaw,
      motion.pitch,
      motion.crouching,
      this.collisionWorld,
    );

    // --- Local character ---------------------------------------------------
    this.localRig.group.position.set(motion.x, motion.y, motion.z);
    this.localRig.group.rotation.y = motion.yaw;
    this.localRig.update(dt, motion.speed, motion.crouching);

    // --- Remote character --------------------------------------------------
    const remote = this.interpolator.update(dt, snapshot?.opponent.visible === true);
    if (remote.presence > 0.001) {
      this.remoteRig.group.visible = true;
      this.remoteRig.group.position.set(remote.x, remote.y, remote.z);
      this.remoteRig.group.rotation.y = remote.yaw;
      this.remoteRig.update(dt, remote.speed, remote.crouching);
      this.remoteRig.setOpacity(remote.presence);
      if (snapshot) {
        this.remoteRig.setWound(snapshot.opponent.wound);
        this.remoteRig.setMarked(
          this.role === 'hunter' && (snapshot.opponent.markedTrail?.strength ?? 0) > 0,
        );
        this.remoteRig.setStunned(false);
      }
    } else {
      this.remoteRig.group.visible = false;
    }

    // --- World, markers, VFX ----------------------------------------------
    this.cameraTmp.copy(this.options.render.camera.position);
    this.playerTmp.set(motion.x, motion.y, motion.z);
    this.world.update({
      dt,
      elapsed: this.elapsed,
      cameraPosition: this.cameraTmp,
      fogBoost: snapshot?.fogBoost ?? 0,
      reducedMotion: this.settings.reducedMotion,
      playerPosition: this.playerTmp,
      disturbance: motion.sprinting ? Math.min(1, motion.speed / 7) : 0,
    });

    if (snapshot) {
      this.markers.sync({
        snapshot,
        map: this.map,
        dt,
        elapsed: this.elapsed,
        role: this.role,
        reducedMotion: this.settings.reducedMotion,
      });
    }
    this.vfx.update(dt, this.elapsed);

    // --- Audio -------------------------------------------------------------
    this.options.audio.setListener({ x: motion.x, z: motion.z, yaw: motion.yaw });
    this.options.audio.setSprinting(motion.sprinting);
    if (snapshot) this.options.audio.setDread(snapshot.self.dread);

    // --- Post grade --------------------------------------------------------
    this.options.render.setDread(snapshot ? snapshot.self.dread * 0.9 : 0);

    // --- Sound indicator ageing -------------------------------------------
    for (let i = this.soundPings.length - 1; i >= 0; i -= 1) {
      this.soundPings[i].age += dt;
      if (this.soundPings[i].age > 1.6) this.soundPings.splice(i, 1);
    }
  }

  private dispatchAction(kind: ActionKind, input: InputSnapshot): void {
    const self = this.snapshot?.self;
    if (self) {
      // Give immediate local feedback when an ability is not available; the
      // server is still the authority, this just avoids a silent no-op.
      const cooldownKey = this.cooldownKeyFor(kind);
      if (cooldownKey && (self.cooldowns[cooldownKey] ?? 0) > 0) {
        this.options.onNotice('Not ready yet', 'bad');
        return;
      }
      if (kind === 'secondary' && this.role === 'hunter' && self.bolts <= 0) {
        this.options.onNotice('Out of bolts — reload with R', 'bad');
        return;
      }
      if (kind === 'ability2' && this.role === 'hunter' && (self.charges.snares ?? 0) <= 0) {
        this.options.onNotice('No snares left', 'bad');
        return;
      }
      if (kind === 'secondary' && this.role === 'runner' && (self.charges.wards ?? 0) <= 0) {
        this.options.onNotice('No wards left', 'bad');
        return;
      }
    }

    if (kind === 'secondary' && this.role === 'hunter') return;
    if (kind === 'primary' && this.role === 'hunter') this.cameraRig.punchFov(this.aiming ? 1.5 : 3);
    if (kind === 'secondary' && this.role === 'hunter') this.cameraRig.addTrauma(0.14);

    this.options.sendAction({
      kind,
      yaw: input.yaw,
      pitch: input.pitch,
      seq: this.predictor.sequence,
    });
  }

  private cooldownKeyFor(kind: ActionKind): string | null {
    if (this.role === 'hunter') {
      switch (kind) {
        case 'primary':
          return this.aiming ? 'crossbow' : 'blade';
        case 'secondary':
          return 'crossbow';
        case 'ability1':
          return 'pulse';
        case 'ability2':
          return 'snare';
        default:
          return null;
      }
    }
    switch (kind) {
      case 'primary':
        return 'throw';
      case 'secondary':
        return 'ward';
      case 'ability1':
        return 'decoy';
      case 'ability2':
        return 'smoke';
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Accessors used by the HUD and the test hooks
  // -------------------------------------------------------------------------

  get currentSnapshot(): WorldSnapshot | null {
    return this.snapshot;
  }

  get pings(): SoundPing[] {
    return this.soundPings;
  }

  get localMotion(): { x: number; y: number; z: number; yaw: number; speed: number } {
    const m = this.predictor.motion;
    return { x: m.x, y: m.y, z: m.z, yaw: m.yaw, speed: m.speed };
  }

  get netStats(): { corrections: number; snaps: number; error: number; pending: number; interpBuffer: number } {
    return { ...this.predictor.stats, interpBuffer: this.interpolator.bufferSize };
  }

  get worldDiagnostics(): ReturnType<WorldExtras['describe']> {
    return this.world.describe();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const scene = this.options.render.scene;
    scene.remove(this.world.root);
    scene.remove(this.markers.root);
    scene.remove(this.vfx.root);
    scene.remove(this.localRig.group);
    scene.remove(this.remoteRig.group);
    scene.fog = null;
    this.world.dispose();
    this.markers.dispose();
    this.vfx.dispose();
    this.localRig.dispose();
    this.remoteRig.dispose();
    this.soundPings.length = 0;
  }
}

/** Best-effort gamepad rumble; silently ignored on unsupported hardware. */
function rumble(durationMs: number, strong: number, weak: number): void {
  if (typeof navigator.getGamepads !== 'function') return;
  for (const pad of navigator.getGamepads()) {
    const actuator = (pad as Gamepad & { vibrationActuator?: GamepadHapticActuator })
      ?.vibrationActuator as
      | { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> }
      | undefined;
    if (!actuator?.playEffect) continue;
    void actuator
      .playEffect('dual-rumble', {
        duration: durationMs,
        strongMagnitude: strong,
        weakMagnitude: weak,
      })
      .catch(() => undefined);
  }
}
