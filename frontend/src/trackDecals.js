// trackDecals.js
import * as THREE from 'three';

const DECAL_COUNT    = 500;
const STAMP_INTERVAL = 0.10;
const DECAL_W        = 0.7;
const DECAL_L        = 0.52;
const FADE_START     = 6.0;
const FADE_END       = 10.0;
const Y_OFFSET       = 0.025;

// Accepts a numeric hex (0x333333), a numeric-hex STRING ("0x333333") as
// stored in maps.json, or a real CSS color string — normalizes to a
// number/string THREE.Color can actually parse.
function _normalizeColorInput(color) {
  if (typeof color === 'number') return color;
  if (typeof color === 'string') {
    const trimmed = color.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      return parseInt(trimmed, 16);
    }
    return trimmed;
  }
  return 0x333333;
}

export class TrackDecalSystem {
  constructor(scene, texturePath = '/tread_normal.jpg', decalColor = 0x333333) {
    this._scene    = scene;
    this._decalColor = _normalizeColorInput(decalColor);
    this._pool     = [];
    this._head     = 0;
    this._distAccL = 0;
    this._distAccR = 0;
    this._lastPosL = null;
    this._lastPosR = null;
    this._dummy    = new THREE.Object3D();

    // ── Geometry ──────────────────────────────────────────────────────────
    const geo = new THREE.PlaneGeometry(DECAL_L, DECAL_W);
    geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

    // ── Texture ───────────────────────────────────────────────────────────
    const loader   = new THREE.TextureLoader();
    const treadTex = loader.load(texturePath);
    treadTex.colorSpace = THREE.SRGBColorSpace;
    treadTex.wrapS = treadTex.wrapT = THREE.ClampToEdgeWrapping;

    // ── Per-instance opacity stored in a DataTexture ──────────────────────
    // Each pixel = one instance's opacity (R channel, 0-255)
    // ShaderMaterial samples this by gl_InstanceID to get per-instance alpha.
    // This completely avoids instanceColor so no multiply-black issue.
    this._opacityData = new Uint8Array(DECAL_COUNT * 4).fill(0);
    this._opacityTex  = new THREE.DataTexture(
      this._opacityData,
      DECAL_COUNT,   // width = one pixel per instance
      1,             // height = 1
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    this._opacityTex.needsUpdate = true;

    // ── ShaderMaterial — true transparency, no color tint ──────────────────
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap:      { value: treadTex },
        uOpacity:  { value: this._opacityTex },
        uCount:    { value: DECAL_COUNT },
        uStrength: { value: 0.15 },   // ← max darkening amount, tune 0–1
        uColor:    { value: new THREE.Color(this._decalColor) },
      },
      vertexShader: `
        varying vec2 vUv;
        flat out int vInstance;
        void main() {
          vUv = uv;
          vInstance = gl_InstanceID;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform sampler2D uOpacity;
        uniform int uCount;
        uniform float uStrength;
        uniform vec3 uColor;
        varying vec2 vUv;
        flat in int vInstance;
        void main() {
          vec4 tex = texture2D(uMap, vUv);

          // Use the texture's own luminance as the tread "shape" — no
          // color tint at all. Dark parts of the texture become visible
          // tread marks, bright/flat parts stay fully transparent.
          float luminance = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
          float shapeA    = 1.0 - smoothstep(0.35, 0.9, luminance);

          // Soft radial falloff so the quad boundary is invisible
          vec2  c        = vUv - 0.5;
          float edgeFade = 1.0 - smoothstep(0.28, 0.5, length(c));

          // Per-instance fade-out over the decal's lifetime
          float u = (float(vInstance) + 0.5) / float(uCount);
          float instanceAlpha = texture2D(uOpacity, vec2(u, 0.5)).r;

          float a = shapeA * edgeFade * instanceAlpha * uStrength;
          if (a < 0.01) discard;

          // Color now driven by uColor (map-configurable) instead of a
          // hardcoded literal. True alpha blending (not multiply) so this
          // fades to fully see-through instead of clipping to white/black.
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite:  false,
      toneMapped:  false,   // ← critical: stops ACES from lifting our dark values toward white
      side:        THREE.FrontSide,
    });
    // ── Instanced mesh ────────────────────────────────────────────────────
    this._mesh = new THREE.InstancedMesh(geo, mat, DECAL_COUNT);
    this._mesh.frustumCulled = false;
    this._mesh.castShadow    = false;
    this._mesh.receiveShadow = false;

    const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < DECAL_COUNT; i++) {
      this._mesh.setMatrixAt(i, zeroM);
      this._pool.push({ age: 9999, active: false });
      // opacity starts at 0 — invisible
      this._opacityData[i * 4] = 0;
    }
    this._mesh.instanceMatrix.needsUpdate = true;

    scene.add(this._mesh);
  }

  // ── Public update ─────────────────────────────────────────────────────────

  update(dt, worldPosL, worldPosR, worldQ, speed) {
    let matrixDirty  = false;
    let opacityDirty = false;

    for (let i = 0; i < DECAL_COUNT; i++) {
      const slot = this._pool[i];
      if (!slot.active) continue;

      slot.age += dt;

      // ── Expired ───────────────────────────────────────────────────────
      if (slot.age > FADE_END) {
        slot.active = false;
        // Set opacity to 0 FIRST — quad goes invisible before matrix hides
        this._opacityData[i * 4] = 0;
        this._mesh.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
        matrixDirty  = true;
        opacityDirty = true;
        continue;
      }

      // ── Fade ──────────────────────────────────────────────────────────
      const t     = Math.max(0, (slot.age - FADE_START) / (FADE_END - FADE_START));
      const alpha = 1.0 - THREE.MathUtils.clamp(t, 0, 1);
      this._opacityData[i * 4] = Math.round(alpha * 255);
      opacityDirty = true;
    }

    if (Math.abs(speed) > 0.02) {
      this._tryStamp(worldPosL, worldQ, 'L');
      this._tryStamp(worldPosR, worldQ, 'R');
    }

    if (matrixDirty)  this._mesh.instanceMatrix.needsUpdate = true;
    if (opacityDirty) this._opacityTex.needsUpdate          = true;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _tryStamp(worldPos, worldQ, side) {
    const lastKey  = side === 'L' ? '_lastPosL' : '_lastPosR';
    const accumKey = side === 'L' ? '_distAccL' : '_distAccR';

    if (!this[lastKey]) {
      this[lastKey] = worldPos.clone();
      return;
    }

    const dist = worldPos.distanceTo(this[lastKey]);
    this[accumKey] += dist;
    this[lastKey].copy(worldPos);

    while (this[accumKey] >= STAMP_INTERVAL) {
      this[accumKey] -= STAMP_INTERVAL;
      this._writeStamp(worldPos, worldQ);
    }
  }

  _writeStamp(worldPos, worldQ) {
    const slot = this._head;
    this._head  = (this._head + 1) % DECAL_COUNT;

    this._pool[slot].age    = 0;
    this._pool[slot].active = true;

    // Set opacity to fully visible
    this._opacityData[slot * 4] = 255;
    this._opacityTex.needsUpdate = true;

    const d = this._dummy;
    d.position.set(worldPos.x, worldPos.y + Y_OFFSET, worldPos.z);

    const euler = new THREE.Euler().setFromQuaternion(worldQ, 'YXZ');
    d.rotation.set(0, euler.y, 0);
    d.scale.set(1, 1, 1);
    d.updateMatrix();

    this._mesh.setMatrixAt(slot, d.matrix);
    this._mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this._scene.remove(this._mesh);
    this._mesh.geometry.dispose();
    this._mesh.material.dispose();
    this._opacityTex.dispose();
  }
}