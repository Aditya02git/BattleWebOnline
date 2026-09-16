import * as THREE from 'three';
import {
  SHADOW_FRAG, SHADOW_VERT,
  MERGED_VERT, MERGED_BIRCH_FRAG, MERGED_SHADOW_VERT,
} from '../shaders/shaders';

// ═══════════════════════════════════════════════════════════════════════════
// NOTE: there's no dedicated MERGED_MAPLE_FRAG in shaders.js, so this reuses
// MERGED_BIRCH_FRAG for the merged fragment shader — maple is a broadleaf
// tree like birch (one-sided bark + two-sided translucent leaves), not a
// conifer like fir (which is why MERGED_FIR_FRAG's one-sided needle shading
// wouldn't look right here). If you later want maple-specific fragment
// logic (e.g. an autumn-color gradient beyond what uMainColor/uSecondColor
// already give you), copy MERGED_BIRCH_FRAG into a new MERGED_MAPLE_FRAG
// export in shaders.js and swap the import below.
//
// uSnowAmount/uSnowTex/uUseSnowTex are still wired up in the uniforms below
// for parity with the other forests' opts, but MERGED_BIRCH_FRAG doesn't
// reference them — WebGL just ignores unused uniforms, so this is harmless
// unless/until you add snow sampling to the shader.
//
// The standalone createMapleLeafMaterial (parity with createFirBranchMaterial,
// for rendering leaves as a separate non-merged mesh) was dropped from this
// file since it needs its own LEAF_FRAG/LEAF_VERT shaders that don't exist
// yet — InstancedMapleForest.js only uses the merged-mesh path below anyway.
// Add it back once you have leaf-specific shaders, following the same
// pattern as createFirBranchMaterial in FirMaterial.js.
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createMapleTrunkMaterial
// ═══════════════════════════════════════════════════════════════════════════

export function createMapleTrunkMaterial(opts = {}) {
  const {
    color     = new THREE.Color('#6b4a34'),
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
// PUBLIC: createMapleMergedMaterial
// One material for trunk + leaf geometry merged into a single InstancedMesh.
// Wind is gated per-vertex (aIsLeaf) and per-instance (aWindStrength) instead
// of by swapping materials/meshes.
// ═══════════════════════════════════════════════════════════════════════════

export function createMapleMergedMaterial(opts = {}) {
  const {
    diffuse           = null,
    barkDiffuse       = null,        // no baked bark atlas for maple by default — flat uTrunkColor tint is used instead
    trunkColor        = new THREE.Color('#6b4a34'),
    windForce         = 0.5,
    windWavesScale    = 0.1,
    windSpeed         = 0.6,
    anchorBase        = false,
    mainColor         = new THREE.Color(0.35, 0.14, 0.05),
    secondColor       = new THREE.Color(0.55, 0.28, 0.06),
    color2Level       = -7.5,
    color2Fade        = -0.06,
    alphaCutoff       = 0.35,
    barkAlphaCutoff   = 0.35,
    snowAmount        = 0.0,   // no Snow_Maple.png yet — kept for parity with the forest manager's shared opts
    snowTex           = null,
    directLightOffset = 0,
    directLightInt    = 1,
    indirectLightInt  = 1,
  } = opts;

  const mat = new THREE.ShaderMaterial({
    vertexShader:   MERGED_VERT,
    fragmentShader: MERGED_BIRCH_FRAG,
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
      uSnowTex:        { value: snowTex },
      uUseSnowTex:     { value: !!snowTex },
      uLightDir:       { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
      uLightColor:     { value: new THREE.Color(1.0, 0.95, 0.85) },
      uAmbientColor:   { value: new THREE.Color(0.2, 0.3, 0.4) },
      // manual fog support (custom ShaderMaterials don't get Three's auto fog)
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
// PUBLIC: createMapleMergedShadowMaterial
// Shadow-map pass for the merged mesh: skips alpha-cutout on trunk vertices.
// ═══════════════════════════════════════════════════════════════════════════

export function createMapleMergedShadowMaterial(leafDiffuse, mergedMat, alphaCutoff = 0.35, barkDiffuse = null, barkAlphaCutoff = 0.35) {
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
      map:             { value: leafDiffuse },
      alphaTest:       { value: alphaCutoff },
      barkMap:         { value: barkDiffuse },
      uUseBarkMap:     { value: !!barkDiffuse },
      barkAlphaTest:   { value: barkAlphaCutoff },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createMapleLod3Material
// Simple flat billboard/quad material for the farthest LOD tier. No wind,
// no shadow-casting shader variant needed — cheap MeshLambertMaterial with
// alpha-cutout so it still reacts to scene lighting like the near tier.
// ═══════════════════════════════════════════════════════════════════════════

export function createMapleLod3Material(opts = {}) {
  const {
    diffuse     = null,
    alphaCutoff = 0.35,
  } = opts;

  const mat = new THREE.MeshLambertMaterial({
    map:         diffuse,
    color:       new THREE.Color('#586a2b'), // flat autumn tint for the far billboard tier
    alphaTest:   alphaCutoff,
    side:        THREE.DoubleSide,
    transparent: false,
    depthWrite:  true,
    depthTest:   true,
  });

  return mat;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createMapleLeafShadowMaterial
// (parity with createBranchShadowMaterial — only needed for the non-merged
// leaf path, see createMapleLeafMaterial above.)
// ═══════════════════════════════════════════════════════════════════════════

export function createMapleLeafShadowMaterial(leafDiffuse, leafMat, alphaCutoff = 0.35) {
  return new THREE.ShaderMaterial({
    vertexShader:   SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    side:           THREE.DoubleSide,
    uniforms: {
      uTime:           { value: 0 },
      uWindForce:      { value: leafMat.uniforms.uWindForce.value },
      uWindWavesScale: { value: leafMat.uniforms.uWindWavesScale.value },
      uWindSpeed:      { value: leafMat.uniforms.uWindSpeed.value },
      uAnchorBase:     { value: leafMat.uniforms.uAnchorBase.value },
      map:             { value: leafDiffuse },
      alphaTest:       { value: alphaCutoff },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY: sync scene lights → merged material uniforms (call each frame)
// ═══════════════════════════════════════════════════════════════════════════

export function syncMapleLighting(mergedMat, scene) {
  // keep the custom shader's fog uniforms matched to the scene's fog,
  // since ShaderMaterial doesn't get Three.js's automatic fog handling.
  if (mergedMat.uniforms.uFogEnabled) {
    if (scene.fog) {
      mergedMat.uniforms.uFogEnabled.value = true;
      mergedMat.uniforms.uFogColor.value.copy(scene.fog.color);
      if (scene.fog.isFogExp2) {
        mergedMat.uniforms.uFogExp2.value    = true;
        mergedMat.uniforms.uFogDensity.value = scene.fog.density;
      } else {
        mergedMat.uniforms.uFogExp2.value = false;
        mergedMat.uniforms.uFogNear.value = scene.fog.near;
        mergedMat.uniforms.uFogFar.value  = scene.fog.far;
      }
    } else {
      mergedMat.uniforms.uFogEnabled.value = false;
    }
  }

  scene.traverse((obj) => {
    if (obj.isDirectionalLight) {
      const dir = new THREE.Vector3();
      obj.getWorldDirection(dir);
      dir.negate();
      mergedMat.uniforms.uLightDir.value.copy(dir);
      mergedMat.uniforms.uLightColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.5);
    }
    if (obj.isAmbientLight) {
      mergedMat.uniforms.uAmbientColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.3);
    }
  });
}