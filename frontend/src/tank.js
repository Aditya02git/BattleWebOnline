// tank.js — Tank with Rapier rigid body + visual mesh + track system

import * as THREE from 'three';
import { Track, PIECE_T } from './track.js';
import { loadModel } from './modelLoader.js';
import { TurretController } from './turret.js';
import { BulletSystem, MachineGunSystem, ProjectileBulletSystem, MultiGunSystem, SpecialGunSystem } from './bullet.js';
import { ExplosionSystem } from './explosion.js';
import { TankSmoke }       from './tankSmoke.js';
import { TankDust } from './tankDust.js';
// import { TankLights } from './lights.js';
import { SmokeGrenadeSystem } from './smokeGrenade.js';
import { RocketSystem } from './rocket.js';

// ── Config ────────────────────────────────────────────────────────────────────

const ENABLE_IN_OUT_WHEELS = false;   // ← toggle for interleaved double road wheels
const ENABLE_BOGGIE_WHEELS = false;
const ENABLE_STEAMPUNK_WHEEL = true;

const SPROCKET_WHEEL_TYPE  = 1;      // 1 | 2 | 3 | 4 | 5
const IDLER_WHEEL_TYPE    = 5;       // 1 | 2 | 3 | 4 | 5
const ROAD_WHEEL_TYPE = 1;           // 1 = existing makeRoadWheelMesh  |  2 = dual wheel assembly

// Road wheel X positions in body-local space (front → rear)
const ROAD_WHEEL_X = [-1.35, -0.80, -0.25, 0.30, 0.85, 1.35];
const ROAD_WHEEL_Y = -0.22;

const SPROCKET_X = 1.85;
const SPROCKET_Y = -0.08; //default 0.12
const IDLER_X    = -1.85;
const IDLER_Y    = 0.12;

const RETURN_ROLLERS = [
  // { x: -0.8, y: 0.25 },
  // { x:  0.0, y: 0.25 },
  // { x:  0.8, y: 0.25 },
];

const TANK_HALF_EXTENTS = { x: 1.8, y: 0.28, z: 0.73 };

const LEFT_TRACK_COLLIDER_Z = -1; // This value should be same as the visuals in the track.js
const RIGHT_TRACK_COLLIDER_Z = 1; // This value should be same as the visuals in the track.js

const ENABLE_AXEL_WHEELS = true;   // ← toggle front axle steering visuals
const AXEL_MAX_ANGLE = Math.PI / 6;  // 30° max steer
const AXEL_STEER_SPEED = 2.5;        // rad/sec

// ─────────────────────────────────────────────────────────────────────────────

export class Tank {
  constructor(scene, world, position = { x: 0, y: 1.5, z: 0 }, config = {}) {

        // ── Resolve config (falls back to your original defaults) ─────────────
    this.cfg = {
      enableInOutWheels:       config.enableInOutWheels  ?? true,
      enableBogieWheels:       config.enableBogieWheels  ?? false,
      enableSteampunkWheel:    config.enableSteampunkWheel    ?? false,
      bogieWheelSystemSize:    config.bogieWheelSystemSize ?? 1,
      bogieArmAngleRange:      config.bogieArmAngleRange ?? 45,
      bogieArmLength:          config.bogieArmLength    ?? 0.28,
      sprocketWheelType:       config.sprocketWheelType  ?? 1,
      idlerWheelType:          config.idlerWheelType     ?? 5,
      roadWheelType:           config.roadWheelType      ?? 1,
      wheelColor:              config.wheelColor         ?? 0xfcd6a9,
      country:                 config.country             ?? null,   // ISO 3166-1 alpha-2 code, e.g. 'DE', 'US', 'JP' — null = no flag texture applied
      scopeType:               config.scopeType           ?? 1,      // 1-5 — selects scope_<N>.png overlay texture
      roadWheelX:              config.roadWheelX         ?? [-1.35, -0.80, -0.25, 0.30, 0.85, 1.35],
      roadWheelY:              config.roadWheelY         ?? -0.22,
      sprocketX:               config.sprocketX          ?? 1.85,
      sprocketY:               config.sprocketY          ?? -0.08,
      idlerX:                  config.idlerX             ?? -1.85,
      idlerY:                  config.idlerY             ?? 0.12,
      hullHalfExtents:         config.hullHalfExtents    ?? { x: 1.8, y: 0.28, z: 0.73 },
      returnRollers:           config.returnRollers     ?? [],
      // Model
      modelObjectURL:          config.modelObjectURL  ?? null,
      modelPath:               config.modelPath       ?? '/model/Tank_Tiger.glb',
      modelScale:              config.modelScale      ?? 2.3,
      modelOffsetX:            config.modelOffsetX    ?? 0.45,
      modelOffsetY:            config.modelOffsetY    ?? 0.45,
      modelOffsetZ:            config.modelOffsetZ    ?? 0.45,
      modelRotX:               config.modelRotX       ?? 0,
      modelRotY:               config.modelRotY       ?? -90,
      modelRotZ:               config.modelRotZ       ?? 0,
      sprocketRadius:          config.sprocketRadius ?? 0.20,
      sprocketWidth:           config.sprocketWidth,
      idlerRadius:             config.idlerRadius ?? 0.14,
      idlerWidth:              config.idlerWidth,
      steampunkPistonReach:    config.steampunkPistonReach    ?? 0.5,
      outerZ:                  config.outerZ ?? 1.0,
      rootTrackWidth:          config.rootTrackWidth ?? 1.0,
      topRunSag:               config.topRunSag    ?? 0.10,   // ← add
      bottomRunSag:            config.bottomRunSag ?? 0.1,    // ← add
      roadWheelRadius:         config.roadWheelRadius       ?? 0.31,
      idlerTransitionSag:      config.idlerTransitionSag    ?? 0.33,
      sprocketTransitionSag:   config.sprocketTransitionSag ?? 0.10,
      hideLastRw:              config.hideLastRw ?? true,
      beltType:                config.beltType ?? 1,
      bogieSystemType:         config.bogieSystemType ?? 1,
      disableEndWheelLinks:    config.disableEndWheelLinks ?? { front: false, back: false },
      enableAxelWheels:        config.enableAxelWheels ?? false, 
      axelWheelRadius:         config.axelWheelRadius   ?? 0.3,
      // When true, rear wheels steer along with the front axle instead of
      // only spinning — for tanks that want 4-wheel steering feel.
      enableRearAxelWheels:    config.enableRearAxelWheels ?? false,

      // ── Suspension travel clamps — how far each wheel type can move up
      // (compression) / down (droop) from rest before the spring hard-stops.
      // Exposed per-tank since heavier/taller tanks may need more droop to
      // track uneven terrain without the mesh clipping through it.
      roadWheelMaxDownTravel:  config.roadWheelMaxDownTravel ?? 0.12,
      axelMaxDownTravel:       config.axelMaxDownTravel      ?? 0.2,
      axelMaxUpTravel:         config.axelMaxUpTravel        ?? 0.1,
      rearWheelMaxDownTravel:  config.rearWheelMaxDownTravel ?? 0.2,
      rearWheelMaxUpTravel:    config.rearWheelMaxUpTravel   ?? 0.1,

      trackPieceCount:         config.trackPieceCount ?? 70,
      enableTorsionBars:       config.enableTorsionBars     ?? false,
      torsionArmAngle:         config.torsionArmAngle        ?? (-Math.PI * 0.18 + Math.PI),
      doubleSideTorsionArm:    config.doubleSideTorsionArm   ?? false,
      spArcFactor:             config.spArcFactor    ?? 1.8,
      idlerArcFactor:          config.idlerArcFactor ?? 1.2,
      gunType:                 config.gunType ?? 2,  
      shellSpeed:              config.shellSpeed ?? 80,
      reloadTime:              config.reloadTime ?? 3,
      fireRate:                config.fireRate   ?? 0.2,   
      bulletCapacity:          config.bulletCapacity ?? 50,
      damage:                  config.damage ?? 100,

      // ── Recoil "feel" — per-tank kick strength applied every time the main
      // gun fires (see triggerRecoil()). hullRecoilVelocity feeds the recoil
      // spring that pushes the whole hull backward as a physics impulse;
      // firePitchVelocity feeds the spring that dips the hull's visual pitch
      // forward on fire. turretRecoilVelocity feeds TurretController's own
      // recoil spring, which slides the barrel mesh back along its local Z
      // (see TurretController.triggerRecoil()). All three springs settle
      // back to rest using STIFFNESS/DAMPING constants hardcoded in their
      // respective update() loops — only the initial kick magnitude is
      // configurable here.
      hullRecoilVelocity:      config.hullRecoilVelocity   ?? 2.5,
      firePitchVelocity:       config.firePitchVelocity    ?? 3.5,
      turretRecoilVelocity:    config.turretRecoilVelocity ?? -0.6,

      // ── gunType 3 (MultiGunSystem) overrides — must be whitelisted here
      // or they never make it out of the raw `config` object into `this.cfg`,
      // which is why multiGunFireRate (and friends) were silently ignored.
      multiGunDamage:          config.multiGunDamage      ?? undefined,
      multiGunRange:           config.multiGunRange       ?? undefined,
      multiGunFireRate:        config.multiGunFireRate    ?? undefined,
      multiGunMaxRounds:       config.multiGunMaxRounds   ?? undefined,
      multiGunReloadTime:      config.multiGunReloadTime  ?? undefined,
      
      turretMinAngle:          config.turretMinAngle ?? -Math.PI,
      turretMaxAngle:          config.turretMaxAngle ??  Math.PI,
      barrelMinAngle:          config.barrelMinAngle ?? -0.25,
      barrelMaxAngle:          config.barrelMaxAngle ??  0.25,
      mgFireStraight:          config.mgFireStraight ?? false,
      gearCount:               config.gearCount ?? 3,
      mgYawMin:                config.mgYawMin   ?? -Math.PI / 4,
      mgYawMax:                config.mgYawMax   ??  Math.PI / 4,
      mgPitchMin:              config.mgPitchMin ?? -0.30,
      mgPitchMax:              config.mgPitchMax ??  0.40,
      mgDamage:                config.mgDamage   ?? 8,
      mgRange:                 config.mgRange    ?? 80,
      mgReloadTime:            config.mgReloadTime ?? undefined, // ← undefined = keep MachineGunSystem's own built-in default

      // ── Weapon slot 5 variant — 'rocket' (default, uses RocketSystem),
      // 'gun' (uses SpecialGunSystem: single high-damage shot, long
      // cooldown), or 'gun/rockets' (same as 'gun' — a combined-label
      // value some tank defs use). Resolved BEFORE enableRockets below,
      // since enableRockets is now implicitly derived from this field.
      specialWeaponType:       config.specialWeaponType ?? 'rocket',
      specialGunDamage:        config.specialGunDamage   ?? 400,
      specialGunSpeed:         config.specialGunSpeed    ?? 120,
      specialGunCooldown:      config.specialGunCooldown ?? 60,

      // ── Rockets — off by default. When true, the tank's GLB must have
      // RocketPoint_1, RocketPoint_2, ... empties (any count), and an
      // extra weapon slot (slot 5) appears in the HUD.
      //
      // tanks.json is moving away from an explicit boolean here — any
      // tank def that sets `specialWeaponType` at all (e.g. "gun",
      // "rocket", "gun/rockets") is implicitly slot-5-enabled, without
      // needing a separate `enableRockets: true` line. An explicit
      // `config.enableRockets` (old-style tank defs) still wins if present.
      enableRockets:
        config.enableRockets ?? !!config.specialWeaponType,

      // ── How long (seconds) the destroyed hull keeps its rigid body and
      // suspension/track simulation running after death before the wreck
      // is fully frozen and the physics body is removed. Lets the tank
      // settle, tip, or keep reacting to terrain instead of instantly
      // locking in place the moment it dies.
      deathFreezeDuration:     config.deathFreezeDuration ?? 2.0,
      rocketDamage:            config.rocketDamage   ?? 60,
      rocketSpeed:             config.rocketSpeed    ?? 90,
      rocketReload:            config.rocketReload   ?? 1.2,
      specialAmmo:             config.specialAmmo    ?? 4,
      guidedRockets:           config.guidedRockets  ?? false,
    };

    // this.tankLights = null;

        // Auto-derive roadWheelY so wheel bottom stays at correct height
    // regardless of roadWheelRadius — keeps suspension raycasts working
    const WHEEL_BOTTOM_OFFSET = -0.44;
    this.cfg.roadWheelY = WHEEL_BOTTOM_OFFSET + this.cfg.roadWheelRadius;

    // ── Dust trail color — comes from the MAP config (mapDef.dustColor via
    // main.js), completely separate from tanks.json's per-tank cfg. Kept
    // off `this.cfg` on purpose so it never mixes with tank-definition data.
    this._dustColor = config.dustColor ?? 0x8B6914;

    // Drive params
    this.maxSpeed   = config.maxSpeed   ?? 4.0;
    this.accel      = config.accel      ?? 0.54;
    this.turnTorque = config.turnTorque ?? 0.15;

    // ← Multiplier applied ONLY to forward top speed (gear tables), leaves
    // reverse speed and everything else derived from maxSpeed untouched.
    this.forwardSpeedMultiplier = config.forwardSpeedMultiplier ?? 1.0;

    this._smoothedLeftThrottle  = 0;
    this._smoothedRightThrottle = 0;

    // ── Gear system — now AUTOMATIC. W/S are throttle pedals (forward /
    // reverse intent), not gear-shift buttons. applyInput() picks the
    // actual gear each frame from current road speed, using the same
    // per-gear top-speed table below (same idea as an RPM-based auto
    // shift, without needing a separate RPM model). ────────────────────
    this.gear         = 0;   // negative=reverse, 0=N, 1..topGear=forward — auto-selected now, kept for HUD/track-belt/other read sites
    this.throttle     = 0;   // smoothed pedal value: -1 (full reverse) .. 0 .. +1 (full forward)
    this.reverseGears = config.reverseGears ?? 1;

    const ms = this.maxSpeed;

    // Use per-tank gear tables from config if provided, otherwise derive from maxSpeed
    this.topGear     = config.gearCount   ?? 3;

    // ── Auto-generated gear tables ──────────────────────────────────────────
    // Previously every tank needed a hand-written gearMaxSpeeds/gearAccels
    // table sized to exactly match gearCount/reverseGears — error prone if
    // they drift out of sync. Now: just set gearCount + reverseGears and a
    // full table is generated automatically from maxSpeed. Explicit
    // gearMaxSpeeds/gearAccels in config still win when present, for tanks
    // that want fully custom, hand-tuned gear feel.
    this.gearMaxSpeed = config.gearMaxSpeeds
      ?? this._generateGearMaxSpeeds(ms, this.topGear, this.reverseGears, this.forwardSpeedMultiplier);

    this.gearAccel = config.gearAccels
      ?? this._generateGearAccels(this.topGear, this.reverseGears, this.forwardSpeedMultiplier);

    this.scene = scene;
    this.world = world;
    this.renderer = config.renderer ?? null;   // ← add — needed for FOV-aware particle sizing
    this._suspRay = null;
    this.speed     = 0;
    this.turnSpeed = 0;

    this._buildPhysics(world, position);

    // ── Render interpolation state — decouples the visual transform from the
    // fixed-timestep physics so movement stays smooth even when render FPS
    // (e.g. 85-90) doesn't line up with the 60Hz physics step ─────────────────
    this._prevPos    = new THREE.Vector3(position.x, position.y, position.z);
    this._prevQuat   = new THREE.Quaternion();
    this._renderPos  = new THREE.Vector3(position.x, position.y, position.z);
    this._renderQuat = new THREE.Quaternion();

    this._buildVisuals(scene);
    this._buildTracks(scene);

    // Suspension offsets — one entry per wheel position (12 if interleaved, 6 if not)
const bogieActive  = this.cfg.enableBogieWheels;
const wheelsPerArm = (this.cfg.bogieSystemType === 2 || this.cfg.bogieSystemType === 3) ? 4 : 2;
const armCount     = this.cfg.roadWheelX.length;
const wheelCount   = bogieActive
  ? armCount * wheelsPerArm
  : this._getWheelPositions().length;
this.suspensionOffsetsLeft  = new Array(wheelCount).fill(0);
this.suspensionOffsetsRight = new Array(wheelCount).fill(0);
this.suspensionVelLeft  = new Array(wheelCount).fill(0);
this.suspensionVelRight = new Array(wheelCount).fill(0);

    // Hull visual suspension state
    this.hullSuspensionY = 0;
    this.hullPitch       = 0;
    this.hullRoll        = 0;

    // this.bulletSystem    = new BulletSystem(scene, world);
    this.mgSystem        = null;   // created after GLB loads
    this.activeWeapon    = 1;      // 1 = main gun, 2 = MG
    this.hasMachineGun   = false;  // ← set true in _loadHullModel() once we know the GLB has an MG_Point; HUD uses this to show/hide the MG weapon slot

    this.hullRecoilVelocity = 0;

    this.hullRecoilVelocity = 0;
    this.hullRecoilAmount   = 0;

    // Firing pitch effect
    this._firePitchAmount   = 0;
    this._firePitchVelocity = 0;

    // ── Weapon-fire recoil camera shake — separate from the damage-hit
    // shake below (_shakeIntensity/_shakeDuration/etc., set via
    // _triggerCameraShake), so firing reads as a distinct kick that stacks
    // on top of (not instead of) any concurrent hit-shake. Mirrors
    // Plane's _fireShakeOffset/_hitShakeOffset split.
    this._hitShakeOffset     = new THREE.Vector3();
    this._fireShakeOffset    = new THREE.Vector3();
    this._fireShakeIntensity = 0;
    this._fireShakeDuration  = 0;
    this._fireShakeElapsed   = 0;
    this._fireShakeFrequency = 0;

    this.explosionSystem = new ExplosionSystem(scene);

    this.bulletSystem    = this.cfg.gunType === 2
  ? new ProjectileBulletSystem(scene, world, this.explosionSystem)
  : this.cfg.gunType === 3
  ? new MultiGunSystem(scene, world, this.explosionSystem)
  : new BulletSystem(scene, world, this.explosionSystem);
    // ── gunType 3 — multi-barrel main gun (GunPoint_1, GunPoint_2, ...) ──
    if (this.cfg.gunType === 3) {
      if (this.cfg.multiGunDamage)     this.bulletSystem.setDamage(this.cfg.multiGunDamage);
      if (this.cfg.multiGunRange)      this.bulletSystem.setRange(this.cfg.multiGunRange);
      if (this.cfg.multiGunFireRate)   this.bulletSystem.setFireRate(this.cfg.multiGunFireRate);
      if (this.cfg.multiGunMaxRounds)  this.bulletSystem.setMaxRounds(this.cfg.multiGunMaxRounds);
      if (this.cfg.multiGunReloadTime) this.bulletSystem.setFullReloadTime(this.cfg.multiGunReloadTime);
    }
    this.mgSystem        = new MachineGunSystem(scene, world, this.explosionSystem);
    this.mgSystem.setDamage(this.cfg.mgDamage);
    this.mgSystem.setRange(this.cfg.mgRange);
    if (this.cfg.mgReloadTime) this.mgSystem.fullReloadTime = this.cfg.mgReloadTime;   // ← research skill override

    // ── Rocket pods — only built when enableRockets is true ────────────────
    this._rocketPoints = [];   // RocketPoint_1, RocketPoint_2, ... populated on GLB load
    // specialWeaponType can be "gun", "rocket"/"rockets", or the combined
    // "gun/rockets" — anything containing "gun" gets the single-shot,
    // high-damage SpecialGunSystem; everything else gets the standard
    // multi-rocket RocketSystem.
    this.rocketSystem = this.cfg.enableRockets
      ? (this.cfg.specialWeaponType?.includes('gun')
          ? new SpecialGunSystem(scene, world, this.explosionSystem, {
              damage:   this.cfg.specialGunDamage,
              speed:    this.cfg.specialGunSpeed,
              cooldown: this.cfg.specialGunCooldown,
            })
          : new RocketSystem(scene, world, this.explosionSystem, {
          damage: this.cfg.rocketDamage,
          speed:  this.cfg.rocketSpeed,
          // `reload` is legacy/back-compat (see rocket.js). `cooldown` is
          // the field RocketSystem actually gates fire() on now — falls
          // back to specialGunCooldown so tanks.json entries that already
          // set that key (shared with the "gun" variant) work unchanged.
          cooldown: this.cfg.rocketCooldown ?? this.cfg.specialGunCooldown ?? this.cfg.rocketReload,
          guided:   this.cfg.guidedRockets,
        }))
      : null;
    // ── Accepts either the new `specialAmmo` loadout key or the legacy
    // `rocketAmmo` key (in case an upstream loadout-builder — e.g.
    // index.html's tank-select code — hasn't been updated to the new
    // field name yet), before ever falling back to cfg's own default.
    this.specialAmmo =
      config.loadout?.specialAmmo ??
      config.loadout?.rocketAmmo ??
      config.specialAmmo ??      // ← in case it was flattened onto top-level config instead of config.loadout
      config.rocketAmmo ??
      this.cfg.specialAmmo;

    if (this.cfg.enableRockets) {
      console.log(
        '[Tank] specialAmmo resolved to', this.specialAmmo,
        '— loadout:', config.loadout,
        'top-level specialAmmo/rocketAmmo:', config.specialAmmo, config.rocketAmmo
      );
    }
    this._initialSpecialAmmo = this.specialAmmo;   // ← cached for respawn() reset

    this.smokeSystem      = null;   // created after GLB loads — needs gunPoint forward
    this._smokeGrenadeSystem = new SmokeGrenadeSystem(scene, this.explosionSystem);    
    // this.machineGunSystem = null;

    this.smokeSystem     = null;   // created in _loadHullModel once GLB is ready
    this._smokeNodes     = [];     // Smoke_1 / Smoke_2 Object3Ds from the GLB

    // this._mgGunPoints = [];
    this._multiGunPoints = [];   // GunPoint_1, GunPoint_2, ... for gunType 3

    this.dustSystem = null;
    this._dustNodes = [];

    // ── Axle steering ─────────────────────────────────────────────────────────
    this._axelNodes = [];       // Front_Axel_L / Front_Axel_R from GLB
    this._axelAngle = 0;        // current steering angle (radians)
    this._rearAxelAngle = 0;    // current REAR steering angle (radians) — only used when enableRearAxelWheels is true

    // ── Axle suspension ───────────────────────────────────────────────────────
    this._axelBasePos    = [];  // {x,y,z} local (body-frame) position per axle node
    this._axelOrigLocalY = [];  // original authored local Y per axle node
    this._axelSuspOffset = [];  // current spring offset per axle node
    this._axelSuspVel    = [];  // current spring velocity per axle node
    this._axelRayOrigin  = null;

    this._axelWheelColliders = [];  // Rapier ball colliders (one per axle node), for real terrain collision

    // ── Debug: visualize axle & rear-wheel suspension raycasts ──────────────
    // Set config.debugRaycasts = true on a tank def to spawn small sphere
    // markers: yellow/orange = ray origin, green/cyan = ground hit point.
    // Lets you visually confirm each ray sits directly under its own wheel.
    this._debugRaycasts               = config.debugRaycasts ?? false;
    this._axelDebugOriginMarkers      = [];
    this._axelDebugHitMarkers         = [];
    this._rearWheelDebugOriginMarkers = [];
    this._rearWheelDebugHitMarkers    = [];
    
    // ── Rear wheels (trackless/wheeled tanks) ────────────────────────────────
    // RearWheel_L_1, RearWheel_R_1, RearWheel_L_2, RearWheel_R_2, ... — used
    // when a tank has no tracks at all (roadWheelX: [], sprocketRadius: 0,
    // idlerRadius: 0, trackPieceCount: 0). Spin with forward speed like the
    // front axle wheels, but never steer.
    this._rearWheelNodes      = [];
    this._rearWheelBasePos    = [];
    this._rearWheelOrigLocalY = [];
    this._rearWheelSuspOffset = [];
    this._rearWheelSuspVel    = [];
    this._rearWheelRayOrigin  = null;
    this._rearWheelColliders  = [];
    this._rearWheelSpinAngle  = 0;

    // ── Health ────────────────────────────────────────────────────────────────
    this.maxHealth = config.maxHealth ?? 100;
    this.health    = this.maxHealth;
    this.armour    = config.armour    ?? 75;
    this.isDead      = false;
    this._dissolveTimer   = 0;
    this._dissolveActive  = false;
    this._ejectedTurret   = null;   // detached THREE.Group after death
    this._deathFreezeTimer = 0;     // seconds remaining before the wreck's physics/suspension is fully frozen

    // Scratch objects — reused every frame to avoid GC pressure
    this._scratchQ        = new THREE.Quaternion();
    this._scratchQ2       = new THREE.Quaternion();
    this._scratchEuler    = new THREE.Euler();
    this._scratchFwd      = new THREE.Vector3();
    this._scratchVel      = new THREE.Vector3();
    this._scratchForce    = new THREE.Vector3();
    this._scratchPos      = new THREE.Vector3();
    this._scratchSuspPos  = new THREE.Vector3();
    this._scratchLocalPos = new THREE.Vector3();
    this._scratchWorldPos = new THREE.Vector3();
    this._suspRayOrigin = null;

    // MG scratch objects — reused every frame
    this._mgScratchDir      = new THREE.Vector3();
    this._mgScratchFwd      = new THREE.Vector3();
    this._mgScratchRight    = new THREE.Vector3();
    this._mgScratchUp       = new THREE.Vector3(0, 1, 0);
    this._mgScratchClamped  = new THREE.Vector3();
    this._mgScratchWorldQ   = new THREE.Quaternion();
    this._mgScratchParentQ  = new THREE.Quaternion();
    this._mgScratchLocalFwd = new THREE.Vector3(0, 0, 1);

    this._hullColliderMesh = null;
    this._crewColliderMesh = null;

    // ── Rocket rack (Calliope) — mirrors barrel pitch each frame ────────
    this._calliopeNode   = null;
    this._calliopeBaseQ  = null;
    this._calliopeDeltaQ = new THREE.Quaternion();
    this._calliopeAxisX  = new THREE.Vector3(1, 0, 0);
  }

    // ── Auto-generated gear tables ────────────────────────────────────────────
  //
  // Forward gears: linear ramp from a low first-gear top speed up to exactly
  // `maxSpeed` at the top gear (gear `topGear` always == maxSpeed, so the
  // `maxSpeed` config value still means what it says).
  //   gear 1        -> maxSpeed / topGear
  //   gear topGear  -> maxSpeed
  //
  // Reverse gears: same linear-ramp shape, scaled down to top out at
  // REVERSE_TOP_FRACTION * maxSpeed on the outermost (fastest) reverse gear
  // — mirrors the old single-reverse-gear default of `-1: ms * 0.50`.
  _generateGearMaxSpeeds(maxSpeed, topGear, reverseGears, forwardMultiplier = 1.0) {
    const REVERSE_TOP_FRACTION = 0.5; // outermost reverse gear tops out at 50% of maxSpeed

    const table = { '0': 0 };

    const forwardTopSpeed = maxSpeed * forwardMultiplier;
    for (let g = 1; g <= topGear; g++) {
      table[String(g)] = forwardTopSpeed * (g / topGear);
    }

    // Reverse stays based on the ORIGINAL (unboosted) maxSpeed on purpose.
    const reverseTop = maxSpeed * REVERSE_TOP_FRACTION;
    for (let g = 1; g <= reverseGears; g++) {
      table[String(-g)] = reverseTop * (g / reverseGears);
    }

    return table;
  }

  // Accel follows a hump: ramps up from gear 1, peaks a bit past the middle
  // gear, then tapers off toward the top gear — mirrors the shape of your
  // hand-tuned 3-gear (0.25 → 0.17 → 0.08) and 8-gear
  // (0.20 → 0.24 → 0.28 → 0.24 → 0.20 → 0.14 → 0.12 → 0.10) tables.
  // Reverse gears reuse the same hump shape, scaled down slightly.
  _generateGearAccels(topGear, reverseGears, forwardMultiplier = 1.0) {
    // Scale accel with the speed boost so the tank can actually REACH the
    // higher top speed in a reasonable time, and so the belt-ratio (which
    // depends on actually-achieved speed vs topGearSpeed) doesn't lag
    // forever. Uses sqrt so accel doesn't scale as aggressively as top
    // speed (avoids absurd instant-launch force at high multipliers).
    const accelScale = Math.sqrt(Math.max(1, forwardMultiplier));
    const FORWARD_PEAK_ACCEL = 0.28 * accelScale; // accel value at the hump's peak
    const FORWARD_MIN_ACCEL  = 0.08 * accelScale; // accel value at the top gear (least punchy)
    const REVERSE_SCALE      = 0.7;  // reverse gears feel ~70% as punchy as forward

    const table = { '0': 0 };

    // Peak sits at roughly 40% of the way through the gear range (matches
    // gear 3 of 8 in the reference table, and gear 1 of 3 for short boxes).
    const peakGear = Math.max(1, Math.round(topGear * 0.4));

    for (let g = 1; g <= topGear; g++) {
      let t;
      if (g <= peakGear) {
        t = peakGear > 1 ? (g - 1) / (peakGear - 1) : 1;
        table[String(g)] = THREE.MathUtils.lerp(FORWARD_MIN_ACCEL * 1.5, FORWARD_PEAK_ACCEL, t);
      } else {
        t = (g - peakGear) / (topGear - peakGear);
        table[String(g)] = THREE.MathUtils.lerp(FORWARD_PEAK_ACCEL, FORWARD_MIN_ACCEL, t);
      }
    }

    const reversePeakGear = Math.max(1, Math.round(reverseGears * 0.4));
    for (let g = 1; g <= reverseGears; g++) {
      let t;
      let val;
      if (g <= reversePeakGear) {
        t = reversePeakGear > 1 ? (g - 1) / (reversePeakGear - 1) : 1;
        val = THREE.MathUtils.lerp(FORWARD_MIN_ACCEL * 1.5, FORWARD_PEAK_ACCEL, t);
      } else {
        t = (g - reversePeakGear) / (reverseGears - reversePeakGear);
        val = THREE.MathUtils.lerp(FORWARD_PEAK_ACCEL, FORWARD_MIN_ACCEL, t);
      }
      table[String(-g)] = val * REVERSE_SCALE;
    }

    return table;
  }

triggerRecoil() {
  this.turretController?.triggerRecoil();
  this.hullRecoilVelocity  = this.cfg.hullRecoilVelocity;
  this._firePitchVelocity  = this.cfg.firePitchVelocity;   // ← per-tank kick, set via tanks.json
}


  static async create(scene, world, position = { x: 0, y: 1.5, z: 0 }, config = {}) {
  const tank = new Tank(scene, world, position, config);
  await tank._loadHullModel();
  return tank;
}

  // ── Wheel position list ───────────────────────────────────────────────────
  //
  // When ENABLE_IN_OUT_WHEELS is true, each original X slot gets two entries:
  //   even index (0,2,4...) = outer wheel at original X
  //   odd  index (1,3,5...) = inner wheel shifted by half a spacing in X
  //
  // This list is used for both building Track meshes AND raycasting suspension.

_getWheelPositions() {
  const { roadWheelX, enableInOutWheels } = this.cfg;
  if (!enableInOutWheels) return roadWheelX;
  const spacing = (roadWheelX[1] - roadWheelX[0]) * 0.5;
  const positions = [];
  roadWheelX.forEach((x, i) => {
    positions.push(x);
    const innerX = i < roadWheelX.length - 1 ? x + spacing : x - spacing;
    positions.push(innerX);
  });
  return positions;
}

  // ── Physics ───────────────────────────────────────────────────────────────

_buildPhysics(world, pos) {
  const RAPIER = world.__RAPIER__;
  const { x: hx, y: hy, z: hz } = this.cfg.hullHalfExtents;

  const rbDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(pos.x, pos.y, pos.z)
    .setLinearDamping(1.5)
    .setAngularDamping(8)
    .setAdditionalMass(2);

  this.rigidBody = world.createRigidBody(rbDesc);

  const HULL_GROUP  = 0x0001;
  const WHEEL_GROUP = 0x0002;

  // Hull cuboid
  const hullCol = RAPIER.ColliderDesc
    .cuboid(hx, hy, hz)
    .setTranslation(0, 0.7, 0)
    .setFriction(1.0)
    .setRestitution(0.0)
    .setCollisionGroups((HULL_GROUP << 16) | (0xFFFF & ~WHEEL_GROUP))
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  world.createCollider(hullCol, this.rigidBody);

  // Side trapezoid colliders — rounded edges via roundConvexHull.
  // These exist purely to give the TRACK BELT (Track class) something to
  // grip/collide against via WHEEL_GROUP. A wheeled/trackless tank
  // (roadWheelX: [], sprocketRadius: 0, idlerRadius: 0, trackPieceCount: 0)
  // has no Track instances at all — skip building this collider pair
  // entirely rather than leaving dead geometry that nothing ever contacts.
  if (this.cfg.roadWheelX && this.cfg.roadWheelX.length > 0) {
    const SLAB_THICKNESS = 0.2;
    const BORDER_RADIUS  = 0.08;          // ← tune this (e.g. 0.05–0.15)

    // Shrink verts inward by BORDER_RADIUS so the final
    // inflated shape stays within the original trapezoid bounds
    const BR = BORDER_RADIUS;
    const TOP_HALF = hx + 0.4  - BR;
    const BOT_HALF = hx * 0.75 + 0.2 - BR;
    const TOP_Y    =  0.1  - BR;
    const BOT_Y    = -0.38 + BR;
    const THICK    = SLAB_THICKNESS - BR; // inset in Z as well

    [-this.cfg.outerZ, this.cfg.outerZ].forEach((z) => {
      const verts = new Float32Array([
        -TOP_HALF, TOP_Y,  z + THICK,
         TOP_HALF, TOP_Y,  z + THICK,
        -BOT_HALF, BOT_Y,  z + THICK,
         BOT_HALF, BOT_Y,  z + THICK,
        -TOP_HALF, TOP_Y,  z - THICK,
         TOP_HALF, TOP_Y,  z - THICK,
        -BOT_HALF, BOT_Y,  z - THICK,
         BOT_HALF, BOT_Y,  z - THICK,
      ]);

      const trapCol = RAPIER.ColliderDesc
        .roundConvexHull(verts, BORDER_RADIUS)  // ← replaces convexHull
        .setFriction(0.05)
        .setRestitution(0.0)
        .setCollisionGroups(
          (WHEEL_GROUP << 16) | (0xFFFF & ~(HULL_GROUP | WHEEL_GROUP))
        );
      world.createCollider(trapCol, this.rigidBody);
    });
  }
}

  // ── Visuals ───────────────────────────────────────────────────────────────

  _buildVisuals(scene) {
    this.bodyGroup = new THREE.Group();
    scene.add(this.bodyGroup);
}


//Load Hull
async _loadHullModel() {
  const modelPath = this.cfg.modelObjectURL ?? this.cfg.modelPath;
  const model = await loadModel(modelPath);

  const s = this.cfg.modelScale;
  model.scale.set(s, s, s);
  model.position.set(this.cfg.modelOffsetX, this.cfg.modelOffsetY, this.cfg.modelOffsetZ);
  model.rotation.set(this.cfg.modelRotX* (Math.PI / 180), this.cfg.modelRotY * (Math.PI / 180), this.cfg.modelRotZ * (Math.PI / 180));

  let turretMesh = null;
  let barrelMesh = null;
  let gunPoint   = null;
  let calliopeMesh = null;
  let scopePoint = null;   // ← add — separate node for scope camera, distinct from GunPoint (firing)
  let mgPoint    = null;
  let gunnerSightNode = null;

  model.traverse((child) => {
    if (child.isMesh) {
      child.castShadow    = true;
      child.receiveShadow = false;
    }
    if (child.name === 'Turret')   turretMesh = child;
    if (child.name === 'Barrel')   barrelMesh = child;
    if (child.name === 'Calliope') calliopeMesh = child;
    if (child.name === 'GunPoint')   gunPoint   = child;
    if (child.name === 'ScopePoint') scopePoint = child;   // ← add
    if (child.name === 'MG_Point')   mgPoint    = child;
    // ── gunType 3 — collect GunPoint_1, GunPoint_2, ... in numeric order ──
    if (/^GunPoint_\d+$/.test(child.name)) {
      this._multiGunPoints.push(child);
    }
    // ── Rockets — collect RocketPoint_1, RocketPoint_2, ... in numeric order ──
    if (this.cfg.enableRockets && /^RocketPoint_\d+$/.test(child.name)) {
      this._rocketPoints.push(child);
    }
    if (child.name === 'GunnerSight') gunnerSightNode = child;   // ← add
    // if (child.name.startsWith('MachineGun_Point')) {
    //   this._mgGunPoints.push(child);
    // }
    if (child.name === 'Hull_Collider') {
      child.visible = false;
      this._hullColliderMesh = child;
    }
    if (child.name === 'Crew_Collider') {
      child.visible = false;
      this._crewColliderMesh = child;
    }
    if (child.name === 'Smoke_1' || child.name === 'Smoke_2') {
      this._smokeNodes.push(child);
    }
    if (child.name === 'Camoflage' && child.isMesh) {
      this._camoNode = child;
    }
    if (child.name === 'Flag' && child.isMesh) {
      this._flagNode = child;

      // ── The flag mesh is a normally-LIT material, so when the tank sits
      // somewhere the directional "sun" light can't reach (inside a
      // tunnel/shelter) and only ambient light remains, it renders fully
      // black. Give it an emissive copy of its own texture so it always
      // shows its true color at a baseline brightness, on top of whatever
      // real lighting (ambient/directional) it's also receiving outdoors.
      const flagMats = Array.isArray(child.material) ? child.material : [child.material];
      flagMats.forEach((mat) => {
        if (!mat || !('emissive' in mat)) return;
        mat.emissiveMap = mat.map ?? null;
        mat.emissive = new THREE.Color(0xffffff);
        mat.emissiveIntensity = 0.6; // tune: higher = brighter/more visible in full shadow
        mat.needsUpdate = true;
      });
    }
    if (child.name === 'Dust_1' || child.name === 'Dust_2' || child.name === 'Dust_3' || child.name === 'Dust_4') {
      this._dustNodes.push(child);
    }
    // Matches the original unnumbered pair (Front_Axel_L / Front_Axel_R)
    // AND numbered multi-axle variants (Front_Axel_L_1, Front_Axel_R_1,
    // Front_Axel_L_2, Front_Axel_R_2, ...).
    if (/^Front_Axel_(L|R)(_\d+)?$/.test(child.name)) {
      this._axelNodes.push(child);

      // Update material of all meshes inside the axle node
      child.traverse((part) => {
        if (part.isMesh && part.material) {
          const mats = Array.isArray(part.material) ? part.material : [part.material];
          mats.forEach((mat) => {
            mat.metalness  = 0.28;   // 0.0 = plastic, 1.0 = fully metallic
            mat.roughness  = 0.82;   // 0.0 = mirror, 1.0 = fully rough
            // mat.color.set(0x888888);  // ← uncomment to also change color
            mat.needsUpdate = true;
          });
        }
      });
    }
    
    // Rear wheels for trackless/wheeled tanks — RearWheel_L_1, RearWheel_R_1,
    // RearWheel_L_2, RearWheel_R_2, ...
    if (/^RearWheel_(L|R)_\d+$/.test(child.name)) {
      this._rearWheelNodes.push(child);

      child.traverse((part) => {
        if (part.isMesh && part.material) {
          const mats = Array.isArray(part.material) ? part.material : [part.material];
          mats.forEach((mat) => {
            mat.metalness  = 0.28;
            mat.roughness  = 0.82;
            mat.needsUpdate = true;
          });
        }
      });
    }
  });
  
  this._setupCamoWindShader();
  this._applyCountryFlagTexture();

  // this.tankLights = new TankLights(model, {
  //   frontColor: '#ffe8b0', 
  //   rearColor: '#ff2200',   
  //   intensity:   0.5,
  //   haloSize:    0.1,
  //   pulseSpeed:  0, });

  this.bodyGroup.add(model);

  // ── Capture axle wheel base positions for suspension raycasting ─────────
  // At this point bodyGroup has no position/rotation applied yet (that only
  // happens inside update()), so each axle's current world position equals
  // its position in the rigid body's local frame — exactly the frame
  // _updateSuspension() already raycasts in for the road wheels.
  if (this._axelNodes.length > 0 || this._rearWheelNodes.length > 0) {
    const _savedBodyPos   = this.bodyGroup.position.clone();
    const _savedBodyQuat  = this.bodyGroup.quaternion.clone();
    const _savedBodyScale = this.bodyGroup.scale.clone();

    this.bodyGroup.position.set(0, 0, 0);
    this.bodyGroup.quaternion.identity();
    this.bodyGroup.scale.set(1, 1, 1);
    this.bodyGroup.updateMatrixWorld(true);

    model.updateMatrixWorld(true);

    const worldPos = new THREE.Vector3();

    this._axelBasePos    = [];
    this._axelOrigLocalY = [];
    this._axelSuspOffset = [];
    this._axelSuspVel    = [];
    for (const axel of this._axelNodes) {
      axel.getWorldPosition(worldPos);
      this._axelBasePos.push({ x: worldPos.x, y: worldPos.y, z: worldPos.z });
      this._axelOrigLocalY.push(axel.position.y);
      this._axelSuspOffset.push(0);
      this._axelSuspVel.push(0);
    }

    this._rearWheelBasePos    = [];
    this._rearWheelOrigLocalY = [];
    this._rearWheelSuspOffset = [];
    this._rearWheelSuspVel    = [];
    for (const rw of this._rearWheelNodes) {
      rw.getWorldPosition(worldPos);
      this._rearWheelBasePos.push({ x: worldPos.x, y: worldPos.y, z: worldPos.z });
      this._rearWheelOrigLocalY.push(rw.position.y);
      this._rearWheelSuspOffset.push(0);
      this._rearWheelSuspVel.push(0);
    }

    this.bodyGroup.position.copy(_savedBodyPos);
    this.bodyGroup.quaternion.copy(_savedBodyQuat);
    this.bodyGroup.scale.copy(_savedBodyScale);
    this.bodyGroup.updateMatrixWorld(true);

    if (this._axelNodes.length > 0)      this._createAxelWheelColliders();
    if (this._rearWheelNodes.length > 0) this._createRearWheelColliders();

    if (this._debugRaycasts) {
      // Clean up any markers left over from a previous life (respawn)
      [...this._axelDebugOriginMarkers, ...this._axelDebugHitMarkers,
       ...this._rearWheelDebugOriginMarkers, ...this._rearWheelDebugHitMarkers]
        .forEach(m => { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); });

      this._axelDebugOriginMarkers      = this._axelNodes.map(() => this._makeDebugSphere(0xffff00)); // yellow — axle ray origin
      this._axelDebugHitMarkers         = this._axelNodes.map(() => this._makeDebugSphere(0x00ff00)); // green  — axle ground hit
      this._rearWheelDebugOriginMarkers = this._rearWheelNodes.map(() => this._makeDebugSphere(0xff8800)); // orange — rear ray origin
      this._rearWheelDebugHitMarkers    = this._rearWheelNodes.map(() => this._makeDebugSphere(0x00ffff)); // cyan   — rear ground hit
    }
  }

  if (turretMesh && barrelMesh) {
    if (this.turretController) {
      // Respawn path — same controller instance, new mesh refs from the
      // freshly-loaded GLB.
      this.turretController.rebindMeshes(turretMesh, barrelMesh);
    } else {
      // First spawn — no controller exists yet.
      this.turretController = new TurretController(turretMesh, barrelMesh, this.scene, {
        turretMinAngle:  this.cfg.turretMinAngle,
        turretMaxAngle:  this.cfg.turretMaxAngle,
        barrelMinAngle:  this.cfg.barrelMinAngle,
        barrelMaxAngle:  this.cfg.barrelMaxAngle,
        recoilVelocity:  this.cfg.turretRecoilVelocity,
      });
    }
  } else {
    console.warn('Turret or Barrel object not found in GLB');
  }

if (this.cfg.gunType === 3) {
  // ── Multi-barrel main gun — sort GunPoint_N nodes numerically (GLB
  // traversal order isn't guaranteed to match the _1, _2, _3... naming) ──
  if (this._multiGunPoints.length > 0) {
    this._multiGunPoints.sort((a, b) => {
      const na = parseInt(a.name.split('_').pop(), 10);
      const nb = parseInt(b.name.split('_').pop(), 10);
      return na - nb;
    });
    this.bulletSystem.setGunPoints(this._multiGunPoints);
    // Turret still aims using the first barrel as its reference point
    this.turretController?.setGunPoint(this._multiGunPoints[0]);
  } else {
    console.warn('[Tank] gunType 3 selected but no GunPoint_1, GunPoint_2, ... found in GLB');
  }
} else if (gunPoint) {
  this.bulletSystem.setGunPoint(gunPoint);
  this.bulletSystem.setShellSpeed(this.cfg.shellSpeed ?? 80);
  this.bulletSystem.setFireRate(this.cfg.reloadTime ?? 3);
  this.bulletSystem.setDamage(this.cfg.damage ?? 100); 
  this.turretController?.setGunPoint(gunPoint);
} else {
  console.warn('GunPoint not found in GLB');
}

// ── Rockets — sort RocketPoint_N nodes numerically and hand them to the
// rocket system. Only relevant when enableRockets is true.
if (this.cfg.enableRockets && this.rocketSystem) {
  if (this._rocketPoints.length > 0) {
    this._rocketPoints.sort((a, b) => {
      const na = parseInt(a.name.split('_').pop(), 10);
      const nb = parseInt(b.name.split('_').pop(), 10);
      return na - nb;
    });
    if (this.cfg.specialWeaponType?.includes('gun')) {
      // SpecialGunSystem only ever fires from one point — use the first.
      this.rocketSystem.setLaunchPoint(this._rocketPoints[0]);
    } else {
      this.rocketSystem.setLaunchPoints(this._rocketPoints);
    }
  } else if (this.cfg.specialWeaponType?.includes('gun') && gunPoint) {
    // No dedicated RocketPoint_N node in this GLB — fall back to firing
    // the special gun from the main cannon's own GunPoint instead of
    // silently doing nothing. Add a RocketPoint_1 empty to the model
    // later for a proper dedicated mount point.
    console.warn('[Tank] specialWeaponType "gun" has no RocketPoint_1 in GLB — falling back to main GunPoint');
    this.rocketSystem.setLaunchPoint(gunPoint);
  } else {
    console.warn('[Tank] enableRockets is true but no RocketPoint_1, RocketPoint_2, ... found in GLB');
  }
}

// ── Calliope (rocket rack) — capture base pose so its pitch can be
// synced to the barrel's current pitch every frame in update(). Reset
// on every respawn since it's part of the freshly-loaded GLB.
if (calliopeMesh) {
  this._calliopeNode  = calliopeMesh;
  this._calliopeBaseQ = calliopeMesh.quaternion.clone();
} else if (this.cfg.enableRockets) {
  console.warn('[Tank] enableRockets is true but no Calliope mesh found in GLB — rocket rack pitch sync disabled');
  this._calliopeNode  = null;
  this._calliopeBaseQ = null;
}

// ── ScopePoint: dedicated node for the scope camera — falls back to
// GunPoint if the model hasn't been updated with a ScopePoint empty yet ────
if (scopePoint) {
  this.scopePoint = scopePoint;
  this.turretController?.setScopePoint(scopePoint);
} else {
  console.warn('ScopePoint not found in GLB — falling back to GunPoint for scope camera');
  this.scopePoint = gunPoint;
  this.turretController?.setScopePoint(gunPoint);
}

if (mgPoint) {
  this.mgSystem.setGunPoint(mgPoint);
  // Store reference so update() can sync MG pitch to barrel
  this._mgPoint = mgPoint;
  this.hasMachineGun = true;   // ← this tank model has a real MG_Point — HUD can show the MG slot

  // ── NEW: the visible MG gun mesh is now MG_Point's parent node ──────────
  // We rotate this node (not MG_Point itself) so the actual gun mesh swivels;
  // MG_Point just rides along as a child to give us muzzle world position.
  this._mgAimNode = mgPoint.parent ?? null;
  if (!this._mgAimNode) {
    console.warn('MG_Point has no parent MG node — MG aiming disabled');
  }
} else {
  console.warn('MG_Point not found in GLB — MG disabled');
  this._mgPoint = null;
  this._mgAimNode = null;
  this.hasMachineGun = false;   // ← no MG_Point in this GLB — HUD should hide the MG weapon slot
}

if (gunnerSightNode) {
  this.gunnerSightNode = gunnerSightNode;
} else {
  console.warn('GunnerSight not found in GLB — gunner sight scope disabled');
  this.gunnerSightNode = null;
}

  // After turretController and bulletSystem.setGunPoint(gunPoint) setup:

   // Smoke emitters
  if (this._smokeNodes.length > 0) {
    this.smokeSystem = new TankSmoke(this.scene, this._smokeNodes);
  } else {
    console.warn('Smoke_1 / Smoke_2 empties not found in GLB — no exhaust smoke.');
  }

  if (this._dustNodes.length > 0) {
  this.dustSystem = new TankDust(this.scene, this._dustNodes, this.rigidBody, this._dustColor);
} else {
  console.warn('Dust_1 / Dust_2 not found in GLB — no dust trail.');
}

  // Clean up the blob URL after the model has loaded — no longer needed
  if (this.cfg.modelObjectURL) {
    URL.revokeObjectURL(this.cfg.modelObjectURL);
    this.cfg.modelObjectURL = null;
  }
}

// ── Camo net wind sway — cheap vertex-shader displacement, no CPU per-vertex work ─
_setupCamoWindShader() {
  const mesh = this._camoNode;
  if (!mesh || !mesh.material) {
    this._camoWindUniforms = null;
    return;
  }

  // Compute local-space Y bounds once so the shader knows what "lower part" means
  mesh.geometry.computeBoundingBox();
  const bbox = mesh.geometry.boundingBox;
  const minY = bbox.min.y;
  const maxY = bbox.max.y;
  const rangeY = Math.max(0.0001, maxY - minY);

  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  this._camoWindUniforms = [];

  materials.forEach((mat) => {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWindTime      = { value: 0 };
      shader.uniforms.uWindIntensity = { value: 0 };   // driven by tank speed each frame
      shader.uniforms.uCamoMinY      = { value: minY };
      shader.uniforms.uCamoRangeY    = { value: rangeY };

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `
        #include <common>
        uniform float uWindTime;
        uniform float uWindIntensity;
        uniform float uCamoMinY;
        uniform float uCamoRangeY;
        `
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        {
          // 0 at top of mesh, 1 at bottom — so only the lower net edge sways
          float heightT = 1.0 - clamp((position.y - uCamoMinY) / uCamoRangeY, 0.0, 1.0);
          float lowerMask = pow(heightT, 2.0); // bias so only the bottom fringe moves noticeably

          float sway =
            sin(uWindTime * 1.6 + position.x * 2.2 + position.z * 1.3) * 0.02 +
            sin(uWindTime * 2.7 + position.x * 4.1) * 0.01;

          transformed.x += sway * lowerMask * uWindIntensity;
          transformed.z += sway * 0.6 * lowerMask * uWindIntensity;
        }
        `
      );

      this._camoWindUniforms.push(shader.uniforms);
    };
    mat.needsUpdate = true;
  });
}

// ── Country flag — plain static texture, no shader/animation ─────────────
_applyCountryFlagTexture() {
  const mesh = this._flagNode;
  if (!mesh || !mesh.material) return;

  const code = this.cfg.country;
  if (!code) return; // no country configured — leave default material as-is

  const url = `https://flagcdn.com/w320/${code.toLowerCase()}.png`;

  const loader = new THREE.TextureLoader();
  loader.load(
    url,
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = true;   // GLTF UVs are typically already flipped correctly

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((mat) => {
        mat.map = texture;
        mat.color?.set?.(0xffffff);   // clear any tint so the flag shows true colors
        // ── Keep the emissive self-illumination in sync with the newly
        // loaded country texture — otherwise emissiveMap would stay
        // pointed at the OLD (baked) texture while .map shows the new
        // one, causing a mismatched double-image once lit from both.
        if ('emissive' in mat) {
          mat.emissiveMap = texture;
          mat.emissiveIntensity = 0.1; // keep in sync with the traverse-time value above
        }
        mat.needsUpdate = true;
      });
    },
    undefined,
    (err) => {
      console.warn(`[Tank] Failed to load flag texture for country "${code}":`, err);
    }
  );
}

_updateCamoWind(dt) {
  if (!this._camoWindUniforms || this._camoWindUniforms.length === 0) return;

  this._camoWindTime = (this._camoWindTime ?? 0) + dt;

  // Scale sway strength with current speed — stronger flutter the faster you go
  let speedFactor = 0;
  if (this.rigidBody) {
    const vel = this.rigidBody.linvel();
    const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    speedFactor = THREE.MathUtils.clamp(speed / (this.maxSpeed || 1), 0, 1);
  }
  // Keep a small baseline sway even when stationary (ambient breeze), ramp up with speed
  const intensity = 0.25 + speedFactor * 1.0;

  for (const u of this._camoWindUniforms) {
    u.uWindTime.value      = this._camoWindTime;
    u.uWindIntensity.value = intensity;
  }
}

  // ── Tracks ────────────────────────────────────────────────────────────────

_buildTracks(scene) {
  const c = this.cfg;

  // ── No-track / wheeled tanks — roadWheelX: [] (paired with
  // sprocketRadius: 0, idlerRadius: 0, trackPieceCount: 0) means this tank
  // has no belts, road wheels, sprocket, or idler at all. Skip building
  // Track instances entirely instead of handing Track an empty wheel list.
  if (!c.roadWheelX || c.roadWheelX.length === 0) {
    this.trackLeft  = null;
    this.trackRight = null;
    return;
  }

  const cfg = {
    roadWheelXPositions:        this._getWheelPositions(),
    roadWheelY:                 c.roadWheelY,
    sprocketX:                  c.sprocketX,
    sprocketY:                  c.sprocketY,
    idlerX:                     c.idlerX,
    idlerY:                     c.idlerY,
    returnRollers:              c.returnRollers,
    topRunSag:                  c.topRunSag    ?? 0.10,
    bottomRunSag:               c.bottomRunSag ?? 0.1,
    enableInAndOutWheels:       c.enableInOutWheels,
    enableBogieWheels:          c.enableBogieWheels,
    enableSteampunkWheel:       c.enableSteampunkWheel,
    bogieWheelSystemSize:       c.bogieWheelSystemSize,
    bogieArmAngleRange:         c.bogieArmAngleRange,
    bogieArmLength:             c.bogieArmLength ?? 0.28,
    sprocketWheelType:          c.sprocketWheelType,
    idlerWheelType:             c.idlerWheelType,
    roadWheelType:              c.roadWheelType,
    wheelColor:                 c.wheelColor,
    sprocketRadius:             c.sprocketRadius,
    sprocketWidth:              c.sprocketWidth,
    idlerRadius:                c.idlerRadius,
    idlerWidth:                 c.idlerWidth,
    steampunkPistonReach:       c.steampunkPistonReach,
    outerZ:                     c.outerZ ?? 1.0,
    rootTrackWidth:             c.rootTrackWidth ?? 1.0,
    roadWheelRadius:            c.roadWheelRadius      ?? 0.31,
    idlerTransitionSag:         c.idlerTransitionSag   ?? 0.33,
    sprocketTransitionSag:      c.sprocketTransitionSag ?? 0.1,
    hideLastRw:                 c.hideLastRw ?? true,
    beltType:                   c.beltType ?? 1,
    bogieSystemType:            c.bogieSystemType ?? 1,
    disableEndWheelLinks:       c.disableEndWheelLinks ?? { front: false, back: false },
    trackPieceCount:            c.trackPieceCount ?? 70,
    enableTorsionBars:          c.enableTorsionBars       ?? false,
    torsionArmAngle:            c.torsionArmAngle          ?? (-Math.PI * 0.18 + Math.PI),
    doubleSideTorsionArm:       c.doubleSideTorsionArm     ?? false,
    spArcFactor:                c.spArcFactor    ?? 1.8,
    idlerArcFactor:             c.idlerArcFactor ?? 1.2,
    shellSpeed:                 c.shellSpeed ?? 80,
    reloadTime:                 c.reloadTime ?? 3,
    fireRate:                   c.fireRate   ?? 0.2,
  };
  this.trackLeft  = new Track(scene, this.bodyGroup, -1, { ...cfg });
  this.trackRight = new Track(scene, this.bodyGroup,  1, { ...cfg });
}

// ── Render interpolation ──────────────────────────────────────────────────
// Call BEFORE each world.step() — snapshots the pre-step transform so the
// render loop can blend between "where the body was" and "where it is now"
// instead of popping the visual straight to the latest 60Hz physics state.
captureTransformSnapshot() {
  if (!this.rigidBody) return;
  const pos = this.rigidBody.translation();
  const rot = this.rigidBody.rotation();
  this._prevPos.set(pos.x, pos.y, pos.z);
  this._prevQuat.set(rot.x, rot.y, rot.z, rot.w);
}

// Call ONCE per render frame, after the physics accumulator loop, with
// alpha = leftover accum / FIXED (0..1). Produces this._renderPos /
// this._renderQuat — the smoothed transform update() should draw from.
computeRenderTransform(alpha) {
  if (!this.rigidBody) return;
  const pos = this.rigidBody.translation();
  const rot = this.rigidBody.rotation();
  this._renderPos.lerpVectors(this._prevPos, pos, alpha);
  this._renderQuat.copy(this._prevQuat).slerp(
    this._scratchQ.set(rot.x, rot.y, rot.z, rot.w),
    alpha
  );
}

  // ── Suspension raycast ────────────────────────────────────────────────────

_updateSuspension(sideZ, offsetsArray, velArray, dt) {
  if (!this.rigidBody) return;   // ← guard against null after death
  const RAPIER = this.world.__RAPIER__;
  const pos    = this.rigidBody.translation();
  const rot    = this.rigidBody.rotation();
  const q      = this._scratchQ.set(rot.x, rot.y, rot.z, rot.w);

const RAY_ABOVE_WHEEL  = 0.6;
// Effective ground-contact radius must include the track belt's own
// thickness wrapped around the wheel rim (see PIECE_T in track.js,
// used identically in Track._buildPath()'s `rwR` calculation) — otherwise
// the raycast treats the bare wheel radius as the resting distance and
// lets the wheel sink further than the belt's actual bottom surface,
// causing the wheel to visually poke through/intersect the lower track run.
const TRACK_THICKNESS  = this.cfg.trackThickness ?? 0.06;   // must match track.js PIECE_T
const WHEEL_RADIUS     = (this.cfg.roadWheelRadius ?? 0.25) - 0.02 + PIECE_T/3;
const NATURAL_HIT_DIST = RAY_ABOVE_WHEEL + WHEEL_RADIUS;
const RAY_MAX_DIST     = 2.0;

  // ── Spring-damper tuning ──────────────────────────────────────────────
  const STIFFNESS = 220;   // try 150–300
  const DAMPING   = 22;    // try 15–30, keep near critically damped

  // ── Use arm-based positions when bogie is active ──────────────────────
  const bogieActive  = this.cfg.enableBogieWheels;
  const wheelsPerArm = (this.cfg.bogieSystemType === 2 || this.cfg.bogieSystemType === 3) ? 4 : 2;
  const basePositions = this.cfg.roadWheelX;  // always the raw 6-entry list

  const loopCount = bogieActive
    ? basePositions.length * wheelsPerArm
    : this._getWheelPositions().length;

  for (let i = 0; i < loopCount; i++) {
    // Map index back to an X position
    const xIndex = bogieActive ? Math.floor(i / wheelsPerArm) : i;
    const wheelX = bogieActive
      ? basePositions[xIndex]
      : this._getWheelPositions()[i];

    const localWheelPos = this._scratchLocalPos.set(wheelX, this.cfg.roadWheelY, sideZ);
    localWheelPos.applyQuaternion(q);

    const worldWheelPos = this._scratchWorldPos.set(
      pos.x + localWheelPos.x,
      pos.y + localWheelPos.y,
      pos.z + localWheelPos.z
    );

    if (!this._suspRayOrigin) {
      this._suspRayOrigin = new RAPIER.Ray(
        { x: 0, y: 0, z: 0 },
        { x: 0, y: -1, z: 0 }
      );
    }
    this._suspRayOrigin.origin.x = worldWheelPos.x;
    this._suspRayOrigin.origin.y = worldWheelPos.y + RAY_ABOVE_WHEEL;
    this._suspRayOrigin.origin.z = worldWheelPos.z;
    const suspRay = this._suspRayOrigin;

    const suspHit = this.world.castRay(
      suspRay, RAY_MAX_DIST, true,
      undefined, undefined, undefined,
      this.rigidBody
    );

    const MAX_DOWN_TRAVEL = this.cfg.roadWheelMaxDownTravel; // ← now tank-configurable (was hardcoded 0.12)

const NO_GROUND_THRESHOLD = RAY_MAX_DIST * 0.92;
const groundIsReal = suspHit && suspHit.timeOfImpact < NO_GROUND_THRESHOLD;

const targetOffset = groundIsReal
  ? Math.max(-MAX_DOWN_TRAVEL, (NATURAL_HIT_DIST - suspHit.timeOfImpact) * 1.0)
  : -MAX_DOWN_TRAVEL; // no (real) ground found → let wheel droop to its limit

    // ── Critically-damped spring toward targetOffset ──────────────────
    const current = offsetsArray[i];
    const vel     = velArray[i];

    const springForce  = (targetOffset - current) * STIFFNESS;
    const dampingForce = -vel * DAMPING;
    const accel         = springForce + dampingForce;

    const newVel    = vel + accel * dt;
    const newOffset = current + newVel * dt;

    velArray[i]     = newVel;
    offsetsArray[i] = Math.max(-MAX_DOWN_TRAVEL, newOffset);
  }
}

_updateAxelSuspension(dt) {
  if (!this.rigidBody || !this.cfg.enableAxelWheels) return;
  if (!this._axelNodes.length || !this._axelBasePos.length) return;

  const RAPIER = this.world.__RAPIER__;
  const pos = this.rigidBody.translation();
  const rot = this.rigidBody.rotation();
  const q   = this._scratchQ.set(rot.x, rot.y, rot.z, rot.w);

  const RAY_ABOVE_WHEEL  = 0.6;
  const WHEEL_RADIUS     = (this.cfg.axelWheelRadius ?? 0.3) - 0.02;
  const NATURAL_HIT_DIST = RAY_ABOVE_WHEEL + WHEEL_RADIUS;
  const RAY_MAX_DIST     = 2.0;

  // Same spring-damper tuning as the road wheels — tweak independently if
  // you want the axle wheels to feel softer/stiffer than the tracks.
  const STIFFNESS = 220;
  const DAMPING   = 22;

  // How far the axle wheel can travel from its rest position — both
  // downward into a dip AND upward under compression. Named distinctly
  // from the road wheels' own MAX_DOWN_TRAVEL (declared separately inside
  // _updateSuspension) — these are unrelated constants tuned independently.
  //
  // AXEL_MAX_UP_TRAVEL matters just as much as the down-travel clamp: on
  // steep terrain (e.g. climbing a slope) the downward raycast can hit
  // ground very close to the wheel even when the wheel isn't genuinely
  // resting flush against it, producing a huge unclamped targetOffset that
  // makes the spring overshoot wildly — the stretched/looping wheel
  // geometry seen when driving up an incline. Clamping this the same way
  // as the droop limit keeps the visual travel physically plausible.
  const AXEL_MAX_DOWN_TRAVEL = this.cfg.axelMaxDownTravel; // ← now tank-configurable (was hardcoded 0.2)
  const AXEL_MAX_UP_TRAVEL   = this.cfg.axelMaxUpTravel;   // ← now tank-configurable (was hardcoded 0.1)

  for (let i = 0; i < this._axelNodes.length; i++) {
    const base = this._axelBasePos[i];
    if (!base) continue;

    const localWheelPos = this._scratchLocalPos.set(base.x, base.y, base.z);
    localWheelPos.applyQuaternion(q);

    const worldWheelPos = this._scratchWorldPos.set(
      pos.x + localWheelPos.x,
      pos.y + localWheelPos.y,
      pos.z + localWheelPos.z
    );

    if (!this._axelRayOrigin) {
      this._axelRayOrigin = new RAPIER.Ray(
        { x: 0, y: 0, z: 0 },
        { x: 0, y: -1, z: 0 }
      );
    }
    this._axelRayOrigin.origin.x = worldWheelPos.x;
    this._axelRayOrigin.origin.y = worldWheelPos.y + RAY_ABOVE_WHEEL;
    this._axelRayOrigin.origin.z = worldWheelPos.z;

    const hit = this.world.castRay(
      this._axelRayOrigin, RAY_MAX_DIST, true,
      undefined, undefined, undefined,
      this.rigidBody
    );

    if (this._debugRaycasts && this._axelDebugOriginMarkers[i]) {
      const om = this._axelDebugOriginMarkers[i];
      om.position.copy(this._axelRayOrigin.origin);
      om.visible = true;

      const hm = this._axelDebugHitMarkers[i];
      if (hit) {
        hm.position.set(
          this._axelRayOrigin.origin.x,
          this._axelRayOrigin.origin.y - hit.timeOfImpact,
          this._axelRayOrigin.origin.z
        );
        hm.visible = true;
      } else {
        hm.visible = false;
      }
    }

    // If the ray found no ground at all within RAY_MAX_DIST, or found ground
    // only very close to the ray's max range (i.e. essentially "no ground
    // under this wheel"), treat it the same way: full droop, not a partial
    // upward reading from a stale/near-miss hit.
    const NO_GROUND_THRESHOLD = RAY_MAX_DIST * 0.92;
    const groundIsReal = hit && hit.timeOfImpact < NO_GROUND_THRESHOLD;

    const rawOffset = groundIsReal
      ? (NATURAL_HIT_DIST - hit.timeOfImpact) * 1.5
      : -AXEL_MAX_DOWN_TRAVEL; // no (real) ground found → let wheel droop to its limit

    const targetOffset = Math.min(
      AXEL_MAX_UP_TRAVEL,
      Math.max(-AXEL_MAX_DOWN_TRAVEL, rawOffset)
    );

    const current = this._axelSuspOffset[i];
    const vel     = this._axelSuspVel[i];

    const springForce  = (targetOffset - current) * STIFFNESS;
    const dampingForce = -vel * DAMPING;
    const accel        = springForce + dampingForce;

    const newVel    = vel + accel * dt;
    const newOffset = current + newVel * dt;

    this._axelSuspVel[i]    = newVel;
    this._axelSuspOffset[i] = Math.min(
      AXEL_MAX_UP_TRAVEL,
      Math.max(-AXEL_MAX_DOWN_TRAVEL, newOffset)
    );
  }
}


_updateRearWheelSuspension(dt) {
  if (!this.rigidBody) return;
  if (!this._rearWheelNodes.length || !this._rearWheelBasePos.length) return;

  const RAPIER = this.world.__RAPIER__;
  const pos = this.rigidBody.translation();
  const rot = this.rigidBody.rotation();
  const q   = this._scratchQ.set(rot.x, rot.y, rot.z, rot.w);

  const RAY_ABOVE_WHEEL  = 0.6;
  const WHEEL_RADIUS     = (this.cfg.axelWheelRadius ?? 0.3) - 0.02;
  const NATURAL_HIT_DIST = RAY_ABOVE_WHEEL + WHEEL_RADIUS;
  const RAY_MAX_DIST     = 2.0;

  const STIFFNESS = 220;
  const DAMPING   = 22;

  const REAR_MAX_DOWN_TRAVEL = this.cfg.rearWheelMaxDownTravel; // ← now tank-configurable (was hardcoded 0.2)
  const REAR_MAX_UP_TRAVEL   = this.cfg.rearWheelMaxUpTravel;   // ← now tank-configurable (was hardcoded 0.1)

  for (let i = 0; i < this._rearWheelNodes.length; i++) {
    const base = this._rearWheelBasePos[i];
    if (!base) continue;

    const localWheelPos = this._scratchLocalPos.set(base.x, base.y, base.z);
    localWheelPos.applyQuaternion(q);

    const worldWheelPos = this._scratchWorldPos.set(
      pos.x + localWheelPos.x,
      pos.y + localWheelPos.y,
      pos.z + localWheelPos.z
    );

    if (!this._rearWheelRayOrigin) {
      this._rearWheelRayOrigin = new RAPIER.Ray(
        { x: 0, y: 0, z: 0 },
        { x: 0, y: -1, z: 0 }
      );
    }
    this._rearWheelRayOrigin.origin.x = worldWheelPos.x;
    this._rearWheelRayOrigin.origin.y = worldWheelPos.y + RAY_ABOVE_WHEEL;
    this._rearWheelRayOrigin.origin.z = worldWheelPos.z;

    const hit = this.world.castRay(
      this._rearWheelRayOrigin, RAY_MAX_DIST, true,
      undefined, undefined, undefined,
      this.rigidBody
    );

    if (this._debugRaycasts && this._rearWheelDebugOriginMarkers[i]) {
      const om = this._rearWheelDebugOriginMarkers[i];
      om.position.copy(this._rearWheelRayOrigin.origin);
      om.visible = true;

      const hm = this._rearWheelDebugHitMarkers[i];
      if (hit) {
        hm.position.set(
          this._rearWheelRayOrigin.origin.x,
          this._rearWheelRayOrigin.origin.y - hit.timeOfImpact,
          this._rearWheelRayOrigin.origin.z
        );
        hm.visible = true;
      } else {
        hm.visible = false;
      }
    }

    const NO_GROUND_THRESHOLD = RAY_MAX_DIST * 0.92;
    const groundIsReal = hit && hit.timeOfImpact < NO_GROUND_THRESHOLD;

    const rawOffset = groundIsReal
      ? (NATURAL_HIT_DIST - hit.timeOfImpact) * 1.5
      : -REAR_MAX_DOWN_TRAVEL;

    const targetOffset = Math.min(
      REAR_MAX_UP_TRAVEL,
      Math.max(-REAR_MAX_DOWN_TRAVEL, rawOffset)
    );

    const current = this._rearWheelSuspOffset[i];
    const vel     = this._rearWheelSuspVel[i];

    const springForce  = (targetOffset - current) * STIFFNESS;
    const dampingForce = -vel * DAMPING;
    const accel        = springForce + dampingForce;

    const newVel    = vel + accel * dt;
    const newOffset = current + newVel * dt;

    this._rearWheelSuspVel[i]    = newVel;
    this._rearWheelSuspOffset[i] = Math.min(
      REAR_MAX_UP_TRAVEL,
      Math.max(-REAR_MAX_DOWN_TRAVEL, newOffset)
    );
  }
}

_createAxelWheelColliders() {
  if (!this.cfg.enableAxelWheels) return;
  if (!this.rigidBody || !this._axelBasePos.length) return;

  const RAPIER = this.world.__RAPIER__;
  const HULL_GROUP  = 0x0001;
  const WHEEL_GROUP = 0x0002;
  const radius = this.cfg.axelWheelRadius ?? 0.3;

  // Old colliders belonged to a rigid body that's already been removed
  // (respawn path) — just drop the stale references, no manual cleanup needed.
  this._axelWheelColliders = [];

  for (const base of this._axelBasePos) {
    const colDesc = RAPIER.ColliderDesc
      .ball(radius)
      .setTranslation(base.x, base.y, base.z)
      .setFriction(0.6)
      .setRestitution(0.0)
      .setCollisionGroups((WHEEL_GROUP << 16) | (0xFFFF & ~(HULL_GROUP | WHEEL_GROUP)));
    const collider = this.world.createCollider(colDesc, this.rigidBody);
    this._axelWheelColliders.push(collider);
  }
}


_makeDebugSphere(color) {
  const geo = new THREE.SphereGeometry(0.05, 8, 6);
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 999;
  mesh.visible = false;
  this.scene.add(mesh);
  return mesh;
}

_createRearWheelColliders() {
  if (!this.rigidBody || !this._rearWheelBasePos.length) return;

  const RAPIER = this.world.__RAPIER__;
  const HULL_GROUP  = 0x0001;
  const WHEEL_GROUP = 0x0002;
  // Reuses axelWheelRadius for now — add a dedicated `rearWheelRadius`
  // cfg key later if you need it tunable separately from the front axles.
  const radius = this.cfg.axelWheelRadius ?? 0.3;

  this._rearWheelColliders = [];

  for (const base of this._rearWheelBasePos) {
    const colDesc = RAPIER.ColliderDesc
      .ball(radius)
      .setTranslation(base.x, base.y, base.z)
      .setFriction(0.6)
      .setRestitution(0.0)
      .setCollisionGroups((WHEEL_GROUP << 16) | (0xFFFF & ~(HULL_GROUP | WHEEL_GROUP)));
    const collider = this.world.createCollider(colDesc, this.rigidBody);
    this._rearWheelColliders.push(collider);
  }
}

takeDamage(amount = 25) {
  if (this.isDead) return;
  this.health = Math.max(0, this.health - amount);
  this._triggerCameraShake(amount);
  if (this.health <= 0) this._die();
}

_triggerCameraShake(amount = 25) {
  // Scale shake intensity with damage — more damage = bigger shake
  const intensity = Math.min(amount / 100, 1.0);   // 0.0 – 1.0
  this._shakeIntensity = intensity * 0.6;            // max offset in world units
  this._shakeDuration  = 0.35 + intensity * 0.25;   // 0.35s – 0.60s
  this._shakeElapsed   = 0;
  this._shakeFrequency = 18 + intensity * 12;        // oscillations per second
}

/** Recoil-style camera shake — internal setter. Independent of (and
 * additive with) the damage-hit shake above, driven by its own
 * intensity/duration/frequency so weapon fire reads as its own kick. */
_triggerFireShake(intensity, duration, frequency) {
  this._fireShakeIntensity = intensity;
  this._fireShakeDuration  = duration;
  this._fireShakeElapsed   = 0;
  this._fireShakeFrequency = frequency;
}

/** Public entry point for weapon-fire shake — call any time this tank
 * actually fires a shot. 'main' = main gun, 'mg' = machine gun,
 * 'rocket' = rockets/special gun. */
triggerFireShake(kind = 'main') {
  if (kind === 'mg')          this._triggerFireShake(0.05, 0.10, 30);
  else if (kind === 'rocket') this._triggerFireShake(0.05, 0.18, 14);
  else                        this._triggerFireShake(0.08, 0.16, 16); // 'main' gun — heaviest kick
}

_die() {
  if (this.isDead) return;
  this.isDead = true;
  this.onDeath?.();   // ← NEW — lets main.js stop engine sound the instant death occurs
  // Reset gear + throttle to neutral on death
  this.gear     = 0;
  this.throttle = 0;
  window._tankGearChanged = true;

  // ── Start the death-freeze countdown — the rigid body + suspension/
  // track simulation keep running (see _updatePostDeathPhysics, called
  // from update()'s isDead branch) until this reaches 0, at which point
  // _finalizeDeathFreeze() actually removes the physics body and locks
  // the wreck in place for good.
  this._deathFreezeTimer = this.cfg.deathFreezeDuration ?? 2.0;

  // ── Eject turret ballistically ────────────────────────────────────────
if (this.turretController?.turret) {
    const turretMesh = this.turretController.turret;
    const worldPos = new THREE.Vector3();
    const worldQ   = new THREE.Quaternion();
    turretMesh.getWorldPosition(worldPos);
    turretMesh.getWorldQuaternion(worldQ);

    this.bodyGroup.remove(turretMesh);
    this.scene.add(turretMesh);
    turretMesh.position.copy(worldPos);
    turretMesh.quaternion.copy(worldQ);

    this._ejectedTurret = turretMesh;
    this.turretController.turret = null;  // ← stop controller rotating ejected turret
    this._ejectedTurret.userData.vel = new THREE.Vector3(
      (Math.random() - 0.5) * 6,
      8 + Math.random() * 6,
      (Math.random() - 0.5) * 6
    );
    this._ejectedTurret.userData.angVel = new THREE.Vector3(
      (Math.random() - 0.5) * 4,
      (Math.random() - 0.5) * 4,
      (Math.random() - 0.5) * 4
    );
  }

// ── Invalidate any in-flight projectiles referencing this body ─────────
  this.bulletSystem?.invalidateRigidBody?.(this.rigidBody);
  this.rocketSystem?.invalidateRigidBody?.(this.rigidBody);

  // ── NOTE: the rigid body and track refs are intentionally NOT cleared
  // here anymore — that now happens in _finalizeDeathFreeze(), once
  // _deathFreezeTimer runs out (see update()'s isDead branch). This is
  // what lets the hull keep reacting to terrain/suspension for a couple
  // seconds after death instead of freezing on this exact frame.

  // ── Staggered explosions then show death screen ───────────────────────
  const deathPos = new THREE.Vector3();
  this.bodyGroup.getWorldPosition(deathPos);
  deathPos.y += 0.8;

  this.explosionSystem?.spawn(deathPos.clone());

  setTimeout(() => {
    const off1 = new THREE.Vector3(
      (Math.random() - 0.5) * 1.2, 0.4,
      (Math.random() - 0.5) * 1.2
    );
    this.explosionSystem?.spawn(deathPos.clone().add(off1));
  }, 220);

  setTimeout(() => {
    const off2 = new THREE.Vector3(
      (Math.random() - 0.5) * 0.8, 1.0,
      (Math.random() - 0.5) * 0.8
    );
    this.explosionSystem?.spawn(deathPos.clone().add(off2));
  }, 480);

  // ── Show death screen after explosions finish ─────────────────────────
  setTimeout(() => {
    this._readyToShowDeath = true;
  }, 1500);
}

/** Actually removes the physics body and severs the tracks' rigid-body
 * refs — the step that used to run synchronously inside _die(). Called
 * once _deathFreezeTimer counts down to 0 (see update()'s isDead branch),
 * or defensively from respawn() in case a fresh life starts before the
 * timer finished. Safe to call multiple times — no-ops if already done. */
_finalizeDeathFreeze() {
  if (!this.rigidBody) return;

  if (this.trackLeft)  { this.trackLeft._tankRigidBody  = null; this.trackLeft._bodyMatrix  = null; }
  if (this.trackRight) { this.trackRight._tankRigidBody = null; this.trackRight._bodyMatrix = null; }

  this.world.removeRigidBody(this.rigidBody);
  this.rigidBody = null;
  this._deathFreezeTimer = 0;
}

/** Runs a trimmed-down version of the normal suspension/hull/track update
 * for a destroyed-but-not-yet-frozen tank — no driving input, no turret
 * aim, no weapon fire, just letting the (still-alive) rigid body keep
 * settling under gravity/collision while the hull visually reacts to it,
 * instead of the wreck popping straight to a frozen pose the instant it
 * dies. Called every frame from update()'s isDead branch while
 * _deathFreezeTimer > 0. */
_updatePostDeathPhysics(dt) {
  if (!this.rigidBody) return;

  const rot    = this.rigidBody.rotation();
  const worldQ = this._scratchQ.set(rot.x, rot.y, rot.z, rot.w);

  const pos = this._renderPos;
  if (!this._scratchQ4) this._scratchQ4 = new THREE.Quaternion();
  const renderQ = this._scratchQ4.copy(this._renderQuat);

  // Per-side suspension raycasts — same as the normal alive path
  this._updateSuspension(-this.cfg.outerZ, this.suspensionOffsetsLeft,  this.suspensionVelLeft,  dt);
  this._updateSuspension( this.cfg.outerZ, this.suspensionOffsetsRight, this.suspensionVelRight, dt);
  this._updateAxelSuspension(dt);
  this._updateRearWheelSuspension(dt);

  const L = this.suspensionOffsetsLeft;
  const R = this.suspensionOffsetsRight;
  const half = L.length / 2;
  const count = L.length + R.length;

  let avgLift = 0, avgFront = 0, avgRear = 0, avgLeft = 0, avgRight = 0;

  if (count > 0) {
    let sumAll = 0, sumFrontL = 0, sumRearL = 0, sumFrontR = 0, sumRearR = 0;
    for (let i = 0; i < L.length; i++) {
      sumAll += L[i] + R[i];
      if (i < half) { sumFrontL += L[i]; sumFrontR += R[i]; }
      else          { sumRearL  += L[i]; sumRearR  += R[i]; }
    }
    avgLift  = sumAll / count;
    avgFront = (sumFrontL + sumFrontR) / (half * 2);
    avgRear  = (sumRearL  + sumRearR)  / (half * 2);
    avgLeft  = (sumFrontL + sumRearL)  / L.length;
    avgRight = (sumFrontR + sumRearR)  / R.length;
  }

  const hullLength = Math.abs(ROAD_WHEEL_X[ROAD_WHEEL_X.length - 1] - ROAD_WHEEL_X[0]);
  const hullWidth  = 1.0;

  const targetPitch = Math.atan2(avgFront - avgRear, hullLength) * 0.6;
  const targetRoll  = Math.atan2(avgRight - avgLeft, hullWidth)  * 0.6;

  this.hullSuspensionY = THREE.MathUtils.lerp(this.hullSuspensionY, avgLift,    Math.min(1, dt * 12));
  this.hullPitch       = THREE.MathUtils.lerp(this.hullPitch,       targetPitch, Math.min(1, dt * 12));
  this.hullRoll        = THREE.MathUtils.lerp(this.hullRoll,        targetRoll,  Math.min(1, dt * 12));

  const suspQ = this._scratchQ2.setFromEuler(
    this._scratchEuler.set(this.hullRoll, 0, -this.hullPitch, 'YXZ')
  );
  if (!this._scratchQ3) this._scratchQ3 = new THREE.Quaternion();
  const suspendedQ   = this._scratchQ3.copy(renderQ).multiply(suspQ);
  const suspendedPos = this._scratchSuspPos.set(pos.x, pos.y + this.hullSuspensionY, pos.z);

  this.bodyGroup.position.copy(suspendedPos);
  this.bodyGroup.quaternion.copy(suspendedQ);

  // No drive input after death — tracks just react to the suspension/
  // terrain contact with zero throttle, so wheels/belts settle instead of
  // continuing to grind forward.
  this.trackLeft?.update(
    dt, 0,
    suspendedPos, suspendedQ,
    this.suspensionOffsetsLeft,
    this.world, this.rigidBody
  );
  this.trackRight?.update(
    dt, 0,
    suspendedPos, suspendedQ,
    this.suspensionOffsetsRight,
    this.world, this.rigidBody
  );
}

  // ── Drive ─────────────────────────────────────────────────────────────────

applyInput(keys, dt) {
  if (!this.rigidBody) return { leftThrottle: 0, rightThrottle: 0 };
  if (this._inputLocked) return { leftThrottle: 0, rightThrottle: 0 };
  try {
    if (this.rigidBody.isValid && !this.rigidBody.isValid()) {
      return { leftThrottle: 0, rightThrottle: 0 };
    }
  } catch (_) {
    return { leftThrottle: 0, rightThrottle: 0 };
  }

  // ── Throttle (W/S) — automatic transmission ───────────────────────────
  // W/S no longer shift gears on press; they set throttle *intent*, which
  // ramps smoothly (no instant 0→full accel/brake). The actual gear is
  // picked automatically every frame from current road speed.
  const rot = this.rigidBody.rotation();
  const q   = this._scratchQ.set(rot.x, rot.y, rot.z, rot.w);
  const fwd = this._scratchFwd.set(-1, 0, 0).applyQuaternion(q);

  const vel0         = this.rigidBody.linvel();
  const currentSpeed = fwd.dot(this._scratchVel.set(vel0.x, vel0.y, vel0.z));  // signed: +forward, -reverse

  const THROTTLE_RAMP_SPEED = 2.5;   // ← tune: higher = snappier pedal response
  let throttleTarget = 0;
  if (keys.forward && !keys.backward)      throttleTarget =  1;
  else if (keys.backward && !keys.forward) throttleTarget = -1;

  this.throttle = THREE.MathUtils.lerp(
    this.throttle,
    throttleTarget,
    Math.min(1, dt * THROTTLE_RAMP_SPEED)
  );

  // ── Automatic gear selection ───────────────────────────────────────────
  // Walks up/down the same per-gear top-speed table (this.gearMaxSpeed)
  // that used to be indexed by the manually-shifted gear, using simple
  // speed-ratio shift points: shift up past 85% of the current gear's top
  // speed, shift down below 65% of the gear below it.
  const SHIFT_UP_RATIO   = 0.85;
  const SHIFT_DOWN_RATIO = 0.65;
  const MIN_TIME_IN_GEAR = 0.45;   // ← seconds a gear must be held before another shift is allowed (tune to taste)
  const prevGear = this.gear;

  this._gearShiftTimer = (this._gearShiftTimer ?? 0) + dt;

  if (Math.abs(throttleTarget) < 0.001) {
    // No pedal input at all (W/S released) → settle in neutral,
    // even if A/D turning-in-place is causing residual speed/drift.
    this.gear = 0;
    this._gearShiftTimer = 0;   // reset so the next gear taken (1 or -1) gets a full cooldown window too
  } else if (throttleTarget > 0 || (this.gear >= 0 && throttleTarget === 0)) {
    // Forward intent, or coasting forward with the pedal released
    let g = this.gear > 0 ? this.gear : 1;
    const speedAbs = Math.max(0, currentSpeed);
    const canShift = this._gearShiftTimer >= MIN_TIME_IN_GEAR;

    if (canShift && g < this.topGear && speedAbs > (this.gearMaxSpeed[String(g)] ?? Infinity) * SHIFT_UP_RATIO) {
      g++;
      this._gearShiftTimer = 0;
    } else if (canShift && g > 1 && speedAbs < (this.gearMaxSpeed[String(g - 1)] ?? 0) * SHIFT_DOWN_RATIO) {
      g--;
      this._gearShiftTimer = 0;
    }
    this.gear = g;
  } else {
    // Reverse intent, or coasting backward with the pedal released
    let g = this.gear < 0 ? this.gear : -1;
    const speedAbs = Math.max(0, -currentSpeed);
    const canShift = this._gearShiftTimer >= MIN_TIME_IN_GEAR;

    if (canShift && -g < this.reverseGears && speedAbs > (this.gearMaxSpeed[String(g)] ?? Infinity) * SHIFT_UP_RATIO) {
      g--;
      this._gearShiftTimer = 0;
    } else if (canShift && -g > 1 && speedAbs < (this.gearMaxSpeed[String(g + 1)] ?? 0) * SHIFT_DOWN_RATIO) {
      g++;
      this._gearShiftTimer = 0;
    }
    this.gear = g;
  }

  if (this.gear !== prevGear) window._tankGearChanged = true;

  const maxSpeed   = this.gearMaxSpeed[String(this.gear)] ?? 0;
  const accel      = this.gearAccel[String(this.gear)]    ?? 0;
  const turnTorque = this.turnTorque;
  const brakeDrag  = 3.0;

  const isTurningKey = (keys.left || keys.right) && !(keys.left && keys.right);
  const TURN_SPEED_FACTOR = 0.72;  // ← tune: how much forward speed drops while turning

  // Pedal value now carries both direction AND magnitude (smoothed), so it
  // replaces the old hard ±1 "throttle direction from gear" logic directly.
  const throttle = this.throttle;

  if (Math.abs(throttle) > 0.001 && maxSpeed > 0) {
    const turnFactor        = isTurningKey ? TURN_SPEED_FACTOR : 1.0;
    const effectiveMaxSpeed = maxSpeed * turnFactor;

    if (Math.abs(currentSpeed) < effectiveMaxSpeed) {
      const force = this._scratchForce.copy(fwd).multiplyScalar(throttle * accel * 2200 * turnFactor * dt);
      this.rigidBody.applyImpulse({ x: force.x, y: 0, z: force.z }, true);
    }
  } else {
    // No pedal input (or pedal hasn't built up past the threshold yet) —
    // coast with brake drag, same as the old neutral-gear case.
    const vel = this.rigidBody.linvel();
    this.rigidBody.applyImpulse({
      x: -vel.x * brakeDrag * dt,
      y: 0,
      z: -vel.z * brakeDrag * dt,
    }, true);
  }

// Wheeled/trackless tanks (no road wheels, sprocket, or idler) shouldn't be
// able to pivot in place while idle — only tracked tanks can do that.
const isWheeledTank = !this.cfg.roadWheelX || this.cfg.roadWheelX.length === 0;

const turnMultiplier = this.gear === 0 ? 800 : 400;
// While reversing, mirror the turn torque so A/D match the tank's travel
// direction (backing up + left should curve it the way you'd expect
// looking over your shoulder), instead of always spinning the hull the
// same way regardless of forward/reverse.
const turnSign = this.gear < 0 ? -1 : 1;
if (!(isWheeledTank && this.gear === 0)) {
  if (keys.left)  this.rigidBody.applyTorqueImpulse({ x: 0, y:  turnSign * turnTorque * turnMultiplier * dt, z: 0 }, true);
  if (keys.right) this.rigidBody.applyTorqueImpulse({ x: 0, y: -turnSign * turnTorque * turnMultiplier * dt, z: 0 }, true);
}

// ── Real-time speed-based belt ratio ─────────────────────────────────────
// Drive belt speed from the tank's actual current velocity — so it slows
// on uphill terrain, speeds up downhill, etc., matching real physics
// rather than a fixed per-gear value.
//
// IMPORTANT: the normalizing "top speed" must match the direction the
// tank is currently in. Forward's top gear tops out at maxSpeed, but
// reverse's top gear tops out much lower (see gearMaxSpeed[-reverseGears]).
// Previously this always normalized against the FORWARD top speed even
// while reversing, which happened to mostly cancel out for reverse (both
// numerator and denominator scaled down together) but caused forward to
// overshoot at every gear upshift — the gearRatio floor term jumped ahead
// of curSpeed the instant a higher gear was selected, before the physics
// had actually caught up, making the belt look like it was running ahead
// of (and then "catching down" to) the tracked wheels.
const isReversing = this.gear < 0;
const topGearSpeed = isReversing
  ? Math.abs(this.gearMaxSpeed[String(-this.reverseGears)] ?? ms * 0.5)
  : (this.gearMaxSpeed[String(this.topGear)] ?? ms);

const curVel       = this.rigidBody.linvel();
const curSpeed     = fwd.dot(this._scratchVel.set(curVel.x, curVel.y, curVel.z));
const realRatio    = Math.min(1, Math.abs(curSpeed) / (topGearSpeed || 1));

// Fallback ratio for neutral/static cases where real speed is ~0
// (e.g. the instant a gear is selected from a standstill) — without this,
// the belt would stay motionless until the tank physically starts moving.
// Uses the SAME direction-correct topGearSpeed as above, and is damped
// (not an instant jump) so a gear upshift doesn't make the belt leap ahead
// of the tank's actual road speed.
const absMaxSpeed  = Math.abs(maxSpeed);
const gearRatioTarget = absMaxSpeed / (topGearSpeed || 1);

this._smoothedGearRatio = THREE.MathUtils.lerp(
  this._smoothedGearRatio ?? gearRatioTarget,
  gearRatioTarget,
  Math.min(1, dt * 4)   // ramps over ~0.25s instead of snapping on upshift
);

// Use real-time speed ratio whenever the tank is actually moving;
// otherwise fall back to the smoothed gear ratio so the belt still
// reflects intent (e.g. throttle held but speed hasn't built up yet).
const beltRatio = Math.max(realRatio, this._smoothedGearRatio * 0.15);

// In neutral, use full ratio (1.0) for turning so tracks spin at max speed
const TURN_RATIO = this.gear === 0 ? 0.3 : 1.0; //old was gearRatio -> changed to 1.0

let leftThrottle  = throttle * beltRatio;
let rightThrottle = throttle * beltRatio;

if (keys.left  && !keys.forward && !keys.backward) { leftThrottle =  TURN_RATIO; rightThrottle = -TURN_RATIO; }
if (keys.right && !keys.forward && !keys.backward) { leftThrottle = -TURN_RATIO; rightThrottle =  TURN_RATIO; }

// While moving in gear 1-3: outer track gets full speed, inner track slows
// down (but never reverses) — both tracks always move in the SAME
// direction as the tank's travel, just at different rates, like a real
// skid-steer/tank turn while driving forward or backward. Same side gets
// slowed down regardless of forward/reverse — the direction sign is
// already carried by leftThrottle/rightThrottle themselves, so this block
// should only decide WHICH side is the inner (slow) track.
const isMoving = this.gear > 0 || this.gear < 0;
const INNER_TRACK_RATIO = 0.35;   // ← tune: 0 = inner track stops, 1 = no differential (straight)

if (keys.left  && isMoving) { leftThrottle  *= 1.0; rightThrottle *= INNER_TRACK_RATIO; }
if (keys.right && isMoving) { rightThrottle *= 1.0; leftThrottle  *= INNER_TRACK_RATIO; }

const THROTTLE_SMOOTH_SPEED = 10;  // ← tune: higher = snappier, lower = smoother/slower ramp
const t = Math.min(1, dt * THROTTLE_SMOOTH_SPEED);

this._smoothedLeftThrottle  = THREE.MathUtils.lerp(this._smoothedLeftThrottle,  leftThrottle,  t);
this._smoothedRightThrottle = THREE.MathUtils.lerp(this._smoothedRightThrottle, rightThrottle, t);

return {
  leftThrottle:  this._smoothedLeftThrottle,
  rightThrottle: this._smoothedRightThrottle,
};
}

  // ── Main update ───────────────────────────────────────────────────────────

update(dt, keys, camera, mouse, cycleData = null) {

  // ── After death — only animate ejected turret, explosions, and let any
  // still-alive smoke particles finish fading out instead of freezing
  // mid-air the instant the tank dies ─────────────────────────────────────
  if (this.isDead) {
    // ── Keep the wreck's suspension/hull reacting to terrain for a couple
    // seconds instead of freezing on the exact frame it died — only while
    // the rigid body is still alive (i.e. the death-freeze timer hasn't
    // run out yet).
    if (this.rigidBody && this._deathFreezeTimer > 0) {
      this._deathFreezeTimer -= dt;
      this._updatePostDeathPhysics(dt);
      if (this._deathFreezeTimer <= 0) {
        this._finalizeDeathFreeze();
      }
    }

    if (this._ejectedTurret) {
      const vel = this._ejectedTurret.userData.vel;
      vel.y -= 12 * dt;
      this._ejectedTurret.position.addScaledVector(vel, dt);
      const av = this._ejectedTurret.userData.angVel;
      this._ejectedTurret.rotation.x += av.x * dt;
      this._ejectedTurret.rotation.y += av.y * dt;
      this._ejectedTurret.rotation.z += av.z * dt;
    }

    // ── Keep ticking weapon systems so any bullet/beam/shell still mid-
    // flight the instant the tank died keeps animating/fading out instead
    // of freezing at its last frame ───────────────────────────────────────
    this.bulletSystem?.update(dt);
    this.mgSystem?.update(dt);
    this.rocketSystem?.update(dt);
    this._smokeGrenadeSystem?.update(dt);

    this.explosionSystem?.update(dt, camera, this.renderer);
    if (this.smokeSystem) this.smokeSystem.update(cycleData);
    this.dustSystem?.tickIdle(dt);
    return;
  }

  if (!this.rigidBody) return;

  const { leftThrottle, rightThrottle } = this.applyInput(keys, dt);
  // if (this.tankLights) this.tankLights.update();
  this._updateCamoWind(dt);

  const rot    = this.rigidBody.rotation();
  const worldQ = this._scratchQ.set(rot.x, rot.y, rot.z, rot.w);   // raw rotation — used below for the recoil impulse (a real physics force, must stay accurate)

  // ── Interpolated transform for rendering — smooths visuals across the
  // gap between render FPS (e.g. 85-90) and the fixed 60Hz physics tick ───
  const pos = this._renderPos;
  if (!this._scratchQ4) this._scratchQ4 = new THREE.Quaternion();
  const renderQ = this._scratchQ4.copy(this._renderQuat);

  // Per-side suspension raycasts
  this._updateSuspension(-this.cfg.outerZ, this.suspensionOffsetsLeft,  this.suspensionVelLeft,  dt);
  this._updateSuspension( this.cfg.outerZ, this.suspensionOffsetsRight, this.suspensionVelRight, dt);
  this._updateAxelSuspension(dt);
  this._updateRearWheelSuspension(dt);

    // ── Hull suspension effect — zero array allocations ────────────────────
    const L = this.suspensionOffsetsLeft;
    const R = this.suspensionOffsetsRight;
    const half = L.length / 2;
    const count = L.length + R.length;

    let avgLift = 0, avgFront = 0, avgRear = 0, avgLeft = 0, avgRight = 0;

    // Guard against tanks with no road wheels at all (roadWheelX: []) —
    // without this, count/L.length/R.length are all 0 and every average
    // below divides by zero, producing NaN that poisons bodyGroup's
    // position/quaternion and makes the whole tank vanish.
    if (count > 0) {
      let sumAll = 0, sumFrontL = 0, sumRearL = 0, sumFrontR = 0, sumRearR = 0;
      for (let i = 0; i < L.length; i++) {
        sumAll += L[i] + R[i];
        if (i < half) { sumFrontL += L[i]; sumFrontR += R[i]; }
        else          { sumRearL  += L[i]; sumRearR  += R[i]; }
      }
      avgLift  = sumAll / count;
      avgFront = (sumFrontL + sumFrontR) / (half * 2);
      avgRear  = (sumRearL  + sumRearR)  / (half * 2);
      avgLeft  = (sumFrontL + sumRearL)  / L.length;
      avgRight = (sumFrontR + sumRearR)  / R.length;
    }

    const hullLength  = Math.abs(ROAD_WHEEL_X[ROAD_WHEEL_X.length - 1] - ROAD_WHEEL_X[0]);
    const hullWidth   = 1.0;
    // Inertial pitch from acceleration/braking
const vel = this.rigidBody.linvel();
const fwd = this._scratchFwd.set(-1, 0, 0).applyQuaternion(worldQ);
const currentSpeed = fwd.dot(this._scratchVel.set(vel.x, vel.y, vel.z));
const rawAccel = dt > 0.0001
  ? (currentSpeed - (this._prevSpeed ?? currentSpeed)) / dt
  : 0;
this._prevSpeed = currentSpeed;

// Smooth the acceleration value to remove per-frame jitter
// Smooth the acceleration value to remove per-frame jitter
this._smoothAccel = THREE.MathUtils.lerp(
  this._smoothAccel ?? 0,
  rawAccel,
  Math.min(1, dt * 3)   // was dt * 5 — slower response = less high-freq noise passed through
);
const inertiaPitch = this._smoothAccel * 0.008;

const targetPitch = Math.atan2(avgFront - avgRear, hullLength) * 0.6 + inertiaPitch;

    const targetRoll  = Math.atan2(avgRight - avgLeft, hullWidth)  * 0.6;

    this.hullSuspensionY = THREE.MathUtils.lerp(this.hullSuspensionY, avgLift,    Math.min(1, dt * 12));
    this.hullPitch       = THREE.MathUtils.lerp(this.hullPitch,       targetPitch, Math.min(1, dt * 12));
    this.hullRoll        = THREE.MathUtils.lerp(this.hullRoll,        targetRoll,  Math.min(1, dt * 12));

    // ── Suspension-adjusted transform (shared by bodyGroup + tracks) ───────
// Reuse _scratchQ2 for suspQ, _scratchEuler for the Euler — no allocations
const suspQ = this._scratchQ2.setFromEuler(
  this._scratchEuler.set(this.hullRoll, 0, -(this.hullPitch + this._firePitchAmount * 0.08), 'YXZ')
);
    // worldQ is already a scratch — clone into suspendedQ by multiplying in place
    // But we still need worldQ intact for the recoil block below, so copy first
    if (!this._scratchQ3) this._scratchQ3 = new THREE.Quaternion();
const suspendedQ = this._scratchQ3.copy(renderQ).multiply(suspQ);
    const suspendedPos = this._scratchSuspPos.set(pos.x, pos.y + this.hullSuspensionY, pos.z);

    this.bodyGroup.position.copy(suspendedPos);
    this.bodyGroup.quaternion.copy(suspendedQ);

    this.trackLeft?.update(
      dt, leftThrottle,
      suspendedPos, suspendedQ,
      this.suspensionOffsetsLeft,
      this.world, this.rigidBody
    );
    this.trackRight?.update(
      dt, rightThrottle,
      suspendedPos, suspendedQ,
      this.suspensionOffsetsRight,
      this.world, this.rigidBody
    );
    // Turret
// Turret
if (this.turretController && this.turretController.turret) {
  this.bodyGroup.getWorldPosition(this._scratchWorldPos);
  this.turretController.update(dt, camera, mouse, this._scratchWorldPos, this.world, this.rigidBody, this.scopeSystem);

  // ── Sync MG_Point orientation to barrel (independent node fix) ───────
if (this._mgPoint && this._mgAimNode && this.turretController) {
  if (this.cfg.mgFireStraight) {
    // Fire straight along parent's forward — no yaw/pitch correction
    this._mgAimNode.quaternion.identity();
  } else {
    const aimTarget = this.turretController.aimTarget;

    if (aimTarget) {
      const mgWorldPos = this._scratchWorldPos;
      this._mgPoint.getWorldPosition(mgWorldPos);

      const worldDir = this._mgScratchDir
        .subVectors(aimTarget, mgWorldPos);

      if (worldDir.lengthSq() > 0.001) {
        worldDir.normalize();

        const tankWorldQ = this._scratchQ2;
        this.bodyGroup.getWorldQuaternion(tankWorldQ);

        const flatFwd = this._mgScratchFwd
          .set(-1, 0, 0)
          .applyQuaternion(tankWorldQ);
        flatFwd.y = 0;
        flatFwd.normalize();

        const worldUp   = this._mgScratchUp;
        const flatRight = this._mgScratchRight
          .crossVectors(worldUp, flatFwd)
          .normalize();

        const localX = worldDir.dot(flatFwd);
        const localY = worldDir.dot(worldUp);
        const localZ = worldDir.dot(flatRight);

        let yaw   = Math.atan2(localZ, localX);
        let pitch = Math.atan2(localY, Math.sqrt(localX * localX + localZ * localZ));

        yaw   = THREE.MathUtils.clamp(yaw,   this.cfg.mgYawMin,   this.cfg.mgYawMax);
        pitch = THREE.MathUtils.clamp(pitch, this.cfg.mgPitchMin, this.cfg.mgPitchMax);

        const cosPitch = Math.cos(pitch);
        const clampedDir = this._mgScratchClamped.set(
          flatFwd.x * Math.cos(yaw) * cosPitch + flatRight.x * Math.sin(yaw) * cosPitch + worldUp.x * Math.sin(pitch),
          flatFwd.y * Math.cos(yaw) * cosPitch + flatRight.y * Math.sin(yaw) * cosPitch + worldUp.y * Math.sin(pitch),
          flatFwd.z * Math.cos(yaw) * cosPitch + flatRight.z * Math.sin(yaw) * cosPitch + worldUp.z * Math.sin(pitch)
        ).normalize();

        const worldQ = this._mgScratchWorldQ
          .setFromUnitVectors(this._mgScratchLocalFwd, clampedDir);

        if (this._mgAimNode.parent) {
          const parentWorldQ = this._mgScratchParentQ;
          this._mgAimNode.parent.getWorldQuaternion(parentWorldQ);
          parentWorldQ.invert();
          this._mgAimNode.quaternion
            .multiplyQuaternions(parentWorldQ, worldQ);
        } else {
          this._mgAimNode.quaternion.copy(worldQ);
        }
      }
    } else {
      this._mgAimNode.quaternion.identity();
    }
  }
}
}

    // ── Rocket rack (Calliope) pitch sync — Calliope isn't a child of the
    // barrel node, so its local pitch has to be driven manually each frame
    // to match the barrel's current elevation. Assumes the barrel's pitch
    // is expressed on its local X axis (same convention as barrelMinAngle/
    // barrelMaxAngle clamp the barrel to) — adjust the axis below if your
    // rig pitches on a different local axis.
    if (this._calliopeNode && this._calliopeBaseQ && this.turretController?.barrel) {
      const barrelPitch = this.turretController.barrel.rotation.x;
      this._calliopeDeltaQ.setFromAxisAngle(this._calliopeAxisX, barrelPitch);
      this._calliopeNode.quaternion.copy(this._calliopeBaseQ).multiply(this._calliopeDeltaQ);
    }

    // Bullets
    this.bulletSystem.update(dt);
    this.mgSystem?.update(dt);
    this.rocketSystem?.update(dt);
    this._smokeGrenadeSystem?.update(dt);
    this.explosionSystem.update(dt, camera, this.renderer);
    
    if (this.smokeSystem) {
      // ── Idle-rev smoke boost — true when the tank is essentially
      // stationary but the player is pressing a drive key (revving in
      // place). `currentSpeed` here is the same variable already computed
      // above for the inertia-pitch calc.
      const IDLE_SPEED_THRESHOLD = 2.0;   // m/s — tune to taste
      const isIdle = Math.abs(currentSpeed) < IDLE_SPEED_THRESHOLD;
      const anyDriveKey = !!(keys.forward || keys.backward || keys.left || keys.right);
      this.smokeSystem.setRevBoost(isIdle && anyDriveKey);

      this.smokeSystem.update(cycleData);
    }

    // ── Camera shake — damage-hit impulse ──────────────────────────────────
    if (this._shakeElapsed !== undefined && this._shakeElapsed < this._shakeDuration) {
      this._shakeElapsed += dt;
      const t         = this._shakeElapsed / this._shakeDuration;
      const envelope  = Math.pow(1 - t, 2);   // quadratic decay
      const offsetX   = Math.sin(this._shakeElapsed * this._shakeFrequency * Math.PI * 2) * this._shakeIntensity * envelope;
      const offsetY   = Math.cos(this._shakeElapsed * this._shakeFrequency * Math.PI * 1.7) * this._shakeIntensity * 0.5 * envelope;
      this._hitShakeOffset.set(offsetX, offsetY, 0);
    } else {
      this._hitShakeOffset.set(0, 0, 0);
    }

    // ── Camera shake — weapon-fire recoil, independent of (and additive
    // with) the damage-hit shake above, so firing reads as its own kick
    // stacked on top of any concurrent hit-shake.
    if (this._fireShakeElapsed !== undefined && this._fireShakeElapsed < this._fireShakeDuration) {
      this._fireShakeElapsed += dt;
      const ft        = this._fireShakeElapsed / this._fireShakeDuration;
      const fEnvelope = Math.pow(1 - ft, 2);
      const fOffsetX  = Math.sin(this._fireShakeElapsed * this._fireShakeFrequency * Math.PI * 2 + 1.3) * this._fireShakeIntensity * fEnvelope;
      const fOffsetY  = Math.cos(this._fireShakeElapsed * this._fireShakeFrequency * Math.PI * 2.3) * this._fireShakeIntensity * 0.6 * fEnvelope;
      this._fireShakeOffset.set(fOffsetX, fOffsetY, 0);
    } else {
      this._fireShakeOffset.set(0, 0, 0);
    }

    // ── Combined offset — this is what main.js's camera code actually
    // reads (`tank._shakeOffset`) and applies to camera.position.
    this._shakeOffset = this._shakeOffset ?? new THREE.Vector3();
    this._shakeOffset.set(
      this._hitShakeOffset.x + this._fireShakeOffset.x,
      this._hitShakeOffset.y + this._fireShakeOffset.y,
      0
    );

    // Hull recoil spring
const STIFFNESS = 12;
const DAMPING   = 5;
this.hullRecoilVelocity += (-STIFFNESS * this.hullRecoilAmount) * dt;
this.hullRecoilVelocity *= (1 - DAMPING * dt);
this.hullRecoilAmount   += this.hullRecoilVelocity * dt;

// Fire pitch spring — hull dips forward on fire then springs back
const PITCH_STIFFNESS    = 100;
const PITCH_DAMPING      = 4;
this._firePitchVelocity += (-PITCH_STIFFNESS * this._firePitchAmount) * dt;
this._firePitchVelocity *= (1 - PITCH_DAMPING * dt);
this._firePitchAmount   += this._firePitchVelocity * dt;

    // Apply as backwards impulse on rigid body
// Apply as backwards impulse on rigid body
if (this.rigidBody && Math.abs(this.hullRecoilVelocity) > 0.001) {
      const fwd = this._scratchFwd.set(1, 0, 0).applyQuaternion(worldQ);
      this.rigidBody.applyImpulse({
        x: fwd.x * this.hullRecoilVelocity * 80 * dt,
        y: 0,
        z: fwd.z * this.hullRecoilVelocity * 80 * dt,
      }, true);
    }

if (this.dustSystem && this.rigidBody) {
  const avgThrottle = (leftThrottle + rightThrottle) / 2;
  this.dustSystem.update(dt, avgThrottle, cycleData);
}

// ── Axle steering + spin ──────────────────────────────────────────────────
if (this.cfg.enableAxelWheels && this._axelNodes.length > 0) {
  const targetAngle = keys.left  ?  AXEL_MAX_ANGLE
                    : keys.right ? -AXEL_MAX_ANGLE
                    : 0;

  this._axelAngle = THREE.MathUtils.lerp(
    this._axelAngle,
    targetAngle,
    Math.min(1, dt * AXEL_STEER_SPEED)
  );

  // Spin from forward velocity
const vel = (this.rigidBody && !this.isDead) ? this.rigidBody.linvel() : null;
  const fwd = this._scratchFwd.set(-1, 0, 0).applyQuaternion(worldQ);
  const currentSpeed = vel
    ? fwd.dot(this._scratchVel.set(vel.x, vel.y, vel.z))
    : 0;

  const WHEEL_RADIUS = 0.30;
  this._axelSpinAngle = (this._axelSpinAngle ?? 0) + (currentSpeed / WHEEL_RADIUS) * dt;

  const s = this.cfg.modelScale || 1;   // convert world-space offset → node-local space

  for (let i = 0; i < this._axelNodes.length; i++) {
    const axel = this._axelNodes[i];
    // Y = steer, Z = spin — applied together so neither disrupts the other
    axel.rotation.set(this._axelSpinAngle, this._axelAngle, 0, 'YZX');

    // Suspension bob — pushes the wheel up as it compresses against terrain
    const suspOffset = this._axelSuspOffset[i] ?? 0;
    const origY       = this._axelOrigLocalY[i] ?? axel.position.y;
    axel.position.y   = origY + suspOffset / s;   // ← fixed: was `origY - suspOffset / s`
  }
}


// ── Rear wheel spin + optional steering — trackless/wheeled tanks ────────
if (this._rearWheelNodes.length > 0) {
  const vel = (this.rigidBody && !this.isDead) ? this.rigidBody.linvel() : null;
  const fwd = this._scratchFwd.set(-1, 0, 0).applyQuaternion(worldQ);
  const currentSpeed = vel
    ? fwd.dot(this._scratchVel.set(vel.x, vel.y, vel.z))
    : 0;

  const WHEEL_RADIUS = this.cfg.axelWheelRadius ?? 0.3;
  this._rearWheelSpinAngle = (this._rearWheelSpinAngle ?? 0) + (currentSpeed / WHEEL_RADIUS) * dt;

  // Rear-axle steering — only when explicitly enabled via config. Reads the
  // same left/right keys as the front axle and lerps at the same
  // AXEL_STEER_SPEED so front and rear turn in sync. Currently steers the
  // SAME direction as the front axle — flip the sign below (or the
  // ternary branches) if you want opposite-direction rear-steer instead.
  if (this.cfg.enableRearAxelWheels) {
    const rearTargetAngle = keys.left  ? -AXEL_MAX_ANGLE
                          : keys.right ?  AXEL_MAX_ANGLE
                          : 0;
    this._rearAxelAngle = THREE.MathUtils.lerp(
      this._rearAxelAngle,
      rearTargetAngle,
      Math.min(1, dt * AXEL_STEER_SPEED)
    );
  } else {
    this._rearAxelAngle = 0;
  }

  const s = this.cfg.modelScale || 1;

  for (let i = 0; i < this._rearWheelNodes.length; i++) {
    const rw = this._rearWheelNodes[i];
    rw.rotation.set(this._rearWheelSpinAngle, this._rearAxelAngle, 0, 'YZX');

    const suspOffset = this._rearWheelSuspOffset[i] ?? 0;
    const origY       = this._rearWheelOrigLocalY[i] ?? rw.position.y;
    rw.position.y     = origY + suspOffset / s;   // ← fixed: was `origY - suspOffset / s`
  }
}

// // ── Death dissolve ─────────────────────────────────────────────────────
// // ── Ejected turret animation ───────────────────────────────────────────
// if (this._ejectedTurret) {
//   const vel = this._ejectedTurret.userData.vel;
//   vel.y -= 12 * dt;
//   this._ejectedTurret.position.addScaledVector(vel, dt);
//   const av = this._ejectedTurret.userData.angVel;
//   this._ejectedTurret.rotation.x += av.x * dt;
//   this._ejectedTurret.rotation.y += av.y * dt;
//   this._ejectedTurret.rotation.z += av.z * dt;
// }
}

  // In tank.js
fire(enemyResolver = null) {
    // console.log('[FIRE]', 'weapon:', this.activeWeapon, 'gunType:', this.cfg.gunType, 'system:', this.bulletSystem?.constructor?.name, 'rounds:', this.bulletSystem?.rounds, 'reloading:', this.bulletSystem?._reloading);
    if (this.activeWeapon === 5) {
      // Special weapon (gun or rocket variant) — only valid when
      // enableRockets is true and the GLB had RocketPoint_N nodes (see
      // _loadHullModel).
      if (!this.cfg.enableRockets || !this.rocketSystem) return;
      if (!this.rigidBody) return;
      if (this.specialAmmo <= 0) return;
      if (!this.rocketSystem.isReady) return;
      // Aim toward the same world point the crosshair/MG already converges
      // on (turretController.aimTarget) instead of each RocketPoint's own
      // raw local-forward direction — this is what makes rockets actually
      // land where the reticle is pointing.
      this.rocketSystem.fire(this.rigidBody, enemyResolver, this.turretController?.aimTarget ?? null);
      this.specialAmmo--;
      this.triggerRecoil();
      this.triggerFireShake('rocket');
      return;
    }

    if (this.activeWeapon === 2) {
      if (!this.hasMachineGun) return;   // ← no MG_Point on this model — nothing to fire
      this.mgSystem?.fire(
        this.rigidBody,
        enemyResolver,
        () => {}
      );
      this.triggerFireShake('mg');
      return;
    }

    if (this.activeWeapon === 3) {
      // Smoke grenade — fire from tank position in forward direction
      if (!this.rigidBody) return;
      if (this._smokeGrenadeSystem && !this._smokeGrenadeSystem.isReady) return;   // ← cooldown gate
      const pos = this.rigidBody.translation();
      const rot = this.rigidBody.rotation();
      const q   = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
      const fwd = new THREE.Vector3(-1, 0, 0).applyQuaternion(q).normalize();
      const origin = new THREE.Vector3(pos.x + fwd.x * 2.5, pos.y + 1.2, pos.z + fwd.z * 2.5);
      this._smokeGrenadeSystem?.fire(origin, fwd);
      return;
    }

    // Main gun
    const deflected = this.turretController?.getDeflectedDirection();
this.bulletSystem.fire(
  this.rigidBody,
  () => {
    this.triggerRecoil();
    this.triggerFireShake('main');
    if (this.cfg.gunType !== 3) {   // ← MultiGunSystem has its own 500-round pool; don't show a per-shot reload ring
      const fireRate = this.bulletSystem.reloadTime ?? 2.0;
      this.turretController?.startReloadAnimation(fireRate);
    }
  },
  null,
  deflected,
  false,
  enemyResolver
);
  }

dispose() {
    this.bulletSystem?.dispose();
    this.mgSystem?.dispose();
    this.rocketSystem?.dispose();
    this._smokeGrenadeSystem?.dispose();
    this.explosionSystem?.dispose();
    this.smokeSystem?.stop();
    this.dustSystem?.stop();
    this.turretController?.dispose();
    this.trackLeft?.dispose();
    this.trackRight?.dispose();
    // this.tankLights?.dispose();
    // this.tankLights = null;
    this._camoWindUniforms = null;
    if (this.rigidBody) {
      this.world.removeRigidBody(this.rigidBody);
      this.rigidBody = null;
    }

    [...this._axelDebugOriginMarkers, ...this._axelDebugHitMarkers,
     ...this._rearWheelDebugOriginMarkers, ...this._rearWheelDebugHitMarkers]
      .forEach(m => { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); });

    this.scene.remove(this.bodyGroup);
  }

  isUpsideDown() {
  if (!this.rigidBody) return false;
  const rot = this.rigidBody.rotation();
  const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  return up.y < 0.2; // true when tank's up vector points mostly downward/sideways
}

rightSelf() {
  if (!this.rigidBody) return;
  const pos = this.rigidBody.translation();
  const RAPIER = this.world.__RAPIER__;

  // Build an upright quaternion preserving current yaw only
  const rot = this.rigidBody.rotation();
  const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
  const fwd = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
  fwd.y = 0;
  fwd.normalize();

  const yaw = Math.atan2(-fwd.z, fwd.x);
  const uprightQ = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0, yaw, 0, 'YXZ')
  );

  // Lift slightly above current position to avoid terrain clipping
  this.rigidBody.setTranslation(
    { x: pos.x, y: pos.y + 1.5, z: pos.z },
    true
  );
  this.rigidBody.setRotation(
    { x: uprightQ.x, y: uprightQ.y, z: uprightQ.z, w: uprightQ.w },
    true
  );

  // Kill any angular velocity so it doesn't immediately flip again
  this.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  this.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

  // Add this method to the Tank class in tank.js
// Place it just before the closing } of the class, after dispose()

respawn(position = { x: 0, y: 10, z: 0 }) {
  if (!this.isDead) return;

  // ── Guard against a respawn happening before the death-freeze timer
  // naturally finished (_finalizeDeathFreeze() is otherwise only called
  // from update()'s isDead branch) — without this, _buildPhysics() below
  // would create a second rigid body while the old one is still alive.
  this._finalizeDeathFreeze();

  // Rebuild physics body
  this._buildPhysics(this.world, position);

  // ── Reset render-interpolation state so respawn doesn't blend from the
// pre-death position/orientation ────────────────────────────────────────
this._prevPos.set(position.x, position.y, position.z);
this._renderPos.set(position.x, position.y, position.z);
this._prevQuat.identity();
this._renderQuat.identity();

  // ── Reset the visual bodyGroup transform too — update() stops running
  // the instant isDead is set, so bodyGroup.position/quaternion are left
  // frozen at wherever the tank died. _loadHullModel() (called below via
  // this._loadHullModel()) captures axle wheel world positions and treats
  // them as body-local offsets — that's only valid when bodyGroup is at
  // identity. Without this reset, axle wheel colliders get built at a
  // huge stale offset (the old death position), dragging on the hull and
  // silently killing yaw torque (A/D turning) after every respawn.
  this.bodyGroup.position.set(0, 0, 0);
  this.bodyGroup.quaternion.identity();

  // Reset state
  this.health  = this.maxHealth;
  this.armour  = this.maxArmour ?? this.maxHealth;
  this.isDead  = false;
  this._readyToShowDeath = false;
  this._deathScreenShown = false;
  this._shakeOffset?.set(0, 0, 0);
  this.hullRecoilVelocity = 0;
  this.hullRecoilAmount   = 0;
  this._firePitchVelocity = 0;
  this._firePitchAmount   = 0;
  this.gear        = 0;
  this.throttle    = 0;
  this.specialAmmo = this._initialSpecialAmmo;   // ← fresh special-weapon ammo every life

  // Re-attach ejected turret visually if still present
  if (this._ejectedTurret) {
    this.scene.remove(this._ejectedTurret);
    this._ejectedTurret = null;
  }

// Reconnect bullet / MG systems to new rigid body
  this.bulletSystem?.setRigidBody?.(this.rigidBody);
  this.mgSystem?.setRigidBody?.(this.rigidBody);

  // ── Dust system held a reference to the OLD (now-freed) rigid body ──────
  // It was never updated after _buildPhysics() created a new one, so every
  // frame it called .linvel() on a dead Rapier handle — corrupting Rapier's
  // internal state and causing "recursive use of an object" crashes in
  // unrelated calls like applyImpulse() right after.
  if (this.dustSystem) {
    this.dustSystem.stop?.();
    this.dustSystem = null;
  }
  this._dustNodes = [];   // will be repopulated by _loadHullModel() below

  // ── Reset track-decal stamping state on respawn — otherwise the next
  // _tryStamp() call measures distance from the pre-death position all
  // the way to the new spawn point, and that huge one-frame jump floods
  // _writeStamp() in a tight loop, instantly overwriting most of the
  // decal pool and making it look like old decals "never clear."
  if (this.trackDecalSystem) {
    this.trackDecalSystem._lastPosL = null;
    this.trackDecalSystem._lastPosR = null;
    this.trackDecalSystem._distAccL = 0;
    this.trackDecalSystem._distAccR = 0;
  }

// Rebuild visuals + tracks so turretController/tracks don't reference dead refs
  this.bodyGroup.clear();
  this.smokeSystem?.stop();           // ← stop old emitters before nodes are discarded
  this.smokeSystem = null;
  this._smokeNodes = [];
  this._dustNodes  = [];
  this._axelNodes  = [];
  this._rearWheelNodes = [];
  this._multiGunPoints = [];   // ← gunType 3 — repopulated by _loadHullModel() below
  this._rocketPoints   = [];   // ← rockets — repopulated by _loadHullModel() below
  this._calliopeNode   = null; // ← rocket rack — repopulated by _loadHullModel() below
  this._calliopeBaseQ  = null;
  // ── Do NOT dispose/null the controller here. Its DOM crosshairs, camera
  // ref, enemy/friendly pool refs, and _markedEnemies map must survive
  // across respawns — otherwise lock-on markers silently stop working
  // after the first life (nothing re-wires those refs on a fresh
  // instance). The old turret/barrel mesh refs get cleared and re-pointed
  // in _loadHullModel() below via rebindMeshes(), once the new GLB loads. ─
  this.turretController?.resetOnDeath();

  // ── Dispose old tracks BEFORE building new ones — old instanced meshes
  // were otherwise leaked in the scene and never replaced ──────────────────
  this.trackLeft?.dispose();
  this.trackRight?.dispose();

  this._buildTracks(this.scene);
  // this.tankLights?.dispose();
  //   this.tankLights = null;
    this._camoWindUniforms = null;

  // ── Await + catch — previously fire-and-forget, so any load failure
  // (e.g. GLTFLoader error) silently left the tank with no model/turret
  // and no error surfaced, making it look like respawn "did nothing" ───────
  this._loadHullModel().then(() => {
    this.turretController?.setCamera(this.scopeSystem?.camera);
    this.scopeSystem?.refreshAfterRespawn(this);
    // No _onRespawnRewire needed anymore — same controller instance keeps
    // its _enemyPool/_friendlyPool refs across respawns automatically.
  }).catch((err) => {
    console.error('[Tank] respawn: hull model failed to reload:', err);
  });
}
}