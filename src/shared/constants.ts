/**
 * Every gameplay tunable lives here. Both the authoritative server and the
 * predicting client import this module, so there is exactly one source of truth
 * for ranges, cooldowns, speeds and durations.
 */

export const TICK_HZ = 30;
export const TICK_DT = 1 / TICK_HZ;
export const SNAPSHOT_HZ = 20;
export const INPUT_SEND_HZ = 30;

/**
 * Largest batch of input commands accepted in one message. High-refresh
 * displays produce commands faster than snapshots acknowledge them, so this
 * needs real headroom for frame hitches.
 */
export const MAX_INPUT_BACKLOG = 48;
/** Largest dt the server will honour from a single input command, in seconds. */
export const MAX_INPUT_DT = 0.1;

export const MATCH_DURATION = 420; // seven minutes
export const COUNTDOWN_DURATION = 5;
export const ROLE_REVEAL_DURATION = 6;
export const RESULTS_AUTO_LOBBY = 60;

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export const PLAYER_RADIUS = 0.42;
export const PLAYER_HEIGHT = 1.75;
export const CROUCH_HEIGHT = 1.05;
export const GRAVITY = 24;
export const VAULT_IMPULSE = 7.2;
/** Obstacles up to this height can be vaulted. */
export const VAULT_MAX_HEIGHT = 1.35;
export const VAULT_COOLDOWN = 0.55;
export const STEP_UP_HEIGHT = 0.34;

export interface SpeedTable {
  readonly walk: number;
  readonly sprint: number;
  readonly crouch: number;
  readonly air: number;
}

export const RUNNER_SPEED: SpeedTable = {
  walk: 4.35,
  sprint: 6.75,
  crouch: 2.15,
  air: 5.4,
};

/** Slower top sprint than the Runner, but far better stamina economy. */
export const HUNTER_SPEED: SpeedTable = {
  walk: 4.5,
  sprint: 6.15,
  crouch: 2.4,
  air: 5.2,
};

export const ACCEL_GROUND = 42;
export const ACCEL_AIR = 9;
export const FRICTION_GROUND = 12;
export const WATER_SPEED_SCALE = 0.62;

export const RUNNER_STAMINA = {
  max: 100,
  drain: 21,
  regen: 15,
  regenDelay: 0.9,
  /** Sprint is locked out until stamina climbs back to this value. */
  unlockAt: 22,
} as const;

export const HUNTER_STAMINA = {
  max: 100,
  drain: 12,
  regen: 19,
  regenDelay: 0.6,
  unlockAt: 15,
} as const;

// ---------------------------------------------------------------------------
// Wounds
// ---------------------------------------------------------------------------

export const WOUND_LEVELS = ['unmarked', 'wounded', 'cursed'] as const;
export type WoundLevel = (typeof WOUND_LEVELS)[number];

/**
 * Grace period after taking a wound during which further blade hits are ignored.
 *
 * Must stay comfortably longer than a full blade cycle
 * (windup + active + recovery + cooldown = 2.88 s) so a Hunter can never chain
 * two wounds out of a single engagement — the Runner always gets a beat to
 * break away and use it.
 */
export const HIT_PROTECTION = 4;
/** Multiplies seal / gate channel speed by wound level index. */
export const WOUND_CHANNEL_PENALTY = [1, 0.86, 0.72] as const;
/** Multiplies runner movement speed by wound level index. */
export const WOUND_SPEED_PENALTY = [1, 0.965, 0.93] as const;
/** Radius inside which the Hunter hears a wounded runner's breathing. */
export const WOUND_BREATH_RADIUS = [0, 16, 24] as const;

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export const SEALS_REQUIRED = 3;
export const SEAL_CHANNEL_TIME = 7.5;
/** Channel progress bleeds away at this fraction per second when interrupted. */
export const SEAL_DECAY_RATE = 0.22;
export const SEAL_INTERACT_RANGE = 2.6;

export const GATE_CHANNEL_TIME = 6;
export const GATE_INTERACT_RANGE = 3.2;
export const GATE_DECAY_RATE = 0.3;

export const SHRINE_CHANNEL_TIME = 9;
export const SHRINE_INTERACT_RANGE = 2.4;
export const SHRINE_DECAY_RATE = 0.35;

// ---------------------------------------------------------------------------
// Hunter kit
// ---------------------------------------------------------------------------

export const BLADE = {
  windup: 0.34,
  active: 0.22,
  recovery: 0.62,
  cooldown: 1.7,
  range: 3.3,
  /** Half-angle of the strike cone, radians. */
  halfAngle: 0.62,
  lungeSpeed: 7.4,
} as const;

export const CROSSBOW = {
  maxBolts: 3,
  reloadTime: 2.4,
  fireCooldown: 0.75,
  projectileSpeed: 30,
  projectileRadius: 0.22,
  projectileLife: 2.6,
  /**
   * Bolt drop. Well below real gravity: at 9.2 the bolt hit the ground around
   * 18m, far short of the sight range, so shots silently vanished into the dirt.
   * At 3.0 it flies usefully to roughly 30m while still dropping enough that
   * long shots reward aiming a little high.
   */
  gravity: 3,
  /** Range within which a level shot is guaranteed to still be above the feet. */
  effectiveRange: 28,
  markDuration: 8,
  slowDuration: 3,
  slowFactor: 0.84,
  /** Recovered by walking over a spent bolt. */
  pickupRadius: 1.6,
} as const;

export const PULSE = {
  cooldown: 17,
  radius: 27,
  /** Traces older than this are not returned at all. */
  maxTraceAge: 26,
  duration: 4.5,
} as const;

export const SNARE = {
  maxActive: 3,
  totalCharges: 3,
  armTime: 1.1,
  radius: 1.15,
  rootDuration: 1.5,
  slowDuration: 2.5,
  slowFactor: 0.6,
  escapeChannel: 1.2,
  placeCooldown: 2.5,
} as const;

export const BREACH = {
  cooldown: 12,
  channel: 1.4,
  range: 3.4,
  /** Self-slow applied after a successful breach. */
  recoverySlow: 0.55,
  recoveryDuration: 1.5,
} as const;

// ---------------------------------------------------------------------------
// Runner kit
// ---------------------------------------------------------------------------

export const DECOY = {
  cooldown: 21,
  lifetime: 9,
  speed: 4.6,
  /** Fake footstep noise cadence, seconds. */
  stepInterval: 0.42,
  noiseRadius: 30,
} as const;

export const SMOKE = {
  cooldown: 27,
  lifetime: 9,
  radius: 6.8,
  /** Fraction of the pulse radius that survives inside the cloud. */
  pulseDamping: 0.25,
} as const;

export const WARD = {
  charges: 2,
  cooldown: 16,
  armTime: 1.2,
  radius: 1.5,
  stunDuration: 1.6,
  runnerHasteDuration: 3.2,
  runnerHasteFactor: 1.24,
  /** The Hunter cannot be stunned again until this expires. */
  stunImmunity: 20,
} as const;

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

/** Hard cap on how far either player can visually resolve the other. */
export const SIGHT_RANGE = 46;
/** Within this radius the Runner is seen even while crouching in cover. */
export const CLOSE_SIGHT_RANGE = 4.5;
/** Hiding spots conceal the Runner beyond this distance. */
export const HIDE_SPOT_CONCEAL_RANGE = 3.0;
/** Foliage conceals a crouching Runner beyond this distance. */
export const FOLIAGE_CONCEAL_RANGE = 6.5;
/** Shadow zones conceal a crouching, non-sprinting Runner beyond this distance. */
export const SHADOW_CONCEAL_RANGE = 12;

export const HEARTBEAT_RANGE = 22;

export const FOOTSTEP_INTERVAL = { walk: 0.46, sprint: 0.32, crouch: 0.78 } as const;
export const FOOTSTEP_NOISE_RADIUS = { walk: 17, sprint: 27, crouch: 7 } as const;
export const FOOTPRINT_LIFETIME = 26;
export const MAX_FOOTPRINTS = 90;

// ---------------------------------------------------------------------------
// Networking / lobby
// ---------------------------------------------------------------------------

export const ROOM_CODE_LENGTH = 4;
/** Ambiguous glyphs (0/O, 1/I, 5/S) are excluded so codes can be read aloud. */
export const ROOM_CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
export const MAX_NAME_LENGTH = 14;
export const RECONNECT_GRACE = 45;
export const EMPTY_ROOM_TTL = 120;

export const MAP_SIZE = 132;
export const MAP_HALF = MAP_SIZE / 2;
