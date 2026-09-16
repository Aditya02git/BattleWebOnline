// tankSmoke.js — Custom smoke using cloud texture, zero external dependencies

import * as THREE from 'three';

const PARTICLE_COUNT = 20;
const TEXTURE_URL = '/textures/cloud.png';

function createSmokeSystem(scene, texture) {
  // ── Geometry ──────────────────────────────────────────────────────────────
  const positions  = new Float32Array(PARTICLE_COUNT * 3);
  const sizes      = new Float32Array(PARTICLE_COUNT);
  const opacities  = new Float32Array(PARTICLE_COUNT);
  const rotations  = new Float32Array(PARTICLE_COUNT);  // per-particle spin
  const ages       = new Float32Array(PARTICLE_COUNT);
  const lifetimes  = new Float32Array(PARTICLE_COUNT);
  const velocities = [];

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    ages[i]       = Math.random();
    lifetimes[i]  = 0.2 + Math.random() * 0.4;
    sizes[i]      = 0;
    opacities[i]  = 0;
    rotations[i]  = Math.random() * Math.PI * 2;
    velocities.push(new THREE.Vector3());
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('size',     new THREE.BufferAttribute(sizes,     1));
  geometry.setAttribute('opacity',  new THREE.BufferAttribute(opacities, 1));
  geometry.setAttribute('rotation', new THREE.BufferAttribute(rotations, 1));

  // ── Shader material ───────────────────────────────────────────────────────
  const material = new THREE.ShaderMaterial({
    uniforms: {
      map:   { value: texture },
      color: { value: new THREE.Color(0x242019) },
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
        gl_PointSize = size * (300.0 / -mvPosition.z);
        gl_Position  = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D map;
      uniform vec3 color;
      varying float vOpacity;
      varying float vRotation;

      void main() {
        // Rotate UV around centre of point sprite
        vec2 uv = gl_PointCoord - 0.5;
        float s = sin(vRotation);
        float c = cos(vRotation);
        uv = vec2(c * uv.x - s * uv.y,
                  s * uv.x + c * uv.y) + 0.5;

        vec4 tex = texture2D(map, uv);

        // Tint + opacity
        gl_FragColor = vec4(color * tex.rgb, tex.a * vOpacity);

        if (gl_FragColor.a < 0.01) discard;
      }
    `,
    transparent:  true,
    depthWrite:   false,
    depthTest:    true,
    blending:     THREE.NormalBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.layers.set(1);
  points.renderOrder = 5;
  scene.add(points);

  return {
    points, geometry, material,
    positions, sizes, opacities, rotations,
    ages, lifetimes, velocities,
  };
}

// ── Reset a single particle back to the emitter ───────────────────────────────

function resetParticle(i, emitterWorldPos, emitterWorldQuat, state, boost = 0) {
  const { positions, sizes, opacities, ages, lifetimes, rotations, velocities } = state;

  positions[i * 3 + 0] = emitterWorldPos.x + (Math.random() - 0.5) * 0.05;
  positions[i * 3 + 1] = emitterWorldPos.y + (Math.random() - 0.5) * 0.05;
  positions[i * 3 + 2] = emitterWorldPos.z + (Math.random() - 0.5) * 0.05;

  // Velocity: upward in emitter local space + small random spread.
  // boost (0..~1.5+) scales the upward speed and spread so a rev boost
  // makes the plume shoot up harder, not just bigger.
  const upSpeed   = 0.1 + Math.random() * 0.5;
  const boostMult = 1.0 + boost * 5.0;   // ← stronger vertical kick under boost
  const localVel = new THREE.Vector3(
    (Math.random() - 0.5) * 0.3 * (1.0 + boost * 0.8),
    upSpeed * boostMult,
    (Math.random() - 0.5) * 0.3 * (1.0 + boost * 0.8),
  ).applyQuaternion(emitterWorldQuat);

  velocities[i].copy(localVel);

  ages[i]       = 0;
  // Much shorter lifetime under boost — particles cycle through the pool
  // faster, which reads as a HIGHER SMOKE RATE (more puffs per second)
  // since PARTICLE_COUNT is fixed and rate is really "how often each slot
  // gets recycled."
  lifetimes[i]  = (0.8 + Math.random() * 0.8) * (1.0 - boost * 0.65);
  sizes[i]      = 0;
  opacities[i]  = 0;
  rotations[i]  = Math.random() * Math.PI * 2;
}

// ── Public class ──────────────────────────────────────────────────────────────

export class TankSmoke {
  constructor(scene, smokeNodes) {
    this.scene     = scene;
    this.nodes     = smokeNodes;
    this._active   = false;
    this._emitters = [];
    this._wp       = new THREE.Vector3();
    this._wq       = new THREE.Quaternion();

    // ── Idle-rev smoke boost — 0 = normal, higher = faster/taller plume.
    // Driven externally each frame via setRevBoost(); decays back to 0
    // on its own so callers only need to push it up while the condition
    // (idle + WASD pressed) is true.
    this._revBoost       = 0;
    this._revBoostTarget = 0;

    this._init();
  }

  async _init() {
    if (!this.nodes || this.nodes.length === 0) {
      console.warn('[TankSmoke] No smoke nodes.');
      return;
    }

    // Load texture ONCE, share across all emitters
    const texture = await new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(TEXTURE_URL, resolve, undefined, reject);
    });

    // Prevent WebGL from treating it as immutable after first upload
    texture.needsUpdate = true;

    for (const node of this.nodes) {
      // Clone so each emitter gets its own texture object — avoids immutability conflict
      const tex = texture.clone();
      tex.needsUpdate = true;

      const state = createSmokeSystem(this.scene, tex);

      // Pre-scatter so smoke is visible immediately
      node.getWorldPosition(this._wp);
      node.getWorldQuaternion(this._wq);
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        resetParticle(i, this._wp, this._wq, state);
        state.ages[i] = Math.random() * state.lifetimes[i];
      }

      this._emitters.push({ node, state });
      // console.log(`[TankSmoke] ✅ "${node.name}" cloud emitter ready`);
    }

    this._active = true;
  }

  setVisible(visible) {
    for (const { state } of this._emitters) {
      state.points.visible = visible;
    }
  }

  // Call every frame with true/false — true while the tank is idle (speed
  // ≈ 0) AND a drive key is held. Internally ramps a smoothed boost value
  // up fast and decays it back down, so callers don't need their own timer.
  setRevBoost(active) {
    this._revBoostTarget = active ? 1.0 : 0.0;
  }

  update(dt) {
    if (!this._active) return;

    // Accept plain dt number OR cycleData object
    const delta = (typeof dt === 'object' && dt !== null)
      ? (dt.delta ?? 0.016)
      : (dt        ?? 0.016);

    // ── Ramp the boost value toward its target ─────────────────────────────
    // Fast attack (revs up quickly when you press a key at idle), slower
    // release (eases back down to normal instead of snapping).
    const RAMP_UP_SPEED   = 12.0;   // higher = snappier rev-up
    const RAMP_DOWN_SPEED = 1.5;   // lower = slower settle back to normal
    const rampSpeed = this._revBoostTarget > this._revBoost ? RAMP_UP_SPEED : RAMP_DOWN_SPEED;
    this._revBoost = THREE.MathUtils.lerp(
      this._revBoost,
      this._revBoostTarget,
      Math.min(1, delta * rampSpeed)
    );

    const boost = this._revBoost;

    for (const { node, state } of this._emitters) {
      const {
        positions, sizes, opacities, rotations,
        ages, lifetimes, velocities, geometry,
      } = state;

      node.getWorldPosition(this._wp);
      node.getWorldQuaternion(this._wq);

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        ages[i] += delta;

        if (ages[i] >= lifetimes[i]) {
          resetParticle(i, this._wp, this._wq, state, boost);
          continue;
        }

        const t = ages[i] / lifetimes[i];   // 0 → 1

        // Translate
        positions[i * 3 + 0] += velocities[i].x * delta;
        positions[i * 3 + 1] += velocities[i].y * delta;
        positions[i * 3 + 2] += velocities[i].z * delta;

        // Drag — lighter while boosted so the plume actually climbs before
        // decelerating, instead of shooting up and instantly stalling.
        const dragRate = 1.2 - boost * 0.7;   // as low as ~0.5 at full boost
        velocities[i].multiplyScalar(1 - delta * dragRate);

        // Spin slowly over lifetime
        rotations[i] += delta * (0.3 + (i % 3) * 0.15);

        // Size: grow from tiny → large (slightly bigger peak under boost)
        sizes[i] = THREE.MathUtils.lerp(0.1, 1.5 + boost * 0.6, Math.min(t * 2.5, 1.0));

        // Opacity: quick fade-in, slow fade-out
        if (t < 0.1) {
          opacities[i] = t / 0.1;
        } else {
          opacities[i] = 1.0 - ((t - 0.1) / 0.9);
        }
        opacities[i] *= 0.6;
      }

      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.size.needsUpdate     = true;
      geometry.attributes.opacity.needsUpdate  = true;
      geometry.attributes.rotation.needsUpdate = true;
    }
  }

  stop() {
    this._active = false;
    for (const { state } of this._emitters) {
      this.scene.remove(state.points);
      state.geometry.dispose();
      state.material.dispose();
    }
    this._emitters = [];
  }
}