// BalloonBomb.js — Fugo balloon bombs: AI-driven, TEAM-NEUTRAL munitions
// that drift in from the map edge, home in on a currently-captured (non-
// neutral) capture point, and detonate on arrival — resetting the point
// to neutral. If ANY tank (either team) wanders into detection range while
// a balloon is inbound, the balloon retargets onto that tank instead. This
// is a single shared pool — there is no "team 1's balloons" vs "team 2's
// balloons"; every balloon is a hazard to both sides equally.
//
// Design notes (why this is cheap):
//  - Kinematic movement (position updated directly from a steer-toward-
//    target heading) rather than driving a dynamic Rapier body with
//    forces — a balloon doesn't need real physics response.
//  - EACH balloon still gets a lightweight Rapier SENSOR collider (fixed
//    body, `.setSensor(true)`, no gravity/forces applied to it) purely so
//    existing hitscan/raycast weapon code (BulletSystem/MachineGunSystem's
//    fireFromPoint, which resolves a hit via collider.parent() and matches
//    by rigid-body handle) can actually detect and register hits on it.
//    Without a collider, a raycast physically cannot find the balloon —
//    this is why shooting previously did nothing. The collider's
//    translation is synced to the balloon's kinematic position once per
//    frame; it never receives velocity/impulses and is excluded from
//    normal dynamic-body collision resolution via collision groups, so it
//    adds negligible physics cost (one sensor vs. ~20 max at once).
//  - Target (re)acquisition is throttled (RETARGET_INTERVAL) and staggered
//    per-instance (random initial phase) so not every balloon re-scans the
//    same frame.
//  - Distance checks against tanks use squared distance, no sqrt, until a
//    candidate is actually the closest.
//  - Speed is derived purely from remaining distance-to-target (falls off
//    a curve) — no need to track altitude separately as a "phase".

import * as THREE from 'three';
import { loadModel } from './modelLoader.js';

// ── Tunables ─────────────────────────────────────────────────────────────
const MAX_BALLOONS_PER_TEAM = 10;

const MAP_HALF_SIZE      = 600;   // 1200x1200 spawn ring half-extent (map is 800x800)
const SPAWN_ALTITUDE_MIN = 220;
const SPAWN_ALTITUDE_MAX = 280;

// Speed ramps from SPEED_FAR (while distant / high) to SPEED_NEAR (final
// approach), driven by normalized distance-to-target, not altitude — this
// keeps behavior correct even after retargeting onto a nearby tank.
const SPEED_FAR       = 18.0;    // units/sec at long range
const SPEED_NEAR      = 22.0;   // units/sec on final approach
const SPEED_RAMP_DIST = 260;    // distance at which speed is ~fully ramped to SPEED_NEAR

const TURN_LERP_FAR   = 0.0;    // heading responsiveness far from target (slow, lumbering)
const TURN_LERP_NEAR  = 0.0;    // heading responsiveness close to target (locks on hard)
const TURN_RAMP_DIST  = 150;

const DESCENT_LERP    = 0.0;    // how eagerly the balloon dives toward target altitude as it closes in

const DETECT_TANK_RADIUS   = 55;   // metres — enemy tank detection bubble while falling
const RETARGET_INTERVAL    = 0.5;  // seconds between target re-scans (staggered per-instance)
const IMPACT_RADIUS        = 6;    // metres — close enough to detonate
const TANK_IMPACT_RADIUS   = 9;    // metres — slightly larger, balloon is a blast weapon

const MAX_HEALTH        = 25;
const BLAST_DAMAGE_TANK = 200;      // damage applied to a tank the balloon detonates on/near
const BLAST_RADIUS      = 14;      // splash radius for tank damage on any detonation

const MODEL_PATH   = '/fugo.glb';
const MODEL_SCALE  = 0.6;

const WOBBLE_SPEED = 0.6;   // gentle idle drift/rotation so balloons don't look robotic
const WOBBLE_AMOUNT = 0.15;

// Sensor collider radius — used purely for hitscan/raycast detection, not
// for any physical collision response (it's a sensor: never pushes or is
// pushed, never resolved by world.step()'s normal contact solving).
// Roughly matches the balloon's visual size.
const HIT_COLLIDER_RADIUS = 5;

// Dedicated collision group for the sensor. It belongs to BALLOON_GROUP
// and is configured to not collide with anything via normal contact
// filtering — explicit raycast queries (world.castRay) find sensors
// regardless of collision-group contact filtering as long as `solid` is
// true and no filter groups are passed to castRay, which is how this
// project's existing fireFromPoint() calls already raycast (see bullet.js).
const BALLOON_GROUP = 0x0004;
const BALLOON_COLLISION_GROUPS = (BALLOON_GROUP << 16) | 0x0000;

let _sharedModelPromise = null;
function _getSharedModel() {
  if (!_sharedModelPromise) _sharedModelPromise = loadModel(MODEL_PATH);
  return _sharedModelPromise;
}

// ── Single balloon bomb ──────────────────────────────────────────────────
export class BalloonBomb {
  constructor(scene, world) {
    this.scene  = scene;
    this.world  = world;   // Rapier world (with .__RAPIER__ set), needed for the hit-sensor collider
    this.active = false;
    this.isDead = false;

    this.bodyGroup = new THREE.Group();
    this.bodyGroup.visible = false;
    scene.add(this.bodyGroup);

    this._modelRoot = null;

    // ── Hit-detection sensor — a fixed rigid body + ball sensor collider
    // that exists ONLY so raycast-based weapons can find this balloon.
    // Built lazily on first activate() (world may not be ready earlier)
    // and reused across the balloon's whole pooled lifetime — moved via
    // setTranslation() each frame rather than recreated.
    this.rigidBody = null;   // NOTE: same field name as EnemyTank uses, so
                              // this balloon can be dropped straight into
                              // the shared AI-candidate list shape without
                              // main.js needing a special case.
    this._sensorCollider = null;

    // Placeholder sphere shown until the GLB clone is ready
    if (!BalloonBomb._placeholderGeo) {
      BalloonBomb._placeholderGeo = new THREE.SphereGeometry(1.6, 10, 8);
      BalloonBomb._placeholderMat = new THREE.MeshStandardMaterial({
        color: 0xd8d0b0, roughness: 0.9, metalness: 0.0,
      });
    }
    this._placeholder = new THREE.Mesh(BalloonBomb._placeholderGeo, BalloonBomb._placeholderMat);
    this.bodyGroup.add(this._placeholder);

    // Kinematic state — no rigid body
    this.pos = new THREE.Vector3();
    this._vel = new THREE.Vector3();      // current heading * speed (world units/sec) — reused, not authoritative physics
    this._heading = new THREE.Vector3(0, 0, 1); // smoothed current facing direction
    this._quat = new THREE.Quaternion();
    this._upAxis = new THREE.Vector3(0, 1, 0);

    // Targeting — team-neutral: a balloon has no side of its own, so there
    // is no "enemy team" filter here at all. It targets whichever capture
    // point is currently non-neutral, and whichever tank (either team)
    // wanders into range.
    this.targetCapturePoint = null;  // {id,x,y,z,owner,...} reference from main.js's CAPTURE_POINTS
    this.targetTank = null;          // EnemyTank-like instance once locked onto a tank
    this._targetCandidate = null;    // fallback: raw candidate wrapper when a real player has no tankRef
    this._retargetTimer = Math.random() * RETARGET_INTERVAL; // staggered

    // Self-reference so this object can be pushed directly into the same
    // flat "allCandidates" list main.js builds for tank/plane AI — lets a
    // balloon itself be targeted by tank turret AI resolvers that expect
    // { pos, rigidBody, tankRef, team, isDead } shaped entries, without
    // main.js needing bespoke balloon-specific plumbing everywhere.
    this.tankRef = this;
    this.team = null; // intentionally null/neutral — never equals a real team (1 or 2), so `c.team === this.team` filters never wrongly treat a balloon as "my own side"

    // Health
    this.maxHealth = MAX_HEALTH;
    this.health = MAX_HEALTH;

    this._wobblePhase = Math.random() * Math.PI * 2;
    this._id = null;

    // Scratch — reused every frame, no per-frame allocation
    this._scratchDir = new THREE.Vector3();
    this._scratchTargetPos = new THREE.Vector3();
  }

  /**
   * @param {THREE.Vector3} spawnPos
   */
  activate(spawnPos) {
    this.pos.copy(spawnPos);
    this.isDead = false;
    this.health = this.maxHealth;
    this.targetCapturePoint = null;
    this.targetTank = null;
    this._targetCandidate = null;
    this._retargetTimer = Math.random() * RETARGET_INTERVAL;
    this._heading.set(0, -0.2, 1).normalize();
    this._wobblePhase = Math.random() * Math.PI * 2;
    this._id = Math.random().toString(36).slice(2);

    this.bodyGroup.position.copy(this.pos);
    this.bodyGroup.visible = true;
    this._placeholder.visible = true;

    this._ensureSensorCollider();
    if (this.rigidBody) {
      this.rigidBody.setTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z }, true);
    }

    if (!this._modelRoot) {
      _getSharedModel().then((template) => {
        if (!this.active) return; // deactivated before load resolved
        this._modelRoot = template.clone(true);
        this._modelRoot.scale.setScalar(MODEL_SCALE);
        this._modelRoot.traverse((c) => {
          if (c.isMesh) {
            c.castShadow = true;
            c.receiveShadow = false;
          }
        });
        this.bodyGroup.add(this._modelRoot);
        this._placeholder.visible = false;
      }).catch((err) => {
        console.warn('[BalloonBomb] failed to load fugo.glb:', err);
      });
    }

    this.active = true;
  }

  /** Builds the fixed rigid body + ball sensor collider once (first
   * activation of this pooled slot) and reuses it for the slot's entire
   * lifetime thereafter — cheaper than create/destroy on every respawn,
   * and avoids Rapier handle churn. */
  _ensureSensorCollider() {
    if (this.rigidBody || !this.world) return;
    const RAPIER = this.world.__RAPIER__;
    if (!RAPIER) return;

    const rbDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(this.pos.x, this.pos.y, this.pos.z);
    this.rigidBody = this.world.createRigidBody(rbDesc);

    const colDesc = RAPIER.ColliderDesc
      .ball(HIT_COLLIDER_RADIUS)
      .setSensor(true)
      .setCollisionGroups(BALLOON_COLLISION_GROUPS)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this._sensorCollider = this.world.createCollider(colDesc, this.rigidBody);
  }

  /** Call once per frame after this.pos has been updated — keeps the
   * sensor collider's transform in sync with the kinematic position so
   * raycasts always test against where the balloon actually is. Cheap:
   * a single setNextKinematicTranslation call, no re-creation. */
  _syncCollider() {
    if (!this.rigidBody) return;
    this.rigidBody.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.bodyGroup.visible = false;
    this._placeholder.visible = true;
    this.targetCapturePoint = null;
    this.targetTank = null;
    this._targetCandidate = null;

    // Park the sensor far away/underground rather than removing it — the
    // rigid body + collider are reused on the next activate() of this
    // pooled slot, same "keep the instance, move it out of play" pattern
    // used elsewhere in this codebase (e.g. Tank._parkTank in main.js).
    // Uses the IMMEDIATE setTranslation (not setNextKinematicTranslation)
    // so the collider is unreachable by raycasts starting this very frame,
    // not just after the next world.step() applies a queued kinematic move.
    if (this.rigidBody) {
      this.rigidBody.setTranslation({ x: 0, y: -1000, z: 0 }, true);
    }
  }

  destroyPermanently() {
    this.deactivate();
    this.scene.remove(this.bodyGroup);
    if (this._modelRoot) {
      this._modelRoot.traverse((c) => {
        if (c.isMesh) {
          c.geometry?.dispose();
          c.material?.dispose();
        }
      });
    }
    if (this.rigidBody && this.world) {
      this.world.removeRigidBody(this.rigidBody);
      this.rigidBody = null;
      this._sensorCollider = null;
    }
  }

  takeDamage(amount = 25) {
    if (this.isDead || !this.active) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) this._die(null);
  }

  /**
   * @param {object|null} impactTank - the tank instance being hit, if the
   *   balloon died by slamming into a tank rather than being shot down /
   *   reaching a capture point with nothing there.
   */
  _die(impactTank) {
    if (this.isDead) return;
    this.isDead = true;

    const explosionSystem = this._explosionSystem;
    const blastPos = this.pos.clone();

    explosionSystem?.spawn(blastPos);
    this._audioSystem?.playExplosion?.(this._distToPlayerForAudio ?? 0);

    // Splash damage to whichever tank we actually detonated on/near —
    // resolved by the pool's update loop (see BalloonBombPool.update),
    // which passes the nearest live tank candidate in range at death time.
    if (impactTank && typeof impactTank.takeDamage === 'function' && !impactTank.isDead) {
      impactTank.takeDamage(BLAST_DAMAGE_TANK);
    }

    // Move the sensor out of raycast range immediately — the balloon is
    // already dead, it shouldn't keep absorbing hits (or being double-
    // killed) during its brief visual dissolve window. Immediate
    // setTranslation, not setNextKinematicTranslation, so this takes
    // effect before any raycast later this same frame.
    if (this.rigidBody) {
      this.rigidBody.setTranslation({ x: 0, y: -1000, z: 0 }, true);
    }

    this._dissolveTimer = 0.6; // short visual linger (smoke puff) before pool recycles the slot
    this._dissolveActive = true;
  }

  _tickDissolve(dt) {
    this._dissolveTimer -= dt;
    if (this._dissolveTimer <= 0) {
      this._dissolveActive = false;
      this.deactivate();
    }
  }

  /**
   * Cheap idle animation — gentle bob/rotate so the balloon doesn't look
   * perfectly rigid while drifting. Applied on top of the heading-derived
   * orientation, not instead of it.
   */
  _applyWobble(dt) {
    this._wobblePhase += dt * WOBBLE_SPEED;
  }
}

// ── Pool ─────────────────────────────────────────────────────────────────
// ONE shared, team-neutral pool for the whole match — there is no per-team
// instance of this anymore. It spawns a single wave of balloons that treat
// every tank (both teams) and every non-neutral capture point identically.
export class BalloonBombPool {
  /**
   * @param {THREE.Scene} scene
   * @param {object} world - Rapier world (with .__RAPIER__ set) — needed
   *   so each balloon can build its hit-detection sensor collider.
   * @param {object} opts
   * @param {Array}  opts.capturePoints - shared reference to main.js's
   *   CAPTURE_POINTS array (each entry: {id,x,y,z,owner,...})
   * @param {Function} opts.getTerrainY - (x,z) => y, for clamping min altitude
   * @param {object} opts.explosionSystem
   * @param {object} [opts.audioSystem]
   * @param {number} [opts.maxBalloons=10] - total balloons in the single
   *   shared wave (not per-team — this is the whole pool's size)
   * @param {number|null} [opts.spawnTime] - absolute seconds into the match
   *   at which the balloon wave releases, sourced from the map's own JSON
   *   (e.g. mapDef.balloonSpawnTime). null/undefined disables balloons
   *   entirely for this map — no fallback default is assumed, since not
   *   every map should necessarily have balloons.
   */
  constructor(scene, world, opts = {}) {
    this.scene = scene;
    this.world = world;
    this.capturePoints = opts.capturePoints ?? [];
    this.getTerrainY = opts.getTerrainY ?? (() => 0);
    this._explosionSystem = opts.explosionSystem ?? null;
    this._audioSystem = opts.audioSystem ?? null;

    this.maxBalloons = opts.maxBalloons ?? MAX_BALLOONS_PER_TEAM;
    this.spawnTime = opts.spawnTime ?? null;
    this._released = false;
    this._releaseIdx = 0; // staggers the spawns instead of dumping all at once
    this._releaseSpawnTimer = 0;
    this.releaseSpawnStagger = opts.releaseSpawnStagger ?? 1.2; // seconds between each spawn

    this._pool = Array.from({ length: this.maxBalloons }, () => new BalloonBomb(scene, world));
    this._activeCache = [];

    // Flat candidate list (every tank/plane/player, both teams), refreshed
    // once per frame by the caller (same pattern as
    // EnemyTankPool.setAllCandidates) — avoids each balloon independently
    // gathering/filtering the full roster.
    this._allCandidatesRef = [];
  }

  /** Same contract as EnemyTankPool.setAllCandidates — a flat list of
   * { pos, rigidBody, isPlayer, tankRef, team, isDead, vehicleType }. */
  setAllCandidates(list) {
    this._allCandidatesRef = list ?? [];
  }

  getActiveBalloons() {
    this._activeCache.length = 0;
    for (const b of this._pool) if (b.active) this._activeCache.push(b);
    return this._activeCache;
  }

  _getInactive() {
    return this._pool.find((b) => !b.active) ?? null;
  }

  /** Picks a spawn point on the 1200x1200 ring (MAP_HALF_SIZE from
   * center), at a random angle, high altitude. */
  _pickSpawnPos() {
    const angle = Math.random() * Math.PI * 2;
    const x = Math.cos(angle) * MAP_HALF_SIZE;
    const z = Math.sin(angle) * MAP_HALF_SIZE;
    const y = SPAWN_ALTITUDE_MIN + Math.random() * (SPAWN_ALTITUDE_MAX - SPAWN_ALTITUDE_MIN);
    return new THREE.Vector3(x, y, z);
  }

  /** Any currently-captured (non-neutral) point, regardless of which team
   * holds it — team-neutral by design: a balloon doesn't care who owns a
   * point, only that it's held by SOMEONE and should be knocked back to
   * neutral. */
  _findCapturedPoint() {
    const candidates = this.capturePoints.filter((cp) => cp.owner !== 'neutral');
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  trySpawnOne() {
    if (this.getActiveBalloons().length >= this.maxBalloons) return false;
    const balloon = this._getInactive();
    if (!balloon) return false;

    const cp = this._findCapturedPoint();
    // No captured point right now — still spawn (design calls for a fixed
    // wave at the configured spawnTime), it will pick up a target
    // opportunistically once a point is captured, or fall back to hunting
    // the nearest tank on either team.
    balloon.targetCapturePoint = cp ?? null;
    balloon._explosionSystem = this._explosionSystem;
    balloon._audioSystem = this._audioSystem;

    balloon.activate(this._pickSpawnPos());
    return true;
  }

  /** Call once per frame with current matchElapsed (seconds). Releases
   * the full wave of `maxBalloons`, staggered, once matchElapsed crosses
   * this.spawnTime (an absolute time from the map's own JSON). Only fires
   * once per match. No-ops entirely if spawnTime is null (map has no
   * balloonSpawnTime configured). */
  update(dt, matchElapsed) {
    if (this.spawnTime == null) return; // balloons disabled for this map

    if (!this._released) {
      if (matchElapsed >= this.spawnTime) {
        this._released = true;
      }
    } else if (this._releaseIdx < this.maxBalloons) {
      this._releaseSpawnTimer -= dt;
      if (this._releaseSpawnTimer <= 0) {
        this._releaseSpawnTimer = this.releaseSpawnStagger;
        if (this.trySpawnOne()) this._releaseIdx++;
      }
    }

    const active = this.getActiveBalloons();
    const candidates = this._allCandidatesRef;

    for (const b of active) {
      if (b._dissolveActive) {
        b._tickDissolve(dt);
        continue;
      }
      this._updateOne(b, dt, candidates);
    }
  }

  _updateOne(b, dt, candidates) {
    b._applyWobble(dt);

    // ── Retarget scan — throttled per-instance ──────────────────────────
    b._retargetTimer -= dt;
    if (b._retargetTimer <= 0) {
      b._retargetTimer = RETARGET_INTERVAL;
      this._rescanTarget(b, candidates);
    }

    // ── Resolve current aim point ────────────────────────────────────────
    let targetPos = null;
    let targetIsTank = false;

    if (b.targetTank) {
      if (b.targetTank.isDead || !b.targetTank.rigidBody) {
        // Locked tank died/despawned before impact — fall back to capture point.
        b.targetTank = null;
      } else {
        const tp = b.targetTank._cachedPos ?? b.targetTank.rigidBody.translation();
        b._scratchTargetPos.set(tp.x, tp.y + 1.0, tp.z);
        targetPos = b._scratchTargetPos;
        targetIsTank = true;
      }
    } else if (b._targetCandidate) {
      // Real-player-vehicle lock (no tankRef) — re-validate every frame,
      // since nothing else clears this if the player dies/despawns before
      // impact (unlike targetTank, which self-heals just above).
      const c = b._targetCandidate;
      if (c.isDead || !c.rigidBody) {
        b._targetCandidate = null;
      } else {
        const tp = c.pos ?? c.rigidBody.translation();
        b._scratchTargetPos.set(tp.x, tp.y + 1.0, tp.z);
        targetPos = b._scratchTargetPos;
        targetIsTank = true;
      }
    }

    if (!targetPos) {
      if (b.targetCapturePoint) {
        b._scratchTargetPos.set(b.targetCapturePoint.x, b.targetCapturePoint.y + 4, b.targetCapturePoint.z);
        targetPos = b._scratchTargetPos;
      } else {
        // Nothing to aim at at all (no enemy point, no nearby tank) —
        // gently descend toward map center and keep scanning; cheap no-op
        // steering rather than special-casing a "loiter" state.
        b._scratchTargetPos.set(0, this.getTerrainY(0, 0) + 30, 0);
        targetPos = b._scratchTargetPos;
      }
    }

    // ── Steer + advance ──────────────────────────────────────────────────
    const toTarget = b._scratchDir.subVectors(targetPos, b.pos);
    const dist = toTarget.length();

    if (dist > 0.001) toTarget.multiplyScalar(1 / dist); // normalize in place

    const distRatio = THREE.MathUtils.clamp(1 - dist / SPEED_RAMP_DIST, 0, 1);
    const speed = THREE.MathUtils.lerp(SPEED_FAR, SPEED_NEAR, distRatio);

    const turnRatio = THREE.MathUtils.clamp(1 - dist / TURN_RAMP_DIST, 0, 1);
    const turnLerp = THREE.MathUtils.lerp(TURN_LERP_FAR, TURN_LERP_NEAR, turnRatio);

    b._heading.lerp(toTarget, Math.min(1, dt * turnLerp)).normalize();

    b.pos.addScaledVector(b._heading, speed * dt);

    // Extra direct descent bias as it closes in, so it visibly dives onto
    // the target instead of only approaching laterally.
    if (dist < TURN_RAMP_DIST) {
      const altDelta = targetPos.y - b.pos.y;
      b.pos.y += altDelta * Math.min(1, dt * DESCENT_LERP) * 0.5;
    }

    // Never let terrain clip through it while loitering with no target
    const groundY = this.getTerrainY(b.pos.x, b.pos.z);
    if (b.pos.y < groundY + 3) b.pos.y = groundY + 3;

    // ── Visual transform ─────────────────────────────────────────────────
    b.bodyGroup.position.copy(b.pos);
    // Face travel direction, plus a small idle wobble so it doesn't look robotic.
    const wobbleY = Math.sin(b._wobblePhase) * WOBBLE_AMOUNT;
    b._quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b._heading);
    b.bodyGroup.quaternion.copy(b._quat);
    b.bodyGroup.rotation.y += wobbleY;

    // ── Keep the hit-detection sensor collider glued to the kinematic
    // position — this is what makes shooting the balloon actually work,
    // since raycast weapons resolve hits via the physics world, not via
    // the Three.js scene graph.
    b._syncCollider();

    // ── Impact check ─────────────────────────────────────────────────────
    const impactRadius = targetIsTank ? TANK_IMPACT_RADIUS : IMPACT_RADIUS;
    if (dist <= impactRadius) {
      this._resolveImpact(b, targetIsTank);
    }
  }

  /** Scans the shared candidate list for the nearest LIVING tank (either
   * team — this pool is team-neutral, so there is no "enemy" side filter
   * at all) within DETECT_TANK_RADIUS of this balloon; locks on if found.
   * Never un-locks once a tank target is acquired (a real munition
   * wouldn't un-commit either) — only clears via death/despawn, handled in
   * _updateOne. */
  _rescanTarget(b, candidates) {
    if (b.targetTank || b._targetCandidate) return; // already locked — no need to rescan

    let best = null;
    let bestDistSq = DETECT_TANK_RADIUS * DETECT_TANK_RADIUS;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!c || c.isDead) continue;
      if (c.tankRef === b) continue;             // never target another balloon / self
      if (c.vehicleType === 'plane') continue;   // balloons only care about ground targets
      const cp = c.pos;
      if (!cp) continue;
      const dx = cp.x - b.pos.x;
      const dy = cp.y - b.pos.y;
      const dz = cp.z - b.pos.z;
      const dsq = dx * dx + dy * dy + dz * dz;
      if (dsq < bestDistSq) {
        bestDistSq = dsq;
        best = c;
      }
    }

    if (best) {
      // tankRef is the actual EnemyTank/RemotePlayerTank-ish object with
      // .rigidBody / .isDead / .takeDamage — same shape used elsewhere
      // (see main.js's _buildAiCandidateList).
      b.targetTank = best.tankRef ?? null;
      // Real players don't expose a tankRef the same way (tankRef is null
      // for the local human player, see main.js) — balloons intentionally
      // do NOT target real players directly by damage-dealing tankRef
      // absence; if tankRef is null (a live player vehicle, not an AI
      // unit), fall back to just steering at their position without ever
      // calling .takeDamage on anything undefined. We store the raw
      // candidate's rigidBody-bearing wrapper instead in that case.
      if (!b.targetTank && best.rigidBody) {
        b._targetCandidate = best; // { pos, rigidBody, ... } — read-only steering target
      }
    }
  }

  _resolveImpact(b, targetIsTank) {
    if (targetIsTank && b.targetTank) {
      // AI tank on either team — apply splash damage directly.
      b._die(b.targetTank);
    } else if (targetIsTank && b._targetCandidate) {
      // Locked onto a real player's vehicle (no AI tankRef available) —
      // main.js owns the actual damage/network-relay path for real
      // players, so report the blast via a callback instead of calling
      // takeDamage on an unknown vehicle type directly here.
      b._die(null);
      this.onPlayerBlast?.(b._targetCandidate, BLAST_DAMAGE_TANK, b.pos);
    } else if (b.targetCapturePoint) {
      // Reset the capture point to neutral — this is the core design goal.
      const cp = b.targetCapturePoint;
      cp.owner = 'neutral';
      cp.captureTimer = 0;
      cp.capturingBy = null;
      this.onCapturePointReset?.(cp);
      b._die(null);
    } else {
      b._die(null);
    }
  }

  /** Full cleanup */
  dispose() {
    this._pool.forEach((b) => b.destroyPermanently());
    this._pool.length = 0;
  }
}