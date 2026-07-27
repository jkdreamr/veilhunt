/**
 * The shared material kit.
 *
 * Every surface in the world draws from this fixed set of named roles so the
 * draw-call budget stays predictable: one `InstancedMesh` per (geometry, role)
 * pair. Nothing outside this module constructs a material.
 *
 * Several roles extend `MeshStandardMaterial` through `onBeforeCompile`:
 *
 * - **World-projected UVs.** Instanced boxes are unit-sized and scaled per
 *   instance, so baked UVs would stretch wildly between a 24m hedge and a 1m
 *   column. Instead the vertex shader picks the dominant world axis pair and
 *   derives `vMapUv` / `vNormalMapUv` from world position, giving constant
 *   texel density everywhere from a single texture fetch. Three derives its
 *   tangent frame from `vNormalMapUv` screen-space derivatives, so normal
 *   mapping stays correct without a tangent attribute.
 * - **Wind sway.** Vertex displacement scaled by the square of normalised
 *   height, so bases stay planted, plus a local `reactAt` bend.
 * - **Flicker.** Per-instance emissive modulation computed from the instance
 *   origin — deterministic, and free of any per-frame CPU work.
 *
 * All injections share one uniform object per channel (`uTime`, `uWind`, ...)
 * so a single write in `update()` drives the entire world.
 */

import * as THREE from 'three';
import type { TextureKit } from './textures.js';
import { ATMOSPHERE, PALETTE, SURFACE, UV_SCALE, WIND } from './palette.js';

/** The shader object handed to `onBeforeCompile`, without importing internals. */
type ShaderRef = Parameters<THREE.Material['onBeforeCompile']>[0];

export interface WorldUniforms {
  /** Seconds since world creation, damped to a crawl under reduced motion. */
  uTime: { value: number };
  /** Global wind/ambient-motion scale, 0..1. Reduced motion drives it near 0. */
  uWind: { value: number };
  /** xyz = last `reactAt` point, w = remaining strength. */
  uBend: { value: THREE.Vector4 };
  /** Emissive flicker depth, 0..1. Reduced motion drives it to 0. */
  uFlicker: { value: number };
  /** Mirrors `THREE.FogExp2.density` for raw shader materials. */
  uFogDensity: { value: number };
  uFogColor: { value: THREE.Color };
}

export function createWorldUniforms(fogDensity: number): WorldUniforms {
  return {
    uTime: { value: 0 },
    uWind: { value: 1 },
    uBend: { value: new THREE.Vector4(0, 0, 0, 0) },
    uFlicker: { value: 1 },
    uFogDensity: { value: fogDensity },
    uFogColor: { value: new THREE.Color(PALETTE.fog) },
  };
}

// ---------------------------------------------------------------------------
// Shader modification pipeline
// ---------------------------------------------------------------------------

interface ShaderMod {
  key: string;
  apply(shader: ShaderRef): void;
}

function installMods(material: THREE.Material, role: string, mods: ShaderMod[]): void {
  if (mods.length === 0) return;
  const key = `veil:${role}:${mods.map((m) => m.key).join('|')}`;
  material.onBeforeCompile = (shader): void => {
    for (const mod of mods) mod.apply(shader);
  };
  material.customProgramCacheKey = (): string => key;
}

/** Only storage-qualified declarations are deduplicated; see `prepend`. */
const GLSL_DECLARATION = /^\s*(uniform|varying|attribute)\s/;

/**
 * Prepends a prelude, dropping declarations that are already present.
 *
 * Mods compose, and several of them want `uniform float uTime;` — a duplicate
 * declaration is a GLSL compile error, so the prelude has to be idempotent.
 * The dedupe is deliberately limited to declaration lines: filtering *every*
 * repeated line would happily delete a helper function's closing brace, since
 * `}` on its own occurs all over the stock shaders.
 */
function prepend(source: string, code: string): string {
  const lines = code.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    if (!GLSL_DECLARATION.test(line)) return true;
    return !source.includes(trimmed);
  });
  return lines.length > 0 ? `${lines.join('\n')}\n${source}` : source;
}

function prependVertex(shader: ShaderRef, code: string): void {
  shader.vertexShader = prepend(shader.vertexShader, code);
}

function prependFragment(shader: ShaderRef, code: string): void {
  shader.fragmentShader = prepend(shader.fragmentShader, code);
}

function afterVertex(shader: ShaderRef, chunk: string, code: string): void {
  const token = `#include <${chunk}>`;
  shader.vertexShader = shader.vertexShader.replace(token, `${token}\n${code}`);
}

function afterFragment(shader: ShaderRef, chunk: string, code: string): void {
  const token = `#include <${chunk}>`;
  shader.fragmentShader = shader.fragmentShader.replace(token, `${token}\n${code}`);
}

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------

/**
 * Derives map UVs from world position on the dominant world axis. Boxes hide
 * the projection seams along their own edges, so a single fetch is enough.
 */
function worldUvMod(scale: number): ShaderMod {
  return {
    key: `worlduv${scale.toFixed(4)}`,
    apply(shader): void {
      shader.uniforms.uUvScale = { value: scale };
      prependVertex(shader, 'uniform float uUvScale;\nvarying vec3 vVeilWorld;');
      prependFragment(shader, 'varying vec3 vVeilWorld;');
      afterVertex(
        shader,
        'uv_vertex',
        /* glsl */ `
	vec4 veilWorldPos = vec4( position, 1.0 );
	vec3 veilWorldNrm = normal;
	#ifdef USE_INSTANCING
		veilWorldPos = instanceMatrix * veilWorldPos;
		veilWorldNrm = mat3( instanceMatrix ) * veilWorldNrm;
	#endif
	veilWorldPos = modelMatrix * veilWorldPos;
	veilWorldNrm = mat3( modelMatrix ) * veilWorldNrm;
	vVeilWorld = veilWorldPos.xyz;
	vec3 veilAxis = abs( veilWorldNrm );
	vec2 veilUv;
	if ( veilAxis.y >= veilAxis.x && veilAxis.y >= veilAxis.z ) {
		veilUv = veilWorldPos.xz;
	} else if ( veilAxis.x >= veilAxis.z ) {
		veilUv = vec2( veilWorldPos.z, - veilWorldPos.y );
	} else {
		veilUv = vec2( veilWorldPos.x, - veilWorldPos.y );
	}
	veilUv *= uUvScale;
	#ifdef USE_MAP
		vMapUv = veilUv;
	#endif
	#ifdef USE_NORMALMAP
		vNormalMapUv = veilUv;
	#endif
	#ifdef USE_ROUGHNESSMAP
		vRoughnessMapUv = veilUv;
	#endif
`,
      );
    },
  };
}

export interface SwayOptions {
  /** Local Y at which sway starts (the planted base). */
  baseY: number;
  /** Local Y span over which sway ramps to full strength. */
  span: number;
  /** Peak displacement in world units at the tip. */
  amplitude: number;
  /** Oscillation rate multiplier. */
  frequency: number;
  /** Radius over which `reactAt` bends this surface. */
  bendRadius: number;
}

/**
 * Height-weighted wind sway plus a local displacement bubble driven by
 * `reactAt`. Instanced geometry reads its world origin straight out of
 * `instanceMatrix`; merged geometry is already authored in world space.
 */
function swayMod(uniforms: WorldUniforms, opts: SwayOptions): ShaderMod {
  const f = (n: number): string => n.toFixed(4);
  return {
    key: `sway${f(opts.baseY)}_${f(opts.span)}_${f(opts.amplitude)}_${f(opts.frequency)}`,
    apply(shader): void {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWind = uniforms.uWind;
      shader.uniforms.uBend = uniforms.uBend;
      prependVertex(shader, 'uniform float uTime;\nuniform float uWind;\nuniform vec4 uBend;');
      afterVertex(
        shader,
        'begin_vertex',
        /* glsl */ `
	{
		vec3 veilOrigin;
		#ifdef USE_INSTANCING
			veilOrigin = instanceMatrix[ 3 ].xyz;
		#else
			veilOrigin = vec3( transformed.x, 0.0, transformed.z );
		#endif
		float veilH = clamp( ( transformed.y - ${f(opts.baseY)} ) / ${f(opts.span)}, 0.0, 1.0 );
		veilH *= veilH;
		float veilPhase = veilOrigin.x * 0.42 + veilOrigin.z * 0.31;
		float veilT = uTime * ${f(opts.frequency)};
		float veilAmp = veilH * uWind * ${f(opts.amplitude)};
		transformed.x += ( sin( veilT + veilPhase ) * 0.72 + sin( veilT * 2.13 + veilPhase * 1.7 ) * 0.28 ) * veilAmp;
		transformed.z += cos( veilT * 0.83 + veilPhase * 1.31 ) * 0.62 * veilAmp;
		vec2 veilDelta = veilOrigin.xz - uBend.xz;
		float veilDist = length( veilDelta );
		float veilPush = uBend.w * ( 1.0 - smoothstep( 0.0, ${f(opts.bendRadius)}, veilDist ) );
		if ( veilPush > 0.0005 ) {
			vec2 veilDir = veilDist > 0.001 ? veilDelta / veilDist : vec2( 1.0, 0.0 );
			transformed.xz += veilDir * veilPush * veilH * ${f(opts.amplitude * 2.4)};
		}
	}
`,
      );
    },
  };
}

/**
 * Per-instance emissive flicker derived from the instance origin. Costs one
 * varying and no CPU work at all — coals and lantern glass never tick in sync.
 */
function flickerMod(uniforms: WorldUniforms, rate: number, depth: number): ShaderMod {
  const f = (n: number): string => n.toFixed(4);
  return {
    key: `flicker${f(rate)}_${f(depth)}`,
    apply(shader): void {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uFlicker = uniforms.uFlicker;
      prependVertex(
        shader,
        'uniform float uTime;\nuniform float uFlicker;\nvarying float vVeilFlicker;',
      );
      prependFragment(shader, 'varying float vVeilFlicker;');
      afterVertex(
        shader,
        'begin_vertex',
        /* glsl */ `
	{
		vec3 veilOrigin = vec3( 0.0 );
		#ifdef USE_INSTANCING
			veilOrigin = instanceMatrix[ 3 ].xyz;
		#endif
		float veilPhase = veilOrigin.x * 3.17 + veilOrigin.z * 2.31 + veilOrigin.y * 1.13;
		float veilT = uTime * ${f(rate)};
		float veilWave = sin( veilT + veilPhase ) * 0.5
			+ sin( veilT * 1.87 + veilPhase * 1.7 ) * 0.32
			+ sin( veilT * 0.41 + veilPhase * 0.6 ) * 0.18;
		vVeilFlicker = 1.0 + veilWave * ${f(depth)} * uFlicker;
	}
`,
      );
      afterFragment(
        shader,
        'emissivemap_fragment',
        '	totalEmissiveRadiance *= max( vVeilFlicker, 0.0 );',
      );
    },
  };
}

/** Wing flap for the spectral crows, driven by a per-instance phase attribute. */
function flapMod(uniforms: WorldUniforms): ShaderMod {
  return {
    key: 'flap',
    apply(shader): void {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWind = uniforms.uWind;
      prependVertex(
        shader,
        'uniform float uTime;\nuniform float uWind;\nattribute float aWing;\nattribute vec2 aFlap;',
      );
      afterVertex(
        shader,
        'begin_vertex',
        /* glsl */ `
	if ( aWing > 0.001 ) {
		// aFlap.x is the per-crow phase, aFlap.y the flap depth (0 perched, 1 flying).
		float veilBeat = sin( uTime * 11.0 + aFlap.x ) * ( 0.16 + aFlap.y * 0.95 );
		float veilAng = veilBeat * aWing * sign( transformed.x ) * max( uWind, 0.25 );
		float veilC = cos( veilAng );
		float veilS = sin( veilAng );
		vec3 veilP = transformed;
		transformed.x = veilP.x * veilC - veilP.y * veilS;
		transformed.y = veilP.x * veilS + veilP.y * veilC;
	}
`,
      );
    },
  };
}

/** Blends the non-tiling macro layer over the tiling ground detail. */
function groundMacroMod(macro: THREE.Texture, mapSize: number): ShaderMod {
  return {
    key: 'groundmacro',
    apply(shader): void {
      shader.uniforms.uMacro = { value: macro };
      prependFragment(shader, 'uniform sampler2D uMacro;');
      afterFragment(
        shader,
        'map_fragment',
        /* glsl */ `
	vec4 veilMacro = texture2D( uMacro, vVeilWorld.xz / ${mapSize.toFixed(1)} + 0.5 );
	diffuseColor.rgb *= veilMacro.rgb * 2.0;
`,
      );
      afterFragment(
        shader,
        'roughnessmap_fragment',
        '	roughnessFactor *= mix( 0.35, 1.28, veilMacro.a );',
      );
    },
  };
}

/**
 * Analytic ripple normals plus a crest glint. Deliberately readable rather
 * than mirror-like: the runner has to be able to see the floor through it.
 */
function waterMod(uniforms: WorldUniforms): ShaderMod {
  return {
    key: 'water',
    apply(shader): void {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWind = uniforms.uWind;
      prependVertex(shader, 'varying vec3 vVeilWorld;');
      prependFragment(
        shader,
        `uniform float uTime;
uniform float uWind;
varying vec3 vVeilWorld;
void veilWave( vec2 dir, float freq, float speed, float amp, vec2 p, float t, inout float h, inout vec2 g ) {
	float ph = dot( dir, p ) * freq + t * speed;
	h += amp * sin( ph );
	g += amp * freq * dir * cos( ph );
}`,
      );
      afterVertex(
        shader,
        'begin_vertex',
        '	vVeilWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );
      afterFragment(
        shader,
        'normal_fragment_begin',
        /* glsl */ `
	vec2 veilW = vVeilWorld.xz;
	float veilTime = uTime * mix( 0.15, 1.0, uWind );
	vec2 veilGrad = vec2( 0.0 );
	float veilHeight = 0.0;
	veilWave( vec2( 0.86, 0.51 ), 2.1, 1.30, 0.055, veilW, veilTime, veilHeight, veilGrad );
	veilWave( vec2( -0.42, 0.91 ), 3.4, -1.05, 0.038, veilW, veilTime, veilHeight, veilGrad );
	veilWave( vec2( 0.70, -0.71 ), 5.9, 2.10, 0.020, veilW, veilTime, veilHeight, veilGrad );
	veilWave( vec2( -0.97, -0.24 ), 9.3, 1.65, 0.010, veilW, veilTime, veilHeight, veilGrad );
	// \`normal\` here is view space, and \`normalMatrix\` is vertex-stage only, so the
	// world-space gradient is rotated with the view matrix instead. The water mesh
	// is unrotated and unscaled, so object space is world space.
	normal = normalize( normal + mat3( viewMatrix ) * vec3( - veilGrad.x, 0.0, - veilGrad.y ) * 1.5 );
`,
      );
      afterFragment(
        shader,
        'emissivemap_fragment',
        /* glsl */ `
	// Thin crest lines only. A wide, bright crest mask turns the courtyard into
	// glowing lily pads instead of shallow water.
	float veilCrest = smoothstep( 0.085, 0.115, veilHeight );
	float veilShore = smoothstep( 0.80, 1.0, vUv.x );
	totalEmissiveRadiance += vec3( 0.10, 0.20, 0.24 ) * veilCrest * 0.14;
	totalEmissiveRadiance += vec3( 0.10, 0.15, 0.17 ) * veilShore * 0.12;
	diffuseColor.a *= 1.0 - veilShore * 0.6;
`,
      );
    },
  };
}

/** Slow drift applied after the instance matrix so quad scale doesn't amplify it. */
function driftMod(uniforms: WorldUniforms): ShaderMod {
  return {
    key: 'drift',
    apply(shader): void {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWind = uniforms.uWind;
      prependVertex(shader, 'uniform float uTime;\nuniform float uWind;');
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        /* glsl */ `
	vec4 mvPosition = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		mvPosition = instanceMatrix * mvPosition;
	#endif
	{
		float veilPhase = mvPosition.x * 0.13 + mvPosition.z * 0.11;
		mvPosition.x += sin( uTime * 0.11 + veilPhase ) * 2.6 * uWind;
		mvPosition.z += cos( uTime * 0.087 + veilPhase * 1.4 ) * 2.0 * uWind;
		mvPosition.y += sin( uTime * 0.19 + veilPhase * 2.1 ) * 0.22 * uWind;
	}
	mvPosition = modelViewMatrix * mvPosition;
	gl_Position = projectionMatrix * mvPosition;
`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------

export interface MaterialKit {
  ground: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  stoneDark: THREE.MeshStandardMaterial;
  stoneWarm: THREE.MeshStandardMaterial;
  stonePale: THREE.MeshStandardMaterial;
  hedge: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
  water: THREE.MeshStandardMaterial;
  iron: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  bone: THREE.MeshStandardMaterial;
  charm: THREE.MeshStandardMaterial;
  crow: THREE.MeshStandardMaterial;
  emberAmber: THREE.MeshStandardMaterial;
  emberCyan: THREE.MeshStandardMaterial;
  emberMagenta: THREE.MeshStandardMaterial;
  mist: THREE.MeshBasicMaterial;
  mote: THREE.ShaderMaterial;
  uniforms: WorldUniforms;
  all: THREE.Material[];
  dispose(): void;
}

function standard(
  role: keyof typeof SURFACE,
  extra: THREE.MeshStandardMaterialParameters,
): THREE.MeshStandardMaterial {
  const surface = SURFACE[role];
  const material = new THREE.MeshStandardMaterial({
    color: surface.color,
    roughness: surface.roughness,
    metalness: surface.metalness,
    ...extra,
  });
  if (surface.emissive !== undefined) {
    material.emissive = new THREE.Color(surface.emissive);
    material.emissiveIntensity = surface.emissiveIntensity ?? 1;
  }
  return material;
}

export function createMaterialKit(
  textures: TextureKit,
  uniforms: WorldUniforms,
  mapSize: number,
): MaterialKit {
  // --- Ground -------------------------------------------------------------
  const ground = standard('ground', {
    map: textures.groundDetail,
    normalMap: textures.groundDetailNormal,
    normalScale: new THREE.Vector2(0.85, 0.85),
    dithering: true,
  });
  ground.name = 'veil-ground';
  installMods(ground, 'ground', [
    worldUvMod(UV_SCALE.ground),
    groundMacroMod(textures.groundMacro, mapSize),
  ]);

  // --- Masonry ------------------------------------------------------------
  const stoneMaps: THREE.MeshStandardMaterialParameters = {
    map: textures.stone,
    normalMap: textures.stoneNormal,
    normalScale: new THREE.Vector2(1, 1),
  };
  const stone = standard('stone', stoneMaps);
  stone.name = 'veil-stone';
  installMods(stone, 'stone', [worldUvMod(UV_SCALE.stone)]);

  const stoneDark = standard('stoneDark', stoneMaps);
  stoneDark.name = 'veil-stone-dark';
  installMods(stoneDark, 'stoneDark', [worldUvMod(UV_SCALE.stone * 1.6)]);

  const stoneWarm = standard('stoneWarm', stoneMaps);
  stoneWarm.name = 'veil-stone-warm';
  installMods(stoneWarm, 'stoneWarm', [worldUvMod(UV_SCALE.stone * 0.78)]);

  const stonePale = standard('stonePale', stoneMaps);
  stonePale.name = 'veil-stone-pale';
  installMods(stonePale, 'stonePale', [worldUvMod(UV_SCALE.stone * 2.1)]);

  // --- Foliage ------------------------------------------------------------
  const hedge = standard('hedge', {
    map: textures.hedge,
    normalMap: textures.hedgeNormal,
    normalScale: new THREE.Vector2(1.3, 1.3),
  });
  hedge.name = 'veil-hedge';
  installMods(hedge, 'hedge', [
    worldUvMod(UV_SCALE.hedge),
    swayMod(uniforms, {
      baseY: 0,
      span: 3.1,
      amplitude: 0.16,
      frequency: 1.05,
      bendRadius: 6,
    }),
  ]);

  const grass = standard('grass', {
    map: textures.grassCard,
    alphaTest: 0.42,
    side: THREE.DoubleSide,
    transparent: false,
  });
  grass.name = 'veil-grass';
  installMods(grass, 'grass', [
    swayMod(uniforms, {
      baseY: 0,
      span: 1,
      amplitude: 0.22,
      frequency: 1.7,
      bendRadius: WIND.bendRadius,
    }),
  ]);

  // --- Water --------------------------------------------------------------
  const water = standard('water', {
    transparent: true,
    opacity: 0.78,
    side: THREE.FrontSide,
    depthWrite: false,
  });
  water.name = 'veil-water';
  water.defines = { ...(water.defines ?? {}), USE_UV: '' };
  water.emissive = new THREE.Color(0x0a1c24);
  water.emissiveIntensity = 1;
  installMods(water, 'water', [waterMod(uniforms)]);

  // --- Props --------------------------------------------------------------
  const iron = standard('iron', {
    map: textures.iron,
    normalMap: textures.ironNormal,
    normalScale: new THREE.Vector2(0.7, 0.7),
  });
  iron.name = 'veil-iron';
  installMods(iron, 'iron', [worldUvMod(UV_SCALE.iron)]);

  const wood = standard('wood', {
    map: textures.wood,
    normalMap: textures.woodNormal,
    normalScale: new THREE.Vector2(0.9, 0.9),
  });
  wood.name = 'veil-wood';
  installMods(wood, 'wood', [worldUvMod(UV_SCALE.wood)]);

  const bone = standard('bone', { map: textures.stone });
  bone.name = 'veil-bone';
  installMods(bone, 'bone', [worldUvMod(UV_SCALE.stone * 3.4)]);

  const charm = standard('bone', { map: textures.stone });
  charm.name = 'veil-charm';
  charm.color = new THREE.Color(PALETTE.bone);
  installMods(charm, 'charm', [
    worldUvMod(UV_SCALE.stone * 3.4),
    // Charms hang downward from their anchor, so the span is negative: sway
    // ramps up toward the dangling end rather than the fixed top.
    swayMod(uniforms, {
      baseY: 0,
      span: -1.6,
      amplitude: 0.19,
      frequency: 2.3,
      bendRadius: 8,
    }),
  ]);

  const crow = standard('crow', {});
  crow.name = 'veil-crow';
  crow.emissive = new THREE.Color(0x1d3b4a);
  crow.emissiveIntensity = 0.55;
  installMods(crow, 'crow', [flapMod(uniforms)]);

  // --- Emissives ----------------------------------------------------------
  const emberAmber = standard('amber', { toneMapped: true });
  emberAmber.name = 'veil-ember-amber';
  installMods(emberAmber, 'emberAmber', [flickerMod(uniforms, 6.2, 0.34)]);

  const emberCyan = standard('cyan', { toneMapped: true });
  emberCyan.name = 'veil-ember-cyan';
  installMods(emberCyan, 'emberCyan', [flickerMod(uniforms, 1.35, 0.22)]);

  const emberMagenta = standard('magenta', { toneMapped: true });
  emberMagenta.name = 'veil-ember-magenta';
  installMods(emberMagenta, 'emberMagenta', [flickerMod(uniforms, 2.1, 0.28)]);

  // --- Atmosphere ---------------------------------------------------------
  const mist = new THREE.MeshBasicMaterial({
    map: textures.mist,
    color: new THREE.Color(PALETTE.mist),
    transparent: true,
    opacity: ATMOSPHERE.mistOpacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  mist.name = 'veil-mist';
  installMods(mist, 'mist', [driftMod(uniforms)]);

  const mote = new THREE.ShaderMaterial({
    name: 'veil-mote',
    uniforms: {
      uTime: uniforms.uTime,
      uWind: uniforms.uWind,
      uFogDensity: uniforms.uFogDensity,
      uMap: { value: textures.mote },
      uColor: { value: new THREE.Color(PALETTE.mote) },
      uBox: { value: new THREE.Vector3(1, 1, 1) },
      uSize: { value: 90 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
			uniform float uTime;
			uniform float uWind;
			uniform vec3 uBox;
			uniform float uSize;
			attribute float aSeed;
			varying float vTwinkle;
			varying float vFade;
			void main() {
				vec3 p = position;
				float s = aSeed * 6.2831853;
				p.x += sin( uTime * 0.14 + s ) * 2.3 + uTime * 0.42 * uWind;
				p.y += sin( uTime * 0.23 + s * 1.7 ) * 0.95 + uTime * 0.16 * uWind;
				p.z += cos( uTime * 0.11 + s * 1.3 ) * 2.1 + uTime * 0.27 * uWind;
				vec3 veilHalf = uBox * 0.5;
				p = mod( p + veilHalf, uBox ) - veilHalf;
				vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
				gl_Position = projectionMatrix * mvPosition;
				float dist = - mvPosition.z;
				gl_PointSize = uSize * ( 0.35 + aSeed * 0.9 ) / max( dist, 0.5 );
				vTwinkle = 0.45 + 0.55 * sin( uTime * ( 1.1 + aSeed * 2.4 ) + s );
				vFade = dist;
			}
		`,
    fragmentShader: /* glsl */ `
			uniform sampler2D uMap;
			uniform vec3 uColor;
			uniform float uFogDensity;
			varying float vTwinkle;
			varying float vFade;
			void main() {
				float a = texture2D( uMap, gl_PointCoord ).a;
				if ( a < 0.02 ) discard;
				// Additive blending cannot be fogged toward the fog colour, so
				// motes simply dissolve with distance instead.
				float fogAmount = exp( - uFogDensity * uFogDensity * vFade * vFade );
				gl_FragColor = vec4( uColor * vTwinkle, a * 0.5 * fogAmount );
			}
		`,
  });

  const kit: MaterialKit = {
    ground,
    stone,
    stoneDark,
    stoneWarm,
    stonePale,
    hedge,
    grass,
    water,
    iron,
    wood,
    bone,
    charm,
    crow,
    emberAmber,
    emberCyan,
    emberMagenta,
    mist,
    mote,
    uniforms,
    all: [],
    dispose(): void {
      for (const material of kit.all) material.dispose();
      kit.all.length = 0;
    },
  };
  kit.all = [
    ground,
    stone,
    stoneDark,
    stoneWarm,
    stonePale,
    hedge,
    grass,
    water,
    iron,
    wood,
    bone,
    charm,
    crow,
    emberAmber,
    emberCyan,
    emberMagenta,
    mist,
    mote,
  ];
  return kit;
}
