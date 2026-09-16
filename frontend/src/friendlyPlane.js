// friendlyPlane.js — Friendly AI fighter plane: same flight/attack FSM as
// EnemyPlane, but targets/fights enemy tanks + enemy planes instead of the
// player. Mirrors friendlyTank.js's relationship to enemyTank.js exactly.

import { EnemyPlane, EnemyPlanePool, PLANE_STATE } from './enemyPlane.js';
import * as THREE from 'three';

// ── Shared shield-marker sprite material — built once, reused by every
// FriendlyPlane instance. A Sprite is inherently camera-facing (billboarded
// on the GPU), so there is zero per-frame JS cost to keep it oriented —
// unlike a plane/mesh billboard, which would need a manual lookAt() each
// frame. Position updates are free too, since the sprite is a child of
// bodyGroup and rides along with the normal scene-graph transform update.
let _sharedShieldTexture  = null;
let _sharedShieldMaterial = null;

function _getSharedShieldMaterial() {
  if (_sharedShieldMaterial) return _sharedShieldMaterial;

  // Procedural 64x64 canvas icon — small, generated once, never touched
  // again. Avoids an extra network request / GLB dependency for a single
  // small marker icon.
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);

  // Shield outline path
  ctx.beginPath();
  ctx.moveTo(0, -22);
  ctx.bezierCurveTo(10, -18, 18, -14, 18, -6);
  ctx.bezierCurveTo(18, 8, 10, 18, 0, 24);
  ctx.bezierCurveTo(-10, 18, -18, 8, -18, -6);
  ctx.bezierCurveTo(-18, -14, -10, -18, 0, -22);
  ctx.closePath();

  ctx.fillStyle = 'rgba(68,170,255,0.85)';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(220,240,255,0.95)';
  ctx.stroke();

  // Simple checkmark inside, same idea as a "friendly/protected" glyph
  ctx.beginPath();
  ctx.moveTo(-7, 0);
  ctx.lineTo(-2, 6);
  ctx.lineTo(9, -8);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  _sharedShieldTexture = new THREE.CanvasTexture(canvas);
  _sharedShieldTexture.colorSpace = THREE.SRGBColorSpace;

  _sharedShieldMaterial = new THREE.SpriteMaterial({
    map: _sharedShieldTexture,
    transparent: true,
    depthWrite: false,   // avoid z-fighting/occlusion artifacts against the plane's own mesh
    sizeAttenuation: true,
  });

  return _sharedShieldMaterial;
}

export class FriendlyPlane extends EnemyPlane {
  constructor(scene, world) {
    super(scene, world);
    this.isFriendly = true;

    // ── Shield marker sprite — one per instance (Sprite objects can't be
    // shared across multiple scene-graph parents), but the material/texture
    // behind it IS shared (see _getSharedShieldMaterial above), so this
    // only costs one small object + one draw call per active friendly plane.
    this._shieldMarker = new THREE.Sprite(_getSharedShieldMaterial());
    this._shieldMarker.scale.set(1.4, 1.4, 1.4);
    this._shieldMarker.position.set(0, 2.4, 0); // sits just above the plane's hull
    this._shieldMarker.renderOrder = 5;
    this.bodyGroup.add(this._shieldMarker);
  }

  destroyPermanently() {
    if (this._shieldMarker) {
      this.bodyGroup.remove(this._shieldMarker);
      // NOTE: do not dispose _sharedShieldMaterial/_sharedShieldTexture here —
      // they're shared across every FriendlyPlane instance in the pool.
      this._shieldMarker = null;
    }
    super.destroyPermanently();
  }

  /**
   * Override: friendlies fight the nearest active ENEMY (tank or plane),
   * never the player. Signature matches EnemyPlane._findCombatTarget(pos,
   * playerPos, playerRigidBody, extraTargets) — `extraTargets` here is the
   * combined enemy tank+plane array passed in by FriendlyPlanePool.update().
   */
  _findCombatTarget(pos, playerPos, playerRigidBody, enemyTargets) {
    let best = null;
    let bestDistSq = Infinity;

    if (pos && enemyTargets && enemyTargets.length) {
      for (let i = 0; i < enemyTargets.length; i++) {
        const t = enemyTargets[i];
        if (!t.active || t.isDead) continue;
        const tp = t._cachedPos;
        if (!tp) continue;
        const dx = tp.x - pos.x, dy = tp.y - pos.y, dz = tp.z - pos.z;
        const dsq = dx * dx + dy * dy + dz * dz;
        if (dsq < bestDistSq) { bestDistSq = dsq; best = t; }
      }
    }

    if (!best) {
      this._scratchFarTarget = this._scratchFarTarget || { x: 0, y: 0, z: 0 };
      this._scratchFarTarget.x = playerPos.x + 1e6;
      this._scratchFarTarget.y = playerPos.y;
      this._scratchFarTarget.z = playerPos.z;
      return { pos: this._scratchFarTarget, rigidBody: null, isPlayer: false, tankRef: null };
    }

    return { pos: best._cachedPos, rigidBody: best.rigidBody, isPlayer: false, tankRef: best };
  }
}

// ── FriendlyPlanePool ────────────────────────────────────────────────────────
// Identical to EnemyPlanePool (same spawn/FSM/update logic via inheritance)
// except:
//   - creates FriendlyPlane instead of EnemyPlane
//   - passes the live enemy tank+plane list into each plane's update() so
//     _findCombatTarget() above has something to search
//   - onHitPlayer here receives (damage, combatTarget, dist, attackerPos)
//     where combatTarget.tankRef is the actual EnemyTank/EnemyPlane hit —
//     main.js's callback should route damage to combatTarget.tankRef.takeDamage(),
//     same pattern already used for FriendlyTankPool's onHitPlayer.

export class FriendlyPlanePool extends EnemyPlanePool {
  constructor(scene, world, terrain, opts = {}) {
    super(scene, world, terrain, opts);

    this._pool = Array.from({ length: this.maxPlanes }, () => new FriendlyPlane(scene, world));

    // Reference to the enemy plane pool + enemy tank pool — supplies the
    // target list every frame (set via setEnemyPool/setEnemyTankPool since
    // those pools are constructed after this one in main.js).
    this._enemyPoolRef     = opts.enemyPool     ?? null;
    this._enemyTankPoolRef = opts.enemyTankPool ?? null;
  }

  setEnemyPool(enemyPlanePool) {
    this._enemyPoolRef = enemyPlanePool;
  }

  setEnemyTankPool(enemyTankPool) {
    this._enemyTankPoolRef = enemyTankPool;
  }

  // ── Grow the pool's cap at runtime (used for the squad "flex" friendly
  // slot — see confirmSpawnSelection() in main.js). Only ever grows; never
  // shrinks, since removing already-active planes mid-match would be far
  // more disruptive than just leaving a spare inactive slot unused. ────────
  setMaxPlanes(newMax) {
    if (newMax > this.maxPlanes) {
      const toAdd = newMax - this.maxPlanes;
      for (let i = 0; i < toAdd; i++) {
        this._pool.push(new FriendlyPlane(this.scene, this.world));
      }
    }
    // See setMaxTanks() in friendlyTank.js for why shrinking is safe.
    this.maxPlanes = newMax;
  }

  update(dt, playerPos) {
    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = this._spawnInterval;
      this.trySpawn();
    }

    const activePlanes = this.getActiveTanks();
    const playerRigidBody = this.playerVehicle?.rigidBody ?? null;

    const enemyPlanes = this._enemyPoolRef?.getActiveTanks() ?? [];
    const enemyTanks  = this._enemyTankPoolRef?.getActiveTanks() ?? [];
    this._combinedTargets = this._combinedTargets ?? [];
    this._combinedTargets.length = 0;
    for (const p of enemyPlanes) this._combinedTargets.push(p);
    for (const t of enemyTanks)  this._combinedTargets.push(t);

    for (const plane of activePlanes) {
      plane.update(
        dt, playerPos,
        this.onMuzzleFlash,
        this.onHitPlayer,
        this._audioSystem,
        playerRigidBody,
        this._combinedTargets,
        this.getTerrainY
      );

      if (plane.rigidBody) {
        const p = plane._cachedPos ?? plane.rigidBody.translation();
        const halfSize = this.terrain.worldSize / 2 + 60;
        if (Math.abs(p.x) > halfSize || Math.abs(p.z) > halfSize || p.y < -50 || p.y > 800) {
          plane.deactivate();
        }
      }
    }

    const MIN_SEP_DIST = 18;
    for (let i = 0; i < activePlanes.length; i++) {
      for (let j = i + 1; j < activePlanes.length; j++) {
        const a = activePlanes[i], b = activePlanes[j];
        if (!a.rigidBody || !b.rigidBody) continue;
        const pa = a.rigidBody.translation(), pb = b.rigidBody.translation();
        const dx = pa.x - pb.x, dy = pa.y - pb.y, dz = pa.z - pb.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const minDistSq = MIN_SEP_DIST * MIN_SEP_DIST;
        if (distSq < minDistSq && distSq > 0.001) {
          const dist = Math.sqrt(distSq);
          const factor = (MIN_SEP_DIST - dist) / MIN_SEP_DIST;
          const fx = (dx / dist) * factor * 4, fy = (dy / dist) * factor * 4, fz = (dz / dist) * factor * 4;
          const av = a.rigidBody.linvel(), bv = b.rigidBody.linvel();
          a.rigidBody.setLinvel({ x: av.x + fx, y: av.y + fy, z: av.z + fz }, true);
          b.rigidBody.setLinvel({ x: bv.x - fx, y: bv.y - fy, z: bv.z - fz }, true);
        }
      }
    }
  }
}