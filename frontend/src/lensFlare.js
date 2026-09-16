// lensFlare.js — Reusable optimized lens-flare system (Three.js, module export)
// Extracted from the standalone demo. Attach it to any light/sun position by
// passing a shared THREE.Vector3 (e.g. your directional light's `.position`)
// as `lensPosition` — since it's passed by reference, moving the light moves
// the flare automatically, no extra sync code needed.

import * as THREE from 'three';

const FLARE_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}`;

function buildFullFragmentShader(flags) {
  const defines = [];
  if (flags.anamorphic) defines.push('#define ANAMORPHIC');
  if (flags.secondaryGhosts) defines.push('#define SECONDARY_GHOSTS');
  const D = defines.join('\n');

  return `
${D}

uniform float iTime;
uniform vec2 lensPosition;
uniform vec2 iResolution;
uniform vec3 colorGain;
uniform float starPoints;
uniform float glareSize;
uniform float flareSize;
uniform float flareSpeed;
uniform float flareShape;
uniform float haloScale;
uniform float opacity;
uniform float ghostScale;
uniform bool enabled;
varying vec2 vUv;

const float uDispersal = 0.3;
const float uHaloWidth = 0.6;
const float uDistortion = 1.5;
vec2 vTexCoord;

float rand(float n){ return fract(sin(n) * 43758.5453123); }
float noise(float p){
  float fl = floor(p);
  float fc = fract(p);
  return mix(rand(fl), rand(fl + 1.0), fc);
}
vec3 hsv2rgb(vec3 c){
  vec4 k = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + k.xyz) * 6.0 - k.www);
  return c.z * mix(k.xxx, clamp(p - k.xxx, 0.0, 1.0), c.y);
}
float saturate2(float x){ return clamp(x, 0.0, 1.0); }
vec2 rotateUV(vec2 uv, float rotation){
  return vec2(cos(rotation)*uv.x + sin(rotation)*uv.y, cos(rotation)*uv.y - sin(rotation)*uv.x);
}

vec3 drawflare(vec2 p, float intensity, float rnd, float speed, int id){
  float flarehueoffset = (1.0/32.0) * float(id) * 0.1;
  float lingrad = distance(vec2(0.0), p);
  float expgrad = 1.0 / exp(lingrad * (fract(rnd) * 0.66 + 0.33));
  vec3 colgrad = hsv2rgb(vec3(fract((expgrad*8.0) + speed*flareSpeed + flarehueoffset), pow(1.0-abs(expgrad*2.0-1.0), 0.45), 20.0*expgrad*intensity));

  #ifdef ANAMORPHIC
  float internalStarPoints = 1.0;
  #else
  float internalStarPoints = starPoints;
  #endif

  float blades = length(p * flareShape * sin(internalStarPoints * atan(p.x, p.y)));
  #ifdef ANAMORPHIC
  float comp = pow(1.0 - saturate2(blades), 100.0);
  #else
  float comp = pow(1.0 - saturate2(blades), 12.0);
  #endif
  comp += saturate2(expgrad - 0.9) * 3.0;
  comp = pow(comp * expgrad, 8.0 + (1.0 - intensity) * 5.0);

  if (flareSpeed > 0.0) return vec3(comp) * colgrad;
  return vec3(comp) * flareSize * 15.0;
}

float glareFn(vec2 uv, vec2 pos, float size){
  vec2 main = uv - pos;
  #ifdef ANAMORPHIC
  float ang = atan(main.y, main.x);
  #else
  float ang = atan(main.y, main.x) * starPoints;
  #endif
  float f0 = 1.0 / (length(uv - pos) * (1.0/size*16.0) + 0.2);
  return f0 + f0 * (sin(ang) * 0.2 + 0.3);
}

#ifdef SECONDARY_GHOSTS
float sdHex(vec2 p){
  p = abs(p);
  vec2 q = vec2(p.x*2.0*0.5773503, p.y + p.x*0.5773503);
  return dot(step(q.xy,q.yx), 1.0 - q.yx);
}
float fpow(float x, float k){ return x > k ? pow((x-k)/(1.0-k), 2.0) : 0.0; }
vec3 renderhex(vec2 uv, vec2 p, float s, vec3 col){
  uv -= p;
  if (abs(uv.x) < 0.2*s && abs(uv.y) < 0.2*s){
    return mix(vec3(0.0), mix(vec3(0.0), col, 0.1 + fpow(length(uv/s), 0.1)*10.0), smoothstep(0.0, 0.1, sdHex(uv*20.0/s)));
  }
  return vec3(0.0);
}
#endif

vec3 LensFlare(vec2 uv, vec2 pos){
  vec2 main = uv - pos;
  vec2 uvd = uv * length(uv);
  float ang = atan(main.x, main.y);
  float f0 = 0.3/(length(uv-pos)*16.0+1.0) * (sin(noise(sin(ang*3.9) * starPoints)) * 0.2);

  float f1 = max(0.01 - pow(length(uv+1.2*pos), 1.9), 0.0) * 7.0;
  float f2 = max(0.9/(10.0+32.0*pow(length(uvd+0.99*pos),2.0)), 0.0)*0.35;
  float f22 = max(0.9/(11.0+32.0*pow(length(uvd+0.85*pos),2.0)), 0.0)*0.23;
  float f23 = max(0.9/(12.0+32.0*pow(length(uvd+0.95*pos),2.0)), 0.0)*0.6;

  vec2 uvx = mix(uv, uvd, 0.1);
  float f4 = max(0.01 - pow(length(uvx+0.4*pos),2.9), 0.0)*4.02;
  float f42 = max(0.0 - pow(length(uvx+0.45*pos),2.9), 0.0)*4.1;
  float f43 = max(0.01 - pow(length(uvx+0.5*pos),2.9), 0.0)*4.6;

  uvx = mix(uv, uvd, -0.4);
  float f5 = max(0.01 - pow(length(uvx+0.1*pos),5.5), 0.0)*2.0;
  float f52 = max(0.01 - pow(length(uvx+0.2*pos),5.5), 0.0)*2.0;
  float f53 = max(0.01 - pow(length(uvx+0.1*pos),5.5), 0.0)*2.0;

  uvx = mix(uv, uvd, 2.1);
  float f6 = max(0.01 - pow(length(uvx-0.3*pos),1.61), 0.0)*3.159;
  float f62 = max(0.01 - pow(length(uvx-0.325*pos),1.614), 0.0)*3.14;
  float f63 = max(0.01 - pow(length(uvx-0.389*pos),1.623), 0.0)*3.12;

  vec3 c = vec3(glareFn(uv, pos, glareSize));

  vec2 prot;
  #ifdef ANAMORPHIC
  prot = rotateUV(uv - pos, 1.570796);
  #else
  prot = uv - pos;
  #endif

  #ifdef ANAMORPHIC
  c += drawflare(prot, flareSize * 10.0, 0.1, 0.0, 1);
  #else
  c += drawflare(prot, flareSize, 0.1, 0.0, 1);
  #endif

  c.r += f1+f2+f4+f5+f6; c.g += f1+f22+f42+f52+f62; c.b += f1+f23+f43+f53+f63;
  c = c * 1.3 * vec3(length(uvd) + 0.09);
  c += vec3(f0);
  return c;
}

void main(){
  if (!enabled) discard;

  vec2 uv = vUv;
  vec2 myUV = uv - 0.5;
  myUV.y *= iResolution.y / iResolution.x;
  vec2 mouse = lensPosition * 0.5;
  mouse.y *= iResolution.y / iResolution.x;

  vec3 finalColor = LensFlare(myUV, mouse) * 20.0 * colorGain / 2.0;

  #ifdef SECONDARY_GHOSTS
  vec3 altGhosts = vec3(0.1);
  altGhosts += renderhex(myUV, -lensPosition*0.25, ghostScale*1.4, vec3(0.03)*colorGain);
  altGhosts += renderhex(myUV, lensPosition*0.25, ghostScale*0.5, vec3(0.03)*colorGain);
  altGhosts += renderhex(myUV, lensPosition*1.25, ghostScale*0.8, vec3(0.03)*colorGain);
  altGhosts += renderhex(myUV, -lensPosition*1.25, ghostScale*5.0, vec3(0.03)*colorGain);
  altGhosts += fpow(1.0 - abs(distance(lensPosition*0.8, myUV) - 0.5), 0.985) * vec3(0.1);
  altGhosts += fpow(1.0 - abs(distance(lensPosition*0.4, myUV) - 0.2), 0.994) * vec3(0.05);
  finalColor += altGhosts;
  #endif

  gl_FragColor = vec4(finalColor, clamp(dot(finalColor, vec3(0.333)), 0.0, 1.0) * opacity);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}

export function OptimizedLensFlare(options = {}, oldOpacityRef) {
  const params = {
    enabled: options.enabled ?? true,
    lensPosition: options.lensPosition ?? new THREE.Vector3(25, 2, -40),
    colorGain: options.colorGain ?? new THREE.Color(1.5, 1.0, 1.0),
    starPoints: options.starPoints ?? 5.0,
    glareSize: options.glareSize ?? 0.55,
    flareSize: options.flareSize ?? 0.004,
    flareSpeed: options.flareSpeed ?? 0.4,
    flareShape: options.flareShape ?? 1.2,
    haloScale: options.haloScale ?? 0.5,
    anamorphic: options.anamorphic ?? false,
    secondaryGhosts: options.secondaryGhosts ?? true,
    ghostScale: options.ghostScale ?? 0.3,
    raycastEveryNFrames: options.raycastEveryNFrames ?? 4,
    occluders: options.occluders ?? [],
    // ── Reference FOV the flare's glareSize/flareSize were tuned at. The
    // flare quad is drawn in constant screen-space UV, so without FOV
    // compensation it never changes absolute size while the rest of the
    // scene magnifies/shrinks with zoom — making it LOOK smaller when you
    // zoom in and bigger when you zoom out. See update() below.
    baseFov: options.baseFov ?? 55
  };

  const clock = new THREE.Clock();
  const raycaster = new THREE.Raycaster();
  const flarePosition = new THREE.Vector3();
  const ndcPos = new THREE.Vector2();
  let frameCount = 0;
  let internalOpacity = oldOpacityRef.value;

  const uniforms = {
    iResolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
    lensPosition: { value: new THREE.Vector2(0, 0) },
    enabled: { value: params.enabled },
    colorGain: { value: params.colorGain },
    starPoints: { value: params.starPoints },
    glareSize: { value: params.glareSize },
    flareSize: { value: params.flareSize },
    flareSpeed: { value: params.flareSpeed },
    flareShape: { value: params.flareShape },
    haloScale: { value: params.haloScale },
    opacity: { value: internalOpacity },
    ghostScale: { value: params.ghostScale }
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FLARE_VERTEX,
    fragmentShader: buildFullFragmentShader(params),
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    name: 'OptimizedLensFlareShader'
  });

  function recompile() {
    material.fragmentShader = buildFullFragmentShader(params);
    material.needsUpdate = true;
  }

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  // Draws after opaque + water, but BELOW anything passed a lower renderOrder
  // via options (e.g. the flight-cloud layer) so those visually cover the
  // flare instead of the flare always winning purely on draw order, since
  // depthTest is disabled and can't resolve this via real depth.
  mesh.renderOrder = options.renderOrder ?? 999;

  const viewport = new THREE.Vector4();

  // Visibility/projection check — call this every frame from your main loop,
  // unconditionally, regardless of the mesh's current visible state. (Doing
  // this inside onBeforeRender is a trap: Three.js stops calling
  // onBeforeRender once a mesh is invisible, so it can never turn itself
  // back on.)
  function update(camera) {
    const projected = params.lensPosition.clone().project(camera);
    flarePosition.copy(projected);

    // ── FOV-compensated flare size — counteracts the flare's fixed
    // screen-space size so it visually scales with zoom the way real
    // lens flares (and the rest of the scene) do. FOV < baseFov (zoomed
    // in) → fovScale > 1 → flare grows. FOV > baseFov (zoomed out) →
    // fovScale < 1 → flare shrinks.
    const fovScale =
      Math.tan(THREE.MathUtils.degToRad(params.baseFov) / 2) /
      Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    uniforms.glareSize.value = params.glareSize * fovScale;
    uniforms.flareSize.value = params.flareSize * fovScale;

    const offScreen =
      flarePosition.z >= 1 ||
      Math.abs(flarePosition.x) > 1.6 ||
      Math.abs(flarePosition.y) > 1.6;

    mesh.visible = !offScreen;
    if (offScreen) return;

    uniforms.lensPosition.value.set(flarePosition.x, flarePosition.y);
    ndcPos.set(flarePosition.x, flarePosition.y);

    frameCount++;
    if (frameCount % params.raycastEveryNFrames === 0 && params.occluders.length) {
      raycaster.setFromCamera(ndcPos, camera);
      // recursive: true — house occluders are Group roots (gltf.scene) whose
      // actual mesh geometry lives on child nodes, not the root itself.
      // terrainMesh (a real Mesh) still raycasts correctly with this on.
      const hits = raycaster.intersectObjects(params.occluders, true);
      internalOpacity = hits.length ? 0 : oldOpacityRef.value;
    } else if (!params.occluders.length) {
      internalOpacity = oldOpacityRef.value;
    }
  }

  material.onBeforeRender = function (renderer) {
    const dt = clock.getDelta();

    renderer.getCurrentViewport(viewport);
    uniforms.iResolution.value.set(viewport.z, viewport.w);

    uniforms.opacity.value += (internalOpacity - uniforms.opacity.value) * Math.min(1, dt * 6);
  };

  return {
    mesh,
    material,
    uniforms,
    params,
    update,
    setFeature(name, value) {
      params[name] = value;
      recompile();
    },
    dispose() {
      material.dispose();
      mesh.geometry.dispose();
    }
  };
}