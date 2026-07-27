/**
 * Deterministic test hooks.
 *
 * Installed only in development and E2E builds. They expose the *local* client's
 * own state plus renderer statistics — never the opponent's hidden position,
 * because the client genuinely does not receive it when it should not.
 */

import type { WorldSnapshot } from '../../shared/types.js';
import type { ScreenName } from '../contracts.js';

export interface TestHookHost {
  getScreen(): ScreenName;
  getSnapshot(): WorldSnapshot | null;
  getRole(): string | null;
  getRoomCode(): string | null;
  getSeed(): number | null;
  getLocalTransform(): { x: number; y: number; z: number; yaw: number; speed: number } | null;
  getNetStats(): Record<string, number> | null;
  getRendererStats(): Record<string, number>;
  getWorldDiagnostics(): Record<string, number> | null;
  isCanvasNonBlank(): { nonBlank: boolean; uniqueColors: number; meanLuminance: number };
  pressAction(kind: string): void;
  setMoveIntent(mx: number, mz: number, sprint: boolean, crouch: boolean): void;
  setLook(yaw: number, pitch: number): void;
  setInteract(held: boolean): void;
  triggerVault(): void;
  createRoom(name: string, seed?: number): void;
  joinRoom(name: string, code: string): void;
  setReady(ready: boolean): void;
  addBot(): void;
  rematch(): void;
  returnToLobby(): void;
  dismissTutorial(): void;
  debugForce(kind: string, value?: number): void;
  getFrameCount(): number;
  getErrors(): string[];
}

export interface VeilHuntTestApi {
  readonly version: number;
  state(): {
    screen: ScreenName;
    role: string | null;
    roomCode: string | null;
    seed: number | null;
    phase: string | null;
    timeRemaining: number | null;
    sealsActivated: number | null;
    gateOpen: boolean | null;
    gateProgress: number | null;
    wound: string | null;
    cooldowns: Record<string, number> | null;
    charges: Record<string, number> | null;
    prompt: { kind: string; label: string; progress: number; blocked: boolean } | null;
    opponentVisible: boolean | null;
    frames: number;
  };
  transform(): { x: number; y: number; z: number; yaw: number; speed: number } | null;
  seals(): { id: number; active: boolean; progress: number }[] | null;
  snapshot(): WorldSnapshot | null;
  net(): Record<string, number> | null;
  renderer(): Record<string, number>;
  world(): Record<string, number> | null;
  canvas(): { nonBlank: boolean; uniqueColors: number; meanLuminance: number };
  errors(): string[];
  input: {
    move(mx: number, mz: number, opts?: { sprint?: boolean; crouch?: boolean }): void;
    look(yaw: number, pitch?: number): void;
    interact(held: boolean): void;
    vault(): void;
    action(kind: string): void;
    stop(): void;
  };
  lobby: {
    create(name: string, seed?: number): void;
    join(name: string, code: string): void;
    ready(value: boolean): void;
    addBot(): void;
    rematch(): void;
    returnToLobby(): void;
    dismissTutorial(): void;
  };
  /** Test-only deterministic state forcing, honoured only by a test server. */
  debug(kind: string, value?: number): void;
}

declare global {
  interface Window {
    __VEIL_HUNT_TEST__?: VeilHuntTestApi;
  }
}

export function installTestHooks(host: TestHookHost): () => void {
  const api: VeilHuntTestApi = {
    version: 1,

    state() {
      const snapshot = host.getSnapshot();
      const self = snapshot?.self ?? null;
      return {
        screen: host.getScreen(),
        role: host.getRole(),
        roomCode: host.getRoomCode(),
        seed: host.getSeed(),
        phase: snapshot?.phase ?? null,
        timeRemaining: snapshot?.timeRemaining ?? null,
        sealsActivated: snapshot?.sealsActivated ?? null,
        gateOpen: snapshot?.gateOpen ?? null,
        gateProgress: snapshot?.gateProgress ?? null,
        wound: self?.wound ?? null,
        cooldowns: self ? { ...self.cooldowns } : null,
        charges: self ? { ...self.charges } : null,
        prompt: self
          ? {
              kind: self.prompt.kind,
              label: self.prompt.label,
              progress: self.prompt.progress,
              blocked: self.prompt.blocked,
            }
          : null,
        opponentVisible: snapshot?.opponent.visible ?? null,
        frames: host.getFrameCount(),
      };
    },

    transform: () => host.getLocalTransform(),
    seals: () => host.getSnapshot()?.seals.map((s) => ({ id: s.id, active: s.active, progress: s.progress })) ?? null,
    snapshot: () => host.getSnapshot(),
    net: () => host.getNetStats(),
    renderer: () => host.getRendererStats(),
    world: () => host.getWorldDiagnostics(),
    canvas: () => host.isCanvasNonBlank(),
    errors: () => host.getErrors(),

    input: {
      move(mx, mz, opts) {
        host.setMoveIntent(mx, mz, opts?.sprint === true, opts?.crouch === true);
      },
      look(yaw, pitch = 0) {
        host.setLook(yaw, pitch);
      },
      interact(held) {
        host.setInteract(held);
      },
      vault() {
        host.triggerVault();
      },
      action(kind) {
        host.pressAction(kind);
      },
      stop() {
        host.setMoveIntent(0, 0, false, false);
        host.setInteract(false);
      },
    },

    lobby: {
      create: (name, seed) => host.createRoom(name, seed),
      join: (name, code) => host.joinRoom(name, code),
      ready: (value) => host.setReady(value),
      addBot: () => host.addBot(),
      rematch: () => host.rematch(),
      returnToLobby: () => host.returnToLobby(),
      dismissTutorial: () => host.dismissTutorial(),
    },

    debug: (kind, value) => host.debugForce(kind, value),
  };

  window.__VEIL_HUNT_TEST__ = api;
  return () => {
    delete window.__VEIL_HUNT_TEST__;
  };
}
