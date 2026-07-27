/**
 * The UI system: one root element, one screen visible at a time, plus three
 * always-on overlay layers (match countdown, opponent presence, toast).
 *
 * Screens that are not active get the `hidden` attribute, which removes them
 * from the accessibility tree and from tab order — visually hiding them would
 * leave a screen reader wandering through eleven dead menus.
 *
 * Nothing here reads or mutates game state; it forwards intent to `UiActions`
 * and renders what it is handed.
 */

import type { HudState, ScreenName, GameSettings, UiActions, UiSystem } from '../contracts.js';
import { DEFAULT_SETTINGS } from '../contracts.js';
import type { MatchResult, Role, RoomView } from '../../shared/types.js';
import { createHud } from './hud.js';
import {
  Listeners,
  createBootScreen,
  createConnectingScreen,
  createCreditsScreen,
  createDisconnectedScreen,
  createLobbyScreen,
  createPauseScreen,
  createResultsScreen,
  createRoleRevealScreen,
  createTitleScreen,
  createTutorialScreen,
  type ScreenContext,
} from './screens.js';

const SCREEN_NAMES: ScreenName[] = [
  'boot',
  'title',
  'connecting',
  'lobby',
  'roleReveal',
  'tutorial',
  'match',
  'pause',
  'results',
  'disconnected',
  'credits',
];

/** Screens that keep the HUD on-screen underneath. */
const HUD_SCREENS = new Set<ScreenName>(['match', 'pause']);

const TOAST_MS = 1800;

/** Used until `setActions()` arrives so an early click can never throw. */
const NOOP_ACTIONS: UiActions = {
  createRoom: () => {},
  joinRoom: () => {},
  setReady: () => {},
  addBot: () => {},
  leaveRoom: () => {},
  rematch: () => {},
  returnToLobby: () => {},
  dismissTutorial: () => {},
  resume: () => {},
  quitToTitle: () => {},
  updateSettings: () => {},
  requestPointerLock: () => {},
  openCredits: () => {},
  closeCredits: () => {},
};

const OVERLAY_MARKUP = `
<div class="countdown" data-el="countdown" hidden>
  <span class="countdown-ring" aria-hidden="true"></span>
  <p class="countdown-num tnum" data-el="countdownNum" role="status">0</p>
</div>

<div class="presence" data-el="presence" role="status" hidden>
  <span class="presence-dot" aria-hidden="true"></span>
  <span class="presence-text">
    <b data-el="presenceName"></b>
    <span data-el="presenceNote"></span>
  </span>
</div>

<div class="ui-toast" data-el="toast" role="status" hidden><span data-el="toastText"></span></div>`;

function el<T extends HTMLElement>(root: ParentNode, name: string): T {
  const found = root.querySelector<T>(`[data-el="${name}"]`);
  if (!found) throw new Error(`Ui: missing [data-el="${name}"]`);
  return found;
}

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

export function createUi(mount: HTMLElement): UiSystem {
  const root = document.createElement('div');
  root.className = 'ui-root';
  root.dataset.screen = 'boot';

  const listeners = new Listeners();

  let actions: UiActions = NOOP_ACTIONS;
  let current: ScreenName = 'boot';
  let creditsReturn: ScreenName = 'title';
  let settings: GameSettings = { ...DEFAULT_SETTINGS };
  let lastReducedMotion = settings.reducedMotion;
  let lastHighContrast = settings.highContrastPrompts;

  const ctx: ScreenContext = {
    actions: () => actions,
    show: (name) => showScreen(name),
    listeners,
  };

  const boot = createBootScreen();
  const title = createTitleScreen(ctx);
  const connecting = createConnectingScreen();
  const lobby = createLobbyScreen(ctx);
  const roleReveal = createRoleRevealScreen();
  const tutorial = createTutorialScreen(ctx);
  const pause = createPauseScreen(ctx);
  const results = createResultsScreen(ctx);
  const disconnected = createDisconnectedScreen(ctx);
  const credits = createCreditsScreen(ctx, () => closeCredits());
  const hud = createHud();

  const elements: Record<ScreenName, HTMLElement> = {
    boot: boot.el,
    title: title.el,
    connecting: connecting.el,
    lobby: lobby.el,
    roleReveal: roleReveal.el,
    tutorial: tutorial.el,
    match: hud.el,
    pause: pause.el,
    results: results.el,
    disconnected: disconnected.el,
    credits: credits.el,
  };

  const focusers: Partial<Record<ScreenName, () => void>> = {
    title: () => title.focusFirst(),
    lobby: () => lobby.focusFirst(),
    tutorial: () => tutorial.focusFirst(),
    pause: () => pause.focusFirst(),
    results: () => results.focusFirst(),
    disconnected: () => disconnected.focusFirst(),
    credits: () => credits.focusFirst(),
  };

  // The HUD lives outside the screen stack so it can stay visible behind the
  // pause menu; every other screen is a sibling in DOM order.
  root.appendChild(hud.el);
  for (const name of SCREEN_NAMES) {
    if (name === 'match') continue;
    root.appendChild(elements[name]);
  }

  const overlays = document.createElement('div');
  overlays.className = 'ui-overlays';
  overlays.innerHTML = OVERLAY_MARKUP;
  root.appendChild(overlays);

  const countdownEl = el(overlays, 'countdown');
  const countdownNum = el(overlays, 'countdownNum');
  const presenceEl = el(overlays, 'presence');
  const presenceName = el(overlays, 'presenceName');
  const presenceNote = el(overlays, 'presenceNote');
  const toastEl = el(overlays, 'toast');
  const toastText = el(overlays, 'toastText');

  hud.el.hidden = true;
  boot.el.hidden = false;

  // -------------------------------------------------------------------------
  // Presence pill + animation pump
  // -------------------------------------------------------------------------

  let presence: { present: boolean; name: string; graceSeconds: number } | null = null;
  let presenceEndsAt = 0;
  let presenceShown = -1;
  let raf = 0;

  function presenceActive(): boolean {
    return presence !== null && !presence.present && presenceEndsAt > performance.now();
  }

  function needsPump(): boolean {
    return current === 'roleReveal' || current === 'disconnected' || presenceActive();
  }

  function pump(): void {
    raf = 0;
    const now = performance.now();
    if (current === 'roleReveal') roleReveal.tick(now);
    if (current === 'disconnected') disconnected.tick(now);
    updatePresence(now);
    ensurePump();
  }

  function ensurePump(): void {
    if (raf === 0 && needsPump()) raf = window.requestAnimationFrame(pump);
  }

  function updatePresence(now: number): void {
    const active = presenceActive() && current !== 'disconnected';
    if (presenceEl.hidden !== !active) presenceEl.hidden = !active;
    if (!active) {
      presenceShown = -1;
      return;
    }
    const remaining = Math.max(0, Math.ceil((presenceEndsAt - now) / 1000));
    if (remaining === presenceShown) return;
    presenceShown = remaining;
    setText(presenceName, presence?.name ?? 'Opponent');
    setText(presenceNote, `reconnecting — ${remaining}s left`);
  }

  // -------------------------------------------------------------------------
  // Screen switching
  // -------------------------------------------------------------------------

  function showScreen(name: ScreenName): void {
    const from = current;
    if (name === 'tutorial') tutorial.setReturnToTitle(from === 'title');
    if (name === 'credits' && from !== 'credits') creditsReturn = from;
    current = name;
    root.dataset.screen = name;

    for (const key of SCREEN_NAMES) {
      if (key === 'match') continue;
      const node = elements[key];
      const shouldHide = key !== name;
      if (node.hidden !== shouldHide) node.hidden = shouldHide;
    }
    const hudHidden = !HUD_SCREENS.has(name);
    if (hud.el.hidden !== hudHidden) hud.el.hidden = hudHidden;

    if (name === 'match') {
      // Hand the keyboard back to the game; a focused menu button would eat
      // WASD and the pointer-lock request.
      const active = document.activeElement;
      if (active instanceof HTMLElement && root.contains(active)) active.blur();
    } else {
      // Always start a screen at its top. `focusFirst` uses `preventScroll` so
      // focusing the primary action cannot scroll the headline out of view.
      elements[name].scrollTop = 0;
      focusers[name]?.();
    }
    ensurePump();
  }

  function closeCredits(): void {
    const back = creditsReturn === 'credits' ? 'title' : creditsReturn;
    showScreen(back);
    actions.closeCredits();
  }

  // -------------------------------------------------------------------------
  // Escape handling for the two screens the app shell does not own
  // -------------------------------------------------------------------------

  listeners.on(window, 'keydown', ((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== 'Escape') return;
    if (current === 'credits') {
      event.preventDefault();
      event.stopPropagation();
      closeCredits();
      return;
    }
    if (current === 'title' && title.closeJoin()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }) as EventListener);

  // -------------------------------------------------------------------------
  // Toast (out-of-match feedback; in-match notices live in the HUD)
  // -------------------------------------------------------------------------

  let toastTimer: number | null = null;

  function showToast(text: string, tone: 'good' | 'bad' | 'neutral'): void {
    setText(toastText, text);
    toastEl.dataset.tone = tone;
    toastEl.hidden = false;
    toastEl.classList.remove('is-in');
    void toastEl.offsetWidth;
    toastEl.classList.add('is-in');
    listeners.clearTimer(toastTimer);
    toastTimer = listeners.after(TOAST_MS, () => {
      toastEl.hidden = true;
      toastTimer = null;
    });
  }

  // -------------------------------------------------------------------------
  // Settings side effects shared by every surface
  // -------------------------------------------------------------------------

  function applySettingFlags(next: GameSettings): void {
    if (next.reducedMotion !== lastReducedMotion) {
      lastReducedMotion = next.reducedMotion;
      root.classList.toggle('reduce-motion', next.reducedMotion);
    }
    if (next.highContrastPrompts !== lastHighContrast) {
      lastHighContrast = next.highContrastPrompts;
      root.classList.toggle('high-contrast', next.highContrastPrompts);
    }
  }

  pause.setSettings(settings);
  applySettingFlags(settings);
  mount.appendChild(root);

  // -------------------------------------------------------------------------

  const system: UiSystem = {
    root,

    setActions(next: UiActions) {
      actions = next;
    },

    showScreen,

    get currentScreen(): ScreenName {
      return current;
    },

    setRoom(view: RoomView | null) {
      lobby.setRoom(view);
    },

    setConnectionError(message: string | null) {
      title.setError(message);
    },

    setStatus(message: string | null) {
      connecting.setStatus(message);
    },

    showRoleReveal(payload) {
      roleReveal.show(payload);
      showScreen('roleReveal');
    },

    setCountdown(seconds: number | null) {
      if (seconds === null || seconds < 0) {
        if (!countdownEl.hidden) countdownEl.hidden = true;
        return;
      }
      const whole = Math.ceil(seconds);
      setText(countdownNum, whole <= 0 ? 'GO' : String(whole));
      countdownEl.classList.toggle('is-go', whole <= 0);
      if (countdownEl.hidden) countdownEl.hidden = false;
    },

    updateHud(state: HudState) {
      // Compare by value, not identity: the app may hand back the same object
      // with mutated fields.
      applySettingFlags(state.settings);
      hud.update(state);
    },

    showResults(result: MatchResult, yourRole: Role) {
      results.show(result, yourRole);
      showScreen('results');
    },

    setSettings(next: GameSettings) {
      settings = next;
      pause.setSettings(next);
      applySettingFlags(next);
    },

    setOpponentPresence(state) {
      presence = state;
      if (state && !state.present) {
        presenceEndsAt = performance.now() + Math.max(0, state.graceSeconds) * 1000;
      } else {
        presenceEndsAt = 0;
      }
      presenceShown = -1;
      disconnected.setPresence(state);
      updatePresence(performance.now());
      ensurePump();
    },

    flashNotice(text: string, tone: 'good' | 'bad' | 'neutral') {
      if (HUD_SCREENS.has(current)) hud.flashNotice(text, tone);
      else showToast(text, tone);
    },

    dispose() {
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      listeners.dispose();
      hud.dispose();
      root.remove();
    },
  };

  return system;
}
