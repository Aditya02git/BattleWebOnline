// aiShip.js — Static AI-controlled ships. No movement, no pathfinding.
// Each ship can carry N turrets (Turret_N / Barrel_N / GunPoint_N under the
// barrel); every turret independently tracks and fires at the nearest
// OPPOSING-team PLANE (AI or real player) within detectRange. Tanks are
// never valid targets for ships. Smoke_N nodes emit periodic funnel smoke.

import * as THREE from 'three';
import { MultiGunSystem } from './bullet.js';   // ← NEW

const TURRET_TURN_SPEED = 1.4;   // rad/s yaw tracking speed
const BARREL_TURN_SPEED = 1.4;   // rad/s pitch tracking speed
const DEATH_DISSOLVE_TIME = 15;  // seconds of burning wreck before final cleanup

const _sharedShipModels = new Map(); // modelPath -> Promise<THREE.Group>
function _getSharedShipModel(modelPath) {
  if (!_sharedShipModels.has(modelPath)) {
    _sharedShipModels.set(
      modelPath,
      import('./modelLoader.js').then(({ loadModel }) => loadModel(modelPath))
    );
  }
  return _sharedShipModels.get(modelPath);
}

function _quatFromYawDeg(deg) {
  const rad = (deg ?? 0) * (Math.PI / 180);
  const half = rad * 0.5;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

// ── One turret: a Turret_N node (yaws), a Barrel_N child (pitches), one or
// more GunPoint_N nodes nested under the barrel, and its OWN MultiGunSystem
// instance so it fires as a proper gunType-3 volley with the fat tracer
// beams, deferred hit resolution, and self-managed fire-rate/reload —
// instead of manually looping raycasts through the shared tank weapon. ────
// ── One turret: a Turret_N node (yaws), a Barrel_N child (pitches), one or
// more GunPoint_N nodes nested under the barrel, its OWN MultiGunSystem
// instance, and now its OWN hit collider + health — turrets are the actual
// damageable surface, not the ship hull. ─────────────────────────────────
class ShipTurret {
  constructor(turretMesh, barrelMesh, gunPoints) {
    this.turretMesh = turretMesh;
    this.barrelMesh = barrelMesh;
    this.gunPoints  = gunPoints;
    this.gunSystem  = null; // MultiGunSystem — assigned once, right after construction

    // ── Per-turret collider — a small static cuboid body placed at the
    // turret's world position at spawn time, sized from the turret mesh's
    // own bounding box. This is what the player's gun/rocket raycasts
    // actually hit, instead of the ship's big hull collider.
    this.rigidBody   = null; // RAPIER.RigidBody (fixed) — one per turret
    this.collider    = null; // RAPIER.Collider
    this.maxHealth   = 250;
    this.health      = 250;
    this.isDestroyed = false;
  }
}

export class AIShip {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.active = false;
    this.isDead = false;
    this.team = 1;

    this.bodyGroup = new THREE.Group();
    scene.add(this.bodyGroup);
    this.bodyGroup.visible = false;

    this.rigidBody = null;
    this._modelRoot = null;
    this._turrets = [];
    this._smokeNodes = [];
    this._smokeTimers = [];

    this._explosionSystem = null;
    this._audioSystem = null;
    this._bulletSystem = null; // shared instant-hit raycast system, passed in per-shot

    this._dissolveTimer = 0;
    this._dissolveActive = false;
    this._killCounted = false;
    this._lastHitBy = null;
    this._lastHitByPos = null;
    this._lastHitByUnit = null;
    this._lastHitByExplicitName = null;
    this._lastHitByExplicitUid = null;
    this._fireSeq = 0;
    this._id = null;
    this._stableId = null; // set externally by main.js's kill-attribution system, same as EnemyTank

    // Scratch — reused every frame, no per-frame allocation
    this._scratchWorldPos = new THREE.Vector3();
    this._scratchWorldQ   = new THREE.Quaternion();
    this._toTargetVec     = new THREE.Vector3();
    this._turretWorldQ    = new THREE.Quaternion();
    this._turretWorldQInv = new THREE.Quaternion();
    this._localDir        = new THREE.Vector3();
    this._hullEuler        = new THREE.Euler();
    this._gunWorldPos      = new THREE.Vector3();
    this._gunWorldDir      = new THREE.Vector3();
  }

  /**
   * @param spawnPos {x,y,z}
   * @param rotY degrees
   * @param modelPromise Promise<THREE.Group> (shared, per shipId)
   * @param shipDef entry from aiships.json
   * @param explosionSystem shared ExplosionSystem (from tank.bulletSystem.explosionSystem)
   * @param team 1 | 2
   * @param audioSystem shared AudioSystem
   */
  activate(spawnPos, rotY, modelPromise, shipDef, explosionSystem, team, audioSystem) {
    this._shipDef = shipDef;
    const cfg = shipDef?.config ?? {};

    this.maxHealth      = cfg.maxHealth ?? 1500;
    this.health         = this.maxHealth;
    this.armour         = cfg.armour ?? 150;
    this.team           = team;
    this.detectRange    = cfg.detectRange ?? 150;
    this.fireInterval   = cfg.fireInterval ?? 2.5;
    this.damage         = cfg.damage ?? 40;
    this._turretMinPitch = cfg.turretMinPitch ?? -0.1;
    this._turretMaxPitch = cfg.turretMaxPitch ??  0.4;
    this._smokeIntervalMin = cfg.smokeIntervalMin ?? 0.5;
    this._smokeIntervalMax = cfg.smokeIntervalMax ?? 1.0;

    this._explosionSystem = explosionSystem;
    this._audioSystem     = audioSystem;

    this.isDead          = false;
    this._dissolveTimer  = 0;
    this._dissolveActive = false;
    this._killCounted    = false;
    this._lastHitBy      = null;
    this._lastHitByExplicitName = null;

    const RAPIER = this.world.__RAPIER__;
    const hx = cfg.hullHalfExtents?.x ?? 25;
    const hy = cfg.hullHalfExtents?.y ?? 5;
    const hz = cfg.hullHalfExtents?.z ?? 6;
    const rq = _quatFromYawDeg(rotY);

    // Ship never moves — a fixed body is far cheaper than a dynamic one
    // (no per-step integration, no sleep/wake bookkeeping).
    const rbDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(spawnPos.x, spawnPos.y, spawnPos.z)
      .setRotation(rq);
    this.rigidBody = this.world.createRigidBody(rbDesc);

    const col = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setFriction(1.0)
      .setRestitution(0.0);
    this.world.createCollider(col, this.rigidBody);

    this.bodyGroup.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
    this.bodyGroup.quaternion.set(rq.x, rq.y, rq.z, rq.w);
    this.bodyGroup.visible = true;

    this._id = Math.random().toString(36).slice(2);
    this._turrets.length = 0;
    this._smokeNodes.length = 0;
    this._smokeTimers.length = 0;

    modelPromise.then((template) => {
      if (!this.active) return;
      this._modelRoot = template.clone(true);

      const s  = cfg.modelScale ?? 1.0;
      this._modelRoot.scale.set(s, s, s);
      this._modelRoot.position.set(cfg.modelOffsetX ?? 0, cfg.modelOffsetY ?? 0, cfg.modelOffsetZ ?? 0);
      this._modelRoot.rotation.y = (cfg.modelRotY ?? 0) * (Math.PI / 180);

      this._modelRoot.traverse((child) => {
        if (child.isMesh) {
          child.castShadow    = true;
          child.receiveShadow = true;
          child.material = child.material.clone();
          child.material.transparent = false;
          child.material.opacity     = 1.0;
        }
      });

      this.bodyGroup.add(this._modelRoot); // ← moved here: must be attached BEFORE turret colliders are built below, so updateWorldMatrix() reflects the ship's real spawn position/rotation
      // ── Collect turrets — each Turret_N is found at the top level, then
      // we search WITHIN that turret's own subtree for its barrel and that
      // barrel's own GunPoint_N children. We deliberately do NOT match by a
      // bare numeric suffix pulled from a flat, whole-model traverse: models
      // very commonly reuse the same local name (e.g. "Barrel_1",
      // "GunPoint_1/2/3") under every turret, since child names only need
      // to be unique within their own parent — matching by number alone
      // would silently pair one turret's yaw pivot with a totally different
      // turret's barrel/gun points. ─────────────────────────────────────────
      const turretNodes = [];
      this._modelRoot.traverse((child) => {
        if (/^Turret_\d+$/.test(child.name)) {
          turretNodes.push(child);
        } else if (/^Smoke_\d+$/.test(child.name)) {
          this._smokeNodes.push(child);
        }
      });

      turretNodes.forEach((turretMesh) => {
        let barrelMesh = null;
        turretMesh.traverse((c) => {
          if (c === turretMesh) return;
          if (!barrelMesh && /^Barrel_\d+$/.test(c.name)) {
            barrelMesh = c;
          }
        });

        const gunPoints = [];
        (barrelMesh ?? turretMesh).traverse((c) => {
          if (/^GunPoint_\d+$/.test(c.name)) gunPoints.push(c);
        });
        gunPoints.sort((a, b) =>
          parseInt(a.name.split('_')[1], 10) - parseInt(b.name.split('_')[1], 10)
        );
        if (!gunPoints.length) return; // no GunPoint_N nodes — nothing to fire, skip this turret entirely

        const turret = new ShipTurret(turretMesh, barrelMesh ?? turretMesh, gunPoints);
        turret.maxHealth = cfg.turretHealth ?? 250;
        turret.health    = turret.maxHealth;

        // ── Build a static collider around this turret's CURRENT world
        // position/box. Ships are stationary and turrets only cosmetically
        // yaw/pitch, so a fixed box captured once at spawn is accurate
        // enough to be "the turret" for hit purposes without needing to
        // sync a moving collider every frame. ────────────────────────────
        {
          const RAPIER = this.world.__RAPIER__;
          turretMesh.updateWorldMatrix(true, false);

          const box = new THREE.Box3().setFromObject(turretMesh);
          if (!box.isEmpty()) {
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());

            // Guard against degenerate/zero-size boxes (e.g. a turret with
            // no visible geometry of its own, only child barrel/gunpoints).
            // `size` already comes from a world-space Box3 (post-scale,
            // post-parenting, now that bodyGroup.add() runs first above),
            // so multiplying by `s` again would double-apply modelScale
            // and make every turret collider too large/offset.
            const hx = Math.max(0.4, size.x * 0.5);
            const hy = Math.max(0.4, size.y * 0.5);
            const hz = Math.max(0.4, size.z * 0.5);

            const trb = this.world.createRigidBody(
              RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z)
            );
            const tcol = this.world.createCollider(
              RAPIER.ColliderDesc.cuboid(hx, hy, hz)
                .setFriction(0.0)
                .setRestitution(0.0),
              trb
            );
            turret.rigidBody = trb;
            turret.collider  = tcol;
          }
        }

        // ── Dedicated gunType-3-style weapon system for this turret — this
        // is what was missing: without a MultiGunSystem instance assigned,
        // turret.gunSystem stays null forever and _updateTurret()'s guard
        // (`if (!target || !aimedEnough || !turret.gunSystem) return;`)
        // silently skips firing on every turret, every frame.
        const gunSys = new MultiGunSystem(this.scene, this.world, this._explosionSystem);
        gunSys.setGunPoints(gunPoints);
        gunSys.setDamage(cfg.damage ?? 45);
        gunSys.setFireRate(cfg.fireRate ?? 2.2);         // seconds between volleys
        gunSys.setMaxRounds(cfg.magSize ?? 300);         // rounds before a reload is forced
        gunSys.setFullReloadTime(cfg.reloadTime ?? 8);   // seconds to refill after emptying
        gunSys.onHit = (hitPos, hitTank, dmg) => {
          this._audioSystem?.playExplosion?.(0);
        };
        turret.gunSystem = gunSys;

        this._turrets.push(turret);
      });

      this._smokeTimers = this._smokeNodes.map(
        () => this._smokeIntervalMin + Math.random() * (this._smokeIntervalMax - this._smokeIntervalMin)
      );
    });

    this._audioSystem?.registerStaticEmitter?.(this._id, spawnPos); // optional — no-op if not implemented
    this.active = true;
  }

  deactivate() {
    if (!this.active) return;

    this._explosionSystem?.stopDamageFire?.(this);

    // ── NEW — dispose each turret's own MultiGunSystem (its InstancedMesh
    // beam pool) before dropping the turret references, or it leaks a
    // detached InstancedMesh in the scene every time a ship deactivates.
    for (const turret of this._turrets) {
      turret.gunSystem?.dispose();
      turret.gunSystem = null;
    }

    if (this.rigidBody) {
      this.world.removeRigidBody(this.rigidBody);
      this.rigidBody = null;
    }
    if (this._modelRoot) {
      this.bodyGroup.remove(this._modelRoot);
      this._modelRoot = null;
    }
    this._turrets.length = 0;
    this._smokeNodes.length = 0;
    this._smokeTimers.length = 0;
    this.bodyGroup.visible = false;
    this.active = false;
  }

  takeDamage(amount = 25) {
    if (this.isDead) return;
    const armorAbsorb = Math.min(this.armour, amount);
    this.armour = Math.max(0, this.armour - armorAbsorb);
    const healthDamage = amount - armorAbsorb;
    this.health = Math.max(0, this.health - healthDamage);
    if (this.health <= 0) this._die();
  }

    /**
   * Applies damage to a SPECIFIC turret (identified by its collider handle).
   * Replaces the old ship-hull takeDamage() as the primary damage path.
   * When a turret's health reaches 0 it's disabled (mesh hidden, gun
   * stopped, collider removed) and a small explosion plays. Once every
   * turret on this ship is destroyed, the whole ship dies via _die().
   */
  takeDamageOnTurret(turret, amount = 25) {
    if (this.isDead || !turret || turret.isDestroyed) return;

    turret.health = Math.max(0, turret.health - amount);
    if (turret.health <= 0) {
      this._destroyTurret(turret);
    }
  }

  _destroyTurret(turret) {
    if (turret.isDestroyed) return;
    turret.isDestroyed = true;

    // Stop firing and free this turret's own weapon system.
    turret.gunSystem?.dispose();
    turret.gunSystem = null;

    // Remove the collider so it can no longer be hit/targeted.
    if (turret.collider) {
      this.world.removeCollider(turret.collider, true);
      turret.collider = null;
    }
    if (turret.rigidBody) {
      this.world.removeRigidBody(turret.rigidBody);
      turret.rigidBody = null;
    }

    // Visually knock it out — hide the turret mesh (and by extension its
    // barrel/gunpoint children) and play a small explosion at its position.
    if (this._explosionSystem) {
      const pos = new THREE.Vector3();
      turret.turretMesh.getWorldPosition(pos);
      this._explosionSystem.spawn(pos);
    }
    turret.turretMesh.visible = false;

    // ── If every turret on this ship is now destroyed, the ship itself
    // is destroyed too. ────────────────────────────────────────────────
    const allDestroyed = this._turrets.every((t) => t.isDestroyed);
    if (allDestroyed) {
      this._die();
    }
  }

    /** Returns the ShipTurret whose OWN rigidBody or collider owns the given
   * Rapier handle. MultiGunSystem/HispanoBulletSystem's enemyResolver is
   * always called with a RIGID-BODY handle (collider.parent().handle), so
   * that check must come first — the collider check is kept as a fallback
   * for any caller that ever passes a raw collider handle instead. */
  findTurretByColliderHandle(handle) {
    for (const t of this._turrets) {
      if (t.rigidBody && t.rigidBody.handle === handle) return t;
      if (t.collider && t.collider.handle === handle) return t;
    }
    return null;
  }

  _die() {
    if (this.isDead) return;
    this.isDead = true;

    if (this.rigidBody) {
      this.world.removeRigidBody(this.rigidBody);
      this.rigidBody = null;
    }

    if (this._explosionSystem) {
      const deathPos = new THREE.Vector3();
      this.bodyGroup.getWorldPosition(deathPos);
      deathPos.y += 3;
      this._explosionSystem.spawn(deathPos);
      this._audioSystem?.playExplosion?.();

      for (let i = 0; i < 3; i++) {
        const offset = new THREE.Vector3(
          (Math.random() - 0.5) * 20, 1 + Math.random() * 3, (Math.random() - 0.5) * 6
        );
        const p = deathPos.clone().add(offset);
        setTimeout(() => this._explosionSystem?.spawn(p), 200 + i * 260);
      }
    }

    this.bodyGroup.traverse((c) => { if (c.isMesh) c.castShadow = false; });
    this._dissolveTimer  = DEATH_DISSOLVE_TIME;
    this._dissolveActive = true;
  }

  _tickDissolve(dt) {
    this._dissolveTimer -= dt;
    if (this._explosionSystem && this._smokeNodes.length) {
      // Heavier, more frequent smoke while burning
      for (let i = 0; i < this._smokeNodes.length; i++) {
        this._smokeTimers[i] -= dt;
        if (this._smokeTimers[i] <= 0) {
          this._smokeTimers[i] = 0.15 + Math.random() * 0.15;
          this._smokeNodes[i].getWorldPosition(this._scratchWorldPos);
          this._explosionSystem.spawnDeathSmoke(this._scratchWorldPos);
        }
      }
    }
    if (this._dissolveTimer <= 0) {
      this._dissolveActive = false;
      this.deactivate();
    }
  }

  /**
   * @param dt
   * @param allCandidates flat list from main.js's _buildAiCandidateList() —
   *   only entries with vehicleType === 'plane' and team !== this.team are
   *   ever considered.
   * @param onHitPlayer  (damage, combatTarget, dist, attackerPos, shooterUnit) => void
   * @param audioSystem  shared AudioSystem, for the fire-shot sound
   */
  update(dt, allCandidates, onHitPlayer, audioSystem) {
    if (!this.active) return;
    if (this._dissolveActive) { this._tickDissolve(dt); return; }
    if (this.isDead) return;

    // ── Ambient funnel smoke ────────────────────────────────────────────────
    if (this._explosionSystem && this._smokeNodes.length) {
      for (let i = 0; i < this._smokeNodes.length; i++) {
        this._smokeTimers[i] -= dt;
        if (this._smokeTimers[i] <= 0) {
          this._smokeTimers[i] = this._smokeIntervalMin + Math.random() * (this._smokeIntervalMax - this._smokeIntervalMin);
          this._smokeNodes[i].getWorldPosition(this._scratchWorldPos);
          this._explosionSystem.spawnDeathSmoke(this._scratchWorldPos);
        }
      }
    }

    if (!this._turrets.length) return; // model still loading

    const shipPos = this.bodyGroup.position;

    let target = null;
    let bestDsq = this.detectRange * this.detectRange;
    if (allCandidates) {
      for (let i = 0; i < allCandidates.length; i++) {
        const c = allCandidates[i];
        if (!c || c.team === this.team || c.isDead) continue;
        if (c.vehicleType !== 'plane') continue;
        if (!c.pos) continue;
        const dx = c.pos.x - shipPos.x, dy = c.pos.y - shipPos.y, dz = c.pos.z - shipPos.z;
        const dsq = dx * dx + dy * dy + dz * dz;
        if (dsq < bestDsq) { bestDsq = dsq; target = c; }
      }
    }

    for (const turret of this._turrets) {
      turret.gunSystem?.update(dt); // ticks its own fire-cooldown + beam travel/fade — must run every frame regardless of target
      this._updateTurret(turret, target, dt, onHitPlayer, audioSystem);
    }
  }

  _updateTurret(turret, target, dt, onHitPlayer, audioSystem) {

    if (!target) {
      // No target — leave the turret exactly where it last was. (No idle
      // sweep: keeps this near-zero cost when nothing's around, which is
      // most of the time for a static ship.)
      return;
    }

    // ── Turret yaw — aim horizontally at the target ────────────────────────
    const toTarget = this._toTargetVec.set(
      target.pos.x - turret.turretMesh.getWorldPosition(this._scratchWorldPos).x,
      0,
      target.pos.z - this._scratchWorldPos.z
    ).normalize();

    this.bodyGroup.getWorldQuaternion(this._scratchWorldQ);
    const hullYaw = this._hullEuler.setFromQuaternion(this._scratchWorldQ, 'YXZ').y;
    const targetWorldYaw = Math.atan2(-toTarget.x, -toTarget.z);

    let desiredLocalYaw = targetWorldYaw - hullYaw;
    while (desiredLocalYaw >  Math.PI) desiredLocalYaw -= Math.PI * 2;
    while (desiredLocalYaw < -Math.PI) desiredLocalYaw += Math.PI * 2;

    let yawDelta = desiredLocalYaw - turret.turretMesh.rotation.y;
    while (yawDelta >  Math.PI) yawDelta -= Math.PI * 2;
    while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    turret.turretMesh.rotation.y += yawDelta * Math.min(1, dt * TURRET_TURN_SPEED);

    // ── Barrel pitch — aim vertically (accounts for the plane's altitude) ──
    if (turret.barrelMesh) {
      turret.turretMesh.getWorldQuaternion(this._turretWorldQ);
      this._turretWorldQInv.copy(this._turretWorldQ).invert();

      const toTarget3 = this._toTargetVec.set(
        target.pos.x - this._scratchWorldPos.x,
        target.pos.y - this._scratchWorldPos.y,
        target.pos.z - this._scratchWorldPos.z
      ).normalize();
      const localDir = this._localDir.copy(toTarget3).applyQuaternion(this._turretWorldQInv);

      const hDist = Math.sqrt(localDir.x * localDir.x + localDir.z * localDir.z);
      const targetPitch = Math.atan2(-localDir.y, hDist);
      const clampedPitch = THREE.MathUtils.clamp(targetPitch, this._turretMinPitch, this._turretMaxPitch);

      turret.barrelMesh.rotation.x +=
        (clampedPitch - turret.barrelMesh.rotation.x) * Math.min(1, dt * BARREL_TURN_SPEED);
    }

    // ── Fire — MultiGunSystem self-throttles its own cooldown/reload, so we
    // just attempt a fire every frame once aimed; it silently no-ops when
    // not yet ready (fire rate / reload in progress). Passing `null` as the
    // direction tells MultiGunSystem to fire each barrel straight along its
    // OWN current world-facing (wherever the GunPoint_N mesh is physically
    // pointing after the yaw/pitch tracking above) instead of forcing every
    // barrel onto one shared vector computed from the turret pivot — that
    // override was exactly what made shots look like they left at an angle
    // relative to the barrel model. ─────────────────────────────────────────
    const aimedEnough = Math.abs(yawDelta) < 0.08;
    if (!target || !aimedEnough || !turret.gunSystem) return;

    const firstGunPoint = turret.gunPoints[0];
    firstGunPoint.getWorldPosition(this._gunWorldPos);

    const fired = turret.gunSystem.fireFromPoint(
      this._gunWorldPos,
      null, // ← fire straight out of each gunpoint's own current orientation
      this.rigidBody, // exclude own (fixed) hull from the raycast
      onHitPlayer
        ? () => onHitPlayer(
            turret.gunSystem.damage,
            target,
            0,
            { x: this._gunWorldPos.x, y: this._gunWorldPos.y, z: this._gunWorldPos.z },
            this
          )
        : null,
      target.rigidBody // MultiGunSystem matches by exact rigid-body handle — no isPlayer special-case needed
    );

    if (fired) {
      this._explosionSystem?.spawnMuzzleFlash(this._gunWorldPos);
      this._fireSeq++;
      audioSystem?.playEnemyShot?.(this._shipDef?.config?.fireSound ?? 1, 0);
    }
  }

    destroyPermanently() {
    this.deactivate();
    this.scene.remove(this.bodyGroup);
  }
}

// ── AIShipPool — one per team. Ships are fixed, map-defined, and created
// ONCE up front (no spawn-timer/pool-cycling needed since there's no
// respawn and only ~2 per team). ────────────────────────────────────────────
export class AIShipPool {
  /**
   * @param opts.shipSpawns  [{ shipId, x, z, y?, rotY? }, ...] from mapDef
   * @param opts.getTerrainY (x,z) => y
   * @param opts.shipDefs    parsed aiships.json array
   * @param opts.team        1 | 2
   * @param opts.explosionSystem, opts.audioSystem, opts.bulletSystem
   * @param opts.onHitPlayer (damage, combatTarget, dist, attackerPos, shooterUnit) => void
   */
  constructor(scene, world, opts = {}) {
    this.scene = scene;
    this.world = world;
    this.team = opts.team ?? 1;
    this.bulletSystem   = opts.bulletSystem ?? null;
    this.onHitPlayer    = opts.onHitPlayer ?? null;
    this._explosionSystem = opts.explosionSystem ?? null;
    this._audioSystem     = opts.audioSystem ?? null;
    this._allCandidatesRef = [];

    this._ships = [];

    const shipDefs = opts.shipDefs ?? [];
    const spawns = opts.shipSpawns ?? [];
    const getTerrainY = opts.getTerrainY ?? (() => 0);

    for (const spawn of spawns) {
      const def = shipDefs.find((d) => d.id === spawn.shipId) ?? shipDefs[0];
      if (!def) continue;

      const ship = new AIShip(scene, world);
      const y = spawn.y ?? getTerrainY(spawn.x, spawn.z);
      const modelPromise = _getSharedShipModel(def.modelPath);

      ship.activate(
        { x: spawn.x, y, z: spawn.z },
        spawn.rotY ?? 0,
        modelPromise,
        def,
        this._explosionSystem,
        this.team,
        this._audioSystem
      );
      this._ships.push(ship);
    }
  }

  /** Same contract as EnemyTankPool.setAllCandidates — called once per
   * frame by main.js with the flat, team-tagged candidate list. */
  setAllCandidates(list) {
    this._allCandidatesRef = list ?? [];
  }

  update(dt) {
    const candidates = this._allCandidatesRef;
    for (const ship of this._ships) {
      ship.update(dt, candidates, this.onHitPlayer, this._audioSystem);
    }
  }

  getActiveTanks() {
    // Named to match EnemyTankPool's API so ships can be dropped straight
    // into the same candidate-list / damage-fire / kill-attribution loops
    // in main.js without special-casing.
    return this._ships.filter((s) => s.active);
  }

    /** Searches every active ship's turrets for one owning `handle`.
   * Returns { ship, turret } or null. Used by main.js's hit-resolution
   * so a raycast hit on a turret collider can be turned into damage. */
  findTurretHit(handle) {
    for (const ship of this._ships) {
      if (!ship.active) continue;
      const t = ship.findTurretByColliderHandle(handle);
      if (t) return { ship, turret: t };
    }
    return null;
  }

  dispose() {
    this._ships.forEach((s) => s.destroyPermanently());
    this._ships.length = 0;
  }
}