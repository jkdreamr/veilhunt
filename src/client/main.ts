/**
 * Application shell.
 *
 * Owns the client state machine, the render loop and the wiring between
 * network, UI, audio and the in-match controller.
 */

import '../style.css';

import { COUNTDOWN_DURATION } from '../shared/constants.js';
import type { MatchResult, Role, RoomView, WorldSnapshot } from '../shared/types.js';
import { DEFAULT_SETTINGS, type GameSettings, type ScreenName, type UiActions } from './contracts.js';
import { GameClient } from './GameClient.js';
import { InputController, type InputSnapshot } from './core/Input.js';
import { RenderSystem } from './core/Renderer.js';
import { SettingsStore, savePlayerName } from './core/Settings.js';
import { NetClient, type ConnectionState } from './net/NetClient.js';
import { createAudioSystem } from './systems/Audio.js';
import { createUi } from './ui/Ui.js';
import { installTestHooks } from './test/hooks.js';

const TUTORIAL_KEY = 'veilhunt.tutorialSeen';
const IS_TEST_BUILD = import.meta.env.DEV || import.meta.env.MODE === 'e2e';

type AppPhase =
  | 'boot'
  | 'title'
  | 'connecting'
  | 'lobby'
  | 'roleReveal'
  | 'tutorial'
  | 'match'
  | 'paused'
  | 'results'
  | 'disconnected';

class App {
  private readonly canvas: HTMLCanvasElement;
  private readonly render: RenderSystem;
  private readonly input: InputController;
  private readonly settingsStore = new SettingsStore();
  private readonly audio = createAudioSystem();
  private readonly net = new NetClient();
  private readonly ui: ReturnType<typeof createUi>;

  private phase: AppPhase = 'boot';
  private game: GameClient | null = null;
  private room: RoomView | null = null;
  private role: Role | null = null;
  private seed: number | null = null;
  private pendingRoleReveal: {
    role: Role;
    opponentName: string;
    round: number;
    seed: number;
    contract: { title: string; description: string } | null;
    duration: number;
  } | null = null;
  private tutorialPending = false;
  private actions!: UiActions;
  private lastFrame = 0;
  private frameCount = 0;
  private rafHandle = 0;
  private readonly errors: string[] = [];
  private opponentAway: { present: boolean; name: string; graceSeconds: number } | null = null;
  private countdownShown: number | null = null;
  private audioUnlocked = false;
  private wakeNoticeTimer: number | null = null;
  /** Overrides driven by the automated test hooks. */
  private testIntent: { mx: number; mz: number; sprint: boolean; crouch: boolean } | null = null;
  private testLook: { yaw: number; pitch: number } | null = null;
  private testInteract: boolean | null = null;
  private testAim = false;
  private testActions: string[] = [];
  private testVault = false;

  constructor() {
    const canvas = document.getElementById('scene');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('Veil Hunt: #scene canvas is missing from index.html');
    }
    this.canvas = canvas;

    const uiMount = document.getElementById('ui');
    if (!uiMount) throw new Error('Veil Hunt: #ui mount is missing from index.html');

    this.render = new RenderSystem(canvas, { preserveDrawingBuffer: IS_TEST_BUILD });
    this.render.setQuality(this.settingsStore.value.quality);
    this.input = new InputController(canvas);
    this.ui = createUi(uiMount);

    this.captureErrors();
    this.wireUi();
    this.wireNet();
    this.wireInput();

    this.ui.setSettings(this.settingsStore.value);
    this.audio.applySettings(this.settingsStore.value);
    this.settingsStore.subscribe((settings) => {
      this.audio.applySettings(settings);
      this.render.setQuality(settings.quality);
      this.game?.applySettings(settings);
      this.input.setSensitivity(settings.mouseSensitivity);
      this.input.setInvertY(settings.invertY);
      this.ui.setSettings(settings);
    });
    this.input.setSensitivity(this.settingsStore.value.mouseSensitivity);
    this.input.setInvertY(this.settingsStore.value.invertY);

    if (IS_TEST_BUILD) this.installHooks();

    this.setPhase('title');
    this.net.connect();
    this.start();
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private captureErrors(): void {
    window.addEventListener('error', (event) => {
      this.errors.push(`${event.message} @ ${event.filename}:${event.lineno}`);
    });
    window.addEventListener('unhandledrejection', (event) => {
      this.errors.push(`unhandledrejection: ${String(event.reason)}`);
    });
  }

  private clearWakeNotice(): void {
    if (this.wakeNoticeTimer !== null) {
      window.clearTimeout(this.wakeNoticeTimer);
      this.wakeNoticeTimer = null;
    }
  }

  private async ensureAudio(): Promise<void> {
    if (this.audioUnlocked) return;
    this.audioUnlocked = true;
    try {
      await this.audio.unlock();
      if (this.phase === 'title' || this.phase === 'lobby') this.audio.startMenuAmbience();
    } catch {
      // Audio stays silent; the game remains fully playable.
    }
  }

  private wireUi(): void {
    this.actions = {
      createRoom: (name, seed) => {
        void this.ensureAudio();
        savePlayerName(name);
        this.setPhase('connecting');
        this.ui.setStatus('Opening a room…');
        this.net.createRoom(name, seed);
      },
      joinRoom: (name, code) => {
        void this.ensureAudio();
        savePlayerName(name);
        this.setPhase('connecting');
        this.ui.setStatus(`Joining room ${code}…`);
        this.net.joinRoom(name, code);
      },
      setReady: (ready) => {
        void this.ensureAudio();
        this.audio.playUi('ready');
        this.net.setReady(ready);
      },
      addBot: () => {
        this.audio.playUi('click');
        this.net.addBot();
      },
      leaveRoom: () => {
        this.audio.playUi('back');
        this.net.leaveRoom();
        this.teardownGame();
        this.room = null;
        this.setPhase('title');
      },
      rematch: () => {
        this.audio.playUi('click');
        this.net.rematch();
        this.ui.setStatus('Waiting for the other player…');
      },
      returnToLobby: () => {
        this.audio.playUi('back');
        this.teardownGame();
        this.net.returnToLobby();
        this.setPhase('lobby');
      },
      dismissTutorial: () => {
        try {
          localStorage.setItem(TUTORIAL_KEY, '1');
        } catch {
          // Non-fatal.
        }
        this.tutorialPending = false;
        this.audio.playUi('click');
        if (this.game) this.setPhase('match');
        else if (this.pendingRoleReveal) this.setPhase('roleReveal');
        else this.setPhase('lobby');
      },
      resume: () => {
        this.audio.playUi('back');
        this.setPhase('match');
      },
      quitToTitle: () => {
        this.audio.playUi('back');
        this.net.leaveRoom();
        this.teardownGame();
        this.room = null;
        this.setPhase('title');
      },
      updateSettings: (patch: Partial<GameSettings>) => {
        this.settingsStore.update(patch);
      },
      requestPointerLock: () => {
        if (this.phase === 'match') this.input.requestLock();
      },
      openCredits: () => {
        this.audio.playUi('click');
        this.ui.showScreen('credits');
      },
      closeCredits: () => {
        this.audio.playUi('back');
        this.ui.showScreen(this.phase === 'title' ? 'title' : 'lobby');
      },
    };
    this.ui.setActions(this.actions);
  }

  private wireNet(): void {
    this.net.setHandlers({
      onConnectionState: (state: ConnectionState, detail?: string) => {
        if (state === 'failed') {
          this.ui.setConnectionError(
            detail ??
              'Could not reach the Veil Hunt server. Make sure it is running, then reload this page.',
          );
          if (this.phase === 'connecting') this.setPhase('title');
        } else if (state === 'connected') {
          this.clearWakeNotice();
          this.ui.setConnectionError(null);
        } else if (state === 'reconnecting') {
          this.ui.setStatus('Reconnecting…');
          // A reconnect that drags on usually means a free-tier host is waking
          // from idle, which takes up to a minute. Say so plainly rather than
          // leaving a spinner that reads as broken.
          if (this.wakeNoticeTimer === null) {
            this.wakeNoticeTimer = window.setTimeout(() => {
              if (this.net.connectionState === 'reconnecting') {
                this.ui.setStatus(
                  'Waking the server — free hosting sleeps when idle, so this can take up to a minute.',
                );
              }
            }, 6000);
          }
        }
      },

      onRoom: (view) => {
        this.room = view;
        this.ui.setRoom(view);
        if (view.phase === 'lobby' && (this.phase === 'connecting' || this.phase === 'title')) {
          this.setPhase('lobby');
          void this.ensureAudio().then(() => this.audio.startMenuAmbience());
        } else if (view.phase === 'lobby' && this.phase === 'results') {
          this.teardownGame();
          this.setPhase('lobby');
        }
      },

      onRoomError: (payload) => {
        this.ui.setConnectionError(payload.message);
        this.setPhase('title');
      },

      onRoleReveal: (payload) => {
        this.pendingRoleReveal = {
          role: payload.role,
          opponentName: payload.opponentName,
          round: payload.round,
          seed: payload.seed,
          contract: payload.contract
            ? { title: payload.contract.title, description: payload.contract.description }
            : null,
          duration: payload.duration,
        };
        this.role = payload.role;
        this.seed = payload.seed;
        this.audio.stopAmbience();
        this.audio.playUi('reveal');
        this.ui.showRoleReveal(this.pendingRoleReveal);
        this.setPhase('roleReveal');
      },

      onMatchStart: (payload) => {
        this.role = payload.role;
        this.seed = payload.seed;
        this.startMatch(payload.seed, payload.role);
      },

      onSnapshot: (snapshot: WorldSnapshot) => {
        // Snapshots are the authority on whether a match is running. If one
        // arrives while we have no match client — a dropped `matchStart`, a
        // reconnect mid-round, or a very slow world build — build it now from
        // the role and seed we already hold rather than stranding the player on
        // the role-reveal screen with the server ticking away without them.
        const liveMatch = snapshot.phase === 'countdown' || snapshot.phase === 'active';
        const recoverable = this.phase === 'roleReveal' || this.phase === 'tutorial';
        if (!this.game && liveMatch && recoverable && this.role !== null && this.seed !== null) {
          this.startMatch(this.seed, this.role);
        }

        this.game?.applySnapshot(snapshot);
        if (snapshot.phase === 'countdown') {
          const seconds = Math.max(0, Math.ceil(snapshot.phaseRemaining));
          if (seconds !== this.countdownShown) {
            this.countdownShown = seconds;
            if (seconds > 0) this.audio.playUi('countdown');
          }
          this.ui.setCountdown(seconds);
        } else if (this.countdownShown !== null) {
          this.countdownShown = null;
          this.ui.setCountdown(null);
        }
      },

      onMatchEnd: (payload) => {
        this.showResults(payload.result, payload.yourRole);
      },

      onOpponentLeft: (payload) => {
        this.opponentAway = { present: false, name: payload.name, graceSeconds: payload.graceSeconds };
        this.ui.setOpponentPresence(this.opponentAway);
        this.ui.flashNotice(`${payload.name} disconnected`, 'bad');
      },

      onOpponentReturned: (payload) => {
        this.opponentAway = { present: true, name: payload.name, graceSeconds: 0 };
        this.ui.setOpponentPresence(this.opponentAway);
        this.ui.flashNotice(`${payload.name} reconnected`, 'good');
        window.setTimeout(() => {
          this.opponentAway = null;
          this.ui.setOpponentPresence(null);
        }, 3000);
      },
    });
  }

  private wireInput(): void {
    this.input.attach();
    this.input.onLockChange = (locked) => {
      // Losing pointer lock mid-match pauses rather than leaving the player
      // running blind with a free cursor.
      if (!locked && this.phase === 'match') this.setPhase('paused');
    };

    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Escape') return;
      if (this.phase === 'tutorial' && this.tutorialPending) {
        // Escape on the tutorial dismisses it rather than opening a pause menu
        // over a screen the player has not finished reading.
        this.actions.dismissTutorial();
      } else if (this.phase === 'match') {
        this.setPhase('paused');
      } else if (this.phase === 'paused') {
        this.setPhase('match');
      }
    });

    this.canvas.addEventListener('click', () => {
      void this.ensureAudio();
      if (this.phase === 'match' && !this.input.isLocked) this.input.requestLock();
    });
  }

  // -------------------------------------------------------------------------
  // Phase machine
  // -------------------------------------------------------------------------

  private setPhase(phase: AppPhase): void {
    this.phase = phase;

    const screenByPhase: Record<AppPhase, ScreenName> = {
      boot: 'boot',
      title: 'title',
      connecting: 'connecting',
      lobby: 'lobby',
      roleReveal: 'roleReveal',
      tutorial: 'tutorial',
      match: 'match',
      paused: 'pause',
      results: 'results',
      disconnected: 'disconnected',
    };
    this.ui.showScreen(screenByPhase[phase]);

    const inMatch = phase === 'match';
    this.input.setEnabled(inMatch);
    if (inMatch) {
      this.input.requestLock();
    } else {
      this.input.releaseLock();
    }

    if (phase === 'title' || phase === 'lobby') {
      void this.ensureAudio().then(() => this.audio.startMenuAmbience());
    }
  }

  private startMatch(seed: number, role: Role): void {
    this.teardownGame();
    this.audio.stopAmbience();

    this.game = new GameClient({
      render: this.render,
      audio: this.audio,
      settings: this.settingsStore.value,
      seed,
      role,
      sendInput: (commands) => this.net.sendInput(commands),
      sendAction: (action) => this.net.sendAction(action),
      onNotice: (text, tone) => this.ui.flashNotice(text, tone),
    });
    this.input.setOrientation(this.game.initialYaw, 0);
    void this.ensureAudio().then(() => this.audio.startMatchAmbience(role));

    let seenTutorial = false;
    try {
      seenTutorial = localStorage.getItem(TUTORIAL_KEY) === '1';
    } catch {
      seenTutorial = false;
    }
    if (!seenTutorial) {
      this.tutorialPending = true;
      this.setPhase('tutorial');
    } else {
      this.setPhase('match');
    }
    this.countdownShown = COUNTDOWN_DURATION;
  }

  private showResults(result: MatchResult, yourRole: Role): void {
    this.input.setEnabled(false);
    this.input.releaseLock();
    this.audio.stopAmbience();
    this.audio.setDread(0);
    this.audio.playUi(result.winner === yourRole ? 'victory' : 'defeat');
    this.ui.showResults(result, yourRole);
    this.setPhase('results');
  }

  private teardownGame(): void {
    if (!this.game) return;
    this.game.dispose();
    this.game = null;
    this.render.setDread(0);
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  private start(): void {
    this.lastFrame = performance.now();
    const frame = (now: number): void => {
      this.rafHandle = requestAnimationFrame(frame);
      // Clamp so a backgrounded tab does not resume with a huge delta.
      const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
      this.lastFrame = now;
      this.tick(dt);
    };
    this.rafHandle = requestAnimationFrame(frame);
  }

  private tick(dt: number): void {
    this.frameCount += 1;

    if (this.game) {
      const input = this.buildInput();
      const enabled = this.phase === 'match';
      this.game.update(dt, input, enabled);

      const snapshot = this.game.currentSnapshot;
      if (snapshot && (this.phase === 'match' || this.phase === 'paused')) {
        this.ui.updateHud({
          role: this.game.role,
          snapshot,
          ping: Math.round(this.net.ping),
          connected: this.net.connected,
          settings: this.settingsStore.value,
          soundPings: this.game.pings,
        });
      }
    }

    this.render.render(dt, performance.now() / 1000);
  }

  /** Merges real input with any overrides driven by the automated test hooks. */
  private buildInput(): InputSnapshot {
    const sampled = this.input.sample();
    if (!IS_TEST_BUILD) return sampled;

    const merged: InputSnapshot = { ...sampled };
    if (this.testIntent) {
      merged.mx = this.testIntent.mx;
      merged.mz = this.testIntent.mz;
      merged.sprint = this.testIntent.sprint;
      merged.crouch = this.testIntent.crouch;
    }
    if (this.testLook) {
      merged.yaw = this.testLook.yaw;
      merged.pitch = this.testLook.pitch;
    }
    if (this.testAim) merged.aim = true;
    if (this.testVault) {
      merged.vault = true;
      this.testVault = false;
    }
    if (this.testInteract !== null) {
      if (this.testInteract && !merged.interactHeld) merged.actions = [...merged.actions, 'interact'];
      if (!this.testInteract && merged.interactHeld) merged.actions = [...merged.actions, 'interactStop'];
      merged.interactHeld = this.testInteract;
      this.testInteract = null;
    }
    if (this.testActions.length > 0) {
      merged.actions = [...merged.actions, ...(this.testActions as InputSnapshot['actions'])];
      this.testActions = [];
    }
    return merged;
  }

  // -------------------------------------------------------------------------
  // Test hooks
  // -------------------------------------------------------------------------

  private installHooks(): void {
    installTestHooks({
      getScreen: () => this.ui.currentScreen,
      getSnapshot: () => this.game?.currentSnapshot ?? null,
      getRole: () => this.role,
      getRoomCode: () => this.room?.code ?? null,
      getSeed: () => this.seed,
      getLocalTransform: () => this.game?.localMotion ?? null,
      getNetStats: () => (this.game ? { ...this.game.netStats } : null),
      getRendererStats: () => ({ ...this.render.stats }),
      getWorldDiagnostics: () => (this.game ? { ...this.game.worldDiagnostics } : null),
      isCanvasNonBlank: () => this.sampleCanvas(),
      pressAction: (kind) => this.testActions.push(kind),
      setMoveIntent: (mx, mz, sprint, crouch) => {
        this.testIntent = { mx, mz, sprint, crouch };
      },
      setLook: (yaw, pitch) => {
        this.testLook = { yaw, pitch };
        this.input.setOrientation(yaw, pitch);
      },
      setInteract: (held) => {
        this.testInteract = held;
      },
      setAim: (held) => {
        this.testAim = held;
      },
      triggerVault: () => {
        this.testVault = true;
      },
      createRoom: (name, seed) => this.net.createRoom(name, seed),
      joinRoom: (name, code) => this.net.joinRoom(name, code),
      setReady: (ready) => this.net.setReady(ready),
      addBot: () => this.net.addBot(),
      rematch: () => this.net.rematch(),
      returnToLobby: () => {
        this.teardownGame();
        this.net.returnToLobby();
        this.setPhase('lobby');
      },
      dismissTutorial: () => {
        this.tutorialPending = false;
        try {
          localStorage.setItem(TUTORIAL_KEY, '1');
        } catch {
          // Non-fatal.
        }
        if (this.game) this.setPhase('match');
      },
      debugForce: (kind, value) => this.net.sendDebug(kind, value),
      getFrameCount: () => this.frameCount,
      getErrors: () => this.errors.slice(),
    });
  }

  /** Reads back a low-resolution sample of the canvas to prove it is drawing. */
  private sampleCanvas(): { nonBlank: boolean; uniqueColors: number; meanLuminance: number } {
    const gl = this.render.renderer.getContext();
    const width = 64;
    const height = 36;
    const pixels = new Uint8Array(width * height * 4);
    const fullWidth = this.canvas.width;
    const fullHeight = this.canvas.height;
    const stepX = Math.max(1, Math.floor(fullWidth / width));
    const stepY = Math.max(1, Math.floor(fullHeight / height));

    // readPixels on the default framebuffer after a render gives us the frame.
    const buffer = new Uint8Array(fullWidth * 4);
    const colors = new Set<number>();
    let sum = 0;
    let samples = 0;
    for (let y = 0; y < fullHeight; y += stepY) {
      gl.readPixels(0, y, fullWidth, 1, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
      for (let x = 0; x < fullWidth; x += stepX) {
        const o = x * 4;
        const r = buffer[o];
        const g = buffer[o + 1];
        const b = buffer[o + 2];
        colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
        sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        samples += 1;
      }
    }
    void pixels;
    const mean = samples > 0 ? sum / samples : 0;
    return {
      nonBlank: colors.size > 12 && mean > 2,
      uniqueColors: colors.size,
      meanLuminance: Number(mean.toFixed(2)),
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
    this.clearWakeNotice();
    this.teardownGame();
    this.input.detach();
    this.net.dispose();
    this.audio.dispose();
    this.ui.dispose();
    this.render.dispose();
    this.settingsStore.dispose();
  }
}

function boot(): void {
  try {
    const app = new App();
    // Expose for manual debugging in development only.
    if (IS_TEST_BUILD) {
      (window as unknown as { __VEIL_APP__?: App }).__VEIL_APP__ = app;
    }
    // Release the WebGL context, sockets, audio nodes and timers as soon as the
    // page goes away. Browsers cap live WebGL contexts per process, so leaving
    // them to garbage collection starves later pages in the same session.
    window.addEventListener(
      'pagehide',
      () => {
        app.dispose();
      },
      { once: true },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = document.getElementById('boot-error');
    if (fallback) {
      fallback.hidden = false;
      fallback.textContent = `Veil Hunt failed to start: ${message}`;
    }
    throw error;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export { DEFAULT_SETTINGS };
