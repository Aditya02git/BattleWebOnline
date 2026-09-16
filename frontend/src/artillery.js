// artillery.js — Call-in artillery strike system
//
// Replaces APSSystem. Player aims at a point on the terrain; on click, a
// barrage of N shells lands within a radius of that point, staggered over
// a few seconds. Each shell is visually spawned high in the sky and falls
// down to its impact point, then deals damage to any tank caught within
// its blast radius and spawns a shell-hit visual via ExplosionSystem.
//
// Usage (see main.js wiring):
//   const artillery = new ArtillerySystem(scene, explosionSystem);
//   artillery.fire(targetWorldPos);     // call once, on confirmed click
//   artillery.update(dt, allTanks);     // call every frame, allTanks = [player, ...enemies]

import * as THREE from 'three';

const SHELL_COUNT      = 15;     // shells per barrage
const BARRAGE_DURATION = 15.0;   // seconds — spread of impact times
const STRIKE_RADIUS_DEFAULT = 25.0;   // metres — scatter radius around target point (tightened so more shells connect)
const BLAST_RADIUS_DEFAULT  = 26.0;   // metres — damage radius per shell impact (larger than scatter radius on purpose)
const BLAST_DAMAGE_DEFAULT  = 90;     // damage at blast center (falls off with distance)
const MIN_DAMAGE_FRAC       = 0.3;    // damage multiplier at the edge of blast radius

// ── Falling shell visual tuning ─────────────────────────────────────────────
const FALL_HEIGHT   = 150;   // metres — how high above the impact point shells start
const FALL_DURATION = 1.1;  // seconds — time spent visibly falling before impact
const SHELL_RADIUS  = 0.1;
const SHELL_LENGTH  = 3;

// ── Falling shell mesh (pooled InstancedMesh, same style as bullet.js) ─────
const _shellGeo = new THREE.CylinderGeometry(
  SHELL_RADIUS * 0.5, SHELL_RADIUS, SHELL_LENGTH, 7, 1
);
_shellGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));

const _shellMat = new THREE.MeshStandardMaterial({
  color:     0x222222,
  emissive:  0x554433,
  emissiveIntensity: 1.5,
  metalness: 0.3,
  roughness: 0.5,
  fog:       false,
});

const _shellDummy  = new THREE.Object3D();
const _zeroMatrix  = new THREE.Matrix4().makeScale(0, 0, 0);
const _fallDir     = new THREE.Vector3(0, -1, 0); // straight down
const _shellFwd    = new THREE.Vector3(0, 0, 1);
const _fallQuat    = new THREE.Quaternion().setFromUnitVectors(_shellFwd, _fallDir);

const _tankPos = new THREE.Vector3();
const _diff    = new THREE.Vector3();

export class ArtillerySystem {
  constructor(scene, explosionSystem, options = {}) {
    this.scene           = scene;
    this.explosionSystem = explosionSystem;

    // ── Research-upgradeable stats ──────────────────────────────────────
    this.strikeRadius = options.strikeRadius ?? STRIKE_RADIUS_DEFAULT;
    this.blastRadius  = options.blastRadius  ?? BLAST_RADIUS_DEFAULT;
    this.blastDamage  = options.blastDamage  ?? BLAST_DAMAGE_DEFAULT;

    // Pending shells: flat arrays, no per-shell object allocation
    this._px      = new Float32Array(SHELL_COUNT); // impact point X
    this._py      = new Float32Array(SHELL_COUNT); // impact point Y (ground)
    this._pz      = new Float32Array(SHELL_COUNT); // impact point Z
    this._timer   = new Float32Array(SHELL_COUNT).fill(-1); // -1 = inactive; counts down to impact
    this._pending = 0; // count of shells still waiting to land

    // Called once per fire() call — hook up to play an "incoming" sound
    this.onFire = null;

    // ── Falling shell visual pool ─────────────────────────────────────────
    this._shellMesh               = new THREE.InstancedMesh(_shellGeo, _shellMat, SHELL_COUNT);
    this._shellMesh.frustumCulled = false;
    this._shellMesh.castShadow    = false;
    this._shellMesh.count         = 0;
    this._shellMesh.visible       = false;
    scene.add(this._shellMesh);

    // Whether slot i currently has a visible falling shell
    this._visActive = new Uint8Array(SHELL_COUNT);

    // Called once per shell, at the moment it starts its visible fall
    this.onShellFall = null;
  }

  /**
   * Trigger a barrage centered on targetPos (world-space ground point).
   * Safe to call again before the previous barrage finishes — any shells
   * still pending from a prior call keep ticking independently.
   *
   * @param {THREE.Vector3} targetPos
   */
  fire(targetPos) {
    if (!targetPos) return;

    for (let i = 0; i < SHELL_COUNT; i++) {
      if (this._timer[i] >= 0) continue; // slot busy — skip (rare, only if spamming)

      const theta = Math.random() * Math.PI * 2;
      const r     = Math.random() * this.strikeRadius;

      this._px[i] = targetPos.x + Math.cos(theta) * r;
      this._py[i] = targetPos.y;
      this._pz[i] = targetPos.z + Math.sin(theta) * r;

      // Stagger impacts across the barrage duration.
      // Ensure every shell has at least FALL_DURATION seconds left so the
      // falling-shell visual always has time to play before impact.
      this._timer[i] = FALL_DURATION + Math.random() * Math.max(0, BARRAGE_DURATION - FALL_DURATION);
      this._pending++;
    }
  }

  /**
   * Call every frame.
   * @param {number} dt
   * @param {Array}  tanks — list of tank-like objects with .rigidBody, .isDead, .takeDamage(amount)
   */
  update(dt, tanks = []) {
    if (this._pending === 0) {
      if (this._shellMesh.visible) this._shellMesh.visible = false;
      return;
    }

    let meshDirty  = false;

    for (let i = 0; i < SHELL_COUNT; i++) {
      if (this._timer[i] < 0) continue;

      this._timer[i] -= dt;

      // ── Falling visual: active for the last FALL_DURATION seconds ────────
      if (this._timer[i] > 0 && this._timer[i] <= FALL_DURATION) {
        const fallT = 1 - (this._timer[i] / FALL_DURATION); // 0 at spawn → 1 at impact
        const y     = this._py[i] + FALL_HEIGHT * (1 - fallT);

        _shellDummy.position.set(this._px[i], y, this._pz[i]);
        _shellDummy.quaternion.copy(_fallQuat);
        _shellDummy.scale.setScalar(1);
        _shellDummy.updateMatrix();

        this._shellMesh.setMatrixAt(i, _shellDummy.matrix);

        // ── Rising edge: this shell just started falling this frame ────────
        if (!this._visActive[i]) {
          this.onShellFall?.();
        }

        this._visActive[i] = 1;
        meshDirty = true;
      } else if (this._visActive[i]) {
        // Not yet falling, or already impacted — ensure it's hidden
        this._shellMesh.setMatrixAt(i, _zeroMatrix);
        this._visActive[i] = 0;
        meshDirty = true;
      }

      if (this._timer[i] > 0) continue;

      // ── Shell impact ──────────────────────────────────────────────────
      this._timer[i] = -1;
      this._pending--;

      if (this._visActive[i]) {
        this._shellMesh.setMatrixAt(i, _zeroMatrix);
        this._visActive[i] = 0;
        meshDirty = true;
      }

      const ix = this._px[i];
      const iy = this._py[i];
      const iz = this._pz[i];

      for (let t = 0; t < tanks.length; t++) {
        const tank = tanks[t];
        if (!tank || tank.isDead || !tank.rigidBody) continue;

        const p = tank.rigidBody.translation();
        _diff.set(p.x - ix, p.y - iy, p.z - iz);
        const dist = _diff.length();
        if (dist > this.blastRadius) continue;

        const falloff = 1 - (dist / this.blastRadius) * (1 - MIN_DAMAGE_FRAC);
        const damage  = this.blastDamage * Math.max(MIN_DAMAGE_FRAC, falloff);
        tank.takeDamage(damage);
      }

      _tankPos.set(ix, iy, iz);
      this.explosionSystem?.spawnShellHit(_tankPos);
      this.onHit?.(_tankPos.clone());
    }

    if (meshDirty) {
      let trueMax = 0;
      for (let i = 0; i < SHELL_COUNT; i++) {
        if (this._visActive[i]) trueMax = i + 1;
      }
      this._shellMesh.count = trueMax;
      this._shellMesh.visible = trueMax > 0;
      this._shellMesh.instanceMatrix.needsUpdate = true;
    }
  }

  setBlastDamage(v)  { this.blastDamage  = v; }
  setStrikeRadius(v) { this.strikeRadius = v; }
  setBlastRadius(v)  { this.blastRadius  = v; }

  dispose() {
    this._timer.fill(-1);
    this._visActive.fill(0);
    this._pending = 0;
    this._shellMesh.visible = false;
    this._shellMesh.geometry.dispose();
    this._shellMesh.material.dispose();
    this._shellMesh.removeFromParent();
  }
}