/**
 * AmmoPoint
 * A GLB crate that the player can approach and hold F to refill all ammo.
 * One instance manages all ammo points on the map.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const REFILL_RADIUS             = 10;   // metres — horizontal proximity trigger
const REFILL_VERTICAL_TOLERANCE = 8;    // metres — max altitude difference from the crate
const REFILL_HOLD_TIME          = 5;    // seconds to hold F
const COOLDOWN_TIME             = 0;    // 0 = infinite, change if needed later

const AMMO_POINT_RESPAWN_TIME = 90;  // seconds (1:30) before a destroyed crate returns
const AMMO_POINT_MAX_HEALTH   = 100; // HP pool — depleted by the real damage value of whatever weapon hits it

export class AmmoPointSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {{ x:number, z:number }[]} pointDefs  — from maps.json ammoPoints
   * @param {Function} getTerrainY                 — terrain height sampler
   * @param {string}   cratePath                   — GLB path, default /ammo_crate.glb
   */
  constructor(scene, world, pointDefs, getTerrainY, cratePath = '/ammo_crate.glb', iconPath = '/Ammo.png') {
    this.scene        = scene;
    this.world        = world; // Rapier world — needed for the destructible collider
    this.getTerrainY  = getTerrainY;
    this.points       = [];        // fully built point objects
    this._elapsed     = 0;

    // ── HUD elements ────────────────────────────────────────────────────────
    this._hud = this._buildHUD();

    // ── F key tracking ──────────────────────────────────────────────────────
    this._fHeld      = false;
    this._holdTimer  = 0;
    this._nearPoint  = null;
    this._onKeyDown  = (e) => { if (e.code === 'KeyF') this._fHeld = true;  };
    this._onKeyUp   = (e) => {
      if (e.code === 'KeyF') {
        this._fHeld     = false;
        this._holdTimer = 0;
        this._setBarPct(0);
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);

    // ── Load GLB + PNG icon, then build points ────────────────────────────────
    this._loader       = new GLTFLoader();
    this._textureLoader = new THREE.TextureLoader();

    this._crateTemplate = null;
    this._iconTexture   = null;   // null = still loading, false = failed/fallback
    this._pendingDefs   = pointDefs;

    const tryBuildPending = () => {
      if (this._crateTemplate && this._iconTexture !== null) {
        this._pendingDefs.forEach(def => this._buildPoint(def));
        this._pendingDefs = [];
      }
    };

    this._loader.load(
      cratePath,
      (gltf) => {
        this._crateTemplate = gltf.scene;
        this._crateTemplate.traverse(c => {
          if (c.isMesh) { c.castShadow = false; c.receiveShadow = false; }
        });
        tryBuildPending();
      },
      undefined,
      (err) => {
        console.warn('[AmmoPoint] GLB load failed, using fallback box:', err);
        this._crateTemplate = this._makeFallbackCrate();
        tryBuildPending();
      }
    );

    this._textureLoader.load(
      iconPath,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        this._iconTexture = tex;
        tryBuildPending();
      },
      undefined,
      (err) => {
        console.warn('[AmmoPoint] Ammo.png load failed, using fallback canvas icon:', err);
        this._iconTexture = false;
        tryBuildPending();
      }
    );
  }

  // ── Build one ammo point ─────────────────────────────────────────────────
  _buildPoint(def) {
    const y = this.getTerrainY(def.x, def.z);

    // Crate mesh
    const crate = this._crateTemplate.clone(true);
    crate.position.set(def.x, y, def.z);
    this.scene.add(crate);
    crate.updateMatrixWorld(true);

    // ── Resolve the "Loadout" (intact), "Destroyed_Loadout" (wrecked), and
    // "Collider" (invisible physics cube) sub-objects inside the GLB.
    let loadoutNode = null;
    let destroyedLoadoutNode = null;
    let colliderMesh = null;
    crate.traverse((child) => {
      if (child.name === 'Loadout') loadoutNode = child;
      else if (child.name === 'Destroyed_Loadout') destroyedLoadoutNode = child;
      else if (child.name === 'Collider') colliderMesh = child;
    });
    if (loadoutNode) loadoutNode.visible = true;
    if (destroyedLoadoutNode) destroyedLoadoutNode.visible = false;

    // Floating icon above crate
    const icon = this._makeFloatingIcon();
    icon.position.set(def.x, y + 2.2, def.z);
    this.scene.add(icon);

    // ── Physics collider — built directly from the GLB's own "Collider"
    // cube mesh (world-space position/rotation + its geometry's bounding
    // box for half-extents), same pattern used for house colliders. This
    // stays enabled permanently, even after the crate is destroyed — only
    // the visible mesh (Loadout vs Destroyed_Loadout) changes on destroy,
    // never the collider itself.
    let rigidBody = null;
    let collider  = null;
    let colliderWorldPos = { x: def.x, y, z: def.z }; // fallback if no Collider node found

    if (this.world && colliderMesh) {
      const RAPIER = this.world.__RAPIER__;

      const worldPos   = new THREE.Vector3();
      const worldQuat  = new THREE.Quaternion();
      const worldScale = new THREE.Vector3();
      colliderMesh.matrixWorld.decompose(worldPos, worldQuat, worldScale);

      colliderMesh.geometry.computeBoundingBox();
      const bbox = colliderMesh.geometry.boundingBox;
      const localHalf = new THREE.Vector3();
      bbox.getSize(localHalf).multiplyScalar(0.5);

      const hx = localHalf.x * worldScale.x;
      const hy = localHalf.y * worldScale.y;
      const hz = localHalf.z * worldScale.z;

      const rq = new RAPIER.Quaternion(
        worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w,
      );

      rigidBody = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(worldPos.x, worldPos.y, worldPos.z)
          .setRotation(rq),
      );
      collider = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz)
          .setFriction(0.8)
          .setRestitution(0.1),
        rigidBody,
      );

      colliderWorldPos = { x: worldPos.x, y: worldPos.y, z: worldPos.z };

      // The Collider mesh itself is just a physics proxy — never rendered.
      colliderMesh.visible = false;
    } else if (this.world && !colliderMesh) {
      console.warn('[AmmoPoint] No "Collider" mesh found in crate GLB — falling back to no physics collider for this point.');
    }

    this.points.push({
      x: def.x, z: def.z, y,
      crate, icon,
      loadoutNode, destroyedLoadoutNode,
      rigidBody, collider, colliderWorldPos,
      cooldownTimer: 0,
      active: true,
      destroyed: false,
      respawnTimer: 0,
      health: AMMO_POINT_MAX_HEALTH,
    });
  }

  // ── Destroy / respawn a point ────────────────────────────────────────────
  // NOTE: the physics collider is intentionally left untouched by both of
  // these — it stays solid permanently, whether the crate is intact or
  // destroyed. Only the visible mesh and resupply availability change.
  _destroyPoint(p) {
    if (p.destroyed) return;
    p.destroyed    = true;
    p.active       = false;
    p.respawnTimer = AMMO_POINT_RESPAWN_TIME;
    p.health       = 0;
    p.icon.visible = false;

    // ── Swap the crate's visual state — show the wrecked model, hide the
    // intact one. If the GLB doesn't have these named nodes, fall back to
    // hiding the whole crate group (old behavior).
    if (p.loadoutNode || p.destroyedLoadoutNode) {
      if (p.loadoutNode) p.loadoutNode.visible = false;
      if (p.destroyedLoadoutNode) p.destroyedLoadoutNode.visible = true;
    } else {
      p.crate.visible = false;
    }

    if (this._nearPoint === p) {
      this._nearPoint = null;
      this._holdTimer = 0;
      this._showHUD(false);
    }
  }

  _respawnPoint(p) {
    p.destroyed    = false;
    p.active       = true;
    p.respawnTimer = 0;
    p.health       = AMMO_POINT_MAX_HEALTH;
    p.icon.visible = true;

    // ── Restore the intact visual, hide the wrecked one.
    if (p.loadoutNode || p.destroyedLoadoutNode) {
      if (p.loadoutNode) p.loadoutNode.visible = true;
      if (p.destroyedLoadoutNode) p.destroyedLoadoutNode.visible = false;
    } else {
      p.crate.visible = true;
    }
  }

  /**
   * Called by main.js from a weapon's onHit callback. Finds the nearest
   * currently-active point within `radius` of the impact and destroys it.
   * Returns the destroyed point object (so the caller can spawn an
   * explosion/sound at its exact location), or null if nothing was hit.
   */
  /**
   * Called by main.js from a weapon's onHit callback. Finds the nearest
   * currently-active point within `radius` of the impact and subtracts
   * `damage` from its health pool. Once health reaches 0 the point is
   * destroyed (swaps to the wrecked model, disables resupply — see
   * _destroyPoint). Returns:
   *   { point, destroyed: true }   — this hit broke the crate
   *   { point, destroyed: false }  — this hit landed but didn't break it yet
   *   null                        — no active point was within range
   */
  notifyHit(hitPosition, damage = 25, radius = 3) {
    if (!hitPosition) return null;
    let closest = null;
    let closestDsq = radius * radius;

    for (const p of this.points) {
      if (p.destroyed) continue;
      const cp = p.colliderWorldPos;
      const dx = cp.x - hitPosition.x;
      const dy = cp.y - hitPosition.y;
      const dz = cp.z - hitPosition.z;
      const dsq = dx * dx + dy * dy + dz * dz;
      if (dsq < closestDsq) {
        closestDsq = dsq;
        closest = p;
      }
    }

    if (!closest) return null;

    closest.health = Math.max(0, closest.health - damage);
    if (closest.health <= 0) {
      this._destroyPoint(closest);
      return { point: closest, destroyed: true };
    }
    return { point: closest, destroyed: false };
  }
  // ── Fallback box if GLB missing ──────────────────────────────────────────
  _makeFallbackCrate() {
    const group = new THREE.Group();
    const mesh  = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.7, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x8b6914, roughness: 0.8, metalness: 0.1 })
    );
    mesh.castShadow    = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    return group;
  }

_makeFloatingIcon() {
  let tex;

  if (this._iconTexture) {
    tex = this._iconTexture;
  } else {
    // Fallback: draw the old hex symbol if Ammo.png failed to load
    const canvas  = document.createElement('canvas');
    canvas.width  = 128;
    canvas.height = 128;
    const ctx     = canvas.getContext('2d');

    ctx.beginPath();
    ctx.arc(64, 64, 56, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(30,60,10,0.85)';
    ctx.fill();
    ctx.strokeStyle = '#8ac060';
    ctx.lineWidth   = 4;
    ctx.stroke();

    ctx.fillStyle = '#c8e888';
    ctx.font      = 'bold 64px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⬡', 64, 66);

    tex = new THREE.CanvasTexture(canvas);
  }

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      alphaTest: 0.01,
      premultipliedAlpha: false
    })
  );
  sprite.scale.set(1.0, 1.0, 1.0);
  return sprite;
}

  // ── HUD ──────────────────────────────────────────────────────────────────
  _buildHUD() {
    const wrap = document.createElement('div');
    wrap.id    = 'ammo-refill-hud';
    wrap.style.cssText = `
      display:none;
      position:fixed; bottom:160px; left:50%; transform:translateX(-50%);
      flex-direction:column; align-items:center; gap:8px;
      font-family:'Courier New',monospace; pointer-events:none; z-index:102;
    `;
    // ── Circular progress ring — same stroke-dashoffset pattern as the
    // tank/plane repair rings, with the ammo icon centered inside it
    // instead of a linear fill bar.
    wrap.innerHTML = `
      <div id="ammo-refill-ring" style="
        position:relative;
        width:56px; height:56px;
        display:flex; align-items:center; justify-content:center;
      ">
        <svg width="56" height="56" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg" style="position:absolute; top:0; left:0;">
          <circle cx="28" cy="28" r="24" fill="none" stroke="rgba(255, 255, 255, 0.25)" stroke-width="3"/>
          <circle cx="28" cy="28" r="24" fill="none" stroke="#ffffff" stroke-width="3"
            stroke-dasharray="150.8"
            stroke-dashoffset="150.8"
            stroke-linecap="round"
            transform="rotate(-90 28 28)"
            id="ammo-refill-fill"/>
        </svg>
        <svg width="26" height="26" viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg" style="position:relative;">
          <g fill="#ffffff">
            <path d="
              M141 383
              L157 339
              L159 269
              L164 269
              C166 214 179 160 190 132
              C194 124 204 127 208 135
              C220 164 232 216 234 269
              L238 269
              L238 339
              L255 383
              L255 642
              L141 642
              Z"/>
            <rect x="141" y="651" width="114" height="15"/>
            <path d="
              M274 383
              L291 339
              L292 269
              L297 269
              C299 214 312 160 323 132
              C327 124 337 127 341 135
              C353 164 365 216 367 269
              L371 269
              L371 339
              L388 383
              L388 642
              L274 642
              Z"/>
            <rect x="274" y="651" width="114" height="15"/>
            <path d="
              M410 383
              L427 339
              L428 269
              L433 269
              C435 214 448 160 459 132
              C463 124 473 127 477 135
              C489 164 501 216 503 269
              L507 269
              L507 339
              L524 383
              L524 642
              L410 642
              Z"/>
            <rect x="410" y="651" width="114" height="15"/>
            <path d="
              M542 383
              L559 339
              L560 269
              L565 269
              C567 214 580 160 591 132
              C595 124 605 127 609 135
              C621 164 633 216 635 269
              L639 269
              L639 339
              L656 383
              L656 642
              L542 642
              Z"/>
            <rect x="542" y="651" width="114" height="15"/>
          </g>
        </svg>
      </div>
      <div style="font-size:13px;color:#ffffff;letter-spacing:0.12em;">
        HOLD <span style="color:#ffdd44;font-size:16px;font-weight:bold;">[F]</span> TO RESUPPLY
      </div>
    `;
    document.body.appendChild(wrap);
    return wrap;
  }

  _setBarPct(pct) {
    const arc = document.getElementById('ammo-refill-fill');
    if (!arc) return;
    const clamped = Math.min(1, Math.max(0, pct));
    arc.style.transition = 'none';
    arc.style.strokeDashoffset = String(150.8 * (1 - clamped));
  }

  _showHUD(show) {
    this._hud.style.display = show ? 'flex' : 'none';
    if (!show) this._setBarPct(0);
  }

  // ── Main update — call every frame from main.js loop ─────────────────────
  /**
   * @param {number} dt
   * @param {{ x:number, y:number, z:number }} tankPos
   * @param {boolean} isDead
   * @param {boolean} isPaused
   * @param {boolean} matchEnded
   * @param {string}  vehicleType — 'tank' | 'plane', selects which ammo shape to check/refill
   * @param {object}  ammoState   — tank: { shellCount, mgAmmo, smokeCount, repairKits }
   *                                plane: { mgAmmo, rocketAmmo, bombAmmo, repairKits }
   * @param {object}  loadout     — starting loadout values to refill to (same shape as ammoState)
   * @param {Function} onRefill   — callback(filledAmmoState) — same shape as ammoState
   */
  update(dt, tankPos, isDead, isPaused, matchEnded, vehicleType, ammoState, loadout, onRefill) {
    // ── Destroyed-crate respawn countdown — ticks unconditionally, even if
    // tankPos is momentarily unavailable or the player is dead/paused, so a
    // shot-up crate reliably comes back on its own schedule.
    for (const p of this.points) {
      if (!p.destroyed) continue;
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) this._respawnPoint(p);
    }

    if (!tankPos) return;
    this._elapsed += dt;

    // ── Icon stays static — no bobbing ─────────────────────────────────────

    if (isDead || isPaused || matchEnded) {
      this._showHUD(false);
      this._holdTimer = 0;
      return;
    }

    // ── Proximity check — horizontal radius + separate vertical tolerance,
    // so a plane flying high overhead no longer registers as "near" a
    // ground-level crate ─────────────────────────────────────────────────
    this._nearPoint = null;
    for (const p of this.points) {
      if (p.destroyed) continue; // can't resupply from a destroyed crate
      const dx = p.x - tankPos.x;
      const dz = p.z - tankPos.z;
      const horizDistSq = dx * dx + dz * dz;
      const vertDist    = Math.abs(p.y - tankPos.y);

      if (horizDistSq < REFILL_RADIUS * REFILL_RADIUS && vertDist < REFILL_VERTICAL_TOLERANCE) {
        this._nearPoint = p;
        break;
      }
    }

    // ── Is ammo already full? ────────────────────────────────────────────────
    const isFull = this._nearPoint && this._isAmmoFull(vehicleType, ammoState, loadout);

    if (!this._nearPoint || isFull) {
      this._showHUD(false);
      this._holdTimer = 0;
      return;
    }

    // ── Show HUD, handle hold ─────────────────────────────────────────────────
    this._showHUD(true);

    if (this._fHeld) {
      this._holdTimer += dt;
      this._setBarPct(this._holdTimer / REFILL_HOLD_TIME);

      if (this._holdTimer >= REFILL_HOLD_TIME) {
        this._holdTimer = 0;
        this._setBarPct(0);
        this._doRefill(vehicleType, loadout, onRefill);
      }
    } else {
      this._holdTimer = 0;
      this._setBarPct(0);
    }
  }

  // ── Check if all ammo is already at max ──────────────────────────────────
  _isAmmoFull(vehicleType, ammoState, loadout) {
    if (vehicleType === 'plane') {
      let full = (
        ammoState.mgAmmo     >= (loadout.mgAmmo     ?? 150) &&
        ammoState.rocketAmmo >= (loadout.rocketAmmo ?? 6)   &&
        ammoState.bombAmmo   >= (loadout.bombAmmo   ?? 4)   &&
        ammoState.repairKits >= (loadout.repairKits ?? 0)
      );

      // ── AI turret gun ammo — only present on planes that actually have
      // AI_Gun_N turrets (see main.js's ammoPointSystem.update() call).
      // ammoState.aiGunAmmo / loadout.aiGunAmmoMax are parallel arrays,
      // one entry per gun (loaded + reserve combined, matching how
      // Plane._aiGunTotalAmmo tracks reserve — see plane.js).
      if (ammoState.aiGunAmmo && loadout.aiGunAmmoMax) {
        for (let i = 0; i < ammoState.aiGunAmmo.length; i++) {
          if (ammoState.aiGunAmmo[i] < (loadout.aiGunAmmoMax[i] ?? 0)) {
            full = false;
            break;
          }
        }
      }

      return full;
    }
    let full = (
      ammoState.shellCount  >= (loadout.shellCount  ?? 20)  &&
      ammoState.mgAmmo      >= (loadout.mgAmmo      ?? 150) &&
      ammoState.smokeCount  >= (loadout.smokeCount  ?? 2)   &&
      ammoState.repairKits  >= (loadout.repairKits  ?? 0)
    );

    // ── Rockets/special weapon — only relevant for tanks with
    // enableRockets: true. ammoState.specialAmmo is only ever present
    // when the tank has rockets (see main.js's ammoPointSystem.update()
    // call, which names this field `specialAmmo` to match tank.specialAmmo),
    // so this is a no-op for every other tank.
    if (ammoState.specialAmmo !== undefined) {
      full = full && ammoState.specialAmmo >= (loadout.specialAmmo ?? 0);
    }

    return full;
  }

  // ── Do the actual refill ─────────────────────────────────────────────────
  _doRefill(vehicleType, loadout, onRefill) {
    if (vehicleType === 'plane') {
      const filled = {
        mgAmmo:     loadout.mgAmmo     ?? 150,
        rocketAmmo: loadout.rocketAmmo ?? 6,
        bombAmmo:   loadout.bombAmmo   ?? 4,
        repairKits: loadout.repairKits ?? 0,
      };
      // Only included for planes that actually track AI gun ammo —
      // loadout.aiGunAmmoMax is only set by main.js when the plane has
      // AI_Gun_N turrets (see plane._aiGunSystems).
      if (loadout.aiGunAmmoMax) {
        filled.aiGunAmmo = loadout.aiGunAmmoMax.slice(); // full reserve per gun
      }
      onRefill(filled);
    } else {
      const filled = {
        shellCount: loadout.shellCount ?? 20,
        mgAmmo:     loadout.mgAmmo     ?? 150,
        smokeCount: loadout.smokeCount ?? 2,
        repairKits: loadout.repairKits ?? 0,
      };
      // Only include specialAmmo in the refill payload for tanks that
      // actually track it (loadout.specialAmmo is only set for
      // enableRockets tanks — see main.js, which names this field
      // `specialAmmo` to match tank.specialAmmo).
      if (loadout.specialAmmo !== undefined) {
        filled.specialAmmo = loadout.specialAmmo;
      }
      onRefill(filled);
    }

    // Flash HUD green
    const status = document.getElementById('ammo-refill-status');
    if (status) {
      const prev = status.textContent;
      status.style.color  = '#44ffaa';
      status.textContent  = '✓ RESUPPLIED';
      setTimeout(() => {
        status.style.color = '#8aaa50';
        status.textContent = prev;
      }, 1200);
    }
  }

  // ── Minimap dots ─────────────────────────────────────────────────────────
  /**
   * Call once after minimap is ready.
   * @param {Function} worldToMinimap  — your existing worldToMinimap(x,z)→{x,y}
   * @param {Element}  minimapEnemyEl  — the minimap overlay div
   */
  addMinimapDots(worldToMinimap, minimapEnemyEl) {
    this.points.forEach((p, i) => {
      const { x, y } = worldToMinimap(p.x, p.z);
      const dot = document.createElement('div');
      dot.id = `ammo-dot-${i}`;
      dot.style.cssText = `
        position:absolute; width:8px; height:8px;
        border-radius:2px;
        background:#ffcc00;
        left:${x}px; top:${y}px;
        transform:translate(-50%,-50%);
        pointer-events:none;
        filter:drop-shadow(0 0 3px rgba(255,200,0,0.9));
      `;
      minimapEnemyEl.appendChild(dot);
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    this.points.forEach(p => {
      this.scene.remove(p.crate);
      this.scene.remove(p.icon);
      p.crate.traverse(c => { c.geometry?.dispose(); c.material?.dispose(); });
      p.icon.material?.map?.dispose(); p.icon.material?.dispose();
      if (p.rigidBody) {
        try { this.world.removeRigidBody(p.rigidBody); } catch (_) {}
      }
    });
    this._hud?.remove();
    this.points = [];
  }
}