// friendlyPlaneMarkers.js — static, billboarded "friendly plane" markers.
//
// One InstancedMesh (one draw call) renders an icon + baked name-text quad
// above every currently-active friendly plane (local player's own plane is
// excluded — you don't need a marker over yourself). Billboarding is done
// entirely in the vertex shader (reads camera-right/up straight out of the
// view matrix, same trick main.js's flight-cloud shader already uses), so
// there's zero per-frame CPU work for orientation. Positions are written
// into a per-instance offset attribute each frame; the marker set (which
// planes have markers, and their baked name texture) is only rebuilt when
// the friendly-plane roster actually changes, not every frame.
//
// Text is baked once per unique name onto a shared canvas atlas (one
// texture for the whole match), so every marker's name — no matter how
// many distinct names appear — is still sampled from a single texture,
// keeping the whole system at one draw call regardless of roster size.

import * as THREE from 'three';

const MAX_MARKERS   = 32;   // hard cap — matches typical squad sizes with headroom
const ATLAS_SIZE     = 1024; // shared name-text atlas, square, power-of-two
const ATLAS_CELL     = 128;  // each name gets one ATLAS_CELL x ATLAS_CELL cell
const ATLAS_COLS     = ATLAS_SIZE / ATLAS_CELL; // cells per row
const ATLAS_MAX_NAMES = ATLAS_COLS * ATLAS_COLS;

const MARKER_WIDTH  = 3.2;  // world units
const MARKER_HEIGHT = 1.0;
const MARKER_Y_OFFSET = 3.0; // world units above the plane's bodyGroup origin

export class FriendlyPlaneMarkerSystem {
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
    // Base UVs span the full quad (0..1); the shader remaps them into the
    // instance's atlas cell using instanceUvOffset/instanceUvScale.
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

    // marker slot -> the friendly plane/proxy object currently occupying it
    this._slotOwners = new Array(MAX_MARKERS).fill(null);
    this._activeSlotCount = 0;

    this._scratchWorldPos = new THREE.Vector3();
  }

  // ── Name atlas ──────────────────────────────────────────────────────────

  /** Bakes `name` into the next free atlas cell (if not already baked) and
   * returns its {u, v} offset (0..1) into the atlas. */
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

    // ── Small icon (filled diamond) + name text, both baked into this
    // single cell so the whole marker (icon+text) is one textured quad. ──
    const cx = px + ATLAS_CELL / 2;
    const iconY = py + ATLAS_CELL * 0.28;
    const iconR = ATLAS_CELL * 0.14;

    ctx.save();
    ctx.translate(cx, iconY);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = 'rgba(68,170,255,0.95)';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3;
    ctx.fillRect(-iconR, -iconR, iconR * 2, iconR * 2);
    ctx.strokeRect(-iconR, -iconR, iconR * 2, iconR * 2);
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
   * @param {Array} friendlyPlanes — every currently-active friendly plane
   *   this client can see (AI instances on the host, RemotePlayerPlane
   *   proxies on a guest — anything with .bodyGroup, .isDead, and a name).
   *   The local player's own plane should NOT be included by the caller.
   * @param {Function} getName — (planeObj) => string, resolves the label
   *   to show (mirrors main.js's getEntityName()/​_labelForKillEntity()).
   */
  update(friendlyPlanes, getName) {
    const count = Math.min(friendlyPlanes.length, MAX_MARKERS);

    for (let i = 0; i < count; i++) {
      const plane = friendlyPlanes[i];
      if (!plane || plane.isDead || !plane.bodyGroup) continue;

      plane.bodyGroup.getWorldPosition(this._scratchWorldPos);

      this._offsetAttr.setXYZ(
        i,
        this._scratchWorldPos.x,
        this._scratchWorldPos.y + MARKER_Y_OFFSET,
        this._scratchWorldPos.z
      );

      // Only re-resolve/bake the name if this slot's owner changed —
      // avoids a Map lookup every frame for every marker.
      if (this._slotOwners[i] !== plane) {
        this._slotOwners[i] = plane;
        const name = getName(plane);
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