// rocketTrail.js — textured smoke trail for rockets
// Uses the same cloud texture + ShaderMaterial approach as tankSmoke.js.
// Fixed pool of particles — zero allocations after init.

import * as THREE from 'three';

const POOL_SIZE     = 200;   // total puff slots shared across ALL rockets
const TRAIL_LIFE    = 2;   // seconds each puff lives
const EMIT_INTERVAL = 0.018; // seconds between puffs per rocket

const PUFF_SCALE_START = 0.01;
const PUFF_SCALE_END   = 0.05;

const TEXTURE_URL =
  '/textures/cloud2.png';

// ── Shared texture (loaded once) ──────────────────────────────────────────
let _sharedTexture     = null;
let _textureLoadPromise = null;

function _getSharedTexture() {
  if (_sharedTexture) return Promise.resolve(_sharedTexture);
  if (_textureLoadPromise) return _textureLoadPromise;

  _textureLoadPromise = new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      TEXTURE_URL,
      (tex) => {
        tex.needsUpdate = true;
        _sharedTexture  = tex;
        resolve(tex);
      },
      undefined,
      reject,
    );
  });
  return _textureLoadPromise;
}

export function resetRocketTrailTexture() {
  _sharedTexture      = null;
  _textureLoadPromise = null;
}

// ── Build the single Points object that holds the whole pool ──────────────
function _buildPointsSystem(scene, texture) {
  const N = POOL_SIZE;

  const positions  = new Float32Array(N * 3);
  const sizes      = new Float32Array(N);
  const opacities  = new Float32Array(N);
  const rotations  = new Float32Array(N);

  // Start everything far off-screen and invisible
  for (let i = 0; i < N; i++) {
    positions[i * 3 + 1] = -9999;
    sizes[i]     = 0;
    opacities[i] = 0;
    rotations[i] = 0;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('size',     new THREE.BufferAttribute(sizes,     1));
  geometry.setAttribute('opacity',  new THREE.BufferAttribute(opacities, 1));
  geometry.setAttribute('rotation', new THREE.BufferAttribute(rotations, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      map:   { value: texture },
      color: { value: new THREE.Color(0xffffff) }, // neutral grey smoke
    },
    vertexShader: /* glsl */`
      attribute float size;
      attribute float opacity;
      attribute float rotation;
      varying   float vOpacity;
      varying   float vRotation;

      void main() {
        vOpacity  = opacity;
        vRotation = rotation;

        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize    = size * (300.0 / -mvPosition.z);
        gl_Position     = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D map;
      uniform vec3      color;
      varying float     vOpacity;
      varying float     vRotation;

      void main() {
        // Rotate UV around the centre of the point sprite
        vec2  uv = gl_PointCoord - 0.5;
        float s  = sin(vRotation);
        float c  = cos(vRotation);
        uv = vec2(c * uv.x - s * uv.y,
                  s * uv.x + c * uv.y) + 0.5;

        vec4 tex = texture2D(map, uv);
        gl_FragColor = vec4(color * tex.rgb, tex.a * vOpacity);
        if (gl_FragColor.a < 0.01) discard;
      }
    `,
    transparent: true,
    depthWrite:  false,
    blending:    THREE.NormalBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  return { points, geometry, material, positions, sizes, opacities, rotations };
}

// ── Per-slot runtime state (kept in plain arrays, not objects) ────────────
// active    : boolean
// life      : remaining seconds
// spin      : current rotation (rad)
// spinSpeed : rad/s
// vy        : upward drift speed

// ── RocketTrailSystem ─────────────────────────────────────────────────────

export class RocketTrailSystem {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene     = scene;
    this._ready    = false;
    this._disposed = false;

    // Per-slot arrays
    this._active    = new Uint8Array(POOL_SIZE);
    this._life      = new Float32Array(POOL_SIZE);
    this._maxLife   = new Float32Array(POOL_SIZE);
    this._spin      = new Float32Array(POOL_SIZE);
    this._spinSpeed = new Float32Array(POOL_SIZE);
    this._vy        = new Float32Array(POOL_SIZE);

    // Trail bookkeeping
    this._trails = new Map(); // id → { emitTimer }
    this._nextId = 0;

    // GPU buffers (set after texture loads)
    this._gpu = null;

    // Begin async init
    this._init();
  }

  async _init() {
    const texture = await _getSharedTexture();
    if (this._disposed) return; // dispose() ran while the texture was still loading
    this._gpu   = _buildPointsSystem(this.scene, texture);
    this._ready = true;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Register a rocket. Returns a trail ID.
   * Pass the ID to remove() when the rocket dies.
   */
  add() {
    const id = this._nextId++;
    this._trails.set(id, { emitTimer: 0 });
    return id;
  }

  /**
   * Stop emitting for this rocket.
   * Existing puffs finish fading naturally.
   */
  remove(id) {
    this._trails.delete(id);
  }

  /**
   * Call every frame.
   * @param {number} dt  Delta time in seconds.
   * @param {Map<number, THREE.Vector3>} rocketPositions
   *   Map from trail ID → current world position.
   */
  update(dt, rocketPositions) {
    if (!this._ready) return;

    const {
      positions, sizes, opacities, rotations,
      geometry,
    } = this._gpu;

    // ── Emit new puffs ────────────────────────────────────────────────
    for (const [id, trail] of this._trails) {
      const pos = rocketPositions.get(id);
      if (!pos) continue;

      trail.emitTimer -= dt;
      if (trail.emitTimer <= 0) {
        trail.emitTimer = EMIT_INTERVAL;
        this._spawnPuff(pos, positions, sizes, opacities, rotations);
      }
    }

    // ── Tick all active puffs ─────────────────────────────────────────
    for (let i = 0; i < POOL_SIZE; i++) {
      if (!this._active[i]) continue;

      this._life[i] -= dt;

      if (this._life[i] <= 0) {
        this._active[i]     = 0;
        sizes[i]            = 0;
        opacities[i]        = 0;
        positions[i * 3 + 1] = -9999;
        continue;
      }

      const t = 1 - (this._life[i] / this._maxLife[i]); // 0→1 as puff ages

      // Scale: grow over lifetime
      sizes[i] = THREE.MathUtils.lerp(
        PUFF_SCALE_START * 300, // converted from world units to gl_PointSize-friendly
        PUFF_SCALE_END   * 300,
        Math.min(t * 2.5, 1.0),
      );

      // Opacity: quick fade-in, slow fade-out — same curve as tankSmoke
      let op;
      if (t < 0.1) {
        op = t / 0.1;
      } else {
        op = 1.0 - ((t - 0.1) / 0.9);
      }
      opacities[i] = op * 0.55;

      // Spin
      this._spin[i]       += dt * this._spinSpeed[i];
      rotations[i]         = this._spin[i];

      // Drift upward
      positions[i * 3 + 1] += this._vy[i] * dt;
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.size.needsUpdate     = true;
    geometry.attributes.opacity.needsUpdate  = true;
    geometry.attributes.rotation.needsUpdate = true;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  _spawnPuff(pos, positions, sizes, opacities, rotations) {
    // Find first inactive slot
    for (let i = 0; i < POOL_SIZE; i++) {
      if (this._active[i]) continue;

      this._active[i]   = 1;
      this._life[i]     = TRAIL_LIFE;
      this._maxLife[i]  = TRAIL_LIFE;
      this._spin[i]     = Math.random() * Math.PI * 2;
      this._spinSpeed[i]= 0.3 + Math.random() * 0.4;
      this._vy[i]       = 0.05 + Math.random() * 0.05;

      positions[i * 3 + 0] = pos.x + (Math.random() - 0.5) * 0.04;
      positions[i * 3 + 1] = pos.y + (Math.random() - 0.5) * 0.04;
      positions[i * 3 + 2] = pos.z + (Math.random() - 0.5) * 0.04;

      sizes[i]     = PUFF_SCALE_START * 300;
      opacities[i] = 0;
      rotations[i] = this._spin[i];

      return;
    }
    // Pool exhausted — silently skip (no allocation)
  }

  dispose() {
    this._disposed = true;
    if (this._gpu) {
      this.scene.remove(this._gpu.points);
      this._gpu.geometry.dispose();
      this._gpu.material.dispose();
      this._gpu = null;
    }
    this._trails.clear();
    this._ready = false;
  }
}