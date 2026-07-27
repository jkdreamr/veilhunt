/**
 * Art-direction constants for "moonlit dark-fantasy ruins".
 *
 * Every colour, material role and atmospheric tunable the world uses lives here
 * so the whole look can be retuned from one file. Nothing in this module
 * touches Three.js — these are plain values consumed by `materials.ts`,
 * `textures.ts` and `sky.ts`.
 *
 * Colours are authored as 0xRRGGBB integers in *sRGB display space*. Materials
 * fed through `THREE.Color` are converted to linear-sRGB automatically by the
 * renderer's colour management; raw `ShaderMaterial`s (the sky) bypass tone
 * mapping and therefore consume these values directly.
 */

// ---------------------------------------------------------------------------
// Core palette
// ---------------------------------------------------------------------------

export const PALETTE = {
  /** Directional moonlight. Cold, slightly blue, never white. */
  moonlight: 0x9dc0e8,
  /** Hemisphere fill — upper half. */
  skyFill: 0x2b3d59,
  /** Hemisphere fill — lower half (bounce off wet stone). */
  groundFill: 0x0c0f14,
  /** Exponential distance fog. */
  fog: 0x0d131e,

  /** Chapel / ruin masonry. */
  stone: 0x525a68,
  /** Contact shadow stone: plinths, trim courses, inset window reveals. */
  stoneDark: 0x252a33,
  /** Slightly warmer masonry used for crypt and tower blocks. */
  stoneWarm: 0x5b5a5a,
  /** Bleached stone used for statues and gravestones. */
  stonePale: 0x6d7280,

  /** Hedge / foliage mass. */
  hedge: 0x22402f,
  /** Grass card tips — a touch lighter so blades read against the mass. */
  hedgeTip: 0x36573d,

  /** Standing water. Glossy, shallow, readable. */
  water: 0x15303e,
  /** Churned mud under the graveyard. */
  mud: 0x2f2820,

  /** Wrought iron: railings, lantern frames, door bands. */
  iron: 0x1c1f26,
  /** Weathered timber: carts, logs, benches, barricades. */
  wood: 0x36291d,
  /** Bone and bead charms. */
  bone: 0xb9b2a2,

  /** Lantern / brazier flame. */
  amber: 0xffb45c,
  /** Ritual light: seals, gate runes, shrine bowl. */
  cyan: 0x6feaff,
  /** Curse light: reserved for hostile markers. */
  magenta: 0xff4d7a,

  /** Spectral crow plumage. */
  crow: 0x14161d,
  /** Ground mist body. */
  mist: 0x5d738f,
  /** Airborne dust motes. */
  mote: 0xb9cfe8,

  // Sky dome (authored in display space — the dome bypasses tone mapping).
  skyZenith: 0x0a0f1c,
  skyMid: 0x16223a,
  skyHorizon: 0x1c2b45,
  skyHaze: 0x2c3e5c,
  moonDisc: 0xf2f6ff,
  moonHalo: 0x7fa4d6,
  star: 0xcfe0f7,
} as const;

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

export const LIGHTING = {
  // These sit at the art-direction values. They were briefly raised while the
  // albedo maps were still mid-grey and multiplying every surface down toward
  // black; with the maps rebalanced to near-white detail modulations (see
  // textures.ts) the specified values expose correctly and anything higher
  // washes the ground out to a pale, snow-like grey.
  moonIntensity: 2.2,
  hemiIntensity: 0.55,
  /**
   * Moon position relative to the map centre: high above and to the north-west
   * (north is -Z in map space, so north-west is -X / -Z).
   */
  moonPosition: { x: -46, y: 72, z: -36 },
  shadowMapSize: 2048,
  shadowBias: -0.0005,
  shadowNormalBias: 0.02,
  /** Tallest thing that needs to cast a shadow (watchtower stub tops out ~17). */
  worldMaxHeight: 20,
  /** Brazier / lantern point lights. Only the nearest few are ever lit. */
  emberLightColor: 0xffb45c,
  emberLightIntensity: 9,
  emberLightDistance: 16,
  emberLightDecay: 1.9,
  maxEmberLights: 5,
} as const;

// ---------------------------------------------------------------------------
// Surface roles: (colour, roughness, metalness) triples used by `materials.ts`
// ---------------------------------------------------------------------------

export interface SurfaceRole {
  readonly color: number;
  readonly roughness: number;
  readonly metalness: number;
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
}

export const SURFACE: Record<string, SurfaceRole> = {
  ground: { color: 0x4d4a44, roughness: 0.96, metalness: 0 },
  stone: { color: PALETTE.stone, roughness: 0.88, metalness: 0 },
  stoneDark: { color: PALETTE.stoneDark, roughness: 0.93, metalness: 0 },
  stoneWarm: { color: PALETTE.stoneWarm, roughness: 0.9, metalness: 0 },
  stonePale: { color: PALETTE.stonePale, roughness: 0.82, metalness: 0 },
  hedge: { color: PALETTE.hedge, roughness: 0.97, metalness: 0 },
  grass: { color: PALETTE.hedgeTip, roughness: 0.95, metalness: 0 },
  water: { color: PALETTE.water, roughness: 0.3, metalness: 0.06 },
  iron: { color: PALETTE.iron, roughness: 0.52, metalness: 0.72 },
  wood: { color: PALETTE.wood, roughness: 0.91, metalness: 0 },
  bone: { color: PALETTE.bone, roughness: 0.74, metalness: 0 },
  crow: { color: PALETTE.crow, roughness: 0.68, metalness: 0.05 },
  amber: {
    color: 0x2a1a0c,
    roughness: 0.4,
    metalness: 0,
    emissive: PALETTE.amber,
    // Kept low deliberately: ACES clips anything much above ~2 to white, and a
    // lantern that reads as a white box loses all of its amber.
    emissiveIntensity: 1.45,
  },
  cyan: {
    color: 0x081a20,
    roughness: 0.32,
    metalness: 0,
    emissive: PALETTE.cyan,
    emissiveIntensity: 1.25,
  },
  magenta: {
    color: 0x22060f,
    roughness: 0.34,
    metalness: 0,
    emissive: PALETTE.magenta,
    emissiveIntensity: 1.15,
  },
};

// ---------------------------------------------------------------------------
// Atmosphere & motion
// ---------------------------------------------------------------------------

export const ATMOSPHERE = {
  /** `map.fogDensity` is the base; late-match `fogBoost` scales toward this. */
  fogBoostMax: 1.9,
  mistY: 0.32,
  mistPlanes: { low: 0, medium: 16, high: 30 },
  mistRadius: { min: 7, max: 16 },
  mistOpacity: 0.16,
  moteCount: { low: 0, medium: 0, high: 1100 },
  /** Motes live in a box that follows the camera so they are always visible. */
  moteBox: { x: 46, y: 13, z: 46 },
  crowCount: { low: 0, medium: 7, high: 10 },
  crowStartleRadius: 14,
  crowFlightSpeed: 9.5,
  crowReturnDelay: { min: 9, max: 17 },
} as const;

export const WIND = {
  /** Base sway strength in world units at the tip of a swaying element. */
  strength: 1,
  /** Reduced-motion clamp: enough to not look frozen-broken, close to still. */
  reducedStrength: 0.04,
  /** Radius over which `reactAt` bends grass. */
  bendRadius: 7,
  /** Seconds for a `reactAt` bend to relax. */
  bendDecay: 1.15,
} as const;

/** Low quality lands at roughly half the card count of high, as specified. */
export const GRASS = {
  /** Extra scattered cards on top of the authored `grass` props. */
  scatter: { low: 1600, medium: 2400, high: 3200 },
  /** Cards spawned per authored `grass` prop (a clump). */
  perProp: { low: 4, medium: 6, high: 8 },
} as const;

/**
 * Ground-plane texture resolutions. The macro layer maps 1:1 over the whole
 * map and only carries low-frequency zone tint and path wear, so 512 is ample;
 * all the crispness comes from the tiling detail layer on top of it.
 */
export const TEXTURE_SIZE = {
  groundMacro: 512,
  groundDetail: 512,
  stone: 512,
  small: 256,
  tiny: 128,
} as const;

/** World units per detail-texture tile. Drives the world-projected UV scale. */
export const UV_SCALE = {
  ground: 1 / 5.5,
  stone: 1 / 3.2,
  hedge: 1 / 2.4,
  wood: 1 / 1.6,
  iron: 1 / 1.1,
} as const;
