// rocket.js — Unguided pod rockets (plane weapon slot 2).
//
// Mirrors ProjectileBulletSystem's pooling/visual pattern from bullet.js:
// flat typed arrays for per-projectile state (zero GC in the hot path),
// an InstancedMesh for the rocket bodies + a glow trail, and a per-frame
// prev→curr segment raycast against the Rapier world for hit detection.
//
// Public surface expected by plane.js:
//   setLaunchPoints(nodes)   — array of THREE.Object3D world-space launch points
//   isReady                 — getter: not reloading + has launch points
//   fire(rigidBody, enemyResolver)
//   update(dt)
//   dispose()
//   invalidateRigidBody(rigidBody)  — optional, called defensively elsewhere

import * as THREE from 'three';
import { RocketTrailSystem } from './rocketTrail.js';

const ROCKET_MAX      = 8;     // simultaneous in-flight rockets
const ROCKET_GRAVITY   = 3;     // mild drop — rockets are largely self-propelled, not ballistic
const ROCKET_LIFETIME  = 2.5;   // seconds before auto-despawn if nothing is hit

// ── Homing guidance tunables (guided: true) ─────────────────────────────
const ROCKET_HOMING_TURN_LERP  = 3.5;  // per-second heading-blend rate — higher = tighter turn radius
const ROCKET_LOCK_CONE_DOT     = 0.85; // cos(angle) — min alignment to launch dir to acquire a lock (~60° half-cone)
const ROCKET_LOCK_MAX_RANGE    = 260;  // metres — max distance to acquire a lock at the moment of firing

// ── Launch direction clamp — keeps the rocket's initial ejection heading
// physically plausible even when aimWorldPos is close/behind/off-axis
// relative to the launch point's actual forward. Guided rockets will still
// steer onto the real target after this initial straight-out launch.
const ROCKET_LAUNCH_CONE_DOT   = 0.7;  // cos(angle) — max allowed deviation from launch-point forward (~45°)

// ── Flare decoy tunables ────────────────────────────────────────────────
const FLARE_DECOY_RADIUS       = 18;   // metres — missile must be within this of a flare to even consider it
const FLARE_DECOY_BASE_CHANCE  = 0.6;  // per-check probability a valid nearby flare actually pulls the lock, scaled by the flare's own strength
const FLARE_DECOY_CHECK_INTERVAL = 0.15; // seconds between decoy checks per rocket — no need to check every frame

const ROCKET_RADIUS = 0.08;  // no longer drives geometry directly (shape comes from the GLB mesh below) — kept in case other code reads it
const ROCKET_LENGTH = 0.9;

// ── Rocket body visual — exact geometry extracted from rocket.glb ──────────
// Source model is nose-up along +Y: base at y=0, tip at y≈24.1816.
// We center it on its own midpoint, uniformly scale so the overall length
// matches ROCKET_LENGTH, then rotate +X 90° so the local +Z axis becomes
// "nose forward" — same convention the old CylinderGeometry used, and what
// _rocketFwd = (0,0,1) expects for velocity-aligned orientation in update().

// ── Merged geometry — 15 unique vertices, 16 real triangles. The raw GLB
// export had 48 duplicated vertices and 24 triangles, but 8 of those
// triangles were zero-area filler (duplicate-apex artifacts from Blender's
// triangulation) and most vertices were flat-shading duplicates of the
// same 15 physical points. Welded here; see chat for the per-vertex
// breakdown (8 box corners + 1 nose apex + 2×(corner,corner,apex) fins).
const _rocketGlbPositions = new Float32Array([
  -0.461295,0.000000, 0.461295,   // 0  box corner A
  -0.461295,19.742140, 0.461295,  // 1  box corner B
  -0.461295,0.000000,-0.461295,   // 2  box corner C
  -0.461295,19.742140,-0.461295,  // 3  box corner D
   0.461295,0.000000, 0.461295,   // 4  box corner E
   0.461295,19.742140, 0.461295,  // 5  box corner F
   0.461295,0.000000,-0.461295,   // 6  box corner G
   0.461295,19.742140,-0.461295,  // 7  box corner H
   0.000000,24.181581, 0.000000,  // 8  nose apex I
  -1.771758,0.409611, 1.771758,   // 9  fin1 corner J
   1.771758,0.409611,-1.771758,   // 10 fin1 corner K
   0.000000,5.420898, 0.000000,   // 11 fin1 apex L
   1.771758,0.409611, 1.771757,   // 12 fin2 corner M
  -1.771758,0.409611,-1.771757,   // 13 fin2 corner N
   0.000000,5.420898, 0.000000,   // 14 fin2 apex O (same point as L, kept separate — unconnected triangle)
]);

const _rocketGlbIndices = [
  0,1,3,   0,3,2,   2,3,7,   2,7,6,    // box sides
  6,7,5,   6,5,4,   4,5,1,   4,1,0,
  2,6,4,   2,4,0,                       // bottom cap
  3,1,8,   1,5,8,   7,3,8,   5,7,8,     // nose cone sides
  9,10,11,                              // fin blade 1 (single triangle)
  12,13,14,                             // fin blade 2 (single triangle)
];

const _rocketGeo = new THREE.BufferGeometry();
_rocketGeo.setAttribute('position', new THREE.BufferAttribute(_rocketGlbPositions, 3));
_rocketGeo.setIndex(_rocketGlbIndices);
_rocketGeo.computeVertexNormals(); // populate a normal attribute (required by MeshStandardMaterial)

const _ROCKET_GLB_HEIGHT = 24.181581;              // tip y − base y in the source mesh
const _rocketGlbScale    = ROCKET_LENGTH / _ROCKET_GLB_HEIGHT;

_rocketGeo.translate(0, -_ROCKET_GLB_HEIGHT * 0.5, 0);                      // center on its own midpoint (old CylinderGeometry was centered too)
_rocketGeo.scale(_rocketGlbScale, _rocketGlbScale, _rocketGlbScale);        // fit ROCKET_LENGTH
_rocketGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));    // Y-up model → Z-forward

const _rocketMat = new THREE.MeshStandardMaterial({
  color:             0x333333,
  emissive:          0x333333,
  emissiveIntensity: 1,
  flatShading:       true,
});

// ── Exhaust glow trail — stretched, additive ─────────────────────────────────
const TRAIL_LENGTH = 2.4;
const TRAIL_RADIUS = 0.09;

const _rocketDummy = new THREE.Object3D();
const _zeroMatrix  = new THREE.Matrix4().makeScale(0, 0, 0);
const _rocketFwd   = new THREE.Vector3(0, 0, 1);

// ─────────────────────────────────────────────────────────────────────────────

export class RocketSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object}      world           — Rapier world (.__RAPIER__ set)
   * @param {object}      explosionSystem
   * @param {object}      opts            — { damage, speed, reload }
   */
  constructor(scene, world, explosionSystem, opts = {}) {
    this.scene           = scene;
    this.world            = world;
    this.explosionSystem  = explosionSystem;

    this.damage     = opts.damage ?? 60;
    this.speed      = opts.speed  ?? 90;
    this.reloadTime = opts.cooldown ?? opts.reload ?? 0.6; // now actually gates firing — see isReady/fire()
    this._reloading = false;
    // Wall-clock deadline (ms, performance.now()-based) — same drift-proof
    // pattern as SpecialGunSystem, so a short cooldown (e.g. 0.5s) can't
    // be stretched by render-dt smoothing or the main loop's dt clamp.
    this._readyAtMs = 0;

    // ── Auto-fire — when true, holding the fire input down (via
    // setAutoFireHeld(true)) repeatedly fires a rocket every time the
    // system comes off reload, instead of requiring one fire() call per
    // press. update(dt) is what actually re-triggers the shot each time
    // isReady flips back to true while held.
    this.rocketAuto      = opts.rocketAuto ?? false;
    this._autoFireHeld   = false;
    this._autoFireArgs   = null; // { rigidBody, enemyResolver, getAimWorldPos } captured from the most recent setAutoFireHeld(true, ...) call

    // ── Guided-missile mode — driven by planes.json's guidedMissile flag,
    // passed through from plane.js. When true, fire() acquires a lock on
    // the nearest valid target in the launch cone, and update() steers
    // each in-flight rocket toward its locked target every frame.
    this.guided = opts.guided ?? false;

    // ── Hit callback — fired once per rocket that actually connects (enemy
    // hit OR terrain/environment hit), same contract as BulletSystem.onHit
    // in bullet.js: (hitPos: THREE.Vector3) => void. Lets main.js play an
    // explosion sound / trigger other side-effects without RocketSystem
    // needing its own reference to the AudioSystem.
    this.onHit = null;

    // ── Called once each time auto-fire actually launches a rocket (i.e.
    // fire() succeeded, not just attempted while on cooldown). plane.js
    // hooks this to decrement rocketAmmo and to auto-stop holding once
    // ammo reaches 0, since RocketSystem itself doesn't track ammo.
    this.onAutoFire = null;

    this._launchPoints = [];
    this._launchIdx    = 0;

        // ── Mounted rocket visuals — one static mesh per launch point,
    // parented directly to that point's Object3D so it always sits
    // correctly on the rail/pylon. Hidden the instant that pod fires,
    // shown again once the system comes off cooldown (see fire() and
    // the isReady getter below).
    // ── Mounted rocket visuals — ONE InstancedMesh covering every launch
    // point (not one Mesh per point), so a 60-point rack still costs a
    // single draw call. Since instances can't be parented like a regular
    // Mesh, each instance's transform is re-synced from its launch point's
    // current world matrix every frame in update() — necessary because the
    // launch points themselves move/rotate with the plane. An empty pod is
    // represented as a zero-scale matrix (InstancedMesh has no per-instance
    // .visible), tracked here so update() knows which slots to zero out.
    this._mountedRocketMesh    = null;
    this._mountedRocketVisible = new Uint8Array(0);
    this._mountedRocketOffsetQuat = new THREE.Quaternion(); // identity — no flip; add one back only if the nose still points wrong

    // ── Per-rocket state — flat arrays, zero GC ─────────────────────────────
    this._active      = new Uint8Array(ROCKET_MAX);   // 0 = free, 1 = live
    this._px          = new Float32Array(ROCKET_MAX);
    this._py          = new Float32Array(ROCKET_MAX);
    this._pz          = new Float32Array(ROCKET_MAX);
    this._vx          = new Float32Array(ROCKET_MAX);
    this._vy          = new Float32Array(ROCKET_MAX);
    this._vz          = new Float32Array(ROCKET_MAX);
    this._life        = new Float32Array(ROCKET_MAX);
    this._resolver    = new Array(ROCKET_MAX).fill(null);
    this._excludeBody = new Array(ROCKET_MAX).fill(null);
    this._targetRef   = new Array(ROCKET_MAX).fill(null);  // locked target (tank/plane instance) per slot, or null

    // ── Flare-diversion state — once a rocket is fooled, it steers at a
    // fixed decoy point instead of the real target for the rest of its
    // flight (matches real countermeasure behaviour: it doesn't "snap
    // back" once it re-acquires nothing better).
    this._diverted        = new Uint8Array(ROCKET_MAX);   // 0 = tracking real target, 1 = diverted to a flare
    this._divertX          = new Float32Array(ROCKET_MAX);
    this._divertY          = new Float32Array(ROCKET_MAX);
    this._divertZ          = new Float32Array(ROCKET_MAX);
    this._decoyCheckAccum  = new Float32Array(ROCKET_MAX); // per-rocket throttle timer for decoy checks

    // ── Instanced visuals ────────────────────────────────────────────────────
    this._rocketMesh               = new THREE.InstancedMesh(_rocketGeo, _rocketMat, ROCKET_MAX);
    this._rocketMesh.frustumCulled = false;
    this._rocketMesh.count         = 0;
    scene.add(this._rocketMesh);

    for (let i = 0; i < ROCKET_MAX; i++) {
      this._rocketMesh.setMatrixAt(i, _zeroMatrix);
    }
    this._rocketMesh.instanceMatrix.needsUpdate = true;

    // ── Smoke trail — pooled textured puffs (rocketTrail.js), one shared
    // system across every rocket this RocketSystem ever fires. Each active
    // rocket slot registers its own trail ID via _trailSystem.add() at
    // spawn time and unregisters via .remove() when it dies; update()
    // below feeds it a fresh Map<id, THREE.Vector3> of live positions
    // every frame.
    this._trailSystem   = new RocketTrailSystem(scene);
    this._trailIds       = new Array(ROCKET_MAX).fill(null); // per-slot trail ID, or null if none registered
    this._trailPositions = new Map();   // reused every frame — id → THREE.Vector3, no per-frame allocation
    this._trailPosPool   = new Array(ROCKET_MAX); // pre-allocated Vector3s, one per slot, reused forever
    for (let i = 0; i < ROCKET_MAX; i++) this._trailPosPool[i] = new THREE.Vector3();

    // ── Scratch — reused every call, never reallocated ──────────────────────
    this._scratchOrigin    = new THREE.Vector3();
    this._scratchDir       = new THREE.Vector3();
    this._scratchLaunchFwd = new THREE.Vector3();
    this._scratchPrev   = new THREE.Vector3();
    this._scratchCurr   = new THREE.Vector3();
    this._scratchQuat   = new THREE.Quaternion();

    // ── Homing scratch — reused every frame, zero allocation ──────────────
    this._scratchTargetPos  = new THREE.Vector3();
    this._scratchDesiredDir = new THREE.Vector3();
    this._scratchCurDir     = new THREE.Vector3();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setLaunchPoints(nodes) {
    this._launchPoints = nodes ?? [];
    this._rebuildMountedRockets();
  }

    /**
   * Syncs the mounted-rocket visuals (and internal launch-order counter)
   * to the loadout's actual remaining ammo count. Call this any time
   * ammo changes for a reason OTHER than this system's own fire() call —
   * i.e. right after deploying with a full/partial loadout, and after an
   * ammo-crate refill — so the rack visually matches ground truth
   * regardless of how the count got there.
   *
   * Points are consumed front-to-back in launch order: with `total`
   * mounted points and `remaining` rockets left, points
   * [0 .. total-remaining-1] are shown empty and
   * [total-remaining .. total-1] are shown loaded. fire()'s own
   * round-robin _launchIdx already advances in this exact order on every
   * shot, so this only needs to be called on external ammo changes, not
   * after every fire().
   */
  setRemainingAmmo(remaining) {
    const total = this._mountedRocketVisible.length;
    if (total === 0) return;

    const clampedRemaining = Math.max(0, Math.min(total, remaining ?? 0));
    const emptiedCount = total - clampedRemaining;

    for (let i = 0; i < total; i++) {
      this._mountedRocketVisible[i] = i >= emptiedCount ? 1 : 0;
    }
    // Actual instance matrices are refreshed on the next update(dt) call
    // via _syncMountedRockets() — no need to touch the mesh here directly.

    // Keep fire()'s round-robin index consistent with this synced state,
    // so the NEXT shot empties the correct next pod rather than one
    // that's already showing empty (or skipping one that's still full).
    this._launchIdx = emptiedCount % total;
  }

  /** (Re)builds the static, always-visible rocket mesh sitting on each
   * launch point — called whenever setLaunchPoints() runs. Shares the
   * same geometry/material as the in-flight rockets (_rocketGeo/_rocketMat),
   * so it's a single extra draw call per launch point, no new GPU
   * resources. */
  _rebuildMountedRockets() {
    if (this._mountedRocketMesh) {
      this._mountedRocketMesh.removeFromParent();
      this._mountedRocketMesh = null;
    }
    this._launchIdx = 0;

    const count = this._launchPoints.length;
    this._mountedRocketVisible = new Uint8Array(count).fill(1); // all loaded initially — setRemainingAmmo() corrects this on the next call
    if (count === 0) return;

    this._mountedRocketMesh = new THREE.InstancedMesh(_rocketGeo, _rocketMat, count);
    this._mountedRocketMesh.frustumCulled = false; // instances span the whole plane/rack — a single bounding sphere would cull incorrectly
    for (let i = 0; i < count; i++) {
      this._mountedRocketMesh.setMatrixAt(i, _zeroMatrix); // hidden until the first _syncMountedRockets() populates real transforms
    }
    this._mountedRocketMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this._mountedRocketMesh);
  }

  /** Re-derives every mounted rocket's world transform from its launch
   * point's CURRENT world matrix (points move/rotate with the plane), and
   * zeroes out any pod currently marked empty. Called once per update(dt). */
  _syncMountedRockets() {
    const mesh = this._mountedRocketMesh;
    if (!mesh) return;

    for (let i = 0; i < this._launchPoints.length; i++) {
      if (!this._mountedRocketVisible[i]) {
        mesh.setMatrixAt(i, _zeroMatrix);
        continue;
      }
      const node = this._launchPoints[i];
      node.getWorldPosition(_rocketDummy.position);
      node.getWorldQuaternion(_rocketDummy.quaternion);
      _rocketDummy.quaternion.multiply(this._mountedRocketOffsetQuat); // nose-flip correction
      _rocketDummy.scale.setScalar(1);
      _rocketDummy.updateMatrix();
      mesh.setMatrixAt(i, _rocketDummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  setDamage(dmg)         { this.damage = dmg; }
  setSpeed(spd)          { this.speed  = spd; }
  setReloadTime(t)       { this.reloadTime = t; }
  setGuided(flag)        { this.guided = !!flag; }
  setRocketAuto(flag)    { this.rocketAuto = !!flag; }

  /**
   * Signals whether the fire input is currently held down. Only has an
   * effect when this.rocketAuto is true — update(dt) checks this each
   * frame and re-fires automatically every time reload finishes, using
   * whichever (rigidBody, enemyResolver, getAimWorldPos) were passed on
   * the most recent call with held=true.
   *
   * @param {boolean}       held
   * @param {object|null}   rigidBody       — shooter's Rapier RigidBody (same as fire()'s first arg)
   * @param {Function|null} enemyResolver   — same as fire()'s second arg
   * @param {Function|null} getAimWorldPos  — () => THREE.Vector3|null, called fresh each
   *   auto-shot so a moving aim point (e.g. mouse-tracked crosshair) stays
   *   accurate across the whole hold, rather than freezing at the aim point
   *   from the moment the button was first pressed.
   */
  setAutoFireHeld(held, rigidBody = null, enemyResolver = null, getAimWorldPos = null) {
    this._autoFireHeld = !!held;
    this._autoFireArgs = held ? { rigidBody, enemyResolver, getAimWorldPos } : null;
  }

    /** True if any currently in-flight rocket from this system has a live
   * homing lock on the given rigid body. O(ROCKET_MAX) — cheap, safe to
   * poll periodically. Used by main.js to drive a missile-lock warning
   * on the player's vehicle. */
  hasActiveLockOn(rigidBody) {
    if (!rigidBody) return false;
    for (let i = 0; i < ROCKET_MAX; i++) {
      if (!this._active[i]) continue;
      const t = this._targetRef[i];
      if (t && t.rigidBody === rigidBody) return true;
    }
    return false;
  }

  get isReady() {
    if (this._reloading && performance.now() >= this._readyAtMs) {
      this._reloading = false;
    }
    return !this._reloading && this._launchPoints.length > 0;
  }

  /** Seconds left before this can fire again — for a HUD countdown. */
  get cooldownRemaining() {
    if (!this._reloading) return 0;
    return Math.max(0, (this._readyAtMs - performance.now()) / 1000);
  }

  /**
   * Fire a single rocket from the next launch point in rotation (pods
   * alternate L/R/etc across successive shots for visual variety).
   * @param {object}              rigidBody     — shooter's Rapier RigidBody (excluded from raycast)
   * @param {Function|null}       enemyResolver — (rbHandle) => tank | null
   * @param {THREE.Vector3|null}  aimWorldPos   — live cursor-tracked aim point in
   *   world space. When provided, the rocket launches toward this point instead
   *   of the raw launch-point forward direction — same convergence behaviour
   *   as the plane's main gun / crosshair.
   */
  fire(rigidBody, enemyResolver = null, aimWorldPos = null, directTarget = null) {
    if (!this.isReady) return false;

    const podIndex    = this._launchIdx % this._launchPoints.length;
    const launchPoint = this._launchPoints[podIndex];
    this._launchIdx++;

    // Empty this pod visually the instant it fires. It stays empty until
    // setRemainingAmmo() is called with a higher count (ammo pickup) —
    // NOT when the fire-rate cooldown elapses, since running dry on
    // ammo and being between shots are two different things.
    if (podIndex < this._mountedRocketVisible.length) {
      this._mountedRocketVisible[podIndex] = 0;
    }

    launchPoint.getWorldPosition(this._scratchOrigin);

    // Launch point's true forward — the physically "straight out of the
    // tube" direction. Always computed, since it's now also the fallback/
    // clamp reference even when aiming at a cursor-tracked point.
    launchPoint.getWorldDirection(this._scratchLaunchFwd);

    if (aimWorldPos) {
      this._scratchDir.subVectors(aimWorldPos, this._scratchOrigin).normalize();

      // Clamp to a cone around the pod's actual forward — prevents the
      // rocket visually ejecting sideways/backward when the aim point is
      // close, behind, or steeply off-axis relative to the launch point.
      const dot = this._scratchDir.dot(this._scratchLaunchFwd);
      if (dot < ROCKET_LAUNCH_CONE_DOT) {
        // Blend toward launch-forward just enough to sit back on the cone
        // edge, rather than snapping straight to launch-forward — keeps
        // some directional bias toward the cursor/target for feel.
        this._scratchDir.lerp(this._scratchLaunchFwd, 1).normalize();
      }
    } else {
      this._scratchDir.copy(this._scratchLaunchFwd);
    }

    // ── Acquire a lock, once, at the moment of firing — NOT every frame.
    // Two paths: a caller that already knows exactly who it's shooting at
    // (e.g. EnemyPlane, which already resolved its combat target this
    // frame) can hand it over directly via `directTarget`, skipping the
    // O(active enemies) search entirely. Otherwise falls back to the
    // resolver-search convention bullet.js's _resolveEnemyMeshHit uses.
    let targetRef = null;
    if (this.guided) {
      if (directTarget && !directTarget.isDead) {
        targetRef = directTarget;
      } else if (enemyResolver) {
        targetRef = this._acquireLockTarget(this._scratchOrigin, this._scratchDir, enemyResolver);
      }
    }

    this._spawnRocket(this._scratchOrigin, this._scratchDir, rigidBody ?? null, enemyResolver, targetRef);

    // Cooldown starts now — next fire() (next click, or next tick of the
    // auto-fire hold-loop in update()) is blocked until isReady flips
    // back, exactly mirroring SpecialGunSystem's wall-clock approach.
    this._reloading = true;
    this._readyAtMs = performance.now() + this.reloadTime * 1000;

    this.explosionSystem?.spawnMuzzleFlash(this._scratchOrigin);
    return true;
  }

  /**
   * Finds the closest valid target within ROCKET_LOCK_MAX_RANGE that also
   * lies inside the forward launch cone (ROCKET_LOCK_CONE_DOT). Runs once
   * per shot, not per frame.
   */
  _acquireLockTarget(origin, dir, enemyResolver) {
    const candidates = enemyResolver('__all__');
    if (!candidates || !Array.isArray(candidates)) return null;

    const maxRangeSq = ROCKET_LOCK_MAX_RANGE * ROCKET_LOCK_MAX_RANGE;

    let best    = null;
    let bestDot = ROCKET_LOCK_CONE_DOT; // must clear the cone threshold to even qualify

    for (let i = 0; i < candidates.length; i++) {
      const t = candidates[i];
      if (!t || t.active === false || t.isDead) continue;

      const tp = t.rigidBody ? t.rigidBody.translation() : t._cachedPos;
      if (!tp) continue;

      const dx = tp.x - origin.x, dy = tp.y - origin.y, dz = tp.z - origin.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > maxRangeSq) continue; // out of lock range entirely — hard cutoff, not a ranking factor

      const dist = Math.sqrt(distSq) || 1;
      const dot  = (dx * dir.x + dy * dir.y + dz * dir.z) / dist; // cos(angle) vs. aim direction

      // ── Selection is by ANGULAR alignment to the aim direction (closest
      // to dead-center of the reticle), not by raw distance. A missile
      // lock should track "what you're actually pointing at", not "what's
      // nearest in a straight line" — the old distance-based selection let
      // an off-to-the-side but closer ground target (e.g. a tank) win over
      // a farther target that was actually under the crosshair (e.g. the
      // plane you were aiming at), since both could sit inside the same
      // wide 60° cone.
      if (dot > bestDot) {
        bestDot = dot;
        best = t;
      }
    }

    return best;
  }

  _spawnRocket(origin, dir, excludeBody, resolver, targetRef = null) {
    let slot = -1;
    for (let i = 0; i < ROCKET_MAX; i++) {
      if (!this._active[i]) { slot = i; break; }
    }
    if (slot === -1) return; // pool full — drop the shot silently

    this._active[slot]      = 1;
    this._px[slot]          = origin.x;
    this._py[slot]          = origin.y;
    this._pz[slot]          = origin.z;
    this._vx[slot]          = dir.x * this.speed;
    this._vy[slot]          = dir.y * this.speed;
    this._vz[slot]          = dir.z * this.speed;
    this._life[slot]        = ROCKET_LIFETIME;
    this._resolver[slot]    = resolver;
    this._excludeBody[slot] = excludeBody;
    this._targetRef[slot]   = targetRef;
    this._diverted[slot]         = 0;
    this._decoyCheckAccum[slot]  = Math.random() * FLARE_DECOY_CHECK_INTERVAL; // stagger checks across rockets

    // Fresh smoke trail for this shot — any previous occupant of this slot
    // already had its trail ID removed in _killRocket.
    this._trailIds[slot] = this._trailSystem.add();
  }

  // ── Update — integrate flight, raycast, resolve hits ───────────────────────

  update(dt) {
    // ── Auto-fire — re-trigger a shot the instant reload clears, as long
    // as the fire input is still being held. Placed before the rocket
    // integration loop below so a freshly-spawned rocket this same frame
    // still gets its first integration step this tick.
    if (this.rocketAuto && this._autoFireHeld && this.isReady) {
      const { rigidBody, enemyResolver, getAimWorldPos } = this._autoFireArgs ?? {};
      const aimWorldPos = getAimWorldPos ? getAimWorldPos() : null;
      const fired = this.fire(rigidBody ?? null, enemyResolver ?? null, aimWorldPos);
      // Let the owner (plane.js) know a shot actually left, so it can
      // decrement ammo / stop holding once empty — RocketSystem itself
      // has no concept of ammo, that's tracked on Plane.
      if (fired) this.onAutoFire?.();
    }

    const RAPIER = this.world.__RAPIER__;
    let anyActive = false;

    for (let i = 0; i < ROCKET_MAX; i++) {
      if (!this._active[i]) continue;
      anyActive = true;

      // ── Homing guidance — steer this rocket's velocity toward either
      // its locked target's CURRENT position, or (once fooled) a fixed
      // flare decoy point. Cost per active rocket: one subtract + one
      // normalize + one lerp — trivial even at the max of 8 simultaneous
      // rockets, and cheaper than the segment raycast already done below
      // every frame anyway.
      let target = this._targetRef[i];

      // ── Flare-decoy check — only while still tracking a real target,
      // throttled per-rocket so this isn't a full scan every frame.
      // Once diverted, a rocket stays diverted for the rest of its flight
      // (see the steer-at-fixed-point branch below) — no re-locking onto
      // the real target even if it re-enters cone/range.
      if (target && !this._diverted[i]) {
        this._decoyCheckAccum[i] -= dt;
        if (this._decoyCheckAccum[i] <= 0) {
          this._decoyCheckAccum[i] = FLARE_DECOY_CHECK_INTERVAL;

          const decoys = target.getActiveFlareDecoys?.();
          if (decoys && decoys.length) {
            const radiusSq = FLARE_DECOY_RADIUS * FLARE_DECOY_RADIUS;
            for (let d = 0; d < decoys.length; d++) {
              const dec = decoys[d];
              const dx = dec.x - this._px[i], dy = dec.y - this._py[i], dz = dec.z - this._pz[i];
              const distSq = dx * dx + dy * dy + dz * dz;
              if (distSq > radiusSq) continue;

              const chance = FLARE_DECOY_BASE_CHANCE * dec.strength;
              if (Math.random() < chance) {
                this._diverted[i] = 1;
                this._divertX[i]  = dec.x;
                this._divertY[i]  = dec.y;
                this._divertZ[i]  = dec.z;
                this._targetRef[i] = null; // stop tracking the real target entirely
                target = null;
                break;
              }
            }
          }
        }
      }

      if (this._diverted[i]) {
        // Steer at the fixed decoy point captured at the moment of
        // diversion — the flare itself may keep burning/moving, but the
        // fooled missile commits to where it WAS fooled, same as real
        // countermeasure behaviour.
        const curSpeed = Math.sqrt(
          this._vx[i] * this._vx[i] +
          this._vy[i] * this._vy[i] +
          this._vz[i] * this._vz[i]
        );
        if (curSpeed > 0.001) {
          this._scratchCurDir.set(
            this._vx[i] / curSpeed,
            this._vy[i] / curSpeed,
            this._vz[i] / curSpeed
          );
          this._scratchDesiredDir.set(
            this._divertX[i] - this._px[i],
            this._divertY[i] - this._py[i],
            this._divertZ[i] - this._pz[i]
          ).normalize();

          const turnT = Math.min(1, ROCKET_HOMING_TURN_LERP * dt);
          this._scratchCurDir.lerp(this._scratchDesiredDir, turnT).normalize();

          this._vx[i] = this._scratchCurDir.x * this.speed;
          this._vy[i] = this._scratchCurDir.y * this.speed;
          this._vz[i] = this._scratchCurDir.z * this.speed;
        }
      } else if (target) {
        // NOTE: `.active` is only meaningful for pooled AI units (Enemy/
        // FriendlyPlane|Tank). A direct player-vehicle target has no such
        // field — treat "missing" as "still active" rather than dropping
        // the lock the instant it's read. Only an EXPLICIT false disables it.
        if (target.active === false || target.isDead) {
          // Target died mid-flight — drop the lock, rocket goes ballistic
          // (keeps its last heading, gravity resumes below).
          this._targetRef[i] = null;
        } else {
          const tp = target.rigidBody ? target.rigidBody.translation() : target._cachedPos;
          if (tp) {
            const curSpeed = Math.sqrt(
              this._vx[i] * this._vx[i] +
              this._vy[i] * this._vy[i] +
              this._vz[i] * this._vz[i]
            );

            if (curSpeed > 0.001) {
              this._scratchCurDir.set(
                this._vx[i] / curSpeed,
                this._vy[i] / curSpeed,
                this._vz[i] / curSpeed
              );
              this._scratchDesiredDir.set(
                tp.x - this._px[i],
                tp.y - this._py[i],
                tp.z - this._pz[i]
              ).normalize();

              // Blend current heading toward target heading — turnLerp
              // controls how tight the missile can turn (higher = snappier).
              const turnT = Math.min(1, ROCKET_HOMING_TURN_LERP * dt);
              this._scratchCurDir.lerp(this._scratchDesiredDir, turnT).normalize();

              // Guided rockets hold constant launch speed along the new
              // heading rather than accelerating/decelerating.
              this._vx[i] = this._scratchCurDir.x * this.speed;
              this._vy[i] = this._scratchCurDir.y * this.speed;
              this._vz[i] = this._scratchCurDir.z * this.speed;
            }
          }
        }
      }

      const prevX = this._px[i];
      const prevY = this._py[i];
      const prevZ = this._pz[i];

      // Gravity only applies while NOT actively homing — an actively
      // guided missile shouldn't fight its own steering. Gravity resumes
      // automatically the instant a lock is lost (see block above).
      if (!this._targetRef[i]) {
        this._vy[i] -= ROCKET_GRAVITY * dt;
      }
      this._px[i] += this._vx[i] * dt;
      this._py[i] += this._vy[i] * dt;
      this._pz[i] += this._vz[i] * dt;

      // ── Smoke trail — push this slot's current position into the
      // shared position map, keyed by its registered trail ID. The
      // RocketTrailSystem itself decides emission timing internally
      // (EMIT_INTERVAL); this just keeps it informed of where each live
      // rocket currently is, every frame.
      const _trailId = this._trailIds[i];
      if (_trailId !== null) {
        const _tp = this._trailPosPool[i];
        _tp.set(this._px[i], this._py[i], this._pz[i]);
        this._trailPositions.set(_trailId, _tp);
      }

      this._life[i] -= dt;
      if (this._life[i] <= 0) {
        // ── Lifetime expired without hitting anything — explode in place
        // instead of just vanishing, same visual/audio beat as an actual
        // impact (see the hit-resolution block below).
        this._scratchCurr.set(this._px[i], this._py[i], this._pz[i]);
        this.explosionSystem?.spawnShellHit(this._scratchCurr);
        this.onHit?.(this._scratchCurr.clone(), null, 0, null);
        this._killRocket(i);
        continue;
      }

      // ── Segment raycast prev → curr ────────────────────────────────────────
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

          const hitCollider = this.world.getCollider(hit.collider.handle);
          const _rbHandle   = hitCollider?.parent()?.handle;

          let _hitEnemy = null;
          if (this._resolver[i]) {
            _hitEnemy = this._resolver[i](_rbHandle);
            if (_hitEnemy) {
              _hitEnemy._lastHitBy = 'player';
              _hitEnemy.takeDamage(this.damage);
            }
          }

          this.explosionSystem?.spawnShellHit(this._scratchCurr);
          // Args added (hitEnemyTank, damage, rbHandle) — mirrors
          // BulletSystem/ProjectileBulletSystem's onHit contract in
          // bullet.js, needed so main.js can do an EXACT rigid-body match
          // against real remote players' proxies instead of guessing by
          // proximity (unreliable for a rocket fired at a steep angle).
          this.onHit?.(this._scratchCurr.clone(), _hitEnemy, this.damage, _rbHandle);
          this._killRocket(i);
          continue;
        }
      }

      // ── Visual orientation — points along current velocity ─────────────────
      const speed = Math.sqrt(
        this._vx[i] * this._vx[i] +
        this._vy[i] * this._vy[i] +
        this._vz[i] * this._vz[i]
      );
      if (speed > 0.001) {
        this._scratchDir.set(this._vx[i] / speed, this._vy[i] / speed, this._vz[i] / speed);
        this._scratchQuat.setFromUnitVectors(_rocketFwd, this._scratchDir);
      }

      _rocketDummy.position.set(this._px[i], this._py[i], this._pz[i]);
      _rocketDummy.quaternion.copy(this._scratchQuat);
      _rocketDummy.scale.setScalar(1);
      _rocketDummy.updateMatrix();
      this._rocketMesh.setMatrixAt(i, _rocketDummy.matrix);
    }

    this._rocketMesh.count = ROCKET_MAX;
    this._rocketMesh.instanceMatrix.needsUpdate = anyActive;

    this._trailSystem.update(dt, this._trailPositions);
    this._syncMountedRockets();
  }

  // ── Insert this new method, right before the existing `_killRocket(i) {` method ──

  /**
   * Immediately deactivates every in-flight rocket, hiding its body, trail
   * (instanced mesh), and ribbon smoke meshes. Used when the owning plane
   * dies — without this, any rocket still in flight at the moment of death
   * simply freezes in place (update() stops running once isDead is true),
   * leaving a visible frozen artifact (a bright emissive rocket body) until
   * the next life's update() calls happen to resolve it naturally.
   */
  clearAll() {
    for (let i = 0; i < ROCKET_MAX; i++) {
      if (this._active[i]) this._killRocket(i);
    }
  }

  _killRocket(i) {
    this._active[i]      = 0;
    this._resolver[i]    = null;
    this._excludeBody[i] = null;
    this._targetRef[i]   = null;
    this._diverted[i]        = 0;
    this._decoyCheckAccum[i] = 0;
    this._rocketMesh.setMatrixAt(i, _zeroMatrix);
    this._rocketMesh.instanceMatrix.needsUpdate = true;

    // ── Smoke trail — stop feeding this slot's ID new positions and tell
    // RocketTrailSystem to stop emitting for it. Existing puffs already
    // emitted keep fading out naturally on their own (see rocketTrail.js).
    const _trailId = this._trailIds[i];
    if (_trailId !== null) {
      this._trailSystem.remove(_trailId);
      this._trailPositions.delete(_trailId);
      this._trailIds[i] = null;
    }
  }

  // ── Invalidate stale rigid body references (e.g. shooter respawned) ────────
  invalidateRigidBody(rigidBody) {
    if (!rigidBody) return;
    for (let i = 0; i < ROCKET_MAX; i++) {
      if (this._excludeBody[i] === rigidBody) this._excludeBody[i] = null;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose() {
    // NOTE: _rocketGeo/_rocketMat/_trailGeo/_trailMat are shared module-level
    // constants used by EVERY RocketSystem instance (every plane's rocket
    // pod). Disposing them here frees the GPU buffers for all of them at
    // once — only detach this instance's own mesh, same pattern as every
    // dispose() in bullet.js.
    this._rocketMesh.visible = false;
    this._rocketMesh.count   = 0;
    this._rocketMesh.removeFromParent();

    // ── Mounted rocket visuals — only detach (geometry/material are the
    // shared module-level _rocketGeo/_rocketMat, already disposed by
    // whichever code path frees those elsewhere; don't double-dispose here).
    if (this._mountedRocketMesh) {
      this._mountedRocketMesh.visible = false;
      this._mountedRocketMesh.removeFromParent();
      this._mountedRocketMesh = null;
    }

    // ── Smoke trail — fully owns its own GPU resources (a shared Points
    // pool used across every rocket this system ever fired), so it needs
    // its own dispose() call, not just detachment.
    this._trailSystem?.dispose();
    this._trailIds = new Array(ROCKET_MAX).fill(null);
    this._trailPositions.clear();
  }
}