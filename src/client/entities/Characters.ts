/**
 * Authored low-poly character rigs for the Runner and the Hunter.
 *
 * Both silhouettes are built from procedural geometry (tapered cylinders with
 * per-vertex profile scaling, lathes, extruded shapes and hand-built buffer
 * strips) and merged down to a handful of meshes so the pair stays inside the
 * 30 draw-call budget. Every mesh hangs off a named joint group; animation is
 * fully procedural and driven from an accumulated phase so it is frame-rate
 * independent.
 *
 * Conventions
 *  - Local -Z is forward (matches `CameraRig`'s yaw → direction mapping).
 *  - Limb geometry hangs *down* from its joint origin, so a joint rotation of
 *    +x swings the limb forward.
 *  - Emissive detail (eye glints, ritual accents, lantern glass, wound seams)
 *    is baked into an `aGlow` vertex attribute and lit by a shader injection,
 *    which removes the need for separate emissive meshes.
 */

import * as THREE from 'three';
import type { CharacterRig, CreateCharacterOptions, QualityLevel } from '../contracts.js';
import { BLADE, type WoundLevel } from '../../shared/constants.js';
import { createRng, type Rng } from '../../shared/rng.js';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const COLOR_CLOTH = 0x4d5461;
const COLOR_LEATHER = 0x3a2f26;
const COLOR_CYAN = 0x6feaff;
const COLOR_IRON = 0x1c1f26;
const COLOR_BRONZE = 0x6b5533;
const COLOR_AMBER = 0xffb45c;
const COLOR_MAGENTA = 0xff4d7a;

const TAU = Math.PI * 2;

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

// ---------------------------------------------------------------------------
// Shader injection: per-vertex accent glow, wound seams and a fresnel rim
// ---------------------------------------------------------------------------

/**
 * Bumped whenever the injected GLSL below changes. Three appends this to the
 * generated program key; without it the renderer can hand back a cached
 * *un-injected* `physical` program compiled for some other standard material.
 */
const RIG_CACHE_KEY = 'veilhunt-rig-v1';

interface RigUniforms {
  uAccent: THREE.IUniform<THREE.Color>;
  uAccentPower: THREE.IUniform<number>;
  uWoundColor: THREE.IUniform<THREE.Color>;
  uWoundPower: THREE.IUniform<number>;
  uRimColor: THREE.IUniform<THREE.Color>;
  uRimPower: THREE.IUniform<number>;
}

function createRigUniforms(accent: number): RigUniforms {
  return {
    uAccent: { value: new THREE.Color(accent) },
    uAccentPower: { value: 1 },
    uWoundColor: { value: new THREE.Color(COLOR_MAGENTA) },
    uWoundPower: { value: 0 },
    uRimColor: { value: new THREE.Color(COLOR_CYAN) },
    uRimPower: { value: 0 },
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

    shader.vertexShader = `attribute vec3 aGlow;
varying vec3 vGlow;
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
varying vec3 vGlow;
${shader.fragmentShader}`.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
	// Channel z carves out light-swallowing voids (the hood / helm interior).
	diffuseColor.rgb *= 1.0 - vGlow.z;
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
  /** `[accentGlow, woundSeam, voidDarkening]`, baked per vertex. */
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

    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      positions.push(v.x, v.y, v.z);
      v.fromBufferAttribute(nrm, i).applyMatrix3(normalMatrix).normalize();
      normals.push(v.x, v.y, v.z);
      glows.push(gx, gy, gz);
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
  out.setAttribute('aGlow', new THREE.Float32BufferAttribute(glows, 3));
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
  flattenZ = 1,
): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, length, radial, 5, false);
  taperY(geo, length / 2, profile);
  if (flattenZ !== 1) geo.scale(1, 1, flattenZ);
  geo.translate(0, -length / 2, 0);
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
): void {
  const step = length / 3;
  const cursor = origin.clone();
  const heading = dir.clone().normalize();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 3; i += 1) {
    const r = radius * (1 - i * 0.26);
    const seg = limb(r, step * 1.06, 5, (t) => 0.7 + t * 0.35);
    const mid = cursor.clone().addScaledVector(heading, step);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, -1, 0),
      heading,
    );
    parts.push({
      geo: seg,
      matrix: new THREE.Matrix4().compose(cursor.clone(), q, new THREE.Vector3(1, 1, 1)),
    });
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
      tine(parts, rng, cursor.clone(), branch, length * 0.52, radius * 0.6, depth - 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Drape (cloak / scarf / coat tail) — a dynamic buffer strip updated per frame
// ---------------------------------------------------------------------------

interface DrapeStrip {
  width: number;
  length: number;
  taper: number;
  originX: number;
  originY: number;
  originZ: number;
  swayAmp: number;
  swayHz: number;
  billow: number;
  glow: readonly number[];
}

const DRAPE_COLS = 5;
const DRAPE_ROWS = 7;

class Drape {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly position: THREE.BufferAttribute;
  private readonly strips: DrapeStrip[];
  private readonly lag: Float32Array;
  private phase = 0;

  constructor(strips: DrapeStrip[], material: THREE.Material) {
    this.strips = strips;
    const vertsPerStrip = DRAPE_COLS * DRAPE_ROWS;
    const total = vertsPerStrip * strips.length;
    const positions = new Float32Array(total * 3);
    const glows = new Float32Array(total * 3);
    const indices: number[] = [];

    for (let s = 0; s < strips.length; s += 1) {
      const base = s * vertsPerStrip;
      const strip = strips[s];
      for (let i = 0; i < vertsPerStrip; i += 1) {
        // Glow fades in toward the trailing tip of each strip.
        const tip = (i / DRAPE_COLS | 0) / (DRAPE_ROWS - 1);
        glows[(base + i) * 3] = (strip.glow[0] ?? 0) * tip;
        glows[(base + i) * 3 + 1] = strip.glow[1] ?? 0;
        glows[(base + i) * 3 + 2] = strip.glow[2] ?? 0;
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
    this.geometry.setAttribute('aGlow', new THREE.Float32BufferAttribute(glows, 3));
    this.geometry.setIndex(indices);
    this.lag = new Float32Array(DRAPE_ROWS * strips.length);

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.write(0);
    this.geometry.computeVertexNormals();
  }

  /** `flow` is 0..1 backward billow (speed + crouch tuck). */
  update(dt: number, flow: number): void {
    this.phase += dt;
    // Propagate the billow down the strip so lower rows trail the upper ones.
    for (let s = 0; s < this.strips.length; s += 1) {
      const off = s * DRAPE_ROWS;
      for (let r = 0; r < DRAPE_ROWS; r += 1) {
        const source = r === 0 ? flow : this.lag[off + r - 1];
        this.lag[off + r] = damp(this.lag[off + r], source, 9 - r * 0.7, dt);
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
        const trail = this.lag[off + r];
        const sway =
          Math.sin(time * strip.swayHz + t * 2.7 + s * 1.9) * strip.swayAmp * t * (0.35 + trail);
        const halfWidth = (strip.width * 0.5) * (1 - t * strip.taper);
        // Gravity drop shortens as the strip billows backward.
        const drop = -strip.length * t * (1 - trail * 0.32);
        const back = strip.billow * trail * t * t;
        for (let c = 0; c < DRAPE_COLS; c += 1) {
          const u = (c / (DRAPE_COLS - 1)) * 2 - 1;
          const x = strip.originX + u * halfWidth + sway;
          // Wrap the cloth around the back of the body.
          const curl = (1 - u * u) * 0.055 * (1 - t * 0.5);
          arr[w] = x;
          arr[w + 1] = strip.originY + drop + Math.sin(t * Math.PI) * 0.012;
          arr[w + 2] = strip.originZ + back + curl;
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
// Rig body definition
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
  cloak: THREE.Group;
  lantern: THREE.Group;
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
  private readonly drape: Drape;
  private readonly particles: BillboardCloud;
  private readonly particleState: Float32Array;
  private readonly particleCount: number;
  private readonly emberCount: number;

  private readonly bladeTrail: THREE.Mesh | null = null;
  private readonly bladeTrailMat: THREE.MeshBasicMaterial | null = null;
  private readonly lanternLight: THREE.PointLight | null = null;
  private readonly disposables: { dispose(): void }[] = [];

  // Animation state -------------------------------------------------------
  private time = 0;
  private phase = 0;
  private moveBlend = 0;
  private crouchBlend = 0;
  private lastSpeed = 0;

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

    const hunter = this.role === 'hunter';
    this.uniforms = createRigUniforms(hunter ? COLOR_AMBER : COLOR_CYAN);

    const radial = this.quality === 'low' ? 5 : this.quality === 'medium' ? 6 : 8;

    const primary = this.makeMaterial(hunter ? COLOR_IRON : COLOR_CLOTH, hunter ? 0.62 : 0.92, hunter ? 0.35 : 0.02);
    const secondary = this.makeMaterial(hunter ? COLOR_BRONZE : COLOR_LEATHER, 0.55, hunter ? 0.65 : 0.1);
    const drapeMat = this.makeMaterial(hunter ? COLOR_IRON : COLOR_CLOTH, 0.95, 0.02);
    drapeMat.side = THREE.DoubleSide;

    const built = hunter
      ? buildHunter(radial, this.rng)
      : buildRunner(radial, this.rng);

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
    };
    // The left-side clones must be mirrored so pauldrons/wraps face outward.
    this.meshes.upperArmL.scale.x = -1;
    this.meshes.foreArmL.scale.x = -1;
    this.meshes.thighL.scale.x = -1;
    this.meshes.shinL.scale.x = -1;

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

      const bladeMesh = new THREE.Mesh(built.blade!, secondary);
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

  private makeMaterial(color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
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
    const cloak = namedGroup('cloak', 0, dims.cloakY, 0.05);
    const lantern = namedGroup('lantern', -dims.hipX - 0.16, 0.06, 0.12);

    torso.add(this.meshes.torso, neck, shoulderL, shoulderR, cloak);
    neck.add(head);
    head.add(this.meshes.head);
    shoulderL.add(this.meshes.upperArmL, elbowL);
    shoulderR.add(this.meshes.upperArmR, elbowR);
    elbowL.add(this.meshes.foreArmL);
    elbowR.add(this.meshes.foreArmR, handR);
    hipL.add(this.meshes.thighL, kneeL);
    hipR.add(this.meshes.thighR, kneeR);
    kneeL.add(this.meshes.shinL);
    kneeR.add(this.meshes.shinR);
    hips.add(torso, hipL, hipR, lantern);
    rig.add(hips);
    this.group.add(rig);

    return {
      rig, hips, torso, neck, head,
      shoulderL, shoulderR, elbowL, elbowR, handR,
      hipL, hipR, kneeL, kneeR, cloak, lantern,
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

    const norm = clamp(speed / 6.6, 0, 1.15);
    this.moveBlend = damp(this.moveBlend, norm, 11, step);
    this.crouchBlend = damp(this.crouchBlend, crouching ? 1 : 0, 8.5, step);
    this.woundBlend = damp(this.woundBlend, WOUND_GLOW[this.wound], 4, step);
    this.limpBlend = damp(this.limpBlend, WOUND_LIMP[this.wound], 5, step);
    this.markBlend = damp(this.markBlend, this.marked ? 1 : 0, 6, step);
    this.stunBlend = damp(this.stunBlend, this.stunned ? 1 : 0, 9, step);
    this.lastSpeed = speed;

    // Stride frequency scales with gait so the cycle stays frame-rate independent.
    const strideHz = 0.62 + this.moveBlend * 1.62 - this.crouchBlend * 0.16;
    this.phase = (this.phase + step * strideHz * TAU) % TAU;

    const move = this.moveBlend;
    const crouch = this.crouchBlend;
    const stun = this.stunBlend;
    const breath = Math.sin(this.time * 1.5) * (1 - move * 0.75);

    const swing = Math.sin(this.phase);
    const swingB = Math.sin(this.phase + Math.PI);
    // Limp: the wounded (right) leg spends less time swinging and dips the hip.
    const limp = this.limpBlend;
    const limpDip = limp * Math.max(0, Math.sin(this.phase)) * move;

    const legAmp = (0.14 + move * 0.78) * (1 - crouch * 0.28);
    const armAmp = (0.11 + move * 0.56) * (1 - crouch * 0.22);

    const j = this.joints;

    // Root: bob, crouch drop, limp hitch.
    const bob = Math.cos(this.phase * 2) * (0.012 + move * 0.055);
    j.rig.position.y = -crouch * 0.42 - limpDip * 0.09 + bob + breath * 0.006;
    j.rig.rotation.z = stun * 0.13 * Math.sin(this.time * 3.1);

    // Hips: counter-rotate against the stride, sag toward the wounded side.
    j.hips.rotation.y = -swing * (0.05 + move * 0.15);
    j.hips.rotation.z = limpDip * 0.11;

    // Torso: forward lean grows with speed and crouch; slight roll on the swing.
    const lean = 0.05 + move * 0.24 + crouch * 0.38 + stun * 0.22;
    j.torso.rotation.x = -lean;
    j.torso.rotation.y = swing * (0.04 + move * 0.1);
    j.torso.rotation.z = swing * 0.03 * move + stun * 0.18;
    j.torso.scale.setScalar(1 + breath * 0.012);

    // Head stabilisation: cancel most of the torso lean and the vertical bob.
    j.head.rotation.x = lean * 0.78 - bob * 1.4 + stun * 0.3;
    j.head.rotation.y = -j.torso.rotation.y * 0.7 + stun * 0.35 * Math.sin(this.time * 2.3);
    j.head.rotation.z = -j.torso.rotation.z * 0.6;

    // Legs -----------------------------------------------------------------
    const swingL = swing * legAmp;
    const swingR = swingB * legAmp * (1 - limp * 0.42);
    j.hipL.rotation.x = swingL + crouch * 0.34;
    j.hipR.rotation.x = swingR + crouch * 0.34 + limp * 0.1;
    j.hipL.rotation.z = 0.03;
    j.hipR.rotation.z = -0.03;
    // Knees only bend backward.
    const bendBase = 0.12 + move * 0.95 + crouch * 0.85;
    j.kneeL.rotation.x = -(Math.max(0, Math.sin(this.phase + 1.15)) * bendBase + crouch * 0.5);
    j.kneeR.rotation.x = -(
      Math.max(0, Math.sin(this.phase + 1.15 + Math.PI)) * bendBase * (1 - limp * 0.3) +
      crouch * 0.5 +
      limp * 0.24
    );

    // Arms -----------------------------------------------------------------
    // Counter-swing: left arm follows the right leg.
    const armL = -swingL * (armAmp / Math.max(legAmp, 1e-4));
    const armR = -swingR * (armAmp / Math.max(legAmp, 1e-4));
    const armTuck = crouch * 0.3 + stun * 0.5;
    j.shoulderL.rotation.set(armL + armTuck, 0, 0.09 + move * 0.06 + stun * 0.4);
    j.shoulderL.rotation.z *= -1;
    j.elbowL.rotation.x = 0.22 + move * 0.42 + crouch * 0.4 + Math.max(0, -armL) * 0.5;

    let shoulderRx = armR + armTuck;
    let shoulderRz = -(0.09 + move * 0.06 + stun * 0.4);
    let elbowRx = 0.22 + move * 0.42 + crouch * 0.4 + Math.max(0, -armR) * 0.5;
    let torsoTwist = 0;

    // Attack overlay --------------------------------------------------------
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
        const p = smoothstep(0, 1, t / w);
        weight = smoothstep(0, 0.4, t / w);
        px = lerp(0, -1.62, p);
        pz = lerp(0, -0.85, p);
        pe = lerp(0, 1.95, p);
        torsoTwist = -0.34 * p;
      } else if (t < a) {
        const p = (t - w) / BLADE.active;
        const e = 1 - Math.pow(1 - p, 3);
        weight = 1;
        px = lerp(-1.62, 0.82, e);
        pz = lerp(-0.85, 0.62, e);
        pe = lerp(1.95, 0.18, e);
        torsoTwist = lerp(-0.34, 0.4, e);
        this.trailStrength = Math.sin(p * Math.PI);
      } else if (t < r) {
        const p = (t - a) / BLADE.recovery;
        const e = smoothstep(0, 1, p);
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
      j.torso.rotation.y += torsoTwist * weight;
    }

    j.shoulderR.rotation.set(shoulderRx, 0, shoulderRz);
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

    // Lantern swing ---------------------------------------------------------
    if (this.lanternLight) {
      j.lantern.rotation.z = Math.sin(this.phase + 0.6) * (0.05 + move * 0.24);
      j.lantern.rotation.x = Math.cos(this.phase * 2) * move * 0.14;
      this.lanternLight.intensity =
        (2.1 + Math.sin(this.time * 7.3) * 0.16 + Math.sin(this.time * 2.9) * 0.1) * this.alpha;
    }

    // Cloth -----------------------------------------------------------------
    this.drape.update(step, clamp(move * 1.05 + crouch * 0.22, 0, 1.2));

    // Shader state ----------------------------------------------------------
    this.uniforms.uWoundPower.value = this.woundBlend;
    this.uniforms.uAccentPower.value =
      0.85 + Math.sin(this.time * 1.9) * 0.12 + this.woundBlend * 0.2;
    this.uniforms.uRimPower.value =
      this.markBlend * (0.55 + 0.45 * Math.sin(this.time * 4.6));

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
// Body construction
// ---------------------------------------------------------------------------

interface RigDims {
  hipY: number;
  hipX: number;
  torsoLen: number;
  shoulderX: number;
  shoulderY: number;
  upperArmLen: number;
  foreArmLen: number;
  thighLen: number;
  cloakY: number;
}

interface BuiltBody {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  foreArm: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  drape: DrapeStrip[];
  dims: RigDims;
  lantern?: THREE.BufferGeometry;
  blade?: THREE.BufferGeometry;
}

function buildRunner(radial: number, rng: Rng): BuiltBody {
  const dims: RigDims = {
    hipY: 0.9,
    hipX: 0.1,
    torsoLen: 0.56,
    shoulderX: 0.17,
    shoulderY: 0.5,
    upperArmLen: 0.29,
    foreArmLen: 0.27,
    thighLen: 0.44,
    cloakY: 0.5,
  };

  // Torso: lithe lathe body with a wrapped chest band and a slung satchel.
  const torsoParts: Part[] = [
    {
      geo: lathe(0, dims.torsoLen, 8, radial + 2, (t) =>
        0.135 + Math.sin(t * Math.PI * 0.95) * 0.055 - t * 0.02,
      ),
    },
    // Pelvis wrap.
    { geo: lathe(-0.16, 0.04, 4, radial + 1, (t) => 0.115 + t * 0.03), matrix: place() },
    // Collar / gorget with a faint ritual accent line.
    {
      geo: new THREE.TorusGeometry(0.115, 0.022, 4, radial + 3),
      matrix: place(0, dims.torsoLen - 0.03, 0, Math.PI / 2),
      glow: [0.22, 0.35],
    },
    // Satchel, rigid to the torso.
    {
      geo: new THREE.BoxGeometry(0.17, 0.14, 0.09),
      matrix: place(0.15, 0.06, 0.1, 0.1, -0.25, 0.18),
    },
    // Satchel strap.
    {
      geo: new THREE.BoxGeometry(0.045, 0.5, 0.02),
      matrix: place(0.03, 0.28, 0.055, 0, 0, -0.42),
    },
  ];
  // Wound seams tracing the ribs.
  for (let i = 0; i < 3; i += 1) {
    torsoParts.push({
      geo: new THREE.TorusGeometry(0.15 - i * 0.008, 0.006, 3, radial + 2, Math.PI * 0.75),
      matrix: place(0, 0.18 + i * 0.11, 0, Math.PI / 2, 0, Math.PI * 0.6),
      glow: [0, 1],
    });
  }
  const torso = mergeParts(torsoParts);

  // Hood: lathe cowl over a dark face void with two cyan eye glints.
  const headParts: Part[] = [
    {
      geo: lathe(-0.18, 0.2, 7, radial + 2, (t) =>
        0.05 + Math.sin(Math.min(1, t * 1.12) * Math.PI * 0.88 + 0.14) * 0.155,
      ),
      matrix: place(0, 0.16, -0.01),
    },
    // Peaked hood brim pulled forward.
    {
      geo: lathe(0, 0.16, 4, radial + 2, (t) => 0.135 - t * 0.11),
      matrix: place(0, 0.24, -0.04, 0.38),
    },
    // Face void — light-swallowing shell sunk inside the cowl.
    {
      geo: new THREE.SphereGeometry(0.088, radial + 2, 5),
      matrix: place(0, 0.16, -0.045, 0, 0, 0, 1, 1.05, 0.7),
      glow: [0, 0, 1],
    },
    // Eye glints.
    {
      geo: new THREE.SphereGeometry(0.016, 4, 3),
      matrix: place(0.038, 0.175, -0.115),
      glow: [1, 0],
    },
    {
      geo: new THREE.SphereGeometry(0.016, 4, 3),
      matrix: place(-0.038, 0.175, -0.115),
      glow: [1, 0],
    },
  ];
  const head = mergeParts(headParts);

  // Limbs: slim, tapered, wrapped forearms and calves.
  const upperArm = mergeParts([
    { geo: limb(0.052, dims.upperArmLen, radial, (t) => 0.86 + t * 0.32) },
    // Shoulder wrap.
    {
      geo: new THREE.TorusGeometry(0.058, 0.016, 3, radial + 1),
      matrix: place(0, -0.03, 0, Math.PI / 2),
    },
  ]);
  const foreArm = mergeParts([
    { geo: limb(0.046, dims.foreArmLen, radial, (t) => 0.78 + t * 0.4) },
    // Cloth wraps.
    {
      geo: new THREE.TorusGeometry(0.05, 0.013, 3, radial + 1),
      matrix: place(0, -0.09, 0, Math.PI / 2),
    },
    {
      geo: new THREE.TorusGeometry(0.045, 0.013, 3, radial + 1),
      matrix: place(0, -0.18, 0, Math.PI / 2),
    },
    // Hand.
    { geo: new THREE.SphereGeometry(0.042, radial, 4), matrix: place(0, -dims.foreArmLen, 0) },
  ]);

  const thigh = mergeParts([
    { geo: limb(0.075, dims.thighLen, radial, (t) => 0.74 + Math.sin(t * Math.PI * 0.8) * 0.46) },
  ]);
  const shin = mergeParts([
    { geo: limb(0.058, 0.44, radial, (t) => 0.62 + Math.sin(t * Math.PI * 0.62) * 0.55) },
    // Boot.
    {
      geo: new THREE.BoxGeometry(0.085, 0.06, 0.19),
      matrix: place(0, -0.45, -0.04),
    },
    { geo: new THREE.TorusGeometry(0.055, 0.012, 3, radial + 1), matrix: place(0, -0.34, 0, Math.PI / 2) },
  ]);

  const drape: DrapeStrip[] = [
    // Tattered cloak from the shoulders.
    {
      width: 0.46,
      length: 0.92,
      taper: 0.42,
      originX: 0,
      originY: 0.04,
      originZ: 0.07,
      swayAmp: 0.075,
      swayHz: 2.4 + rng.range(-0.2, 0.2),
      billow: 0.46,
      glow: [0, 0],
    },
    // Ritual scarf with a glowing tip.
    {
      width: 0.1,
      length: 0.78,
      taper: 0.55,
      originX: 0.11,
      originY: 0.02,
      originZ: 0.03,
      swayAmp: 0.15,
      swayHz: 3.3 + rng.range(-0.25, 0.25),
      billow: 0.7,
      glow: [0.5, 0],
    },
  ];

  return { torso, head, upperArm, foreArm, thigh, shin, drape, dims };
}

function buildHunter(radial: number, rng: Rng): BuiltBody {
  const dims: RigDims = {
    hipY: 1.05,
    hipX: 0.135,
    torsoLen: 0.66,
    shoulderX: 0.26,
    shoulderY: 0.58,
    upperArmLen: 0.34,
    foreArmLen: 0.32,
    thighLen: 0.5,
    cloakY: 0.14,
  };

  // Torso: heavy coat with a high collar and a broad belt.
  const torsoParts: Part[] = [
    {
      geo: lathe(0, dims.torsoLen, 9, radial + 3, (t) =>
        0.19 + Math.sin(t * Math.PI * 0.72 + 0.35) * 0.085,
      ),
    },
    // Coat skirt flaring below the belt.
    { geo: lathe(-0.3, 0.02, 4, radial + 3, (t) => 0.3 - t * 0.09) },
    // Belt.
    {
      geo: new THREE.TorusGeometry(0.215, 0.032, 4, radial + 4),
      matrix: place(0, 0.02, 0, Math.PI / 2),
      glow: [0.08, 0],
    },
    // High collar: an open lathe cone rising behind the head.
    {
      geo: lathe(0, 0.26, 3, radial + 3, (t) => 0.15 + t * 0.13),
      matrix: place(0, dims.torsoLen - 0.06, 0.02, -0.22),
    },
    // Chest plate with oxidised trim.
    {
      geo: new THREE.BoxGeometry(0.3, 0.26, 0.14),
      matrix: place(0, 0.42, -0.11, 0.06),
      glow: [0.05, 0],
    },
  ];
  for (let i = 0; i < 3; i += 1) {
    torsoParts.push({
      geo: new THREE.TorusGeometry(0.21 - i * 0.01, 0.007, 3, radial + 3, Math.PI * 0.8),
      matrix: place(0, 0.16 + i * 0.13, 0, Math.PI / 2, 0, Math.PI * 0.55),
      glow: [0, 1],
    });
  }
  const torso = mergeParts(torsoParts);

  // Helm: iron dome, brow band, dark face void, amber visor slit and antlers.
  const headParts: Part[] = [
    {
      geo: lathe(-0.14, 0.2, 6, radial + 3, (t) =>
        0.055 + Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.9) * 0.145,
      ),
      matrix: place(0, 0.16, 0),
    },
    // Crown band.
    {
      geo: new THREE.TorusGeometry(0.148, 0.022, 4, radial + 4),
      matrix: place(0, 0.19, 0, Math.PI / 2),
      glow: [0.06, 0],
    },
    // Face void.
    {
      geo: new THREE.SphereGeometry(0.1, radial + 2, 5),
      matrix: place(0, 0.15, -0.03, 0, 0, 0, 1, 1, 0.8),
      glow: [0, 0, 1],
    },
    // Visor slit.
    {
      geo: new THREE.BoxGeometry(0.13, 0.017, 0.02),
      matrix: place(0, 0.17, -0.115),
      glow: [1, 0],
    },
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
    );
  }
  // Iron spikes around the crown.
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI - Math.PI * 0.5;
    headParts.push({
      geo: limb(0.014, 0.09, 4, (t) => 0.2 + t * 0.9),
      matrix: place(Math.sin(a) * 0.14, 0.3, Math.cos(a) * 0.14, Math.PI, 0, 0),
    });
  }
  const head = mergeParts(headParts);

  // Arms: heavy pauldrons merged into the upper arm so they rotate with it.
  const upperArm = mergeParts([
    { geo: limb(0.075, dims.upperArmLen, radial, (t) => 0.82 + t * 0.34) },
    // Pauldron: layered lathe plates.
    {
      geo: lathe(-0.11, 0.06, 3, radial + 3, (t) => 0.075 + Math.sin(t * Math.PI * 0.9) * 0.11),
      matrix: place(0.03, 0.03, 0, 0, 0, 0.22),
      glow: [0.05, 0],
    },
    {
      geo: new THREE.TorusGeometry(0.115, 0.018, 3, radial + 3, Math.PI * 1.2),
      matrix: place(0.03, -0.02, 0, Math.PI / 2, 0, 0),
      glow: [0.3, 0],
    },
  ]);
  const foreArm = mergeParts([
    { geo: limb(0.065, dims.foreArmLen, radial, (t) => 0.74 + t * 0.42) },
    // Bracer plates.
    {
      geo: new THREE.TorusGeometry(0.072, 0.02, 3, radial + 2),
      matrix: place(0, -0.12, 0, Math.PI / 2),
      glow: [0.1, 0],
    },
    { geo: new THREE.SphereGeometry(0.055, radial, 4), matrix: place(0, -dims.foreArmLen, 0) },
  ]);

  const thigh = mergeParts([
    { geo: limb(0.1, dims.thighLen, radial, (t) => 0.78 + Math.sin(t * Math.PI * 0.8) * 0.38) },
  ]);
  const shin = mergeParts([
    { geo: limb(0.082, 0.5, radial, (t) => 0.66 + Math.sin(t * Math.PI * 0.6) * 0.5) },
    // Greave.
    {
      geo: new THREE.TorusGeometry(0.085, 0.018, 3, radial + 2),
      matrix: place(0, -0.16, 0, Math.PI / 2),
      glow: [0.05, 0],
    },
    // Heavy boot.
    { geo: new THREE.BoxGeometry(0.125, 0.09, 0.25), matrix: place(0, -0.52, -0.05) },
  ]);

  // Belt lantern: bronze cage plus an emissive amber core (aGlow.x = 1).
  const lantern = mergeParts([
    { geo: lathe(-0.09, 0.09, 4, 6, (t) => 0.045 + Math.sin(t * Math.PI) * 0.028) },
    { geo: new THREE.TorusGeometry(0.055, 0.008, 3, 7), matrix: place(0, 0.08, 0, Math.PI / 2) },
    { geo: new THREE.TorusGeometry(0.055, 0.008, 3, 7), matrix: place(0, -0.08, 0, Math.PI / 2) },
    // Glowing core.
    { geo: new THREE.SphereGeometry(0.038, 6, 4), glow: [1, 0] },
    // Hanging ring.
    { geo: new THREE.TorusGeometry(0.026, 0.006, 3, 6), matrix: place(0, 0.11, 0) },
  ]);

  // Long ritual blade held in the right hand, edge glowing faintly.
  const bladeParts: Part[] = [
    { geo: bladeGeometry(), matrix: place(0, 0, 0, 0, 0, 0), glow: [0.16, 0] },
    // Crossguard.
    { geo: new THREE.BoxGeometry(0.3, 0.028, 0.05), matrix: place(0, 0.01, 0), glow: [0.3, 0] },
    // Grip.
    { geo: limb(0.024, 0.2, 5, (t) => 0.85 + t * 0.2), matrix: place(0, 0.01, 0) },
    // Pommel.
    { geo: new THREE.SphereGeometry(0.032, 5, 4), matrix: place(0, -0.2, 0), glow: [0.4, 0] },
  ];
  // Hold it point-down-forward in the fist.
  const blade = mergeParts(bladeParts);
  blade.rotateX(Math.PI * 0.5);
  blade.translate(0, -0.02, -0.06);

  const drape: DrapeStrip[] = [
    // Long coat tail.
    {
      width: 0.6,
      length: 0.86,
      taper: 0.24,
      originX: 0,
      originY: -0.02,
      originZ: 0.14,
      swayAmp: 0.055,
      swayHz: 1.9 + rng.range(-0.15, 0.15),
      billow: 0.38,
      glow: [0, 0],
    },
  ];

  return { torso, head, upperArm, foreArm, thigh, shin, drape, dims, lantern, blade };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCharacter(options: CreateCharacterOptions): CharacterRig {
  return new Character(options);
}
