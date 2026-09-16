// explosion.js — Optimized: no per-spawn Vector3 allocs, no forEach closures,
// inlined lerpColor, cached index math, tighter tick loop, no rocks layer,
// zero _active entry allocation after warmup via entry pool.

import * as THREE from 'three';

const BASE = 'https://raw.githubusercontent.com/NewKrok/three-particles-editor/refs/heads/master/public/assets/textures';
const loader = new THREE.TextureLoader();
const textures = {
  flame:  loader.load(`/textures/flame.png`),
  flare:  loader.load("/textures/spark.png"),
  cloud:  loader.load(`/textures/cloud.png`),
  rocks:  loader.load(`${BASE}/rocks.webp`),
  shells: loader.load(`/textures/bullet_shells.png`),
};

// ── Shader — supports per-particle RGB color ──────────────────────────────────

function makeMaterial(texture, blending) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map:  { value: texture },
      cols: { value: 1 },
      rows: { value: 1 },
      pixelScale: { value: 400.0 },
    },
    vertexShader: /* glsl */`
      attribute float size;
      attribute float opacity;
      attribute float rotation;
      attribute float frame;
      attribute vec3  color;
      uniform float pixelScale;
      varying float vOpacity;
      varying float vRotation;
      varying float vFrame;
      varying vec3  vColor;
      void main() {
        vOpacity  = opacity;
        vRotation = rotation;
        vFrame    = frame;
        vColor    = color;
        vec4 mv   = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (pixelScale / -mv.z);
        gl_Position  = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D map;
      uniform float cols;
      uniform float rows;
      varying float vOpacity;
      varying float vRotation;
      varying float vFrame;
      varying vec3  vColor;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float s = sin(vRotation);
        float c = cos(vRotation);
        uv = vec2(c*uv.x - s*uv.y, s*uv.x + c*uv.y) + 0.5;
        float fi  = floor(vFrame);
        float col = mod(fi, cols);
        float row = floor(fi / cols);
        uv = (uv + vec2(col, row)) / vec2(cols, rows);
        vec4 tex = texture2D(map, uv);
        gl_FragColor = vec4(tex.rgb * vColor, tex.a * vOpacity);
        if (gl_FragColor.a < 0.005) discard;
      }
    `,
    transparent: true,
    depthWrite:  false,
    // depthTest:   false,
    blending,
  });
}

// ── Layer ─────────────────────────────────────────────────────────────────────

function makeLayer(scene, count, texture, blending, renderOrder = 7) {
  const positions = new Float32Array(count * 3);
  const sizes     = new Float32Array(count);
  const opacities = new Float32Array(count);
  const rotations = new Float32Array(count);
  const frames    = new Float32Array(count);
  const colors    = new Float32Array(count * 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('size',     new THREE.BufferAttribute(sizes,     1));
  geo.setAttribute('opacity',  new THREE.BufferAttribute(opacities, 1));
  geo.setAttribute('rotation', new THREE.BufferAttribute(rotations, 1));
  geo.setAttribute('frame',    new THREE.BufferAttribute(frames,    1));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

  const mat    = makeMaterial(texture, blending);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = renderOrder;   // must render AFTER flightCloudMesh (renderOrder 6) in main.js, or plane damage smoke gets hidden behind the cloud layer
  scene.add(points);

  return {
    points, geo, mat,
    positions, sizes, opacities, rotations, frames, colors,
    ages:      new Float32Array(count).fill(9999),
    lifetimes: new Float32Array(count).fill(1),
    vx: new Float32Array(count),
    vy: new Float32Array(count),
    vz: new Float32Array(count),
    startSize: new Float32Array(count),
    count,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rnd(min, max) { return min + Math.random() * (max - min); }

function setColor(colors, i, r, g, b) {
  const idx = i * 3;
  colors[idx]   = r;
  colors[idx+1] = g;
  colors[idx+2] = b;
}

function _normalizeInto(dx, dy, dz, spd, out) {
  const len = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
  const inv = spd / len;
  out[0] = dx * inv;
  out[1] = dy * inv;
  out[2] = dz * inv;
}

const _dir = new Float32Array(3);

// ── Spawners ──────────────────────────────────────────────────────────────────

function spawnFire(i, pos, L, delay = 0) {
  const theta = Math.random() * Math.PI * 2;
  const phi   = Math.acos(2 * Math.random() - 1);
  const r     = Math.random() * 0.4;
  const i3    = i * 3;
  L.positions[i3]   = pos.x + r * Math.sin(phi) * Math.cos(theta);
  L.positions[i3+1] = pos.y + r * Math.cos(phi) * 0.5;
  L.positions[i3+2] = pos.z + r * Math.sin(phi) * Math.sin(theta);

  const spd = rnd(1.5, 3);
  _normalizeInto(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5, spd, _dir);
  L.vx[i] = _dir[0];
  L.vy[i] = _dir[1] + Math.abs(_dir[1]);
  L.vz[i] = _dir[2];

  L.ages[i]      = -delay;
  L.lifetimes[i] = rnd(0.4, 0.67);
  L.startSize[i] = rnd(2, 8);
  L.sizes[i]     = 0;
  L.opacities[i] = rnd(0.287, 0.442);
  L.rotations[i] = rnd(-Math.PI, Math.PI);
  L.frames[i]    = 0;

  const t = Math.random();
  setColor(L.colors, i,
    0.91 + t * 0.09,
    0.29 + t * 0.68,
    0.29 - t * 0.25);
}

function spawnSmoke(i, pos, L, delay = 0) {
  const theta = Math.random() * Math.PI * 2;
  const r     = Math.random() * 1.2;
  const i3    = i * 3;
  L.positions[i3]   = pos.x + r * Math.cos(theta);
  L.positions[i3+1] = pos.y + (Math.random()-0.5) * 0.4;
  L.positions[i3+2] = pos.z + r * Math.sin(theta);

  const spd = rnd(0, 2.2);
  L.vx[i] = (Math.random()-0.5) * spd;
  L.vy[i] = Math.random() * spd * 0.5 + 0.3;
  L.vz[i] = (Math.random()-0.5) * spd;

  L.ages[i]      = -delay;
  L.lifetimes[i] = rnd(0.67, 4);
  L.startSize[i] = rnd(25, 50);
  L.sizes[i]     = 0;
  L.opacities[i] = 0;
  L.rotations[i] = rnd(-Math.PI, Math.PI);
  L.frames[i]    = 0;

  const g = rnd(0.05, 0.14);
  setColor(L.colors, i, g * 0.9, g * 0.85, g * 0.8);
}

// ── Plane damage effects — flame licks (replacing the old white-smoke
// variant) paired with a black smoke puff, reusing the same spawn shape
// as spawnSmoke() but with plane-appropriate lifetime (short, snappy
// puffs rather than lingering).


function spawnPlaneSmokeBlack(i, pos, L, delay = 0) {
  const theta = Math.random() * Math.PI * 2;
  const r     = Math.random() * 0.5;
  const i3    = i * 3;
  L.positions[i3]   = pos.x + r * Math.cos(theta);
  L.positions[i3+1] = pos.y + (Math.random()-0.5) * 0.2;
  L.positions[i3+2] = pos.z + r * Math.sin(theta);

  const spd = rnd(0.3, 1.2);
  L.vx[i] = (Math.random()-0.5) * spd;
  L.vy[i] = Math.random() * spd * 0.5 + 0.4;
  L.vz[i] = (Math.random()-0.5) * spd;

  L.ages[i]      = -delay;
  L.lifetimes[i] = rnd(1.2, 1.5);
  L.startSize[i] = rnd(4.5, 4.8);
  L.sizes[i]     = 0;
  L.opacities[i] = 0;
  L.rotations[i] = rnd(-Math.PI, Math.PI);
  L.frames[i]    = 0;

  const g = rnd(0.45, 0.65);   // near-black
  setColor(L.colors, i, g, g, g);
}

// ── Aerodynamic condensation (vapor) puffs — emitted from Low_Pressure_N
// nodes during hard-G maneuvers. Reuses the smoke layer/pool (no new
// geometry/material): small, fast-fading, bright-white wisps that snap
// in and vanish, rather than lingering like normal smoke.
function spawnCondensation(i, pos, L, dirX, dirY, dirZ, delay = 0) {
  const i3 = i * 3;
  L.positions[i3]   = pos.x + (Math.random() - 0.5) * 0.15;
  L.positions[i3+1] = pos.y + (Math.random() - 0.5) * 0.15;
  L.positions[i3+2] = pos.z + (Math.random() - 0.5) * 0.15;

  const spd = rnd(0.8, 2.2);
  L.vx[i] = dirX * spd + (Math.random() - 0.5) * 0.3;
  L.vy[i] = dirY * spd + (Math.random() - 0.5) * 0.3;
  L.vz[i] = dirZ * spd + (Math.random() - 0.5) * 0.3;

  L.ages[i]      = -delay;
  L.lifetimes[i] = rnd(0.18, 0.32); // snap-vanish, not a lingering trail
  L.startSize[i] = rnd(7.5, 10.0);
  L.sizes[i]     = 0;
  L.opacities[i] = rnd(0.55, 0.85);
  L.rotations[i] = rnd(-Math.PI, Math.PI);
  L.frames[i]    = 0;

  // Near-white with a faint blue tint — condensation, not smoke
  const g = 1.0;
  setColor(L.colors, i, g, g, g);
}

function spawnEmissive(i, pos, L, delay = 0) {
  const theta = Math.random() * Math.PI * 2;
  const phi   = Math.acos(2 * Math.random() - 1);
  const r     = Math.random() * 1.5;
  const i3    = i * 3;
  L.positions[i3]   = pos.x + r * Math.sin(phi) * Math.cos(theta);
  L.positions[i3+1] = pos.y + r * Math.cos(phi) * 0.6;
  L.positions[i3+2] = pos.z + r * Math.sin(phi) * Math.sin(theta);

  const spd = rnd(2.5, 7.0);
  _normalizeInto(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5, spd, _dir);
  L.vx[i] = _dir[0];
  L.vy[i] = Math.abs(_dir[1]) * 0.6 + rnd(0.5, 2.0);
  L.vz[i] = _dir[2];

  L.ages[i]      = -delay;
  L.lifetimes[i] = rnd(0.5, 1.1);
  L.startSize[i] = rnd(1.2, 3.5);
  L.sizes[i]     = 0;
  L.opacities[i] = rnd(0.7, 1.0);
  L.rotations[i] = rnd(-Math.PI, Math.PI);
  L.frames[i]    = 0;

  const t = Math.random();
  let cr, cg, cb;
  if (t < 0.5) {
    const u = t * 2;
    cr = 1.0; cg = 0.25 + u * 0.50; cb = u * 0.05;
  } else {
    const u = (t - 0.5) * 2;
    cr = 1.0; cg = 0.75 + u * 0.25; cb = 0.05 + u * 0.80;
  }
  setColor(L.colors, i, cr, cg, cb);
}

function spawnWideSmoke(i, pos, L, delay = 0) {
  const theta = Math.random() * Math.PI * 2;
  const r     = rnd(5.0, 13.0);
  const i3    = i * 3;
  L.positions[i3]   = pos.x + r * Math.cos(theta);
  L.positions[i3+1] = pos.y + rnd(0.0, 1.2);
  L.positions[i3+2] = pos.z + r * Math.sin(theta);

  const outX   = L.positions[i3]   - pos.x;
  const outZ   = L.positions[i3+2] - pos.z;
  const invLen = 1.0 / (Math.sqrt(outX*outX + outZ*outZ) || 1);
  const outSpd = rnd(0.4, 1.4);
  L.vx[i] = outX * invLen * outSpd;
  L.vy[i] = rnd(0.3, 0.9);
  L.vz[i] = outZ * invLen * outSpd;

  L.ages[i]      = -delay;
  L.lifetimes[i] = rnd(3.0, 6.0);
  L.startSize[i] = rnd(35, 65);
  L.sizes[i]     = 0;
  L.opacities[i] = 0;
  L.rotations[i] = rnd(-Math.PI, Math.PI);
  L.frames[i]    = 0;

  const g = rnd(0.18, 0.38);
  setColor(L.colors, i, g * 0.9, g * 0.85, g * 0.8);
}

function spawnRock(i, pos, L) {
  const theta = Math.random() * Math.PI * 2;
  const cone  = rnd(0, 100 * Math.PI / 180);
  const r     = Math.random() * 10.0;
  const i3    = i * 3;
  L.positions[i3]   = pos.x + r * Math.cos(theta);
  L.positions[i3+1] = pos.y;
  L.positions[i3+2] = pos.z + r * Math.sin(theta);

  const spd = rnd(15, 25);
  const ux   = Math.cos(theta) * Math.sin(cone);
  const uy   = Math.cos(cone);
  const uz   = Math.sin(theta) * Math.sin(cone);
  L.vx[i] = ux * spd;
  L.vy[i] = uy * spd;
  L.vz[i] = uz * spd;

  L.ages[i]      = 0;
  L.lifetimes[i] = rnd(1.5, 2.5);
  L.startSize[i] = rnd(0.2, 0.6);
  L.sizes[i]     = 0;
  L.opacities[i] = rnd(0.8, 1.0);
  L.rotations[i] = rnd(-Math.PI, Math.PI);
  L.frames[i]    = Math.floor(rnd(0, 10));  // random tile from sprite sheet

  const t = Math.random();
  let cr, cg, cb;
  if (t < 0.5) {
    const u = t * 2;
    cr = 1.0; cg = 0.25 + u * 0.50; cb = u * 0.05;
  } else {
    const u = (t - 0.5) * 2;
    cr = 1.0; cg = 0.75 + u * 0.25; cb = 0.05 + u * 0.80;
  }
  setColor(L.colors, i, cr, cg, cb);
}

function spawnRockTrailPuff(i, px, py, pz, L) {
  const i3 = i * 3;
  L.positions[i3]   = px + (Math.random() - 0.5) * 0.08;
  L.positions[i3+1] = py + (Math.random() - 0.5) * 0.08;
  L.positions[i3+2] = pz + (Math.random() - 0.5) * 0.08;

  const spd = rnd(25, 50);
  L.vx[i] = (Math.random() - 0.5) * 0.15;
  L.vy[i] = rnd(0.05, 0.2);
  L.vz[i] = (Math.random() - 0.5) * 0.15;

  L.ages[i]      = 0;
L.lifetimes[i] = rnd(0.6, 1.0);
L.startSize[i] = rnd(0.5, 2.5);
  L.sizes[i]     = 0;
  L.opacities[i] = 0;
  L.rotations[i] = rnd(-Math.PI, Math.PI);
  L.frames[i]    = 0;

  // Very dark — near black smoke
  const g = rnd(0.05, 0.14);
  setColor(L.colors, i, g * 0.9, g * 0.85, g * 0.8);
}

// ── Ejected bullet shell casing — ballistic arc + tumble, brass-colored ────
const SHELL_BACK_OFFSET = 1.85; // world-units — how far behind the muzzle the casing spawns

function spawnBulletShell(i, pos, dirX, dirZ, L) {
  const i3 = i * 3;
  L.positions[i3]   = pos.x - dirX * SHELL_BACK_OFFSET;
  L.positions[i3+1] = pos.y;
  L.positions[i3+2] = pos.z - dirZ * SHELL_BACK_OFFSET;

  // Eject sideways relative to the gun's horizontal facing direction —
  // classic ejected-casing kick, not a straight-back toss.
  const sideX = -dirZ, sideZ = dirX;   // perpendicular to fire direction
  const side  = Math.random() < 0.5 ? 1 : -1;
  const spd   = rnd(1.5, 3.0);

  L.vx[i] = sideX * spd * side + (Math.random() - 0.5) * 0.5;
  L.vy[i] = rnd(1.5, 3.0);
  L.vz[i] = sideZ * spd * side + (Math.random() - 0.5) * 0.5;

  L.ages[i]      = 0;
  L.lifetimes[i] = rnd(1.4, 2.0);
  L.startSize[i] = rnd(0.36, 0.48);
  L.sizes[i]     = 0;
  L.opacities[i] = 1.0;
  L.rotations[i] = rnd(-Math.PI, Math.PI);
  L.frames[i]    = 0;

  // Brass/gold tint
  setColor(L.colors, i, 1.0, 0.85, 0.5);
}

// ── Tick ──────────────────────────────────────────────────────────────────────

function tick(L, dt, gravity, drag, rotSpd, sizeFn, opacityFn) {
  const count     = L.count;
  const positions = L.positions;
  const ages      = L.ages;
  const lifetimes = L.lifetimes;
  const sizes     = L.sizes;
  const opacities = L.opacities;
  const rotations = L.rotations;
  const vx = L.vx, vy = L.vy, vz = L.vz;
  const startSize = L.startSize;

  // ── Skip entire layer if no particles are alive ───────────────────────
  let anyAlive = false;
  for (let i = 0; i < count; i++) {
    if (ages[i] < lifetimes[i]) { anyAlive = true; break; }
  }
  if (!anyAlive) return;

  let anyUpdated = false;
  for (let i = 0; i < count; i++) {
    const age = ages[i];
    if (age >= lifetimes[i]) {
      continue;   // ← skip instead of zeroing — already invisible
    }

    const newAge = age + dt;
    ages[i] = newAge;

    if (newAge < 0) continue;   // still in delay — no visual update needed

    anyUpdated = true;
    const t  = newAge / lifetimes[i];
    const i3 = i * 3;

    positions[i3]   += vx[i] * dt;
    positions[i3+1] += vy[i] * dt;
    positions[i3+2] += vz[i] * dt;

    vy[i] += gravity * dt;
    vx[i] *= drag;
    vz[i] *= drag;

    rotations[i] += dt * rotSpd * (i & 1 ? -1 : 1);
    sizes[i]      = startSize[i] * sizeFn(t);
    opacities[i]  = opacityFn(t);
  }

  if (anyUpdated) {
    const attr = L.geo.attributes;
    attr.position.needsUpdate = true;
    attr.size.needsUpdate     = true;
    attr.opacity.needsUpdate  = true;
    attr.rotation.needsUpdate = true;
    attr.color.needsUpdate    = true;
  }
}

// ── Size / opacity curves ─────────────────────────────────────────────────────

const sizeBell      = (t) => Math.sin(t * Math.PI);
const opacityLinear = (t) => 1 - t;
const opacityDense  = (t) => {
  let o;
  if (t < 0.10) o = t / 0.10;
  else          o = 1.0 - ((t - 0.10) / 0.90);
  return o * 1.5;
};

// Shells: stay full-size and opaque for most of their life (they're a
// solid physical object, not a puff), then fade quickly right at the end.
const sizeConstant   = () => 1.0;
const opacityShellFade = (t) => (t < 0.75 ? 1.0 : Math.max(0, 1.0 - (t - 0.75) / 0.25));

// ── Pool ──────────────────────────────────────────────────────────────────────

function makePool(n) {
  return { free: Array.from({ length: n }, (_, i) => i) };
}

function grab(pool, n) {
  const count = Math.min(n, pool.free.length);
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push(pool.free.pop());  // pop from end — no shifting
  }
  return result;
}

function release(pool, L, ids) {
  for (let i = 0; i < ids.length; i++) {
    pool.free.push(ids[i]);
    L.ages[ids[i]] = 9999;
  }
}

// ── Active entry pool — avoids {} allocation on every spawn ──────────────────

const _entryPool = [];

function _getEntry() {
  const e = _entryPool.pop();
  if (e) {
    e.fIds.length = 0; e.flIds.length = 0; e.sIds.length = 0;
    e.eIds.length = 0; e.wIds.length  = 0; e.rIds.length = 0;
    e.shIds.length = 0;
    e.elapsed = 0;     e.maxLife = 0;
    e.gunNode = null;
    if (e.gunSIds) e.gunSIds.length = 0; else e.gunSIds = [];
    return e;
  }
  return {
    fIds: [], flIds: [], sIds: [], eIds: [], wIds: [], rIds: [], shIds: [],
    elapsed: 0, maxLife: 0,
    gunNode: null, gunSIds: [],
  };
}

function _recycleEntry(e) {
  _entryPool.push(e);
}

// ── House chimney/vent smoke ──────────────────────────────────────────────
// Continuously loops black smoke puffs upward from a fixed set of world
// positions (one emitter per SmokePoint_N node found in a loaded house GLB).
export class HouseSmokeSystem {
  constructor(scene, positions, opts = {}) {
    this.scene = scene;
    this.emitterPositions = positions; // array of THREE.Vector3
    this.maxParticlesPerEmitter = opts.maxParticlesPerEmitter ?? 10;
    this.spawnInterval = opts.spawnInterval ?? 0.35; // seconds between spawns, per emitter
    this.riseSpeed = opts.riseSpeed ?? 1.2; // world units/sec
    this.lifetime = opts.lifetime ?? 4.5; // seconds
    this.startSize = opts.startSize ?? 1.5;
    this.endSize = opts.endSize ?? 6.0;
    this.drift = opts.drift ?? 0.4; // horizontal random drift speed

    this._maxParticles = this.emitterPositions.length * this.maxParticlesPerEmitter;
    if (this._maxParticles === 0) {
      this.points = null;
      return;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this._maxParticles * 3), 3));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(this._maxParticles), 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(this._maxParticles), 1));
    geo.setAttribute("aRot", new THREE.BufferAttribute(new Float32Array(this._maxParticles), 1));

    const smokeTex = new THREE.TextureLoader().load(
      "https://mrdoob.com/lab/javascript/webgl/clouds/cloud10.png",
    );

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: smokeTex },
        uColor: { value: new THREE.Color(0x7d7d7d) }, // near-black smoke
        pixelScale: { value: 300.0 },
      },
      vertexShader: `
        attribute float aAlpha;
        attribute float aSize;
        attribute float aRot;
        uniform float pixelScale;
        varying float vAlpha;
        varying float vRot;
        void main() {
          vAlpha = aAlpha;
          vRot = aRot;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (pixelScale / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform vec3 uColor;
        varying float vAlpha;
        varying float vRot;
        void main() {
          vec2 centered = gl_PointCoord - 0.5;
          float c = cos(vRot), s = sin(vRot);
          vec2 rotated = vec2(centered.x * c - centered.y * s, centered.x * s + centered.y * c) + 0.5;
          vec4 tex = texture2D(map, rotated);
          float a = tex.a * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);

    this._posAttr = geo.attributes.position;
    this._alphaAttr = geo.attributes.aAlpha;
    this._sizeAttr = geo.attributes.aSize;
    this._rotAttr = geo.attributes.aRot;

    this._particles = [];
    for (let i = 0; i < this._maxParticles; i++) {
      this._particles.push({ active: false, age: 0, life: 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, rot: 0, rotSpeed: 0 });
    }

    this._spawnTimers = this.emitterPositions.map(() => Math.random() * this.spawnInterval);
  }

  _spawnParticle(emitterIdx) {
    const base = emitterIdx * this.maxParticlesPerEmitter;
    for (let i = 0; i < this.maxParticlesPerEmitter; i++) {
      const p = this._particles[base + i];
      if (p.active) continue;
      const origin = this.emitterPositions[emitterIdx];
      p.active = true;
      p.age = 0;
      p.life = this.lifetime * (0.8 + Math.random() * 0.4);
      p.x = origin.x;
      p.y = origin.y;
      p.z = origin.z;
      p.vx = (Math.random() - 0.5) * this.drift;
      p.vz = (Math.random() - 0.5) * this.drift;
      p.rot = Math.random() * Math.PI * 2;
      p.rotSpeed = (Math.random() - 0.5) * 0.5;
      return;
    }
  }

  update(dt, camera, renderer) {
    if (!this.points) return;

    // ── Keep point-sprite size correct as camera FOV changes (scope zoom) —
    // same fix already applied to ExplosionSystem's layers. Without this,
    // gl_PointSize's distance-based falloff is computed against a FOV baked
    // in at construction time, so smoke shrinks/grows incorrectly whenever
    // the camera's actual FOV changes (e.g. scoping in/out).
    if (camera && renderer) {
      const pixelScale =
        renderer.domElement.clientHeight /
        (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      this.points.material.uniforms.pixelScale.value = pixelScale;
    }

    for (let e = 0; e < this.emitterPositions.length; e++) {
      this._spawnTimers[e] -= dt;
      if (this._spawnTimers[e] <= 0) {
        this._spawnTimers[e] = this.spawnInterval * (0.7 + Math.random() * 0.6);
        this._spawnParticle(e);
      }
    }

    for (let i = 0; i < this._particles.length; i++) {
      const p = this._particles[i];
      if (!p.active) {
        this._alphaAttr.array[i] = 0;
        continue;
      }
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        this._alphaAttr.array[i] = 0;
        continue;
      }
      const t = p.age / p.life;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.y += this.riseSpeed * dt * (0.6 + t * 0.6);
      p.rot += p.rotSpeed * dt;

      const fadeIn = Math.min(1, t / 0.15);
      const fadeOut = 1 - Math.max(0, (t - 0.6) / 0.4);
      const alpha = Math.max(0, Math.min(fadeIn, fadeOut)) * 0.55;
      const size = THREE.MathUtils.lerp(this.startSize, this.endSize, t);

      this._posAttr.array[i * 3] = p.x;
      this._posAttr.array[i * 3 + 1] = p.y;
      this._posAttr.array[i * 3 + 2] = p.z;
      this._alphaAttr.array[i] = alpha;
      this._sizeAttr.array[i] = size;
      this._rotAttr.array[i] = p.rot;
    }

    this._posAttr.needsUpdate = true;
    this._alphaAttr.needsUpdate = true;
    this._sizeAttr.needsUpdate = true;
    this._rotAttr.needsUpdate = true;
  }

  /** Fast-forwards the simulation by `duration` seconds using fixed steps,
   * so the smoke column is already fully populated (puffs at every stage
   * of their life, already risen partway up) on the very first real
   * render — instead of visibly starting from nothing and building up
   * over `lifetime` seconds. Call once, right after construction. */
  _prime(duration, step = 0.1) {
    if (!this.points) return;
    let t = 0;
    while (t < duration) {
      this.update(step);
      t += step;
    }
  }

  dispose() {
    if (!this.points) return;
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.map?.dispose();
    this.points.material.dispose();
    this.points = null;
  }
}

// ── Public ────────────────────────────────────────────────────────────────────

export class ExplosionSystem {
  constructor(scene) {
    this.scene   = scene;
    this._active = [];
    // key (tank object) → { getPosition, fireTimer, smokeTimer }
    this._damageFires = new Map();
    // key (plane object) → { getPosition, whiteTimer, blackTimer }
    this._planeDamageSmoke = new Map();

    const FC = 60;
    const SC = 160;
    const EC = 80;
    const WC = 100;
    const RC = 72;   // rocks
    const RSC = 160;  // rock smoke trails (more — one trail per rock tick)
    const SHC = 40;   // ejected bullet shells

    this._fireL  = makeLayer(scene, FC,  textures.flame,  THREE.AdditiveBlending, 8);
    this._flareL = makeLayer(scene, FC,  textures.flare,  THREE.AdditiveBlending, 8);
    this._smokeL = makeLayer(scene, SC,  textures.cloud,  THREE.NormalBlending,   7);
    this._emitL  = makeLayer(scene, EC,  textures.flare,  THREE.AdditiveBlending, 8);
    this._wsmkL  = makeLayer(scene, WC,  textures.cloud,  THREE.NormalBlending,   7);
    this._rockL  = makeLayer(scene, RC,  textures.rocks,  THREE.NormalBlending,   7);
    this._rsmkL  = makeLayer(scene, RSC, textures.cloud,  THREE.NormalBlending,   7);
    this._shellL = makeLayer(scene, SHC, textures.shells, THREE.NormalBlending,   7);

    // rocks sprite sheet is 5×2
this._rockL.mat.uniforms.cols.value = 5;
this._rockL.mat.uniforms.rows.value = 2;
    this._fPool  = makePool(FC);
    this._flPool = makePool(FC);
    this._sPool  = makePool(SC);
    this._ePool  = makePool(EC);
    this._wPool  = makePool(WC);
    this._rPool  = makePool(RC);
    this._rsPool = makePool(RSC);
    this._shPool = makePool(SHC);

    // track live rocks so we can emit trail smoke each tick
    this._liveRocks = [];  // { idx, trailTimer }
  }

  // ── Full tank-death explosion ─────────────────────────────────────────────

spawn(position) {
  const fIds = grab(this._fPool, 4);
  const sIds = grab(this._sPool, 2);
  const eIds = grab(this._ePool, 0);
  const wIds = grab(this._wPool, 1);
  const rIds = grab(this._rPool, 8);

  for (let k = 0; k < fIds.length; k++) spawnFire(fIds[k],      position, this._fireL);
  for (let k = 0; k < eIds.length; k++) spawnEmissive(eIds[k],  position, this._emitL, Math.random() * 0.05);
  for (let k = 0; k < sIds.length; k++) spawnSmoke(sIds[k],     position, this._smokeL, 0.2 + Math.random() * 0.1);
  for (let k = 0; k < wIds.length; k++) spawnWideSmoke(wIds[k], position, this._wsmkL,  0.35 + Math.random() * 0.2);
  for (let k = 0; k < rIds.length; k++) {
    spawnRock(rIds[k], position, this._rockL);
    this._liveRocks.push({ idx: rIds[k], trailTimer: 0 });
  }

  const entry = _getEntry();
  entry.fIds  = fIds; entry.sIds = sIds;
  entry.eIds  = eIds; entry.wIds = wIds;
  entry.rIds  = rIds;
  entry.elapsed = 0;  entry.maxLife = 6.6;
  this._active.push(entry);
}

  // ── Muzzle flash (main gun) ───────────────────────────────────────────────

  spawnMuzzleFlash(position) {
    const fIds = grab(this._fPool, 6);
    const L    = this._fireL;

    for (let k = 0; k < fIds.length; k++) {
      const i     = fIds[k];
      const theta = Math.random() * Math.PI * 2;
      const r     = Math.random() * 0.15;
      const i3    = i * 3;
      L.positions[i3]   = position.x + r * Math.cos(theta);
      L.positions[i3+1] = position.y + r * Math.sin(theta);
      L.positions[i3+2] = position.z + r * Math.sin(theta);

      const spd = rnd(0.5, 1.5);
      _normalizeInto(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5, spd, _dir);
      L.vx[i] = _dir[0]; L.vy[i] = _dir[1]; L.vz[i] = _dir[2];

      L.ages[i]      = 0;
      L.lifetimes[i] = rnd(0.06, 0.12);
      L.startSize[i] = rnd(1.5, 3.5);
      L.sizes[i]     = 0;
      L.opacities[i] = rnd(0.7, 1.0);
      L.rotations[i] = rnd(-Math.PI, Math.PI);
      L.frames[i]    = 0;

      const t = Math.random();
      setColor(L.colors, i, 1.0, 0.9 + t * 0.1, 0.3 + t * 0.65);
    }

    const entry = _getEntry();
    entry.fIds  = fIds; entry.elapsed = 0; entry.maxLife = 0.15;
    this._active.push(entry);
  }

  // ── Gun barrel smoke — lingers after main cannon fire ─────────────────────

spawnGunSmoke(gunPointNode) {
  const sIds = grab(this._sPool, 8);
  const SL   = this._smokeL;

  // Store node reference + per-particle delay so update() can
  // sample the live world position when each particle's delay expires
  const _wp = new THREE.Vector3();
    const _dir = new THREE.Vector3();
  gunPointNode.getWorldDirection(_dir);

  for (let k = 0; k < sIds.length; k++) {
    const i     = sIds[k];
    const delay = k * 0.12;   // stagger

    // Park at origin — update() will place them correctly when delay expires
    const i3 = i * 3;
    SL.positions[i3]   = 0;
    SL.positions[i3+1] = -9999;  // hide below ground until delay expires
    SL.positions[i3+2] = 0;

    const spd    = 0.5 + Math.random() * 0.5;
    const spread = 0.15;  // ← controls cone width, increase for wider angle

    SL.vx[i] = _dir.x * spd + (Math.random() - 0.5) * spread;
    SL.vy[i] = _dir.y * spd + (Math.random() - 0.5) * spread;
    SL.vz[i] = _dir.z * spd + (Math.random() - 0.5) * spread;

    SL.ages[i]      = -delay;
    SL.lifetimes[i] = rnd(1.2, 1.8);
    SL.startSize[i] = rnd(1.2, 2.0);
    SL.sizes[i]     = 0;
    SL.opacities[i] = 0;
    SL.rotations[i] = rnd(-Math.PI, Math.PI);
    SL.frames[i]    = 0;

    const g = 1.0;
    setColor(SL.colors, i, g, g, g);
  }

  const entry = _getEntry();
  entry.sIds      = sIds;
  entry.elapsed   = 0;
  entry.maxLife   = 5.0;
  entry.gunNode   = gunPointNode;   // ← live THREE.Object3D reference
  entry.gunSIds   = sIds.slice();   // ← which particles still need positioning
  this._active.push(entry);
}

  // ── Muzzle flash (machine gun) ────────────────────────────────────────────

  spawnMGMuzzleFlash(position) {
    const fIds = grab(this._fPool, 3);
    const L    = this._fireL;

    for (let k = 0; k < fIds.length; k++) {
      const i     = fIds[k];
      const theta = Math.random() * Math.PI * 2;
      const r     = Math.random() * 0.15;
      const i3    = i * 3;
      L.positions[i3]   = position.x + r * Math.cos(theta);
      L.positions[i3+1] = position.y + r * Math.sin(theta);
      L.positions[i3+2] = position.z + r * Math.sin(theta);

      const spd = rnd(0.5, 1.5);
      _normalizeInto(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5, spd, _dir);
      L.vx[i] = _dir[0]; L.vy[i] = _dir[1]; L.vz[i] = _dir[2];

      L.ages[i]      = 0;
      L.lifetimes[i] = rnd(0.06, 0.12);
      L.startSize[i] = rnd(0.3, 0.8);
      L.sizes[i]     = 0;
      L.opacities[i] = rnd(0.7, 1.0);
      L.rotations[i] = rnd(-Math.PI, Math.PI);
      L.frames[i]    = 0;

      const t = Math.random();
      setColor(L.colors, i, 1.0, 0.9 + t * 0.1, 0.3 + t * 0.65);
    }

    const entry = _getEntry();
    entry.fIds  = fIds; entry.elapsed = 0; entry.maxLife = 0.15;
    this._active.push(entry);
  }

    // ── Muzzle smoke (multi-gun) — single lightweight smoke particle ─────────

  spawnMultiGunSmoke(position) {
    const sIds = grab(this._sPool, 1);
    if (!sIds.length) return;
    const SL = this._smokeL;

    for (let k = 0; k < sIds.length; k++) {
      const i     = sIds[k];
      const theta = Math.random() * Math.PI * 2;
      const r     = Math.random() * 0.1;
      const i3    = i * 3;
      SL.positions[i3]   = position.x + r * Math.cos(theta);
      SL.positions[i3+1] = position.y + (Math.random() - 0.5) * 0.1;
      SL.positions[i3+2] = position.z + r * Math.sin(theta);

      const spd = rnd(0.3, 0.7);
      SL.vx[i] = (Math.random() - 0.5) * spd;
      SL.vy[i] = Math.random() * spd * 0.5 + 0.2;
      SL.vz[i] = (Math.random() - 0.5) * spd;

      SL.ages[i]      = 0;
      SL.lifetimes[i] = rnd(0.35, 0.55);
      SL.startSize[i] = rnd(1.5, 4.5);
      SL.sizes[i]     = 0;
      SL.opacities[i] = 0;
      SL.rotations[i] = rnd(-Math.PI, Math.PI);
      SL.frames[i]    = 0;

      const g = rnd(0.5, 0.7);
      setColor(SL.colors, i, g, g, g);
    }

    const entry = _getEntry();
    entry.sIds    = sIds;
    entry.elapsed = 0;
    entry.maxLife = 0.55;
    this._active.push(entry);
  }

    // ── Ejected bullet shell casings — physical brass casings kicked out
  // sideways from the gun, with gravity + tumble. ─────────────────────────

  spawnBulletShells(position, direction, count = 1) {
    const shIds = grab(this._shPool, count);
    if (!shIds.length) return;
    const L = this._shellL;

    for (let k = 0; k < shIds.length; k++) {
      spawnBulletShell(shIds[k], position, direction.x, direction.z, L);
    }

    const entry = _getEntry();
    entry.shIds   = shIds;
    entry.elapsed = 0;
    entry.maxLife = 2.0; // matches the upper bound of lifetimes[] set in spawnBulletShell
    this._active.push(entry);
  }

  // ── MG bullet hit spark ───────────────────────────────────────────────────

  spawnSpark(position) {
    const flIds = grab(this._flPool, 2);
    const sIds  = grab(this._sPool,  1);
    const FL    = this._flareL;
    const SL    = this._smokeL;

    for (let k = 0; k < flIds.length; k++) {
      const i     = flIds[k];
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = Math.random() * 0.1;
      const i3    = i * 3;
      FL.positions[i3]   = position.x + r * Math.sin(phi) * Math.cos(theta);
      FL.positions[i3+1] = position.y + r * Math.cos(phi);
      FL.positions[i3+2] = position.z + r * Math.sin(phi) * Math.sin(theta);

      const spd = rnd(3.0, 6.0);
      _normalizeInto(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5, spd, _dir);
      FL.vx[i] = _dir[0]; FL.vy[i] = _dir[1]; FL.vz[i] = _dir[2];

      FL.ages[i]      = 0;
      FL.lifetimes[i] = rnd(0.15, 0.25);
      FL.startSize[i] = rnd(0.5, 3.0);
      FL.sizes[i]     = 0;
      FL.opacities[i] = rnd(0.8, 1.0);
      FL.rotations[i] = rnd(-Math.PI, Math.PI);
      FL.frames[i]    = 0;

      const t = Math.random();
      setColor(FL.colors, i, 1.0, 1.0 - t * 0.05, 0.6 - t * 0.30);
    }

    for (let k = 0; k < sIds.length; k++) {
      const i     = sIds[k];
      const theta = Math.random() * Math.PI * 2;
      const r     = Math.random() * 0.08;
      const i3    = i * 3;
      SL.positions[i3]   = position.x + r * Math.cos(theta);
      SL.positions[i3+1] = position.y + (Math.random() - 0.5) * 0.08;
      SL.positions[i3+2] = position.z + r * Math.sin(theta);

      const spd = rnd(0.3, 0.8);
      SL.vx[i] = (Math.random() - 0.5) * spd;
      SL.vy[i] = Math.random() * spd * 0.6 + 0.2;
      SL.vz[i] = (Math.random() - 0.5) * spd;

      SL.ages[i]      = 0;
      SL.lifetimes[i] = rnd(0.25, 0.45);
      SL.startSize[i] = rnd(1.5, 3.0);
      SL.sizes[i]     = 0;
      SL.opacities[i] = 0;
      SL.rotations[i] = rnd(-Math.PI, Math.PI);
      SL.frames[i]    = 0;

      const g = rnd(0.55, 0.75);
      setColor(SL.colors, i, g, g, g);
    }

    const entry = _getEntry();
    entry.flIds = flIds; entry.sIds = sIds;
    entry.elapsed = 0;   entry.maxLife = 0.45;
    this._active.push(entry);
  }

  // ── Smoke grenade cloud — dense long-lasting smoke ────────────────────────

  spawnSmokeCloud(position) {
    const sIds = grab(this._sPool, 1);   // was 5
    const wIds = grab(this._wPool, 1);   // was 4

    for (let k = 0; k < sIds.length; k++) {
      const i     = sIds[k];
      const theta = Math.random() * Math.PI * 2;
      const r     = rnd(0.2, 1.5);
      const i3    = i * 3;
      this._smokeL.positions[i3]   = position.x + r * Math.cos(theta);
      this._smokeL.positions[i3+1] = position.y + rnd(0.5, 1.5);
      this._smokeL.positions[i3+2] = position.z + r * Math.sin(theta);

      this._smokeL.vx[i] = (Math.random() - 0.5) * 0.4;
      this._smokeL.vy[i] = rnd(0.05, 0.15);
      this._smokeL.vz[i] = (Math.random() - 0.5) * 0.4;

      this._smokeL.ages[i]      = 0;
      this._smokeL.lifetimes[i] = rnd(25.0, 30.0);
      this._smokeL.startSize[i] = rnd(30, 55);
      this._smokeL.sizes[i]     = 0;
      this._smokeL.opacities[i] = 0;
      this._smokeL.rotations[i] = rnd(-Math.PI, Math.PI);
      this._smokeL.frames[i]    = 0;

      // Slightly greenish-grey tint — tune these values
      const g = rnd(0.85, 0.95);
      setColor(this._smokeL.colors, i, g, g, g);
    }

    for (let k = 0; k < wIds.length; k++) {
      const i     = wIds[k];
      const theta = Math.random() * Math.PI * 2;
      const r     = rnd(1.0, 3.5);
      const i3    = i * 3;
      this._wsmkL.positions[i3]   = position.x + r * Math.cos(theta);
      this._wsmkL.positions[i3+1] = position.y + rnd(0.8, 2.0);
      this._wsmkL.positions[i3+2] = position.z + r * Math.sin(theta);

      const outX   = this._wsmkL.positions[i3]   - position.x;
      const outZ   = this._wsmkL.positions[i3+2] - position.z;
      const invLen = 1.0 / (Math.sqrt(outX*outX + outZ*outZ) || 1);
      const outSpd = rnd(0.2, 0.6);
      this._wsmkL.vx[i] = outX * invLen * outSpd;
      this._wsmkL.vy[i] = rnd(0.05, 0.12);
      this._wsmkL.vz[i] = outZ * invLen * outSpd;

      this._wsmkL.ages[i]      = 0;
      this._wsmkL.lifetimes[i] = rnd(25.0, 30.0);
      this._wsmkL.startSize[i] = rnd(40, 65);
      this._wsmkL.sizes[i]     = 0;
      this._wsmkL.opacities[i] = 0;
      this._wsmkL.rotations[i] = rnd(-Math.PI, Math.PI);
      this._wsmkL.frames[i]    = 0;

     const g = rnd(0.88, 0.98);
      setColor(this._wsmkL.colors, i, g, g, g);
    }

    const entry = _getEntry();
    entry.sIds = sIds; entry.wIds = wIds;
    entry.elapsed = 0; entry.maxLife = 30.0;
    this._active.push(entry);
  }

  // ── Cannon bullet hit — small smoke puff only ─────────────────────────────

  spawnBulletHit(position) {
    const sIds  = grab(this._sPool,  2);
    const flIds = grab(this._flPool, 2);
    const SL    = this._smokeL;
    const FL    = this._flareL;

    for (let k = 0; k < sIds.length; k++) {
      const i  = sIds[k];
      const i3 = i * 3;
      SL.positions[i3]   = position.x + (Math.random() - 0.5) * 0.2;
      SL.positions[i3+1] = position.y + 0.1;
      SL.positions[i3+2] = position.z + (Math.random() - 0.5) * 0.2;

      SL.vx[i] = (Math.random() - 0.5) * 0.8;
      SL.vy[i] = 0.5 + Math.random() * 1.0;
      SL.vz[i] = (Math.random() - 0.5) * 0.8;

      SL.ages[i]      = 0;
      SL.lifetimes[i] = rnd(0.4, 0.9);
      SL.startSize[i] = rnd(0.1, 1.5);
      SL.sizes[i]     = 0;
      SL.opacities[i] = 0;
      SL.rotations[i] = rnd(-Math.PI, Math.PI);
      SL.frames[i]    = 0;

      const g = rnd(0.45, 0.65);
      setColor(SL.colors, i, g, g, g);
    }

    for (let k = 0; k < flIds.length; k++) {
      const i  = flIds[k];
      const i3 = i * 3;
      FL.positions[i3]   = position.x + (Math.random() - 0.5) * 0.1;
      FL.positions[i3+1] = position.y + 0.1;
      FL.positions[i3+2] = position.z + (Math.random() - 0.5) * 0.1;

      const spd = rnd(1.0, 2.5);
      _normalizeInto(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5, spd, _dir);
      FL.vx[i] = _dir[0]; FL.vy[i] = Math.abs(_dir[1]); FL.vz[i] = _dir[2];

      FL.ages[i]      = 0;
      FL.lifetimes[i] = rnd(0.08, 0.15);
      FL.startSize[i] = rnd(0.4, 1.0);
      FL.sizes[i]     = 0;
      FL.opacities[i] = rnd(0.6, 0.9);
      FL.rotations[i] = rnd(-Math.PI, Math.PI);
      FL.frames[i]    = 0;

      const t = Math.random();
      setColor(FL.colors, i, 1.0, 0.85 + t * 0.1, 0.3 + t * 0.4);
    }

    const entry = _getEntry();
    entry.flIds = flIds; entry.sIds = sIds;
    entry.elapsed = 0;   entry.maxLife = 0.9;
    this._active.push(entry);
  }

  // ── Smoke grenade trail — 2 smoke particles only, no flare ───────────────

  spawnSmokeTrail(position) {
    const sIds = grab(this._sPool, 2);
    const SL   = this._smokeL;

    for (let k = 0; k < sIds.length; k++) {
      const i  = sIds[k];
      const i3 = i * 3;
      SL.positions[i3]   = position.x + (Math.random() - 0.5) * 0.1;
      SL.positions[i3+1] = position.y;
      SL.positions[i3+2] = position.z + (Math.random() - 0.5) * 0.1;

      SL.vx[i] = (Math.random() - 0.5) * 0.2;
      SL.vy[i] = 0.2 + Math.random() * 0.3;
      SL.vz[i] = (Math.random() - 0.5) * 0.2;

      SL.ages[i]      = 0;
      SL.lifetimes[i] = rnd(0.4, 0.7);
      SL.startSize[i] = rnd(1.0, 1.8);
      SL.sizes[i]     = 0;
      SL.opacities[i] = 0;
      SL.rotations[i] = rnd(-Math.PI, Math.PI);
      SL.frames[i]    = 0;

      const g = rnd(0.50, 0.65);
      setColor(SL.colors, i, g, g, g);
    }

    const entry = _getEntry();
    entry.sIds = sIds; entry.elapsed = 0; entry.maxLife = 0.7;
    this._active.push(entry);
  }

  spawnDeathSmoke(position) {
    const sIds  = grab(this._sPool,  1);
    const fIds  = grab(this._fPool,  0);
    const SL    = this._smokeL;
    const FL    = this._fireL;

    for (let k = 0; k < sIds.length; k++) {
      const i  = sIds[k];
      const i3 = i * 3;
      SL.positions[i3]   = position.x + (Math.random() - 0.5) * 0.3;
      SL.positions[i3+1] = position.y;
      SL.positions[i3+2] = position.z + (Math.random() - 0.5) * 0.3;

      SL.vx[i] = (Math.random() - 0.5) * 0.3;
      SL.vy[i] = 1.5 + Math.random() * 1.0;
      SL.vz[i] = (Math.random() - 0.5) * 0.3;

      SL.ages[i]      = 0;
      SL.lifetimes[i] = rnd(1.8, 3.0);
      SL.startSize[i] = rnd(1.5, 10);
      SL.sizes[i]     = 0;
      SL.opacities[i] = 0;
      SL.rotations[i] = rnd(-Math.PI, Math.PI);
      SL.frames[i]    = 0;

      // Very dark gray smoke
      const g = rnd(0.20, 0.45);
      setColor(SL.colors, i, g, g, g);
    }

    for (let k = 0; k < fIds.length; k++) {
      const i  = fIds[k];
      const i3 = i * 3;
      FL.positions[i3]   = position.x + (Math.random() - 0.5) * 0.25;
      FL.positions[i3+1] = position.y - 0.1;
      FL.positions[i3+2] = position.z + (Math.random() - 0.5) * 0.25;

      const spd = rnd(0.4, 1.2);
      _normalizeInto(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5, spd, _dir);
      FL.vx[i] = _dir[0] * 0.3;
      FL.vy[i] = Math.abs(_dir[1]) + rnd(1.5, 3.0);
      FL.vz[i] = _dir[2] * 0.3;

      FL.ages[i]      = 0;
      FL.lifetimes[i] = rnd(0.3, 0.6);
      FL.startSize[i] = rnd(1.5, 4.0);
      FL.sizes[i]     = 0;
      FL.opacities[i] = rnd(0.5, 0.85);
      FL.rotations[i] = rnd(-Math.PI, Math.PI);
      FL.frames[i]    = 0;

      // Deep orange-red fire tones
      const t = Math.random();
      setColor(FL.colors, i,
        0.85 + t * 0.15,
        0.15 + t * 0.25,
        0.0);
    }

    const entry = _getEntry();
    entry.fIds  = fIds;
    entry.sIds  = sIds;
    entry.elapsed = 0;
    entry.maxLife = 3.0;
    this._active.push(entry);
  }

  spawnShellHit(position) {
  const sIds  = grab(this._sPool,  1);
  const flIds = grab(this._flPool, 2);
  const SL    = this._smokeL;
  const FL    = this._flareL;

  for (let k = 0; k < sIds.length; k++) {
    const i  = sIds[k];
    const i3 = i * 3;
    SL.positions[i3]   = position.x + (Math.random() - 0.5) * 0.3;
    SL.positions[i3+1] = position.y + 0.1;
    SL.positions[i3+2] = position.z + (Math.random() - 0.5) * 0.3;

    SL.vx[i] = (Math.random() - 0.5) * 1.2;
    SL.vy[i] = 0.8 + Math.random() * 1.5;
    SL.vz[i] = (Math.random() - 0.5) * 1.2;

    SL.ages[i]      = 0;
    SL.lifetimes[i] = rnd(0.8, 1.6);
    SL.startSize[i] = rnd(12.0, 22.0);
    SL.sizes[i]     = 0;
    SL.opacities[i] = 0;
    SL.rotations[i] = rnd(-Math.PI, Math.PI);
    SL.frames[i]    = 0;

    const g = rnd(0.25, 0.45);
    setColor(SL.colors, i, g * 0.9, g * 0.85, g * 0.8);
  }

  for (let k = 0; k < flIds.length; k++) {
    const i     = flIds[k];
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = Math.random() * 0.15;
    const i3    = i * 3;
    FL.positions[i3]   = position.x + r * Math.sin(phi) * Math.cos(theta);
    FL.positions[i3+1] = position.y + r * Math.cos(phi);
    FL.positions[i3+2] = position.z + r * Math.sin(phi) * Math.sin(theta);

    const spd = rnd(4.0, 9.0);
    _normalizeInto(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5, spd, _dir);
    FL.vx[i] = _dir[0];
    FL.vy[i] = Math.abs(_dir[1]) * 0.8 + rnd(0.5, 1.5);
    FL.vz[i] = _dir[2];

    FL.ages[i]      = 0;
    FL.lifetimes[i] = rnd(0.12, 0.22);
    FL.startSize[i] = rnd(0.6, 1.8);
    FL.sizes[i]     = 0;
    FL.opacities[i] = rnd(0.8, 1.0);
    FL.rotations[i] = rnd(-Math.PI, Math.PI);
    FL.frames[i]    = 0;

    const t = Math.random();
    setColor(FL.colors, i, 1.0, 0.9 + t * 0.1, 0.5 + t * 0.4);
  }

  const entry = _getEntry();
  entry.flIds = flIds; entry.sIds = sIds;
  entry.elapsed = 0;   entry.maxLife = 1.6;
  this._active.push(entry);
}

// ── Persistent low-health fire/smoke ──────────────────────────────────────
  // `key` can be any stable object reference (a tank instance works well).
  // `getPosition` must return {x,y,z} (world space) or null, called each tick.
  startDamageFire(key, getPosition) {
    if (this._damageFires.has(key)) return;
    this._damageFires.set(key, { getPosition, fireTimer: 0, smokeTimer: 0 });
  }

  stopDamageFire(key) {
    this._damageFires.delete(key);
  }

  isDamageFireActive(key) {
    return this._damageFires.has(key);
  }

  // ── Plane-only persistent damage smoke — white + black smoke, no fire.
  // Separate map/methods from startDamageFire so the tank's fire behavior
  // is completely untouched. `getPosition` must return {x,y,z} or null,
  // called each tick — same contract as startDamageFire's callback.
  startPlaneDamageSmoke(key, getPosition) {
    if (this._planeDamageSmoke.has(key)) return;
    this._planeDamageSmoke.set(key, { getPosition, fireTimer: 0, blackTimer: 0 });
  }

  stopPlaneDamageSmoke(key) {
    this._planeDamageSmoke.delete(key);
  }

  isPlaneDamageSmokeActive(key) {
    return this._planeDamageSmoke.has(key);
  }

  _spawnPlaneSmokeWhitePuff(position) {
    const sIds = grab(this._sPool, 4);
    if (!sIds.length) return;
    spawnPlaneSmokeWhite(sIds[0], position, this._smokeL, 0);

    const entry = _getEntry();
    entry.sIds    = sIds;
    entry.elapsed = 0;
    entry.maxLife = this._smokeL.lifetimes[sIds[0]];
    this._active.push(entry);
  }

  _spawnPlaneSmokeBlackPuff(position) {
    const sIds = grab(this._sPool, 4);
    if (!sIds.length) return;
    spawnPlaneSmokeBlack(sIds[0], position, this._smokeL, 0);

    const entry = _getEntry();
    entry.sIds    = sIds;
    entry.elapsed = 0;
    entry.maxLife = this._smokeL.lifetimes[sIds[0]];
    this._active.push(entry);
  }

  _spawnDamageFireLick(position) {
    const fIds = grab(this._fPool, 1);
    if (!fIds.length) return;
    spawnFire(fIds[0], position, this._fireL, 0);
    this._fireL.startSize[fIds[0]] *= 0.2; // smaller than explosion fire

    const entry = _getEntry();
    entry.fIds    = fIds;
    entry.elapsed = 0;
    entry.maxLife = this._fireL.lifetimes[fIds[0]];
    this._active.push(entry);
  }

  _spawnPlaneFireLick(position) {
    const fIds = grab(this._fPool, 1);
    if (!fIds.length) return;
    spawnFire(fIds[0], position, this._fireL, 0);
    this._fireL.startSize[fIds[0]] *= 0.4; // bigger than tank damage fire (0.2)

    const entry = _getEntry();
    entry.fIds    = fIds;
    entry.elapsed = 0;
    entry.maxLife = this._fireL.lifetimes[fIds[0]];
    this._active.push(entry);
  }

  _spawnDamageSmokePuff(position) {
    const sIds = grab(this._sPool, 1);
    if (!sIds.length) return;
    spawnSmoke(sIds[0], position, this._smokeL, 0);
    this._smokeL.startSize[sIds[0]] *= 0.1; // smaller/tighter than normal smoke

    const entry = _getEntry();
    entry.sIds    = sIds;
    entry.elapsed = 0;
    entry.maxLife = this._smokeL.lifetimes[sIds[0]];
    this._active.push(entry);
  }

    // ── Aerodynamic condensation puff — pooled off the existing smoke layer
  // (no new buffers/materials). Call this at a THROTTLED interval from
  // plane.js — never every frame — see Plane._updateAerodynamicCondensation.
  spawnCondensationPuff(position, dir) {
    const sIds = grab(this._sPool, 2);
    if (!sIds.length) return;

    // Track the longest total lifespan (delay + lifetime) across every
    // particle spawned in this puff, not just the last one — otherwise
    // the active-entry sweep in update() releases the pool slots back to
    // _sPool before every particle has actually finished fading, causing
    // a still-visible particle to be yanked/reused mid-animation.
    let longestSpan = 0;
    for (let k = 0; k < sIds.length; k++) {
      const delay = k * 0.02;
      spawnCondensation(sIds[k], position, this._smokeL, dir.x, dir.y, dir.z, delay);
      const span = delay + this._smokeL.lifetimes[sIds[k]];
      if (span > longestSpan) longestSpan = span;
    }

    const entry = _getEntry();
    entry.sIds    = sIds;
    entry.elapsed = 0;
    entry.maxLife = longestSpan;
    this._active.push(entry);
  }

  // ── Update ────────────────────────────────────────────────────────────────

  update(dt, camera, renderer) {
    // console.log('[explosion update]', !!camera, !!renderer, camera?.fov, renderer?.domElement?.clientHeight);
    // ── Must NOT early-return solely on _active being empty — persistent
    // effects (_damageFires, _planeDamageSmoke) can be scheduled even
    // while no one-shot effect is currently playing, especially on a
    // low-traffic ExplosionSystem instance like the plane's own.
    if (this._active.length === 0 && this._damageFires.size === 0 && this._planeDamageSmoke.size === 0) return;

    // ── Keep point-sprite size correct as camera FOV changes (scope zoom) ──
    if (camera && renderer) {
      const pixelScale =
        renderer.domElement.clientHeight /
        (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));

      this._fireL.mat.uniforms.pixelScale.value  = pixelScale;
      this._flareL.mat.uniforms.pixelScale.value = pixelScale;
      this._smokeL.mat.uniforms.pixelScale.value = pixelScale;
      this._emitL.mat.uniforms.pixelScale.value  = pixelScale;
      this._wsmkL.mat.uniforms.pixelScale.value  = pixelScale;
      this._rockL.mat.uniforms.pixelScale.value  = pixelScale;
      this._rsmkL.mat.uniforms.pixelScale.value  = pixelScale;
      this._shellL.mat.uniforms.pixelScale.value = pixelScale;
    }

    // ── For gun-smoke entries: place delayed particles at live GunPoint
// world position the moment their delay expires — not at stale fire pos ──
const _gpWorld = new THREE.Vector3();
for (let i = 0; i < this._active.length; i++) {
  const ex = this._active[i];
  if (!ex.gunNode || !ex.gunSIds.length) continue;

  ex.gunNode.getWorldPosition(_gpWorld);
  const SL = this._smokeL;

  for (let j = ex.gunSIds.length - 1; j >= 0; j--) {
    const idx = ex.gunSIds[j];
    // Once age crosses 0 the particle is "born" — set its spawn position now
    if (SL.ages[idx] >= 0) {
      const i3 = idx * 3;
      SL.positions[i3]   = _gpWorld.x + (Math.random() - 0.5) * 0.05;
      SL.positions[i3+1] = _gpWorld.y + (Math.random() - 0.5) * 0.05;
      SL.positions[i3+2] = _gpWorld.z + (Math.random() - 0.5) * 0.05;
      ex.gunSIds.splice(j, 1);  // no longer needs positioning
    }
  }
}

// ── Persistent low-health fire/smoke — ticks while a tank stays damaged ─
    if (this._damageFires.size > 0) {
      for (const df of this._damageFires.values()) {
        const pos = df.getPosition();
        if (!pos) continue;

        df.fireTimer -= dt;
        if (df.fireTimer <= 0) {
          df.fireTimer = 0.08 + Math.random() * 0.05; // ~12-15 licks/sec
          this._spawnDamageFireLick(pos);
        }

        df.smokeTimer -= dt;
        if (df.smokeTimer <= 0) {
          df.smokeTimer = 0.18 + Math.random() * 0.12;
          this._spawnDamageSmokePuff(pos);
        }
      }
    }

    // ── Plane-only persistent damage smoke (white + black, no fire) ────────
    if (this._planeDamageSmoke.size > 0) {
      for (const ds of this._planeDamageSmoke.values()) {
        const pos = ds.getPosition();
        if (!pos) continue;

        ds.fireTimer -= dt;
        if (ds.fireTimer <= 0) {
          ds.fireTimer = 0.005 + Math.random() * 0.0125; // ~12-15 licks/sec, same cadence as tank damage fire
          this._spawnPlaneFireLick(pos);
        }

        ds.blackTimer -= dt;
        if (ds.blackTimer <= 0) {
          ds.blackTimer = 0.005 + Math.random() * 0.0125;
          this._spawnPlaneSmokeBlackPuff(pos);
        }
      }
    }

tick(this._fireL,  dt, -0.5,  0.92,  2.5,  sizeBell, opacityLinear);
tick(this._flareL, dt, -0.5,  0.92,  2.5,  sizeBell, opacityLinear);
tick(this._smokeL, dt,  0.0,  0.99,  0.4,  sizeBell, opacityDense);
tick(this._emitL,  dt, -1.2,  0.94,  3.0,  sizeBell, opacityLinear);
tick(this._wsmkL,  dt,  0.0, 0.999, 0.15, sizeBell, opacityDense);
tick(this._rockL,  dt,  -13.7, 0.98,  4.0,  sizeBell, opacityLinear);
tick(this._rsmkL,  dt,  0.0,  0.98,  0.3,  sizeBell, opacityDense);
tick(this._shellL, dt,  -9.8, 0.96,  8.0,  sizeConstant, opacityShellFade);

// emit trail smoke from live rocks
for (let i = this._liveRocks.length - 1; i >= 0; i--) {
  const rock = this._liveRocks[i];
  const RL   = this._rockL;
  if (RL.ages[rock.idx] >= RL.lifetimes[rock.idx]) {
    this._liveRocks.splice(i, 1);
    continue;
  }
  if (RL.ages[rock.idx] < 0) continue;  // delayed

  rock.trailTimer += dt;
  if (rock.trailTimer >= 0.04) {  // emit puff every 40ms
    rock.trailTimer = 0;
const rsIds = grab(this._rsPool, 1);
if (rsIds.length) {
  const i3 = rock.idx * 3;
  spawnRockTrailPuff(
    rsIds[0],
    RL.positions[i3], RL.positions[i3+1], RL.positions[i3+2],
    this._rsmkL
  );
  // no setTimeout — cleanup loop below handles release
}
  }
}

// release expired rock trail puffs back to pool
for (let i = 0; i < this._rsmkL.count; i++) {
  if (this._rsmkL.ages[i] >= this._rsmkL.lifetimes[i] &&
      this._rsmkL.ages[i] < 9999) {
    this._rsmkL.ages[i] = 9999;
    this._rsPool.free.push(i);
  }
}

    for (let i = this._active.length - 1; i >= 0; i--) {
      const ex = this._active[i];
      ex.elapsed += dt;
      if (ex.elapsed >= ex.maxLife) {
release(this._fPool,  this._fireL,  ex.fIds);
release(this._flPool, this._flareL, ex.flIds);
release(this._sPool,  this._smokeL, ex.sIds);
release(this._ePool,  this._emitL,  ex.eIds);
release(this._wPool,  this._wsmkL,  ex.wIds);
release(this._rPool,  this._rockL,  ex.rIds);
release(this._shPool, this._shellL, ex.shIds);
        _recycleEntry(ex);
        this._active[i] = this._active[this._active.length - 1];
        this._active.pop();
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose() {
    [this._fireL, this._flareL, this._smokeL, this._emitL, this._wsmkL, this._rockL, this._rsmkL, this._shellL].forEach(L => {
      this.scene.remove(L.points);
      L.geo.dispose();
      L.mat.dispose();
    });
    this._active = [];
    this._damageFires.clear();
    this._planeDamageSmoke.clear();
  }
}