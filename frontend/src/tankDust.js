// tankDust.js — Dust trail + Rock debris from Dust_1 / Dust_2 nodes, single draw call each

import * as THREE from 'three';
import { terrainData } from './utils/terrainData.js';

const DUST_TEXTURE_URL  = '/textures/cloud.png';
// const ROCKS_TEXTURE_URL = 'https://raw.githubusercontent.com/NewKrok/three-particles-editor/refs/heads/master/public/assets/textures/rocks.webp';
const WATER_TEXTURE_URL = '/textures/water.png'; // ← your uploaded sprite sheet

const PER_EMITTER       = 5;    // dust particles per emitter
// const PER_EMITTER_ROCK  = 3;    // rock particles per emitter (fewer rocks than dust)
const PER_EMITTER_WATER = 15;    // splash particles per emitter while underwater
const SPAWN_THRESHOLD   = 0.02; // min speed to emit (world units/s)

// Accepts a numeric hex (0x8B6914), a numeric-hex STRING ("0x8B6914"),
// or a real CSS color string ("#8B6914") — maps.json stores dustColor as
// a plain JSON string like "0x8B6914", which THREE.Color would otherwise
// silently fail to parse (falling back to white).
function _normalizeColorInput(color) {
  if (typeof color === 'number') return color;
  if (typeof color === 'string') {
    const trimmed = color.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      return parseInt(trimmed, 16);
    }
    return trimmed; // real CSS string like "#8B6914" or "orange" — let THREE.Color handle it
  }
  return 0x8B6914; // fallback
}

// // Rocks sprite-sheet: 5 columns × 2 rows = 10 frames
// const ROCK_SHEET_COLS = 5;
// const ROCK_SHEET_ROWS = 2;

// Water splash sprite-sheet: 3 columns × 2 rows = 6 frames
const WATER_SHEET_COLS = 3;
const WATER_SHEET_ROWS = 2;

// Submersion threshold — must match the water plane's y in main.js
const WATER_LEVEL_Y = terrainData.waterLevel ?? 8.0;

// ── Shared geometry + material (one draw call for all particles) ──────────────

function createSharedSystem(scene, texture, totalCount, color, useSheet = false, blending = THREE.NormalBlending, layer = 0) {
  const positions  = new Float32Array(totalCount * 3);
  const sizes      = new Float32Array(totalCount);
  const opacities  = new Float32Array(totalCount);
  const rotations  = new Float32Array(totalCount);
  // Per-particle color tint — only used by the non-sheet (dust) system so
  // individual dust particles can be forced white when spawned underwater
  // while the shared uniform stays the normal dust color for everyone else.
  const colors     = !useSheet ? new Float32Array(totalCount * 3) : null;

  // For sprite-sheet animation we need per-particle UV offset + scale
  const uvOffset = useSheet ? new Float32Array(totalCount * 2) : null;
  const uvScale  = useSheet ? new Float32Array(totalCount * 2) : null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('size',     new THREE.BufferAttribute(sizes,     1));
  geometry.setAttribute('opacity',  new THREE.BufferAttribute(opacities, 1));
  geometry.setAttribute('rotation', new THREE.BufferAttribute(rotations, 1));

  if (colors) {
    geometry.setAttribute('pcolor', new THREE.BufferAttribute(colors, 3));
  }

  if (useSheet) {
    geometry.setAttribute('uvOffset', new THREE.BufferAttribute(uvOffset, 2));
    geometry.setAttribute('uvScale',  new THREE.BufferAttribute(uvScale,  2));
  }

  const vertexShader = useSheet
    ? /* glsl */`
        attribute float size;
        attribute float opacity;
        attribute float rotation;
        attribute vec2  uvOffset;
        attribute vec2  uvScale;
        varying float vOpacity;
        varying float vRotation;
        varying vec2  vUvOffset;
        varying vec2  vUvScale;

        void main() {
          vOpacity  = opacity;
          vRotation = rotation;
          vUvOffset = uvOffset;
          vUvScale  = uvScale;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (200.0 / -mvPosition.z);
          gl_Position  = projectionMatrix * mvPosition;
        }
      `
    : /* glsl */`
        attribute float size;
        attribute float opacity;
        attribute float rotation;
        attribute vec3  pcolor;
        varying float vOpacity;
        varying float vRotation;
        varying vec3  vColor;

        void main() {
          vOpacity  = opacity;
          vRotation = rotation;
          vColor    = pcolor;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (200.0 / -mvPosition.z);
          gl_Position  = projectionMatrix * mvPosition;
        }
      `;

  const fragmentShader = useSheet
    ? /* glsl */`
        uniform sampler2D map;
        uniform vec3 color;
        varying float vOpacity;
        varying float vRotation;
        varying vec2  vUvOffset;
        varying vec2  vUvScale;

        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float s = sin(vRotation);
          float c = cos(vRotation);
          uv = vec2(c * uv.x - s * uv.y,
                    s * uv.x + c * uv.y) + 0.5;

          // Map into the sprite-sheet cell
          uv = vUvOffset + uv * vUvScale;

          vec4 tex = texture2D(map, uv);
          gl_FragColor = vec4(color * tex.rgb, tex.a * vOpacity);
          if (gl_FragColor.a < 0.01) discard;
        }
      `
    : /* glsl */`
        uniform sampler2D map;
        varying float vOpacity;
        varying float vRotation;
        varying vec3  vColor;

        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float s = sin(vRotation);
          float c = cos(vRotation);
          uv = vec2(c * uv.x - s * uv.y,
                    s * uv.x + c * uv.y) + 0.5;

          vec4 tex = texture2D(map, uv);
          gl_FragColor = vec4(vColor * tex.rgb, tex.a * vOpacity);
          if (gl_FragColor.a < 0.01) discard;
        }
      `;

  const baseColorObj = new THREE.Color(_normalizeColorInput(color));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      map:   { value: texture },
      color: { value: baseColorObj },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite:  false,
    blending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  // Only ever non-zero for the dust system (see the createSharedSystem call
  // below) — keeps ground dust off the water Reflector's reflection pass
  // (which only renders layer 0) without affecting water splash particles,
  // which should still show up mirrored in the water surface as normal.
  points.layers.set(layer);
  scene.add(points);

  return { points, geometry, material, positions, sizes, opacities, rotations, uvOffset, uvScale, colors, baseColor: baseColorObj };
}

// ── Per-emitter state factory ─────────────────────────────────────────────────

function createEmitterState(offset, count) {
  const ages       = new Float32Array(count);
  const lifetimes  = new Float32Array(count);
  const velocities = [];
  const spawnDebt  = { value: 0 };

  for (let i = 0; i < count; i++) {
    ages[i]      = 999; // dead on start
    lifetimes[i] = 1;
    velocities.push(new THREE.Vector3());
  }

  return { ages, lifetimes, velocities, spawnDebt, offset };
}

// ── Dust particle reset ───────────────────────────────────────────────────────

function resetDustParticle(localIdx, worldPos, worldQuat, state, shared, isUnderwater = false) {
  const gi = state.offset + localIdx;
  const { positions, sizes, opacities, rotations, colors, baseColor } = shared;

  if (colors) {
    const r = isUnderwater ? 1 : baseColor.r;
    const g = isUnderwater ? 1 : baseColor.g;
    const b = isUnderwater ? 1 : baseColor.b;
    colors[gi * 3 + 0] = r;
    colors[gi * 3 + 1] = g;
    colors[gi * 3 + 2] = b;
  }

  positions[gi * 3 + 0] = worldPos.x + (Math.random() - 0.5) * 0.15;
  positions[gi * 3 + 1] = worldPos.y + (Math.random() - 0.5) * 0.05;
  positions[gi * 3 + 2] = worldPos.z + (Math.random() - 0.5) * 0.15;

  const speed = 0.8 + Math.random() * 0.6;
  const vel = new THREE.Vector3(
    (Math.random() - 0.5) * 1.2,
    0.15 + Math.random() * 0.25,
    (Math.random() - 0.5) * 1.2,
  ).applyQuaternion(worldQuat).multiplyScalar(speed);

  state.velocities[localIdx].copy(vel);
  state.ages[localIdx]      = 0;
  state.lifetimes[localIdx] = 1.6 + Math.random() * 0.8;
  sizes[gi]                 = 0;
  opacities[gi]             = 0;
  rotations[gi]             = Math.random() * Math.PI * 2;
}

// ── Rock particle reset ───────────────────────────────────────────────────────

function resetRockParticle(localIdx, worldPos, worldQuat, state, shared) {
  const gi = state.offset + localIdx;
  const { positions, sizes, opacities, rotations, uvOffset, uvScale } = shared;

  // Spawn near the ground node with a small horizontal scatter
  positions[gi * 3 + 0] = worldPos.x + (Math.random() - 0.5) * 0.3;
  positions[gi * 3 + 1] = worldPos.y;
  positions[gi * 3 + 2] = worldPos.z + (Math.random() - 0.5) * 0.3;

  // Rocks fly outward + upward in a cone (mirroring rocksEffect cone shape)
  const angle = Math.random() * Math.PI;
  const cone  = 0.14 + Math.random() * 0.3;   // spread angle ~36°
  const speed = 0.5 + Math.random() * 5.0;    // startSpeed min/max from rocksEffect
  const vel = new THREE.Vector3(
    Math.sin(cone) * Math.cos(angle),
    Math.cos(cone),                             // mostly upward
    Math.sin(cone) * Math.sin(angle),
  ).applyQuaternion(worldQuat).multiplyScalar(speed);

  state.velocities[localIdx].copy(vel);
  state.ages[localIdx]      = 0;
  state.lifetimes[localIdx] = 0.1 + Math.random() * 0.4; // startLifetime min/max

  // Pick a random frame from the 5×2 sprite sheet
  const frame = Math.floor(Math.random() * (ROCK_SHEET_COLS * ROCK_SHEET_ROWS));
  const col   = frame % ROCK_SHEET_COLS;
  const row   = Math.floor(frame / ROCK_SHEET_COLS);
  const scaleU = 1 / ROCK_SHEET_COLS;
  const scaleV = 1 / ROCK_SHEET_ROWS;

  uvOffset[gi * 2 + 0] = col * scaleU;
  uvOffset[gi * 2 + 1] = row * scaleV;
  uvScale [gi * 2 + 0] = scaleU;
  uvScale [gi * 2 + 1] = scaleV;

  sizes[gi]     = 0;
  opacities[gi] = 0;
  rotations[gi] = Math.random() * Math.PI * 2;
}

// ── Water splash particle reset ────────────────────────────────────────────────

function resetWaterParticle(localIdx, worldPos, worldQuat, state, shared) {
  const gi = state.offset + localIdx;
  const { positions, sizes, opacities, rotations, uvOffset, uvScale } = shared;

  positions[gi * 3 + 0] = worldPos.x + (Math.random() - 0.5) * 0.4;
  positions[gi * 3 + 1] = worldPos.y;
  positions[gi * 3 + 2] = worldPos.z + (Math.random() - 0.5) * 0.4;

  // Splash burst — outward + upward, gravity pulls it back down in the tick fn
  const angle = Math.random() * Math.PI * 2;
  const cone  = 0.1 + Math.random() * 0.5;
  const speed = 0.8 + Math.random() * 3.5;
  const vel = new THREE.Vector3(
    Math.sin(cone) * Math.cos(angle),
    Math.cos(cone),
    Math.sin(cone) * Math.sin(angle),
  ).applyQuaternion(worldQuat).multiplyScalar(speed);

  state.velocities[localIdx].copy(vel);
  state.ages[localIdx]      = 0;
  state.lifetimes[localIdx] = 0.3 + Math.random() * 0.5;

  const frame = Math.floor(Math.random() * (WATER_SHEET_COLS * WATER_SHEET_ROWS));
  const col   = frame % WATER_SHEET_COLS;
  const row   = Math.floor(frame / WATER_SHEET_COLS);
  const scaleU = 1 / WATER_SHEET_COLS;
  const scaleV = 1 / WATER_SHEET_ROWS;

  uvOffset[gi * 2 + 0] = col * scaleU;
  uvOffset[gi * 2 + 1] = row * scaleV;
  uvScale [gi * 2 + 0] = scaleU;
  uvScale [gi * 2 + 1] = scaleV;

  sizes[gi]     = 0;
  opacities[gi] = 0;
  rotations[gi] = Math.random() * Math.PI * 2;
}

// ── Public class ──────────────────────────────────────────────────────────────

export class TankDust {
  constructor(scene, dustNodes, rigidBody, dustColor = 0x8B6914) {
    this.scene     = scene;
    this.nodes     = dustNodes;
    this.rigidBody = rigidBody;
    this._dustColor = dustColor;
    this._active   = false;

    this._sharedDust  = null;
    // this._sharedRocks = null;
    this._sharedWater = null;
    this._dustEmitters  = [];
    // this._rockEmitters  = [];
    this._waterEmitters = [];

    this._wp      = new THREE.Vector3();
    this._wq      = new THREE.Quaternion();
    this._vel     = new THREE.Vector3();
    this._wpCheck = new THREE.Vector3(); // scratch for underwater checks

    this._init();
  }

  async _init() {
    if (!this.nodes || this.nodes.length === 0) {
      console.warn('[TankDust] No dust nodes.');
      return;
    }

    const nodeCount = this.nodes.length;

    // Load all three textures in parallel
    const [dustTex, waterTex] = await Promise.all([
  new Promise((res, rej) =>
    new THREE.TextureLoader().load(DUST_TEXTURE_URL,  res, undefined, rej)),
  new Promise((res, rej) =>
    new THREE.TextureLoader().load(WATER_TEXTURE_URL, res, undefined, rej)),
]);
dustTex.needsUpdate  = true;
waterTex.needsUpdate = true;

    // Dust system — change color
    // layer 1 — excluded from the water Reflector's reflection camera (see
    // createSharedSystem), so ground dust doesn't show up mirrored in water
    this._sharedDust = createSharedSystem(
      this.scene, dustTex,
      PER_EMITTER * nodeCount,
      this._dustColor,   // ← now driven by the map's dustColor (see constructor)
      false,
      THREE.NormalBlending,
      1
    );
    // // Rocks system — change color
    // this._sharedRocks = createSharedSystem(
    //   this.scene, rocksTex,
    //   PER_EMITTER_ROCK * nodeCount,
    //   0x5C3D1A,   // was 0x625f5f — dark earthy brown
    //   true
    // );

    // Water splash system — additive blending so the black sheet bg disappears
    this._sharedWater = createSharedSystem(
      this.scene, waterTex,
      PER_EMITTER_WATER * nodeCount,
      0xffffff,   // light blue-white tint
      true,
      THREE.AdditiveBlending
    );

    for (let n = 0; n < nodeCount; n++) {
      const node = this.nodes[n];

      this._dustEmitters.push({
        node,
        state: createEmitterState(n * PER_EMITTER, PER_EMITTER),
      });

      // this._rockEmitters.push({
      //   node,
      //   state: createEmitterState(n * PER_EMITTER_ROCK, PER_EMITTER_ROCK),
      // });

      this._waterEmitters.push({
        node,
        state: createEmitterState(n * PER_EMITTER_WATER, PER_EMITTER_WATER),
      });

      // console.log(`[TankDust] ✅ "${node.name}" dust+rocks+water emitters ready`);
    }

    this._active = true;
  }

  // throttle: -1 → 0 → 1  (from tank.applyInput leftThrottle/rightThrottle avg)
  update(dt, throttle = 0, waterInfo = null) {
    if (!this._active || !this._sharedDust || !this._sharedWater) return;

    const delta = typeof dt === 'number' ? dt : (dt?.delta ?? 0.016);
    const waterEnabled = waterInfo?.waterEnabled !== false;
    const waterY       = waterInfo?.waterY ?? WATER_LEVEL_Y;

    const rv    = this.rigidBody.linvel();
    this._vel.set(rv.x, rv.y, rv.z);
    const speed  = this._vel.length();
    const moving = speed > SPAWN_THRESHOLD;

    // Spawn rates scale with speed
    const dustSpawnRate  = Math.min(speed * 12, 25);   // particles/s per emitter
    // const rocksSpawnRate = Math.min(speed * 4,  8);    // rocks are rarer
    const waterSpawnRate = Math.min(speed * 10, 20);   // splash rate while underwater

    // Per-node submersion check — each dust node (wheel/track contact point)
    // is tested individually against the water plane height. When water is
    // disabled for this map, dust must never be filtered out here — always
    // treat every node as "above water" so dust spawns normally on dry maps.
    const isAboveWater = (node) => {
      if (!waterEnabled) return true;
      node.getWorldPosition(this._wpCheck);
      return this._wpCheck.y >= waterY;
    };
    const isUnderwater = (_node) => {
      if (!waterEnabled) return false;
      const tankY = this.rigidBody.translation().y;
      return tankY < (waterY + 0.5);
    };

    // ── DUST update — now spawns underwater too, tinted white via colorFn ─
    this._updateSystem(
      this._dustEmitters,
      this._sharedDust,
      PER_EMITTER,
      moving, dustSpawnRate, delta,
      resetDustParticle,
      (gi, t, i, state, shared) => {
        const { sizes, opacities, rotations, positions } = shared;
        positions[gi * 3 + 0] += state.velocities[i].x * delta;
        positions[gi * 3 + 1] += state.velocities[i].y * delta;
        positions[gi * 3 + 2] += state.velocities[i].z * delta;
        state.velocities[i].y -= 1.5 * delta;
        state.velocities[i].multiplyScalar(1 - delta * 1.8);
        rotations[gi] += delta * (0.2 + (i % 4) * 0.1);
        sizes[gi] = THREE.MathUtils.lerp(5, 18, Math.min(t * 3.0, 1.0));
        opacities[gi] = t < 0.08
          ? t / 0.08
          : (1.0 - ((t - 0.08) / 0.92)) * 0.5;
      },
      null,
      (node) => !isAboveWater(node)
    );

    // // ── ROCKS update — skipped for nodes currently underwater ─────────────
    // this._updateSystem(
    //   this._rockEmitters,
    //   this._sharedRocks,
    //   PER_EMITTER_ROCK,
    //   moving, rocksSpawnRate, delta,
    //   resetRockParticle,
    //   (gi, t, i, state, shared) => {
    //     const { sizes, opacities, rotations, positions } = shared;
    //     positions[gi * 3 + 0] += state.velocities[i].x * delta;
    //     positions[gi * 3 + 1] += state.velocities[i].y * delta;
    //     positions[gi * 3 + 2] += state.velocities[i].z * delta;
    //     state.velocities[i].y -= 20 * delta;
    //     state.velocities[i].multiplyScalar(1 - delta * 0.6);
    //     rotations[gi] += delta * (3.0 + (i % 3) * 2.0);
    //     sizes[gi] = THREE.MathUtils.lerp(0.1, 0.3, Math.min(t * 2.0, 1.0));
    //     opacities[gi] = t < 0.8
    //       ? 1.0
    //       : 1.0 - ((t - 0.8) / 0.2);
    //   },
    //   isAboveWater
    // );

    // ── WATER SPLASH update — only spawns for nodes currently underwater ──
    this._updateSystem(
      this._waterEmitters,
      this._sharedWater,
      PER_EMITTER_WATER,
      moving, waterSpawnRate, delta,
      resetWaterParticle,
      (gi, t, i, state, shared) => {
        const { sizes, opacities, rotations, positions } = shared;
        positions[gi * 3 + 0] += state.velocities[i].x * delta;
        positions[gi * 3 + 1] += state.velocities[i].y * delta;
        positions[gi * 3 + 2] += state.velocities[i].z * delta;
        state.velocities[i].y -= 3 * delta;        // gravity pulls droplets back down
        state.velocities[i].multiplyScalar(1 - delta * 0.5);
        rotations[gi] += delta * (1.0 + (i % 3) * 0.5);
        sizes[gi] = THREE.MathUtils.lerp(1.2, 2.4, Math.min(t * 4.0, 1.0));
        opacities[gi] = t < 0.15
        ? (t / 0.15) * 1.5
        : (1.0 - ((t - 0.15) / 0.85)) * 1.5;
      },
      isUnderwater
    );
  }

  // ── Ages/fades any already-emitted particles WITHOUT spawning new ones
  // and WITHOUT touching this.rigidBody. Call this instead of update()
  // whenever the tank isn't being actively driven (flying the plane, or
  // dead/respawning) — otherwise any dust/splash particle that was
  // mid-fade the instant driving stopped just freezes forever, since
  // update() (the only thing that ages particles) never runs again.
  tickIdle(dt) {
    if (!this._active || !this._sharedDust || !this._sharedWater) return;
    const delta = typeof dt === 'number' ? dt : (dt?.delta ?? 0.016);

    this._updateSystem(
      this._dustEmitters, this._sharedDust, PER_EMITTER,
      false, 0, delta, resetDustParticle,
      (gi, t, i, state, shared) => {
        const { sizes, opacities, rotations, positions } = shared;
        positions[gi * 3 + 0] += state.velocities[i].x * delta;
        positions[gi * 3 + 1] += state.velocities[i].y * delta;
        positions[gi * 3 + 2] += state.velocities[i].z * delta;
        state.velocities[i].y -= 1.5 * delta;
        state.velocities[i].multiplyScalar(1 - delta * 1.8);
        rotations[gi] += delta * (0.2 + (i % 4) * 0.1);
        sizes[gi] = THREE.MathUtils.lerp(5, 18, Math.min(t * 3.0, 1.0));
        opacities[gi] = t < 0.08
          ? t / 0.08
          : (1.0 - ((t - 0.08) / 0.92)) * 0.5;
      },
      null
    );

    this._updateSystem(
      this._waterEmitters, this._sharedWater, PER_EMITTER_WATER,
      false, 0, delta, resetWaterParticle,
      (gi, t, i, state, shared) => {
        const { sizes, opacities, rotations, positions } = shared;
        positions[gi * 3 + 0] += state.velocities[i].x * delta;
        positions[gi * 3 + 1] += state.velocities[i].y * delta;
        positions[gi * 3 + 2] += state.velocities[i].z * delta;
        state.velocities[i].y -= 3 * delta;
        state.velocities[i].multiplyScalar(1 - delta * 0.5);
        rotations[gi] += delta * (1.0 + (i % 3) * 0.5);
        sizes[gi] = THREE.MathUtils.lerp(1.2, 2.4, Math.min(t * 4.0, 1.0));
        opacities[gi] = t < 0.15
          ? (t / 0.15) * 1.5
          : (1.0 - ((t - 0.15) / 0.85)) * 1.5;
      },
      null
    );
  }

  // ── Generic system tick (shared by dust and rocks) ────────────────────────
  _updateSystem(emitters, shared, perEmitter, moving, spawnRate, delta, resetFn, tickFn, nodeFilter = null, colorFn = null) {
    const { positions, sizes, opacities, rotations } = shared;

    for (const { node, state } of emitters) {
      node.getWorldPosition(this._wp);
      node.getWorldQuaternion(this._wq);

      // Spawn
      if (moving && (!nodeFilter || nodeFilter(node))) {
        state.spawnDebt.value += spawnRate * delta;
        while (state.spawnDebt.value >= 1) {
          let slot = -1;
          for (let i = 0; i < perEmitter; i++) {
            if (state.ages[i] >= state.lifetimes[i]) { slot = i; break; }
          }
          if (slot !== -1) resetFn(slot, this._wp, this._wq, state, shared, colorFn ? colorFn(node) : false);
          state.spawnDebt.value -= 1;
        }
      }

      // Tick
      for (let i = 0; i < perEmitter; i++) {
        const gi = state.offset + i;
        if (state.ages[i] >= state.lifetimes[i]) {
          sizes[gi]     = 0;
          opacities[gi] = 0;
          continue;
        }
        state.ages[i] += delta;
        const t = state.ages[i] / state.lifetimes[i];
        tickFn(gi, t, i, state, shared);
      }
    }

    // Single GPU upload
    shared.geometry.attributes.position.needsUpdate = true;
    shared.geometry.attributes.size.needsUpdate     = true;
    shared.geometry.attributes.opacity.needsUpdate  = true;
    shared.geometry.attributes.rotation.needsUpdate = true;
    if (shared.geometry.attributes.uvOffset) {
      shared.geometry.attributes.uvOffset.needsUpdate = true;
      shared.geometry.attributes.uvScale.needsUpdate  = true;
    }
    if (shared.geometry.attributes.pcolor) {
      shared.geometry.attributes.pcolor.needsUpdate = true;
    }
  }

  stop() {
    this._active = false;
    for (const sys of [this._sharedDust, this._sharedWater]) {
      if (sys) {
        this.scene.remove(sys.points);
        sys.geometry.dispose();
        sys.material.dispose();
      }
    }
    this._dustEmitters  = [];
    // this._rockEmitters  = [];
    this._waterEmitters = [];
  }
}