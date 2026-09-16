// plane.js — Plane with Rapier rigid body + visual mesh + BF5-style flight model
//
// Mirrors tank.js's public surface as closely as possible so main.js can treat
// a Plane mostly like a Tank: .rigidBody, .bodyGroup, .health/.armour/.isDead,
// .bulletSystem (with .onHit / .fire), .update(dt, keys, camera, mouse, cycleData),
// .takeDamage(), .respawn(), .dispose(). Where the two diverge (no turret, no
// tracks, no gears) those tank-only fields are simply absent — main.js should
// branch on a `vehicleType` flag ('tank' | 'plane') rather than duck-type.

import * as THREE from 'three';
import { loadModel } from './modelLoader.js';
import { getMouseFlightOffset } from './input.js';
import { BulletSystem, MachineGunSystem, ProjectileBulletSystem, MultiGunSystem, HispanoBulletSystem } from './bullet.js';
import { ExplosionSystem } from './explosion.js';
import { RocketSystem } from './rocket.js';
import { BombSystem }   from './bomb.js';
import { FlareSystem }  from './flare.js';
import { PlaneWaterSplash } from './planeWaterSplash.js';



// ── Blender → Three.js axis conversion ──────────────────────────────────────
// Blender is Z-up (right-handed), Three.js/glTF is Y-up (right-handed).
// The standard Blender→glTF axis remap is (Xb, Yb, Zb) → (Xb, Zb, -Yb), which
// is exactly a fixed rotation of -90° about the X axis. Any rotation authored
// in Blender's local axes (e.g. read off the Rotation panel) needs to be run
// through this same basis change before it means the same thing to a
// Three.js quaternion — otherwise a Y-axis spin in Blender ends up spinning
// the wrong (Z) axis in-game, etc.
const _BLENDER_TO_THREE_CONV = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _THREE_TO_BLENDER_CONV = _BLENDER_TO_THREE_CONV.clone().invert();

// ── Death-fall tuning — kept identical to EnemyPlane's fall model
// (enemyPlane.js) so player and AI planes crash the same way.
const FALL_GRAVITY = 9.6; // world units/sec² — scaled for this game's flight speeds, not real-world 9.8
const FALL_DRAG     = 0.1; // per-second decay on horizontal fall velocity, sheds forward glide speed over time

const AI_GUN_TARGET_SEARCH_INTERVAL = 0.25; // seconds — how often an AI gun re-scans for the nearest target

// Cosine margin around the plane's left/right beam (frontDot≈0). Without
// this, a target sitting almost exactly perpendicular to the nose can pass
// BOTH a front gun's "not behind" test AND a rear gun's "not in front" test
// at the same instant — which is what let a rear gun fire on a target that
// wasn't actually behind the plane during a turn.
const AI_GUN_HEMISPHERE_MARGIN = 0.12;

// ── Afterburner flame mesh — exact geometry reconstructed from the
// original after_burner.glb (Mesh_41/Material.003): 9 radial fin-strips
// spanning the flame's local +X axis. Shared across every Plane instance
// and every jet-propulsion node — never mutated per-instance.
const AFTERBURNER_POSITIONS = new Float32Array([7.490623,0.007730,0.999996,7.490623,0.007730,-1.000000,-0.509374,0.007730,0.999996,-0.509374,0.007730,-1.000000,7.490623,-0.348975,0.937004,7.490623,0.348925,-0.937008,-0.509374,-0.348975,0.937004,-0.509374,0.348925,-0.937008,7.490623,-0.643644,0.763776,7.490623,0.643595,-0.763780,-0.509374,-0.643644,0.763776,-0.509374,0.643595,-0.763780,7.490623,-0.860769,0.496060,7.490623,0.860719,-0.496064,-0.509374,-0.860769,0.496060,-0.509374,0.860719,-0.496064,7.490623,-0.984840,0.181100,7.490623,0.984790,-0.181104,-0.509374,-0.984840,0.181100,-0.509374,0.984790,-0.181104,7.490623,-0.984840,-0.181104,7.490623,0.984790,0.181100,-0.509374,-0.984840,-0.181104,-0.509374,0.984790,0.181100,7.490623,-0.860769,-0.496064,7.490623,0.860719,0.496060,-0.509374,-0.860769,-0.496064,-0.509374,0.860719,0.496060,7.490623,-0.643644,-0.763780,7.490623,0.643595,0.763776,-0.509374,-0.643644,-0.763780,-0.509374,0.643595,0.763776,7.490623,-0.348975,-0.937008,7.490623,0.348925,0.937004,-0.509374,-0.348975,-0.937008,-0.509374,0.348925,0.937004]);
const AFTERBURNER_NORMALS = new Float32Array([0.000000,0.999998,0.002200,0.000000,0.999998,0.002200,0.000000,0.999998,0.002200,0.000000,0.999998,0.002200,-0.001900,0.940281,0.340393,-0.001900,0.940281,0.340393,-0.001900,0.940281,0.340393,-0.001900,0.940281,0.340393,-0.001900,0.766792,0.641893,-0.001900,0.766841,0.641834,-0.001900,0.766841,0.641834,-0.001900,0.766792,0.641893,0.003700,0.500587,0.865678,0.003700,0.500587,0.865678,0.003800,0.500587,0.865678,0.003800,0.500587,0.865678,0.003700,0.173796,0.984775,0.003700,0.173796,0.984775,0.003700,0.173796,0.984775,0.003700,0.173796,0.984775,0.003700,-0.173796,0.984775,0.003700,-0.173796,0.984775,0.003700,-0.173796,0.984775,0.003700,-0.173796,0.984775,0.003700,-0.500587,0.865678,0.003700,-0.500587,0.865678,0.003800,-0.500587,0.865678,0.003800,-0.500587,0.865678,-0.001900,-0.766792,0.641893,-0.001900,-0.766841,0.641834,-0.001900,-0.766841,0.641834,-0.001900,-0.766792,0.641893,-0.001900,-0.940281,0.340393,-0.001900,-0.940281,0.340393,-0.001900,-0.940281,0.340393,-0.001900,-0.940281,0.340393]);
const AFTERBURNER_UVS = new Float32Array([1.000001,1.000000,1.000001,-0.000001,0.000000,1.000000,0.000000,-0.000001,1.000001,1.000000,1.000001,-0.000001,0.000000,1.000000,0.000000,-0.000001,1.000001,1.000000,1.000001,-0.000001,0.000000,1.000000,0.000000,-0.000001,1.000001,1.000000,1.000001,-0.000001,0.000000,1.000000,0.000000,-0.000001,1.000001,1.000000,1.000001,-0.000001,0.000000,1.000000,0.000000,-0.000001,1.000001,1.000000,1.000001,-0.000001,0.000000,1.000000,0.000000,-0.000001,1.000001,1.000000,1.000001,-0.000001,0.000000,1.000000,0.000000,-0.000001,1.000001,1.000000,1.000001,-0.000001,0.000000,1.000000,0.000000,-0.000001,1.000001,1.000000,1.000001,-0.000001,0.000000,1.000000,0.000000,-0.000001]);
const AFTERBURNER_INDICES = new Uint16Array([21,23,22,21,22,20,25,27,26,25,26,24,33,35,34,33,34,32,29,31,30,29,30,28,13,15,14,13,14,12,17,19,18,17,18,16,9,11,10,9,10,8,5,7,6,5,6,4,1,3,2,1,2,0]);

// Authored glTF node scale — the mesh's baseline (unstretched) scale;
// only scale.x ever changes at runtime (the "breathing" pulse).
const AFTERBURNER_BASE_SCALE = new THREE.Vector3(0.5, 0.521, 0.521);

// The geometry's long axis is local +X. Every Jet_Propulsion_N node in
// this file treats its own local -Z as "backward" (see the old shockwave
// placement code this replaces), so the flame mesh gets a fixed local
// rotation mapping +X → -Z: a +90° turn about Y. If a flame ever shoots
// forward instead of aft on some rig, flip the sign to -Math.PI / 2.
const AFTERBURNER_ALIGN_QUAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

// Same URL for both types for now — swap AFTERBURNER_TEXTURE_URLS.red to a
// distinct texture later; nothing else needs to change when you do.
// Same texture for both types now — only the material's tint color (see
// _getAfterburnerMaterial) differentiates 'blue' vs 'red'.
const AFTERBURNER_TEXTURE_URL = "/textures/afterburner-blue.png";
const AFTERBURNER_TEXTURE_URLS = {
  blue: AFTERBURNER_TEXTURE_URL,
  red:  AFTERBURNER_TEXTURE_URL,
};

// Pulse / flicker / twist / vibration tuning — lifted directly from the
// reference reconstruction.
const AFTERBURNER_PULSE_AMOUNT    = 0.35;
const AFTERBURNER_PULSE_SPEED     = 3.2;
const AFTERBURNER_FLICKER_SPEED   = 11.0;
const AFTERBURNER_FLICKER_AMOUNT  = 0.08;
const AFTERBURNER_TWIST_AMOUNT    = Math.PI / 5;
const AFTERBURNER_TWIST_SPEED     = 1.6;
const AFTERBURNER_TWIST_AXIS      = new THREE.Vector3(1, 0, 0);
const AFTERBURNER_VIBE_POS_AMOUNT = 0.035;
const AFTERBURNER_VIBE_ROT_AMOUNT = 0.012;
const AFTERBURNER_VIBE_FREQ       = [37, 53, 71];
function _afterburnerVibeNoise(t, freq, phase) {
  return Math.sin(t * freq + phase) * 0.6 + Math.sin(t * freq * 1.7 + phase * 2.3) * 0.4;
}
/**
 * Converts a rotation authored as Blender-space Euler degrees (X, Y, Z) —
 * exactly what you'd type into Blender's N-panel Rotation fields — into the
 * equivalent Three.js quaternion, via a similarity transform so the whole
 * compound rotation (not just one axis) survives the axis change intact.
 */
function blenderEulerDegToThreeQuat(bx, by, bz) {
  const blenderEuler = new THREE.Euler(
    THREE.MathUtils.degToRad(bx),
    THREE.MathUtils.degToRad(by),
    THREE.MathUtils.degToRad(bz),
    'ZYX'   // Blender's "XYZ Euler" rotation mode composes in the opposite
            // order from Three.js's Euler 'XYZ' label — Three's 'ZYX' is
            // the equivalent composition order, confirmed against Blender's
            // actual quaternion output for LandingGear_1's retracted pose.
  );
  const qBlender = new THREE.Quaternion().setFromEuler(blenderEuler);
  return _BLENDER_TO_THREE_CONV.clone().multiply(qBlender).multiply(_THREE_TO_BLENDER_CONV);
}

// ─────────────────────────────────────────────────────────────────────────────

export class Plane {
  constructor(scene, world, position = { x: 0, y: 80, z: 0 }, config = {}) {

    // ── Resolve config ──────────────────────────────────────────────────────
    this.cfg = {
      country:    config.country    ?? null,
      // 'light' | 'heavy' | 'modern_light' | 'modern_heavy' — which engine
      // sound category this plane uses. Read by main.js when calling
      // audioSystem.configurePlaneSound()/updateEnemyEngine(), not used
      // inside Plane itself (same pass-through pattern as `country` above).
      planeSound: config.planeSound ?? 'light',

      // Model
      modelObjectURL: config.modelObjectURL ?? null,
      modelPath:      config.modelPath      ?? '/model/Plane_Fighter.glb',
      modelScale:     config.modelScale     ?? 1.0,
      modelOffsetX:   config.modelOffsetX   ?? 0,
      modelOffsetY:   config.modelOffsetY   ?? 0,
      modelOffsetZ:   config.modelOffsetZ   ?? 0,
      modelRotX:      config.modelRotX      ?? 0,
      modelRotY:      config.modelRotY      ?? -90,
      modelRotZ:      config.modelRotZ      ?? 0,

      hullHalfExtents: config.hullHalfExtents ?? { x: 3.4, y: 0.9, z: 0.5 },
      colliderYOffset: config.colliderYOffset ?? 0,

      // Wing collider — thin, wide cuboid spanning the wingspan, separate
      // from the fuselage hull box above. Defaults assume wings sit near
      // the hull's vertical center and extend outward along local Z.
      wingHalfExtents: config.wingHalfExtents ?? { x: 1.0, y: 0.25, z: 4.0 },
      wingColliderOffset: config.wingColliderOffset ?? { x: 0, y: 0, z: 0 },

      // Propeller / control surfaces
      propellerAxis:          config.propellerAxis          ?? 'z',
      propellerMaxSpeed:      config.propellerMaxSpeed       ?? 45,
      controlSurfaceMaxAngle: config.controlSurfaceMaxAngle  ?? 0.5,

      // Local rotation axis for each control surface — tune per-model if the
      // authored rig uses a different local axis than these defaults.
      aileronAxis:  config.aileronAxis  ?? 'x',
      elevatorAxis: config.elevatorAxis ?? 'x',
      rudderAxis:   config.rudderAxis   ?? 'y',
      flapAxis:     config.flapAxis     ?? 'x',

            // ── Thrust-vectoring nozzles (Nozzle_1, Nozzle_2, ...) — rigid-pivot
      // gimbal. The Nozzle_N mesh's own origin is authored AT the hinge
      // point, so rotating the whole node's quaternion around that origin
      // IS the "rigid pivot" from the demo — there's no separate fixed
      // forward half baked into this mesh to preserve.
      nozzleGimbalMaxDeg:   config.nozzleGimbalMaxDeg   ?? 12,   // max deflection off-axis, degrees
      nozzleGimbalSpeedDeg: config.nozzleGimbalSpeedDeg ?? 260,  // slew rate, degrees/sec
      // Local axes (in the Nozzle_N node's own space) that pitch/yaw
      // deflection tilt about. Tune per-rig if the direction looks
      // mirrored or wrong once you see it in-game — same caveat as every
      // other axis config in this file.
      nozzlePitchAxis: config.nozzlePitchAxis ?? 'x',
      nozzleYawAxis:   config.nozzleYawAxis   ?? 'y',

            // ── Nozzle exit-area animation — radial scale on the Nozzle_N mesh,
      // driven by throttle. Real C-D nozzles open up (larger exit area) at
      // high throttle/afterburner for better supersonic expansion, and
      // close down toward idle — this is a cosmetic scale-only version of
      // that, no geometry rebuild needed.
      nozzleAxialAxis:      config.nozzleAxialAxis      ?? 'z',   // local axis running along the nozzle's LENGTH (unscaled)
      nozzleAreaMinScale:   config.nozzleAreaMinScale    ?? 0.75, // radial scale at throttle 0 (closed down)
      nozzleAreaMaxScale:   config.nozzleAreaMaxScale    ?? 1.3, // radial scale at throttle 1 (wide open)
      nozzleAreaSpeed:      config.nozzleAreaSpeed       ?? 2.5,  // smoothing rate, higher = snappier
      // Fraction (0..1) along the nozzle's length, from the FIXED end,
      // where the exit-area taper begins — only the last (1 - this)
      // fraction of the mesh is affected. 0.5 = only the back half moves.
      nozzleTaperStart:     config.nozzleTaperStart      ?? 0.5,
      // Fraction (0..1) along the nozzle's length, from the FIXED end,
      // where the GIMBAL bend begins — same convention as nozzleTaperStart.
      // Only the last (1 - this) fraction physically bends; the attached
      // front half stays rigid, matching how a real hinged nozzle section works.
      nozzleGimbalStart:    config.nozzleGimbalStart     ?? 0.5,
      // true = the nozzle's EXIT (tapering end) sits at the local MAX of
      // nozzleAxialAxis; flip to false if the taper shows up at the wrong
      // (attached) end once you see it in-game.
      nozzleExitAtAxialMax: config.nozzleExitAtAxialMax  ?? false,

      // Flaps deploy as throttle drops below this fraction (0..1), fully
      // deployed at throttle 0. Purely a visual/drag cue — no separate
      // lift/drag physics term is added, though you could hook one in later.
      flapThrottleThreshold: config.flapThrottleThreshold ?? 0.6,
      flapMaxAngle:          config.flapMaxAngle           ?? 0.8, // radians
      flapSpeed:             config.flapSpeed              ?? 1.5, // deploy/retract rate, fraction/sec

      // Leading-edge flaps (slats) — droop down/forward at low speed for
      // extra lift, share the same deploy timing (_flapDeploy) as the
      // trailing-edge flaps above so both edges move together.
      leadingEdgeFlapAxis:      config.leadingEdgeFlapAxis      ?? 'x',
      leadingEdgeFlapMaxAngle:  config.leadingEdgeFlapMaxAngle  ?? 0.5, // radians

      // Throttle / speed envelope
      throttleAccel:  config.throttleAccel  ?? 14,
      throttleDecel:  config.throttleDecel  ?? 10,
      minSpeed:       config.minSpeed       ?? 4,
      cruiseSpeed:    config.cruiseSpeed    ?? 28,
      maxSpeed:       config.maxSpeed       ?? 46,
      boostMaxSpeed:  config.boostMaxSpeed  ?? 60,
      boostAccel:     config.boostAccel     ?? 20,

      // ── Reverse ("R") gear — a fixed, non-scaling low speed used only
      // for ground taxiing backward. Doesn't come from throttle at all;
      // throttle itself never goes negative. Engages automatically while
      // grounded + throttle idle + backward held (see _reverseGearEngaged).
      reverseSpeed:           config.reverseSpeed           ?? 6,   // world units/sec, constant
      reverseAccel:           config.reverseAccel           ?? 4,   // world units/sec² — ease rate in/out
      reverseGroundThreshold: config.reverseGroundThreshold ?? 0.5, // world units — wheel-to-ground clearance that counts as "grounded" for reverse purposes

      // ── Wheel friction — normally high so the plane doesn't slide around
      // on landing/taxi. Dropped to reverseWheelFriction while reverse gear
      // is engaged, since normal friction is high enough to fully cancel
      // the small imposed reverse velocity within a single physics step
      // (Rapier's contact solver treats it as a slide and kills it before
      // the next frame ever reads the velocity back).
      wheelFriction:        config.wheelFriction        ?? 0.9,
      reverseWheelFriction: config.reverseWheelFriction ?? 0.05,

      // Throttle LEVER ramp rate — fraction per second the throttle value
      // itself moves while holding forward/backward (manual control only;
      // see _updateAutopilotInput for autopilot's own separate lerp rate).
      // Distinct from throttleAccel/throttleDecel above, which govern how
      // fast actual AIRSPEED chases the throttle-derived target once the
      // throttle lever has already moved.
      throttleRampRate: config.throttleRampRate ?? 0.1,

      // Initial throttle applied on spawn/respawn — comes from the map
      // config (mapDef.plane.initialThrottle), not the plane preset.
      // Initial airspeed is now DERIVED from this (minSpeed + throttle *
      // (maxSpeed - minSpeed)) instead of a separate hardcoded speed value.
      initialThrottle: config.initialThrottle ?? 0.5,

      // Throttle ceiling while critically damaged — matches main.js's
      // LOW_HEALTH_FRACTION (0.8), the same threshold that starts the
      // damage smoke, so the throttle cap kicks in at exactly that moment.
      lowHealthDamageFraction: config.lowHealthDamageFraction ?? 0.5,
      lowHealthMaxThrottle:    config.lowHealthMaxThrottle    ?? 0.90,

      // ── Shader-based low-health damage stripping — no extra geometry.
      // Discards fragments aft of a moving cutoff plane (jagged/zigzag
      // boundary) directly in each material's fragment shader.
      damageEffect: {
        enabled:               config.damageEffect?.enabled               ?? true,
        healthTriggerFraction: config.damageEffect?.healthTriggerFraction  ?? 0.65,  // starts below 50% health
        minRemainingFraction:  config.damageEffect?.minRemainingFraction   ?? 0.95,  // 90% of length left at 0 hp (only ~10% stripped)
        deathMinRemainingFraction: config.damageEffect?.deathMinRemainingFraction ?? 0.65, // even less left once destroyed (NEW)
        maxCutbackLength:      config.damageEffect?.maxCutbackLength       ?? 3.5,    // world units, nose→tail
        wingCutbackLength:     config.damageEffect?.wingCutbackLength      ?? 3.5,    // world units, wingtip→center (NEW — strips both wings inward)
        jagAmplitude:          config.damageEffect?.jagAmplitude           ?? 0.5,  // zigzag depth (world units)
        jagFrequency:          config.damageEffect?.jagFrequency           ?? 1.4,  // zigzag spatial frequency
      },

      // ── Jet propulsion effect (afterburner flame + shockwave) — driven
      // by empty "Jet_Propulsion_1".."Jet_Propulsion_3" nodes in the GLB
      // (max 3). Purely additive visual: does nothing if the nodes aren't
      // present, or if cfg.propulsion is false.
      propulsion:     config.propulsion     ?? false,
      propulsionType: config.propulsionType ?? 'blue', // 'blue' | 'red'
      propulsionScale: config.propulsionScale ?? 1.0,  // uniform size multiplier on the whole flame mesh

      // Stall
      stallSpeed:    config.stallSpeed    ?? 9,
      stallSinkRate: config.stallSinkRate ?? 6,

      // Control rates (rad/sec at full deflection)
      pitchRate:          config.pitchRate          ?? 1.15,
      rollRate:            config.rollRate            ?? 2.6,
      yawRate:              config.yawRate              ?? 0.55,
      autoLevelStrength:    config.autoLevelStrength    ?? 0.6,

// Aero
liftCoefficient: config.liftCoefficient ?? 0.42,
dragCoefficient: config.dragCoefficient ?? 0.02,
gravity:         config.gravity         ?? 19.6,

// ── Sideslip / drift model ──────────────────────────────────────────
sideStabilityNormal:  config.sideStabilityNormal  ?? 2.2,  // how hard sideways velocity is corrected in normal flight
sideStabilityHighAoA: config.sideStabilityHighAoA ?? 0.25, // corrected much more weakly at high AoA — lets it drift
maxAoARad:            config.maxAoARad            ?? THREE.MathUtils.degToRad(35), // AoA at which stability bottoms out
velocityBlendNormal:  config.velocityBlendNormal   ?? 4.0,  // dt multiplier for the old hard velocity-snap (normal flight)
velocityBlendHighAoA: config.velocityBlendHighAoA  ?? 0.6,  // much softer snap at high AoA — velocity keeps its own inertia

      minAltitude:            config.minAltitude            ?? 2,
      // Hard ceiling — plane is clamped here the instant it tries to climb
      // higher, regardless of throttle/lift. Purely a position/velocity
      // clamp (cheapest option), not a soft aerodynamic force.
      maxAltitude:            config.maxAltitude            ?? 400,

      // Play-zone boundary — half-size of a square centered on the origin
      // (1000x1000 total → 500 half-size). Purely an XZ distance check.
      playZoneHalfSize:  config.playZoneHalfSize  ?? 1000,
      playZoneGraceTime: config.playZoneGraceTime ?? 10, // seconds allowed outside before destruction

      groundCollisionDamage:  config.groundCollisionDamage  ?? 40,
      // Impact speed (km/h) above which hitting the ground destroys the
      // plane outright instead of allowing a normal landing/taxi.
      crashSpeedThreshold:    config.crashSpeedThreshold    ?? 110,
      // Impact speed (km/h) above which — but still below crashSpeedThreshold —
      // a ground/obstacle touch kicks up a one-shot smoke puff at each wheel,
      // instead of doing nothing (too slow/gentle) or destroying the plane
      // (too fast, handled by crashSpeedThreshold above).
      wheelSmokeMaxSpeedThreshold: config.wheelSmokeMaxSpeedThreshold ?? 200,
      wheelSmokeSpeedThreshold: config.wheelSmokeSpeedThreshold ?? 20,

      // Weapons
      gunType:    config.gunType    ?? 1,   // 1 = single MG, 3 = multi-barrel (MultiGunSystem)
      // Caps how many numbered GunPoint_N nodes are actually wired up as
      // firing muzzles, e.g. totalMG: 4 → only GunPoint_1..GunPoint_4 are
      // used even if the GLB has more. undefined/0 = no cap, use every
      // GunPoint_N node found in the model.
      totalMG:    config.totalMG    ?? undefined,
      // Renamed from "mgDamage" — this is the plane's slot-1 MAIN GUN
      // damage, whether it's a single-barrel MachineGunSystem (gunType 1)
      // or multi-barrel MultiGunSystem (gunType 3). There is no separate
      // "MG" weapon on the plane distinct from the main gun — "mg" here
      // only ever referred to the underlying class name, not a second
      // weapon slot, which was confusing.
      gunDamage:  config.gunDamage ?? config.mgDamage ?? 20,   // mgDamage kept as a fallback for old configs
      mgRange:    config.mgRange    ?? 250,
      mgFireRate: config.mgFireRate ?? 0.09,
      mgAmmo:     config.mgAmmo     ?? 400,
      mgReloadTime: config.mgReloadTime ?? undefined, // ← undefined = keep the underlying gun system's own default

      // ← multi-barrel main gun's volley rate (gunType 3 only), from
      // planes.json's "fireRate" field. Undefined when not provided, so
      // MultiGunSystem's own MULTIGUN_FIRE_RATE default applies untouched.
      multiGunFireRate: config.fireRate ?? config.multiGunFireRate ?? undefined,

      // ── Hispano cannon banks (Hispano_1..Hispano_N empty nodes) — a
      // separate, always-independent weapon system detected purely from
      // GLB node names, not gated behind gunType at all. Only becomes
      // active if the model actually contains one or more Hispano_N nodes
      // (see _loadHullModel).
      hispanoDamage:     config.hispanoDamage     ?? 45,
      hispanoRange:      config.hispanoRange      ?? 600,
      hispanoFireRate:   config.hispanoFireRate   ?? undefined, // undefined = HispanoBulletSystem's own default
      hispanoAmmo:       config.loadout?.hispanoAmmo ?? config.hispanoAmmo ?? 60, // TOTAL reserve pool
      hispanoMagSize:    config.hispanoMagSize    ?? 60, // drum/magazine capacity, independent of the total pool above
      hispanoReloadTime: config.hispanoReloadTime ?? undefined,

      rocketDamage: config.rocketDamage ?? 60,
      rocketSpeed:  config.rocketSpeed  ?? 90,
      rocketReload: config.rocketReload ?? 0.6,
      rocketAmmo:   config.rocketAmmo   ?? 6,
      rocketAuto:   config.rocketAuto   ?? false,
      // ← from planes.json's "guidedMissile" field. main.js already spreads
      // the plane preset's config object (_pc) into what Plane.create()
      // receives as `config`, so this flows through automatically once set.
      guidedMissile: config.guidedMissile ?? false,

      bombDamage:      config.bombDamage      ?? 500,
      bombBlastRadius: config.bombBlastRadius ?? 14,
      bombReload:      config.bombReload      ?? 1.5,
      bombAmmo:        config.bombAmmo        ?? 4,
      bombFuseGravity: config.bombFuseGravity ?? 19.6,

      // ── Flares (countermeasures) ──────────────────────────────────────
      flareAmmo:      config.flareAmmo      ?? 50,   // total flares available across all deploys this life
      flareCount:     config.flareCount     ?? 10,    // flares released per deploy ("press" of the flare key)
      flareReload:    config.flareReload    ?? 0.5,     // seconds cooldown between deploys

      // ── Water-spray effect — no dedicated GLB node for this (unlike
      // Tank's Dust_N nodes), so a synthetic anchor is used instead (see
      // PlaneWaterSplash instantiation below).
      waterSplashMaxHeight: config.waterSplashMaxHeight ?? 4.0,  // world units above water where spray starts fading in
      waterSplashMinHeight: config.waterSplashMinHeight ?? -1.5, // world units below water surface still allowed to emit
            // ── AI turret guns (AI_Gun_N / AI_GunPoint_N) — completely optional;
      // only built if the GLB actually contains matching nodes. Every gun
      // shares these defaults unless overridden per-index via the array
      // configs below (index 0 = AI_Gun_1, etc.).
      aiGunRange:            config.aiGunRange            ?? 150,  // world units
      aiGunYawLimitDeg:      config.aiGunYawLimitDeg      ?? 30,   // ± degrees from rest facing
      aiGunPitchLimitDeg:    config.aiGunPitchLimitDeg    ?? 30,   // ± degrees from rest facing
      aiGunYawLimitsDeg:     config.aiGunYawLimitsDeg     ?? [],   // optional per-gun overrides
      aiGunPitchLimitsDeg:   config.aiGunPitchLimitsDeg   ?? [],   // optional per-gun overrides
      aiGunDamage:           config.aiGunDamage           ?? 5,
      aiGunFireRate:         config.aiGunFireRate         ?? 0.12, // seconds between shots
      aiGunMagSize:          config.aiGunMagSize          ?? 60,   // rounds per magazine before reload
      aiGunReloadTime:       config.aiGunReloadTime       ?? 4,    // seconds to fully reload once empty
      aiGunTotalAmmo:        config.aiGunTotalAmmo        ?? undefined, // total ammo pool per gun (loaded+reserve) — undefined = 3 magazines' worth     
      aiGunAimSpeedDeg:      config.aiGunAimSpeedDeg      ?? 220,  // turret slew speed, degrees/sec
      aiGunFireToleranceDeg: config.aiGunFireToleranceDeg ?? 4,    // must be aimed this close before firing
      // Per-gun 180° flip — use when a gun's authored forward direction
      // faces the wrong way once its rotation is reset to identity.
      aiGunInverse:          config.aiGunInverse          ?? [],

      cameraFollowDistance: config.cameraFollowDistance ?? 14,
      cameraFollowHeight:   config.cameraFollowHeight   ?? 3.5,

      damageSmokeOffset: config.damageSmokeOffset ?? { x: 0, y: 0, z: 0 },

      // ── Landing gear ────────────────────────────────────────────────────
      // Blender-space Euler degrees (X,Y,Z) each LandingGear_N node rotates
      // to when RETRACTED (gear off). Index 0 → LandingGear_1, index 1 →
      // LandingGear_2, etc. Extended/gear-down is always the authored
      // (0,0,0) pose the GLB was exported with — no config needed for that.
      landingGearRotationsDeg:       config.landingGearRotationsDeg ?? [[0, -80, 38], [0, 80, -38]],
      landingGearTransitionDuration: config.landingGearTransitionDuration ?? 1.2,
      wheelColliderHalfExtent:       config.wheelColliderHalfExtent        ?? 0.12,

      // ── Landing gear doors — INVERTED convention vs. the gear itself:
      // the authored (0,0,0) GLB pose is OPEN, so these are Blender-space
      // Euler degrees (X,Y,Z) each Door_{n}_L / Door_{n}_R node rotates to
      // when CLOSED. PLACEHOLDER VALUES — tune against the actual rig.
      // Single angle pair reused for every gear index (all L doors move the
      // same, all R doors move the same) unless per-gear tuning is needed later.
      doorCloseRotationDegL: config.doorCloseRotationDegL ?? [0, 0, 80],
      doorCloseRotationDegR: config.doorCloseRotationDegR ?? [0, 0, -80],
      // ── Per-door angle overrides — index-matched to door number (index 0
      // = Door_1_L/R, index 1 = Door_2_L/R, etc.). A door index missing from
      // this array falls back to doorCloseRotationDegL above (the shared
      // default). This is the array to edit for "door 3 needs a different
      // close angle than the others."
      doorCloseRotationsDegL: config.doorCloseRotationsDegL ?? [],
      // Right-side per-door overrides. A door index missing from THIS array
      // does NOT fall back to doorCloseRotationDegR — instead it's
      // auto-mirrored from that same index's LEFT angle (negate Y and Z),
      // since in practice right doors are the mirror image of their left
      // counterpart unless a rig genuinely needs an asymmetric pair.
      doorCloseRotationsDegR: config.doorCloseRotationsDegR ?? [],
      // Fraction of the gear-transition window spent on the single
      // door-motion phase for each direction — [extendOpenFrac, retractCloseFrac].
      // extendOpenFrac: fraction of the EXTEND transition spent opening the
      //   door before the gear starts moving (door already open the rest of the way).
      // retractCloseFrac: fraction of the RETRACT transition spent closing
      //   the door AFTER the gear finishes moving (door stays open until then).
      doorPhaseFractions: config.doorPhaseFractions ?? [0.3, 0.3],
      // Gear state on spawn/respawn — comes from the map config
      // (mapDef.plane.landingGearDown). true = extended (default), false = retracted.
      landingGearDown:                config.landingGearDown ?? true,
      // Whether the plane spawns with autopilot already engaged — comes
      // from the map config (mapDef.plane.autopilotOn).
      initialAutopilotOn:             config.initialAutopilotOn ?? true,

      // Camera turbulence while critically damaged
      lowHealthTurbulenceFraction: config.lowHealthTurbulenceFraction ?? 0.35, // starts below this % of maxHealth
      turbulenceMaxIntensity:      config.turbulenceMaxIntensity      ?? 0.12, // world units at 0 health
      turbulenceFrequency:         config.turbulenceFrequency         ?? 14,   // Hz-ish

      // Control-surface trembling while critically damaged — shares the
      // same health threshold as the camera turbulence above, but drives a
      // small jitter angle added on top of the aileron/elevator/rudder's
      // normal input-driven rotation.
      controlSurfaceTrembleMaxAngle:   config.controlSurfaceTrembleMaxAngle   ?? 0.08, // radians at 0 health
      controlSurfaceTrembleFrequency:  config.controlSurfaceTrembleFrequency  ?? 70,   // Hz-ish

      // Camera turbulence while gear is down at high throttle — simulates
      // wind buffet/drag shake from flying "dirty" (gear extended) fast.
      gearTurbulenceThrottleThreshold: config.gearTurbulenceThrottleThreshold ?? 0.65,
      gearTurbulenceMaxIntensity:      config.gearTurbulenceMaxIntensity      ?? 0.05,
      gearTurbulenceFrequency:         config.gearTurbulenceFrequency         ?? 22,

      // ── Aerodynamic condensation (vapor cloud) — planes.json flag,
      // emits fast smoke puffs from Low_Pressure_1/2 nodes during hard-G
      // turns. Everything downstream of this flag is a no-op cost when false.
      aerodynamicCondensation:     config.aerodynamicCondensation     ?? false,
      condensationGTurnRate:       config.condensationGTurnRate       ?? 2.2,  // rad/sec turn-rate for FULL intensity
      condensationMinTurnRate:     config.condensationMinTurnRate     ?? 1.3, // rad/sec turn-rate where it first appears
      condensationMinEmitInterval: config.condensationMinEmitInterval ?? 0.02, // sec between puffs at full intensity (fast)
      condensationMaxEmitInterval: config.condensationMaxEmitInterval ?? 0.16, // sec between puffs right as it starts
    };

    this.scene    = scene;
    this.world    = world;
    this.renderer = config.renderer ?? null;

    this.vehicleType = 'plane';   // ← lets main.js / other systems duck-check cheaply

    // ── Weapon availability — set once _loadHullModel() actually finds (or
    // fails to find) the relevant mount points in the GLB. Starts true so
    // nothing flickers hidden-then-shown before the model loads; flipped to
    // false in _loadHullModel() if the corresponding node(s) are missing.
    // main.js reads these to hide weapon-slot UI for weapons this plane
    // physically has no mount points for.
    this.hasRockets = true;
    this.hasBombs   = true;
    this.bombPoint = null; // ← BombPoint node reference, used by the bomb-sight scope view (main.js)
    this.hasHispano = false;      // ← flipped true in _loadHullModel() only if Hispano_N nodes are found
    this.hispanoSystem = null;    // ← HispanoBulletSystem instance, built in _loadHullModel()  

    // ── Flight state ─────────────────────────────────────────────────────────
    this.throttle   = this.cfg.initialThrottle;   // 0..1, player input — spawn value comes from map config
    this.airspeed   = this.cfg.minSpeed + this.throttle * (this.cfg.maxSpeed - this.cfg.minSpeed);
    this.isBoosting = false;
    this.isStalled  = false;

    // ── Reverse ("R") gear state — recomputed every frame in update().
    this._isGrounded        = false; // true when the hull's lowest corner is near/at the terrain
    this._reverseGearEngaged = false; // true while actively taxiing backward

    // Orientation is tracked as yaw/pitch/roll on the rigid body directly —
    // input drives angular velocity toward a target, physics integrates it.
    this._pitchInput = 0;   // -1..1
    this._rollInput  = 0;   // -1..1
    this._yawInput   = 0;   // -1..1

    // ── Roll lock — set true while the bomb-sight scope is active (see
    // ScopeSystem._enterScope/_exitScope), so the plane holds level roll
    // (auto-level torque brings it to 0) instead of responding to mouse
    // roll input while the pilot is looking straight down through the sight.
    this._rollLocked = false;

    // ── Pitch lock — same idea as roll lock above, also driven by the
    // bomb-sight scope. Freezes mouse pitch input (elevator) so the plane
    // can't be pitched up/down while aiming a bomb drop; the plane simply
    // continues on whatever ballistic trajectory it was already on.
    this._pitchLocked = false;

    // ── Autopilot — toggled by Shift while flying. Holds altitude + heading
    // captured at the moment it's enabled, wings level, gentle cruise throttle.
    this.autopilotEnabled     = false;
    this._apTargetAltitude    = 0;
    this._apTargetHeadingRad  = 0;

    this._buildPhysics(world, position);

    // ── Render interpolation — same pattern as Tank ─────────────────────────
    this._prevPos    = new THREE.Vector3(position.x, position.y, position.z);
    this._prevQuat   = new THREE.Quaternion();
    this._renderPos  = new THREE.Vector3(position.x, position.y, position.z);
    this._renderQuat = new THREE.Quaternion();
    // ── Velocity captured immediately BEFORE the physics step that may
    // contain a ground-impact collision — see captureTransformSnapshot()
    // and _checkGroundCollision() for why this is needed.
    this._preStepVel = new THREE.Vector3();

    this._buildVisuals(scene);

    // ── Water-spray particles — no GLB empty node for this, so a synthetic
    // anchor (assumed "normal position": fuselage belly, offset down by the
    // hull's half-height) is parented to bodyGroup and tracks the airframe
    // automatically, same as a real node would.
    this.waterSplashSystem = new PlaneWaterSplash(scene, this.bodyGroup, this.rigidBody, {
      anchorLocalY: -(this.cfg.hullHalfExtents?.y ?? 0.5),
      maxHeight: this.cfg.waterSplashMaxHeight,
      minHeight: this.cfg.waterSplashMinHeight,
    });

    // Control-surface nodes (populated once GLB loads)
    this._propellerNodes = []; // Propeller_1, Propeller_2, ... (or single "Propeller", index 0)
    this._pilotNode = null;   // hidden while scoped in (first-person view)
    this._aileronL = null;
    this._aileronR = null;
    this._elevatorL = null;
    this._elevatorR = null;
    this._rudderNodes = [];
    this._flapL = null;
    this._flapR = null;
    this._leadingEdgeFlapL = null;
    this._leadingEdgeFlapR = null;

    // ── Landing gear — array-based (one entry per LandingGear_N) ──────────
    this._landingGearNodes     = [];   // Group nodes, populated once GLB loads
    this._wheelNodes           = [];   // matching Wheel_N node, same index
    this._landingGearBaseQuats = [];   // authored ("gear down") quaternion per gear
    this._landingGearUpQuats   = [];   // computed ("gear up"/retracted) target quaternion per gear
    this._landingGearDown      = this.cfg.landingGearDown; // spawn value comes from map config
    this._landingGearT         = this._landingGearDown ? 1 : 0; // 0 = fully up, 1 = fully down — current blend position
    this._wheelColliders       = [];   // Rapier colliders currently attached (only exist while gear is down)

    // ── Thrust-vectoring nozzles ────────────────────────────────────────
    this._nozzleNodes       = []; // Nozzle_N nodes, populated once GLB loads
    this._nozzleBaseQuats   = []; // authored (neutral/un-deflected) local quaternion per nozzle
    this._nozzleCurrentQuat = []; // current live quaternion per nozzle — slerped toward target each frame
    this._nozzleBaseScales  = []; // authored local scale per nozzle — kept for reference, no longer driving area (see _nozzleTaperMaterials)
    this._nozzleAreaScale   = []; // current smoothed radial scale factor (1.0 = authored/neutral), one per nozzle
    this._nozzleTaperMaterials = []; // per-nozzle array of shader-patched materials driving the EXIT-ONLY area taper

    // ── Cached per-nozzle axial extents (mesh-space min/max along
    // cfg.nozzleAxialAxis), captured once in _setupNozzleTaperShader.
    // _updatePropulsionFollowGimbal() reuses these to derive the exact
    // same bend pivot the taper shader uses, so Jet_Propulsion_N can be
    // dragged along with the shader-only nozzle bend.
    this._nozzleAxialMin = [];
    this._nozzleAxialMax = [];

        // ── AI turret guns — populated once the GLB loads (see _loadHullModel).
    // Purely optional: if the model has no AI_Gun_N nodes, all these stay
    // empty and _updateAiGuns() becomes a cheap no-op every frame.
    this._aiGunNodes       = []; // AI_Gun_N group nodes
    this._aiGunPointNodes  = []; // matching AI_GunPoint_N child, same index
    this._aiGunBaseQuats   = []; // neutral (reset + optional 180° inverse) local quaternion per gun — VISUAL rest pose
    this._aiGunAimBaseQuats = []; // "0 yaw/pitch" reference frame used for AIMING MATH only — for rear
    // (aiGunInverse) guns this is baseQuat rotated a further 180°, so the arc/aim math centers on
    // the back of the plane while the mesh's idle pose (baseQuat) is left untouched.
    this._aiGunSystems     = []; // one MachineGunSystem per gun (null if no gun point found)
    this._aiGunTargets     = []; // currently-tracked target per gun, or null
    this._aiGunTotalAmmo   = []; // fixed total ammo pool per gun (loaded + reserve combined) — magSize is just the mag capacity, this is the real ceiling
    this._aiGunSearchAccum = []; // per-gun target-reacquire throttle timer
    this._aiGunEnemyResolver = null; // set externally via setAiGunEnemyResolver()
    this.onAiGunHit = null; // optional external hook — mirrors bulletSystem.onHit's (hitPos, hitTarget, damage) shape
    this.onAiGunFire = null; // optional external hook — called with the gun's world position every time an AI turret gun actually fires a shot
    

    // ── Landing gear doors — Door_{gearIndex}_L / Door_{gearIndex}_R nodes,
    // paired by gear index with the LandingGear_N array above. All _L doors
    // share one rotation angle, all _R doors share the mirrored angle (same
    // pattern as ailerons). Driven by the SAME _landingGearT progress value,
    // remapped into a three-phase envelope: door opens (0→0.25) → gear moves
    // (0.25→0.75) → door closes (0.75→1.0). The gear slerp itself is also
    // remapped onto that middle 50% window (see update()), so from the
    // outside it reads as "door opens, THEN gear moves, THEN door closes."
    // NOTE: authored GLB rest pose for doors is OPEN (not closed, unlike
    // the gear's own authored-down convention) — so "base" here means
    // "authored/open", and "closed" is the COMPUTED target, inverted from
    // how landing gear itself works.
    this._doorLNodes    = []; // Door_{n}_L nodes, indexed same as _landingGearNodes
    this._doorRNodes    = []; // Door_{n}_R nodes, indexed same as _landingGearNodes
    this._doorLBaseQuats  = []; // authored (OPEN) quaternion per door, left side
    this._doorRBaseQuats  = []; // authored (OPEN) quaternion per door, right side
    this._doorLClosedQuats = []; // computed (CLOSED) target quaternion per door, left side
    this._doorRClosedQuats = []; // computed (CLOSED) target quaternion per door, right side
    this._extendDoorsNode = null; // "Extend_Doors" node — hidden only mid-transition

    this._propSpinAngle    = 0;
    this._propSpinVelocity = 0;   // rad/sec — captured at death, decays to 0 while falling
    this._propWobblePhase  = 0;   // drives the irregular off-axis wobble while spinning down

    // Base (authored) local quaternions for each control surface — captured
    // once at load time. Every frame we rotate FROM this base by a small
    // delta on the correct local axis, rather than overwriting .rotation.x/y/z
    // directly, since a Blender-exported node's "forward" axis in local space
    // isn't guaranteed to line up with the world axis names.
    this._aileronLBaseQ = null;
    this._aileronRBaseQ = null;
    this._elevatorLBaseQ = null;
    this._elevatorRBaseQ = null;
    this._rudderBaseQs = []; // one authored base quaternion per rudder node, same index
    this._flapLBaseQ = null;
    this._flapRBaseQ = null;
    this._leadingEdgeFlapLBaseQ = null;
    this._leadingEdgeFlapRBaseQ = null;
    this._flapDeploy = 0; // 0 = retracted, 1 = fully deployed — smoothed each frame

    // Scratch quaternions/axes for control-surface local rotation — reused
    // every frame, never reallocated.
    this._csDeltaQ  = new THREE.Quaternion();
    this._csAxisX   = new THREE.Vector3(1, 0, 0);
    this._csAxisY   = new THREE.Vector3(0, 1, 0);
    this._csAxisZ   = new THREE.Vector3(0, 0, 1);

        this._nozzleScratchAxis    = new THREE.Vector3();
    this._nozzleScratchDeltaQ  = new THREE.Quaternion();
    this._nozzleScratchTargetQ = new THREE.Quaternion();

    this._nozzlePivotVec       = new THREE.Vector3(); // scratch — bend hinge point, Nozzle_N local space
    this._propulsionScratchPos = new THREE.Vector3(); // scratch — Jet_Propulsion_N's rotated local position

    // ── Health ───────────────────────────────────────────────────────────────
    this.maxHealth = config.maxHealth ?? 60;
    this.health    = this.maxHealth;
    this.maxArmour = config.armour    ?? 20;
    this.armour    = this.maxArmour;
    this.isDead    = false;
    this._readyToShowDeath = false;
    this._deathScreenShown = false;
    this._dissolveActive   = false;

    // ── Weapons ──────────────────────────────────────────────────────────────
    // Slot 1 (main gun) — gunType 3 uses MultiGunSystem (multi-barrel,
    // e.g. GunPoint_1/GunPoint_2 firing together), otherwise falls back to
    // the single-barrel MachineGunSystem. Matches tank.js's gunType convention.
    this.explosionSystem = new ExplosionSystem(scene);
    const _gunType = config.gunType ?? this.cfg.gunType ?? 1;
    this._gunType  = _gunType;

    if (_gunType === 3) {
      this.bulletSystem = new MultiGunSystem(scene, world, this.explosionSystem);
      if (this.cfg.gunDamage)      this.bulletSystem.setDamage(this.cfg.gunDamage);
      if (this.cfg.multiGunFireRate) this.bulletSystem.setFireRate(this.cfg.multiGunFireRate);
    } else {
      this.bulletSystem = new MachineGunSystem(scene, world, this.explosionSystem);
      this.bulletSystem.setDamage(this.cfg.gunDamage);
      this.bulletSystem.setRange(this.cfg.mgRange);
      this.bulletSystem.fireInterval = this.cfg.mgFireRate;
    }
    if (this.cfg.mgReloadTime) this.bulletSystem.fullReloadTime = this.cfg.mgReloadTime;   // ← research skill override, applies to whichever gun system was just built

    this.rocketSystem = new RocketSystem(scene, world, this.explosionSystem, {
      damage:     this.cfg.rocketDamage,
      speed:      this.cfg.rocketSpeed,
      reload:     this.cfg.rocketReload,
      guided:     this.cfg.guidedMissile,
      rocketAuto: this.cfg.rocketAuto,
    });
    this.rocketSystem.onAutoFire = () => {
      this.rocketAmmo = Math.max(0, this.rocketAmmo - 1);
      if (this.rocketAmmo <= 0) this.rocketSystem.setAutoFireHeld(false);
    };

    this.bombSystem = new BombSystem(scene, world, this.explosionSystem, {
      damage:      this.cfg.bombDamage,
      blastRadius: this.cfg.bombBlastRadius,
      reload:      this.cfg.bombReload,
      fuseGravity: this.cfg.bombFuseGravity,
    });

    this.flareSystem = new FlareSystem(scene);
    this._flareReloadTimer = 0; // seconds remaining before the next deploy is allowed

    this.activeWeapon = 1; // 1 = MG, 2 = rockets, 3 = bombs (main.js maps its own slot numbers in)
    this.mgAmmo     = config.loadout?.mgAmmo     ?? this.cfg.mgAmmo;
    this.rocketAmmo = config.loadout?.rocketAmmo ?? this.cfg.rocketAmmo;
    this.bombAmmo   = config.loadout?.bombAmmo   ?? this.cfg.bombAmmo;
    this.flareAmmo  = config.loadout?.flareAmmo  ?? this.cfg.flareAmmo;

    // ← cached so respawn() can reset back to these exact starting values
    // (config isn't retained on `this`, so this is the only way respawn
    // can know what the original loadout-resolved ammo counts were)
    this._initialMgAmmo     = this.mgAmmo;
    this._initialRocketAmmo = this.rocketAmmo;
    this._initialBombAmmo   = this.bombAmmo;
    this._initialFlareAmmo  = this.flareAmmo;
    this._initialHispanoAmmo    = this.cfg.hispanoAmmo;
    this._initialHispanoMagSize = this.cfg.hispanoMagSize;

    // ── Hispano ammo is NOT independently tracked here — HispanoBulletSystem
    // (like MultiGunSystem) already owns its own rounds/maxRounds/reload
    // cycle internally, set from this.cfg.hispanoAmmo once the system is
    // built in _loadHullModel(). Read plane.hispanoSystem.rounds /
    // .maxRounds directly for HUD display, the same way you'd read any
    // other gun system's internal ammo state.

    // ── Optional callback main.js can assign to play the crash-explosion
    // sound at the exact moment the plane hits the ground and blows up —
    // mirrors the pattern already used for tank.bulletSystem.onHit /
    // artillery.onHit elsewhere in this codebase. Called with the world
    // impact position. explosionSystem.spawn() only handles the VISUAL
    // side (particles/fire), never audio, so without this hook the crash
    // is silent.
    this.onGroundExplosion = null;

    // ── Optional callback main.js can assign to play the flare-deploy
    // sound at the exact moment flares are released — same pattern as
    // onGroundExplosion above.
    this.onFlareDeploy = null;
    
    // ── Optional callback main.js can assign to relay Hispano cannon hits
    // (e.g. for multiplayer damage sync) — mirrors bulletSystem.onHit's
    // (hitPos, hitTarget, damage) shape.
    this.onHispanoHit = null;

    // ── Shader-based damage stripping — materials patched in
    // _applyDamageShaderToModel(), uniforms refreshed in
    // _updateDamageShaderUniforms() each frame.
    this._damageShaderMaterials = [];
    this._scratchDamageOrigin = new THREE.Vector3();
    this._scratchDamageAft    = new THREE.Vector3();
    this._scratchDamageRight  = new THREE.Vector3();
    this._scratchDamageUp     = new THREE.Vector3();

    // Scratch objects — avoid GC pressure in update()
    this._scratchQ        = new THREE.Quaternion();
    this._scratchQ2       = new THREE.Quaternion();
    this._scratchQ3       = new THREE.Quaternion();
    this._scratchEuler    = new THREE.Euler();
    this._scratchFwd      = new THREE.Vector3();
    this._scratchUp       = new THREE.Vector3();
    this._scratchRight    = new THREE.Vector3();
    this._scratchVel      = new THREE.Vector3();
    this._scratchForce    = new THREE.Vector3();
    this._scratchWorldPos = new THREE.Vector3();

        // ── AI gun turret scratch objects — reused every frame, never reallocated
    this._aiGunScratchGunPos        = new THREE.Vector3();
    this._aiGunScratchTargetPos     = new THREE.Vector3();
    this._aiGunScratchDir           = new THREE.Vector3();
    this._aiGunScratchParentQuat    = new THREE.Quaternion();
    this._aiGunScratchParentQuatInv = new THREE.Quaternion();
    this._aiGunScratchBaseQuatInv   = new THREE.Quaternion();
    this._aiGunScratchEuler         = new THREE.Euler();
    this._aiGunScratchTargetQuat    = new THREE.Quaternion();

    // ── Rear-arc aim flip — a 180° yaw turn applied ONLY to the aiming
    // math (direction-in, quaternion-out) for guns flagged aiGunInverse.
    // This is intentionally separate from `baseQuat` (which only corrects
    // the VISUAL rest pose of a backward-authored mesh) so that flagging a
    // gun as "inverse" now also repurposes it as a tail/rear gun: it hunts
    // for and fires at targets behind the plane instead of in front,
    // regardless of whatever the mesh's own authored orientation happens
    // to be. Self-inverse (180° about Y), so no separate "inverted" copy
    // is needed — applying it once each direction does the job.
    this._aiGunRearFlipQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

    this._groundRayOrigin = null;
    // ── Scratch objects for _checkGroundCollision()'s orientation-aware
    // lowest-corner test — reused every frame, never reallocated.
    this._groundCheckQuat   = new THREE.Quaternion();
    this._groundCheckCorner = new THREE.Vector3();
    this._shakeOffset      = new THREE.Vector3();   // combined (hit-shake + fire-shake + turbulence) offset applied by main.js
    this._hitShakeOffset   = new THREE.Vector3();   // damage-hit shake only
    this._fireShakeOffset  = new THREE.Vector3();   // weapon-fire recoil shake only
    this._turbulenceOffset = new THREE.Vector3();   // low-health turbulence only
    this._turbulencePhaseX = Math.random() * Math.PI * 2;
    this._turbulencePhaseY = Math.random() * Math.PI * 2;

    // ── Control-surface trembling phases — one per surface, randomized so
    // ailerons/elevator/rudder don't all shake in lockstep.
    this._aileronTremblePhase  = Math.random() * Math.PI * 2;
    this._elevatorTremblePhase = Math.random() * Math.PI * 2;
    this._rudderTremblePhase   = Math.random() * Math.PI * 2;
    this._aileronTrembleAngle  = 0;
    this._elevatorTrembleAngle = 0;
    this._rudderTrembleAngle   = 0;

    this._gearTurbulenceOffset = new THREE.Vector3();   // gear-down + high-throttle turbulence only
    this._gearTurbulencePhaseX = Math.random() * Math.PI * 2;
    this._gearTurbulencePhaseY = Math.random() * Math.PI * 2;

    // ── Wingtip vortices — thin trailing ribbon per wingtip, driven by
    // speed / angle-of-attack / G-force. Ring-buffer trail, fixed-size
    // pre-allocated geometry, updated in place (no per-frame allocation).
    this._wingtipNodes  = [null, null];   // WingTip_1, WingTip_2 — populated on GLB load
    this._vortexMeshes  = [null, null];
    this._vortexBuffers = [null, null];   // { positions: Float32Array, alphas: Float32Array, ring: Vector3[], head, count }
    this._VORTEX_TRAIL_LENGTH = 18;       // number of sample points per ribbon
    this._VORTEX_SAMPLE_INTERVAL = 1 / 45; // seconds between samples — decoupled from render fps
    this._vortexSampleAccum = 0;
    this._vortexWidth = 0.015;             // world units, half-width of the ribbon
    this._vortexIntensity = 0;            // smoothed 0..1, shared by both ribbons
    this._scratchVortexDir  = new THREE.Vector3();
    this._scratchVortexRight = new THREE.Vector3();
    this._scratchVelDirPrev = new THREE.Vector3();
    this._scratchVelDirPrevValid = false;
    this._scratchVortexWander = new THREE.Vector3();   // per-point positional wander for cloudy look

    
    // ── Aerodynamic condensation (vapor) — Low_Pressure_1/2 nodes,
    // populated on GLB load only when cfg.aerodynamicCondensation is true
    // (see _loadHullModel). Reuses ExplosionSystem's pooled smoke layer —
    // no new geometry/materials created here.
    this._condensationNodes     = [null, null]; // Low_Pressure_1, Low_Pressure_2
    this._condensationIntensity = 0;            // smoothed 0..1, shared by both points
    this._condensationEmitAccum = [0, 0];       // per-node countdown to next puff
    this._scratchCondensationDir      = new THREE.Vector3();
    this._scratchTurnAxisPrevFwd      = new THREE.Vector3();
    this._scratchTurnAxisPrevFwdValid = false;

    // ── Jet propulsion nodes — populated on GLB load, one entry per
    // Jet_Propulsion_N found (up to 3). Each entry owns its own flame
    // particle system + a pooled set of shockwave sprites, all parented
    // to `scene` directly (world-space), same pattern as the wingtip
    // vortex ribbons above.
    this._propulsionNodes = [];   // THREE.Object3D — the empty node itself
    this._propulsionRigs  = [];   // { flame: {...}, shockwaves: [...] } per node

    // ── Jet_Propulsion_N → Nozzle_N follow-transform bookkeeping. Since
    // Nozzle_N's own transform never changes (see _updateNozzleGimbal),
    // anything parented under it — currently just Jet_Propulsion_N — has
    // to be manually dragged along with the shader-only gimbal bend.
    this._propulsionNozzleIndex   = []; // per Jet_Propulsion_N index → matching _nozzleNodes index, or -1
    this._propulsionBaseLocalPos  = []; // authored local position relative to its Nozzle_N parent, captured at load
    this._propulsionBaseLocalQuat = []; // authored local quaternion, same space

    // ── Spawn grace period — ground-collision damage is suppressed for a
    // brief window after spawn/respawn, since the plane starts near/at
    // minAltitude before throttle has had a chance to build climb speed.
    this._groundCollisionGrace = 1.5; // seconds
    this._treeCheckAccum = 0; // seconds since last tree-collision probe while falling after death
    // ── Cooldown between wheel-touch smoke puffs — prevents spamming a
    // puff every physics step while airspeed lingers in the moderate
    // "landing" band for several frames in a row.
    this._wheelSmokeCooldown = 0; // seconds remaining until another puff is allowed

    // ── Play-zone boundary state — read by main.js every frame to drive
    // the "RETURN TO PLAY ZONE" HUD warning + countdown. isOutOfPlayZone
    // and outOfZoneTimeRemaining are the only two fields main.js needs.
    this._outOfZoneTimer      = 0;
    this.isOutOfPlayZone      = false;
    this.outOfZoneTimeRemaining = 0;

    // ── Spawn directly into autopilot mode, if the map config wants it.
    // Reuses toggleAutopilot() rather than just setting the flag, so
    // _apTargetAltitude/_apTargetHeadingRad/throttle get initialized
    // exactly the same way a manual Shift-press would set them — flipping
    // the flag alone would leave those targets at their constructor
    // defaults (0), causing the plane to immediately "correct" toward
    // y=0 / heading 0 on spawn.
    if (this.cfg.initialAutopilotOn) {
      this.toggleAutopilot();
    }
  }

  static async create(scene, world, position = { x: 0, y: 80, z: 0 }, config = {}) {
    const plane = new Plane(scene, world, position, config);
    await plane._loadHullModel();
    return plane;
  }

  // ── Physics ────────────────────────────────────────────────────────────────

  _buildPhysics(world, pos) {
    const RAPIER = world.__RAPIER__;
    const { x: hx, y: hy, z: hz } = this.cfg.hullHalfExtents;

    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinearDamping(0.15)     // planes coast much more freely than tanks
      .setAngularDamping(2.2)
      .setAdditionalMass(1.2)
      .setCcdEnabled(true);       // fast-moving thin body — avoid tunnelling through terrain

    this.rigidBody = world.createRigidBody(rbDesc);

    // ── Vertical offset of the collider relative to the rigid body origin.
    // Positive = collider sits ABOVE the body's translation (i.e. the visual
    // model appears to hang lower than the hitbox). Tune to taste.
    const colliderYOffset = this.cfg.colliderYOffset ?? 1;

    const bodyCol = RAPIER.ColliderDesc
      .cuboid(hx, hy, hz)
      .setTranslation(0, colliderYOffset, 0)   // ← local offset from the rigid body's origin
      .setFriction(0.3)
      .setRestitution(0.05)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    world.createCollider(bodyCol, this.rigidBody);

    // ── Wing collider — separate cuboid so wingtip/wing-strike hits and
    // ground clips register even though the fuselage hull box above is
    // narrow. Attached to the same rigid body, so it moves/rotates with
    // the plane automatically and is removed for free when the rigid body
    // is removed (respawn/death/dispose).
    const { x: wx, y: wy, z: wz } = this.cfg.wingHalfExtents;
    const wingOff = this.cfg.wingColliderOffset;
    const wingCol = RAPIER.ColliderDesc
      .cuboid(wx, wy, wz)
      .setTranslation(wingOff.x, colliderYOffset + wingOff.y, wingOff.z)
      .setFriction(0.3)
      .setRestitution(0.05)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    world.createCollider(wingCol, this.rigidBody);

    // ── Seed initial velocity so the plane doesn't start from a dead stop.
    // Body spawns with no rotation applied (identity quaternion), so local
    // forward is (0,0,-1) — matches the fwd vector convention used in
    // _updateFlightPhysics. Without this, gravity/drag act on the rigid
    // body for several frames before the velocity-blend in
    // _updateFlightPhysics catches up to `this.airspeed`, causing a sink
    // on spawn/respawn.
    // this.airspeed is already derived from cfg.initialThrottle at
    // construction/respawn time (see constructor / respawn()).
    const initialAirspeed = this.airspeed;
    this.rigidBody.setLinvel({ x: 0, y: 0, z: -initialAirspeed }, true);
  }

  _buildVisuals(scene) {
    this.bodyGroup = new THREE.Group();
    scene.add(this.bodyGroup);
  }

  async _loadHullModel() {
    const modelPath = this.cfg.modelObjectURL ?? this.cfg.modelPath;
    const model = await loadModel(modelPath);

    const s = this.cfg.modelScale;
    model.scale.set(s, s, s);
    model.position.set(this.cfg.modelOffsetX, this.cfg.modelOffsetY, this.cfg.modelOffsetZ);
    model.rotation.set(
      this.cfg.modelRotX * (Math.PI / 180),
      this.cfg.modelRotY * (Math.PI / 180),
      this.cfg.modelRotZ * (Math.PI / 180)
    );

    // Node names match the authored Blender rig exactly:
    // Aileron_L, Aileron_R, Elevator_L, Elevator_R, Rudder, Propeller,
    // GunPoint_1, GunPoint_2, RocketPoint_L, RocketPoint_R, BombPoint,
    // ScopePoint, LandingGear, Wheels.
    const gunPointByIndex = new Map(); // e.g. "GunPoint_1" → index 0, "GunPoint_3" → index 2
    let scopePoint = null;
    let bombPoint = null;
    let rocketPointL = null;
    let rocketPointR = null;
    const landingGearByIndex = new Map(); // e.g. "LandingGear_1" → index 0
    const wheelByIndex       = new Map(); // e.g. "Wheel_1"       → index 0
    const doorLByIndex       = new Map(); // e.g. "Door_1_L"      → index 0
    const doorRByIndex       = new Map(); // e.g. "Door_1_R"      → index 0
    const propellerByIndex   = new Map(); // e.g. "Propeller_1"   → index 0, plain "Propeller" → index 0
    const rudderByIndex      = new Map(); // e.g. "Rudder_1"      → index 0, plain "Rudder" → index 0
        const nozzleByIndex      = new Map(); // e.g. "Nozzle_1"      → index 0

    const aiGunByIndex      = new Map(); // e.g. "AI_Gun_1"      → index 0
    const jetPropulsionByIndex = new Map(); // e.g. "Jet_Propulsion_1" → index 0
    const aiGunPointByIndex = new Map(); // e.g. "AI_GunPoint_1" → index 0
    const hispanoByIndex    = new Map(); // e.g. "Hispano_1"     → index 0

    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow    = true;
        child.receiveShadow = false;
      }
      if (child.name.startsWith('Propeller_Shadow')) {
        child.castShadow    = false;
        child.receiveShadow = false;
      }
      // Supports both the legacy single "Propeller" node (treated as
      // index 0) and numbered "Propeller_1", "Propeller_2", ... for
      // multi-prop aircraft. If a model somehow has both, the numbered
      // one wins for index 0 (Map.set overwrites) since it's matched second.
      if (child.name === 'Propeller') propellerByIndex.set(0, child);
      const _propMatch = child.name.match(/^Propeller_(\d+)$/);
      if (_propMatch) propellerByIndex.set(Number(_propMatch[1]) - 1, child);

      if (child.name === 'Pilot')       this._pilotNode      = child;
      if (child.name === 'Aileron_L')   this._aileronL        = child;
      if (child.name === 'Aileron_R')   this._aileronR        = child;
      if (child.name === 'Elevator_L')  this._elevatorL       = child;
      if (child.name === 'Elevator_R')  this._elevatorR       = child;
      // Supports both the legacy single "Rudder" node (treated as index 0)
      // and numbered "Rudder_1", "Rudder_2", ... for twin-tail aircraft.
      // Same pattern as the Propeller_N handling above. If a model has
      // both, the numbered one wins for index 0 (Map.set overwrites) since
      // it's matched second.
      if (child.name === 'Rudder') rudderByIndex.set(0, child);
      const _rudderMatch = child.name.match(/^Rudder_(\d+)$/);
      if (_rudderMatch) rudderByIndex.set(Number(_rudderMatch[1]) - 1, child);
      if (child.name === 'Flap_L')      this._flapL           = child;
      if (child.name === 'Flap_R')      this._flapR           = child;
      if (child.name === 'LeadingEdge_Flap_L') this._leadingEdgeFlapL = child;
      if (child.name === 'LeadingEdge_Flap_R') this._leadingEdgeFlapR = child;
      const _gunPointMatch = child.name.match(/^GunPoint_(\d+)$/);
      if (_gunPointMatch) gunPointByIndex.set(Number(_gunPointMatch[1]) - 1, child);
      if (child.name === 'ScopePoint')  scopePoint  = child;
      if (child.name === 'BombPoint')   bombPoint   = child;
      if (child.name === 'RocketPoint_L') rocketPointL = child;
      if (child.name === 'RocketPoint_R') rocketPointR = child;
      const _lgMatch = child.name.match(/^LandingGear_(\d+)$/);
      if (_lgMatch) landingGearByIndex.set(Number(_lgMatch[1]) - 1, child);
            const _nozzleMatch = child.name.match(/^Nozzle_(\d+)$/);
      if (_nozzleMatch) nozzleByIndex.set(Number(_nozzleMatch[1]) - 1, child);

            const _aiGunMatch = child.name.match(/^AI_Gun_(\d+)$/);
      if (_aiGunMatch) aiGunByIndex.set(Number(_aiGunMatch[1]) - 1, child);
      const _aiGunPointMatch = child.name.match(/^AI_GunPoint_(\d+)$/);
      if (_aiGunPointMatch) aiGunPointByIndex.set(Number(_aiGunPointMatch[1]) - 1, child);
      
      const _hispanoMatch = child.name.match(/^Hispano_(\d+)$/);
      if (_hispanoMatch) hispanoByIndex.set(Number(_hispanoMatch[1]) - 1, child);

      if (child.name === 'WingTip_1') this._wingtipNodes[0] = child;
      if (child.name === 'WingTip_2') this._wingtipNodes[1] = child;

      const _jetPropMatch = child.name.match(/^Jet_Propulsion_(\d+)$/);
      if (_jetPropMatch && this.cfg.propulsion) {
        const idx = Number(_jetPropMatch[1]) - 1;
        if (idx >= 0 && idx < 3) jetPropulsionByIndex.set(idx, child);
      }

      if (this.cfg.aerodynamicCondensation) {
        if (child.name === 'Low_Pressure_1') this._condensationNodes[0] = child;
        if (child.name === 'Low_Pressure_2') this._condensationNodes[1] = child;
      }

      const _wheelMatch = child.name.match(/^Wheel_(\d+)$/);
      if (_wheelMatch) wheelByIndex.set(Number(_wheelMatch[1]) - 1, child);

      const _doorLMatch = child.name.match(/^Door_(\d+)_L$/);
      if (_doorLMatch) doorLByIndex.set(Number(_doorLMatch[1]) - 1, child);
      const _doorRMatch = child.name.match(/^Door_(\d+)_R$/);
      if (_doorRMatch) doorRByIndex.set(Number(_doorRMatch[1]) - 1, child);

      if (child.name === 'Extend_Doors') this._extendDoorsNode = child;
    });

    // ── Build ordered propeller array (index 0 = Propeller_1 or legacy
    // "Propeller", index 1 = Propeller_2, etc.)
    this._propellerNodes = [];
    const _propIndices = [...propellerByIndex.keys()].sort((a, b) => a - b);
    for (const idx of _propIndices) {
      this._propellerNodes.push(propellerByIndex.get(idx));
    }
    if (this._propellerNodes.length === 0) console.warn('[Plane] No Propeller/Propeller_N node found in GLB — no spin animation');
    if (!this._pilotNode)      console.warn('[Plane] Pilot node not found in GLB — cannot hide for scope view');
    if (this._pilotNode)       this._pilotNode.visible = true; // always starts visible on (re)load, even mid-scope-toggle-state
    if (!this._aileronL || !this._aileronR)   console.warn('[Plane] Aileron_L/R not found — no visible roll animation');
    if (!this._elevatorL || !this._elevatorR) console.warn('[Plane] Elevator_L/R not found — no visible pitch animation');

    // ── Build ordered rudder array (index 0 = Rudder_1 or legacy "Rudder",
    // index 1 = Rudder_2, etc.) — supports twin/multi-tail aircraft.
    this._rudderNodes = [];
    const _rudderIndices = [...rudderByIndex.keys()].sort((a, b) => a - b);
    for (const idx of _rudderIndices) {
      this._rudderNodes.push(rudderByIndex.get(idx));
    }
    if (this._rudderNodes.length === 0) console.warn('[Plane] No Rudder/Rudder_N node found in GLB — no visible yaw animation');

    // ── Capture base (authored) local rotations for control surfaces ───────
    // Must happen right after traverse, before any per-frame delta rotation
    // is ever applied, so the "neutral" pose is exactly what the artist made.
    if (this._aileronL)   this._aileronLBaseQ  = this._aileronL.quaternion.clone();
    if (this._aileronR)   this._aileronRBaseQ  = this._aileronR.quaternion.clone();
    if (this._elevatorL)  this._elevatorLBaseQ = this._elevatorL.quaternion.clone();
    if (this._elevatorR)  this._elevatorRBaseQ = this._elevatorR.quaternion.clone();
    this._rudderBaseQs = this._rudderNodes.map((node) => node.quaternion.clone());
    if (this._flapL)      this._flapLBaseQ     = this._flapL.quaternion.clone();
    if (this._flapR)      this._flapRBaseQ     = this._flapR.quaternion.clone();
    if (!this._flapL || !this._flapR) console.warn('[Plane] Flap_L/R not found in GLB — no flap deploy animation');

    if (this._leadingEdgeFlapL) this._leadingEdgeFlapLBaseQ = this._leadingEdgeFlapL.quaternion.clone();
    if (this._leadingEdgeFlapR) this._leadingEdgeFlapRBaseQ = this._leadingEdgeFlapR.quaternion.clone();
    if (!this._leadingEdgeFlapL || !this._leadingEdgeFlapR) console.warn('[Plane] LeadingEdge_Flap_L/R not found in GLB — no leading-edge flap animation');

    // ── Build ordered arrays (index 0 = LandingGear_1, etc.), capture each
    // gear's authored ("gear down") base quaternion, and precompute its
    // retracted ("gear up") target quaternion from the Blender-space Euler
    // degrees configured in planes.json.
    this._landingGearNodes     = [];
    this._wheelNodes           = [];
    this._landingGearBaseQuats = [];
    this._landingGearUpQuats   = [];

    const _gearIndices = [...landingGearByIndex.keys()].sort((a, b) => a - b);
    for (const idx of _gearIndices) {
      const gearNode = landingGearByIndex.get(idx);
      this._landingGearNodes.push(gearNode);
      this._wheelNodes.push(wheelByIndex.get(idx) ?? null);
      this._landingGearBaseQuats.push(gearNode.quaternion.clone());

      const rotDeg  = this.cfg.landingGearRotationsDeg[idx] ?? [0, 0, 0];
      const upDelta = blenderEulerDegToThreeQuat(rotDeg[0], rotDeg[1], rotDeg[2]);
      this._landingGearUpQuats.push(gearNode.quaternion.clone().multiply(upDelta));

      // ── Doors are now collected in their OWN loop below, decoupled from
      // gear indices — see the door-building block immediately after this
      // gear loop. (Left intentionally empty here.)
    }

    // ── Doors — collected over their OWN index range (Door_N_L/R), NOT
    // tied 1:1 to LandingGear_N. A single physical gear leg can have
    // multiple door pairs (e.g. leg door + bay door), so door index N no
    // longer implies "belongs to LandingGear_N" structurally — instead,
    // each door is driven by the SAME shared _landingGearT progress value
    // as before (all doors still open/close in the same overall envelope),
    // but door count is independent of gear count.
    //
    // If you need PER-GEAR-LEG door timing (e.g. nose gear doors move on a
    // different schedule than main gear doors), extend
    // this.cfg.doorGearMap (door index → gear index) and read the
    // corresponding gear's _landingGearT in update() instead of the shared
    // one — not implemented here since all doors currently share one timeline.
    this._doorLNodes    = [];
    this._doorRNodes    = [];
    this._doorLBaseQuats  = [];
    this._doorRBaseQuats  = [];
    this._doorLClosedQuats = [];
    this._doorRClosedQuats = [];

    const _doorIndices = new Set([...doorLByIndex.keys(), ...doorRByIndex.keys()]);
    const _sortedDoorIndices = [..._doorIndices].sort((a, b) => a - b);

    for (const idx of _sortedDoorIndices) {
      const doorLNode = doorLByIndex.get(idx) ?? null;
      const doorRNode = doorRByIndex.get(idx) ?? null;
      this._doorLNodes.push(doorLNode);
      this._doorRNodes.push(doorRNode);

      // ── Resolve this door's LEFT close angle — per-index override if
      // provided, otherwise the shared default.
      const leftAngleDeg = this.cfg.doorCloseRotationsDegL[idx] ?? this.cfg.doorCloseRotationDegL;

      if (doorLNode) {
        this._doorLBaseQuats.push(doorLNode.quaternion.clone()); // OPEN (authored)
        const closeDelta = blenderEulerDegToThreeQuat(...leftAngleDeg);
        this._doorLClosedQuats.push(doorLNode.quaternion.clone().multiply(closeDelta)); // CLOSED (computed)
      } else {
        this._doorLBaseQuats.push(null);
        this._doorLClosedQuats.push(null);
      }

      // ── Resolve this door's RIGHT close angle — per-index override if
      // explicitly provided; otherwise auto-mirror THIS SAME door's left
      // angle (negate Y and Z, matching the shared-default convention of
      // [0,0,80] ↔ [0,0,-80]), rather than falling back to the separate
      // doorCloseRotationDegR default. This means editing a door's left
      // angle alone keeps left/right symmetric for free, unless you add an
      // explicit entry in doorCloseRotationsDegR for that index.
      const rightAngleDeg = this.cfg.doorCloseRotationsDegR[idx]
        ?? [leftAngleDeg[0], -leftAngleDeg[1], -leftAngleDeg[2]];

      if (doorRNode) {
        this._doorRBaseQuats.push(doorRNode.quaternion.clone()); // OPEN (authored)
        const closeDelta = blenderEulerDegToThreeQuat(...rightAngleDeg);
        this._doorRClosedQuats.push(doorRNode.quaternion.clone().multiply(closeDelta)); // CLOSED (computed)
      } else {
        this._doorRBaseQuats.push(null);
        this._doorRClosedQuats.push(null);
      }
    }

    if (this._landingGearNodes.length === 0) {
      console.warn('[Plane] No LandingGear_N nodes found in GLB — no retract animation');
    }
    if (this._doorLNodes.every(n => !n) && this._doorRNodes.every(n => !n)) {
      console.warn('[Plane] No Door_N_L/R nodes found in GLB — no gear door animation');
    }
    if (!this._extendDoorsNode) {
      console.warn('[Plane] Extend_Doors node not found in GLB — nothing to hide during gear transition');
    } else {
      this._extendDoorsNode.visible = true; // always starts visible on (re)load, matches idle state
    }

        // ── Thrust-vectoring nozzles — build ordered array (index 0 = Nozzle_1,
    // etc.), capturing each nozzle's authored (neutral) local quaternion as
    // the rest pose every future deflection is applied FROM.
    this._nozzleNodes       = [];
    this._nozzleBaseQuats   = [];
    this._nozzleCurrentQuat = [];
    this._nozzleTaperMaterials = [];
    const _nozzleIndices = [...nozzleByIndex.keys()].sort((a, b) => a - b);
    for (const idx of _nozzleIndices) {
      const nozzleNode = nozzleByIndex.get(idx);
      this._nozzleNodes.push(nozzleNode);
      this._nozzleBaseQuats.push(nozzleNode.quaternion.clone());
      this._nozzleCurrentQuat.push(nozzleNode.quaternion.clone());
      this._nozzleBaseScales.push(nozzleNode.scale.clone());
      this._nozzleAreaScale.push(1.0); // starts neutral, eases toward the throttle target once flying
      this._setupNozzleTaperShader(nozzleNode, idx);
    }
    if (this._nozzleNodes.length === 0) {
      console.warn('[Plane] No Nozzle_N nodes found in GLB — no thrust-vectoring animation');
    }

    if (!this._wingtipNodes[0] || !this._wingtipNodes[1]) {
      console.warn('[Plane] WingTip_1/2 not found in GLB — no vortex ribbons');
    } else {
      // ── Dispose any ribbon meshes left over from a PREVIOUS life before
      // building fresh ones. Note: we don't call _disposeWingtipVortices()
      // here since that also nulls _wingtipNodes[w] — which the traverse()
      // above just freshly repopulated for THIS life. Only the old
      // mesh/buffer objects need clearing.
      for (let w = 0; w < 2; w++) {
        const oldMesh = this._vortexMeshes[w];
        if (oldMesh) {
          this.scene.remove(oldMesh);
          oldMesh.geometry.dispose();
          oldMesh.material.dispose();
        }
        this._vortexMeshes[w]  = null;
        this._vortexBuffers[w] = null;
      }
      this._buildWingtipVortexMeshes();
    }

    // ── Jet propulsion — build ordered array (index 0 = Jet_Propulsion_1,
    // etc.), disposing any rigs left over from a previous life first.
    this._disposeJetPropulsion();
    if (this.cfg.propulsion) {
      const _jpIndices = [...jetPropulsionByIndex.keys()].sort((a, b) => a - b);
      for (const idx of _jpIndices) {
        const node = jetPropulsionByIndex.get(idx);
        this._propulsionNodes.push(node);
        this._propulsionRigs.push(this._buildAfterburnerRig(node));
      }
      if (this._propulsionNodes.length === 0) {
        console.warn('[Plane] cfg.propulsion is true but no Jet_Propulsion_N nodes found in GLB');
      }
    }

        // ── Map each Jet_Propulsion_N to whichever Nozzle_N it's actually
    // parented under (via the real scene-graph parent, not index-guessing),
    // and capture its authored local transform. Both are needed by
    // _updatePropulsionFollowGimbal() every frame — must run AFTER
    // _nozzleNodes is fully populated (it is, that loop runs earlier in
    // this method) and AFTER _propulsionNodes above.
    this._propulsionNozzleIndex   = [];
    this._propulsionBaseLocalPos  = [];
    this._propulsionBaseLocalQuat = [];
    for (const propNode of this._propulsionNodes) {
      const nozzleIdx = this._nozzleNodes.indexOf(propNode.parent);
      if (nozzleIdx === -1) {
        console.warn(`[Plane] ${propNode.name} is not parented under any Nozzle_N — it will not follow nozzle gimbal`);
      }
      this._propulsionNozzleIndex.push(nozzleIdx);
      this._propulsionBaseLocalPos.push(propNode.position.clone());
      this._propulsionBaseLocalQuat.push(propNode.quaternion.clone());
    }
    
    if (this.cfg.aerodynamicCondensation && (!this._condensationNodes[0] || !this._condensationNodes[1])) {
      console.warn('[Plane] aerodynamicCondensation is true but Low_Pressure_1/2 not found in GLB — no vapor effect');
    }

        // ── AI turret guns — build ordered arrays (index 0 = AI_Gun_1, etc.).
    // Each gun's authored rotation is reset to identity first, then the
    // configured 180° "inverse" flip (if any) is baked in as its neutral
    // rest pose — everything _updateAiGuns() does afterward rotates FROM
    // this rest pose, never from whatever Blender happened to export.
    this._disposeAiGuns(); // clears any stale state from a previous life — safe no-op on first load

    const _aiGunIndices = [...aiGunByIndex.keys()].sort((a, b) => a - b);
    for (const idx of _aiGunIndices) {
      const gunNode = aiGunByIndex.get(idx);
      const pointNode = aiGunPointByIndex.get(idx) ?? null;

      gunNode.quaternion.identity(); // reset authored rotation

      const inverse = this.cfg.aiGunInverse[idx] ?? false;
      const baseQuat = inverse
        ? new THREE.Quaternion().setFromAxisAngle(this._csAxisY, Math.PI)
        : new THREE.Quaternion();
      gunNode.quaternion.copy(baseQuat);

      this._aiGunNodes.push(gunNode);
      this._aiGunPointNodes.push(pointNode);
      this._aiGunBaseQuats.push(baseQuat);
      // ── Aim-frame correction — CONFIRMED via runtime diagnostics
      // (frontDot vs. yaw logged in _isTargetInGunArc): this rig's
      // AI_Gun_N nodes treat local +Z as "forward", not local -Z like the
      // yaw/pitch decomposition below assumes. Using the VISUAL baseQuat
      // directly as the aim frame (as before) made every gun's "0° yaw"
      // point at the plane's nose regardless of aiGunInverse — so rear
      // guns could never read a target behind the plane as in-arc.
      // Baking one more 180°-about-Y correction into the AIM frame only
      // (never into gunNode's own visual quaternion/baseQuat) flips the
      // parity back: inverse (rear) guns end up with 0-yaw = astern,
      // non-inverse (front) guns end up with 0-yaw = dead ahead — both
      // rotations are about the same axis so they commute regardless of
      // multiplication order.
      const _aimFrameCorrection = new THREE.Quaternion().setFromAxisAngle(this._csAxisY, Math.PI);
      this._aiGunAimBaseQuats.push(baseQuat.clone().multiply(_aimFrameCorrection));
      this._aiGunTargets.push(null);
      this._aiGunSearchAccum.push(Math.random() * AI_GUN_TARGET_SEARCH_INTERVAL); // stagger scans across guns
      this._aiGunTotalAmmo.push(this.cfg.aiGunTotalAmmo ?? this.cfg.aiGunMagSize * 3); // total pool this gun ever has, loaded + reserve

      if (!pointNode) {
        console.warn(`[Plane] AI_Gun_${idx + 1} has no matching AI_GunPoint_${idx + 1} — this gun will not fire`);
        this._aiGunSystems.push(null);
        continue;
      }

      const sys = new MachineGunSystem(this.scene, this.world, this.explosionSystem);
      sys.setGunPoint(pointNode);
      sys.setDamage(this.cfg.aiGunDamage);
      sys.setRange(this.cfg.aiGunRange);
      sys.fireInterval = this.cfg.aiGunFireRate;
      // ── Finite ammo — AI turret guns now use a real magazine + reload
      // cycle, same mechanism the player's own MG uses. MachineGunSystem's
      // own update() already handles the reload countdown once `rounds`
      // hits 0 (see the `_reloading` branch in update()), so all we need
      // to do here is seed it with real numbers instead of Infinity.
      sys.magSize        = this.cfg.aiGunMagSize;
      sys.rounds         = this.cfg.aiGunMagSize;
      sys.fullReloadTime = this.cfg.aiGunReloadTime;
      sys.onHit = (hitPos, hitTarget, appliedDamage) => {
        this.onAiGunHit?.(hitPos, hitTarget, appliedDamage);
      };
      this._aiGunSystems.push(sys);
    }

    this.bodyGroup.add(model);
    this._applyDamageShaderToModel(model);

    // ── Wheel colliders — small cuboids placed at each Wheel_N node's
    // current world position, expressed relative to the rigid body origin
    // (bodyGroup's local space), so they ride along with the plane.
    this.bodyGroup.updateMatrixWorld(true);
    this._rebuildWheelColliders();

    // ── Main guns — feed the same MachineGunSystem/MultiGunSystem. Builds
    // an ordered array from every GunPoint_N node found (index 0 =
    // GunPoint_1, etc.), then caps it to cfg.totalMG if configured. Uses
    // setGunPoints (plural) if the MG system supports multiple muzzles;
    // otherwise falls back to the first point found so single-gun fire
    // still works.
    let gunPoints = [];
    const _gunPointIndices = [...gunPointByIndex.keys()].sort((a, b) => a - b);
    for (const idx of _gunPointIndices) {
      gunPoints.push(gunPointByIndex.get(idx));
    }
    if (this.cfg.totalMG != null && this.cfg.totalMG > 0) {
      gunPoints = gunPoints.slice(0, this.cfg.totalMG);
    }

    if (gunPoints.length > 0) {
      if (typeof this.bulletSystem.setGunPoints === 'function') {
        this.bulletSystem.setGunPoints(gunPoints);
      } else {
        this.bulletSystem.setGunPoint(gunPoints[0]);
      }
    } else {
      console.warn('[Plane] No GunPoint_N nodes found in GLB (or totalMG capped to 0) — MG disabled');
    }

    // ── Hispano cannon banks — entirely independent of gunType. Detected
    // purely from Hispano_N node names; if the model has none, this plane
    // simply has no slot-6 weapon at all (this.hasHispano stays false).
    this.hispanoSystem?.dispose?.(); // clear any stale instance from a previous life (respawn)
    const hispanoPoints = [];
    const _hispanoIndices = [...hispanoByIndex.keys()].sort((a, b) => a - b);
    for (const idx of _hispanoIndices) {
      hispanoPoints.push(hispanoByIndex.get(idx));
    }

    if (hispanoPoints.length > 0) {
      this.hispanoSystem = new HispanoBulletSystem(this.scene, this.world, this.explosionSystem);
      this.hispanoSystem.setGunPoints(hispanoPoints);
      this.hispanoSystem.setDamage(this.cfg.hispanoDamage);
      this.hispanoSystem.setRange(this.cfg.hispanoRange);
      if (this.cfg.hispanoFireRate)   this.hispanoSystem.setFireRate(this.cfg.hispanoFireRate);
      if (this.cfg.hispanoReloadTime) this.hispanoSystem.fullReloadTime = this.cfg.hispanoReloadTime;
      this.hispanoSystem.setMagSize(this.cfg.hispanoMagSize ?? 60);
      this.hispanoSystem.setTotalAmmo(this.cfg.hispanoAmmo);
      this.hispanoSystem.onHit = (hitPos, hitTarget, appliedDamage) => {
        this.onHispanoHit?.(hitPos, hitTarget, appliedDamage);
      };
      this.hasHispano = true;
    } else {
      this.hispanoSystem = null;
      this.hasHispano = false;
    }

    this.scopePoint = scopePoint ?? gunPoints[0] ?? null;
    if (!scopePoint) console.warn('[Plane] ScopePoint not found in GLB — falling back to GunPoint/none for aim view');

    if (bombPoint) {
      this.bombSystem.setDropPoint(bombPoint);
      this.hasBombs = true;
      this.bombPoint = bombPoint; // ← exposed for the bomb-sight scope view
    } else {
      console.warn('[Plane] BombPoint not found in GLB — bombs disabled');
      this.hasBombs = false;
      this.bombPoint = null;
    }

    const rocketPoints = [rocketPointL, rocketPointR].filter(Boolean);
    if (rocketPoints.length > 0) {
      this.rocketSystem.setLaunchPoints(rocketPoints);
      this.hasRockets = true;
    } else {
      console.warn('[Plane] RocketPoint_L/R not found in GLB — rockets disabled');
      this.hasRockets = false;
    }

    if (!this._landingGearNode) console.warn('[Plane] LandingGear not found in GLB — no retract animation');

    if (this.cfg.modelObjectURL) {
      URL.revokeObjectURL(this.cfg.modelObjectURL);
      this.cfg.modelObjectURL = null;
    }
  }

  // ── Local-axis control-surface rotation helper ───────────────────────────
  // Rotates `node` to baseQuat * deltaRotation(axis, angle) — i.e. the delta
  // is applied in the node's own local space on top of however it was
  // authored in Blender, robust regardless of the node's rest orientation.
  _applyControlSurfaceRotation(node, baseQuat, axisVec, angle) {
    if (!node || !baseQuat) return;
    this._csDeltaQ.setFromAxisAngle(axisVec, angle);
    node.quaternion.copy(baseQuat).multiply(this._csDeltaQ);
  }

  // ── Landing gear ──────────────────────────────────────────────────────────

  /** Toggles the landing gear between extended (down) and retracted (up).
   * Mirrors toggleAutopilot()'s pattern — flips a boolean, update() handles
   * the actual visual slerp each frame. */
  toggleLandingGear() {
    if (this.isDead) return this._landingGearDown;
    this._landingGearDown = !this._landingGearDown;

    // Retracting: colliders come off the instant retraction starts, so the
    // plane doesn't clip/bounce off ghost wheels mid-fold.
    // Extending: colliders are NOT rebuilt here — the wheel nodes haven't
    // reached their extended world position yet (the gear-down slerp takes
    // landingGearTransitionDuration seconds in update()). Building now would
    // bake the collider at the wheel's still-folded position and it would
    // never re-sync once the animation finishes. Instead, update() rebuilds
    // them once the extension animation actually completes.
    if (!this._landingGearDown) {
      this._disposeWheelColliders();
    }

    // ── Force autopilot off the instant gear is lowered mid-flight —
    // mirrors takeDamage()'s low-health disengage. Gear was already UP
    // when autopilot was engaged (toggleAutopilot's guard above prevents
    // engaging otherwise), so this only fires on the up→down transition.
    if (this._landingGearDown && this.autopilotEnabled) {
      this.autopilotEnabled = false;
    }

    return this._landingGearDown;
  }

  _rebuildWheelColliders() {
    this._disposeWheelColliders();
    if (!this._landingGearDown || !this.rigidBody) return;

    const RAPIER = this.world.__RAPIER__;
    const half   = this.cfg.wheelColliderHalfExtent;
    const worldPos = new THREE.Vector3();

    for (const wheelNode of this._wheelNodes) {
      if (!wheelNode) continue;
      wheelNode.getWorldPosition(worldPos);
      const localPos = this.bodyGroup.worldToLocal(worldPos); // relative to rigid body origin

      const colliderDesc = RAPIER.ColliderDesc
        .cuboid(half, half, half)
        .setTranslation(localPos.x, localPos.y, localPos.z)
        .setFriction(this.cfg.wheelFriction)
        .setRestitution(0.0);

      this._wheelColliders.push(this.world.createCollider(colliderDesc, this.rigidBody));
    }

    // Freshly built colliders always start at normal friction, even if
    // reverse happened to be engaged the instant before a rebuild.
    if (this._reverseGearEngaged) {
      this._setWheelFriction(this.cfg.reverseWheelFriction);
    }
  }

    /** Live-adjusts friction on the currently attached wheel colliders — used
   * to nearly eliminate rolling friction while reverse gear is engaged, so
   * the small imposed reverse velocity isn't cancelled out by the contact
   * solver before the next frame ever reads it back. Cheap: just a
   * .setFriction() call per collider, no rebuild. */
  _setWheelFriction(value) {
    for (const collider of this._wheelColliders) {
      collider.setFriction(value);
    }
  }

  _disposeWheelColliders() {
    if (!this._wheelColliders?.length) { this._wheelColliders = []; return; }
    for (const collider of this._wheelColliders) {
      try { this.world.removeCollider(collider, true); } catch (_) {}
    }
    this._wheelColliders = [];
  }

    _disposeAiGuns() {
    if (this._aiGunSystems) {
      for (const sys of this._aiGunSystems) sys?.dispose?.();
    }
    this._aiGunNodes       = [];
    this._aiGunPointNodes  = [];
    this._aiGunBaseQuats   = [];
    this._aiGunAimBaseQuats = [];
    this._aiGunSystems     = [];
    this._aiGunTargets     = [];
    this._aiGunSearchAccum = [];
    this._aiGunTotalAmmo   = []; // ← was never cleared — stale depleted totals were
                                  //   leaking into the next life instead of being
                                  //   replaced by fresh values in _loadHullModel()
    this._aiGunWasReloading = []; // ← same staleness risk for the reload-edge tracker
  }

  /** Registers the function main.js uses to resolve enemy candidates —
   * same contract as the enemyResolver passed elsewhere: calling it with
   * '__all__' must return an array of objects each exposing .rigidBody
   * and .isDead. Call once, right after Plane.create() resolves. */
  setAiGunEnemyResolver(fn) {
    this._aiGunEnemyResolver = fn ?? null;
  }

  /** True if world position `targetPos` currently falls within gun i's
   * actual firing arc (same frame + optional rear-arc flip used for aiming
   * and firing). Used to keep target ACQUISITION honest — without this,
   * "nearest candidate in range" ignores facing entirely, so a rear
   * (aiGunInverse) gun will happily lock onto and visually swing toward a
   * front target, then just silently fail the fire-cone check — which is
   * exactly what read as "the gun rotates to the front." */
  /** Single source of truth for a gun's hemisphere gate + yaw/pitch decomposition
   * against a world-space target position. Used by BOTH target SELECTION
   * (_isTargetInGunArc / _findAiGunTarget) and the FIRING decision in
   * _updateAiGuns, so the two can never disagree frame-to-frame. */
  _computeGunAimData(i, targetPos, baseQuat) {
    const result = { inArc: false, hemisphereOk: false, yaw: 0, pitch: 0, yawRaw: 0, pitchRaw: 0 };
    const gunNode = this._aiGunNodes[i];
    if (!gunNode) return result;

    gunNode.getWorldPosition(this._aiGunScratchGunPos);
    this._aiGunScratchDir.subVectors(targetPos, this._aiGunScratchGunPos).normalize();

    const _inverseGun = this.cfg.aiGunInverse[i] ?? false;
    this.getForwardVector(this._scratchFwd);
    const _frontDot = this._aiGunScratchDir.dot(this._scratchFwd);

    // ── Hemisphere gate, WITH margin — see AI_GUN_HEMISPHERE_MARGIN above.
    result.hemisphereOk = _inverseGun
      ? _frontDot <= -AI_GUN_HEMISPHERE_MARGIN
      : _frontDot >=  AI_GUN_HEMISPHERE_MARGIN;
    if (!result.hemisphereOk) return result;

    gunNode.parent.getWorldQuaternion(this._aiGunScratchParentQuat);
    this._aiGunScratchParentQuatInv.copy(this._aiGunScratchParentQuat).invert();
    this._aiGunScratchDir.applyQuaternion(this._aiGunScratchParentQuatInv);

    this._aiGunScratchBaseQuatInv.copy(baseQuat).invert();
    this._aiGunScratchDir.applyQuaternion(this._aiGunScratchBaseQuatInv);

    const dx = this._aiGunScratchDir.x;
    const dy = this._aiGunScratchDir.y;
    const dz = this._aiGunScratchDir.z;
    const yawRaw = Math.atan2(dx, -dz);
    const horizLen = Math.sqrt(dx * dx + dz * dz) || 0.0001;
    const pitchRaw = Math.atan2(dy, horizLen);

    const yawLimit   = THREE.MathUtils.degToRad(this.cfg.aiGunYawLimitsDeg[i]   ?? this.cfg.aiGunYawLimitDeg);
    const pitchLimit = THREE.MathUtils.degToRad(this.cfg.aiGunPitchLimitsDeg[i] ?? this.cfg.aiGunPitchLimitDeg);

    result.yawRaw = yawRaw;
    result.pitchRaw = pitchRaw;
    result.yaw = THREE.MathUtils.clamp(yawRaw, -yawLimit, yawLimit);
    result.pitch = THREE.MathUtils.clamp(pitchRaw, -pitchLimit, pitchLimit);
    result.inArc = Math.abs(yawRaw) <= yawLimit && Math.abs(pitchRaw) <= pitchLimit;
    return result;
  }

  /** True if world position `targetPos` currently falls within gun i's
   * actual firing arc. Thin wrapper over _computeGunAimData so selection
   * and firing always agree. */
  _isTargetInGunArc(i, targetPos) {
    // Arc/eligibility check — uses the CORRECTED aim frame (front/rear
    // hemisphere-consistent), not the raw visual base. This only decides
    // yes/no for target selection, never drives the actual gun rotation.
    return this._computeGunAimData(i, targetPos, this._aiGunAimBaseQuats[i]).inArc;
  }
  /** Nearest live candidate within range AND within gun i's firing arc, or
   * null. gunIndex is required now — arc depends on which gun (and
   * whether it's flagged as a rear gun) is searching. */
  _findAiGunTarget(gunIndex, gunWorldPos, maxRangeSq) {
    if (!this._aiGunEnemyResolver) { console.log(`[AI_Gun_${gunIndex}] no enemyResolver set`); return null; }
    const candidates = this._aiGunEnemyResolver('__all__');
    if (!candidates || !candidates.length) { console.log(`[AI_Gun_${gunIndex}] resolver returned 0 candidates`); return null; }

    let best = null;
    let bestDsq = maxRangeSq;
    for (const c of candidates) {
      if (!c || c.isDead || !c.rigidBody) { console.log(`[AI_Gun_${gunIndex}] candidate skipped: dead or no rigidBody`); continue; }
      const p = c.rigidBody.translation();
      const dx = p.x - gunWorldPos.x, dy = p.y - gunWorldPos.y, dz = p.z - gunWorldPos.z;
      const dsq = dx * dx + dy * dy + dz * dz;
      const dist = Math.sqrt(dsq);
      if (dsq >= bestDsq) { console.log(`[AI_Gun_${gunIndex}] candidate out of range: dist=${dist.toFixed(0)} maxRange=${Math.sqrt(maxRangeSq).toFixed(0)}`); continue; }
      this._aiGunScratchTargetPos.set(p.x, p.y, p.z);
      const _inArc = this._isTargetInGunArc(gunIndex, this._aiGunScratchTargetPos);
      console.log(`[AI_Gun_${gunIndex}] candidate dist=${dist.toFixed(0)} inArc=${_inArc}`);
      if (!_inArc) continue;
      bestDsq = dsq; best = c;
    }
    return best;
  }

  /** Aims and fires every AI_Gun_N turret at the nearest in-range enemy
   * tank/plane, every frame, while the plane is alive. Each gun rotates
   * FROM its rest pose (identity + optional 180° inverse, baked in at
   * load time) toward the target, clamped to its own yaw/pitch cone, and
   * only fires once it's actually aimed closely enough — the turret still
   * visually tracks a target sitting past the cone edge, it just holds at
   * the limit and doesn't shoot. */
  _updateAiGuns(dt) {
    if (!this._aiGunNodes || this._aiGunNodes.length === 0) return;

    const rangeSq = this.cfg.aiGunRange * this.cfg.aiGunRange;
    const fireToleranceRad = THREE.MathUtils.degToRad(this.cfg.aiGunFireToleranceDeg);
    const slewT = Math.min(1, THREE.MathUtils.degToRad(this.cfg.aiGunAimSpeedDeg) * dt);

    for (let i = 0; i < this._aiGunNodes.length; i++) {
      const gunNode = this._aiGunNodes[i];
      const sys = this._aiGunSystems[i];
      if (!gunNode || !sys) continue;

      const yawLimit = THREE.MathUtils.degToRad(this.cfg.aiGunYawLimitsDeg[i] ?? this.cfg.aiGunYawLimitDeg);
      const pitchLimit = THREE.MathUtils.degToRad(this.cfg.aiGunPitchLimitsDeg[i] ?? this.cfg.aiGunPitchLimitDeg);

      gunNode.getWorldPosition(this._aiGunScratchGunPos);

      // ── Track reload state BEFORE sys.update(dt) runs — needed to
      // detect the exact frame a reload completes.
      if (!this._aiGunWasReloading) this._aiGunWasReloading = [];
      const _wasReloadingBefore = sys._reloading;

      sys.update(dt); // keep tracers/reload ticking — this is where
                       // MachineGunSystem itself flips _reloading→false
                       // and refills sys.rounds to sys.magSize the
                       // instant the timer completes.

      // ── Auto-reload — MachineGunSystem never starts a reload on its
      // own. Only re-arm if there's still ammo left in the TRUE total
      // pool (_aiGunTotalAmmo[i], which actually depletes below), so a
      // gun with no reserve left goes permanently dry instead of
      // reloading forever.
      if (sys.rounds <= 0 && !sys._reloading && this._aiGunTotalAmmo[i] > 0) {
        sys._reloading = true;
        sys._reloadTimer = sys.fullReloadTime;
      }

      // ── Reload just completed this frame — CONSUME the refill from
      // the gun's true total pool, clamping the magazine down if the
      // pool can't cover a full reload. This is what makes total ammo
      // actually drain across reloads instead of staying fixed.
      if (_wasReloadingBefore && !sys._reloading) {
        const refillAmount = Math.min(sys.rounds, this._aiGunTotalAmmo[i]);
        sys.rounds = refillAmount;
        this._aiGunTotalAmmo[i] -= refillAmount;
      }
      this._aiGunWasReloading[i] = sys._reloading;

      // ── Safety clamp — never let the loaded magazine exceed what's
      // actually left in the pool.
      if (sys.rounds > this._aiGunTotalAmmo[i]) {
        sys.rounds = this._aiGunTotalAmmo[i];
      }

      // ── Re-acquire target on a throttled timer, not every frame ────────
      this._aiGunSearchAccum[i] -= dt;
      if (this._aiGunSearchAccum[i] <= 0) {
        this._aiGunSearchAccum[i] = AI_GUN_TARGET_SEARCH_INTERVAL;
        const current = this._aiGunTargets[i];
        let keepCurrent = false;
        if (current && !current.isDead && current.rigidBody) {
          const p = current.rigidBody.translation();
          const dx = p.x - this._aiGunScratchGunPos.x;
          const dy = p.y - this._aiGunScratchGunPos.y;
          const dz = p.z - this._aiGunScratchGunPos.z;
          const inRange = (dx * dx + dy * dy + dz * dz) <= rangeSq;
          this._aiGunScratchTargetPos.set(p.x, p.y, p.z);
          keepCurrent = inRange && this._isTargetInGunArc(i, this._aiGunScratchTargetPos);
        }
        this._aiGunTargets[i] = keepCurrent
          ? current
          : this._findAiGunTarget(i, this._aiGunScratchGunPos, rangeSq);
      }

      const target = this._aiGunTargets[i];
      if (!target || !target.rigidBody) {
        gunNode.quaternion.slerp(this._aiGunBaseQuats[i], slewT); // no target — ease back to rest
        continue;
      }

      const tp = target.rigidBody.translation();
      this._aiGunScratchTargetPos.set(tp.x, tp.y, tp.z);

      const gate   = this._computeGunAimData(i, this._aiGunScratchTargetPos, this._aiGunAimBaseQuats[i]);
      const visual = this._computeGunAimData(i, this._aiGunScratchTargetPos, this._aiGunBaseQuats[i]);
      const inCone = gate.inArc;
      const yaw   = visual.yaw;
      const pitch = visual.pitch;

      this._aiGunScratchEuler.set(-pitch, yaw, 0, 'YXZ');
      this._aiGunScratchTargetQuat
        .setFromEuler(this._aiGunScratchEuler)
        .premultiply(this._aiGunBaseQuats[i]);

      gunNode.quaternion.slerp(this._aiGunScratchTargetQuat, slewT);

      const aimErrorRad = gunNode.quaternion.angleTo(this._aiGunScratchTargetQuat);
      if (inCone && aimErrorRad <= fireToleranceRad && sys.isReady) {
        sys.fire(this.rigidBody, this._aiGunEnemyResolver, () => {}, this._aiGunScratchTargetPos);
        this.onAiGunFire?.(this._aiGunScratchGunPos.clone());
      }
    }
  }

  // ── Thrust-vectoring nozzles ──────────────────────────────────────────────

  /** Rigid-pivot TVC gimbal — same mechanic as the demo's "Rigid pivot"
   * mode: a single combined axis (blend of the configured pitch/yaw axes,
   * weighted by stick input) tilted by a magnitude-clamped angle, applied
   * as ONE rigid rotation on top of the node's authored rest pose. Because
   * each Nozzle_N's own origin already sits at its hinge point, rotating
   * the whole node IS rotating the rigid aft section about the hinge —
   * no per-vertex geometry split needed like the standalone demo used. */
  _updateNozzleGimbal(dt) {
    if (!this._nozzleNodes || this._nozzleNodes.length === 0) return;

    const maxAngle = THREE.MathUtils.degToRad(this.cfg.nozzleGimbalMaxDeg);
    const slewT = Math.min(1, THREE.MathUtils.degToRad(this.cfg.nozzleGimbalSpeedDeg) * dt);

    const pitchAxisVec = this._csAxisVecFor(this.cfg.nozzlePitchAxis);
    const yawAxisVec   = this._csAxisVecFor(this.cfg.nozzleYawAxis);

    // Same stick input that drives the control surfaces — clamped so a
    // full diagonal input never exceeds the nozzle's mechanical gimbal limit.
    const px = THREE.MathUtils.clamp(this._pitchInput, -1, 1);
    const py = THREE.MathUtils.clamp(this._yawInput,   -1, 1);
    const mag = Math.min(1, Math.hypot(px, py));

    // Which mesh-space axis is "along the nozzle's length" — needed here
    // (not just in the shader) so the follow-transform below can place its
    // pivot at the exact same coordinate the shader bends around.
    const axialAxis = this.cfg.nozzleAxialAxis;

    // Node itself no longer rotates — it stays at its authored rest pose.
    // Only the shader-side bend (applied to the back nozzleGimbalStart..1
    // fraction of the mesh) reflects the deflection now. See
    // _setupNozzleTaperShader's #include <begin_vertex> patch.
    for (let i = 0; i < this._nozzleNodes.length; i++) {
      const node = this._nozzleNodes[i];
      if (!node) continue;

      if (mag > 0.0001) {
        this._nozzleScratchAxis
          .set(0, 0, 0)
          .addScaledVector(pitchAxisVec, px)
          .addScaledVector(yawAxisVec, py)
          .normalize();
        this._nozzleScratchDeltaQ.setFromAxisAngle(this._nozzleScratchAxis, mag * maxAngle);
      } else {
        this._nozzleScratchDeltaQ.identity();
      }

      // Slew toward the target deflection the same way as before, but the
      // slerped quaternion is now only used to DERIVE an axis+angle pushed
      // into the shader, not applied to node.quaternion directly.
      this._nozzleScratchTargetQ.copy(this._nozzleScratchDeltaQ);
      this._nozzleCurrentQuat[i].slerp(this._nozzleScratchTargetQ, slewT);

      // Decompose the slewed quaternion back to axis+angle for the shader.
      const q = this._nozzleCurrentQuat[i];
      const angle = 2 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
      const s = Math.sqrt(1 - q.w * q.w);
      if (s < 0.0001) {
        this._nozzleScratchAxis.set(0, 1, 0);
      } else {
        this._nozzleScratchAxis.set(q.x / s, q.y / s, q.z / s);
      }

      // ── NEW: drag Jet_Propulsion_N (if parented under this nozzle)
      // along with the same bend the shader is about to apply below.
      this._updatePropulsionFollowGimbal(i, q, axialAxis);

      const mats = this._nozzleTaperMaterials[i];
      if (!mats) continue;
      for (const mat of mats) {
        const shader = mat.userData?.nozzleTaperShader;
        if (!shader) continue; // hasn't finished compiling yet
        shader.uniforms.uNozzleGimbalAxis.value.copy(this._nozzleScratchAxis);
        shader.uniforms.uNozzleGimbalAngle.value = angle;
      }
    }
  }

  /**
   * Nozzle_N's own transform never changes (the gimbal bend is a
   * shader-only vertex deformation on the mesh's exit end — see the "Node
   * itself no longer rotates" note in _updateNozzleGimbal above). That
   * means anything actually PARENTED to a Nozzle_N node in the scene
   * graph — currently just Jet_Propulsion_N — sits at the node's static
   * rest transform and never visually follows the bend, even though the
   * flame is supposed to come out of the moving exit.
   *
   * This reproduces the exact same rotation the shader applies to the
   * mesh's exit-end vertices — rotate by `q` about the pivot point where
   * the bend hinges, `mix(axialMin, axialMax, nozzleGimbalStart)` along
   * nozzleAxialAxis, in the Nozzle_N node's own local space — and applies
   * it directly to Jet_Propulsion_N's local position/orientation instead.
   *
   * Note this applies the FULL bend angle as a hard hinge rather than the
   * shader's smoothstep ramp — a good approximation as long as
   * Jet_Propulsion_N sits at/beyond the nozzle's physical exit, past where
   * the shader's own ramp has already reached ~1.0.
   */
  _updatePropulsionFollowGimbal(nozzleIndex, q, axialAxis) {
    if (!this._propulsionNodes || this._propulsionNodes.length === 0) return;

    const axialMin = this._nozzleAxialMin[nozzleIndex];
    const axialMax = this._nozzleAxialMax[nozzleIndex];
    if (axialMin === undefined || axialMax === undefined) return; // taper geometry never resolved for this nozzle

    const gAxial = THREE.MathUtils.lerp(axialMin, axialMax, this.cfg.nozzleGimbalStart);
    this._nozzlePivotVec.set(0, 0, 0);
    this._nozzlePivotVec[axialAxis] = gAxial;

    for (let j = 0; j < this._propulsionNodes.length; j++) {
      if (this._propulsionNozzleIndex[j] !== nozzleIndex) continue;
      const propNode = this._propulsionNodes[j];
      if (!propNode) continue;

      // rotated = pivot + q · (basePos - pivot) — identical math to the
      // shader's Rodrigues rotation, just applied to one point instead of
      // every vertex.
      this._propulsionScratchPos
        .copy(this._propulsionBaseLocalPos[j])
        .sub(this._nozzlePivotVec)
        .applyQuaternion(q)
        .add(this._nozzlePivotVec);
      propNode.position.copy(this._propulsionScratchPos);

      propNode.quaternion.copy(q).multiply(this._propulsionBaseLocalQuat[j]);
    }
  }

    /**
   * Patches every material on nozzleNode's mesh descendants so the exit-area
   * "breathing" only affects the last (1 - cfg.nozzleTaperStart) fraction of
   * the mesh's length — the EXIT/open end of the nozzle cone/cylinder —
   * while the FIXED (attached) end never moves. A rigid Object3D.scale
   * can't do this (it moves the whole mesh, including the base attachment
   * point), so this deforms vertices directly in the vertex shader instead.
   */
  _setupNozzleTaperShader(nozzleNode, idx) {
    const axialAxis = this.cfg.nozzleAxialAxis; // 'x' | 'y' | 'z'
    const axisIndex = axialAxis === 'x' ? 0 : axialAxis === 'y' ? 1 : 2;

    let axialMin = Infinity, axialMax = -Infinity;
    const meshes = [];
    nozzleNode.traverse((child) => {
      if (!child.isMesh) return;
      meshes.push(child);
      child.geometry.computeBoundingBox();
      const bbox = child.geometry.boundingBox;
      const lo = axisIndex === 0 ? bbox.min.x : axisIndex === 1 ? bbox.min.y : bbox.min.z;
      const hi = axisIndex === 0 ? bbox.max.x : axisIndex === 1 ? bbox.max.y : bbox.max.z;
      axialMin = Math.min(axialMin, lo);
      axialMax = Math.max(axialMax, hi);
    });

    // Cache the resolved extents regardless of whether the taper material
    // patch below succeeds — _updatePropulsionFollowGimbal() needs these
    // to place Jet_Propulsion_N at the bent exit, independent of whether
    // this particular nozzle has taper-capable geometry.
    if (meshes.length > 0 && axialMax > axialMin) {
      this._nozzleAxialMin[idx] = axialMin;
      this._nozzleAxialMax[idx] = axialMax;
    }

    if (meshes.length === 0 || axialMax <= axialMin) {
      console.warn(`[Plane] Nozzle_${idx + 1}: couldn't resolve mesh geometry for exit-area taper — skipping`);
      this._nozzleTaperMaterials.push([]);
      return;
    }

    const patchedMats = [];
    for (const mesh of meshes) {
      // ── Clone this mesh's material(s) BEFORE patching, so the shader
      // edit below only ever affects this nozzle mesh's own material
      // instance. Without this, a material shared with the fuselage (or
      // any other part of the model — very common in optimized GLBs)
      // gets its onBeforeCompile patched globally, so every mesh using
      // that shared material runs the nozzle-taper math against ITS OWN
      // vertex positions — which is what made the whole plane shrink.
      const isMulti = Array.isArray(mesh.material);
      const sourceMats = isMulti ? mesh.material : [mesh.material];
      const clonedMats = sourceMats.map((m) => {
        if (!m) return m;
        const clone = m.clone();
        clone.userData = { ...(m.userData || {}) };

        // ── CRITICAL: without a unique cache key, Three.js's WebGLPrograms
        // cache sees this clone as shader-identical to the original shared
        // material (default customProgramCacheKey() returns '' for every
        // material of the same type/params) and silently REUSES the
        // already-compiled program — meaning our onBeforeCompile edits
        // below get compiled once but then never actually applied to this
        // mesh's draw calls. A unique key per nozzle index forces a fresh,
        // separate compiled program for this clone.
        const _cacheKeySuffix = `__nozzleTaper_${idx}_${clone.uuid}`;
        clone.customProgramCacheKey = () => _cacheKeySuffix;

        return clone;
      });
      mesh.material = isMulti ? clonedMats : clonedMats[0];

      const mats = clonedMats;
      for (const mat of mats) {
        if (!mat || mat.userData?.__nozzleTaperPatched) continue;
        mat.userData = mat.userData || {};
        mat.userData.__nozzleTaperPatched = true;

        // ── Chain rather than overwrite — _applyDamageShaderToModel() runs
        // AFTER this and patches onBeforeCompile again for damage stripping.
        // A plain assignment there would silently discard this taper patch.
        const _prevOnBeforeCompile = mat.onBeforeCompile;

        mat.onBeforeCompile = (shader) => {
          _prevOnBeforeCompile?.(shader);

          Object.assign(shader.uniforms, {
            uNozzleAxialMin:   { value: axialMin },
            uNozzleAxialMax:   { value: axialMax },
            uNozzleTaperStart: { value: this.cfg.nozzleTaperStart },
            uNozzleExitAtMax:  { value: this.cfg.nozzleExitAtAxialMax ? 1.0 : 0.0 },
            uNozzleAreaScale:  { value: 1.0 }, // pushed live every frame from _updateNozzleArea
            uNozzleGimbalStart:{ value: this.cfg.nozzleGimbalStart },
            uNozzleGimbalAxis: { value: new THREE.Vector3(0, 1, 0) }, // pushed live from _updateNozzleGimbal
            uNozzleGimbalAngle:{ value: 0.0 }, // pushed live from _updateNozzleGimbal
          });

          // GLSL needs these declared in the source text itself — Object.assign
          // above only registers the JS-side values.
          shader.vertexShader =
            'uniform float uNozzleAxialMin;\n' +
            'uniform float uNozzleAxialMax;\n' +
            'uniform float uNozzleTaperStart;\n' +
            'uniform float uNozzleExitAtMax;\n' +
            'uniform float uNozzleAreaScale;\n' +
            'uniform float uNozzleGimbalStart;\n' +
            'uniform vec3  uNozzleGimbalAxis;\n' +
            'uniform float uNozzleGimbalAngle;\n' +
            shader.vertexShader;

          shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            {
              // 0 at the FIXED end, 1 at the EXIT end (flipped if uNozzleExitAtMax=0)
              float _nAxial = position.${axialAxis};
              float _nT = (_nAxial - uNozzleAxialMin) / max(0.0001, (uNozzleAxialMax - uNozzleAxialMin));
              if (uNozzleExitAtMax < 0.5) _nT = 1.0 - _nT;

              // Only the last (1 - uNozzleTaperStart) fraction (the exit end)
              // is affected — smoothly ramped so there's no hard crease.
              float _nTaper = smoothstep(uNozzleTaperStart, 1.0, _nT);
              float _nRadialScale = mix(1.0, uNozzleAreaScale, _nTaper);

              // Scale only the two RADIAL axes — the axial coordinate (and
              // therefore the nozzle's length) is left untouched.
              ${axialAxis !== 'x' ? 'transformed.x *= _nRadialScale;' : ''}
              ${axialAxis !== 'y' ? 'transformed.y *= _nRadialScale;' : ''}
              ${axialAxis !== 'z' ? 'transformed.z *= _nRadialScale;' : ''}

              // ── Gimbal bend — only the last (1 - uNozzleGimbalStart)
              // fraction (the exit end) physically rotates; the attached
              // front half stays put. Pivot is the split point itself, so
              // the bend hinges exactly where the rigid/flexible sections meet.
              float _nGimbal = smoothstep(uNozzleGimbalStart, 1.0, _nT);
              if (_nGimbal > 0.0001 && abs(uNozzleGimbalAngle) > 0.0001) {
                float _gAxial = mix(uNozzleAxialMin, uNozzleAxialMax, uNozzleGimbalStart);
                vec3 _pivot = vec3(0.0);
                if (${axisIndex} == 0) _pivot.x = _gAxial;
                else if (${axisIndex} == 1) _pivot.y = _gAxial;
                else _pivot.z = _gAxial;

                float _ang = uNozzleGimbalAngle * _nGimbal;
                float _s = sin(_ang);
                float _c = cos(_ang);
                vec3 _local = transformed - _pivot;
                vec3 _axis = normalize(uNozzleGimbalAxis);
                // Rodrigues' rotation formula
                vec3 _rotated = _local * _c
                  + cross(_axis, _local) * _s
                  + _axis * dot(_axis, _local) * (1.0 - _c);
                transformed = _rotated + _pivot;
              }
            }
            `
          );

          mat.userData.nozzleTaperShader = shader;
        };

        mat.needsUpdate = true;
        patchedMats.push(mat);
      }
    }

    this._nozzleTaperMaterials.push(patchedMats);
  }

    /** Cosmetic exit-area "breathing" — radial (non-axial) scale on each
   * Nozzle_N node, eased toward a throttle-derived target every frame.
   * Only the two radial axes are scaled; the axial (length) axis is left
   * at its authored value so the nozzle doesn't stretch/shrink lengthwise. */
  _updateNozzleArea(dt) {
    if (!this._nozzleNodes || this._nozzleNodes.length === 0) return;

    const targetScale = THREE.MathUtils.lerp(
      this.cfg.nozzleAreaMinScale,
      this.cfg.nozzleAreaMaxScale,
      THREE.MathUtils.clamp(this.throttle, 0, 1)
    );
    const t = Math.min(1, dt * this.cfg.nozzleAreaSpeed);

    for (let i = 0; i < this._nozzleNodes.length; i++) {
      if (!this._nozzleNodes[i]) continue;

      this._nozzleAreaScale[i] = THREE.MathUtils.lerp(this._nozzleAreaScale[i], targetScale, t);
      const s = this._nozzleAreaScale[i];

      // node.scale is no longer touched — the taper shader
      // (_setupNozzleTaperShader) applies this scale ONLY to the exit-end
      // vertices, per-frame, via the uNozzleAreaScale uniform below.
      const mats = this._nozzleTaperMaterials[i];
      if (!mats) continue;
      for (const mat of mats) {
        const shader = mat.userData?.nozzleTaperShader;
        if (!shader) continue; // hasn't finished compiling yet
        shader.uniforms.uNozzleAreaScale.value = s;
      }
    }
  }

  // ── Shader-based damage stripping ─────────────────────────────────────────

  /** Patches one material's fragment shader to discard fragments beyond a
   * jagged (zigzag) cutoff plane. Cheap: a handful of dot products + fract()
   * ops, no textures, no new geometry. Idempotent — safe to call on a
   * material more than once. */
  _setupDamageShaderMaterial(material) {
    if (!material || material.userData?.__damagePatched) return;
    material.userData = material.userData || {};
    material.userData.__damagePatched = true;

    // ── Chain rather than overwrite — a material may already carry an
    // onBeforeCompile from _setupNozzleTaperShader (nozzle meshes are
    // patched for taper BEFORE this damage pass runs over the whole
    // model). A plain assignment here would discard that earlier patch.
    const _prevOnBeforeCompile = material.onBeforeCompile;

    material.onBeforeCompile = (shader) => {
      _prevOnBeforeCompile?.(shader);
      Object.assign(shader.uniforms, {
        uDamageOrigin:     { value: new THREE.Vector3() },
        uDamageAft:        { value: new THREE.Vector3(0, 0, 1) },
        uDamageRight:      { value: new THREE.Vector3(1, 0, 0) },
        uDamageUp:         { value: new THREE.Vector3(0, 1, 0) },
        uDamageCutoff:     { value: 9999 },   // huge = nothing stripped yet (fuselage, nose→tail)
        uDamageWingCutoff: { value: 9999 },   // huge = nothing stripped yet (wings, both tips inward) — NEW
        uDamageJagAmp:     { value: this.cfg.damageEffect.jagAmplitude },
        uDamageJagFreq:    { value: this.cfg.damageEffect.jagFrequency },
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
      'uniform float uDamageWingCutoff;\n' +   // NEW
      'uniform float uDamageJagAmp;\n' +
      'uniform float uDamageJagFreq;\n' +
      shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
  'void main() {',
  `void main() {
    {
      // Cheap zigzag battle-damage cutoff — three summed triangle waves
      // (different axes/frequencies) give a torn-metal silhouette instead
      // of a clean cut, with zero extra geometry.
      vec3 dOff = vDamageWorldPos - uDamageOrigin;
      float aftDist    = dot(dOff, uDamageAft);
      float rightCoord = dot(dOff, uDamageRight);
      float upCoord    = dot(dOff, uDamageUp);

      // Fuselage jag — boundary line lies in the right/up plane (cut runs
      // nose→tail), so the zigzag varies along right + up.
      float z1 = abs(fract(rightCoord * uDamageJagFreq) - 0.5) * 4.0 - 1.0;
      float z2 = abs(fract(upCoord * uDamageJagFreq * 1.7 + 0.31) - 0.5) * 4.0 - 1.0;
      float z3 = abs(fract((rightCoord + upCoord) * uDamageJagFreq * 2.9 + 0.62) - 0.5) * 4.0 - 1.0;
      float jag = (z1 * 0.5 + z2 * 0.3 + z3 * 0.2) * uDamageJagAmp;
      if (aftDist > uDamageCutoff + jag) discard;

      // NEW — Wing jag, rotated 90° relative to the fuselage jag. The wing
      // cut's boundary line lies in the aft/up plane (cut runs wingtip→
      // center, i.e. along "right"), so the zigzag must vary along aft +
      // up instead of right + up — otherwise the torn edge would run the
      // wrong direction relative to the cut.
      float w1 = abs(fract(aftDist * uDamageJagFreq) - 0.5) * 4.0 - 1.0;
      float w2 = abs(fract(upCoord * uDamageJagFreq * 1.7 + 0.31) - 0.5) * 4.0 - 1.0;
      float w3 = abs(fract((aftDist + upCoord) * uDamageJagFreq * 2.9 + 0.62) - 0.5) * 4.0 - 1.0;
      float jagWing = (w1 * 0.5 + w2 * 0.3 + w3 * 0.2) * uDamageJagAmp;

      // Wing stripping — eats inward from BOTH wingtips symmetrically.
      // rightCoord > 0 = toward the right wingtip, < 0 = toward the left.
      float rightWingDist = rightCoord;    // distance toward the right tip
      float leftWingDist  = -rightCoord;   // distance toward the left tip
      if (rightWingDist > uDamageWingCutoff + jagWing) discard;
      if (leftWingDist  > uDamageWingCutoff + jagWing) discard;
    }
`
);

      material.userData.damageShader = shader; // so we can push uniform updates later
    };

    material.needsUpdate = true;
  }

  /** Walks the freshly loaded GLB and patches every material it finds. */
  _applyDamageShaderToModel(model) {
    if (!this.cfg.damageEffect.enabled) return;
    this._damageShaderMaterials = [];

    model.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        this._setupDamageShaderMaterial(mat);
        this._damageShaderMaterials.push(mat);
      }
    });
  }

  /** Writes the given cutoff/wingCutoff values, plus the plane's live world
   * position/orientation, into every patched material's uniforms. Shared by
   * the alive (health-driven) path and the one-shot push in _die(). */
  _pushDamageShaderUniforms(cutoff, wingCutoff) {
    if (!this._damageShaderMaterials?.length || !this.bodyGroup) return;

    this.bodyGroup.getWorldPosition(this._scratchDamageOrigin);
    this._scratchDamageAft.set(1, 0, 0).applyQuaternion(this.bodyGroup.quaternion);    // nose → tail
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

  /** Pushes the current health-derived cutoff into every patched material's
   * uniforms. Cheap — a few vector ops, no allocations. */
  _updateDamageShaderUniforms() {
    const cfg = this.cfg.damageEffect;
    const healthFrac = this.maxHealth > 0 ? this.health / this.maxHealth : 1;

    let cutoff = 9999; // default: whole plane intact
    let wingCutoff = 9999; // default: both wings intact
    if (healthFrac < cfg.healthTriggerFraction) {
      const t = 1 - (healthFrac / cfg.healthTriggerFraction); // 0 at trigger → 1 at zero hp
      const remainingFrac = THREE.MathUtils.lerp(1, cfg.minRemainingFraction, t);
      cutoff = remainingFrac * cfg.maxCutbackLength;
      wingCutoff = remainingFrac * cfg.wingCutbackLength; // same health curve, wing-scaled
    }

    this._pushDamageShaderUniforms(cutoff, wingCutoff);
  }

  // ── Wingtip vortices ──────────────────────────────────────────────────────

  _buildWingtipVortexMeshes() {
    const N = this._VORTEX_TRAIL_LENGTH;

    for (let w = 0; w < 2; w++) {
      // 2 verts per trail point (left/right edge of ribbon) → (N-1) quads
      const vertCount = N * 2;
      const positions = new Float32Array(vertCount * 3);
      const colors    = new Float32Array(vertCount * 4); // rgba per vertex

      const indices = [];
      for (let i = 0; i < N - 1; i++) {
        const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
        indices.push(a, b, c,  b, d, c);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(colors, 4));
      geo.setIndex(indices);
      // Trail is world-positioned directly into the buffer each update —
      // recompute bounds only occasionally, not every frame (cheap insurance
      // against frustum-culling pop; see _updateWingtipVortices).
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
      geo.frustumCulled = true;

      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        vertexColors: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        fog: false,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 4; // draw before smoke/explosions (5), after opaque geometry
      mesh.frustumCulled = true;
      mesh.visible = false; // hidden until first samples fill the trail
      this.scene.add(mesh);

      this._vortexMeshes[w] = mesh;

      const ring = new Array(N);
      for (let i = 0; i < N; i++) ring[i] = new THREE.Vector3();

      this._vortexBuffers[w] = {
        positions, colors, ring,
        head: 0,     // index of the NEWEST sample
        count: 0,    // how many samples have been written so far (ramps up to N)
      };
    }
  }

  /** Pushes one new world-space sample into wingtip w's ring buffer. */
  _pushVortexSample(w) {
    const node = this._wingtipNodes[w];
    const buf  = this._vortexBuffers[w];
    if (!node || !buf) return;

    buf.head = (buf.head + 1) % this._VORTEX_TRAIL_LENGTH;
    node.getWorldPosition(buf.ring[buf.head]);
    if (buf.count < this._VORTEX_TRAIL_LENGTH) buf.count++;
  }

  /**
   * Computes a 0..1 vortex strength from speed, angle-of-attack, and a
   * G-force proxy (rate of change of velocity direction × speed). Cheap —
   * a handful of dot products and no allocations.
   */
  _computeVortexIntensity(dt) {
    if (!this.rigidBody || this.isStalled) return 0;

    const vel = this.rigidBody.linvel();
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    if (speed < 0.5) return 0;

    // ── Speed factor — ramps in between stall speed and cruise speed,
    // full strength at/above cruise. No airflow, no vortex.
    const speedFactor = THREE.MathUtils.smoothstep(
      this.airspeed, this.cfg.stallSpeed, this.cfg.cruiseSpeed
    );
    if (speedFactor <= 0) return 0;

    const velDir = this._scratchVortexDir.set(vel.x, vel.y, vel.z).divideScalar(speed);

    // ── Angle of attack proxy — angle between velocity direction and the
    // plane's nose direction. Level cruise flight ≈ 0; climbing/diving
    // steeply or slipping sideways raises it.
    this.getForwardVector(this._scratchFwd);
    const aoaDot = THREE.MathUtils.clamp(velDir.dot(this._scratchFwd), -1, 1);
    const aoaRad = Math.acos(aoaDot);
    const AOA_FULL_STRENGTH_RAD = THREE.MathUtils.degToRad(12); // tune to taste
    const aoaFactor = THREE.MathUtils.clamp(aoaRad / AOA_FULL_STRENGTH_RAD, 0, 1);

    // ── G-force proxy — how fast the velocity DIRECTION is changing,
    // scaled by speed (a tight high-speed turn changes direction fast AND
    // loads the wing hard; a slow gentle turn barely registers).
    let gForceFactor = 0;
    if (this._scratchVelDirPrevValid && dt > 0.0001) {
      const dot = THREE.MathUtils.clamp(velDir.dot(this._scratchVelDirPrev), -1, 1);
      const turnRateRad = Math.acos(dot) / dt; // rad/sec
      const G_TURN_RATE_FULL_STRENGTH = 1.1;   // rad/sec — tune to taste
      gForceFactor = THREE.MathUtils.clamp(turnRateRad / G_TURN_RATE_FULL_STRENGTH, 0, 1)
                   * THREE.MathUtils.clamp(speed / this.cfg.cruiseSpeed, 0, 1);
    }
    this._scratchVelDirPrev.copy(velDir);
    this._scratchVelDirPrevValid = true;

    const combined = Math.max(aoaFactor, gForceFactor); // either condition alone can trigger it
    return THREE.MathUtils.clamp(combined, 0, 1) * speedFactor;
  }

  /** Rebuilds the live GPU buffers for both ribbons from their ring buffers. */
  _uploadVortexGeometry(w) {
    const mesh = this._vortexMeshes[w];
    const buf  = this._vortexBuffers[w];
    if (!mesh || !buf) return;

    const N = this._VORTEX_TRAIL_LENGTH;
    if (buf.count < 2) { mesh.visible = false; return; }

    const posAttr = mesh.geometry.attributes.position;
    const colAttr = mesh.geometry.attributes.color;
    const positions = buf.positions;
    const colors    = buf.colors;

    // Walk from newest (head) to oldest, oldest samples fade to alpha 0.
    for (let i = 0; i < buf.count; i++) {
      const ringIdx = (buf.head - i + N) % N;
      const p = buf.ring[ringIdx];

      // Local ribbon direction — toward the next-older sample (or itself
      // for the newest point, using velocity as a fallback direction).
      const olderIdx = (buf.head - Math.min(i + 1, buf.count - 1) + N) % N;
      const older = buf.ring[olderIdx];

      this._scratchVortexDir.subVectors(p, older);
      if (this._scratchVortexDir.lengthSq() < 1e-8) this._scratchVortexDir.set(0, 0, 1);
      this._scratchVortexDir.normalize();

      // Ribbon lies in the plane perpendicular to world-up and the streak
      // direction — reads as a physical trailing streak rather than a
      // camera billboard, at zero extra per-frame camera lookups.
      // ── Cloudy jitter — cheap deterministic pseudo-noise seeded by the
      // ring slot index, so each point's wobble stays stable frame-to-frame
      // (no shimmer) instead of re-randomizing every upload.
      const tailFade = 1 - (i / Math.max(1, buf.count - 1));
      const noiseSeed = ringIdx * 12.9898 + w * 78.233;
      const noiseA = Math.abs(Math.sin(noiseSeed * 43758.5453) % 1);
      const noiseB = Math.abs(Math.sin((noiseSeed + 4.21) * 91340.7831) % 1);

      const widthJitter = 0.85 + noiseA * 0.3;  // 0.85x .. 1.15x width variance — light puff
      const alphaJitter = 0.8 + noiseB * 0.4;   // 0.8x .. 1.2x alpha variance — mild patchiness

      this._scratchVortexRight
        .crossVectors(this._scratchVortexDir, this._scratchUp.set(0, 1, 0))
        .normalize()
        .multiplyScalar(this._vortexWidth * widthJitter);
      if (this._scratchVortexRight.lengthSq() < 1e-8) {
        this._scratchVortexRight.set(this._vortexWidth * widthJitter, 0, 0);
      }

      // ── Positional wander — the whole cross-section drifts slightly off
      // its clean trail path, growing toward the tail (older = more diffuse,
      // like real turbulent wake dispersing). Applied along world-up so it
      // reads as vertical puffiness rather than shifting the streak sideways.
      const wanderMag = (noiseA - 0.5) * 0.03 * tailFade;
      this._scratchVortexWander.set(0, wanderMag, 0);

      const vA = i * 2, vB = i * 2 + 1;
      positions[vA * 3]     = p.x - this._scratchVortexRight.x + this._scratchVortexWander.x;
      positions[vA * 3 + 1] = p.y - this._scratchVortexRight.y + this._scratchVortexWander.y;
      positions[vA * 3 + 2] = p.z - this._scratchVortexRight.z + this._scratchVortexWander.z;
      positions[vB * 3]     = p.x + this._scratchVortexRight.x + this._scratchVortexWander.x;
      positions[vB * 3 + 1] = p.y + this._scratchVortexRight.y + this._scratchVortexWander.y;
      positions[vB * 3 + 2] = p.z + this._scratchVortexRight.z + this._scratchVortexWander.z;

      // Fade to the tail, modulated by overall intensity and the per-point
      // alpha jitter. Smoke-white, low peak alpha so it reads as patchy
      // translucent wisps rather than a smooth solid taper.
      const alpha = tailFade * tailFade * this._vortexIntensity * 0.75 * alphaJitter;
      colors[vA * 4] = colors[vB * 4] = 1;
      colors[vA * 4 + 1] = colors[vB * 4 + 1] = 1;
      colors[vA * 4 + 2] = colors[vB * 4 + 2] = 1;
      colors[vA * 4 + 3] = colors[vB * 4 + 3] = alpha;
    }

    // Degenerate/zero out any unused tail verts so they don't draw stale
    // geometry from a previous longer trail (only matters right after
    // buf.count first ramps up from 0).
    for (let i = buf.count; i < N; i++) {
      const vA = i * 2, vB = i * 2 + 1;
      colors[vA * 4 + 3] = colors[vB * 4 + 3] = 0;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate  = true;
    mesh.visible = this._vortexIntensity > 0.01;
  }

  _updateWingtipVortices(dt) {
    if (!this._vortexMeshes[0] && !this._vortexMeshes[1]) return; // GLB had no wingtip nodes

    const targetIntensity = this._computeVortexIntensity(dt);
    // Fast-ish attack, slower release — reads as a natural puff-in / fade-out
    const rate = targetIntensity > this._vortexIntensity ? 6 : 2.2;
    this._vortexIntensity += (targetIntensity - this._vortexIntensity) * Math.min(1, dt * rate);
    if (this._vortexIntensity < 0.005) this._vortexIntensity = 0;

    // Sample throttling — decouples trail resolution from render framerate,
    // and skips all the per-sample math entirely when intensity is ~0.
    this._vortexSampleAccum += dt;
    const shouldSample = this._vortexIntensity > 0 || this._vortexSampleAccum >= this._VORTEX_SAMPLE_INTERVAL;
    if (this._vortexSampleAccum >= this._VORTEX_SAMPLE_INTERVAL) {
      this._vortexSampleAccum = 0;
      if (this._vortexIntensity > 0) {
        this._pushVortexSample(0);
        this._pushVortexSample(1);
      } else {
        // Not producing vortex right now — let existing trail points age
        // out naturally next time it triggers, by resetting so a re-trigger
        // starts a fresh clean streak instead of jumping across a gap.
        this._vortexBuffers[0].count = 0;
        this._vortexBuffers[1].count = 0;
      }
    }

    this._uploadVortexGeometry(0);
    this._uploadVortexGeometry(1);
  }

  _disposeWingtipVortices() {
    for (let w = 0; w < 2; w++) {
      const mesh = this._vortexMeshes[w];
      if (mesh) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      this._vortexMeshes[w]  = null;
      this._vortexBuffers[w] = null;
      this._wingtipNodes[w]  = null;
    }
  }

  // ── Afterburner flame mesh (replaces the old particle-based flame) ──────

  /** Lazily builds + caches the shared afterburner geometry — identical
   * triangle data reused by every rig on every plane. */
  static _getAfterburnerGeometry() {
    if (Plane._sharedAfterburnerGeo) return Plane._sharedAfterburnerGeo;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(AFTERBURNER_POSITIONS, 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(AFTERBURNER_NORMALS, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(AFTERBURNER_UVS, 2));
    geo.setIndex(new THREE.BufferAttribute(AFTERBURNER_INDICES, 1));
    Plane._sharedAfterburnerGeo = geo;
    return geo;
  }

  /** Lazily builds + caches the afterburner texture per propulsionType —
   * one network fetch per type, reused by every rig/plane using that type. */
  static _getAfterburnerTexture(type) {
    Plane._sharedAfterburnerTex = Plane._sharedAfterburnerTex || {};
    if (Plane._sharedAfterburnerTex[type]) return Plane._sharedAfterburnerTex[type];

    const url = AFTERBURNER_TEXTURE_URLS[type] ?? AFTERBURNER_TEXTURE_URLS.blue;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const tex = loader.load(
      url,
      (t) => {
        t.encoding = THREE.sRGBEncoding; // rename to t.colorSpace = THREE.SRGBColorSpace on r152+
        t.wrapS = THREE.ClampToEdgeWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        console.log(`[Plane] afterburner texture LOADED ok (${type}):`, t.image.width, 'x', t.image.height, url);
      },
      undefined,
      (err) => {
        console.error(`[Plane] afterburner texture FAILED TO LOAD (${type}):`, url, err);
      }
    );
    Plane._sharedAfterburnerTex[type] = tex;
    return tex;
  }

  /** Lazily builds + caches one material per propulsionType ('blue' | 'red').
   * MeshBasicMaterial is UNLIT — no scene light/ambient touches it, so the
   * texture's own RGB renders exactly as authored, with zero color mixing
   * from the material itself. This is what actually fixes the "always
   * shows white" problem: MeshStandardMaterial's lit color+emissive
   * channels were being washed out by scene lighting; this bypasses that
   * entirely. Individual rigs clone this so opacity can animate per engine
   * without affecting other planes sharing the same base material. */
  static _getAfterburnerMaterial(type) {
    Plane._sharedAfterburnerMats = Plane._sharedAfterburnerMats || {};
    if (Plane._sharedAfterburnerMats[type]) return Plane._sharedAfterburnerMats[type];

    const tex = Plane._getAfterburnerTexture(type);
    const AFTERBURNER_COLORS = { blue: 0x2f7dff, red: 0xff7017 };
    const tintColor = AFTERBURNER_COLORS[type] ?? AFTERBURNER_COLORS.blue;
    const mat = new THREE.MeshBasicMaterial({
      color: tintColor,     // tints the (now-shared) texture per propulsionType
      map: tex,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending, // matches the reference demo — THIS is what
      // actually produces the glow: bright texture areas (the shock-diamond core)
      // bloom/add together instead of flatly alpha-compositing into a dull, faded blob.
      toneMapped: false, // bypass the renderer's tone-mapping curve (ACES/etc.) so the
      // flame keeps its raw brightness/color instead of being compressed and
      // desaturated into gray — this was the main cause of the "fading, no glow" look.
    });
    Plane._sharedAfterburnerMats[type] = mat;
    return mat;
  }

  /** Builds one afterburner rig, parented directly under the given
   * Jet_Propulsion_N node so it automatically inherits that node's world
   * position/orientation — only the LOCAL pulse/twist/vibration transform
   * needs to be driven per-frame in _updatePropulsion(). */
  _buildAfterburnerRig(node) {
    const geo = Plane._getAfterburnerGeometry();
    const mat = Plane._getAfterburnerMaterial(this.cfg.propulsionType).clone();

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5; // same layer the old flame particles used
    mesh.quaternion.copy(AFTERBURNER_ALIGN_QUAT);
    mesh.scale.copy(AFTERBURNER_BASE_SCALE).multiplyScalar(this.cfg.propulsionScale);

    // Vibration wrapper — jitter is applied to this group's local
    // position/rotation each frame, never to the mesh's own quaternion,
    // so it doesn't fight with the twist animation below.
    const group = new THREE.Group();
    group.add(mesh);
    node.add(group);

    return {
      group, mesh, material: mat,
      baseScaleX: AFTERBURNER_BASE_SCALE.x,
      twistQuat: new THREE.Quaternion(),
    };
  }

  /** Updates every jet-propulsion rig's flame mesh (pulse/flicker length,
   * tail twist, engine-vibration jitter) for this frame, all scaled by a
   * throttle-derived intensity so idle looks like a faint, steady flame
   * and full throttle looks like a long, roaring one. */
  _updatePropulsion(dt, elapsed) {
    if (!this.cfg.propulsion || this._propulsionNodes.length === 0) return;

    const PROPULSION_MIN_INTENSITY = 0.18; // idle flame floor (0..1)
    const throttleT = THREE.MathUtils.clamp(this.throttle ?? 0, 0, 1);
    const propIntensity = PROPULSION_MIN_INTENSITY + (1 - PROPULSION_MIN_INTENSITY) * throttleT;

    for (let n = 0; n < this._propulsionRigs.length; n++) {
      const rig = this._propulsionRigs[n];
      if (!rig) continue;
      const { mesh, group, material } = rig;

      const lengthScale = 0.5 + 0.5 * propIntensity; // shorter flame near idle
      mesh.scale.x = rig.baseScaleX * this.cfg.propulsionScale * lengthScale;

      const twistAngle = Math.sin(elapsed * AFTERBURNER_TWIST_SPEED) * AFTERBURNER_TWIST_AMOUNT;
      rig.twistQuat.setFromAxisAngle(AFTERBURNER_TWIST_AXIS, twistAngle);
      mesh.quaternion.copy(AFTERBURNER_ALIGN_QUAT).multiply(rig.twistQuat);

      group.position.set(
        _afterburnerVibeNoise(elapsed, AFTERBURNER_VIBE_FREQ[0], 0.0) * AFTERBURNER_VIBE_POS_AMOUNT * propIntensity,
        _afterburnerVibeNoise(elapsed, AFTERBURNER_VIBE_FREQ[1], 1.7) * AFTERBURNER_VIBE_POS_AMOUNT * propIntensity,
        _afterburnerVibeNoise(elapsed, AFTERBURNER_VIBE_FREQ[2], 3.1) * AFTERBURNER_VIBE_POS_AMOUNT * propIntensity,
      );
      group.rotation.x = _afterburnerVibeNoise(elapsed, AFTERBURNER_VIBE_FREQ[1], 0.9) * AFTERBURNER_VIBE_ROT_AMOUNT * propIntensity;
      group.rotation.z = _afterburnerVibeNoise(elapsed, AFTERBURNER_VIBE_FREQ[2], 2.4) * AFTERBURNER_VIBE_ROT_AMOUNT * propIntensity;

      material.opacity = propIntensity;
    }
  }

  /** The old particle system exposed shockwave sprites here for main.js's
   * render-target compositing pass. The mesh-based flame has none, so this
   * is now a no-op that returns `out` unchanged — kept so existing
   * main.js call sites don't need to change. */
  collectShockwaveSprites(out = []) {
    return out;
  }

  _disposeJetPropulsion() {
    for (const rig of this._propulsionRigs) {
      if (rig?.group) rig.group.parent?.remove(rig.group);
      // Geometry + the cached base material are shared across every plane
      // and stay alive — only this rig's own material CLONE is ours to free.
      rig?.material?.dispose?.();
    }
    this._propulsionNodes = [];
    this._propulsionRigs = [];
    this._propulsionNozzleIndex   = [];
    this._propulsionBaseLocalPos  = [];
    this._propulsionBaseLocalQuat = [];
  }

  
  /**
   * Fast vapor/condensation puffs from Low_Pressure_1/2, driven purely by
   * TURN RATE (how fast the nose direction is changing) — a stricter,
   * "hard maneuver only" gate compared to the wingtip vortex's AoA/G blend.
   * Entirely gated behind cfg.aerodynamicCondensation, so planes without
   * the flag pay just one boolean check per frame.
   */
  _updateAerodynamicCondensation(dt) {
    if (!this.cfg.aerodynamicCondensation) return;
    if (!this._condensationNodes[0] && !this._condensationNodes[1]) return;
    if (!this.rigidBody || this.isDead || dt <= 0.0001) {
      this._condensationIntensity = 0;
      return;
    }

    // ── Turn-rate proxy — angle between this frame's and last frame's
    // forward vector, scaled by dt. Cheap: one dot product, one acos.
    this.getForwardVector(this._scratchFwd);
    let targetIntensity = 0;
    if (this._scratchTurnAxisPrevFwdValid) {
      const dot = THREE.MathUtils.clamp(this._scratchFwd.dot(this._scratchTurnAxisPrevFwd), -1, 1);
      const turnRateRad = Math.acos(dot) / dt;
      targetIntensity = THREE.MathUtils.smoothstep(
        turnRateRad, this.cfg.condensationMinTurnRate, this.cfg.condensationGTurnRate
      );
    }
    this._scratchTurnAxisPrevFwd.copy(this._scratchFwd);
    this._scratchTurnAxisPrevFwdValid = true;

    // Fast attack, fast release — reads as a sharp snap of vapor appearing/
    // disappearing with the maneuver, not a lingering cloud.
    const rate = targetIntensity > this._condensationIntensity ? 10 : 5;
    this._condensationIntensity += (targetIntensity - this._condensationIntensity) * Math.min(1, dt * rate);
    if (this._condensationIntensity < 0.02) { this._condensationIntensity = 0; return; }

    // ── Emit — throttled per-node countdown, NOT every frame. Interval
    // shrinks toward condensationMinEmitInterval as intensity climbs, so
    // emission gets very fast right at the peak of a hard G-turn, capped
    // to at most one puff-pair per node per accumulator tick regardless
    // of framerate.
    const interval = THREE.MathUtils.lerp(
      this.cfg.condensationMaxEmitInterval,
      this.cfg.condensationMinEmitInterval,
      this._condensationIntensity
    );

    for (let n = 0; n < 2; n++) {
      const node = this._condensationNodes[n];
      if (!node) continue;

      this._condensationEmitAccum[n] -= dt;
      if (this._condensationEmitAccum[n] > 0) continue;
      this._condensationEmitAccum[n] = interval;

      node.getWorldPosition(this._scratchWorldPos);
      this._scratchCondensationDir.copy(this._scratchFwd).multiplyScalar(-1);
      this.explosionSystem?.spawnCondensationPuff(this._scratchWorldPos, this._scratchCondensationDir);
    }
  }

  // Resolves a config axis string ('x'|'y'|'z') to the matching reusable
  // scratch Vector3 — avoids allocating a new Vector3 every frame per surface.
  _csAxisVecFor(axisName) {
    if (axisName === 'y') return this._csAxisY;
    if (axisName === 'z') return this._csAxisZ;
    return this._csAxisX;
  }

  // ── Render interpolation — identical pattern to Tank ────────────────────────

  captureTransformSnapshot() {
    if (!this.rigidBody) return;
    const pos = this.rigidBody.translation();
    const rot = this.rigidBody.rotation();
    this._prevPos.set(pos.x, pos.y, pos.z);
    this._prevQuat.set(rot.x, rot.y, rot.z, rot.w);

    // ── Capture linear velocity right before THIS physics step runs. This
    // is the only reliable "impact velocity" for ground-collision damage:
    // Rapier's CCD/collision solver resolves (zeroes/reflects) the velocity
    // component along the collision normal WITHIN the same step contact
    // happens — a perpendicular/nose-first hit has its vertical speed wiped
    // out before any post-step read ever sees it, while a shallow/parallel
    // hit only loses its vertical component and still reads "fast" from its
    // untouched horizontal speed. That asymmetry is what made perpendicular
    // high-speed impacts silently survive while grazing impacts "crashed."
    // main.js calls this once immediately before every world.step(), so
    // this always holds the true pre-impact velocity for whichever step
    // produces the actual contact.
    const vel = this.rigidBody.linvel();
    this._preStepVel.set(vel.x, vel.y, vel.z);
  }

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

  // ── Damage / death ───────────────────────────────────────────────────────

  takeDamage(amount = 25) {
    if (this.isDead) return;
    this.health = Math.max(0, this.health - amount);
    this._triggerCameraShake(amount);

    // ── Force autopilot off the moment health drops into the critical
    // range — toggleAutopilot() only blocks new engagement, this catches
    // the case where it was already on before the hit.
    if (this.autopilotEnabled && this._isLowHealth()) {
      this.autopilotEnabled = false;
    }

    if (this.health <= 0) this._die();
  }

  _triggerCameraShake(amount = 25) {
    const intensity = Math.min(amount / 100, 1.0);
    this._shakeIntensity = intensity * 0.6;
    this._shakeDuration   = 0.35 + intensity * 0.25;
    this._shakeElapsed    = 0;
    this._shakeFrequency  = 18 + intensity * 12;
  }

    /** Recoil-style camera shake — internal setter. Independent of (and
   * additive with) the damage-hit shake above, driven by its own
   * intensity/duration/frequency so a quick MG burst reads as a rapid
   * stutter while a rocket/bomb feels like one heavier kick. */
  _triggerFireShake(intensity, duration, frequency) {
    this._fireShakeIntensity = intensity;
    this._fireShakeDuration  = duration;
    this._fireShakeElapsed   = 0;
    this._fireShakeFrequency = frequency;
  }

  /** Public entry point for weapon-fire shake — call this any time a shot
   * is actually fired. Covers weapons fired through fire() itself, and is
   * also exposed for main.js to call directly for the two paths that
   * bypass fire() (continuous Hispano fire, rocket auto-fire). */
  triggerFireShake(kind = 'mg') {
    if (kind === 'rocket')       this._triggerFireShake(0.045, 0.16, 16);
    else if (kind === 'bomb')    this._triggerFireShake(0.055, 0.18, 14);
    else if (kind === 'hispano') this._triggerFireShake(0.030, 0.12, 24);
    else                         this._triggerFireShake(0.015, 0.08, 32); // 'mg' (both gunType 1 and 3)
  }

  /** True once health drops at/below the same threshold that triggers
   * low-health turbulence — reused here to also gate autopilot. */
  _isLowHealth() {
    const healthFrac = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    return healthFrac <= this.cfg.lowHealthTurbulenceFraction;
  }

  /** Returns the current throttle ceiling (0..1) — drops to
   * lowHealthMaxThrottle the instant health falls at/below
   * lowHealthDamageFraction, the same threshold that starts the damage
   * smoke in main.js's updateDamageFireEffects(). */
  _getMaxThrottle() {
    const healthFrac = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    return healthFrac <= this.cfg.lowHealthDamageFraction
      ? this.cfg.lowHealthMaxThrottle
      : 1;
  }

  /** Continuous shudder while flying critically damaged — intensity ramps
   * up smoothly from 0 as health drops below lowHealthTurbulenceFraction,
   * peaking at turbulenceMaxIntensity near 0 health. Writes into
   * _turbulenceOffset only; combined with hit-shake in update(). */
  _updateLowHealthTurbulence(dt, isScoped = false) {
    const healthFrac = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    const threshold   = this.cfg.lowHealthTurbulenceFraction;

    if (this.isDead || healthFrac >= threshold || this.throttle <= 0.25) {
      this._turbulenceOffset.set(0, 0, 0);
      return;
    }

    // 0 at threshold → 1 at zero health
    const severity = 1 - (healthFrac / threshold);

    // ── While scoped, use fixed turbulence tuning instead of the
    // configured values — tuned separately for the tighter scoped view.
    const SCOPED_TURBULENCE_FREQUENCY    = 20;
    const SCOPED_TURBULENCE_MAX_INTENSITY = 0.015;
    const turbFreq = isScoped ? SCOPED_TURBULENCE_FREQUENCY    : this.cfg.turbulenceFrequency;
    const maxIntensity = isScoped ? SCOPED_TURBULENCE_MAX_INTENSITY : this.cfg.turbulenceMaxIntensity;

    this._turbulencePhaseX += dt * turbFreq * (0.9 + severity * 0.4);
    this._turbulencePhaseY += dt * turbFreq * (1.3 + severity * 0.5);

    const mag = severity * maxIntensity;
    this._turbulenceOffset.set(
      Math.sin(this._turbulencePhaseX) * mag,
      Math.sin(this._turbulencePhaseY) * mag * 0.6,
      0
    );
  }

    /** Small random jitter added to aileron/elevator/rudder rotation while
   * critically damaged — reads as the control surfaces themselves shaking
   * from battle damage, distinct from the camera-shake turbulence above.
   * Shares the same health threshold (lowHealthTurbulenceFraction) so both
   * effects kick in together, but each surface gets its own phase/rate so
   * they don't all tremble in perfect sync. */
  _updateControlSurfaceTremble(dt) {
    const healthFrac = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    const threshold  = this.cfg.lowHealthTurbulenceFraction;

    if (this.isDead || healthFrac >= threshold) {
      this._aileronTrembleAngle  = 0;
      this._elevatorTrembleAngle = 0;
      this._rudderTrembleAngle   = 0;
      return;
    }

    // 0 at threshold → 1 at zero health — same severity curve as the
    // camera turbulence, for a consistent "how bad is it" feel.
    const severity = 1 - (healthFrac / threshold);
    const freq     = this.cfg.controlSurfaceTrembleFrequency;
    const maxAngle = severity * this.cfg.controlSurfaceTrembleMaxAngle;

    // Each surface advances its phase at a slightly different rate so the
    // three don't visually sync into one uniform shake.
    this._aileronTremblePhase  += dt * freq * 1.0;
    this._elevatorTremblePhase += dt * freq * 1.35;
    this._rudderTremblePhase   += dt * freq * 0.8;

    this._aileronTrembleAngle  = Math.sin(this._aileronTremblePhase)  * maxAngle;
    this._elevatorTrembleAngle = Math.sin(this._elevatorTremblePhase) * maxAngle;
    this._rudderTrembleAngle   = Math.sin(this._rudderTremblePhase)   * maxAngle;
  }

  /** Continuous shudder while flying with landing gear extended above the
   * configured throttle threshold — simulates wind buffet from the extra
   * drag of flying "dirty." Ramps in smoothly above the threshold rather
   * than switching on/off abruptly at exactly 65% throttle. */
  _updateGearTurbulence(dt, isScoped = false) {
    const threshold = this.cfg.gearTurbulenceThrottleThreshold;

    if (this.isDead || !this._landingGearDown || this.throttle <= threshold) {
      this._gearTurbulenceOffset.set(0, 0, 0);
      return;
    }

    // 0 right at threshold → 1 at full throttle
    const severity = (this.throttle - threshold) / (1 - threshold);

    const SCOPED_GEAR_TURB_FREQUENCY     = 26;
    const SCOPED_GEAR_TURB_MAX_INTENSITY = 0.012;
    const turbFreq      = isScoped ? SCOPED_GEAR_TURB_FREQUENCY     : this.cfg.gearTurbulenceFrequency;
    const maxIntensity  = isScoped ? SCOPED_GEAR_TURB_MAX_INTENSITY : this.cfg.gearTurbulenceMaxIntensity;

    this._gearTurbulencePhaseX += dt * turbFreq * (1.0 + severity * 0.3);
    this._gearTurbulencePhaseY += dt * turbFreq * (1.4 + severity * 0.4);

    const mag = severity * maxIntensity;
    this._gearTurbulenceOffset.set(
      Math.sin(this._gearTurbulencePhaseX) * mag,
      Math.sin(this._gearTurbulencePhaseY) * mag * 0.6,
      0
    );
  }

  _die() {
    if (this.isDead) return;
    this.isDead = true;
    this.autopilotEnabled = false;

    // ── Increase battle-damage stripping (nose→tail + both wings) the
    // instant the plane is destroyed, using the stricter
    // deathMinRemainingFraction instead of the normal (alive) one. Pushed
    // once here — no per-frame update needed since update()'s alive-only
    // damage-shader call stops running once isDead is true, so this value
    // simply stays for the rest of the fall/crash sequence.
    const cfg = this.cfg.damageEffect;
    this._deathDamageCutoff     = cfg.deathMinRemainingFraction * cfg.maxCutbackLength;
    this._deathDamageWingCutoff = cfg.deathMinRemainingFraction * cfg.wingCutbackLength;
    this._pushDamageShaderUniforms(this._deathDamageCutoff, this._deathDamageWingCutoff);

    this.bulletSystem?.invalidateRigidBody?.(this.rigidBody);
    this.rocketSystem?.invalidateRigidBody?.(this.rigidBody);
    this.bombSystem?.invalidateRigidBody?.(this.rigidBody);

    // ── Snap-clear any still-fading tracer beams. update() is what
    // normally fades these out, but it stops being called on this plane
    // instance the moment isDead flips true (see the early-return at the
    // top of update()) — without this, a beam mid-flight at the exact
    // moment of death stays frozen in the scene indefinitely, even after
    // respawning as the tank. ────────────────────────────────────────────
    this.bulletSystem?.clearBeams?.();
    this.hispanoSystem?.clearBeams?.();

    // ── Immediately clear any in-flight flares — flareSystem.update()
    // stops being called the moment isDead flips true (see the dead-
    // branch early-return in update()), so without this any flares still
    // burning at the moment of death would freeze in place, visibly
    // frozen, until a respawn's update() calls resumed ticking them down.
    this.flareSystem?.clearAll?.();

    // ── Immediately clear any in-flight rockets — rocketSystem.update()
    // also stops being called the moment isDead flips true, so without
    // this a rocket that's still mid-flight at the instant of death
    // freezes in place (a bright emissive rocket body hanging in the
    // air) instead of disappearing — visible straight through the
    // death-hold screen and into spawn-selection.
    this.rocketSystem?.clearAll?.();

    // ── Immediately clear wingtip vortex trails on death rather than
    // waiting for next frame's dead-branch to hide them — also resets
    // intensity/sample state so a respawn doesn't inherit a stale
    // "already at full intensity" value from the life that just ended.
    this._vortexIntensity   = 0;
    this._vortexSampleAccum = 0;
    if (this._vortexBuffers[0]) this._vortexBuffers[0].count = 0;
    if (this._vortexBuffers[1]) this._vortexBuffers[1].count = 0;
    if (this._vortexMeshes[0]) this._vortexMeshes[0].visible = false;
    if (this._vortexMeshes[1]) this._vortexMeshes[1].visible = false;
        // ── Immediately hide jet propulsion (flame + shockwave) on death —
    // _updatePropulsion() stops being called once isDead is true (see the
    // dead-branch in update()), so without this the flame/shockwave sprites
    // would otherwise freeze visible at whatever they looked like the
    // instant of death, instead of disappearing.
    for (const rig of this._propulsionRigs) {
      if (rig.group) rig.group.visible = false;
    }

    const deathPos = new THREE.Vector3();
    this.bodyGroup.getWorldPosition(deathPos);

    // ── Explosion at the moment of destruction — distinct from the later
    // ground-impact explosion (which only fires once the wreck lands).
    // This is the "got hit and blew up" beat; the wreck then keeps falling
    // as a burning/tumbling husk until it crashes.
    this.explosionSystem?.spawn(deathPos.clone());
    this.onGroundExplosion?.(deathPos.clone(), 'death');

    // A couple of secondary puffs slightly offset, same pattern as the
    // ground-impact explosion, so the death blast doesn't read as a single
    // flat pop.
    for (let i = 0; i < 2; i++) {
      setTimeout(() => {
        if (!this.explosionSystem) return;
        const off = new THREE.Vector3(
          (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 1.5,
          (Math.random() - 0.5) * 2
        );
        this.explosionSystem.spawn(deathPos.clone().add(off));
      }, 120 + i * 140);
    }

    // ── Fall vector — seeded from the plane's ACTUAL rigid-body velocity
    // at the moment of death (captured BEFORE the rigid body is removed
    // below), not a synthetic "airspeed × 0.6" guess. This is what
    // preserves real momentum from a dive/boost/knockback into the death
    // fall — the old version discarded the real linvel entirely and
    // reconstructed a generic forward-glide vector from this.airspeed
    // (a target scalar, not the true velocity), which is why a plane
    // destroyed at high speed visually "lost" its momentum the instant
    // it died. Gravity still does the rest each frame in update().
    if (this.rigidBody) {
      const _preDeathVel = this.rigidBody.linvel();
      this._fallVel = new THREE.Vector3(_preDeathVel.x, _preDeathVel.y, _preDeathVel.z);
    } else {
      this.getForwardVector(this._scratchFwd);
      this._fallVel = this._scratchFwd.clone().multiplyScalar((this.airspeed ?? this.cfg.cruiseSpeed) * 0.6);
    }
    this._fallVel.y -= 1;

    // Random sideways/vertical kick — magnitude scaled by current airspeed
    // so a fast death looks more violent than a slow one. Uses bodyGroup's
    // local right/up so the kick direction is relative to how the plane
    // was actually oriented at the moment of death, not world axes.
    this.getForwardVector(this._scratchFwd); // re-read (already have it, kept for clarity)
    const _kickRight = new THREE.Vector3(0, 0, -1).applyQuaternion(this.bodyGroup.quaternion);
    const _kickUp     = new THREE.Vector3(0, 1, 0).applyQuaternion(this.bodyGroup.quaternion);
    const _kickMag = THREE.MathUtils.randFloat(2, 6) * (0.5 + (this.airspeed ?? this.cfg.cruiseSpeed) / this.cfg.maxSpeed);
    this._fallVel.addScaledVector(_kickRight, (Math.random() < 0.5 ? -1 : 1) * _kickMag);
    this._fallVel.addScaledVector(_kickUp,    THREE.MathUtils.randFloat(-1.5, 2.5));

    // ── Propeller keeps windmilling through the fall instead of freezing
    // at whatever angle it had the instant health hit 0 — captured here
    // from the same rate formula update() used while alive, then decayed
    // gradually each frame in the dead branch below.
    this._propSpinVelocity = this._propellerNodes.length > 0
      ? (0.4 + this.throttle) * this.cfg.propellerMaxSpeed
      : 0;

    // ── Chaotic multi-axis tumble — pitch/roll/yaw all spin independently
    // now (not just roll), each with its own random rate and random sign,
    // so every death tumbles differently and looks like a genuine loss of
    // control rather than a scripted single-axis wobble.
    this._fallRollRate  = (Math.random() < 0.5 ? -1 : 1) * THREE.MathUtils.randFloat(0.6, 1.8);
    this._fallPitchRate = (Math.random() < 0.5 ? -1 : 1) * THREE.MathUtils.randFloat(0.3, 1.1);
    this._fallYawRate   = (Math.random() < 0.5 ? -1 : 1) * THREE.MathUtils.randFloat(0.2, 0.8);

    // Tumble rates ramp up slightly over the first moment of the fall
    // (like the plane genuinely spinning out) rather than snapping to full
    // spin instantly — driven by _fallElapsed in update().
    this._fallTumbleRampDuration = THREE.MathUtils.randFloat(0.4, 0.9);

    // ── Rigid body is removed IMMEDIATELY on death, same as the
    // original working behavior — this is what makes enemy/friendly AI
    // correctly treat the plane as gone right away (no rigidBody, no
    // target) instead of continuing to track and fire at it for the
    // entire duration of the fall. Everything after this point is a
    // fully hand-animated fall (position/velocity moved manually each
    // frame in update()), not physics-driven.

    if (this.rigidBody) {
      this.world.removeRigidBody(this.rigidBody);
      this.rigidBody = null;
    }
    // ← must happen in the SAME synchronous pass as the removal above,
    // since _die() can be triggered mid-update() (e.g. from
    // _checkGroundCollision()), and update() keeps running afterward —
    // without this, waterSplashSystem.update() further down the same
    // frame still calls .linvel() on the just-removed Rapier body.
    this.waterSplashSystem?.setRigidBody(null);

    // Wheel colliders were attached to the rigid body just removed above —
    // Rapier already discarded them along with it, so just drop the
    // JS-side references without calling world.removeCollider() on them.
    this._wheelColliders = [];

    // ── Ground-contact state ────────────────────────────────────────
    this._groundExplosionSpawned = false;

    // Plane keeps falling/tumbling visually until it "lands" (ground hit or
    // timeout) — main.js's death-hold camera window covers this the same
    // way it does the tank's turret-eject animation.
    this._fallElapsed = 0;
    this._treeCheckAccum = 0;
    this._readyToShowDeath = false;

    setTimeout(() => {
      this._readyToShowDeath = true;
    }, 1800);
  }

  // ── Flight input / physics ──────────────────────────────────────────────

  /** Toggle autopilot on/off. Returns the new enabled state. */
  toggleAutopilot() {
    if (!this.rigidBody) return this.autopilotEnabled;

    // ── Autopilot can't be ENGAGED while critically damaged — reuses the
    // same threshold as the low-health turbulence effect, so both kick in
    // together. Turning autopilot OFF is always allowed, even at low health.
    if (!this.autopilotEnabled && this._isLowHealth()) {
      return this.autopilotEnabled;
    }

    // ── Autopilot can't be ENGAGED while the landing gear is down —
    // gear-down implies taxi/takeoff/landing, not stable cruise flight,
    // so autopilot shouldn't be able to take over then. Turning autopilot
    // OFF is always allowed regardless of gear state (mirrors the health
    // guard above).
    if (!this.autopilotEnabled && this._landingGearDown) {
      return this.autopilotEnabled;
    }

    this.autopilotEnabled = !this.autopilotEnabled;
    if (this.autopilotEnabled) {
      const pos = this.rigidBody.translation();
      this._apTargetAltitude = pos.y;
      this.getForwardVector(this._scratchFwd);
      this._apTargetHeadingRad = Math.atan2(this._scratchFwd.x, this._scratchFwd.z);
      // Snap throttle up immediately rather than waiting for next frame's
      // ramp — avoids a beat of continued freefall right at engage time.
      this.throttle = Math.max(this.throttle, 0.65);
    }
    return this.autopilotEnabled;
  }

  /** Computes pitch/roll/yaw input automatically to hold altitude + heading. */
  _updateAutopilotInput(dt) {
    const AUTOPILOT_CRUISE_THROTTLE = 0.75;

    const rot   = this.rigidBody.rotation();
    const q     = this._scratchQ.set(rot.x, rot.y, rot.z, rot.w);
    const fwd   = this._scratchFwd.set(-1, 0, 0).applyQuaternion(q);
    const pos   = this.rigidBody.translation();
    const vel   = this.rigidBody.linvel();

    // ── Throttle: cruise normally, but floor it to full power the moment
    // we're stalled or sinking fast — pitch correction alone can't fix a
    // stall (lift is zeroed while stalled regardless of pitch), only
    // regaining airspeed can, so this has to react quickly rather than
    // ramp slowly like manual throttle does. ────────────────────────────
    const emergencyClimb  = this.isStalled || vel.y < -4;
    const maxThrottle      = this._getMaxThrottle();
    const throttleTarget   = Math.min(maxThrottle, emergencyClimb ? 1.0 : AUTOPILOT_CRUISE_THROTTLE);
    const throttleLerpT   = Math.min(1, dt * (emergencyClimb ? 4 : 1.5));
    this.throttle = THREE.MathUtils.lerp(this.throttle, throttleTarget, throttleLerpT);
    this.throttle = Math.min(this.throttle, maxThrottle);
    this.isBoosting = false;

    // ── Altitude hold → pitch, with a damping term on vertical speed so
    // it settles instead of overshooting/oscillating (which is what was
    // reading as "not steady, falling"). While stalled, don't fight for
    // pitch-up — it does nothing until airspeed recovers, so ease off
    // toward level instead and let the throttle boost above do the work. ─
    const altError = this._apTargetAltitude - pos.y;
    let targetPitch;
    if (this.isStalled) {
      targetPitch = THREE.MathUtils.clamp(altError * 0.008, -0.15, 0.15);
    } else {
      targetPitch = THREE.MathUtils.clamp(altError * 0.02 - vel.y * 0.05, -0.5, 0.5);
    }

    // ── Heading hold → yaw only. In this flight model, rolling about the
    // plane's own forward axis does NOT change its heading (no bank-to-turn
    // coupling), so commanding roll from headingError never reduces the
    // error — it just sends the plane into a perpetual, self-reinforcing
    // barrel roll. Heading is corrected via yaw alone; roll target stays
    // at 0 so autoLevelRoll (in _updateFlightPhysics) keeps the wings level.
    const currentHeading = Math.atan2(fwd.x, fwd.z);
    let headingError = this._apTargetHeadingRad - currentHeading;
    headingError = Math.atan2(Math.sin(headingError), Math.cos(headingError)); // normalize -PI..PI
    const targetRoll = 0;
    const targetYaw  = THREE.MathUtils.clamp(headingError * 0.3, -0.3, 0.3);

    const INPUT_SMOOTH = 3; // gentler than manual control — lazy autopilot feel
    const t = Math.min(1, dt * INPUT_SMOOTH);
    this._pitchInput = THREE.MathUtils.lerp(this._pitchInput, targetPitch, t);
    this._rollInput  = THREE.MathUtils.lerp(this._rollInput,  targetRoll,  t);
    this._yawInput   = THREE.MathUtils.lerp(this._yawInput,   targetYaw,   t);
  }

  /** Locks/unlocks manual roll input — used by the bomb-sight scope view
   * so the plane can't be rolled while aiming a bomb drop. Pitch/yaw are
   * untouched; auto-level torque in _updateFlightPhysics() will bring the
   * plane back to level roll once targetRoll is forced to 0 below. */
  setRollLocked(locked) {
    this._rollLocked = !!locked;
  }

  /** Locks/unlocks manual pitch (elevator) input — used alongside
   * setRollLocked() by the bomb-sight scope view, so the plane's attitude
   * is fully frozen (no roll, no pitch) while the pilot is looking
   * straight down through the sight. Yaw is left untouched. */
  setPitchLocked(locked) {
    this._pitchLocked = !!locked;
  }

  applyInput(keys, dt, invertRoll = false) {
    if (!this.rigidBody) return;

    // ── Reset every call; only set true below if manual input actually
    // has backward held. Ensures autopilot/no-input frames don't inherit
    // a stale "S held" state from a previous manual-control frame.
    this._backwardHeld = false;

    // ── Autopilot must run even while _inputLocked is set (e.g. after the
    // match ends) — _inputLocked exists to block MANUAL player input, not
    // autopilot's own control loop. Checking it before the autopilot
    // branch used to freeze the plane's controls entirely instead of
    // letting autopilot keep flying it straight-and-level. ─────────────
    if (this.autopilotEnabled) {
      this._updateAutopilotInput(dt);
      return;
    }

    if (this._inputLocked) return;

    // ── Cache raw backward-key state for other systems (e.g. flap
    // deployment in update()) that need to know "S" is held this frame,
    // independent of throttle value.
    this._backwardHeld = !!keys.backward;

    // ── Throttle ─────────────────────────────────────────────────────────
    const maxThrottle = this._getMaxThrottle();
    if (keys.forward)  this.throttle = Math.min(maxThrottle, this.throttle + this.cfg.throttleRampRate * dt);
    if (keys.backward) this.throttle = Math.max(0, this.throttle - this.cfg.throttleRampRate * dt);
    // Also clamps down immediately if throttle was already above the cap
    // (e.g. was at 100% the instant health crossed the damage threshold).
    this.throttle = Math.min(this.throttle, maxThrottle);

    // ── Reverse ("R") gear — engages only while grounded with throttle at
    // idle and backward held. Fixed speed, not scaled by how long S is
    // held or how far throttle would otherwise go.
    const wasReverseEngaged = this._reverseGearEngaged;
    this._reverseGearEngaged = this._isGrounded && this.throttle <= 0 && !!keys.backward;

    // Drop wheel friction near-zero while reversing so the small imposed
    // velocity isn't cancelled by ground contact each step; restore normal
    // friction the instant reverse disengages (only touches colliders that
    // currently exist, i.e. only while gear is actually down).
    if (this._reverseGearEngaged !== wasReverseEngaged) {
      this._setWheelFriction(this._reverseGearEngaged ? this.cfg.reverseWheelFriction : this.cfg.wheelFriction);
    }

    // ── TEMP DEBUG — remove once reverse is confirmed working. Logs once
    // per ~0.5s while backward is held so you can see exactly which gate
    // (grounded / throttle / engaged) is blocking it.
    if (keys.backward) {
      this._reverseDebugAccum = (this._reverseDebugAccum ?? 0) + dt;
      if (this._reverseDebugAccum > 0.5) {
        this._reverseDebugAccum = 0;
        console.log('[Plane reverse debug]', {
          autopilot: this.autopilotEnabled,
          isGrounded: this._isGrounded,
          throttle: this.throttle.toFixed(3),
          gearDown: this._landingGearDown,
          engaged: this._reverseGearEngaged,
          wheelNodesFound: this._wheelNodes.filter(n => n).length,
          gearNodesFound: this._landingGearNodes.length,
        });
      }
    }

    this.isBoosting = !!keys.boost;

    // ── Mouse-driven pitch + roll — cursor offset from screen center acts
    // like a self-centering joystick. Small deadzone near center so tiny
    // hand tremor / sub-pixel jitter doesn't register as input, which lets
    // auto-level actually settle the plane instead of fighting noise.
    const offset = getMouseFlightOffset();
    const DEADZONE = 0.06;

    const applyDeadzone = (v) => {
      if (Math.abs(v) < DEADZONE) return 0;
      // Rescale so output still reaches -1..1 at the edges, instead of
      // having a small "dead" gap right past the deadzone threshold.
      const sign = v > 0 ? 1 : -1;
      return sign * (Math.abs(v) - DEADZONE) / (1 - DEADZONE);
    };

    // ── NOTE: control-surface authority (throttle gating) is applied ONLY
    // in _updateFlightPhysics(), not here. _pitchInput/_rollInput/_yawInput
    // are shared by two consumers: the actual flight physics (which SHOULD
    // go dead at zero throttle — no airflow, no aerodynamic authority) and
    // the purely cosmetic control-surface animation in update() (which
    // should keep visually responding to input regardless of throttle —
    // the flaps/ailerons/elevator/rudder still physically move even when
    // the engine is idle). Gating the values here would zero both at once.
    // ── Roll direction flips in chase cam (invertRoll=true), passed in
    // from main.js based on scope.isScoped — chase cam and scope view sit
    // on opposite sides visually, so a raw mouse-x roll input that feels
    // correct in one reads backwards in the other unless flipped here.
    const rollSign    = invertRoll ? -1 : 1;
    const targetRoll  = this._rollLocked  ? 0 : applyDeadzone(offset.x) * rollSign;
    const targetPitch = this._pitchLocked ? 0 : applyDeadzone(-offset.y); // cursor up (negative y) → pitch up (positive)

    // ── Yaw (rudder) — keyboard only, A/D ───────────────────────────────
    const targetYaw = (keys.yawRight ? 1 : 0) - (keys.yawLeft ? 1 : 0);

    const INPUT_SMOOTH = 8;
    const t = Math.min(1, dt * INPUT_SMOOTH);
    this._pitchInput = THREE.MathUtils.lerp(this._pitchInput, targetPitch, t);
    this._rollInput  = THREE.MathUtils.lerp(this._rollInput,  targetRoll,  t);
    this._yawInput   = THREE.MathUtils.lerp(this._yawInput,   targetYaw,   t);
  }

  _updateFlightPhysics(dt) {
    if (!this.rigidBody) return;

    const rot = this.rigidBody.rotation();
    const q   = this._scratchQ.set(rot.x, rot.y, rot.z, rot.w);

    const fwd   = this._scratchFwd.set(-1, 0, 0).applyQuaternion(q);
    const up    = this._scratchUp.set(0, 1, 0).applyQuaternion(q);
    const right = this._scratchRight.set(0, 0, -1).applyQuaternion(q);

    // ── Throttle → target airspeed ──────────────────────────────────────────
    const maxSpeed = this.isBoosting ? this.cfg.boostMaxSpeed : this.cfg.maxSpeed;
    const accel    = this.isBoosting ? this.cfg.boostAccel    : this.cfg.throttleAccel;

    // Reverse gear overrides the normal throttle→speed curve entirely with
    // a fixed constant target — it never scales with throttle position.
    const isReversing = this._reverseGearEngaged;
    const targetSpeed = isReversing
      ? -this.cfg.reverseSpeed
      : this.cfg.minSpeed + this.throttle * (maxSpeed - this.cfg.minSpeed);
    const currentAccel = isReversing ? this.cfg.reverseAccel : accel;
    const currentDecel = isReversing ? this.cfg.reverseAccel : this.cfg.throttleDecel;

    if (this.airspeed < targetSpeed) {
      this.airspeed = Math.min(targetSpeed, this.airspeed + currentAccel * dt);
    } else {
      this.airspeed = Math.max(targetSpeed, this.airspeed - currentDecel * dt);
    }

    // ── Stall check — reverse taxiing is a ground maneuver, not a stall.
    this.isStalled = !isReversing && this.airspeed < this.cfg.stallSpeed;

    // ── Control-surface AERODYNAMIC authority scales with throttle — no
    // thrust means no airflow over the surfaces, so they shouldn't be able
    // to actually rotate the airframe at low throttle, even though they
    // still visually flex with mouse input (see update()'s control-surface
    // animation, which reads _pitchInput/_rollInput/_yawInput directly and
    // is intentionally NOT gated here).
    //
    // Pitch/roll/yaw authority now scales smoothly with throttle instead of
    // hard-gating on/off at a fixed threshold — low throttle means sluggish,
    // weak control response; full throttle means full control authority.
    // FULL_AUTHORITY_THROTTLE is the point at which control authority caps
    // out at 1.0 — throttle above this still gives full authority, throttle
    // below it ramps down linearly toward MIN_AUTHORITY at throttle 0.
    const FULL_AUTHORITY_THROTTLE = 0.70;
    const MIN_AUTHORITY = 0; // zero authority at zero throttle — plane shouldn't move at all
    const pitchRollAuthority = MIN_AUTHORITY + (1 - MIN_AUTHORITY) *
      THREE.MathUtils.clamp(this.throttle / FULL_AUTHORITY_THROTTLE, 0, 1);

    // ── Apply attitude rotation (angular velocity toward input targets) ────
    // Roll and yaw are direct-rate controls; pitch likewise, but we also
    // blend in a mild auto-level torque on roll when the player isn't
    // inputting anything — matches BF5's "let go and it gently levels" feel.
    const pitchRate = this.cfg.pitchRate * this._pitchInput * pitchRollAuthority;
    const rollRate  = this.cfg.rollRate  * this._rollInput  * pitchRollAuthority;
    // Yaw (rudder) ramps the same way, but keeps a bit more low-end
    // authority than pitch/roll since rudder is partly driven by
    // prop/slipstream wash rather than pure freestream airflow.
    //
    // ── Reverse-gear override: throttle is always 0 while reversing (see
    // applyInput's reverse-engage gate), which used to zero out yawAuthority
    // entirely — meaning A/D had no steering effect while backing up and the
    // plane always reversed dead straight. While actively reversing, this is
    // ground taxiing (like a car backing up), not aerodynamic yaw authority,
    // so give it a fixed, throttle-independent steering authority instead.
    const REVERSE_YAW_AUTHORITY = 1;
    const YAW_MIN_AUTHORITY = 0; // zero yaw authority at zero throttle too (non-reverse case)
    const yawAuthority = isReversing
      ? REVERSE_YAW_AUTHORITY
      : YAW_MIN_AUTHORITY + (1 - YAW_MIN_AUTHORITY) *
        THREE.MathUtils.clamp(this.throttle / FULL_AUTHORITY_THROTTLE, 0, 1);

    // ── Reverse steering flip — the plane travels tail-first while
    // reversing, so a yaw input that swings the NOSE right actually swings
    // the (leading) TAIL left — the opposite of what the player expects,
    // same as a car's reverse steering needing to be mirrored relative to
    // forward-driving intuition. Flip the input sign only in this case so
    // A/D steer the direction of travel the way the player expects.
    const yawInputForRate = isReversing ? -this._yawInput : this._yawInput;
    const yawRate   = this.cfg.yawRate   * yawInputForRate * yawAuthority;

    // Auto-level: torque roll back toward 0 bank when no roll input, scaled
    // by how far from level we are (small-angle torque, not a snap).
    // Gated by controlAuthority same as manual input — with no airflow
    // (zero throttle) there's no aerodynamic self-righting either, so a
    // stationary/idling plane should stay however it's currently banked.
    let autoLevelRoll = 0;
    if (Math.abs(this._rollInput) < 0.05) {
      // Extract current bank angle from `right.y` (0 = level, ±1 = knife-edge)
      const bank = Math.asin(THREE.MathUtils.clamp(right.y, -1, 1));
      // NOTE: given this model's axis convention (fwd × right = -up), a roll
      // rate ω about the forward axis produces d(right.y)/dt = -ω. To get
      // negative feedback (decay back to level) we need ω = +bank * strength,
      // NOT -bank * strength — the old negated sign was positive feedback,
      // so any tiny bank noise grew exponentially into a runaway roll.
      autoLevelRoll = bank * this.cfg.autoLevelStrength * pitchRollAuthority;
    }

    // angular velocity is expressed in world space for Rapier; build it from
    // the plane's local pitch/roll/yaw axes (right/up/fwd respectively)
    const angVel = this._scratchVel.set(0, 0, 0)
        .addScaledVector(right, pitchRate)
        .addScaledVector(fwd,   (rollRate + autoLevelRoll))
        .addScaledVector(up,    -yawRate);

    this.rigidBody.setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z }, true);

    if (this.throttle === 0 && (Math.abs(pitchRate) > 0.0001 || Math.abs(rollRate) > 0.0001)) {
      console.warn('[Plane] Non-zero pitch/roll rate at throttle 0:', pitchRate, rollRate, 'rollInput=', this._rollInput, 'pitchInput=', this._pitchInput);
    }

    // ── Aerodynamic forces ────────────────────────────────────────────────
    // Lift: proportional to airspeed^2 and liftCoefficient, always along the
    // plane's local "up", vanishes below stall speed (replaced by a sink rate).
    // Drag: opposes velocity, proportional to speed^2.
    // Gravity: constant downward, always on.
    const mass = this.rigidBody.mass ? this.rigidBody.mass() : 1;
    const speedSq = this.airspeed * this.airspeed;

    this._scratchForce.set(0, 0, 0);

    if (isReversing) {
      // Reverse taxi — grounded, no lift needed; the ground collider's
      // own contact response supports the plane, same as any parked object.
    } else if (!this.isStalled) {
      const liftMag = this.cfg.liftCoefficient * speedSq;
      this._scratchForce.addScaledVector(up, liftMag);
    } else {
      // Stalled — no meaningful lift, plane sinks even if pointed level
      this._scratchForce.addScaledVector(up, -this.cfg.stallSinkRate * mass);
    }

    // Gravity (always)
    this._scratchForce.y -= this.cfg.gravity * mass;

    // Drag opposing current velocity (uses actual rigid body velocity, not
    // just airspeed, so wind/impacts bleed off naturally)
    const vel = this.rigidBody.linvel();
    const dragMag = this.cfg.dragCoefficient * speedSq;
    const velLen = Math.hypot(vel.x, vel.y, vel.z) || 1;
    this._scratchForce.x -= (vel.x / velLen) * dragMag;
    this._scratchForce.y -= (vel.y / velLen) * dragMag;
    this._scratchForce.z -= (vel.z / velLen) * dragMag;

    this.rigidBody.applyImpulse({
      x: this._scratchForce.x * dt,
      y: this._scratchForce.y * dt,
      z: this._scratchForce.z * dt,
    }, true);

    // ── Sideslip / drift model ──────────────────────────────────────────
    // Re-read linvel post-impulse (setLinvel below is an absolute
    // overwrite, so anything computed from a stale `vel` would discard
    // the lift/drag/gravity impulse just applied above).
    const postImpulseVel = this.rigidBody.linvel();
    const worldVel = this._scratchVel.set(postImpulseVel.x, postImpulseVel.y, postImpulseVel.z);

    // Local-space velocity — right/up/fwd already computed above from the
    // current orientation, so this is just a change of basis (no quaternion
    // inversion needed since right/up/fwd already form an orthonormal frame).
    const localForwardSpeed = worldVel.dot(fwd);
    const localLateralSpeed = worldVel.dot(right);
    const localVerticalSpeed = worldVel.dot(up);

    // ── Angle of attack — angle between velocity direction and nose, in
    // the pitch plane (fwd/up). Low/zero at level cruise; climbs fast in
    // a hard pull-up or when airspeed drops relative to vertical speed.
    //
    // Skipped entirely while reverse-gear taxiing: localForwardSpeed is
    // intentionally near zero there (starting from a stop), so this falls
    // back to the 0.0001 epsilon and any tiny vertical-velocity noise from
    // gravity (applied a frame before ground contact resolves it) makes
    // aoaRad spike to ~±90°. That was driving driftT to 1 every frame while
    // grounded, which crushes forwardBlendRate down to velocityBlendHighAoA
    // (0.6) — so the reverse target speed converged so slowly it looked
    // like the plane wasn't moving at all.
    let aoaRad = 0;
    let aoaT = 0;
    if (!isReversing) {
      aoaRad = Math.atan2(localVerticalSpeed, Math.abs(localForwardSpeed) || 0.0001);
      aoaT = THREE.MathUtils.clamp(Math.abs(aoaRad) / this.cfg.maxAoARad, 0, 1);
    }

    // Also factor in raw stick aggression — a hard yaw/roll input alone
    // (even before AoA builds up) should start loosening stability, so the
    // drift begins the instant the player throws the plane around, not a
    // frame later once AoA has caught up.
    const turnIntensity = THREE.MathUtils.clamp(
      Math.abs(this._yawInput) * 0.6 + Math.abs(this._rollInput) * 0.4, 0, 1
    );
    const driftT = isReversing ? 0 : Math.max(aoaT, turnIntensity);

    // ── Side force — gently corrects lateral (sideways) velocity back
    // toward zero, rather than the old hard snap-to-forward blend. Strong
    // in normal flight (feels locked-in), weak at high AoA/aggressive
    // turns (lets the nose point somewhere different from the velocity
    // vector — the actual "drift"/sideslip look).
    const sideStability = THREE.MathUtils.lerp(
      this.cfg.sideStabilityNormal, this.cfg.sideStabilityHighAoA, driftT
    );
    const sideForceImpulse = -localLateralSpeed * sideStability * dt;
    worldVel.addScaledVector(right, sideForceImpulse);

    // ── Forward thrust — blend the FORWARD component of velocity toward
    // the throttle-derived airspeed target, instead of blending the WHOLE
    // velocity vector toward fwd*airspeed like before. Blending the whole
    // vector is exactly what erases sideslip every frame (see reference
    // notes) — isolating it to just the forward axis lets lateral/vertical
    // velocity carry its own inertia while thrust still does its job.
    const desiredForwardSpeed = this.airspeed;
    const forwardBlendRate = THREE.MathUtils.lerp(
      this.cfg.velocityBlendNormal, this.cfg.velocityBlendHighAoA, driftT
    );
    const newForwardSpeed = THREE.MathUtils.lerp(
      localForwardSpeed, desiredForwardSpeed, Math.min(1, dt * forwardBlendRate)
    );
    const forwardSpeedDelta = newForwardSpeed - localForwardSpeed;
    worldVel.addScaledVector(fwd, forwardSpeedDelta);

    // ── Vertical velocity damping — the old whole-vector blend implicitly
    // kept climb/sink rate sane every frame; isolating forward+lateral above
    // means nothing was left to stop vertical speed from accumulating
    // unchecked when lift doesn't exactly cancel gravity. Lightly damp any
    // vertical speed EXCESS beyond what lift/gravity/stall already intend,
    // rather than fighting them outright — this only removes runaway
    // buildup, it doesn't override normal climb/dive control.
    const verticalDampRate = THREE.MathUtils.lerp(3.0, 0.8, driftT); // gentler damping while drifting, like fwd/lateral
    const verticalCorrection = -localVerticalSpeed * verticalDampRate * dt;
    // Only damp, never amplify — clamp so this can't itself inject energy
    // if dt spikes on a slow frame.
    const clampedVerticalCorrection = THREE.MathUtils.clamp(verticalCorrection, -20 * dt, 20 * dt);
    worldVel.addScaledVector(up, clampedVerticalCorrection);

    this.rigidBody.setLinvel({ x: worldVel.x, y: worldVel.y, z: worldVel.z }, true);

    // ── TEMP DEBUG — remove once reverse is confirmed working.
    if (isReversing) {
      this._reverseGearDebugAccum = (this._reverseGearDebugAccum ?? 0) + dt;
      if (this._reverseGearDebugAccum > 0.4) {
        this._reverseGearDebugAccum = 0;
        const posNow = this.rigidBody.translation();
        console.log('[Plane reverse physics]', {
          targetSpeed: targetSpeed.toFixed(3),
          airspeed: this.airspeed.toFixed(3),
          localForwardSpeed: localForwardSpeed.toFixed(3),
          postImpulseVel: `${postImpulseVel.x.toFixed(2)}, ${postImpulseVel.y.toFixed(2)}, ${postImpulseVel.z.toFixed(2)}`,
          finalLinvel: `${worldVel.x.toFixed(3)}, ${worldVel.y.toFixed(3)}, ${worldVel.z.toFixed(3)}`,
          pos: `${posNow.x.toFixed(3)}, ${posNow.y.toFixed(3)}, ${posNow.z.toFixed(3)}`,
          bodyType: this.rigidBody.bodyType?.(),
          isSleeping: this.rigidBody.isSleeping?.(),
        });
      }
    }

    // Stash for other systems (e.g. condensation/vortex could read this
    // instead of recomputing AoA themselves later, if desired).
    this._currentAoARad = aoaRad;
    this._currentDriftT = driftT;
  }

  // ── Ground proximity / crash check ──────────────────────────────────────

  _checkGroundCollision(dt, getTerrainY) {
    if (!this.rigidBody || this.isDead) return;

    // ── Post-spawn grace window — suppresses crash detection right after
    // spawn/respawn, since the plane starts near/at minAltitude before
    // throttle has had a chance to build climb speed.
    if (this._groundCollisionGrace > 0) {
      this._groundCollisionGrace = Math.max(0, this._groundCollisionGrace - dt);
      return;
    }

    const pos = this.rigidBody.translation();
    const rot = this.rigidBody.rotation();
    const groundY = getTerrainY(pos.x, pos.z);

    // ── Orientation-aware ground touch test — finds the lowest WORLD-SPACE
    // corner of the hull's box collider, instead of assuming the plane is
    // level (the old "pos.y minus half-height" check). A level flight only
    // ever needs half the hull's HEIGHT of clearance, but a steep/perpendicular
    // dive rotates the box so its LENGTH or WIDTH points downward — the
    // actual contact corner can be far below pos.y while pos.y itself (the
    // rigid body's center) is still well above the old flat-orientation
    // threshold. That mismatch is why perpendicular impacts never registered
    // at all: the function returned early before ever reaching the speed
    // check below.
    this._groundCheckQuat.set(rot.x, rot.y, rot.z, rot.w);
    const { x: hx, y: hy, z: hz } = this.cfg.hullHalfExtents;
    const colliderYOffset = this.cfg.colliderYOffset ?? 1;

    let minCornerY = Infinity;
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          this._groundCheckCorner
            .set(sx * hx, sy * hy + colliderYOffset, sz * hz)
            .applyQuaternion(this._groundCheckQuat)
            .add(pos);
          if (this._groundCheckCorner.y < minCornerY) minCornerY = this._groundCheckCorner.y;
        }
      }
    }

    // Still airborne — nothing to check yet.
    if (minCornerY > groundY) return;

    // ── Upside-down ground contact — destroyed instantly regardless of
    // speed. A plane resting/sliding on its back or side is a wreck, not
    // a recoverable landing, no matter how gently it got there.
    if (this.isUpsideDown()) {
      this.takeDamage(this.maxHealth);
      return;
    }

    // ── Touching/below ground — check impact speed. Uses the velocity
    // captured immediately BEFORE the physics step that likely produced
    // this contact (see captureTransformSnapshot()), not the current
    // rigid-body velocity — by this point in the frame, both the ground
    // collision solver AND _updateFlightPhysics()'s own setLinvel() call
    // have already overwritten/resolved linvel(), discarding the real
    // physical impact velocity. Reading the pre-step snapshot instead is
    // what makes a perpendicular high-speed impact register correctly.
    const vel = this._preStepVel;
    const speedMs  = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
    const speedKmh = speedMs * 3.6;

    if (speedKmh > this.cfg.wheelSmokeMaxSpeedThreshold) {
      // Lethal high-speed ground impact — destroy the plane outright.
      // Reuses the normal damage pipeline (camera shake + _die()) rather
      // than calling _die() directly, so a crash feels consistent with
      // any other killing blow.
      this.takeDamage(this.maxHealth);
    } else if (speedKmh > this.cfg.wheelSmokeSpeedThreshold) {
      // Moderate-speed touchdown — not fast enough to destroy the plane,
      // but fast enough to kick up a puff of smoke at each wheel, same
      // idea as tires chirping on landing. Throttled so this only fires
      // once per "landing event" rather than every physics step the
      // plane happens to still be near/at the speed band.
      this._spawnWheelTouchSmoke();
    }
  }

  /**
   * Handles a physical collision against any solid, non-terrain obstacle —
   * a house collider, an enemy/friendly tank's hull, another plane, etc.
   * Called from main.js's drainCollisionEvents() the instant Rapier
   * reports contact has actually started (`started === true`) between
   * this plane's rigid body and the other body.
   *
   * Uses the SAME speed gate as _checkGroundCollision (cfg.crashSpeedThreshold)
   * so a plane taxiing/bumping gently into something at low speed doesn't
   * instantly explode, but any real impact does — consistent crash feel
   * across every solid obstacle, not just terrain.
   */
  handleObstacleCollision() {
    if (!this.rigidBody || this.isDead) return;
    // Same post-spawn grace window as ground collisions — a plane spawning
    // at/near a house or another vehicle shouldn't insta-die on the very
    // first physics step before it's had a chance to move away.
    if (this._groundCollisionGrace > 0) return;

    // ── Upside-down obstacle contact — destroyed instantly regardless of
    // speed, same rule as the ground-collision check above.
    if (this.isUpsideDown()) {
      this.takeDamage(this.maxHealth);
      return;
    }

    const vel = this._preStepVel;
    const speedMs  = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
    const speedKmh = speedMs * 3.6;

    if (speedKmh > this.cfg.crashSpeedThreshold) {
      this.takeDamage(this.maxHealth);
    } else if (speedKmh > this.cfg.wheelSmokeSpeedThreshold) {
      this._spawnWheelTouchSmoke();
    }
  }

  /**
   * Spawns a one-shot smoke puff (via ExplosionSystem.spawnMultiGunSmoke,
   * reused here purely for its cheap single-particle puff shape — nothing
   * multi-gun-specific about it) at each wheel's current world position.
   * Player-plane only: intentionally NOT called from EnemyPlane, which has
   * no wheel nodes wired up for this at all. Cooldown-gated so a plane
   * lingering in the moderate touchdown speed band doesn't spam a puff
   * every physics step.
   */
  _spawnWheelTouchSmoke() {
    if (!this.explosionSystem) return;
    if (this._wheelSmokeCooldown > 0) return;
    this._wheelSmokeCooldown = 0.5; // seconds — tune to taste

    for (const wheelNode of this._wheelNodes) {
      if (!wheelNode) continue;
      wheelNode.getWorldPosition(this._scratchWorldPos);
      this.explosionSystem.spawnMultiGunSmoke(this._scratchWorldPos);
    }
  }

  // ── Grounded check for reverse-gear purposes. Prefers the WHEEL mesh
  // NODES' live world position (works whether or not wheel colliders
  // actually got built — collider creation depends on Wheel_N nodes
  // existing AND matching a LandingGear_N index, while the node check
  // here only needs the node itself). Falls back to the LandingGear_N
  // node, then to the hull-corner method, so this degrades gracefully
  // no matter what the GLB actually contains.
  //
  // IMPORTANT: this now raycasts against the actual physics world FIRST
  // (terrain heightfield, house Collider_N boxes, cars, props — anything
  // solid), and only falls back to the terrain heightmap (getTerrainY) if
  // the raycast finds nothing. Without the raycast, a plane resting on a
  // house's Collider_N (which sits well above the terrain heightmap at
  // that XZ position) always measured a huge "clearance" against the raw
  // terrain height underneath the house, so _isGrounded never went true
  // and reverse gear silently refused to engage while parked on a roof.
  _updateGroundedState(getTerrainY) {
    if (!this.rigidBody || !this._landingGearDown) {
      this._isGrounded = false;
      return;
    }

    const probeNodes = this._wheelNodes.some(n => n)
      ? this._wheelNodes
      : (this._landingGearNodes.length > 0 ? this._landingGearNodes : null);

    const RAPIER = this.world?.__RAPIER__;
    const RAY_ABOVE = 2.0; // cast from this far above the wheel, downward
    const RAY_MAX_DIST = RAY_ABOVE + Math.max(this.cfg.reverseGroundThreshold, 2.0) + 1.0;

    if (probeNodes && RAPIER) {
      if (!this._wheelRapierRay) {
        this._wheelRapierRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
      }

      let minClearance = Infinity;
      let anyHit = false;

      for (const node of probeNodes) {
        if (!node) continue;
        node.getWorldPosition(this._scratchWorldPos);

        this._wheelRapierRay.origin.x = this._scratchWorldPos.x;
        this._wheelRapierRay.origin.y = this._scratchWorldPos.y + RAY_ABOVE;
        this._wheelRapierRay.origin.z = this._scratchWorldPos.z;
        this._wheelRapierRay.dir.x = 0;
        this._wheelRapierRay.dir.y = -1;
        this._wheelRapierRay.dir.z = 0;

        // Exclude the plane's own rigid body so the ray doesn't immediately
        // self-hit the wheel/hull collider it's being cast from.
        const hit = this.world.castRay(
          this._wheelRapierRay,
          RAY_MAX_DIST,
          true, // solid — stop at first surface, not just centroid
          undefined,
          undefined,
          undefined,
          this.rigidBody,
        );

        if (hit) {
          anyHit = true;
          const clearance = hit.timeOfImpact - RAY_ABOVE; // distance from wheel down to the surface
          if (clearance < minClearance) minClearance = clearance;
        }
      }

      if (anyHit) {
        this._isGrounded = minClearance <= this.cfg.reverseGroundThreshold;
        return;
      }
      // No physics-world hit under any wheel (shouldn't normally happen
      // while actually resting on something) — fall through to the
      // terrain-heightmap method below as a safety net.
    }

    if (!getTerrainY) {
      this._isGrounded = false;
      return;
    }

    if (probeNodes) {
      let minClearance = Infinity;
      for (const node of probeNodes) {
        if (!node) continue;
        node.getWorldPosition(this._scratchWorldPos);
        const groundY = getTerrainY(this._scratchWorldPos.x, this._scratchWorldPos.z);
        const clearance = this._scratchWorldPos.y - groundY;
        if (clearance < minClearance) minClearance = clearance;
      }
      this._isGrounded = minClearance <= this.cfg.reverseGroundThreshold;
      return;
    }

    // Last-resort fallback — no wheel or gear nodes at all, use the hull's
    // lowest corner (looser threshold since the hull sits above the wheels).
    const pos = this.rigidBody.translation();
    const rot = this.rigidBody.rotation();
    this._groundCheckQuat.set(rot.x, rot.y, rot.z, rot.w);
    const { x: hx, y: hy, z: hz } = this.cfg.hullHalfExtents;
    const colliderYOffset = this.cfg.colliderYOffset ?? 1;

    let minCornerY = Infinity;
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          this._groundCheckCorner
            .set(sx * hx, sy * hy + colliderYOffset, sz * hz)
            .applyQuaternion(this._groundCheckQuat)
            .add(pos);
          if (this._groundCheckCorner.y < minCornerY) minCornerY = this._groundCheckCorner.y;
        }
      }
    }
    const groundY = getTerrainY(pos.x, pos.z);
    this._isGrounded = minCornerY <= groundY + Math.max(this.cfg.reverseGroundThreshold, 2.0);
  }

  // ── Play-zone boundary ───────────────────────────────────────────────────
  // Cheap: one XZ distance-from-center check per frame, no allocations.
  // Starts/advances a countdown while outside the zone; resets it the
  // instant the plane returns; destroys the plane if the timer runs out.
  _checkPlayZone(dt) {
    if (!this.rigidBody || this.isDead) return;

    const pos  = this.rigidBody.translation();
    const half = this.cfg.playZoneHalfSize;
    const outside = Math.abs(pos.x) > half || Math.abs(pos.z) > half;

    if (outside) {
      this._outOfZoneTimer += dt;
      this.isOutOfPlayZone = true;
      this.outOfZoneTimeRemaining = Math.max(0, this.cfg.playZoneGraceTime - this._outOfZoneTimer);

      if (this._outOfZoneTimer >= this.cfg.playZoneGraceTime) {
        this.takeDamage(this.maxHealth); // reuses the normal death pipeline
      }
    } else {
      this._outOfZoneTimer = 0;
      this.isOutOfPlayZone = false;
      this.outOfZoneTimeRemaining = 0;
    }
  }

  // ── Altitude ceiling ─────────────────────────────────────────────────────
  // Cheapest possible clamp: reads translation/linvel (already cached by
  // Rapier, no extra allocation) and only writes back when the plane is
  // actually above the ceiling — zero cost the rest of the time beyond one
  // comparison.
  _clampMaxAltitude() {
    if (!this.rigidBody) return;

    const pos = this.rigidBody.translation();
    if (pos.y <= this.cfg.maxAltitude) return;

    this.rigidBody.setTranslation({ x: pos.x, y: this.cfg.maxAltitude, z: pos.z }, true);

    // Kill any remaining upward velocity so it doesn't keep re-triggering
    // the clamp every frame / fighting the pilot's climb input forever —
    // horizontal speed is left untouched.
    const vel = this.rigidBody.linvel();
    if (vel.y > 0) {
      this.rigidBody.setLinvel({ x: vel.x, y: 0, z: vel.z }, true);
    }
  }

  // ── Main update ───────────────────────────────────────────────────────────

  update(dt, keys, camera, mouse, cycleData = null, getTerrainY = null, invertRoll = false, isScoped = false, onTreeCollision = null) {
    if (this.isDead) {
      // ── Rigid body is already gone (removed immediately in _die()) —
      // the fall is fully hand-animated: manually integrate position via
      // gravity acting on _fallVel, same pattern as the original version,
      // just keeping the forward-glide speed boost and eased nose-down tilt.
      // ── Once the plane has landed (_groundExplosionSpawned), freeze it
      // completely — no more gravity, no more position integration. Without
      // this guard, gravity kept accumulating into _fallVel every frame
      // even after touchdown, and since the ground-clamp check below only
      // ran while NOT yet spawned, nothing stopped the frozen-looking wreck
      // from silently drifting/falling straight through the terrain on
      // subsequent frames.
      if (this._fallVel && !this._groundExplosionSpawned) {
        this._fallVel.y -= FALL_GRAVITY * dt;
        // Bleed off horizontal speed so the plane noses over into a drop
        // instead of gliding forward the whole way down — same as EnemyPlane.
        const dragFactor = Math.max(0, 1 - FALL_DRAG * dt);
        this._fallVel.x *= dragFactor;
        this._fallVel.z *= dragFactor;
        this.bodyGroup.position.addScaledVector(this._fallVel, dt);

        // ── Chaotic multi-axis tumble — pitch, roll, and yaw all spin
        // simultaneously about the wreck's OWN current local axes (not
        // fixed world axes), so the tumble compounds realistically as the
        // orientation changes, rather than always spinning around the same
        // world-space line. Ramps up over _fallTumbleRampDuration so it
        // reads as spinning out of control rather than an instant snap.
        this._fallElapsed = (this._fallElapsed ?? 0) + dt;
        const _rampT = this._fallTumbleRampDuration > 0
          ? Math.min(1, this._fallElapsed / this._fallTumbleRampDuration)
          : 1;

        if (this._fallRollRate || this._fallPitchRate || this._fallYawRate) {
          this.getForwardVector(this._scratchFwd); // roll axis — nose direction
          const _pitchAxis = new THREE.Vector3(0, 0, -1).applyQuaternion(this.bodyGroup.quaternion); // local right
          const _yawAxis   = new THREE.Vector3(0, 1, 0).applyQuaternion(this.bodyGroup.quaternion);  // local up

          this._scratchQ.setFromAxisAngle(this._scratchFwd,  this._fallRollRate  * _rampT * dt);
          this._scratchQ2.setFromAxisAngle(_pitchAxis,        this._fallPitchRate * _rampT * dt);
          this._scratchQ3.setFromAxisAngle(_yawAxis,          this._fallYawRate   * _rampT * dt);

          this.bodyGroup.quaternion
            .premultiply(this._scratchQ)
            .premultiply(this._scratchQ2)
            .premultiply(this._scratchQ3);
        }

        // ── Re-anchor the damage-shader origin/axes to the wreck's CURRENT
        // position/orientation every frame. Without this, the origin stays
        // frozen at the exact instant of death while the mesh keeps moving
        // (falling) and rotating (roll wobble) — the shader's cutoff check
        // is a distance from that frozen origin, so as the mesh drifts away
        // from it, more and more of the mesh ends up beyond the cutoff and
        // gets discarded, reading as the plane progressively vanishing
        // during the fall. Cutoff distance itself stays fixed at the death
        // value — only origin/axes are refreshed.
        this._pushDamageShaderUniforms(this._deathDamageCutoff, this._deathDamageWingCutoff);

        // ── Propeller windmills down gradually rather than stopping dead —
        // reads as the engine spinning freely with no more power driving it.
        if (this._propellerNodes.length > 0) {
          this._propSpinVelocity = Math.max(0, this._propSpinVelocity - 3 * dt); // tune decay rate to taste
          this._propSpinAngle += this._propSpinVelocity * dt;
          const axis = this.cfg.propellerAxis;
          for (const propNode of this._propellerNodes) {
            propNode.rotation[axis] = this._propSpinAngle;
          }
        }

                // ── Tree-knockdown probe — same gating as EnemyPlane: only once
        // the wreck is close to the ground, throttled to ~10Hz.
        if (onTreeCollision && getTerrainY) {
          const _groundY = getTerrainY(this.bodyGroup.position.x, this.bodyGroup.position.z);
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
        
        if (getTerrainY) {
          const groundY = getTerrainY(this.bodyGroup.position.x, this.bodyGroup.position.z);
          if (this.bodyGroup.position.y <= groundY + 0.5) {
            this.bodyGroup.position.y = groundY + 0.5;
            this._fallVel.set(0, 0, 0);
            this._groundExplosionSpawned = true;

            const impactPos = this.bodyGroup.position.clone();
            this.explosionSystem?.spawn(impactPos.clone());

            // ── Play the crash-explosion sound, if main.js has wired one
            // up. explosionSystem.spawn() above is visual-only.
            this.onGroundExplosion?.(impactPos.clone(), 'impact');

            setTimeout(() => {
              const off = new THREE.Vector3(
                (Math.random() - 0.5) * 1.5,
                0.3,
                (Math.random() - 0.5) * 1.5
              );
              this.explosionSystem?.spawn(impactPos.clone().add(off));
            }, 200);

            // ── Stop the damage smoke now that the plane has actually
            // blown up — the fireball replaces it.
            this.explosionSystem?.stopPlaneDamageSmoke?.(this);
          }
        }
      }

      // ── Keep any already-launched rocket/bomb resolving naturally after
      // death. bulletSystem's tracers are cleared instantly above via
      // clearBeams() (see _die()) since a beam has no further physics to
      // resolve, and flareSystem is likewise cleared instantly via
      // clearAll() (see _die()) — but a rocket or bomb already in flight
      // is a real projectile with its own physics/lifetime. Simply no
      // longer calling .update() on it (as before) freezes it hanging
      // motionless in the air indefinitely — visible straight through the
      // death-hold screen and into spawn-selection — instead of letting it
      // keep falling/flying until it hits something or times out on its own.
      this.rocketSystem?.update(dt);
      this.bombSystem?.update(dt);
      // hispanoSystem's tracers are already snap-cleared in _die() via
      // clearBeams(), so nothing further to tick post-death.

      // ── Kill vortex trails instantly on death rather than leaving a
      // frozen streak hanging in the air where the plane died.
      if (this._vortexMeshes[0]) this._vortexMeshes[0].visible = false;
      if (this._vortexMeshes[1]) this._vortexMeshes[1].visible = false;

      this.waterSplashSystem?.tickIdle(dt);

      this.explosionSystem?.update(dt, camera, this.renderer);

      // ── Camera shake decay must also run while dead/falling — the
      // killing blow calls takeDamage() → _triggerCameraShake() in the
      // SAME frame _die() flips isDead to true, so the alive-path shake
      // decay block below (which normally computes _shakeOffset every
      // frame) never gets a chance to run for that hit. Without this,
      // the death-blow shake is armed but never actually applied.
      if (this._shakeElapsed !== undefined && this._shakeElapsed < this._shakeDuration) {
        this._shakeElapsed += dt;
        const t        = this._shakeElapsed / this._shakeDuration;
        const envelope = Math.pow(1 - t, 2);
        const offsetX  = Math.sin(this._shakeElapsed * this._shakeFrequency * Math.PI * 2) * this._shakeIntensity * envelope;
        const offsetY  = Math.cos(this._shakeElapsed * this._shakeFrequency * Math.PI * 1.7) * this._shakeIntensity * 0.5 * envelope;
        this._shakeOffset.set(offsetX, offsetY, 0);
      } else {
        this._shakeOffset.set(0, 0, 0);
      }

      return;
    }

    if (!this.rigidBody) return;

    this._updateGroundedState(getTerrainY);
    this.applyInput(keys, dt, invertRoll);
    this._updateFlightPhysics(dt);
    this._clampMaxAltitude();
    this._checkPlayZone(dt);
    if (this._wheelSmokeCooldown > 0) this._wheelSmokeCooldown = Math.max(0, this._wheelSmokeCooldown - dt);
    if (getTerrainY) this._checkGroundCollision(dt, getTerrainY);

    // ── Render transform ─────────────────────────────────────────────────
    const pos = this._renderPos;
    const renderQ = this._scratchQ2.copy(this._renderQuat);

    this.bodyGroup.position.copy(pos);
    this.bodyGroup.quaternion.copy(renderQ);

    // ── Propeller spin — always spins proportional to throttle, never stops
    // dead so it doesn't look frozen mid-air. All propellers share the same
    // angle/axis — spin them in lockstep unless per-prop tuning is added later. ──
    if (this._propellerNodes.length > 0) {
      this._propSpinAngle += (0.4 + this.throttle) * this.cfg.propellerMaxSpeed * dt;
      const axis = this.cfg.propellerAxis;
      for (const propNode of this._propellerNodes) {
        propNode.rotation[axis] = this._propSpinAngle;
      }
    }
    // ── Control-surface trembling — computed here (before the animation
    // block below) so this frame's angle is used immediately, not delayed
    // a frame like the turbulence values computed later in update().
    this._updateControlSurfaceTremble(dt);

    // ── Control surface animation — purely cosmetic, mirrors input ─────────
    // Each surface rotates from its authored (base) local quaternion by a
    // delta angle around its configured local axis — NOT a raw .rotation.x/y/z
    // write, so it works regardless of how the node's rest orientation was
    // authored in Blender. Ailerons move opposite to each other (roll);
    // elevators move together (pitch); rudder alone handles yaw. The tremble
    // angle (0 unless critically damaged) is simply added on top.
    const maxA = this.cfg.controlSurfaceMaxAngle;
    const aileronAxisVec  = this._csAxisVecFor(this.cfg.aileronAxis);
    const elevatorAxisVec = this._csAxisVecFor(this.cfg.elevatorAxis);
    const rudderAxisVec   = this._csAxisVecFor(this.cfg.rudderAxis);

    this._applyControlSurfaceRotation(this._aileronL, this._aileronLBaseQ, aileronAxisVec,  this._rollInput * maxA + this._aileronTrembleAngle);
    this._applyControlSurfaceRotation(this._aileronR, this._aileronRBaseQ, aileronAxisVec, -this._rollInput * maxA - this._aileronTrembleAngle);
    this._applyControlSurfaceRotation(this._elevatorL, this._elevatorLBaseQ, elevatorAxisVec, this._pitchInput * maxA + this._elevatorTrembleAngle);
    this._applyControlSurfaceRotation(this._elevatorR, this._elevatorRBaseQ, elevatorAxisVec, this._pitchInput * maxA + this._elevatorTrembleAngle);
    for (let i = 0; i < this._rudderNodes.length; i++) {
      this._applyControlSurfaceRotation(this._rudderNodes[i], this._rudderBaseQs[i], rudderAxisVec, this._yawInput * maxA + this._rudderTrembleAngle);
    }

    // ── Flaps — deploy as throttle drops below flapThrottleThreshold, fully
    // out at throttle 0; retract smoothly again as throttle climbs back up.
    // Holding "S" (backward) forces flaps FULLY deployed regardless of
    // current throttle — e.g. for a steeper approach/braking configuration
    // even if throttle hasn't yet decayed down near the threshold.
    const flapThreshold = this.cfg.flapThrottleThreshold;
    const throttleFlapTarget = this.throttle < flapThreshold
      ? THREE.MathUtils.clamp((flapThreshold - this.throttle) / flapThreshold, 0, 1)
      : 0;
    const targetFlapDeploy = this._backwardHeld ? 1 : throttleFlapTarget;
    this._flapDeploy = THREE.MathUtils.lerp(
      this._flapDeploy,
      targetFlapDeploy,
      Math.min(1, dt * this.cfg.flapSpeed)
    );
    const flapAxisVec = this._csAxisVecFor(this.cfg.flapAxis);
    // Same sign on both sides — flaps deploy together, unlike ailerons which mirror.
    this._applyControlSurfaceRotation(this._flapL, this._flapLBaseQ, flapAxisVec, -this._flapDeploy * this.cfg.flapMaxAngle);
    this._applyControlSurfaceRotation(this._flapR, this._flapRBaseQ, flapAxisVec, -this._flapDeploy * this.cfg.flapMaxAngle);

    // ── Leading-edge flaps (slats) — share the same _flapDeploy timing as
    // the trailing-edge flaps above (both edges extend/retract together,
    // matching real slat/flap systems), but on their own configurable axis
    // and deflection magnitude since a leading-edge droop is usually a
    // different angle/axis than the trailing-edge flap.
    //
    // On top of that base droop, the slats now also react to pitch input
    // directly, rotating OPPOSITE to the elevator's own deflection — e.g.
    // elevator up (positive pitchInput * maxA) → slats rotate the other
    // way. Uses the same maxA magnitude as the elevator so the two read as
    // a mirrored pair, and the same tremble angle (negated) so low-health
    // shake stays consistent across both surfaces.
    const leadingEdgeFlapAxisVec = this._csAxisVecFor(this.cfg.leadingEdgeFlapAxis);
    const leadingEdgePitchReaction = -(this._pitchInput * maxA + this._elevatorTrembleAngle);
    this._applyControlSurfaceRotation(
      this._leadingEdgeFlapL, this._leadingEdgeFlapLBaseQ, leadingEdgeFlapAxisVec,
      -this._flapDeploy * this.cfg.leadingEdgeFlapMaxAngle + leadingEdgePitchReaction
    );
    this._applyControlSurfaceRotation(
      this._leadingEdgeFlapR, this._leadingEdgeFlapRBaseQ, leadingEdgeFlapAxisVec,
      -this._flapDeploy * this.cfg.leadingEdgeFlapMaxAngle + leadingEdgePitchReaction
    );

    // ── Thrust-vectoring nozzle gimbal — purely cosmetic, mirrors input
    // the same way the control surfaces do.
    this._updateNozzleGimbal(dt);
    // ── Nozzle exit-area breathing — throttle-driven radial scale.
    this._updateNozzleArea(dt);

    // ── Landing gear + door animation ───────────────────────────────────
    // Door rest state tracks gear position directly: gear UP → door CLOSED,
    // gear DOWN → door OPEN (matches your real aircraft, and the GLB's
    // authored pose = open = gear-down state, so no motion needed there).
    // Only ONE door-motion phase happens per direction — no open-close-open
    // dance, since the door's start/end states already match the gear's:
    //   EXTENDING (T 0→1): door opens FIRST (over doorPhaseFractions[0] of
    //     the travel), then gear extends while door stays open the rest of
    //     the way — door is already correctly open once gear finishes.
    //   RETRACTING (T 1→0): gear retracts FIRST (door stays open, since it
    //     was already open at T=1), then door closes over the LAST
    //     doorPhaseFractions[1] of the travel, once gear is fully up.
    {
      const gearTarget = this._landingGearDown ? 1 : 0;
      const step = dt / Math.max(0.0001, this.cfg.landingGearTransitionDuration);
      if (this._landingGearT < gearTarget) {
        this._landingGearT = Math.min(gearTarget, this._landingGearT + step);
      } else if (this._landingGearT > gearTarget) {
        this._landingGearT = Math.max(gearTarget, this._landingGearT - step);
      }

      const [extendOpenFrac, retractCloseFrac] = this.cfg.doorPhaseFractions;
      const isExtending = gearTarget === 1;
      const startT  = isExtending ? 0 : 1;
      const travel  = Math.abs(this._landingGearT - startT); // 0..1, direction-agnostic

      // doorOpen: 0 = closed, 1 = open (authored/base pose)
      let doorOpen;
      let gearBlendT; // 0(up)..1(down) — same space _landingGearUpQuats/BaseQuats slerp uses

      if (isExtending) {
        // Phase A: door closed→open over [0, extendOpenFrac]. Phase B: door
        // stays open while gear moves over the remaining travel.
        if (travel < extendOpenFrac) {
          doorOpen   = extendOpenFrac > 0 ? travel / extendOpenFrac : 1;
          gearBlendT = 0; // gear hasn't started moving yet
        } else {
          doorOpen = 1;
          const moveFrac = Math.max(0.0001, 1 - extendOpenFrac);
          gearBlendT = THREE.MathUtils.clamp((travel - extendOpenFrac) / moveFrac, 0, 1);
        }
      } else {
        // Phase A: door stays open while gear moves over [0, 1-retractCloseFrac].
        // Phase B: door open→closed over the final retractCloseFrac.
        const moveFrac = Math.max(0.0001, 1 - retractCloseFrac);
        if (travel < moveFrac) {
          doorOpen   = 1;
          gearBlendT = 1 - THREE.MathUtils.clamp(travel / moveFrac, 0, 1);
        } else {
          gearBlendT = 0; // gear fully retracted
          const closeProgress = retractCloseFrac > 0 ? (travel - moveFrac) / retractCloseFrac : 1;
          doorOpen = 1 - THREE.MathUtils.clamp(closeProgress, 0, 1);
        }
      }
      doorOpen = THREE.MathUtils.clamp(doorOpen, 0, 1);

      const _doorAnimCount = Math.max(this._landingGearNodes.length, this._doorLNodes.length, this._doorRNodes.length);
      for (let i = 0; i < _doorAnimCount; i++) {
        const node = this._landingGearNodes[i] ?? null;
        if (node) {
          node.quaternion.copy(this._landingGearUpQuats[i]).slerp(this._landingGearBaseQuats[i], gearBlendT);
        }

        const doorL = this._doorLNodes[i];
        if (doorL) {
          // doorOpen=0 → closed (computed), doorOpen=1 → open (authored base)
          doorL.quaternion.copy(this._doorLClosedQuats[i]).slerp(this._doorLBaseQuats[i], doorOpen);
        }
        const doorR = this._doorRNodes[i];
        if (doorR) {
          doorR.quaternion.copy(this._doorRClosedQuats[i]).slerp(this._doorRBaseQuats[i], doorOpen);
        }
      }

      // ── Extend_Doors — hidden only while actively mid-transition (not
      // idle at either end), visible otherwise.
      if (this._extendDoorsNode) {
        const isTransitioning = this._landingGearT > 0 && this._landingGearT < 1;
        this._extendDoorsNode.visible = !isTransitioning;
      }

      // ── Rebuild wheel colliders once the gear has fully finished
      // extending — this is the moment the wheel nodes actually reach
      // their correct "gear down" world position. Guarded by an empty
      // colliders array so this only fires once per extension (not every
      // frame while sitting on the ground with gear already down).
      if (this._landingGearDown && this._landingGearT >= 1 && this._wheelColliders.length === 0) {
        this.bodyGroup.updateMatrixWorld(true);
        this._rebuildWheelColliders();
      }
    }

    // ── Weapons systems tick ────────────────────────────────────────────────
    this.bulletSystem.update(dt);
    this.rocketSystem.update(dt);
    this.bombSystem.update(dt);
    this.flareSystem.update(dt);
    this.hispanoSystem?.update(dt);
    if (this._flareReloadTimer > 0) this._flareReloadTimer = Math.max(0, this._flareReloadTimer - dt);
    this.explosionSystem.update(dt, camera, this.renderer);
    this._updateAiGuns(dt); // AI turret guns — independent of player input, runs every alive frame

    // ── Wingtip vortices — speed/AoA/G-force driven trailing ribbons ─────
    this._updateWingtipVortices(dt);

    // ── Water-spray particles — fades in as the plane nears the water
    // surface, fades out climbing away. cycleData already carries
    // waterEnabled/waterY for the tank's dust system (see tank.js's
    // dustSystem.update call) — reused here the same way.
    this.waterSplashSystem?.update(dt, cycleData);

    // ── Aerodynamic condensation vapor — Low_Pressure_1/2, hard-G turns only
    this._updateAerodynamicCondensation(dt);

    // ── Jet propulsion (afterburner flame + shockwave visuals) ───────────
    this._updatePropulsion(dt, cycleData?.elapsed ?? 0);

    // ── Health-driven shader damage stripping (no extra geometry) ────────
    this._updateDamageShaderUniforms();

    // ── Camera shake decay (damage-hit impulse) ──────────────────────────────
    if (this._shakeElapsed !== undefined && this._shakeElapsed < this._shakeDuration) {
      this._shakeElapsed += dt;
      const t = this._shakeElapsed / this._shakeDuration;
      const envelope = Math.pow(1 - t, 2);
      const offsetX = Math.sin(this._shakeElapsed * this._shakeFrequency * Math.PI * 2) * this._shakeIntensity * envelope;
      const offsetY = Math.cos(this._shakeElapsed * this._shakeFrequency * Math.PI * 1.7) * this._shakeIntensity * 0.5 * envelope;
      this._hitShakeOffset.set(offsetX, offsetY, 0);
    } else {
      this._hitShakeOffset.set(0, 0, 0);
    }

    // ── Weapon-fire recoil shake decay — its own envelope/frequency,
    // separate from the damage-hit shake above, so a rapid MG burst reads
    // as a distinct stutter on top of (not instead of) any concurrent hit-shake.
    if (this._fireShakeElapsed !== undefined && this._fireShakeElapsed < this._fireShakeDuration) {
      this._fireShakeElapsed += dt;
      const ft = this._fireShakeElapsed / this._fireShakeDuration;
      const fEnvelope = Math.pow(1 - ft, 2);
      const fOffsetX = Math.sin(this._fireShakeElapsed * this._fireShakeFrequency * Math.PI * 2 + 1.3) * this._fireShakeIntensity * fEnvelope;
      const fOffsetY = Math.cos(this._fireShakeElapsed * this._fireShakeFrequency * Math.PI * 2.3) * this._fireShakeIntensity * 0.6 * fEnvelope;
      this._fireShakeOffset.set(fOffsetX, fOffsetY, 0);
    } else {
      this._fireShakeOffset.set(0, 0, 0);
    }

    // ── Low-health turbulence (continuous, independent of hit-shake) ─────────
    this._updateLowHealthTurbulence(dt, isScoped);

    // ── Gear-down + high-throttle turbulence (continuous, independent of
    // both hit-shake and low-health turbulence — all three can stack) ────────
    this._updateGearTurbulence(dt, isScoped);

    // ── Combined offset — this is what main.js actually reads/applies ────────
    this._shakeOffset.set(
      this._hitShakeOffset.x + this._fireShakeOffset.x + this._turbulenceOffset.x + this._gearTurbulenceOffset.x,
      this._hitShakeOffset.y + this._fireShakeOffset.y + this._turbulenceOffset.y + this._gearTurbulenceOffset.y,
      0
    );
  }
  // ── Weapons fire ──────────────────────────────────────────────────────────

  /**
   * @param {Function|null} enemyResolver
   * @param {THREE.Vector3|null} aimWorldPos — live cursor-tracked aim point
   *   in world space (from main.js's updatePlaneCursorAim). When provided,
   *   the MG fires toward this point instead of the raw gun-point forward
   *   direction, same idea as the tank's free-aim crosshair.
   */
  fire(enemyResolver = null, aimWorldPos = null) {
    if (this.isDead || !this.rigidBody) return;

    if (this.activeWeapon === 1) {
      if (this.mgAmmo <= 0) return;
      if (this._gunType === 3) {
        // MultiGunSystem.fire signature: (rigidBody, onFire, onRecoil, overrideDir, isMG, enemyResolver, aimWorldPos)
        this.bulletSystem?.fire(this.rigidBody, null, null, null, false, enemyResolver, aimWorldPos);
      } else {
        // MachineGunSystem.fire signature: (rigidBody, enemyResolver, onFire, aimWorldPos)
        this.bulletSystem?.fire(this.rigidBody, enemyResolver, () => {}, aimWorldPos);
      }
      this.triggerFireShake('mg');
      return;
    }

    if (this.activeWeapon === 2) {
      if (this.rocketAmmo <= 0) return;
      if (!this.rocketSystem?.isReady) return;
      this.rocketSystem.fire(this.rigidBody, enemyResolver, aimWorldPos);
      this.rocketAmmo--;
      this.triggerFireShake('rocket');
      return;
    }

    if (this.activeWeapon === 3) {
      if (this.bombAmmo <= 0) return;
      if (!this.bombSystem?.isReady) return;
      // Dropped with zero inherited velocity — bombs fall straight down
      // from the drop point instead of continuing to travel forward at
      // the plane's airspeed (which read as the bomb staying glued to
      // the plane while falling).
      this.bombSystem.drop(this.rigidBody, { x: 0, y: 0, z: 0 }, enemyResolver);
      this.bombAmmo--;
      this.triggerFireShake('bomb');
      return;
    }

    if (this.activeWeapon === 4) {
      this.deployFlares();
      return;
    }

    if (this.activeWeapon === 6) {
      if (!this.hasHispano || !this.hispanoSystem?.isReady) return;
      // HispanoBulletSystem.fire signature matches MultiGunSystem's:
      // (rigidBody, onFire, onRecoil, overrideDir, isMG, enemyResolver, aimWorldPos)
      this.hispanoSystem.fire(this.rigidBody, null, null, null, false, enemyResolver, aimWorldPos);
      this.triggerFireShake('hispano');
      return;
    }
  }

  /** Releases a burst of flares from the tail of the plane. Exposed as its
   * own method (rather than folded only into fire()) so main.js can bind a
   * dedicated flare key instead of routing it through the weapon-slot
   * cycle, if preferred — both call the same logic either way. */
  deployFlares() {
    if (this.isDead || !this.rigidBody) return;
    if (this.flareAmmo <= 0) return;
    if (this._flareReloadTimer > 0) return;

    const count = Math.min(this.cfg.flareCount, this.flareAmmo);
    this.getForwardVector(this._scratchFwd);
    this._scratchUp.set(0, 1, 0).applyQuaternion(this.bodyGroup.quaternion);
    const vel = this.rigidBody.linvel();

    this.bodyGroup.getWorldPosition(this._scratchWorldPos);
    // Nudge the release point slightly behind/below the fuselage rather
    // than dead-center, so flares visually originate from the tail.
    this._scratchWorldPos.addScaledVector(this._scratchFwd, -1.5);
    this._scratchWorldPos.y -= 0.3;

    // Re-invoked every time a STAGGERED flare in this burst actually
    // activates (see FlareSystem.deploy's getLiveState param). Uses fresh
    // THREE.Vector3s here — NOT this._scratchFwd/_scratchWorldPos, which
    // are shared/reused every frame elsewhere in this class and would
    // already hold unrelated values by the time a delayed flare fires.
    const getLiveFlareState = () => {
      const fwd = new THREE.Vector3();
      this.getForwardVector(fwd);
      const origin = new THREE.Vector3();
      this.bodyGroup.getWorldPosition(origin);
      origin.addScaledVector(fwd, -1.5);
      origin.y -= 0.3;
      const liveVel = this.rigidBody
        ? this.rigidBody.linvel()
        : { x: 0, y: 0, z: 0 };
      return { origin, forward: fwd, vel: liveVel };
    };

    this.flareSystem.deploy(
      this._scratchWorldPos,
      this._scratchFwd,
      this._scratchUp,
      vel,
      count,
      getLiveFlareState,
    );
    this.onFlareDeploy?.();

    this.flareAmmo -= count;
    this._flareReloadTimer = this.cfg.flareReload;
  }

  /**
   * Press/release entry point for rocket auto-fire, meant to be called from
   * main.js's mousedown/mouseup (or key-held) handlers for weapon slot 2,
   * instead of calling fire() repeatedly on an interval externally.
   * No-ops (and internally stops any active auto-fire) unless
   * this.cfg.rocketAuto is true and rockets are the active weapon.
   *
   * @param {boolean}       held
   * @param {Function|null} enemyResolver
   * @param {Function|null} getAimWorldPos — () => THREE.Vector3|null, re-evaluated每 auto-shot
   */

    /** Returns this plane's currently active flare decoy points, in the shape
   * RocketSystem.update()'s homing-diversion check expects:
   * target.getActiveFlareDecoys?.() → [{ x, y, z, strength }] | null.
   * Thin passthrough to FlareSystem.getDecoyPositions() — without this,
   * a guided rocket locked onto this plane can never be fooled by flares,
   * since rocket.js calls this exact method name on the locked target. */
  getActiveFlareDecoys() {
    return this.flareSystem?.getDecoyPositions() ?? null;
  }

  setRocketFireHeld(held, enemyResolver = null, getAimWorldPos = null) {
    if (!this.rocketSystem) return;

    if (!this.cfg.rocketAuto || this.activeWeapon !== 2 || this.isDead || !this.rigidBody) {
      this.rocketSystem.setAutoFireHeld(false);
      return;
    }

    if (held && this.rocketAmmo <= 0) {
      this.rocketSystem.setAutoFireHeld(false);
      return;
    }

    this.rocketSystem.setAutoFireHeld(held, this.rigidBody, enemyResolver, getAimWorldPos);
  }

  // ── Dispose / respawn ──────────────────────────────────────────────────────

  dispose() {
    this.bulletSystem?.dispose();
    this.rocketSystem?.dispose();
    this.bombSystem?.dispose();
    this.flareSystem?.dispose();
    this.hispanoSystem?.dispose();
    this.explosionSystem?.dispose();
    this.waterSplashSystem?.stop();
    this._disposeWheelColliders();
    this._disposeAiGuns();
    if (this.rigidBody) {
      this.world.removeRigidBody(this.rigidBody);
      this.rigidBody = null;
    }
    this._disposeWingtipVortices();
    this._disposeJetPropulsion();
    this.scene.remove(this.bodyGroup);
  }

  respawn(position = { x: 0, y: 80, z: 0 }) {
    if (!this.isDead) return;

    this._buildPhysics(this.world, position);

    this._prevPos.set(position.x, position.y, position.z);
    this._renderPos.set(position.x, position.y, position.z);
    this._prevQuat.identity();
    this._renderQuat.identity();

    this.health  = this.maxHealth;
    this.armour  = this.maxArmour;
    this.isDead  = false;
    this._readyToShowDeath = false;
    this._deathScreenShown = false;
    this._shakeOffset.set(0, 0, 0);
    this.throttle = this.cfg.initialThrottle;
    this.airspeed = this.cfg.minSpeed + this.throttle * (this.cfg.maxSpeed - this.cfg.minSpeed);
    this._pitchInput = 0;
    this._rollInput  = 0;
    this._yawInput   = 0;
    this.autopilotEnabled = false;
    this._fallVel = null;
    this._fallAngVel = null;
    this._groundCollisionGrace = 1.5; // ← reset grace window on every respawn
    this._outOfZoneTimer        = 0;
    this.isOutOfPlayZone        = false;
    this.outOfZoneTimeRemaining = 0;

    // ── Reset ammo back to the original loadout-resolved counts —
    // without this, a plane redeployed after death keeps whatever
    // depleted ammo it had at the moment it died.
    this.mgAmmo     = this._initialMgAmmo;
    this.rocketAmmo = this._initialRocketAmmo;
    this.bombAmmo   = this._initialBombAmmo;
    this.flareAmmo  = this._initialFlareAmmo;
    this._flareReloadTimer = 0;

    // ── Hispano — reset the STILL-LIVE system (from the life that just
    // ended) immediately, rather than relying solely on _loadHullModel()'s
    // async reload to rebuild a fresh HispanoBulletSystem later this same
    // call. Without this, there's a window between respawn() starting and
    // the new model finishing where this.hispanoSystem still points at the
    // OLD, depleted instance — any HUD read in that window would show
    // stale ammo instead of the reset value.
    if (this.hispanoSystem) {
      this.hispanoSystem.setMagSize(this._initialHispanoMagSize);
      this.hispanoSystem.setTotalAmmo(this._initialHispanoAmmo);
      this.hispanoSystem._reloading = false;
      this.hispanoSystem._reloadTimer = 0;
    }

    this.bulletSystem?.setRigidBody?.(this.rigidBody);
    this.rocketSystem?.setRigidBody?.(this.rigidBody);
    this.bombSystem?.setRigidBody?.(this.rigidBody);

    this.bodyGroup.clear();
    this.bodyGroup.rotation.set(0, 0, 0);

    // ── The old water-spray anchor was a child of bodyGroup (just cleared
    // above) and held a reference to the OLD, now-removed rigid body —
    // rebuild fresh against the new one instead of trying to re-point it.
    this.waterSplashSystem?.stop();
    this.waterSplashSystem = new PlaneWaterSplash(this.scene, this.bodyGroup, this.rigidBody, {
      anchorLocalY: -(this.cfg.hullHalfExtents?.y ?? 0.5),
      maxHeight: this.cfg.waterSplashMaxHeight,
      minHeight: this.cfg.waterSplashMinHeight,
    });

    // ── Re-engage autopilot on respawn too, same as initial spawn —
    // respects the same map-config flag ──────────────────────────────
    if (this.cfg.initialAutopilotOn) {
      this.toggleAutopilot();
    }
    this._propellerNodes = [];
    this._pilotNode = null;
    this._aileronL = null;
    this._aileronR = null;
    this._elevatorL = null;
    this._elevatorR = null;
    this._rudderNodes = []; // Rudder_1, Rudder_2, ... (or single "Rudder", index 0)
    this._flapL = null;
    this._flapR = null;
    this._leadingEdgeFlapL = null;
    this._leadingEdgeFlapR = null;

    this._landingGearNodes     = [];
    this._wheelNodes           = [];
    this._landingGearBaseQuats = [];
    this._landingGearUpQuats   = [];
    this._landingGearDown = this.cfg.landingGearDown;   // every fresh life starts per the map config
    this._landingGearT    = this._landingGearDown ? 1 : 0;
    this._wheelColliders  = [];     // old rigid body (and its colliders) is already gone — just clear the list

    // Nozzle refs belong to the OLD (discarded) mesh hierarchy — nulled so
    // _loadHullModel() re-captures fresh ones from the newly loaded GLB.
    this._nozzleNodes       = [];
    this._nozzleBaseQuats   = [];
    this._nozzleCurrentQuat = [];
    this._nozzleBaseScales  = [];
    this._nozzleAreaScale   = [];
    this._nozzleTaperMaterials = [];
    this._nozzleAxialMin = [];
    this._nozzleAxialMax = [];

    // Door refs belong to the OLD (discarded) mesh hierarchy — must be
    // nulled so _loadHullModel() re-captures fresh ones from the newly
    // loaded GLB, same reasoning as the aileron/elevator/rudder base quats below.
    this._doorLNodes      = [];
    this._doorRNodes      = [];
    this._doorLBaseQuats   = [];
    this._doorRBaseQuats   = [];
    this._doorLClosedQuats = [];
    this._doorRClosedQuats = [];
    this._extendDoorsNode  = null;

    // ── Condensation nodes belong to the OLD mesh hierarchy — cleared so
    // _loadHullModel() re-captures fresh ones; intensity/accumulators reset
    // so a respawn doesn't inherit stale mid-turn vapor state.
    this._condensationNodes           = [null, null];
    this._condensationIntensity       = 0;
    this._condensationEmitAccum       = [0, 0];
    this._scratchTurnAxisPrevFwdValid = false;
        // ── Jet propulsion nodes/rigs belong to the OLD mesh hierarchy —
    // dispose and let _loadHullModel() rebuild fresh ones for the new life.
    this._disposeJetPropulsion();

        // Old GLB's AI_Gun_N nodes/systems are gone with bodyGroup.clear()
    // above — _loadHullModel() rebuilds fresh ones for the new life.
    // NOTE: _disposeAiGuns() also clears _aiGunTotalAmmo/_aiGunWasReloading —
    // without that, ammo totals from the previous life leaked into this one
    // (see _disposeAiGuns() definition).
    this._disposeAiGuns();

    // ── Clear GLB-populated weapon/scope references from the OLD model —
    // bodyGroup.clear() above already discarded the old mesh hierarchy,
    // but these fields still hold dangling references to it until
    // _loadHullModel() finishes and repopulates them. Without nulling
    // scopePoint here, main.js's `if (plane.scopePoint)` check in
    // confirmSpawnSelection() sees a stale (truthy but detached) node and
    // skips setting up the watcher that waits for the fresh one — leaving
    // the scope camera following a dead object on every life after the first.
    this.scopePoint = null;
    this.bombPoint = null; // ← stale reference to the OLD model's BombPoint — re-captured in _loadHullModel()
    this._damageShaderMaterials = [];

    // Base quaternions belong to the OLD (now-discarded) mesh instances —
    // must be nulled so _loadHullModel() re-captures fresh ones from the
    // newly loaded GLB rather than reusing stale quaternion objects.
    this._aileronLBaseQ  = null;
    this._aileronRBaseQ  = null;
    this._elevatorLBaseQ = null;
    this._elevatorRBaseQ = null;
    this._rudderBaseQs   = [];
    this._flapLBaseQ     = null;
    this._flapRBaseQ     = null;
    this._flapDeploy     = 0;

    this._loadHullModel().catch((err) => {
      console.error('[Plane] respawn: hull model failed to reload:', err);
    });
  }

  // ── Forward-heading vector — same convention main.js already uses for the
  // chase camera / compass (bodyGroup's local -X axis). This is the direction
  // the plane is actually flying/pointing, which is what rockets follow.
  // GunPoint_1/2's own local rotation does NOT reliably match this, which is
  // why relying on their getWorldDirection() gave a wrong gun/crosshair aim —
  // use this instead anywhere "where the nose points" is needed.
  getForwardVector(target = new THREE.Vector3()) {
    if (!this.bodyGroup) return target.set(0, 0, -1);
    return target.set(-1, 0, 0).applyQuaternion(this.bodyGroup.quaternion);
  }

  /** Shows/hides the Pilot mesh — called by ScopeSystem on scope enter/exit
   * so the first-person scope view doesn't render the pilot's own head/body
   * blocking the camera. */
  setPilotVisible(visible) {
    if (this._pilotNode) this._pilotNode.visible = visible;
  }

  // ── Propeller world position — used by main.js's damage-fire effect so
  // the smoke/fire visually originates from the propeller/engine instead
  // of the hull center. Falls back to bodyGroup's own position if the
  // propeller node hasn't loaded yet (e.g. GLB still mid-reload after a
  // respawn), so the fire has somewhere sane to spawn either way.
  //
  // An optional local-space offset (this.cfg.damageSmokeOffset) is applied
  // on top, rotated into world space by the plane's current orientation,
  // so the smoke source can be nudged (e.g. up/back from the propeller)
  // without hardcoding a node position in the model.
  getPropellerWorldPosition(target = new THREE.Vector3()) {
    if (this._propellerNodes.length > 0) {
      // Multi-prop planes: use the first propeller as the smoke/fire
      // origin reference point. If you want smoke centered between
      // multiple engines instead, this is the spot to average positions.
      this._propellerNodes[0].getWorldPosition(target);
    } else if (this.bodyGroup) {
      this.bodyGroup.getWorldPosition(target);
    } else {
      return target.set(0, 0, 0);
    }

    const off = this.cfg.damageSmokeOffset;
    if (off && (off.x || off.y || off.z)) {
      this._scratchWorldPos.set(off.x ?? 0, off.y ?? 0, off.z ?? 0);
      if (this.bodyGroup) {
        this._scratchWorldPos.applyQuaternion(this.bodyGroup.quaternion);
      }
      target.add(this._scratchWorldPos);
    }

    return target;
  }

  isUpsideDown() {
    if (!this.rigidBody) return false;
    const rot = this.rigidBody.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    return up.y < 0.2;
  }
}