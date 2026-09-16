// turret.js — fixed, AI-driven emplacement turret + pool manager

import * as THREE from 'three';
import { loadModel } from './modelLoader.js';
import { MachineGunSystem } from './bullet.js';

const AIM_TOLERANCE = 0.035;       // radians — how "aimed" is close enough to fire
const RETARGET_INTERVAL = 0.4;     // seconds between re-scanning for a new target

// ── Deterministic seeded RNG (mulberry32) ───────────────────────────────────
// Regular Math.random() would make the host and every guest independently
// pick DIFFERENT turret types at the same points, desyncing the match.
// Seeding off the point's own index instead guarantees every client
// computes the exact same assignment with zero network traffic.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickTurretDef(defs, index, salt = 0) {
  if (!defs || defs.length === 0) return {};
  const rand = mulberry32(index * 9781 + salt * 104729 + 12345);
  return defs[Math.floor(rand() * defs.length) % defs.length];
}

export class Turret {
  static _nextId = 1;

  constructor(scene, world, RAPIER, position, rotationY, def, explosionSystem) {
    this.scene = scene;
    this.world = world;
    this.RAPIER = RAPIER;
    this.position = { x: position.x, y: position.y, z: position.z };
    this.baseRotationY = rotationY ?? 0;
    this.def = def ?? {};
    this.explosionSystem = explosionSystem ?? null;

    this.id = `turret_${Turret._nextId++}`;
    this._aiKind = 'turret';   // ← lets existing match:damage-ai relay recognize this as an AI-style unit
    this._id = this.id;

    this.cfg = {
      modelPath:       def.modelPath   ?? '/model/Turret_Default.glb',
      modelScale:      def.modelScale  ?? 1,
      maxHealth:       def.maxHealth   ?? 200,
      damage:          def.damage      ?? 16,
      fireRate:        def.fireRate    ?? 0.15,
      range:           def.range       ?? 90,
      yawMin:          THREE.MathUtils.degToRad(def.yawMin   ?? -180),
      yawMax:          THREE.MathUtils.degToRad(def.yawMax   ??  180),
      pitchMin:        THREE.MathUtils.degToRad(def.pitchMin ?? -5),
      pitchMax:        THREE.MathUtils.degToRad(def.pitchMax ??  35),
      yawSpeed:        def.yawSpeed    ?? 2.0,
      pitchSpeed:      def.pitchSpeed  ?? 1.4,
      activationTime:  def.activationTime  ?? 5,
      respawnCooldown: def.respawnCooldown ?? 8,
      gunHeight:       def.gunHeight   ?? 1.6,
    };

    this.team = null;               // 1 | 2 | null
    this.state = 'inactive';        // 'inactive' | 'active' | 'destroyed'
    this.isDead = false;
    this.health = this.cfg.maxHealth;
    this.maxHealth = this.cfg.maxHealth;

    this._activationProgress = 0;
    this._activatingTeam = null;

    this._currentYaw = 0;
    this._currentPitch = 0;
    this._targetYaw = 0;
    this._targetPitch = 0;
    this._retargetTimer = Math.random() * RETARGET_INTERVAL;
    this._target = null;
    this._fireCooldown = 0;
    this._deathTimer = 0;
    this._loaded = false;
    this._fireSeq = 0;
    this._justFired = false;

    this.onHit = null; // (hitPos, hitTarget, damage) => void — set externally

    this.bodyGroup = new THREE.Group();
    this.bodyGroup.position.set(this.position.x, this.position.y, this.position.z);
    this.bodyGroup.rotation.y = this.baseRotationY;
    this.bodyGroup.visible = false;
    scene.add(this.bodyGroup);

    this.turretMesh = null;
    this.barrelMesh = null;
    this.gunPoint = null;
    this.mgSystem = null;

    this._scratchV1 = new THREE.Vector3();

    this._buildCollider();
    this._loadModel();
  }

  async _loadModel() {
    try {
      const model = await loadModel(this.cfg.modelPath);
      const s = this.cfg.modelScale;
      model.scale.set(s, s, s);
      model.traverse((child) => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
        if (child.name === 'Turret')   this.turretMesh = child;
        if (child.name === 'Barrel')   this.barrelMesh = child;
        if (child.name === 'GunPoint') this.gunPoint = child;
      });
      this.bodyGroup.add(model);
      this.bodyGroup.visible = true;

      if (this.gunPoint) {
        this.mgSystem = new MachineGunSystem(this.scene, this.world, this.explosionSystem);
        this.mgSystem.setDamage(this.cfg.damage);
        this.mgSystem.setRange(this.cfg.range);
        this.mgSystem.setGunPoint(this.gunPoint);
        this.mgSystem.onHit = (hitPos, hitTarget, damage) => {
          this.onHit?.(hitPos, hitTarget, damage ?? this.cfg.damage);
        };
      } else {
        console.warn(`[Turret] GunPoint not found in ${this.cfg.modelPath}`);
      }
      if (!this.turretMesh) console.warn(`[Turret] "Turret" node not found in ${this.cfg.modelPath}`);
      if (!this.barrelMesh) console.warn(`[Turret] "Barrel" node not found in ${this.cfg.modelPath}`);

      this._loaded = true;
    } catch (err) {
      console.error('[Turret] Failed to load model', this.cfg.modelPath, err);
    }
  }

  _buildCollider() {
    const RAPIER = this.RAPIER;
    const half = this.baseRotationY / 2;
    const rbDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(this.position.x, this.position.y + 1.0, this.position.z)
      .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
    this.rigidBody = this.world.createRigidBody(rbDesc);
    const colDesc = RAPIER.ColliderDesc
      .cuboid(0.9, 1.1, 0.9)
      .setFriction(0.8)
      .setRestitution(0.0)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.world.createCollider(colDesc, this.rigidBody);
  }

  // ── Activation ───────────────────────────────────────────────────────
  isActivatable() {
    if (!this._loaded) return false;
    if (this.state === 'active') return false;
    if (this.state === 'destroyed' && this._deathTimer > 0) return false;
    return true;
  }

  /** Call every frame a player holds F in range. Returns true the instant
   * activation completes. */
  tickActivation(dt, byTeam) {
    if (!this.isActivatable()) return false;
    if (this._activatingTeam !== byTeam) {
      this._activatingTeam = byTeam;
      this._activationProgress = 0;
    }
    this._activationProgress += dt;
    if (this._activationProgress >= this.cfg.activationTime) {
      this._completeActivation(byTeam);
      return true;
    }
    return false;
  }

  activationFraction() {
    return Math.min(1, this._activationProgress / this.cfg.activationTime);
  }

  /** Call when F is released without completing activation. */
  resetActivation() {
    this._activationProgress = 0;
    this._activatingTeam = null;
  }

  _completeActivation(team) {
    this.state = 'active';
    this.team = team;
    this.health = this.cfg.maxHealth;
    this.isDead = false;
    this._activationProgress = 0;
    this._activatingTeam = null;
    this._target = null;
  }

  // ── Damage / death ───────────────────────────────────────────────────
  takeDamage(amount = 25) {
    if (this.state !== 'active' || this.isDead) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) this._die();
  }

  _die() {
    if (this.isDead) return;
    this.isDead = true;
    this.state = 'destroyed';
    this.team = null;
    this._target = null;
    this._deathTimer = this.cfg.respawnCooldown;

    this.bodyGroup.getWorldPosition(this._scratchV1);
    this.explosionSystem?.spawn(this._scratchV1.clone());

    if (this.barrelMesh) this.barrelMesh.rotation.x = this.cfg.pitchMin; // slump — simple destroyed pose
  }

  // ── AI update ────────────────────────────────────────────────────────
  /**
   * @param dt
   * @param candidatesList array of {pos, rigidBody, team, isDead, vehicleType, ...}
   *   — the SAME shape main.js's _buildAiCandidateList() already produces.
   * @param isHost only the host runs real targeting/firing; guests just
   *   interpolate the aim/fire state applied via applyNetworkState().
   */
  update(dt, candidatesList, isHost = true) {
    if (!this._loaded) return;

    if (this.state === 'destroyed' && this._deathTimer > 0) {
      this._deathTimer = Math.max(0, this._deathTimer - dt);
    }

    if (this.state !== 'active' || this.isDead) {
      this._targetYaw = 0;
      this._targetPitch = this.state === 'destroyed' ? this.cfg.pitchMin : 0;
      this._applyAim(dt);
      return;
    }

    if (isHost) {
      this._retargetTimer -= dt;
      if (this._retargetTimer <= 0) {
        this._retargetTimer = RETARGET_INTERVAL;
        this._target = this._findTarget(candidatesList);
      }
      if (this._target && (this._target.isDead || !this._withinRange(this._target))) {
        this._target = null;
      }

      if (this._target) this._aimAt(this._target.pos);
      else { this._targetYaw = 0; this._targetPitch = 0; }

      this._applyAim(dt);

      this._fireCooldown -= dt;
      if (this._target && this._isAimedCloseEnough() && this._fireCooldown <= 0) {
        this._fire(candidatesList);
        this._fireCooldown = this.cfg.fireRate;
      }

      this.mgSystem?.update(dt);
    } else {
      this._applyAim(dt);
      this.mgSystem?.update(dt);
    }
  }

  _findTarget(candidatesList) {
    if (!candidatesList || candidatesList.length === 0) return null;
    let best = null, bestDsq = this.cfg.range * this.cfg.range;
    for (const c of candidatesList) {
      if (!c || c.isDead || c.team === this.team) continue;
      if (c.vehicleType === 'turret') continue; // turrets don't target other turrets
      const dx = c.pos.x - this.position.x;
      const dz = c.pos.z - this.position.z;
      const dsq = dx * dx + dz * dz;
      if (dsq < bestDsq) { bestDsq = dsq; best = c; }
    }
    return best;
  }

  _withinRange(c) {
    const dx = c.pos.x - this.position.x;
    const dz = c.pos.z - this.position.z;
    return (dx * dx + dz * dz) <= this.cfg.range * this.cfg.range;
  }

  _aimAt(targetPos) {
    const dx = targetPos.x - this.position.x;
    const dz = targetPos.z - this.position.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz) || 0.0001;
    const dy = (targetPos.y + 0.8) - (this.position.y + this.cfg.gunHeight);

    const worldYaw = Math.atan2(dx, dz);
    let localYaw = worldYaw - this.baseRotationY;
    localYaw = Math.atan2(Math.sin(localYaw), Math.cos(localYaw)); // normalize [-PI,PI]
    this._targetYaw = THREE.MathUtils.clamp(localYaw, this.cfg.yawMin, this.cfg.yawMax);

    const pitch = Math.atan2(dy, horizDist);
    this._targetPitch = THREE.MathUtils.clamp(pitch, this.cfg.pitchMin, this.cfg.pitchMax);
  }

  _applyAim(dt) {
    const yawStep = this.cfg.yawSpeed * dt;
    const pitchStep = this.cfg.pitchSpeed * dt;

    const dYaw = Math.atan2(Math.sin(this._targetYaw - this._currentYaw), Math.cos(this._targetYaw - this._currentYaw));
    this._currentYaw += THREE.MathUtils.clamp(dYaw, -yawStep, yawStep);

    const dPitch = this._targetPitch - this._currentPitch;
    this._currentPitch += THREE.MathUtils.clamp(dPitch, -pitchStep, pitchStep);

    if (this.turretMesh) this.turretMesh.rotation.y = this._currentYaw;
    if (this.barrelMesh) this.barrelMesh.rotation.x = -this._currentPitch; // flip sign if your model pitches the wrong way
  }

  _isAimedCloseEnough() {
    return Math.abs(this._targetYaw - this._currentYaw) < AIM_TOLERANCE
        && Math.abs(this._targetPitch - this._currentPitch) < AIM_TOLERANCE;
  }

  _fire(candidatesList) {
    if (!this.mgSystem || !this.rigidBody) return;
    const resolver = (rbHandle) => {
      if (rbHandle === '__all__') {
        return candidatesList.filter((c) => c && !c.isDead && c.team !== this.team);
      }
      const found = candidatesList.find((c) => c.rigidBody?.handle === rbHandle);
      return (found && found.team !== this.team) ? found : null;
    };
    this.mgSystem.fire(this.rigidBody, resolver, () => {});
    this._fireSeq++;
    this._justFired = true;
  }

  // ── Multiplayer (guest-side visual application) ─────────────────────
  applyNetworkState({ team, state, health, yaw, pitch, fireSeq }) {
    if (team !== undefined) this.team = team;
    if (state !== undefined) { this.state = state; this.isDead = state === 'destroyed'; }
    if (health !== undefined) this.health = health;
    if (yaw !== undefined) this._targetYaw = yaw;
    if (pitch !== undefined) this._targetPitch = pitch;
    if (fireSeq !== undefined && fireSeq !== this._fireSeq) {
      this._fireSeq = fireSeq;
      this._justFired = true;
    }
  }

  dispose() {
    this.mgSystem?.dispose?.();
    if (this.rigidBody) { this.world.removeRigidBody(this.rigidBody); this.rigidBody = null; }
    this.scene.remove(this.bodyGroup);
  }
}

export class TurretPool {
  constructor(scene, world, RAPIER, turretPoints, turretDefs, opts = {}) {
    this.explosionSystem = opts.explosionSystem ?? null;
    this.isHost = opts.isHost ?? true;
    this.onFire = opts.onFire ?? null; // (turret) => void

    this.turrets = turretPoints.map((pt, i) => {
      const def = pickTurretDef(turretDefs, i, opts.seedSalt ?? 0);
      return new Turret(scene, world, RAPIER, pt.position, pt.rotationY ?? 0, def, this.explosionSystem);
    });
  }

  getAll() { return this.turrets; }

  getActiveTurrets() {
    return this.turrets.filter((t) => t.state === 'active' && !t.isDead);
  }

  findActivatableNear(pos, radius) {
    let best = null, bestDsq = radius * radius;
    for (const t of this.turrets) {
      if (!t.isActivatable()) continue;
      const dx = t.position.x - pos.x, dz = t.position.z - pos.z;
      const dsq = dx * dx + dz * dz;
      if (dsq < bestDsq) { bestDsq = dsq; best = t; }
    }
    return best;
  }

  update(dt, candidatesList) {
    for (const t of this.turrets) {
      t.update(dt, candidatesList, this.isHost);
      if (t._justFired) { this.onFire?.(t); t._justFired = false; }
    }
  }

  dispose() {
    for (const t of this.turrets) t.dispose();
    this.turrets.length = 0;
  }
}