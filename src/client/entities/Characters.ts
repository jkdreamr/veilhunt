/**
 * Authored low-poly character rigs for the Runner and the Hunter.
 *
 * Both silhouettes are built from procedural geometry (lathed bodies with
 * authored radius profiles, tapered limb segments with spherical joint caps,
 * bevelled armour plates and hand-built cloth strips) and merged down to a
 * handful of meshes so the pair stays inside the 40 draw-call budget.
 *
 * Every mesh hangs off a named joint group; animation is fully procedural,
 * driven from an accumulated stride phase and exponential/spring followers, so
 * it is frame-rate independent and deterministic.
 *
 * Conventions
 *  - Local -Z is forward (matches `CameraRig`'s yaw → direction mapping).
 *  - Limb geometry hangs *down* from its joint origin, so a joint rotation of
 *    +x swings the limb forward.
 *  - Stride `phase` is normalised to 0..1 (one full left+right stride).
 *  - Surface detail is baked into a four-channel `aGlow` vertex attribute and
 *    resolved by a shader injection, which lets one merged mesh carry emissive
 *    accents, wound seams, light-swallowing voids *and* a second (trim) metal
 *    without paying extra draw calls.
 */

import * as THREE from 'three';
import type { CharacterRig, CreateCharacterOptions, QualityLevel } from '../contracts.js';
import { BLADE, type WoundLevel } from '../../shared/constants.js';
import { createRng, type Rng } from '../../shared/rng.js';

// ---------------------------------------------------------------------------
// Palette (kept in step with `world/palette.ts`)
// ---------------------------------------------------------------------------

const COLOR_CLOTH = 0x4d5461;
const COLOR_LEATHER = 0x3a2f26;
/** Hunter's oiled hide: coat lining, straps, greaves and boots. */
const COLOR_HIDE = 0x2f2b25;
const COLOR_CYAN = 0x6feaff;
const COLOR_IRON = 0x1c1f26;
const COLOR_AMBER = 0xffb45c;
const COLOR_MAGENTA = 0xff4d7a;
/** Runner trim: bone charms, buckles and pale worn leather. */
const COLOR_BONE = 0xb9b2a2;
/** Hunter trim: lit bronze filigree on blackened iron. */
const COLOR_TRIM_BRONZE = 0x8d6c3a;

const TAU = Math.PI * 2;

/** Reference sprint speed used to normalise the gait blend. */
const SPRINT_REF = 6.5;

/** Wound level → seam glow strength. */
const WOUND_GLOW: Record<WoundLevel, number> = {
  unmarked: 0,
  wounded: 0.55,
  cursed: 1.35,
};

/** Wound level → limp amount. */
const WOUND_LIMP: Record<WoundLevel, number> = {
  unmarked: 0,
  wounded: 0.28,
  cursed: 0.62,
};

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Frame-rate independent exponential approach. */
function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Cubic Hermite between two values with incoming/outgoing tangents. */
function hermite(v0: number, v1: number, m0: number, m1: number, x: number): number {
  const x2 = x * x;
  const x3 = x2 * x;
  return (
    (2 * x3 - 3 * x2 + 1) * v0 +
    (x3 - 2 * x2 + x) * m0 +
    (-2 * x3 + 3 * x2) * v1 +
    (x3 - x2) * m1
  );
}

type Key = readonly [number, number];

/**
 * A cyclic Catmull-Rom keyframe track sampled over a normalised 0..1 stride.
 *
 * Gait channels are authored as poses (heel strike, mid-stance, toe-off, swing)
 * and this evaluates them with C1 continuity, so limbs *ease* between poses
 * instead of ticking. Raw sines cannot express a stance phase that tracks the
 * ground at a constant rate, which is what stops the feet from skating.
 */
class Cycle {
  private readonly t: Float64Array;
  private readonly v: Float64Array;

  constructor(keys: readonly Key[]) {
    this.t = Float64Array.from(keys, (k) => k[0]);
    this.v = Float64Array.from(keys, (k) => k[1]);
  }

  at(p: number): number {
    const t = this.t;
    const v = this.v;
    const n = t.length;
    const u = p - Math.floor(p);

    let i = n - 1;
    for (let k = 0; k < n; k += 1) {
      if (t[k] > u) {
        i = k - 1;
        break;
      }
    }
    if (i < 0) i = n - 1;

    const i1 = (i + 1) % n;
    const i0 = (i - 1 + n) % n;
    const i2 = (i + 2) % n;

    const wrap = (d: number): number => (d <= 0 ? d + 1 : d);
    const span = wrap(t[i1] - t[i]);
    const prev = wrap(t[i] - t[i0]);
    const next = wrap(t[i2] - t[i1]);

    let d = u - t[i];
    if (d < 0) d += 1;
    const x = clamp(d / span, 0, 1);

    const m0 = ((v[i1] - v[i0]) / (prev + span)) * span;
    const m1 = ((v[i2] - v[i]) / (span + next)) * span;
    return hermite(v[i], v[i1], m0, m1, x);
  }
}

/** Smooth, non-cyclic Catmull-Rom over authored control points. */
function ramp(points: readonly Key[]): (x: number) => number {
  const n = points.length;
  return (x) => {
    if (x <= points[0][0]) return points[0][1];
    if (x >= points[n - 1][0]) return points[n - 1][1];
    let i = 0;
    while (i < n - 2 && points[i + 1][0] <= x) i += 1;
    const t0 = points[i][0];
    const v0 = points[i][1];
    const t1 = points[i + 1][0];
    const v1 = points[i + 1][1];
    const span = t1 - t0;
    const pPrev = i > 0 ? points[i - 1] : points[i];
    const pNext = i + 2 < n ? points[i + 2] : points[i + 1];
    const m0 = ((v1 - pPrev[1]) / Math.max(1e-5, t1 - pPrev[0])) * span;
    const m1 = ((pNext[1] - v0) / Math.max(1e-5, pNext[0] - t0)) * span;
    return hermite(v0, v1, m0, m1, (x - t0) / span);
  };
}

/** Deterministic smooth wobble: three seeded sines, output roughly -1..1. */
function makeWave(rng: Rng): (t: number) => number {
  const a = rng.range(0, TAU);
  const b = rng.range(0, TAU);
  const c = rng.range(0, TAU);
  return (t) =>
    Math.sin(t + a) * 0.54 + Math.sin(t * 1.73 + b) * 0.31 + Math.sin(t * 2.91 + c) * 0.15;
}

// ---------------------------------------------------------------------------
// Gait tracks
// ---------------------------------------------------------------------------

/**
 * Hip pitch, normalised to ±1, over one stride starting at heel strike.
 * The stance span (0 → ~0.62) is deliberately close to linear: the planted
 * foot then sweeps backward at a constant rate and tracks the ground.
 */
const HIP_WALK = new Cycle([
  [0.0, 1.0],
  [0.16, 0.52],
  [0.31, 0.05],
  [0.47, -0.45],
  [0.62, -0.94],
  [0.7, -0.7],
  [0.8, 0.04],
  [0.9, 0.72],
]);

/** Running shortens the stance to ~0.46 and lengthens the airborne swing. */
const HIP_RUN = new Cycle([
  [0.0, 1.05],
  [0.12, 0.6],
  [0.24, 0.14],
  [0.36, -0.44],
  [0.46, -0.98],
  [0.55, -0.82],
  [0.66, -0.08],
  [0.78, 0.66],
  [0.9, 1.02],
]);

/** Knee flexion, 0..1 before amplitude scaling. */
const KNEE_WALK = new Cycle([
  [0.0, 0.09],
  [0.1, 0.25],
  [0.22, 0.12],
  [0.42, 0.04],
  [0.56, 0.2],
  [0.68, 0.86],
  [0.78, 0.72],
  [0.88, 0.26],
  [0.95, 0.1],
]);

const KNEE_RUN = new Cycle([
  [0.0, 0.24],
  [0.1, 0.55],
  [0.22, 0.34],
  [0.4, 0.26],
  [0.5, 0.66],
  [0.6, 1.26],
  [0.7, 1.08],
  [0.82, 0.54],
  [0.93, 0.24],
]);

/** Walking: body is lowest at double support, highest over mid-stance. */
const BOB_WALK = new Cycle([
  [0.0, -1.0],
  [0.25, 1.0],
  [0.5, -1.0],
  [0.75, 1.0],
]);

/** Running: lowest under mid-stance compression, highest at flight apex. */
const BOB_RUN = new Cycle([
  [0.0, -0.3],
  [0.16, -1.0],
  [0.42, 1.0],
  [0.5, -0.3],
  [0.66, -1.0],
  [0.92, 1.0],
]);

/** Arm swing is far more sinusoidal than the leg cycle. */
const ARM_SWING = new Cycle([
  [0.0, 1.0],
  [0.25, 0.0],
  [0.5, -1.0],
  [0.75, 0.0],
]);

/** Ankle roll layered on top of the level-keeping compensation. */
const FOOT_ROLL = new Cycle([
  [0.0, 0.42],
  [0.12, 0.02],
  [0.44, -0.06],
  [0.56, -0.55],
  [0.66, -0.3],
  [0.8, 0.22],
  [0.92, 0.4],
]);

// ---------------------------------------------------------------------------
// Shader injection: accent glow, wound seams, trim metal and a fresnel rim
// ---------------------------------------------------------------------------

/**
 * Bumped whenever the injected GLSL below changes. Three appends this to the
 * generated program key; without it the renderer can hand back a cached
 * *un-injected* `physical` program compiled for some other standard material.
 */
const RIG_CACHE_KEY = 'veilhunt-rig-v2';

interface RigUniforms {
  uAccent: THREE.IUniform<THREE.Color>;
  uAccentPower: THREE.IUniform<number>;
  uWoundColor: THREE.IUniform<THREE.Color>;
  uWoundPower: THREE.IUniform<number>;
  uRimColor: THREE.IUniform<THREE.Color>;
  uRimPower: THREE.IUniform<number>;
  uTrim: THREE.IUniform<THREE.Color>;
}

function createRigUniforms(accent: number, trim: number): RigUniforms {
  return {
    uAccent: { value: new THREE.Color(accent) },
    uAccentPower: { value: 1 },
    uWoundColor: { value: new THREE.Color(COLOR_MAGENTA) },
    uWoundPower: { value: 0 },
    uRimColor: { value: new THREE.Color(COLOR_CYAN) },
    uRimPower: { value: 0 },
    uTrim: { value: new THREE.Color(trim) },
  };
}

function injectRigShader(material: THREE.MeshStandardMaterial, u: RigUniforms): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAccent = u.uAccent;
    shader.uniforms.uAccentPower = u.uAccentPower;
    shader.uniforms.uWoundColor = u.uWoundColor;
    shader.uniforms.uWoundPower = u.uWoundPower;
    shader.uniforms.uRimColor = u.uRimColor;
    shader.uniforms.uRimPower = u.uRimPower;
    shader.uniforms.uTrim = u.uTrim;

    shader.vertexShader = `attribute vec4 aGlow;
varying vec4 vGlow;
${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
	vGlow = aGlow;`,
    );

    shader.fragmentShader = `uniform vec3 uAccent;
uniform float uAccentPower;
uniform vec3 uWoundColor;
uniform float uWoundPower;
uniform vec3 uRimColor;
uniform float uRimPower;
uniform vec3 uTrim;
varying vec4 vGlow;
${shader.fragmentShader}`
      // Trim vertices read as polished metal rather than painted-on colour.
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
	roughnessFactor = mix( roughnessFactor, 0.34, clamp( vGlow.w, 0.0, 1.0 ) );`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
	metalnessFactor = mix( metalnessFactor, 0.88, clamp( vGlow.w, 0.0, 1.0 ) );`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
	// Channel w: blend albedo toward the rig's trim metal (buckles, filigree).
	diffuseColor.rgb = mix( diffuseColor.rgb, uTrim, clamp( vGlow.w, 0.0, 1.0 ) );
	// Channel z: signed shade. Positive swallows light (hood / helm interior),
	// negative lifts a surface so worn leather reads against the cloth.
	diffuseColor.rgb *= max( 0.0, 1.0 - vGlow.z );
	totalEmissiveRadiance += uAccent * ( vGlow.x * uAccentPower );
	totalEmissiveRadiance += uWoundColor * ( vGlow.y * uWoundPower );
	float rimFacing = 1.0 - clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
	totalEmissiveRadiance += uRimColor * ( pow( rimFacing, 2.6 ) * uRimPower );`,
      );
  };
  material.customProgramCacheKey = () => RIG_CACHE_KEY;
}

// ---------------------------------------------------------------------------
// Geometry authoring helpers
// ---------------------------------------------------------------------------

interface Part {
  geo: THREE.BufferGeometry;
  /** `[accent, woundSeam, shade, trim]`, baked per vertex. `shade` may go negative. */
  glow?: readonly number[];
  matrix?: THREE.Matrix4;
}

const IDENTITY = new THREE.Matrix4();

/**
 * Merges authored parts into one indexed geometry carrying position, normal and
 * the custom `aGlow` attribute. Source geometries are consumed and disposed.
 */
function mergeParts(parts: Part[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const glows: number[] = [];
  const indices: number[] = [];
  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();

  for (const part of parts) {
    const geo = part.geo;
    const pos = geo.getAttribute('position');
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const nrm = geo.getAttribute('normal');
    const base = positions.length / 3;
    const m = part.matrix ?? IDENTITY;
    normalMatrix.setFromMatrix4(m).invert().transpose();
    const gx = part.glow?.[0] ?? 0;
    const gy = part.glow?.[1] ?? 0;
    const gz = part.glow?.[2] ?? 0;
    const gw = part.glow?.[3] ?? 0;

    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      positions.push(v.x, v.y, v.z);
      v.fromBufferAttribute(nrm, i).applyMatrix3(normalMatrix).normalize();
      normals.push(v.x, v.y, v.z);
      glows.push(gx, gy, gz, gw);
    }

    const idx = geo.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i += 1) indices.push(base + idx.getX(i));
    } else {
      for (let i = 0; i < pos.count; i += 1) indices.push(base + i);
    }
    geo.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  out.setAttribute('aGlow', new THREE.Float32BufferAttribute(glows, 4));
  out.setIndex(indices);
  out.computeBoundingSphere();
  return out;
}

/** Transform helper used while authoring parts. */
function place(
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** Applies a radial profile curve to a Y-aligned geometry (per-vertex scaling). */
function taperY(
  geo: THREE.BufferGeometry,
  halfHeight: number,
  profile: (t: number) => number,
): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i += 1) {
    const t = clamp((pos.getY(i) + halfHeight) / (halfHeight * 2), 0, 1);
    const k = profile(t);
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * A tapered limb segment that hangs from the origin down to -length.
 * `profile(t)` receives 0 at the far (distal) end and 1 at the joint.
 */
function limb(
  radius: number,
  length: number,
  radial: number,
  profile: (t: number) => number,
  rows = 6,
  flattenZ = 1,
): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, length, radial, rows, false);
  taperY(geo, length / 2, profile);
  if (flattenZ !== 1) geo.scale(1, 1, flattenZ);
  geo.translate(0, -length / 2, 0);
  return geo;
}

/**
 * Joint cap centred exactly on a pivot. Because it sits *on* the rotation
 * origin it can never separate from the parent segment, which is what closes
 * the shoulder / elbow / hip / knee gaps for good.
 */
function ball(radius: number, radial: number, squashY = 1, squashZ = 1): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(radius, radial, Math.max(4, Math.round(radial * 0.55)));
  if (squashY !== 1 || squashZ !== 1) geo.scale(1, squashY, squashZ);
  return geo;
}

/** Lathe body: `profile` returns radius for t in 0..1 spanning y0..y1. */
function lathe(
  y0: number,
  y1: number,
  rows: number,
  segments: number,
  profile: (t: number) => number,
): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= rows; i += 1) {
    const t = i / rows;
    pts.push(new THREE.Vector2(Math.max(0.012, profile(t)), lerp(y0, y1, t)));
  }
  return new THREE.LatheGeometry(pts, segments);
}

/**
 * A bevelled plate: the workhorse for armour, buckles, satchels and straps.
 * Replaces raw boxes so nothing reads as an untextured cube at close range.
 */
function plate(
  width: number,
  height: number,
  depth: number,
  radius: number,
  curve = 2,
): THREE.BufferGeometry {
  const r = Math.min(radius, width * 0.45, height * 0.45);
  const hw = Math.max(0.0008, width / 2 - r);
  const hh = Math.max(0.0008, height / 2 - r);
  const shape = new THREE.Shape();
  shape.absarc(hw, hh, r, 0, Math.PI / 2, false);
  shape.absarc(-hw, hh, r, Math.PI / 2, Math.PI, false);
  shape.absarc(-hw, -hh, r, Math.PI, Math.PI * 1.5, false);
  shape.absarc(hw, -hh, r, Math.PI * 1.5, TAU, false);

  const bevel = Math.min(r * 0.75, depth * 0.34);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, depth - bevel * 2),
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 1,
    steps: 1,
    curveSegments: curve,
  });
  geo.translate(0, 0, bevel - depth / 2);
  geo.computeVertexNormals();
  return geo;
}

/** A run of tiny stitches along a straight seam — cheap, reads as craft. */
function stitches(
  parts: Part[],
  count: number,
  from: THREE.Vector3,
  to: THREE.Vector3,
  size: number,
  glow: readonly number[],
): void {
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    const t = (i + 0.5) / count;
    p.copy(from).lerp(to, t);
    parts.push({
      geo: new THREE.BoxGeometry(size * 2.1, size, size),
      matrix: place(p.x, p.y, p.z, 0, 0, (i % 2 === 0 ? 1 : -1) * 0.5),
      glow,
    });
  }
}

/** Long ritual blade: extruded diamond cross-section with a fullered spine. */
function bladeGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.04);
  shape.lineTo(0.052, 0.05);
  shape.lineTo(0.042, 0.92);
  shape.lineTo(0.02, 1.16);
  shape.lineTo(0, 1.3);
  shape.lineTo(-0.02, 1.16);
  shape.lineTo(-0.042, 0.92);
  shape.lineTo(-0.052, 0.05);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.026,
    bevelEnabled: true,
    bevelSize: 0.009,
    bevelThickness: 0.008,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 1,
  });
  geo.translate(0, 0, -0.013);
  return geo;
}

/** Antler / horn tine built from a chain of shrinking segments. */
function tine(
  parts: Part[],
  rng: Rng,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  length: number,
  radius: number,
  depth: number,
  radial: number,
): void {
  const step = length / 3;
  const cursor = origin.clone();
  const heading = dir.clone().normalize();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 3; i += 1) {
    const r = radius * (1 - i * 0.26);
    const seg = limb(r, step * 1.08, radial, (t) => 0.66 + t * 0.4, 3);
    const mid = cursor.clone().addScaledVector(heading, step);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), heading);
    parts.push({
      geo: seg,
      matrix: new THREE.Matrix4().compose(cursor.clone(), q, new THREE.Vector3(1, 1, 1)),
      glow: [0, 0, 0, 0.12],
    });
    // A knuckle at each kink so the chain reads as one grown horn.
    parts.push({ geo: ball(r * 1.02, radial), matrix: place(mid.x, mid.y, mid.z) });
    cursor.copy(mid);
    // Curl outward and back, with a seeded wobble so the pair is not mirrored.
    heading.applyAxisAngle(up, rng.range(-0.22, 0.22));
    heading.addScaledVector(new THREE.Vector3(0, 0.34, 0.1), 0.34).normalize();
    if (depth > 0 && i === 0) {
      const branch = heading
        .clone()
        .applyAxisAngle(up, rng.range(0.5, 0.9))
        .add(new THREE.Vector3(0, 0.4, 0))
        .normalize();
      tine(parts, rng, cursor.clone(), branch, length * 0.52, radius * 0.6, depth - 1, radial);
    }
  }
}

// ---------------------------------------------------------------------------
// Drape (cloak / scarf / coat tail) — a spring-driven cloth strip
// ---------------------------------------------------------------------------

interface DrapeStrip {
  /** Wrap radius at the top of the strip: cloth is a cylinder section, not a card. */
  radius: number;
  /** Angular span around the body, radians. */
  arc: number;
  length: number;
  /** Positive shrinks the wrap toward the hem, negative flares it. */
  taper: number;
  originX: number;
  originY: number;
  originZ: number;
  swayAmp: number;
  swayHz: number;
  billow: number;
  /** Vertical fold count across the span — the thing that reads as cloth. */
  folds: number;
  /** Fold depth as a fraction of the wrap radius. */
  foldDepth: number;
  /** Sideways responsiveness to turning and footfalls. */
  whip: number;
  glow: readonly number[];
}

const DRAPE_COLS = 9;
const DRAPE_ROWS = 10;

/**
 * Cloth as a chain of damped springs, one per row. Each row chases the row
 * above it rather than the body, so motion propagates down the cloak, overshoots
 * and settles instead of moving rigidly with the hips.
 */
class Drape {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly position: THREE.BufferAttribute;
  private readonly strips: DrapeStrip[];
  private readonly trail: Float32Array;
  private readonly trailVel: Float32Array;
  private readonly sway: Float32Array;
  private readonly swayVel: Float32Array;
  private phase = 0;

  constructor(strips: DrapeStrip[], material: THREE.Material) {
    this.strips = strips;
    const vertsPerStrip = DRAPE_COLS * DRAPE_ROWS;
    const total = vertsPerStrip * strips.length;
    const positions = new Float32Array(total * 3);
    const glows = new Float32Array(total * 4);
    const indices: number[] = [];

    for (let s = 0; s < strips.length; s += 1) {
      const base = s * vertsPerStrip;
      const strip = strips[s];
      for (let i = 0; i < vertsPerStrip; i += 1) {
        const row = (i / DRAPE_COLS) | 0;
        const tip = row / (DRAPE_ROWS - 1);
        const o = (base + i) * 4;
        // Accent fades in toward the trailing tip of each strip.
        glows[o] = (strip.glow[0] ?? 0) * tip;
        glows[o + 1] = strip.glow[1] ?? 0;
        // Shade deepens into the fold valleys and up under the shoulders.
        const col = i % DRAPE_COLS;
        const u = (col / (DRAPE_COLS - 1)) * 2 - 1;
        const valley = Math.max(0, -Math.cos(u * Math.PI * strip.folds));
        glows[o + 2] = (strip.glow[2] ?? 0) + valley * 0.16 + (1 - tip) * 0.1;
        glows[o + 3] = strip.glow[3] ?? 0;
      }
      for (let r = 0; r < DRAPE_ROWS - 1; r += 1) {
        for (let c = 0; c < DRAPE_COLS - 1; c += 1) {
          const a = base + r * DRAPE_COLS + c;
          const b = a + 1;
          const d = a + DRAPE_COLS;
          const e = d + 1;
          indices.push(a, d, b, b, d, e);
        }
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.position = new THREE.Float32BufferAttribute(positions, 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('aGlow', new THREE.Float32BufferAttribute(glows, 4));
    this.geometry.setIndex(indices);

    const rows = DRAPE_ROWS * strips.length;
    this.trail = new Float32Array(rows);
    this.trailVel = new Float32Array(rows);
    this.sway = new Float32Array(rows);
    this.swayVel = new Float32Array(rows);

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.write(0);
    this.geometry.computeVertexNormals();
  }

  /**
   * `flow` is the 0..1 backward billow (speed + crouch tuck), `side` the lateral
   * push from turning, `kick` a one-frame impulse fired on each footfall.
   */
  update(dt: number, flow: number, side: number, kick: number): void {
    this.phase += dt;
    const rows = DRAPE_ROWS;
    // Sub-step so a long frame cannot destabilise the explicit integrator.
    const sub = dt > 0.034 ? 3 : dt > 0.019 ? 2 : 1;
    const h = dt / sub;

    for (let s = 0; s < this.strips.length; s += 1) {
      const off = s * rows;
      if (kick > 0) {
        for (let r = 1; r < 4; r += 1) this.trailVel[off + r] += kick * (0.6 - r * 0.12);
      }
      for (let n = 0; n < sub; n += 1) {
        for (let r = 0; r < rows; r += 1) {
          const i = off + r;
          const srcT = r === 0 ? flow : this.trail[i - 1];
          const srcS = r === 0 ? side : this.sway[i - 1];
          // Upper rows are stiff (stitched to the body), lower rows loose.
          const k = 165 - r * 12;
          const c = 2 * Math.sqrt(k) * 0.56;
          this.trailVel[i] += ((srcT - this.trail[i]) * k - this.trailVel[i] * c) * h;
          this.trail[i] += this.trailVel[i] * h;
          this.swayVel[i] += ((srcS - this.sway[i]) * k * 0.72 - this.swayVel[i] * c * 0.8) * h;
          this.sway[i] += this.swayVel[i] * h;
        }
      }
    }

    this.write(this.phase);
    this.geometry.computeVertexNormals();
    this.position.needsUpdate = true;
    const normal = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
    normal.needsUpdate = true;
  }

  private write(time: number): void {
    const arr = this.position.array as Float32Array;
    let w = 0;
    for (let s = 0; s < this.strips.length; s += 1) {
      const strip = this.strips[s];
      const off = s * DRAPE_ROWS;
      for (let r = 0; r < DRAPE_ROWS; r += 1) {
        const t = r / (DRAPE_ROWS - 1);
        const trail = this.trail[off + r];
        const lateral = this.sway[off + r] * strip.whip;
        const sway =
          Math.sin(time * strip.swayHz + t * 2.7 + s * 1.9) * strip.swayAmp * t * (0.35 + trail);
        const radius = strip.radius * (1 - t * strip.taper);
        // Gravity drop shortens as the strip billows backward.
        const drop = -strip.length * t * (1 - trail * 0.2);
        const back = strip.billow * trail * t * t;
        // Folds deepen as the cloth hangs slack and flatten out when it streams.
        const foldAmp = strip.foldDepth * (0.3 + t * 0.95) * (1 - trail * 0.2);
        // A travelling ripple keeps a streaming cloak from reading as a board.
        const ripple =
          Math.sin(t * 5.6 - time * (2.2 + strip.swayHz)) * 0.035 * t * Math.min(1, trail);
        const y =
          strip.originY +
          drop +
          Math.sin(t * Math.PI) * 0.012 +
          ripple -
          Math.abs(lateral) * t * 0.05;
        for (let c = 0; c < DRAPE_COLS; c += 1) {
          const u = (c / (DRAPE_COLS - 1)) * 2 - 1;
          const fold = Math.cos(u * Math.PI * strip.folds);
          // Cloth is a cylinder section wrapped around the body's back, so it
          // catches light across its own curvature instead of reading as a card.
          const rr = radius * (1 + fold * foldAmp);
          const ang = u * strip.arc * 0.5;
          arr[w] = strip.originX + Math.sin(ang) * rr + sway + lateral * t;
          arr[w + 1] = y;
          arr[w + 2] = strip.originZ + Math.cos(ang) * rr + back;
          w += 3;
        }
      }
    }
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Rig particles — one instanced billboard cloud shared by embers and stun motes
// ---------------------------------------------------------------------------

const QUAD_POS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
const QUAD_UV = [0, 0, 1, 0, 1, 1, 0, 1];
const QUAD_IDX = [0, 1, 2, 0, 2, 3];

const BILLBOARD_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute vec4 aColor;
attribute vec3 aParam; // x = size, y = rotation, z = variant
varying vec4 vColor;
varying vec2 vUv;
varying float vVariant;
#ifdef USE_FOG
varying float vFogDepth;
#endif
void main() {
	vColor = aColor;
	vUv = uv;
	vVariant = aParam.z;
	vec4 mv = modelViewMatrix * vec4( aOffset, 1.0 );
	float s = sin( aParam.y );
	float c = cos( aParam.y );
	vec2 corner = position.xy * aParam.x;
	mv.xy += vec2( corner.x * c - corner.y * s, corner.x * s + corner.y * c );
	#ifdef USE_FOG
	vFogDepth = - mv.z;
	#endif
	gl_Position = projectionMatrix * mv;
}
`;

/** Additive soft puff. `uSoft` biases between a tight spark and a wide bloom. */
const BILLBOARD_FRAG = /* glsl */ `
uniform float uAlpha;
uniform float uSoft;
varying vec4 vColor;
varying vec2 vUv;
varying float vVariant;
#ifdef USE_FOG
uniform vec3 fogColor;
varying float vFogDepth;
#ifdef FOG_EXP2
uniform float fogDensity;
#else
uniform float fogNear;
uniform float fogFar;
#endif
#endif
void main() {
	vec2 p = vUv * 2.0 - 1.0;
	float d = dot( p, p );
	if ( d > 1.0 ) discard;
	float core = pow( max( 0.0, 1.0 - d ), mix( 1.4, 3.4, uSoft ) );
	float spokes = 0.82 + 0.18 * sin( vVariant * 6.2831 + atan( p.y, p.x ) * 3.0 );
	float a = vColor.a * core * spokes * uAlpha;
	#ifdef USE_FOG
	#ifdef FOG_EXP2
	float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
	float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	// Additive particles must fade *out* in fog, never toward the fog colour.
	a *= 1.0 - fogFactor;
	#endif
	if ( a < 0.002 ) discard;
	gl_FragColor = vec4( vColor.rgb, a );
}
`;

function fogUniforms(): Record<string, THREE.IUniform> {
  return {
    fogColor: { value: new THREE.Color(0x000000) },
    fogDensity: { value: 0.0 },
    fogNear: { value: 1 },
    fogFar: { value: 1000 },
  };
}

interface BillboardCloud {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  offset: THREE.InstancedBufferAttribute;
  color: THREE.InstancedBufferAttribute;
  param: THREE.InstancedBufferAttribute;
}

function createBillboardCloud(
  capacity: number,
  blending: THREE.Blending,
  soft: number,
): BillboardCloud {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(QUAD_POS.slice(), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(QUAD_UV.slice(), 2));
  geometry.setIndex(QUAD_IDX.slice());

  const offset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  const color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const param = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  offset.setUsage(THREE.DynamicDrawUsage);
  color.setUsage(THREE.DynamicDrawUsage);
  param.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aOffset', offset);
  geometry.setAttribute('aColor', color);
  geometry.setAttribute('aParam', param);
  geometry.instanceCount = 0;

  const material = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 1 }, uSoft: { value: soft }, ...fogUniforms() },
    vertexShader: BILLBOARD_VERT,
    fragmentShader: BILLBOARD_FRAG,
    transparent: true,
    depthWrite: false,
    blending,
    side: THREE.DoubleSide,
    fog: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 6;
  return { mesh, geometry, material, offset, color, param };
}

// ---------------------------------------------------------------------------
// Rig skeleton
// ---------------------------------------------------------------------------

interface RigMeshes {
  torso: THREE.Mesh;
  head: THREE.Mesh;
  upperArmL: THREE.Mesh;
  foreArmL: THREE.Mesh;
  upperArmR: THREE.Mesh;
  foreArmR: THREE.Mesh;
  thighL: THREE.Mesh;
  shinL: THREE.Mesh;
  thighR: THREE.Mesh;
  shinR: THREE.Mesh;
  footL: THREE.Mesh;
  footR: THREE.Mesh;
}

interface RigJoints {
  rig: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  neck: THREE.Group;
  head: THREE.Group;
  shoulderL: THREE.Group;
  shoulderR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  handR: THREE.Group;
  hipL: THREE.Group;
  hipR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  ankleL: THREE.Group;
  ankleR: THREE.Group;
  cloak: THREE.Group;
  lantern: THREE.Group;
}

interface RigDims {
  hipY: number;
  hipX: number;
  torsoLen: number;
  shoulderX: number;
  shoulderY: number;
  upperArmLen: number;
  foreArmLen: number;
  thighLen: number;
  shinLen: number;
  /** Effective hip→ankle reach, used to keep stride length matched to speed. */
  legLength: number;
  cloakY: number;
}

interface BuiltBody {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  foreArm: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  foot: THREE.BufferGeometry;
  drape: DrapeStrip[];
  dims: RigDims;
  lantern?: THREE.BufferGeometry;
  blade?: THREE.BufferGeometry;
}

function namedGroup(name: string, x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  return g;
}

// ---------------------------------------------------------------------------
// Character implementation
// ---------------------------------------------------------------------------

class Character implements CharacterRig {
  readonly group = new THREE.Group();

  private readonly role: 'hunter' | 'runner';
  private readonly quality: QualityLevel;
  private readonly rng: Rng;

  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly uniforms: RigUniforms;
  private readonly meshes: RigMeshes;
  private readonly joints: RigJoints;
  private readonly dims: RigDims;
  private readonly drape: Drape;
  private readonly particles: BillboardCloud;
  private readonly particleState: Float32Array;
  private readonly particleCount: number;
  private readonly emberCount: number;

  private readonly bladeTrail: THREE.Mesh | null = null;
  private readonly bladeTrailMat: THREE.MeshBasicMaterial | null = null;
  private readonly lanternLight: THREE.PointLight | null = null;
  private readonly disposables: { dispose(): void }[] = [];

  /** Seeded idle wobbles: look-around, its gate, and the weight shift. */
  private readonly waveLook: (t: number) => number;
  private readonly waveGate: (t: number) => number;
  private readonly waveShift: (t: number) => number;

  // Animation state -------------------------------------------------------
  private time = 0;
  /** Normalised stride position, 0..1. */
  private phase = 0;
  private runBlend = 0;
  private crouchBlend = 0;
  private speedBlend = 0;
  private lastSpeed = 0;

  // Secondary-motion followers (all frame-rate independent).
  private spineTwist = 0;
  private spineLean = 0;
  private headYaw = 0;
  private headPitch = 0;
  private headRoll = 0;
  private elbowLBlend = 0.24;
  private elbowRBlend = 0.24;
  private bobSmooth = 0;
  private turnRate = 0;
  private lastYaw = 0;
  private yawSeen = false;
  private lanternAngle = 0;
  private lanternVel = 0;

  private wound: WoundLevel = 'unmarked';
  private woundBlend = 0;
  private limpBlend = 0;
  private marked = false;
  private markBlend = 0;
  private stunned = false;
  private stunBlend = 0;

  private attacking = false;
  private attackTime = 0;
  private trailStrength = 0;

  private alpha = 1;

  constructor(options: CreateCharacterOptions) {
    this.role = options.role;
    this.quality = options.quality;
    this.group.name = `rig-${options.role}`;
    // A fixed per-role seed keeps horn curl / ember scatter reproducible.
    this.rng = createRng(this.role === 'hunter' ? 0x48554e54 : 0x52554e4e);
    // A second stream so authoring changes never shift the idle wobbles.
    const idleRng = createRng(this.role === 'hunter' ? 0x1d1e0001 : 0x1d1e0002);
    this.waveLook = makeWave(idleRng);
    this.waveGate = makeWave(idleRng);
    this.waveShift = makeWave(idleRng);

    const hunter = this.role === 'hunter';
    this.uniforms = createRigUniforms(
      hunter ? COLOR_AMBER : COLOR_CYAN,
      hunter ? COLOR_TRIM_BRONZE : COLOR_BONE,
    );

    // Segment counts only go up where the silhouette actually shows.
    const radial = this.quality === 'low' ? 6 : this.quality === 'medium' ? 9 : 12;

    const primary = this.makeMaterial(
      hunter ? COLOR_IRON : COLOR_CLOTH,
      hunter ? 0.62 : 0.92,
      hunter ? 0.35 : 0.02,
    );
    // Secondary is oiled leather for both roles. Bronze/bone now arrives purely
    // through the trim channel, so the metal lands only where it was authored.
    const secondary = this.makeMaterial(
      hunter ? COLOR_HIDE : COLOR_LEATHER,
      hunter ? 0.72 : 0.55,
      hunter ? 0.12 : 0.1,
    );
    const drapeMat = this.makeMaterial(hunter ? COLOR_IRON : COLOR_CLOTH, 0.95, 0.02);
    drapeMat.side = THREE.DoubleSide;

    const built = hunter ? buildHunter(radial, this.rng) : buildRunner(radial, this.rng);
    this.dims = built.dims;

    this.meshes = {
      torso: new THREE.Mesh(built.torso, primary),
      head: new THREE.Mesh(built.head, primary),
      upperArmL: new THREE.Mesh(built.upperArm.clone(), primary),
      foreArmL: new THREE.Mesh(built.foreArm.clone(), secondary),
      upperArmR: new THREE.Mesh(built.upperArm, primary),
      foreArmR: new THREE.Mesh(built.foreArm, secondary),
      thighL: new THREE.Mesh(built.thigh.clone(), primary),
      shinL: new THREE.Mesh(built.shin.clone(), secondary),
      thighR: new THREE.Mesh(built.thigh, primary),
      shinR: new THREE.Mesh(built.shin, secondary),
      footL: new THREE.Mesh(built.foot.clone(), secondary),
      footR: new THREE.Mesh(built.foot, secondary),
    };
    // The left-side clones must be mirrored so pauldrons/wraps face outward.
    this.meshes.upperArmL.scale.x = -1;
    this.meshes.foreArmL.scale.x = -1;
    this.meshes.thighL.scale.x = -1;
    this.meshes.shinL.scale.x = -1;
    this.meshes.footL.scale.x = -1;

    for (const mesh of Object.values(this.meshes)) {
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      this.disposables.push(mesh.geometry);
    }

    this.joints = this.assemble(built.dims);

    this.drape = new Drape(built.drape, drapeMat);
    this.joints.cloak.add(this.drape.mesh);

    if (hunter) {
      const lanternMesh = new THREE.Mesh(built.lantern!, secondary);
      lanternMesh.castShadow = true;
      this.disposables.push(lanternMesh.geometry);
      this.joints.lantern.add(lanternMesh);

      this.lanternLight = new THREE.PointLight(COLOR_AMBER, 2.4, 9, 2);
      this.lanternLight.castShadow = false;
      this.joints.lantern.add(this.lanternLight);

      const bladeMesh = new THREE.Mesh(built.blade!, primary);
      bladeMesh.castShadow = true;
      this.disposables.push(bladeMesh.geometry);
      this.joints.handR.add(bladeMesh);

      const trailGeo = new THREE.RingGeometry(0.55, 2.05, 14, 1, 0, 1.5);
      this.bladeTrailMat = new THREE.MeshBasicMaterial({
        color: 0xcfe9ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.bladeTrail = new THREE.Mesh(trailGeo, this.bladeTrailMat);
      this.bladeTrail.visible = false;
      this.bladeTrail.frustumCulled = false;
      this.bladeTrail.renderOrder = 5;
      this.bladeTrail.position.set(0.1, 1.34, -0.06);
      this.bladeTrail.rotation.set(0, Math.PI * 0.5, 0.35);
      this.disposables.push(trailGeo, this.bladeTrailMat);
      this.joints.torso.add(this.bladeTrail);
    }

    // Particles: first half embers (cursed), second half stun motes.
    this.emberCount = this.quality === 'low' ? 6 : 12;
    this.particleCount = this.emberCount * 2;
    this.particles = createBillboardCloud(this.particleCount, THREE.AdditiveBlending, 0.75);
    this.particleState = new Float32Array(this.particleCount * 5); // x,y,z,life,seed
    this.seedParticles();
    this.group.add(this.particles.mesh);

    if (options.isLocal) this.meshes.head.visible = false;
  }

  // -- construction -------------------------------------------------------

  private makeMaterial(
    color: number,
    roughness: number,
    metalness: number,
  ): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      flatShading: this.quality === 'low',
    });
    injectRigShader(mat, this.uniforms);
    this.materials.push(mat);
    return mat;
  }

  private assemble(dims: RigDims): RigJoints {
    const rig = namedGroup('rig');
    const hips = namedGroup('hips', 0, dims.hipY, 0);
    const torso = namedGroup('torso');
    const neck = namedGroup('neck', 0, dims.torsoLen, 0);
    const head = namedGroup('head');
    const shoulderL = namedGroup('shoulderL', dims.shoulderX, dims.shoulderY, 0);
    const shoulderR = namedGroup('shoulderR', -dims.shoulderX, dims.shoulderY, 0);
    const elbowL = namedGroup('elbowL', 0, -dims.upperArmLen, 0);
    const elbowR = namedGroup('elbowR', 0, -dims.upperArmLen, 0);
    const handR = namedGroup('handR', 0, -dims.foreArmLen, 0);
    const hipL = namedGroup('hipL', dims.hipX, 0, 0);
    const hipR = namedGroup('hipR', -dims.hipX, 0, 0);
    const kneeL = namedGroup('kneeL', 0, -dims.thighLen, 0);
    const kneeR = namedGroup('kneeR', 0, -dims.thighLen, 0);
    const ankleL = namedGroup('ankleL', 0, -dims.shinLen, 0);
    const ankleR = namedGroup('ankleR', 0, -dims.shinLen, 0);
    const cloak = namedGroup('cloak', 0, dims.cloakY, 0.05);
    const lantern = namedGroup('lantern', -dims.hipX - 0.135, 0.05, 0.04);

    torso.add(this.meshes.torso, neck, shoulderL, shoulderR, cloak);
    neck.add(head);
    head.add(this.meshes.head);
    shoulderL.add(this.meshes.upperArmL, elbowL);
    shoulderR.add(this.meshes.upperArmR, elbowR);
    elbowL.add(this.meshes.foreArmL);
    elbowR.add(this.meshes.foreArmR, handR);
    hipL.add(this.meshes.thighL, kneeL);
    hipR.add(this.meshes.thighR, kneeR);
    kneeL.add(this.meshes.shinL, ankleL);
    kneeR.add(this.meshes.shinR, ankleR);
    ankleL.add(this.meshes.footL);
    ankleR.add(this.meshes.footR);
    hips.add(torso, hipL, hipR, lantern);
    rig.add(hips);
    this.group.add(rig);

    return {
      rig, hips, torso, neck, head,
      shoulderL, shoulderR, elbowL, elbowR, handR,
      hipL, hipR, kneeL, kneeR, ankleL, ankleR, cloak, lantern,
    };
  }

  private seedParticles(): void {
    const state = this.particleState;
    for (let i = 0; i < this.particleCount; i += 1) {
      const o = i * 5;
      state[o] = this.rng.range(-0.24, 0.24);
      state[o + 1] = this.rng.range(0, 1.5);
      state[o + 2] = this.rng.range(-0.2, 0.2);
      state[o + 3] = this.rng.range(0, 1);
      state[o + 4] = this.rng();
    }
  }

  // -- public API ---------------------------------------------------------

  update(dt: number, speed: number, crouching: boolean): void {
    const step = clamp(dt, 0, 0.1);
    this.time += step;
    this.lastSpeed = speed;

    // -- blends -------------------------------------------------------------
    // Damping the *speed* (not a normalised alias of it) means stride length,
    // frequency and lean all ease together with no possible snap between gaits.
    this.speedBlend = damp(this.speedBlend, Math.max(0, speed), 10, step);
    const spd = this.speedBlend;
    this.crouchBlend = damp(this.crouchBlend, crouching ? 1 : 0, 8.5, step);
    this.woundBlend = damp(this.woundBlend, WOUND_GLOW[this.wound], 4, step);
    this.limpBlend = damp(this.limpBlend, WOUND_LIMP[this.wound], 5, step);
    this.markBlend = damp(this.markBlend, this.marked ? 1 : 0, 6, step);
    this.stunBlend = damp(this.stunBlend, this.stunned ? 1 : 0, 9, step);

    const crouch = this.crouchBlend;
    const move = clamp(spd / SPRINT_REF, 0, 1.12);
    // Walk→run is a continuous weight, so every curve pair cross-fades.
    this.runBlend = damp(this.runBlend, smoothstep(0.46, 0.98, move) * (1 - crouch * 0.7), 6, step);
    const run = this.runBlend;
    const stun = this.stunBlend;
    const limp = this.limpBlend;
    const idle = 1 - smoothstep(0.15, 1.4, spd);

    // Turn rate feeds cloth whip and body banking. `group.rotation.y` is set by
    // the caller immediately before this runs.
    const yaw = this.group.rotation.y;
    if (this.yawSeen) {
      let d = yaw - this.lastYaw;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      this.turnRate = damp(this.turnRate, clamp(d / Math.max(step, 1e-4), -6, 6), 12, step);
    } else {
      this.yawSeen = true;
    }
    this.lastYaw = yaw;

    // -- stride timing ------------------------------------------------------
    // Stance covers ~62% of a walk cycle and ~46% of a run, so the ground the
    // planted foot sweeps per cycle is `2 * legLength * sin(amp) / stanceFrac`.
    // Solving that for amplitude at the current frequency keeps feet planted.
    const legLen = this.dims.legLength * (1 - crouch * 0.2);
    const strideK = lerp(3.23, 4.35, run);
    const maxAmp = 0.82 - crouch * 0.22;
    const cycleDist = Math.max(0.25, strideK * legLen * Math.sin(maxAmp));
    const idleHz = 0.42;
    const hz = clamp(Math.max(idleHz, spd / cycleDist), idleHz, 3.4);
    const prevPhase = this.phase;
    this.phase = (this.phase + step * hz) % 1;
    const p = this.phase;

    const gait = smoothstep(0.08, 0.6, spd);
    const legAmp = Math.asin(clamp(spd / (strideK * legLen * hz), 0, 0.93)) * gait;

    // -- gait channels ------------------------------------------------------
    const hipAt = (q: number): number => lerp(HIP_WALK.at(q), HIP_RUN.at(q), run);
    const kneeAt = (q: number): number => lerp(KNEE_WALK.at(q), KNEE_RUN.at(q), run);
    const bob = lerp(BOB_WALK.at(p), BOB_RUN.at(p), run) * (0.008 + move * 0.05) * gait;
    this.bobSmooth = damp(this.bobSmooth, bob, 22, step);

    const breath = Math.sin(this.time * 1.35) * (0.35 + idle * 0.65);
    const shift = this.waveShift(this.time * 0.42) * idle;
    const limpDip = limp * Math.max(0, HIP_WALK.at(p)) * move;

    const j = this.joints;

    // -- root ---------------------------------------------------------------
    j.rig.position.y = -crouch * 0.42 - limpDip * 0.09 + bob + breath * 0.005 * idle;
    j.rig.rotation.z = stun * 0.13 * Math.sin(this.time * 3.1);

    // -- pelvis -------------------------------------------------------------
    const legNormL = hipAt(p);
    const legNormR = hipAt(p + 0.5);
    const pelvisYaw = legNormL * (0.05 + move * 0.17) * gait;
    j.hips.rotation.y = pelvisYaw;
    // Pelvic list: the hip on the swing side drops (Trendelenburg).
    j.hips.rotation.z = -legNormL * (0.02 + move * 0.055) * gait + limpDip * 0.11 + shift * 0.035;
    j.hips.position.x = shift * 0.018;

    // -- spine: counter-rotation, trailing a beat behind the pelvis ---------
    const twistTarget = -pelvisYaw * 1.3 - clamp(this.turnRate, -3, 3) * 0.05;
    this.spineTwist = damp(this.spineTwist, twistTarget, 13, step);
    const leanTarget = 0.05 + move * 0.26 + crouch * 0.4 + stun * 0.22;
    this.spineLean = damp(this.spineLean, leanTarget, 9, step);
    const bank = clamp(this.turnRate, -3, 3) * 0.055;
    j.torso.rotation.x = -this.spineLean;
    j.torso.rotation.y = this.spineTwist;
    j.torso.rotation.z = legNormL * 0.028 * move * gait + stun * 0.18 + bank - shift * 0.02;
    // Breathing lives on the chest mesh alone so it cannot swim the shoulders.
    this.meshes.torso.scale.set(
      1 + breath * 0.02,
      1 + breath * 0.006,
      1 + breath * 0.028,
    );

    // -- head: stabilised against bob and twist, with a seeded idle glance ---
    const gate = smoothstep(0.2, 0.62, this.waveGate(this.time * 0.13));
    const lookY = this.waveLook(this.time * 0.31) * gate * idle * 0.55;
    const lookX = this.waveLook(this.time * 0.19 + 2.1) * idle * 0.1;
    this.headYaw = damp(
      this.headYaw,
      -this.spineTwist * 0.8 + lookY + stun * 0.35 * Math.sin(this.time * 2.3),
      8,
      step,
    );
    this.headPitch = damp(this.headPitch, this.spineLean * 0.82 + lookX + stun * 0.3, 10, step);
    this.headRoll = damp(this.headRoll, -j.torso.rotation.z * 0.55, 9, step);
    j.head.rotation.set(this.headPitch, this.headYaw, this.headRoll);
    // Counter the vertical bob so the head floats instead of pogoing.
    j.head.position.y = -this.bobSmooth * 0.42;

    // -- legs ---------------------------------------------------------------
    const ampL = legAmp;
    const ampR = legAmp * (1 - limp * 0.34);
    const crouchHip = crouch * 0.5;
    const hipRotL = legNormL * ampL + crouchHip;
    const hipRotR = legNormR * ampR + crouchHip + limp * 0.1;
    j.hipL.rotation.set(hipRotL, -pelvisYaw * 0.35, 0.045 + shift * 0.02);
    j.hipR.rotation.set(hipRotR, -pelvisYaw * 0.35, -0.045 + shift * 0.02);

    const kneeScale = lerp(1.02, 1.5, run) * gait;
    const kneeRawL = kneeAt(p);
    const kneeRawR = kneeAt(p + 0.5);
    // A permanent sliver of bend keeps the legs from reading as locked poles.
    const kneeFlexL = kneeRawL * kneeScale + crouch * 1.0 + 0.06;
    const kneeFlexR = kneeRawR * kneeScale * (1 - limp * 0.35) + crouch * 1.0 + 0.06 + limp * 0.24;
    j.kneeL.rotation.x = -kneeFlexL;
    j.kneeR.rotation.x = -kneeFlexR;

    // Ankles hold the sole level while the leg is loaded, then roll through
    // heel-strike → toe-off. This is what removes the skating read.
    const rollAmp = 0.34 + move * 0.3;
    const stanceL = clamp(1 - kneeRawL * 1.15, 0, 1);
    const stanceR = clamp(1 - kneeRawR * 1.15, 0, 1);
    j.ankleL.rotation.x = clamp(
      (kneeFlexL - hipRotL) * stanceL + FOOT_ROLL.at(p) * rollAmp * gait - crouch * 0.18,
      -0.95,
      0.95,
    );
    j.ankleR.rotation.x = clamp(
      (kneeFlexR - hipRotR) * stanceR + FOOT_ROLL.at(p + 0.5) * rollAmp * gait - crouch * 0.18,
      -0.95,
      0.95,
    );

    // -- arms ---------------------------------------------------------------
    // The swing lags the legs by ~7% of a stride (about four frames at 60 fps).
    const armLag = 0.075;
    const armNormL = ARM_SWING.at(p + 0.5 - armLag);
    const armNormR = ARM_SWING.at(p - armLag);
    const armAmp = (0.09 + move * 0.6) * (1 - crouch * 0.28) * gait;
    const armTuck = crouch * 0.32 + stun * 0.5 + idle * 0.03;
    const splay = 0.11 + move * 0.05 + crouch * 0.04 + stun * 0.4;
    const shoulderLx = armNormL * armAmp + armTuck;
    const shoulderRxIdle = armNormR * armAmp + armTuck;

    // Elbows chase their target, so they overlap the shoulder by a few frames.
    this.elbowLBlend = damp(
      this.elbowLBlend,
      0.24 + move * 0.3 + crouch * 0.42 + Math.max(0, armNormL) * (0.3 + run * 0.8),
      16,
      step,
    );
    j.shoulderL.rotation.set(shoulderLx, -this.spineTwist * 0.25, splay);
    j.elbowL.rotation.x = this.elbowLBlend;

    let shoulderRx = shoulderRxIdle;
    let shoulderRz = -splay;
    let elbowRx = damp(
      this.elbowRBlend,
      0.24 + move * 0.3 + crouch * 0.42 + Math.max(0, armNormR) * (0.3 + run * 0.8),
      16,
      step,
    );
    this.elbowRBlend = elbowRx;
    let torsoTwist = 0;

    // -- attack overlay -----------------------------------------------------
    this.trailStrength = damp(this.trailStrength, 0, 9, step);
    if (this.attacking) {
      this.attackTime += step;
      const t = this.attackTime;
      const w = BLADE.windup;
      const a = w + BLADE.active;
      const r = a + BLADE.recovery;
      let weight: number;
      let px: number;
      let pz: number;
      let pe: number;
      if (t < w) {
        const p0 = smoothstep(0, 1, t / w);
        weight = smoothstep(0, 0.4, t / w);
        px = lerp(0, -1.62, p0);
        pz = lerp(0, -0.85, p0);
        pe = lerp(0, 1.95, p0);
        torsoTwist = -0.34 * p0;
      } else if (t < a) {
        const p0 = (t - w) / BLADE.active;
        const e = 1 - Math.pow(1 - p0, 3);
        weight = 1;
        px = lerp(-1.62, 0.82, e);
        pz = lerp(-0.85, 0.62, e);
        pe = lerp(1.95, 0.18, e);
        torsoTwist = lerp(-0.34, 0.4, e);
        this.trailStrength = Math.sin(p0 * Math.PI);
      } else if (t < r) {
        const p0 = (t - a) / BLADE.recovery;
        const e = smoothstep(0, 1, p0);
        weight = 1 - e;
        px = lerp(0.82, 0, e);
        pz = lerp(0.62, 0, e);
        pe = lerp(0.18, 0, e);
        torsoTwist = lerp(0.4, 0, e);
      } else {
        this.attacking = false;
        weight = 0;
        px = 0;
        pz = 0;
        pe = 0;
      }
      shoulderRx = lerp(shoulderRx, px, weight);
      shoulderRz = lerp(shoulderRz, pz, weight);
      elbowRx = lerp(elbowRx, pe, weight);
      this.elbowRBlend = elbowRx;
      j.torso.rotation.y += torsoTwist * weight;
      j.hips.rotation.y += torsoTwist * weight * 0.35;
    }

    j.shoulderR.rotation.set(shoulderRx, -this.spineTwist * 0.25, shoulderRz);
    j.elbowR.rotation.x = elbowRx;

    if (this.bladeTrail && this.bladeTrailMat) {
      const vis = this.trailStrength > 0.01;
      this.bladeTrail.visible = vis;
      if (vis) {
        this.bladeTrailMat.opacity = this.trailStrength * 0.85 * this.alpha;
        this.bladeTrail.scale.setScalar(0.82 + this.trailStrength * 0.3);
        this.bladeTrail.rotation.z = 0.35 - this.trailStrength * 1.5;
      }
    }

    // -- lantern: a real damped pendulum, not a driven sine ------------------
    if (this.lanternLight) {
      const drive =
        Math.sin(p * TAU + 0.6) * (0.05 + move * 0.5) - clamp(this.turnRate, -4, 4) * 0.12;
      const sub = step > 0.034 ? 3 : 1;
      const h = step / sub;
      for (let n = 0; n < sub; n += 1) {
        this.lanternVel += ((drive - this.lanternAngle) * 90 - this.lanternVel * 8.5) * h;
        this.lanternAngle += this.lanternVel * h;
      }
      j.lantern.rotation.z = clamp(this.lanternAngle, -0.7, 0.7);
      j.lantern.rotation.x = Math.cos(p * TAU * 2) * move * 0.12;
      this.lanternLight.intensity =
        (2.1 + Math.sin(this.time * 7.3) * 0.16 + Math.sin(this.time * 2.9) * 0.1) * this.alpha;
    }

    // -- cloth --------------------------------------------------------------
    // Fire a kick on each footfall so the hem snaps and settles.
    const kick = Math.floor(prevPhase * 2) !== Math.floor(p * 2) ? move * 1.6 : 0;
    this.drape.update(
      step,
      clamp(move * 1.05 + crouch * 0.22, 0, 1.2),
      clamp(-this.turnRate * 0.22 + legNormL * 0.06 * move, -1.2, 1.2),
      kick,
    );

    // -- shader state -------------------------------------------------------
    this.uniforms.uWoundPower.value = this.woundBlend;
    this.uniforms.uAccentPower.value =
      0.85 + Math.sin(this.time * 1.9) * 0.12 + this.woundBlend * 0.2;
    this.uniforms.uRimPower.value = this.markBlend * (0.55 + 0.45 * Math.sin(this.time * 4.6));

    this.updateParticles(step);
  }

  private updateParticles(dt: number): void {
    const emberOn = this.wound === 'cursed' ? 1 : 0;
    const stunOn = this.stunned ? 1 : 0;
    const active = emberOn > 0 || stunOn > 0 || this.woundBlend > 0.9 || this.stunBlend > 0.02;
    this.particles.mesh.visible = active && this.alpha > 0.02;
    if (!this.particles.mesh.visible) {
      this.particles.geometry.instanceCount = 0;
      return;
    }

    const state = this.particleState;
    const off = this.particles.offset.array as Float32Array;
    const col = this.particles.color.array as Float32Array;
    const par = this.particles.param.array as Float32Array;
    let n = 0;

    for (let i = 0; i < this.particleCount; i += 1) {
      const o = i * 5;
      const isEmber = i < this.emberCount;
      const seed = state[o + 4];

      if (isEmber) {
        state[o + 3] += dt * (0.34 + seed * 0.26);
        if (state[o + 3] >= 1) {
          state[o + 3] -= 1;
          state[o] = (seed - 0.5) * 0.46;
          state[o + 2] = (this.rng() - 0.5) * 0.4;
        }
        const life = state[o + 3];
        if (this.woundBlend < 0.9) continue;
        const y = 0.24 + life * 1.5;
        const drift = Math.sin(this.time * 1.7 + seed * TAU) * 0.09 * life;
        off[n * 3] = state[o] + drift;
        off[n * 3 + 1] = y;
        off[n * 3 + 2] = state[o + 2] + Math.cos(this.time * 1.3 + seed * TAU) * 0.07 * life;
        const fade = Math.sin(life * Math.PI);
        col[n * 4] = 1;
        col[n * 4 + 1] = 0.3;
        col[n * 4 + 2] = 0.48;
        col[n * 4 + 3] = fade * 0.85 * clamp((this.woundBlend - 0.9) * 3, 0, 1);
        par[n * 3] = 0.045 + seed * 0.035;
        par[n * 3 + 1] = life * 3;
        par[n * 3 + 2] = seed;
        n += 1;
      } else {
        if (this.stunBlend < 0.02) continue;
        const spin = this.time * 3.4 + seed * TAU;
        const radius = 0.26 + seed * 0.12;
        off[n * 3] = Math.cos(spin) * radius;
        off[n * 3 + 1] = 1.72 + Math.sin(spin * 1.7) * 0.09 + seed * 0.1;
        off[n * 3 + 2] = Math.sin(spin) * radius;
        col[n * 4] = 0.85;
        col[n * 4 + 1] = 0.95;
        col[n * 4 + 2] = 1;
        col[n * 4 + 3] = this.stunBlend * (0.5 + 0.5 * Math.sin(spin * 2.2));
        par[n * 3] = 0.05 + seed * 0.03;
        par[n * 3 + 1] = spin;
        par[n * 3 + 2] = seed;
        n += 1;
      }
    }

    this.particles.geometry.instanceCount = n;
    this.particles.material.uniforms.uAlpha.value = this.alpha;
    this.particles.offset.needsUpdate = true;
    this.particles.color.needsUpdate = true;
    this.particles.param.needsUpdate = true;
    if (n === 0) this.particles.mesh.visible = false;
  }

  setWound(level: WoundLevel): void {
    this.wound = level;
  }

  setMarked(marked: boolean): void {
    this.marked = marked;
  }

  setStunned(stunned: boolean): void {
    this.stunned = stunned;
  }

  playAttack(): void {
    this.attacking = true;
    this.attackTime = 0;
  }

  setOpacity(alpha: number): void {
    const a = clamp(alpha, 0, 1);
    if (a === this.alpha) return;
    this.alpha = a;
    const fading = a < 1;
    for (const mat of this.materials) {
      mat.opacity = a;
      mat.transparent = fading;
      mat.depthWrite = !fading;
    }
    this.particles.material.uniforms.uAlpha.value = a;
    if (this.bladeTrailMat) this.bladeTrailMat.opacity = this.trailStrength * 0.85 * a;
  }

  /** Exposed for diagnostics; keeps `lastSpeed` meaningful to callers. */
  get speed(): number {
    return this.lastSpeed;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.clear();
    this.drape.dispose();
    this.particles.geometry.dispose();
    this.particles.material.dispose();
    for (const d of this.disposables) d.dispose();
    for (const mat of this.materials) mat.dispose();
    this.materials.length = 0;
    this.disposables.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Runner: lithe, hooded, cyan ritual accents
// ---------------------------------------------------------------------------

function buildRunner(radial: number, rng: Rng): BuiltBody {
  const dims: RigDims = {
    hipY: 0.93,
    hipX: 0.105,
    torsoLen: 0.58,
    shoulderX: 0.19,
    shoulderY: 0.53,
    upperArmLen: 0.29,
    foreArmLen: 0.27,
    thighLen: 0.44,
    shinLen: 0.42,
    legLength: 0.82,
    cloakY: 0.5,
  };
  // The silhouette lathes carry the read, so they get the segments.
  const seg = radial + 4;
  const det = radial >= 10 ? 3 : 2;

  // -- torso ----------------------------------------------------------------
  const torsoProfile = ramp([
    [0.0, 0.112],
    [0.18, 0.1],
    [0.4, 0.128],
    [0.62, 0.152],
    [0.8, 0.147],
    [0.9, 0.122],
    [1.0, 0.06],
  ]);
  const torsoParts: Part[] = [
    { geo: lathe(0, dims.torsoLen, 14, seg, torsoProfile) },
    // Leather pelvis wrap, a shade darker than the cloth above it.
    {
      geo: lathe(-0.2, 0.05, 7, seg, ramp([[0, 0.085], [0.4, 0.118], [1, 0.13]])),
      glow: [0, 0, 0.16, 0],
    },
    // Shoulder mantle: a short cape that softens the neck-to-shoulder line.
    {
      geo: lathe(0.4, 0.605, 5, seg, ramp([[0, 0.228], [0.55, 0.19], [1, 0.098]])),
      glow: [0, 0, 0.06, 0],
    },
    // Wrapped chest binding.
    {
      geo: new THREE.TorusGeometry(0.142, 0.012, 4, seg),
      matrix: place(0, 0.3, 0, Math.PI / 2, 0, 0.06),
      glow: [0, 0, 0.1, 0],
    },
    {
      geo: new THREE.TorusGeometry(0.153, 0.012, 4, seg),
      matrix: place(0, 0.385, 0, Math.PI / 2, 0, -0.05),
      glow: [0, 0, 0.1, 0],
    },
    // Belt and buckle.
    {
      geo: new THREE.TorusGeometry(0.109, 0.021, 5, seg),
      matrix: place(0, 0.05, 0, Math.PI / 2),
      glow: [0, 0, 0.18, 0],
    },
    {
      geo: plate(0.062, 0.055, 0.03, 0.016, det),
      matrix: place(0, 0.05, -0.108),
      glow: [0, 0, 0, 1],
    },
    // Collar ring at the base of the hood.
    {
      geo: new THREE.TorusGeometry(0.074, 0.02, 5, seg),
      matrix: place(0, dims.torsoLen - 0.025, 0, Math.PI / 2),
      glow: [0.18, 0.3, 0, 0],
    },
    // Slung satchel, rigid to the torso.
    {
      geo: plate(0.17, 0.14, 0.085, 0.03, det),
      matrix: place(0.152, 0.1, 0.1, 0.1, -0.3, 0.16),
      glow: [0, 0, 0.14, 0],
    },
    { geo: plate(0.05, 0.03, 0.02, 0.01, det), matrix: place(0.15, 0.115, 0.05, 0, -0.3, 0.16), glow: [0, 0, 0, 1] },
    // Satchel strap over the opposite shoulder, plus a crossing bandolier.
    {
      geo: plate(0.046, 0.54, 0.018, 0.016, det),
      matrix: place(0.035, 0.3, 0.06, 0, 0, -0.44),
      glow: [0, 0, 0.2, 0],
    },
    {
      geo: plate(0.036, 0.5, 0.016, 0.014, det),
      matrix: place(-0.015, 0.33, -0.108, 0, 0, 0.52),
      glow: [0, 0, 0.24, 0],
    },
    // Two bone charms knotted on the bandolier.
    { geo: ball(0.017, 5), matrix: place(-0.085, 0.19, -0.11), glow: [0, 0, 0, 0.9] },
    { geo: ball(0.013, 5), matrix: place(-0.062, 0.155, -0.108), glow: [0, 0, 0, 0.9] },
  ];
  // Stitched seam along the mantle hem.
  stitches(
    torsoParts,
    9,
    new THREE.Vector3(-0.15, 0.408, -0.155),
    new THREE.Vector3(0.15, 0.408, -0.155),
    0.006,
    [0, 0, -0.22, 0],
  );
  // Wound seams tracing the ribs.
  for (let i = 0; i < 3; i += 1) {
    torsoParts.push({
      geo: new THREE.TorusGeometry(0.15 - i * 0.008, 0.006, 3, seg, Math.PI * 0.75),
      matrix: place(0, 0.2 + i * 0.11, 0, Math.PI / 2, 0, Math.PI * 0.6),
      glow: [0, 1, 0, 0],
    });
  }
  const torso = mergeParts(torsoParts);

  // -- head: hood over a light-swallowing void ------------------------------
  const headParts: Part[] = [
    {
      geo: lathe(
        -0.2,
        0.23,
        12,
        seg,
        ramp([[0, 0.05], [0.18, 0.138], [0.46, 0.17], [0.72, 0.156], [0.9, 0.1], [1, 0.028]]),
      ),
      matrix: place(0, 0.16, -0.01),
    },
    // Peaked brim pulled forward over the brow.
    {
      geo: lathe(0, 0.17, 5, seg, ramp([[0, 0.148], [0.55, 0.098], [1, 0.02]])),
      matrix: place(0, 0.235, -0.05, 0.42),
      glow: [0, 0, 0.05, 0],
    },
    // Rim of the cowl opening.
    {
      geo: new THREE.TorusGeometry(0.132, 0.015, 4, seg),
      matrix: place(0, 0.152, -0.028, Math.PI / 2 - 0.34),
      glow: [0, 0, 0.12, 0],
    },
    // Slack point of the hood falling back off the crown.
    {
      geo: limb(0.075, 0.125, seg, (t) => 0.34 + t * 0.8, 4),
      matrix: place(0, 0.265, 0.085, -1.78),
      glow: [0, 0, 0.03, 0],
    },
    // Crown seam running front-to-back over the hood.
    {
      geo: new THREE.TorusGeometry(0.152, 0.007, 3, seg, Math.PI),
      matrix: place(0, 0.17, -0.012, 0, Math.PI / 2, 0),
      glow: [0, 0, 0.18, 0],
    },
    // Face void — light-swallowing shell sunk inside the cowl.
    {
      geo: ball(0.092, seg, 1.05, 0.72),
      matrix: place(0, 0.16, -0.05),
      glow: [0, 0, 1, 0],
    },
    // Scarf wound around the throat, knotted to one side.
    {
      geo: new THREE.TorusGeometry(0.098, 0.031, 5, seg),
      matrix: place(0, 0.075, -0.012, Math.PI / 2, 0, 0.08),
      glow: [0, 0, 0.08, 0],
    },
    { geo: ball(0.032, 6, 0.9), matrix: place(0.082, 0.055, -0.055), glow: [0, 0, 0.05, 0] },
    // Eye glints.
    { geo: ball(0.015, 6), matrix: place(0.038, 0.175, -0.117), glow: [1, 0, 0, 0] },
    { geo: ball(0.015, 6), matrix: place(-0.038, 0.175, -0.117), glow: [1, 0, 0, 0] },
  ];
  const head = mergeParts(headParts);

  // -- limbs: joint caps sit on the pivots, so nothing can pull apart --------
  const upperArm = mergeParts([
    { geo: ball(0.066, radial, 1, 0.95) },
    { geo: limb(0.053, dims.upperArmLen, radial, (t) => 0.84 + t * 0.34) },
    { geo: ball(0.052, radial), matrix: place(0, -dims.upperArmLen, 0) },
    {
      geo: new THREE.TorusGeometry(0.062, 0.016, 4, radial + 2),
      matrix: place(0, -0.035, 0, Math.PI / 2),
      glow: [0, 0, 0.14, 0],
    },
  ]);
  const foreArm = mergeParts([
    { geo: limb(0.047, dims.foreArmLen, radial, (t) => 0.76 + t * 0.4) },
    // Cloth wraps.
    {
      geo: new THREE.TorusGeometry(0.05, 0.013, 4, radial + 2),
      matrix: place(0, -0.075, 0, Math.PI / 2),
      glow: [0, 0, 0.16, 0],
    },
    {
      geo: new THREE.TorusGeometry(0.046, 0.013, 4, radial + 2),
      matrix: place(0, -0.155, 0, Math.PI / 2),
      glow: [0, 0, 0.16, 0],
    },
    // Bracer strapped to the outside of the forearm.
    {
      geo: plate(0.055, 0.115, 0.038, 0.018, det),
      matrix: place(0.026, -0.115, -0.02, 0, 0.5, 0),
      glow: [0, 0, 0, 0.35],
    },
    // Hand, slightly flattened so it reads as a fist not a bead.
    { geo: ball(0.045, radial, 1, 0.82), matrix: place(0, -dims.foreArmLen, 0) },
    {
      geo: plate(0.05, 0.03, 0.05, 0.014, det),
      matrix: place(0, -dims.foreArmLen - 0.012, -0.03),
      glow: [0, 0, 0.1, 0],
    },
  ]);

  const thigh = mergeParts([
    { geo: ball(0.09, radial, 1, 0.95) },
    { geo: limb(0.077, dims.thighLen, radial, (t) => 0.72 + Math.sin(t * Math.PI * 0.82) * 0.46) },
    { geo: ball(0.07, radial), matrix: place(0, -dims.thighLen, 0) },
    // Thigh strap with a small buckle.
    {
      geo: new THREE.TorusGeometry(0.073, 0.012, 4, radial + 2),
      matrix: place(0, -0.28, 0, Math.PI / 2),
      glow: [0, 0, 0.2, 0],
    },
    { geo: plate(0.03, 0.026, 0.02, 0.008, det), matrix: place(0.07, -0.28, -0.02), glow: [0, 0, 0, 1] },
  ]);
  const shin = mergeParts([
    { geo: limb(0.059, dims.shinLen, radial, (t) => 0.6 + Math.sin(t * Math.PI * 0.62) * 0.56) },
    {
      geo: new THREE.TorusGeometry(0.054, 0.012, 4, radial + 2),
      matrix: place(0, -0.12, 0, Math.PI / 2),
      glow: [0, 0, 0.18, 0],
    },
    {
      geo: new THREE.TorusGeometry(0.05, 0.012, 4, radial + 2),
      matrix: place(0, -0.24, 0, Math.PI / 2),
      glow: [0, 0, 0.18, 0],
    },
    { geo: ball(0.05, radial), matrix: place(0, -dims.shinLen, 0) },
  ]);

  // -- boot -----------------------------------------------------------------
  const foot = mergeParts([
    { geo: plate(0.088, 0.072, 0.2, 0.028, det), matrix: place(0, -0.038, -0.045, Math.PI / 2, 0, 0) },
    // Toe cap and heel.
    { geo: ball(0.042, radial, 0.72, 1), matrix: place(0, -0.046, -0.126), glow: [0, 0, 0, 0.3] },
    { geo: ball(0.04, radial, 0.8, 0.9), matrix: place(0, -0.04, 0.042), glow: [0, 0, 0.1, 0] },
    // Cuff folded over the ankle.
    {
      geo: new THREE.TorusGeometry(0.058, 0.019, 4, radial + 2),
      matrix: place(0, 0.004, -0.005, Math.PI / 2),
      glow: [0, 0, 0.06, 0],
    },
  ]);

  const drape: DrapeStrip[] = [
    // Tattered cloak, wrapped around the shoulders and flaring to the hem.
    {
      radius: 0.2,
      arc: 2.45,
      length: 0.98,
      taper: -0.42,
      originX: 0,
      originY: 0.02,
      originZ: -0.04,
      swayAmp: 0.07,
      swayHz: 2.4 + rng.range(-0.2, 0.2),
      billow: 0.34,
      folds: 3,
      foldDepth: 0.11,
      whip: 0.18,
      glow: [0, 0, 0.05, 0],
    },
    // Ritual scarf with a glowing tip.
    {
      radius: 0.055,
      arc: 1.5,
      length: 0.82,
      taper: 0.5,
      originX: 0.12,
      originY: 0.0,
      originZ: -0.02,
      swayAmp: 0.15,
      swayHz: 3.3 + rng.range(-0.25, 0.25),
      billow: 0.7,
      folds: 1,
      foldDepth: 0.06,
      whip: 0.34,
      glow: [0.5, 0, 0, 0],
    },
  ];

  return { torso, head, upperArm, foreArm, thigh, shin, foot, drape, dims };
}

// ---------------------------------------------------------------------------
// Hunter: broad, horned, iron and bronze
// ---------------------------------------------------------------------------

function buildHunter(radial: number, rng: Rng): BuiltBody {
  const dims: RigDims = {
    hipY: 1.06,
    hipX: 0.135,
    torsoLen: 0.66,
    shoulderX: 0.285,
    shoulderY: 0.585,
    upperArmLen: 0.34,
    foreArmLen: 0.32,
    thighLen: 0.5,
    shinLen: 0.47,
    legLength: 0.92,
    cloakY: 0.14,
  };
  const seg = radial + 5;
  const det = radial >= 10 ? 3 : 2;

  // -- torso: heavy coat, high collar, broad belt ---------------------------
  const torsoProfile = ramp([
    [0.0, 0.188],
    [0.16, 0.176],
    [0.38, 0.216],
    [0.6, 0.247],
    [0.78, 0.248],
    [0.9, 0.208],
    [1.0, 0.098],
  ]);
  const torsoParts: Part[] = [
    { geo: lathe(0, dims.torsoLen, 16, seg, torsoProfile) },
    // Coat skirt flaring below the belt.
    {
      geo: lathe(-0.34, 0.035, 8, seg, ramp([[0, 0.325], [0.45, 0.27], [1, 0.201]])),
      glow: [0, 0, 0.05, 0],
    },
    // Shoulder mantle over the pauldron roots.
    {
      geo: lathe(0.44, 0.63, 5, seg, ramp([[0, 0.302], [0.55, 0.26], [1, 0.16]])),
      glow: [0, 0, 0.08, 0],
    },
    // Belt, buckle and studs.
    {
      geo: new THREE.TorusGeometry(0.222, 0.033, 5, seg),
      matrix: place(0, 0.03, 0, Math.PI / 2),
      glow: [0, 0, 0.12, 0],
    },
    {
      geo: plate(0.11, 0.086, 0.05, 0.024, det),
      matrix: place(0, 0.03, -0.216),
      glow: [0, 0, 0, 1],
    },
    // High collar rising behind the helm — a standing wolf-collar, not a cone.
    {
      geo: lathe(0, 0.19, 5, seg, ramp([[0, 0.135], [0.5, 0.17], [1, 0.205]])),
      matrix: place(0, dims.torsoLen - 0.07, 0.035, -0.3),
      glow: [0, 0, 0.14, 0],
    },
    // Chest plate: bronze backing plate with the iron cuirass proud of it.
    {
      geo: plate(0.35, 0.31, 0.09, 0.055, det),
      matrix: place(0, 0.445, -0.148, 0.07),
      glow: [0, 0, 0, 1],
    },
    {
      geo: plate(0.31, 0.27, 0.1, 0.05, det),
      matrix: place(0, 0.45, -0.168, 0.07),
      glow: [0.04, 0, 0, 0],
    },
    // Bandolier with three stoppered vials.
    {
      geo: plate(0.062, 0.64, 0.024, 0.02, det),
      matrix: place(0.035, 0.36, -0.2, 0, 0, -0.42),
      glow: [0, 0, 0.18, 0],
    },
  ];
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * TAU;
    torsoParts.push({
      geo: ball(0.016, 5),
      matrix: place(Math.sin(a) * 0.222, 0.03, Math.cos(a) * 0.222),
      glow: [0, 0, 0, 0.85],
    });
  }
  for (let i = 0; i < 3; i += 1) {
    torsoParts.push({
      geo: limb(0.021, 0.062, 6, (t) => 0.8 + t * 0.3, 2),
      matrix: place(0.12 - i * 0.06, 0.5 - i * 0.075, -0.215, 0, 0, -0.42),
      glow: [0.1, 0, 0, 0.2],
    });
  }
  // Stitched seam down the coat front and along the mantle hem.
  stitches(
    torsoParts,
    10,
    new THREE.Vector3(-0.055, 0.09, -0.208),
    new THREE.Vector3(-0.055, 0.62, -0.16),
    0.007,
    [0, 0, 0.3, 0],
  );
  stitches(
    torsoParts,
    11,
    new THREE.Vector3(-0.2, 0.452, -0.215),
    new THREE.Vector3(0.2, 0.452, -0.215),
    0.007,
    [0, 0, 0, 0.5],
  );
  for (let i = 0; i < 3; i += 1) {
    torsoParts.push({
      geo: new THREE.TorusGeometry(0.215 - i * 0.01, 0.007, 3, seg, Math.PI * 0.8),
      matrix: place(0, 0.17 + i * 0.13, 0, Math.PI / 2, 0, Math.PI * 0.55),
      glow: [0, 1, 0, 0],
    });
  }
  const torso = mergeParts(torsoParts);

  // -- helm -----------------------------------------------------------------
  const headParts: Part[] = [
    {
      geo: lathe(
        -0.17,
        0.23,
        11,
        seg,
        ramp([[0, 0.062], [0.16, 0.138], [0.44, 0.166], [0.7, 0.156], [0.88, 0.1], [1, 0.03]]),
      ),
      matrix: place(0, 0.16, 0),
    },
    // Brow ridge and crown band.
    {
      geo: new THREE.TorusGeometry(0.153, 0.023, 5, seg),
      matrix: place(0, 0.185, -0.008, Math.PI / 2 - 0.12),
      glow: [0, 0, 0, 0.55],
    },
    {
      geo: new THREE.TorusGeometry(0.144, 0.019, 5, seg),
      matrix: place(0, 0.262, 0, Math.PI / 2),
      glow: [0.05, 0, 0, 0.8],
    },
    // Gorget closing the neck gap.
    {
      geo: new THREE.TorusGeometry(0.112, 0.028, 5, seg),
      matrix: place(0, 0.015, 0, Math.PI / 2),
      glow: [0, 0, 0, 0.25],
    },
    // Cheek plates.
    {
      geo: plate(0.06, 0.13, 0.05, 0.024, det),
      matrix: place(0.108, 0.13, -0.048, 0, 0.6, 0.06),
      glow: [0, 0, 0.06, 0],
    },
    {
      geo: plate(0.06, 0.13, 0.05, 0.024, det),
      matrix: place(-0.108, 0.13, -0.048, 0, -0.6, -0.06),
      glow: [0, 0, 0.06, 0],
    },
    // Face void.
    { geo: ball(0.104, seg, 1, 0.82), matrix: place(0, 0.15, -0.03), glow: [0, 0, 1, 0] },
    // Visor slit and two breath vents.
    {
      geo: plate(0.136, 0.018, 0.022, 0.008, det),
      matrix: place(0, 0.172, -0.118),
      glow: [1, 0, 0, 0],
    },
    { geo: ball(0.011, 5), matrix: place(0.032, 0.098, -0.104), glow: [0.35, 0, 0, 0] },
    { geo: ball(0.011, 5), matrix: place(-0.032, 0.098, -0.104), glow: [0.35, 0, 0, 0] },
  ];
  // Antlered crown — a seeded pair of branching tines.
  for (const side of [1, -1]) {
    tine(
      headParts,
      rng,
      new THREE.Vector3(side * 0.1, 0.26, 0.01),
      new THREE.Vector3(side * 0.55, 0.82, 0.12),
      0.46,
      0.026,
      1,
      Math.max(5, radial - 5),
    );
  }
  // Iron spikes around the crown.
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI - Math.PI * 0.5;
    headParts.push({
      geo: limb(0.015, 0.09, 5, (t) => 0.18 + t * 0.9, 2),
      matrix: place(Math.sin(a) * 0.138, 0.302, Math.cos(a) * 0.138, Math.PI, 0, 0),
      glow: [0, 0, 0, 0.3],
    });
  }
  const head = mergeParts(headParts);

  // -- arms: pauldrons merged in so they rotate with the shoulder -----------
  const upperArm = mergeParts([
    { geo: ball(0.092, radial, 1, 0.95) },
    { geo: limb(0.076, dims.upperArmLen, radial, (t) => 0.8 + t * 0.34) },
    { geo: ball(0.073, radial), matrix: place(0, -dims.upperArmLen, 0) },
    // Layered pauldron plates.
    {
      geo: lathe(-0.12, 0.07, 5, seg, ramp([[0, 0.082], [0.45, 0.145], [1, 0.086]])),
      matrix: place(0.035, 0.035, 0, 0, 0, 0.22),
      glow: [0.04, 0, 0, 0],
    },
    {
      geo: lathe(-0.04, 0.055, 3, seg, ramp([[0, 0.128], [1, 0.07]])),
      matrix: place(0.045, 0.02, 0, 0, 0, 0.3),
      glow: [0, 0, 0, 0.28],
    },
    {
      geo: new THREE.TorusGeometry(0.122, 0.017, 4, seg, Math.PI * 1.25),
      matrix: place(0.035, -0.035, 0, Math.PI / 2, 0, 0),
      glow: [0.22, 0, 0, 0.5],
    },
    // Strap tying the pauldron down to the arm.
    {
      geo: new THREE.TorusGeometry(0.079, 0.014, 4, radial + 2),
      matrix: place(0, -0.16, 0, Math.PI / 2),
      glow: [0, 0, 0.22, 0],
    },
  ]);
  const foreArm = mergeParts([
    { geo: limb(0.066, dims.foreArmLen, radial, (t) => 0.72 + t * 0.44) },
    // Bracer plate with rivets.
    {
      geo: plate(0.09, 0.17, 0.075, 0.028, det),
      matrix: place(0, -0.115, -0.012),
      glow: [0, 0, 0, 0.18],
    },
    {
      geo: new THREE.TorusGeometry(0.075, 0.018, 4, radial + 2),
      matrix: place(0, -0.195, 0, Math.PI / 2),
      glow: [0.08, 0, 0, 0.4],
    },
    { geo: ball(0.011, 5), matrix: place(0.048, -0.06, -0.038), glow: [0, 0, 0, 0.85] },
    { geo: ball(0.011, 5), matrix: place(-0.048, -0.06, -0.038), glow: [0, 0, 0, 0.85] },
    // Gauntlet fist with a knuckle plate.
    { geo: ball(0.057, radial, 1, 0.85), matrix: place(0, -dims.foreArmLen, 0) },
    {
      geo: plate(0.062, 0.038, 0.06, 0.016, det),
      matrix: place(0, -dims.foreArmLen - 0.012, -0.04),
      glow: [0, 0, 0, 0.3],
    },
  ]);

  const thigh = mergeParts([
    { geo: ball(0.118, radial, 1, 0.95) },
    { geo: limb(0.102, dims.thighLen, radial, (t) => 0.76 + Math.sin(t * Math.PI * 0.82) * 0.38) },
    { geo: ball(0.094, radial), matrix: place(0, -dims.thighLen, 0) },
    // Tasset hanging over the outer thigh.
    {
      geo: plate(0.13, 0.2, 0.06, 0.03, det),
      matrix: place(0.07, -0.16, 0.01, 0, 0.55, 0.06),
      glow: [0, 0, 0.08, 0],
    },
  ]);
  const shin = mergeParts([
    { geo: limb(0.084, dims.shinLen, radial, (t) => 0.64 + Math.sin(t * Math.PI * 0.6) * 0.5) },
    // Knee cop sitting just under the knee ball.
    {
      geo: ball(0.086, radial, 0.8, 1),
      matrix: place(0, -0.025, -0.028),
      glow: [0.05, 0, 0, 0.35],
    },
    // Greave.
    {
      geo: plate(0.12, 0.24, 0.08, 0.032, det),
      matrix: place(0, -0.21, -0.022),
      glow: [0, 0, 0, 0.15],
    },
    {
      geo: new THREE.TorusGeometry(0.088, 0.017, 4, radial + 2),
      matrix: place(0, -0.34, 0, Math.PI / 2),
      glow: [0.05, 0, 0, 0.4],
    },
    { geo: ball(0.07, radial), matrix: place(0, -dims.shinLen, 0) },
  ]);

  // -- heavy boot -----------------------------------------------------------
  const foot = mergeParts([
    { geo: plate(0.128, 0.092, 0.26, 0.036, det), matrix: place(0, -0.046, -0.055, Math.PI / 2, 0, 0) },
    { geo: ball(0.058, radial, 0.72, 1), matrix: place(0, -0.055, -0.16), glow: [0, 0, 0, 0.4] },
    { geo: ball(0.055, radial, 0.8, 0.9), matrix: place(0, -0.048, 0.05), glow: [0, 0, 0.08, 0] },
    // Cuff folded over the greave.
    {
      geo: new THREE.TorusGeometry(0.086, 0.024, 4, radial + 2),
      matrix: place(0, 0.005, -0.008, Math.PI / 2),
      glow: [0, 0, 0.1, 0],
    },
  ]);

  // -- belt lantern: open bronze cage around an emissive amber core ---------
  const lanternParts: Part[] = [
    // Domed cap and base, with the cage left open so the flame actually shows.
    {
      geo: lathe(0.062, 0.108, 4, 10, ramp([[0, 0.062], [0.6, 0.05], [1, 0.014]])),
      glow: [0, 0, 0, 0.85],
    },
    {
      geo: lathe(-0.098, -0.058, 3, 10, ramp([[0, 0.03], [0.5, 0.055], [1, 0.06]])),
      glow: [0, 0, 0, 0.85],
    },
    { geo: ball(0.041, 10, 1.15), glow: [1, 0, 0, 0] },
    { geo: new THREE.TorusGeometry(0.026, 0.006, 4, 9), matrix: place(0, 0.125, 0), glow: [0, 0, 0, 0.9] },
  ];
  // Four vertical cage bars.
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * TAU + Math.PI * 0.25;
    lanternParts.push({
      geo: limb(0.008, 0.13, 4, (t) => 0.85 + t * 0.3, 2),
      matrix: place(Math.sin(a) * 0.052, 0.065, Math.cos(a) * 0.052),
      glow: [0, 0, 0, 0.95],
    });
  }
  const lantern = mergeParts(lanternParts);

  // -- long ritual blade ----------------------------------------------------
  const bladeParts: Part[] = [
    { geo: bladeGeometry(), glow: [0.07, 0, 0, 0] },
    { geo: plate(0.26, 0.032, 0.055, 0.014, det), matrix: place(0, 0.012, 0), glow: [0.2, 0, 0, 0.4] },
    // Wrapped grip: darkened iron reads as leather without a second material.
    { geo: limb(0.024, 0.2, 7, (t) => 0.85 + t * 0.2), matrix: place(0, 0.012, 0), glow: [0, 0, 0.42, 0] },
    { geo: ball(0.032, 8), matrix: place(0, -0.2, 0), glow: [0.3, 0, 0, 0.35] },
  ];
  // Carried point-down and trailing behind the hip, so it never reads as a
  // horizontal plank and keeps the tip clear of the ground.
  const blade = mergeParts(bladeParts);
  blade.scale(0.8, 0.8, 0.8);
  blade.rotateX(1.95);
  blade.translate(0, -0.02, -0.05);

  const drape: DrapeStrip[] = [
    // Long coat tail, wrapped around the back and flaring past the boots.
    {
      radius: 0.28,
      arc: 2.05,
      length: 0.78,
      taper: -0.26,
      originX: 0,
      originY: -0.03,
      originZ: -0.04,
      swayAmp: 0.05,
      swayHz: 1.9 + rng.range(-0.15, 0.15),
      billow: 0.3,
      folds: 4,
      foldDepth: 0.1,
      whip: 0.13,
      glow: [0, 0, 0.06, 0],
    },
    // Torn side sash that trails behind the hip.
    {
      radius: 0.07,
      arc: 1.5,
      length: 0.66,
      taper: 0.45,
      originX: -0.22,
      originY: -0.06,
      originZ: 0.0,
      swayAmp: 0.11,
      swayHz: 2.6 + rng.range(-0.2, 0.2),
      billow: 0.52,
      folds: 1,
      foldDepth: 0.06,
      whip: 0.3,
      glow: [0, 0, 0, 0.06],
    },
  ];

  return { torso, head, upperArm, foreArm, thigh, shin, foot, drape, dims, lantern, blade };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCharacter(options: CreateCharacterOptions): CharacterRig {
  return new Character(options);
}
