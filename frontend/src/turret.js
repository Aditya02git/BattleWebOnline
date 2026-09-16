import * as THREE from 'three';
import { isPointerLocked, getMouseFlightOffset } from './input.js';

const TURRET_TURN_SPEED = 1.0;
const BARREL_TURN_SPEED = 1.0;
const RETURN_SPEED      = 1.0;

const TURRET_MIN_ANGLE  = -Math.PI; 
const TURRET_MAX_ANGLE  =  Math.PI; 

const BARREL_MIN_ANGLE  = -0.25;
const BARREL_MAX_ANGLE  =  0.25;

const SKY_AIM_DISTANCE  = 400;

const SCOPE_TURRET_SPEED = 1.0;
const SCOPE_BARREL_SPEED = 1.0;

// 1.0 = perfect accuracy, 0.0 = maximum spread
// Controls how large the accuracy circles grow along the trajectory
export const ACCURACY = 0.95;

export class TurretController {
  constructor(turretMesh, barrelMesh, scene, options = {}) {
    this.turret  = turretMesh;
    this.barrel  = barrelMesh;
    this.scene   = scene;
    this.enabled = false;

    this._turretMinAngle = options.turretMinAngle ?? TURRET_MIN_ANGLE;
    this._turretMaxAngle = options.turretMaxAngle ?? TURRET_MAX_ANGLE;
    this._barrelMinAngle = options.barrelMinAngle ?? BARREL_MIN_ANGLE;
    this._barrelMaxAngle = options.barrelMaxAngle ?? BARREL_MAX_ANGLE;

    this._turretTurnSpeed = options.turretTurnSpeed ?? TURRET_TURN_SPEED;
    this._barrelTurnSpeed = options.barrelTurnSpeed ?? BARREL_TURN_SPEED;

    // Per-tank kick strength applied to the barrel-recoil spring every time
    // triggerRecoil() is called (see below) — configurable so heavier guns
    // can kick harder than light ones.
    this._recoilVelocity = options.recoilVelocity ?? -0.6;

    this.turretRestY = turretMesh.rotation.y;
    this.barrelRestX = barrelMesh.rotation.x;

    this.raycaster = new THREE.Raycaster();
    this.aimTarget = null;

    this.isTargetFixed = false;
    this.fixedTarget   = new THREE.Vector3();

    this.recoilAmount   = 0;
    this.recoilVelocity = 0;

    // ── Enemy pool reference — kept only for any other future use;
    // lock-on marking itself has been removed. ──────────────────────────
    this._enemyPool     = null;   // set via setEnemyPool() from main.js
    this._friendlyPool  = null;   // set via setFriendlyPool() from main.js

// ── Crosshair (CSS element — follows cursor in aim mode) ──────────────
    this._crosshair = document.createElement('div');
this._crosshair.style.cssText = `
      position: fixed;
      width: 30px;
      height: 30px;
      pointer-events: none;
      display: none;
      transform: translate(-50%, -50%);
      z-index: 9999;
    `;
    this._crosshair.innerHTML = `
      <div id="tank-crosshair-ring" style="transform:scale(1); transition:none;">
        <svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg">
          <circle cx="15" cy="15" r="12" fill="none" stroke="rgba(255, 0, 0, 0.35)" stroke-width="1.5"/>
          <circle cx="15" cy="15" r="12" fill="none" stroke="white" stroke-width="1.5"
            stroke-dasharray="75.4"
            stroke-dashoffset="0"
            stroke-linecap="round"
            transform="rotate(-90 15 15)"
            id="crosshair-fill"/>
        </svg>
      </div>
    `;
    document.body.appendChild(this._crosshair);

    // ── Repair cross — standalone fixed element (NOT nested inside
    // _crosshair). _crosshair's display is toggled every frame by
    // _aim()/_returnToRest() based on aim-mode state, which has nothing
    // to do with repairing — nesting the repair ring inside it meant the
    // repair progress was invisible whenever not aiming, and overlapped
    // the static aim ring (looking like a "duplicate crosshair") whenever
    // aiming. Standing alone here, it's shown/hidden purely by
    // showRepairCross()/hideRepairCross(), independent of aim state.
    this._repairCross = document.createElement('div');
    this._repairCross.id = 'tank-repair-cross';
    this._repairCross.style.cssText = `
      position: fixed;
      top: 50%; left: 50%;
      width: 30px; height: 30px;
      transform: translate(-50%, -50%);
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 9999;
    `;
    this._repairCross.innerHTML = `
      <svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg" style="position:absolute; top:0; left:0;">
        <circle cx="15" cy="15" r="12" fill="none" stroke="rgba(255, 255, 255, 0.35)" stroke-width="1.5"/>
        <circle cx="15" cy="15" r="12" fill="none" stroke="rgb(255, 255, 255)" stroke-width="1.5"
          stroke-dasharray="75.4"
          stroke-dashoffset="75.4"
          stroke-linecap="round"
          transform="rotate(-90 15 15)"
          id="tank-repair-fill"/>
      </svg>
      <svg width="16" height="16" viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg" style="display:block; position:relative;">
        <path fill="#ffffff" d="
          M778,122
          L758,106 L748,108 L665,214 L629,217 L568,166
          L563,131 L638,29 L637,17 L615,0 L595,3
          L545,24 L501,54 L466,92 L451,121 L438,178
          L436,251 L421,294 L30,672 L16,698 L13,732
          L20,756 L34,776 L59,793 L83,799 L110,797 L139,783
          L516,377 L532,368 L550,363 L615,358 L663,349
          L694,335 L715,320 L753,278 L766,257 L779,226
          L786,190 L786,162 Z

          M559,432
          L431,560 L635,762 L658,774 L684,779 L715,775
          L735,766 L759,745 L775,715 L779,691 L778,675
          L767,643 L758,630 Z

          M84,21
          L21,86 L93,202 L162,217 L294,348
          L349,295 L217,162 L201,91 Z
        "/>
      </svg>
    `;
    document.body.appendChild(this._repairCross);
    this._repairFillEl = this._repairCross.querySelector('#tank-repair-fill');

    // ── Hit marker — cheap opacity+scale corner-flash overlay, nested
    // inside _crosshair so it automatically tracks the crosshair's screen
    // position every frame without needing its own per-frame transform
    // update. Same pattern as planeHitMarker in main.js.
    this._hitMarker = document.createElement('div');
    this._hitMarker.id = 'tank-hit-marker';
    this._hitMarker.style.cssText = `
      position:absolute; top:50%; left:50%;
      width:28px; height:28px;
      margin:-14px 0 0 -14px;
      pointer-events:none;
      opacity:0;
      transform:scale(0.6);
      transition:none;
    `;
    this._hitMarker.innerHTML = `
      <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
        <line x1="4" y1="4" x2="9" y2="9" stroke="#ffffff" stroke-width="2"/>
        <line x1="24" y1="4" x2="19" y2="9" stroke="#ffffff" stroke-width="2"/>
        <line x1="4" y1="24" x2="9" y2="19" stroke="#ffffff" stroke-width="2"/>
        <line x1="24" y1="24" x2="19" y2="19" stroke="#ffffff" stroke-width="2"/>
      </svg>
    `;
    this._crosshair.appendChild(this._hitMarker);
    this._hitMarkerTimer = null;

    // ── Turret-tracking crosshair (always visible, follows turret aim) ─────
    this._turretCrosshair = document.createElement('div');
    this._turretCrosshair.style.cssText = `
      position: fixed;
      width: 48px;
      height: 48px;
      pointer-events: none;
      display: none;
      transform: translate(-50%, -50%);
      z-index: 9998;
    `;
    this._turretCrosshair.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <!-- Left arc ( -->
        <path d="M 10 10 A 18 18 0 0 0 10 38"
          fill="none"
          stroke="rgba(255,255,255,0.75)"
          stroke-width="2"
          stroke-linecap="round"/>
        <!-- Right arc ) -->
        <path d="M 38 10 A 18 18 0 0 1 38 38"
          fill="none"
          stroke="rgba(255,255,255,0.75)"
          stroke-width="2"
          stroke-linecap="round"/>
      </svg>
    `;
    document.body.appendChild(this._turretCrosshair);

    // Track mouse position for crosshair placement — must account for
    // Pointer Lock: while locked, the real cursor never moves (the browser
    // traps it), so e.clientX/Y stays frozen at whatever position it was
    // at the instant lock engaged. Mirror main.js's own _onMousemove fix:
    // derive screen position from input.js's virtual cursor (accumulated
    // via movementX/Y while locked) instead, so the crosshair keeps
    // tracking the invisible locked "cursor" instead of freezing in place.
    this._mouseScreenX = window.innerWidth  / 2;
    this._mouseScreenY = window.innerHeight / 2;
    window.addEventListener('mousemove', (e) => {
      if (isPointerLocked()) {
        const off = getMouseFlightOffset(); // -1..1, same source plane.js's flight control reads
        this._mouseScreenX = window.innerWidth  * 0.5 + off.x * (window.innerWidth  * 0.5);
        this._mouseScreenY = window.innerHeight * 0.5 + off.y * (window.innerHeight * 0.5);
      } else {
        this._mouseScreenX = e.clientX;
        this._mouseScreenY = e.clientY;
      }
    });

    this.gunPoint   = null;
    this.scopePoint = null;   // ← add — feeds ScopeSystem's camera position only

    // Store the sampled arc points so fire() can use them for deflection
    this._arcPoints = [];

    this.barrelRestZ = barrelMesh.position.z;

    this.barrelGun = barrelMesh.getObjectByName('BarrelGun');
this.barrelGunRestZ = this.barrelGun ? this.barrelGun.position.z : 0;

    // ── Laser rangefinder HUD element ─────────────────────────────────────
this._rangeDisplay = document.createElement('div');
this._rangeDisplay.style.cssText = `
  position: fixed;
  bottom: 38%;
  left: 30.5%;
  transform: translateX(-50%);
  font-family: 'Courier New', monospace;
  font-size: 14px;
  color: rgba(180, 220, 100, 0.92);
  letter-spacing: 0.15em;
  pointer-events: none;
  display: none;
  z-index: 200;
  text-shadow: 0 0 8px rgba(100,180,40,0.7);
  padding: 3px 14px;
`;
document.body.appendChild(this._rangeDisplay);

this._laserActive  = false;
this._laserDistance = null;

// Key listeners for L key
this._onKeyDown = (e) => {
  if (e.key === 'e' || e.key === 'E') this._laserActive = true;
};
this._onKeyUp = (e) => {
  if (e.key === 'e' || e.key === 'E') {
    this._laserActive = false;
    // Don't hide — keep showing last measured distance
  }
};
window.addEventListener('keydown', this._onKeyDown);
window.addEventListener('keyup',   this._onKeyUp);
  }

// ── Re-point this controller at a freshly-loaded turret/barrel mesh pair
// after respawn, WITHOUT tearing down the controller itself. Keeps
// _enemyPool/_friendlyPool/_camera/_markedEnemies/DOM crosshairs all intact
// across the tank's lifetime — only the mesh refs and rest-pose values
// need to change, since the old GLB nodes are gone and new ones replace
// them on every respawn. ────────────────────────────────────────────────
rebindMeshes(turretMesh, barrelMesh) {
  this.turret = turretMesh;
  this.barrel = barrelMesh;
  this.turretRestY = turretMesh.rotation.y;
  this.barrelRestX = barrelMesh.rotation.x;
  this.barrelRestZ = barrelMesh.position.z;
  this.barrelGun = barrelMesh.getObjectByName('BarrelGun');
  this.barrelGunRestZ = this.barrelGun ? this.barrelGun.position.z : 0;

  // Reset per-frame turret-sound deltas so the first frame after rebind
  // doesn't compare against the old (now-destroyed) mesh's last rotation
  this._prevTurretY = undefined;
  this._prevBarrelX = undefined;
}

setGunPoint(gp) {
    this.gunPoint = gp;
  }

  setScopePoint(sp) {   // ← add
    this.scopePoint = sp;
  }

/** Wire up the enemy pool so the turret can resolve raycast hits to EnemyTank instances. */
  setEnemyPool(enemyPool) {
    this._enemyPool = enemyPool;
  }

  /** Wire up the friendly pool so the turret can also mark friendly tanks. */
  setFriendlyPool(friendlyPool) {
    this._friendlyPool = friendlyPool;
  }

  setCamera(camera) {
    this._camera = camera;
  }

  // ── Compute random deflection offset for an actual fired bullet ───────────
  // Call this from bullet.js / tank.js instead of using the raw barrel direction.
  // Returns a THREE.Vector3 direction (normalised) with spread applied.
getDeflectedDirection() {
  if (!this.gunPoint) return null;

  const barrelDir = new THREE.Vector3();
  this.gunPoint.getWorldDirection(barrelDir);
  return barrelDir;
}

// ── Project turret aim direction onto screen for the turret crosshair ────
  _updateTurretCrosshair() {
    if (!this._camera || !this.turret) {
      // Hide both crosshairs when turret is ejected
      this._turretCrosshair.style.display = 'none';
      this._crosshair.style.display = 'none';
      return;
    }

    // Only shown once we actually compute a real position below —
    // stays hidden by default (e.g. during spawn-selection, before the
    // turret controller's update() loop is running).
    this._turretCrosshair.style.display = 'block';

    // Build a world-space point along the turret's horizontal aim direction
    // (turret yaw only — ignores barrel pitch so it truly follows turret rotation)
    const turretWorldPos = new THREE.Vector3();
    this.turret.getWorldPosition(turretWorldPos);

    // Get turret's world quaternion for yaw-only direction
    const turretWorldQ = new THREE.Quaternion();
    this.turret.getWorldQuaternion(turretWorldQ);

    // Local forward for this turret is +Z (same convention as the barrel)
    const localFwd = new THREE.Vector3(0, 0, 1);
    const worldFwd = localFwd.applyQuaternion(turretWorldQ);
    worldFwd.y = 0;   // flatten — turret crosshair ignores barrel pitch
    worldFwd.normalize();

    const aimPoint = turretWorldPos.clone().addScaledVector(worldFwd, 200);

    // Project to NDC
    const ndc = aimPoint.clone().project(this._camera);

    // Off-screen — clamp to screen edge so it's never lost
    const clampedX = THREE.MathUtils.clamp(ndc.x, -0.98, 0.98);
    const clampedY = THREE.MathUtils.clamp(ndc.y, -0.98, 0.98);

    const sx = ( clampedX * 0.5 + 0.5) * window.innerWidth;
    const sy = (-clampedY * 0.5 + 0.5) * window.innerHeight;

    this._turretCrosshair.style.left = sx + 'px';
    this._turretCrosshair.style.top  = sy + 'px';

    // Dim slightly when behind the camera (ndc.z > 1)
    this._turretCrosshair.style.opacity = ndc.z > 1 ? '0.25' : '1.0';
  }

  // ── Toggle ────────────────────────────────────────────────────────────────

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      this.isTargetFixed = false;
    }
  }

  // ── Full reset — call immediately when the player tank is destroyed.
  // Clears every piece of aim/scope state instead of just hiding the DOM
  // crosshairs, so a respawn starts clean rather than inheriting whatever
  // aim mode (free-aim, fixed target, laser rangefinder, lock-on) was
  // active at the exact moment of death. Safe to call even though
  // this.turret/this.barrel may already be null (turret ejected). ────────
  resetOnDeath() {
  this.enabled          = false;
  this.isTargetFixed    = false;
  this.aimTarget        = null;
  this._laserActive     = false;
  this._lastLRFDistance = null;
  this.recoilAmount     = 0;
  this.recoilVelocity   = 0;
  this._prevTurretY     = undefined;
  this._prevBarrelX     = undefined;

  this._crosshair.style.display       = 'none';
  this._turretCrosshair.style.display = 'none';
  this._rangeDisplay.style.display    = 'none';
  this.hideRepairCross();
}

// ── Hides just the turret's own screen HUD (crosshair, turret-tracking
  // crosshair, range display) WITHOUT touching aim/lock/marker state —
  // unlike resetOnDeath(), this is for a vehicle switch (tank → plane),
  // not a death. update() stops being called on this controller the
  // moment the player isn't driving the tank, so these elements would
  // otherwise stay frozen on screen at their last position/opacity.
  hideHud() {
    this._crosshair.style.display       = 'none';
    this._turretCrosshair.style.display = 'none';
    this._rangeDisplay.style.display    = 'none';
    this.hideRepairCross();
  }

  triggerRecoil() {
    this.recoilVelocity = this._recoilVelocity;
  }

  // ── Flashes the tank's hit marker — same corner-flash + ring-punch
  // treatment as the plane's showPlaneHitMarker() in main.js. Safe to
  // call rapidly (e.g. MG spraying an enemy) — each call just restarts
  // the animation from full opacity.
  showHitMarker() {
    if (this._hitMarkerTimer) clearTimeout(this._hitMarkerTimer);

    this._hitMarker.style.transition = 'none';
    this._hitMarker.style.opacity    = '1';
    this._hitMarker.style.transform  = 'scale(1.15)';

    const ringEl = document.getElementById('tank-crosshair-ring');
    if (ringEl) {
      ringEl.style.transition = 'none';
      ringEl.style.transform  = 'scale(0.7)';
    }

    void this._hitMarker.getBoundingClientRect(); // force reflow so the transitions below actually animate

    this._hitMarker.style.transition = 'opacity 0.50s ease-out, transform 0.50s ease-out';
    this._hitMarker.style.opacity    = '0';
    this._hitMarker.style.transform  = 'scale(0.9)';

    if (ringEl) {
      ringEl.style.transition = 'transform 0.50s ease-out';
      ringEl.style.transform  = 'scale(1)';
    }

    this._hitMarkerTimer = setTimeout(() => { this._hitMarkerTimer = null; }, 260);
  }

  // ── Repair cross — shown/hidden by main.js while the player holds the
  // repair action. Standalone element (see constructor) — visibility is
  // no longer tied to _crosshair's aim-mode display toggling.
  showRepairCross() {
    if (this._repairCross) this._repairCross.style.display = 'flex';
    this.setRepairProgress(0);
  }

  hideRepairCross() {
    if (this._repairCross) this._repairCross.style.display = 'none';
    this.setRepairProgress(0);
  }
  // ── Drives the repair-progress ring, exactly like startReloadAnimation's
  // stroke-dashoffset trick, but takes a live 0..1 fraction each frame
  // (repair hold time is player-cancelable, so this can't be a fire-and-
  // forget CSS transition the way reload's fixed-duration animation is).
  setRepairProgress(fraction) {
    const arc = this._repairFillEl;
    if (!arc) return;
    const clamped = Math.min(1, Math.max(0, fraction));
    arc.style.transition = 'none';
    arc.style.strokeDashoffset = String(75.4 * (1 - clamped));
  }

  // ── Main update ───────────────────────────────────────────────────────────

update(dt, camera, mouse, tankWorldPos, world, tankRigidBody, scopeSystem, audioSystem) {
  // ── Guard: turret was ejected on death ───────────────────────────────
  if (!this.turret || !this.barrel) return;
  // ── Guard: match ended — freeze turret, hide crosshairs ──────────────
  if (this._matchEnded) {
    this._crosshair.style.display       = 'none';
    this._turretCrosshair.style.display = 'none';
    this._rangeDisplay.style.display    = 'none';
    return;
  }

  this._scopeSystem = scopeSystem;   // cache for use in rangefinder check

  if (this.enabled) {
    this._aim(dt, camera, mouse, world, tankRigidBody, scopeSystem);
  } else {
    this._returnToRest(dt);
  }

  const STIFFNESS  = 18;
  const DAMPING    = 6;
  this.recoilVelocity += (-STIFFNESS * this.recoilAmount) * dt;
  this.recoilVelocity *= (1 - DAMPING * dt);
  this.recoilAmount   += this.recoilVelocity * dt;

  if (this.barrelGun) {
  this.barrelGun.position.z = this.barrelGunRestZ + this.recoilAmount;
}
// ── Turret rotation sound ─────────────────────────────────────────────
  if (audioSystem) {
    const prevTurretY  = this._prevTurretY  ?? this.turret.rotation.y;
    const prevBarrelX  = this._prevBarrelX  ?? this.barrel.rotation.x;
    const turretDelta  = Math.abs(this.turret.rotation.y - prevTurretY);
    const barrelDelta  = Math.abs(this.barrel.rotation.x - prevBarrelX);
    const isRotating   = this.enabled && (turretDelta > 0.0025 || barrelDelta > 0.001);
    this._prevTurretY  = this.turret.rotation.y;
    this._prevBarrelX  = this.barrel.rotation.x;
    audioSystem.updateTurret(isRotating, dt);
  }
  // Always update turret crosshair regardless of aim mode
  this._updateTurretCrosshair();

  // this._updateMarkedEnemies(dt);

// ── Laser rangefinder — only fires when L is held AND in scope mode ───
if (this._laserActive && this.enabled && this._scopeSystem?.isScoped) {
  this.fireLaserRangefinder(world, tankRigidBody);
}
}

  // ── Aim ───────────────────────────────────────────────────────────────────

_aim(dt, camera, mouse, world, tankRigidBody, scopeSystem) {
  // ── Guard: turret was ejected on death ───────────────────────────────
  if (!this.turret || !this.barrel) return;

    // ── Scope mode: delta-based rotation, no raycasting ───────────────────
// ── Scope mode: delta-based rotation, no raycasting ───────────────────
if (scopeSystem && scopeSystem.isScoped) {
  // Main gun scope pins the crosshair to screen center (fixed reticle).
  // The gunner sight has no fixed reticle — crosshair follows the real cursor.
  if (scopeSystem.scopeMode === 'gunner') {
    this._crosshair.style.left = this._mouseScreenX + 'px';
    this._crosshair.style.top  = this._mouseScreenY + 'px';
  } else {
    this._crosshair.style.left = (window.innerWidth  / 2) + 'px';
    this._crosshair.style.top  = (window.innerHeight / 2) + 'px';
  }
  this._crosshair.style.display = 'block';

  // Show last LRF reading in scope (or placeholder if never measured)
  const label = this._lastLRFDistance != null ? `LRF  ${this._lastLRFDistance}m` : `LRF  ---`;
  this._rangeDisplay.style.display = 'block';
  this._rangeDisplay.textContent   = label;

  if (!this.isTargetFixed) {
    // ── Gunner sight: raycast from real cursor position → aim turret/barrel there ──
    if (scopeSystem.scopeMode === 'gunner' && this._camera) {
      const gunnerMouse = new THREE.Vector2(
        ( this._mouseScreenX / window.innerWidth  ) * 2 - 1,
        -( this._mouseScreenY / window.innerHeight ) * 2 + 1
      );
      this.raycaster.setFromCamera(gunnerMouse, this._camera);
      const ray = this.raycaster.ray;

      const RAPIER    = world.__RAPIER__;
      const rapierRay = new RAPIER.Ray(
        { x: ray.origin.x,    y: ray.origin.y,    z: ray.origin.z },
        { x: ray.direction.x, y: ray.direction.y, z: ray.direction.z }
      );
      const hit = world.castRay(rapierRay, 1000, true, undefined, undefined, undefined, tankRigidBody);
      // this._checkLockOn(hit, dt);

      if (!this.aimTarget) this.aimTarget = new THREE.Vector3();
      if (hit) {
        this.aimTarget.set(
          ray.origin.x + ray.direction.x * hit.timeOfImpact,
          ray.origin.y + ray.direction.y * hit.timeOfImpact,
          ray.origin.z + ray.direction.z * hit.timeOfImpact,
        );
      } else {
        this.aimTarget.copy(ray.origin).addScaledVector(ray.direction, SKY_AIM_DISTANCE);
      }

      // ── Turret: horizontal rotation toward cursor raycast target ─────────
      const turretWorldPos = new THREE.Vector3();
      this.turret.getWorldPosition(turretWorldPos);
      const worldDir = new THREE.Vector3().subVectors(this.aimTarget, turretWorldPos).normalize();
      const parentWorldQ = new THREE.Quaternion();
      this.turret.parent.getWorldQuaternion(parentWorldQ);
      const localDir = worldDir.clone().applyQuaternion(parentWorldQ.clone().invert());
      const rawYaw   = Math.atan2(localDir.x, localDir.z);
      const is360    = this._turretMinAngle <= -Math.PI && this._turretMaxAngle >= Math.PI;
      if (is360) {
        let diff = rawYaw - this.turret.rotation.y;
        diff = ((diff + Math.PI) % (2 * Math.PI)) - Math.PI;
        this.turret.rotation.y += diff * Math.min(1, dt * this._turretTurnSpeed);
      } else {
        const targetYaw = THREE.MathUtils.clamp(rawYaw, this._turretMinAngle, this._turretMaxAngle);
        let diff = targetYaw - this.turret.rotation.y;
        diff = ((diff + Math.PI) % (2 * Math.PI)) - Math.PI;
        this.turret.rotation.y = THREE.MathUtils.clamp(
          this.turret.rotation.y + diff * Math.min(1, dt * this._turretTurnSpeed),
          this._turretMinAngle,
          this._turretMaxAngle
        );
      }

      // ── Barrel: vertical rotation toward cursor raycast target ───────────
      const barrelWorldPos = new THREE.Vector3();
      this.barrel.getWorldPosition(barrelWorldPos);
      const horizontalDist = new THREE.Vector2(
        this.aimTarget.x - barrelWorldPos.x,
        this.aimTarget.z - barrelWorldPos.z
      ).length();
      const verticalDiff = this.aimTarget.y - barrelWorldPos.y;
      const rawPitch     = Math.atan2(verticalDiff, horizontalDist);
      const targetPitch  = THREE.MathUtils.clamp(-rawPitch, this._barrelMinAngle, this._barrelMaxAngle);
      this.barrel.rotation.x = THREE.MathUtils.lerp(
        this.barrel.rotation.x, targetPitch, Math.min(1, dt * this._barrelTurnSpeed)
      );

    } else {
      // ── Main gun scope: original delta-based rotation ─────────────────────
      const dx = scopeSystem.getMouseDeltaX();
      const dy = scopeSystem.getMouseDeltaY();
      const speedX = dx * Math.abs(dx);
      const speedY = dy * Math.abs(dy);
      const is360  = this._turretMinAngle <= -Math.PI && this._turretMaxAngle >= Math.PI;
      if (is360) {
        this.turret.rotation.y -= speedX * SCOPE_TURRET_SPEED * dt;
      } else {
        this.turret.rotation.y = THREE.MathUtils.clamp(
          this.turret.rotation.y - speedX * SCOPE_TURRET_SPEED * dt,
          this._turretMinAngle,
          this._turretMaxAngle
        );
      }
      this.barrel.rotation.x = THREE.MathUtils.clamp(
        this.barrel.rotation.x + speedY * SCOPE_BARREL_SPEED * dt,
        this._barrelMinAngle,
        this._barrelMaxAngle
      );
    }
  }

  // Always update aimTarget from current barrel direction (for non-gunner modes or aim lock)
  if (this.gunPoint && scopeSystem.scopeMode !== 'gunner') {
    const gunPos = new THREE.Vector3();
    const gunDir = new THREE.Vector3();
    this.gunPoint.getWorldPosition(gunPos);
    this.gunPoint.getWorldDirection(gunDir);
    if (!this.aimTarget) this.aimTarget = new THREE.Vector3();

    if (this.isTargetFixed) {
      this.aimTarget.copy(this.fixedTarget);
    } else {
      this.aimTarget.copy(gunPos).addScaledVector(gunDir, 500);
    }
  }

  return;
}


    // ── Normal aim mode (existing code unchanged below) ───────────────────
    if (!this.isTargetFixed) {
      this.raycaster.setFromCamera(mouse, camera);
      const ray = this.raycaster.ray;

      const RAPIER    = world.__RAPIER__;
      const rapierRay = new RAPIER.Ray(
        { x: ray.origin.x,    y: ray.origin.y,    z: ray.origin.z },
        { x: ray.direction.x, y: ray.direction.y, z: ray.direction.z }
      );
      const hit = world.castRay(rapierRay, 1000, true, undefined, undefined, undefined, tankRigidBody);

      if (!this.aimTarget) this.aimTarget = new THREE.Vector3();

      if (hit) {
        this.aimTarget.set(
          ray.origin.x + ray.direction.x * hit.timeOfImpact,
          ray.origin.y + ray.direction.y * hit.timeOfImpact,
          ray.origin.z + ray.direction.z * hit.timeOfImpact,
        );
      } else {
        this.aimTarget.copy(ray.origin).addScaledVector(ray.direction, SKY_AIM_DISTANCE);
      }
    } else {
      if (!this.aimTarget) this.aimTarget = new THREE.Vector3();
      this.aimTarget.copy(this.fixedTarget);
    }

    // ── Turret: horizontal rotation ───────────────────────────────────────
    const turretWorldPos = new THREE.Vector3();
    this.turret.getWorldPosition(turretWorldPos);

    const worldDir = new THREE.Vector3()
      .subVectors(this.aimTarget, turretWorldPos)
      .normalize();

    const parentWorldQ = new THREE.Quaternion();
    this.turret.parent.getWorldQuaternion(parentWorldQ);
    const parentInvQ = parentWorldQ.clone().invert();
    const localDir   = worldDir.clone().applyQuaternion(parentInvQ);

    const rawYaw = Math.atan2(localDir.x, localDir.z);
    const is360 = this._turretMinAngle <= -Math.PI && this._turretMaxAngle >= Math.PI;

    if (is360) {
      // Full 360: shortest-path rotate with no clamping
      let diff = rawYaw - this.turret.rotation.y;
      diff = ((diff + Math.PI) % (2 * Math.PI)) - Math.PI;
      this.turret.rotation.y += diff * Math.min(1, dt * this._turretTurnSpeed);
    } else {
      const targetYaw = THREE.MathUtils.clamp(rawYaw, this._turretMinAngle, this._turretMaxAngle);
      let diff = targetYaw - this.turret.rotation.y;
      diff = ((diff + Math.PI) % (2 * Math.PI)) - Math.PI;
      this.turret.rotation.y = THREE.MathUtils.clamp(
        this.turret.rotation.y + diff * Math.min(1, dt * this._turretTurnSpeed),
        this._turretMinAngle,
        this._turretMaxAngle
      );
    }

    // ── Barrel: vertical rotation ─────────────────────────────────────────
    const barrelWorldPos = new THREE.Vector3();
    this.barrel.getWorldPosition(barrelWorldPos);

    const horizontalDist = new THREE.Vector2(
      this.aimTarget.x - barrelWorldPos.x,
      this.aimTarget.z - barrelWorldPos.z
    ).length();
    const verticalDiff = this.aimTarget.y - barrelWorldPos.y;

    const rawPitch = Math.atan2(verticalDiff, horizontalDist);
    const targetPitch = THREE.MathUtils.clamp(
      -rawPitch,
      this._barrelMinAngle,
      this._barrelMaxAngle
    );

    this.barrel.rotation.x = THREE.MathUtils.lerp(
      this.barrel.rotation.x,
      targetPitch,
      Math.min(1, dt * this._barrelTurnSpeed)
    );

    this._crosshair.style.display = 'block';
    this._crosshair.style.left = this._mouseScreenX + 'px';
    this._crosshair.style.top  = this._mouseScreenY + 'px';
  }

  // ── Fix target ────────────────────────────────────────────────────────────

  fixTarget() {
    if (!this.enabled || !this.aimTarget) return;
    if (this.isTargetFixed) {
      this.isTargetFixed = false;
    } else {
      this.fixedTarget.copy(this.aimTarget);
      this.isTargetFixed = true;
    }
  }

  // ── Return to rest ────────────────────────────────────────────────────────

_returnToRest(dt) {
  // ── Guard: turret was ejected on death ───────────────────────────────
  if (!this.turret || !this.barrel) return;

    this._crosshair.style.display = 'none';

    const is360 = this._turretMinAngle <= -Math.PI && this._turretMaxAngle >= Math.PI;
    if (is360) {
      // Shortest-path return to rest so it doesn't spin the long way round
      let restDiff = this.turretRestY - this.turret.rotation.y;
      restDiff = ((restDiff + Math.PI) % (2 * Math.PI)) - Math.PI;
      this.turret.rotation.y += restDiff * Math.min(1, dt * RETURN_SPEED);
    } else {
      this.turret.rotation.y = THREE.MathUtils.lerp(
        this.turret.rotation.y,
        this.turretRestY,
        Math.min(1, dt * RETURN_SPEED)
      );
    }
    this.barrel.rotation.x = THREE.MathUtils.lerp(
      this.barrel.rotation.x,
      this.barrelRestX,
      Math.min(1, dt * RETURN_SPEED)
    );
  }

startReloadAnimation(duration, isScoped = false) {
  const arc = this._crosshair.querySelector('#crosshair-fill');
  if (!arc) return;

  if (isScoped) {
    // Pin to center and show only during reload
    this._crosshair.style.left = (window.innerWidth  / 2) + 'px';
    this._crosshair.style.top  = (window.innerHeight / 2) + 'px';
    this._crosshair.style.display = 'block';
    clearTimeout(this._scopeReloadTimeout);
    this._scopeReloadTimeout = setTimeout(() => {
      this._crosshair.style.display = 'none';
    }, duration * 1000);
  }

  // Reload ring animation — runs in both modes
// Reload ring animation — snap to empty, then fill back up
arc.style.transition = 'none';
  arc.style.strokeDashoffset = '75.4';
  void arc.getBoundingClientRect();   // force reflow so the snap registers
  requestAnimationFrame(() => {
    arc.style.transition = `stroke-dashoffset ${duration}s linear`;
    arc.style.strokeDashoffset = '0';
  });
}

// ── Laser rangefinder — called every frame when L is held ─────────────
fireLaserRangefinder(world, tankRigidBody) {
  if (!this.gunPoint || !world) return;

  const RAPIER = world.__RAPIER__;

  const origin = new THREE.Vector3();
  const dir    = new THREE.Vector3();
  this.gunPoint.getWorldPosition(origin);
  this.gunPoint.getWorldDirection(dir);

  const rapierRay = new RAPIER.Ray(
    { x: origin.x, y: origin.y, z: origin.z },
    { x: dir.x,    y: dir.y,    z: dir.z    }
  );

  const hit = world.castRay(rapierRay, 2000, true, undefined, undefined, undefined, tankRigidBody);

  if (hit) {
    this._lastLRFDistance = Math.round(hit.timeOfImpact);
  } else {
    this._lastLRFDistance = null;
  }

  const label = this._lastLRFDistance !== null ? `LRF  ${this._lastLRFDistance}m` : `LRF  ---`;
  this._rangeDisplay.style.display = 'block';
  this._rangeDisplay.textContent   = label;
}

dispose() {
  if (this._hitMarkerTimer) clearTimeout(this._hitMarkerTimer);
  this._crosshair.style.display = 'none';
  this._crosshair.remove();
  this._turretCrosshair.style.display = 'none';
  this._turretCrosshair.remove();
  this._rangeDisplay.style.display = 'none';
  this._rangeDisplay.remove();
  if (this._repairCross) {
    this._repairCross.style.display = 'none';
    this._repairCross.remove();
    this._repairCross = null;
    this._repairFillEl = null;
  }
  window.removeEventListener('keydown', this._onKeyDown);
  window.removeEventListener('keyup',   this._onKeyUp);
}
}
