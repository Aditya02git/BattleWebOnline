import * as THREE from 'three';
import { FLOWERS_FRAG, FLOWERS_VERT, FLOWERS_SHADOW_FRAG, FLOWERS_SHADOW_VERT } from '../shaders/shaders';
import { MAX_GRASS_IMPACTS } from './GrassMaterial.js';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createFlowersMaterial
// ═══════════════════════════════════════════════════════════════════════════

export function createFlowersMaterial(opts = {}) {
  const {
    diffuse           = null,
    windForce         = 0.01,
    windWavesScale    = 0.3,
    windSpeed         = 0.4,
    anchorBase        = true,
    mainColor         = new THREE.Color(1.0, 0.08, 0.58),   // pink flower head
    secondColor       = new THREE.Color(0.05, 0.55, 0.05),  // green stem
    flowerStart       = 0.6,   // UV.y where pink begins (tune 0.4–0.8)
    colorBlend        = 0.12,  // transition softness
    alphaCutoff       = 0.35,
    smoothness        = 0.1,
    translucencyInt   = 3.0,
    directLightOffset = 0.0,
    directLightInt    = 1.0,
    indirectLightInt  = 1.0,
  } = opts;

  return new THREE.ShaderMaterial({
    vertexShader:   FLOWERS_VERT,
    fragmentShader: FLOWERS_FRAG,
    side:           THREE.DoubleSide,
    transparent:    true,
    depthWrite:     false,
    depthTest:      true,
    uniforms: {
      uDiffuse:           { value: diffuse },
      uTime:              { value: 0 },
      uWindForce:         { value: windForce },
      uWindWavesScale:    { value: windWavesScale },
      uWindSpeed:         { value: windSpeed },
      uAnchorBase:        { value: anchorBase },
      uMainColor:         { value: mainColor },
      uSecondColor:       { value: secondColor },
      uFlowerStart:       { value: flowerStart },
      uColorBlend:        { value: colorBlend },
      uAlphaCutoff:       { value: alphaCutoff },
      uSmoothness:        { value: smoothness },
      uTranslucencyInt:   { value: translucencyInt },
      uDirectLightOffset: { value: directLightOffset },
      uDirectLightInt:    { value: directLightInt },
      uIndirectLightInt:  { value: indirectLightInt },
      uImpactData:        { value: Array.from({ length: MAX_GRASS_IMPACTS }, () => new THREE.Vector4(0, 0, -9999, 0)) },
      uImpactCount:       { value: 0 },
      uImpactRadius:      { value: opts.impactRadius   ?? 8.0 },
      uImpactStrength:    { value: opts.impactStrength ?? 1.0 },
      uImpactDuration:    { value: opts.impactDuration ?? 0.8 },
      uImpactDecay:       { value: opts.impactDecay    ?? 4.0 },
      uLightDir:          { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
      uLightColor:        { value: new THREE.Color(1.0, 0.95, 0.85) },
      uAmbientColor:      { value: new THREE.Color(0.3, 0.4, 0.5) },
      uHeightFade:        { value: 1.0 },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createFlowersShadowMaterial
// ═══════════════════════════════════════════════════════════════════════════

export function createFlowersShadowMaterial(diffuse, mat, alphaCutoff = 0.35) {
  return new THREE.ShaderMaterial({
    vertexShader:   FLOWERS_SHADOW_VERT,
    fragmentShader: FLOWERS_SHADOW_FRAG,
    side:           THREE.DoubleSide,
    uniforms: {
      uTime:           { value: 0 },
      uWindForce:      { value: mat.uniforms.uWindForce.value },
      uWindWavesScale: { value: mat.uniforms.uWindWavesScale.value },
      uWindSpeed:      { value: mat.uniforms.uWindSpeed.value },
      uAnchorBase:     { value: mat.uniforms.uAnchorBase.value },
      uImpactData:     { value: mat.uniforms.uImpactData.value }, // shared array reference
      uImpactCount:    { value: mat.uniforms.uImpactCount.value },
      uImpactRadius:   { value: mat.uniforms.uImpactRadius.value },
      uImpactStrength: { value: mat.uniforms.uImpactStrength.value },
      uImpactDuration: { value: mat.uniforms.uImpactDuration.value },
      uImpactDecay:    { value: mat.uniforms.uImpactDecay.value },
      map:             { value: diffuse },
      alphaTest:       { value: alphaCutoff },
      uHeightFade:     { value: 1.0 },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY: sync scene lights → flowers material uniforms (call each frame)
// ═══════════════════════════════════════════════════════════════════════════

export function syncFlowersLighting(mat, scene) {
  scene.traverse((obj) => {
    if (obj.isDirectionalLight) {
      const dir = new THREE.Vector3();
      obj.getWorldDirection(dir);
      dir.negate();
      mat.uniforms.uLightDir.value.copy(dir);
      mat.uniforms.uLightColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.5);
    }
    if (obj.isAmbientLight) {
      mat.uniforms.uAmbientColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.3);
    }
  });
}