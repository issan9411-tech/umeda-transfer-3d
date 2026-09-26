import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyLook, Lighting, lightState, lookUniforms, materials, patchMaterial, sunPosition } from '../src/render/look';
import { getTexture, mulberry32, TEXTURE_METRES } from '../src/render/textures';

const finite = (v: THREE.Vector3 | THREE.Color) => (v instanceof THREE.Color ? [v.r, v.g, v.b] : [v.x, v.y, v.z]).every(Number.isFinite);

describe('sun position (Osaka, late April)', () => {
  it('is high in the south at noon and below the horizon at night', () => {
    const noon = sunPosition(12);
    expect(noon.elevation).toBeGreaterThan(60);
    expect(noon.elevation).toBeLessThan(75);
    expect(Math.abs(noon.azimuth - 180)).toBeLessThan(10);
    expect(sunPosition(21).elevation).toBeLessThan(-15);
    expect(sunPosition(3).elevation).toBeLessThan(-15);
  });

  it('rises in the east around 5 h and sets in the west around 18.5 h', () => {
    expect(sunPosition(4.8).elevation).toBeLessThan(0);
    expect(sunPosition(5.8).elevation).toBeGreaterThan(0);
    expect(sunPosition(6).azimuth).toBeGreaterThan(60);
    expect(sunPosition(6).azimuth).toBeLessThan(110);
    expect(sunPosition(18).elevation).toBeGreaterThan(0);
    expect(sunPosition(19).elevation).toBeLessThan(0);
    expect(sunPosition(18).azimuth).toBeGreaterThan(250);
  });
});

describe('light state', () => {
  it('has no NaN for any hour in either theme', () => {
    for (let h = 0; h <= 24; h += 0.25) {
      for (const dark of [false, true]) {
        const s = lightState(h, dark);
        for (const v of [s.keyDir, s.keyColor, s.hemiSky, s.hemiGround, s.zenith, s.horizon, s.ground, s.glow, s.haze, s.artAbove, s.artUnder, s.sunDir]) {
          expect(finite(v)).toBe(true);
        }
        expect(s.keyIntensity).toBeGreaterThanOrEqual(0);
        expect(s.night).toBeGreaterThanOrEqual(0);
        expect(s.night).toBeLessThanOrEqual(1);
        expect(s.keyDir.y).toBeGreaterThan(0); // key light always comes from above
      }
    }
  });

  it('is day at noon, night at 21 h, and warm at golden hour', () => {
    const noon = lightState(12, false);
    const night = lightState(21, false);
    const golden = lightState(17.5, false);
    expect(noon.night).toBe(0);
    expect(night.night).toBe(1);
    expect(noon.keyIntensity).toBeGreaterThan(golden.keyIntensity);
    expect(night.keyIntensity).toBeLessThan(1); // moonlight
    expect(night.artAbove.r).toBeGreaterThan(0); // street lights on
    expect(noon.artAbove.r).toBe(0);
    expect(golden.keyColor.b / golden.keyColor.r).toBeLessThan(noon.keyColor.b / noon.keyColor.r);
    expect(night.stars).toBeGreaterThan(0.5);
  });

  it('turns daytime into dusk in the dark theme', () => {
    const s = lightState(12, true);
    expect(s.elevation).toBeLessThanOrEqual(-7);
    expect(s.night).toBeGreaterThan(0.3);
    expect(s.zenith.getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThan(lightState(12, false).zenith.getHSL({ h: 0, s: 0, l: 0 }).l);
  });

  it('keeps underground lighting constant through the day', () => {
    expect(lightState(3, false).artUnder.equals(lightState(12, false).artUnder)).toBe(true);
  });
});

describe('Lighting rig', () => {
  it('updates shared uniforms and snaps the shadow camera to texels', () => {
    const L = new Lighting();
    L.setTime(21, false);
    expect(lookUniforms.lookNight.value).toBe(1);
    L.setTime(12, false);
    expect(lookUniforms.lookNight.value).toBe(0);
    L.setShadowFocus(new THREE.Vector3(123.456, 10, -78.9), 100);
    const cam = L.key.shadow.camera;
    expect(cam.right - cam.left).toBe(200);
    // Target moves by less than one shadow texel from the requested focus.
    expect(L.key.target.position.distanceTo(new THREE.Vector3(123.456, 10, -78.9))).toBeLessThan((200 / 2048) * 1.5);
    expect(L.key.position.y).toBeGreaterThan(L.key.target.position.y);
    L.setUndergroundY(-3, 24);
    expect(lookUniforms.lookUnderY.value).toBe(-3);
    L.dispose();
  });
});

describe('materials and textures (node: no canvas)', () => {
  it('falls back to plain colours without a DOM', () => {
    expect(getTexture('floorTile')).toBeNull();
    const m = materials.floorTile();
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(m.map).toBeNull();
    expect(m.defines?.LOOK_TRIPLANAR).toBeUndefined();
    const f = materials.facade();
    expect(f.defines?.LOOK_NIGHT_EMISSIVE).toBe('');
    expect(materials.floorTile({ vertexColors: true }).color.getHex()).toBe(0xffffff);
  });

  it('patches idempotently with a distinct program cache key', () => {
    const m = new THREE.MeshLambertMaterial();
    patchMaterial(m);
    const hook = m.onBeforeCompile;
    patchMaterial(m, { nightEmissive: true });
    expect(m.onBeforeCompile).toBe(hook);
    expect(m.customProgramCacheKey()).toMatch(/^look/);
    // The hook injects the shared uniforms and rewrites the lighting chunk.
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.lookUnderY).toBe(lookUniforms.lookUnderY);
    expect(shader.fragmentShader).toContain('lookArtUnder');
    expect(shader.vertexShader).toContain('vLookPos =');
  });

  it('keeps real-world texture sizes and deterministic noise', () => {
    expect(TEXTURE_METRES.floorTile).toEqual([2.4, 2.4]);
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });
});

describe('applyLook', () => {
  it('swaps role materials, patches the rest and sets shadow flags', () => {
    const root = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
    floor.name = 'floor';
    const walls = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.3 }));
    walls.name = 'walls';
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.55 }));
    ground.name = 'ground';
    const other = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial());
    const light = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    light.name = 'lights';
    root.add(floor, walls, ground, other, light);

    applyLook(root, { shadows: false });
    expect(floor.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(ground.material).toBeInstanceOf(THREE.MeshLambertMaterial); // overview keeps it schematic
    expect((other.material as THREE.Material).userData.look).toBeTruthy();
    expect((light.material as THREE.Material).toneMapped).toBe(false);
    expect(floor.castShadow).toBe(false);

    const floorMat = floor.material;
    applyLook(root, { shadows: true, walk: true });
    expect(floor.material).toBe(floorMat); // idempotent
    expect(floor.castShadow && floor.receiveShadow).toBe(true);
    expect(walls.castShadow).toBe(false); // glass
    expect(walls.receiveShadow).toBe(true);
    expect(other.castShadow).toBe(true);
    expect(light.receiveShadow).toBe(false);
  });
});
