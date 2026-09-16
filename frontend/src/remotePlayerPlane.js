import * as THREE from 'three';
import { EnemyPlane } from './enemyPlane.js';
import { MachineGunSystem, MultiGunSystem } from './bullet.js';

export class RemotePlayerPlane extends EnemyPlane {
  constructor(scene, world) {
    super(scene, world);
    this.isRemotePlayer = true;
    this.isFriendly     = true;   // deprecated — see RemotePlayerTank's constructor comment
    this.team           = 1;
    this._netPos       = new THREE.Vector3();
    this._netQuat       = new THREE.Quaternion();
    this._netCapturing  = false;
    this._hasNetState   = false;
    this._lastFireSeq   = undefined;
    this._pendingFireFx = false;
    this._tracers       = [];
    this._playerName    = 'Player';

    // ── Cached activation args — needed to rebuild this proxy on revive.
    this._lastKnownModelPromise    = null;
    this._lastKnownExplosionSystem = null;
    this._lastKnownModelPath       = null;
    this._lastKnownHullHalfExtents = null;
    this._lastKnownColliderYOffset = null;
    this._lastKnownGetTerrainY     = null;

    // ── Visual-only tracer beam system — EnemyPlane now supports BOTH
    // MachineGunSystem (gunType 1) and MultiGunSystem (gunType 3), so this
    // proxy must build whichever one matches the plane's own locked
    // gunType, not always assume single-barrel MG. This proxy never
    // applies damage (see takeDamage() override below); the beam pool is
    // purely cosmetic, replacing the flat THREE.Line placeholder.
    this._visualBeamSystem = null; // created lazily in activate()
  }

  activate(spawnPos, modelPromise, explosionSystem, modelPath, hullHalfExtents, colliderYOffset, getTerrainY, playerName = 'Player', team = 1) {
    super.activate(spawnPos, modelPromise, explosionSystem, modelPath, hullHalfExtents, colliderYOffset, getTerrainY, team);
    this._playerName = playerName;
    this.team = team;

    // ── Lazily create the visual-only beam system once, matching this
    // plane's own locked gunType (set by EnemyPlanePool.trySpawn() via
    // super.activate() just above). Rebuilt if the gunType somehow differs
    // from what's already cached (shouldn't normally happen mid-life, but
    // guards against a stale MachineGunSystem surviving a MultiGunSystem
    // plane, or vice versa).
    const _wantMultiGun = this._gunType === 3;
    const _haveMultiGun = this._visualBeamSystem instanceof MultiGunSystem;
    if (!this._visualBeamSystem || _wantMultiGun !== _haveMultiGun) {
      this._visualBeamSystem?.dispose();
      this._visualBeamSystem = _wantMultiGun
        ? new MultiGunSystem(this.scene, this.world, explosionSystem)
        : new MachineGunSystem(this.scene, this.world, explosionSystem);
    } else {
      this._visualBeamSystem.explosionSystem = explosionSystem;
    }

    // ── Cache for revive-on-respawn (see setNetworkState()) ──────────────
    this._lastKnownModelPromise    = modelPromise;
    this._lastKnownExplosionSystem = explosionSystem;
    this._lastKnownModelPath       = modelPath;
    this._lastKnownHullHalfExtents = hullHalfExtents;
    this._lastKnownColliderYOffset = colliderYOffset;
    this._lastKnownGetTerrainY     = getTerrainY;

    if (this.rigidBody) {
      this.rigidBody.setBodyType(this.world.__RAPIER__.RigidBodyType.KinematicPositionBased, true);
    }
    this.state = 'REMOTE';
    this._hasNetState = false;
  }

  setNetworkState({ pos, quat, health, isDead, fireSeq, capturing, team }) {
    if (typeof team === 'number') this.team = team;

    if (!isDead && !this.active && this._lastKnownModelPath) {
      this.activate(
        { x: pos.x, y: pos.y, z: pos.z },
        this._lastKnownModelPromise,
        this._lastKnownExplosionSystem,
        this._lastKnownModelPath,
        this._lastKnownHullHalfExtents,
        this._lastKnownColliderYOffset,
        this._lastKnownGetTerrainY,
        this._playerName,
        this.team
      );
    }

    this._netPos.set(pos.x, pos.y, pos.z);
    this._netQuat.set(quat.x, quat.y, quat.z, quat.w);
    this._hasNetState = true;
    this._netCapturing = !!capturing;
    if (typeof health === 'number') this.health = health;
    if (isDead && !this.isDead) this._die();
    else if (!isDead && this.isDead) this.isDead = false;

    if (fireSeq !== undefined) {
      if (this._lastFireSeq === undefined) {
        this._lastFireSeq = fireSeq;
      } else if (fireSeq !== this._lastFireSeq) {
        this._lastFireSeq = fireSeq;
        this._pendingFireFx = true;
      }
    }
  }

  /** See RemotePlayerTank.takeDamage() for why this is a no-op. */
  takeDamage(_amount) {
    // Intentionally a no-op.
  }

  // No FSM, no gun AI, no ground self-destruct — just interpolate + FX.
  update(dt, playerPos = null) {
    if (!this.active) return;
    if (this._dissolveActive) {
      this._tickDissolve(dt, this._audioSystem, playerPos);
      this._visualBeamSystem?.update(dt);   // ← keep beams fading/travelling even mid-dissolve
      return;
    }
    this._tickTracers(dt);
    this._visualBeamSystem?.update(dt);   // ← advances travel + fades the instanced tracer beams
    if (!this._hasNetState) return;

    this.bodyGroup.position.lerp(this._netPos, Math.min(1, dt * 12));
    this.bodyGroup.quaternion.slerp(this._netQuat, Math.min(1, dt * 12));

    // ── Engine sound — distance-based, mirrors EnemyPlane.update()'s own
    // engine-audio block. RemotePlayerPlane fully overrides update() instead
    // of calling super, so without this, guest clients never call
    // audioSystem.updateEnemyEngine() for AI planes (or remote real players'
    // planes) at all — the engine loop is simply never created. This also
    // fixes _distToPlayer being stuck at undefined/0, which was making
    // playEnemyShot() ignore distance culling for plane gunfire.
    // Note: `true` as the last arg marks this as a plane engine — see
    // AudioSystem.updateEnemyEngine()'s isPlane branch (wider hearing
    // range + separate ai_plane_engine.ogg sample).
    if (this._audioSystem && playerPos) {
      const dx = this.bodyGroup.position.x - playerPos.x;
      const dy = this.bodyGroup.position.y - playerPos.y;
      const dz = this.bodyGroup.position.z - playerPos.z;
      this._distToPlayer = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // _netSpeed isn't tracked on this proxy (unlike RemotePlayerTank) —
      // approximate throttle/movement from the actual per-frame lerp delta
      // instead, since nothing else here reports a network-reported speed.
      const moveDist = this.bodyGroup.position.distanceTo(this._netPos);
      const approxSpeed = dt > 0 ? moveDist / dt : 0;
      this._audioSystem.updateEnemyEngine(
        this._id, dt, approxSpeed / 30, approxSpeed > 1, this._distToPlayer, true
      );
    }

    // ← ADD — same reason as RemotePlayerTank: EnemyPlane._findCombatTarget()
    // needs this set every frame or AI planes will never treat this proxy
    // as a valid target.
    this._cachedPos = this.bodyGroup.position;

    if (this.rigidBody) {
      this.rigidBody.setNextKinematicTranslation(this.bodyGroup.position);
      this.rigidBody.setNextKinematicRotation({
        x: this.bodyGroup.quaternion.x, y: this.bodyGroup.quaternion.y,
        z: this.bodyGroup.quaternion.z, w: this.bodyGroup.quaternion.w,
      });
    }

    if (this._propellerNode) {
      this._propSpinAngle += 30 * dt;
      this._propellerNode.rotation.z = this._propSpinAngle;
    }

    if (this._pendingFireFx) {
      this._pendingFireFx = false;
      this._playFireEffect();
    }
  }

  _playFireEffect() {
    // GunPoint_1 / GunPoint_2 — fire a beam from EVERY active gun point.
    // For gunType 3 (MultiGunSystem) both barrels fire together per shot,
    // same as EnemyPlane._fireGun() does on the host; for gunType 1
    // (MachineGunSystem) there's normally just one gun point anyway.
    const gunPoints = this._gunPoints?.length ? this._gunPoints : null;

    if (!gunPoints) {
      // No gun point resolved yet (model still loading) — nothing to draw.
      return;
    }

    const origin = new THREE.Vector3();
    const dir    = new THREE.Vector3();

    for (const gp of gunPoints) {
      gp.getWorldPosition(origin);
      gp.getWorldDirection(dir);

      this.explosionSystem?.spawnMuzzleFlash?.(origin);
      // Same instanced, travelling tracer beam a local shot would spawn —
      // replaces the old flat, non-animated THREE.Line placeholder. Both
      // MachineGunSystem and MultiGunSystem expose the same _spawnBeam()
      // shape, so no branching needed here beyond which class was built
      // in activate() above.
      this._visualBeamSystem?._spawnBeam(origin, dir);
    }

    // ── Fire sound — mirrors EnemyPlane._fireGun()'s inline call, which
    // never runs on a guest (enemyPlanePool.update() is host-only).
    if (this._audioSystem?._ready) {
      this._audioSystem.playEnemyShot?.(this._fireSound, this._distToPlayer ?? 0);
    } else {
      this._audioSystem?._resume?.().then(() =>
        this._audioSystem.playEnemyShot?.(this._fireSound, this._distToPlayer ?? 0)
      );
    }
  }

  _tickTracers(dt) {
    for (let i = this._tracers.length - 1; i >= 0; i--) {
      const t = this._tracers[i];
      t.timer -= dt;
      t.mat.opacity = Math.max(0, t.timer / 0.08);
      if (t.timer <= 0) {
        this.scene.remove(t.line);
        t.geo.dispose();
        t.mat.dispose();
        this._tracers.splice(i, 1);
      }
    }
  }

  deactivate() {
    // Stop any in-flight beams immediately so they don't freeze mid-fade
    // when this proxy is torn down (e.g. permanent death, pool cleanup).
    this._visualBeamSystem?.clearBeams();
    super.deactivate();
  }

  destroyPermanently() {
    this._visualBeamSystem?.dispose();
    this._visualBeamSystem = null;
    super.destroyPermanently();
  }
}