// bomb.js — Free-fall bombs (plane weapon slot 3).
//
// Same pooling/visual pattern as rocket.js and ProjectileBulletSystem in
// bullet.js: flat typed arrays for per-bomb state, an InstancedMesh visual,
// per-frame prev→curr segment raycast against the Rapier world to detect
// ground/tank impact, then an area-of-effect damage sweep on impact.
//
// Public surface expected by plane.js:
//   setDropPoint(node)       — THREE.Object3D world-space bomb-bay point
//   isReady                  — getter: not reloading + has a drop point
//   drop(rigidBody, velocity, enemyResolver)
//   update(dt)
//   dispose()

import * as THREE from 'three';

const BOMB_MAX      = 6;     // simultaneous falling bombs
const BOMB_LIFETIME = 10.0;  // safety despawn if nothing is ever hit

const BOMB_RADIUS = 0.14;   // kept for reference — see BOMB_GEO_SCALE below
const BOMB_LENGTH = 0.55;   // kept for reference — see BOMB_GEO_SCALE below

// ── Bomb body geometry parameters (ported from the capsule-geo prototype) ──
const BOMB_GEO = {
  r1: 0.60,   // big-end (tail) radius
  r2: 0.30,   // small-end (nose) radius
  bodyLength: 1.60,
  radialSegments: 8,
  capSegments: 2,
  finWidth: 1.00,
  finBase: 0.35,
  finTaper: 0.45,
  finThickness: 0.06,
  finEmbed: 0.08,
  finLift: 0.75,
  guardRadius: 0.55,
  guardWall: 0.05,
  guardHeight: 0.34,
  guardOffsetY: -0.17,
};

// Raw geometry above is built at "prototype scale" (r1 = 0.6). Scale it down
// so the final bomb footprint matches the old capsule's radius (BOMB_RADIUS).
// Tweak the divisor (BOMB_GEO.r1) if you want the new shape bigger/smaller
// relative to the old one.
const BOMB_GEO_SCALE = BOMB_RADIUS / BOMB_GEO.r1;

// ── Geometry builders (ported 1:1 from the prototype) ──────────────────────

function _buildAsymmetricCapsuleGeometry(r1, r2, bodyLength, radialSegments, capSegments) {
  const points = [];
  const bottomCenterY = -bodyLength / 2;
  const topCenterY = bodyLength / 2;

  for (let i = 0; i <= capSegments; i++) {
    const t = i / capSegments;
    const px = r1 * Math.sin(t * Math.PI / 2);
    const py = bottomCenterY - r1 * Math.cos(t * Math.PI / 2);
    points.push(new THREE.Vector2(Math.max(px, 0.0001), py));
  }

  points.push(new THREE.Vector2(Math.max(r1, 0.0001), bottomCenterY));
  points.push(new THREE.Vector2(Math.max(r2, 0.0001), topCenterY));

  for (let i = 0; i <= capSegments; i++) {
    const t = i / capSegments;
    const px = r2 * Math.cos(t * Math.PI / 2);
    const py = topCenterY + r2 * Math.sin(t * Math.PI / 2);
    points.push(new THREE.Vector2(Math.max(px, 0.0001), py));
  }

  const geometry = new THREE.LatheGeometry(points, radialSegments);
  geometry.computeVertexNormals();
  return geometry;
}

function _buildFinGeometry(width, baseLen, taperLen, thickness) {
  const w = width / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-w, 0);
  shape.lineTo(w, 0);
  shape.lineTo(w, baseLen);
  shape.lineTo(0, baseLen + taperLen);
  shape.lineTo(-w, baseLen);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    steps: 1,
  });
  geometry.translate(0, 0, -thickness / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function _buildHollowCylinderGeometry(outerRadius, wallThickness, height, radialSegments) {
  const innerRadius = Math.max(outerRadius - wallThickness, 0.001);

  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);

  const hole = new THREE.Path();
  hole.absarc(0, 0, innerRadius, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    steps: 1,
    curveSegments: radialSegments,
  });
  geometry.translate(0, 0, -height / 2);
  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

// Reduces any geometry to {position, normal} only, non-indexed — required
// before merging LatheGeometry/ExtrudeGeometry outputs, which can differ
// in indexing/attributes.
function _normalizeForMerge(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  const clean = new THREE.BufferGeometry();
  clean.setAttribute('position', g.getAttribute('position'));
  clean.setAttribute('normal', g.getAttribute('normal'));
  return clean;
}

// Concatenates position/normal buffers from several normalized geometries
// into one BufferGeometry. Local stand-in for BufferGeometryUtils.mergeGeometries
// so no extra import is needed.
function _mergeGeometries(geometries) {
  const positions = geometries.map(g => g.getAttribute('position').array);
  const normals   = geometries.map(g => g.getAttribute('normal').array);

  const posLen  = positions.reduce((sum, a) => sum + a.length, 0);
  const normLen = normals.reduce((sum, a) => sum + a.length, 0);

  const mergedPos  = new Float32Array(posLen);
  const mergedNorm = new Float32Array(normLen);

  let po = 0, no = 0;
  for (let i = 0; i < geometries.length; i++) {
    mergedPos.set(positions[i], po);  po += positions[i].length;
    mergedNorm.set(normals[i], no);   no += normals[i].length;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
  return merged;
}

// Assembles capsule body + crossed fins + guard ring into one merged,
// pre-scaled, pre-rotated BufferGeometry — built once at module load,
// same role the old CapsuleGeometry played.
function _buildBombGeometry() {
  const g = BOMB_GEO;

  const capsuleGeo = _buildAsymmetricCapsuleGeometry(
    g.r1, g.r2, g.bodyLength, g.radialSegments, g.capSegments
  );

  const tipY = g.bodyLength / 2 + g.r2;
  const finGroupY = tipY - g.finEmbed + g.finLift;
  const finBaseGeo = _buildFinGeometry(g.finWidth, g.finBase, g.finTaper, g.finThickness);

  const finAGeo = finBaseGeo.clone();
  finAGeo.applyMatrix4(
    new THREE.Matrix4()
      .makeTranslation(0, finGroupY, 0)
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI))
  );

  const finBGeo = finBaseGeo.clone();
  finBGeo.applyMatrix4(
    new THREE.Matrix4()
      .makeTranslation(0, finGroupY, 0)
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI))
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
  );

  const ringGeo = _buildHollowCylinderGeometry(g.guardRadius, g.guardWall, g.guardHeight, g.radialSegments);
  ringGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, finGroupY + g.guardOffsetY, 0));

  const rawParts   = [capsuleGeo, finAGeo, finBGeo, ringGeo];
  const cleanParts = rawParts.map(_normalizeForMerge);
  const merged      = _mergeGeometries(cleanParts);

  rawParts.forEach(geo => geo.dispose());
  cleanParts.forEach(geo => geo.dispose());
  finBaseGeo.dispose();

  merged.scale(BOMB_GEO_SCALE, BOMB_GEO_SCALE, BOMB_GEO_SCALE);
  merged.rotateX(-Math.PI / 2); 
  merged.computeVertexNormals();

  return merged;
}

// ── Bomb body visual ─────────────────────────────────────────────────────────
const _bombGeo = _buildBombGeometry();

const _bombMat = new THREE.MeshStandardMaterial({
  color:     0x2a2a2a,
  roughness: 0.6,
  metalness: 0.3,
});

const _bombDummy  = new THREE.Object3D();
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
const _bombFwd    = new THREE.Vector3(0, 0, 1);

// ─────────────────────────────────────────────────────────────────────────────

export class BombSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object}      world           — Rapier world (.__RAPIER__ set)
   * @param {object}      explosionSystem
   * @param {object}      opts            — { damage, blastRadius, reload, fuseGravity }
   */
  constructor(scene, world, explosionSystem, opts = {}) {
    this.scene           = scene;
    this.world            = world;
    this.explosionSystem  = explosionSystem;

    this.damage      = opts.damage      ?? 140;
    this.blastRadius = opts.blastRadius ?? 14;
    this.reloadTime  = opts.reload      ?? 1.5;
    this.fuseGravity = opts.fuseGravity ?? 19.6;
    this._reloading  = false;

    // ── Hit callback — fired once at the moment of impact, BEFORE the AoE
    // sweep in _resolveBlast(). (hitPos, hitEnemyTank, damage) => void —
    // hitEnemyTank/damage are always null/undefined here since bomb damage
    // is an area effect applied to potentially many targets, not a single
    // resolved hit. main.js uses this to know an impact happened at all
    // (for the explosion sound) and to run its own remote-player AoE sweep,
    // since resolver('__all__') below only ever contains AI units.
    this.onHit = null;

    this._dropPoint = null;

    // ── Per-bomb state — flat arrays, zero GC ───────────────────────────────
    this._active      = new Uint8Array(BOMB_MAX);   // 0 = free, 1 = live
    this._px          = new Float32Array(BOMB_MAX);
    this._py          = new Float32Array(BOMB_MAX);
    this._pz          = new Float32Array(BOMB_MAX);
    this._vx          = new Float32Array(BOMB_MAX);
    this._vy          = new Float32Array(BOMB_MAX);
    this._vz          = new Float32Array(BOMB_MAX);
    this._life        = new Float32Array(BOMB_MAX);
    this._resolver    = new Array(BOMB_MAX).fill(null);
    this._excludeBody = new Array(BOMB_MAX).fill(null);

    // ── Instanced visual ─────────────────────────────────────────────────────
    this._bombMesh               = new THREE.InstancedMesh(_bombGeo, _bombMat, BOMB_MAX);
    this._bombMesh.frustumCulled = false;
    this._bombMesh.count         = 0;
    scene.add(this._bombMesh);

    for (let i = 0; i < BOMB_MAX; i++) {
      this._bombMesh.setMatrixAt(i, _zeroMatrix);
    }
    this._bombMesh.instanceMatrix.needsUpdate = true;

    // ── Scratch — reused every call, never reallocated ──────────────────────
    this._scratchOrigin = new THREE.Vector3();
    this._scratchPrev   = new THREE.Vector3();
    this._scratchCurr   = new THREE.Vector3();
    this._scratchDir    = new THREE.Vector3();
    this._scratchQuat   = new THREE.Quaternion();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setDropPoint(node)  { this._dropPoint = node; }
  setDamage(dmg)       { this.damage = dmg; }
  setBlastRadius(r)    { this.blastRadius = r; }
  setReloadTime(t)     { this.reloadTime = t; }

  get isReady() { return !this._reloading && !!this._dropPoint; }

  /**
   * Release a bomb from the bomb bay. Inherits the plane's current velocity
   * so it falls forward realistically instead of dropping straight down.
   * @param {object}         rigidBody     — shooter's Rapier RigidBody (excluded from raycast)
   * @param {object}         velocity      — { x, y, z } plane linear velocity at drop time
   * @param {Function|null}  enemyResolver — (rbHandle | '__all__') => tank | tank[] | null
   */
  drop(rigidBody, velocity = { x: 0, y: 0, z: 0 }, enemyResolver = null) {
    if (!this.isReady) return false;

    this._dropPoint.getWorldPosition(this._scratchOrigin);
    this._spawnBomb(this._scratchOrigin, velocity, rigidBody ?? null, enemyResolver);

    this._reloading = true;
    setTimeout(() => { this._reloading = false; }, this.reloadTime * 1000);

    return true;
  }

  _spawnBomb(origin, velocity, excludeBody, resolver) {
    let slot = -1;
    for (let i = 0; i < BOMB_MAX; i++) {
      if (!this._active[i]) { slot = i; break; }
    }
    if (slot === -1) return; // pool full — drop the shot silently

    this._active[slot]      = 1;
    this._px[slot]          = origin.x;
    this._py[slot]          = origin.y;
    this._pz[slot]          = origin.z;
    this._vx[slot]          = velocity.x;
    this._vy[slot]          = velocity.y;
    this._vz[slot]          = velocity.z;
    this._life[slot]        = BOMB_LIFETIME;
    this._resolver[slot]    = resolver;
    this._excludeBody[slot] = excludeBody;
  }

  // ── Update — integrate fall, raycast, resolve AoE on impact ────────────────

  update(dt) {
    const RAPIER = this.world.__RAPIER__;
    let anyActive = false;

    for (let i = 0; i < BOMB_MAX; i++) {
      if (!this._active[i]) continue;
      anyActive = true;

      const prevX = this._px[i];
      const prevY = this._py[i];
      const prevZ = this._pz[i];

      this._vy[i] -= this.fuseGravity * dt;
      this._px[i] += this._vx[i] * dt;
      this._py[i] += this._vy[i] * dt;
      this._pz[i] += this._vz[i] * dt;

      this._life[i] -= dt;
      if (this._life[i] <= 0) {
        this._killBomb(i);
        continue;
      }

      // ── Segment raycast prev → curr (catches terrain, houses, tanks) ───────
      const dx = this._px[i] - prevX;
      const dy = this._py[i] - prevY;
      const dz = this._pz[i] - prevZ;
      const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (segLen > 0.001) {
        const ray = new RAPIER.Ray(
          { x: prevX,       y: prevY,       z: prevZ       },
          { x: dx / segLen, y: dy / segLen, z: dz / segLen }
        );

        const hit = this.world.castRay(
          ray, segLen, true,
          undefined, undefined, undefined,
          this._excludeBody[i] ?? undefined
        );

        if (hit) {
          const hitX = prevX + (dx / segLen) * hit.timeOfImpact;
          const hitY = prevY + (dy / segLen) * hit.timeOfImpact;
          const hitZ = prevZ + (dz / segLen) * hit.timeOfImpact;
          this._scratchCurr.set(hitX, hitY, hitZ);

          this._resolveBlast(this._scratchCurr, this._resolver[i]);
          this._killBomb(i);
          continue;
        }
      }

      // ── Visual — tumbles nose-down along its fall velocity ─────────────────
      const speed = Math.sqrt(
        this._vx[i] * this._vx[i] +
        this._vy[i] * this._vy[i] +
        this._vz[i] * this._vz[i]
      );
      if (speed > 0.001) {
        this._scratchDir.set(this._vx[i] / speed, this._vy[i] / speed, this._vz[i] / speed);
        this._scratchQuat.setFromUnitVectors(_bombFwd, this._scratchDir);
      }

      _bombDummy.position.set(this._px[i], this._py[i], this._pz[i]);
      _bombDummy.quaternion.copy(this._scratchQuat);
      _bombDummy.scale.setScalar(1);
      _bombDummy.updateMatrix();
      this._bombMesh.setMatrixAt(i, _bombDummy.matrix);
    }

    this._bombMesh.count = BOMB_MAX;
    this._bombMesh.instanceMatrix.needsUpdate = anyActive;
  }

  /**
   * Apply falloff-scaled AoE damage to every active tank within blastRadius,
   * and spawn the big explosion visual/sound-trigger at the impact point.
   */
  _resolveBlast(position, resolver) {
    this.explosionSystem?.spawn(position.clone());
    this.onHit?.(position.clone(), null, this.damage);

    if (!resolver) return;

    // main.js's _enemyResolver treats '__all__' as a sentinel that returns
    // every active enemy tank — same convention bullet.js relies on for
    // mesh-precise hit testing.
    const activeTanks = resolver('__all__');
    if (!activeTanks || !Array.isArray(activeTanks)) return;

    for (const tank of activeTanks) {
      if (tank.isDead || !tank.rigidBody) continue;
      const p = tank.rigidBody.translation();
      const dist = Math.hypot(p.x - position.x, p.y - position.y, p.z - position.z);
      if (dist > this.blastRadius) continue;

      // Linear falloff — full damage at the center, ~0 at the blast edge.
      const falloff = 1 - (dist / this.blastRadius);
      const dmg = Math.round(this.damage * Math.max(0.15, falloff));

      tank._lastHitBy = 'player';
      tank.takeDamage(dmg);
    }
  }

  _killBomb(i) {
    this._active[i]      = 0;
    this._resolver[i]    = null;
    this._excludeBody[i] = null;
    this._bombMesh.setMatrixAt(i, _zeroMatrix);
    this._bombMesh.instanceMatrix.needsUpdate = true;
  }

  // ── Invalidate stale rigid body references (e.g. shooter respawned) ────────
  invalidateRigidBody(rigidBody) {
    if (!rigidBody) return;
    for (let i = 0; i < BOMB_MAX; i++) {
      if (this._excludeBody[i] === rigidBody) this._excludeBody[i] = null;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose() {
    this._bombMesh.geometry.dispose();
    this._bombMesh.material.dispose();
    this._bombMesh.removeFromParent();
  }
}