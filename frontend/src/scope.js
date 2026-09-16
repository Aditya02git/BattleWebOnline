import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { isPointerLocked, getMouseFlightOffset } from './input.js';

export class ScopeSystem {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   * @param {object} options
   * @param {boolean} options.holdScope  — true = hold RMB, false = toggle on double-click
   * @param {string}  options.texturePath — path to .ktx2 scope overlay image
   * @param {number}  options.zoomFOV    — FOV when scoped in (default 15)
   * @param {number}  options.normalFOV  — FOV when not scoped (default 55)
   * @param {string}  options.scopeHudStyle — 'old' (default, glowing crosshair) or
   *                                           'modern' (F16-style flight HUD, planes only)
   */
// REPLACE WITH:
  constructor(renderer, camera, options = {}) {
    this.renderer    = renderer;
    this.camera      = camera;
    this.holdScope   = options.holdScope   ?? false;
    this.texturePath = options.texturePath ?? '/textures/scope_1.png';
    this.scopeType   = options.scopeType   ?? 1;   // 0 = no overlay texture/vignette, plain zoomed view
    this.scopeHudStyle = options.scopeHudStyle ?? 'old';   // 'old' = glowing crosshair, 'modern' = F16-style flight HUD
    this._scopeImageCache = {};   // scopeType (1-5) → loaded Image, so switching vehicles doesn't re-fetch
    this.gunnerTexturePath = options.gunnerTexturePath ?? '/textures/gunner_sight.png';
    this.gunnerZoomFOV     = options.gunnerZoomFOV    ?? options.zoomFOV ?? 15;
    this.zoomFOV      = options.zoomFOV      ?? 15;
    this.planeZoomFOV = options.planeZoomFOV ?? options.zoomFOV ?? 15;   // falls back to zoomFOV if not set
    this.bombZoomFOV  = options.bombZoomFOV  ?? 35;   // FOV while in the plane's downward bomb-sight view    
    this.normalFOV      = options.normalFOV      ?? 55;
    this.planeNormalFOV = options.planeNormalFOV ?? options.normalFOV ?? 55;   // non-scoped FOV while flying — falls back to normalFOV if not set

    this.isScoped    = false;
    this._texture    = null;
    this._overlay    = null;
    this._ctx        = null;
    this._loaded     = false;
    this.gunPoint    = null;   // set via setGunPoint() after model loads — firing direction only, not used for camera anymore
    this.scopePoint  = null;   // ← add — dedicated node for scope camera position
    this.bombPoint   = null;   // ← BombPoint node, used for the plane's downward bomb-sight scope view    
    this.tank        = null;
    this._prevCamPos = new THREE.Vector3();
    this._prevCamQ   = new THREE.Quaternion();

    // ── Corrective rotation applied on top of the scope-source node's
    // world quaternion, in case its authored local orientation doesn't
    // already face "camera forward" (-Z). Identity (no-op) by default —
    // only set this if the scope view looks rotated/inverted after the
    // quaternion-copy fix in update().
    this._scopeAxisCorrectionQ = new THREE.Quaternion();
    this._scopeAxisCorrectionQ.setFromEuler(new THREE.Euler(0, Math.PI, 0));
    // ── Scratch objects for the bomb-sight's downward-look orientation —
    // computed fresh every frame in update(), never allocated there.
    this._bombUpScratch     = new THREE.Vector3();
    this._bombTargetScratch = new THREE.Vector3();
    this._bombMatrixScratch = new THREE.Matrix4();    

    // ── Rear-view toggle (plane only) — flipped by "V" while flying,
    // consumed by main.js's plane chase-camera to look backward ─────────
    this.vehicleType = 'tank';   // set by main.js whenever the active vehicle changes
    this.rearViewActive = false;

    // ── Set by main.js while the spawn-selection screen owns the camera —
    // blocks the "V" gunner-sight/rear-view toggle from firing during that
    // window (see _onGunnerKeyDown below).
    this.spawnSelectionActive = false;

    // ── Enemy detection markers (modern HUD only) ────────────────────────
    this._enemyResolver     = null;
    this._maxEnemyMarkers   = 6;
    this._enemyMarkerPool   = [];
    this._trackedEnemies    = [];
    this._enemyScanAccum    = 0;
    this._enemyScanInterval = 0.25;
    this._enemyScratchVec   = new THREE.Vector3();

    this._buildOverlay();
    this._buildModernHud();
    this._buildEnemyMarkers();
    if (this.scopeType !== 0) this._loadTexture();   // scopeType 0 → skip loading, no overlay image needed
    this._loadGunnerTexture();
    this._bindInput();

    this._mouseDeltaX = 0;
this._mouseDeltaY = 0;
this._lastMouseX  = null;
this._lastMouseY  = null;

    // ── Modern HUD (F16-style) scratch state — smoothing so the ladders
    // glide instead of snapping every frame, plus a self-tracked dt since
    // update() is called with no args from main.js's render loop.
    this._modernHudLastTime = null;
    this._modernHudSmoothed = { velocity: 0, altitude: 0, heading: 0, pitch: 0, roll: 0, g: 1 };
    this._modernHudPrevVel      = new THREE.Vector3();
    this._modernHudPrevVelValid = false;
    this._modernHudFwd   = new THREE.Vector3();
    this._modernHudRight = new THREE.Vector3();
    this._modernHudVelScratch = new THREE.Vector3();
  }

  // ── Overlay canvas ────────────────────────────────────────────────────────

  _buildOverlay() {
    this._overlay = document.createElement('canvas');
    this._overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      display: none;
      z-index: 100;
    `;
    document.body.appendChild(this._overlay);
    this._ctx = this._overlay.getContext('2d');
    // Range predictor element
this._rangeEl = document.createElement('div');
this._rangeEl.style.cssText = `
  position: fixed;
  bottom: 38%;
  right: 30.5%;
  transform: translateX(50%);
  font-family: 'Courier New', monospace;
  font-size: 13px;
  color: rgba(180, 220, 100, 0.92);
  letter-spacing: 0.15em;
  pointer-events: none;
  display: none;
  z-index: 101;
  text-shadow: 0 0 8px rgba(100,180,40,0.7);
  padding: 3px 14px;
`;
document.body.appendChild(this._rangeEl);

// ── Turret bearing indicator ──────────────────────────────────────────
this._bearingEl = document.createElement('canvas');
this._bearingEl.width  = 160;
this._bearingEl.height = 160;
this._bearingEl.style.cssText = `
  position: fixed;
  bottom: 80px;
  left: 120px;
  transform: translateX(-50%);
  pointer-events: none;
  display: none;
  z-index: 200;
  opacity: 0.85;
`;
document.body.appendChild(this._bearingEl);
this._bearingCtx = this._bearingEl.getContext('2d');

this._angleEl = document.createElement('div');
this._angleEl.style.cssText = `
  position: fixed;
  top: 38%;
  left: 30.5%;
  transform: translateX(-50%);
  font-family: 'Courier New', monospace;
  font-size: 13px;
  color: rgba(180, 220, 100, 0.92);
  letter-spacing: 0.15em;
  pointer-events: none;
  display: none;
  z-index: 101;
  text-shadow: 0 0 8px rgba(100,180,40,0.7);
  padding: 3px 14px;
`;
document.body.appendChild(this._angleEl);
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    this._overlay.width  = window.innerWidth;
    this._overlay.height = window.innerHeight;
    if (this.isScoped) this._drawScope();
  }

    // ── Modern (F16-style) flight HUD — SVG-based overlay, built once and
  // toggled via display:none rather than being torn down/rebuilt, same
  // pattern as the canvas overlay above. Only ever shown for scopeMode
  // 'main' on a plane with scopeHudStyle === 'modern'; every other
  // combination keeps using the canvas-drawn glowing crosshair.
  _buildModernHud() {
    const NS = 'http://www.w3.org/2000/svg';

    if (!document.getElementById('modernHudStyles')) {
      const link = document.createElement('link');
      link.rel  = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Oxygen+Mono&display=swap';
      document.head.appendChild(link);

      const style = document.createElement('style');
      style.id = 'modernHudStyles';
      style.textContent = `
        .modern-hud-container {
          position: fixed;
          top: 0; left: 0;
          width: 100%; height: 100%;
          pointer-events: none;
          display: none;
          z-index: 100;
        }
        .modern-hud-container svg {
          position: absolute;
          width: 600px;
          height: 800px;
          left: 0; right: 0; top: 0; bottom: 0;
          margin: auto;
        }
        .modern-hud-container .hud-color {
          fill: transparent;
          stroke: #23de6c;
          stroke-opacity: 70%;
          stroke-width: 2;
        }
        .modern-hud-container text {
          fill: #189d4c;
          font-family: 'Oxygen Mono', monospace;
          font-size: 14px;
          font-weight: normal;
          stroke-width: 1;
        }
        .modern-hud-container .ladderTicks {
          stroke-width: 5;
        }
      `;
      document.head.appendChild(style);
    }

    // All ids prefixed "mhud-" so this can never collide with any other
    // id on the page. (Note: the reference project's `border-style: solid`
    // on the <svg> was left out deliberately — that was a dev alignment
    // aid, not part of the actual HUD.)
    this._modernHudContainer = document.createElement('div');
    this._modernHudContainer.className = 'modern-hud-container';
    this._modernHudContainer.innerHTML = `
<svg viewBox="0 0 600 800" xmlns="${NS}">
  <defs>
    <radialGradient id="mhud-hudViewPortGradient" cx="50%" cy="50%" r="50%">
      <stop offset="85%" stop-color="#ffffff" />
      <stop offset="90%" stop-color="#000000" />
    </radialGradient>
    <filter id="mhud-glow">
      <feGaussianBlur stdDeviation="2.5" result="coloredBlur" />
      <feMerge>
        <feMergeNode in="coloredBlur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
    <mask id="mhud-hudViewPortMask">
      <circle cx="300" cy="400" r="300" fill="url('#mhud-hudViewPortGradient')" />
    </mask>
    <clipPath id="mhud-verticalLadderClip">
      <rect x="-50" y="-150" width="100" height="150" />
    </clipPath>
    <clipPath id="mhud-compassLadderClip">
      <rect x="0" y="0" width="100" height="30" />
    </clipPath>
    <g id="mhud-pitch-positiv-bars">
      <polyline points="0,0 50,0 50,10" />
      <polyline points="100,10 100,0 150,0" />
    </g>
    <g id="mhud-pitch-negativ-bars" stroke-dasharray="4">
      <polyline points="0,0 50,0 50,-10" />
      <polyline points="100,-10 100,0 150,0" />
    </g>
    <g id="mhud-velocityLadder"></g>
    <g id="mhud-altitudeLadder"></g>
    <g id="mhud-compassLadder"></g>
    <g id="mhud-pitchLadder"></g>
  </defs>

  <g class="hud-color" filter="url(#mhud-glow)" mask="url(#mhud-hudViewPortMask)">
    <circle cx="300" cy="400" r="180" />

    <g transform="translate(100 400)">
      <g>
        <polygon points="0,-10 40,-10 50,0 40,10 0,10" />
        <text id="mhud-velocity-value" x="40" y="1" dominant-baseline="middle" text-anchor="end">0</text>
      </g>
      <use clip-path="url(#mhud-verticalLadderClip)" href="#mhud-velocityLadder" x="57" y="85" />
      <g transform="translate(60 0)">
        <line x1="0" y1="0" x2="27" y2="0" />
        <text x="0" y="-4" text-anchor="start">knt</text>
      </g>
      <text id="mhud-current-g" x="65" y="-85">1.0g</text>
      <text x="40" y="120">NAV</text>
    </g>

    <g transform="translate(420 400)">
      <g>
        <line x1="0" y1="0" x2="20" y2="0" />
        <text x="16" y="-4" text-anchor="end">ft</text>
      </g>
      <use clip-path="url(#mhud-verticalLadderClip)" href="#mhud-altitudeLadder" x="20" y="85" />
      <g transform="translate(30 0)">
        <polygon points="0,0 10,-10 60,-10 60,10 10,10" />
        <text id="mhud-altitude-value" x="55" y="1" dominant-baseline="middle" text-anchor="end">0</text>
      </g>
    </g>

    <g transform="translate(250 480)">
      <line x1="50" y1="0" x2="50" y2="-15" />
      <use clip-path="url(#mhud-compassLadderClip)" href="#mhud-compassLadder" />
      <rect width="30" height="20" transform="translate(35 23)" />
      <text id="mhud-heading" x="50" y="38" text-anchor="middle">0</text>
    </g>

    <g id="mhud-roll-wrap">
      <g id="mhud-pitch-roll" transform="translate(225 400)">
        <use href="#mhud-pitchLadder"></use>
        <line x1="-300" y1="0" x2="50" y2="0"></line>
        <line x1="100" y1="0" x2="450" y2="0"></line>
      </g>
    </g>
  </g>
</svg>`;

    document.body.appendChild(this._modernHudContainer);
    const container = this._modernHudContainer;

    // Ladder geometry is built once — only transforms/text change per frame.
    this._createVerticalLadder(
      container.querySelector('#mhud-velocityLadder'),
      10, 50, 0, 1000, 'up', 'left', (n) => Math.round(n / 10).toString()
    );
    this._createVerticalLadder(
      container.querySelector('#mhud-altitudeLadder'),
      100, 500, 0, 45000, 'up', 'right', (n) => Math.round(n / 100).toString()
    );
    this._createCompassLadder();
    this._createPitchLadder();
  }

    _buildEnemyMarkers() {
    this._enemyMarkerContainer = document.createElement('div');
    this._enemyMarkerContainer.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 150; display: none;
    `;
    document.body.appendChild(this._enemyMarkerContainer);

    for (let i = 0; i < this._maxEnemyMarkers; i++) {
      const el = document.createElement('div');
      el.style.cssText = `
        position: absolute; width: 36px; height: 36px; margin: -18px 0 0 -18px;
        border: 1.5px solid rgba(255,60,60,0.9);
        box-shadow: 0 0 6px rgba(255,60,60,0.6);
        display: none; pointer-events: none;
      `;
      const label = document.createElement('div');
      label.style.cssText = `
        position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
        font-family: 'Courier New', monospace; font-size: 11px;
        color: rgba(255,80,80,0.9); white-space: nowrap;
        text-shadow: 0 0 4px rgba(200,30,30,0.8);
      `;
      el.appendChild(label);
      this._enemyMarkerContainer.appendChild(el);
      this._enemyMarkerPool.push({ el, label });
    }
  }

  setEnemyResolver(fn) {
    this._enemyResolver = fn ?? null;
  }

  _rescanEnemies() {
    if (!this._enemyResolver) { this._trackedEnemies = []; return; }
    const candidates = this._enemyResolver('__all__') || [];
    const camPos = this.camera.position;

    const withDist = [];
    for (const c of candidates) {
      if (!c || c.isDead || !c.rigidBody) continue;
      const p = c.rigidBody.translation();
      const dx = p.x - camPos.x, dy = p.y - camPos.y, dz = p.z - camPos.z;
      withDist.push({ c, dsq: dx * dx + dy * dy + dz * dz });
    }
    withDist.sort((a, b) => a.dsq - b.dsq);
    this._trackedEnemies = withDist.slice(0, this._maxEnemyMarkers).map(o => o.c);
  }

  _updateEnemyMarkers(dt) {
    if (!this._enemyMarkerContainer) return;

    this._enemyScanAccum -= dt;
    if (this._enemyScanAccum <= 0) {
      this._enemyScanAccum = this._enemyScanInterval;
      this._rescanEnemies();
    }

    const w = window.innerWidth, h = window.innerHeight;
    const camPos = this.camera.position;

    for (let i = 0; i < this._maxEnemyMarkers; i++) {
      const slot   = this._enemyMarkerPool[i];
      const target = this._trackedEnemies[i];
      if (!target || target.isDead || !target.rigidBody) { slot.el.style.display = 'none'; continue; }

      const p = target.rigidBody.translation();
      this._enemyScratchVec.set(p.x, p.y, p.z).project(this.camera);

      if (this._enemyScratchVec.z > 1) { slot.el.style.display = 'none'; continue; }

      const sx = (this._enemyScratchVec.x * 0.5 + 0.5) * w;
      const sy = (1 - (this._enemyScratchVec.y * 0.5 + 0.5)) * h;
      if (sx < 0 || sx > w || sy < 0 || sy > h) { slot.el.style.display = 'none'; continue; }

      slot.el.style.display = 'block';
      slot.el.style.transform = `translate(${sx}px, ${sy}px)`;

      const dx = p.x - camPos.x, dy = p.y - camPos.y, dz = p.z - camPos.z;
      slot.label.textContent = `${Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz))}m`;
    }
  }

  _hideAllEnemyMarkers() {
    for (const slot of this._enemyMarkerPool) slot.el.style.display = 'none';
  }
    
  _createVerticalLadder(svgGroup, minorScaleTick, majorScaleTick, minScaleValue, maxScaleValue, orientation, labelSide, labelFormatter) {
    if (!svgGroup) return;
    const minorTickSpacing = 10;
    const majorTickSpacing = minorTickSpacing * Math.round(majorScaleTick / minorScaleTick);
    const minorTickLength = 5;
    const majorTickLength = 7;
    const lr  = labelSide === 'right' ? 1 : -1;
    const labelTextAnchor = labelSide === 'right' ? 'start' : 'end';
    const dir = orientation === 'up' ? -1 : 1;
    const NS  = 'http://www.w3.org/2000/svg';

    for (let i = Math.floor(minScaleValue / minorScaleTick); i <= Math.floor(maxScaleValue / minorScaleTick); i++) {
      if ((i * minorTickSpacing) % majorTickSpacing !== 0) {
        const tick = document.createElementNS(NS, 'line');
        tick.setAttribute('x1', 0);
        tick.setAttribute('x2', lr * minorTickLength);
        tick.setAttribute('y1', dir * i * minorTickSpacing);
        tick.setAttribute('y2', dir * i * minorTickSpacing);
        svgGroup.appendChild(tick);
      }
    }

    for (let i = Math.floor(minScaleValue / majorScaleTick); i <= Math.floor(maxScaleValue / majorScaleTick); i++) {
      const tick = document.createElementNS(NS, 'line');
      tick.setAttribute('x1', 0);
      tick.setAttribute('x2', lr * majorTickLength);
      tick.setAttribute('y1', dir * i * majorTickSpacing);
      tick.setAttribute('y2', dir * i * majorTickSpacing);
      tick.setAttribute('class', 'ladderTicks');
      svgGroup.appendChild(tick);

      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', lr * (majorTickLength + 3));
      label.setAttribute('y', dir * i * majorTickSpacing);
      label.setAttribute('text-anchor', labelTextAnchor);
      label.setAttribute('dominant-baseline', 'middle');
      label.textContent = labelFormatter ? labelFormatter(i * majorScaleTick) : String(i * majorScaleTick);
      svgGroup.appendChild(label);
    }
  }

  _createCompassLadder() {
    const svgGroup = this._modernHudContainer.querySelector('#mhud-compassLadder');
    if (!svgGroup) return;
    const minorScaleTick = 5, majorScaleTick = 10;
    const minScaleValue = -40, maxScaleValue = 400;
    const minorTickSpacing = 20;
    const majorTickSpacing = minorTickSpacing * Math.round(majorScaleTick / minorScaleTick);
    const minorTickLength = 5, majorTickLength = 7;
    const labelFormatter = (num) => Math.round(num / 10).toString().padStart(2, '0');
    const NS = 'http://www.w3.org/2000/svg';

    for (let i = Math.floor(minScaleValue / minorScaleTick); i <= Math.floor(maxScaleValue / minorScaleTick); i++) {
      if ((i * minorTickSpacing) % majorTickSpacing !== 0) {
        const tick = document.createElementNS(NS, 'line');
        tick.setAttribute('x1', i * minorTickSpacing);
        tick.setAttribute('x2', i * minorTickSpacing);
        tick.setAttribute('y1', 0);
        tick.setAttribute('y2', minorTickLength);
        svgGroup.appendChild(tick);
      }
    }

    for (let i = Math.floor(minScaleValue / majorScaleTick); i <= Math.floor(maxScaleValue / majorScaleTick); i++) {
      const tick = document.createElementNS(NS, 'line');
      tick.setAttribute('x1', i * majorTickSpacing);
      tick.setAttribute('x2', i * majorTickSpacing);
      tick.setAttribute('y1', 0);
      tick.setAttribute('y2', majorTickLength);
      tick.setAttribute('class', 'ladderTicks');
      svgGroup.appendChild(tick);

      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', i * majorTickSpacing);
      label.setAttribute('y', majorTickLength + 3);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'hanging');
      label.textContent = labelFormatter(Math.abs((360 + i * majorScaleTick) % 360));
      svgGroup.appendChild(label);
    }
  }

  _createPitchLadder() {
    const svgGroup = this._modernHudContainer.querySelector('#mhud-pitchLadder');
    if (!svgGroup) return;
    const pitchScaleTick = 5, pitchTickSpacing = 100;
    const minPitchValue = -90, maxPitchValue = 90;
    const barsWidth = 150;
    const NS = 'http://www.w3.org/2000/svg';

    for (let p = 1; p <= Math.floor(maxPitchValue / pitchScaleTick); p++) {
      const pBar = document.createElementNS(NS, 'use');
      pBar.setAttribute('href', '#mhud-pitch-positiv-bars');
      pBar.setAttribute('x', 0);
      pBar.setAttribute('y', -p * pitchTickSpacing);
      svgGroup.appendChild(pBar);

      const pLeftLabel = document.createElementNS(NS, 'text');
      pLeftLabel.setAttribute('x', -4);
      pLeftLabel.setAttribute('y', -p * pitchTickSpacing);
      pLeftLabel.setAttribute('text-anchor', 'end');
      pLeftLabel.setAttribute('dominant-baseline', 'middle');
      pLeftLabel.textContent = Math.round(p * pitchScaleTick);
      svgGroup.appendChild(pLeftLabel);

      const pRightLabel = document.createElementNS(NS, 'text');
      pRightLabel.setAttribute('x', barsWidth + 4);
      pRightLabel.setAttribute('y', -p * pitchTickSpacing);
      pRightLabel.setAttribute('text-anchor', 'start');
      pRightLabel.setAttribute('dominant-baseline', 'middle');
      pRightLabel.textContent = Math.round(p * pitchScaleTick);
      svgGroup.appendChild(pRightLabel);
    }

    for (let n = -1; n >= Math.ceil(minPitchValue / pitchScaleTick); n--) {
      const nBar = document.createElementNS(NS, 'use');
      nBar.setAttribute('href', '#mhud-pitch-negativ-bars');
      nBar.setAttribute('x', 0);
      nBar.setAttribute('y', -n * pitchTickSpacing);
      svgGroup.appendChild(nBar);

      const nLeftLabel = document.createElementNS(NS, 'text');
      nLeftLabel.setAttribute('x', -4);
      nLeftLabel.setAttribute('y', -n * pitchTickSpacing);
      nLeftLabel.setAttribute('text-anchor', 'end');
      nLeftLabel.setAttribute('dominant-baseline', 'middle');
      nLeftLabel.textContent = Math.round(n * pitchScaleTick);
      svgGroup.appendChild(nLeftLabel);

      const nRightLabel = document.createElementNS(NS, 'text');
      nRightLabel.setAttribute('x', barsWidth + 4);
      nRightLabel.setAttribute('y', -n * pitchTickSpacing);
      nRightLabel.setAttribute('text-anchor', 'start');
      nRightLabel.setAttribute('dominant-baseline', 'middle');
      nRightLabel.textContent = Math.round(n * pitchScaleTick);
      svgGroup.appendChild(nRightLabel);
    }
  }

  _velocityToPixels(value) {
    const minorTickSpacing = 10, minorScaleTick = 10;
    return Math.round(-170 / 2 + (value * minorTickSpacing) / minorScaleTick);
  }

  _altitudeToPixels(value) {
    const minorTickSpacing = 10, minorScaleTick = 100;
    return Math.round(-170 / 2 + (value * minorTickSpacing) / minorScaleTick);
  }

  _headingToPixels(value) {
    const minorTickSpacing = 20, minorScaleTick = 5;
    return Math.round(-100 / 2 + (value * minorTickSpacing) / minorScaleTick);
  }

  /** Reads live telemetry off this.tank (a Plane instance) and pushes it
   * into the modern HUD's ladders/text each frame. dt in seconds. */
  _updateModernHud(dt) {
    const container = this._modernHudContainer;
    if (!container || !this.tank) return;

    const linvel = this.tank.rigidBody
      ? this.tank.rigidBody.linvel()
      : { x: 0, y: 0, z: 0 };
    const velVec = this._modernHudVelScratch.set(linvel.x, linvel.y, linvel.z);
    const speedMs = velVec.length();

    const posY = this.tank.rigidBody
      ? this.tank.rigidBody.translation().y
      : (this.tank.bodyGroup?.position.y ?? 0);

    const fwd   = this._modernHudFwd;
    const right = this._modernHudRight;
    this.tank.getForwardVector?.(fwd);
    if (this.tank.bodyGroup) right.set(0, 0, -1).applyQuaternion(this.tank.bodyGroup.quaternion);

    const headingDeg = THREE.MathUtils.radToDeg(Math.atan2(fwd.x, fwd.z));
    const pitchDeg    = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)));
    const rollDeg     = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(right.y, -1, 1)));

    // World units treated as m/s and meters — converted to the aviation
    // units the reference HUD expects (knots, feet).
    const velocityKnots = speedMs * 1.94384;
    const altitudeFt    = Math.max(0, posY) * 3.28084;

    // Crude G-force estimate from the rate of change of the velocity
    // vector — not physically exact (ignores the static 1G of level
    // flight), but reads correctly as "climbing/turning hard = more g's".
    let gForce = 1;
    if (this._modernHudPrevVelValid && dt > 0.0001) {
      const dv = this._modernHudPrevVel.distanceTo(velVec);
      const gravity = this.tank.cfg?.gravity ?? 19.6;
      gForce = 1 + (dv / dt) / gravity;
    }
    this._modernHudPrevVel.copy(velVec);
    this._modernHudPrevVelValid = true;

    // Frame-rate-independent exponential smoothing so the ladders glide.
    const s = this._modernHudSmoothed;
    const smoothT = 1 - Math.pow(0.001, Math.max(dt, 0));
    s.velocity = THREE.MathUtils.lerp(s.velocity, velocityKnots, smoothT);
    s.altitude = THREE.MathUtils.lerp(s.altitude, altitudeFt, smoothT);
    s.g        = THREE.MathUtils.lerp(s.g, gForce, smoothT);
    s.pitch    = THREE.MathUtils.lerp(s.pitch, pitchDeg, smoothT);
    s.roll     = THREE.MathUtils.lerp(s.roll,  rollDeg,  smoothT);

    let headingDelta = headingDeg - s.heading;
    headingDelta = ((headingDelta + 180) % 360 + 360) % 360 - 180; // shortest-path wrap
    s.heading = (s.heading + headingDelta * smoothT + 360) % 360;

    const velEl = container.querySelector('#mhud-velocity-value');
    if (velEl) velEl.textContent = Math.round(s.velocity).toString();
    container.querySelector('#mhud-velocityLadder')
      ?.setAttribute('transform', `translate(0 ${this._velocityToPixels(s.velocity)})`);

    const altEl = container.querySelector('#mhud-altitude-value');
    if (altEl) altEl.textContent = Math.round(s.altitude).toString();
    container.querySelector('#mhud-altitudeLadder')
      ?.setAttribute('transform', `translate(0 ${this._altitudeToPixels(s.altitude)})`);

    const gEl = container.querySelector('#mhud-current-g');
    if (gEl) gEl.textContent = `${s.g.toFixed(1)}g`;

    const headingEl = container.querySelector('#mhud-heading');
    if (headingEl) headingEl.textContent = Math.round(s.heading).toString();
    container.querySelector('#mhud-compassLadder')
      ?.setAttribute('transform', `translate(${-this._headingToPixels(s.heading)} 0)`);

    container.querySelector('#mhud-roll-wrap')
      ?.setAttribute('transform', `rotate(${-s.roll} 300 400)`);

    const pitchPx = Math.round((100 / 5) * s.pitch) + 400;
    container.querySelector('#mhud-pitch-roll')
      ?.setAttribute('transform', `translate(225 ${pitchPx})`);
  }

  // ── KTX2 texture load ─────────────────────────────────────────────────────

_loadTexture() {
  if (this.scopeType === 0) return;   // no overlay for a plain scope
  this._loadScopeImageForType(this.scopeType, (img) => {
    this._scopeImage = img;
    if (this.isScoped) this._drawScope();  // redraw if already scoped
  });
}

// ── Loads (and caches) the scope_<type>.png overlay image. Cache means
// switching back and forth between tank/plane scope types never re-fetches
// an image it's already loaded once this session. ─────────────────────────
_loadScopeImageForType(type, onReady) {
  if (this._scopeImageCache[type]) {
    onReady(this._scopeImageCache[type]);
    return;
  }
  const pngPath = `/textures/scope_${type}.png`;
  const img = new Image();
  img.onload = () => {
    this._scopeImageCache[type] = img;
    onReady(img);
  };
  img.onerror = () => {
    console.warn('[ScopeSystem] Scope image failed to load:', pngPath);
  };
  img.src = pngPath;
}

// ── Switches the active scope texture at runtime (1-5), or disables the
// overlay entirely (0) — called by main.js whenever the player switches
// between tank and plane, since each vehicle can carry its own scopeType. ──
setScopeType(type) {
  const newType = type ?? 1;
  if (newType === this.scopeType) return;
  this.scopeType = newType;

  if (newType === 0) {
    this._scopeImage = null;
    if (this.isScoped) this._drawScope();
    return;
  }

  this._loadScopeImageForType(newType, (img) => {
    this._scopeImage = img;
    if (this.isScoped) this._drawScope();
  });
}

// ── Switches between the classic canvas crosshair ('old') and the F16-
// style SVG flight HUD ('modern') — called by main.js the same way
// setScopeType() is, whenever the active plane preset changes.
setScopeHudStyle(style) {
  this.scopeHudStyle = style === 'modern' ? 'modern' : 'old';

  // If already scoped into main mode, swap the active overlay immediately
  // instead of waiting for the next enter/exit cycle.
  if (this.isScoped && this.scopeMode === 'main') {
    const useModernHud = this.scopeHudStyle === 'modern' && this.vehicleType === 'plane';
    this._modernHudContainer.style.display = useModernHud ? 'block' : 'none';
    this._enemyMarkerContainer.style.display = useModernHud ? 'block' : 'none';
    this._overlay.style.display = useModernHud ? 'none' : 'block';
    if (!useModernHud) this._drawScope();
  }
}

_loadGunnerTexture() {
  const img = new Image();
  img.onload = () => {
    this._gunnerScopeImage = img;
    if (this.isScoped && this.scopeMode === 'gunner') this._drawScope();
  };
  img.onerror = () => {
    console.warn('[ScopeSystem] Gunner sight image failed to load:', this.gunnerTexturePath);
  };
  img.src = this.gunnerTexturePath;
}

  // ── Draw scope overlay ────────────────────────────────────────────────────

  _drawScope() {
    const ctx = this._ctx;
    const w   = this._overlay.width;
    const h   = this._overlay.height;

    ctx.clearRect(0, 0, w, h);

    // ── Gunner sight: no binocular vignette, no circular clip —
    // just the raw overlay texture stretched across the full screen ────────
    if (this.scopeMode === 'gunner') {
      if (this._gunnerScopeImage) {
        ctx.drawImage(this._gunnerScopeImage, 0, 0, w, h);
      }
      return;
    }

    // ── Bomb-sight: dedicated reticle + vignette ───────────────────────────
    if (this.scopeMode === 'bomb') {
      this._drawBombSight(ctx, w, h);
      return;
    }

    // scopeType 0 — plain zoomed view, no binocular vignette, no overlay texture
    if (this.scopeType === 0) {
      return;
    }

    // ── Main gun scope: binocular vignette + circular clipped texture ─────
    const cx  = w / 2;
    const cy  = h / 2;
    const r   = Math.min(w, h) * 0.42;   // scope circle radius

// ── Single-eye vignette — one soft circle centered on screen ──────────
ctx.save();

const eyeR      = Math.min(w, h) * 0.63;  // slightly larger than each binocular eye was
const fadeInner = eyeR * 0.55;
const fadeOuter = eyeR * 1.25;

ctx.fillStyle = '#000';
ctx.fillRect(0, 0, w, h);

ctx.globalCompositeOperation = 'destination-out';
const grad = ctx.createRadialGradient(cx, cy, fadeInner, cx, cy, fadeOuter);
grad.addColorStop(0,    'rgba(0,0,0,1)');
grad.addColorStop(0.85, 'rgba(0,0,0,0.95)');
grad.addColorStop(1,    'rgba(0,0,0,0)');
ctx.fillStyle = grad;
ctx.beginPath();
ctx.arc(cx, cy, fadeOuter, 0, Math.PI * 2);
ctx.fill();

ctx.restore();

    // ── Draw KTX2 scope image inside the circle ───────────────────────────
    if (this._scopeImage) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(this._scopeImage, cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
    }

    // ── Scope reticle (crosshair lines) — the classic glowing crosshair.
    // Skipped for tanks (no reticle wanted there); still drawn for the
    // plane's 'old' HUD style, since modern-HUD planes never reach this
    // code path at all (see _enterScope).
    if (this.vehicleType !== 'tank') {
      ctx.save();
      const reticleColor = 'rgba(50, 220, 120, 0.9)';
      const gapPx    = 10;
      const lengthPx = r * 0.5;
      ctx.strokeStyle = reticleColor;
      ctx.lineWidth   = 1.5;
      ctx.shadowColor = reticleColor;
      ctx.shadowBlur  = 8;
      ctx.beginPath();
      ctx.moveTo(cx - gapPx - lengthPx, cy);
      ctx.lineTo(cx - gapPx, cy);
      ctx.moveTo(cx + gapPx, cy);
      ctx.lineTo(cx + gapPx + lengthPx, cy);
      ctx.moveTo(cx, cy - gapPx - lengthPx);
      ctx.lineTo(cx, cy - gapPx);
      ctx.moveTo(cx, cy + gapPx);
      ctx.lineTo(cx, cy + gapPx + lengthPx);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = reticleColor;
      ctx.shadowBlur = 6;
      ctx.fill();
      ctx.restore();
    }
  }

  // ── Bomb-sight reticle: vignette + crosshair, ported from the SVG mock ──
  // Authored at 1280×720 with reticle geometry centered on (640,360),
  // radius 355 — scale factor below maps that onto whatever the actual
  // canvas resolution is, using height as the reference axis (same way
  // the SVG's r=355 relates to its own half-height of 360).
  _drawBombSight(ctx, w, h) {
    const cx = w / 2;
    const cy = h / 2;
    const s  = Math.min(w, h) / 720;
    const r  = 560 * s;

    // ── Fill the whole canvas black (masks out the game view everywhere
    // outside the scope circle), then punch a hole in the middle so the
    // 3D scene shows through inside the circle, with just a soft dark
    // vignette fading in near the rim. Same destination-out technique the
    // 'main' gun scope uses further down in _drawScope(). ─────────────────
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0.00, 'rgba(0,0,0,1)');   // fully clear at center — scene visible
    grad.addColorStop(0.70, 'rgba(0,0,0,1)');
    grad.addColorStop(0.92, 'rgba(0,0,0,0.55)'); // vignette starts darkening near the rim
    grad.addColorStop(1.00, 'rgba(0,0,0,0)');    // stays black at the very edge/bezel
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ── Secondary soft-blurred crosshairs (drawn under the crisp reticle) ─
    ctx.save();
    ctx.strokeStyle   = 'rgba(0,0,0,1)';
    ctx.globalAlpha   = 0.2;
    ctx.lineWidth     = 1 * s;
    ctx.shadowColor   = 'rgba(0,0,0,1)';
    ctx.shadowBlur    = 4 * s;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy + 1);
    ctx.lineTo(cx + r, cy + 1);
    ctx.moveTo(cx + 1, cy - r);
    ctx.lineTo(cx + 1, cy + r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 100 * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // ── Main reticle — bright green, visible against the black background
    // (originally #000000 in the SVG mock, which assumed a light backdrop) ─
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.globalAlpha = 0.85;

    // Full center crosshair
    ctx.lineWidth = 1.8 * s;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.stroke();

    // Inner range ring
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.arc(cx, cy, 100 * s, 0, Math.PI * 2);
    ctx.stroke();

    // Outer dashed range ring
    ctx.lineWidth = 1 * s;
    ctx.setLineDash([2 * s, 6 * s]);
    ctx.beginPath();
    ctx.arc(cx, cy, 180 * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Heavy outer posts
    ctx.lineWidth = 6 * s;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy);  ctx.lineTo(cx - 220 * s, cy);
    ctx.moveTo(cx + r, cy);  ctx.lineTo(cx + 220 * s, cy);
    ctx.moveTo(cx, cy - r);  ctx.lineTo(cx, cy - 220 * s);
    ctx.moveTo(cx, cy + r);  ctx.lineTo(cx, cy + 220 * s);
    ctx.stroke();

    // Horizontal hash marks (ticks crossing the horizontal line)
    ctx.lineWidth = 1.2 * s;
    ctx.beginPath();
    [[-80, 5], [-40, 3], [40, 3], [80, 5]].forEach(([dx, half]) => {
      ctx.moveTo(cx + dx * s, cy - half * s);
      ctx.lineTo(cx + dx * s, cy + half * s);
    });
    ctx.stroke();

    // Vertical hash marks (ticks crossing the vertical line)
    ctx.beginPath();
    [[-80, 5], [-40, 3], [40, 3], [80, 5]].forEach(([dy, half]) => {
      ctx.moveTo(cx - half * s, cy + dy * s);
      ctx.lineTo(cx + half * s, cy + dy * s);
    });
    ctx.stroke();

    // Center aim point
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ── Scope bezel — tracks r so it scales together with the rest of
    // the scope instead of drifting off the vignette edge ────────────────
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1 * s, 0, Math.PI * 2);
    ctx.strokeStyle = '#2a3328';
    ctx.lineWidth   = 2 * s;
    ctx.globalAlpha = 0.4;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r + 1 * s, 0, Math.PI * 2);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth   = 3 * s;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    ctx.restore();
  }
  
  // Call this from tank.js after gunPoint is found in the model
  setGunPoint(gp) {
    this.gunPoint = gp;
  }

  // ← add — call this from tank.js after ScopePoint is found in the model
  setScopePoint(sp) {
    this.scopePoint = sp;
  }
  // ← add — call this from main.js once the plane's BombPoint node is found
  setBombPoint(bp) {
    this.bombPoint = bp;
  }  

  setGunnerSightNode(node) {        // ← new
  this.gunnerSightNode = node;
}

  refreshAfterRespawn(tank) {
    this.gunPoint        = null;
    this.scopePoint      = null;   // ← add
    this.barrel          = null;
    this.gunnerSightNode = null;   // ← add
    this.tank            = tank;
    this.turretController = null;

    const watchController = setInterval(() => {
      if (tank.turretController) {
        this.turretController = tank.turretController;
        clearInterval(watchController);
      }
    }, 100);

    const watchGun = setInterval(() => {
      if (tank.turretController?.gunPoint) {
        this.setGunPoint(tank.turretController.gunPoint);
        clearInterval(watchGun);
      }
    }, 100);

    const watchScopePoint = setInterval(() => {   // ← add
      if (tank.turretController?.scopePoint) {
        this.setScopePoint(tank.turretController.scopePoint);
        clearInterval(watchScopePoint);
      }
    }, 100);

    const watchBarrel = setInterval(() => {
      if (tank.turretController?.barrel) {
        this.barrel = tank.turretController.barrel;
        clearInterval(watchBarrel);
      }
    }, 100);

    const watchGunnerSight = setInterval(() => {   // ← add
      if (tank.gunnerSightNode) {
        this.setGunnerSightNode(tank.gunnerSightNode);
        clearInterval(watchGunnerSight);
      }
    }, 100);
  }

  // ── Input binding ─────────────────────────────────────────────────────────

// REPLACE WITH:
_bindInput() {
    // Always block context menu
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    if (this.holdScope) {
      // Hold RMB = scoped, release = unscoped
      window.addEventListener('mousedown', (e) => {
        if (e.button === 2) this._enterScope('main');
      });
      window.addEventListener('mouseup', (e) => {
        if (e.button === 2) this._exitScope();
      });
    } else {
      // Double right-click toggle — manually track timing
      // because dblclick only fires for button 0 in most browsers
      let _lastRMB = 0;
      const DOUBLE_CLICK_MS = 300;

      window.addEventListener('mousedown', (e) => {
        if (e.button !== 2) return;
        const now = performance.now();
        if (now - _lastRMB < DOUBLE_CLICK_MS) {
          // Double click detected — main gun scope
          if (this.isScoped && this.scopeMode === 'main') {
            this._exitScope();
          } else {
            this._enterScope('main');
          }
          _lastRMB = 0;  // reset so triple-click doesn't re-trigger
        } else {
          _lastRMB = now;
        }
      });
    }

    // ── V key: rear-view toggle while flying a plane, gunner sight while
    // driving a tank. Branches on this.vehicleType, which main.js keeps in
    // sync whenever the active vehicle switches. ────────────────────────
    this._onGunnerKeyDown = (e) => {
      if (e.key !== 'v' && e.key !== 'V') return;
      if (this.spawnSelectionActive) return;   // never open gunner sight / toggle rear-view during spawn selection

      if (this.vehicleType === 'plane') {
        if (this.isScoped) return;   // don't fight with the plane's own scope view
        this.rearViewActive = !this.rearViewActive;
        return;
      }

      // Tank: original gunner-sight behavior, unchanged
      if (this.isScoped && this.scopeMode === 'gunner') {
        this._exitScope();
      } else if (!this.isScoped) {
        this._enterScope('gunner');
      }
      // if isScoped is true but in 'main' mode, V does nothing —
      // exit main scope first (double RMB) before opening gunner sight
    };
    window.addEventListener('keydown', this._onGunnerKeyDown);

    window.addEventListener('wheel', (e) => {
  if (!this.isScoped) return;
  if (this.scopeMode === 'gunner') return;  // no zoom in gunner sight
  if (this.scopeMode !== 'bomb' && this.scopeType === 0) return; // no zoom for a plain scope — bomb-sight always allows zoom

  e.preventDefault();
  const delta = e.deltaY > 0 ? 1 : -1;  // +1 = zoom out, -1 = zoom in
  const newFOV = THREE.MathUtils.clamp(
    this.camera.fov + delta * 2,  // 2° per scroll tick — tune to taste
    8,    // max zoom in
    this._getActiveNormalFOV()   // max zoom out = active vehicle's normal FOV
  );
  this.camera.fov = newFOV;
  this.camera.updateProjectionMatrix();
}, { passive: false });

window.addEventListener('mousemove', (e) => {
  // Normalized position from center (-1 to +1). Under Pointer Lock the
  // real cursor is trapped and e.clientX/Y never changes, so this must
  // fall back to input.js's virtual cursor (accumulated via movementX/Y
  // while locked) — same fix as turret.js's crosshair tracking. The two
  // branches produce identical math when not locked: (clientX/W)*2-1 is
  // algebraically the same as getMouseFlightOffset()'s (clientX-halfW)/halfW.
  let cx, cy;
  if (isPointerLocked()) {
    const off = getMouseFlightOffset();
    cx = off.x;
    cy = off.y;
  } else {
    cx = (e.clientX / window.innerWidth)  * 2 - 1;
    cy = (e.clientY / window.innerHeight) * 2 - 1;
  }

  // Store as continuous velocity, not delta
  this._mouseDeltaX = cx;
  this._mouseDeltaY = cy;
});
  }

getMouseDeltaX() {
  return this._mouseDeltaX;
}

getMouseDeltaY() {
  return this._mouseDeltaY;
}

// ── Resolves the correct non-scoped FOV for whichever vehicle is
  // currently active — same branching pattern _enterScope() already uses
  // for the zoomed FOV, just for the resting/unscoped state.
  _getActiveNormalFOV() {
    return this.vehicleType === 'plane' ? this.planeNormalFOV : this.normalFOV;
  }

  // ── Enter / Exit ──────────────────────────────────────────────────────────

// REPLACE WITH:
  _enterScope(mode = 'main') {
    // console.log('[Scope ENTER]', ...);
    if (this.tank?.isDead) return;
    if (mode === 'gunner' && !this.gunnerSightNode) return;  // node not loaded yet
    if (mode === 'bomb' && !this.bombPoint) return;          // BombPoint not loaded / plane has no bomb mount

    this.isScoped  = true;
    this.scopeMode = mode;

    this.rearViewActive = false;   // scope view always looks forward, regardless of prior rear-view state

    // ── Lock roll AND pitch while bomb-sighting (unlocked for every other
    // mode) — handles both "entering bomb mode" and "switching away from
    // bomb mode into another scope mode" in one place.
    if (this.vehicleType === 'plane') {
      this.tank?.setRollLocked?.(mode === 'bomb');
      this.tank?.setPitchLocked?.(mode === 'bomb');
    }

    // ── Hide the pilot mesh so it doesn't block the first-person scope
    // view — only relevant while flying a plane (tanks don't have this
    // issue since the scope sits outside the hull).
    if (this.vehicleType === 'plane') {
      this.tank?.setPilotVisible?.(false);
    }
    
    const useModernHud = mode === 'main' && this.scopeHudStyle === 'modern' && this.vehicleType === 'plane';
    if (useModernHud) {
      this._modernHudContainer.style.display = 'block';
      this._enemyMarkerContainer.style.display = 'block';   // ← fix: show enemy marker layer
      this._overlay.style.display = 'none';
    } else {
      this._overlay.style.display = 'block';
      this._enemyMarkerContainer.style.display = 'none';    // ← fix: hide it for non-modern scopes too
      this._drawScope();
    }
    if (this._bearingEl) this._bearingEl.style.display = 'block';

    // scopeType 0 — plain "look through the gun" view, no zoom at all.
    // Otherwise: gunner sight has its own FOV, and main-scope FOV differs
    // between tank and plane (this.vehicleType, kept in sync by main.js
    // whenever the active vehicle switches).
    const targetFOV = mode === 'gunner'
      ? this.gunnerZoomFOV
      : mode === 'bomb'
      ? this.bombZoomFOV
      : (this.vehicleType === 'plane' ? this.planeZoomFOV : this.zoomFOV);
    this._animateFOV(this.camera.fov, targetFOV);   // ← animate from current fov, not always normalFOV

    // Save current camera transform so we can restore on exit
    this._prevCamPos.copy(this.camera.position);
    this._prevCamQ.copy(this.camera.quaternion);
  }

_exitScope() {
    if (this.tank?.isDead) {
    this.isScoped  = false;
    this.scopeMode = null;          // ← add
    if (this.vehicleType === 'plane') {
      this.tank?.setPilotVisible?.(true);
      this.tank?.setRollLocked?.(false);
      this.tank?.setPitchLocked?.(false);
    }
    this._overlay.style.display = 'none';
    this._modernHudContainer.style.display = 'none';
    this._enemyMarkerContainer.style.display = 'none';
    this._hideAllEnemyMarkers();
    if (this._bearingEl) this._bearingEl.style.display = 'none';
    this._rangeEl && (this._rangeEl.style.display = 'none');
    this._angleEl && (this._angleEl.style.display = 'none');

    // ── Snap FOV back to normal immediately — no need to animate since
    // the tank is dead, but leaving it at the scoped value here means the
    // death-hold camera, spawn-selection screen, and intro flythrough all
    // inherit whatever zoom level was active at the moment of death ──────
    this.camera.fov = this._getActiveNormalFOV();
    this.camera.updateProjectionMatrix();

    if (this.turretController?._rangeDisplay) {
      this.turretController._rangeDisplay.style.display = 'none';
    }
    return;
  }
  
  this.isScoped  = false;
  this.scopeMode = null;            // ← add
  if (this.vehicleType === 'plane') {
    this.tank?.setPilotVisible?.(true);
    this.tank?.setRollLocked?.(false);
    this.tank?.setPitchLocked?.(false);
  }

  this._overlay.style.display = 'none';
  this._modernHudContainer.style.display = 'none';
  this._enemyMarkerContainer.style.display = 'none';
  this._hideAllEnemyMarkers();
  if (this._bearingEl) this._bearingEl.style.display = 'none';
  this._animateFOV(this.camera.fov, this._getActiveNormalFOV());
  if (this._rangeEl)   this._rangeEl.style.display   = 'none';
  if (this._angleEl)   this._angleEl.style.display   = 'none';

  if (this.turretController?._rangeDisplay) {
    this.turretController._rangeDisplay.style.display = 'none';
  }
}
  // ── Smooth FOV zoom ───────────────────────────────────────────────────────

  _animateFOV(fromFOV, toFOV) {
    const duration = 180;   // ms
    const start    = performance.now();

    const tick = (now) => {
      const t   = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);   // ease-out cubic
      this.camera.fov = fromFOV + (toFOV - fromFOV) * ease;
      this.camera.updateProjectionMatrix();
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _drawTurretBearing(turretYaw) {
  const canvas = this._bearingEl;
  const ctx    = this._bearingCtx;
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;

  ctx.clearRect(0, 0, W, H);

  const GREEN       = 'rgba(50, 220, 120, 0.9)';
  const GREEN_DIM   = 'rgba(50, 220, 120, 0.18)';
  const GREEN_RING  = 'rgba(50, 220, 120, 0.22)';

  // // ── Outer ring ────────────────────────────────────────────────────────
  // const outerR = W * 0.46;
  // ctx.beginPath();
  // ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  // ctx.strokeStyle = GREEN_RING;
  // ctx.lineWidth = 1;
  // ctx.stroke();

  // // ── Inner ring ────────────────────────────────────────────────────────
  // const innerR = W * 0.32;
  // ctx.beginPath();
  // ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  // ctx.strokeStyle = GREEN_RING;
  // ctx.lineWidth = 0.7;
  // ctx.stroke();

  // ── Hull shape (pentagon-ish, always points up = forward) ─────────────
  ctx.save();
  ctx.strokeStyle = GREEN;
  ctx.lineWidth   = 1.5;
  ctx.shadowColor = GREEN;
  ctx.shadowBlur  = 6;

  const hullW  = W * 0.22;
  const hullH  = H * 0.28;
  const nosePx = H * 0.1;   // nose tip extra forward

  // Pentagon: bottom-left, bottom-right, right, nose, left
  ctx.beginPath();
  ctx.moveTo(cx - hullW, cy + hullH * 0.5);           // bottom-left
  ctx.lineTo(cx + hullW, cy + hullH * 0.5);           // bottom-right
  ctx.lineTo(cx + hullW, cy - hullH * 0.3);           // right shoulder
  ctx.lineTo(cx,          cy - hullH * 0.5 - nosePx); // nose tip
  ctx.lineTo(cx - hullW, cy - hullH * 0.3);           // left shoulder
  ctx.closePath();

  // Filled dark background
  ctx.fillStyle = 'rgba(0, 30, 10, 0.82)';
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // ── Turret barrel line (rotates with turret yaw relative to hull) ──────
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-turretYaw);   // turretYaw = turret.rotation.y relative to hull

  ctx.strokeStyle = GREEN;
  ctx.lineWidth   = 2;
  ctx.shadowColor = GREEN;
  ctx.shadowBlur  = 8;
  ctx.lineCap     = 'round';

  // Dot at base (turret pivot)
  ctx.beginPath();
  ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = GREEN;
  ctx.fill();

  // Barrel line — pointing forward (−Y in canvas = up = forward)
  const barrelLen = W * 0.36;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -barrelLen);
  ctx.stroke();

  // Dot at barrel tip
  // ctx.beginPath();
  // ctx.arc(0, -barrelLen, 3.5, 0, Math.PI * 2);
  // ctx.fill();

  ctx.restore();
}

  setPredictedRange(meters) {
  if (!this._rangeEl) return;
  if (!this.isScoped) {
    this._rangeEl.style.display = 'none';
    return;
  }
  this._rangeEl.style.display = 'block';
  this._rangeEl.textContent = `RNG  ${Math.round(meters)}m`;
}

setBarrelAngle(radians) {
  if (!this._angleEl) return;
  if (!this.isScoped) {
    this._angleEl.style.display = 'none';
    return;
  }
  const deg = (radians * 180 / Math.PI).toFixed(1);
  const sign = radians >= 0 ? '+' : '';
  this._angleEl.style.display = 'block';
  this._angleEl.textContent = `ANG  ${sign}${deg}°`;
}

  // Call this every frame from main.js loop, BEFORE renderer.render()
update() {
  const _now = performance.now();
  const dt = this._modernHudLastTime != null ? Math.min(0.1, (_now - this._modernHudLastTime) / 1000) : 0;
  this._modernHudLastTime = _now;

  if (!this.isScoped) {
    if (this._bearingEl) this._bearingEl.style.display = 'none';
    return;
  }

  // ── Turret bearing indicator ──────────────────────────────────────────
  if (this._bearingEl && this.turretController?.turret) {
    this._bearingEl.style.display = 'block';
    // turret.rotation.y is already relative to the hull (parent is hull group)
    this._drawTurretBearing(this.turretController.turret.rotation.y);
  }

  // Gunner sight follows its own empty node; main scope follows ScopePoint;
  // bomb-sight follows BombPoint (position only — orientation computed
  // below, independent of the node's own authored rotation).
  const sourceNode = this.scopeMode === 'gunner'
    ? this.gunnerSightNode
    : this.scopeMode === 'bomb'
    ? this.bombPoint
    : this.scopePoint;
  if (!sourceNode) return;

  const gpPos  = new THREE.Vector3();
  const gpQuat = new THREE.Quaternion();
  sourceNode.getWorldPosition(gpPos);

  if (this.scopeMode === 'bomb') {
    // ── Downward bomb-sight view — always looks straight down in world
    // space, regardless of BombPoint's own authored rotation. "Up" on
    // screen tracks the plane's current horizontal heading, so the view
    // still rotates with the plane's yaw, like a real bombsight.
    this.tank?.getForwardVector?.(this._bombUpScratch);
    this._bombUpScratch.y = 0;
    if (this._bombUpScratch.lengthSq() < 0.0001) this._bombUpScratch.set(0, 0, -1);
    this._bombUpScratch.normalize();

    this._bombTargetScratch.copy(gpPos);
    this._bombTargetScratch.y -= 10;

    this._bombMatrixScratch.lookAt(gpPos, this._bombTargetScratch, this._bombUpScratch);
    gpQuat.setFromRotationMatrix(this._bombMatrixScratch);
  } else {
    sourceNode.getWorldQuaternion(gpQuat);
  }

  this.camera.position.copy(gpPos);

  if (this.tank?._shakeOffset) {
    // Small positional nudge is barely visible in a cockpit-style scope
    // view (camera sits essentially "at" the source node) — still apply
    // it for consistency with the unscoped camera, but it's the rotation
    // jitter below that actually reads as shake on screen.
    this.camera.position.x += this.tank._shakeOffset.x;
    this.camera.position.y += this.tank._shakeOffset.y;
  }

  // ── Copy the FULL world orientation (not just a look-at direction) so
  // roll is preserved. camera.lookAt() only aligns the forward axis and
  // always re-derives "up" from world-up / the camera's previous up —
  // it silently discards any roll the source node (and therefore the
  // plane, when rolling/banking) actually has. This is what made the
  // scope view stay level even while the plane rolled.
  //
  // The correction quaternion compensates for ScopePoint's authored local
  // orientation not matching camera convention (-Z forward) — it was
  // found to be facing 180° backwards, hence the Y-axis flip below.
  // Bomb-sight orientation is already an exact world-space quaternion
  // (computed above) — the backward-facing axis correction only applies
  // to nodes authored in the model itself (ScopePoint / gunner sight).
  if (this.scopeMode === 'bomb') {
    this.camera.quaternion.copy(gpQuat);
  } else {
    this.camera.quaternion.copy(gpQuat).multiply(this._scopeAxisCorrectionQ);
  }

  // ── Shake/turbulence as ROTATIONAL jitter — a tiny positional offset
  // barely changes what's visible when the camera sits at the eye point,
  // but a small rotational nudge visibly swings the whole view, which is
  // what actually reads as "shake" on screen. Scale factor converts the
  // ~0.1-unit positional offset into a proportionally small rotation.
  if (this.tank?._shakeOffset) {
    const so = this.tank._shakeOffset;
    const SHAKE_ROTATION_SCALE = 0.6; // radians per world-unit of shakeOffset — tune to taste
    this._shakeRotQ = this._shakeRotQ || new THREE.Quaternion();
    this._shakeEuler = this._shakeEuler || new THREE.Euler();
    this._shakeEuler.set(
      -so.y * SHAKE_ROTATION_SCALE,  // pitch (vertical shake → pitch)
       so.x * SHAKE_ROTATION_SCALE,  // yaw   (horizontal shake → yaw)
      0,
      'XYZ'
    );
    this._shakeRotQ.setFromEuler(this._shakeEuler);
    this.camera.quaternion.multiply(this._shakeRotQ);
  }

  if (this.scopeMode === 'main' && this.scopeHudStyle === 'modern' && this.vehicleType === 'plane') {
    this._updateModernHud(dt);
    this._updateEnemyMarkers(dt);
  }
}

  // ── Cleanup ───────────────────────────────────────────────────────────────

dispose() {
  this._overlay?.remove();
  this._bearingEl?.remove();
  this._rangeEl?.remove();
  this._angleEl?.remove();
  this._modernHudContainer?.remove();
  this._texture?.dispose();
  if (this._onGunnerKeyDown) {
    window.removeEventListener('keydown', this._onGunnerKeyDown);
  }
}
}