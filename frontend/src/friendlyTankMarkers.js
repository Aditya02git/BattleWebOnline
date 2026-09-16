// friendlyTankMarkers.js — static, billboarded "friendly tank" markers.
//
// One InstancedMesh (one draw call) renders an icon + baked name-text quad
// above every currently-active friendly tank (local player's own tank is
// excluded — you don't need a marker over yourself). Billboarding is done
// entirely in the vertex shader (reads camera-right/up straight out of the
// view matrix, same trick main.js's flight-cloud shader / friendlyPlaneMarkers.js
// already use), so there's zero per-frame CPU work for orientation.
// Positions are written into a per-instance offset attribute each frame;
// the marker set (which tanks have markers, and their baked name texture)
// is only rebuilt when the friendly-tank roster actually changes, not
// every frame.
//
// Text is baked once per unique name onto a shared canvas atlas (one
// texture for the whole match), so every marker's name — no matter how
// many distinct names appear — is still sampled from a single texture,
// keeping the whole system at one draw call regardless of roster size.
//
// This replaces the old per-tank THREE.Sprite friendly markers that used
// to live inside TurretController (_markEnemy/_updateMarkedEnemies with
// isFriendly=true) — that system is now enemy-only.

import * as THREE from 'three';

const MAX_MARKERS    = 32;   // hard cap — matches typical squad sizes with headroom
const ATLAS_SIZE      = 1024; // shared name-text atlas, square, power-of-two
const ATLAS_CELL      = 128;  // each name gets one ATLAS_CELL x ATLAS_CELL cell
const ATLAS_COLS      = ATLAS_SIZE / ATLAS_CELL; // cells per row
const ATLAS_MAX_NAMES = ATLAS_COLS * ATLAS_COLS;

const MARKER_WIDTH  = 1.6;  // world units — square to match the atlas cell's 1:1 aspect, avoids stretching
const MARKER_HEIGHT = 1.6;
const MARKER_Y_OFFSET = 3.2; // world units above the tank's bodyGroup origin (slightly above hull roofline)

export class FriendlyTankMarkerSystem {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;

    // ── Shared name-text atlas ─────────────────────────────────────────
    this._atlasCanvas = document.createElement('canvas');
    this._atlasCanvas.width  = ATLAS_SIZE;
    this._atlasCanvas.height = ATLAS_SIZE;
    this._atlasCtx = this._atlasCanvas.getContext('2d');
    this._atlasTexture = new THREE.CanvasTexture(this._atlasCanvas);
    this._atlasTexture.colorSpace = THREE.SRGBColorSpace;
    this._atlasTexture.magFilter  = THREE.LinearFilter;
    this._atlasTexture.minFilter  = THREE.LinearFilter;

    this._nameToCellIndex = new Map(); // playerName -> cell index in the atlas
    this._nextCellIndex   = 0;

    // ── Geometry — single quad. UV rewritten per-instance (via an
    // instanced attribute) to point at that instance's atlas cell, so one
    // geometry serves every marker regardless of which name it shows.
    const geo = new THREE.PlaneGeometry(MARKER_WIDTH, MARKER_HEIGHT);
    const instGeo = new THREE.InstancedBufferGeometry();
    instGeo.index               = geo.index;
    instGeo.attributes.position = geo.attributes.position;
    instGeo.attributes.uv       = geo.attributes.uv;
    instGeo.instanceCount       = 0;

    const offsets   = new Float32Array(MAX_MARKERS * 3); // world position per marker
    const uvOffsets = new Float32Array(MAX_MARKERS * 2); // atlas cell offset (0..1) per marker

    instGeo.setAttribute('instanceOffset',   new THREE.InstancedBufferAttribute(offsets, 3));
    instGeo.setAttribute('instanceUvOffset', new THREE.InstancedBufferAttribute(uvOffsets, 2));

    this._offsetAttr   = instGeo.attributes.instanceOffset;
    this._uvOffsetAttr = instGeo.attributes.instanceUvOffset;

    const uvScale = ATLAS_CELL / ATLAS_SIZE;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map:     { value: this._atlasTexture },
        uvScale: { value: uvScale },
      },
      vertexShader: `
        attribute vec3 instanceOffset;
        attribute vec2 instanceUvOffset;
        uniform float uvScale;
        varying vec2 vUv;
        void main() {
          // Remap this quad's base UV (0..1) into the instance's atlas cell.
          vUv = instanceUvOffset + uv * uvScale;

          // Billboard: camera-right/up pulled directly from the view matrix
          // columns — always faces the camera with zero per-frame CPU cost.
          vec3 cameraRight = vec3(viewMatrix[0].x, viewMatrix[1].x, viewMatrix[2].x);
          vec3 cameraUp    = vec3(viewMatrix[0].y, viewMatrix[1].y, viewMatrix[2].y);

          vec3 worldPos = instanceOffset
                         + cameraRight * position.x
                         + cameraUp    * position.y;

          gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        varying vec2 vUv;
        void main() {
          vec4 tex = texture2D(map, vUv);
          if (tex.a < 0.02) discard;
          gl_FragColor = tex;
        }
      `,
      transparent: true,
      depthWrite:  false,
      depthTest:   true,
      side:        THREE.DoubleSide,
    });

    this._mesh = new THREE.Mesh(instGeo, mat);
    this._mesh.frustumCulled = false; // instances are spread across the map — bounding sphere would be wrong
    this._mesh.renderOrder   = 5;
    this._mesh.visible       = false;
    scene.add(this._mesh);

    // marker slot -> the friendly tank/proxy object currently occupying it
    this._slotOwners = new Array(MAX_MARKERS).fill(null);
    this._activeSlotCount = 0;

    this._scratchWorldPos = new THREE.Vector3();
  }

  // ── Name atlas ──────────────────────────────────────────────────────────

  /** Bakes `name` into the next free atlas cell (if not already baked) and
   * returns its cell index into the atlas. */
  _getOrBakeName(name) {
    const key = name || 'Player';
    let cellIndex = this._nameToCellIndex.get(key);
    if (cellIndex !== undefined) return cellIndex;

    if (this._nextCellIndex >= ATLAS_MAX_NAMES) {
      // Atlas full (very unlikely — would need 64 distinct friendly names
      // in one match) — reuse cell 0 rather than overflow.
      return 0;
    }

    cellIndex = this._nextCellIndex++;
    this._nameToCellIndex.set(key, cellIndex);
    this._bakeNameIntoCell(key, cellIndex);
    return cellIndex;
  }

  _bakeNameIntoCell(name, cellIndex) {
    const col = cellIndex % ATLAS_COLS;
    const row = Math.floor(cellIndex / ATLAS_COLS);
    const px = col * ATLAS_CELL;
    const py = row * ATLAS_CELL;

    const ctx = this._atlasCtx;
    ctx.clearRect(px, py, ATLAS_CELL, ATLAS_CELL);

    // ── Small icon (rounded "shield" badge, matches the old friendly
    // sprite marker's look) + name text, baked into this single cell so
    // the whole marker (icon+text) is one textured quad. ─────────────────
    const cx = px + ATLAS_CELL / 2;
    const iconY = py + ATLAS_CELL * 0.28;
    const iconR = ATLAS_CELL * 0.16;

    ctx.save();
    ctx.translate(cx, iconY);
    ctx.beginPath();
    ctx.moveTo(0, -iconR);
    ctx.quadraticCurveTo(iconR, -iconR * 0.85, iconR, 0);
    ctx.quadraticCurveTo(iconR, iconR * 0.85, 0, iconR);
    ctx.quadraticCurveTo(-iconR, iconR * 0.85, -iconR, 0);
    ctx.quadraticCurveTo(-iconR, -iconR * 0.85, 0, -iconR);
    ctx.closePath();
    ctx.fillStyle = 'rgba(40,140,255,0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.floor(iconR * 1.15)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✓', 0, iconR * 0.05);
    ctx.restore();

    ctx.font = `bold ${Math.floor(ATLAS_CELL * 0.16)}px 'Courier New', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillText(name, cx + 1, py + ATLAS_CELL * 0.68 + 1, ATLAS_CELL * 0.92);
    ctx.fillStyle = '#e8f0c0';
    ctx.fillText(name, cx, py + ATLAS_CELL * 0.68, ATLAS_CELL * 0.92);

    this._atlasTexture.needsUpdate = true;
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  /**
   * @param {Array} friendlyTanks — every currently-active friendly tank
   *   this client can see (AI instances on the host, RemotePlayerTank
   *   proxies on a guest — anything with .bodyGroup, .isDead, and a name).
   *   The local player's own tank should NOT be included by the caller.
   * @param {Function} getName — (tankObj) => string, resolves the label
   *   to show (mirrors main.js's getEntityName()/​_labelForKillEntity()).
   */
  update(friendlyTanks, getName) {
    const count = Math.min(friendlyTanks.length, MAX_MARKERS);

    for (let i = 0; i < count; i++) {
      const tank = friendlyTanks[i];
      if (!tank || tank.isDead || !tank.bodyGroup) continue;

      tank.bodyGroup.getWorldPosition(this._scratchWorldPos);

      this._offsetAttr.setXYZ(
        i,
        this._scratchWorldPos.x,
        this._scratchWorldPos.y + MARKER_Y_OFFSET,
        this._scratchWorldPos.z
      );

      // Only re-resolve/bake the name if this slot's owner changed —
      // avoids a Map lookup every frame for every marker.
      if (this._slotOwners[i] !== tank) {
        this._slotOwners[i] = tank;
        const name = getName(tank);
        const cellIndex = this._getOrBakeName(name);
        const col = cellIndex % ATLAS_COLS;
        const row = Math.floor(cellIndex / ATLAS_COLS);
        this._uvOffsetAttr.setXY(i, col / ATLAS_COLS, 1 - (row + 1) / ATLAS_COLS);
      }
    }

    // Clear any now-unused trailing slots (roster shrank)
    for (let i = count; i < this._activeSlotCount; i++) {
      this._slotOwners[i] = null;
      this._offsetAttr.setXYZ(i, 0, -10000, 0); // park off-screen rather than scaling to 0 (cheaper, no extra branch)
    }

    this._activeSlotCount = count;
    this._mesh.geometry.instanceCount = count;
    this._mesh.visible = count > 0;

    this._offsetAttr.needsUpdate   = true;
    this._uvOffsetAttr.needsUpdate = true;
  }

  dispose() {
    this._mesh.visible = false;
    this.scene.remove(this._mesh);
    this._mesh.geometry.dispose();
    this._mesh.material.dispose();
    this._atlasTexture.dispose();
  }
}