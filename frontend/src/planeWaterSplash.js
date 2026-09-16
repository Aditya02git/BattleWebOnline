// planeWaterSplash.js — Lightweight water-spray effect for planes flying low
// over water. Mirrors the water-splash particle system already used by
// TankDust (tankDust.js), but the plane's GLB has no dedicated empty node
// for this (unlike Tank's Dust_1/Dust_2). Instead this uses a single
// synthetic anchor Object3D parented to the plane's bodyGroup — its world
// position/orientation track the airframe automatically, the same way a
// real GLB empty would, just without needing one authored in the model.
//
// Two particle layers, sharing the same trigger/proximity logic:
//   - "water" droplets — sprite-sheet splash texture, matches TankDust's
//     underwater splash look.
//   - "mist" puffs — the same soft cloud texture TankDust uses for ground
//     dust, tinted pure white (mirrors TankDust's own underwater-dust
//     white tint in resetDustParticle), bigger/slower/softer, layered on
//     top of the droplets for a fuller spray look.
//
// Spawn intensity is driven by PROXIMITY to the water surface (0 at
// maxHeight, full strength right at the surface) rather than a simple
// above/below-water boolean, so the effect reads as a gradual spray
// build-up as the plane descends toward the water instead of an abrupt pop.

import * as THREE from 'three';

const WATER_TEXTURE_URL = '/textures/water.png'; // same sprite sheet TankDust uses
const DUST_TEXTURE_URL  = '/textures/cloud.png';  // same soft cloud texture TankDust's dust uses

const WATER_SHEET_COLS  = 3;
const WATER_SHEET_ROWS  = 2;

const WATER_PARTICLE_COUNT = 18; // droplets
const MIST_PARTICLE_COUNT  = 10; // white puffs — fewer, bigger, softer

const SPAWN_THRESHOLD = 0.02; // min speed (world units/s) to emit

export class PlaneWaterSplash {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Group} bodyGroup   Plane's bodyGroup — the anchor is
   *   parented to this so it rides along for free, no per-frame sync needed.
   * @param {THREE.RigidBody} rigidBody
   * @param {Object} [opts]
   * @param {number} [opts.anchorLocalY] Local Y offset of the spray point
   *   relative to bodyGroup's origin — defaults to slightly below origin
   *   (assumed fuselage belly / "normal position").
   * @param {number} [opts.maxHeight] World units above the water surface
   *   where the effect starts fading in.
   * @param {number} [opts.minHeight] World units below the water surface
   *   still allowed to emit (guards against a submerged/crashed plane
   *   spamming particles forever).
   */
  constructor(scene, bodyGroup, rigidBody, opts = {}) {
    this.scene     = scene;
    this.bodyGroup = bodyGroup;
    this.rigidBody = rigidBody;
    this.maxHeight = opts.maxHeight ?? 4.0;
    this.minHeight = opts.minHeight ?? -1.5;
    this._active   = false;

    // Synthetic anchor — parented so world position/quaternion follow the
    // plane automatically, exactly like a real GLB empty node would.
    this.anchor = new THREE.Object3D();
    this.anchor.position.set(0, opts.anchorLocalY ?? -0.4, 0);
    this.bodyGroup.add(this.anchor);

    this._wp  = new THREE.Vector3();
    this._wq  = new THREE.Quaternion();
    this._vel = new THREE.Vector3();

    // ── Water droplet state ────────────────────────────────────────────
    this._age        = new Float32Array(WATER_PARTICLE_COUNT).fill(999);
    this._lifetime   = new Float32Array(WATER_PARTICLE_COUNT).fill(1);
    this._velocities = Array.from({ length: WATER_PARTICLE_COUNT }, () => new THREE.Vector3());
    this._spawnDebt  = 0;

    // ── White mist puff state (NEW) ───────────────────────────────────
    this._mistAge        = new Float32Array(MIST_PARTICLE_COUNT).fill(999);
    this._mistLifetime   = new Float32Array(MIST_PARTICLE_COUNT).fill(1);
    this._mistVelocities = Array.from({ length: MIST_PARTICLE_COUNT }, () => new THREE.Vector3());
    this._mistSpawnDebt  = 0;

    this._init();
  }

  async _init() {
    const [waterTex, dustTex] = await Promise.all([
      new Promise((res, rej) =>
        new THREE.TextureLoader().load(WATER_TEXTURE_URL, res, undefined, rej)),
      new Promise((res, rej) =>
        new THREE.TextureLoader().load(DUST_TEXTURE_URL, res, undefined, rej)),
    ]).catch((err) => {
      console.warn('[PlaneWaterSplash] Failed to load textures:', err);
      return [null, null];
    });
    if (!waterTex || !dustTex) return;
    waterTex.needsUpdate = true;
    dustTex.needsUpdate  = true;

    // ── Water droplets — sprite-sheet, per-particle UV frame ────────────
    {
      const positions = new Float32Array(WATER_PARTICLE_COUNT * 3);
      const sizes     = new Float32Array(WATER_PARTICLE_COUNT);
      const opacities = new Float32Array(WATER_PARTICLE_COUNT);
      const rotations = new Float32Array(WATER_PARTICLE_COUNT);
      const uvOffset  = new Float32Array(WATER_PARTICLE_COUNT * 2);
      const uvScale   = new Float32Array(WATER_PARTICLE_COUNT * 2);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('size',     new THREE.BufferAttribute(sizes,     1));
      geometry.setAttribute('opacity',  new THREE.BufferAttribute(opacities, 1));
      geometry.setAttribute('rotation', new THREE.BufferAttribute(rotations, 1));
      geometry.setAttribute('uvOffset', new THREE.BufferAttribute(uvOffset,  2));
      geometry.setAttribute('uvScale',  new THREE.BufferAttribute(uvScale,   2));

      const material = new THREE.ShaderMaterial({
        uniforms: {
          map:   { value: waterTex },
          color: { value: new THREE.Color(0xffffff) },
        },
        vertexShader: /* glsl */`
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
        `,
        fragmentShader: /* glsl */`
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
            uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;
            uv = vUvOffset + uv * vUvScale;
            vec4 tex = texture2D(map, uv);
            gl_FragColor = vec4(color * tex.rgb, tex.a * vOpacity);
            if (gl_FragColor.a < 0.01) discard;
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      this.points = new THREE.Points(geometry, material);
      this.points.frustumCulled = false;
      this.scene.add(this.points);

      this._positions = positions;
      this._sizes     = sizes;
      this._opacities = opacities;
      this._rotations = rotations;
      this._uvOffset  = uvOffset;
      this._uvScale   = uvScale;
      this._geometry  = geometry;
    }

    // ── White mist puffs (NEW) — plain soft cloud texture, no sprite
    // sheet, tinted pure white to match TankDust's underwater dust tint. ──
    {
      const positions = new Float32Array(MIST_PARTICLE_COUNT * 3);
      const sizes     = new Float32Array(MIST_PARTICLE_COUNT);
      const opacities = new Float32Array(MIST_PARTICLE_COUNT);
      const rotations = new Float32Array(MIST_PARTICLE_COUNT);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('size',     new THREE.BufferAttribute(sizes,     1));
      geometry.setAttribute('opacity',  new THREE.BufferAttribute(opacities, 1));
      geometry.setAttribute('rotation', new THREE.BufferAttribute(rotations, 1));

      const material = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: dustTex },
        },
        vertexShader: /* glsl */`
          attribute float size;
          attribute float opacity;
          attribute float rotation;
          varying float vOpacity;
          varying float vRotation;
          void main() {
            vOpacity  = opacity;
            vRotation = rotation;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * (200.0 / -mvPosition.z);
            gl_Position  = projectionMatrix * mvPosition;
          }
        `,
        fragmentShader: /* glsl */`
          uniform sampler2D map;
          varying float vOpacity;
          varying float vRotation;
          void main() {
            vec2 uv = gl_PointCoord - 0.5;
            float s = sin(vRotation);
            float c = cos(vRotation);
            uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;
            vec4 tex = texture2D(map, uv);
            // Pure white tint — same look TankDust uses for its
            // underwater dust particles (resetDustParticle's isUnderwater
            // branch forces r=g=b=1 there too).
            gl_FragColor = vec4(vec3(1.0) * tex.rgb, tex.a * vOpacity);
            if (gl_FragColor.a < 0.01) discard;
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending, // matches TankDust's dust blending — softer than additive
      });

      this.mistPoints = new THREE.Points(geometry, material);
      this.mistPoints.frustumCulled = false;
      this.scene.add(this.mistPoints);

      this._mistPositions = positions;
      this._mistSizes     = sizes;
      this._mistOpacities = opacities;
      this._mistRotations = rotations;
      this._mistGeometry  = geometry;
    }

    this._active = true;
  }

  _resetParticle(i, worldPos, worldQuat) {
    this._positions[i * 3 + 0] = worldPos.x + (Math.random() - 0.5) * 0.5;
    this._positions[i * 3 + 1] = worldPos.y;
    this._positions[i * 3 + 2] = worldPos.z + (Math.random() - 0.5) * 0.5;

    const angle = Math.random() * Math.PI * 2;
    const cone  = 0.1 + Math.random() * 0.5;
    const speed = 0.8 + Math.random() * 3.0;
    this._velocities[i].set(
      Math.sin(cone) * Math.cos(angle),
      Math.cos(cone),
      Math.sin(cone) * Math.sin(angle),
    ).applyQuaternion(worldQuat).multiplyScalar(speed);

    this._age[i]      = 0;
    this._lifetime[i] = 0.3 + Math.random() * 0.5;

    const frame = Math.floor(Math.random() * (WATER_SHEET_COLS * WATER_SHEET_ROWS));
    const col   = frame % WATER_SHEET_COLS;
    const row   = Math.floor(frame / WATER_SHEET_COLS);
    const su = 1 / WATER_SHEET_COLS;
    const sv = 1 / WATER_SHEET_ROWS;
    this._uvOffset[i * 2 + 0] = col * su;
    this._uvOffset[i * 2 + 1] = row * sv;
    this._uvScale[i * 2 + 0]  = su;
    this._uvScale[i * 2 + 1]  = sv;

    this._sizes[i]     = 0;
    this._opacities[i] = 0;
    this._rotations[i] = Math.random() * Math.PI * 2;
  }

  /** Resets one white mist puff — slower, longer-lived, drifts upward like
   * TankDust's ground dust rather than bursting outward like the droplets. */
  _resetMistParticle(i, worldPos, worldQuat) {
    this._mistPositions[i * 3 + 0] = worldPos.x + (Math.random() - 0.5) * 0.6;
    this._mistPositions[i * 3 + 1] = worldPos.y + (Math.random() - 0.5) * 0.1;
    this._mistPositions[i * 3 + 2] = worldPos.z + (Math.random() - 0.5) * 0.6;

    const speed = 0.6 + Math.random() * 0.5;
    this._mistVelocities[i].set(
      (Math.random() - 0.5) * 0.8,
      0.4 + Math.random() * 0.4,
      (Math.random() - 0.5) * 0.8,
    ).applyQuaternion(worldQuat).multiplyScalar(speed);

    this._mistAge[i]      = 0;
    this._mistLifetime[i] = 0.9 + Math.random() * 0.6;

    this._mistSizes[i]     = 0;
    this._mistOpacities[i] = 0;
    this._mistRotations[i] = Math.random() * Math.PI * 2;
  }

  /** Called whenever the owning Plane's rigid body is replaced or removed
   * (death, respawn) — without this, this system keeps its own stale copy
   * of the OLD reference even after Plane.rigidBody is nulled, and calling
   * .linvel() on a Rapier body that's already been removed from the world
   * panics the wasm module and poisons the whole physics world for every
   * other tank/plane. */
  setRigidBody(rigidBody) {
    this.rigidBody = rigidBody;
  }

  /**
   * @param {number} dt
   * @param {{waterEnabled?: boolean, waterY?: number}} [waterInfo] — same
   *   shape TankDust.update() expects (main.js already builds this via
   *   cycleData for the tank; plane.js's own cycleData param can be passed
   *   straight through, see plane.js's update()).
   */
  update(dt, waterInfo = null) {
    if (!this._active || !this.rigidBody) return;

    // ── Defensive validity check — guards against any stale-reference
    // path (e.g. mid-frame death) calling into a removed Rapier body.
    try {
      if (this.rigidBody.isValid && !this.rigidBody.isValid()) {
        this.rigidBody = null;
        return;
      }
    } catch (_) {
      this.rigidBody = null;
      return;
    }

    const waterEnabled = waterInfo?.waterEnabled !== false;
    if (!waterEnabled) { this._tick(dt); return; }

    const waterY = waterInfo?.waterY ?? 8.0;

    this.anchor.getWorldPosition(this._wp);
    this.anchor.getWorldQuaternion(this._wq);

    const altitude = this._wp.y - waterY;
    const inRange  = altitude <= this.maxHeight && altitude >= this.minHeight;

    const rv = this.rigidBody.linvel();
    this._vel.set(rv.x, rv.y, rv.z);
    const speed  = this._vel.length();
    const moving = speed > SPAWN_THRESHOLD;

    // Proximity-scaled spawn rate — full strength right at the surface,
    // fading out toward maxHeight, so it reads as a gradual spray build-up
    // rather than an abrupt on/off pop.
    const proximity = inRange
      ? THREE.MathUtils.clamp(1 - Math.max(altitude, 0) / this.maxHeight, 0, 1)
      : 0;

    if (moving && inRange && proximity > 0) {
      // Water droplets
      const spawnRate = Math.min(speed * 6, 18) * proximity;
      this._spawnDebt += spawnRate * dt;
      while (this._spawnDebt >= 1) {
        let slot = -1;
        for (let i = 0; i < WATER_PARTICLE_COUNT; i++) {
          if (this._age[i] >= this._lifetime[i]) { slot = i; break; }
        }
        if (slot !== -1) this._resetParticle(slot, this._wp, this._wq);
        this._spawnDebt -= 1;
      }

      // White mist puffs (NEW) — sparser than droplets, same proximity gate
      const mistSpawnRate = Math.min(speed * 2.5, 7) * proximity;
      this._mistSpawnDebt += mistSpawnRate * dt;
      while (this._mistSpawnDebt >= 1) {
        let slot = -1;
        for (let i = 0; i < MIST_PARTICLE_COUNT; i++) {
          if (this._mistAge[i] >= this._mistLifetime[i]) { slot = i; break; }
        }
        if (slot !== -1) this._resetMistParticle(slot, this._wp, this._wq);
        this._mistSpawnDebt -= 1;
      }
    }

    this._tick(dt);
  }

  /** Ages/fades already-spawned particles without emitting new ones — call
   * this instead of update() while the plane is dead/has no rigid body, so
   * any mid-fade particle doesn't freeze forever. */
  tickIdle(dt) {
    if (!this._active) return;
    this._tick(dt);
  }

  _tick(dt) {
    if (!this._active) return;

    // Water droplets
    for (let i = 0; i < WATER_PARTICLE_COUNT; i++) {
      if (this._age[i] >= this._lifetime[i]) {
        this._sizes[i]     = 0;
        this._opacities[i] = 0;
        continue;
      }
      this._age[i] += dt;
      const t = this._age[i] / this._lifetime[i];

      this._positions[i * 3 + 0] += this._velocities[i].x * dt;
      this._positions[i * 3 + 1] += this._velocities[i].y * dt;
      this._positions[i * 3 + 2] += this._velocities[i].z * dt;
      this._velocities[i].y -= 3 * dt;
      this._velocities[i].multiplyScalar(1 - dt * 0.5);
      this._rotations[i] += dt * (1.0 + (i % 3) * 0.5);
      this._sizes[i] = THREE.MathUtils.lerp(1.2, 2.4, Math.min(t * 4.0, 1.0));
      this._opacities[i] = t < 0.15
        ? (t / 0.15) * 1.5
        : (1.0 - ((t - 0.15) / 0.85)) * 1.5;
    }

    this._geometry.attributes.position.needsUpdate = true;
    this._geometry.attributes.size.needsUpdate     = true;
    this._geometry.attributes.opacity.needsUpdate  = true;
    this._geometry.attributes.rotation.needsUpdate = true;
    this._geometry.attributes.uvOffset.needsUpdate = true;
    this._geometry.attributes.uvScale.needsUpdate  = true;

    // White mist puffs (NEW)
    if (this._mistGeometry) {
      for (let i = 0; i < MIST_PARTICLE_COUNT; i++) {
        if (this._mistAge[i] >= this._mistLifetime[i]) {
          this._mistSizes[i]     = 0;
          this._mistOpacities[i] = 0;
          continue;
        }
        this._mistAge[i] += dt;
        const t = this._mistAge[i] / this._mistLifetime[i];

        this._mistPositions[i * 3 + 0] += this._mistVelocities[i].x * dt;
        this._mistPositions[i * 3 + 1] += this._mistVelocities[i].y * dt;
        this._mistPositions[i * 3 + 2] += this._mistVelocities[i].z * dt;
        this._mistVelocities[i].y -= 0.4 * dt; // gentle settle, not a hard fall like droplets
        this._mistVelocities[i].multiplyScalar(1 - dt * 1.2);
        this._mistRotations[i] += dt * (0.15 + (i % 4) * 0.08);
        this._mistSizes[i] = THREE.MathUtils.lerp(4, 12, Math.min(t * 2.5, 1.0));
        this._mistOpacities[i] = t < 0.1
          ? t / 0.1
          : (1.0 - (t - 0.1) / 0.9) * 0.5;
      }

      this._mistGeometry.attributes.position.needsUpdate = true;
      this._mistGeometry.attributes.size.needsUpdate     = true;
      this._mistGeometry.attributes.opacity.needsUpdate  = true;
      this._mistGeometry.attributes.rotation.needsUpdate = true;
    }
  }

  stop() {
    this._active = false;
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
      this.points = null;
    }
    if (this.mistPoints) {
      this.scene.remove(this.mistPoints);
      this.mistPoints.geometry.dispose();
      this.mistPoints.material.dispose();
      this.mistPoints = null;
    }
    if (this.anchor?.parent) this.anchor.parent.remove(this.anchor);
  }
}