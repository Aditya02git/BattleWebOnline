// friendlyTank.js — Friendly AI tanks: same capture-point FSM as EnemyTank,
// but targets/fights enemy tanks instead of the player, and captured points
// count for the player's team (scored in main.js, same as before).

import { EnemyTank, EnemyTankPool, STATE } from './enemyTank.js';

export class FriendlyTank extends EnemyTank {
  constructor(scene, world) {
    super(scene, world);
    this.isFriendly = true;
    this._cachedPos = null;
  }

  /**
   * Override: friendlies fight the nearest active ENEMY tank, not the player.
   * Signature must match EnemyTank._findCombatTarget(pos, playerPos, playerRigidBody, extraTargets)
   * — `extraTargets` here is the enemyTanks array, passed as the 9th
   * positional arg to update() by FriendlyTankPool (see below).
   */
  _findCombatTarget(pos, playerPos, playerRigidBody, enemyTanks) {
    let best = null;
    let bestDistSq = Infinity;

    if (pos && enemyTanks && enemyTanks.length) {
      for (let i = 0; i < enemyTanks.length; i++) {
        const et = enemyTanks[i];
        if (!et.active || et.isDead || !et._cachedPos) continue;
        const ep = et._cachedPos;
        const dx = ep.x - pos.x, dz = ep.z - pos.z;
        const dsq = dx * dx + dz * dz;
        if (dsq < bestDistSq) { bestDistSq = dsq; best = et; }
      }
    }

    if (!best) {
      // No living enemies — park the FSM's combat check far away so it
      // never enters ENGAGE/ATTACK (dist will be huge).
      this._scratchFarTarget = this._scratchFarTarget || { x: 0, y: 0, z: 0 };
      this._scratchFarTarget.x = playerPos.x + 1e6;
      this._scratchFarTarget.y = playerPos.y;
      this._scratchFarTarget.z = playerPos.z;
      return { pos: this._scratchFarTarget, rigidBody: null, isPlayer: false, tankRef: null };
    }

    return { pos: best._cachedPos, rigidBody: best.rigidBody, isPlayer: false, tankRef: best };
  }
}

// ── FriendlyTankPool ─────────────────────────────────────────────────────────
// Identical to EnemyTankPool (same capture-point coordinator, same spawn/LOD
// logic) except:
//   - creates FriendlyTank instead of EnemyTank
//   - passes the live enemy-tank list into each tank's update() so
//     _findCombatTarget() above has something to search
//   - onHitPlayer callback receives (damage, combatTarget) — combatTarget.tankRef
//     is the actual EnemyTank instance that got hit, so we call .takeDamage() on it
//     instead of damaging the player tank

export class FriendlyTankPool extends EnemyTankPool {
  constructor(scene, world, terrain, opts = {}) {
    super(scene, world, terrain, opts);

    // Rebuild pool using FriendlyTank instead of EnemyTank
    this._pool = Array.from(
      { length: this.maxTanks },
      () => new FriendlyTank(scene, world)
    );

    // Reference to the enemy pool — supplies the target list every frame.
    this._enemyPoolRef = opts.enemyPool ?? null;
  }

  setEnemyPool(enemyPool) {
    this._enemyPoolRef = enemyPool;
  }

  // ── Grow the pool's cap at runtime (used for the squad "flex" friendly
  // slot — see confirmSpawnSelection() in main.js). Only ever grows; never
  // shrinks, since removing already-active tanks mid-match would be far
  // more disruptive than just leaving a spare inactive slot unused. ────────
  setMaxTanks(newMax) {
    if (newMax > this.maxTanks) {
      // Growing — add fresh inactive instances so trySpawn() has more
      // slots to draw from.
      const toAdd = newMax - this.maxTanks;
      for (let i = 0; i < toAdd; i++) {
        this._pool.push(new FriendlyTank(this.scene, this.world));
      }
    }
    // Shrinking is safe too — trySpawn() checks getActiveTanks().length
    // against this.maxTanks before spawning, so lowering the cap just
    // stops NEW spawns once living count catches up. Any already-alive
    // tank above the new cap is left alone to die out naturally instead
    // of being force-despawned mid-match.
    this.maxTanks = newMax;
  }

  update(dt, playerPos) {
    console.log('[FriendlyTankPool.update] active=', this._activeCount());
    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = this._spawnInterval;
      this.trySpawn();
    }

    // NOTE: EnemyTrackSystem.drainNearQueue() is already called once per
    // frame by enemyPool.update() in main.js — no need to call it again here.

    // Capture-point coordination — SAME shared CAPTURE_POINTS list/logic as
    // EnemyTankPool. This makes friendlies compete for the same points.
    this._updateCaptureAssignments(dt);

    const shootCb      = this.onEnemyShoot;
    const flashCb      = this.onMuzzleFlash;
    const bulletSystem = this.bulletSystem;
    const onHitPlayer   = this.onHitPlayer;   // reused name — see note below
    const audioSystem  = this._audioSystem;

    const activeTanks = this.getActiveTanks();
    const enemyTanks  = this._enemyPoolRef?.getActiveTanks() ?? [];
    const playerRigidBody = this.playerTank?.rigidBody ?? null;

    for (const tank of activeTanks) {
      tank.update(dt, playerPos, shootCb, flashCb, bulletSystem, onHitPlayer, audioSystem, playerRigidBody, enemyTanks);

      if (tank.rigidBody) {
        const p = tank.rigidBody.translation();
        const halfSize = this.terrain.worldSize / 2 + 10;
        if (Math.abs(p.x) > halfSize || Math.abs(p.z) > halfSize || p.y < -20) {
          tank.deactivate();
          continue;
        }
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

    const MIN_SEP_DIST = 6.0;
    for (let i = 0; i < activeTanks.length; i++) {
      for (let j = i + 1; j < activeTanks.length; j++) {
        const a = activeTanks[i];
        const b = activeTanks[j];
        if (!a.rigidBody || !b.rigidBody) continue;
        const pa = a.rigidBody.translation();
        const pb = b.rigidBody.translation();
        const dx = pa.x - pb.x;
        const dz = pa.z - pb.z;
        const distSq = dx * dx + dz * dz;
        const minDistSq = MIN_SEP_DIST * MIN_SEP_DIST;
        if (distSq < minDistSq && distSq > 0.001) {
          const dist   = Math.sqrt(distSq);
          const factor = (MIN_SEP_DIST - dist) / MIN_SEP_DIST;
          const fx = (dx / dist) * factor * 800 * dt;
          const fz = (dz / dist) * factor * 800 * dt;
          a.rigidBody.applyImpulse({ x:  fx, y: 0, z:  fz }, true);
          b.rigidBody.applyImpulse({ x: -fx, y: 0, z: -fz }, true);
        }
      }
    }

    // ── Player avoidance (debug version — logs so you can confirm it's
    // actually running) — directly sets velocity instead of applying an
    // impulse, so the push is immediate and not fighting the AI's own
    // drive forces frame-by-frame.
    const PLAYER_SEP_DIST = 9.0; // metres
    if (playerRigidBody) {
      const pp = playerRigidBody.translation();

      for (const t of activeTanks) {
        if (!t.rigidBody || t.isDead) continue;

        const tp = t.rigidBody.translation();
        const dx = tp.x - pp.x;
        const dz = tp.z - pp.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < PLAYER_SEP_DIST && dist > 0.001) {
          const nx = dx / dist;
          const nz = dz / dist;
          const factor = 1 - dist / PLAYER_SEP_DIST;   // 0 at edge, 1 at center
          const pushSpeed = factor * 12;                // m/s — tune this

          const vel = t.rigidBody.linvel();
          t.rigidBody.setLinvel({
            x: vel.x + nx * pushSpeed,
            y: vel.y,
            z: vel.z + nz * pushSpeed,
          }, true);

          console.log('[PlayerAvoid]', t._id, 'dist=', dist.toFixed(2), 'push=', pushSpeed.toFixed(2));
        }
      }
    }
  }
}