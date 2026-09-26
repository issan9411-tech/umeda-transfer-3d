import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { disposeTextures, getTexture, setTextureAnisotropy, TEXTURE_METRES, type TextureId } from './textures';

/**
 * Lighting, sky, PBR materials and procedural textures for a more photographic look.
 *
 * - `setupRenderer` / `createEnvironment`: tone mapping, colour space, shadows, PMREM reflections.
 * - `Lighting`: sun / moon / sky light and a gradient sky dome driven by the hour of day in
 *   Osaka (and the app theme: dark = dusk or night), with a shadow camera that follows the walker.
 * - `patchMaterial` / `applyLook`: every lit material gets world-space (triplanar) textures and
 *   an "artificial light" term, so underground corridors are lit by their ceiling lights instead
 *   of the sky, and building windows glow at night.
 * - `materials`: shared MeshStandardMaterial factories (floor tiles, terrazzo, tactile paving, …).
 */

// ---------------------------------------------------------------- renderer + environment

/** ACES filmic tone mapping, sRGB output and soft PCF shadows. */
export function setupRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  // three r186 removed PCFSoftShadowMap; PCF with a sampling radius (set on the light) is the
  // soft variant now.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  setTextureAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
}

let envTexture: THREE.Texture | null = null;

/**
 * Pre-filtered RoomEnvironment for reflections on the look's PBR materials.
 *
 * It is deliberately *not* set as `scene.environment`: since r16x three.js also applies that to
 * Lambert/Phong materials as a multiplicative reflection, which would recolour every schematic
 * overview material. Instead `materials.*` and `applyLook` set it as `envMap` on standard
 * materials, and the look shader scales it by time of day (see `lookUniforms`).
 */
export function createEnvironment(renderer: THREE.WebGLRenderer): { texture: THREE.Texture; dispose: () => void } {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const target = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  envTexture = target.texture;
  return {
    texture: target.texture,
    dispose: () => {
      if (envTexture === target.texture) envTexture = null;
      target.dispose();
    },
  };
}

// ---------------------------------------------------------------- sun position

/** Osaka (Umeda). */
const LAT = 34.7025;
const LON = 135.4959;
/** Default day of year: late April, so the sun rises ≈5:15 and sets ≈18:35 (night 19h–5h). */
export const DEFAULT_DAY = 110;

const DEG = Math.PI / 180;

/**
 * Sun elevation / azimuth (degrees; azimuth clockwise from north) for a local JST hour.
 * Simple declination + hour-angle model (±1° is plenty for lighting).
 */
export function sunPosition(hour: number, dayOfYear = DEFAULT_DAY): { elevation: number; azimuth: number } {
  const decl = 23.44 * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365) * DEG;
  // Equation of time (minutes), then local solar time from JST (UTC+9 → 135°E meridian).
  const b = (2 * Math.PI * (dayOfYear - 81)) / 364;
  const eot = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const solar = hour + (4 * (LON - 135) + eot) / 60;
  const H = (solar - 12) * 15 * DEG;
  const phi = LAT * DEG;
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const az = Math.atan2(-Math.sin(H), Math.tan(decl) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { elevation: el / DEG, azimuth: ((az / DEG) + 360) % 360 };
}

/** Unit vector towards a sky position in scene axes (x = east, y = up, z = south). */
export function skyDirection(elevationDeg: number, azimuthDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const el = elevationDeg * DEG;
  const az = azimuthDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

// ---------------------------------------------------------------- light state (pure)

export interface LightState {
  /** Effective sun elevation used for lighting (clamped to dusk in the dark theme). */
  elevation: number;
  azimuth: number;
  /** 0 = full day … 1 = full night. */
  night: number;
  /** Direction towards the key light (sun, or moon at night). */
  keyDir: THREE.Vector3;
  keyColor: THREE.Color;
  keyIntensity: number;
  shadowIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  envIntensity: number;
  zenith: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  /** Colour of the glow around the sun near the horizon. */
  glow: THREE.Color;
  sunDir: THREE.Vector3;
  /** 0 … 1: sun disc visibility. */
  sunVisible: number;
  moonDir: THREE.Vector3;
  stars: number;
  /** Distance haze / fog colour (matches the sky at the horizon). */
  haze: THREE.Color;
  /** Artificial light added above ground (street lights, shop fronts) and underground. */
  artAbove: THREE.Color;
  artUnder: THREE.Color;
}

type Key = [elevation: number, zenith: string, horizon: string, ground: string, glow: string, hemiSky: string, hemiGround: string, hemiI: number, envI: number, art: number];

/** Sky / ambient keyframes by sun elevation (sRGB hex; interpolated in linear space). */
const KEYS: Key[] = [
  [-18, '#03070f', '#161d2c', '#07090d', '#000000', '#41557f', '#1a1917', 0.9, 0.08, 0.24],
  [-8, '#0a1530', '#353955', '#0e1017', '#4a2a30', '#56689a', '#1e1d1f', 0.95, 0.14, 0.2],
  [-3, '#1a3263', '#8c7b98', '#24242b', '#d9764a', '#7b8cbd', '#2f2c2b', 1.0, 0.36, 0.14],
  [2, '#3b62a0', '#efb58c', '#5c5650', '#ff9a52', '#aab9d7', '#5a5048', 0.9, 0.5, 0.04],
  [10, '#3f74bb', '#e6d3bd', '#8a857c', '#ffc892', '#bed1ea', '#7c7468', 0.85, 0.6, 0],
  [30, '#3a78c4', '#c9dae7', '#9aa0a4', '#fff0d8', '#c8dcf2', '#8a8478', 0.8, 0.7, 0],
  [80, '#2e6ec0', '#c4d7e7', '#9aa0a4', '#fff4e0', '#cadef4', '#8a8478', 0.8, 0.72, 0],
];

type SunKey = [elevation: number, color: string, intensity: number];
const SUN_KEYS: SunKey[] = [
  [-1.5, '#ff7a30', 0],
  [2, '#ff9a55', 1.1],
  [8, '#ffbb80', 2.1],
  [20, '#ffe6c8', 2.3],
  [45, '#fff5e8', 2.6],
  [80, '#fff8f0', 2.7],
];

const MOON_DIR = skyDirection(48, 200);
const MOON_COLOR = new THREE.Color('#9db4dc');
const ART_WARM = new THREE.Color('#ffdcb4');
/** Station / mall lighting: neutral white LEDs, a touch warm. */
const ART_UNDER = new THREE.Color('#fff3e2');

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function keyAt<T extends [number, ...unknown[]]>(keys: T[], el: number): [T, T, number] {
  if (el <= keys[0][0]) return [keys[0], keys[0], 0];
  for (let i = 1; i < keys.length; i++) {
    if (el <= keys[i][0]) {
      const a = keys[i - 1];
      const b = keys[i];
      const t = (el - a[0]) / (b[0] - a[0]);
      return [a, b, t * t * (3 - 2 * t)];
    }
  }
  const last = keys[keys.length - 1];
  return [last, last, 0];
}

const tA = new THREE.Color();
const tB = new THREE.Color();
const lerpHex = (out: THREE.Color, a: string, b: string, t: number) => out.copy(tA.set(a)).lerp(tB.set(b), t);

/**
 * Everything the lights and the sky need for a given hour (pure; testable in node).
 * In the dark theme the sun is held at or below −7° so daytime reads as dusk and evening
 * as night, matching the dark UI.
 */
export function lightState(hour: number, dark: boolean, dayOfYear = DEFAULT_DAY): LightState {
  const h = ((hour % 24) + 24) % 24;
  const sun = sunPosition(h, dayOfYear);
  const el = dark ? Math.min(sun.elevation, -7) : sun.elevation;
  const [a, b, t] = keyAt(KEYS, el);
  const [sa, sb, st] = keyAt(SUN_KEYS, el);

  const sunDir = skyDirection(Math.max(el, -2), sun.azimuth);
  const sunI = sa[2] + (sb[2] - sa[2]) * st;
  const night = 1 - smooth(-12, -2, el);
  const moonI = 0.55 * night;
  const useSun = sunI >= moonI;
  const keyColor = useSun ? lerpHex(new THREE.Color(), sa[1], sb[1], st) : MOON_COLOR.clone();
  const keyIntensity = useSun ? sunI : moonI;

  const art = a[9] + (b[9] - a[9]) * t;
  return {
    elevation: el,
    azimuth: sun.azimuth,
    night,
    // Near the horizon the key light stays a few degrees up, so it never lights from below.
    keyDir: useSun ? skyDirection(Math.max(el, 4), sun.azimuth) : MOON_DIR.clone(),
    keyColor,
    keyIntensity,
    shadowIntensity: useSun ? 0.35 + 0.5 * smooth(0, 20, el) : 0.35,
    hemiSky: lerpHex(new THREE.Color(), a[5], b[5], t),
    hemiGround: lerpHex(new THREE.Color(), a[6], b[6], t),
    hemiIntensity: a[7] + (b[7] - a[7]) * t,
    envIntensity: a[8] + (b[8] - a[8]) * t,
    zenith: lerpHex(new THREE.Color(), a[1], b[1], t),
    horizon: lerpHex(new THREE.Color(), a[2], b[2], t),
    ground: lerpHex(new THREE.Color(), a[3], b[3], t),
    glow: lerpHex(new THREE.Color(), a[4], b[4], t),
    sunDir,
    sunVisible: smooth(-1.5, 1, el),
    moonDir: MOON_DIR.clone(),
    stars: smooth(-10, -16, el),
    haze: lerpHex(new THREE.Color(), a[2], b[2], t).lerp(lerpHex(tA.clone(), a[3], b[3], t), 0.25),
    artAbove: ART_WARM.clone().multiplyScalar(art),
    artUnder: ART_UNDER.clone().multiplyScalar(1.15),
  };
}

// ---------------------------------------------------------------- shared shader uniforms

/**
 * Uniforms shared by every patched material (one update re-lights the whole scene).
 * `lookUnderY` is the scene Y below which surfaces count as underground.
 */
export const lookUniforms = {
  lookUnderY: { value: -1.2 },
  /** Scene Y up to which the night-time street lighting reaches (fades out by 2.5×). */
  lookStreetTop: { value: 24 },
  lookArtAbove: { value: new THREE.Color(0, 0, 0) },
  lookArtUnder: { value: ART_UNDER.clone().multiplyScalar(1.15) },
  /** Reflection strength above ground (day sky) and underground (station lights). */
  lookEnvAbove: { value: 0.7 },
  lookEnvUnder: { value: 0.8 },
  /** How much of the room environment counts as diffuse fill (it is bright and grey). */
  lookEnvDiffuse: { value: 0.25 },
  lookNight: { value: 0 },
};

// ---------------------------------------------------------------- sky dome

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  // Rotation-only view: the dome is infinitely far away and never needs moving.
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position.z = gl_Position.w; // on the far plane
  // Orthographic cameras (the minimap) see no sky.
  if (projectionMatrix[3][3] == 1.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 ground;
uniform vec3 glow;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float sunVisible;
uniform vec3 moonDir;
uniform float stars;
varying vec3 vDir;

float skyHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(zenith, horizon, exp(-max(h, 0.0) * 5.5));
  // Below the horizon: haze fading into the (city) ground colour.
  col = mix(col, ground, smoothstep(0.0, 0.12, -h));

  float cs = max(dot(d, sunDir), 0.0);
  float nearHorizon = exp(-abs(h) * 4.0);
  col += glow * (pow(cs, 6.0) * 0.55 * nearHorizon + pow(cs, 48.0) * 0.35);
  // Sun disc, over-bright so tone mapping renders it white-hot.
  col += sunColor * smoothstep(0.99965, 0.99985, cs) * sunVisible * 18.0 * step(0.0, h);

  // Moon and a sparse, light-polluted star field.
  float cm = max(dot(d, moonDir), 0.0);
  col += vec3(0.85, 0.9, 1.0) * smoothstep(0.99975, 0.9999, cm) * stars * 2.5;
  col += vec3(0.25, 0.3, 0.4) * pow(cm, 64.0) * stars * 0.25;
  if (stars > 0.0) {
    vec3 q = d * 260.0;
    float n = skyHash(floor(q));
    float star = step(0.9975, n) * smoothstep(0.35, 0.0, length(fract(q) - 0.5));
    col += vec3(0.9, 0.92, 1.0) * star * stars * smoothstep(0.04, 0.35, h) * (0.4 + 0.6 * fract(n * 91.0));
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function makeSky(): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      zenith: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      ground: { value: new THREE.Color() },
      glow: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color() },
      sunVisible: { value: 0 },
      moonDir: { value: MOON_DIR.clone() },
      stars: { value: 0 },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  sky.name = 'look:sky';
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  return sky;
}

// ---------------------------------------------------------------- lighting rig

const SHADOW_MAP = 2048;
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _c = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Sun / moon + sky light + sky dome. Add `object` to the scene, call `setTime` when the hour or
 * theme changes and `setShadowFocus` whenever the area of interest moves (cheap; no allocation).
 */
export class Lighting {
  readonly object = new THREE.Group();
  readonly key: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  /** Fog / haze colour for the current time (updated by `setTime`). */
  readonly haze = new THREE.Color('#c9dae7');
  state: LightState;
  private focus = new THREE.Vector3();
  private radius = 150;

  constructor() {
    this.object.name = 'look:lighting';
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.key = new THREE.DirectionalLight(0xffffff, 3);
    this.key.castShadow = true;
    const sh = this.key.shadow;
    sh.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    sh.radius = 3;
    sh.bias = -0.0004;
    sh.normalBias = 0.05;
    this.sky = makeSky();
    this.object.add(this.hemi, this.key, this.key.target, this.sky);
    this.state = lightState(12, false);
    this.setTime(8.5, false);
  }

  /** Turns shadow casting on (walk mode) or off (overview: nothing to cast, saves the pass). */
  setShadows(on: boolean): void {
    this.key.castShadow = on;
  }

  setTime(hour: number, dark: boolean): void {
    const s = lightState(hour, dark);
    this.state = s;
    this.key.color.copy(s.keyColor);
    this.key.intensity = s.keyIntensity;
    this.key.shadow.intensity = s.shadowIntensity;
    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;
    const u = this.sky.material.uniforms;
    u.zenith.value.copy(s.zenith);
    u.horizon.value.copy(s.horizon);
    u.ground.value.copy(s.ground);
    u.glow.value.copy(s.glow);
    u.sunDir.value.copy(s.sunDir);
    u.sunColor.value.copy(s.keyColor);
    u.sunVisible.value = s.sunVisible;
    u.moonDir.value.copy(s.moonDir);
    u.stars.value = s.stars;
    this.haze.copy(s.haze);
    lookUniforms.lookArtAbove.value.copy(s.artAbove);
    lookUniforms.lookArtUnder.value.copy(s.artUnder);
    lookUniforms.lookNight.value = smooth(0.15, 0.8, s.night);
    // Underground reflections come from the station lighting, not the (dim) night sky.
    lookUniforms.lookEnvAbove.value = s.envIntensity;
    this.placeKey();
  }

  /**
   * Vertical zones in scene units: below `underY` surfaces are lit as underground; street
   * lighting at night reaches up to `streetTop` (e.g. the 3F concourse) and fades above it.
   */
  setUndergroundY(underY: number, streetTop = 24): void {
    lookUniforms.lookUnderY.value = underY;
    lookUniforms.lookStreetTop.value = Math.max(1, streetTop);
  }

  /** Centres the shadow camera on `center` covering ±radius (scene units). */
  setShadowFocus(center: THREE.Vector3, radius: number): void {
    this.focus.copy(center);
    if (radius !== this.radius) {
      this.radius = radius;
      const cam = this.key.shadow.camera;
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 1;
      cam.far = radius * 2 + 1200;
      cam.updateProjectionMatrix();
    }
    this.placeKey();
  }

  /** Places the key light up-sun of the focus, snapped to whole shadow texels (no shimmer). */
  private placeKey(): void {
    const dir = this.state.keyDir;
    // Light-space basis (matches Object3D.lookAt from the light to its target).
    _right.crossVectors(WORLD_UP, dir);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(dir, _right).normalize();
    const texel = (2 * this.radius) / SHADOW_MAP;
    const x = this.focus.dot(_right);
    const y = this.focus.dot(_up);
    _c.copy(this.focus)
      .addScaledVector(_right, Math.round(x / texel) * texel - x)
      .addScaledVector(_up, Math.round(y / texel) * texel - y);
    this.key.target.position.copy(_c);
    this.key.position.copy(_c).addScaledVector(dir, this.radius + 600);
    this.key.target.updateMatrixWorld();
    this.key.updateMatrixWorld();
  }

  dispose(): void {
    this.object.removeFromParent();
    this.key.shadow.dispose();
    this.key.dispose();
    this.hemi.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
  }
}

// ---------------------------------------------------------------- material patch

export interface PatchOptions {
  /** Texture drawn in world space (triplanar), at its real-world size. */
  texture?: TextureId;
  /** Emissive map texture (world space, same scale as `texture`). */
  emissive?: TextureId;
  /** Multiply the emissive colour by the night factor (lit windows). */
  nightEmissive?: boolean;
  /** Low-frequency brightness variation (0 … 0.5) to break up tiling on large floors. */
  macro?: number;
}

type Patchable = THREE.MeshStandardMaterial | THREE.MeshLambertMaterial | THREE.MeshPhongMaterial;

const VERT_HEAD = /* glsl */ `
varying vec3 vLookPos;
varying vec3 vLookNormal;`;

const VERT_BODY = /* glsl */ `
{
  vec4 lookP = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    lookP = batchingMatrix * lookP;
  #endif
  #ifdef USE_INSTANCING
    lookP = instanceMatrix * lookP;
  #endif
  vLookPos = (modelMatrix * lookP).xyz;
  vLookNormal = inverseTransformDirection(transformedNormal, viewMatrix);
}`;

const FRAG_HEAD = /* glsl */ `
varying vec3 vLookPos;
varying vec3 vLookNormal;
uniform float lookUnderY;
uniform float lookStreetTop;
uniform vec3 lookArtAbove;
uniform vec3 lookArtUnder;
uniform float lookEnvAbove;
uniform float lookEnvUnder;
uniform float lookEnvDiffuse;
uniform float lookNight;
#ifdef LOOK_TRIPLANAR
  uniform vec2 lookScale;
  uniform float lookMacro;
  float lookHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float lookNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(lookHash(i), lookHash(i + vec2(1.0, 0.0)), f.x), mix(lookHash(i + vec2(0.0, 1.0)), lookHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  vec3 lookWeights() {
    vec3 w = pow(abs(normalize(vLookNormal)), vec3(6.0));
    return w / (w.x + w.y + w.z + 1e-5);
  }
  // Floors use x/z; walls use their horizontal run and height.
  vec4 lookSample(sampler2D tex, vec3 w) {
    return texture2D(tex, vec2(vLookPos.z, vLookPos.y) * lookScale) * w.x
      + texture2D(tex, vLookPos.xz * lookScale.x) * w.y
      + texture2D(tex, vec2(vLookPos.x, vLookPos.y) * lookScale) * w.z;
  }
#endif`;

const FRAG_MAP = /* glsl */ `
#if defined(LOOK_TRIPLANAR) && defined(USE_MAP)
  vec3 lookW = lookWeights();
  diffuseColor *= lookSample(map, lookW);
  float lookN = lookNoise(vLookPos.xz * 0.11) * 0.65 + lookNoise(vLookPos.xz * 0.53) * 0.35;
  diffuseColor.rgb *= 1.0 + lookMacro * (lookN - 0.5);
#else
  #include <map_fragment>
#endif`;

const FRAG_EMISSIVE = /* glsl */ `
#if defined(LOOK_TRIPLANAR) && defined(USE_EMISSIVEMAP)
  totalEmissiveRadiance *= lookSample(emissiveMap, lookWeights()).rgb;
#else
  #include <emissivemap_fragment>
#endif
#ifdef LOOK_NIGHT_EMISSIVE
  totalEmissiveRadiance *= lookNight;
#endif`;

/*
 * Underground (below lookUnderY) the sun and sky are replaced by the station's own lighting;
 * above ground the artificial term is a warm fill that only matters at night.
 */
const FRAG_LIGHTS = /* glsl */ `
#include <lights_fragment_end>
{
  float lookU = 1.0 - smoothstep(lookUnderY - 2.0, lookUnderY + 0.4, vLookPos.y);
  reflectedLight.directDiffuse *= 1.0 - lookU;
  reflectedLight.directSpecular *= 1.0 - lookU;
  reflectedLight.indirectDiffuse *= 1.0 - 0.85 * lookU;
  reflectedLight.indirectSpecular *= mix(lookEnvAbove, lookEnvUnder, lookU);
  // Street lights and shop fronts only reach the lower storeys.
  float lookStreet = 1.0 - smoothstep(lookStreetTop, lookStreetTop * 2.5, vLookPos.y);
  reflectedLight.indirectDiffuse += material.diffuseColor * mix(lookArtAbove * lookStreet, lookArtUnder, lookU);
}`;

/**
 * Adds the look shader hooks to a lit material (idempotent). With a `texture` the material's
 * `map` is sampled in world space, so geometry needs no UVs (instanced boxes included).
 * Without a canvas (node) textures are skipped and the material keeps its plain colour.
 */
export function patchMaterial<M extends Patchable>(mat: M, o: PatchOptions = {}): M {
  if (mat.userData.look) return mat;
  const map = o.texture ? getTexture(o.texture) : null;
  const emap = o.emissive ? getTexture(o.emissive) : null;
  const metres = TEXTURE_METRES[o.texture ?? o.emissive ?? 'floorTile'];
  const tri = !!(map || emap);
  if (map) mat.map = map;
  if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial && !(mat as THREE.MeshStandardMaterial).envMap && envTexture) {
    (mat as THREE.MeshStandardMaterial).envMap = envTexture;
  }
  if (emap && 'emissiveMap' in mat) mat.emissiveMap = emap;
  const scale = new THREE.Vector2(1 / metres[0], 1 / metres[1]);
  const macro = o.macro ?? 0;
  const key = `look1${tri ? 't' : ''}${o.nightEmissive ? 'n' : ''}`;
  mat.userData.look = { key, scale, macro };
  mat.defines = { ...(mat.defines ?? {}) };
  if (tri) mat.defines.LOOK_TRIPLANAR = '';
  if (o.nightEmissive) mat.defines.LOOK_NIGHT_EMISSIVE = '';
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, lookUniforms);
    shader.uniforms.lookScale = { value: scale };
    shader.uniforms.lookMacro = { value: macro };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n#ifdef STANDARD\n  iblIrradiance *= lookEnvDiffuse;\n#endif')
      .replace('#include <lights_fragment_end>', FRAG_LIGHTS);
  };
  mat.needsUpdate = true;
  return mat;
}

// ---------------------------------------------------------------- material factories

export interface MatOptions {
  color?: THREE.ColorRepresentation;
  /** Tint by vertex colours (the material colour becomes white). */
  vertexColors?: boolean;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
}

function standard(o: MatOptions, color: THREE.ColorRepresentation, roughness: number, metalness: number, patch: PatchOptions): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: o.vertexColors ? 0xffffff : (o.color ?? color),
    roughness,
    metalness,
    vertexColors: !!o.vertexColors,
    side: o.side ?? THREE.FrontSide,
    transparent: !!o.transparent,
    opacity: o.opacity ?? 1,
    depthWrite: o.depthWrite ?? !o.transparent,
  });
  return patchMaterial(m, patch);
}

/**
 * Material factories. Each call returns a new material (owners may dispose it); the textures
 * behind them are shared and cached (see `disposeLook`).
 */
export const materials = {
  /** Polished 60 cm station floor tiles (light grey). */
  floorTile: (o: MatOptions = {}) => standard(o, '#cfcbc4', 0.42, 0, { texture: 'floorTile', macro: 0.12 }),
  /** Terrazzo for underground malls. */
  terrazzo: (o: MatOptions = {}) => standard(o, '#e3ddd2', 0.25, 0, { texture: 'terrazzo', macro: 0.1 }),
  /** Yellow tactile paving: dots (warning) or bars (direction). */
  tactile: (o: MatOptions & { bars?: boolean } = {}) =>
    standard(o, '#e9b300', 0.55, 0, { texture: o.bars ? 'tactileBars' : 'tactileDots' }),
  asphalt: (o: MatOptions = {}) => standard(o, '#5c6166', 0.92, 0, { texture: 'asphalt', macro: 0.25 }),
  /** Interlocking sidewalk pavers. */
  pavers: (o: MatOptions = {}) => standard(o, '#b3aba0', 0.85, 0, { texture: 'pavers', macro: 0.18 }),
  concrete: (o: MatOptions = {}) => standard(o, '#a9a7a1', 0.88, 0, { texture: 'concrete', macro: 0.2 }),
  /** Brushed stainless steel (handrails, gate bodies, cladding). */
  metal: (o: MatOptions = {}) => standard(o, '#c9ced3', 0.38, 0.75, { texture: 'brushedMetal' }),
  escalatorTread: (o: MatOptions = {}) => standard(o, '#9aa0a6', 0.45, 0.6, { texture: 'escalatorTread' }),
  /** Clear glazing: screens, lift shafts, corridor walls. */
  glass: (o: MatOptions = {}) =>
    standard({ transparent: true, opacity: 0.25, depthWrite: false, ...o }, '#b9cfd9', 0.06, 0.1, {}),
  /** Glass curtain wall: reflective by day, random lit offices at night. */
  facade: (o: MatOptions = {}) => {
    const m = standard(o, '#ffffff', 0.1, 0.25, { texture: 'facadeDay', emissive: 'facadeNight', nightEmissive: true });
    m.emissive.set(m.emissiveMap ? 0xffffff : 0xffd9a0);
    m.emissiveIntensity = m.emissiveMap ? 1.1 : 0.25;
    return m;
  },
  /** Painted car body (clear-coated look). */
  trainPaint: (o: MatOptions = {}) => standard(o, '#9aa3ab', 0.32, 0.45, { texture: 'brushedMetal' }),
};

/** Releases the shared textures (materials made by `materials` are disposed by their owners). */
export function disposeLook(): void {
  disposeTextures();
}

// ---------------------------------------------------------------- scene pass

/**
 * Material role by mesh name / `userData.look` (set by the geometry builders).
 * Roles replace the builder's placeholder material with a textured PBR one.
 */
const ROLES: Record<string, (old: THREE.Material) => THREE.Material> = {
  floor: () => materials.floorTile({ vertexColors: true, side: THREE.DoubleSide }),
  terrazzo: () => materials.terrazzo({ vertexColors: true, side: THREE.DoubleSide }),
  paving: () => materials.pavers({ vertexColors: true, side: THREE.DoubleSide }),
  crossing: () => materials.asphalt({ vertexColors: true, side: THREE.DoubleSide }),
  walls: (old) => materials.glass({ vertexColors: true, side: THREE.DoubleSide, opacity: Math.min(0.35, old.opacity + 0.02) }),
  shafts: (old) => materials.glass({ side: THREE.DoubleSide, opacity: Math.max(0.12, old.opacity), color: '#8fd3a8' }),
  fixtures: () => materials.concrete({ vertexColors: false }),
  trainBody: (old) => materials.trainPaint({ color: (old as THREE.MeshLambertMaterial).color ?? '#9aa3ab' }),
  /** Walk mode: the street plane becomes (see-through) paving, roads become asphalt. */
  ground: (old) => materials.pavers({ color: '#a39d94', transparent: true, opacity: old.opacity, depthWrite: false }),
  road: (old) => materials.asphalt({ side: THREE.DoubleSide, transparent: true, opacity: Math.max(0.85, old.opacity), depthWrite: false }),
  trainGlass: () => {
    const m = new THREE.MeshStandardMaterial({ color: '#1a232c', roughness: 0.05, metalness: 0.6 });
    return patchMaterial(m);
  },
};

/** Roles that should never cast shadows (glass, light panels). */
const NO_CAST = new Set(['walls', 'shafts', 'lights', 'guide', 'crossing']);

export interface ApplyOptions {
  /** Set castShadow / receiveShadow (walk mode). False clears them (overview). */
  shadows?: boolean;
  /** Walk mode: also restyle the schematic street plane and roads (roles in WALK_ROLES). */
  walk?: boolean;
}

/** Roles only applied in walk mode; in the overview these stay schematic. */
const WALK_ROLES = new Set(['ground', 'road']);

/**
 * Walks `root` once: role meshes get PBR materials, every other lit material gets the look
 * hooks (underground light, night fill), emissive light panels skip tone mapping. Idempotent,
 * so it is safe to call after every rebuild.
 */
export function applyLook(root: THREE.Object3D, o: ApplyOptions = {}): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || obj.name === 'look:sky') return;
    const role = (mesh.userData.look as string | undefined) ?? mesh.name;
    const old = mesh.material as THREE.Material | THREE.Material[];
    if (!Array.isArray(old)) {
      const make = WALK_ROLES.has(role) && !o.walk ? undefined : ROLES[role];
      if (make && !old.userData.look) {
        mesh.material = make(old);
        old.dispose();
      } else if (role === 'lights' || role === 'guide') {
        old.toneMapped = role !== 'lights';
      } else if (isPatchable(old)) {
        patchMaterial(old);
      }
    } else {
      for (const m of old) if (isPatchable(m)) patchMaterial(m);
    }
    const mat = mesh.material as THREE.Material;
    const lit = !(mat as THREE.MeshBasicMaterial).isMeshBasicMaterial;
    if (o.shadows === undefined) return;
    mesh.castShadow = o.shadows && lit && !mat.transparent && !NO_CAST.has(role);
    mesh.receiveShadow = o.shadows && lit;
  });
}

function isPatchable(m: THREE.Material): m is Patchable {
  return !!((m as THREE.MeshStandardMaterial).isMeshStandardMaterial || (m as THREE.MeshLambertMaterial).isMeshLambertMaterial || (m as THREE.MeshPhongMaterial).isMeshPhongMaterial);
}
