import * as THREE from 'three';
import { GRASS_FRAG, GRASS_SHADOW_FRAG, GRASS_SHADOW_VERT, GRASS_VERT } from '../shaders/shaders';

export const MAX_GRASS_IMPACTS = 8;

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createGrassMaterial
// ═══════════════════════════════════════════════════════════════════════════
export function createGrassMaterial(opts = {}) {
  const {
    diffuse           = null,
    // Wind Settings
    windForce         = 0.01,
    windWavesScale    = 0.3,
    windSpeed         = 0.4,
    anchorBase        = true, 
    // Color Settings
    mainColor         = new THREE.Color('#5f642e'),
    secondColor       = new THREE.Color('#5f642e'),
    color2Level       = -0.29,
    color2Fade        = 0.64,
    // Surface
    alphaCutoff       = 0.35,
    smoothness        = 0.1,
    // Lighting Settings
    translucencyInt   = 2.0,
    directLightOffset = 0.0,
    directLightInt    = 1.0,
    indirectLightInt  = 1.0,
  } = opts;

  const mat = new THREE.ShaderMaterial({
    vertexShader:   GRASS_VERT,
    fragmentShader: GRASS_FRAG,
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
      uMainColor:         { value: mainColor instanceof THREE.Color ? mainColor : new THREE.Color(...mainColor) },
      uSecondColor:       { value: secondColor instanceof THREE.Color ? secondColor : new THREE.Color(...secondColor) },
      uColor2Level:       { value: color2Level },
      uColor2Fade:        { value: color2Fade },
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
      uHeightFade:        { value: 1.0 }, // ← ADD      
      uAlphaBoost:        { value: 1.8 }, // ← ADD: raise for more solid-looking grass (try 1.5–2.5)    
    },
  });

  return mat;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createGrassShadowMaterial
// ═══════════════════════════════════════════════════════════════════════════
export function createGrassShadowMaterial(grassDiffuse, grassMat, alphaCutoff = 0.35) {
  return new THREE.ShaderMaterial({
    vertexShader:   GRASS_SHADOW_VERT,
    fragmentShader: GRASS_SHADOW_FRAG,
    side:           THREE.DoubleSide,
    uniforms: {
      uTime:           { value: 0 },
      uWindForce:      { value: grassMat.uniforms.uWindForce.value },
      uWindWavesScale: { value: grassMat.uniforms.uWindWavesScale.value },
      uWindSpeed:      { value: grassMat.uniforms.uWindSpeed.value },
      uAnchorBase:     { value: grassMat.uniforms.uAnchorBase.value },
      uImpactData:     { value: grassMat.uniforms.uImpactData.value }, // shared array reference
      uImpactCount:    { value: grassMat.uniforms.uImpactCount.value },
      uImpactRadius:   { value: grassMat.uniforms.uImpactRadius.value },
      uImpactStrength: { value: grassMat.uniforms.uImpactStrength.value },
      uImpactDuration: { value: grassMat.uniforms.uImpactDuration.value },
      uImpactDecay:    { value: grassMat.uniforms.uImpactDecay.value },
      map:             { value: grassDiffuse },
      alphaTest:       { value: alphaCutoff },
      uHeightFade:     { value: 1.0 }, // ← ADD
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: syncGrassLighting  (call each frame, same pattern as syncLighting)
// ═══════════════════════════════════════════════════════════════════════════
export function syncGrassLighting(grassMat, scene) {
  scene.traverse((obj) => {
    if (obj.isDirectionalLight) {
      const dir = new THREE.Vector3();
      obj.getWorldDirection(dir);
      dir.negate();
      grassMat.uniforms.uLightDir.value.copy(dir);
      grassMat.uniforms.uLightColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.6);
    }
    if (obj.isAmbientLight) {
      grassMat.uniforms.uAmbientColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.5);
    }
  });
}