import * as THREE from 'three';
import { EnemyTank } from './enemyTank.js';
import { MachineGunSystem, ProjectileBulletSystem } from './bullet.js';

export class RemotePlayerTank extends EnemyTank {
  constructor(scene, world) {
    super(scene, world);
    this.isRemotePlayer = true;
    this.isFriendly     = true; // deprecated — no longer read anywhere; kept only so any
                                  // stray external reference doesn't crash. Real friendliness
                                  // is now `this.team`, set below and refreshed every packet
                                  // in setNetworkState().
    this.team            = 1;    // overwritten immediately once the first match:state packet
                                  // (or the ai-state packet, for a real teammate reflected via
                                  // AI relay — not applicable here) carries a team value

    this._netPos         = new THREE.Vector3();
    this._netQuat         = new THREE.Quaternion();
    this._netSpeed        = 0;
    this._netTurretYaw    = 0;
    this._netBarrelPitch  = 0;
    this._netCapturing    = false;   // ← is this remote player currently holding [F]
    this._hasNetState     = false;
    this._lastFireSeq     = undefined;
    this._pendingFireFx   = false;
    this._lastMgFireSeq   = undefined;   // ← NEW
    this._pendingMgFireFx = false;       // ← NEW
    this._playerName      = 'Player';

    // ── Cached activation args — needed to rebuild this proxy on revive
    // after a full deactivate() (see setNetworkState()'s revive branch).
    this._lastKnownTrackCfg       = null;
    this._lastKnownModelPromise   = null;
    this._lastKnownExplosionSystem = null;
    this._lastKnownTankDef        = null;

    // ── Visual-only tracer beam system — used for main-gun (gunType 1/3)
    // and MG fire replays. This proxy never applies damage/ammo (see
    // takeDamage() override below), so MachineGunSystem is used purely for
    // its beam pool/travel-animation visuals, matching exactly what a
    // locally-fired hitscan shot looks like.
    this._visualBeamSystem = null; // created lazily in activate() once scene/world are known

    // ── Visual-only ARC PROJECTILE system — used for gunType 2 fire
    // replays (lobbed shells with gravity), so a guest sees the same
    // falling/arcing shell mesh + trail the host simulates for real,
    // instead of a straight instant beam standing in for it.
    this._visualProjSystem = null; // created lazily in activate()
  }

  // Same visuals/collider setup as EnemyTank.activate() (real trackCfg,
  // real GLB, real turret/barrel/gunPoint discovery), but the rigid body
  // is switched to kinematic — this tank's motion is dictated by the
  // network, never by local forces/torque/AI.
  activate(spawnPos, trackCfg, modelPromise, explosionSystem, tankDef, playerName = 'Player', team = 1) {
    super.activate(spawnPos, trackCfg, modelPromise, explosionSystem, tankDef, team);
    this._playerName = playerName;
    this.team = team;

    // ── Lazily create the visual-only beam system once (survives revives —
    // only needs scene/world/explosionSystem, none of which change) ───────
    if (!this._visualBeamSystem) {
      this._visualBeamSystem = new MachineGunSystem(this.scene, this.world, explosionSystem);
    } else {
      this._visualBeamSystem.explosionSystem = explosionSystem;
    }

    // ── Same lazy pattern for the visual-only projectile system, used only
    // when this tank's own def is gunType 2. Created unconditionally (cheap
    // — just a couple of small InstancedMeshes) so it's ready even if the
    // tankDef arrives slightly after activate() is first called.
    if (!this._visualProjSystem) {
      this._visualProjSystem = new ProjectileBulletSystem(this.scene, this.world, explosionSystem);
    } else {
      this._visualProjSystem.explosionSystem = explosionSystem;
    }
    // Match the host's shell speed/gravity feel for this tank type so the
    // arc reads the same on both sides — ProjectileBulletSystem's gravity
    // constant (PROJ_GRAVITY) is fixed module-wide, but speed is per-instance.
    this._visualProjSystem.bulletSpeed = tankDef?.config?.shellSpeed ?? 55;

    // ── Cache for revive-on-respawn (see setNetworkState()) ──────────────
    this._lastKnownTrackCfg        = trackCfg;
    this._lastKnownModelPromise    = modelPromise;
    this._lastKnownExplosionSystem = explosionSystem;
    this._lastKnownTankDef         = tankDef;

    if (this.rigidBody) {
      this.rigidBody.setBodyType(this.world.__RAPIER__.RigidBodyType.KinematicPositionBased, true);
    }

    this.state = 'REMOTE'; // never enters the AI FSM
    this._hasNetState = false;
  }

  /** Called whenever a match:state packet arrives for this player. */
  setNetworkState({ pos, quat, speed = 0, health, isDead, turretYaw, barrelPitch, fireSeq, mgFireSeq, capturing, team }) {
    // Team can change between packets in theory only if a player somehow
    // switched teams mid-match — in practice it's fixed for the match, but
    // applying it every packet (not just on first spawn) means AI/other
    // players' targeting reacts immediately if it ever does change, with
    // zero extra cost.
    if (typeof team === 'number') this.team = team;

    // ── Revive — the source player respawned. If this proxy fully
    // deactivated (dissolve finished → deactivate() → active=false), a
    // stale network packet can't reach it since update() bails out while
    // inactive. Re-activate it fresh at the incoming position before
    // applying the rest of this packet's state.
    if (!isDead && !this.active && this._lastKnownTankDef) {
      this.activate(
        { x: pos.x, y: pos.y, z: pos.z },
        this._lastKnownTrackCfg,
        this._lastKnownModelPromise,
        this._lastKnownExplosionSystem,
        this._lastKnownTankDef,
        this._playerName,
        this.team
      );
    }

    this._netPos.set(pos.x, pos.y, pos.z);
    this._netQuat.set(quat.x, quat.y, quat.z, quat.w);
    this._netSpeed = speed;
    this._hasNetState = true;

    if (turretYaw   !== undefined) this._netTurretYaw   = turretYaw;
    if (barrelPitch !== undefined) this._netBarrelPitch = barrelPitch;
    this._netCapturing = !!capturing;

    if (typeof health === 'number') this.health = health;
    if (isDead && !this.isDead) this._die();
    else if (!isDead && this.isDead) {
      // Revive flags — activate() above already rebuilt the rigid body/
      // visuals; just clear the stale death state so update() resumes.
      this.isDead = false;
    }

    if (fireSeq !== undefined) {
      if (this._lastFireSeq === undefined) {
        this._lastFireSeq = fireSeq; // don't flash on the very first packet received
      } else if (fireSeq !== this._lastFireSeq) {
        this._lastFireSeq = fireSeq;
        this._pendingFireFx = true;
      }
    }

    if (mgFireSeq !== undefined) {
      if (this._lastMgFireSeq === undefined) {
        this._lastMgFireSeq = mgFireSeq; // don't flash on the very first packet received
      } else if (mgFireSeq !== this._lastMgFireSeq) {
        this._lastMgFireSeq = mgFireSeq;
        this._pendingMgFireFx = true;
      }
    }
  }

  /**
   * Overrides EnemyTank.takeDamage(). This proxy has NO authority over its
   * own health — the real EnemyTank instance lives on the host. If a local
   * raycast/bullet hit on this proxy were allowed to call the inherited
   * takeDamage()/_die(), the GUEST would show it destroyed instantly and
   * independently of the host, which is exactly the desync being seen
   * (guest sees a kill, host's real unit is untouched and keeps firing).
   * Real damage only ever arrives through setNetworkState() below, driven
   * by the host's match:ai-state broadcast. Local hits are still reported
   * to the host separately via main.js's bulletSystem.onHit → 
   * 'match:damage-ai' emit — this override just prevents the double
   * (and locally-incorrect) application.
   */
  takeDamage(_amount) {
    // Intentionally a no-op.
  }

  // Overrides EnemyTank.update() entirely — no FSM, no local shooting/
  // steering AI. Interpolates transform + turret/barrel toward the latest
  // network sample, keeps tracks scrolling, and plays fire FX on trigger.
  update(dt, playerPos = null) {
    if (!this.active) return;
    if (this._dissolveActive) {
      this._tickDissolve(dt);
      this._visualBeamSystem?.update(dt);   // ← keep beams fading/travelling even mid-dissolve
      this._visualProjSystem?.update(dt);   // ← keep any in-flight shell arcing/falling too
      return;
    }
    this._tickTracers(dt);
    this._visualBeamSystem?.update(dt);   // ← advances travel + fades the instanced tracer beams
    this._visualProjSystem?.update(dt);   // ← advances the shell's arc + segment raycast (used only for visual kill, since resolver is null)
    if (!this._hasNetState) return;

    const posLag = Math.min(1, dt * 12);
    const rotLag = Math.min(1, dt * 12);
    this.bodyGroup.position.lerp(this._netPos, posLag);
    this.bodyGroup.quaternion.slerp(this._netQuat, rotLag);

    // ── Engine sound — distance-based, mirrors EnemyTank.update()'s own
    // engine-audio block (`if (audioSystem) { ... audioSystem.updateEnemyEngine(...) }`).
    // RemotePlayerTank fully overrides update() instead of calling super,
    // so without this, guest clients never call audioSystem.updateEnemyEngine()
    // for AI tanks (or remote real players' tanks) at all — the engine loop
    // is simply never created. This also fixes _distToPlayer being stuck at
    // undefined/0, which was making playEnemyShot() ignore distance culling.
    if (this._audioSystem && playerPos) {
      const dx = this.bodyGroup.position.x - playerPos.x;
      const dz = this.bodyGroup.position.z - playerPos.z;
      this._distToPlayer = Math.sqrt(dx * dx + dz * dz);
      this._audioSystem.updateEnemyEngine(
        this._id, dt, this._netSpeed / 3.5, this._netSpeed > 0.1, this._distToPlayer
      );
    }

    // ← ADD — EnemyTank._findCombatTarget() requires ft._cachedPos to be
    // set to even consider this proxy as a candidate target. The base
    // class sets this every frame in its own update(); since this class
    // fully overrides update() instead of calling super, it must be set
    // here too or AI will never engage remote players.
    this._cachedPos = this.bodyGroup.position;

    if (this.rigidBody) {
      this.rigidBody.setNextKinematicTranslation(this.bodyGroup.position);
      this.rigidBody.setNextKinematicRotation({
        x: this.bodyGroup.quaternion.x, y: this.bodyGroup.quaternion.y,
        z: this.bodyGroup.quaternion.z, w: this.bodyGroup.quaternion.w,
      });
    }

    // ── Tracks/wheels — same EnemyTrackSystem the AI tanks use, driven by
    // network speed instead of local throttle ─────────────────────────────
    if (this.trackLeft && this.trackRight) {
      this.trackLeft.update(dt, this._netSpeed, this.bodyGroup.position, this.bodyGroup.quaternion, null, null);
      this.trackRight.update(dt, this._netSpeed, this.bodyGroup.position, this.bodyGroup.quaternion, null, null);
    }

    // ── Turret / barrel — smoothly chase the networked local-space angles ──
    if (this._turretMesh) {
      let delta = this._netTurretYaw - this._turretMesh.rotation.y;
      while (delta >  Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this._turretMesh.rotation.y += delta * Math.min(1, dt * 10);
    }
    if (this._barrelMesh) {
      this._barrelMesh.rotation.x += (this._netBarrelPitch - this._barrelMesh.rotation.x) * Math.min(1, dt * 10);
    }

    if (this._pendingFireFx) {
      this._pendingFireFx = false;
      this._playFireEffect();
    }
    if (this._pendingMgFireFx) {
      this._pendingMgFireFx = false;
      this._playMgFireEffect();
    }
  }

  _playFireEffect() {
    const gunType = this._tankDef?.config?.gunType ?? 1;

    const gunPoints = (this._multiGunPoints?.length ? this._multiGunPoints : null)
      ?? (this._gunPoint ? [this._gunPoint] : []);

    if (gunPoints.length === 0) {
      // No gun point resolved yet (model still loading) — nothing to draw.
      return;
    }

    const origin = new THREE.Vector3();
    const dir    = new THREE.Vector3();

    for (const gp of gunPoints) {
      gp.getWorldPosition(origin);
      gp.getWorldDirection(dir);

      this._explosionSystem?.spawnMuzzleFlash?.(origin);

      if (gunType === 2 && this._visualProjSystem) {
        // ── Arc projectile (lobbed shell) — spawns into the visual-only
        // ProjectileBulletSystem, which simulates gravity/arc + draws the
        // real shell+trail mesh every frame via its own update(), instead
        // of a straight instant beam. type=2 marks it as an "enemy" slot
        // internally (no resolver/onHitPlayer — purely cosmetic, no damage).
        this._visualProjSystem._spawnProjectile(origin, dir, null, 2, null, null, null);
      } else {
        // Hitscan (gunType 1/3) — same instanced, travelling tracer beam a
        // local shot would spawn.
        this._visualBeamSystem?._spawnBeam(origin, dir);
      }
    }

    // ── Fire sound — the real EnemyTank plays this inline inside its own
    // ATTACK-state shoot block (see EnemyTank.update()), but that code
    // path never runs on a guest client (enemyPool.update() is host-only).
    // Replay it here instead, keyed off the same fireSeq-change trigger
    // that already drives the visual muzzle flash/tracer above.
    const _fireSound = this._tankDef?.config?.fireSound ?? 1;
    if (this._audioSystem?._ready) {
      this._audioSystem.playEnemyShot(_fireSound, this._distToPlayer ?? 0);
    } else {
      this._audioSystem?._resume?.().then(() =>
        this._audioSystem.playEnemyShot(_fireSound, this._distToPlayer ?? 0)
      );
    }
  }

  _playMgFireEffect() {
    const gp = this._mgGunPoint;   // ← MG-specific mount — falls back below if the model has none
    const origin = new THREE.Vector3();
    const dir    = new THREE.Vector3();

    if (gp) {
      gp.getWorldPosition(origin);
      gp.getWorldDirection(dir);
    } else {
      this.bodyGroup.getWorldPosition(origin);
      dir.set(0, 0, -1).applyQuaternion(this.bodyGroup.quaternion);
    }

    this._explosionSystem?.spawnMuzzleFlash?.(origin);
    // Same instanced, travelling tracer beam a local MG shot would spawn.
    this._visualBeamSystem?._spawnBeam(origin, dir);
  }

  _tickTracers(dt) {
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

  deactivate() {
    // Stop any in-flight beams/shells immediately so they don't freeze
    // mid-flight when this proxy is torn down (e.g. permanent death, pool
    // cleanup).
    this._visualBeamSystem?.clearBeams();
    if (this._visualProjSystem && Array.isArray(this._visualProjSystem._active)) {
      for (let i = 0; i < this._visualProjSystem._active.length; i++) {
        if (this._visualProjSystem._active[i]) {
          this._visualProjSystem._killProjectile(i);
        }
      }
    }
    super.deactivate();
  }

  destroyPermanently() {
    this._visualBeamSystem?.dispose();
    this._visualBeamSystem = null;
    this._visualProjSystem?.dispose();
    this._visualProjSystem = null;
    super.destroyPermanently();
  }
}