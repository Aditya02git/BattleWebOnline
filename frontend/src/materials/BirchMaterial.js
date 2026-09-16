import * as THREE from "three";
import {
  LEAVES_FRAG,
  LEAVES_VERT,
  SHADOW_FRAG,
  SHADOW_VERT,
  MERGED_VERT,
  MERGED_BIRCH_FRAG,
  MERGED_SHADOW_VERT,
} from "../shaders/shaders";

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createBirchLeavesMaterial
// ═══════════════════════════════════════════════════════════════════════════
export function createBirchLeavesMaterial(opts = {}) {
  const {
    diffuse = null,
    windForce = 0.4,
    windWavesScale = 0.08,
    windSpeed = 0.508,
    anchorBase = false,
    mainColor = new THREE.Color(0.15, 0.55, 0.1),
    secondColor = new THREE.Color(0.25, 0.7, 0.05),
    color2Level = -7.5,
    color2Fade = -0.06,
    alphaCutoff = 0.35,
    smoothness = 0.1,
    translucencyInt = 8.0,
    directLightOffset = 0,
    directLightInt = 1,
    indirectLightInt = 1,
  } = opts;

  const mat = new THREE.ShaderMaterial({
    vertexShader: MERGED_VERT,
    fragmentShader: MERGED_BIRCH_FRAG,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    alphaTest: alphaCutoff, // exposed so Three.js's shadow-variant auto-derivation alpha-tests
    uniforms: {
      uDiffuse: { value: diffuse },
      uTime: { value: 0 },
      uWindForce: { value: windForce },
      uWindWavesScale: { value: windWavesScale },
      uWindSpeed: { value: windSpeed },
      uAnchorBase: { value: anchorBase },
      uMainColor: { value: mainColor },
      uSecondColor: { value: secondColor },
      uColor2Level: { value: color2Level },
      uColor2Fade: { value: color2Fade },
      uAlphaCutoff: { value: alphaCutoff },
      uSmoothness: { value: smoothness },
      uTranslucencyInt: { value: translucencyInt },
      uDirectLightOffset: { value: directLightOffset },
      uDirectLightInt: { value: directLightInt },
      uIndirectLightInt: { value: indirectLightInt },
      uLightDir: { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
      uLightColor: { value: new THREE.Color(1.0, 0.95, 0.85) },
      uAmbientColor: { value: new THREE.Color(0.3, 0.4, 0.5) },
    },
  });

  return mat;
}

// ═══════════════════════════════════════════════════════════════════════════
// BARK MATERIAL
// ═══════════════════════════════════════════════════════════════════════════
export function createBirchBarkMaterial(opts = {}) {
  const {
    diffuse = null,
    color = new THREE.Color("#EADDCA"),
    roughness = 0.8,
    metalness = 0.0,
  } = opts;

  const mat = new THREE.MeshStandardMaterial({
    map: diffuse,
    color: color,
    roughness: roughness,
    metalness: metalness,
    side: THREE.FrontSide,
  });

  mat.uniforms = { uTime: { value: 0 } };
  return mat;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createBirchMergedMaterial
// ═══════════════════════════════════════════════════════════════════════════
export function createBirchMergedMaterial(opts = {}) {
  const {
    diffuse = null,           // leaves texture
    barkDiffuse = null,       // bark texture (optional — Birch bark can use a map)
    trunkColor = new THREE.Color("#EADDCA"),
    windForce = 0.4,
    windWavesScale = 0.08,
    windSpeed = 0.508,
    anchorBase = false,
    mainColor = new THREE.Color(0.15, 0.55, 0.1),
    secondColor = new THREE.Color(0.25, 0.7, 0.05),
    color2Level = -7.5,
    color2Fade = -0.06,
    alphaCutoff = 0.35,
    barkAlphaCutoff = 0.35,
    } = opts;

  const mat = new THREE.ShaderMaterial({
    vertexShader: MERGED_VERT,
    fragmentShader: MERGED_BIRCH_FRAG,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    alphaTest: alphaCutoff, // exposed so Three.js's shadow-variant auto-derivation alpha-tests
    uniforms: {
      uDiffuse: { value: diffuse },
      uBarkDiffuse: { value: barkDiffuse },
      uUseBarkMap: { value: !!barkDiffuse },
      uTrunkColor: { value: trunkColor },
      uTime: { value: 0 },
      uWindForce: { value: windForce },
      uWindWavesScale: { value: windWavesScale },
      uWindSpeed: { value: windSpeed },
      uAnchorBase: { value: anchorBase },
      uMainColor: { value: mainColor },
      uSecondColor: { value: secondColor },
      uColor2Level: { value: color2Level },
      uColor2Fade: { value: color2Fade },
      uAlphaCutoff: { value: alphaCutoff },
      uBarkAlphaCutoff: { value: barkAlphaCutoff },
      uLightDir: { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
      uLightColor: { value: new THREE.Color(1.0, 0.95, 0.85) },
      uAmbientColor: { value: new THREE.Color(0.3, 0.4, 0.5) },
      // ← ADD: manual fog support (ShaderMaterial doesn't get Three's auto fog)
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
// PUBLIC: createBirchMergedShadowMaterial
// ═══════════════════════════════════════════════════════════════════════════
export function createBirchMergedShadowMaterial(leavesDiffuse, mergedMat, alphaCutoff = 0.35, barkDiffuse = null, barkAlphaCutoff = 0.35) {
  return new THREE.ShaderMaterial({
    vertexShader: MERGED_SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    defines: { USE_LEAF_MASK: '', USE_INSTANCING: '' },
    side: THREE.DoubleSide,
    alphaTest: alphaCutoff, 
    uniforms: {
      uTime: { value: 0 },
      uWindForce: { value: mergedMat.uniforms.uWindForce.value },
      uWindWavesScale: { value: mergedMat.uniforms.uWindWavesScale.value },
      uWindSpeed: { value: mergedMat.uniforms.uWindSpeed.value },
      uAnchorBase: { value: mergedMat.uniforms.uAnchorBase.value },
      map: { value: leavesDiffuse },
      alphaTest: { value: alphaCutoff },
      barkMap: { value: barkDiffuse },
      uUseBarkMap: { value: !!barkDiffuse },
      barkAlphaTest: { value: barkAlphaCutoff },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: createBirchLod3Material
// Simple flat billboard/quad material for the farthest LOD tier. No wind,
// no shadow-casting shader variant needed — cheap MeshLambertMaterial with
// alpha-cutout so it still reacts to scene lighting like the near tier.
// ═══════════════════════════════════════════════════════════════════════════

export function createBirchLod3Material(opts = {}) {
  const {
    diffuse     = null,
    alphaCutoff = 0.35,
  } = opts;

  const mat = new THREE.MeshLambertMaterial({
    map:         diffuse,
    color:       new THREE.Color('#586a2b'), // ← CHANGED: no snow tint — birch never gets the overlay
    alphaTest:   alphaCutoff,
    side:        THREE.DoubleSide,
    transparent: false,
    depthWrite:  true,
    depthTest:   true,
  });

  return mat;
}
// ═══════════════════════════════════════════════════════════════════════════
// SHADOW MATERIAL
// ═══════════════════════════════════════════════════════════════════════════
export function createLeavesShadowMaterial(
  leavesDiffuse,
  leavesMat,
  alphaCutoff = 0.35,
) {
  return new THREE.ShaderMaterial({
    vertexShader: SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    side: THREE.DoubleSide,
    alphaTest: alphaCutoff, 
    uniforms: {
      uTime: { value: 0 },
      uWindForce: { value: leavesMat.uniforms.uWindForce.value },
      uWindWavesScale: { value: leavesMat.uniforms.uWindWavesScale.value },
      uWindSpeed: { value: leavesMat.uniforms.uWindSpeed.value },
      uAnchorBase: { value: leavesMat.uniforms.uAnchorBase.value },
      map: { value: leavesDiffuse },
      alphaTest: { value: alphaCutoff },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY: sync scene lights → leaves material uniforms (call each frame)
// ═══════════════════════════════════════════════════════════════════════════

export function syncLighting(leavesMat, scene) {
  // ← ADD: keep the custom shader's fog uniforms matched to the scene's fog
  if (leavesMat.uniforms.uFogEnabled) {
    if (scene.fog) {
      leavesMat.uniforms.uFogEnabled.value = true;
      leavesMat.uniforms.uFogColor.value.copy(scene.fog.color);
      if (scene.fog.isFogExp2) {
        leavesMat.uniforms.uFogExp2.value    = true;
        leavesMat.uniforms.uFogDensity.value = scene.fog.density;
      } else {
        leavesMat.uniforms.uFogExp2.value = false;
        leavesMat.uniforms.uFogNear.value = scene.fog.near;
        leavesMat.uniforms.uFogFar.value  = scene.fog.far;
      }
    } else {
      leavesMat.uniforms.uFogEnabled.value = false;
    }
  }

  scene.traverse((obj) => {
    if (obj.isDirectionalLight) {
      const dir = new THREE.Vector3();
      obj.getWorldDirection(dir);
      dir.negate();
      leavesMat.uniforms.uLightDir.value.copy(dir);
      leavesMat.uniforms.uLightColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.5);
    }
    if (obj.isAmbientLight) {
      leavesMat.uniforms.uAmbientColor.value
        .copy(obj.color)
        .multiplyScalar(obj.intensity * 0.3);
    }
  });
}
