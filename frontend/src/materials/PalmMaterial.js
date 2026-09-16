import * as THREE from 'three';
import {
  BRANCH_FRAG, BRANCH_VERT, SHADOW_FRAG, SHADOW_VERT,
  MERGED_VERT, MERGED_FIR_FRAG, MERGED_SHADOW_VERT,
} from '../shaders/shaders';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createPalmFrondMaterial
// ═══════════════════════════════════════════════════════════════════════════

export function createPalmFrondMaterial(opts = {}) {
  const {
    diffuse           = null,
    windForce         = 0.4,
    windWavesScale    = 0.08,
    windSpeed         = 0.508,
    anchorBase        = false,
    mainColor         = new THREE.Color(0.04, 0.18, 0.05),
    secondColor       = new THREE.Color(0.08, 0.28, 0.07),
    color2Level       = -7.5,
    color2Fade        = -0.06,
    alphaCutoff       = 0.35,
    smoothness        = 0.05,
    translucencyInt   = 10.0,
    directLightOffset = 0,
    directLightInt    = 1,
    indirectLightInt  = 1,
  } = opts;

  const mat = new THREE.ShaderMaterial({
    vertexShader:   BRANCH_VERT,
    fragmentShader: BRANCH_FRAG,
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
      uMainColor:         { value: mainColor },
      uSecondColor:       { value: secondColor },
      uColor2Level:       { value: color2Level },
      uColor2Fade:        { value: color2Fade },
      uAlphaCutoff:       { value: alphaCutoff },
      uSmoothness:        { value: smoothness },
      uTranslucencyInt:   { value: translucencyInt },
      uDirectLightOffset: { value: directLightOffset },
      uDirectLightInt:    { value: directLightInt },
      uIndirectLightInt:  { value: indirectLightInt },
      uLightDir:          { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
      uLightColor:        { value: new THREE.Color(1.0, 0.95, 0.85) },
      uAmbientColor:      { value: new THREE.Color(0.2, 0.3, 0.4) },
    },
  });

  return mat;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createPalmTrunkMaterial
// Plain tan/grey MeshStandardMaterial (no texture)
// ═══════════════════════════════════════════════════════════════════════════

export function createPalmTrunkMaterial(opts = {}) {
  const {
    color     = new THREE.Color('#a08662'),
    roughness = 0.9,
    metalness = 0.0,
  } = opts;

  const mat = new THREE.MeshStandardMaterial({
    color:     color,
    roughness: roughness,
    metalness: metalness,
    side:      THREE.FrontSide,
  });

  mat.uniforms = { uTime: { value: 0 } };
  return mat;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createPalmMergedMaterial
// One material for trunk + frond geometry merged into a single InstancedMesh.
// Wind is gated per-vertex (aIsLeaf) and per-instance (aWindStrength) instead
// of by swapping materials/meshes.
// ═══════════════════════════════════════════════════════════════════════════

export function createPalmMergedMaterial(opts = {}) {
  const {
    diffuse           = null,
    barkDiffuse       = null,        // bark map — same baked atlas as diffuse (Palm_Leaves.png)
    trunkColor        = new THREE.Color('#a08662'),
    windForce         = 0.4,
    windWavesScale    = 0.08,
    windSpeed         = 0.508,
    anchorBase        = false,
    mainColor         = new THREE.Color(0.04, 0.18, 0.05),
    secondColor       = new THREE.Color(0.08, 0.28, 0.07),
    color2Level       = -7.5,
    color2Fade        = -0.06,
    alphaCutoff       = 0.35,
    barkAlphaCutoff   = 0.35,
    directLightOffset = 0, // unused by current frag; kept for API parity
    directLightInt    = 1,
    indirectLightInt  = 1,
    // ← CHANGED: palm shares MERGED_FIR_FRAG but never gets snow — snowAmount/
    // snowColor removed; uUseSnowTex stays false below so the shader's snow
    // branch is skipped entirely for palm.
  } = opts;

  const mat = new THREE.ShaderMaterial({
    vertexShader:   MERGED_VERT,
    fragmentShader: MERGED_FIR_FRAG,
    side:           THREE.DoubleSide,
    transparent:    false,
    depthWrite:     true,
    depthTest:      true,
    alphaTest:      alphaCutoff, // exposed so Three.js's shadow-variant auto-derivation alpha-tests
    uniforms: {
      uDiffuse:         { value: diffuse },
      uBarkDiffuse:     { value: barkDiffuse },
      uUseBarkMap:      { value: !!barkDiffuse },
      uBarkAlphaCutoff: { value: barkAlphaCutoff },
      uTrunkColor:      { value: trunkColor },
      uTime:            { value: 0 },
      uWindForce:      { value: windForce },
      uWindWavesScale: { value: windWavesScale },
      uWindSpeed:      { value: windSpeed },
      uAnchorBase:     { value: anchorBase },
      uMainColor:      { value: mainColor },
      uSecondColor:    { value: secondColor },
      uColor2Level:    { value: color2Level },
      uColor2Fade:     { value: color2Fade },
      uAlphaCutoff:    { value: alphaCutoff },
      // ← CHANGED: palm never shows snow (only fir does) — bind harmless
      // defaults so MERGED_FIR_FRAG's shared uniforms are always valid.
      uSnowAmount:     { value: 0.0 },
      uSnowTex:        { value: null },
      uUseSnowTex:     { value: false },
      uLightDir:       { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
      uLightColor:     { value: new THREE.Color(1.0, 0.95, 0.85) },
      uAmbientColor:   { value: new THREE.Color(0.2, 0.3, 0.4) },
    },
  });

  mat.map = diffuse; // standard property, read by WebGLShadowMap's auto shadow-variant derivation for InstancedMesh

  return mat;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createPalmMergedShadowMaterial
// Shadow-map pass for the merged mesh: skips alpha-cutout on trunk vertices.
// ═══════════════════════════════════════════════════════════════════════════

export function createPalmMergedShadowMaterial(frondDiffuse, mergedMat, alphaCutoff = 0.35, barkDiffuse = null, barkAlphaCutoff = 0.35) {
  return new THREE.ShaderMaterial({
    vertexShader:   MERGED_SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    defines:        { USE_LEAF_MASK: '', USE_INSTANCING: '' },
    side:           THREE.DoubleSide,
    alphaTest:      alphaCutoff,
    uniforms: {
      uTime:           { value: 0 },
      uWindForce:      { value: mergedMat.uniforms.uWindForce.value },
      uWindWavesScale: { value: mergedMat.uniforms.uWindWavesScale.value },
      uWindSpeed:      { value: mergedMat.uniforms.uWindSpeed.value },
      uAnchorBase:     { value: mergedMat.uniforms.uAnchorBase.value },
      map:             { value: frondDiffuse },
      alphaTest:       { value: alphaCutoff },
      barkMap:         { value: barkDiffuse },
      uUseBarkMap:     { value: !!barkDiffuse },
      barkAlphaTest:   { value: barkAlphaCutoff },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createPalmLod3Material
// Simple flat billboard/quad material for the farthest LOD tier. No wind,
// no shadow-casting shader variant needed — cheap MeshLambertMaterial with
// alpha-cutout so it still reacts to scene lighting like the near tier.
// ═══════════════════════════════════════════════════════════════════════════

export function createPalmLod3Material(opts = {}) {
  const {
    diffuse     = null,
    alphaCutoff = 0.35,
  } = opts;

  const mat = new THREE.MeshLambertMaterial({
    map:         diffuse,
    color:       new THREE.Color('#5f6b3a'), // ← CHANGED: no snow tint
    alphaTest:   alphaCutoff,
    side:        THREE.DoubleSide,
    transparent: false,
    depthWrite:  true,
    depthTest:   true,
  });

  return mat;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createPalmFrondShadowMaterial
// ═══════════════════════════════════════════════════════════════════════════

export function createPalmFrondShadowMaterial(frondDiffuse, frondMat, alphaCutoff = 0.35) {
  return new THREE.ShaderMaterial({
    vertexShader:   SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    side:           THREE.DoubleSide,
    uniforms: {
      uTime:           { value: 0 },
      uWindForce:      { value: frondMat.uniforms.uWindForce.value },
      uWindWavesScale: { value: frondMat.uniforms.uWindWavesScale.value },
      uWindSpeed:      { value: frondMat.uniforms.uWindSpeed.value },
      uAnchorBase:     { value: frondMat.uniforms.uAnchorBase.value },
      map:             { value: frondDiffuse },
      alphaTest:       { value: alphaCutoff },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY: sync scene lights → frond material uniforms (call each frame)
// ═══════════════════════════════════════════════════════════════════════════

export function syncPalmLighting(frondMat, scene) {
  scene.traverse((obj) => {
    if (obj.isDirectionalLight) {
      const dir = new THREE.Vector3();
      obj.getWorldDirection(dir);
      dir.negate();
      frondMat.uniforms.uLightDir.value.copy(dir);
      frondMat.uniforms.uLightColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.5);
    }
    if (obj.isAmbientLight) {
      frondMat.uniforms.uAmbientColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.3);
    }
  });
}