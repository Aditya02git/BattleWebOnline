// prop.js — Breakable props loaded from Prop_N meshes inside houses.glb.
// Same interaction model as the old FenceSystem: fully instanced (ONE
// draw call for all props), no Rapier colliders, purely visual +
// proximity-triggered. When a tank (player/enemy/friendly) gets within
// PROP_TRIGGER_RADIUS of a prop's position, that prop's instance is
// hidden (zero-scaled) and a short particle burst plays at its position.

import * as THREE from 'three';

const PROP_TRIGGER_RADIUS    = 2.0;  // metres — distance at which a tank breaks a prop
const PROP_TRIGGER_RADIUS_SQ = PROP_TRIGGER_RADIUS * PROP_TRIGGER_RADIUS;
const PARTICLE_LIFETIME      = 0.35; // seconds — how long a break burst is visible
const PARTICLE_COUNT         = 5;

// ── Shared scratch objects — reused across all matrix builds, zero
// per-prop allocation ────────────────────────────────────────────────────
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0); // collapses an instance to nothing

export class PropSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {Array<{mesh: THREE.Mesh, matrixWorld: THREE.Matrix4}>} propDefs
   *   - one entry per Prop_N mesh found while loading houses.glb. `mesh` is
   *     used to source geometry/material (per unique geometry — see below);
   *     `matrixWorld` is that specific instance's placement.
   * @param {object} opts
   * @param {number} [opts.triggerRadius]
   * @param {number} [opts.missingChance] - chance a prop starts pre-broken
   */
  constructor(scene, propDefs, opts = {}) {
    this.scene = scene;
    const triggerRadius = opts.triggerRadius ?? PROP_TRIGGER_RADIUS;
    this._triggerRadiusSq = triggerRadius * triggerRadius;
    this._missingChance = opts.missingChance ?? 0;

    // { x, y, z, alive, index, meshGroupIndex }
    this._props = [];
    this._bursts = [];
    this._dirty = new Set(); // meshGroupIndex values needing an instanceMatrix flush this frame

    // ── Group props by their source geometry+material, since each
    // distinct Prop mesh "type" (e.g. a barrel vs a crate) needs its own
    // InstancedMesh — but every prop sharing the same geometry/material
    // batches into ONE draw call regardless of how many there are. ───────
    this._meshGroups = []; // { geometry, material, instancedMesh, propIndices: [] }
    const groupByGeometry = new Map(); // geometry -> group index

    for (const def of propDefs) {
      const geo = def.mesh.geometry;
      let groupIdx = groupByGeometry.get(geo);
      if (groupIdx === undefined) {
        groupIdx = this._meshGroups.length;
        groupByGeometry.set(geo, groupIdx);
        this._meshGroups.push({
          geometry: geo,
          material: def.mesh.material,
          instancedMesh: null,
          propIndices: [],
        });
      }

      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      def.matrixWorld.decompose(pos, quat, scale);

      const propIndex = this._props.length;
      this._props.push({
        x: pos.x,
        y: pos.y,
        z: pos.z,
        matrix: def.matrixWorld.clone(),
        alive: true,
        index: -1, // instance index within its own group's InstancedMesh
        groupIndex: groupIdx,
      });
      this._meshGroups[groupIdx].propIndices.push(propIndex);
    }

    // ── Randomly pre-break some props for a naturally weathered look ─────
    if (this._missingChance > 0) {
      for (const prop of this._props) {
        if (Math.random() < this._missingChance) prop.alive = false;
      }
    }

    // ── Build one InstancedMesh per geometry group ────────────────────────
    for (const group of this._meshGroups) {
      const count = Math.max(1, group.propIndices.length);
      const instancedMesh = new THREE.InstancedMesh(group.geometry, group.material, count);
      instancedMesh.castShadow = true;
      instancedMesh.receiveShadow = true;
      instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      instancedMesh.count = group.propIndices.length;

      group.propIndices.forEach((propIndex, i) => {
        const prop = this._props[propIndex];
        prop.index = i;
        if (prop.alive) {
          instancedMesh.setMatrixAt(i, prop.matrix);
        } else {
          instancedMesh.setMatrixAt(i, _zeroMatrix);
        }
      });
      instancedMesh.instanceMatrix.needsUpdate = true;
      if (group.propIndices.length) instancedMesh.computeBoundingSphere();

      group.instancedMesh = instancedMesh;
      this.scene.add(instancedMesh);
    }

    // ── Shared particle sprite material (simple dots, matches old fence look) ──
    this._particleMat = new THREE.PointsMaterial({
      color: 0x8a8378,
      size: 0.5,
      transparent: false,
      opacity: 1,
      depthWrite: false,
    });
  }

  _spawnBurst(x, y, z) {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const velocities = [];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 2.0;
      velocities.push({
        x: Math.cos(angle) * speed,
        y: 2.0 + Math.random() * 3.0,
        z: Math.sin(angle) * speed,
      });
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = this._particleMat.clone();
    const points = new THREE.Points(geo, material);
    this.scene.add(points);

    this._bursts.push({ points, geo, material, velocities, life: 0 });
  }

  /**
   * Per-frame: check tank proximity against every alive prop's position,
   * break on contact, tick particle bursts, flush dirty instance buffers.
   * @param {number} dt
   * @param {Array<{x:number,y:number,z:number}>} tankPositions
   */
  update(dt, tankPositions) {
    if (tankPositions && tankPositions.length) {
      for (const prop of this._props) {
        if (!prop.alive) continue;
        for (let i = 0; i < tankPositions.length; i++) {
          const tp = tankPositions[i];
          if (!tp) continue;
          const dx = tp.x - prop.x;
          const dz = tp.z - prop.z;
          if (dx * dx + dz * dz < this._triggerRadiusSq) {
            this._breakProp(prop);
            break;
          }
        }
      }
    }

    // ── Flush instance matrix updates once per frame, per dirty group ────
    if (this._dirty.size) {
      for (const groupIndex of this._dirty) {
        this._meshGroups[groupIndex].instancedMesh.instanceMatrix.needsUpdate = true;
      }
      this._dirty.clear();
    }

    // ── Tick active particle bursts ───────────────────────────────────────
    for (let i = this._bursts.length - 1; i >= 0; i--) {
      const b = this._bursts[i];
      b.life += dt;

      const posAttr = b.geo.getAttribute('position');
      for (let p = 0; p < PARTICLE_COUNT; p++) {
        const v = b.velocities[p];
        posAttr.array[p * 3 + 0] += v.x * dt;
        posAttr.array[p * 3 + 1] += v.y * dt;
        posAttr.array[p * 3 + 2] += v.z * dt;
        v.y -= 9.8 * dt; // gravity
      }
      posAttr.needsUpdate = true;

      b.material.opacity = Math.max(0, 1 - b.life / PARTICLE_LIFETIME);

      if (b.life >= PARTICLE_LIFETIME) {
        this.scene.remove(b.points);
        b.geo.dispose();
        b.material.dispose();
        this._bursts.splice(i, 1);
      }
    }
  }

  _breakProp(prop) {
    if (!prop.alive) return;
    prop.alive = false;
    const group = this._meshGroups[prop.groupIndex];
    group.instancedMesh.setMatrixAt(prop.index, _zeroMatrix);
    this._dirty.add(prop.groupIndex);
    this._spawnBurst(prop.x, prop.y, prop.z);
  }

  dispose() {
    for (const group of this._meshGroups) {
      this.scene.remove(group.instancedMesh);
      // NOTE: geometry/material are owned by the loaded GLB (shared with
      // the original Prop_N meshes' resources) — do NOT dispose them here,
      // since main.js's scene.clear() / normal GLTF cleanup already owns
      // that lifecycle. Only the InstancedMesh wrapper itself is removed.
    }
    this._meshGroups.length = 0;
    this._props.length = 0;

    for (const b of this._bursts) {
      this.scene.remove(b.points);
      b.geo.dispose();
      b.material.dispose();
    }
    this._bursts.length = 0;
    this._particleMat.dispose();
  }
}