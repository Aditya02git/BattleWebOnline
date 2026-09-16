import * as THREE from "three";
import {
  GRASS_FRAG,
  GRASS_SHADOW_FRAG,
  GRASS_SHADOW_VERT,
  GRASS_VERT,
} from "../shaders/shaders";

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createDesertGrassMaterial
//
// Reuses the same GRASS_VERT / GRASS_FRAG shaders as GrassMaterial but with
// desert-tuned defaults:
//   • Dry sandy-yellow/ochre palette instead of lush green
//   • Slower, stiffer wind (less force, lower frequency)
//   • anchorBase: true so blade roots stay pinned to the ground
// ═══════════════════════════════════════════════════════════════════════════
export function createDesertGrassMaterial(opts = {}) {
  const {
    diffuse           = null,
    // Wind — desert grass is stiffer and moves less than meadow grass
    windForce         = 0.25,
    windWavesScale    = 0.12,
    windSpeed         = 0.35,
    anchorBase        = true,
    // Color — dry ochre at the base, slightly lighter/warmer at the tips
    mainColor         = new THREE.Color(0.42, 0.34, 0.10),
    secondColor       = new THREE.Color(0.62, 0.52, 0.20),
    color2Level       = -0.20,
    color2Fade        = 0.55,
    // Surface
    alphaCutoff       = 0.35,
    smoothness        = 0.08,
    // Lighting
    translucencyInt   = 3.5,
    directLightOffset = 0.0,
    directLightInt    = 1.0,
    indirectLightInt  = 1.0,
  } = opts;

  const mat = new THREE.ShaderMaterial({
    // ── Instancing support ─────────────────────────────────────────────────
    // Enables the #ifdef USE_INSTANCING branches in GRASS_VERT so that
    // instanceMatrix is applied correctly for InstancedMesh rendering.
    defines: {
      USE_INSTANCING: '',
    },
    vertexShader:   GRASS_VERT,
    fragmentShader: GRASS_FRAG,
    side:           THREE.DoubleSide,
    transparent:    false,
    depthWrite:     true,
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
      uLightDir:          { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
      uLightColor:        { value: new THREE.Color(1.0, 0.92, 0.75) },
      uAmbientColor:      { value: new THREE.Color(0.45, 0.38, 0.28) },
    },
  });

  return mat;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createDesertGrassShadowMaterial
// Matches wind uniforms from the main material so shadows stay in sync.
// ═══════════════════════════════════════════════════════════════════════════
export function createDesertGrassShadowMaterial(
  grassDiffuse,
  grassMat,
  alphaCutoff = 0.35,
) {
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
      map:             { value: grassDiffuse },
      alphaTest:       { value: alphaCutoff },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: syncDesertGrassLighting
// Call once per frame (same pattern as syncGrassLighting).
// Picks up DirectionalLight + AmbientLight from the scene automatically.
// ═══════════════════════════════════════════════════════════════════════════
export function syncDesertGrassLighting(grassMat, scene) {
  scene.traverse((obj) => {
    if (obj.isDirectionalLight) {
      const dir = new THREE.Vector3();
      obj.getWorldDirection(dir);
      dir.negate();
      grassMat.uniforms.uLightDir.value.copy(dir);
      grassMat.uniforms.uLightColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.5);
    }
    if (obj.isAmbientLight) {
      grassMat.uniforms.uAmbientColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.3);
    }
  });
}