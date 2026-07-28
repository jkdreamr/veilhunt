/**
 * Keyboard, mouse and gamepad input. Produces a frame-stable intent object plus
 * a queue of discrete action edges; it never touches game state directly.
 */

import type { ActionKind } from '../../shared/types.js';

export interface MoveIntent {
  /** Strafe, -1..1. */
  mx: number;
  /** Forward, -1..1. */
  mz: number;
  sprint: boolean;
  crouch: boolean;
  vault: boolean;
}

export interface InputSnapshot extends MoveIntent {
  /** Right mouse held — the Hunter aims the crossbow. */
  aim: boolean;
  yaw: number;
  pitch: number;
  /** Discrete actions triggered this frame. */
  actions: ActionKind[];
  interactHeld: boolean;
  pointerLocked: boolean;
}

const KEY_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'ControlRight', 'KeyC'],
  vault: ['Space'],
  interact: ['KeyE'],
  ability1: ['KeyQ'],
  ability2: ['KeyF'],
  reload: ['KeyR'],
} as const;

export class InputController {
  private readonly pressed = new Set<string>();
  private readonly actionQueue: ActionKind[] = [];
  private yawValue = 0;
  private pitchValue = 0;
  private interact = false;
  private enabled = false;
  private locked = false;
  private sensitivity = 1;
  private invertY = false;
  private lastGamepadButtons = new Map<number, boolean>();
  private padInteract = false;
  private aimHeld = false;
  private mouseAimHeld = false;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    if (event.repeat) {
      // Held keys still count for movement, but not for discrete actions.
      this.pressed.add(event.code);
      return;
    }
    this.pressed.add(event.code);

    if (KEY_BINDINGS.interact.includes(event.code as never)) {
      if (!this.interact) {
        this.interact = true;
        this.actionQueue.push('interact');
      }
      event.preventDefault();
    } else if (KEY_BINDINGS.ability1.includes(event.code as never)) {
      this.actionQueue.push('ability1');
    } else if (KEY_BINDINGS.ability2.includes(event.code as never)) {
      this.actionQueue.push('ability2');
    } else if (KEY_BINDINGS.reload.includes(event.code as never)) {
      this.actionQueue.push('reload');
    }

    // Space would otherwise scroll the page behind the canvas.
    if (event.code === 'Space') event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
    if (KEY_BINDINGS.interact.includes(event.code as never) && this.interact) {
      this.interact = false;
      this.actionQueue.push('interactStop');
    }
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || !this.locked) return;
    const scale = 0.0022 * this.sensitivity;
    this.yawValue -= event.movementX * scale;
    const pitchDelta = event.movementY * scale * (this.invertY ? 1 : -1);
    this.pitchValue = Math.max(-1.15, Math.min(0.95, this.pitchValue + pitchDelta));
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (!this.enabled || !this.locked) return;
    if (event.button === 0) this.actionQueue.push('primary');
    else if (event.button === 2) {
      this.aimHeld = true;
      this.mouseAimHeld = true;
      this.actionQueue.push('secondary');
    }
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button === 2) {
      this.aimHeld = false;
      this.mouseAimHeld = false;
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.enabled) event.preventDefault();
  };

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.target;
    if (!this.locked) this.releaseAll();
    this.onLockChange?.(this.locked);
  };

  private readonly onBlur = (): void => {
    this.releaseAll();
  };

  /** Notified whenever pointer lock is gained or lost. */
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private readonly target: HTMLElement) {}

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.target.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.target.removeEventListener('contextmenu', this.onContextMenu);
    this.releaseAll();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  setSensitivity(value: number): void {
    this.sensitivity = value;
  }

  setInvertY(value: boolean): void {
    this.invertY = value;
  }

  requestLock(): void {
    if (this.locked) return;
    const request = this.target.requestPointerLock?.bind(this.target);
    if (!request) return;
    // Chrome rejects the promise form when called too soon after an exit.
    const result = request() as unknown;
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => undefined);
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Sets the yaw without generating mouse deltas, e.g. on match start. */
  setOrientation(yaw: number, pitch = 0): void {
    this.yawValue = yaw;
    this.pitchValue = pitch;
  }

  private releaseAll(): void {
    this.pressed.clear();
    this.aimHeld = false;
    this.mouseAimHeld = false;
    if (this.interact) {
      this.interact = false;
      this.actionQueue.push('interactStop');
    }
  }

  private any(codes: readonly string[]): boolean {
    for (const code of codes) if (this.pressed.has(code)) return true;
    return false;
  }

  private pollGamepad(): { mx: number; mz: number; sprint: boolean; crouch: boolean; aim: boolean } | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (!pad) continue;
      const dead = (v: number): number => (Math.abs(v) < 0.18 ? 0 : v);
      const mx = dead(pad.axes[0] ?? 0);
      const mz = -dead(pad.axes[1] ?? 0);
      const lookX = dead(pad.axes[2] ?? 0);
      const lookY = dead(pad.axes[3] ?? 0);
      this.yawValue -= lookX * 0.045 * this.sensitivity;
      this.pitchValue = Math.max(
        -1.15,
        Math.min(0.95, this.pitchValue + lookY * 0.032 * this.sensitivity * (this.invertY ? 1 : -1)),
      );

      const edge = (index: number, action: ActionKind): void => {
        const down = pad.buttons[index]?.pressed === true;
        if (down && !this.lastGamepadButtons.get(index)) this.actionQueue.push(action);
        this.lastGamepadButtons.set(index, down);
      };
      edge(7, 'primary'); // right trigger
      edge(6, 'secondary'); // left trigger
      edge(2, 'ability1'); // X / square
      edge(3, 'ability2'); // Y / triangle
      edge(1, 'reload'); // B / circle

      const interactDown = pad.buttons[0]?.pressed === true;
      if (interactDown && !this.padInteract) {
        this.padInteract = true;
        if (!this.interact) {
          this.interact = true;
          this.actionQueue.push('interact');
        }
      } else if (!interactDown && this.padInteract) {
        this.padInteract = false;
        if (this.interact) {
          this.interact = false;
          this.actionQueue.push('interactStop');
        }
      }

      return {
        mx,
        mz,
        sprint: pad.buttons[10]?.pressed === true,
        crouch: pad.buttons[11]?.pressed === true,
        aim: pad.buttons[6]?.pressed === true,
      };
    }
    return null;
  }

  /** Reads the current frame's intent and drains queued discrete actions. */
  sample(): InputSnapshot {
    let mx = 0;
    let mz = 0;
    if (this.enabled) {
      if (this.any(KEY_BINDINGS.right)) mx += 1;
      if (this.any(KEY_BINDINGS.left)) mx -= 1;
      if (this.any(KEY_BINDINGS.forward)) mz += 1;
      if (this.any(KEY_BINDINGS.back)) mz -= 1;
    }

    let sprint = this.enabled && this.any(KEY_BINDINGS.sprint);
    let crouch = this.enabled && this.any(KEY_BINDINGS.crouch);
    const vault = this.enabled && this.any(KEY_BINDINGS.vault);

    const pad = this.enabled ? this.pollGamepad() : null;
    if (pad) {
      if (Math.abs(pad.mx) > Math.abs(mx)) mx = pad.mx;
      if (Math.abs(pad.mz) > Math.abs(mz)) mz = pad.mz;
      sprint = sprint || pad.sprint;
      crouch = crouch || pad.crouch;
      if (pad.aim) this.aimHeld = true;
      else if (!this.mouseAimHeld) this.aimHeld = false;
    }

    const actions = this.actionQueue.slice();
    this.actionQueue.length = 0;

    return {
      mx,
      mz,
      sprint,
      crouch,
      vault,
      aim: this.enabled && this.aimHeld,
      yaw: this.yawValue,
      pitch: this.pitchValue,
      actions,
      interactHeld: this.interact,
      pointerLocked: this.locked,
    };
  }
}

/** Human-readable control reference shared by the tutorial and pause screens. */
export const CONTROL_REFERENCE: { keys: string; action: string }[] = [
  { keys: 'W A S D', action: 'Move' },
  { keys: 'Mouse', action: 'Look / aim' },
  { keys: 'Shift', action: 'Sprint' },
  { keys: 'Ctrl / C', action: 'Crouch' },
  { keys: 'Space', action: 'Vault' },
  { keys: 'E', action: 'Interact (hold)' },
  { keys: 'Left click', action: 'Blade, or fire crossbow while aiming / throw stone' },
  { keys: 'Right click', action: 'Hold to aim crossbow / place ward' },
  { keys: 'Q', action: 'Tracking pulse / Echo decoy' },
  { keys: 'F', action: 'Snare / Veil smoke' },
  { keys: 'R', action: 'Reload crossbow' },
  { keys: 'Esc', action: 'Pause / release cursor' },
];
