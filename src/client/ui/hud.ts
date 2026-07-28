/**
 * The in-match HUD.
 *
 * Layout rule that governs this whole file: the middle 50% width x 55% height
 * of the viewport is reserved for gameplay and must stay clear. Every zone is
 * anchored to an edge and hard-capped so it cannot geometrically reach the
 * reserved rectangle (see `.hud-zone` in style.css). The only things allowed
 * near the centre are the reticle itself and the context prompt, which is
 * anchored to the bottom boundary of the reserved rectangle.
 *
 * Performance rule: `update()` runs every frame. Element references are built
 * once and cached; every write goes through `setText` / `setVar` / `setFlag`
 * which compare against the previous value first, so a steady-state frame
 * touches the DOM zero times.
 */

import type { HudState } from '../contracts.js';
import type { Role, SoundKind, WorldSnapshot } from '../../shared/types.js';
import {
  BLADE,
  BREACH,
  CROSSBOW,
  DECOY,
  HUNTER_STAMINA,
  MATCH_DURATION,
  PULSE,
  RUNNER_STAMINA,
  SEALS_REQUIRED,
  SMOKE,
  SNARE,
  WARD,
} from '../../shared/constants.js';

export interface HudHandle {
  readonly el: HTMLElement;
  update(state: HudState): void;
  flashNotice(text: string, tone: 'good' | 'bad' | 'neutral'): void;
  dispose(): void;
}

/** The stone throw has no shared constant; the server uses this literal. */
const THROW_COOLDOWN = 3.2;
/** Server-side blade cooldown = the full swing timeline plus the recharge. */
const BLADE_TOTAL = BLADE.windup + BLADE.active + BLADE.recovery + BLADE.cooldown;

const BANNER_MS = 4000;
const NOTICE_MS = 1600;
const FLASH_MS = 460;
/** Sound pings fade out over this long; `age` arrives in seconds. */
const PING_FADE = 1.1;
const MAX_PINGS = 12;
/**
 * The top strip and the ability zone are both hard-capped so they cannot reach
 * the reserved play area, which gives each a fixed height budget. These two
 * limits are what keep the content inside that budget at every window size;
 * both lists are priority-ordered, so what gets dropped is the least urgent.
 */
const MAX_BANNERS = 2;
const MAX_STATUS_PIPS = 4;

// ---------------------------------------------------------------------------
// Tiny write-through-cache DOM helpers
// ---------------------------------------------------------------------------

const varCache = new WeakMap<HTMLElement, Map<string, string>>();

function setVar(el: HTMLElement, name: string, value: string): void {
  let cache = varCache.get(el);
  if (!cache) {
    cache = new Map();
    varCache.set(el, cache);
  }
  if (cache.get(name) === value) return;
  cache.set(name, value);
  el.style.setProperty(name, value);
}

function setNum(el: HTMLElement, name: string, value: number, places = 3): void {
  setVar(el, name, value.toFixed(places));
}

function setText(el: HTMLElement, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

function setFlag(el: HTMLElement, cls: string, on: boolean): void {
  if (el.classList.contains(cls) === on) return;
  el.classList.toggle(cls, on);
}

function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function query<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`hud: missing element ${selector}`);
  return found;
}

function queryAll<T extends HTMLElement>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

function make(tag: string, className: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

// ---------------------------------------------------------------------------
// Icons — static markup only, never interpolated with network data
// ---------------------------------------------------------------------------

function svg(body: string, extra = ''): string {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;
}

const ICONS = {
  blade: svg('<path d="M12 2.5 15 9.5 12 21.5 9 9.5Z"/><path d="M9.4 9.5h5.2"/>'),
  crossbow: svg('<path d="M4 6.5 12 12l8-5.5"/><path d="M12 12v9"/><path d="M7.5 12.5h9"/><circle cx="12" cy="12" r="1.4"/>'),
  pulse: svg('<circle cx="12" cy="12" r="2"/><path d="M6.6 12a5.4 5.4 0 0 1 5.4-5.4"/><path d="M17.4 12a5.4 5.4 0 0 1-5.4 5.4"/><path d="M3 12a9 9 0 0 1 9-9"/><path d="M21 12a9 9 0 0 1-9 9"/>'),
  snare: svg('<circle cx="12" cy="13" r="5.6" stroke-dasharray="2.4 2.6"/><path d="M12 2.5v4.4"/><path d="M8.6 9.6 12 13l3.4-3.4"/>'),
  decoy: svg('<path d="M8.5 21v-5.2L6.8 11a2.7 2.7 0 0 1 5.2-1.5"/><circle cx="9.2" cy="4.6" r="2.1"/><path d="M15 21v-5.2l-1.4-4" opacity=".55"/><circle cx="16.2" cy="5.4" r="1.7" opacity=".55"/>'),
  smoke: svg('<path d="M6 16.5a3.2 3.2 0 0 1 .5-6.3 4.4 4.4 0 0 1 8.4-1.6 3.4 3.4 0 0 1 3.6 5.4"/><path d="M5.5 19.6h13"/><path d="M8 16.6h10"/>'),
  ward: svg('<path d="M12 2.6v4"/><path d="M12 17.4v4"/><path d="M2.6 12h4"/><path d="M17.4 12h4"/><path d="m5.9 5.9 2.8 2.8"/><path d="m15.3 15.3 2.8 2.8"/><path d="m18.1 5.9-2.8 2.8"/><path d="m8.7 15.3-2.8 2.8"/><circle cx="12" cy="12" r="2.4"/>'),
  stone: svg('<path d="M5.2 13.4 8.6 6.3l7.4-1.6 3.2 6-3.4 6.6-7.6 1z"/><path d="m8.6 6.3 3 5.4 5-6.9"/>'),
  breach: svg('<path d="M4 20.5 10 14"/><path d="m8.6 12.6 3.4 3.4"/><path d="M13 4.5 20 11.5l-3 3-7-7z"/>'),
  root: svg('<path d="M12 3v10"/><path d="M12 13c0 4-3 5.6-6 5.6"/><path d="M12 13c0 4 3 5.6 6 5.6"/><path d="M8 21h8"/>'),
  stun: svg('<path d="m13.6 2.5-7.2 9h5l-1 10 7.2-9.6h-5z"/>'),
  slow: svg('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3 1.8"/>'),
  haste: svg('<path d="M4 8h8"/><path d="M3 12h6"/><path d="M5 16h6"/><path d="m14 5 6 7-6 7"/>'),
  mark: svg('<circle cx="12" cy="12" r="7.4"/><circle cx="12" cy="12" r="2"/><path d="M12 2.6v3"/><path d="M12 18.4v3"/><path d="M2.6 12h3"/><path d="M18.4 12h3"/>'),
  hidden: svg('<path d="M3 12s3.6-6.2 9-6.2S21 12 21 12s-3.6 6.2-9 6.2S3 12 3 12z" opacity=".5"/><path d="m4.5 4.5 15 15"/>'),
  channel: svg('<path d="M12 3.2 19 7.6v8.8L12 20.8 5 16.4V7.6z"/><path d="M12 8.4v7.2"/>'),
  wound0: svg('<circle cx="12" cy="12" r="7.6"/>'),
  wound1: svg('<path d="M19.6 12a7.6 7.6 0 1 1-7.6-7.6"/><path d="M12 4.4 14.4 9l-4 2.2 3.4 3-1.6 5.2"/>'),
  wound2: svg('<path d="M12 4.4 17.8 7v4.6"/><path d="M16.6 16.6 12 19.6 6.2 16.4V7.6"/><path d="m9.4 5.6-.8 5.2 4.4 1.4-1.6 4 3.8 1.6"/><path d="m5.4 12.6 3.2-1.8"/>'),
} as const;

// ---------------------------------------------------------------------------
// Ability slots
// ---------------------------------------------------------------------------

interface AbilityDef {
  /** Key into `self.cooldowns`. */
  id: string;
  name: string;
  /** Fits under a ~48px tile; the full `name` goes to the accessible label. */
  short: string;
  /** Key cap text. */
  key: string;
  icon: string;
  cooldown: number;
  /** Key into `self.charges`, when the ability is charge-limited. */
  chargeKey?: 'bolts' | 'snares' | 'wards';
  chargeMax?: number;
  /** Only the crossbow shows a reload sweep. */
  reload?: boolean;
}

/** Ordered LMB, RMB, Q, F for both roles so muscle memory carries across sides. */
const RUNNER_ABILITIES: AbilityDef[] = [
  { id: 'throw', name: 'Throw Stone', short: 'Stone', key: 'LMB', icon: ICONS.stone, cooldown: THROW_COOLDOWN },
  { id: 'ward', name: 'Flash Ward', short: 'Ward', key: 'RMB', icon: ICONS.ward, cooldown: WARD.cooldown, chargeKey: 'wards', chargeMax: WARD.charges },
  { id: 'decoy', name: 'Echo Decoy', short: 'Decoy', key: 'Q', icon: ICONS.decoy, cooldown: DECOY.cooldown },
  { id: 'smoke', name: 'Veil Smoke', short: 'Smoke', key: 'F', icon: ICONS.smoke, cooldown: SMOKE.cooldown },
];

const HUNTER_ABILITIES: AbilityDef[] = [
  { id: 'blade', name: 'Ritual Blade', short: 'Blade', key: 'LMB', icon: ICONS.blade, cooldown: BLADE_TOTAL },
  { id: 'crossbow', name: 'Marking Crossbow', short: 'Bolt', key: 'RMB\u2192LMB', icon: ICONS.crossbow, cooldown: CROSSBOW.fireCooldown, chargeKey: 'bolts', chargeMax: CROSSBOW.maxBolts, reload: true },
  { id: 'pulse', name: 'Tracking Pulse', short: 'Pulse', key: 'Q', icon: ICONS.pulse, cooldown: PULSE.cooldown },
  { id: 'snare', name: 'Snare', short: 'Snare', key: 'F', icon: ICONS.snare, cooldown: SNARE.placeCooldown, chargeKey: 'snares', chargeMax: SNARE.totalCharges },
];

interface SlotRefs {
  def: AbilityDef;
  root: HTMLElement;
  dial: HTMLElement;
  pips: HTMLElement[];
  timer: HTMLElement;
  /** Cooldown was zero on the previous frame — used to fire the ready flash. */
  wasReady: boolean;
  flashUntil: number;
}

function buildSlot(def: AbilityDef): SlotRefs {
  const root = make('div', 'slot');
  root.dataset.ability = def.id;
  const pipMarkup =
    def.chargeMax && def.chargeMax > 0
      ? `<div class="slot-pips" aria-hidden="true">${'<i class="pip"></i>'.repeat(def.chargeMax)}</div>`
      : '';
  root.innerHTML = `
    <div class="slot-face">
      <div class="slot-dial" aria-hidden="true"></div>
      <div class="slot-icon" aria-hidden="true">${def.icon}</div>
      <kbd class="cap slot-key"></kbd>
      <span class="slot-timer tnum" aria-hidden="true"></span>
    </div>
    ${pipMarkup}
    <span class="slot-label"></span>`;
  setText(query(root, '.slot-key'), def.key);
  setText(query(root, '.slot-label'), def.short);
  // The tile only has room for a short label; screen readers get the real name.
  root.setAttribute('aria-label', `${def.name} (${def.key})`);
  root.title = `${def.name} — ${def.key}`;
  return {
    def,
    root,
    dial: query(root, '.slot-dial'),
    pips: queryAll(root, '.pip'),
    timer: query(root, '.slot-timer'),
    wasReady: true,
    flashUntil: 0,
  };
}

// ---------------------------------------------------------------------------
// Status pips
// ---------------------------------------------------------------------------

interface StatusDef {
  id: string;
  label: string;
  icon: string;
  /** Nominal full duration used to scale the remaining-time ring. */
  full: number;
  tone: 'bad' | 'good' | 'neutral';
}

/**
 * DOM order is priority order: when more effects are live than the strip can
 * hold, the ones further down are dropped. Things that change what you can do
 * right now come first; passive information comes last.
 */
const STATUS_DEFS: StatusDef[] = [
  { id: 'rooted', label: 'Rooted', icon: ICONS.root, full: SNARE.rootDuration, tone: 'bad' },
  { id: 'stunned', label: 'Stunned', icon: ICONS.stun, full: WARD.stunDuration, tone: 'bad' },
  { id: 'slowed', label: 'Slowed', icon: ICONS.slow, full: SNARE.slowDuration, tone: 'bad' },
  { id: 'marked', label: 'Marked', icon: ICONS.mark, full: CROSSBOW.markDuration, tone: 'bad' },
  { id: 'hasted', label: 'Hasted', icon: ICONS.haste, full: WARD.runnerHasteDuration, tone: 'good' },
  { id: 'breaching', label: 'Breaching', icon: ICONS.breach, full: 1, tone: 'neutral' },
  { id: 'channeling', label: 'Channelling', icon: ICONS.channel, full: 1, tone: 'neutral' },
  { id: 'inSmoke', label: 'In Smoke', icon: ICONS.smoke, full: 0, tone: 'good' },
  { id: 'hidden', label: 'Hidden', icon: ICONS.hidden, full: 0, tone: 'good' },
  { id: 'breach', label: 'Breach', icon: ICONS.breach, full: BREACH.cooldown, tone: 'neutral' },
];

interface PipRefs {
  def: StatusDef;
  root: HTMLElement;
  ring: HTMLElement;
  value: HTMLElement;
}

function buildStatusPip(def: StatusDef): PipRefs {
  const root = make('div', `spip spip--${def.tone}`);
  root.hidden = true;
  root.innerHTML = `
    <span class="spip-ring" aria-hidden="true"></span>
    <span class="spip-icon" aria-hidden="true">${def.icon}</span>
    <span class="spip-text"><span class="spip-label"></span><span class="spip-value tnum"></span></span>`;
  setText(query(root, '.spip-label'), def.label);
  return { def, root, ring: query(root, '.spip-ring'), value: query(root, '.spip-value') };
}

// ---------------------------------------------------------------------------
// Sound categories
// ---------------------------------------------------------------------------

type SoundCategory = 'foot' | 'combat' | 'ritual';

const SOUND_CATEGORY: Record<SoundKind, SoundCategory> = {
  footstepDirt: 'foot',
  footstepStone: 'foot',
  footstepWater: 'foot',
  footstepGrass: 'foot',
  decoyStep: 'foot',
  vault: 'foot',
  bladeWindup: 'combat',
  bladeHit: 'combat',
  bladeMiss: 'combat',
  crossbowFire: 'combat',
  boltImpact: 'combat',
  smokeDeploy: 'combat',
  wardTrigger: 'combat',
  snareTrigger: 'combat',
  snarePlace: 'combat',
  breach: 'combat',
  capture: 'combat',
  wound: 'combat',
  pulse: 'combat',
  breath: 'combat',
  sealStart: 'ritual',
  sealDone: 'ritual',
  gateOpen: 'ritual',
  gateChannel: 'ritual',
  shrineStart: 'ritual',
  shrineDone: 'ritual',
  charmRattle: 'ritual',
  doorSlam: 'ritual',
  doorCreak: 'ritual',
};

/**
 * Maps a bearing (radians, 0 = camera forward, positive = clockwise on screen)
 * onto the perimeter of the ping container, as percentages. Percentages mean no
 * resize listener and no pixel measurement is ever needed.
 */
function edgePoint(angle: number): { x: number; y: number } {
  const sx = Math.sin(angle);
  const sy = -Math.cos(angle);
  const ax = Math.abs(sx);
  const ay = Math.abs(sy);
  // Scale the unit direction out to whichever edge it hits first.
  const scale = Math.min(ax < 1e-4 ? Infinity : 0.5 / ax, ay < 1e-4 ? Infinity : 0.5 / ay);
  const s = Number.isFinite(scale) ? scale : 0.5;
  return { x: (0.5 + sx * s) * 100, y: (0.5 + sy * s) * 100 };
}

// ---------------------------------------------------------------------------
// Root markup
// ---------------------------------------------------------------------------

const HUD_MARKUP = `
<div class="hud-vignette" data-hud="vignette" aria-hidden="true"></div>
<div class="hud-sonar" data-hud="sonar" aria-hidden="true"></div>

<div class="hud-zone hud-tl">
  <div class="role-badge" data-hud="roleBadge">
    <span class="role-badge-mark" aria-hidden="true"></span>
    <span class="role-badge-text">
      <span class="role-badge-role" data-hud="roleName"></span>
      <span class="role-badge-sub" data-hud="roleThesis"></span>
    </span>
  </div>
  <div class="wound" data-hud="wound">
    <span class="wound-icon" data-hud="woundIcon" aria-hidden="true"></span>
    <span class="wound-body">
      <span class="wound-label" data-hud="woundLabel"></span>
      <span class="wound-note" data-hud="woundNote"></span>
    </span>
  </div>
</div>

<div class="hud-zone hud-tr">
  <div class="conn" data-hud="conn">
    <span class="conn-bars" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="conn-text">
      <span class="conn-state" data-hud="connState"></span>
      <span class="conn-ping tnum" data-hud="connPing"></span>
    </span>
  </div>
</div>

<div class="hud-top" data-hud="top">
  <div class="clock" data-hud="clock">
    <span class="clock-time tnum" data-hud="clockTime">0:00</span>
    <span class="clock-rule" aria-hidden="true"><i data-hud="clockFill"></i></span>
  </div>
  <div class="seals" data-hud="seals">
    <span class="seal-nodes" aria-hidden="true"></span>
    <span class="seal-count tnum" data-hud="sealCount"></span>
    <span class="seal-word">seals</span>
  </div>
  <ul class="banners" data-hud="banners" role="status" aria-live="polite"></ul>
</div>

<div class="hud-reticle" data-hud="reticle" aria-hidden="true">
  <i class="ret-dot"></i>
  <i class="ret-tick ret-n"></i><i class="ret-tick ret-e"></i>
  <i class="ret-tick ret-s"></i><i class="ret-tick ret-w"></i>
</div>

<div class="hud-lower" data-hud="lower">
  <div class="notice-slot"><div class="notice" data-hud="notice" hidden><span data-hud="noticeText"></span></div></div>
  <div class="prompt" data-hud="prompt" hidden>
    <span class="prompt-key" data-hud="promptKey">
      <span class="prompt-arc" aria-hidden="true"></span>
      <kbd class="cap">E</kbd>
    </span>
    <span class="prompt-body">
      <span class="prompt-label" data-hud="promptLabel"></span>
      <span class="prompt-blocked" data-hud="promptBlocked"></span>
    </span>
  </div>
</div>

<div class="hud-zone hud-bl">
  <div class="stamina" data-hud="stamina">
    <div class="stamina-head">
      <span class="stamina-label" data-hud="staminaLabel">Stamina</span>
      <span class="stamina-value tnum" data-hud="staminaValue"></span>
    </div>
    <div class="stamina-track" data-hud="staminaTrack">
      <i class="stamina-fill" data-hud="staminaFill"></i>
      <i class="stamina-mark" data-hud="staminaMark" aria-hidden="true"></i>
    </div>
  </div>
</div>

<div class="hud-zone hud-br">
  <div class="status-strip" data-hud="statusStrip"></div>
  <div class="abilities" data-hud="abilities"></div>
</div>`;

// ---------------------------------------------------------------------------

interface BannerRef {
  el: HTMLElement;
  expires: number;
}

interface PingRef {
  el: HTMLElement;
  glyph: HTMLElement;
}

export function createHud(): HudHandle {
  const el = make('div', 'hud');
  el.dataset.screen = 'match';
  el.innerHTML = HUD_MARKUP;

  const ref = <T extends HTMLElement>(name: string): T => query<T>(el, `[data-hud="${name}"]`);

  const vignette = ref('vignette');
  const sonar = ref('sonar');
  const roleBadge = ref('roleBadge');
  const roleName = ref('roleName');
  const roleThesis = ref('roleThesis');
  const woundEl = ref('wound');
  const woundIcon = ref('woundIcon');
  const woundLabel = ref('woundLabel');
  const woundNote = ref('woundNote');
  const conn = ref('conn');
  const connState = ref('connState');
  const connPing = ref('connPing');
  const clock = ref('clock');
  const clockTime = ref('clockTime');
  const clockFill = ref('clockFill');
  const sealCount = ref('sealCount');
  const bannerList = ref('banners');
  const reticle = ref('reticle');
  const notice = ref('notice');
  const noticeText = ref('noticeText');
  const prompt = ref('prompt');
  const promptKey = ref('promptKey');
  const promptLabel = ref('promptLabel');
  const promptBlocked = ref('promptBlocked');
  const stamina = ref('stamina');
  const staminaLabel = ref('staminaLabel');
  const staminaValue = ref('staminaValue');
  const staminaFill = ref('staminaFill');
  const staminaMark = ref('staminaMark');
  const statusStrip = ref('statusStrip');
  const abilities = ref('abilities');

  // Seal nodes -------------------------------------------------------------
  const sealHost = query(el, '.seal-nodes');
  const sealNodes: HTMLElement[] = [];
  for (let i = 0; i < SEALS_REQUIRED; i += 1) {
    const node = make('i', 'seal-node');
    sealHost.appendChild(node);
    sealNodes.push(node);
  }

  // Ability clusters (both built once; the inactive role's cluster is hidden)
  const clusters: Record<Role, { root: HTMLElement; slots: SlotRefs[] }> = {
    runner: { root: make('div', 'ability-row'), slots: [] },
    hunter: { root: make('div', 'ability-row'), slots: [] },
  };
  for (const role of ['runner', 'hunter'] as Role[]) {
    const defs = role === 'runner' ? RUNNER_ABILITIES : HUNTER_ABILITIES;
    const cluster = clusters[role];
    cluster.root.hidden = true;
    for (const def of defs) {
      const slot = buildSlot(def);
      cluster.slots.push(slot);
      cluster.root.appendChild(slot.root);
    }
    abilities.appendChild(cluster.root);
  }

  // Status pips ------------------------------------------------------------
  const pips: PipRefs[] = STATUS_DEFS.map((def) => {
    const pip = buildStatusPip(def);
    statusStrip.appendChild(pip.root);
    return pip;
  });

  // Sound ping pool --------------------------------------------------------
  const pingPool: PingRef[] = [];
  for (let i = 0; i < MAX_PINGS; i += 1) {
    const holder = make('div', 'ping');
    holder.hidden = true;
    const glyph = make('i', 'ping-arc');
    holder.appendChild(glyph);
    sonar.appendChild(holder);
    pingPool.push({ el: holder, glyph });
  }

  const banners = new Map<number, BannerRef>();
  let noticeExpires = 0;
  let lastRole: Role | null = null;

  // -----------------------------------------------------------------------

  function updateRole(role: Role): void {
    if (lastRole === role) return;
    lastRole = role;
    setFlag(el, 'is-hunter', role === 'hunter');
    setFlag(el, 'is-runner', role === 'runner');
    setFlag(roleBadge, 'is-hunter', role === 'hunter');
    setText(roleName, role === 'hunter' ? 'HUNTER' : 'RUNNER');
    setText(roleThesis, role === 'hunter' ? 'Corner the quarry' : 'Light three, then run');
    clusters.runner.root.hidden = role !== 'runner';
    clusters.hunter.root.hidden = role !== 'hunter';
    setText(staminaValue, '');
  }

  function updateClock(snapshot: WorldSnapshot): void {
    setText(clockTime, formatClock(snapshot.timeRemaining));
    const critical = snapshot.timeRemaining <= 20;
    const warn = !critical && snapshot.timeRemaining <= 60;
    setFlag(clock, 'is-warn', warn);
    setFlag(clock, 'is-critical', critical);
    setNum(clockFill, '--elapsed', clamp01(1 - snapshot.timeRemaining / MATCH_DURATION), 3);
  }

  function updateSeals(snapshot: WorldSnapshot): void {
    const lit = Math.min(SEALS_REQUIRED, Math.max(0, snapshot.sealsActivated));
    let partial = 0;
    for (const seal of snapshot.seals) {
      if (!seal.active && seal.progress > partial) partial = seal.progress;
    }
    for (let i = 0; i < sealNodes.length; i += 1) {
      const node = sealNodes[i];
      const fill = i < lit ? 1 : i === lit ? clamp01(partial) : 0;
      setNum(node, '--fill', fill, 3);
      setFlag(node, 'is-lit', i < lit);
      setFlag(node, 'is-burning', i === lit && partial > 0.02);
    }
    setText(sealCount, `${lit}/${SEALS_REQUIRED}`);
  }

  function updateWound(snapshot: WorldSnapshot, dread: number, reducedMotion: boolean): void {
    const wound = snapshot.self.wound;
    setFlag(woundEl, 'is-wounded', wound === 'wounded');
    setFlag(woundEl, 'is-cursed', wound === 'cursed');
    const icon = wound === 'cursed' ? ICONS.wound2 : wound === 'wounded' ? ICONS.wound1 : ICONS.wound0;
    if (woundIcon.dataset.state !== wound) {
      woundIcon.dataset.state = wound;
      woundIcon.innerHTML = icon;
    }
    setText(woundLabel, wound === 'cursed' ? 'CURSED' : wound === 'wounded' ? 'WOUNDED' : 'UNMARKED');
    const protection = snapshot.self.protectionRemaining;
    setText(
      woundNote,
      protection > 0.05
        ? `shielded ${protection.toFixed(1)}s`
        : wound === 'cursed'
          ? 'one more ends it'
          : wound === 'wounded'
            ? 'slower, louder'
            : 'unhurt',
    );
    // Heartbeat rate rises with dread; disabled entirely under reduced motion.
    const beating = !reducedMotion && dread > 0.05;
    setFlag(woundEl, 'is-beating', beating);
    if (beating) setNum(woundEl, '--beat', 1.15 - dread * 0.7, 3);
  }

  function updateConnection(ping: number, connected: boolean): void {
    const quality = !connected ? 'lost' : ping < 60 ? 'good' : ping < 130 ? 'fair' : 'poor';
    if (conn.dataset.quality !== quality) conn.dataset.quality = quality;
    setText(connState, connected ? (quality === 'good' ? 'STABLE' : quality === 'fair' ? 'FAIR' : 'POOR') : 'RECONNECTING');
    setText(connPing, connected ? `${Math.round(ping)} ms` : '--- ms');
  }

  function updateStamina(snapshot: WorldSnapshot, role: Role): void {
    const table = role === 'hunter' ? HUNTER_STAMINA : RUNNER_STAMINA;
    const value = clamp01(snapshot.self.stamina / table.max);
    setNum(stamina, '--fill', value, 3);
    setNum(staminaMark, '--at', table.unlockAt / table.max, 3);
    setText(staminaValue, `${Math.round(snapshot.self.stamina)}`);
    const locked = snapshot.self.staminaLocked;
    setFlag(stamina, 'is-locked', locked);
    setFlag(stamina, 'is-low', !locked && value < 0.3);
    setFlag(staminaFill, 'is-locked', locked);
    setText(staminaLabel, locked ? 'Sprint locked' : 'Stamina');
  }

  function updateAbilities(state: HudState, now: number): void {
    const cluster = clusters[state.role];
    const self = state.snapshot.self;
    for (const slot of cluster.slots) {
      const { def } = slot;
      const remaining = Math.max(0, self.cooldowns[def.id] ?? 0);
      const charges = def.chargeKey ? Math.max(0, self.charges[def.chargeKey] ?? 0) : 1;
      const reloading = def.reload ? Math.max(0, self.reloading) : 0;

      let sweep = def.cooldown > 0 ? clamp01(remaining / def.cooldown) : 0;
      if (reloading > 0) sweep = clamp01(reloading / CROSSBOW.reloadTime);
      setNum(slot.dial, '--cd', sweep, 3);

      const empty = charges <= 0 && reloading <= 0;
      const cooling = remaining > 0.02;
      const ready = !empty && !cooling && reloading <= 0;

      // Bright flash on the frame a cooldown finishes, expiring on a timestamp
      // so the HUD keeps zero event listeners.
      if (ready && !slot.wasReady) slot.flashUntil = now + FLASH_MS;
      slot.wasReady = ready;
      setFlag(slot.root, 'is-flash', now < slot.flashUntil);

      setFlag(slot.root, 'is-ready', ready);
      setFlag(slot.root, 'is-cooling', cooling && !empty);
      setFlag(slot.root, 'is-empty', empty);
      setFlag(slot.root, 'is-reloading', reloading > 0);

      const label = reloading > 0 ? reloading.toFixed(1) : cooling ? (remaining >= 10 ? String(Math.ceil(remaining)) : remaining.toFixed(1)) : '';
      setText(slot.timer, label);

      for (let i = 0; i < slot.pips.length; i += 1) {
        setFlag(slot.pips[i], 'is-on', i < charges);
      }
    }
  }

  /** Reused every frame so the status pass allocates nothing. */
  const statusFrame = new Map<string, { seconds: number; progress: number }>();

  function updateStatus(state: HudState): void {
    const s = state.snapshot.self.status;
    const breachCd = Math.max(0, state.snapshot.self.cooldowns.breach ?? 0);
    const timed = (seconds: number, full: number) => ({ seconds, progress: full > 0 ? clamp01(seconds / full) : 0 });

    statusFrame.clear();
    if (s.rooted > 0.05) statusFrame.set('rooted', timed(s.rooted, SNARE.rootDuration));
    if (s.stunned > 0.05) statusFrame.set('stunned', timed(s.stunned, WARD.stunDuration));
    if (s.slowed > 0.05) statusFrame.set('slowed', timed(s.slowed, SNARE.slowDuration));
    if (s.marked > 0.05) statusFrame.set('marked', timed(s.marked, CROSSBOW.markDuration));
    if (s.hasted > 0.05) statusFrame.set('hasted', timed(s.hasted, WARD.runnerHasteDuration));
    // A breach is also a channel; show the more specific pip only.
    if (s.breaching > 0.01) statusFrame.set('breaching', { seconds: 0, progress: clamp01(s.breaching) });
    else if (s.channeling > 0.01) statusFrame.set('channeling', { seconds: 0, progress: clamp01(s.channeling) });
    // Hunter-only: the barricade breach recharge lives outside the ability cluster.
    if (state.role === 'hunter' && breachCd > 0.05) statusFrame.set('breach', timed(breachCd, BREACH.cooldown));
    if (s.inSmoke) statusFrame.set('inSmoke', { seconds: 0, progress: 0 });
    if (s.hidden || s.concealed) statusFrame.set('hidden', { seconds: 0, progress: 0 });

    let shown = 0;
    for (const pip of pips) {
      const entry = shown < MAX_STATUS_PIPS ? statusFrame.get(pip.def.id) : undefined;
      setHidden(pip.root, !entry);
      if (!entry) continue;
      shown += 1;
      setNum(pip.ring, '--ring', entry.progress, 3);
      setText(
        pip.value,
        entry.seconds > 0.05
          ? `${entry.seconds.toFixed(1)}s`
          : entry.progress > 0
            ? `${Math.round(entry.progress * 100)}%`
            : '',
      );
    }
  }

  function updatePrompt(state: HudState): void {
    const p = state.snapshot.self.prompt;
    const show = p.kind !== 'none' && p.label.length > 0;
    setHidden(prompt, !show);
    if (!show) return;
    setText(promptLabel, p.label);
    setFlag(prompt, 'is-blocked', p.blocked);
    setText(promptBlocked, p.blocked ? p.blockedReason : '');
    setHidden(promptBlocked, !p.blocked || p.blockedReason.length === 0);
    setNum(promptKey, '--arc', clamp01(p.progress), 3);
    setFlag(prompt, 'is-hc', state.settings.highContrastPrompts);
  }

  function updateReticle(state: HudState): void {
    const self = state.snapshot.self;
    let spread = 0;
    if (state.role === 'hunter') {
      if (self.bladePhase === 'windup') {
        spread = 1 - clamp01(self.bladePhaseRemaining / BLADE.windup);
      } else if (self.bladePhase === 'active') {
        spread = 1;
      } else if (self.bladePhase === 'recovery') {
        spread = clamp01(self.bladePhaseRemaining / BLADE.recovery) * 0.5;
      }
    }
    setNum(reticle, '--spread', spread, 3);
    setFlag(reticle, 'is-charged', spread > 0.02);
  }

  function updateBanners(state: HudState, now: number): void {
    for (const banner of state.snapshot.banners) {
      let entry = banners.get(banner.id);
      if (!entry) {
        if (banners.size >= MAX_BANNERS) {
          // Drop the oldest so newer, more relevant news always lands.
          let oldestId = -1;
          let oldestAt = Infinity;
          for (const [id, ref2] of banners) {
            if (ref2.expires < oldestAt) {
              oldestAt = ref2.expires;
              oldestId = id;
            }
          }
          const stale = banners.get(oldestId);
          if (stale) {
            stale.el.remove();
            banners.delete(oldestId);
          }
        }
        const li = make('li', `banner banner--${banner.tone}`);
        li.innerHTML = '<span class="banner-mark" aria-hidden="true"></span><span class="banner-text"></span>';
        setText(query(li, '.banner-text'), banner.text);
        bannerList.appendChild(li);
        entry = { el: li, expires: now + BANNER_MS };
        banners.set(banner.id, entry);
      }
    }
    for (const [id, entry] of banners) {
      if (now >= entry.expires) {
        entry.el.remove();
        banners.delete(id);
      } else if (now >= entry.expires - 420) {
        setFlag(entry.el, 'is-leaving', true);
      }
    }
  }

  function updateSonar(state: HudState): void {
    const enabled = state.settings.showSoundIndicators;
    setHidden(sonar, !enabled);
    if (!enabled) return;
    const list = state.soundPings;
    for (let i = 0; i < pingPool.length; i += 1) {
      const slot = pingPool[i];
      const ping = i < list.length ? list[i] : null;
      if (!ping) {
        setHidden(slot.el, true);
        continue;
      }
      const fade = clamp01(1 - ping.age / PING_FADE);
      if (fade <= 0.01) {
        setHidden(slot.el, true);
        continue;
      }
      setHidden(slot.el, false);
      const point = edgePoint(ping.angle);
      setVar(slot.el, '--x', `${point.x.toFixed(2)}%`);
      setVar(slot.el, '--y', `${point.y.toFixed(2)}%`);
      setNum(slot.el, '--rot', (ping.angle * 180) / Math.PI, 1);
      setNum(slot.el, '--fade', fade, 3);
      setNum(slot.el, '--strength', clamp01(ping.strength), 3);
      const category = SOUND_CATEGORY[ping.kind] ?? 'foot';
      if (slot.glyph.dataset.cat !== category) slot.glyph.dataset.cat = category;
    }
  }

  function updateVignette(state: HudState): void {
    const dread = state.role === 'runner' ? clamp01(state.snapshot.self.dread) : 0;
    setNum(vignette, '--dread', dread, 3);
    setHidden(vignette, dread <= 0.01);
  }

  function update(state: HudState): void {
    const now = performance.now();
    updateRole(state.role);
    setFlag(el, 'is-reduced', state.settings.reducedMotion);
    updateClock(state.snapshot);
    updateSeals(state.snapshot);
    updateWound(state.snapshot, state.role === 'runner' ? state.snapshot.self.dread : 0, state.settings.reducedMotion);
    updateConnection(state.ping, state.connected);
    updateStamina(state.snapshot, state.role);
    updateAbilities(state, now);
    updateStatus(state);
    updatePrompt(state);
    updateReticle(state);
    updateBanners(state, now);
    updateSonar(state);
    updateVignette(state);
    if (noticeExpires > 0 && now >= noticeExpires) {
      noticeExpires = 0;
      setHidden(notice, true);
    }
  }

  function flashNotice(text: string, tone: 'good' | 'bad' | 'neutral'): void {
    setText(noticeText, text);
    notice.dataset.tone = tone;
    setHidden(notice, false);
    // Restart the entry animation without touching listeners or timers.
    notice.classList.remove('is-in');
    void notice.offsetWidth;
    notice.classList.add('is-in');
    noticeExpires = performance.now() + NOTICE_MS;
  }

  function dispose(): void {
    banners.clear();
    el.remove();
  }

  return { el, update, flashNotice, dispose };
}
