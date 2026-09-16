import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadModel } from './modelLoader.js';
import { EnemyTrackSystem } from './enemyTrack.js';
import { ProjectileBulletSystem, MultiGunSystem } from './bullet.js';

// ── Tunables ─────────────────────────────────────────────────────────────────

const MAX_TANKS          = 3;
const SPAWN_MARGIN       = 20;    // metres from terrain edge to avoid spawning on border
const MIN_SPAWN_DIST     = 90;    // minimum spawn distance from player
const MAX_SPAWN_DIST     = 180;    // maximum spawn distance from player
const SPAWN_ATTEMPTS     = 20;    // tries before giving up

const DETECT_RANGE       = 80;    // metres — player detection radius
const ATTACK_RANGE       = 50;    // metres — start shooting
const STOP_CHASE_RANGE   = 90;    // metres — give up chasing, return to patrol
const SHOOT_INTERVAL      = 3.5;   // seconds between shots
const PATROL_SPEED        = 0.8;   // fraction of maxSpeed
const CHASE_SPEED         = 1.2;
// ── ATTACK-state movement cycle: rotate in place ~45°, then
// forward → pause → backward → pause, repeating. All while still shooting.
const ATTACK_ROTATE_ANGLE   = Math.PI / 4;  // ~45 degrees
const ATTACK_ROTATE_SPEED   = 1.6;          // rad/s while doing the in-place rotate
const ATTACK_MOVE_SPEED     = 0.15;         // fraction of maxSpeed for fwd/back legs — kept low, this is a slow shuffle not a chase
const ATTACK_MOVE_FORCE_MUL = 5000;          // impulse scale for fwd/back legs (lower than _steerToward's 2200 — those legs run continuously with drag to balance; these are short bursts)
const ATTACK_FORWARD_TIME   = 1.4;          // seconds driving forward
const ATTACK_PAUSE_TIME     = 0.8;          // seconds paused (both after fwd and after back)
const ATTACK_BACKWARD_TIME  = 1.2;          // seconds driving backward
const TURN_SPEED          = 3;   // rad/s
const HULL_HALF_EXTENTS  = { x: 1.8, y: 0.7, z: 0.73 };
// ── Forward obstacle-avoidance raycast ("whiskers") ─────────────────────────
const OBSTACLE_LOOKAHEAD      = 14;          // metres — center whisker length
const OBSTACLE_SIDE_LOOKAHEAD = 9;           // metres — side whisker length (shorter)
const OBSTACLE_WHISKER_ANGLE  = Math.PI / 6; // 30° — side whisker angle off forward
const OBSTACLE_AVOID_STRENGTH = 2.0;         // how hard to bend the desired heading
const OBSTACLE_RAY_HEIGHT     = 0.9;         // height above rigidBody origin to cast from
const OBSTACLE_SCAN_INTERVAL  = 0.15;        // seconds between rescans (perf — reused between scans)

// ── Line-of-sight check before firing ───────────────────────────────────────
const LOS_CHECK_INTERVAL      = 0.3;   // seconds between line-of-sight raycast checks
const LOS_BLOCKED_STRAFE_DIST = 12;    // metres — how far to reposition when the shot is blocked
const LOS_STRAFE_SPEED        = 0.6;   // fraction of maxSpeed while repositioning for a clear shot

// ── Capture-point / curve AI tunables ───────────────────────────────────────
const CP_ARRIVE_RADIUS   = 8;     // metres — considered "arrived" at a capture point
const CP_HOLD_RADIUS     = 6;     // metres — loiter radius while holding/defending a point
const CP_ASSIGN_INTERVAL = 2.0;   // seconds between capture-point (re)assignment passes
const CP_HOLD_DURATION   = 30;    // seconds — how long a tank stays on a point before rotating
const CURVE_SPEED_UNITS  = 6;     // world units/sec at PATROL_SPEED==1 while following the curve
const SQUAD_MAX_SIZE     = 2;     // tanks per convoy following one curve leader
const TRAIL_SAMPLE_DT    = 0.15;  // seconds between leader trail recordings
const TRAIL_FOLLOW_GAP   = 6;     // trail samples between each tank in the convoy

const HULL_TURN_INTERVAL  = 0.12;   // seconds between hull rotation updates
const HULL_ANGLE_THRESHOLD = 0.08;  // radians — don't turn if already close enough

const STUCK_SAMPLE_INTERVAL = 1.0;   // seconds between progress samples
const STUCK_MIN_PROGRESS    = 1.5;   // metres — must move at least this far per sample
const STUCK_TRIGGER_TIME    = 2.5;   // seconds of no-progress before we call it "stuck"
const STUCK_REPLAN_COOLDOWN = 3.0;   // seconds to wait before allowing another forced replan

const MG_GUN_POINT_NAME = 'MG_Point';   // ← rename to match your tank model's actual MG mount node name

// Shared geometry & material for the placeholder hull (used until GLB loads)
let _sharedHullGeo  = null;
let _sharedHullMat  = null;
// let _sharedGLBModel = null;   // Promise<THREE.Group> — loaded once, cloned per tank

function _getSharedHullGeo() {
  if (!_sharedHullGeo) _sharedHullGeo = new THREE.BoxGeometry(
    HULL_HALF_EXTENTS.x * 2,
    HULL_HALF_EXTENTS.y * 2,
    HULL_HALF_EXTENTS.z * 2
  );
  return _sharedHullGeo;
}
function _getSharedHullMat() {
  if (!_sharedHullMat) _sharedHullMat = new THREE.MeshStandardMaterial({
    color: 0x4a5c3a, roughness: 0.85, metalness: 0.2,
  });
  return _sharedHullMat;
}

// Load the GLB once, return a promise; subsequent calls reuse the same promise.
// Map<modelPath, Promise<THREE.Group>> — one entry per unique GLB
const _sharedGLBModels = new Map();

function _getSharedModel(modelPath = '/model/Tank_Tiger_L.glb') {
  if (!_sharedGLBModels.has(modelPath)) {
    _sharedGLBModels.set(
      modelPath,
      import('./modelLoader.js').then(({ loadModel }) => loadModel(modelPath))
    );
  }
  return _sharedGLBModels.get(modelPath);
}

// ── FSM states ────────────────────────────────────────────────────────────────

// AFTER
// AFTER
export const STATE = Object.freeze({
  IDLE:          'IDLE',
  TRAVEL:        'TRAVEL',        // moving toward an assigned capture point
  HOLDING:       'HOLDING',       // loitering on / defending a capture point
  PATROL_CURVE:  'PATROL_CURVE',  // following (or convoying behind) the Blender curve
  ENGAGE:        'ENGAGE',        // closing distance on a detected player
  ATTACK:        'ATTACK',        // stopped, turret tracking + shooting
  DEAD:          'DEAD',
  ESCORT:        'ESCORT',        // friendly-only: following/guarding the player
});

// ── Build a trackCfg object from a tankDef JSON entry ────────────────────────
// Falls back to hardcoded defaults so existing code still works without a def.

export function _buildTrackCfgFromDef(tankDef) {
  const c = tankDef?.config ?? {};

  const roadWheelX = c.roadWheelX ?? [-1.35, -0.80, -0.25, 0.30, 0.85, 1.35];
  const enableInAndOutWheels = c.enableInOutWheels ?? true;

  function expandWheelPositions(wxArr) {
    const spacing = (wxArr[1] - wxArr[0]) * 0.5;
    const out = [];
    wxArr.forEach((x, i) => {
      out.push(x);
      const innerX = i < wxArr.length - 1 ? x + spacing : x - spacing;
      out.push(innerX);
    });
    return out;
  }

  const roadWheelXPositions = enableInAndOutWheels
    ? expandWheelPositions(roadWheelX)
    : roadWheelX;

  // const gunType = c.gunType ?? 1;

  return {
    roadWheelX,
    roadWheelXPositions,
    roadWheelY:                c.roadWheelY               ?? -0.22,
    sprocketX:                 c.sprocketX                ??  1.85,
    sprocketY:                 c.sprocketY                ?? -0.08,
    idlerX:                    c.idlerX                   ?? -1.85,
    idlerY:                    c.idlerY                   ??  0.12,
    returnRollers:             c.returnRollers            ?? [],
    modelScale:                c.modelScale               ?? 2.3,
    modelOffsetY:              c.modelOffsetY             ?? 0.45,
    modelRotY:                 c.modelRotY                ?? -90,
    enableInAndOutWheels,

    // ── Bogie ──────────────────────────────────────────────────────────────
    enableBogieWheels:         c.enableBogieWheels         ?? false,
    bogieSystemType:           c.bogieSystemType           ?? 1,
    bogieWheelSystemSize:      c.bogieWheelSystemSize      ?? 1.0,
    bogieWheelType:            c.bogieWheelType            ?? 1,
    bogieArmType:              c.bogieArmType              ?? 1,
    bogieArmLength:            c.bogieArmLength            ?? 0.28,
    bogieArmAngleRange:        c.bogieArmAngleRange        ?? 15,

    // ── Wheel types ────────────────────────────────────────────────────────
    enableSteampunkWheel:      c.enableSteampunkWheel      ?? false,
    sprocketWheelType:         c.sprocketWheelType         ?? 1,
    idlerWheelType:            c.idlerWheelType            ?? 5,
    roadWheelType:             c.roadWheelType             ?? 1,
    wheelColor:                c.wheelColor                ?? 0xfcd6a9,

    // ── Geometry ───────────────────────────────────────────────────────────
    outerZ:                    c.outerZ                    ??  1.0,
    rootTrackWidth:            c.rootTrackWidth            ??  1.0,
    roadWheelRadius:           c.roadWheelRadius           ??  0.25,
    sprocketRadius:            c.steampunkSprocketRadius   ??  0.20,
    idlerRadius:               c.steampunkIdlerRadius      ??  0.14,
    steampunkSprocketRadius:   c.steampunkSprocketRadius   ??  0.20,
    steampunkIdlerRadius:      c.steampunkIdlerRadius      ??  0.20,
    steampunkPistonReach:      c.steampunkPistonReach      ??  0.5,
    idlerTransitionSag:        c.idlerTransitionSag        ??  0.05,
    sprocketTransitionSag:     c.sprocketTransitionSag     ??  0.1,
    topRunSag:                 c.topRunSag                 ??  0.06,
    bottomRunSag:              c.bottomRunSag              ??  0.02,
    hideLastRw:                c.hideLastRw                ?? false,
    beltType:                  c.beltType                  ??  1,
    trackPieceCount:           c.trackPieceCount           ?? 70,
    enableTorsionBars:         c.enableTorsionBars         ?? false,
    torsionArmAngle:           c.torsionArmAngle           ?? (-Math.PI * 0.18 + Math.PI),
    doubleSideTorsionArm:      c.doubleSideTorsionArm      ?? false,
    gunType:                   c.gunType                   ?? 1,
    turretMinAngle:            c.turretMinAngle            ?? -Math.PI,
    turretMaxAngle:            c.turretMaxAngle            ??  Math.PI,
    barrelMinAngle:            c.barrelMinAngle            ?? -0.25,
    barrelMaxAngle:            c.barrelMaxAngle            ??  0.25,
  };
}

// ── Squad — convoy of tanks sharing one curve leader ────────────────────────
// Only the leader samples the patrol curve each frame; followers just steer
// toward a point on the leader's recorded trail (much cheaper than every
// tank independently doing curve/AI queries).
class Squad {
  constructor(id, curve) {
    this.id        = id;
    this.curve     = curve;
    this.leader    = null;
    this.followers = [];
    this.trail     = [];   // recorded {x,y,z} leader positions, newest first
    this._trailTimer = 0;
  }

  recordTrail(pos, dt) {
    this._trailTimer -= dt;
    if (this._trailTimer > 0) return;
    this._trailTimer = TRAIL_SAMPLE_DT;
    this.trail.unshift({ x: pos.x, y: pos.y, z: pos.z });
    const maxLen = (SQUAD_MAX_SIZE + 1) * TRAIL_FOLLOW_GAP + 5;
    if (this.trail.length > maxLen) this.trail.length = maxLen;
  }

  getTrailTarget(followerIndex) {
    const idx = Math.min((followerIndex + 1) * TRAIL_FOLLOW_GAP, this.trail.length - 1);
    return idx >= 0 ? this.trail[idx] : null;
  }
}

// ── EnemyTank ─────────────────────────────────────────────────────────────────

export class EnemyTank {
  constructor(scene, world) {
    this.scene  = scene;
    this.world  = world;
    this.active = false;
    this.state  = STATE.IDLE;

    // Physics
    this.rigidBody = null;

    // Visuals
    this.bodyGroup = new THREE.Group();
    scene.add(this.bodyGroup);
    this.bodyGroup.visible = false;

    // Placeholder hull mesh (visible until GLB finishes cloning)
const placeholderMat = _getSharedHullMat().clone();
placeholderMat.transparent = true;
placeholderMat.opacity     = 1.0;
this._placeholder = new THREE.Mesh(_getSharedHullGeo(), placeholderMat);
    this._placeholder.position.y = 0.3;
    this.bodyGroup.add(this._placeholder);

    // GLB model (cloned from shared load)
    this._modelRoot = null;

    // Tracks
    this.trackLeft  = null;
    this.trackRight = null;

    // AI state
    this.shootTimer    = Math.random() * SHOOT_INTERVAL;
    this._fireSeq      = 0;   // ← ADD — incremented every shot, broadcast so remote clients can replay fire FX
    this.patrolTarget  = new THREE.Vector3();
    this.patrolTimer   = 0;

    // Suspension
    // const wheelCount = 6;
    // this.suspensionL = new Array(wheelCount).fill(0);
    // this.suspensionR = new Array(wheelCount).fill(0);

    this._turretMesh = null;
    this._hullColliderMesh = null;
    this._crewColliderMesh = null;
    this._barrelMesh = null;
    this._gunPoint   = null;
    this._mgGunPoint = null;   // ← NEW — MG muzzle mount, used only for RemotePlayerTank's MG fire FX
    this._explosionSystem = null;
    this._ownBulletSystem = null;   // ProjectileBulletSystem for gunType 2
    this._flagNode  = null;
    this._country   = null;

    // Reusable vectors (avoid allocation in update hot path)
    this._toPlayer = new THREE.Vector3();
    this._fwd      = new THREE.Vector3();
    this._euler    = new THREE.Euler();

    this._quatReuse  = new THREE.Quaternion();
this._fwdVec     = new THREE.Vector3();
this._toPlayerVec = new THREE.Vector3();
this._hullEuler   = new THREE.Euler();

    this.chaseTimer = 0;

    // ── Capture-point / curve-patrol AI state ───────────────────────────────
    this.assignedCP    = null;   // capture point this tank is traveling to / holding
    this.curve         = null;   // shared PatrolCurve reference (unused now, kept for compat)
    this.curveT        = 0;      // normalised position along the curve (0..1)
    this.role          = 'solo'; // 'leader' | 'follower' | 'solo'
    this.squad         = null;
    this._holdAngle    = Math.random() * Math.PI * 2;   // kept for backward compat, no longer used for hull movement
    this._prevJobState = STATE.PATROL_CURVE;
    this._turretIdleTimer  = 0;   // counts down to next random turret sweep while HOLDING
    this._turretIdleTarget = 0;   // random local yaw target for idle turret sweep

    // ── Capture-point round-robin rotation state ────────────────────────────
    this._cpRouteIdx      = null;   // index into pool.capturePoints this tank is targeting
    this._cpHoldTimer     = 0;      // counts down while HOLDING; rotate to next point at 0
    this._readyToRotate   = false;  // set true by HOLDING once timer expires
    this._captureSquadRef = null;   // shared group object — tanks in the same squad move together

    // ── NavGrid pathfinding state ────────────────────────────────────────────
    this.navGrid      = null;
    this._path        = null;
    this._pathIdx     = 0;
    this._pathTarget  = null;

    // ── Stuck detection ──────────────────────────────────────────────────────
    this._stuckCheckTimer = 0;      // seconds until next stuck-progress sample
    this._stuckLastPos    = null;   // {x,z} position at last sample
    this._stuckTimer      = 0;      // seconds spent with near-zero progress
    this._stuckReplanCooldown = 0;  // brief cooldown after a forced replan

    // ── Locked-in tank type for this pool slot — chosen once, reused on every respawn ──
    this._lockedTankDef      = null;
    this._lockedTrackCfg     = null;
    this._lockedModelPromise = null;

    // ── Health ────────────────────────────────────────────────────────────────
    this.maxHealth = 100;  // will be overwritten in activate()
    this.health    = 100;
    this.engageAiPlanes = false;   // will be overwritten in activate()
    this.isDead           = false;
    this._dissolveTimer   = 0;
    this._dissolveActive  = false;
    this._ejectedTurret   = null;
    this._smokeEmitTimer  = 0;

    this._hullTurnTimer   = 0;
this._lastHullTorque  = 0;
this._cachedPos       = null;   // this tank's own position, cached once per frame in update()
this._distToPlayer    = 0;      // this tank's distance to the real player, cached once per frame — reused for both engine volume and fire-sound attenuation

    // Scratch objects — reused every frame to avoid GC pressure
    this._scratchQ      = new THREE.Quaternion();
    this._scratchVel    = new THREE.Vector3();
    this._scratchFwd    = new THREE.Vector3();
    this._scratchToTgt  = new THREE.Vector3();
    this._scratchForce  = new THREE.Vector3();
    this._scratchFwdFlat = new THREE.Vector3();
    this._scratchPos    = new THREE.Vector3();
    this._scratchWorldPos  = new THREE.Vector3();
    this._scratchWorldQ    = new THREE.Quaternion();
    this._scratchTurretQ   = new THREE.Quaternion();
    this._scratchTurretQInv = new THREE.Quaternion();
    this._scratchLocalDir  = new THREE.Vector3();
    this._scratchUp        = new THREE.Vector3();
    this._scratchFlipQ     = new THREE.Quaternion();
    this._tracers = [];

    // ── Obstacle-avoidance ("whisker" raycast) state ────────────────────────
    this._obstacleRay        = null;               // lazily-built RAPIER.Ray, reused every cast
    this._obstacleBias       = new THREE.Vector3(); // cached steering bias (world XZ), refreshed every OBSTACLE_SCAN_INTERVAL
    this._obstacleScanTimer  = Math.random() * OBSTACLE_SCAN_INTERVAL; // staggered so all tanks don't rescan the same frame
    this._obstacleTurnBias   = 0;                   // sticky left/right dodge direction while something blocks the center whisker

    
    // ── Line-of-sight (LOS) state — checked before shooting; if blocked,
    // the tank repositions instead of shooting through the obstacle.
    this._losCheckTimer      = Math.random() * LOS_CHECK_INTERVAL; // staggered — avoids every attacking tank raycasting on the same frame
    this._hasLOS             = true;
    this._losStrafeSign      = 1;
    this._losStrafeTarget    = { x: 0, y: 0, z: 0 }; // reused in-place, never reallocated
    this._hasLosStrafeTarget = false;                // tracks whether it's been populated yet
    this._losRepositionTimer = 0;

    // ── ATTACK movement-cycle state (rotate → forward → pause → backward → pause → repeat) ──
    this._attackPhase       = 'rotate';   // 'rotate' | 'forward' | 'pause1' | 'backward' | 'pause2'
    this._attackPhaseTimer  = 0;
    this._attackRotateSign  = 1;          // +1 / -1, randomized per cycle
    this._attackRotateStartYaw = 0;       // hull yaw when the current rotate phase began

  }

  // ── Activation / deactivation (pool API) ────────────────────────────────

activate(spawnPos, trackCfg, modelPromise, explosionSystem = null, tankDef = null, team = 1, engageAiPlanes = false) {
  this._explosionSystem = explosionSystem;
  this._tankDef = tankDef;   // store for reference
  this.maxHealth = tankDef?.config?.maxHealth ?? 100;
  this.armour    = tankDef?.config?.armour    ?? 75;
  this._country  = tankDef?.config?.country   ?? null;
  // ── jiggleFight: when true (default), ATTACK state runs the rotate →
  // forward → pause → backward → pause shuffle cycle. When false, the tank
  // just brakes to a stop and holds position while attacking — no shuffle.
  this.jiggleFight = tankDef?.config?.jiggleFight ?? true;
  this.engageAiPlanes = engageAiPlanes;   // ← bool toggle: should tanks fight AI-controlled planes?
  this.team      = team;   // 1 | 2 — which side this AI unit belongs to. Friendliness to any
                            // viewer (real player or another AI unit) is ALWAYS computed as
                            // (this.team === viewerTeam), never a fixed isFriendly flag.

  const RAPIER = this.world.__RAPIER__;

  const rbDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spawnPos.x, spawnPos.y, spawnPos.z)
    .setLinearDamping(1.5)
    .setAngularDamping(8);
  this.rigidBody = this.world.createRigidBody(rbDesc);

  const HULL_GROUP  = 0x0001;
  const WHEEL_GROUP = 0x0002;

  // Hull extents — from tankDef if available, else fall back to constants
  const hullExtents = tankDef?.config?.hullHalfExtents ?? HULL_HALF_EXTENTS;
  const hx = hullExtents.x;
  const hy = hullExtents.y;
  const hz = hullExtents.z;

  const hullCol = RAPIER.ColliderDesc
    .cuboid(hx, hy, hz)
    .setTranslation(0, 0.7, 0)
    .setFriction(1.0)
    .setRestitution(0.0)
    .setCollisionGroups((HULL_GROUP << 16) | (0xFFFF & ~WHEEL_GROUP));
  this.world.createCollider(hullCol, this.rigidBody);

  // ── Trapezoid track colliders ────────────────────────────────────────────
  const SLAB_THICKNESS = 0.2;
  const TOP_HALF = hx + 0.4;
  const BOT_HALF = hx * 0.75 + 0.2;
  const TOP_Y    =  0.10;
  const BOT_Y    = -0.5; // the player tank has -0.38 , i.e (-0.38-(-0.5))= 0.12 extra , so that the whole wheel part ar above the ground

  // outerZ from tankDef — controls which Z the trapezoid colliders sit at
  const outerZ = tankDef?.config?.outerZ ?? 1;

  [-outerZ, outerZ].forEach((z) => {
    const verts = new Float32Array([
      -TOP_HALF, TOP_Y,  z + SLAB_THICKNESS,
       TOP_HALF, TOP_Y,  z + SLAB_THICKNESS,
      -BOT_HALF, BOT_Y,  z + SLAB_THICKNESS,
       BOT_HALF, BOT_Y,  z + SLAB_THICKNESS,
      -TOP_HALF, TOP_Y,  z - SLAB_THICKNESS,
       TOP_HALF, TOP_Y,  z - SLAB_THICKNESS,
      -BOT_HALF, BOT_Y,  z - SLAB_THICKNESS,
       BOT_HALF, BOT_Y,  z - SLAB_THICKNESS,
    ]);
    const trapCol = RAPIER.ColliderDesc
      .convexHull(verts)
      .setFriction(0.05)
      .setRestitution(0.0)
      .setCollisionGroups((WHEEL_GROUP << 16) | (0xFFFF & ~(HULL_GROUP | WHEEL_GROUP)));
    this.world.createCollider(trapCol, this.rigidBody);
  });

  // rest of activate() stays exactly the same...
  this._placeholder.visible = true;
  this.bodyGroup.visible    = true;


// Expand roadWheelX into interleaved list (mirrors Tank._getWheelPositions())


this.trackLeft  = new EnemyTrackSystem(this.scene, this.bodyGroup, -1, trackCfg);
this.trackRight = new EnemyTrackSystem(this.scene, this.bodyGroup,  1, trackCfg);

  modelPromise.then((templateModel) => {
    if (!this.active) return;
    this._modelRoot = templateModel.clone(true);
const s   = this._tankDef?.config?.modelScale   ?? 2.3;
    const oy  = this._tankDef?.config?.modelOffsetY ?? 0.45;
    const ry  = this._tankDef?.config?.modelRotY    ?? -90;
    this._modelRoot.scale.set(s, s, s);
    this._modelRoot.position.set(-0.1, oy, 0);
    this._modelRoot.rotation.y = ry * (Math.PI / 180);
this._modelRoot.traverse(child => {
      if (child.isMesh) {
        child.castShadow    = true;
        child.receiveShadow = true;
        child.material = child.material.clone();
        child.material.transparent = false;  // ← reset: was left true from previous dissolve
        child.material.opacity     = 1.0;
      }
    });

    // ── Find turret & barrel in cloned model ──────────────────────────────
    let hullMesh   = null;
    let camoMesh   = null;

    this._multiGunPoints = null;   // populated below only for gunType 3 (multi-barrel) tanks

    this._modelRoot.traverse(child => {
      if (child.name === 'Turret') this._turretMesh = child;
      if (child.name === 'Barrel') this._barrelMesh = child;
      if (child.name === 'GunPoint') this._gunPoint = child;
      if (child.name === MG_GUN_POINT_NAME) this._mgGunPoint = child;
      // ── Multi-barrel gun points: GunPoint_1, GunPoint_2, ... ────────────
      if (/^GunPoint_\d+$/.test(child.name)) {
        (this._multiGunPoints ?? (this._multiGunPoints = [])).push(child);
      }
      if (child.name === 'Hull_Collider') {
        child.visible          = false;
        this._hullColliderMesh = child;
      }
      if (child.name === 'Crew_Collider') {
        child.visible          = false;
        this._crewColliderMesh = child;
      }
      if (child.name === 'Flag' && child.isMesh) {
        this._flagNode = child;
      }
      if (child.name === 'Hull' && child.isMesh) {
        hullMesh = child;
      }
      if (child.name === 'Camoflage' && child.isMesh) {
        camoMesh = child;
      }
    });

    if (this._ownBulletSystem) {
      if (typeof this._ownBulletSystem.setGunPoints === 'function' && this._multiGunPoints?.length) {
        // Deterministic barrel order — GunPoint_1, GunPoint_2, ...
        this._multiGunPoints.sort((a, b) => {
          const na = parseInt(a.name.split('_')[1], 10);
          const nb = parseInt(b.name.split('_')[1], 10);
          return na - nb;
        });
        this._ownBulletSystem.setGunPoints(this._multiGunPoints);
        // Use the first barrel as the aim-direction reference for shootDir
        // in update() below, same as the single-gunPoint tanks do.
        if (!this._gunPoint) this._gunPoint = this._multiGunPoints[0];
      } else if (this._gunPoint) {
        this._ownBulletSystem.setGunPoint(this._gunPoint);
      }
    }

    this._applyCountryFlagTexture();

    // ── Merge Camoflage into Hull — enemies don't need the wind-sway shader,
    // so folding it into the hull geometry saves a drawcall per tank. Only
    // safe when both meshes use the same material (else Three would still
    // need a second draw call for the second material group). Falls back to
    // leaving Camoflage as its own static mesh if merge isn't possible. ────
    this._mergeCamoIntoHull(hullMesh, camoMesh);

    this.bodyGroup.add(this._modelRoot);
    this._placeholder.visible = false;
  });

// ── Own weapon system for gunType 2 (arc projectile) / gunType 3 (multi-barrel) ──
if (this._ownBulletSystem) {
      // Kill any remaining in-flight projectile slots before disposing —
      // only ProjectileBulletSystem has this pool; MultiGunSystem doesn't.
      if (Array.isArray(this._ownBulletSystem._active)) {
        for (let i = 0; i < this._ownBulletSystem._active.length; i++) {
          if (this._ownBulletSystem._active[i]) {
            this._ownBulletSystem._killProjectile(i);
          }
        }
      }
      this._ownBulletSystem.dispose();
      this._ownBulletSystem = null;
    }

  const _gunType = tankDef?.config?.gunType ?? 1;

  if (_gunType === 2) {
    this._ownBulletSystem = new ProjectileBulletSystem(this.scene, this.world, explosionSystem);
    this._ownBulletSystem.bulletSpeed = tankDef?.config?.shellSpeed ?? 55;
    this._ownBulletSystem.reloadTime  = tankDef?.config?.reloadTime ?? 3;
    this._ownBulletSystem.damage      = tankDef?.config?.damage     ?? 100;
    this._ownBulletSystem.onHit = () => this._audioSystem?.playExplosion(this._distToPlayer);
    // Gun point set later once GLB loads — done in modelPromise.then() above
  } else if (_gunType === 3) {
    this._ownBulletSystem = new MultiGunSystem(this.scene, this.world, explosionSystem);
    if (tankDef?.config?.reloadTime) this._ownBulletSystem.setFireRate(tankDef.config.reloadTime);
    if (tankDef?.config?.damage)     this._ownBulletSystem.setDamage(tankDef.config.damage);
    if (tankDef?.config?.maxRounds)  this._ownBulletSystem.setMaxRounds(tankDef.config.maxRounds);
    // Gun points set later once GLB loads — done in modelPromise.then() above
  }

  this.state  = STATE.IDLE;   // real job gets assigned right below / by the pool
  this.active = true;

  this._id            = Math.random().toString(36).slice(2);
  this._audioSystem   = null;

  // ── Fire cadence — gunType 3 (multi-barrel) fires much more often than
  // the single-shot gun types, since each volley is spread across barrels.
  // tankDef can override via config.shootInterval if you want per-tank tuning.
  const _gunTypeForFireRate = tankDef?.config?.gunType ?? 1;
  const _defaultShootInterval = _gunTypeForFireRate === 3 ? 1.2 : SHOOT_INTERVAL;
  this._shootInterval = tankDef?.config?.shootInterval ?? _defaultShootInterval;
  
  this.shootTimer     = 1.5 + Math.random() * 1.0;

    // Pre-warm transparent shader variant to avoid stutter on first death
  this._prewarmTransparency();

  // ← ADD THESE:
  this.health           = this.maxHealth;
  this.isDead           = false;
  this._dissolveTimer   = 0;
  this._dissolveActive  = false;
  this._ejectedTurret   = null;
  this._killCounted = false;
  this._smokeEmitTimer  = 0;
  this._lastHitBy       = null;   // ← reset kill-credit attribution for this new life
  this._lastHitByExplicitName = null;   // ← same, for the real-remote-player name override

  this._hasLOS             = true;
  this._losCheckTimer      = Math.random() * LOS_CHECK_INTERVAL;
  this._hasLosStrafeTarget = false;
  this._losRepositionTimer = 0;

  // ── Reset capture-point / curve AI state ────────────────────────────────
  this.assignedCP    = null;
  this.role          = 'solo';
  this.squad         = null;
  this.curveT        = Math.random();
  this._holdAngle    = Math.random() * Math.PI * 2;
  this._prevJobState = STATE.PATROL_CURVE;
  this.state         = STATE.PATROL_CURVE;   // pool.trySpawn() assigns the real job right after
  this._cpRouteIdx   = null;
  this._cpHoldTimer  = 0;
  this._captureSquadRef = null;   // re-grouped fresh by _updateCaptureAssignments on next update

  this._pickNewPatrolTarget(spawnPos);
}

  deactivate() {
    if (!this.active) return;

    // ── Same fix as EnemyPlane.deactivate() — stop any active damage fire
    // tracking this tank before teardown, in case deactivate() was
    // triggered by something other than death (e.g. out-of-bounds cleanup).
    this._explosionSystem?.stopDamageFire?.(this);

    // ── Clean up any still-flying ejected turret. Normally this happens
    // naturally inside _tickDissolve() once the dissolve timer hits 0
    // (which is what calls deactivate() in the first place) — but
    // deactivate() can also fire from other paths (pool dispose(),
    // killTank(), or a guest's local dissolve finishing slightly out of
    // sync with the host's broadcast), none of which know to clean up
    // _ejectedTurret. Without this, an orphaned turret — added directly
    // to the scene, not as a child of bodyGroup — is left floating
    // forever with no owning hull, exactly the "ownerless turret" symptom.
    if (this._ejectedTurret) {
      this.scene.remove(this._ejectedTurret);
      this._ejectedTurret.traverse(c => {
        if (c.isMesh) { c.geometry?.dispose(); c.material?.dispose(); }
      });
      this._ejectedTurret = null;
    }

    // ── Release capture-point assignment ────────────────────────────────────
    if (this.assignedCP && this.assignedCP.assignedTank === this) {
      this.assignedCP.assignedTank = null;
    }
    this.assignedCP = null;
    this.squad      = null;
    this.role       = 'solo';

    // ── Leave capture squad — will be re-grouped fresh on next spawn ───────
    if (this._captureSquadRef) {
      this._captureSquadRef.tankIds.delete(this._id);
      this._captureSquadRef = null;
    }
    this._cpRouteIdx = null;

    // Stop engine sound for this tank
    if (this._audioSystem) {
      this._audioSystem.stopEnemyEngine(this._id);
    }

// ── Invalidate any in-flight projectiles referencing this body ─────────
  this._ownBulletSystem?.invalidateRigidBody?.(this.rigidBody);
  this._sharedBulletSystem?.invalidateRigidBody?.(this.rigidBody);

  // ── Clear stale rigid body refs cached inside tracks ────────────────────
  if (this.trackLeft)  { this.trackLeft._tankRigidBody  = null; this.trackLeft._bodyMatrix  = null; }
  if (this.trackRight) { this.trackRight._tankRigidBody = null; this.trackRight._bodyMatrix = null; }

  // Remove physics immediately so it stops blocking bullets/movement
  if (this.rigidBody) {
    this.world.removeRigidBody(this.rigidBody);
    this.rigidBody = null;
  }

    // Remove GLB model
    if (this._modelRoot) {
      this.bodyGroup.remove(this._modelRoot);
      this._modelRoot = null;
          this._hullColliderMesh = null;
    this._crewColliderMesh = null;
    this._flagNode = null;
    }

    // ── Clear stale mesh/node refs from the destroyed model — otherwise on
    // the NEXT spawn, the `if (!this._gunPoint) ...` guard in activate()'s
    // modelPromise.then() callback sees a truthy-but-detached old node and
    // never repoints it to the new model, causing shootDir (and turret/
    // barrel tracking) to be computed from a frozen, stale transform ──────
    this._gunPoint      = null;
    this._mgGunPoint    = null;   // ← NEW
    this._turretMesh    = null;
    this._barrelMesh    = null;
    this._multiGunPoints = null;
    this._placeholder.visible = false;
    this.bodyGroup.visible    = false;

    // Dispose tracks
    this.trackLeft?.dispose();
    this.trackRight?.dispose();
    this.trackLeft  = null;
    this.trackRight = null;

// Clean up any leftover tracers
    for (const t of this._tracers) {
      this.scene.remove(t.line);
      t.geo.dispose();
      t.mat.dispose();
    }
    this._tracers = [];

this._ownBulletSystem?.dispose();
    this._ownBulletSystem = null;

    this.active = false;
    this.state  = STATE.IDLE;
    this.team   = 1;   // default; overwritten by activate()'s `team` param on every (re)spawn
  }

  // ── AI helpers ────────────────────────────────────────────────────────────

_pickNewPatrolTarget(fromPos) {
  const angle = Math.random() * Math.PI * 2;
  const dist  = 20 + Math.random() * 30;
  this.patrolTarget.set(
    fromPos.x + Math.cos(angle) * dist,
    fromPos.y,
    fromPos.z + Math.sin(angle) * dist
  );
  this.patrolTimer = 8 + Math.random() * 8;
}

// ── Country flag — plain static texture, no shader/animation ─────────────
_applyCountryFlagTexture() {
  const mesh = this._flagNode;
  if (!mesh || !mesh.material) return;

  const code = this._country;
  if (!code) return; // no country configured — leave default material as-is

  const url = `https://flagcdn.com/w320/${code.toLowerCase()}.png`;

  const loader = new THREE.TextureLoader();
  loader.load(
    url,
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = true;

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((mat) => {
        mat.map = texture;
        mat.color?.set?.(0xffffff);
        mat.needsUpdate = true;
      });
    },
    undefined,
    (err) => {
      console.warn(`[EnemyTank] Failed to load flag texture for country "${code}":`, err);
    }
  );
}

// ── Merge Camoflage mesh into Hull mesh to save a drawcall ─────────────────
// Enemies never animate the camo net (no wind shader), so it's safe to bake
// it into the hull's static geometry. Requires both meshes to reference the
// same material — otherwise Three still issues a second draw call per
// material group and merging buys nothing, so we skip it in that case.
_mergeCamoIntoHull(hullMesh, camoMesh) {
  if (!hullMesh || !camoMesh) return;
  if (!hullMesh.isMesh || !camoMesh.isMesh) return;

  const sameMaterial = hullMesh.material === camoMesh.material
    || (hullMesh.material?.uuid && hullMesh.material.uuid === camoMesh.material?.uuid);

  if (!sameMaterial) {
    // Different materials — merging wouldn't reduce drawcalls, and could
    // silently drop camo's texture/tint. Leave both meshes as-is.
    return;
  }

  try {
    // Bake each mesh's local transform into its geometry before merging,
    // since mergeGeometries concatenates vertex buffers directly and
    // ignores each source mesh's individual position/rotation/scale.
    hullMesh.updateMatrix();
    camoMesh.updateMatrix();

    const hullGeo = hullMesh.geometry.clone().applyMatrix4(hullMesh.matrix);
    const camoGeo = camoMesh.geometry.clone().applyMatrix4(camoMesh.matrix);

    // Ensure both geometries carry the same attribute set (mergeGeometries
    // requires matching attributes) — drop anything camo has that hull
    // doesn't, and vice versa isn't handled here since hull is primary.
    const hullAttrs = new Set(Object.keys(hullGeo.attributes));
    for (const key of Object.keys(camoGeo.attributes)) {
      if (!hullAttrs.has(key)) camoGeo.deleteAttribute(key);
    }
    for (const key of hullAttrs) {
      if (!camoGeo.attributes[key]) {
        // Camo geometry is missing an attribute hull has (e.g. uv2) — bail,
        // merge would silently misalign vertex data.
        hullGeo.dispose();
        camoGeo.dispose();
        return;
      }
    }

    const merged = mergeGeometries([hullGeo, camoGeo], false);
    hullGeo.dispose();
    camoGeo.dispose();

    if (!merged) return;   // merge failed — keep both meshes separate, no-op

    // Replace hull's geometry with the merged result, positioned at origin
    // since the transforms are now baked in.
    hullMesh.geometry.dispose();
    hullMesh.geometry = merged;
    hullMesh.position.set(0, 0, 0);
    hullMesh.rotation.set(0, 0, 0);
    hullMesh.scale.set(1, 1, 1);
    hullMesh.updateMatrix();

    // Remove the now-redundant camo mesh from the scene graph and free it
    camoMesh.parent?.remove(camoMesh);
    // Don't dispose camoMesh.material — it's the same material object hull
    // still uses (sameMaterial check above), disposing it would break hull.
    this._camoNode = null;   // enemies never reference this again
  } catch (err) {
    console.warn('[EnemyTank] Failed to merge Camoflage into Hull:', err);
  }
}

_getForward() {
  const rot = this.rigidBody.rotation();
  this._scratchQ.set(rot.x, rot.y, rot.z, rot.w);
  return this._scratchFwd.set(-1, 0, 0).applyQuaternion(this._scratchQ);
}

/**
 * Casts a single ray through the physics world, excluding this tank's own
 * rigid body, and returns the raw Rapier hit ({ collider, timeOfImpact })
 * or null if nothing was hit within maxDist.
 */
_castForwardRay(originX, originY, originZ, dirX, dirY, dirZ, maxDist) {
  const RAPIER = this.world?.__RAPIER__;
  if (!RAPIER || !this.rigidBody) return null;

  if (!this._obstacleRay) {
    this._obstacleRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  }
  this._obstacleRay.origin.x = originX;
  this._obstacleRay.origin.y = originY;
  this._obstacleRay.origin.z = originZ;
  this._obstacleRay.dir.x = dirX;
  this._obstacleRay.dir.y = dirY;
  this._obstacleRay.dir.z = dirZ;

  return this.world.castRay(
    this._obstacleRay,
    maxDist,
    true,           // solid — stop at first surface, not just centroid
    undefined,
    undefined,
    undefined,
    this.rigidBody, // exclude self
  );
}

/**
 * Forward-facing 3-ray "whisker" obstacle scan — one ray straight ahead,
 * two angled ±OBSTACLE_WHISKER_ANGLE to the sides. Returns a world-space
 * (XZ-only) steering bias that bends the tank's desired heading away from
 * whatever is closest ahead, so _steerToward() can dodge it before impact
 * instead of driving straight into it and relying on physics collision to
 * stop it. Result is cached and only refreshed every OBSTACLE_SCAN_INTERVAL
 * seconds — obstacles don't move, so re-casting 3 rays every single frame
 * for every active tank is unnecessary cost.
 */
_scanForObstacles(pos, fwd, dt) {
  this._obstacleScanTimer -= dt;
  if (this._obstacleScanTimer > 0) return this._obstacleBias;
  this._obstacleScanTimer = OBSTACLE_SCAN_INTERVAL;

  this._obstacleBias.set(0, 0, 0);
  if (!this.world || !this.rigidBody) return this._obstacleBias;

  const rayY = pos.y + OBSTACLE_RAY_HEIGHT;
  const cosA = Math.cos(OBSTACLE_WHISKER_ANGLE);
  const sinA = Math.sin(OBSTACLE_WHISKER_ANGLE);

  // Side whisker directions — forward rotated ± angle around world Y
  const leftX  = fwd.x * cosA - fwd.z * sinA;
  const leftZ  = fwd.x * sinA + fwd.z * cosA;
  const rightX = fwd.x * cosA + fwd.z * sinA;
  const rightZ = -fwd.x * sinA + fwd.z * cosA;

  const centerHit = this._castForwardRay(pos.x, rayY, pos.z, fwd.x, 0, fwd.z, OBSTACLE_LOOKAHEAD);
  const leftHit   = this._castForwardRay(pos.x, rayY, pos.z, leftX, 0, leftZ, OBSTACLE_SIDE_LOOKAHEAD);
  const rightHit  = this._castForwardRay(pos.x, rayY, pos.z, rightX, 0, rightZ, OBSTACLE_SIDE_LOOKAHEAD);

  // Perpendicular-to-forward vector (world XZ) — used to bend left/right
  const perpX = -fwd.z;
  const perpZ =  fwd.x;

  if (centerHit) {
    const strength = 1 - centerHit.timeOfImpact / OBSTACLE_LOOKAHEAD;
    // Dodge toward whichever side is clearer. If both sides are also
    // blocked (or both clear), stick to whatever side we already picked
    // this "blocked" streak so the tank doesn't flicker left/right.
    let side;
    if (leftHit && !rightHit) side = -1;
    else if (rightHit && !leftHit) side = 1;
    else side = this._obstacleTurnBias || (this._obstacleTurnBias = (Math.random() < 0.5 ? 1 : -1));

    this._obstacleTurnBias = side;
    this._obstacleBias.x += perpX * side * strength * OBSTACLE_AVOID_STRENGTH;
    this._obstacleBias.z += perpZ * side * strength * OBSTACLE_AVOID_STRENGTH;
  } else {
    this._obstacleTurnBias = 0; // path ahead is clear — forget the last dodge side
  }

  if (leftHit) {
    const strength = 1 - leftHit.timeOfImpact / OBSTACLE_SIDE_LOOKAHEAD;
    this._obstacleBias.x += perpX * strength * OBSTACLE_AVOID_STRENGTH * 0.5;
    this._obstacleBias.z += perpZ * strength * OBSTACLE_AVOID_STRENGTH * 0.5;
  }
  if (rightHit) {
    const strength = 1 - rightHit.timeOfImpact / OBSTACLE_SIDE_LOOKAHEAD;
    this._obstacleBias.x -= perpX * strength * OBSTACLE_AVOID_STRENGTH * 0.5;
    this._obstacleBias.z -= perpZ * strength * OBSTACLE_AVOID_STRENGTH * 0.5;
  }

  return this._obstacleBias;
}


/**
 * Raycasts from originPos toward targetPos, excluding this tank's own
 * rigid body, to determine whether a house/wall/fence/terrain sits between
 * the two points. Hitting the target's own collider does not count as
 * "blocked" — that's just confirming the shot connects.
 */
_checkLineOfSight(originPos, targetPos, targetRigidBody) {
  if (!this.world || !this.rigidBody) return true;

  const dx = targetPos.x - originPos.x;
  const dy = targetPos.y - originPos.y;
  const dz = targetPos.z - originPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.5) return true;

  const invDist = 1 / dist;
  const hit = this._castForwardRay(
    originPos.x, originPos.y, originPos.z,
    dx * invDist, dy * invDist, dz * invDist,
    dist - 0.5, // stop a bit short so the target's own hull is never itself flagged as "the obstacle"
  );

  if (!hit) return true; // nothing solid in the way

  // Edge case: something WAS hit right around the target's own position —
  // still a clear shot, not a blocked one.
  if (targetRigidBody) {
    const hitBody = hit.collider?.parent?.();
    if (hitBody && hitBody.handle === targetRigidBody.handle) return true;
  }

  return false; // a house/wall/fence/terrain is genuinely blocking the shot
}

/**
 * Called every frame from ATTACK while this._hasLOS is false. Picks a
 * lateral strafe point (recomputed every couple of seconds, alternating
 * sides so a wide obstacle doesn't trap it pushing the same blocked
 * direction forever) and drives there via the same NavGrid-aware
 * path-following + obstacle whiskers already used for normal travel.
 */
_repositionForLineOfSight(pos, combatTarget, dt) {
  this._losRepositionTimer -= dt;

  if (!this._hasLosStrafeTarget || this._losRepositionTimer <= 0) {
    this._losRepositionTimer = 2.5 + Math.random() * 1.5;
    this._hasLosStrafeTarget = true;

    const tx  = combatTarget.pos.x - pos.x;
    const tz  = combatTarget.pos.z - pos.z;
    const len = Math.sqrt(tx * tx + tz * tz) || 1;
    const dirX = tx / len, dirZ = tz / len;
    const perpX = -dirZ, perpZ = dirX;

    this._losStrafeSign = -(this._losStrafeSign || 1);

    // Mutate the persistent object in place instead of allocating a new one
    this._losStrafeTarget.x = pos.x + perpX * this._losStrafeSign * LOS_BLOCKED_STRAFE_DIST + dirX * (LOS_BLOCKED_STRAFE_DIST * 0.3);
    this._losStrafeTarget.y = pos.y;
    this._losStrafeTarget.z = pos.z + perpZ * this._losStrafeSign * LOS_BLOCKED_STRAFE_DIST + dirZ * (LOS_BLOCKED_STRAFE_DIST * 0.3);
  }

  return this._followPath(this._losStrafeTarget, LOS_STRAFE_SPEED, dt);
}

  /**
   * Steer toward a world-space target.
   * Returns { throttle, leftThrottle, rightThrottle }
   */
_steerToward(targetPos, speed, dt) {
  const pos = this.rigidBody.translation();
  const fwd = this._getForward();  // returns this._scratchFwd — read-only after this

  // Reuse scratch — no new Vector3
  const toTarget = this._scratchToTgt.set(
    targetPos.x - pos.x,
    0,
    targetPos.z - pos.z
  );
  const distToTarget = toTarget.length();
  toTarget.normalize();

  // ── Player avoidance — bend the DESIRED HEADING away from the player
  // when they're nearby, instead of driving straight at/through them.
  // This feeds into the normal torque-based turn below, so the tank
  // physically rotates its hull around the player like it would around
  // any other obstacle, then straightens back onto its real target once
  // clear — instead of sliding sideways with setLinvel.
  const avoidPos = this._avoidPos;
  if (avoidPos) {
    const AVOID_RADIUS = 11; // metres — start bending the heading this far out
    const ax = pos.x - avoidPos.x;
    const az = pos.z - avoidPos.z;
    const avoidDistSq = ax * ax + az * az;

    if (avoidDistSq < AVOID_RADIUS * AVOID_RADIUS && avoidDistSq > 0.0001) {
      const avoidDist   = Math.sqrt(avoidDistSq);
      const awayX       = ax / avoidDist;
      const awayZ       = az / avoidDist;
      // 0 at the edge of the radius, 1 when right on top of the player
      const avoidStrength = 1 - (avoidDist / AVOID_RADIUS);

      toTarget.x += awayX * avoidStrength * 1.6;
      toTarget.z += awayZ * avoidStrength * 1.6;

      // Guard against the blended vector collapsing to ~0 (player exactly
      // between tank and target) — keep the last valid heading instead of
      // normalizing a near-zero vector into garbage.
      if (toTarget.lengthSq() > 0.0001) {
        toTarget.normalize();
      } else {
        toTarget.set(fwd.x, 0, fwd.z).normalize();
      }
    }
  }

  // ── Obstacle avoidance — forward-facing raycast "whiskers" detect
  // houses/fences/walls ahead and bend the desired heading around them
  // before the hull physically collides, instead of relying purely on
  // NavGrid waypoints (which can still clip a corner while transiting
  // between two waypoints).
  const obstacleBias = this._scanForObstacles(pos, fwd, dt);
  if (obstacleBias.lengthSq() > 0.0001) {
    toTarget.x += obstacleBias.x;
    toTarget.z += obstacleBias.z;

    if (toTarget.lengthSq() > 0.0001) {
      toTarget.normalize();
    } else {
      toTarget.set(fwd.x, 0, fwd.z).normalize();
    }
  }

  const cross = fwd.x * toTarget.z - fwd.z * toTarget.x;
  const dot   = fwd.dot(toTarget);
  const angle = Math.atan2(cross, dot);

  const torque   = THREE.MathUtils.clamp(angle * 2.0, -1, 1);
  this.rigidBody.applyTorqueImpulse(
    { x: 0, y: -torque * 0.15 * 800 * dt, z: 0 }, true
  );

  const absAngle = Math.abs(angle);
  const throttle = absAngle > Math.PI * 0.6 ? speed * 0.2 : speed;
  const maxSpeed = 2.0 * Math.max(speed, 0.1);

  // Reuse scratch flat-forward vector
  const fwdFlat = this._scratchFwdFlat.set(fwd.x, 0, fwd.z);
  const vel     = this.rigidBody.linvel();
  // Reuse scratch vel vector instead of new Vector3(vel.x, 0, vel.z)
  const velFwd  = fwdFlat.dot(this._scratchVel.set(vel.x, 0, vel.z));

  if (speed > 0 && distToTarget > 3) {
    if (Math.abs(velFwd) < maxSpeed) {
      // Reuse scratch force vector instead of fwdVec.clone().multiplyScalar(...)
      const force = this._scratchForce
        .copy(fwdFlat)
        .multiplyScalar(throttle * 0.35 * 2200 * dt);
      this.rigidBody.applyImpulse({ x: force.x, y: 0, z: force.z }, true);
    }
  } else {
    this.rigidBody.applyImpulse({
      x: -vel.x * 3.0 * dt,
      y: 0,
      z: -vel.z * 3.0 * dt,
    }, true);
  }

  const leftThrottle  = throttle - torque * 0.5;
  const rightThrottle = throttle + torque * 0.5;
  return { throttle, leftThrottle, rightThrottle };
}

// ── NavGrid path-following ────────────────────────────────────────────────
_ensurePath(target) {
  const needsNew = !this._path ||
    !this._pathTarget ||
    Math.hypot(this._pathTarget.x - target.x, this._pathTarget.z - target.z) > 6;

  if (needsNew && this.navGrid) {
    const from = this.rigidBody.translation();
    const path = this.navGrid.findPath(from, target);
    this._path = (path && path.length) ? path : [target]; // fallback: straight line
    this._pathIdx = 0;
    this._pathTarget = { x: target.x, z: target.z };
  }
}

// ── Stuck detection — call every frame while path-following. Tracks how far
// the tank has actually moved over a rolling sample window; if it's barely
// moved despite trying to, flags a stuck state so the caller can force a
// reroute instead of endlessly re-steering into the same obstacle. ────────


_checkStuck(pos, dt) {
  if (this._stuckReplanCooldown > 0) {
    this._stuckReplanCooldown -= dt;
  }

  this._stuckCheckTimer -= dt;
  if (this._stuckCheckTimer > 0) return false;
  this._stuckCheckTimer = STUCK_SAMPLE_INTERVAL;

  if (this._stuckLastPos) {
    const dx = pos.x - this._stuckLastPos.x;
    const dz = pos.z - this._stuckLastPos.z;
    const moved = Math.sqrt(dx * dx + dz * dz);

    if (moved < STUCK_MIN_PROGRESS) {
      this._stuckTimer += STUCK_SAMPLE_INTERVAL;
    } else {
      this._stuckTimer = 0;
    }
  }

  this._stuckLastPos = { x: pos.x, z: pos.z };

  if (this._stuckTimer >= STUCK_TRIGGER_TIME && this._stuckReplanCooldown <= 0) {
    this._stuckTimer          = 0;
    this._stuckReplanCooldown = STUCK_REPLAN_COOLDOWN;
    return true;
  }
  return false;
}

_followPath(target, speed, dt) {
  const pos = this.rigidBody.translation();

  // ── Detect being wedged/stuck and force a brand-new path if so ─────────
  if (this._checkStuck(pos, dt)) {
    this._path       = null;   // discard current path — forces _ensurePath to replan below
    this._pathTarget = null;
    // Small random lateral nudge target so the fresh path doesn't just route
    // straight back into the same obstacle corner it just got wedged on.
    const nudgeAngle = Math.random() * Math.PI * 2;
    this.rigidBody.applyImpulse({
      x: Math.cos(nudgeAngle) * 300,
      y: 0,
      z: Math.sin(nudgeAngle) * 300,
    }, true);
  }

  this._ensurePath(target);

  if (!this.navGrid || !this._path || this._pathIdx >= this._path.length) {
    return this._steerToward(target, speed, dt);
  }

  const wp = this._path[this._pathIdx];
  const dx = wp.x - pos.x, dz = wp.z - pos.z;
  const WAYPOINT_RADIUS = 5;
  if (dx * dx + dz * dz < WAYPOINT_RADIUS * WAYPOINT_RADIUS) {
    this._pathIdx++;
  }

  const steerTarget = this._path[Math.min(this._pathIdx, this._path.length - 1)] ?? target;
  return this._steerToward(steerTarget, speed, dt);
}

takeDamage(amount = 25) {
  if (this.isDead) return;
  const armorAbsorb = Math.min(this.armour, amount);
  this.armour       = Math.max(0, this.armour - armorAbsorb);
  const healthDamage = amount - armorAbsorb;
  this.health = Math.max(0, this.health - healthDamage);
  if (this.health <= 0) this._die();
}

_die() {
  if (this.isDead) return;
  this.isDead  = true;
  this.state   = STATE.DEAD;

  // ── Stop this tank's engine sound the instant it dies — previously the
  // engine loop kept playing/looping until deactivate() ran, which only
  // happens after the full 15s _dissolveTimer finishes (see _tickDissolve()),
  // so a destroyed tank's engine was audible for up to 15 more seconds.
  this._audioSystem?.stopEnemyEngine(this._id);

  // ── Eject turret ──────────────────────────────────────────────────────
  if (this._turretMesh) {
    const worldPos = new THREE.Vector3();
    const worldQ   = new THREE.Quaternion();
    this._turretMesh.getWorldPosition(worldPos);
    this._turretMesh.getWorldQuaternion(worldQ);

    this.bodyGroup.remove(this._turretMesh);
    this.scene.add(this._turretMesh);
    this._turretMesh.position.copy(worldPos);
    this._turretMesh.quaternion.copy(worldQ);
    this._ejectedTurret = this._turretMesh;
    this._turretMesh    = null;

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
  this._ownBulletSystem?.invalidateRigidBody?.(this.rigidBody);
  this._sharedBulletSystem?.invalidateRigidBody?.(this.rigidBody);

  // Remove physics immediately so it stops blocking bullets/movement
  if (this.rigidBody) {
    this.world.removeRigidBody(this.rigidBody);
    this.rigidBody = null;
  }

  // Disable shadows immediately on death
  this.bodyGroup.traverse(c => {
    if (c.isMesh) c.castShadow = false;
  });

  // ── Remove belt mesh immediately on death (wheels stay) ─────────────────
  this.trackLeft?.disposeBelt();
  this.trackRight?.disposeBelt();

  // Spawn death explosion via the shared ExplosionSystem
if (this._explosionSystem && this.rigidBody === null) {
  // rigidBody was just removed above — use bodyGroup position instead
  const deathPos = new THREE.Vector3();
  this.bodyGroup.getWorldPosition(deathPos);
  deathPos.y += 0.8;   // raise to hull centre-mass height


// Primary blast
  this._explosionSystem.spawn(deathPos);
  this._audioSystem?.playExplosion(this._distToPlayer);

  // Second delayed blast
  const offset = new THREE.Vector3(
    (Math.random() - 0.5) * 1.2,
    0.4,
    (Math.random() - 0.5) * 1.2
  );
  const exp2Pos = deathPos.clone().add(offset);
  const _distAtDeath = this._distToPlayer;   // snapshot — tank may deactivate before the timeout fires
  setTimeout(() => {
    this._explosionSystem?.spawn(exp2Pos);
    this._audioSystem?.playExplosion(_distAtDeath);
  }, 220);

  const exp3Pos = new THREE.Vector3(
    deathPos.x + (Math.random() - 0.5) * 0.8,
    deathPos.y + 1.0,
    deathPos.z + (Math.random() - 0.5) * 0.8
  );
  setTimeout(() => {
    this._explosionSystem?.spawn(exp3Pos);
    this._audioSystem?.playExplosion(_distAtDeath);
  }, 480);
}

// Immediately kill all in-flight projectiles — clear every active slot
  // (only ProjectileBulletSystem, gunType 2, has an _active pool; MultiGunSystem, gunType 3, doesn't)
  if (this._ownBulletSystem && Array.isArray(this._ownBulletSystem._active)) {
    for (let i = 0; i < this._ownBulletSystem._active.length; i++) {
      if (this._ownBulletSystem._active[i]) {
        this._ownBulletSystem._killProjectile(i);
      }
    }
  }

  this._dissolveTimer  = 15;
  this._dissolveActive = true;
}

_tickDissolve(dt) {
  // ── Keep ticking this tank's own weapon system (gunType 2/3) so any
  // beam/shell that was still mid-flight the instant this tank died keeps
  // animating/fading out instead of freezing at its last frame ───────────
  this._ownBulletSystem?.update(dt);

  this._dissolveTimer -= dt;

  // ── Continuous burning smoke + fire from destroyed hull ────────────────
  if (this._explosionSystem && this._dissolveTimer > 0) {
    this._smokeEmitTimer -= dt;
    if (this._smokeEmitTimer <= 0) {
      this._smokeEmitTimer = 0.18 + Math.random() * 0.12; // emit every ~180-300ms

      // Use bodyGroup position as smoke origin, offset up to hull centre
      const smokePos = new THREE.Vector3();
      this.bodyGroup.getWorldPosition(smokePos);
      smokePos.y += 1 + Math.random() * 0.6;   // raised higher above hull
      smokePos.x += (Math.random() - 0.5) * 0.5;
      smokePos.z += (Math.random() - 0.5) * 0.5;

      this._explosionSystem.spawnDeathSmoke(smokePos);
    }
  }

  // ── Tick tracers during dissolve so they don't freeze ──────────────────
  if (this._tracers.length) {
    for (let i = this._tracers.length - 1; i >= 0; i--) {
      const t = this._tracers[i];
      t.timer -= dt;
      t.mat.opacity = Math.max(0, t.timer / 0.10);
      if (t.timer <= 0) {
        this.scene.remove(t.line);
        t.geo.dispose();
        t.mat.dispose();
        this._tracers.splice(i, 1);
      }
    }
  }

  // Ballistic turret
  if (this._ejectedTurret) {
    const vel = this._ejectedTurret.userData.vel;
    vel.y -= 12 * dt;
    this._ejectedTurret.position.addScaledVector(vel, dt);
    const av = this._ejectedTurret.userData.angVel;
    this._ejectedTurret.rotation.x += av.x * dt;
    this._ejectedTurret.rotation.y += av.y * dt;
    this._ejectedTurret.rotation.z += av.z * dt;

    // if (this._dissolveTimer < 1.5) {
    //   this._ejectedTurret.traverse(c => {
    //     if (c.isMesh && c.material) {
    //       c.material.transparent = true;
    //       c.material.opacity = Math.max(0, this._dissolveTimer / 1.5);
    //     }
    //   });
    // }
    if (this._dissolveTimer <= 0) {
      this.scene.remove(this._ejectedTurret);
      this._ejectedTurret = null;
    }
  }

  // Sink hull
  // if (this._dissolveTimer < 2.0 && this._dissolveTimer > 0) {
  //   const sinkT = 1 - (this._dissolveTimer / 2.0);
  //   this.bodyGroup.position.y -= sinkT * 0.012;
  //   this.bodyGroup.traverse(c => {
  //     if (c.isMesh && c.material) {
  //       c.material.transparent = true;
  //       c.material.opacity = Math.max(0, 1 - sinkT);
  //     }
  //   });
  // }

  // Final cleanup — calls deactivate() which removes tracks etc.
  if (this._dissolveTimer <= 0) {
    this._dissolveActive = false;
    this.deactivate();
  }
}

_prewarmTransparency() {
  if (this._placeholder) {
    this._placeholder.material.transparent = true;
    this._placeholder.material.opacity = 1.0;
  }
}

// ── Flip recovery — reset to upright in place instead of destroying ────────
// Keeps the tank's current x/z position and current facing (yaw), but zeroes
// out pitch/roll so it's standing upright again. Also clears velocity so it
// doesn't carry over any tumbling momentum, and resumes AI immediately.
_resetUpright() {
  if (!this.rigidBody) return;

  const pos = this.rigidBody.translation();
  const rot = this.rigidBody.rotation();

  // Extract current yaw only (discard pitch/roll from the flip).
  this._scratchQ.set(rot.x, rot.y, rot.z, rot.w);
  this._hullEuler.setFromQuaternion(this._scratchQ, 'YXZ');
  const yaw = this._hullEuler.y;

  const uprightQ = this._scratchFlipQ.setFromEuler(
    this._euler.set(0, yaw, 0, 'YXZ')
  );

  this.rigidBody.setTranslation({ x: pos.x, y: pos.y + 1.0, z: pos.z }, true);
  this.rigidBody.setRotation({ x: uprightQ.x, y: uprightQ.y, z: uprightQ.z, w: uprightQ.w }, true);
  this.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  this.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

/**
   * Returns the combat target this tank should chase/shoot at.
   * Base EnemyTank targets whichever is nearer: the player, or the nearest
   * active friendly tank (passed in as `extraTargets`). FriendlyTank overrides
   * this to search enemy tanks instead — see friendlyTank.js.
   * @param {object} pos - this tank's own current position, {x,y,z} (already
   *   fetched once in update() — avoids a second .translation() call here)
   * @returns {{ pos: {x,y,z}, rigidBody: object|null, isPlayer: boolean, tankRef: object|null }}
   */
  /**
   * Team-relative target search. `allCandidates` is now a FLAT list of every
   * potential target this unit could conceivably fight — the real player's
   * vehicle (wrapped as a candidate, see main.js's _buildAiCandidateList()),
   * every remote real player's proxy, and every AI unit from BOTH team
   * pools. Each candidate must expose { pos, rigidBody, isPlayer, tankRef,
   * team }. This method's only job is: find the nearest candidate whose
   * team !== this.team. Friendliness is no longer baked into which array a
   * candidate arrived in — it's computed here, per-candidate, every call.
   */
  _findCombatTarget(pos, allCandidates) {
    let bestPos       = null;
    let bestRigidBody = null;
    let bestIsPlayer  = false;
    let bestTankRef   = null;
    let bestDistSq    = Infinity;

    if (pos && allCandidates && allCandidates.length) {
      for (let i = 0; i < allCandidates.length; i++) {
        const c = allCandidates[i];
        if (!c || c.team === this.team) continue;         // same team — never a target
        if (c.isDead) continue;
        if (!c.rigidBody && !c.isPlayer) continue;         // dead/despawned AI candidate
        // ── Tanks skip AI-controlled planes UNLESS engageAiPlanes is true.
        // Real players' planes (host or client) are always valid targets
        // regardless of this flag.
        if (c.vehicleType === 'plane' && !c.isPlayer && !this.engageAiPlanes) continue;
        const cp = c.pos;
        if (!cp) continue;
        const dx = cp.x - pos.x, dz = cp.z - pos.z;
        const dsq = dx * dx + dz * dz;
        if (dsq < bestDistSq) {
          bestDistSq     = dsq;
          bestPos        = cp;
          bestRigidBody  = c.rigidBody ?? null;
          bestIsPlayer   = !!c.isPlayer;
          bestTankRef    = c.tankRef ?? null;
        }
      }
    }

    if (bestRigidBody === null && bestTankRef === null) {
      // Nothing alive on the opposing side to fight — park target far away
      // so combat states never trigger. Anchored off this unit's own
      // current position (not a "playerPos" that may no longer be
      // meaningful once there are 12 players across 2 teams).
      this._scratchFarTarget = this._scratchFarTarget || { x: 0, y: 0, z: 0 };
      this._scratchFarTarget.x = pos.x + 1e6;
      this._scratchFarTarget.y = pos.y;
      this._scratchFarTarget.z = pos.z;
      return { pos: this._scratchFarTarget, rigidBody: null, isPlayer: false, tankRef: null };
    }

    return { pos: bestPos, rigidBody: bestRigidBody, isPlayer: bestIsPlayer, tankRef: bestTankRef };
  }

  // ── Main update ───────────────────────────────────────────────────────────

  /**
   * @param {number}          dt
   * @param {THREE.Vector3}   playerPos   – player tank world position
   * @param {Function|null}   onShoot     – called when enemy fires (pos, dir) => void
   */
update(dt, playerPos, onShoot, onMuzzleFlash, bulletSystem = null, onHitPlayer = null, audioSystem = null, playerRigidBody = null, allCandidates = null, isPlayerTeam = false) {
  if (!this.active) return;
  this._sharedBulletSystem = bulletSystem;
  if (this._dissolveActive) {
    this._tickDissolve(dt);
    return;
  }
  if (!this.rigidBody) return;

  const pos = this.rigidBody.translation();
  const rot = this.rigidBody.rotation();

  // ── Distance to the real player — computed ONCE per frame here, reused
  // below for both engine volume and fire-sound attenuation. The listener
  // is always the player, so loudness must fall off from the player's
  // position regardless of whether this tank is fighting the player or a
  // friendly tank — using combatTarget's distance instead would be wrong.
  // 3D distance (includes Y) so a player flying overhead in a plane is
  // correctly heard as far away instead of "right on top of" the tank. ──
  const _dxToPlayer = pos.x - playerPos.x;
  const _dyToPlayer = pos.y - playerPos.y;
  const _dzToPlayer = pos.z - playerPos.z;
  this._distToPlayer = Math.sqrt(
    _dxToPlayer * _dxToPlayer + _dyToPlayer * _dyToPlayer + _dzToPlayer * _dzToPlayer
  );

  // ── Remembered for _steerToward()'s avoidance blend below — the real
  // player's current position, refreshed every frame this tank updates.
  // Only tanks on the PLAYER'S OWN team should steer away from the player
  // (avoids friendlies driving through them); an opposing-team tank must
  // never avoid the player — it should close in and engage instead. This
  // is what previously made enemy tanks visibly "back off" as the player
  // approached.
  this._avoidPos = isPlayerTeam ? playerPos : null;

  // ── Engine sound ───────────────────────────────────────────────────────
  if (audioSystem) {
    const vel = this.rigidBody.linvel();
    const spd = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    // ← FIX: pass this tank's OWN engine sound (from its locked tankDef),
    // not the player's — previously every AI tank shared the player's
    // engine sound because audioSystem silently defaulted to it.
    audioSystem.updateEnemyEngine(
      this._id, dt, spd / 3.5, spd > 0.1, this._distToPlayer,
      false, 1, 1, this._tankDef?.config?.tankSound ?? 'light'
    );
  }

// const pos = this.rigidBody.translation();
//   const rot = this.rigidBody.rotation();
  const worldQ = this._scratchWorldQ.set(rot.x, rot.y, rot.z, rot.w);

  this._cachedPos = pos;   // publish this tank's position for other tanks' target search this frame
  const combatTarget = this._findCombatTarget(pos, allCandidates);
  const dx = pos.x - combatTarget.pos.x;
  const dz = pos.z - combatTarget.pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  // ── FSM transitions ──────────────────────────────────────────────────────
  // Combat overrides whatever "job" state the tank is doing (TRAVEL /
  // HOLDING / PATROL_CURVE); the job is remembered in _prevJobState and
  // resumed once no living target remains in range.
  // NOTE: gated on combatTarget.rigidBody (player OR nearest friendly),
  // NOT on playerRigidBody directly — this lets enemies keep fighting
  // friendlies even while the player is dead/respawning/spawn-picking.
  const isJobState = this.state === STATE.TRAVEL || this.state === STATE.HOLDING
                   || this.state === STATE.PATROL_CURVE || this.state === STATE.IDLE;
  const hasLivingTarget = !!combatTarget.rigidBody;

  if (hasLivingTarget && dist < ATTACK_RANGE) {
    if (this.state !== STATE.ATTACK) {
      if (isJobState) this._prevJobState = this.state;
      this.state = STATE.ATTACK;
      this._hullTurnTimer  = 0;
      this._lastHullTorque = 0;
      this.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);

      // ── Start a fresh movement cycle every time the tank (re)enters
      // ATTACK — e.g. after chasing back in from ENGAGE.
      this._attackPhase      = 'rotate';
      this._attackPhaseTimer = 0;
      this._attackRotateSign = Math.random() < 0.5 ? -1 : 1;
      const _r = this.rigidBody.rotation();
      this._scratchQ.set(_r.x, _r.y, _r.z, _r.w);
      this._attackRotateStartYaw = this._hullEuler.setFromQuaternion(this._scratchQ, 'YXZ').y;

      // ── Force an immediate line-of-sight check next frame instead of
      // trusting whatever _hasLOS was left over from a previous bout.
      this._hasLOS             = true;
      this._losCheckTimer      = 0;
      this._hasLosStrafeTarget = false;
    }
  } else if (hasLivingTarget && dist < DETECT_RANGE) {
    if (isJobState) this._prevJobState = this.state;
    if (this.state !== STATE.ATTACK) this.state = STATE.ENGAGE;
  } else if ((this.state === STATE.ATTACK || this.state === STATE.ENGAGE)
             && (!hasLivingTarget || dist > STOP_CHASE_RANGE)) {
    this.state = this._prevJobState ?? STATE.PATROL_CURVE;
  }

  // ── FSM actions ──────────────────────────────────────────────────────────
  let leftThrottle  = 0;
  let rightThrottle = 0;

if (this.state === STATE.TRAVEL) {
  // Heading for an assigned capture point (EnemyTankPool assigns/clears this)
  const cp = this.assignedCP;
  if (!cp) {
    this.state = STATE.PATROL_CURVE;
  } else {
    const dx = cp.x - pos.x, dz = cp.z - pos.z;
    if (Math.sqrt(dx * dx + dz * dz) < CP_ARRIVE_RADIUS) {
      this.state         = STATE.HOLDING;
      this._path          = null;   // clear so a fresh path builds next TRAVEL
      this._cpHoldTimer   = CP_HOLD_DURATION;
      this._readyToRotate = false;
    } else {
      const r = this._followPath(cp, CHASE_SPEED, dt);
      leftThrottle  = r.leftThrottle;
      rightThrottle = r.rightThrottle;
    }
  }

}else if (this.state === STATE.HOLDING) {
  // Sitting on / defending an assigned capture point — hull stays fully
  // still (no more circling), turret idly sweeps to a new random yaw every
  // ~5 seconds. After CP_HOLD_DURATION seconds it hands off to the pool's
  // rotation coordinator, which sends it to the next point in its route.
  const cp = this.assignedCP;
  if (!cp) {
    this.state = STATE.PATROL_CURVE;
  } else {
    // ── Hull: fully stopped ────────────────────────────────────────────
    const angVel = this.rigidBody.angvel();
    if (Math.abs(angVel.y) > 0.005) {
      this.rigidBody.setAngvel({ x: angVel.x, y: 0, z: angVel.z }, true);
    }
    const vel = this.rigidBody.linvel();
    this.rigidBody.applyImpulse({
      x: -vel.x * 6.0 * dt,
      y: 0,
      z: -vel.z * 6.0 * dt,
    }, true);
    leftThrottle  = 0;
    rightThrottle = 0;

    // ── Turret: idle sweep — pick a new random target yaw every ~5s ────
    this._turretIdleTimer = (this._turretIdleTimer ?? 0) - dt;
    if (this._turretIdleTimer <= 0) {
      this._turretIdleTimer  = 5 + Math.random() * 2;   // 5-7s between sweeps, feels less robotic
      this._turretIdleTarget = Math.random() * Math.PI * 2 - Math.PI;   // random yaw in [-PI, PI]
    }
    if (this._turretMesh) {
      const turretMin = this._tankDef?.config?.turretMinAngle ?? -Math.PI;
      const turretMax = this._tankDef?.config?.turretMaxAngle ??  Math.PI;
      const desiredLocalYaw = THREE.MathUtils.clamp(
        this._turretIdleTarget ?? 0, turretMin, turretMax
      );
      const currentYaw = this._turretMesh.rotation.y;
      let delta = desiredLocalYaw - currentYaw;
      while (delta >  Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this._turretMesh.rotation.y += delta * Math.min(1, dt * (TURN_SPEED * 0.3));   // slower, idle-feeling sweep
    }

    this._cpHoldTimer -= dt;
    // _readyToRotate is just a flag; EnemyTankPool._updateCaptureAssignments
    // reads it and performs the actual hand-off to the next route point.
    this._readyToRotate = this._cpHoldTimer <= 0;
  }

} else if (this.state === STATE.PATROL_CURVE) {
  // No capture point needs this tank — follow the Blender-authored curve.
  // Only the squad leader samples the curve; followers chase a point on the
  // leader's recorded trail (convoy behaviour, cheap for the rest of the squad).
  if (!this.curve) {
    // No curve configured on this map — random-point patrol, routed via NavGrid.
    this.patrolTimer -= dt;
    const curPos3 = this._scratchPos.set(pos.x, 0, pos.z);
    const toDest  = curPos3.distanceTo(this.patrolTarget);
    if (this.patrolTimer <= 0 || toDest < 8) {
      this._pickNewPatrolTarget(curPos3);
      this._path = null;   // force a fresh path to the new target
    }
    const r = this._followPath(this.patrolTarget, PATROL_SPEED, dt);
    leftThrottle  = r.leftThrottle;
    rightThrottle = r.rightThrottle;
  } else if (this.role === 'follower' && this.squad) {
    const idx    = this.squad.followers.indexOf(this);
    const target = this.squad.getTrailTarget(idx) ?? this.curve.getPointAt(this.curveT);
    const r = this._steerToward(target, CHASE_SPEED, dt);
    leftThrottle  = r.leftThrottle;
    rightThrottle = r.rightThrottle;
  } else {
    // Leader (or solo tank with no squad) — advance along the curve.
    this.curveT = this.curve.advance(this.curveT, PATROL_SPEED * CURVE_SPEED_UNITS * dt);
    const target = this.curve.getPointAt(this.curveT);
    const r = this._steerToward(target, PATROL_SPEED, dt);
    leftThrottle  = r.leftThrottle;
    rightThrottle = r.rightThrottle;
    this.squad?.recordTrail(pos, dt);
  }

} else if (this.state === STATE.ENGAGE) {
  const r = this._steerToward(combatTarget.pos, CHASE_SPEED, dt);
  leftThrottle  = r.leftThrottle;
  rightThrottle = r.rightThrottle;

} else if (this.state === STATE.ATTACK) {

  // ── Line-of-sight check — periodic (LOS_CHECK_INTERVAL), cached in
  // this._hasLOS between checks so we're not raycasting every single frame.
  this._losCheckTimer -= dt;
  if (this._losCheckTimer <= 0) {
    this._losCheckTimer = LOS_CHECK_INTERVAL;
    let losOrigin;
    if (this._gunPoint) {
      this._gunPoint.getWorldPosition(this._scratchWorldPos);
      losOrigin = this._scratchWorldPos;
    } else {
      losOrigin = { x: pos.x, y: pos.y + 0.6, z: pos.z };
    }
    this._hasLOS = this._checkLineOfSight(losOrigin, combatTarget.pos, combatTarget.rigidBody);
  }

  if (!this._hasLOS) {
    // ── Something (house/wall/fence) is blocking the shot — reposition
    // instead of running the normal in-place attack shuffle below.
    const r = this._repositionForLineOfSight(pos, combatTarget, dt);
    leftThrottle  = r.leftThrottle;
    rightThrottle = r.rightThrottle;

    // Reset the shuffle cycle so it starts clean once LOS is regained.
    this._attackPhase      = 'rotate';
    this._attackPhaseTimer = 0;

  } else if (!this.jiggleFight) {

    // ── jiggleFight disabled — normal fight: just stop and hold position.
    // No rotate/forward/pause/backward shuffle; turret tracking, LOS check,
    // and shooting below still run exactly the same as the jiggle path.
    this.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const vel = this.rigidBody.linvel();
    this.rigidBody.applyImpulse({ x: -vel.x * 6.0 * dt, y: 0, z: -vel.z * 6.0 * dt }, true);
    leftThrottle  = 0;
    rightThrottle = 0;

  } else {

  // ── Discrete movement cycle instead of continuous strafing:
  // rotate ~45° in place → drive forward → pause → drive backward → pause → repeat.
  // Cheap: just a phase enum + timer, reuses existing scratch vectors/impulse calls.
  this._attackPhaseTimer += dt;

  // worldQ was already computed once at the top of update() — no need to
  // refetch rigidBody.rotation() a second time here.
  const curYaw = this._hullEuler.setFromQuaternion(worldQ, 'YXZ').y;

  if (this._attackPhase === 'rotate') {
    // Turn in place toward attackRotateStartYaw ± 45°, then move on.
    let target = this._attackRotateStartYaw + this._attackRotateSign * ATTACK_ROTATE_ANGLE;
    let delta  = target - curYaw;
    while (delta >  Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    if (Math.abs(delta) < 0.05) {
      // Reached ~45° — stop turning, kill angvel, move to forward leg.
      this.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this._attackPhase      = 'forward';
      this._attackPhaseTimer = 0;
    } else {
      const turnDir = Math.sign(delta);
      this.rigidBody.setAngvel({ x: 0, y: turnDir * ATTACK_ROTATE_SPEED, z: 0 }, true);
    }
    // Brake linear drift during the rotate
    const vel = this.rigidBody.linvel();
    this.rigidBody.applyImpulse({ x: -vel.x * 6.0 * dt, y: 0, z: -vel.z * 6.0 * dt }, true);
    leftThrottle  = 0;
    rightThrottle = 0;

  } else if (this._attackPhase === 'forward') {
    this.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const fwd = this._getForward();

    // Cap current forward speed so the impulse doesn't keep stacking
    // velocity frame after frame — only push while under the target speed.
    const vel      = this.rigidBody.linvel();
    const fwdSpeed = fwd.x * vel.x + fwd.z * vel.z;
    const maxSpeed = ATTACK_MOVE_SPEED * 6;   // small absolute cap, tune to taste
    if (fwdSpeed < maxSpeed) {
      this.rigidBody.applyImpulse({
        x: fwd.x * ATTACK_MOVE_SPEED * ATTACK_MOVE_FORCE_MUL * dt,
        y: 0,
        z: fwd.z * ATTACK_MOVE_SPEED * ATTACK_MOVE_FORCE_MUL * dt,
      }, true);
    }
    leftThrottle  = ATTACK_MOVE_SPEED;
    rightThrottle = ATTACK_MOVE_SPEED;

    if (this._attackPhaseTimer >= ATTACK_FORWARD_TIME) {
      this._attackPhase      = 'pause1';
      this._attackPhaseTimer = 0;
    }

  } else if (this._attackPhase === 'pause1' || this._attackPhase === 'pause2') {
    this.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const vel = this.rigidBody.linvel();
    this.rigidBody.applyImpulse({ x: -vel.x * 6.0 * dt, y: 0, z: -vel.z * 6.0 * dt }, true);
    leftThrottle  = 0;
    rightThrottle = 0;

    if (this._attackPhaseTimer >= ATTACK_PAUSE_TIME) {
      if (this._attackPhase === 'pause1') {
        this._attackPhase = 'backward';
      } else {
        // pause2 finished — loop straight back to forward. The 45° rotate
        // only ever happens once, right when the tank first enters ATTACK
        // (see the state-transition block) — not on every cycle.
        this._attackPhase = 'forward';
      }
      this._attackPhaseTimer = 0;
    }

  } else if (this._attackPhase === 'backward') {
    this.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const fwd = this._getForward();

    const vel      = this.rigidBody.linvel();
    const bwdSpeed = -(fwd.x * vel.x + fwd.z * vel.z);
    const maxSpeed = ATTACK_MOVE_SPEED * 6;
    if (bwdSpeed < maxSpeed) {
      this.rigidBody.applyImpulse({
        x: -fwd.x * ATTACK_MOVE_SPEED * ATTACK_MOVE_FORCE_MUL * dt,
        y: 0,
        z: -fwd.z * ATTACK_MOVE_SPEED * ATTACK_MOVE_FORCE_MUL * dt,
      }, true);
    }
    leftThrottle  = -ATTACK_MOVE_SPEED;
    rightThrottle = -ATTACK_MOVE_SPEED;

    if (this._attackPhaseTimer >= ATTACK_BACKWARD_TIME) {
      this._attackPhase      = 'pause2';
      this._attackPhaseTimer = 0;
    }
  }

  } // ← closes the `else` (has-LOS) branch opened above

  // ── Turret rotation toward player ─────────────────────────────────────

    // ── Turret rotation toward player ──────────────────────────────────────
if (this._turretMesh) {
  const toPlayer = this._toPlayerVec.set(
    combatTarget.pos.x - pos.x, 0, combatTarget.pos.z - pos.z
  ).normalize();

  const targetWorldYaw = Math.atan2(toPlayer.x, toPlayer.z);
  const hullEuler = this._hullEuler.setFromQuaternion(worldQ, 'YXZ');
  const hullYaw   = hullEuler.y;

  let desiredLocalYaw = targetWorldYaw - hullYaw + Math.PI / 2;
  while (desiredLocalYaw >  Math.PI) desiredLocalYaw -= Math.PI * 2;
  while (desiredLocalYaw < -Math.PI) desiredLocalYaw += Math.PI * 2;

  // Clamp to turret rotation limits from tankDef config
  const turretMin = this._tankDef?.config?.turretMinAngle ?? -Math.PI;
  const turretMax = this._tankDef?.config?.turretMaxAngle ??  Math.PI;

  // ── Hull rotation assist — player is outside turret arc ──────────────────
  // Only kick in when turret range is genuinely limited (< 180° total arc)
  const turretArc = turretMax - turretMin;
  const isLimitedTurret = turretArc < Math.PI;

  if (isLimitedTurret) {
    const isOutOfRange = desiredLocalYaw < turretMin || desiredLocalYaw > turretMax;

    if (isOutOfRange) {
      // Determine which limit was hit and rotate hull in that direction
      const overflowDir = desiredLocalYaw > turretMax ? 1 : -1;
      const HULL_ASSIST_TORQUE = 2.2;
      this.rigidBody.applyTorqueImpulse(
        { x: 0, y: overflowDir * HULL_ASSIST_TORQUE * 800 * dt, z: 0 },
        true
      );

      // Also brake linear velocity so tank pivots in place cleanly
      const vel = this.rigidBody.linvel();
      this.rigidBody.applyImpulse({
        x: -vel.x * 4.0 * dt,
        y: 0,
        z: -vel.z * 4.0 * dt,
      }, true);

      // Drive belt scroll during hull rotation:
      // left track forward when rotating right, backward when rotating left
      leftThrottle  = -overflowDir * 0.6;
      rightThrottle =  overflowDir * 0.6;
    }
  }

  desiredLocalYaw = THREE.MathUtils.clamp(desiredLocalYaw, turretMin, turretMax);

  const currentYaw = this._turretMesh.rotation.y;
  let delta = desiredLocalYaw - currentYaw;
  while (delta >  Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;

  this._turretMesh.rotation.y += delta * Math.min(1, dt * TURN_SPEED);
}

    // ── Barrel pitch toward player ─────────────────────────────────────────
if (this._barrelMesh) {
  // Build world-space direction to combat target
  const toPlayer = this._toPlayerVec.set(
    combatTarget.pos.x - pos.x,
    combatTarget.pos.y - pos.y,
    combatTarget.pos.z - pos.z
  ).normalize();

  // Transform direction into turret local space so hull incline is cancelled out
  this._turretMesh
    ? this._turretMesh.getWorldQuaternion(this._scratchTurretQ)
    : this._scratchTurretQ.copy(worldQ);

  this._scratchTurretQInv.copy(this._scratchTurretQ).invert();
  const localDir = this._scratchLocalDir.copy(toPlayer).applyQuaternion(this._scratchTurretQInv);

  // Pitch in turret local space: atan2(up, forward)
  // localDir.x is forward in turret local space (barrel points along -X or +X depending on model)
  const hDist       = Math.sqrt(localDir.x * localDir.x + localDir.z * localDir.z);
  const targetPitch = Math.atan2(-localDir.y, hDist);

  const MIN_PITCH    = this._tankDef?.config?.barrelMinAngle ?? -0.25;
  const MAX_PITCH    = this._tankDef?.config?.barrelMaxAngle ??  0.25;
  const clampedPitch = THREE.MathUtils.clamp(targetPitch, MIN_PITCH, MAX_PITCH);
  this._barrelMesh.rotation.x += (clampedPitch - this._barrelMesh.rotation.x) * Math.min(1, dt * TURN_SPEED);
}

// ── Shoot ──────────────────────────────────────────────────────────────
this.shootTimer -= dt;

if (this.shootTimer <= 0 && combatTarget.rigidBody && !this._hasLOS) {
  // Blocked — don't burn the reload cycle uselessly; check again very
  // soon so the tank fires almost immediately once LOS is regained.
  this.shootTimer = 0.2;
}

if (this.shootTimer <= 0 && combatTarget.rigidBody && this._hasLOS) {   // ← only shoot if target is alive AND visible
  this.shootTimer = this._shootInterval + Math.random() * 0.05;

  let shootOrigin;
  let shootDir;

  if (this._gunPoint) {
    this._gunPoint.getWorldPosition(this._scratchWorldPos);
    shootOrigin = this._scratchWorldPos.clone();
    this._gunPoint.getWorldDirection(this._scratchToTgt);
    shootDir = this._scratchToTgt.clone().normalize();
  } else {
    const fwd = this._getForward();
    shootOrigin = new THREE.Vector3(pos.x, pos.y + 0.6, pos.z);
    shootDir    = fwd.clone().normalize();
  }

if (this._ownBulletSystem) {
  // gunType 2 — arc projectile fired from own system
  this._ownBulletSystem.fireFromPoint(
    shootOrigin,
    shootDir,
    this.rigidBody,
    onHitPlayer ? () => onHitPlayer(this._ownBulletSystem.damage, combatTarget, this._distToPlayer, { x: pos.x, y: pos.y, z: pos.z }, this) : null,
    combatTarget.rigidBody
  );
} else if (bulletSystem) {
  // gunType 1 — instant raycast via shared system
  bulletSystem.fireFromPoint(
    shootOrigin,
    shootDir,
    this.rigidBody,
    onHitPlayer ? () => onHitPlayer(this._tankDef?.config?.damage ?? 25, combatTarget, this._distToPlayer, { x: pos.x, y: pos.y, z: pos.z }, this) : null,
    combatTarget.isPlayer ? null : combatTarget.rigidBody
  );
}

const _fireSound = this._tankDef?.config?.fireSound ?? 1;
if (audioSystem?._ready) {
  audioSystem.playEnemyShot(_fireSound, this._distToPlayer);
} else {
  audioSystem?._resume?.().then(() => audioSystem.playEnemyShot(_fireSound, this._distToPlayer));
}

onMuzzleFlash?.(shootOrigin);
this._explosionSystem?.spawnMuzzleFlash(shootOrigin);
this._fireSeq++;   // ← ADD — signals this shot to remote clients via match:ai-state

// Delay explosion sound so it doesn't overlap the shot sound
// setTimeout(() => {
//   audioSystem?.playExplosion();
// }, 180);
}
}

// ── Tick own projectile system (gunType 2) ────────────────────────────
  this._ownBulletSystem?.update(dt);

  // ── Tick tracers ─────────────────────────────────────────────────────────
  if (this._tracers.length) {
    for (let i = this._tracers.length - 1; i >= 0; i--) {
      const t = this._tracers[i];
      t.timer -= dt;
      t.mat.opacity = Math.max(0, t.timer / 0.10);
      if (t.timer <= 0) {
        this.scene.remove(t.line);
        t.geo.dispose();
        t.mat.dispose();
        this._tracers.splice(i, 1);
      }
    }
  }

  // ── Visual body transform ────────────────────────────────────────────────
// ── Visual body transform ────────────────────────────────────────────────
  const worldPos3 = this._scratchWorldPos.set(pos.x, pos.y, pos.z);
  this.bodyGroup.position.copy(worldPos3);
  this.bodyGroup.quaternion.copy(worldQ);

  // ── Track update ─────────────────────────────────────────────────────────
  if (this.trackLeft && this.trackRight) {
    this.trackLeft.update(
      dt, leftThrottle, worldPos3, worldQ, null, playerPos
    );
    this.trackRight.update(
      dt, rightThrottle, worldPos3, worldQ, null, playerPos
    );
  }
}

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroyPermanently() {
    this.deactivate();
    this.scene.remove(this.bodyGroup);
  }
}

// ── EnemyTankPool ─────────────────────────────────────────────────────────────

export class EnemyTankPool {
  /**
   * @param {THREE.Scene}    scene
   * @param {object}         world         – Rapier world (with .__RAPIER__ set)
   * @param {TerrainBuilder} terrain       – for getHeightAtWorld()
   * @param {object}         opts
   * @param {object}         opts.playerTank      – Tank instance
   * @param {Function}       opts.onEnemyShoot    – (origin:Vector3, dir:Vector3) => void
   * @param {number}         [opts.maxTanks=3]
   * @param {string}         [opts.modelPath]
   */
  constructor(scene, world, terrain, opts = {}) {
    this.scene   = scene;
    this.world   = world;
    this.terrain = terrain;

    this.maxTanks     = opts.maxTanks    ?? MAX_TANKS;
    this.playerTank   = opts.playerTank  ?? null;
    this.onEnemyShoot  = opts.onEnemyShoot  ?? null;
    this.onMuzzleFlash = opts.onMuzzleFlash ?? null;
    this.bulletSystem  = opts.bulletSystem  ?? null;
    this.onHitPlayer   = opts.onHitPlayer   ?? null;   // (damage, combatTarget) => void — called when raycast hits the player OR a friendly
    this.modelPath    = opts.modelPath   ?? '/model/Tank_Tiger_L.glb';

    // ── Team ID this pool's AI units belong to (1 or 2). Every unit
    // spawned by this pool is tagged with this team in trySpawn(). ───────
    this.team = opts.team ?? 1;

    // ── Toggle: should this pool's tanks fight AI-controlled planes?
    // false = tanks ignore AI planes (only fight real players' planes).
    // true  = tanks treat AI planes as valid targets too.
    this.engageAiPlanes = opts.engageAiPlanes ?? false;
    // ← ADD
    // ── True when this pool's team matches the LOCAL PLAYER's own team —
    // only tanks on the player's team should steer away from the player
    // (see EnemyTank._avoidPos); opposing-team tanks must never avoid the
    // player, or they visibly "back off" instead of engaging.
    this.isPlayerTeam = opts.isPlayerTeam ?? false;

    // ── Flat candidate list (every real player + every AI unit, both
    // teams), rebuilt once per frame by main.js and pushed to every pool
    // via setAllCandidates(). Replaces the old friendlyPoolRef/remoteTargets
    // combining logic — team-relative filtering now happens inside each
    // unit's own _findCombatTarget(), not by which array it arrived in.
    this._allCandidatesRef = opts.allCandidates ?? [];

    // ── Fixed spawn points, capture points & navmesh (map-authored) ─────────
    this.spawnPoints    = opts.spawnPoints   ?? [];
    this.capturePoints  = opts.capturePoints ?? [];
    this.navGrid        = opts.navGrid       ?? null;
    this._nextSpawnIdx  = 0;
    this._squads        = [];
    this._cpAssignTimer = 0;

    // ── Capture-point squads: groups of up to SQUAD_MAX_SIZE tanks that are
    // assigned to, and rotate through, capture points together. Built once,
    // lazily, the first time _updateCaptureAssignments sees unassigned tanks
    // whose count matches the pool's expected active roster. ───────────────
    this._captureSquads = null;   // array of { tankIds: Set<string>, routeIdx: number, capturePointOrder: cp[] }

    // Pre-load the GLB once
    this._modelPromise = _getSharedModel(this.modelPath);

    // Track config mirrors your player tank defaults
this._tankDefs    = [];        // populated after JSON fetch — each tank picks a random entry on spawn

// Fetch tank definitions
const dataPath = opts.tanksDataPath ?? '/enemytanks.json';
this._defsReady = fetch(dataPath)
  .then(r => {
    if (!r.ok) throw new Error(`Failed to load tank defs: ${r.status} ${r.url}`);
    return r.json();
  })
  .then(defs => {
    this._tankDefs = defs;
  })
  .catch(err => console.error('[EnemyTankPool] Failed to load tank defs:', err));

    // Pre-create pool (all inactive)
    this._pool = Array.from(
      { length: this.maxTanks },
      () => new EnemyTank(scene, world)
    );

    // Spawn timer
    this._spawnInterval = opts.spawnInterval ?? 15;   // seconds between auto-spawns
    this._spawnTimer    = 3;   // first spawn after 3 seconds

    // Reusable player position vector
    this._playerPos = new THREE.Vector3();
    this._explosionSystem = opts.explosionSystem ?? null;
    this._audioSystem     = opts.audioSystem     ?? null;
    // Cached active tanks array — reused every frame to avoid allocation
    this._activeTanksCache = [];    
  }


  /** Called once per frame by main.js with the flat, team-tagged candidate
   * list (see _buildAiCandidateList() in main.js). Every pool — regardless
   * of which team it belongs to — receives the SAME list; each unit filters
   * it down to "not my team" inside _findCombatTarget(). */
  setAllCandidates(list) {
    this._allCandidatesRef = list ?? [];
  }

  /**
   * Repoints which vehicle enemy AI targets/aims at — call this whenever
   * the player switches between tank and plane. Without this, enemies
   * keep shooting at whichever vehicle was passed in at construction time
   * (always the tank), even while the player is flying and the tank sits
   * parked far below the map.
   * @param {object} vehicle — the Tank or Plane instance currently being
   *   driven/flown by the player. Must expose .rigidBody.
   */
  setActivePlayerVehicle(vehicle) {
    this.playerTank = vehicle ?? null;
  }

  /**
   * Live-adjusts this pool's tank cap. The pool only pre-allocates
   * `maxTanks` EnemyTank instances at construction — just changing
   * `this.maxTanks` without growing `_pool` would let the cap say "room
   * for more" while trySpawn() still finds no inactive instance to use.
   * Shrinking never force-kills already-active tanks; it just lowers the
   * ceiling trySpawn()/_isFriendlyPoolFull() check against.
   */
  setMaxTanks(n) {
    const newMax = Math.max(0, Math.floor(n));
    if (newMax > this._pool.length) {
      const toAdd = newMax - this._pool.length;
      for (let i = 0; i < toAdd; i++) {
        this._pool.push(new EnemyTank(this.scene, this.world));
      }
    }
    this.maxTanks = newMax;

    // ── Actively cull down to the new cap. ...
    const active = this.getActiveTanks();
    let excess = active.length - newMax;
    for (let i = active.length - 1; i >= 0 && excess > 0; i--) {
      const t = active[i];
      if (t.isDead) continue;
      t.deactivate();
      excess--;
    }

    // ── If the cap just grew, fill the newly-opened slot(s) immediately
    // instead of waiting for the next _spawnTimer tick (up to
    // _spawnInterval seconds later, default 15s) — avoids a "the flex
    // unit never shows up" delay right after a squad switch resolves.
    // Safe no-op if tank defs haven't finished loading yet — the normal
    // spawn timer will pick it up as soon as they're ready.
    if (this._activeCount() < this.maxTanks) {
      this.trySpawn();
    }
  }

  // ── Spawn helpers ─────────────────────────────────────────────────────────

  _getInactiveTank() {
    return this._pool.find(t => !t.active) ?? null;
  }

_activeCount() {
  let n = 0;
  for (const t of this._pool) if (t.active) n++;
  return n;
}

  /**
   * Try to find a valid spawn position on the terrain.
   * Returns {x, y, z} or null.
   */
  _findSpawnPos(playerPos) {
    const terrain  = this.terrain;
    const halfSize = terrain.worldSize / 2 - SPAWN_MARGIN;

    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      // Random position in a ring around the player
      const angle = Math.random() * Math.PI * 2;
      const dist  = MIN_SPAWN_DIST + Math.random() * (MAX_SPAWN_DIST - MIN_SPAWN_DIST);
      const x     = playerPos.x + Math.cos(angle) * dist;
      const z     = playerPos.z + Math.sin(angle) * dist;

      // Stay within terrain bounds
      if (Math.abs(x) > halfSize || Math.abs(z) > halfSize) continue;

      const y = terrain.getHeightAtWorld(x, z) + 1.5;   // float above ground
      return { x, y, z };
    }
    return null;   // failed to find valid position
  }

  /**
   * Attempt to spawn one enemy tank.
   * Returns true if successful.
   */
  // AFTER
  trySpawn() {
    if (this._activeCount() >= this.maxTanks) return false;

    const tank = this._getInactiveTank();
    if (!tank) return false;

    if (!this._tankDefs.length) {
      console.warn('[EnemyTankPool] Tank defs not ready yet — skipping spawn');
      return false;
    }

    // ── Pick the tank type ONCE per pool slot, then reuse it on every respawn
    // of that same slot — no re-rolling, no level-based upgrading. ─────────
    if (!tank._lockedTankDef) {
      tank._lockedTankDef      = this._tankDefs[Math.floor(Math.random() * this._tankDefs.length)];
      tank._lockedTrackCfg     = _buildTrackCfgFromDef(tank._lockedTankDef);
      tank._lockedModelPromise = _getSharedModel(tank._lockedTankDef.modelPath);
    }
    const tankDef       = tank._lockedTankDef;
    const trackCfg      = tank._lockedTrackCfg;
    const modelPromise  = tank._lockedModelPromise;

    // ── Fixed spawn points (round-robin) — falls back to a ring around the
    // player only if the map hasn't defined any spawnPoints ────────────────
    let pos;
    if (this.spawnPoints.length) {
      const sp = this.spawnPoints[this._nextSpawnIdx % this.spawnPoints.length];
      this._nextSpawnIdx++;
      pos = { x: sp.x, y: this.terrain.getHeightAtWorld(sp.x, sp.z) + 1.5, z: sp.z };
    } else {
      const playerPos = this.playerTank?.rigidBody?.translation() ?? { x: 0, y: 0, z: 0 };
      pos = this._findSpawnPos(playerPos);
      if (!pos) return false;
    }

    tank.activate(pos, trackCfg, modelPromise, this._explosionSystem, tankDef, this.team, this.engageAiPlanes);
    tank._audioSystem = this._audioSystem;
    tank.navGrid = this.navGrid;

    // Default job: join a curve-patrol squad. The capture-point coordinator
    // will pull it off onto a point if one needs it.
    this._assignToSquad(tank);
    return true;
  }

  // ── Main update ───────────────────────────────────────────────────────────

  /**
   * Call every frame from your main game loop.
   * @param {number}        dt
   * @param {THREE.Vector3} playerPos   – current player world position
   */
  update(dt, playerPos) {
    // Auto-spawn timer
    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = this._spawnInterval;
      this.trySpawn();
    }

    // ── Drain queued NEAR-mode track builds, a few per frame ────────────────
    // Prevents multiple tanks crossing the LOD threshold in the same frame
    // from all building heavy geometry/materials synchronously (stutter).
    EnemyTrackSystem.drainNearQueue();

    // Capture-point (re)assignment — throttled internally
    this._updateCaptureAssignments(dt);

    // Update active tanks
    const shootCb      = this.onEnemyShoot;
    const flashCb      = this.onMuzzleFlash;
    const bulletSystem = this.bulletSystem;
    const onHitPlayer  = this.onHitPlayer;
    const audioSystem  = this._audioSystem;

    // Build active list ONCE — reused for updates and separation below
    const activeTanks = this.getActiveTanks();

// ── allCandidates is now built ONCE PER FRAME by main.js and handed to
// every pool via setAllCandidates() (see main.js's _buildAiCandidateList()
// + the sendAiStateIfDue/update wiring). It's a flat list covering every
// real player (local + remote) and every AI unit across BOTH team pools.
// Falls back to an empty array defensively if main.js hasn't wired it yet.
const allCandidates = this._allCandidatesRef ?? [];

    for (const tank of activeTanks) {
      // ── Re-resolve the player's rigid body fresh for EACH tank, not once
      // for the whole frame — an earlier tank in this same loop can kill
      // the player (via onHitPlayer → tank._die() → world.removeRigidBody()),
      // which would otherwise leave later tanks (and the anti-clip block
      // below) holding a stale/freed rigid-body handle and crash Rapier
      // with a "recursive use of an object" panic the instant .translation()/
      // .linvel() is called on it. Mirrors the identical fix already applied
      // in EnemyPlanePool.update().
      const _freshPlayerRigidBody = this.playerTank?.rigidBody ?? null;
      tank.update(dt, playerPos, shootCb, flashCb, bulletSystem, onHitPlayer, audioSystem, _freshPlayerRigidBody, allCandidates, this.isPlayerTeam);

// Auto-deactivate if tank falls off terrain OR is flipped ~90°
if (tank.rigidBody) {
    const p = tank._cachedPos ?? tank.rigidBody.translation();
    const halfSize = this.terrain.worldSize / 2 + 10;
    if (Math.abs(p.x) > halfSize || Math.abs(p.z) > halfSize || p.y < -20) {
        tank.deactivate();
        continue;   // rigidBody is now null — skip flip check
    }

    // Guard again — deactivate() nulls rigidBody
    if (tank.rigidBody) {
        const rot = tank.rigidBody.rotation();
        tank._scratchFlipQ.set(rot.x, rot.y, rot.z, rot.w);
        tank._scratchUp.set(0, 1, 0).applyQuaternion(tank._scratchFlipQ);
        if (tank._scratchUp.y < 0.707) {
            tank._resetUpright();
        }
    }
}
    }

    // ── Combined tank-tank + tank-player separation — single merged pass.
    // Reuses each tank's _cachedPos (already captured this frame inside
    // EnemyTank.update()) instead of re-querying rigidBody.translation()
    // a second/third time per tank — .translation() allocates a fresh
    // object crossing the WASM boundary on every call, and the old
    // two-loop version called it up to (n-1) times per tank in the
    // pairwise loop, then AGAIN per tank in the separate player-clip loop,
    // for data already on hand. MIN_SEP_DIST (real AI-vs-AI spacing) and
    // PLAYER_CLIP_DIST (a much gentler anti-overlap nudge vs. the player)
    // stay behaviorally distinct — only the redundant position lookups
    // and the second full pass over activeTanks are merged away.
    const MIN_SEP_DIST        = 6.0; // metres — minimum distance between tanks
    const MIN_SEP_DIST_SQ     = MIN_SEP_DIST * MIN_SEP_DIST;
    const PLAYER_CLIP_DIST    = 4.0; // metres — much tighter than tank-tank spacing
    const PLAYER_CLIP_DIST_SQ = PLAYER_CLIP_DIST * PLAYER_CLIP_DIST;

    // Re-fetch fresh here — this runs AFTER the tank update loop above,
    // where the player could have just been killed this same frame by an
    // earlier tank in that loop. A reference captured before the loop is
    // exactly what caused the Rapier "recursive use / unsafe aliasing" panic.
    const playerRigidBody = this.playerTank?.rigidBody ?? null;
    const pp = playerRigidBody ? playerRigidBody.translation() : null;

    for (let i = 0; i < activeTanks.length; i++) {
      const a = activeTanks[i];
      if (!a.rigidBody || !a._cachedPos) continue;
      const pa = a._cachedPos;

      // ── Tank vs tank ──────────────────────────────────────────────────
      for (let j = i + 1; j < activeTanks.length; j++) {
        const b = activeTanks[j];
        if (!b.rigidBody || !b._cachedPos) continue;
        const pb = b._cachedPos;

        const dx = pa.x - pb.x;
        const dz = pa.z - pb.z;
        const distSq = dx * dx + dz * dz;

        if (distSq < MIN_SEP_DIST_SQ && distSq > 0.001) {
          const dist   = Math.sqrt(distSq);
          const factor = (MIN_SEP_DIST - dist) / MIN_SEP_DIST;
          const fx = (dx / dist) * factor * 800 * dt;
          const fz = (dz / dist) * factor * 800 * dt;

          a.rigidBody.applyImpulse({ x:  fx, y: 0, z:  fz }, true);
          b.rigidBody.applyImpulse({ x: -fx, y: 0, z: -fz }, true);
        }
      }

      // ── Tank vs player — anti-clip nudge only. Deliberately NOT
      // team-gated (unlike _steerToward's real avoidance elsewhere) —
      // this just prevents visual hull overlap and applies regardless
      // of which side the tank is on.
      if (pp && !a.isDead) {
        const dx = pa.x - pp.x;
        const dz = pa.z - pp.z;
        const dy = pa.y - pp.y;
        const distSq = dx * dx + dz * dz;

        // Only treat this as a clipping risk if the player is also close
        // in altitude — otherwise a plane flying directly overhead (large
        // |dy|, near-zero XZ distance) was being treated as "on top of"
        // the tank and shoved it sideways for no real collision reason.
        const verticalOk = Math.abs(dy) < PLAYER_CLIP_DIST;

        if (verticalOk && distSq < PLAYER_CLIP_DIST_SQ && distSq > 0.001) {
          const dist      = Math.sqrt(distSq);
          const nx        = dx / dist;
          const nz        = dz / dist;
          const factor    = 1 - dist / PLAYER_CLIP_DIST;
          const pushSpeed = factor * 4;   // gentle — just prevents overlap

          const vel = a.rigidBody.linvel();
          a.rigidBody.setLinvel({
            x: vel.x + nx * pushSpeed,
            y: vel.y,
            z: vel.z + nz * pushSpeed,
          }, true);
        }
      }
    }
  }

  // ── Public helpers ────────────────────────────────────────────────────────

  /** Returns array of active EnemyTank instances */
getActiveTanks() {
    this._activeTanksCache.length = 0;
    for (const t of this._pool) {
      if (t.active) this._activeTanksCache.push(t);
    }
    return this._activeTanksCache;
  }
  // ── Squad management ──────────────────────────────────────────────────────

  _findOpenSquad() {
    for (const s of this._squads) {
      if (s.leader?.active && s.followers.length < SQUAD_MAX_SIZE - 1) return s;
    }
    return null;
  }

  _assignToSquad(tank) {
    let squad = this._findOpenSquad();
    if (!squad) {
      squad = new Squad(this._squads.length, this.patrolCurve);
      this._squads.push(squad);
    }
    if (!squad.leader || !squad.leader.active) {
      squad.leader = tank;
      tank.role    = 'leader';
    } else {
      squad.followers.push(tank);
      tank.role = 'follower';
    }
    tank.squad  = squad;
    tank.curveT = 0;   // curve no longer used — kept for backward compat only
    tank.assignedCP = null;
    tank.state       = STATE.PATROL_CURVE;
  }

  _detachFromSquad(tank) {
    const squad = tank.squad;
    if (!squad) return;
    if (squad.leader === tank) {
      squad.leader = squad.followers.shift() ?? null;
      if (squad.leader) squad.leader.role = 'leader';
    } else {
      const idx = squad.followers.indexOf(tank);
      if (idx !== -1) squad.followers.splice(idx, 1);
    }
    tank.squad = null;
    tank.role  = 'solo';
  }

  // ── Capture-point coordinator ─────────────────────────────────────────────
  // Fill any existing capture squads that have spare room (up to SQUAD_MAX_SIZE)
  // before creating brand-new squads. This matters because tanks spawn one at
  // a time (staggered by _spawnTimer), so grouping must accumulate newcomers
  // into existing squads rather than always giving each new arrival its own
  // isolated squad of 1.
  _buildCaptureSquads(tanksNeedingGroup) {
    const cps = this.capturePoints;
    if (!cps.length || !tanksNeedingGroup.length) return;

    if (!this._captureSquads) this._captureSquads = [];

    // Shuffle newcomers so grouping isn't always in spawn order.
    const shuffledTanks = [...tanksNeedingGroup];
    for (let i = shuffledTanks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledTanks[i], shuffledTanks[j]] = [shuffledTanks[j], shuffledTanks[i]];
    }

    for (const tank of shuffledTanks) {
      // ── Try to slot into an existing squad that still has room ─────────
      let squad = this._captureSquads.find(s => s.tankIds.size < SQUAD_MAX_SIZE);

      if (!squad) {
        // ── No open squad — create a new one on a capture point not yet
        // claimed by another squad, if possible (spreads coverage out). ──
        const claimedIdxs = new Set(this._captureSquads.map(s => s.routeIdx));
        let routeIdx = cps.findIndex((_, idx) => !claimedIdxs.has(idx));
        if (routeIdx === -1) routeIdx = Math.floor(Math.random() * cps.length);

        squad = { routeIdx, tankIds: new Set() };
        this._captureSquads.push(squad);
      }

      squad.tankIds.add(tank._id);
      tank._captureSquadRef = squad;
      tank._cpRouteIdx      = squad.routeIdx;
      tank.assignedCP       = cps[squad.routeIdx];
      tank.state            = STATE.TRAVEL;
      tank._path            = null;
    }
  }

  _updateCaptureAssignments(dt) {
    const cps = this.capturePoints;
    if (!cps.length) return;

    const active = this.getActiveTanks().filter(t => !t.isDead);

    // ── Group any tanks that don't yet have a capture squad ───────────────
    const needingGroup = active.filter(t =>
      t.state !== STATE.ATTACK && t.state !== STATE.ENGAGE && !t._captureSquadRef
    );
    if (needingGroup.length) {
      this._detachFromSquad = this._detachFromSquad; // (no-op, keeps existing curve-squad API untouched)
      needingGroup.forEach(t => this._detachFromSquad(t));   // leave any curve-patrol squad
      this._buildCaptureSquads(needingGroup);
    }

    for (const tank of active) {
      // Skip tanks currently in combat — they resume their route afterward
      // via _prevJobState, same as before.
      if (tank.state === STATE.ATTACK || tank.state === STATE.ENGAGE) continue;

      const squad = tank._captureSquadRef;
      if (!squad) continue;   // shouldn't happen — just grouped above if needed

      // ── Finished holding — whole squad rotates to the next point together ──
      // Only advance once ALL living members of the squad are ready (or the
      // squad has effectively shrunk to just this tank via deaths).
      if (tank.state === STATE.HOLDING && tank._readyToRotate) {
        const squadTanks = active.filter(t => t._captureSquadRef === squad);
        const allReady = squadTanks.every(t => t.state !== STATE.HOLDING || t._readyToRotate);

        if (allReady) {
          squad.routeIdx = (squad.routeIdx + 1) % cps.length;
          const cp = cps[squad.routeIdx];
          for (const t of squadTanks) {
            t._readyToRotate = false;
            t._cpRouteIdx    = squad.routeIdx;
            t.assignedCP     = cp;
            t.state          = STATE.TRAVEL;
            t._path          = null;   // force a fresh path to the new point
          }
        }
      }

      // ── Safety net — re-sync if a tank lost its job state somehow ──────
      if (!tank.assignedCP && tank.state !== STATE.TRAVEL && tank.state !== STATE.HOLDING) {
        const cp = cps[squad.routeIdx];
        tank.assignedCP = cp;
        tank.state      = STATE.TRAVEL;
      }
    }
  }
  /** Deactivate a specific tank (e.g. when destroyed by bullet) */
  killTank(tank) {
    tank.deactivate();
  }

  /** Full cleanup */
  dispose() {
    this._pool.forEach(t => t.destroyPermanently());
    this._pool.length = 0;
  }
}

export function resetEnemyModelCache() {
  _sharedGLBModels.clear();
}