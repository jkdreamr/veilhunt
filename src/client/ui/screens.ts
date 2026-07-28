/**
 * Every full-screen surface outside the match HUD.
 *
 * Each factory returns a small controller: an element plus the handful of
 * setters `Ui.ts` needs. Screens never touch game state — they only call into
 * `UiActions`, which is late-bound through `ScreenContext.actions()` because
 * `setActions()` arrives after `createUi()`.
 *
 * Safety rule: anything that can come from the network — player names, room
 * codes, contract text, result reasons — is written with `textContent`. The
 * `innerHTML` calls in this file are all static author-written templates.
 */

import type { GameSettings, QualityLevel, ScreenName, UiActions } from '../contracts.js';
import type { MatchResult, MatchStats, Role, RoomView } from '../../shared/types.js';
import {
  CROSSBOW,
  MATCH_DURATION,
  MAX_NAME_LENGTH,
  ROOM_CODE_LENGTH,
  SEALS_REQUIRED,
  SNARE,
  WARD,
} from '../../shared/constants.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Tracks every listener and timer so `dispose()` can unwind them all. */
export class Listeners {
  private entries: { target: EventTarget; type: string; fn: EventListener; opts?: AddEventListenerOptions }[] = [];
  private timers = new Set<number>();

  on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    fn: (event: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  on(target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void;
  on(target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.entries.push({ target, type, fn, opts });
  }

  /** A self-deregistering timeout, so nothing survives `dispose()`. */
  after(ms: number, fn: () => void): number {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  clearTimer(id: number | null): void {
    if (id === null) return;
    window.clearTimeout(id);
    this.timers.delete(id);
  }

  dispose(): void {
    for (const e of this.entries) e.target.removeEventListener(e.type, e.fn, e.opts);
    this.entries = [];
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
  }
}

export interface ScreenContext {
  /** Late-bound: `setActions()` runs after the screens are built. */
  actions(): UiActions;
  show(name: ScreenName): void;
  listeners: Listeners;
}

function el<T extends HTMLElement>(root: ParentNode, name: string): T {
  const found = root.querySelector<T>(`[data-el="${name}"]`);
  if (!found) throw new Error(`screens: missing [data-el="${name}"]`);
  return found;
}

function screenRoot(name: ScreenName, className: string, markup: string): HTMLElement {
  const section = document.createElement('section');
  section.className = `screen ${className}`;
  section.dataset.screen = name;
  section.hidden = true;
  section.innerHTML = markup;
  return section;
}

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/**
 * Focus without scrolling. Screens are entered at their top; letting the
 * browser scroll a primary action into view would push the headline off-screen
 * on short windows.
 */
function focusQuietly(node: HTMLElement): void {
  node.focus({ preventScroll: true });
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return '--';
  return `${Math.round((part / whole) * 100)}%`;
}

function roleWord(role: Role): string {
  return role === 'hunter' ? 'HUNTER' : 'RUNNER';
}

const ROLE_THESIS: Record<Role, string> = {
  hunter: 'Read the noise, cut the angle, end the ritual before it finishes.',
  runner: 'Light three seals, stay unseen, and be gone through the gate.',
};

/** Static icon markup, never combined with dynamic text. */
function ico(body: string): string {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const GLYPH = {
  goal: ico('<path d="M6 21V4h11l-1.6 3.4L17 11H6"/><circle cx="6" cy="21" r="1"/>'),
  kit: ico('<path d="M4 8.5h16v11H4z"/><path d="M9 8.5V6a3 3 0 0 1 6 0v2.5"/><path d="M4 13.5h16"/>'),
  eye: ico('<path d="M2.6 12S6.6 5.6 12 5.6 21.4 12 21.4 12 17.4 18.4 12 18.4 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  clock: ico('<circle cx="12" cy="12" r="8.6"/><path d="M12 7v5.2l3.2 2"/>'),
  wax: ico('<circle cx="12" cy="12" r="7"/><path d="M9 12h6M12 9v6"/>'),
} as const;

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

export interface BootScreen {
  readonly el: HTMLElement;
}

export function createBootScreen(): BootScreen {
  return {
    el: screenRoot(
      'boot',
      'screen--boot',
      `<main class="boot">
         <p class="wordmark-title wordmark-title--small"><span>VEIL</span><span>HUNT</span></p>
         <p class="boot-note">Waking the ruins&hellip;</p>
       </main>`,
    ),
  };
}

// ---------------------------------------------------------------------------
// title
// ---------------------------------------------------------------------------

const NAME_STORAGE_KEY = 'veilhunt.name';

function loadName(): string {
  try {
    return (window.localStorage.getItem(NAME_STORAGE_KEY) ?? '').slice(0, MAX_NAME_LENGTH);
  } catch {
    return '';
  }
}

function saveName(value: string): void {
  try {
    window.localStorage.setItem(NAME_STORAGE_KEY, value.slice(0, MAX_NAME_LENGTH));
  } catch {
    /* Private browsing: the name simply will not persist. */
  }
}

export interface TitleScreen {
  readonly el: HTMLElement;
  setError(message: string | null): void;
  name(): string;
  focusFirst(): void;
  /** True while the join-code panel is open, so Escape can close it. */
  closeJoin(): boolean;
}

export function createTitleScreen(ctx: ScreenContext): TitleScreen {
  const root = screenRoot(
    'title',
    'screen--title',
    `<div class="moonfield" aria-hidden="true"><i></i><i></i><i></i></div>
     <main class="menu menu--title">
       <header class="wordmark">
         <h1 class="wordmark-title"><span>VEIL</span><span>HUNT</span></h1>
         <p class="rule" aria-hidden="true"></p>
         <p class="wordmark-sub">One hunts. One runs. Three seals and a gate, in seven minutes.</p>
       </header>

       <div class="alert alert--bad" data-el="error" role="alert" hidden>
         <span class="alert-dot" aria-hidden="true"></span>
         <div class="alert-body">
           <strong class="alert-title">Cannot reach the server</strong>
           <p class="alert-text" data-el="errorText"></p>
           <p class="alert-hint">Make sure the game server is running, then try again. Everything else here still works.</p>
         </div>
       </div>

       <form class="panel entry" data-el="createForm" novalidate>
         <div class="field">
           <label class="field-label" for="veil-name">Your name</label>
           <input class="input" data-el="name" id="veil-name" name="name" type="text"
                  maxlength="${MAX_NAME_LENGTH}" autocomplete="nickname" autocapitalize="off"
                  spellcheck="false" placeholder="Wanderer" aria-describedby="veil-name-note" />
           <p class="field-note" id="veil-name-note">Up to ${MAX_NAME_LENGTH} characters. Kept on this device.</p>
         </div>
         <div class="entry-actions">
           <button class="btn btn--primary" type="submit" data-el="create">Create Room</button>
           <button class="btn" type="button" data-el="joinToggle" aria-expanded="false" aria-controls="veil-join">Join Room</button>
         </div>
       </form>

       <form class="panel entry entry--join" data-el="joinForm" id="veil-join" hidden novalidate>
         <div class="field">
           <label class="field-label" for="veil-code">Room code</label>
           <input class="input input--code" data-el="code" id="veil-code" name="code" type="text"
                  maxlength="${ROOM_CODE_LENGTH}" autocomplete="off" autocapitalize="characters"
                  spellcheck="false" aria-describedby="veil-code-note" placeholder="${'-'.repeat(ROOM_CODE_LENGTH)}" />
           <p class="field-note" id="veil-code-note">${ROOM_CODE_LENGTH} characters. It joins as soon as the code is complete.</p>
         </div>
         <div class="entry-actions">
           <button class="btn btn--primary" type="submit" data-el="joinGo">Enter Room</button>
           <button class="btn btn--quiet" type="button" data-el="joinCancel">Cancel</button>
         </div>
       </form>

       <nav class="menu-links" aria-label="More">
         <button class="link" type="button" data-el="howto">How to Play</button>
         <span class="link-sep" aria-hidden="true"></span>
         <button class="link" type="button" data-el="credits">Credits</button>
       </nav>
     </main>`,
  );

  const errorBox = el(root, 'error');
  const errorText = el(root, 'errorText');
  const createForm = el<HTMLFormElement>(root, 'createForm');
  const joinForm = el<HTMLFormElement>(root, 'joinForm');
  const nameInput = el<HTMLInputElement>(root, 'name');
  const codeInput = el<HTMLInputElement>(root, 'code');
  const joinToggle = el<HTMLButtonElement>(root, 'joinToggle');

  nameInput.value = loadName();

  const name = (): string => {
    const raw = nameInput.value.trim().slice(0, MAX_NAME_LENGTH);
    return raw.length > 0 ? raw : 'Wanderer';
  };

  const setJoinOpen = (open: boolean): void => {
    joinForm.hidden = !open;
    joinToggle.setAttribute('aria-expanded', String(open));
    joinToggle.classList.toggle('is-active', open);
    if (open) {
      codeInput.focus();
      codeInput.select();
    }
  };

  const submitJoin = (): void => {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== ROOM_CODE_LENGTH) {
      codeInput.focus();
      root.classList.remove('is-shaking');
      void root.offsetWidth;
      root.classList.add('is-shaking');
      return;
    }
    saveName(nameInput.value.trim());
    ctx.actions().joinRoom(name(), code);
  };

  ctx.listeners.on(nameInput, 'change', () => saveName(nameInput.value.trim()));

  ctx.listeners.on(createForm, 'submit', (event) => {
    event.preventDefault();
    saveName(nameInput.value.trim());
    ctx.actions().createRoom(name());
  });

  ctx.listeners.on(joinToggle, 'click', () => setJoinOpen(joinForm.hidden));
  ctx.listeners.on(el<HTMLButtonElement>(root, 'joinCancel'), 'click', () => {
    setJoinOpen(false);
    joinToggle.focus();
  });

  ctx.listeners.on(joinForm, 'submit', (event) => {
    event.preventDefault();
    submitJoin();
  });

  ctx.listeners.on(codeInput, 'input', () => {
    // Uppercase and strip anything that cannot appear in a room code, keeping
    // the caret at the end (codes are short enough that this never fights the
    // user mid-edit).
    const cleaned = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
    if (codeInput.value !== cleaned) codeInput.value = cleaned;
    if (cleaned.length === ROOM_CODE_LENGTH) submitJoin();
  });

  ctx.listeners.on(el<HTMLButtonElement>(root, 'howto'), 'click', () => ctx.show('tutorial'));
  ctx.listeners.on(el<HTMLButtonElement>(root, 'credits'), 'click', () => {
    ctx.show('credits');
    ctx.actions().openCredits();
  });

  return {
    el: root,
    setError(message) {
      const text = message ?? '';
      errorBox.hidden = text.length === 0;
      setText(errorText, text);
    },
    name,
    focusFirst() {
      focusQuietly(nameInput);
      if (nameInput.value.length > 0) nameInput.select();
    },
    closeJoin() {
      if (joinForm.hidden) return false;
      setJoinOpen(false);
      joinToggle.focus();
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// connecting
// ---------------------------------------------------------------------------

export interface ConnectingScreen {
  readonly el: HTMLElement;
  setStatus(message: string | null): void;
}

export function createConnectingScreen(): ConnectingScreen {
  const root = screenRoot(
    'connecting',
    'screen--connecting',
    `<main class="menu menu--slim">
       <div class="spinner" aria-hidden="true"><i></i><i></i></div>
       <p class="connect-status" data-el="status" role="status" aria-live="polite">Reaching the ruins&hellip;</p>
       <p class="hint">This should only take a moment.</p>
     </main>`,
  );
  const status = el(root, 'status');
  return {
    el: root,
    setStatus(message) {
      setText(status, message && message.length > 0 ? message : 'Reaching the ruins…');
    },
  };
}

// ---------------------------------------------------------------------------
// lobby
// ---------------------------------------------------------------------------

export interface LobbyScreen {
  readonly el: HTMLElement;
  setRoom(view: RoomView | null): void;
  focusFirst(): void;
}

interface SlotRefs {
  root: HTMLElement;
  name: HTMLElement;
  role: HTMLElement;
  ready: HTMLElement;
  conn: HTMLElement;
  host: HTMLElement;
}

function buildSlot(index: number): SlotRefs {
  const li = document.createElement('li');
  li.className = 'slot-card';
  li.innerHTML = `
    <span class="slot-index tnum" aria-hidden="true">${index + 1}</span>
    <span class="slot-main">
      <span class="slot-name" data-el="name"></span>
      <span class="slot-tags">
        <span class="tag tag--host" data-el="host" hidden>HOST</span>
        <span class="tag" data-el="role" hidden></span>
      </span>
    </span>
    <span class="slot-state">
      <span class="tag tag--ready" data-el="ready"></span>
      <span class="tag tag--conn" data-el="conn" hidden>RECONNECTING</span>
    </span>`;
  return {
    root: li,
    name: el(li, 'name'),
    role: el(li, 'role'),
    ready: el(li, 'ready'),
    conn: el(li, 'conn'),
    host: el(li, 'host'),
  };
}

export function createLobbyScreen(ctx: ScreenContext): LobbyScreen {
  const root = screenRoot(
    'lobby',
    'screen--lobby',
    `<main class="menu">
       <header class="lobby-head">
         <p class="eyebrow">Room code</p>
         <div class="code-row">
           <p class="roomcode tnum" data-el="code" aria-live="polite">${'-'.repeat(ROOM_CODE_LENGTH)}</p>
           <button class="btn btn--ghost" type="button" data-el="copy">Copy</button>
         </div>
         <p class="hint" data-el="share">
           Share this code with your opponent. On the same LAN they can open this
           page on your machine's address and join with it — no account, no server list.
         </p>
       </header>

       <ol class="slots" data-el="slots" aria-label="Players"></ol>

       <div class="lobby-actions">
         <button class="btn btn--primary" type="button" data-el="ready" aria-pressed="false">Ready</button>
         <button class="btn" type="button" data-el="bot" hidden>Add practice bot</button>
         <button class="btn btn--quiet" type="button" data-el="leave">Leave</button>
       </div>
       <p class="lobby-status" data-el="status" role="status" aria-live="polite"></p>
     </main>`,
  );

  const codeEl = el(root, 'code');
  const copyBtn = el<HTMLButtonElement>(root, 'copy');
  const slotsEl = el(root, 'slots');
  const readyBtn = el<HTMLButtonElement>(root, 'ready');
  const botBtn = el<HTMLButtonElement>(root, 'bot');
  const statusEl = el(root, 'status');

  const slots = [buildSlot(0), buildSlot(1)];
  for (const slot of slots) slotsEl.appendChild(slot.root);

  let localReady = false;
  let copyTimer: number | null = null;

  const confirmCopy = (label: string): void => {
    setText(copyBtn, label);
    copyBtn.classList.add('is-done');
    ctx.listeners.clearTimer(copyTimer);
    copyTimer = ctx.listeners.after(1600, () => {
      setText(copyBtn, 'Copy');
      copyBtn.classList.remove('is-done');
      copyTimer = null;
    });
  };

  const copyCode = (): void => {
    const code = codeEl.textContent ?? '';
    if (!code || code.startsWith('-')) return;
    const fallback = (): void => {
      // execCommand is deprecated but remains the only clipboard path on
      // insecure origins, which is exactly the LAN case this game targets.
      const scratch = document.createElement('textarea');
      scratch.value = code;
      scratch.setAttribute('readonly', '');
      scratch.className = 'visually-hidden';
      document.body.appendChild(scratch);
      scratch.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      scratch.remove();
      confirmCopy(ok ? 'Copied' : 'Press Ctrl+C');
      if (!ok) {
        const range = document.createRange();
        range.selectNodeContents(codeEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(() => confirmCopy('Copied'), fallback);
    } else {
      fallback();
    }
  };

  ctx.listeners.on(copyBtn, 'click', copyCode);
  ctx.listeners.on(readyBtn, 'click', () => {
    localReady = !localReady;
    ctx.actions().setReady(localReady);
  });
  ctx.listeners.on(botBtn, 'click', () => ctx.actions().addBot());
  ctx.listeners.on(el<HTMLButtonElement>(root, 'leave'), 'click', () => ctx.actions().leaveRoom());

  return {
    el: root,
    focusFirst() {
      focusQuietly(readyBtn);
    },
    setRoom(view) {
      if (!view) {
        setText(codeEl, '-'.repeat(ROOM_CODE_LENGTH));
        for (const slot of slots) {
          setText(slot.name, 'Empty slot');
          slot.root.classList.add('is-empty');
        }
        return;
      }
      setText(codeEl, view.code);
      const you = view.players.find((p) => p.id === view.youId) ?? null;
      localReady = you?.ready ?? false;
      readyBtn.setAttribute('aria-pressed', String(localReady));
      readyBtn.classList.toggle('is-on', localReady);
      setText(readyBtn, localReady ? 'Ready — waiting' : 'Ready');

      botBtn.hidden = view.players.length !== 1;

      for (let i = 0; i < slots.length; i += 1) {
        const slot = slots[i];
        const player = view.players[i];
        if (!player) {
          slot.root.classList.add('is-empty');
          slot.root.classList.remove('is-you');
          setText(slot.name, 'Waiting for a challenger…');
          setText(slot.ready, 'EMPTY');
          slot.ready.className = 'tag tag--ready is-empty';
          slot.conn.hidden = true;
          slot.host.hidden = true;
          slot.role.hidden = true;
          continue;
        }
        slot.root.classList.remove('is-empty');
        slot.root.classList.toggle('is-you', player.id === view.youId);
        setText(slot.name, player.id === view.youId ? `${player.name} (you)` : player.name);
        slot.host.hidden = !player.isHost;
        slot.role.hidden = player.role === null;
        if (player.role) setText(slot.role, roleWord(player.role));
        setText(slot.ready, player.ready ? 'READY' : 'NOT READY');
        slot.ready.className = `tag tag--ready ${player.ready ? 'is-on' : 'is-off'}`;
        slot.conn.hidden = player.connected;
      }

      const others = view.players.filter((p) => p.id !== view.youId);
      const allReady = view.players.length === 2 && view.players.every((p) => p.ready && p.connected);
      setText(
        statusEl,
        view.players.length < 2
          ? 'Waiting for a second player. Add a practice bot to play solo.'
          : allReady
            ? 'Both ready. The veil is thinning…'
            : others.every((p) => p.ready)
              ? 'Your opponent is ready.'
              : 'Waiting on your opponent to ready up.',
      );
    },
  };
}

// ---------------------------------------------------------------------------
// role reveal
// ---------------------------------------------------------------------------

export interface RoleRevealPayload {
  role: Role;
  opponentName: string;
  round: number;
  seed: number;
  contract: { title: string; description: string } | null;
  duration: number;
}

export interface RoleRevealScreen {
  readonly el: HTMLElement;
  show(payload: RoleRevealPayload): void;
  /** Returns true while the countdown is still running. */
  tick(now: number): boolean;
}

export function createRoleRevealScreen(): RoleRevealScreen {
  const root = screenRoot(
    'roleReveal',
    'screen--reveal',
    `<main class="reveal">
       <p class="eyebrow">Round <span class="tnum" data-el="round">1</span></p>
       <p class="reveal-lead">The veil chooses. You are the</p>
       <h1 class="reveal-role" data-el="role">RUNNER</h1>
       <p class="rule rule--wide" aria-hidden="true"></p>
       <p class="reveal-thesis" data-el="thesis"></p>

       <dl class="reveal-meta">
         <div><dt>Opponent</dt><dd data-el="opponent">—</dd></div>
         <div><dt>Seed</dt><dd class="tnum" data-el="seed">0</dd></div>
       </dl>

       <section class="envelope" data-el="envelope" hidden aria-labelledby="veil-contract-h">
         <header class="envelope-head">
           <span class="wax" aria-hidden="true">${GLYPH.wax}</span>
           <h2 class="envelope-kicker" id="veil-contract-h">Sealed contract</h2>
         </header>
         <p class="envelope-title" data-el="contractTitle"></p>
         <p class="envelope-desc" data-el="contractDesc"></p>
         <p class="envelope-note">${GLYPH.eye} Only you can see this. It is revealed to both players in the tally.</p>
       </section>

       <p class="reveal-count">
         <span class="count-ring" data-el="ring" aria-hidden="true"></span>
         <span class="count-text">Begins in <span class="tnum" data-el="count">0</span>s</span>
       </p>
     </main>`,
  );

  const roleEl = el(root, 'role');
  const thesisEl = el(root, 'thesis');
  const opponentEl = el(root, 'opponent');
  const seedEl = el(root, 'seed');
  const roundEl = el(root, 'round');
  const envelope = el(root, 'envelope');
  const contractTitle = el(root, 'contractTitle');
  const contractDesc = el(root, 'contractDesc');
  const ring = el(root, 'ring');
  const countEl = el(root, 'count');

  let endsAt = 0;
  let duration = 1;
  let lastShown = -1;

  return {
    el: root,
    show(payload) {
      root.classList.toggle('is-hunter', payload.role === 'hunter');
      root.classList.toggle('is-runner', payload.role === 'runner');
      setText(roleEl, roleWord(payload.role));
      setText(thesisEl, ROLE_THESIS[payload.role]);
      setText(opponentEl, payload.opponentName.length > 0 ? payload.opponentName : 'Unknown');
      setText(seedEl, String(payload.seed));
      setText(roundEl, String(payload.round));
      const hasContract = payload.contract !== null;
      envelope.hidden = !hasContract;
      if (payload.contract) {
        setText(contractTitle, payload.contract.title);
        setText(contractDesc, payload.contract.description);
      }
      duration = Math.max(0.5, payload.duration);
      endsAt = performance.now() + duration * 1000;
      lastShown = -1;
    },
    tick(now) {
      const remaining = Math.max(0, (endsAt - now) / 1000);
      const shown = Math.ceil(remaining);
      if (shown !== lastShown) {
        lastShown = shown;
        setText(countEl, String(shown));
      }
      ring.style.setProperty('--p', (1 - remaining / duration).toFixed(3));
      return remaining > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// tutorial
// ---------------------------------------------------------------------------

export interface TutorialScreen {
  readonly el: HTMLElement;
  /** Remembers whether the title screen opened it, so "Got it" goes back. */
  setReturnToTitle(value: boolean): void;
  focusFirst(): void;
}

function kitRow(icon: string, label: string, detail: string): string {
  return `<li class="kit-row"><span class="kit-ico" aria-hidden="true">${icon}</span><span class="kit-body"><b>${label}</b><span>${detail}</span></span></li>`;
}

export function createTutorialScreen(ctx: ScreenContext): TutorialScreen {
  const root = screenRoot(
    'tutorial',
    'screen--tutorial',
    `<main class="menu menu--wide">
       <header class="tut-head">
         <h1 class="section-title">How to Play</h1>
         <p class="hint">${MATCH_DURATION / 60} minutes. ${SEALS_REQUIRED} seals. One way out.</p>
       </header>

       <div class="tut-cols">
         <section class="panel tut-col tut-col--runner">
           <h2 class="tut-role">RUNNER</h2>
           <ul class="kit">
             ${kitRow(GLYPH.goal, 'Objective', `Light ${SEALS_REQUIRED} ritual seals by holding E, then escape through the gate.`)}
             ${kitRow(GLYPH.kit, 'Kit', `Throw Stone (LMB) &middot; Flash Ward &times;${WARD.charges} (RMB) &middot; Echo Decoy (Q) &middot; Veil Smoke (F)`)}
             ${kitRow(GLYPH.eye, 'Stay unseen', 'Crouch in shadow, foliage and hiding spots. Sprinting is loud.')}
             ${kitRow(GLYPH.clock, 'Pressure', 'Two blade hits and you are taken. Wounds slow the ritual.')}
           </ul>
         </section>

         <section class="panel tut-col tut-col--hunter">
           <h2 class="tut-role">HUNTER</h2>
           <ul class="kit">
             ${kitRow(GLYPH.goal, 'Objective', 'Catch the Runner before the seals burn, or simply outlast the clock.')}
             ${kitRow(GLYPH.kit, 'Kit', `Ritual Blade (LMB) &middot; Crossbow &times;${CROSSBOW.maxBolts} (hold RMB to aim, LMB to fire) &middot; Tracking Pulse (Q) &middot; Snare &times;${SNARE.totalCharges} (F)`)}
             ${kitRow(GLYPH.eye, 'Read the ruins', 'Pulse reveals fresh footprints. A marked Runner leaves a trail.')}
             ${kitRow(GLYPH.clock, 'Pressure', 'Every seal lit is ground lost. Guard the gate late.')}
           </ul>
         </section>
       </div>

       <section class="panel tut-controls">
         <h2 class="tut-role">CONTROLS</h2>
         <ul class="keylist" data-el="keys"></ul>
       </section>

       <div class="menu-actions">
         <button class="btn btn--primary" type="button" data-el="got">Got it</button>
       </div>
     </main>`,
  );

  el(root, 'keys').appendChild(buildKeyList());

  const got = el<HTMLButtonElement>(root, 'got');
  let returnToTitle = false;

  ctx.listeners.on(got, 'click', () => {
    // Order matters: hand control back to the app last so its own reaction to
    // `dismissTutorial()` always wins over our local navigation.
    if (returnToTitle) ctx.show('title');
    ctx.actions().dismissTutorial();
  });

  return {
    el: root,
    setReturnToTitle(value) {
      returnToTitle = value;
    },
    focusFirst() {
      focusQuietly(got);
    },
  };
}

const CONTROLS: [string, string][] = [
  ['W A S D', 'Move'],
  ['Shift', 'Sprint (drains stamina)'],
  ['Ctrl / C', 'Crouch — quieter, harder to see'],
  ['Space', 'Vault low obstacles'],
  ['Hold E', 'Interact / channel a ritual'],
  ['LMB', 'Ritual Blade — or fire the crossbow while aiming / Throw Stone'],
  ['RMB', 'Hold to aim the crossbow / Place a Flash Ward'],
  ['Q', 'Ability — Tracking Pulse / Echo Decoy'],
  ['F', 'Ability — Snare / Veil Smoke'],
  ['R', 'Reload the crossbow'],
  ['Space (mash)', 'Struggle free of a snare'],
  ['Esc', 'Pause and settings'],
];

function buildKeyList(): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const [key, label] of CONTROLS) {
    const li = document.createElement('li');
    li.className = 'keylist-row';
    li.innerHTML = '<kbd class="cap"></kbd><span></span>';
    setText(li.querySelector('kbd') as HTMLElement, key);
    setText(li.querySelector('span') as HTMLElement, label);
    frag.appendChild(li);
  }
  return frag;
}

// ---------------------------------------------------------------------------
// pause + settings
// ---------------------------------------------------------------------------

type NumericSetting = 'masterVolume' | 'ambienceVolume' | 'effectsVolume' | 'mouseSensitivity';
type ToggleSetting = 'muted' | 'invertY' | 'reducedShake' | 'reducedMotion' | 'showSoundIndicators' | 'highContrastPrompts';

interface RangeSpec {
  kind: 'range';
  key: NumericSetting;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

interface ToggleSpec {
  kind: 'toggle';
  key: ToggleSetting;
  label: string;
  hint: string;
}

interface SelectSpec {
  kind: 'select';
  key: 'quality';
  label: string;
  hint: string;
  options: { value: QualityLevel; label: string }[];
}

type SettingSpec = RangeSpec | ToggleSpec | SelectSpec;

const asPercent = (v: number): string => `${Math.round(v * 100)}%`;
const asMultiplier = (v: number): string => `${v.toFixed(2)}×`;

const SETTING_GROUPS: { title: string; items: SettingSpec[] }[] = [
  {
    title: 'Audio',
    items: [
      { kind: 'range', key: 'masterVolume', label: 'Master volume', hint: 'Overall loudness.', min: 0, max: 1, step: 0.01, format: asPercent },
      { kind: 'range', key: 'ambienceVolume', label: 'Ambience', hint: 'Wind, crows, the ruins themselves.', min: 0, max: 1, step: 0.01, format: asPercent },
      { kind: 'range', key: 'effectsVolume', label: 'Effects', hint: 'Footsteps, blades, rituals.', min: 0, max: 1, step: 0.01, format: asPercent },
      { kind: 'toggle', key: 'muted', label: 'Mute all sound', hint: 'Turn on visual sound indicators below to keep playing silently.' },
    ],
  },
  {
    title: 'Controls',
    items: [
      { kind: 'range', key: 'mouseSensitivity', label: 'Mouse sensitivity', hint: 'Look speed multiplier.', min: 0.2, max: 3, step: 0.05, format: asMultiplier },
      { kind: 'toggle', key: 'invertY', label: 'Invert vertical look', hint: 'Push the mouse forward to look up.' },
    ],
  },
  {
    title: 'Comfort',
    items: [
      { kind: 'toggle', key: 'reducedShake', label: 'Reduced camera shake', hint: 'Damps impact and sprint camera motion.' },
      { kind: 'toggle', key: 'reducedMotion', label: 'Reduced motion', hint: 'Removes HUD pulsing and non-essential animation.' },
    ],
  },
  {
    title: 'Display & accessibility',
    items: [
      {
        kind: 'select',
        key: 'quality',
        label: 'Graphics quality',
        hint: 'Lower settings trade detail for frame rate.',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
      { kind: 'toggle', key: 'showSoundIndicators', label: 'Visual sound indicators', hint: 'Directional arcs at the screen edge show where a sound came from.' },
      { kind: 'toggle', key: 'highContrastPrompts', label: 'High-contrast prompts', hint: 'Solid backing plates behind interaction prompts.' },
    ],
  },
];

export interface PauseScreen {
  readonly el: HTMLElement;
  setSettings(settings: GameSettings): void;
  focusFirst(): void;
}

function numericPatch(key: NumericSetting, value: number): Partial<GameSettings> {
  return { [key]: value } as Partial<GameSettings>;
}

function togglePatch(key: ToggleSetting, value: boolean): Partial<GameSettings> {
  return { [key]: value } as Partial<GameSettings>;
}

export function createPauseScreen(ctx: ScreenContext): PauseScreen {
  const root = screenRoot(
    'pause',
    'screen--pause',
    `<div class="scrim" aria-hidden="true"></div>
     <main class="menu menu--wide pause">
       <header class="pause-head">
         <h1 class="section-title">Paused</h1>
         <button class="btn btn--primary" type="button" data-el="resume">Resume</button>
       </header>

       <div class="pause-body">
         <section class="panel settings" aria-labelledby="veil-settings-h">
           <h2 class="panel-title" id="veil-settings-h">Settings</h2>
           <div data-el="groups"></div>
         </section>

         <section class="panel" aria-labelledby="veil-controls-h">
           <h2 class="panel-title" id="veil-controls-h">Controls</h2>
           <ul class="keylist keylist--compact" data-el="keys"></ul>
         </section>
       </div>

       <div class="menu-actions menu-actions--split">
         <button class="btn btn--quiet btn--danger" type="button" data-el="quit">Quit to title</button>
         <p class="hint">Settings apply immediately and are kept for the rest of the session.</p>
       </div>
     </main>`,
  );

  el(root, 'keys').appendChild(buildKeyList());

  const groups = el(root, 'groups');
  const ranges = new Map<NumericSetting, { input: HTMLInputElement; out: HTMLElement; spec: RangeSpec }>();
  const toggles = new Map<ToggleSetting, HTMLInputElement>();
  let qualitySelect: HTMLSelectElement | null = null;
  /** Guards against `setSettings()` echoing back out as `updateSettings()`. */
  let applying = false;

  let uid = 0;
  for (const group of SETTING_GROUPS) {
    const section = document.createElement('div');
    section.className = 'setting-group';
    const heading = document.createElement('h3');
    heading.className = 'setting-group-title';
    setText(heading, group.title);
    section.appendChild(heading);

    for (const spec of group.items) {
      uid += 1;
      const id = `veil-set-${uid}`;
      const hintId = `${id}-hint`;
      const row = document.createElement('div');
      row.className = `setting setting--${spec.kind}`;

      if (spec.kind === 'range') {
        row.innerHTML = `
          <label class="setting-label"></label>
          <span class="setting-value tnum" data-el="out"></span>
          <input class="range" type="range" data-el="input" />
          <p class="setting-hint"></p>`;
        const label = row.querySelector('label') as HTMLLabelElement;
        const input = el<HTMLInputElement>(row, 'input');
        const out = el(row, 'out');
        input.id = id;
        label.htmlFor = id;
        (row.querySelector('.setting-hint') as HTMLElement).id = hintId;
        input.setAttribute('aria-describedby', hintId);
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);
        setText(label, spec.label);
        setText(row.querySelector('.setting-hint') as HTMLElement, spec.hint);
        ctx.listeners.on(input, 'input', () => {
          const value = Number(input.value);
          setText(out, spec.format(value));
          if (!applying) ctx.actions().updateSettings(numericPatch(spec.key, value));
        });
        ranges.set(spec.key, { input, out, spec });
      } else if (spec.kind === 'toggle') {
        row.innerHTML = `
          <input class="switch" type="checkbox" data-el="input" />
          <label class="setting-label"></label>
          <p class="setting-hint"></p>`;
        const input = el<HTMLInputElement>(row, 'input');
        const label = row.querySelector('label') as HTMLLabelElement;
        input.id = id;
        label.htmlFor = id;
        const hint = row.querySelector('.setting-hint') as HTMLElement;
        hint.id = hintId;
        input.setAttribute('aria-describedby', hintId);
        setText(label, spec.label);
        setText(hint, spec.hint);
        ctx.listeners.on(input, 'change', () => {
          if (!applying) ctx.actions().updateSettings(togglePatch(spec.key, input.checked));
        });
        toggles.set(spec.key, input);
      } else {
        row.innerHTML = `
          <label class="setting-label"></label>
          <select class="select" data-el="input"></select>
          <p class="setting-hint"></p>`;
        const select = el<HTMLSelectElement>(row, 'input');
        const label = row.querySelector('label') as HTMLLabelElement;
        select.id = id;
        label.htmlFor = id;
        const hint = row.querySelector('.setting-hint') as HTMLElement;
        hint.id = hintId;
        select.setAttribute('aria-describedby', hintId);
        setText(label, spec.label);
        setText(hint, spec.hint);
        for (const option of spec.options) {
          const opt = document.createElement('option');
          opt.value = option.value;
          setText(opt, option.label);
          select.appendChild(opt);
        }
        ctx.listeners.on(select, 'change', () => {
          if (!applying) ctx.actions().updateSettings({ quality: select.value as QualityLevel });
        });
        qualitySelect = select;
      }
      section.appendChild(row);
    }
    groups.appendChild(section);
  }

  const resume = el<HTMLButtonElement>(root, 'resume');
  ctx.listeners.on(resume, 'click', () => ctx.actions().resume());
  ctx.listeners.on(el<HTMLButtonElement>(root, 'quit'), 'click', () => ctx.actions().quitToTitle());

  return {
    el: root,
    focusFirst() {
      focusQuietly(resume);
    },
    setSettings(settings) {
      applying = true;
      for (const [key, entry] of ranges) {
        const value = settings[key];
        entry.input.value = String(value);
        setText(entry.out, entry.spec.format(value));
      }
      for (const [key, input] of toggles) input.checked = settings[key];
      if (qualitySelect) qualitySelect.value = settings.quality;
      applying = false;
    },
  };
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

export interface ResultsScreen {
  readonly el: HTMLElement;
  show(result: MatchResult, yourRole: Role): void;
  focusFirst(): void;
}

interface StatRow {
  label: string;
  value: string;
  detail?: string;
}

function buildStatRows(stats: MatchStats): StatRow[] {
  return [
    { label: 'Match length', value: clock(stats.durationPlayed) },
    { label: 'Seals lit', value: `${stats.sealsActivated} / ${SEALS_REQUIRED}` },
    { label: 'Wounds taken', value: String(stats.woundsTaken) },
    {
      label: 'Blade accuracy',
      value: percent(stats.bladeHits, stats.bladeSwings),
      detail: `${stats.bladeHits} of ${stats.bladeSwings} swings`,
    },
    {
      label: 'Bolts',
      value: `${stats.boltsHit} / ${stats.boltsFired}`,
      detail: stats.boltsFired > 0 ? `${percent(stats.boltsHit, stats.boltsFired)} on target` : 'none fired',
    },
    {
      label: 'Snares',
      value: `${stats.snaresTriggered} / ${stats.snaresPlaced}`,
      detail: 'triggered of placed',
    },
    { label: 'Echo decoys', value: String(stats.decoysUsed) },
    { label: 'Veil smokes', value: String(stats.smokesUsed) },
    { label: 'Wards triggered', value: String(stats.wardsTriggered) },
    { label: 'Barricades breached', value: String(stats.breaches) },
    { label: 'Runner healed', value: stats.healed ? 'Yes' : 'No' },
    { label: 'Runner distance', value: `${Math.round(stats.distanceRunner)} m` },
    { label: 'Hunter distance', value: `${Math.round(stats.distanceHunter)} m` },
    { label: 'Closest approach', value: `${stats.closestApproach.toFixed(1)} m` },
    { label: 'Time concealed', value: clock(stats.timeSpentHidden) },
  ];
}

export function createResultsScreen(ctx: ScreenContext): ResultsScreen {
  const root = screenRoot(
    'results',
    'screen--results',
    `<main class="menu menu--wide results">
       <header class="results-head">
         <p class="eyebrow" data-el="verdict">Match over</p>
         <h1 class="results-title" data-el="headline">The hunt ends</h1>
         <p class="results-winner" data-el="winner"></p>
         <p class="rule rule--wide" aria-hidden="true"></p>
         <p class="results-reason" data-el="reason"></p>
       </header>

       <div class="results-body">
         <section class="panel" aria-labelledby="veil-tally-h">
           <h2 class="panel-title" id="veil-tally-h">Tally</h2>
           <table class="stats">
             <caption class="visually-hidden">Match statistics</caption>
             <tbody data-el="stats"></tbody>
           </table>
         </section>

         <section class="panel" aria-labelledby="veil-contracts-h">
           <h2 class="panel-title" id="veil-contracts-h">Sealed contracts</h2>
           <div class="contracts" data-el="contracts"></div>
         </section>
       </div>

       <div class="menu-actions menu-actions--split">
         <button class="btn btn--primary" type="button" data-el="rematch">Rematch <span class="btn-sub">roles swap</span></button>
         <button class="btn" type="button" data-el="lobby">Back to lobby</button>
       </div>
     </main>`,
  );

  const verdict = el(root, 'verdict');
  const headline = el(root, 'headline');
  const winnerEl = el(root, 'winner');
  const reasonEl = el(root, 'reason');
  const statsBody = el(root, 'stats');
  const contractsEl = el(root, 'contracts');
  const rematchBtn = el<HTMLButtonElement>(root, 'rematch');

  ctx.listeners.on(rematchBtn, 'click', () => ctx.actions().rematch());
  ctx.listeners.on(el<HTMLButtonElement>(root, 'lobby'), 'click', () => ctx.actions().returnToLobby());

  const renderContract = (
    result: MatchResult,
    role: Role,
    yourRole: Role,
  ): HTMLElement => {
    const entry = result.contracts[role];
    const owner = role === 'hunter' ? result.hunterName : result.runnerName;
    const card = document.createElement('article');
    card.className = `contract contract--${role}`;
    card.innerHTML = `
      <header class="contract-head">
        <span class="contract-role" data-el="role"></span>
        <span class="contract-owner" data-el="owner"></span>
        <span class="chip" data-el="chip"></span>
      </header>
      <p class="contract-title" data-el="title"></p>
      <p class="contract-desc" data-el="desc"></p>`;
    setText(el(card, 'role'), roleWord(role));
    setText(el(card, 'owner'), role === yourRole ? `${owner} — you` : owner);
    const chip = el(card, 'chip');
    if (!entry) {
      chip.className = 'chip chip--none';
      setText(chip, 'NONE');
      setText(el(card, 'title'), 'No contract this round');
      setText(el(card, 'desc'), '');
      return card;
    }
    card.classList.toggle('is-complete', entry.complete);
    chip.className = `chip ${entry.complete ? 'chip--good' : 'chip--bad'}`;
    setText(chip, entry.complete ? 'COMPLETE' : 'FAILED');
    setText(el(card, 'title'), entry.contract.title);
    setText(el(card, 'desc'), entry.contract.description);
    return card;
  };

  return {
    el: root,
    focusFirst() {
      focusQuietly(rematchBtn);
    },
    show(result, yourRole) {
      const won = result.winner !== null && result.winner === yourRole;
      root.classList.toggle('is-win', won);
      root.classList.toggle('is-loss', result.winner !== null && !won);
      setText(verdict, result.winner === null ? 'No winner' : won ? 'Victory' : 'Defeat');

      if (result.winner === null) {
        setText(headline, 'The hunt is abandoned');
        setText(winnerEl, '');
      } else {
        const name = result.winner === 'hunter' ? result.hunterName : result.runnerName;
        setText(headline, result.winner === 'hunter' ? 'The Hunter takes the ruins' : 'The Runner slips the veil');
        setText(winnerEl, `${roleWord(result.winner)} — ${name}`);
      }
      setText(reasonEl, result.reason);

      statsBody.replaceChildren();
      for (const row of buildStatRows(result.stats)) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<th scope="row"></th><td class="tnum"></td><td class="stat-detail"></td>';
        setText(tr.querySelector('th') as HTMLElement, row.label);
        const cells = tr.querySelectorAll('td');
        setText(cells[0] as HTMLElement, row.value);
        setText(cells[1] as HTMLElement, row.detail ?? '');
        statsBody.appendChild(tr);
      }

      contractsEl.replaceChildren(
        renderContract(result, 'runner', yourRole),
        renderContract(result, 'hunter', yourRole),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// disconnected
// ---------------------------------------------------------------------------

export interface DisconnectedScreen {
  readonly el: HTMLElement;
  setPresence(state: { present: boolean; name: string; graceSeconds: number } | null): void;
  tick(now: number): boolean;
  focusFirst(): void;
}

export function createDisconnectedScreen(ctx: ScreenContext): DisconnectedScreen {
  const root = screenRoot(
    'disconnected',
    'screen--disconnected',
    `<main class="menu menu--slim">
       <p class="eyebrow">Connection</p>
       <h1 class="section-title" data-el="title">The thread is cut</h1>
       <p class="lede" data-el="body">
         The link to the match was lost. Nothing you did caused this — it is almost
         always the network or the server restarting.
       </p>
       <p class="countdown-line" data-el="countLine" hidden>
         Holding the room open for <span class="tnum" data-el="count">0</span>s
       </p>
       <div class="bar" data-el="bar" hidden aria-hidden="true"><i></i></div>
       <div class="menu-actions">
         <button class="btn btn--primary" type="button" data-el="back">Back to title</button>
       </div>
       <p class="hint">You can always start a fresh room from the title screen.</p>
     </main>`,
  );

  const titleEl = el(root, 'title');
  const bodyEl = el(root, 'body');
  const countLine = el(root, 'countLine');
  const countEl = el(root, 'count');
  const bar = el(root, 'bar');
  const back = el<HTMLButtonElement>(root, 'back');

  ctx.listeners.on(back, 'click', () => ctx.actions().quitToTitle());

  let endsAt = 0;
  let grace = 1;
  let lastShown = -1;

  return {
    el: root,
    focusFirst() {
      focusQuietly(back);
    },
    setPresence(state) {
      if (!state || state.present) {
        countLine.hidden = true;
        bar.hidden = true;
        endsAt = 0;
        setText(titleEl, 'The thread is cut');
        setText(
          bodyEl,
          'The link to the match was lost. Nothing you did caused this — it is almost always the network or the server restarting.',
        );
        return;
      }
      const who = state.name.length > 0 ? state.name : 'Your opponent';
      setText(titleEl, 'Your opponent dropped out');
      setText(bodyEl, `${who} lost connection. The room stays open for a short while so they can rejoin the same match.`);
      countLine.hidden = false;
      bar.hidden = false;
      grace = Math.max(1, state.graceSeconds);
      endsAt = performance.now() + state.graceSeconds * 1000;
      lastShown = -1;
    },
    tick(now) {
      if (endsAt === 0) return false;
      const remaining = Math.max(0, (endsAt - now) / 1000);
      const shown = Math.ceil(remaining);
      if (shown !== lastShown) {
        lastShown = shown;
        setText(countEl, String(shown));
      }
      bar.style.setProperty('--p', (remaining / grace).toFixed(3));
      if (remaining <= 0) {
        setText(titleEl, 'They did not come back');
        setText(bodyEl, 'The reconnect window closed. Head back to the title screen and start a new room.');
        countLine.hidden = true;
        bar.hidden = true;
        endsAt = 0;
        return false;
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// credits
// ---------------------------------------------------------------------------

export interface CreditsScreen {
  readonly el: HTMLElement;
  focusFirst(): void;
}

export function createCreditsScreen(ctx: ScreenContext, onClose: () => void): CreditsScreen {
  const root = screenRoot(
    'credits',
    'screen--credits',
    `<main class="menu menu--wide">
       <header class="wordmark wordmark--compact">
         <h1 class="wordmark-title"><span>VEIL</span><span>HUNT</span></h1>
         <p class="wordmark-sub">A two-player asymmetric hunt in moonlit ruins.</p>
       </header>

       <div class="credit-cols">
         <section class="panel">
           <h2 class="panel-title">Built with</h2>
           <p class="lede">Three.js, Socket.IO, TypeScript and the Web Audio API.</p>
           <p class="hint">
             Every mesh, material, texture, particle and sound in this game is generated
             procedurally at runtime. There are no image, model or audio files — the whole
             build runs offline, from source.
           </p>
         </section>

         <section class="panel">
           <h2 class="panel-title">Controls</h2>
           <ul class="keylist keylist--compact" data-el="keys"></ul>
         </section>
       </div>

       <div class="menu-actions">
         <button class="btn btn--primary" type="button" data-el="back">Back</button>
       </div>
     </main>`,
  );

  el(root, 'keys').appendChild(buildKeyList());
  const back = el<HTMLButtonElement>(root, 'back');
  ctx.listeners.on(back, 'click', onClose);

  return {
    el: root,
    focusFirst() {
      focusQuietly(back);
    },
  };
}
