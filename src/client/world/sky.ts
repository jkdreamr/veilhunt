/**
 * Sky dome and moon.
 *
 * Two objects, both raw `ShaderMaterial`s and both `frustumCulled = false`:
 *
 * 1. A `BackSide` sphere carrying the vertical gradient (deep indigo zenith
 *    down to a cold horizon haze), a two-layer star field and the moon's wide
 *    atmospheric halo.
 * 2. A billboard disc for the moon itself, with a limb-darkened edge and faint
 *    mare blotches.
 *
 * Raw shader materials bypass tone mapping and output colour-space conversion,
 * so every colour here is authored in *display* space. `displayColor()` loads a
 * hex literal without the usual sRGB-to-linear conversion to keep it that way.
 *
 * The dome is small (radius 20) and rides along with the camera, with depth
 * testing off and a very negative render order. That makes it immune to
 * whatever near/far planes the app picks.
 */

import * as THREE from 'three';
import { PALETTE } from './palette.js';

/** Loads a hex literal verbatim, skipping the sRGB-to-working conversion. */
function displayColor(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
}

const DOME_RADIUS = 20;
const MOON_DISTANCE = 18.5;
const MOON_QUAD_RADIUS = 2.5;

export interface SkyHandles {
  group: THREE.Group;
  /** Unit vector from the world origin toward the moon. */
  moonDirection: THREE.Vector3;
  /** Keeps the dome centred on the viewer and advances the slow drift. */
  update(cameraPosition: THREE.Vector3, elapsed: number): void;
  dispose(): void;
}

const SKY_VERTEX = /* glsl */ `
	varying vec3 vDir;
	void main() {
		vDir = position;
		gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	}
`;

const SKY_FRAGMENT = /* glsl */ `
	precision highp float;

	uniform vec3 uZenith;
	uniform vec3 uMid;
	uniform vec3 uHorizon;
	uniform vec3 uHaze;
	uniform vec3 uStarColor;
	uniform vec3 uHaloColor;
	uniform vec3 uMoonDir;
	uniform float uTime;
	uniform float uSeed;
	varying vec3 vDir;

	float hash21( vec2 p ) {
		vec3 q = fract( vec3( p.xyx ) * ( 0.1031 + uSeed * 0.0007 ) );
		q += dot( q, q.yzx + 33.33 );
		return fract( ( q.x + q.y ) * q.z );
	}

	float valueNoise( vec2 p ) {
		vec2 i = floor( p );
		vec2 f = fract( p );
		f = f * f * ( 3.0 - 2.0 * f );
		float a = hash21( i );
		float b = hash21( i + vec2( 1.0, 0.0 ) );
		float c = hash21( i + vec2( 0.0, 1.0 ) );
		float d = hash21( i + vec2( 1.0, 1.0 ) );
		return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
	}

	/** One scattered star layer: one star per cell, gated by a density threshold. */
	float starLayer( vec2 uv, float density, float sharpness ) {
		vec2 id = floor( uv );
		vec2 f = fract( uv );
		float rnd = hash21( id );
		float present = step( density, rnd );
		vec2 offset = vec2( hash21( id + 17.1 ), hash21( id + 41.7 ) ) * 0.7 + 0.15;
		float d = length( f - offset );
		float core = pow( max( 0.0, 1.0 - d * sharpness ), 6.0 );
		float twinkle = 0.55 + 0.45 * sin( uTime * 0.9 + rnd * 44.0 );
		return core * present * twinkle * ( 0.35 + 0.65 * hash21( id + 71.3 ) );
	}

	void main() {
		vec3 dir = normalize( vDir );
		float h = dir.y;

		// Vertical gradient: haze band hugging the horizon, indigo overhead.
		vec3 sky = mix( uHorizon, uMid, smoothstep( 0.0, 0.34, h ) );
		sky = mix( sky, uZenith, smoothstep( 0.28, 0.85, h ) );
		sky = mix( uHaze, sky, smoothstep( -0.09, 0.11, h ) );

		// Sparse cold cloud banding just above the skyline.
		vec2 cloudUv = vec2( atan( dir.z, dir.x ) * 1.6, h * 7.0 );
		float clouds = valueNoise( cloudUv * 1.4 ) * 0.6 + valueNoise( cloudUv * 3.7 ) * 0.4;
		clouds = smoothstep( 0.52, 0.92, clouds ) * ( 1.0 - smoothstep( 0.06, 0.46, h ) );
		sky = mix( sky, uHaze * 1.25, clouds * 0.5 );

		// Stars: fade out near the horizon haze and inside the moon's glare.
		float moonDot = max( dot( dir, uMoonDir ), 0.0 );
		vec2 sph = vec2( atan( dir.z, dir.x ), asin( clamp( h, -1.0, 1.0 ) ) );
		float stars = starLayer( sph * 34.0, 0.955, 9.0 ) * 1.0;
		stars += starLayer( sph * 71.0 + 13.7, 0.982, 12.0 ) * 0.7;
		float starFade = smoothstep( 0.02, 0.3, h ) * ( 1.0 - clouds * 0.85 );
		starFade *= 1.0 - pow( moonDot, 42.0 ) * 0.9;
		sky += uStarColor * stars * starFade;

		// Wide atmospheric halo around the moon.
		float halo = pow( moonDot, 190.0 ) * 0.55 + pow( moonDot, 14.0 ) * 0.1;
		sky += uHaloColor * halo;

		// No colour-space or tone-mapping chunk: the values written here are the
		// final display-space texels, which is why the palette is authored in sRGB.
		gl_FragColor = vec4( sky, 1.0 );
	}
`;

const MOON_VERTEX = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	}
`;

const MOON_FRAGMENT = /* glsl */ `
	precision highp float;

	uniform vec3 uMoonColor;
	uniform vec3 uHaloColor;
	varying vec2 vUv;

	void main() {
		vec2 p = ( vUv - 0.5 ) * 2.0;
		float d = length( p );

		float disc = 1.0 - smoothstep( 0.40, 0.435, d );
		// Limb darkening keeps the edge from reading as a flat sticker.
		float limb = 1.0 - smoothstep( 0.12, 0.42, d ) * 0.22;

		// Two soft mare blotches, fixed so the moon has a recognisable face.
		float mare = smoothstep( 0.26, 0.02, length( p - vec2( -0.11, 0.07 ) ) ) * 0.5;
		mare += smoothstep( 0.19, 0.01, length( p - vec2( 0.13, -0.13 ) ) ) * 0.38;
		mare += smoothstep( 0.12, 0.0, length( p - vec2( 0.05, 0.19 ) ) ) * 0.3;

		vec3 body = uMoonColor * limb * ( 1.0 - mare * 0.17 );
		float glow = pow( max( 0.0, 1.0 - d ), 3.4 ) * 0.42;

		vec3 color = body * disc + uHaloColor * glow;
		float alpha = disc + glow * 0.85;
		gl_FragColor = vec4( color, clamp( alpha, 0.0, 1.0 ) );
	}
`;

/**
 * Builds the dome and moon. `moonDirection` should be the direction the
 * moonlight arrives *from*, i.e. the normalised directional light position.
 */
export function createSky(seed: number, moonDirection: THREE.Vector3): SkyHandles {
  const group = new THREE.Group();
  group.name = 'veil-sky';
  const dir = moonDirection.clone().normalize();

  const domeGeometry = new THREE.SphereGeometry(DOME_RADIUS, 32, 20);
  const domeMaterial = new THREE.ShaderMaterial({
    name: 'veil-sky-dome',
    uniforms: {
      uZenith: { value: displayColor(PALETTE.skyZenith) },
      uMid: { value: displayColor(PALETTE.skyMid) },
      uHorizon: { value: displayColor(PALETTE.skyHorizon) },
      uHaze: { value: displayColor(PALETTE.skyHaze) },
      uStarColor: { value: displayColor(PALETTE.star) },
      uHaloColor: { value: displayColor(PALETTE.moonHalo) },
      uMoonDir: { value: dir.clone() },
      uTime: { value: 0 },
      uSeed: { value: (seed % 977) / 977 },
    },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
  });
  const dome = new THREE.Mesh(domeGeometry, domeMaterial);
  dome.name = 'veil-sky-dome';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.matrixAutoUpdate = false;
  group.add(dome);

  const moonGeometry = new THREE.CircleGeometry(MOON_QUAD_RADIUS, 64);
  const moonMaterial = new THREE.ShaderMaterial({
    name: 'veil-sky-moon',
    uniforms: {
      uMoonColor: { value: displayColor(PALETTE.moonDisc) },
      uHaloColor: { value: displayColor(PALETTE.moonHalo) },
    },
    vertexShader: MOON_VERTEX,
    fragmentShader: MOON_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
  });
  const moon = new THREE.Mesh(moonGeometry, moonMaterial);
  moon.name = 'veil-sky-moon';
  moon.frustumCulled = false;
  moon.renderOrder = -999;
  moon.position.copy(dir).multiplyScalar(MOON_DISTANCE);
  moon.lookAt(0, 0, 0);
  moon.updateMatrix();
  moon.matrixAutoUpdate = false;
  group.add(moon);

  return {
    group,
    moonDirection: dir,
    update(cameraPosition, elapsed): void {
      group.position.copy(cameraPosition);
      domeMaterial.uniforms.uTime.value = elapsed;
    },
    dispose(): void {
      domeGeometry.dispose();
      domeMaterial.dispose();
      moonGeometry.dispose();
      moonMaterial.dispose();
      group.clear();
    },
  };
}
