import * as THREE from "three";
import { LEAVES_FRAG, LEAVES_VERT, SHADOW_FRAG, SHADOW_VERT } from "../shaders/shaders";

export function createBushLeavesMaterial(opts = {}) {
  const {
    diffuse        = null,
    windForce      = 0.4,
    windWavesScale = 0.08,
    windSpeed      = 0.508,
    anchorBase     = false,
    mainColor      = new THREE.Color(0.1, 0.32, 0.06),
    secondColor    = new THREE.Color(0.18, 0.45, 0.08),
    color2Level    = -3.0,
    color2Fade     = -0.1,
    alphaCutoff    = 0.35,
  } = opts;

  return new THREE.ShaderMaterial({
    vertexShader:   LEAVES_VERT,
    fragmentShader: LEAVES_FRAG,
    side:           THREE.DoubleSide,
    transparent:    true,
    depthWrite:     false,
    depthTest:      true,
    uniforms: {
      uDiffuse:       { value: diffuse },
      uTime:          { value: 0 },
      uWindForce:     { value: windForce },
      uWindWavesScale:{ value: windWavesScale },
      uWindSpeed:     { value: windSpeed },
      uAnchorBase:    { value: anchorBase },
      uMainColor:     { value: mainColor },
      uSecondColor:   { value: secondColor },
      uColor2Level:   { value: color2Level },
      uColor2Fade:    { value: color2Fade },
      uAlphaCutoff:   { value: alphaCutoff },
      uLightDir:      { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
      uLightColor:    { value: new THREE.Color(1.0, 0.95, 0.85) },
      uAmbientColor:  { value: new THREE.Color(0.28, 0.38, 0.3) },
    },
  });
}

export function createBushShadowMaterial(leavesDiffuse, leavesMat, alphaCutoff = 0.35) {
  return new THREE.ShaderMaterial({
    vertexShader:   SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    side:           THREE.DoubleSide,
    uniforms: {
      uTime:          { value: 0 },
      uWindForce:     { value: leavesMat.uniforms.uWindForce.value },
      uWindWavesScale:{ value: leavesMat.uniforms.uWindWavesScale.value },
      uWindSpeed:     { value: leavesMat.uniforms.uWindSpeed.value },
      uAnchorBase:    { value: leavesMat.uniforms.uAnchorBase.value },
      map:            { value: leavesDiffuse },
      alphaTest:      { value: alphaCutoff },
    },
  });
}

export function syncBushLighting(leavesMat, scene) {
  scene.traverse((obj) => {
    if (obj.isDirectionalLight) {
      const dir = new THREE.Vector3();
      obj.getWorldDirection(dir);          // points away from light — shader negates it
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