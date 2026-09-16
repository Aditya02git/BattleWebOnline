import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const DEFAULT_BULLET_SPEED = 80;   // kept for API compat — not used in raycast
const DEFAULT_RELOAD_TIME  = 3;
const DAMAGE        = 100;
const RANGE         = 300;  // metres — max raycast distance

// ── Tracer beam visual (InstancedMesh) ───────────────────────────────────────
const TRACER_MAX      = 16;    // max simultaneous tracer beams
const TRACER_LIFETIME = 0.10;  // seconds — short flash
const TRACER_RADIUS   = 0.045;
const TRACER_LENGTH   = 4.0;   // world-units — visual length of tracer

const _tracerGeo = new THREE.CylinderGeometry(
  TRACER_RADIUS, TRACER_RADIUS * 0.3, TRACER_LENGTH, 6, 1
);
_tracerGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));

const _tracerMat = new THREE.MeshBasicMaterial({
  color:       0xffdd88,
  transparent: true,
  opacity:     0.95,
  depthWrite:  false,
});

// Shared scratch for instanced matrix writes
const _tracerDummy   = new THREE.Object3D();
const _zeroMatrix    = new THREE.Matrix4().makeScale(0, 0, 0);
const _tracerFwd     = new THREE.Vector3(0, 0, 1);

// ADD near the top of bullet.js, after the existing const declarations:
const _meshRaycaster = new THREE.Raycaster();
_meshRaycaster.near = 0;
_meshRaycaster.far  = 400;

// ─────────────────────────────────────────────────────────────────────────────

export class BulletSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object}      world          — Rapier world (.__RAPIER__ set)
   * @param {object}      explosionSystem
   */
  constructor(scene, world, explosionSystem) {
    this.scene           = scene;
    this.world           = world;
    this.explosionSystem = explosionSystem;

    // Public state (API-compat with old physics version)
    this.gunPoint    = null;
    this.bulletSpeed = DEFAULT_BULLET_SPEED;
    this.reloadTime  = DEFAULT_RELOAD_TIME;
    this.damage = DAMAGE;
    this._reloading  = false;

    // Not used in raycast mode — kept so existing collision-event wiring
    // doesn't throw when it calls these.
    this._enemyBulletHandles = new Set();
    this.trailSystem         = null;
    this.onHit = null;

    // ── Instanced tracer beam pool ────────────────────────────────────────
    this._tracerMesh               = new THREE.InstancedMesh(_tracerGeo, _tracerMat, TRACER_MAX);
    this._tracerMesh.frustumCulled = false;
    this._tracerMesh.count         = 0;
    this._tracerMesh.visible       = false;
    scene.add(this._tracerMesh);

    this._tracerLifetimes = new Float32Array(TRACER_MAX).fill(-1);
    this._tracerActive    = 0;

    // ── Scratch vectors — zero allocation in hot paths ────────────────────
    this._scratchOrigin  = new THREE.Vector3();
    this._scratchDir     = new THREE.Vector3();
    this._scratchHitPos  = new THREE.Vector3();
    this._scratchBeamQ   = new THREE.Quaternion();
    this._scratchBeamP   = new THREE.Vector3();
    this._scratchBeamS   = new THREE.Vector3(1, 1, 1);

    // Cached Rapier Ray — mutated in place each shot, never reallocated
    this._ray = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setGunPoint(gunPointObject) { this.gunPoint    = gunPointObject; }
  setShellSpeed(speed)        { this.bulletSpeed = speed; }          // API-compat
  setFireRate(rate)           { this.reloadTime  = rate; }
  setDamage(dmg) { this.damage = dmg; }

  get isReloaded()     { return !this._reloading; }
  get reloadProgress() { return this._reloading ? 0 : 1; }

  /**
   * Player fires the main cannon.
   * @param {object}        tankRigidBody  — player's Rapier RigidBody (used to exclude self from raycast)
   * @param {Function|null} onFire         — callback after firing
   * @param {Function|null} onRecoil       — callback for recoil animation
   * @param {THREE.Vector3|null} overrideDir — optional direction override
   * @param {boolean}       isMG           — ignored (MG has its own system)
   * @param {Function|null} enemyResolver  — (rbHandle) => EnemyTank | null
   */
  fire(tankRigidBody, onFire, onRecoil, overrideDir = null, isMG = false, enemyResolver = null) {
    if (!this.isReloaded || !this.gunPoint) return;

    // Get world origin & direction from gun point
    this.gunPoint.getWorldPosition(this._scratchOrigin);
    if (overrideDir) {
      this._scratchDir.copy(overrideDir).normalize();
    } else {
      this.gunPoint.getWorldDirection(this._scratchDir);
    }

    this._castAndResolve(this._scratchOrigin, this._scratchDir, tankRigidBody, enemyResolver, false);

    // Start reload timer
    this._reloading = true;
    setTimeout(() => { this._reloading = false; }, this.reloadTime * 1000);

    // Muzzle flash at gun point
    this.explosionSystem?.spawnMuzzleFlash(this._scratchOrigin);
    this.explosionSystem?.spawnGunSmoke(this.gunPoint);
    onFire?.();
    onRecoil?.();
  }

  /**
   * Enemy fires the main cannon.
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} direction
   * @param {object|null}   excludeBody    — enemy's own RigidBody (exclude from ray)
   * @param {Function|null} onHitPlayer    — () => void  called when ray hits player
   * @param {object|null}   playerRigidBody — player's RigidBody handle for hit detection
   */
  fireFromPoint(origin, direction, excludeBody = null, onHitPlayer = null, playerRigidBody = null) {
    this._scratchDir.copy(direction).normalize();
    this._castAndResolve(origin, this._scratchDir, excludeBody, null, true, onHitPlayer, playerRigidBody);
    this.explosionSystem?.spawnMuzzleFlash(origin);
  }

  /**
   * No-op — raycast hits are resolved instantly inside fire() / fireFromPoint().
   * Kept so existing collision-event wiring compiles without changes.
   */
  handleCollision(_h1, _h2, _started, _resolver) { return false; }

  /** No-op — kept for API compat */
  isEnemyBulletHandle(_handle) { return false; }

  /** No-op — tracer system is internal now */
  setTrailSystem(_ts) {}

  // ── Core raycast ──────────────────────────────────────────────────────────

  /**
   * Cast a ray, resolve damage, spawn visuals.
   * @param {THREE.Vector3}  origin
   * @param {THREE.Vector3}  dir           — must be normalised
   * @param {object|null}    excludeBody   — Rapier RigidBody to exclude (shooter)
   * @param {Function|null}  enemyResolver — (rbHandle) => EnemyTank | null  (player shots)
   * @param {boolean}        isEnemy
   * @param {Function|null}  onHitPlayer   — called when enemy shot hits player body
   * @param {object|null}    playerRigidBody
   */
  _castAndResolve(origin, dir, excludeBody, enemyResolver, isEnemy, onHitPlayer = null, playerRigidBody = null) {
    const RAPIER = this.world.__RAPIER__;

    // Lazy-create the Ray once, mutate origin/dir in-place every call
const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: dir.x,    y: dir.y,    z: dir.z    }
    );

    const hit = this.world.castRay(
      ray,
      RANGE,
      true,          // solid
      undefined,     // filter flags
      undefined,     // filter groups
      undefined,     // filter predicate
      excludeBody    // exclude shooter's own body
    );

    if (hit) {
      // Compute world hit position
      this._scratchHitPos.set(
        origin.x + dir.x * hit.timeOfImpact,
        origin.y + dir.y * hit.timeOfImpact,
        origin.z + dir.z * hit.timeOfImpact
      );

      // ── Damage resolution ────────────────────────────────────────────────
      const hitCollider = this.world.getCollider(hit.collider.handle);
      const rbHandle    = hitCollider?.parent()?.handle;

      let _hitResult = null;
      if (!isEnemy && enemyResolver) {
        _meshRaycaster.set(origin, dir);
        const meshHitResult = _resolveEnemyMeshHit(
          origin, dir, enemyResolver, this.world, this.damage
        );
        // meshHitResult.hit = true means a collider mesh was hit and damage applied
        // if false, fall back to Rapier rbHandle (e.g. hit the physics body)
        if (meshHitResult.hit) {
          _hitResult = meshHitResult;
        } else {
          const enemyTank = enemyResolver(rbHandle);
          if (enemyTank) {
            enemyTank._lastHitBy = 'player';   // ← kill-credit attribution
            enemyTank.takeDamage(this.damage);
            _hitResult = { hit: true, tank: enemyTank, damage: this.damage, isCrewHit: false };
          }
        }
      }

if (isEnemy && onHitPlayer) {
  // Any solid hit by an enemy shot counts as hitting the player
  // (terrain hits are acceptable false positives at this fire rate)
  onHitPlayer();
}

      // ── Hit explosion ────────────────────────────────────────────────────────────
      this.explosionSystem?.spawnShellHit(this._scratchHitPos);
      // Pass the resolved tank + actual applied damage (accounts for the
      // crew-collider one-shot override) so callers like main.js's
      // multiplayer relay report the REAL damage, not just this.damage.
      this.onHit?.(this._scratchHitPos.clone(), _hitResult?.tank ?? null, _hitResult?.damage ?? this.damage);
    } else {
      // No hit — tracer travels to max range (visual end point)
      this._scratchHitPos.copy(origin).addScaledVector(dir, RANGE);
    }

    // ── Spawn tracer beam ────────────────────────────────────────────────────
    this._spawnTracer(origin, dir);
  }

  // ── Tracer beam pool ──────────────────────────────────────────────────────

  _spawnTracer(origin, direction) {
    // Find a free slot
    let slot = -1;
    for (let i = 0; i < TRACER_MAX; i++) {
      if (this._tracerLifetimes[i] <= 0) { slot = i; break; }
    }
    if (slot === -1) return; // pool full — skip visual (rare)

    this._tracerLifetimes[slot] = TRACER_LIFETIME;

    // Position tracer half-length along the ray from the origin
    this._scratchBeamP
      .copy(origin)
      .addScaledVector(direction, TRACER_LENGTH * 0.5);

    this._scratchBeamQ.setFromUnitVectors(_tracerFwd, direction);

    _tracerDummy.position.copy(this._scratchBeamP);
    _tracerDummy.quaternion.copy(this._scratchBeamQ);
    _tracerDummy.scale.copy(this._scratchBeamS);
    _tracerDummy.updateMatrix();

    this._tracerMesh.setMatrixAt(slot, _tracerDummy.matrix);
    this._tracerMesh.instanceMatrix.needsUpdate = true;

    this._tracerActive        = Math.min(TRACER_MAX, this._tracerActive + 1);
    this._tracerMesh.count    = this._tracerActive;
    this._tracerMesh.visible  = true;
  }

  // ── Update — only ticks tracer beams ─────────────────────────────────────

  /**
   * Call every frame. Extremely cheap — just fades out tracer beams.
   * No bullet physics to step, no array to iterate.
   * @param {number} dt
   */
  update(dt) {
    if (this._tracerActive === 0) return;

    let maxActive = 0;
    let dirty     = false;

    for (let i = 0; i < TRACER_MAX; i++) {
      if (this._tracerLifetimes[i] <= 0) continue;

      this._tracerLifetimes[i] -= dt;

      if (this._tracerLifetimes[i] <= 0) {
        this._tracerMesh.setMatrixAt(i, _zeroMatrix);
        this._tracerLifetimes[i] = -1;
        dirty = true;
      } else {
        // Fade opacity as beam expires
        _tracerMat.opacity =
          Math.max(0, this._tracerLifetimes[i] / TRACER_LIFETIME) * 0.95;
        maxActive = i + 1;
      }
    }

    this._tracerActive      = maxActive;
    this._tracerMesh.count  = maxActive;
    this._tracerMesh.visible = maxActive > 0;

    if (dirty) this._tracerMesh.instanceMatrix.needsUpdate = true;
  }

  // ── Invalidate stale rigid body references ────────────────────────────────
  // No-op — BulletSystem (hitscan) resolves hits synchronously inside fire(),
  // so there's no stored rigidBody reference that can go stale between frames.
  invalidateRigidBody(_rigidBody) {}

  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose() {
    // NOTE: _tracerGeo/_tracerMat are shared module-level constants used by
    // every BulletSystem instance — do NOT dispose them here, or every other
    // tank/plane sharing this geometry/material loses its tracer rendering
    // the instant any one instance is disposed (e.g. on respawn).
    this._tracerMesh.visible = false;
    this._tracerMesh.count   = 0;
    this._tracerMesh.removeFromParent();
  }
}


// ADD this function in bullet.js, between BulletSystem class closing }
// and the MachineGunSystem class definition

/**
 * Raycast against Hull_Collider / Crew_Collider meshes on all active enemies.
 * Returns true if a collider mesh was hit and damage was applied.
 *
 * @param {THREE.Vector3}  origin
 * @param {THREE.Vector3}  dir            — must be normalised
 * @param {Function}       enemyResolver  — (rbHandle) => EnemyTank | null
 * @param {object}         world          — Rapier world (used to get active tanks)
 * @param {number}         baseDamage
 * @returns {boolean}
 */
function _resolveEnemyMeshHit(origin, dir, enemyResolver, world, baseDamage, maxDist = Infinity) {
  _meshRaycaster.set(origin, dir);
  _meshRaycaster.far = maxDist;

  // Collect all Hull_Collider + Crew_Collider meshes from active enemies
  // We access them via the global enemyPool — passed through resolver closure
  // Instead, we scan using the resolver against a synthesised handle list.
  // Simpler: enemyResolver is called per-handle; here we use the world's
  // collider iteration to find candidate tanks, then mesh-raycast them.

  // We can't iterate Rapier colliders easily, so we rely on the fact that
  // enemyResolver exposes a getActiveTanks-style pattern via closure OR
  // we attach the active tank list to the resolver function itself.
  // The resolver in main.js is:
  //   const _enemyResolver = (rbHandle) =>
  //     enemyPool.getActiveTanks().find(t => t.rigidBody?.handle === rbHandle) ?? null;
  //
  // So we call it with a sentinel to get all tanks:
  const activeTanks = enemyResolver('__all__');  // ← see main.js change below
  if (!activeTanks || !Array.isArray(activeTanks)) return false;

  let closestDist  = Infinity;
  let hitTank      = null;
  let isCrewHit    = false;

  for (const tank of activeTanks) {
    if (tank.isDead) continue;

    const meshesToCheck = [];
    if (tank._hullColliderMesh) meshesToCheck.push({ mesh: tank._hullColliderMesh, isCrew: false });
    if (tank._crewColliderMesh) meshesToCheck.push({ mesh: tank._crewColliderMesh, isCrew: true  });
    // Also check player tank collider meshes if needed — skipped here (enemy shots use different path)

    for (const { mesh, isCrew } of meshesToCheck) {
      const hits = _meshRaycaster.intersectObject(mesh, false);
      if (hits.length > 0 && hits[0].distance < closestDist) {
        closestDist = hits[0].distance;
        hitTank     = tank;
        isCrewHit   = isCrew;
      }
    }
  }

  _meshRaycaster.far = 400;   // restore default — don't leak maxDist into other callers

  if (hitTank) {
    const damage = isCrewHit ? 1000 : baseDamage;
    hitTank._lastHitBy = 'player';   // ← kill-credit attribution
    hitTank.takeDamage(damage);
    return { hit: true, tank: hitTank, damage, isCrewHit };
  }

  return { hit: false, tank: null, damage: 0, isCrewHit: false };
}


// ── Machine Gun System — unchanged from original ───────────────────────────
// Raycast-based already. Kept here so imports stay the same.

const MG_MAX_AMMO  = 200;
const MG_FIRE_RATE = 0.08;
const MG_RANGE     = 80;
const MG_DAMAGE    = 8;
const MG_SPREAD    = 0.022;
const MG_MAG_SIZE     = 30;   // rounds per magazine before a reload is needed
const MG_RELOAD_TIME  = 3;    // seconds for a manual reload

const MG_BEAM_MAX      = 10;
const MG_BEAM_LIFETIME = 0.5;
const MG_BEAM_LENGTH   = 1.5;
const MG_BEAM_TRAVEL_SPEED = 150; // world-units per second
const MG_BEAM_TRAVEL_MAX   = 100; // stops travelling after this distance
const MG_BEAM_RADIUS   = 0.005;

// ── Bullet mesh (exported from Blender as bullet.glb) ───────────────────────
// Cross-plane body (two perpendicular quads, same trick as the old tapered
// beam planes) capped with a 4-sided pyramid nose. Built directly from the
// glTF vertex data so no runtime GLTFLoader/.glb fetch is needed.
function _createBulletMeshGeometry() {
  const positions = new Float32Array([
    2.9230093e-10, 0.06795156, -8.8126774,
    2.9230093e-10, 0.06795156, -8.8126774,
    0.2680653, -0.15476762, 0.16846877,
    0.2680653, -0.15476762, 0.16846877,
    0.058847774, -0.03397578, -8.8126774,
    0.058847774, -0.03397578, -8.8126774,
    -0.26806539, -0.15476754, 0.16846876,
    -0.26806539, -0.15476754, 0.16846876,
    -0.058847774, -0.033975758, -8.8126774,
    -0.058847774, -0.033975758, -8.8126774,
    7.1409723e-08, 0.30953521, 0.16846874,
    7.1409723e-08, 0.30953521, 0.16846874,
    -1.1665033, 0.057619505, -1.83764,
    1.2125671e-15, -1.108884, -1.83764,
    1.1665033, 0.057619505, -1.83764,
    1.2125671e-15, 1.2241226, -1.83764,
    1.2125671e-15, 0.057619516, 1.6762049,
  ]);

  const normals = new Float32Array([
    0.86591631, 0.50000942, -0.013400252,
    -0.86591631, 0.50000942, -0.013400252,
    0, -0.99991024, -0.013400137,
    0.86591631, 0.50000942, -0.013400252,
    0, -0.99991024, -0.013400137,
    0.86591631, 0.50000942, -0.013400252,
    0, -0.99991024, -0.013400137,
    -0.86591631, 0.50000942, -0.013400252,
    0, -0.99991024, -0.013400137,
    -0.86591631, 0.50000942, -0.013400252,
    0.86591631, 0.50000942, -0.013400252,
    -0.86591631, 0.50000942, -0.013400252,
    -0.66358471, 0.082098097, 0.74358279,
    -0.082098097, -0.66358471, 0.74358279,
    0.66358471, -0.082098097, 0.74358279,
    0.082098097, 0.66358471, 0.74358279,
    0, -0.7969901, 0.60399246,
  ]);

  const uvs = new Float32Array([
    0.19802661, 0.033001423,
    0.19802661, 0.033001423,
    0.20120825, 0.99430192,
    0.36593071, 0.99719512,
    0.20120834, 0.035699427,
    0.36593071, 0.033001423,
    0.3658821, 0.99430192,
    0.36593071, 0.99719512,
    0.36588222, 0.035699427,
    0.36593071, 0.033001423,
    0.19802661, 0.99719512,
    0.19802661, 0.99719512,
    1.0059679, 0.74589825,
    0.73569369, 1.0049251,
    0.46541956, 0.74589825,
    0.73569375, 0.48687124,
    0.73569369, 0.74589837,
  ]);

  const indices = [
    0, 10, 3,  0, 3, 5,
    4, 2, 6,   4, 6, 8,
    9, 7, 11,  9, 11, 1,
    16, 12, 13,
    16, 13, 14,
    16, 14, 15,
    16, 15, 12,
  ];

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
  // Flip UVs vertically (V axis) so the texture mirrors top-to-bottom
  for (let i = 0; i < uvs.length; i += 2) {
    uvs[i + 1] = 1 - uvs[i + 1];
  }
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);

  // Normalize to unit length along local Z, centered at the origin — this
  // matches the convention the old tapered-plane geometry used, so all the
  // existing halfLen / scale.z math in _spawnBeam()/update() keeps working
  // unchanged.
  geo.computeBoundingBox();
  const lenZ = geo.boundingBox.max.z - geo.boundingBox.min.z;
  const s = 1 / lenZ;
  geo.scale(s, s, s);
  geo.center();

  return geo;
}

const _beamGeo = _createBulletMeshGeometry();

// Texture — adjust this path to wherever your textures folder is served
// from (e.g. '/assets/textures/bullet.png').
const _bulletTextureLoader = new THREE.TextureLoader();
const _bulletTexture = _bulletTextureLoader.load('textures/bullet.png');
_bulletTexture.colorSpace = THREE.SRGBColorSpace;

const _beamMat = new THREE.MeshBasicMaterial({
  map:         _bulletTexture,
  color:       0xffee88,   // base tint, multiplies the texture — tweak per weapon via .clone()
  transparent: true,
  depthWrite:  false,
  side:        THREE.DoubleSide,
  blending:    THREE.AdditiveBlending,
  fog:         false,
});

const _beamDummy  = new THREE.Object3D();
const _zeroMatrixMG = new THREE.Matrix4().makeScale(0, 0, 0);

export class MachineGunSystem {
  constructor(scene, world, explosionSystem) {
    this.scene           = scene;
    this.world            = world;
    this.explosionSystem = explosionSystem;

    this.ammo       = MG_MAX_AMMO;
    this.maxAmmo    = MG_MAX_AMMO;
    this.damage     = MG_DAMAGE;
    this.range      = MG_RANGE;
    this._fireTimer = 0;
    this._gunPoint  = null;
    this.onHit      = null;   // (hitPos, enemyTank|null) => void — set externally, e.g. main.js's multiplayer relay

    // ── Magazine / reload state (mirrors MultiGunSystem's rounds/reload) ───
    this.magSize        = MG_MAG_SIZE;
    this.rounds         = Math.min(this.magSize, this.ammo);
    this.fullReloadTime = MG_RELOAD_TIME;
    this._reloading     = false;
    this._reloadTimer   = 0;

    this._beamMesh               = new THREE.InstancedMesh(_beamGeo, _beamMat, MG_BEAM_MAX);
    this._beamMesh.frustumCulled = false;
    this._beamMesh.count         = 0;
    this._beamMesh.visible       = false;
    scene.add(this._beamMesh);

    this._beamLifetimes = new Float32Array(MG_BEAM_MAX).fill(-1);
    this._beamActive    = 0;

    // Travel animation — origin + direction per beam slot
    this._beamOx = new Float32Array(MG_BEAM_MAX); // origin X
    this._beamOy = new Float32Array(MG_BEAM_MAX); // origin Y
    this._beamOz = new Float32Array(MG_BEAM_MAX); // origin Z
    this._beamDx = new Float32Array(MG_BEAM_MAX); // direction X
    this._beamDy = new Float32Array(MG_BEAM_MAX); // direction Y
    this._beamDz = new Float32Array(MG_BEAM_MAX); // direction Z
    this._beamTravel = new Float32Array(MG_BEAM_MAX); // current travel distance
    this._beamLenScale = new Float32Array(MG_BEAM_MAX).fill(1); 

    this._beamQx = new Float32Array(MG_BEAM_MAX);
    this._beamQy = new Float32Array(MG_BEAM_MAX);
    this._beamQz = new Float32Array(MG_BEAM_MAX);
    this._beamQw = new Float32Array(MG_BEAM_MAX).fill(1);

    this._scratchOrigin  = new THREE.Vector3();
    this._scratchBaseDir = new THREE.Vector3();
    this._scratchDir     = new THREE.Vector3();
    this._scratchHit     = new THREE.Vector3();
    this._scratchSpread  = new THREE.Vector3();
    this._scratchBeamQ   = new THREE.Quaternion();
    this._scratchBeamP   = new THREE.Vector3();
    this._scratchBeamS   = new THREE.Vector3(1, 1, 1);
    this._beamFwd        = new THREE.Vector3(0, 0, 1);

    this._gpCacheTimer = 0;
    this._ray          = null;
  }

  setGunPoint(gp) { this._gunPoint = gp; }
setDamage(dmg)  { this.damage = dmg; }
setRange(range) { this.range  = range; }

/** Returns an array of active gun point Object3Ds — always length 0 or 1 for MG. */
getGunPoints() { return this._gunPoint ? [this._gunPoint] : []; }

  get isReady() { return this._fireTimer <= 0 && !this._reloading && this.rounds > 0 && !!this._gunPoint; }
  get isEmpty()  { return this.rounds <= 0; }

  _spawnBeam(origin, direction) {
  let slot = -1;
  for (let i = 0; i < MG_BEAM_MAX; i++) {
    if (this._beamLifetimes[i] <= 0) { slot = i; break; }
  }
  if (slot === -1) return;

  this._beamLifetimes[slot] = MG_BEAM_LIFETIME;
  this._beamTravel[slot]    = 0;

  // Randomize visual length per-shot — e.g. 70%–130% of base length
  const lenScale = 0.7 + Math.random() * 0.6;
  this._beamLenScale[slot] = lenScale;

  // Store origin and direction for travel animation
  this._beamOx[slot] = origin.x;
  this._beamOy[slot] = origin.y;
  this._beamOz[slot] = origin.z;
  this._beamDx[slot] = direction.x;
  this._beamDy[slot] = direction.y;
  this._beamDz[slot] = direction.z;

  // Set initial matrix (beam centre at MG_BEAM_LENGTH * 0.5 ahead of origin)
  const halfLen = MG_BEAM_LENGTH * lenScale * 0.5;
this._scratchBeamP.set(
  origin.x + direction.x * halfLen,
  origin.y + direction.y * halfLen,
  origin.z + direction.z * halfLen
);
this._scratchBeamQ.setFromUnitVectors(this._beamFwd, direction);

this._beamQx[slot] = this._scratchBeamQ.x;
this._beamQy[slot] = this._scratchBeamQ.y;
this._beamQz[slot] = this._scratchBeamQ.z;
this._beamQw[slot] = this._scratchBeamQ.w;

_beamDummy.position.copy(this._scratchBeamP);
_beamDummy.quaternion.copy(this._scratchBeamQ);
_beamDummy.scale.set(1, 1, lenScale); // stretch only along local Z (the beam's length axis)
_beamDummy.updateMatrix();

  this._beamMesh.setMatrixAt(slot, _beamDummy.matrix);
  this._beamMesh.instanceMatrix.needsUpdate = true;
  this._beamActive         = Math.min(MG_BEAM_MAX, this._beamActive + 1);
  this._beamMesh.count     = this._beamActive;
  this._beamMesh.visible   = true;
}

  fire(rigidBody, enemyResolver = null, onFire = null, aimWorldPos = null) {
    if (!this.isReady) return false;

    this._fireTimer = MG_FIRE_RATE;
    this.rounds     = Math.max(0, this.rounds - 1);

    const RAPIER = this.world.__RAPIER__;

    this._gpCacheTimer--;
    if (this._gpCacheTimer <= 0) {
      this._gunPoint.getWorldPosition(this._scratchOrigin);
      if (aimWorldPos) {
        this._scratchBaseDir.subVectors(aimWorldPos, this._scratchOrigin).normalize();
      } else {
        this._gunPoint.getWorldDirection(this._scratchBaseDir);
      }
      this._gpCacheTimer = 2;
    } else if (aimWorldPos) {
      // Aim point can move every frame even while the gun-point position
      // cache is still valid — recompute direction from the live cached
      // origin so aim doesn't lag/snap when cache refreshes.
      this._scratchBaseDir.subVectors(aimWorldPos, this._scratchOrigin).normalize();
    }

    this._scratchDir.copy(this._scratchBaseDir);
    this._scratchSpread.set(
      (Math.random() - 0.5) * MG_SPREAD,
      (Math.random() - 0.5) * MG_SPREAD,
      (Math.random() - 0.5) * MG_SPREAD
    );
    this._scratchDir.add(this._scratchSpread).normalize();

    if (!this._ray) {
      this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    }
    this._ray.origin.x = this._scratchOrigin.x;
    this._ray.origin.y = this._scratchOrigin.y;
    this._ray.origin.z = this._scratchOrigin.z;
    this._ray.dir.x    = this._scratchDir.x;
    this._ray.dir.y    = this._scratchDir.y;
    this._ray.dir.z    = this._scratchDir.z;

    const hit = this.world.castRay(this._ray, this.range, true, undefined, undefined, undefined, rigidBody);

    if (hit) {
      this._scratchHit.set(
        this._scratchOrigin.x + this._scratchDir.x * hit.timeOfImpact,
        this._scratchOrigin.y + this._scratchDir.y * hit.timeOfImpact,
        this._scratchOrigin.z + this._scratchDir.z * hit.timeOfImpact
      );
      this.explosionSystem?.spawnSpark(this._scratchHit);

      let hitEnemyTank = null;
      if (enemyResolver) {
        const collider  = this.world.getCollider(hit.collider.handle);
        const rbHandle  = collider?.parent()?.handle;
        const enemyTank = enemyResolver(rbHandle);
        if (enemyTank) {
          enemyTank._lastHitBy = 'player';   // ← kill-credit attribution
          enemyTank.takeDamage(this.damage);
          hitEnemyTank = enemyTank;
        }
      }

      // ── onHit callback — mirrors BulletSystem/ProjectileBulletSystem's
      // contract so main.js can wire up the same multiplayer damage-relay
      // pattern for the MG that it already uses for the main gun. Passes
      // the resolved enemy tank (or null) as a second arg so callers don't
      // need to re-run their own nearest-enemy search.
      this.onHit?.(this._scratchHit.clone(), hitEnemyTank);
    }

    this._spawnBeam(this._scratchOrigin, this._scratchDir);
    this.explosionSystem?.spawnMGMuzzleFlash(this._scratchOrigin);
    onFire?.();
    return true;
  }

  update(dt) {
  if (this._fireTimer > 0) this._fireTimer -= dt;

  if (this._reloading) {
    this._reloadTimer -= dt;
    if (this._reloadTimer <= 0) {
      this._reloading   = false;
      this._reloadTimer = 0;
      this.rounds       = this.magSize;
    }
  }

  if (this._beamActive === 0) return;

  let maxActive = 0;
  let dirty     = false;

  for (let i = 0; i < MG_BEAM_MAX; i++) {
    if (this._beamLifetimes[i] <= 0) continue;

    this._beamLifetimes[i] -= dt;

    if (this._beamLifetimes[i] <= 0) {
      this._beamMesh.setMatrixAt(i, _zeroMatrixMG);
      this._beamLifetimes[i] = -1;
      dirty = true;
    } else {
      // Advance travel distance — clamp at max
      this._beamTravel[i] = Math.min(
        this._beamTravel[i] + MG_BEAM_TRAVEL_SPEED * dt,
        MG_BEAM_TRAVEL_MAX
      );

      // Recompute beam centre position along stored direction
      // Recompute beam centre position along stored direction
      const t = this._beamTravel[i];
      const halfLen = MG_BEAM_LENGTH * this._beamLenScale[i] * 0.5;
      const cx = this._beamOx[i] + this._beamDx[i] * (t + halfLen);
      const cy = this._beamOy[i] + this._beamDy[i] * (t + halfLen);
      const cz = this._beamOz[i] + this._beamDz[i] * (t + halfLen);

      _beamDummy.position.set(cx, cy, cz);
      _beamDummy.quaternion.set(this._beamQx[i], this._beamQy[i], this._beamQz[i], this._beamQw[i]);
      _beamDummy.scale.set(1, 1, this._beamLenScale[i]);
      _beamDummy.updateMatrix();
      this._beamMesh.setMatrixAt(i, _beamDummy.matrix);

      dirty     = true;
      maxActive = i + 1;
    }
  }

  this._beamActive       = maxActive;
  this._beamMesh.count   = maxActive;
  this._beamMesh.visible = maxActive > 0;

  if (dirty) this._beamMesh.instanceMatrix.needsUpdate = true;
}

  /** Immediately hides and resets all active tracer beams. Needed because
   * update() (which normally fades beams out over ~0.5s) may never run
   * again after this — e.g. the plane died, or was parked while switching
   * to the tank — leaving any beam that was mid-fade frozen in the scene
   * forever otherwise. */
  clearBeams() {
    if (this._beamActive === 0) return;
    for (let i = 0; i < MG_BEAM_MAX; i++) {
      if (this._beamLifetimes[i] <= 0) continue;
      this._beamMesh.setMatrixAt(i, _zeroMatrixMG);
      this._beamLifetimes[i] = -1;
    }
    this._beamActive       = 0;
    this._beamMesh.count   = 0;
    this._beamMesh.visible = false;
    this._beamMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    // NOTE: this mesh's geometry (_beamGeo) and material (_beamMat) are
    // shared module-level constants used by EVERY MachineGunSystem instance
    // (every tank's MG, every player/enemy/friendly plane's gun). Disposing
    // them here would free the GPU buffers for all of those at once — this
    // is exactly what was breaking tracer/muzzle visuals after any single
    // plane respawned. Only detach this instance's own mesh.
    this._beamMesh.visible = false;
    this._beamMesh.count   = 0;
    this._beamMesh.removeFromParent();
  }
}// ── Multi-Gun System (gunType: 3) ───────────────────────────────────────────
// Fires all barrels (GunPoint_1, GunPoint_2, ...) simultaneously per shot.
// Reuses the same hitscan + tracer-beam visual approach as MachineGunSystem,
// but resolves N rays per fire() call instead of one.

const MULTIGUN_MAX_BARRELS = 8;    // hard cap on simultaneous gun points
const MULTIGUN_FIRE_RATE   = 0.25;  // seconds between volleys (rate of fire, not reload)
const MULTIGUN_RANGE       = 500;
const MULTIGUN_DAMAGE      = 20;
const MULTIGUN_SPREAD      = 0.01;
const MULTIGUN_MAX_ROUNDS  = 150;  // volleys before a full reload is required
const MULTIGUN_RELOAD_TIME = 8;    // seconds to fully reload after exhausting rounds

// Beams: reuse the same beam pool size math as MG, just bigger since every
// volley can spawn up to MULTIGUN_MAX_BARRELS beams at once.
const MULTIGUN_BEAM_MAX      = MULTIGUN_MAX_BARRELS * 3; // headroom for overlap while fading
const MULTIGUN_BEAM_LIFETIME = 0.5;
const MULTIGUN_BEAM_LENGTH   = 1.5;
const MULTIGUN_BEAM_TRAVEL_SPEED = 150;
const MULTIGUN_BEAM_TRAVEL_MAX   = 50;
const MULTIGUN_BEAM_ARRIVE_FADE  = 0.06; // seconds — brief flash held after the beam reaches its hit point, before despawning

// ADD:
const MULTIGUN_BEAM_SIZE_SCALE = 2.5; // width/thickness multiplier — bigger = fatter bullet beam

// Reuse the same cross-section beam geometry/material as MG — identical look.
const _multiBeamGeo = _beamGeo;   // shared geometry, no extra GPU buffers
const _multiBeamMat = _beamMat.clone();

const _multiBeamDummy    = new THREE.Object3D();
const _zeroMatrixMulti   = new THREE.Matrix4().makeScale(0, 0, 0);

export class MultiGunSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object}      world
   * @param {object}      explosionSystem
   */
  constructor(scene, world, explosionSystem) {
    this.scene           = scene;
    this.world            = world;
    this.explosionSystem = explosionSystem;

    // Array of THREE.Object3D — set via setGunPoints()
    this._gunPoints = [];

    this.damage     = MULTIGUN_DAMAGE;
    this.range      = MULTIGUN_RANGE;
    this.reloadTime = MULTIGUN_FIRE_RATE;
// console.log('[MultiGunSystem constructed] reloadTime:', this.reloadTime);
    this._fireTimer = 0;
    this.onHit      = null;   // (hitPos, hitEnemyTank|null, damage) => void — set externally by main.js for multiplayer relay
    // Per-beam-slot pending-hit data — flat arrays instead of closures, so
    // deferring hit resolution until the beam visually arrives costs zero
    // allocation per shot (matches the _beamOx/_beamDx-style pooling used
    // everywhere else in this class).
    this._pendingActive  = new Uint8Array(MULTIGUN_BEAM_MAX);   // 0=none 1=player-fired(enemy hit) 2=enemy-fired(player hit)
    this._pendingX       = new Float32Array(MULTIGUN_BEAM_MAX);
    this._pendingY       = new Float32Array(MULTIGUN_BEAM_MAX);
    this._pendingZ       = new Float32Array(MULTIGUN_BEAM_MAX);
    this._pendingDamage  = new Float32Array(MULTIGUN_BEAM_MAX);
    this._pendingTank    = new Array(MULTIGUN_BEAM_MAX).fill(null);   // enemy tank ref for kind 1
    this._pendingNotify  = new Uint8Array(MULTIGUN_BEAM_MAX);          // 1 = call onHitPlayer for kind 2
    this._pendingOnHitPlayer = new Array(MULTIGUN_BEAM_MAX).fill(null); // fn ref (already created by caller) for kind 2

    // Reused for spark-position vector instead of cloning per-hit
    this._scratchResolvedPos = new THREE.Vector3();

    // ── Ammo pool — reload triggers after maxRounds volleys, not per-shot ──
    this.maxRounds      = MULTIGUN_MAX_ROUNDS;
    this.rounds         = MULTIGUN_MAX_ROUNDS;
    this.fullReloadTime = MULTIGUN_RELOAD_TIME;
    this._reloading      = false;   // true while doing the long empty-reload
    this._reloadTimer    = 0;       // counts down during the long reload

    // ── Instanced tracer beam pool (shared style with MG) ──────────────────
    this._beamMesh               = new THREE.InstancedMesh(_multiBeamGeo, _multiBeamMat, MULTIGUN_BEAM_MAX);
    this._beamMesh.frustumCulled = false;
    this._beamMesh.count         = 0;
    this._beamMesh.visible       = false;
    scene.add(this._beamMesh);

    this._beamLifetimes = new Float32Array(MULTIGUN_BEAM_MAX).fill(-1);
    this._beamActive    = 0;

    this._beamOx = new Float32Array(MULTIGUN_BEAM_MAX);
    this._beamOy = new Float32Array(MULTIGUN_BEAM_MAX);
    this._beamOz = new Float32Array(MULTIGUN_BEAM_MAX);
    this._beamDx = new Float32Array(MULTIGUN_BEAM_MAX);
    this._beamDy = new Float32Array(MULTIGUN_BEAM_MAX);
    this._beamDz = new Float32Array(MULTIGUN_BEAM_MAX);
    this._beamTravel   = new Float32Array(MULTIGUN_BEAM_MAX);
    this._beamMaxTravel = new Float32Array(MULTIGUN_BEAM_MAX).fill(MULTIGUN_BEAM_TRAVEL_MAX); // ← ADD — per-slot cap, set to hit distance so the beam stops at whatever it actually hit instead of always traveling MULTIGUN_BEAM_TRAVEL_MAX
    this._beamLenScale = new Float32Array(MULTIGUN_BEAM_MAX).fill(1);

    this._beamQx = new Float32Array(MULTIGUN_BEAM_MAX);
    this._beamQy = new Float32Array(MULTIGUN_BEAM_MAX);
    this._beamQz = new Float32Array(MULTIGUN_BEAM_MAX);
    this._beamQw = new Float32Array(MULTIGUN_BEAM_MAX).fill(1);

    // Scratch — zero allocation in hot paths
    this._scratchOrigin = new THREE.Vector3();
    this._scratchDir    = new THREE.Vector3();
    this._scratchSpread = new THREE.Vector3();
    this._scratchHit    = new THREE.Vector3();
    this._beamFwd       = new THREE.Vector3(0, 0, 1);

    this._ray = null;
  }

  // ── Public API — mirrors MachineGunSystem where sensible ──────────────────

  /** @param {THREE.Object3D[]} gunPointArray — [GunPoint_1, GunPoint_2, ...] */
  setGunPoints(gunPointArray) { this._gunPoints = gunPointArray ?? []; }
setGunPoint(singleGunPoint) { this._gunPoints = singleGunPoint ? [singleGunPoint] : []; }

/** Returns the array of active gun point Object3Ds. */
getGunPoints() { return this._gunPoints; }
  setDamage(dmg)   { this.damage     = dmg; }
  setRange(range)  { this.range      = range; }
  setFireRate(rate){ this.reloadTime = rate; }
  /** No-op — hitscan barrels have no travel speed. Kept for API compat with BulletSystem/ProjectileBulletSystem. */
  setShellSpeed(_speed) {}
  setMaxRounds(n)       { this.maxRounds = n; this.rounds = n; }
  setFullReloadTime(sec){ this.fullReloadTime = sec; }

  get isEmpty() { return this.rounds <= 0; }
  get isReady() {
    return !this._reloading && this._fireTimer <= 0 && this.rounds > 0 && this._gunPoints.length > 0;
  }
  get barrelCount() { return this._gunPoints.length; }
  // "Reloaded" here means ready-to-fire in the BulletSystem-API sense — used
  // by any HUD/main-gun code checking this.bulletSystem.isReloaded generically.
  get isReloaded()     { return this.isReady; }
  get reloadProgress() {
    if (this._reloading) {
      return this.fullReloadTime > 0 ? 1 - Math.max(0, this._reloadTimer) / this.fullReloadTime : 1;
    }
    return this.reloadTime > 0 ? 1 - Math.max(0, this._fireTimer) / this.reloadTime : 1;
  }

  /**
   * Fire all barrels at once. Signature matches BulletSystem/ProjectileBulletSystem
   * so it's a drop-in replacement for tank.js's this.bulletSystem.fire(...) call.
   * @param {object}        tankRigidBody  — shooter's Rapier RigidBody (excluded from raycast)
   * @param {Function|null} onFire
   * @param {Function|null} onRecoil
   * @param {THREE.Vector3|null} overrideDir — optional direction override, applied to all barrels
   * @param {boolean}       isMG           — unused, kept for signature compat
   * @param {Function|null} enemyResolver  — (rbHandle) => EnemyTank | null
   */
  fire(tankRigidBody, onFire = null, onRecoil = null, overrideDir = null, isMG = false, enemyResolver = null, aimWorldPos = null) {
    if (!this.isReady) return false;

    this._fireTimer = this.reloadTime;
    this.rounds     = Math.max(0, this.rounds - 1);
    if (this.rounds <= 0) {
      this._reloading   = true;
      this._reloadTimer = this.fullReloadTime;
    }
    const rigidBody = tankRigidBody;

    const RAPIER = this.world.__RAPIER__;
    if (!this._ray) {
      this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    }

    const count = Math.min(this._gunPoints.length, MULTIGUN_MAX_BARRELS);

    for (let b = 0; b < count; b++) {
      const gp = this._gunPoints[b];
      if (!gp) continue;

      gp.getWorldPosition(this._scratchOrigin);
      if (aimWorldPos) {
        // Cursor-tracked aim point (world position) — each barrel aims from
        // its own position toward the same target, so barrels naturally
        // converge instead of firing parallel.
        this._scratchDir.subVectors(aimWorldPos, this._scratchOrigin).normalize();
      } else if (overrideDir) {
        this._scratchDir.copy(overrideDir);
      } else {
        gp.getWorldDirection(this._scratchDir);
      }

      this._scratchSpread.set(
        (Math.random() - 0.5) * MULTIGUN_SPREAD,
        (Math.random() - 0.5) * MULTIGUN_SPREAD,
        (Math.random() - 0.5) * MULTIGUN_SPREAD
      );
      this._scratchDir.add(this._scratchSpread).normalize();

      this._ray.origin.x = this._scratchOrigin.x;
      this._ray.origin.y = this._scratchOrigin.y;
      this._ray.origin.z = this._scratchOrigin.z;
      this._ray.dir.x    = this._scratchDir.x;
      this._ray.dir.y    = this._scratchDir.y;
      this._ray.dir.z    = this._scratchDir.z;

      const hit = this.world.castRay(
        this._ray, this.range, true,
        undefined, undefined, undefined,
        rigidBody
      );

      // ← ADD — default to the beam's normal max travel; narrowed below
      // to the actual hit distance so the visual beam stops exactly where
      // the raycast stopped (e.g. a house wall), instead of always
      // traveling the full MULTIGUN_BEAM_TRAVEL_MAX regardless of hit.

      let _beamMaxDist = MULTIGUN_BEAM_TRAVEL_MAX;
      let _hasHit  = false;
      let _hitX = 0, _hitY = 0, _hitZ = 0;
      let _hitTank = null;

      if (hit) {
        _hitX = this._scratchOrigin.x + this._scratchDir.x * hit.timeOfImpact;
        _hitY = this._scratchOrigin.y + this._scratchDir.y * hit.timeOfImpact;
        _hitZ = this._scratchOrigin.z + this._scratchDir.z * hit.timeOfImpact;
        _beamMaxDist = Math.min(hit.timeOfImpact, MULTIGUN_BEAM_TRAVEL_MAX);
        _hasHit = true;

        if (enemyResolver) {
          const collider  = this.world.getCollider(hit.collider.handle);
          const rbHandle  = collider?.parent()?.handle;
          _hitTank = enemyResolver(rbHandle);
        }
      }

      this._scratchOrigin.set(this._scratchOrigin.x, this._scratchOrigin.y, this._scratchOrigin.z); // no-op, origin already correct — kept for clarity of intent
      const _slot = this._spawnBeam(this._scratchOrigin, this._scratchDir, _beamMaxDist);

      if (_slot !== -1) {
        if (_hasHit) {
          this._pendingActive[_slot] = 1;
          this._pendingX[_slot]      = _hitX;
          this._pendingY[_slot]      = _hitY;
          this._pendingZ[_slot]      = _hitZ;
          this._pendingDamage[_slot] = this.damage;
          this._pendingTank[_slot]   = _hitTank;
        } else {
          this._pendingActive[_slot] = 0;
        }
      } else if (_hasHit) {
        // Beam pool was full — no visual to sync to, resolve immediately.
        this._applyMultiGunPlayerHit(_hitX, _hitY, _hitZ, this.damage, _hitTank);
      }

      this.explosionSystem?.spawnMGMuzzleFlash(this._scratchOrigin);
      this.explosionSystem?.spawnMultiGunSmoke(this._scratchOrigin);
      this.explosionSystem?.spawnBulletShells(this._scratchOrigin, this._scratchDir);
    }

    onFire?.();
    onRecoil?.();
    return true;
  }

  /**
   * Enemy-fire entry point — mirrors fire()'s per-barrel loop but matches
   * the fireFromPoint(...) signature used by BulletSystem/ProjectileBulletSystem
   * so EnemyTank.update() can call any weapon system uniformly.
   * @param {THREE.Vector3} origin         — unused; each barrel supplies its own world position (kept for API parity)
   * @param {THREE.Vector3} direction      — aim direction override applied to every barrel
   * @param {object|null}   excludeBody    — shooter's own RigidBody, excluded from each barrel's raycast
   * @param {Function|null} onHitPlayer    — called once per barrel that actually hits the target body
   * @param {object|null}   targetRigidBody — RigidBody to match against for onHitPlayer
   */
  fireFromPoint(origin, direction, excludeBody = null, onHitPlayer = null, targetRigidBody = null) {
    if (!this.isReady) return false;

    this._fireTimer = this.reloadTime;
    this.rounds     = Math.max(0, this.rounds - 1);
    if (this.rounds <= 0) {
      this._reloading   = true;
      this._reloadTimer = this.fullReloadTime;
    }

    const RAPIER = this.world.__RAPIER__;
    if (!this._ray) {
      this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    }

    const count = Math.min(this._gunPoints.length, MULTIGUN_MAX_BARRELS);
    const targetHandle = targetRigidBody?.handle;

    for (let b = 0; b < count; b++) {
      const gp = this._gunPoints[b];
      if (!gp) continue;

      gp.getWorldPosition(this._scratchOrigin);
      if (direction) {
        // Explicit shared aim direction (e.g. a turret's computed line-of-
        // fire) — used as-is for every barrel.
        this._scratchDir.copy(direction);
      } else {
        // No direction override — fire straight along THIS barrel's own
        // current world-facing, so each GunPoint_N shoots exactly where its
        // mesh is physically pointing rather than being forced onto one
        // shared vector computed from somewhere else (e.g. a turret pivot).
        gp.getWorldDirection(this._scratchDir);
      }

      this._scratchSpread.set(
        (Math.random() - 0.5) * MULTIGUN_SPREAD,
        (Math.random() - 0.5) * MULTIGUN_SPREAD,
        (Math.random() - 0.5) * MULTIGUN_SPREAD
      );
      this._scratchDir.add(this._scratchSpread).normalize();

      this._ray.origin.x = this._scratchOrigin.x;
      this._ray.origin.y = this._scratchOrigin.y;
      this._ray.origin.z = this._scratchOrigin.z;
      this._ray.dir.x    = this._scratchDir.x;
      this._ray.dir.y    = this._scratchDir.y;
      this._ray.dir.z    = this._scratchDir.z;

      const hit = this.world.castRay(
        this._ray, this.range, true,
        undefined, undefined, undefined,
        excludeBody ?? undefined
      );

      let _beamMaxDist = MULTIGUN_BEAM_TRAVEL_MAX;
      let _hasHit  = false;
      let _hitX = 0, _hitY = 0, _hitZ = 0;
      let _shouldNotify = false;

      if (hit) {
        _hitX = this._scratchOrigin.x + this._scratchDir.x * hit.timeOfImpact;
        _hitY = this._scratchOrigin.y + this._scratchDir.y * hit.timeOfImpact;
        _hitZ = this._scratchOrigin.z + this._scratchDir.z * hit.timeOfImpact;
        _beamMaxDist = Math.min(hit.timeOfImpact, MULTIGUN_BEAM_TRAVEL_MAX);
        _hasHit = true;

        if (onHitPlayer && targetHandle !== undefined) {
          const collider = this.world.getCollider(hit.collider.handle);
          const rbHandle  = collider?.parent()?.handle;
          if (rbHandle === targetHandle) _shouldNotify = true;
        }
      }

      const _slot = this._spawnBeam(this._scratchOrigin, this._scratchDir, _beamMaxDist);

      if (_slot !== -1) {
        if (_hasHit) {
          this._pendingActive[_slot]      = 2;
          this._pendingX[_slot]           = _hitX;
          this._pendingY[_slot]           = _hitY;
          this._pendingZ[_slot]           = _hitZ;
          this._pendingNotify[_slot]      = _shouldNotify ? 1 : 0;
          this._pendingOnHitPlayer[_slot] = onHitPlayer; // already-existing fn ref, not a new closure
        } else {
          this._pendingActive[_slot] = 0;
        }
      } else if (_hasHit) {
        this._applyMultiGunEnemyHit(_hitX, _hitY, _hitZ, _shouldNotify, onHitPlayer);
      }

      this.explosionSystem?.spawnMGMuzzleFlash(this._scratchOrigin);
    }

    return true;
  }

    // ── Apply a deferred player→enemy hit (spark + damage) ─────────────────
  _applyMultiGunPlayerHit(x, y, z, dmg, tank) {
    this._scratchResolvedPos.set(x, y, z);
    this.explosionSystem?.spawnSpark(this._scratchResolvedPos);
    if (tank) {
      tank._lastHitBy = 'player';   // ← kill-credit attribution
      tank.takeDamage(dmg);
    }
    this.onHit?.(this._scratchResolvedPos.clone(), tank, dmg);
  }

  // ── Apply a deferred enemy→player hit (spark + notify) ─────────────────
  _applyMultiGunEnemyHit(x, y, z, notify, onHitPlayerFn) {
    this._scratchResolvedPos.set(x, y, z);
    this.explosionSystem?.spawnSpark(this._scratchResolvedPos);
    if (notify) onHitPlayerFn?.();
  }

    // ── Dispatch a pending slot's hit to the correct apply method, then clear it ──
  _resolvePendingSlot(i) {
    const kind = this._pendingActive[i];
    this._pendingActive[i] = 0;

    if (kind === 1) {
      const tank = this._pendingTank[i];
      this._pendingTank[i] = null;   // drop ref promptly, avoid holding onto dead tanks
      this._applyMultiGunPlayerHit(
        this._pendingX[i], this._pendingY[i], this._pendingZ[i],
        this._pendingDamage[i], tank
      );
    } else if (kind === 2) {
      const fn = this._pendingOnHitPlayer[i];
      this._pendingOnHitPlayer[i] = null;
      this._applyMultiGunEnemyHit(
        this._pendingX[i], this._pendingY[i], this._pendingZ[i],
        this._pendingNotify[i] === 1, fn
      );
    }
  }

  // ── Tracer beam pool (identical mechanics to MachineGunSystem) ────────────

  _spawnBeam(origin, direction, maxTravel = MULTIGUN_BEAM_TRAVEL_MAX) {
    let slot = -1;
    for (let i = 0; i < MULTIGUN_BEAM_MAX; i++) {
      if (this._beamLifetimes[i] <= 0) { slot = i; break; }
    }
    if (slot === -1) return -1; // pool full — skip visual for this barrel (rare)

    this._beamTravel[slot]    = 0;
    this._beamMaxTravel[slot] = Math.max(0, Math.min(maxTravel, MULTIGUN_BEAM_TRAVEL_MAX)); // clamp so the beam never travels further than what it actually hit

    // Shorten this beam's lifetime to roughly the time it takes to reach its
    // actual hit point (+ a brief flash), instead of always running the full
    // MULTIGUN_BEAM_LIFETIME. Without this, a close-range hit (e.g. hitting
    // the player) reaches its target almost instantly, then sits frozen in
    // place — fully opaque, not moving — for the rest of its lifetime,
    // reading as a visual freeze/glitch right at the impact point.
    const _arriveTime = this._beamMaxTravel[slot] / MULTIGUN_BEAM_TRAVEL_SPEED;
    this._beamLifetimes[slot] = Math.min(MULTIGUN_BEAM_LIFETIME, _arriveTime + MULTIGUN_BEAM_ARRIVE_FADE);

    const lenScale = 2.5 + Math.random() * 0.6;
    this._beamLenScale[slot] = lenScale;

    this._beamOx[slot] = origin.x;
    this._beamOy[slot] = origin.y;
    this._beamOz[slot] = origin.z;
    this._beamDx[slot] = direction.x;
    this._beamDy[slot] = direction.y;
    this._beamDz[slot] = direction.z;

    const halfLen = MULTIGUN_BEAM_LENGTH * lenScale * 0.5;
    _multiBeamDummy.position.set(
      origin.x + direction.x * halfLen,
      origin.y + direction.y * halfLen,
      origin.z + direction.z * halfLen
    );
    _multiBeamDummy.quaternion.setFromUnitVectors(this._beamFwd, direction);

    this._beamQx[slot] = _multiBeamDummy.quaternion.x;
    this._beamQy[slot] = _multiBeamDummy.quaternion.y;
    this._beamQz[slot] = _multiBeamDummy.quaternion.z;
    this._beamQw[slot] = _multiBeamDummy.quaternion.w;

    _multiBeamDummy.scale.set(MULTIGUN_BEAM_SIZE_SCALE, MULTIGUN_BEAM_SIZE_SCALE, lenScale);
    _multiBeamDummy.updateMatrix();

    this._beamMesh.setMatrixAt(slot, _multiBeamDummy.matrix);
    this._beamMesh.instanceMatrix.needsUpdate = true;
    this._beamActive       = Math.min(MULTIGUN_BEAM_MAX, this._beamActive + 1);
    this._beamMesh.count   = this._beamActive;
    this._beamMesh.visible = true;
    return slot;
  }

  // ── Update — ticks fire cooldown + travels/fades beams ─────────────────────

  update(dt) {
    if (this._fireTimer > 0) this._fireTimer -= dt;

    if (this._reloading) {
      this._reloadTimer -= dt;
      if (this._reloadTimer <= 0) {
        this._reloading   = false;
        this._reloadTimer = 0;
        this.rounds       = this.maxRounds;
      }
    }

    if (this._beamActive === 0) return;

    let maxActive = 0;
    let dirty     = false;

    for (let i = 0; i < MULTIGUN_BEAM_MAX; i++) {
      if (this._beamLifetimes[i] <= 0) continue;

      this._beamLifetimes[i] -= dt;

      if (this._beamLifetimes[i] <= 0) {
        this._beamMesh.setMatrixAt(i, _zeroMatrixMulti);
        this._beamLifetimes[i] = -1;
        // Safety net — resolve any hit that somehow never got triggered by
        // the arrival check below (shouldn't normally happen), so damage/
        // hit-fx is never silently dropped.
        if (this._pendingActive[i] !== 0) {
          this._resolvePendingSlot(i);
        }
        dirty = true;
      } else {
        const _wasArrived = this._beamTravel[i] >= this._beamMaxTravel[i];
        this._beamTravel[i] = Math.min(
          this._beamTravel[i] + MULTIGUN_BEAM_TRAVEL_SPEED * dt,
          this._beamMaxTravel[i]   // ← was MULTIGUN_BEAM_TRAVEL_MAX — now stops at this shot's actual hit distance
        );

        // Beam just reached its target this frame — apply the actual hit
        // (spark/damage/onHit) NOW, in sync with the visual arrival, instead
        // of back when the raycast was originally cast.
        if (!_wasArrived && this._beamTravel[i] >= this._beamMaxTravel[i] && this._pendingActive[i] !== 0) {
          this._resolvePendingSlot(i);
        }

        const t = this._beamTravel[i];
        const halfLen = MULTIGUN_BEAM_LENGTH * this._beamLenScale[i] * 0.5;
        const cx = this._beamOx[i] + this._beamDx[i] * (t + halfLen);
        const cy = this._beamOy[i] + this._beamDy[i] * (t + halfLen);
        const cz = this._beamOz[i] + this._beamDz[i] * (t + halfLen);

        _multiBeamDummy.position.set(cx, cy, cz);
        _multiBeamDummy.quaternion.set(this._beamQx[i], this._beamQy[i], this._beamQz[i], this._beamQw[i]);
        _multiBeamDummy.scale.set(MULTIGUN_BEAM_SIZE_SCALE, MULTIGUN_BEAM_SIZE_SCALE, this._beamLenScale[i]);
        _multiBeamDummy.updateMatrix();
        this._beamMesh.setMatrixAt(i, _multiBeamDummy.matrix);

        dirty     = true;
        maxActive = i + 1;
      }
    }

    this._beamActive       = maxActive;
    this._beamMesh.count   = maxActive;
    this._beamMesh.visible = maxActive > 0;

    if (dirty) this._beamMesh.instanceMatrix.needsUpdate = true;
  }

  /** Same purpose as MachineGunSystem.clearBeams() — see that comment. */
  clearBeams() {
    if (this._beamActive === 0) return;
    for (let i = 0; i < MULTIGUN_BEAM_MAX; i++) {
      if (this._beamLifetimes[i] <= 0) continue;
      this._beamMesh.setMatrixAt(i, _zeroMatrixMulti);
      this._beamLifetimes[i] = -1;
    }
    this._beamActive       = 0;
    this._beamMesh.count   = 0;
    this._beamMesh.visible = false;
    this._beamMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    // NOTE: _beamGeo (shared with MachineGunSystem) and _multiBeamMat (a
    // module-level clone, but still shared by every MultiGunSystem instance)
    // must not be disposed per-instance — same reasoning as
    // MachineGunSystem.dispose() above.
    this._beamMesh.visible = false;
    this._beamMesh.count   = 0;
    this._beamMesh.removeFromParent();
  }
}


// ── Hispano Bullet System (gunType: 4) ──────────────────────────────────────
// Multi-barrel hitscan cannon in the style of MultiGunSystem — same
// deferred-hit-resolution / beam-arrival pattern — but tuned as a heavier,
// slower-firing autocannon: fewer barrels, higher per-hit damage, longer
// range, lower rate of fire than MultiGunSystem/MachineGunSystem.

const HISPANO_MAX_BARRELS = 4;     // classic quad-cannon bank
const HISPANO_FIRE_RATE   = 0.20;  // seconds between volleys — slower than MultiGunSystem
const HISPANO_RANGE       = 600;
const HISPANO_DAMAGE      = 45;
const HISPANO_SPREAD      = 0.006; // tighter spread — heavier, more accurate cannon
const HISPANO_MAX_ROUNDS  = 60;    // rounds per drum before reload
const HISPANO_RELOAD_TIME = 5.0;    // seconds for a full reload

const HISPANO_BEAM_MAX      = HISPANO_MAX_BARRELS * 3;
const HISPANO_BEAM_LIFETIME = 0.5;
const HISPANO_BEAM_LENGTH   = 1.8;
const HISPANO_BEAM_TRAVEL_SPEED = 180;
const HISPANO_BEAM_TRAVEL_MAX   = 60;
const HISPANO_BEAM_ARRIVE_FADE  = 0.06;

const HISPANO_BEAM_SIZE_SCALE = 4; // width/thickness multiplier — bigger = fatter bullet beam

// Reuse the same cross-section beam geometry as MG/MultiGun — own material
// clone so color/uniforms can diverge (e.g. a cooler muzzle color) without
// affecting the other weapon systems' shared instances.
const _hispanoBeamGeo = _beamGeo;
const _hispanoBeamMat = _beamMat.clone();
_hispanoBeamMat.color = new THREE.Color(0xffaa33); // tint Hispano rounds differently from MG/MultiGun

const _hispanoBeamDummy  = new THREE.Object3D();
const _zeroMatrixHispano = new THREE.Matrix4().makeScale(0, 0, 0);

export class HispanoBulletSystem {
  constructor(scene, world, explosionSystem) {
    this.scene           = scene;
    this.world            = world;
    this.explosionSystem = explosionSystem;

    this._gunPoints = [];

    this.damage     = HISPANO_DAMAGE;
    this.range      = HISPANO_RANGE;
    this.reloadTime = HISPANO_FIRE_RATE;
    this._fireTimer = 0;
    this.onHit      = null;

    this._pendingActive  = new Uint8Array(HISPANO_BEAM_MAX);
    this._pendingX       = new Float32Array(HISPANO_BEAM_MAX);
    this._pendingY       = new Float32Array(HISPANO_BEAM_MAX);
    this._pendingZ       = new Float32Array(HISPANO_BEAM_MAX);
    this._pendingDamage  = new Float32Array(HISPANO_BEAM_MAX);
    this._pendingTank    = new Array(HISPANO_BEAM_MAX).fill(null);
    this._pendingNotify  = new Uint8Array(HISPANO_BEAM_MAX);
    this._pendingOnHitPlayer = new Array(HISPANO_BEAM_MAX).fill(null);

    this._scratchResolvedPos = new THREE.Vector3();

    this.maxRounds      = HISPANO_MAX_ROUNDS;   // magazine/drum capacity
    this.rounds         = HISPANO_MAX_ROUNDS;   // currently loaded
    this.totalAmmo      = HISPANO_MAX_ROUNDS;   // ← true reserve pool (loaded + reserve combined)
    this.fullReloadTime = HISPANO_RELOAD_TIME;
    this._reloading      = false;
    this._reloadTimer    = 0;

    this._beamMesh               = new THREE.InstancedMesh(_hispanoBeamGeo, _hispanoBeamMat, HISPANO_BEAM_MAX);
    this._beamMesh.frustumCulled = false;
    this._beamMesh.count         = 0;
    this._beamMesh.visible       = false;
    scene.add(this._beamMesh);

    this._beamLifetimes = new Float32Array(HISPANO_BEAM_MAX).fill(-1);
    this._beamActive    = 0;

    this._beamOx = new Float32Array(HISPANO_BEAM_MAX);
    this._beamOy = new Float32Array(HISPANO_BEAM_MAX);
    this._beamOz = new Float32Array(HISPANO_BEAM_MAX);
    this._beamDx = new Float32Array(HISPANO_BEAM_MAX);
    this._beamDy = new Float32Array(HISPANO_BEAM_MAX);
    this._beamDz = new Float32Array(HISPANO_BEAM_MAX);
    this._beamTravel    = new Float32Array(HISPANO_BEAM_MAX);
    this._beamMaxTravel = new Float32Array(HISPANO_BEAM_MAX).fill(HISPANO_BEAM_TRAVEL_MAX);
    this._beamLenScale  = new Float32Array(HISPANO_BEAM_MAX).fill(1);

    this._beamQx = new Float32Array(HISPANO_BEAM_MAX);
    this._beamQy = new Float32Array(HISPANO_BEAM_MAX);
    this._beamQz = new Float32Array(HISPANO_BEAM_MAX);
    this._beamQw = new Float32Array(HISPANO_BEAM_MAX).fill(1);

    this._scratchOrigin = new THREE.Vector3();
    this._scratchDir    = new THREE.Vector3();
    this._scratchSpread = new THREE.Vector3();
    this._scratchHit    = new THREE.Vector3();
    this._beamFwd       = new THREE.Vector3(0, 0, 1);

    this._ray = null;
  }

  // ── Public API — mirrors MultiGunSystem ────────────────────────────────────

  setGunPoints(gunPointArray) { this._gunPoints = gunPointArray ?? []; }
  setGunPoint(singleGunPoint) { this._gunPoints = singleGunPoint ? [singleGunPoint] : []; }
  getGunPoints() { return this._gunPoints; }
  setDamage(dmg)   { this.damage     = dmg; }
  setRange(range)  { this.range      = range; }
  setFireRate(rate){ this.reloadTime = rate; }
  setShellSpeed(_speed) {}
  /** Sets the DRUM/MAGAZINE capacity (how many rounds are loaded and can be
   * fired before a reload is needed) — NOT the total ammo pool. */
  setMagSize(n) {
    this.maxRounds = n;
    this.rounds = Math.min(this.rounds, n, this.totalAmmo);
  }
  /** Sets the TOTAL reserve pool (loaded + reserve combined) — the real
   * ammo ceiling across every reload this life. */
  setTotalAmmo(n) {
    this.totalAmmo = n;
    this.rounds = Math.min(this.rounds, this.maxRounds, this.totalAmmo);
  }
  /** Back-compat convenience — sets BOTH magazine size and total pool to
   * the same value (old callers that only ever passed one number). */
  setMaxRounds(n) {
    this.maxRounds = n;
    this.totalAmmo = n;
    this.rounds = n;
  }
  setFullReloadTime(sec) { this.fullReloadTime = sec; }

  get isEmpty() { return this.totalAmmo <= 0; }
  get isReady() {
    return !this._reloading && this._fireTimer <= 0 && this.rounds > 0 && this._gunPoints.length > 0;
  }
  get barrelCount() { return this._gunPoints.length; }
  get isReloaded()     { return this.isReady; }
  get reloadProgress() {
    if (this._reloading) {
      return this.fullReloadTime > 0 ? 1 - Math.max(0, this._reloadTimer) / this.fullReloadTime : 1;
    }
    return this.reloadTime > 0 ? 1 - Math.max(0, this._fireTimer) / this.reloadTime : 1;
  }

  fire(tankRigidBody, onFire = null, onRecoil = null, overrideDir = null, isMG = false, enemyResolver = null, aimWorldPos = null) {
    if (!this.isReady) return false;

    this._fireTimer = this.reloadTime;
    this.rounds     = Math.max(0, this.rounds - 1);
    this.totalAmmo  = Math.max(0, this.totalAmmo - 1);
    if (this.rounds <= 0 && this.totalAmmo > 0) {
      this._reloading   = true;
      this._reloadTimer = this.fullReloadTime;
    }
    const rigidBody = tankRigidBody;

    const RAPIER = this.world.__RAPIER__;
    if (!this._ray) {
      this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    }

    const count = Math.min(this._gunPoints.length, HISPANO_MAX_BARRELS);

    for (let b = 0; b < count; b++) {
      const gp = this._gunPoints[b];
      if (!gp) continue;

      gp.getWorldPosition(this._scratchOrigin);
      if (aimWorldPos) {
        this._scratchDir.subVectors(aimWorldPos, this._scratchOrigin).normalize();
      } else if (overrideDir) {
        this._scratchDir.copy(overrideDir);
      } else {
        gp.getWorldDirection(this._scratchDir);
      }

      this._scratchSpread.set(
        (Math.random() - 0.5) * HISPANO_SPREAD,
        (Math.random() - 0.5) * HISPANO_SPREAD,
        (Math.random() - 0.5) * HISPANO_SPREAD
      );
      this._scratchDir.add(this._scratchSpread).normalize();

      this._ray.origin.x = this._scratchOrigin.x;
      this._ray.origin.y = this._scratchOrigin.y;
      this._ray.origin.z = this._scratchOrigin.z;
      this._ray.dir.x    = this._scratchDir.x;
      this._ray.dir.y    = this._scratchDir.y;
      this._ray.dir.z    = this._scratchDir.z;

      const hit = this.world.castRay(
        this._ray, this.range, true,
        undefined, undefined, undefined,
        rigidBody
      );

      let _beamMaxDist = HISPANO_BEAM_TRAVEL_MAX;
      let _hasHit  = false;
      let _hitX = 0, _hitY = 0, _hitZ = 0;
      let _hitTank = null;

      if (hit) {
        _hitX = this._scratchOrigin.x + this._scratchDir.x * hit.timeOfImpact;
        _hitY = this._scratchOrigin.y + this._scratchDir.y * hit.timeOfImpact;
        _hitZ = this._scratchOrigin.z + this._scratchDir.z * hit.timeOfImpact;
        _beamMaxDist = Math.min(hit.timeOfImpact, HISPANO_BEAM_TRAVEL_MAX);
        _hasHit = true;

        if (enemyResolver) {
          const collider  = this.world.getCollider(hit.collider.handle);
          const rbHandle  = collider?.parent()?.handle;
          _hitTank = enemyResolver(rbHandle);
        }
      }

      const _slot = this._spawnBeam(this._scratchOrigin, this._scratchDir, _beamMaxDist);

      if (_slot !== -1) {
        if (_hasHit) {
          this._pendingActive[_slot] = 1;
          this._pendingX[_slot]      = _hitX;
          this._pendingY[_slot]      = _hitY;
          this._pendingZ[_slot]      = _hitZ;
          this._pendingDamage[_slot] = this.damage;
          this._pendingTank[_slot]   = _hitTank;
        } else {
          this._pendingActive[_slot] = 0;
        }
      } else if (_hasHit) {
        this._applyHispanoPlayerHit(_hitX, _hitY, _hitZ, this.damage, _hitTank);
      }

      this.explosionSystem?.spawnMGMuzzleFlash(this._scratchOrigin);
      this.explosionSystem?.spawnMultiGunSmoke(this._scratchOrigin);
      this.explosionSystem?.spawnBulletShells(this._scratchOrigin, this._scratchDir);
    }

    onFire?.();
    onRecoil?.();
    return true;
  }

  fireFromPoint(origin, direction, excludeBody = null, onHitPlayer = null, targetRigidBody = null) {
    if (!this.isReady) return false;

    this._fireTimer = this.reloadTime;
    this.rounds     = Math.max(0, this.rounds - 1);
    this.totalAmmo  = Math.max(0, this.totalAmmo - 1);
    if (this.rounds <= 0 && this.totalAmmo > 0) {
      this._reloading   = true;
      this._reloadTimer = this.fullReloadTime;
    }

    const RAPIER = this.world.__RAPIER__;
    if (!this._ray) {
      this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    }

    const count = Math.min(this._gunPoints.length, HISPANO_MAX_BARRELS);
    const targetHandle = targetRigidBody?.handle;

    for (let b = 0; b < count; b++) {
      const gp = this._gunPoints[b];
      if (!gp) continue;

      gp.getWorldPosition(this._scratchOrigin);
      this._scratchDir.copy(direction);

      this._scratchSpread.set(
        (Math.random() - 0.5) * HISPANO_SPREAD,
        (Math.random() - 0.5) * HISPANO_SPREAD,
        (Math.random() - 0.5) * HISPANO_SPREAD
      );
      this._scratchDir.add(this._scratchSpread).normalize();

      this._ray.origin.x = this._scratchOrigin.x;
      this._ray.origin.y = this._scratchOrigin.y;
      this._ray.origin.z = this._scratchOrigin.z;
      this._ray.dir.x    = this._scratchDir.x;
      this._ray.dir.y    = this._scratchDir.y;
      this._ray.dir.z    = this._scratchDir.z;

      const hit = this.world.castRay(
        this._ray, this.range, true,
        undefined, undefined, undefined,
        excludeBody ?? undefined
      );

      let _beamMaxDist = HISPANO_BEAM_TRAVEL_MAX;
      let _hasHit  = false;
      let _hitX = 0, _hitY = 0, _hitZ = 0;
      let _shouldNotify = false;

      if (hit) {
        _hitX = this._scratchOrigin.x + this._scratchDir.x * hit.timeOfImpact;
        _hitY = this._scratchOrigin.y + this._scratchDir.y * hit.timeOfImpact;
        _hitZ = this._scratchOrigin.z + this._scratchDir.z * hit.timeOfImpact;
        _beamMaxDist = Math.min(hit.timeOfImpact, HISPANO_BEAM_TRAVEL_MAX);
        _hasHit = true;

        if (onHitPlayer && targetHandle !== undefined) {
          const collider = this.world.getCollider(hit.collider.handle);
          const rbHandle  = collider?.parent()?.handle;
          if (rbHandle === targetHandle) _shouldNotify = true;
        }
      }

      const _slot = this._spawnBeam(this._scratchOrigin, this._scratchDir, _beamMaxDist);

      if (_slot !== -1) {
        if (_hasHit) {
          this._pendingActive[_slot]      = 2;
          this._pendingX[_slot]           = _hitX;
          this._pendingY[_slot]           = _hitY;
          this._pendingZ[_slot]           = _hitZ;
          this._pendingNotify[_slot]      = _shouldNotify ? 1 : 0;
          this._pendingOnHitPlayer[_slot] = onHitPlayer;
        } else {
          this._pendingActive[_slot] = 0;
        }
      } else if (_hasHit) {
        this._applyHispanoEnemyHit(_hitX, _hitY, _hitZ, _shouldNotify, onHitPlayer);
      }

      this.explosionSystem?.spawnMGMuzzleFlash(this._scratchOrigin);
    }

    return true;
  }

  _applyHispanoPlayerHit(x, y, z, dmg, tank) {
    this._scratchResolvedPos.set(x, y, z);
    this.explosionSystem?.spawnSpark(this._scratchResolvedPos);
    if (tank) {
      tank._lastHitBy = 'player';
      tank.takeDamage(dmg);
    }
    this.onHit?.(this._scratchResolvedPos.clone(), tank, dmg);
  }

  _applyHispanoEnemyHit(x, y, z, notify, onHitPlayerFn) {
    this._scratchResolvedPos.set(x, y, z);
    this.explosionSystem?.spawnSpark(this._scratchResolvedPos);
    if (notify) onHitPlayerFn?.();
  }

  _resolvePendingSlot(i) {
    const kind = this._pendingActive[i];
    this._pendingActive[i] = 0;

    if (kind === 1) {
      const tank = this._pendingTank[i];
      this._pendingTank[i] = null;
      this._applyHispanoPlayerHit(
        this._pendingX[i], this._pendingY[i], this._pendingZ[i],
        this._pendingDamage[i], tank
      );
    } else if (kind === 2) {
      const fn = this._pendingOnHitPlayer[i];
      this._pendingOnHitPlayer[i] = null;
      this._applyHispanoEnemyHit(
        this._pendingX[i], this._pendingY[i], this._pendingZ[i],
        this._pendingNotify[i] === 1, fn
      );
    }
  }

  _spawnBeam(origin, direction, maxTravel = HISPANO_BEAM_TRAVEL_MAX) {
    let slot = -1;
    for (let i = 0; i < HISPANO_BEAM_MAX; i++) {
      if (this._beamLifetimes[i] <= 0) { slot = i; break; }
    }
    if (slot === -1) return -1;

    this._beamTravel[slot]    = 0;
    this._beamMaxTravel[slot] = Math.max(0, Math.min(maxTravel, HISPANO_BEAM_TRAVEL_MAX));

    const _arriveTime = this._beamMaxTravel[slot] / HISPANO_BEAM_TRAVEL_SPEED;
    this._beamLifetimes[slot] = Math.min(HISPANO_BEAM_LIFETIME, _arriveTime + HISPANO_BEAM_ARRIVE_FADE);

    const lenScale = 4.0 + Math.random() * 0.6;
    this._beamLenScale[slot] = lenScale;

    this._beamOx[slot] = origin.x;
    this._beamOy[slot] = origin.y;
    this._beamOz[slot] = origin.z;
    this._beamDx[slot] = direction.x;
    this._beamDy[slot] = direction.y;
    this._beamDz[slot] = direction.z;

    const halfLen = HISPANO_BEAM_LENGTH * lenScale * 0.5;
    _hispanoBeamDummy.position.set(
      origin.x + direction.x * halfLen,
      origin.y + direction.y * halfLen,
      origin.z + direction.z * halfLen
    );
    _hispanoBeamDummy.quaternion.setFromUnitVectors(this._beamFwd, direction);

    this._beamQx[slot] = _hispanoBeamDummy.quaternion.x;
    this._beamQy[slot] = _hispanoBeamDummy.quaternion.y;
    this._beamQz[slot] = _hispanoBeamDummy.quaternion.z;
    this._beamQw[slot] = _hispanoBeamDummy.quaternion.w;

    _hispanoBeamDummy.scale.set(HISPANO_BEAM_SIZE_SCALE, HISPANO_BEAM_SIZE_SCALE, lenScale);
    _hispanoBeamDummy.updateMatrix();

    this._beamMesh.setMatrixAt(slot, _hispanoBeamDummy.matrix);
    this._beamMesh.instanceMatrix.needsUpdate = true;
    this._beamActive       = Math.min(HISPANO_BEAM_MAX, this._beamActive + 1);
    this._beamMesh.count   = this._beamActive;
    this._beamMesh.visible = true;
    return slot;
  }

  update(dt) {
    if (this._fireTimer > 0) this._fireTimer -= dt;

    if (this._reloading) {
      this._reloadTimer -= dt;
      if (this._reloadTimer <= 0) {
        this._reloading   = false;
        this._reloadTimer = 0;
        this.rounds       = Math.min(this.maxRounds, this.totalAmmo);
      }
    }

    // Reserve is exhausted — force the magazine dry and cancel any
    // straggling reload instead of refilling forever.
    if (this.totalAmmo <= 0) {
      this.rounds     = 0;
      this._reloading = false;
    }

    if (this._beamActive === 0) return;

    let maxActive = 0;
    let dirty     = false;

    for (let i = 0; i < HISPANO_BEAM_MAX; i++) {
      if (this._beamLifetimes[i] <= 0) continue;

      this._beamLifetimes[i] -= dt;

      if (this._beamLifetimes[i] <= 0) {
        this._beamMesh.setMatrixAt(i, _zeroMatrixHispano);
        this._beamLifetimes[i] = -1;
        if (this._pendingActive[i] !== 0) {
          this._resolvePendingSlot(i);
        }
        dirty = true;
      } else {
        const _wasArrived = this._beamTravel[i] >= this._beamMaxTravel[i];
        this._beamTravel[i] = Math.min(
          this._beamTravel[i] + HISPANO_BEAM_TRAVEL_SPEED * dt,
          this._beamMaxTravel[i]
        );

        if (!_wasArrived && this._beamTravel[i] >= this._beamMaxTravel[i] && this._pendingActive[i] !== 0) {
          this._resolvePendingSlot(i);
        }

        const t = this._beamTravel[i];
        const halfLen = HISPANO_BEAM_LENGTH * this._beamLenScale[i] * 0.5;
        const cx = this._beamOx[i] + this._beamDx[i] * (t + halfLen);
        const cy = this._beamOy[i] + this._beamDy[i] * (t + halfLen);
        const cz = this._beamOz[i] + this._beamDz[i] * (t + halfLen);

        _hispanoBeamDummy.position.set(cx, cy, cz);
        _hispanoBeamDummy.quaternion.set(this._beamQx[i], this._beamQy[i], this._beamQz[i], this._beamQw[i]);
        _hispanoBeamDummy.scale.set(HISPANO_BEAM_SIZE_SCALE, HISPANO_BEAM_SIZE_SCALE, this._beamLenScale[i]);
        _hispanoBeamDummy.updateMatrix();
        this._beamMesh.setMatrixAt(i, _hispanoBeamDummy.matrix);

        dirty     = true;
        maxActive = i + 1;
      }
    }

    this._beamActive       = maxActive;
    this._beamMesh.count   = maxActive;
    this._beamMesh.visible = maxActive > 0;

    if (dirty) this._beamMesh.instanceMatrix.needsUpdate = true;
  }

  clearBeams() {
    if (this._beamActive === 0) return;
    for (let i = 0; i < HISPANO_BEAM_MAX; i++) {
      if (this._beamLifetimes[i] <= 0) continue;
      this._beamMesh.setMatrixAt(i, _zeroMatrixHispano);
      this._beamLifetimes[i] = -1;
    }
    this._beamActive       = 0;
    this._beamMesh.count   = 0;
    this._beamMesh.visible = false;
    this._beamMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    // NOTE: _hispanoBeamGeo is shared (== _beamGeo). _hispanoBeamMat is a
    // module-level clone shared by every HispanoBulletSystem instance —
    // never dispose either here, only detach this instance's mesh.
    this._beamMesh.visible = false;
    this._beamMesh.count   = 0;
    this._beamMesh.removeFromParent();
  }
}


// ── Projectile Bullet System (gunType: 2) ─────────────────────────────────
// Arc-path projectile: pure JS simulation + per-frame segment raycast.
// Zero Rapier allocations per shot. InstancedMesh pool for visuals.

const PROJ_MAX         = 8;
const PROJ_GRAVITY     = 22;
const PROJ_LIFETIME    = 6.0;
// const PROJ_DAMAGE      = 10;
// const PROJ_RANGE       = 300;

const PROJ_SHELL_RADIUS  = 0.06;
const PROJ_SHELL_LENGTH  = 0.35;

const _shellGeo = new THREE.CylinderGeometry(
  PROJ_SHELL_RADIUS * 0.5, PROJ_SHELL_RADIUS, PROJ_SHELL_LENGTH, 7, 1
);
_shellGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));

const _shellMat = new THREE.MeshStandardMaterial({
  color: 0xffaa22,
  emissive: 0xffdd44,
  emissiveIntensity: 50
});

const _shellDummy   = new THREE.Object3D();
const _zeroMatrixP  = new THREE.Matrix4().makeScale(0, 0, 0);
const _shellFwd     = new THREE.Vector3(0, 0, 1);
const _shellUpRef   = new THREE.Vector3(0, 1, 0);

// ── Tracer glow trail — stretched, additive-blended, much more visible
// at range than the small shell mesh alone ─────────────────────────────
const TRAIL_LENGTH = 3.5;   // world-units — visual streak length behind shell
const TRAIL_RADIUS = 0.10;

const _trailGeo = new THREE.CylinderGeometry(0.01, TRAIL_RADIUS, TRAIL_LENGTH, 6, 1);
_trailGeo.translate(0, -TRAIL_LENGTH * 0.5, 0);   // pivot at the "front" end (near the shell)
_trailGeo.rotateX(Math.PI / 2);

const _trailMat = new THREE.MeshBasicMaterial({
  color:       0xff6a00,
  transparent: true,
  opacity:     0.55,
  depthWrite:  false,
  blending:    THREE.AdditiveBlending,
  fog:         false,
});

export class ProjectileBulletSystem {
  constructor(scene, world, explosionSystem) {
    this.scene           = scene;
    this.world           = world;
    this.explosionSystem = explosionSystem;

    this.gunPoint    = null;
    this.bulletSpeed = 80;
    this.reloadTime  = 3;
    this._reloading  = false;
    this.onHit       = null;
    this.damage = DAMAGE;

    // Per-projectile state — flat arrays, zero GC
// Per-projectile state — flat arrays, zero GC
    this._active      = new Uint8Array(PROJ_MAX);   // 0=free 1=player 2=enemy
    this._px          = new Float32Array(PROJ_MAX);
    this._py          = new Float32Array(PROJ_MAX);
    this._pz          = new Float32Array(PROJ_MAX);
    this._vx          = new Float32Array(PROJ_MAX);
    this._vy          = new Float32Array(PROJ_MAX);
    this._vz          = new Float32Array(PROJ_MAX);
    this._life        = new Float32Array(PROJ_MAX);
    this._resolver    = new Array(PROJ_MAX).fill(null);
    this._onHitPlayer = new Array(PROJ_MAX).fill(null);
    this._excludeBody = new Array(PROJ_MAX).fill(null);
    this._playerBody  = new Array(PROJ_MAX).fill(null);

    // InstancedMesh shell visual
    this._shellMesh               = new THREE.InstancedMesh(_shellGeo, _shellMat, PROJ_MAX);
    this._shellMesh.frustumCulled = false;
    this._shellMesh.count         = PROJ_MAX;
    scene.add(this._shellMesh);

    // Tracer glow trail — one per shell slot, same instance count/lifecycle
    this._trailMesh               = new THREE.InstancedMesh(_trailGeo, _trailMat, PROJ_MAX);
    this._trailMesh.frustumCulled = false;
    this._trailMesh.count         = PROJ_MAX;
    scene.add(this._trailMesh);

    // Hide all slots initially
    for (let i = 0; i < PROJ_MAX; i++) {
      this._shellMesh.setMatrixAt(i, _zeroMatrixP);
      this._trailMesh.setMatrixAt(i, _zeroMatrixP);
    }
    this._shellMesh.instanceMatrix.needsUpdate = true;
    this._trailMesh.instanceMatrix.needsUpdate = true;

    // Reusable Rapier ray — mutated in place, never reallocated
    this._ray = null;

    // Scratch vectors
    this._scratchOrigin  = new THREE.Vector3();
    this._scratchDir     = new THREE.Vector3();
    this._scratchPrev    = new THREE.Vector3();
    this._scratchCurr    = new THREE.Vector3();
    this._scratchSegDir  = new THREE.Vector3();
    this._scratchBeamQ   = new THREE.Quaternion();
  }

  // ── API (identical surface to BulletSystem) ───────────────────────────────

  setGunPoint(gp)    { this.gunPoint    = gp; }
  setShellSpeed(s)   { this.bulletSpeed = s; }
  setFireRate(r)     { this.reloadTime  = r; }
  setDamage(dmg) { this.damage = dmg; }

  get isReloaded()     { return !this._reloading; }
  get reloadProgress() { return this._reloading ? 0 : 1; }

  handleCollision()        { return false; }
  isEnemyBulletHandle()    { return false; }
  setTrailSystem()         {}

  // ── Fire (player) ─────────────────────────────────────────────────────────

  fire(tankRigidBody, onFire, onRecoil, overrideDir = null, isMG = false, enemyResolver = null) {
    if (!this.isReloaded || !this.gunPoint) return;

    this.gunPoint.getWorldPosition(this._scratchOrigin);
    if (overrideDir) {
      this._scratchDir.copy(overrideDir).normalize();
    } else {
      this.gunPoint.getWorldDirection(this._scratchDir);
    }

this._spawnProjectile(
      this._scratchOrigin, this._scratchDir,
      tankRigidBody ?? null, 1, enemyResolver, null
    );

    this._reloading = true;
    setTimeout(() => { this._reloading = false; }, this.reloadTime * 1000);

    this.explosionSystem?.spawnMuzzleFlash(this._scratchOrigin);
    this.explosionSystem?.spawnGunSmoke(this.gunPoint); 
    onFire?.();
    onRecoil?.();
  }

  // ── Fire (enemy) ──────────────────────────────────────────────────────────

fireFromPoint(origin, direction, excludeBody = null, onHitPlayer = null, playerRigidBody = null) {
    this._scratchDir.copy(direction).normalize();
    this._spawnProjectile(
      origin, this._scratchDir,
      excludeBody ?? null, 2, null, onHitPlayer, playerRigidBody
    );
    this.explosionSystem?.spawnMuzzleFlash(origin);
  }

  // ── Internal: spawn ───────────────────────────────────────────────────────

_spawnProjectile(origin, dir, excludeBody, type, resolver, onHitPlayer, playerBody = null) {
    let slot = -1;
    for (let i = 0; i < PROJ_MAX; i++) {
      if (!this._active[i]) { slot = i; break; }
    }
    if (slot === -1) return;

    this._active[slot]      = type;
    this._px[slot]          = origin.x;
    this._py[slot]          = origin.y;
    this._pz[slot]          = origin.z;
    this._vx[slot]          = dir.x * this.bulletSpeed;
    this._vy[slot]          = dir.y * this.bulletSpeed;
    this._vz[slot]          = dir.z * this.bulletSpeed;
    this._life[slot]        = PROJ_LIFETIME;
    this._resolver[slot]    = resolver;
    this._onHitPlayer[slot] = onHitPlayer;
    this._excludeBody[slot] = excludeBody;
    this._playerBody[slot]  = playerBody;
  }

  static predictRange(bulletSpeed, barrelAngleDeg, gravity = 22) {
    const theta = barrelAngleDeg * (Math.PI / 180);
    const range = (bulletSpeed * bulletSpeed * Math.sin(2 * theta)) / gravity;
    return Math.max(0, range);
  }

  // ── Update — called every frame ───────────────────────────────────────────

  update(dt) {
    const RAPIER = this.world.__RAPIER__;
    let anyActive = false;

    for (let i = 0; i < PROJ_MAX; i++) {
      if (!this._active[i]) continue;
      anyActive = true;

      // Previous position (for segment raycast)
      const prevX = this._px[i];
      const prevY = this._py[i];
      const prevZ = this._pz[i];

      // Integrate gravity + velocity
      this._vy[i] -= PROJ_GRAVITY * dt;
      this._px[i] += this._vx[i] * dt;
      this._py[i] += this._vy[i] * dt;
      this._pz[i] += this._vz[i] * dt;

      this._life[i] -= dt;
      if (this._life[i] <= 0) {
        this._killProjectile(i);
        continue;
      }

      // ── Segment raycast from prev → curr ────────────────────────────────
      const dx = this._px[i] - prevX;
      const dy = this._py[i] - prevY;
      const dz = this._pz[i] - prevZ;
      const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);

if (segLen > 0.001) {
        // ── Mesh-based enemy hit test — runs BEFORE the physics raycast so a
        // near-miss on the (smaller/offset) Rapier hull collider still counts
        // as a hit if the shell's visual path crosses the actual hull mesh ──
        let meshHitResult = null;
        if (this._active[i] === 1 && this._resolver[i]) {
          this._scratchDir.set(dx / segLen, dy / segLen, dz / segLen);
          meshHitResult = _resolveEnemyMeshHit(
            this._scratchPrev.set(prevX, prevY, prevZ),
            this._scratchDir,
            this._resolver[i],
            this.world,
            this.damage,
            segLen
          );
          if (meshHitResult.hit) {
            this._scratchCurr.set(this._px[i], this._py[i], this._pz[i]);
            this.explosionSystem?.spawnShellHit(this._scratchCurr);
            this.onHit?.(this._scratchCurr.clone(), meshHitResult.tank, meshHitResult.damage);
            this._killProjectile(i);
            continue;
          }
        }

        const ray = new RAPIER.Ray(
          { x: prevX,        y: prevY,        z: prevZ        },
          { x: dx / segLen,  y: dy / segLen,  z: dz / segLen  }
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

          // Damage resolution
          const hitCollider = this.world.getCollider(hit.collider.handle);
          const rbHandle    = hitCollider?.parent()?.handle;

          let _hitTankRef = null;
          if (this._active[i] === 1 && this._resolver[i]) {
            const enemy = this._resolver[i](rbHandle);
            if (enemy) {
              enemy._lastHitBy = 'player';   // ← kill-credit attribution
              enemy.takeDamage(this.damage);
              _hitTankRef = enemy;
            }
          }
          if (this._active[i] === 2 && this._onHitPlayer[i]) {
            const playerHandle = this._playerBody[i]?.handle;
            if (playerHandle !== undefined && rbHandle === playerHandle) {
              this._onHitPlayer[i]();
            }
          }

          this.explosionSystem?.spawnShellHit(this._scratchCurr);
          this.onHit?.(this._scratchCurr.clone(), _hitTankRef, this.damage);
          this._killProjectile(i);
          continue;
        }
      }

      // ── Update visual shell orientation (points along velocity) ──────────
      const speed = Math.sqrt(
        this._vx[i] * this._vx[i] +
        this._vy[i] * this._vy[i] +
        this._vz[i] * this._vz[i]
      );

      if (speed > 0.001) {
        this._scratchDir.set(
          this._vx[i] / speed,
          this._vy[i] / speed,
          this._vz[i] / speed
        );
        this._scratchBeamQ.setFromUnitVectors(_shellFwd, this._scratchDir);
      }

      _shellDummy.position.set(this._px[i], this._py[i], this._pz[i]);
      _shellDummy.quaternion.copy(this._scratchBeamQ);
      _shellDummy.scale.setScalar(1);
      _shellDummy.updateMatrix();
      this._shellMesh.setMatrixAt(i, _shellDummy.matrix);

      // Trail trails directly behind the shell along its velocity direction —
      // reuses the same position/quaternion, geometry itself is pre-offset
      this._trailMesh.setMatrixAt(i, _shellDummy.matrix);
    }

    this._shellMesh.instanceMatrix.needsUpdate = anyActive;
    this._trailMesh.instanceMatrix.needsUpdate = anyActive;
  }

  // ── Kill projectile slot ──────────────────────────────────────────────────

_killProjectile(i) {
    this._active[i]      = 0;
    this._resolver[i]    = null;
    this._onHitPlayer[i] = null;
    this._excludeBody[i] = null;
    this._playerBody[i]  = null;
    this._shellMesh.setMatrixAt(i, _zeroMatrixP);
    this._trailMesh.setMatrixAt(i, _zeroMatrixP);
    this._shellMesh.instanceMatrix.needsUpdate = true;
    this._trailMesh.instanceMatrix.needsUpdate = true;
  }
  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose() {
    // NOTE: _shellGeo/_shellMat/_trailGeo/_trailMat are shared module-level
    // constants used by every ProjectileBulletSystem instance — same
    // reasoning as the other dispose() methods above, do not free them here.
    this._shellMesh.visible = false;
    this._shellMesh.count   = 0;
    this._shellMesh.removeFromParent();
    this._trailMesh.visible = false;
    this._trailMesh.count   = 0;
    this._trailMesh.removeFromParent();
  }
}

// ── Special Weapon System (weapon slot 5 — "gun" variant) ──────────────────
// An alternative to RocketSystem for slot 5: a single high-damage shot with
// a long flat cooldown after every fire, instead of a magazine. Reuses
// ProjectileBulletSystem's arc-path/segment-raycast + visuals wholesale —
// only fire() is overridden, with a signature matching RocketSystem.fire()
// (rigidBody, enemyResolver, aimWorldPos) so tank.js's slot-5 fire() call
// works identically regardless of which system backs it.

const SPECIAL_GUN_DAMAGE   = 400;
const SPECIAL_GUN_COOLDOWN = 60;   // seconds — full cooldown after EVERY shot
const SPECIAL_GUN_SPEED    = 120;

export class SpecialGunSystem extends ProjectileBulletSystem {
  constructor(scene, world, explosionSystem, opts = {}) {
    super(scene, world, explosionSystem);
    this.damage      = opts.damage ?? SPECIAL_GUN_DAMAGE;
    this.bulletSpeed = opts.speed  ?? SPECIAL_GUN_SPEED;
    this.reloadTime  = opts.cooldown ?? SPECIAL_GUN_COOLDOWN;
    this._cooldownRemaining = 0;
    // ← Wall-clock deadline (ms, performance.now()-based) for when this
    // weapon becomes ready again. Using a real timestamp instead of
    // subtracting per-frame dt means a very short cooldown (e.g. 0.2s)
    // can't drift longer than intended due to render-dt smoothing
    // (main.js's _smoothedDt lags real frame time) or the main loop's
    // dt clamp (`dt = Math.min(dt, 1/20)`) silently dropping time during
    // a frame hitch. This makes the cooldown accurate to real elapsed
    // time regardless of frame rate or stutter.
    this._readyAtMs = 0;
  }

  /** Single mount point (unlike RocketSystem's multi-point setLaunchPoints). */
  setLaunchPoint(gp) { this.gunPoint = gp; }

  get isReady() {
    // Lazily clear _reloading the moment real time has passed the
    // deadline, even if update(dt) hasn't ticked this exact frame yet —
    // so a fire attempt right at the boundary isn't wrongly blocked.
    if (this._reloading && performance.now() >= this._readyAtMs) {
      this._reloading = false;
      this._cooldownRemaining = 0;
    }
    return !this._reloading && !!this.gunPoint;
  }

  /** Seconds left before this can fire again — for a HUD countdown. */
  get cooldownRemaining() {
    if (!this._reloading) return 0;
    return Math.max(0, (this._readyAtMs - performance.now()) / 1000);
  }

  /**
   * Matches RocketSystem.fire()'s signature exactly, so tank.js's
   * activeWeapon===5 branch works unchanged for either system.
   */
  fire(tankRigidBody, enemyResolver = null, aimWorldPos = null) {
    if (!this.isReady) return;

    this.gunPoint.getWorldPosition(this._scratchOrigin);
    if (aimWorldPos) {
      this._scratchDir.subVectors(aimWorldPos, this._scratchOrigin).normalize();
    } else {
      this.gunPoint.getWorldDirection(this._scratchDir);
    }

    this._spawnProjectile(
      this._scratchOrigin, this._scratchDir,
      tankRigidBody ?? null, 1, enemyResolver, null
    );

    this._reloading = true;
    this._readyAtMs = performance.now() + this.reloadTime * 1000;
    this._cooldownRemaining = this.reloadTime;

    this.explosionSystem?.spawnMuzzleFlash(this._scratchOrigin);
  }

  /**
   * Wall-clock-driven cooldown — _readyAtMs is the source of truth (set in
   * fire()); this just keeps _cooldownRemaining in sync each frame for the
   * HUD countdown and flips _reloading off once the deadline passes. Still
   * only ticks while update() is actually being called (paused/spawn-
   * selection/match-ended tanks don't call this), so cooldown still
   * correctly freezes in those states — it's just immune to per-frame dt
   * drift while active.
   */
  update(dt) {
    super.update(dt); // still need ProjectileBulletSystem's own projectile/visual tick

    if (this._reloading) {
      const remainingMs = this._readyAtMs - performance.now();
      this._cooldownRemaining = Math.max(0, remainingMs / 1000);
      if (remainingMs <= 0) {
        this._reloading = false;
        this._cooldownRemaining = 0;
      }
    }
  }

  dispose() {
    super.dispose();
  }
}