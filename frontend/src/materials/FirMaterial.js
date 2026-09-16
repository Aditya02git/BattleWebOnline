import * as THREE from 'three';
import {
  BRANCH_FRAG, BRANCH_VERT, SHADOW_FRAG, SHADOW_VERT,
  MERGED_VERT, MERGED_FIR_FRAG, MERGED_SHADOW_VERT,
} from '../shaders/shaders';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createFirBranchMaterial
// ═══════════════════════════════════════════════════════════════════════════

export function createFirBranchMaterial(opts = {}) {
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
// PUBLIC: createFirTrunkMaterial
// Plain dark-brown MeshStandardMaterial (no texture)
// ═══════════════════════════════════════════════════════════════════════════

export function createFirTrunkMaterial(opts = {}) {
  const {
    color     = new THREE.Color('#8f6145'),
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
// PUBLIC: createFirMergedMaterial
// One material for trunk + branch geometry merged into a single InstancedMesh.
// Wind is gated per-vertex (aIsLeaf) and per-instance (aWindStrength) instead
// of by swapping materials/meshes.
// ═══════════════════════════════════════════════════════════════════════════

export function createFirMergedMaterial(opts = {}) {
  const {
    diffuse           = null,
    barkDiffuse       = null,        // bark map — same baked atlas as diffuse (Fir_Branch.png)
    trunkColor        = new THREE.Color('#8f6145'),
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
    snowAmount        = 0.0,   // intensity of the snow overlay (0 = none, 1 = full)
    snowTex           = null,  // ← CHANGED: Snow_Fir.png overlay texture, replaces the old flat-color tint
    directLightOffset = 0,
    directLightInt    = 1,
    indirectLightInt  = 1,
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
      uSnowAmount:     { value: snowAmount },
      uSnowTex:        { value: snowTex },       // ← CHANGED: texture-based snow overlay
      uUseSnowTex:     { value: !!snowTex },      // ← ADD: guards sampling when no texture is bound
      uLightDir:       { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
      uLightColor:     { value: new THREE.Color(1.0, 0.95, 0.85) },
      uAmbientColor:   { value: new THREE.Color(0.2, 0.3, 0.4) },
      // ← ADD: manual fog support (custom ShaderMaterials don't get Three's auto fog)
      uFogEnabled:     { value: false },
      uFogColor:       { value: new THREE.Color(0xffffff) },
      uFogNear:        { value: 1 },
      uFogFar:         { value: 1000 },
      uFogExp2:        { value: false },
      uFogDensity:     { value: 0.00025 },
    },
  });

  mat.map = diffuse; // standard property, read by WebGLShadowMap's auto shadow-variant derivation for InstancedMesh

  return mat;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createFirMergedShadowMaterial
// Shadow-map pass for the merged mesh: skips alpha-cutout on trunk vertices.
// ═══════════════════════════════════════════════════════════════════════════

export function createFirMergedShadowMaterial(branchDiffuse, mergedMat, alphaCutoff = 0.35, barkDiffuse = null, barkAlphaCutoff = 0.35) {
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
      map:             { value: branchDiffuse },
      alphaTest:       { value: alphaCutoff },
      barkMap:         { value: barkDiffuse },
      uUseBarkMap:     { value: !!barkDiffuse },
      barkAlphaTest:   { value: barkAlphaCutoff },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createFirLod3Material
// Simple flat billboard/quad material for the farthest LOD tier. No wind,
// no shadow-casting shader variant needed — cheap MeshLambertMaterial with
// alpha-cutout so it still reacts to scene lighting like the near tier.
// ═══════════════════════════════════════════════════════════════════════════

export function createFirLod3Material(opts = {}) {
  const {
    diffuse     = null,
    alphaCutoff = 0.35,
  } = opts;

  const mat = new THREE.MeshLambertMaterial({
    map:         diffuse,
    color:       new THREE.Color('#525f34'), // ← CHANGED: no snow tint on the far billboard tier
    alphaTest:   alphaCutoff,
    side:        THREE.DoubleSide,
    transparent: false,
    depthWrite:  true,
    depthTest:   true,
  });

  return mat;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createBranchShadowMaterial
// ═══════════════════════════════════════════════════════════════════════════

export function createBranchShadowMaterial(branchDiffuse, branchMat, alphaCutoff = 0.35) {
  return new THREE.ShaderMaterial({
    vertexShader:   SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    side:           THREE.DoubleSide,
    uniforms: {
      uTime:           { value: 0 },
      uWindForce:      { value: branchMat.uniforms.uWindForce.value },
      uWindWavesScale: { value: branchMat.uniforms.uWindWavesScale.value },
      uWindSpeed:      { value: branchMat.uniforms.uWindSpeed.value },
      uAnchorBase:     { value: branchMat.uniforms.uAnchorBase.value },
      map:             { value: branchDiffuse },
      alphaTest:       { value: alphaCutoff },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY: sync scene lights → branch material uniforms (call each frame)
// ═══════════════════════════════════════════════════════════════════════════

export function syncFirLighting(branchMat, scene) {
  // ← ADD: keep the custom shader's fog uniforms matched to the scene's fog,
  // since ShaderMaterial doesn't get Three.js's automatic fog handling.
  if (branchMat.uniforms.uFogEnabled) {
    if (scene.fog) {
      branchMat.uniforms.uFogEnabled.value = true;
      branchMat.uniforms.uFogColor.value.copy(scene.fog.color);
      if (scene.fog.isFogExp2) {
        branchMat.uniforms.uFogExp2.value    = true;
        branchMat.uniforms.uFogDensity.value = scene.fog.density;
      } else {
        branchMat.uniforms.uFogExp2.value = false;
        branchMat.uniforms.uFogNear.value = scene.fog.near;
        branchMat.uniforms.uFogFar.value  = scene.fog.far;
      }
    } else {
      branchMat.uniforms.uFogEnabled.value = false;
    }
  }

  scene.traverse((obj) => {
    if (obj.isDirectionalLight) {
      const dir = new THREE.Vector3();
      obj.getWorldDirection(dir);
      dir.negate();
      branchMat.uniforms.uLightDir.value.copy(dir);
      branchMat.uniforms.uLightColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.5);
    }
    if (obj.isAmbientLight) {
      branchMat.uniforms.uAmbientColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.3);
    }
  });
}