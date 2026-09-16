import * as THREE from 'three';
import FakeGlowMaterial from './FakeGlowMaterial.js';

function makeGlowTexture(innerColor, size = 256) {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0.0,  innerColor);
  grad.addColorStop(0.25, innerColor);
  grad.addColorStop(0.6,  innerColor.replace(/[\d.]+\)$/, '0.4)'));
  grad.addColorStop(1.0,  innerColor.replace(/[\d.]+\)$/, '0.0)'));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(cv);
}

function hexToRgba(hex, alpha = 1.0) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applyGlow(child, color) {
  const mat = new FakeGlowMaterial();
  mat.uniforms.glowColor.value.set(color);
  mat.uniforms.glowInternalRadius.value = 0.5;
  mat.uniforms.glowSharpness.value = 3.0;
  mat.uniforms.opacity.value = 5.0;
  mat.uniforms.falloff.value = 2.0;
  mat.depthTest = true;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;
  return mat;
}

function buildSpriteGlow(parent, position, colorHex, texCore, texOuter, spriteList) {
  const { x, y, z } = position;
  const baseColor = new THREE.Color(colorHex);

  const layers = [
    { map: texCore,  scale: 0.5, opacity: 1.0,  color: baseColor.clone().multiplyScalar(1.4) },
    { map: texOuter, scale: 1.0, opacity: 0.85, color: baseColor.clone() },
    { map: texOuter, scale: 2.2, opacity: 0.45, color: baseColor.clone().multiplyScalar(0.8) },
    { map: texOuter, scale: 4.0, opacity: 0.18, color: baseColor.clone().multiplyScalar(0.6) },
  ];

  layers.forEach(({ map, scale, opacity, color }) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity,
      color,
    }));
    sprite.scale.set(scale, scale, 1);
    sprite.position.set(x, y, z);
    parent.add(sprite);
    spriteList.push({ sprite, baseScale: scale, baseOpacity: opacity });
  });
}

export class TankLights {
  constructor(model, options = {}) {
    const {
      frontColor = '#ffe8b0',
      rearColor  = '#7e1100',
      intensity  = 1.0,
      haloSize   = 1.0,
      pulseSpeed = 0.0,
      frontLightsOn = false,
    } = options;

    this._intensity    = intensity;
    this._haloSize     = haloSize;
    this._pulseSpeed   = pulseSpeed;
    this._clock        = new THREE.Clock();
    this._frontEnabled = frontLightsOn;   // toggled by L key

    // Separate tracking for front and rear
    this._sprites      = [];     // all sprites (for dispose)
    this._frontSprites = [];
    this._rearSprites  = [];
    this._frontMeshes  = [];     // { mesh, glowMat, originalMat }
    this._rearMeshes   = [];

    const frontTexCore  = makeGlowTexture(hexToRgba(frontColor, 1.0));
    const frontTexOuter = makeGlowTexture(hexToRgba(frontColor, 1.0));
    const rearTexCore   = makeGlowTexture(hexToRgba(rearColor,  1.0));
    const rearTexOuter  = makeGlowTexture(hexToRgba(rearColor,  1.0));

    model.traverse((child) => {
      if (!child.isMesh) return;

      if (child.name.startsWith('Front_Light_')) {
        // Save original material and apply glow
        const originalMat = child.material;
        const glowMat     = applyGlow(child, frontColor);
        child.material    = glowMat;
        this._frontMeshes.push({ mesh: child, glowMat, originalMat });

        // Build sprite layers and track them as front sprites
        const before = this._sprites.length;
        buildSpriteGlow(
          child.parent,
          child.position.clone(),
          frontColor,
          frontTexCore,
          frontTexOuter,
          this._sprites
        );
        this._frontSprites.push(...this._sprites.slice(before));
      }

      if (child.name.startsWith('Rear_Light_')) {
        // Save original material and apply glow
        const originalMat = child.material;
        const glowMat     = applyGlow(child, rearColor);
        child.material    = glowMat;
        this._rearMeshes.push({ mesh: child, glowMat, originalMat });

        // Build sprite layers and track them as rear sprites
        const before = this._sprites.length;
        buildSpriteGlow(
          child.parent,
          child.position.clone(),
          rearColor,
          rearTexCore,
          rearTexOuter,
          this._sprites
        );
        this._rearSprites.push(...this._sprites.slice(before));
      }
    });

    // Apply initial front light state based on frontLightsOn option
    this._frontMeshes.forEach(({ mesh, glowMat, originalMat }) => {
      mesh.material = this._frontEnabled ? glowMat : originalMat;
    });
    this._frontSprites.forEach(({ sprite }) => {
      sprite.visible = this._frontEnabled;
    });

    // ── L key listener — toggles front lights only ────────────────────────
    this._onKeyDown = (e) => {
      if (e.code === 'KeyL') this.toggleFront();
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  // ── Toggle front lights on/off ──────────────────────────────────────────
  toggleFront() {
    this._frontEnabled = !this._frontEnabled;

    // Swap front mesh materials
    this._frontMeshes.forEach(({ mesh, glowMat, originalMat }) => {
      mesh.material = this._frontEnabled ? glowMat : originalMat;
    });

    // Show/hide front sprites — skips draw calls when hidden
    this._frontSprites.forEach(({ sprite }) => {
      sprite.visible = this._frontEnabled;
    });
  }

  // ── Per-frame update ────────────────────────────────────────────────────
  update() {
    const t     = this._clock.getElapsedTime();
    const pulse = this._pulseSpeed > 0
      ? 1.0 + Math.sin(t * this._pulseSpeed) * 0.08
      : 1.0;

    // Rear lights — always on, always updated
    this._rearSprites.forEach(({ sprite, baseScale, baseOpacity }) => {
      const s = baseScale * this._haloSize * pulse;
      sprite.scale.set(s, s, 1);
      sprite.material.opacity = Math.min(1.0, baseOpacity * this._intensity * pulse);
    });

    // Front lights — only update when enabled
    if (!this._frontEnabled) return;
    this._frontSprites.forEach(({ sprite, baseScale, baseOpacity }) => {
      const s = baseScale * this._haloSize * pulse;
      sprite.scale.set(s, s, 1);
      sprite.material.opacity = Math.min(1.0, baseOpacity * this._intensity * pulse);
    });
  }

  // ── Clean up listener and sprite materials on tank dispose/respawn ──────
  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    this._sprites.forEach(({ sprite }) => {
      sprite.material.dispose();
    });
    this._sprites      = [];
    this._frontSprites = [];
    this._rearSprites  = [];
    this._frontMeshes  = [];
    this._rearMeshes   = [];
  }

  set intensity(v)  { this._intensity  = v; }
  set haloSize(v)   { this._haloSize   = v; }
  set pulseSpeed(v) { this._pulseSpeed = v; }
}