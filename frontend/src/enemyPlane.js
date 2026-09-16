// enemyPlane.js — AI-controlled fighter plane + pool.
//
// Mirrors enemyTank.js's shape as closely as a flying unit reasonably can:
// a pooled, pre-allocated AI class with activate()/deactivate(), a shared
// GLB cache, an FSM driven each frame from EnemyPlanePool.update(), and a
// getActiveTanks()-style accessor so main.js can treat this pool exactly
// like EnemyTankPool/FriendlyTankPool (same method names, same call shape).
//
// It does NOT extend Plane (the player-flyable class) — Plane's constructor
// builds a full player-input rig (mouse-flight, autopilot, HUD-facing scope
// point, landing gear, etc.) that an AI unit doesn't need and that would
// cost real per-instance overhead across a whole pool. Instead this is a
// lightweight, purpose-built AI flight model, the same way EnemyTank is its
// own hand-written class rather than `extends Tank`.

import * as THREE from 'three';
import { loadModel } from './modelLoader.js';
import { MachineGunSystem, MultiGunSystem } from './bullet.js';
import { RocketSystem } from './rocket.js';
import { FlareSystem } from './flare.js';

// ── Tunables ─────────────────────────────────────────────────────────────────

const MAX_PLANES         = 2;
const SPAWN_MARGIN       = 40;     // metres from terrain edge
const SPAWN_ALTITUDE_MIN = 60;
const SPAWN_ALTITUDE_MAX = 110;
const MIN_SPAWN_DIST     = 140;    // metres from player
const MAX_SPAWN_DIST     = 260;
const SPAWN_ATTEMPTS     = 20;

const DETECT_RANGE       = 220;    // metres — target acquisition radius (air is wide-open, bigger than tank's)
const ATTACK_RANGE       = 140;    // metres — start firing
const STOP_CHASE_RANGE   = 280;    // metres — give up, return to patrol
const SHOOT_INTERVAL      = 3.2;    // seconds between bursts
const BURST_FIRE_INTERVAL = 0.1;   // seconds between individual shots WITHIN a burst
const BURST_SHOTS_MIN     = 3;      // fewest shots per burst
const BURST_SHOTS_MAX     = 18;      // most shots per burst

const ROCKET_INTERVAL_MIN    = 1;    // seconds — base cooldown between rocket-fire attempts
const ROCKET_INTERVAL_JITTER = 4;    // seconds — random addition on top of the base interval
const ROCKET_FIRE_CHANCE     = 0.75;  // probability a ready, in-cone rocket attempt actually fires
const ROCKET_RETRY_BACKOFF   = 1.5;  // seconds — short re-check delay after a failed/blocked attempt
const ROCKET_FACING_COS      = 0.20; // ~37° cone — loose enough that an orbiting plane's nose actually sweeps through it periodically, rather than requiring gun-run-level precision
const DEFAULT_ROCKET_AMMO    = 6;

// ── AI flare countermeasures ────────────────────────────────────────────
const AI_FLARE_CHECK_INTERVAL = 0.35;  // seconds between threat scans per plane — deliberately coarse, this is a reflex not a twitch response
const AI_FLARE_REACT_CHANCE   = 0.85;
const AI_FLARE_COOLDOWN       = 5;
const AI_FLARE_COUNT          = 3;
const AI_FLARE_TOTAL_AMMO     = 12;

const PATROL_SPEED       = 30;     // world units/sec
const CHASE_SPEED        = 45;
const ATTACK_SPEED       = 55;     // speed maintained while strafing/orbiting a target
const TURN_RATE          = 1.1;    // rad/s — how fast the plane can re-orient toward its steer target
const MAX_CLIMB_RATE     = 14;     // world units/sec vertical

const MIN_FLIGHT_ALTITUDE = 90;    // metres above terrain — AI never dives below this
const GROUND_COLLISION_MARGIN = 1.5; // metres — plane is destroyed the instant its rigid-body origin dips this close to (or below) actual terrain height, regardless of what the steering logic intended
const PATROL_ALTITUDE_MIN = 100;
const PATROL_ALTITUDE_MAX = 120;

const ORBIT_RADIUS        = 55;    // metres — distance kept while circling an attack target
const ORBIT_TURN_DIR_FLIP_TIME = 8; // seconds — occasionally reverse orbit direction so it's not a static circle

const ATTACK_RUN_DURATION = 1.6;          // seconds — length of a direct gun-run pass at the target
const ATTACK_RUN_SPEED    = ATTACK_SPEED + 6;
const GUN_FACING_COS      = 0.90;         // was 0.94 in _fireGun — a bit more slack for turn-in lag
const ATTACK_RUN_TURN_RATE = 2.0;         // rad/s — faster than TURN_RATE, used only while
                                           // committed to a gun run, so the nose catches up
                                           // to the lead point well inside ATTACK_RUN_DURATION

const HULL_HALF_EXTENTS   = { x: 3.6, y: 0.9, z: 0.7 }; // fallback default only — real value comes from planes.json's config.hullHalfExtents, passed down via EnemyPlanePool opts → trySpawn() → activate()
const COLLIDER_Y_OFFSET   = 0; // fallback default only — real value comes from planes.json's config.colliderYOffset
const WING_HALF_EXTENTS   = { x: 1.0, y: 0.25, z: 5.5 }; // fallback default only — real value comes from planes.json's config.wingHalfExtents
const WING_COLLIDER_OFFSET = { x: 0, y: 0, z: 0 };       // fallback default only — real value comes from planes.json's config.wingColliderOffset

const MIN_SEP_DIST        = 18; // metres — separation force between planes/other air units
// ── ADD THESE — flyby one-shot trigger tuning ─────────────────────────
const FLYBY_TRIGGER_DIST = 45;   // metres — inside this range, treat it as "passing close" and fire the whoosh
const FLYBY_REARM_DIST   = 150;  // metres — must retreat this far out before the SAME plane can trigger another flyby
const FLYBY_PAN_WIDTH    = 80;   // metres — lateral distance mapped to full pan (-1..1); tune to taste
// ── END ADD ─────────────────────────────────────────────────────────────

const DEATH_FALL_DURATION = 6;  // seconds — how long a destroyed plane falls/burns before fully removed (fallback cleanup timer only — engine now stops on actual ground impact, see _tickDissolve)
const FALL_GRAVITY         = 9.6; // world units/sec² — scaled up from real-world 9.8 to match this game's much larger flight speeds (PATROL_SPEED=55, CHASE_SPEED=65); 9.8 looked like a slow glide against those speeds
const FALL_DRAG            = 0.1; // per-second decay applied to horizontal fall velocity so the plane sheds forward speed and actually drops instead of gliding the whole way down

// Volume multiplier applied to the engine loop while this plane is falling/
// dying — must match audioSystem.js's own ENGINE_DYING_VOLUME_BOOST value;
// kept as a separate local constant since enemyPlane.js and audioSystem.js
// are different modules and this is the only place it's needed here.
const ENGINE_DYING_VOLUME_BOOST = 1.7;

// ── Shader-based battle-damage stripping — defaults only. Real values are
// locked per-pool from planes.json's config.damageEffect (see
// EnemyPlanePool constructor / trySpawn()) so AI planes use the exact same
// tuning as the player Plane class for whichever plane preset they're
// using. modelScale is locked the same way, fixing a bug where a locked
// scale of 1.6 (vs the player's 1.0) made the same world-unit cutback
// length strip a disproportionate chunk of the AI plane's geometry.
const DEFAULT_MODEL_SCALE = 1.0;
const DEFAULT_DAMAGE_EFFECT = {
  healthTriggerFraction:     0.65,
  minRemainingFraction:      0.95,
  deathMinRemainingFraction: 0.65,
  maxCutbackLength:          3.5,
  wingCutbackLength:         3.5,
  jagAmplitude:              0.5,
  jagFrequency:               1.4,
};

// ── Shared GLB cache — one entry per unique modelPath, reused across every
// EnemyPlane/FriendlyPlane instance so the model is only ever fetched once.
const _sharedGLBModels = new Map();

function _getSharedModel(modelPath = '/model/Plane_Fighter.glb') {
  if (!_sharedGLBModels.has(modelPath)) {
    _sharedGLBModels.set(modelPath, loadModel(modelPath));
  }
  return _sharedGLBModels.get(modelPath);
}

export function resetEnemyPlaneModelCache() {
  _sharedGLBModels.clear();
}

// ── Suppresses shell-casing + multigun-smoke VFX for AI-fired guns only.
// Wraps the shared ExplosionSystem in a Proxy that no-ops spawnShell/
// spawnMultiGunSmoke while forwarding every other call (bound to the real
// instance) untouched — so death explosions, damage smoke, condensation
// puffs, etc. all still work exactly as before for enemy planes.
function _createGunEffectsFilter(explosionSystem) {
  if (!explosionSystem) return explosionSystem;
  return new Proxy(explosionSystem, {
    get(target, prop, receiver) {
      if (prop === 'spawnShell' || prop === 'spawnMultiGunSmoke') {
        return () => {};
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

// ── FSM states ────────────────────────────────────────────────────────────────

export const PLANE_STATE = Object.freeze({
  IDLE:    'IDLE',
  PATROL:  'PATROL',   // cruising a random loiter point at patrol altitude
  ENGAGE:  'ENGAGE',   // closing distance on a detected target
  ATTACK:  'ATTACK',   // orbiting/strafing a target in range, firing
  DEAD:    'DEAD',
});

// ── EnemyPlane ──────────────────────────────────────────────────────────────

export class EnemyPlane {
  constructor(scene, world) {
    this.scene  = scene;
    this.world  = world;
    this.active = false;
    this.state  = PLANE_STATE.IDLE;
    this.isFriendly = false;   // deprecated — kept only so nothing crashes if some stray
                                 // code still reads it; friendliness is now team-relative
                                 // (see .team below and _findCombatTarget in enemyTank.js's
                                 // pattern, mirrored here).
    this.team = 1;              // overwritten by activate()'s `team` param on every (re)spawn
    this.vehicleType = 'plane';

    this.rigidBody = null;

    this.bodyGroup = new THREE.Group();
    scene.add(this.bodyGroup);
    this.bodyGroup.visible = false;

    // Simple placeholder (visible until GLB clone finishes) — cheap box,
    // same idea as EnemyTank's placeholder hull.
    this._placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.5, 3.2),
      new THREE.MeshStandardMaterial({ color: 0x3a4a5c, roughness: 0.7, metalness: 0.2 })
    );
    this.bodyGroup.add(this._placeholder);

    this._modelRoot     = null;
    // ── Propeller nodes — ordered array supporting numbered "Propeller_1",
    // "Propeller_2", ... (multi-engine planes like the Ju 88), or a single
    // legacy "Propeller" node (treated as index 0). Mirrors plane.js's
    // Plane._propellerNodes exactly.
    this._propellerNodes = [];
    this._propSpinAngle = 0;
    this._propSpinVelocity = 0; // rad/sec — captured at death, decays to 0 while falling

    // AI state
    this.patrolTarget = new THREE.Vector3();
    this.patrolTimer  = 0;
    this._orbitDir    = 1;
    this._orbitFlipTimer = ORBIT_TURN_DIR_FLIP_TIME;
    this.shootTimer   = Math.random() * SHOOT_INTERVAL;
    this._fireSeq     = 0;   // ← ADD
    this._gunSoundCooldown = 0; // ← ADD — throttles playEnemyShot to a fixed cadence, independent of the gun's actual fireRate
    this._burstShotsRemaining = 0;   // >0 while a burst still has shots left to fire
    this._burstShotTimer      = 0;   // counts down between individual shots within a burst
    this._attackRunActive = false;   // true while making a direct gun-run pass at the target
    this._attackRunTimer  = 0;       // counts down the current gun-run pass
    this._prevJobState = PLANE_STATE.PATROL;
    this._id = Math.random().toString(36).slice(2);

    this._flybyState = 'armed'; // ← ADD — 'armed' | 'triggered' | 'done'

    // Weapon
    this._gunPoints = null;
    this.explosionSystem = null;
    this.bulletSystem    = null;

    // Rockets — occasional secondary weapon, mirrors bulletSystem's lifecycle
    this._rocketPoints = null;
    this.rocketSystem  = null;
    this.rocketTimer   = ROCKET_INTERVAL_MIN + Math.random() * ROCKET_INTERVAL_JITTER;
    this.rocketAmmo    = 0;

    // ── Flare countermeasures — deploys via the POOL's single shared
    // FlareSystem (this.flareSystem, injected below), not a per-instance
    // one. Avoids multiplying InstancedMesh/ribbon-mesh GPU objects by
    // pool size when most planes never fire a flare in their lifetime.
    this.flareSystem       = null; // set externally by EnemyPlanePool (shared, one per pool)
    this._flareAmmo        = 0;
    this._flareCooldown    = 0;
    this._flareCheckTimer  = Math.random() * AI_FLARE_CHECK_INTERVAL; // stagger scans across planes

    // Cached each update() — the rocket onHit handler needs to know what
    // this plane was tracking at the moment it fired, since a rocket can
    // land several frames (or after this plane's own death) later.
    this._lastCombatTarget = null;
    this._lastCombatDist   = 0;

    // Health
    this.maxHealth = 100;
    this.health    = 100;
    this.maxArmour = 0;
    this.armour    = 0;
    this.isDead    = false;
    this._dissolveTimer  = 0;
    this._dissolveActive = false;
    this._treeCheckAccum = 0; // seconds since last tree-collision probe while falling
    this._killCounted  = false;
    this._lastHitBy    = null;

    // Locked model — chosen once per pool slot, reused every respawn
    this._lockedModelPath    = null;
    this._lockedModelPromise = null;

    // ── Locked weapon config — set once by the pool (from planes.json's
    // config.gunType / config.gunDamage / config.fireRate), reused on
    // every respawn so the weapon type never changes mid-life.
    this._lockedGunType           = null;
    this._lockedGunDamage         = null;
    this._lockedMultiGunFireRate  = null;

    // ── Locked rocket config — set once by the pool (from planes.json's
    // config.rocketDamage/rocketSpeed/rocketReload/rocketAmmo/guidedMissile),
    // reused every respawn so a plane's rocket loadout never changes mid-life.
    this._lockedRocketDamage  = null;
    this._lockedRocketSpeed   = null;
    this._lockedRocketReload  = null;
    this._lockedRocketAmmo    = null;
    this._lockedGuidedMissile = null;

    // ── Locked visual/damage-effect config — set once by the pool (from
    // planes.json's config.modelScale / config.damageEffect), reused on
    // every respawn so a plane's scale and damage-shader tuning never
    // change mid-life or drift from the preset it was spawned from.
    this._lockedModelScale   = null;
    this._lockedDamageEffect = null;

    // Cached per-frame data (published for other planes'/tanks' target search)
    this._cachedPos    = null;
    this._distToPlayer = 0;
    this._lastPlayerPos = new THREE.Vector3(); // ← last known player position, used to compute explosion distance on rocket ground-impact hits

    // Scratch objects — reused every frame, never reallocated
    this._scratchQ       = new THREE.Quaternion();
    this._scratchFwd      = new THREE.Vector3();
    this._scratchUp        = new THREE.Vector3();
    this._scratchRight     = new THREE.Vector3();
    this._scratchToTgt    = new THREE.Vector3();
    this._scratchVel      = new THREE.Vector3();
    this._scratchWorldPos = new THREE.Vector3();
    this._scratchOrbit    = new THREE.Vector3();
    this._scratchLead     = new THREE.Vector3(); // reused each frame — no per-frame allocation
    this._scratchEuler    = new THREE.Euler();
    this._scratchTargetQ  = new THREE.Quaternion();
    this._scratchFarTarget = null;

    this._audioSystem = null;
    this._fireSound   = 1; // ← which fire SFX variant to play; set from planes.json via the pool (see trySpawn)
    this._navGrid = null; // unused — planes don't pathfind, kept only for pool-API symmetry with EnemyTankPool
    this._getTerrainYRef = null; // (x,z) => height — set from activate() and refreshed every update()

    // ── Shader-based battle-damage stripping — materials patched fresh
    // each activate() (the GLB clone gets fresh cloned materials every
    // spawn, so the patch can't be applied just once like the player
    // Plane class does). Uniforms refreshed every frame in update()
    // while alive, and re-anchored every frame in _tickDissolve() while
    // falling after death.
    this._damageShaderMaterials = [];
    this._scratchDamageOrigin = new THREE.Vector3();
    this._scratchDamageAft    = new THREE.Vector3();
    this._scratchDamageRight  = new THREE.Vector3();
    this._scratchDamageUp     = new THREE.Vector3();
    this._deathDamageCutoff     = null;
    this._deathDamageWingCutoff = null;

  }

  // ── Activation / deactivation (pool API — mirrors EnemyTank) ────────────

  activate(spawnPos, modelPromise, explosionSystem = null, modelPath = '/model/Plane_Fighter.glb', hullHalfExtents = HULL_HALF_EXTENTS, colliderYOffset = COLLIDER_Y_OFFSET, getTerrainY = null, team = 1, wingHalfExtents = WING_HALF_EXTENTS, wingColliderOffset = WING_COLLIDER_OFFSET) {
    this.explosionSystem = explosionSystem;
    this.team = team;
    // ← Stored immediately (not just via update()) so _pickNewPatrolTarget()
    // below — called at the END of this same method — can already resolve
    // a terrain-relative altitude for the very first patrol target,
    // instead of falling back to a flat/absolute one for that first leg.
    if (getTerrainY) this._getTerrainYRef = getTerrainY;

    const RAPIER = this.world.__RAPIER__;
    const { x: hx, y: hy, z: hz } = hullHalfExtents;

    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnPos.x, spawnPos.y, spawnPos.z)
      .setLinearDamping(0.15)
      .setAngularDamping(3.0)
      .setAdditionalMass(1.2)
      .setCcdEnabled(true)
      .setGravityScale(0); // AI plane flight is fully hand-driven (setLinvel), same as tank steering — no need to fight gravity every frame

    this.rigidBody = this.world.createRigidBody(rbDesc);

    // ── IMPORTANT: no .setSensor(true) here, and no COLLISION_EVENTS /
    // INTERSECTION_EVENTS active-events flag. AI-plane flight is fully
    // hand-driven (setLinvel/setRotation in _steerToward), so this
    // collider only needs to exist for hit detection against player
    // weapon raycasts — it never needs to generate collision/intersection
    // events into the shared `eventQueue` that main.js drains every frame.
    // A sensor collider on a fast-moving dynamic body was generating a
    // stream of events into that same queue, and main.js's
    // drainCollisionEvents callback re-queries `enemyPool.getActiveTanks()`
    // rigid-body handles while processing it — mixing plane-originated
    // events through that per-frame handle lookup caused a Rapier
    // "recursive use / unsafe aliasing" panic the moment a plane's rigid
    // body was removed (on death) in the same tick its events were still
    // being drained. Solid, non-sensor, non-event collider avoids all of
    // that — CCD still prevents tunnelling, and setGravityScale(0) means
    // Rapier's own contact-response solver has effectively nothing to do
    // against static terrain anyway since we overwrite velocity every frame.
    // solverGroups all-zero on the membership side means this collider is
    // excluded from Rapier's contact-response solver entirely (no physical
    // pushback from terrain/houses/other bodies) while still remaining a
    // normal, queryable, raycast-hittable collider for weapon hit-detection.
    const bodyCol = RAPIER.ColliderDesc
      .cuboid(hx, hy, hz)
      .setTranslation(0, colliderYOffset, 0)   // ← local offset from the rigid body's origin, same convention as Plane.js
      .setFriction(0.3)
      .setRestitution(0.05)
      .setActiveEvents(0)          // no collision/intersection events
      .setSolverGroups(0x0000FFFF, 0xFFFF0000); // member 0x0000FFFF, filter (interacts with) 0xFFFF0000 — mutually exclusive with every gameplay group (all use low 16 bits), so contact response never applies to this collider
    this.world.createCollider(bodyCol, this.rigidBody);

    // ── Wing collider — same non-sensor, event-free, solver-excluded setup
    // as the hull collider above (see the long comment above bodyCol for
    // why: avoids the Rapier "recursive use" panic from mixing plane
    // collision events through main.js's per-frame handle lookups).
    // Attached to the same rigid body, so it's removed automatically
    // whenever the rigid body is (deactivate()/death), no extra cleanup needed.
    const { x: wx, y: wy, z: wz } = wingHalfExtents;
    const wingCol = RAPIER.ColliderDesc
      .cuboid(wx, wy, wz)
      .setTranslation(wingColliderOffset.x, colliderYOffset + wingColliderOffset.y, wingColliderOffset.z)
      .setFriction(0.3)
      .setRestitution(0.05)
      .setActiveEvents(0)
      .setSolverGroups(0x0000FFFF, 0xFFFF0000);
    this.world.createCollider(wingCol, this.rigidBody);

    const initialFwd = this._scratchFwd.set(0, 0, -1);
    this.rigidBody.setLinvel({ x: initialFwd.x * PATROL_SPEED, y: 0, z: initialFwd.z * PATROL_SPEED }, true);

    this._placeholder.visible = true;
    this.bodyGroup.visible    = true;

    // Fresh list for THIS activation — the previous life's materials (if
    // any) belonged to a now-discarded model clone, already cleaned up in
    // deactivate().
    this._damageShaderMaterials = [];

    modelPromise.then((templateModel) => {
      if (!this.active) return;
      this._modelRoot = templateModel.clone(true);
      const s = this._lockedModelScale ?? DEFAULT_MODEL_SCALE;
      this._modelRoot.scale.set(s, s, s);
      this._modelRoot.rotation.set(0, -90 * (Math.PI / 180), 0);

      this._gunPoints = [];
      this._rocketPoints = [];
      const propellerByIndex  = new Map(); // e.g. "Propeller_1"   → index 0, plain "Propeller" → index 0

      this._modelRoot.traverse(child => {
        if (child.isMesh) {
          child.castShadow    = true;
          child.receiveShadow = false;
          child.material = child.material.clone();
          this._setupDamageShaderMaterial(child.material);
          this._damageShaderMaterials.push(child.material);
        }
        // Supports both the legacy single "Propeller" node (index 0) and
        // numbered "Propeller_1", "Propeller_2", ... for multi-engine
        // aircraft (e.g. the Ju 88's twin props). If a model has both, the
        // numbered one wins for index 0 (Map.set overwrites), since it's
        // matched second — same precedence as plane.js's Plane class.
        if (child.name === 'Propeller') propellerByIndex.set(0, child);
        const _propMatch = child.name.match(/^Propeller_(\d+)$/);
        if (_propMatch) propellerByIndex.set(Number(_propMatch[1]) - 1, child);

        if (child.name === 'GunPoint_1' || child.name === 'GunPoint_2') {
          this._gunPoints.push(child);
        }

        if (child.name === 'RocketPoint_L' || child.name === 'RocketPoint_R') {
          this._rocketPoints.push(child);
        }

        // ── ADD THIS: permanently hide landing gear + wheels — AI planes
        // never take off/land, so gear should just never be shown. Matches
        // on both the Group node (LandingGear_N) and its child (Wheel_N),
        // same naming convention the player Plane class reads in
        // _loadHullModel(). Hiding the parent Group is enough to hide its
        // Wheel_N child too, but Wheel_N is matched explicitly as well in
        // case a wheel mesh is parented elsewhere in the hierarchy.
        if (/^LandingGear_\d+$/.test(child.name) || /^Wheel_\d+$/.test(child.name)) {
          child.visible = false;
        }
      });

      // ── Build ordered propeller array (index 0 = Propeller_1 or legacy
      // "Propeller", index 1 = Propeller_2, etc.) — mirrors plane.js's
      // Plane._loadHullModel() exactly.
      this._propellerNodes = [];
      const _propIndices = [...propellerByIndex.keys()].sort((a, b) => a - b);
      for (const idx of _propIndices) {
        this._propellerNodes.push(propellerByIndex.get(idx));
      }

      if (this.bulletSystem && this._gunPoints.length) {
        if (typeof this.bulletSystem.setGunPoints === 'function') {
          this.bulletSystem.setGunPoints(this._gunPoints);
        } else {
          this.bulletSystem.setGunPoint(this._gunPoints[0]);
        }
      }

      if (this.rocketSystem && this._rocketPoints.length) {
        this.rocketSystem.setLaunchPoints(this._rocketPoints);
      }

      this.bodyGroup.add(this._modelRoot);
      this._placeholder.visible = false;
    });

    // ── Weapon system — mirrors Plane.js's own gunType branch: gunType 3
    // uses MultiGunSystem (multi-barrel volley), otherwise the single-
    // barrel MachineGunSystem. Previously this was hardcoded to
    // MachineGunSystem regardless of the tank/plane def's gunType, which
    // silently downgraded any gunType-3 plane's AI/host-simulated weapon
    // to single-barrel MG behavior.
    this.bulletSystem?.dispose?.();
    this._gunType = this._lockedGunType ?? 1;

    console.log('[EnemyPlane activate]', this._lockedGunType, this._lockedMultiGunFireRate, this._lockedModelPath);
    const _gunEffectsExplosionSystem = _createGunEffectsFilter(explosionSystem);
    if (this._gunType === 3) {
      this.bulletSystem = new MultiGunSystem(this.scene, this.world, _gunEffectsExplosionSystem);
      this.bulletSystem.setDamage(this._lockedGunDamage ?? 20);
      if (this._lockedMultiGunFireRate) this.bulletSystem.setFireRate(this._lockedMultiGunFireRate);
    } else {
      this.bulletSystem = new MachineGunSystem(this.scene, this.world, _gunEffectsExplosionSystem);
      this.bulletSystem.setDamage(14);
      this.bulletSystem.setRange(220);
      this.bulletSystem.fireInterval = 0.11;
    }

    if (this._gunPoints?.length) {
      if (typeof this.bulletSystem.setGunPoints === 'function') {
        this.bulletSystem.setGunPoints(this._gunPoints);
      } else {
        this.bulletSystem.setGunPoint(this._gunPoints[0]);
      }
    }

    // ── Rocket system — optional secondary weapon. Only built when this
    // plane's locked config actually grants rocket ammo, so presets with
    // no rockets pay zero extra cost (no object, no per-frame update).
    this.rocketSystem?.dispose?.();
    this.rocketAmmo = this._lockedRocketAmmo ?? DEFAULT_ROCKET_AMMO;

    if (this.rocketAmmo > 0) {
      this.rocketSystem = new RocketSystem(this.scene, this.world, explosionSystem, {
        damage:     this._lockedRocketDamage  ?? 60,
        speed:      this._lockedRocketSpeed   ?? 70,
        reload:     this._lockedRocketReload  ?? 1.2,
        guided:     this._lockedGuidedMissile ?? false,
        rocketAuto: false, // AI always fires single discrete shots, never held auto-fire
      });
      // ── Explicit hit resolution — same reasoning as _fireGun's MG damage:
      // RocketSystem's own generic resolver→takeDamage path hardcodes
      // `_lastHitBy = 'player'`, which would misattribute an AI-fired
      // rocket's kill. We never pass an enemyResolver into fire() (see the
      // ATTACK-state rocket block), so that internal path never runs —
      // instead we resolve + apply damage here ourselves, against
      // whichever target this plane was actually locked onto at fire time.
      this.rocketSystem.onHit = (hitPos, _unusedHitEnemy, dmg, rbHandle) => {
        this._handleRocketHit(hitPos, rbHandle, dmg);
      };
    } else {
      this.rocketSystem = null;
    }

    this.state  = PLANE_STATE.PATROL;
    this.active = true;

    this.health = this.maxHealth;
    this.isDead = false;
    this._dissolveTimer  = 0;
    this._dissolveActive = false;
    this._killCounted  = false;
    this._lastHitBy    = null;
    this._treeCheckAccum = 0;

    this.shootTimer  = 1.0 + Math.random() * SHOOT_INTERVAL;
    this._burstShotsRemaining = 0;
    this._burstShotTimer      = 0;
    this._attackRunActive = false;
    this._attackRunTimer  = 0;
    this._orbitDir   = Math.random() < 0.5 ? -1 : 1;
    this._orbitFlipTimer = ORBIT_TURN_DIR_FLIP_TIME;
    this.rocketTimer = ROCKET_INTERVAL_MIN + Math.random() * ROCKET_INTERVAL_JITTER;

    this._flareAmmo       = AI_FLARE_TOTAL_AMMO;
    this._flareCooldown   = 0;
    this._flareCheckTimer = Math.random() * AI_FLARE_CHECK_INTERVAL;
    this._flybyState = 'armed';   // ← ADD — re-arm so a respawned plane can trigger a fresh flyby

    this._pickNewPatrolTarget(spawnPos);
  }

  deactivate() {
    if (!this.active) return;

    // ── Stop any active damage smoke tracking THIS plane before tearing
    // down state. deactivate() can be triggered by more than death — e.g.
    // EnemyPlanePool's out-of-bounds cleanup can deactivate a plane while
    // it's still alive and smoking from low health. main.js's
    // updateDamageFireEffects() only calls stopPlaneDamageSmoke() for
    // planes still present in enemyPlanePool.getActiveTanks() — once
    // deactivate() removes this plane from that list, nothing else would
    // ever tell ExplosionSystem to stop, leaving the smoke rendering
    // forever at this plane's last (now-frozen) position.
    this.explosionSystem?.stopPlaneDamageSmoke?.(this);

    if (this._audioSystem) {
      this._audioSystem.stopEnemyEngine?.(this._id);
    }

    this.bulletSystem?.invalidateRigidBody?.(this.rigidBody);
    this.rocketSystem?.invalidateRigidBody?.(this.rigidBody);

    if (this.rigidBody) {
      this.world.removeRigidBody(this.rigidBody);
      this.rigidBody = null;
    }

    if (this._modelRoot) {
      this.bodyGroup.remove(this._modelRoot);
      this._modelRoot = null;
    }
    this._gunPoints = null;
    this._rocketPoints = null;
    this._propellerNodes = [];

    // Materials belonged to the now-removed model clone — drop references
    // so they can be GC'd, and so a stale list doesn't get pushed to on
    // the next activation before the fresh model finishes loading.
    this._damageShaderMaterials = [];
    this._deathDamageCutoff     = null;
    this._deathDamageWingCutoff = null;

    this._placeholder.visible = false;
    this.bodyGroup.visible    = false;

    this.bulletSystem?.dispose();
    this.bulletSystem = null;
    this.rocketSystem?.dispose();
    this.rocketSystem = null;

    this.active = false;
    this.state  = PLANE_STATE.IDLE;
  }

  // ── AI helpers ────────────────────────────────────────────────────────────

  _pickNewPatrolTarget(fromPos) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = 80 + Math.random() * 140;
    const px = fromPos.x + Math.cos(angle) * dist;
    const pz = fromPos.z + Math.sin(angle) * dist;

    // ── Altitude must be relative to the terrain height UNDER THE NEW
    // PATROL POINT, not a flat world-space constant — the old version used
    // PATROL_ALTITUDE_MIN/MAX as an absolute Y, which on hilly terrain
    // could place the patrol target below a hill's actual ground height,
    // sending the plane straight through it on the way there.
    const groundY = this._getTerrainYRef ? this._getTerrainYRef(px, pz) : 0;
    const alt = groundY + PATROL_ALTITUDE_MIN + Math.random() * (PATROL_ALTITUDE_MAX - PATROL_ALTITUDE_MIN);

    this.patrolTarget.set(px, alt, pz);
    this.patrolTimer = 10 + Math.random() * 10;
  }

  // ── Shader-based damage stripping ─────────────────────────────────────
  // Identical technique to the player Plane class (plane.js) — discards
  // fragments beyond a jagged cutoff plane, both nose→tail and inward from
  // each wingtip. See plane.js for the full derivation/comments; kept
  // terse here since EnemyPlane has no per-instance cfg object.

  _setupDamageShaderMaterial(material) {
    if (!material || material.userData?.__damagePatched) return;
    material.userData = material.userData || {};
    material.userData.__damagePatched = true;

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uDamageOrigin:     { value: new THREE.Vector3() },
        uDamageAft:        { value: new THREE.Vector3(0, 0, 1) },
        uDamageRight:      { value: new THREE.Vector3(1, 0, 0) },
        uDamageUp:         { value: new THREE.Vector3(0, 1, 0) },
        uDamageCutoff:     { value: 9999 },
        uDamageWingCutoff: { value: 9999 },
        uDamageJagAmp:     { value: (this._lockedDamageEffect ?? DEFAULT_DAMAGE_EFFECT).jagAmplitude },
        uDamageJagFreq:    { value: (this._lockedDamageEffect ?? DEFAULT_DAMAGE_EFFECT).jagFrequency },
      });

      shader.vertexShader = 'varying vec3 vDamageWorldPos;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>\n  vDamageWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

      shader.fragmentShader =
        'varying vec3 vDamageWorldPos;\n' +
        'uniform vec3 uDamageOrigin;\n' +
        'uniform vec3 uDamageAft;\n' +
        'uniform vec3 uDamageRight;\n' +
        'uniform vec3 uDamageUp;\n' +
        'uniform float uDamageCutoff;\n' +
        'uniform float uDamageWingCutoff;\n' +
        'uniform float uDamageJagAmp;\n' +
        'uniform float uDamageJagFreq;\n' +
        shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        `void main() {
    {
      vec3 dOff = vDamageWorldPos - uDamageOrigin;
      float aftDist    = dot(dOff, uDamageAft);
      float rightCoord = dot(dOff, uDamageRight);
      float upCoord    = dot(dOff, uDamageUp);

      float z1 = abs(fract(rightCoord * uDamageJagFreq) - 0.5) * 4.0 - 1.0;
      float z2 = abs(fract(upCoord * uDamageJagFreq * 1.7 + 0.31) - 0.5) * 4.0 - 1.0;
      float z3 = abs(fract((rightCoord + upCoord) * uDamageJagFreq * 2.9 + 0.62) - 0.5) * 4.0 - 1.0;
      float jag = (z1 * 0.5 + z2 * 0.3 + z3 * 0.2) * uDamageJagAmp;
      if (aftDist > uDamageCutoff + jag) discard;

      float w1 = abs(fract(aftDist * uDamageJagFreq) - 0.5) * 4.0 - 1.0;
      float w2 = abs(fract(upCoord * uDamageJagFreq * 1.7 + 0.31) - 0.5) * 4.0 - 1.0;
      float w3 = abs(fract((aftDist + upCoord) * uDamageJagFreq * 2.9 + 0.62) - 0.5) * 4.0 - 1.0;
      float jagWing = (w1 * 0.5 + w2 * 0.3 + w3 * 0.2) * uDamageJagAmp;

      float rightWingDist = rightCoord;
      float leftWingDist  = -rightCoord;
      if (rightWingDist > uDamageWingCutoff + jagWing) discard;
      if (leftWingDist  > uDamageWingCutoff + jagWing) discard;
    }
`
      );

      material.userData.damageShader = shader;
    };

    material.needsUpdate = true;
  }

  /** Writes cutoff/wingCutoff + live orientation into every patched
   * material's uniforms. Shared by the alive (health-driven) path and the
   * per-frame re-anchor while falling after death. */
  _pushDamageShaderUniforms(cutoff, wingCutoff) {
    if (!this._damageShaderMaterials?.length || !this.bodyGroup) return;

    this.bodyGroup.getWorldPosition(this._scratchDamageOrigin);
    this._scratchDamageAft.set(1, 0, 0).applyQuaternion(this.bodyGroup.quaternion);
    this._scratchDamageRight.set(0, 0, -1).applyQuaternion(this.bodyGroup.quaternion);
    this._scratchDamageUp.set(0, 1, 0).applyQuaternion(this.bodyGroup.quaternion);

    for (const mat of this._damageShaderMaterials) {
      const shader = mat.userData?.damageShader;
      if (!shader) continue; // hasn't compiled yet
      shader.uniforms.uDamageOrigin.value.copy(this._scratchDamageOrigin);
      shader.uniforms.uDamageAft.value.copy(this._scratchDamageAft);
      shader.uniforms.uDamageRight.value.copy(this._scratchDamageRight);
      shader.uniforms.uDamageUp.value.copy(this._scratchDamageUp);
      shader.uniforms.uDamageCutoff.value = cutoff;
      shader.uniforms.uDamageWingCutoff.value = wingCutoff;
    }
  }

  /** Pushes the current health-derived cutoff each frame while alive. */
  _updateDamageShaderUniforms() {
    const de = this._lockedDamageEffect ?? DEFAULT_DAMAGE_EFFECT;
    const healthFrac = this.maxHealth > 0 ? this.health / this.maxHealth : 1;

    let cutoff = 9999;
    let wingCutoff = 9999;
    if (healthFrac < de.healthTriggerFraction) {
      const t = 1 - (healthFrac / de.healthTriggerFraction);
      const remainingFrac = THREE.MathUtils.lerp(1, de.minRemainingFraction, t);
      cutoff = remainingFrac * de.maxCutbackLength;
      wingCutoff = remainingFrac * de.wingCutbackLength;
    }

    this._pushDamageShaderUniforms(cutoff, wingCutoff);
  }

  _getForward() {
    const rot = this.rigidBody.rotation();
    this._scratchQ.set(rot.x, rot.y, rot.z, rot.w);
    // Model is authored nose-along-local -X (modelRotY = -90°), same
    // convention as the player Plane class's getForwardVector().
    return this._scratchFwd.set(-1, 0, 0).applyQuaternion(this._scratchQ);
  }

  /**
   * Steers the plane toward a world-space target point in full 3D.
   * Sets linear velocity directly (banked toward the target) and orients
   * the rigid body to face its velocity — arcade-style flight, consistent
   * with how EnemyTank._steerToward drives ground units via simple direct
   * control rather than full force-based aerodynamics.
   */
  _steerToward(targetPos, speed, dt, minAltitudeAboveGround = null, turnRate = TURN_RATE) {
    const pos = this.rigidBody.translation();

    let ty = targetPos.y;
    if (minAltitudeAboveGround !== null) {
      // ── Terrain-relative floor — clamp against the ground height under
      // BOTH the plane's current position and the target's position (the
      // higher of the two), so a plane crossing from a valley toward a
      // point beyond a hill (or chasing a ground target like a tank) never
      // dips through terrain partway along the path. This is also what
      // fixes ENGAGE/ATTACK: previously, chasing a tank meant steering
      // straight at the tank's ground-level Y with no floor at all.
      if (this._getTerrainYRef) {
        const groundHere   = this._getTerrainYRef(pos.x, pos.z);
        const groundTarget = this._getTerrainYRef(targetPos.x, targetPos.z);
        const floor = Math.max(groundHere, groundTarget) + minAltitudeAboveGround;
        ty = Math.max(ty, floor);
      } else {
        ty = Math.max(ty, minAltitudeAboveGround); // fallback if no terrain sampler wired up yet
      }
    }

    const toTarget = this._scratchToTgt.set(targetPos.x - pos.x, ty - pos.y, targetPos.z - pos.z);
    const dist = toTarget.length();
    if (dist > 0.001) toTarget.normalize();

    const fwd = this._getForward();

    // ── Slerp current facing toward the desired direction — gives a
    // believable turn radius instead of instantly snapping to face target.
    const currentQ = this._scratchQ;
    const _localForwardAxis = this._scratchOrbit.set(-1, 0, 0);
    this._scratchTargetQ.setFromUnitVectors(_localForwardAxis, toTarget);
    const turnT = Math.min(1, turnRate * dt);
    currentQ.slerp(this._scratchTargetQ, turnT);
    this.rigidBody.setRotation({ x: currentQ.x, y: currentQ.y, z: currentQ.z, w: currentQ.w }, true);

    // ── Velocity follows the (now-updated) facing direction at `speed`,
    // vertical component clamped so climb/dive rate feels aircraft-like
    // rather than snapping instantly.
    const newFwd = this._scratchFwd.set(-1, 0, 0).applyQuaternion(currentQ);
    const desiredVel = this._scratchVel.copy(newFwd).multiplyScalar(speed);

    const vel = this.rigidBody.linvel();
    const maxVertDelta = MAX_CLIMB_RATE * dt;
    let vy = desiredVel.y;
    if (vy - vel.y > maxVertDelta) vy = vel.y + maxVertDelta;
    if (vel.y - vy > maxVertDelta) vy = vel.y - maxVertDelta;

    this.rigidBody.setLinvel({ x: desiredVel.x, y: vy, z: desiredVel.z }, true);

    return dist;
  }

  /** Orbits a target point at ORBIT_RADIUS, used while in ATTACK state. */
  _orbitTarget(targetPos, speed, dt) {
    const pos = this.rigidBody.translation();
    const dx = pos.x - targetPos.x;
    const dz = pos.z - targetPos.z;
    const curDist = Math.sqrt(dx * dx + dz * dz) || 1;

    // Tangent direction around the target, flipped periodically so AI
    // planes don't fly a perfectly predictable circle forever.
    this._orbitFlipTimer -= dt;
    if (this._orbitFlipTimer <= 0) {
      this._orbitFlipTimer = ORBIT_TURN_DIR_FLIP_TIME * (0.7 + Math.random() * 0.6);
      this._orbitDir *= -1;
    }

    const radialX = dx / curDist, radialZ = dz / curDist;
    const tangentX = -radialZ * this._orbitDir, tangentZ = radialX * this._orbitDir;

    // Blend inward/outward correction with tangential motion to hold ORBIT_RADIUS
    const radialError = curDist - ORBIT_RADIUS;
    const inwardPull = THREE.MathUtils.clamp(radialError * 0.03, -0.6, 0.6);

    const aimPoint = this._scratchOrbit.set(
      pos.x + (tangentX - radialX * inwardPull) * 40,
      targetPos.y,
      pos.z + (tangentZ - radialZ * inwardPull) * 40
    );

    return this._steerToward(aimPoint, speed, dt, MIN_FLIGHT_ALTITUDE);
  }

  // ── Combat target resolution — base class targets the player + friendly
  // tanks/planes (whichever is nearest); FriendlyPlane overrides to search
  // enemy tanks/planes instead. Mirrors EnemyTank._findCombatTarget's shape
  // so main.js's existing wiring pattern (extraTargets arrays) carries over.
  /** Team-relative target search — same contract as EnemyTank._findCombatTarget()
   * in enemyTank.js. `allCandidates` is the flat, team-tagged list built once
   * per frame by main.js (see _buildAiCandidateList()). */
  _findCombatTarget(pos, allCandidates) {
    let bestPos       = null;
    let bestRigidBody = null;
    let bestIsPlayer  = false;
    let bestTankRef   = null;
    let bestDistSq    = Infinity;

    if (pos && allCandidates && allCandidates.length) {
      for (let i = 0; i < allCandidates.length; i++) {
        const c = allCandidates[i];
        if (!c || c.team === this.team) continue;
        if (c.isDead) continue;
        if (!c.rigidBody && !c.isPlayer) continue;
        const cp = c.pos;
        if (!cp) continue;
        const dx = cp.x - pos.x, dz = cp.z - pos.z, dy = cp.y - pos.y;
        const dsq = dx * dx + dy * dy + dz * dz;
        if (dsq < bestDistSq) {
          bestDistSq    = dsq;
          bestPos       = cp;
          bestRigidBody = c.rigidBody ?? null;
          bestIsPlayer  = !!c.isPlayer;
          bestTankRef   = c.tankRef ?? null;
        }
      }
    }

    if (bestRigidBody === null && bestTankRef === null) {
      this._scratchFarTarget = this._scratchFarTarget || { x: 0, y: 0, z: 0 };
      this._scratchFarTarget.x = pos.x + 1e6;
      this._scratchFarTarget.y = pos.y;
      this._scratchFarTarget.z = pos.z;
      return { pos: this._scratchFarTarget, rigidBody: null, isPlayer: false, tankRef: null };
    }

    return { pos: bestPos, rigidBody: bestRigidBody, isPlayer: bestIsPlayer, tankRef: bestTankRef };
  }

  // ── Damage / death ───────────────────────────────────────────────────────

  takeDamage(amount = 20) {
    if (this.isDead) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) this._die();
  }

  /**
   * Destroys the plane after it clips into terrain — reuses the exact same
   * visual/audio death sequence as being shot down (_die()), but explicitly
   * clears kill attribution first. main.js's kill-counting/kill-feed logic
   * only credits a kill when _lastHitBy is 'player' or 'friendly', so
   * clearing it to null here guarantees a terrain crash is never counted
   * as a kill — even if this plane happened to take non-fatal damage from
   * the player or a friendly moments earlier (which would otherwise leave
   * _lastHitBy stale and misattribute the crash to them).
   */
  _dieFromGroundImpact() {
    if (this.isDead) return;

    // Sync the visual transform to the current physics position before
    // dying — update() normally does this later in the frame, but ground
    // collision is detected (and returns early) before reaching that point.
    if (this.rigidBody) {
      const p = this.rigidBody.translation();
      const r = this.rigidBody.rotation();
      this.bodyGroup.position.set(p.x, p.y, p.z);
      this.bodyGroup.quaternion.set(r.x, r.y, r.z, r.w);
    }

    this.health        = 0;
    this._lastHitBy     = null;
    this._lastHitByPos  = null;
    this._die();
  }

  /**
   * Destroys this plane after colliding with a solid obstacle other than
   * terrain — a house collider or a tank's hull — reported by main.js via
   * eventQueue.drainCollisionEvents(). Mirrors _dieFromGroundImpact():
   * kill attribution is explicitly cleared so a stray earlier hit from the
   * player/a friendly doesn't get wrongly credited for what's actually an
   * unrelated crash.
   */
  _dieFromObstacleImpact() {
    if (this.isDead) return;

    if (this.rigidBody) {
      const p = this.rigidBody.translation();
      const r = this.rigidBody.rotation();
      this.bodyGroup.position.set(p.x, p.y, p.z);
      this.bodyGroup.quaternion.set(r.x, r.y, r.z, r.w);
    }

    this.health        = 0;
    this._lastHitBy     = null;
    this._lastHitByPos  = null;
    this._die();
  }

  _die() {
    if (this.isDead) return;
    this.isDead = true;
    this.state  = PLANE_STATE.DEAD;

    // ── Increase battle-damage stripping the instant this plane is
    // destroyed, same approach as the player Plane class's _die(). Stored
    // so _tickDissolve() can keep re-anchoring the origin/axes to the
    // falling wreck's live transform every frame at this fixed cutoff.
    const de = this._lockedDamageEffect ?? DEFAULT_DAMAGE_EFFECT;
    this._deathDamageCutoff     = de.deathMinRemainingFraction * de.maxCutbackLength;
    this._deathDamageWingCutoff = de.deathMinRemainingFraction * de.wingCutbackLength;
    this._pushDamageShaderUniforms(this._deathDamageCutoff, this._deathDamageWingCutoff);

    this.bulletSystem?.invalidateRigidBody?.(this.rigidBody);
    this.rocketSystem?.invalidateRigidBody?.(this.rigidBody);

    if (this.rigidBody) {
      this.world.removeRigidBody(this.rigidBody);
      this.rigidBody = null;
    }

    this.bodyGroup.traverse(c => { if (c.isMesh) c.castShadow = false; });

    // ── Propeller keeps windmilling through the fall instead of freezing
    // at the death instant — same fixed rate the alive-state update() uses.
    this._propSpinVelocity = this._propellerNodes.length > 0 ? 30 : 0;

    if (this.explosionSystem) {
      const deathPos = new THREE.Vector3();
      this.bodyGroup.getWorldPosition(deathPos);
      this.explosionSystem.spawn(deathPos);
      this._audioSystem?.playPlaneExplosion?.(this._distToPlayer);

      const _distAtDeath = this._distToPlayer;
      setTimeout(() => {
        const off = new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.3, (Math.random() - 0.5) * 1.2);
        this.explosionSystem?.spawn(deathPos.clone().add(off));
        this._audioSystem?.playPlaneExplosion?.(_distAtDeath);
      }, 200);
    }

    // ── Fall — seeded from the plane's ACTUAL rigid-body velocity at the
    // moment of death (captured BEFORE the rigid body is removed below),
    // not a flat CHASE_SPEED guess. Same fix as the player Plane class's
    // _die() — preserves real momentum from a dive/attack-run/knockback
    // into the death fall instead of discarding it.
    if (this.rigidBody) {
      const _preDeathVel = this.rigidBody.linvel();
      this._fallVel = new THREE.Vector3(_preDeathVel.x, _preDeathVel.y, _preDeathVel.z);
    } else {
      this.getForwardVector(this._scratchFwd);
      this._fallVel = this._scratchFwd.clone().multiplyScalar(CHASE_SPEED * 0.6);
    }
    this._fallVel.y -= 1;
    this._fallRollRate = (Math.random() < 0.5 ? -1 : 1) * THREE.MathUtils.randFloat(1.2, 2.8);

    this._dissolveTimer  = DEATH_FALL_DURATION;
    this._dissolveActive = true;
    this._groundExplosionSpawned = false;
  }

    // ── ADD THIS WHOLE METHOD ───────────────────────────────────────────────
  /**
   * Fires the close-pass "flyby" one-shot once this plane gets inside
   * FLYBY_TRIGGER_DIST, then the receding "afterpass" tail once it has
   * pulled back out past FLYBY_TRIGGER_DIST * 1.4 — and re-arms itself
   * once the plane is far enough away (FLYBY_REARM_DIST) to trigger again
   * on a later pass. Pan is derived from lateral world-X offset from the
   * player; flip the sign below if it sweeps the wrong way for your
   * camera/world convention.
   * @param {number} lateralX  pos.x - playerPos.x (already computed in update())
   */
  _updateFlybySound(audioSystem, lateralX) {
    if (!audioSystem || this.isDead) return;
    const dist = this._distToPlayer;
    const pan  = THREE.MathUtils.clamp(lateralX / FLYBY_PAN_WIDTH, -1, 1);

    if (this._flybyState === 'armed') {
      if (dist < FLYBY_TRIGGER_DIST) {
        audioSystem.playPlaneFlyby(pan, 1.05 + Math.random() * 0.08);
        this._flybyState = 'triggered';
      }
    } else if (this._flybyState === 'triggered') {
      if (dist > FLYBY_TRIGGER_DIST * 1.4) {
        audioSystem.playPlaneAfterpass(pan, 0.85 + Math.random() * 0.06);
        this._flybyState = 'done';
      }
    } else if (this._flybyState === 'done') {
      if (dist > FLYBY_REARM_DIST) {
        this._flybyState = 'armed'; // re-armed — ready for the next pass
      }
    }
  }
  // ── END ADD ──────────────────────────────────────────────────────────

  _tickDissolve(dt, audioSystem = null, playerPos = null, onTreeCollision = null) {
    this.bulletSystem?.update(dt);
    this.rocketSystem?.update(dt); // keep any rocket already in flight animating/resolving its hit even after this plane itself has died
    this._dissolveTimer -= dt;

    // ── Engine while falling — pitch drops immediately to a low, dying
    // drone and STAYS there (dyingPitchFactor=0), while volume is boosted
    // so it stays clearly audible over the whole fall instead of fading
    // toward silence. The loop is stopped outright — cleanly, via
    // stopEnemyEngine's own short fade — the instant the plane actually
    // hits the ground (see the ground-impact block below), not on a timer.
    if (audioSystem && !this._groundExplosionSpawned) {
      let dist = this._distToPlayer;
      if (playerPos) {
        const dx = this.bodyGroup.position.x - playerPos.x;
        const dy = this.bodyGroup.position.y - playerPos.y;
        const dz = this.bodyGroup.position.z - playerPos.z;
        dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        this._distToPlayer = dist;
      }
      audioSystem.updateEnemyEngine(this._id, dt, 0, false, dist, true, 0, ENGINE_DYING_VOLUME_BOOST);
    }

    if (this._propellerNodes.length > 0) {
      this._propSpinVelocity = Math.max(0, this._propSpinVelocity - 3 * dt); // tune decay rate to taste
      this._propSpinAngle += this._propSpinVelocity * dt;
      for (const propNode of this._propellerNodes) {
        propNode.rotation.z = this._propSpinAngle;
      }
    }

    if (this._fallVel) {
      this._fallVel.y -= FALL_GRAVITY * dt;
      // Bleed off horizontal speed so the plane noses over into more of a
      // drop instead of gliding forward at death-speed for the whole
      // DEATH_FALL_DURATION.
      const dragFactor = Math.max(0, 1 - FALL_DRAG * dt);
      this._fallVel.x *= dragFactor;
      this._fallVel.z *= dragFactor;
      this.bodyGroup.position.addScaledVector(this._fallVel, dt);
      if (this._fallRollRate) {
        this.getForwardVector(this._scratchFwd);
        this._scratchQ.setFromAxisAngle(this._scratchFwd, this._fallRollRate * dt);
        this.bodyGroup.quaternion.premultiply(this._scratchQ);
      }

      // ── Re-anchor the damage-shader origin/axes to the wreck's CURRENT
      // position/orientation every frame — same fix as the player Plane
      // class. Without this the cutoff plane stays frozen at the death
      // instant while the mesh keeps falling/rolling away from it, making
      // the wreck progressively vanish instead of staying consistently
      // torn-up. Cutoff distance itself stays fixed at the death value.
      if (this._deathDamageCutoff !== null) {
        this._pushDamageShaderUniforms(this._deathDamageCutoff, this._deathDamageWingCutoff);
      }

            // ── Tree-knockdown probe — gated to when the wreck is actually
      // close to the ground (so most of the fall, while still high up,
      // costs nothing) and throttled to ~10Hz on top of that.
      if (onTreeCollision && !this._groundExplosionSpawned && this._getTerrainYRef) {
        const _groundY = this._getTerrainYRef(this.bodyGroup.position.x, this.bodyGroup.position.z);
        if (this.bodyGroup.position.y - _groundY < 20) {
          this._treeCheckAccum += dt;
          if (this._treeCheckAccum >= 0.1) {
            this._treeCheckAccum = 0;
            this.getForwardVector(this._scratchFwd);
            onTreeCollision(
              this.bodyGroup.position.x,
              this.bodyGroup.position.z,
              this._scratchFwd.x,
              this._scratchFwd.z,
            );
          }
        }
      }

      if (this._getTerrainYRef && !this._groundExplosionSpawned) {
        const groundY = this._getTerrainYRef(this.bodyGroup.position.x, this.bodyGroup.position.z);
        if (this.bodyGroup.position.y <= groundY + 0.5) {
          this.bodyGroup.position.y = groundY + 0.5;
          this._fallVel.set(0, 0, 0);
          this._groundExplosionSpawned = true;
          this._audioSystem?.stopEnemyEngine?.(this._id);   // ← engine cuts (cleanly) exactly on ground impact
          if (this.explosionSystem) {
            const impactPos = this.bodyGroup.position.clone();
            this.explosionSystem.spawn(impactPos);
            this._audioSystem?.playExplosion?.(this._distToPlayer);
          }
        }
      }
    }

    if (this._dissolveTimer <= 0) {
      this._dissolveActive = false;
      this.deactivate();
    }
  }

  // ── Main update ───────────────────────────────────────────────────────────

  /**
   * @param {number}        dt
   * @param {THREE.Vector3} playerPos
   * @param {Function|null} onMuzzleFlash
   * @param {Function|null} onHitPlayer   – (damage, combatTarget, dist, attackerPos) => void
   * @param {object|null}   audioSystem
   * @param {object|null}   playerRigidBody
   * @param {Array}         extraTargets  – friendly (or enemy, for FriendlyPlane) tanks+planes
   * @param {Function|null} getTerrainY   – (x,z) => height, used only for the death-fall impact check
   */
  update(dt, playerPos, onMuzzleFlash, onHitPlayer, audioSystem, playerRigidBody, allCandidates, getTerrainY, onTreeCollision, threatRocketSystems) {
    if (!this.active) return;
    this._getTerrainYRef = getTerrainY ?? this._getTerrainYRef;
    this._threatRocketSystemsRef = threatRocketSystems;

    if (this._dissolveActive) {
      this._tickDissolve(dt, audioSystem, playerPos, onTreeCollision);
      return;
    }
    if (!this.rigidBody) return;

    const pos = this.rigidBody.translation();
    this._cachedPos = pos;

    // ── Ground collision — destroys the plane the instant it clips into
    // (or below) actual terrain height, regardless of what the steering
    // logic was aiming for. This is a hard failsafe layered on top of the
    // terrain-relative altitude targeting above (_steerToward /
    // _pickNewPatrolTarget) — those reduce how often this happens, this
    // catches anything that still slips through. Explicitly NOT attributed
    // to any shooter, so it's never credited as a player/friendly kill
    // (see _dieFromGroundImpact).
    if (this._getTerrainYRef) {
      const groundY = this._getTerrainYRef(pos.x, pos.z);
      if (pos.y <= groundY + GROUND_COLLISION_MARGIN) {
        this._dieFromGroundImpact();
        return;
      }
    }

    const dxp = pos.x - playerPos.x, dzp = pos.z - playerPos.z, dyp = pos.y - playerPos.y;
    this._distToPlayer = Math.sqrt(dxp * dxp + dyp * dyp + dzp * dzp);
    this._lastPlayerPos.set(playerPos.x, playerPos.y, playerPos.z);

    if (audioSystem) {
      const vel = this.rigidBody.linvel();
      const spd = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
      audioSystem.updateEnemyEngine?.(this._id, dt, spd / 30, spd > 1, this._distToPlayer, true);
    }

        // ← ADD — layer the flyby/afterpass one-shots on top of the ambient engine loop above
    this._updateFlybySound(audioSystem, dxp);

    const combatTarget = this._findCombatTarget(pos, allCandidates);
    const dx = pos.x - combatTarget.pos.x, dy = pos.y - combatTarget.pos.y, dz = pos.z - combatTarget.pos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Cached for _handleRocketHit, which fires asynchronously whenever a
    // rocket actually lands — not necessarily this same frame.
    this._lastCombatTarget = combatTarget.rigidBody ? combatTarget : null;
    this._lastCombatDist   = dist;

    const isJobState = this.state === PLANE_STATE.PATROL || this.state === PLANE_STATE.IDLE;
    const hasLivingTarget = !!combatTarget.rigidBody;

    // ── FSM transitions ──────────────────────────────────────────────────
    if (hasLivingTarget && dist < ATTACK_RANGE) {
      if (this.state !== PLANE_STATE.ATTACK) {
        if (isJobState) this._prevJobState = this.state;
        this.state = PLANE_STATE.ATTACK;
      }
    } else if (hasLivingTarget && dist < DETECT_RANGE) {
      if (isJobState) this._prevJobState = this.state;
      if (this.state !== PLANE_STATE.ATTACK) this.state = PLANE_STATE.ENGAGE;
    } else if ((this.state === PLANE_STATE.ATTACK || this.state === PLANE_STATE.ENGAGE)
               && (!hasLivingTarget || dist > STOP_CHASE_RANGE)) {
      this.state = this._prevJobState ?? PLANE_STATE.PATROL;
    }

    // ── FSM actions ──────────────────────────────────────────────────────
    if (this.state === PLANE_STATE.PATROL) {
      this.patrolTimer -= dt;
      const toDest = Math.hypot(this.patrolTarget.x - pos.x, this.patrolTarget.z - pos.z);
      if (this.patrolTimer <= 0 || toDest < 15) {
        this._pickNewPatrolTarget(pos);
      }
      this._steerToward(this.patrolTarget, PATROL_SPEED, dt, MIN_FLIGHT_ALTITUDE);

    } else if (this.state === PLANE_STATE.ENGAGE) {
      this._steerToward(combatTarget.pos, CHASE_SPEED, dt, MIN_FLIGHT_ALTITUDE);

    } else if (this.state === PLANE_STATE.ATTACK) {
      // ── Movement: orbit to reposition between bursts, but break into a
      // direct lead-pursuit pass ("gun run") for the duration of each
      // burst — orbiting alone points the nose tangent to the target, so
      // the facing-cone check in _fireGun almost never passed before.
      if (this._attackRunActive) {
        this._attackRunTimer -= dt;

        // Lead the target using its current velocity so the pass converges
        // on where it's headed, not where it was a frame ago.
        let aimPos = combatTarget.pos;
        let tVel = null;
        try {
          // Guard against a stale/freed rigid-body handle — the target may
          // have died earlier THIS SAME FRAME (e.g. killed by another AI
          // unit processed before this one), in which case its rigidBody
          // reference here is already invalid on the Rapier/wasm side even
          // though the JS object still exists. Calling .linvel() on it
          // would otherwise panic the whole physics world.
          if (combatTarget.rigidBody?.isValid?.() !== false) {
            tVel = combatTarget.rigidBody?.linvel?.();
          }
        } catch (_) {
          tVel = null;
        }
        if (tVel) {
          const leadTime = Math.min(1.4, dist / ATTACK_RUN_SPEED);
          aimPos = this._scratchLead.set(
            combatTarget.pos.x + tVel.x * leadTime,
            combatTarget.pos.y + tVel.y * leadTime,
            combatTarget.pos.z + tVel.z * leadTime
          );
        }
        this._steerToward(aimPos, ATTACK_RUN_SPEED, dt, MIN_FLIGHT_ALTITUDE, ATTACK_RUN_TURN_RATE);

        if (this._attackRunTimer <= 0 || dist < ORBIT_RADIUS * 0.6) {
          this._attackRunActive = false; // break off, resume orbit to reposition
        }
      } else {
        this._orbitTarget(combatTarget.pos, ATTACK_SPEED, dt);
      }

      // ── Shoot — bursts of discrete shots, count randomized per burst
      // (BURST_SHOTS_MIN..BURST_SHOTS_MAX), each spaced BURST_FIRE_INTERVAL
      // apart. Between bursts, shootTimer enforces the longer cooldown.
      if (this._burstShotsRemaining > 0) {
        this._burstShotTimer -= dt;
        if (this._burstShotTimer <= 0) {
          // ── Use the gun's own configured fire rate for shot cadence
          // when it's faster than the generic burst tick, so a plane
          // with a low fireRate (e.g. the SU-30's 0.02) actually fires
          // audibly/mechanically faster instead of being capped at
          // BURST_FIRE_INTERVAL (0.1) regardless of its real fireRate.
          const _shotInterval = Math.min(BURST_FIRE_INTERVAL, this.bulletSystem?.reloadTime ?? BURST_FIRE_INTERVAL);
          this._burstShotTimer = _shotInterval;
          this._burstShotsRemaining--;
          this._fireGun(combatTarget, onHitPlayer, onMuzzleFlash, audioSystem);
        }
      } else {
        this.shootTimer -= dt;
        if (this.shootTimer <= 0 && combatTarget.rigidBody) {
          // Loose pre-check (not the strict GUN_FACING_COS fire-cone) — only
          // commit to a burst if the nose is already roughly pointed at the
          // target. Otherwise skip this cycle and let orbiting keep turning;
          // shootTimer stays at <=0 so the check re-runs next frame.
          const fwd = this._getForward();
          const toTgt = this._scratchToTgt.set(
            combatTarget.pos.x - pos.x,
            combatTarget.pos.y - pos.y,
            combatTarget.pos.z - pos.z
          ).normalize();

          if (fwd.dot(toTgt) > 0.3) {
            this.shootTimer          = SHOOT_INTERVAL + Math.random() * 1.2;
            this._burstShotsRemaining = BURST_SHOTS_MIN
              + Math.floor(Math.random() * (BURST_SHOTS_MAX - BURST_SHOTS_MIN + 1));
            this._burstShotTimer      = 0; // fire the first shot immediately on burst start
            // Start a direct gun-run pass timed with the burst, instead of
            // firing while still tangential to the target mid-orbit.
            this._attackRunActive = true;
            this._attackRunTimer  = ATTACK_RUN_DURATION;
          }
        }
      }

      // ── Rockets — occasional secondary attack, NOT a constant weapon:
      // gated by a long randomized cooldown, a facing check, finite ammo,
      // AND a probability roll. The cooldown ticks for the WHOLE ATTACK
      // state (not just during a gun-run pass) so it reliably reaches 0
      // within a plane's actual combat lifetime — gating it to the short
      // gun-run window made the effective cooldown much longer than
      // intended and, combined with a tight facing check against the RAW
      // target position (rather than where the plane was actually
      // steering), meant it almost never fired before the plane died.
      if (this.rocketSystem && this.rocketAmmo > 0 && combatTarget.rigidBody) {
        this.rocketTimer -= dt;
        if (this.rocketTimer <= 0) {
          const rFwd = this._getForward();
          const rToTgt = this._scratchToTgt.set(
            combatTarget.pos.x - pos.x,
            combatTarget.pos.y - pos.y,
            combatTarget.pos.z - pos.z
          ).normalize();
          const aligned = rFwd.dot(rToTgt) > ROCKET_FACING_COS;

          if (aligned && this.rocketSystem.isReady) {
            if (Math.random() < ROCKET_FIRE_CHANCE) {
              // ── Build a minimal, safe homing-lock target. Prefer the
              // real instance (combatTarget.tankRef — an EnemyTank/
              // EnemyPlane/etc, which already has correct .active/.isDead)
              // when available. The player itself has no tankRef wired
              // through allCandidates, so fall back to a tiny adapter that
              // checks the LIVE Rapier rigidBody validity each frame
              // instead of trusting a frozen isDead snapshot — avoids ever
              // calling .translation() on a rigid body that's since been
              // removed (respawn/death), which would panic Rapier.
              const rb = combatTarget.rigidBody;
              // Ref to the real Plane instance if this lock is on the human
              // player — used so the fallback lock object below can still
              // answer getActiveFlareDecoys(), same as a real tankRef would.
              const _lockPlayerRef = combatTarget.isPlayer ? this._playerVehicleRef : null;
              const lockTarget = this.rocketSystem.guided
                ? (combatTarget.tankRef ?? (rb ? {
                    rigidBody: rb,
                    get isDead() {
                      try { return rb.isValid ? rb.isValid() === false : false; } catch (_) { return true; }
                    },
                    getActiveFlareDecoys: () => _lockPlayerRef?.getActiveFlareDecoys?.() ?? null,
                  } : null))
                : null;

              this.rocketSystem.fire(this.rigidBody, null, combatTarget.pos, lockTarget);
              this.rocketAmmo--;
              this.rocketTimer = ROCKET_INTERVAL_MIN + Math.random() * ROCKET_INTERVAL_JITTER;
            } else {
              this.rocketTimer = ROCKET_RETRY_BACKOFF; // missed the roll — short recheck, not a full cooldown
            }
          } else {
            this.rocketTimer = ROCKET_RETRY_BACKOFF; // not aligned/ready yet — recheck soon
          }
        }
      }
    }

    // ── Propeller spin — cosmetic only, spins every propeller in lockstep
    // (index-agnostic) unless per-prop tuning is added later ─────────────
    if (this._propellerNodes.length > 0) {
      this._propSpinAngle += 30 * dt;
      for (const propNode of this._propellerNodes) {
        propNode.rotation.z = this._propSpinAngle;
      }
    }

    // ── Auto-reload — AI planes have no player-driven reload trigger (no
    // "R" key, no main.js mgAmmo-pool watcher), so once the magazine
    // (MG_MAG_SIZE = 30 rounds) empties, `rounds` stays at 0 forever and
    // MachineGunSystem.fire() silently no-ops (returns false) for the rest
    // of the plane's life — tracer beam, muzzle flash, and shot audio all
    // stop, even though bursts keep "firing" every attack cycle.
    if (this.bulletSystem && this.bulletSystem.rounds <= 0 && !this.bulletSystem._reloading) {
      this.bulletSystem._reloading   = true;
      this.bulletSystem._reloadTimer = this.bulletSystem.fullReloadTime;
    }

    this.bulletSystem?.update(dt);
    this.rocketSystem?.update(dt);
    this._updateFlareCountermeasures(dt, this._threatRocketSystemsRef);
    if (this._gunSoundCooldown > 0) this._gunSoundCooldown -= dt;

    // ── Visual transform ─────────────────────────────────────────────────
    const rot = this.rigidBody.rotation();
    this._scratchWorldPos.set(pos.x, pos.y, pos.z);
    this.bodyGroup.position.copy(this._scratchWorldPos);
    this.bodyGroup.quaternion.set(rot.x, rot.y, rot.z, rot.w);

    // ── Health-driven shader damage stripping (no extra geometry) ────────
    this._updateDamageShaderUniforms();
  }

  // ── Fire-cadence gate — MachineGunSystem.fire() is meant to be called
  // every tick while the trigger is "held" (same as main.js's continuous
  // MG-fire block for the player), so AI bursts call it every frame for
  // BURST_DURATION seconds rather than once per shot.
  _fireGun(combatTarget, onHitPlayer, onMuzzleFlash, audioSystem) {
    if (!this.bulletSystem) return;
    if (!this._gunPoints?.length) return;

    const rb = this.rigidBody;
    const targetRb = combatTarget.rigidBody;

    // Explicit hit resolution — a simple range + facing cone check against
    // the resolved combat target, mirroring how enemyTank.js applies
    // damage explicitly via onHitPlayer(...) from inside its own shoot
    // block rather than relying on the underlying bullet system's internal
    // hit routing (whose exact collision-filtering behavior isn't something
    // this AI class has visibility into). This keeps AI-plane damage
    // reliable and independent of MachineGunSystem's own hit-detection.
    let targetRbValid = !!targetRb;
    if (targetRbValid) {
      try {
        if (targetRb.isValid && targetRb.isValid() === false) targetRbValid = false;
      } catch (_) {
        targetRbValid = false;
      }
    }

    if (targetRbValid && onHitPlayer && this.bulletSystem.isReady) {
      const p = rb.translation();
      const tp = targetRb.translation ? targetRb.translation() : combatTarget.pos;
      const dx = tp.x - p.x, dy = tp.y - p.y, dz = tp.z - p.z;
      const distToTarget = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (distToTarget <= ATTACK_RANGE * 1.1) {
        const fwd = this._getForward();
        const toTarget = this._scratchToTgt.set(dx, dy, dz).normalize();
        const facing = fwd.dot(toTarget); // 1 = dead ahead, <cos(~18deg) = miss

        if (facing > GUN_FACING_COS) {
          const damage = 8; // per-tick damage while burst is active — tuned low since _fireGun runs every frame of the burst
          onHitPlayer(damage, combatTarget, this._distToPlayer, { x: p.x, y: p.y, z: p.z }, this);
        }
      }
    }

    // Visual/audio only — the bullet system's own internal raycast hit is
    // intentionally ignored here (see comment above); the tracer/muzzle-
    // flash visuals it produces are still wanted. MachineGunSystem.fire()
    // and MultiGunSystem.fire() have different signatures — branch on
    // gunType rather than assuming MachineGunSystem's shape.
    const _muzzleCb = () => {
      onMuzzleFlash?.(this._gunPoints[0]?.getWorldPosition(this._scratchWorldPos) ?? this._scratchWorldPos);
    };
    if (this._gunType === 3) {
      // MultiGunSystem.fire signature: (rigidBody, onFire, onRecoil, overrideDir, isMG, enemyResolver, aimWorldPos)
      this.bulletSystem.fire(rb, _muzzleCb, null, null, false, null, null);
    } else {
      // MachineGunSystem.fire signature: (rigidBody, enemyResolver, onFire, aimWorldPos)
      this.bulletSystem.fire(rb, null, _muzzleCb, null);
    }
    this._fireSeq++;   // ← ADD

    // ── Gate the audio cue to the gun's ACTUAL fire rate (bulletSystem.
    // reloadTime — set from planes.json's config.fireRate for gunType 3,
    // e.g. 0.02s for the SU-30). _fireGun() itself is only ever called
    // once per BURST_FIRE_INTERVAL (0.1s) tick by the burst loop, so a
    // fireRate faster than that (like 0.02) means this cooldown is always
    // already expired by the next call — the sound plays every burst tick,
    // audibly matching the configured weapon speed. A fireRate SLOWER than
    // 0.1s would correctly space the sound out further than the burst tick.
    const soundInterval = this.bulletSystem?.reloadTime ?? BURST_FIRE_INTERVAL;
    if (this._gunSoundCooldown <= 0) {
      this._gunSoundCooldown = soundInterval;
      if (audioSystem?._ready) {
        audioSystem.playEnemyShot?.(this._fireSound, this._distToPlayer);
      } else {
        audioSystem?._resume?.().then(() => audioSystem.playEnemyShot?.(this._fireSound, this._distToPlayer));
      }
    }
  }

  
  /**
   * Applies damage for a rocket hit — called from RocketSystem.onHit.
   * Confirms the collided rigid body actually belongs to the target this
   * plane was tracking at fire time (covers the guided-lock case, which is
   * the overwhelming majority of hits, since the whole point of a guided
   * rocket is that it steers onto that same target) before crediting
   * damage, so a rocket that instead clips terrain/scenery doesn't try to
   * damage anything.
   */
  _handleRocketHit(hitPos, rbHandle, damage) {
    // ── Explosion sound — plays for EVERY rocket impact, whether it
    // struck the tracked target or just detonated on terrain/scenery
    // after missing. Distance is measured from the impact point to the
    // player's last known position (cached each frame in update()), so
    // it fades out correctly the same way playExplosion() already does
    // for every other explosion source in the game.
    if (this._audioSystem && hitPos) {
      const lp = this._lastPlayerPos;
      const dist = Math.sqrt(
        (hitPos.x - lp.x) ** 2 +
        (hitPos.y - lp.y) ** 2 +
        (hitPos.z - lp.z) ** 2
      );
      this._audioSystem.playExplosion(dist);
    }

    const target = this._lastCombatTarget;
    const cb     = this._onHitPlayerCallback; // set by the pool in trySpawn(), same callback _fireGun uses
    if (!target || !target.rigidBody || !cb) return;

    let targetHandle = null;
    try { targetHandle = target.rigidBody.handle; } catch (_) { return; }
    if (targetHandle == null || targetHandle !== rbHandle) return;

    // attackerPos mirrors _fireGun's convention (shooter position, not
    // impact position) — best-effort re-read since the shooter may have
    // moved (or died) in the time it took the rocket to land.
    let attackerPos = hitPos;
    try {
      if (this.rigidBody) {
        const p = this.rigidBody.translation();
        attackerPos = { x: p.x, y: p.y, z: p.z };
      }
    } catch (_) { /* shooter already removed — fall back to hitPos */ }

    cb(damage, target, this._lastCombatDist, attackerPos, this);
  }

  
  /** Releases a burst of flares via the pool's shared FlareSystem. */
  _deployFlares() {
    if (!this.flareSystem || this._flareAmmo <= 0 || this._flareCooldown > 0 || !this.rigidBody) return;

    const count = Math.min(AI_FLARE_COUNT, this._flareAmmo);
    const fwd = this._getForward();
    const rot = this.rigidBody.rotation();
    const up = this._scratchUp.set(0, 1, 0).applyQuaternion(this._scratchQ.set(rot.x, rot.y, rot.z, rot.w));
    const vel = this.rigidBody.linvel();

    this.bodyGroup.getWorldPosition(this._scratchWorldPos);
    this._scratchWorldPos.addScaledVector(fwd, -1.5);
    this._scratchWorldPos.y -= 0.3;

    this.flareSystem.deploy(this._scratchWorldPos, fwd, up, vel, count);

    this._flareAmmo -= count;
    this._flareCooldown = AI_FLARE_COOLDOWN;
    // Intentionally no sound here — flare audio is reserved for the
    // player's own plane only (see Plane.deployFlares() / main.js's
    // deployPlaneFlare(), which calls audio.playFlare() directly).
  }

  /** Throttled scan of hostile rocket systems for a live lock on this
   * plane. O(threatRocketSystems.length) array reads, no allocation,
   * runs at most once every AI_FLARE_CHECK_INTERVAL seconds per plane. */
  _updateFlareCountermeasures(dt, threatRocketSystems) {
    if (this._flareCooldown > 0) this._flareCooldown -= dt;
    if (!this.rigidBody || !threatRocketSystems || threatRocketSystems.length === 0) return;

    this._flareCheckTimer -= dt;
    if (this._flareCheckTimer > 0) return;
    this._flareCheckTimer = AI_FLARE_CHECK_INTERVAL;

    if (this._flareAmmo <= 0 || this._flareCooldown > 0) return;

    let locked = false;
    for (let i = 0; i < threatRocketSystems.length; i++) {
      const sys = threatRocketSystems[i];
      if (sys && sys.hasActiveLockOn(this.rigidBody)) {
        locked = true;
        break;
      }
    }

    if (locked && Math.random() < AI_FLARE_REACT_CHANCE) {
      this._deployFlares();
    }
  }

  /**
   * Returns this plane's currently active flare decoys — polled by any
   * RocketSystem currently homing on this plane (see RocketSystem.update()'s
   * flare-decoy check: `target.getActiveFlareDecoys?.()`).
   *
   * flareSystem is a POOL-SHARED FlareSystem (one instance for every
   * EnemyPlane/FriendlyPlane in the pool — see EnemyPlanePool's
   * _sharedFlareSystem), so this technically returns every currently-
   * burning flare across the whole pool, not just this plane's own. That's
   * fine in practice: the rocket's own proximity check (FLARE_DECOY_RADIUS,
   * in rocket.js) is what actually limits which decoys are close enough to
   * this specific rocket to matter.
   *
   * Without this method, _deployFlares() still visually launches flares,
   * but no in-flight guided rocket ever sees them as decoys — the lock
   * never breaks, and the missile hits regardless of flares fired.
   */
  getActiveFlareDecoys() {
    return this.flareSystem?.getDecoyPositions() ?? null;
  }

  getForwardVector(target = new THREE.Vector3()) {
    if (!this.bodyGroup) return target.set(0, 0, -1);
    return target.set(-1, 0, 0).applyQuaternion(this.bodyGroup.quaternion);
  }

  // ── ADD THIS ──────────────────────────────────────────────────────────
  // Propeller world position — same purpose as Plane.js's own version:
  // gives the damage-smoke effect a sane spawn point (propeller/engine)
  // instead of the hull center. Falls back to bodyGroup's position if the
  // GLB clone hasn't finished loading yet.
  getPropellerWorldPosition(target = this._scratchWorldPos) {
    // Multi-prop planes: use the first propeller as the smoke/fire origin
    // reference point, same convention as plane.js's Plane class.
    if (this._propellerNodes.length > 0) {
      this._propellerNodes[0].getWorldPosition(target);
    } else if (this.bodyGroup) {
      this.bodyGroup.getWorldPosition(target);
    } else {
      target.set(0, 0, 0);
    }
    return target;
  }
  // ── END ADD ───────────────────────────────────────────────────────────

  destroyPermanently() {
    this.deactivate();
    this.scene.remove(this.bodyGroup);
  }
}

// ── EnemyPlanePool ────────────────────────────────────────────────────────────

export class EnemyPlanePool {
  /**
   * @param {THREE.Scene}    scene
   * @param {object}         world     – Rapier world (with .__RAPIER__ set)
   * @param {TerrainBuilder} terrain   – for getHeightAtWorld()
   * @param {object}         opts
   */
  constructor(scene, world, terrain, opts = {}) {
    this.scene   = scene;
    this.world   = world;
    this.terrain = terrain;

    this.maxPlanes      = opts.maxPlanes ?? MAX_PLANES;
    this.playerVehicle  = opts.playerVehicle ?? opts.playerTank ?? null;
    this.onMuzzleFlash  = opts.onMuzzleFlash ?? null;
    this.onHitPlayer    = opts.onHitPlayer   ?? null; // (damage, combatTarget, dist, attackerPos) => void
        this.onTreeCollision = opts.onTreeCollision ?? null; // (x, z, hitDirX, hitDirZ) => void — called while a plane in this pool is crashing
    // ── Roster mode — if opts.planeDefs (array of full planes.json entries)
    // is provided, each spawned plane independently picks (and locks for its
    // own lifetime) one random entry from this roster via _pickPlaneDefFor(),
    // instead of the whole pool sharing one fixed preset. Falls back to the
    // old single-preset fields below when no roster is given (back-compat).
    this.planeDefs = opts.planeDefs ?? null;

    this.modelPath        = opts.modelPath ?? '/model/Plane_Fighter.glb';
    this.fireSound        = opts.fireSound ?? 1;   // ← from planes.json's fireSound field, wired in main.js
    this.hullHalfExtents  = opts.hullHalfExtents ?? HULL_HALF_EXTENTS;   // ← from planes.json's config.hullHalfExtents
    this.colliderYOffset  = opts.colliderYOffset ?? COLLIDER_Y_OFFSET;  // ← from planes.json's config.colliderYOffset
    this.wingHalfExtents     = opts.wingHalfExtents     ?? WING_HALF_EXTENTS;     // ← from planes.json's config.wingHalfExtents
    this.wingColliderOffset  = opts.wingColliderOffset  ?? WING_COLLIDER_OFFSET;  // ← from planes.json's config.wingColliderOffset
    this.gunType          = opts.gunType ?? 1;                 // ← from planes.json's config.gunType
    this.gunDamage        = opts.gunDamage ?? 20;               // ← from planes.json's config.gunDamage
    this.multiGunFireRate = opts.multiGunFireRate ?? undefined; // ← from planes.json's config.fireRate
    this.modelScale       = opts.modelScale ?? DEFAULT_MODEL_SCALE;   // ← from planes.json's config.modelScale
    this.damageEffect     = { ...DEFAULT_DAMAGE_EFFECT, ...(opts.damageEffect ?? {}) }; // ← from planes.json's config.damageEffect

    // ← from planes.json's config.rocketDamage/rocketSpeed/rocketReload/rocketAmmo/guidedMissile
    this.rocketDamage     = opts.rocketDamage  ?? 60;
    this.rocketSpeed      = opts.rocketSpeed   ?? 90;
    this.rocketReload     = opts.rocketReload  ?? 1.2;
    this.rocketAmmo       = opts.rocketAmmo    ?? DEFAULT_ROCKET_AMMO;
    this.guidedMissile    = opts.guidedMissile ?? false;

    this.getTerrainY      = opts.getTerrainY ?? ((x, z) => terrain?.getHeightAtWorld?.(x, z) ?? 0);

    this._friendlyPoolRef = opts.friendlyPool ?? null; // planes' friendly targets (set via setFriendlyPool)
    this._friendlyTankPoolRef = opts.friendlyTankPool ?? null; // ground friendlies also count as targets

    this._remoteTargets = opts.remoteTargets ?? []; // remote players (multiplayer) — see setRemoteTargets()
// ── Team ID this pool's AI planes belong to (1 or 2). ─────────────────
    this.team = opts.team ?? 1;

    // ── Flat, team-tagged candidate list, rebuilt once per frame by
    // main.js and pushed via setAllCandidates(). Replaces the old
    // friendlyPool/friendlyTankPool/remoteTargets combining logic below.
    this._allCandidatesRef = opts.allCandidates ?? [];
    this._explosionSystem = opts.explosionSystem ?? null;
    this._audioSystem     = opts.audioSystem     ?? null;

    // In roster mode, don't eagerly resolve a single shared model — each
    // spawned plane resolves its own model promise (see trySpawn()) based
    // on whichever def it randomly picked. In legacy single-preset mode,
    // keep the old eager fetch exactly as before.
    this._modelPromise = this.planeDefs ? null : _getSharedModel(this.modelPath);

    this._pool = Array.from({ length: this.maxPlanes }, () => new EnemyPlane(scene, world));

    // ── One shared FlareSystem for the WHOLE pool, not one per plane —
    // FlareSystem allocates an InstancedMesh + several small ribbon
    // meshes up front (see flare.js), so giving every pooled plane its
    // own instance would multiply that fixed GPU/draw-call cost by
    // maxPlanes even though most planes never fire a flare. One shared
    // pool-level instance keeps that cost flat regardless of squad size.
    this._sharedFlareSystem = new FlareSystem(scene);
    for (const p of this._pool) p.flareSystem = this._sharedFlareSystem;

    this._threatRocketSystemsRef = [];

    this._spawnInterval = opts.spawnInterval ?? 25;
    this._spawnTimer     = opts.initialSpawnDelay ?? 5;

    this._activePlanesCache = [];
  }

  /** Called once per frame by main.js with the flat, team-tagged candidate
   * list — same contract as EnemyTankPool.setAllCandidates(). */
  setAllCandidates(list) {
    this._allCandidatesRef = list ?? [];
  }

  /** Called once per frame by main.js with every hostile RocketSystem
   * currently in play, so this pool's planes can react to an active
   * guided-missile lock with flares. */
  setThreatRocketSystems(list) {
    this._threatRocketSystemsRef = list ?? [];
  }

  /** Repoints which vehicle enemy planes target/aim at — call whenever the
   * player switches between tank and plane, same contract as
   * EnemyTankPool.setActivePlayerVehicle(). */
  setActivePlayerVehicle(vehicle) {
    this.playerVehicle = vehicle ?? null;
  }

  /**
   * Live-adjusts this pool's plane cap. Mirrors EnemyTankPool.setMaxTanks()
   * — the pool only pre-allocates `maxPlanes` EnemyPlane instances at
   * construction, so just changing `this.maxPlanes` without growing
   * `_pool` would let the cap say "room for more" while trySpawn() still
   * finds no inactive instance to use. Shrinking never force-kills
   * already-active planes; it just lowers the ceiling trySpawn()/
   * _isFriendlyPoolFull() checks against.
   *
   * Without this method, every planePool.setMaxPlanes?.(...) call site in
   * main.js (the squad "flex slot" logic in _selectVehicleType() and
   * _applyRemoteFlexForTeam()) silently no-ops via optional chaining,
   * leaving maxPlanes permanently stuck at its construction-time baseline.
   */
  setMaxPlanes(n) {
    const newMax = Math.max(0, Math.floor(n));
    if (newMax > this._pool.length) {
      const toAdd = newMax - this._pool.length;
      for (let i = 0; i < toAdd; i++) {
        const p = new EnemyPlane(this.scene, this.world);
        p.flareSystem = this._sharedFlareSystem;
        this._pool.push(p);
      }
    }
    this.maxPlanes = newMax;

    // ── Same active-cull fix as EnemyTankPool.setMaxTanks() ...
    const active = this.getActiveTanks();
    let excess = active.length - newMax;
    for (let i = active.length - 1; i >= 0 && excess > 0; i--) {
      const p = active[i];
      if (p.isDead) continue;
      p.deactivate();
      excess--;
    }

    // ── Same immediate-fill fix as EnemyTankPool.setMaxTanks() — spawn
    // the newly-opened slot right away instead of waiting on the next
    // _spawnTimer tick.
    if (this._activeCount() < this.maxPlanes) {
      this.trySpawn();
    }
  }

  _getInactivePlane() {
    return this._pool.find(p => !p.active) ?? null;
  }

  _activeCount() {
    let n = 0;
    for (const p of this._pool) if (p.active) n++;
    return n;
  }

  _findSpawnPos(playerPos) {
    const terrain  = this.terrain;
    const halfSize = terrain.worldSize / 2 - SPAWN_MARGIN;

    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = MIN_SPAWN_DIST + Math.random() * (MAX_SPAWN_DIST - MIN_SPAWN_DIST);
      const x = playerPos.x + Math.cos(angle) * dist;
      const z = playerPos.z + Math.sin(angle) * dist;
      if (Math.abs(x) > halfSize || Math.abs(z) > halfSize) continue;

      const groundY = terrain.getHeightAtWorld(x, z);
      const y = groundY + SPAWN_ALTITUDE_MIN + Math.random() * (SPAWN_ALTITUDE_MAX - SPAWN_ALTITUDE_MIN);
      return { x, y, z };
    }
    return null;
  }

  trySpawn() {
    if (this._activeCount() >= this.maxPlanes) return false;

    const plane = this._getInactivePlane();
    if (!plane) return false;

    if (!plane._lockedModelPath) {
      // ── Roster mode — pick ONE random def for THIS plane's entire
      // lifetime (this pool slot keeps reusing the same def on every
      // respawn, exactly like the old single-preset behavior did, just
      // randomized per-slot instead of fixed for the whole pool). Legacy
      // mode (no planeDefs given) falls back to the pool's single fixed
      // preset fields, unchanged from before.
      const def = this.planeDefs
        ? this.planeDefs[Math.floor(Math.random() * this.planeDefs.length)]
        : null;
      const pc = def?.config ?? {};

      const lockedModelPath = def
        ? (def.modelPath ?? this.modelPath)
        : this.modelPath;

      plane._lockedModelPath    = lockedModelPath;
      plane._lockedModelPromise = def
        ? _getSharedModel(lockedModelPath)
        : this._modelPromise;
      plane._lockedGunType          = def ? (pc.gunType ?? 1) : this.gunType;
      plane._lockedGunDamage        = def ? (pc.gunDamage ?? pc.mgDamage ?? 20) : this.gunDamage;
      plane._lockedMultiGunFireRate = def ? (pc.fireRate ?? undefined) : this.multiGunFireRate;
      plane._lockedModelScale       = def ? (pc.modelScale ?? DEFAULT_MODEL_SCALE) : this.modelScale;
      plane._lockedDamageEffect     = def
        ? { ...DEFAULT_DAMAGE_EFFECT, ...(pc.damageEffect ?? {}) }
        : this.damageEffect;

      plane._lockedRocketDamage  = def ? (pc.rocketDamage  ?? 60)  : this.rocketDamage;
      plane._lockedRocketSpeed   = def ? (pc.rocketSpeed   ?? 90)  : this.rocketSpeed;
      plane._lockedRocketReload  = def ? (pc.rocketReload  ?? 1.2) : this.rocketReload;
      plane._lockedRocketAmmo    = def ? (pc.rocketAmmo    ?? DEFAULT_ROCKET_AMMO) : this.rocketAmmo;
      plane._lockedGuidedMissile = def ? (pc.guidedMissile ?? false) : this.guidedMissile;

      // ── Also lock this def's own hull/wing/collider geometry — without
      // this, every plane in roster mode kept using the POOL's single
      // hullHalfExtents/wingHalfExtents (e.g. the Spitfire's), even though
      // its visual model might be the much larger Ju 88, causing the
      // hitbox to badly mismatch the mesh.
      plane._lockedHullHalfExtents    = def ? (pc.hullHalfExtents ?? HULL_HALF_EXTENTS) : this.hullHalfExtents;
      plane._lockedColliderYOffset    = def ? (pc.colliderYOffset ?? COLLIDER_Y_OFFSET) : this.colliderYOffset;
      plane._lockedWingHalfExtents    = def ? (pc.wingHalfExtents ?? WING_HALF_EXTENTS) : this.wingHalfExtents;
      plane._lockedWingColliderOffset = def ? (pc.wingColliderOffset ?? WING_COLLIDER_OFFSET) : this.wingColliderOffset;
      plane._lockedFireSound          = def ? (def.fireSound ?? pc.fireSound ?? 1) : this.fireSound;
    }

    const playerPos = this.playerVehicle?.rigidBody?.translation()
      ?? this.playerVehicle?.bodyGroup?.position
      ?? { x: 0, y: 0, z: 0 };

    const pos = this._findSpawnPos(playerPos);
    if (!pos) return false;

    plane._onHitPlayerCallback = this.onHitPlayer; // read inside activate() to wire onAiGunHitPlayer
    plane._playerVehicleRef = this.playerVehicle; // ← so guided-rocket lock objects can reach the player's flareSystem
    plane.activate(
      pos,
      plane._lockedModelPromise,
      this._explosionSystem,
      plane._lockedModelPath,
      plane._lockedHullHalfExtents ?? this.hullHalfExtents,
      plane._lockedColliderYOffset ?? this.colliderYOffset,
      this.getTerrainY,
      this.team,
      plane._lockedWingHalfExtents ?? this.wingHalfExtents,
      plane._lockedWingColliderOffset ?? this.wingColliderOffset,
    );
    plane._audioSystem = this._audioSystem;
    plane._fireSound   = plane._lockedFireSound ?? this.fireSound;
    plane.onAiGunFire = () => {}; // no-op default; main.js/pool consumer can override per-unit if desired

    return true;
  }

  update(dt, playerPos) {
    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = this._spawnInterval;
      this.trySpawn();
    }

    // ── Tick the shared FlareSystem ONCE per pool per frame, not once
    // per plane — it owns its own fixed-size instanced buffers already,
    // update() just animates whatever flares are currently active
    // (usually zero), so this stays cheap regardless of pool size.
    this._sharedFlareSystem.update(dt);

    const activePlanes = this.getActiveTanks();
    const allCandidates = this._allCandidatesRef ?? [];
    const threatRocketSystems = this._threatRocketSystemsRef ?? [];

    for (const plane of activePlanes) {
      plane._playerVehicleRef = this.playerVehicle;
      const playerRigidBody = this.playerVehicle?.rigidBody ?? null;

      plane.update(
        dt, playerPos,
        this.onMuzzleFlash,
        this.onHitPlayer,
        this._audioSystem,
        playerRigidBody,
        allCandidates,
        this.getTerrainY,
        this.onTreeCollision,
        threatRocketSystems
      );

      // Auto-deactivate if a plane wanders absurdly far off-map
      if (plane.rigidBody) {
        const p = plane._cachedPos ?? plane.rigidBody.translation();
        const halfSize = this.terrain.worldSize / 2 + 300;
        if (Math.abs(p.x) > halfSize || Math.abs(p.z) > halfSize || p.y < -50 || p.y > 800) {
          plane.deactivate();
        }
      }
    }

    // ── Separation force between active planes (own pool only — cheap,
    // avoids two planes in the same pool visually overlapping mid-orbit) ──
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
          a.rigidBody.setLinvel({ x: a.rigidBody.linvel().x + fx, y: a.rigidBody.linvel().y + fy, z: a.rigidBody.linvel().z + fz }, true);
          b.rigidBody.setLinvel({ x: b.rigidBody.linvel().x - fx, y: b.rigidBody.linvel().y - fy, z: b.rigidBody.linvel().z - fz }, true);
        }
      }
    }
  }

  /** Returns array of active EnemyPlane instances — same accessor name as
   * EnemyTankPool.getActiveTanks() so main.js can treat both pools uniformly. */
  getActiveTanks() {
    this._activePlanesCache.length = 0;
    for (const p of this._pool) {
      if (p.active) this._activePlanesCache.push(p);
    }
    return this._activePlanesCache;
  }

  killPlane(plane) {
    plane.deactivate();
  }

  dispose() {
    this._pool.forEach(p => p.destroyPermanently());
    this._pool.length = 0;
    this._sharedFlareSystem.dispose();
  }
}