// water.js — Quadtree-chunked Gerstner-wave ocean with slope/height foam.
//
// Drop-in replacement for the old Reflector-based Water class. Same public
// API as before so main.js needs NO changes:
//
//   const water = new Water(scene, renderer, { size, y, color, ... });
//   water.update(dt);          // call every frame
//   water.setSize(w, h);       // call from resize handler
//   water.excludedFromReflection.push(obj);  // no-op now (kept for API compat)
//   water.dispose();
//
// Internally this is a quadtree of small PlaneGeometry chunks (LOD denser
// near the camera, coarser far away / at altitude), each vertex-displaced
// by summed Gerstner waves in the vertex shader, with a foam layer driven
// by wave-convergence (jacobian) + crest height + noise breakup.

import * as THREE from 'three';

const MAX_WAVES = 6;
const NUM_WAVE_SECTORS = 6; // number of angular "edges" around the radial wave field

// ── Deterministic PRNG so the wave spectrum is stable across reloads ──────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Builds an irregular wave spectrum: geometric wavelength cascade + wide
// direction spread + per-wave random phase, so crests don't read as ranked
// parallel ridges. Mirrors the standalone demo's makeWaveSet().
function makeWaveSet(baseDirDeg, seed = 1337) {
  const rad = (d) => (d * Math.PI) / 180;
  const base = rad(baseDirDeg);
  const rnd = mulberry32(seed);

  const waves = [];
  let wavelength = 55; // dominant wavelength — smaller than the open-ocean demo since this is a bounded map-scale lake/sea, not a boundless ocean
  for (let i = 0; i < MAX_WAVES; i++) {
    const falloff = 0.5 + rnd() * 0.35;
    if (i > 0) wavelength *= falloff;
    const wobble = 0.75 + rnd() * 0.5;
    const wavelengthFinal = wavelength * wobble;

    const spreadDeg = 34 + i * 10;
    const dirOffset = rad((rnd() * 2 - 1) * spreadDeg);

    const baseSteepness = 0.3 * Math.pow(0.84, i);
    const steepJitter = 0.5 + rnd() * 1.0;
    const steepness = baseSteepness * steepJitter;

    const speed = 0.65 + rnd() * 0.9;
    const phase = rnd() * Math.PI * 2;

    waves.push({ dir: base + dirOffset, steepness, wavelength: wavelengthFinal, speed, phase });
  }
  return waves;
}

// Randomly selects `activeCount` of the `numSectors` angular sectors to be
// "active" (wave-bearing) — the rest get damped toward flat. Seeded so the
// choice is stable across reloads, same as the wave spectrum itself.
function makeSectorMask(numSectors, activeCount, seed) {
  const rnd = mulberry32(seed);
  const idxs = Array.from({ length: numSectors }, (_, i) => i);
  for (let i = idxs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
  }
  const mask = new Float32Array(numSectors).fill(0);
  const count = Math.max(1, Math.min(numSectors, activeCount));
  for (let i = 0; i < count; i++) mask[idxs[i]] = 1;
  return mask;
}

function packWaves(waveSet, amp, wind) {
  const dir = new Float32Array(MAX_WAVES * 2);
  const params = new Float32Array(MAX_WAVES * 4); // steepness, wavelength, speed, phase
  for (let i = 0; i < MAX_WAVES; i++) {
    const w = waveSet[i];
    dir[i * 2 + 0] = Math.cos(w.dir);
    dir[i * 2 + 1] = Math.sin(w.dir);
    params[i * 4 + 0] = w.steepness * amp;
    params[i * 4 + 1] = w.wavelength / Math.max(wind, 0.05);
    params[i * 4 + 2] = w.speed * wind;
    params[i * 4 + 3] = w.phase;
  }
  return { dir, params };
}

const SECTOR_MASK_GLSL = `
  #define NUM_SECTORS ${NUM_WAVE_SECTORS}
  uniform float uSectorMask[NUM_SECTORS];
  uniform float uSectorBlend;
  uniform float uSectorRotation; // radians, advances over time in JS

  float sectorMaskAt(int i) {
    if (i == 0) return uSectorMask[0];
    if (i == 1) return uSectorMask[1];
    if (i == 2) return uSectorMask[2];
    if (i == 3) return uSectorMask[3];
    if (i == 4) return uSectorMask[4];
    return uSectorMask[5];
  }

  // Splits the plane into NUM_SECTORS angular wedges around the origin
  // (think hexagon edges) and returns a 0..1 factor: 1.0 inside an
  // "active" wedge, blending smoothly toward the neighboring wedge's
  // value near the boundary — so only some edges show waves, with no
  // hard seam.
  float sectorFactor(vec2 posXZ) {
    float ang = atan(posXZ.y, posXZ.x) + 3.14159265359 + uSectorRotation; // 0..2PI, slowly rotating
    ang = mod(ang, 6.28318530718);
    float sectorWidth = 6.28318530718 / float(NUM_SECTORS);
    float raw = ang / sectorWidth;
    int idx = int(mod(raw, float(NUM_SECTORS)));
    int nextIdx = int(mod(float(idx + 1), float(NUM_SECTORS)));
    float frac = fract(raw);

    float m0 = sectorMaskAt(idx);
    float m1 = sectorMaskAt(nextIdx);
    float t = smoothstep(1.0 - clamp(uSectorBlend, 0.001, 0.999), 1.0, frac);
    return mix(m0, m1, t);
  }
`;

const GERSTNER_GLSL = `
  ${SECTOR_MASK_GLSL}

  #define NUM_WAVES ${MAX_WAVES}
  uniform vec2 uWaveDir[NUM_WAVES];
  uniform vec4 uWaveParams[NUM_WAVES];
  uniform float uTime;
  uniform float uWaveVariance;

  float envHash(vec2 p){
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }
  float envNoise(vec2 p){
    vec2 i = floor(p); vec2 f = fract(p);
    float a = envHash(i), b = envHash(i + vec2(1.0,0.0)), c = envHash(i + vec2(0.0,1.0)), d = envHash(i + vec2(1.0,1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }

  float waveEnvelope(vec2 posXZ, int i) {
    float fi = float(i);
    vec2 seedOff = vec2(fi * 41.7, -fi * 67.3);
    float freq = 0.010 + fi * 0.006;
    float drift = 0.02 + fi * 0.014;
    vec2 driftDir = normalize(vec2(0.8 - fi * 0.11, 0.5 + fi * 0.08));
    vec2 p1 = posXZ * freq + seedOff + uTime * drift * driftDir;
    vec2 p2 = posXZ * freq * 0.35 - seedOff * 0.6 - uTime * drift * 0.5 * driftDir;
    float e = envNoise(p1) * 0.65 + envNoise(p2) * 0.35;
    e = smoothstep(0.15, 0.85, e);
    float energy = mix(0.05, 2.6, e);
    return mix(1.0, energy, clamp(uWaveVariance, 0.0, 2.0));
  }

  float waveGust(int i, float seed) {
    float fi = float(i);
    float g1 = sin(uTime * (0.17 + fi * 0.06) + seed * 1.7) * 0.5 + 0.5;
    float g2 = sin(uTime * (0.41 + fi * 0.09) - seed * 0.9) * 0.5 + 0.5;
    float g = g1 * 0.6 + g2 * 0.4;
    return mix(0.35, 1.65, g);
  }

  float phaseWarp(vec2 posXZ, float seed) {
    vec2 p1 = posXZ * 0.0022 + vec2(seed, -seed) + uTime * 0.006;
    vec2 p2 = posXZ * 0.008  + vec2(-seed * 2.0, seed) - uTime * 0.014;
    float n = envNoise(p1) * 0.7 + envNoise(p2) * 0.3;
    return (n - 0.5) * 6.28318530718 * 1.4;
  }

  float chopHeight(vec2 p) {
    vec2 cp1 = p * 0.09  + vec2(uTime * 0.22, -uTime * 0.17);
    vec2 cp2 = p * 0.21  - vec2(-uTime * 0.31, uTime * 0.26);
    vec2 cp3 = p * 0.46  + vec2(uTime * 0.4, uTime * 0.33);
    return (envNoise(cp1) - 0.5) * 1.0 + (envNoise(cp2) - 0.5) * 0.5 + (envNoise(cp3) - 0.5) * 0.25;
  }

  vec3 gerstnerDisplace(vec2 posXZ, out vec3 tangent, out vec3 binormal) {
    vec3 offset = vec3(0.0);
    tangent = vec3(1.0, 0.0, 0.0);
    binormal = vec3(0.0, 0.0, 1.0);

    // Radial-inward direction: every wave points from this vertex back
    // toward the origin (0,0) — the center of the water plane — instead
    // of a fixed wind direction, so crests travel inward toward the
    // center from all sides.
    vec2 toCenter = -posXZ;
    float distToCenter = length(toCenter);
    vec2 dRadial = distToCenter > 0.0001 ? toCenter / distToCenter : vec2(1.0, 0.0);

    // Only some angular "edges" of the radial field are wave-bearing;
    // the rest are damped toward flat by this factor.
    float sFactor = sectorFactor(posXZ);

    for (int i = 0; i < NUM_WAVES; i++) {
      vec2 d = dRadial;
      float steepness = uWaveParams[i].x;
      float wavelength = max(uWaveParams[i].y, 0.001);
      float speed = uWaveParams[i].z;
      float staticPhase = uWaveParams[i].w;

      // Only the dominant first 3 waves pay for the full noise-driven
      // envelope/gust/phase-warp modulation; higher-index waves already
      // have small steepness (falls off ~0.84^i) so a flat multiplier is
      // visually indistinguishable but skips ~half the vertex noise calls.
      float k = 6.28318530718 / wavelength;
      float c = sqrt(9.8 / k) * speed;
      float pw = 0.0;
      if (i < 3) {
        steepness *= waveEnvelope(posXZ, i) * waveGust(i, staticPhase);
        pw = phaseWarp(posXZ, float(i) * 17.31 + 3.7);
      } else {
        steepness *= 0.9; // flat de-emphasis, no noise sampling
      }
      steepness *= sFactor;

      float f = k * dot(d, posXZ) - c * uTime * k + pw + staticPhase;
      float a = steepness / k;

      float sinF = sin(f);
      float cosF = cos(f);

      float pinch = clamp(steepness * 2.2, 0.0, 0.85);
      float sinShaped = sinF + pinch * (sinF * abs(sinF) - sinF) * 0.5;

      offset.x += d.x * a * cosF;
      offset.z += d.y * a * cosF;
      offset.y += a * sinShaped;

      float wa = k * a;
      tangent += vec3(
        -d.x * d.x * wa * sinF,
         d.x * wa * cosF,
        -d.x * d.y * wa * sinF
      );
      binormal += vec3(
        -d.x * d.y * wa * sinF,
         d.y * wa * cosF,
        -d.y * d.y * wa * sinF
      );
    }

    float chopScale = clamp((uWaveParams[0].x + uWaveParams[1].x) * 1.8, 0.0, 1.4);
    float chopAmp = 1.1 * chopScale * sFactor;
    float ce = 0.6;
    float ch0 = chopHeight(posXZ);
    float chX = chopHeight(posXZ + vec2(ce, 0.0));
    float chZ = chopHeight(posXZ + vec2(0.0, ce));
    offset.y += ch0 * chopAmp;
    tangent.y += (chX - ch0) * chopAmp / ce;
    binormal.y += (chZ - ch0) * chopAmp / ce;

    return offset;
  }
`;

const WATER_VERTEX_SHADER = `
  ${GERSTNER_GLSL}

  uniform sampler2D uTerrainHeightMap;
  uniform float uHasTerrainMap;
  uniform float uTerrainWorldSize;
  uniform float uTerrainHeightScale;
  uniform float uTerrainHeightOffset;
  uniform float uWaterLevel;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vJacobian;
  varying float vHeight;
  varying float vShoreDist; // terrainHeight - waterLevel; only meaningful if uHasTerrainMap > 0.5

  float sampleTerrainHeight(vec2 worldXZ) {
    vec2 uv = worldXZ / uTerrainWorldSize + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return -9999.0;
    float raw = texture2D(uTerrainHeightMap, uv).r;
    return raw * uTerrainHeightScale + uTerrainHeightOffset;
  }

  void main(){
    #ifdef USE_INSTANCING
      vec4 localPos = instanceMatrix * vec4(position, 1.0);
    #else
      vec4 localPos = vec4(position, 1.0);
    #endif
    vec4 wp = modelMatrix * localPos;

    // Sample shore distance at the UNDISPLACED xz — cheap, stable, and
    // matches what the fragment shader needs for the foam band.
    float shoreDist = 20000.0; // large positive -> "far from any land" sentinel when no map is bound
    if (uHasTerrainMap > 0.5) {
      float terrainH = sampleTerrainHeight(wp.xz);
      if (terrainH > -9000.0) {
        shoreDist = terrainH - uWaterLevel;
      }
    }
    vShoreDist = shoreDist;

    // Damp wave amplitude approaching/over land so waves settle into the
    // shore instead of slicing through the terrain at full height.
    float ampDamp = 1.0;
    if (uHasTerrainMap > 0.5 && shoreDist < 20000.0) {
      ampDamp = smoothstep(-6.0, 2.0, -shoreDist); // shoreDist>0 (land) -> damp toward 0
      ampDamp = mix(0.08, 1.0, ampDamp);
    }

    vec3 tangent, binormal;
    vec3 disp = gerstnerDisplace(wp.xz, tangent, binormal);
    disp *= ampDamp;
    tangent = mix(vec3(1.0,0.0,0.0), tangent, ampDamp);
    binormal = mix(vec3(0.0,0.0,1.0), binormal, ampDamp);
    // Vertex displacement removed — surface stays perfectly flat at
    // waterY. disp/tangent/binormal are kept only to drive shading
    // (fake normal, vHeight, jacobian foam) below.

    vec3 n = normalize(cross(binormal, tangent));

    float jac = (tangent.x * binormal.z - tangent.z * binormal.x);
    vJacobian = 1.0 - clamp(jac, 0.0, 1.5) / 1.0;

    vWorldPos = wp.xyz;
    vNormal = n;
    vHeight = disp.y;

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const WATER_FRAGMENT_SHADER = `
  ${SECTOR_MASK_GLSL}

  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uSkyHorizonColor;
  uniform vec3 uSkyZenithColor;
  uniform float uReflectionStrength;
  uniform float uReflectionSharpness;
  uniform float uSunGlintStrength;
  uniform vec3 uFoamColor;
  uniform float uFoamAmount;
  uniform vec2 uWaveLineDir;
  uniform float uWaveLineSpeed;
  uniform float uWaveLineFreq;
  uniform float uWaveLineSharpness;
  uniform float uWaveLineAmount;
  uniform vec3 uCameraPos;
  uniform float uTime;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uFoamEnabled;
  uniform float uOpacity;
  uniform float uHasTerrainMap;
  uniform float uShoreFoamWidth;
  uniform sampler2D uTerrainHeightMap;
  uniform float uTerrainWorldSize;
  uniform float uTerrainHeightScale;
  uniform float uTerrainHeightOffset;
  uniform float uWaterLevel;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vJacobian;
  varying float vHeight;
  varying float vShoreDist;

  float hash(vec2 p){
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }
  float fbm(vec2 p){
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 2; i++){
      v += amp * noise(p);
      p *= 2.02;
      amp *= 0.5;
    }
    return v;
  }
      float fbm1(vec2 p){ return noise(p); } // cheap 1-octave version for broad modulators

  // Per-pixel terrain sample for the shoreline band — replaces the old
  // vertex-interpolated vShoreDist, which inherited the water mesh's low
  // chunk resolution and made the foam edge look faceted/low-poly.
  float sampleTerrainHeightF(vec2 worldXZ) {
    vec2 uv = worldXZ / uTerrainWorldSize + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return -9999.0;
    float raw = texture2D(uTerrainHeightMap, uv).r;
    return raw * uTerrainHeightScale + uTerrainHeightOffset;
  }

  vec3 perturbNormal(vec3 N, vec2 worldXZ, float strength) {
    if (strength < 0.02) return N; // far away — skip the 3 noise() calls entirely
    vec2 p = worldXZ * 0.9 + uTime * 0.15;
    float h = noise(p);
    float hx = noise(p + vec2(0.35, 0.0));
    float hz = noise(p + vec2(0.0, 0.35));
    vec3 grad = vec3((h - hx) / 0.35, 1.0, (h - hz) / 0.35);
    return normalize(N + grad * 0.1 * strength);
  }

    // Fake flowing wave-crest lines — pure fragment-shader trick, no vertex
  // displacement needed. Projects world position onto the wind direction
  // to get a 1D coordinate that scrolls with uTime, then draws periodic
  // bands along it with sin/pow. A low-frequency fbm warp bends the bands
  // so they don't read as perfectly straight/artificial ridges.
  float waveLineFoam(vec2 worldXZ, float t) {
    float warp = (fbm1(worldXZ * 0.015 + t * 0.015) - 0.5) * 40.0;
    // Distance from center. Adding (not subtracting) t*speed here makes
    // a ring of constant phase (flow = const) satisfy r = const - t*speed,
    // i.e. its radius shrinks over time — rings collapse inward toward
    // the center instead of expanding outward.
    float flow = length(worldXZ) + warp;
    flow += t * uWaveLineSpeed;

    float band = sin(flow * uWaveLineFreq);
    float lines = pow(max(band, 0.0), uWaveLineSharpness);

    // break the continuous bands into patchy streaks instead of solid
    // parallel ridges across the whole surface
    float breakup = fbm1(worldXZ * 0.08 - t * 0.02);
    lines *= smoothstep(0.25, 0.75, breakup);

    return lines;
  }

  void main(){
    vec3 toCam = uCameraPos - vWorldPos;
    float dist = length(toCam);
    vec3 V = toCam / max(dist, 1e-4);

    // Precompute fog + a detail fade so we can skip expensive noise work
    // on fragments that are far enough to be fogged out anyway.
    float fogFac = clamp(1.0 - exp(-uFogDensity * uFogDensity * dist * dist), 0.0, 1.0);
    float foamDetail = 1.0 - smoothstep(500.0, 1100.0, dist); // tune to your map scale

    vec3 N = normalize(vNormal);
    N = perturbNormal(N, vWorldPos.xz, foamDetail);
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(V + L);

    float NdotL = max(dot(N, L), 0.0);
    float NdotV = max(dot(N, V), 0.05);
    float NdotH = max(dot(N, H), 0.0);

    float fresnel = pow(1.0 - NdotV, uReflectionSharpness);
    fresnel = mix(0.02, 1.0, fresnel) * uReflectionStrength;

    float heightMix = smoothstep(-1.2, 1.6, vHeight);
    vec3 waterColor = mix(uDeepColor, uShallowColor, heightMix * 0.65 + 0.15);

    float wrap = clamp((NdotL + 0.25) / 1.25, 0.0, 1.0);
    waterColor *= (0.35 + 0.9 * wrap);

    float spec = pow(NdotH, 220.0) * 3.2;
    spec += pow(NdotH, 40.0) * 0.4;
    vec3 specColor = uSunColor * spec;

    // ---- Fake planar reflection (no render target, pure ALU) ----
    // Reflect the view ray about the perturbed normal to get a pseudo
    // "reflection vector", then use its vertical component to pick a
    // point on a simple sky gradient — this fakes "closer to horizon
    // -> lighter/hazier, straight up -> deeper sky" the way a mirrored
    // scene would look on a wide open water body, without ever sampling
    // a texture or rendering the scene twice.
    vec3 R = reflect(-V, N);
    float skyT = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 skyReflect = mix(uSkyHorizonColor, uSkyZenithColor, pow(skyT, 0.55));

    // Reflected sun glint: brightens the sky reflection when the
    // reflection vector points back near the sun direction, giving a
    // moving glare patch that tracks camera angle like a real specular
    // reflection of the sun disc would.
    float sunAlign = clamp(dot(R, L), 0.0, 1.0);
    float glint = pow(sunAlign, 120.0) * uSunGlintStrength;
    skyReflect += uSunColor * glint;

    vec3 color = mix(waterColor, skyReflect, fresnel * 0.75);
    color += specColor;

    float foamMask = 0.0;
    if (uFoamEnabled > 0.5 && foamDetail > 0.02) {
      // ── Cheap "wave" look — NO vertex displacement, just scrolling foam.
      // crestFoam/convergeFoam are free: vHeight/vJacobian are already
      // computed every frame in the vertex shader (from gerstnerDisplace,
      // used there only for the fake normal/lighting). waveLineFoam() adds
      // radially-scrolling foam bands (pure fragment math, no extra vertex
      // cost) that collapse toward the water's center over time, which is
      // what actually reads as moving waves on a perfectly flat surface.
      //

      float sFactor = sectorFactor(vWorldPos.xz);
      float crestFoam = smoothstep(0.55, 1.35, vHeight) * uFoamAmount;
      float convergeFoam = smoothstep(0.25, 0.85, vJacobian) * uFoamAmount;
      float waveLines = waveLineFoam(vWorldPos.xz, uTime) * uWaveLineAmount * sFactor;

      foamMask = clamp(waveLines + crestFoam * 0.5 + convergeFoam * 0.35, 0.0, 1.0);

      float n1 = fbm(vWorldPos.xz * 0.14 + uTime * 0.07);
      float n2 = fbm(vWorldPos.xz * 0.4 - uTime * 0.11);
      float n3 = fbm(vWorldPos.xz * 0.9 + uTime * 0.15);
      float texture_ = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;

      foamMask *= smoothstep(0.25, 0.55, texture_ + foamMask * 0.22);
      foamMask = clamp(foamMask, 0.0, 1.0);

      float streak = fbm1(vWorldPos.xz * 0.7 + vec2(0.0, uTime * 0.28));
      foamMask *= mix(0.5, 1.0, streak);

      float foamQty = fbm1(vWorldPos.xz * 0.02 + vec2(uTime * -0.018, uTime * 0.025));
      foamQty = smoothstep(0.28, 0.78, foamQty);
      foamMask *= mix(0.15, 1.15, foamQty);
      foamMask = clamp(foamMask, 0.0, 1.0);

      // ---- SHORELINE SURF BAND ----
      // Sampled per-pixel here instead of using the old vertex-interpolated
      // vShoreDist varying — that inherited the water mesh's chunk
      // resolution and produced a faceted/low-poly foam edge. Sampling the
      // terrain heightmap texture directly follows the real contour.
      float shoreDist = 20000.0; // sentinel: "no terrain data here" -> no foam
      if (uHasTerrainMap > 0.5) {
        float terrainH = sampleTerrainHeightF(vWorldPos.xz);
        if (terrainH > -9000.0) shoreDist = terrainH - uWaterLevel;
      }

      if (uHasTerrainMap > 0.5 && shoreDist < 15000.0) {
        float absShore = abs(shoreDist);
        // Extend the influence range a bit past uShoreFoamWidth purely for
        // the extent falloff, so the outer edge has room to fade smoothly
        // instead of being clipped by the "if" boundary itself.
        float outerLimit = uShoreFoamWidth * 1.6;
        if (absShore < outerLimit) {
          float breathe = sin(uTime * 0.9 - shoreDist * 0.35) * 0.5 + 0.5;

          // ---- 1) SMOOTH EXTENT (no noise here at all) ----
          // This alone decides how far the foam reaches and how it fades
          // into open water — kept perfectly smooth so there's no hard
          // ring where texture noise used to cut it off.
          float extent = 1.0 - smoothstep(uShoreFoamWidth * 0.15, outerLimit, absShore);
          extent = pow(extent, 1.15);

          // ---- 2) TEXTURE (multiplies extent, never fully zeroes it) ----
          // Multiple noise octaves at different scales/speeds for a
          // genuinely clumpy, foamy look instead of a flat white fill.
          float coarse = fbm(vWorldPos.xz * 0.2 + uTime * 0.1);
          float mid    = fbm(vWorldPos.xz * 0.7 - uTime * 0.22);
          float fine1  = fbm(vWorldPos.xz * 1.8 + uTime * 0.4);
          float fine2  = fbm(vWorldPos.xz * 3.6 - uTime * 0.55);

          float texture_ = coarse * 0.35 + mid * 0.3 + fine1 * 0.22 + fine2 * 0.13;
          // Remap into a range that never collapses fully to 0 or 1 — this
          // is what keeps the pattern looking like foam texture rather
          // than binary on/off patches.
          float texMod = mix(0.35, 1.25, texture_);

          float band = extent * texMod * (0.75 + 0.25 * breathe);

          // Waterline core: still boosts right at the shore, but blended
          // additively at low strength so it doesn't create a flat solid
          // disc — texture still shows through near the shoreline too.
          float waterline = 1.0 - smoothstep(0.0, 3.0, absShore);
          band += waterline * texMod * 0.35 * (0.6 + 0.4 * breathe);

          band = clamp(band, 0.0, 1.0);

          foamMask = clamp(max(foamMask, band * uFoamAmount), 0.0, 1.0);
        }
      }
    }

    // Blend the foam color itself toward the surrounding water color
    // first, so the foam never reads as a flat, disconnected white band —
    // it picks up the local water tint (which already varies with depth/
    // fresnel/lighting), and only a fraction stays pure foam-white.
    // Lower foam-color mix (was 0.85) so the water's own color/shading
    // shows through the foam — pure white flattens all the texture we
    // just computed. This alone makes the noise visible instead of a
    // solid white slab.
    vec3 tintedFoam = mix(color, uFoamColor, 0.88);

    // No extra contrast curve on the mask itself (was pow(foamMask,0.75),
    // which pushed mid-range noise values toward full white/full water
    // and killed the graininess). Use the mask as-is.
    color = mix(color, tintedFoam, foamMask);
    color += tintedFoam * foamMask * 0.25;

    // ---- Dissolved / noisy shoreline edge ----
    // The water plane meeting the terrain is a perfectly smooth geometric
    // intersection, which reads as a hard, unnaturally clean curve. This
    // fades the water's alpha near that boundary using noise-warped
    // distance instead of the raw terrain contour, so the edge wobbles
    // and breaks up like an eroded waterline instead of tracing a
    // mathematically perfect curve.
    //
    // Key change: the transition is pushed to sit ENTIRELY on the water
    // side of the actual geometric boundary (edgeDist = 0), and reaches
    // full 0.0 alpha some distance *before* that boundary. That means the
    // literal mesh edge — where the old hard line was — always renders at
    // alpha 0 (nothing there), so the line itself is never visible; the
    // sand shows straight through and the water dissolves in gradually
    // further out.
    float edgeAlpha = 1.0;
    if (uHasTerrainMap > 0.5) {
      float terrainHEdge = sampleTerrainHeightF(vWorldPos.xz);
      if (terrainHEdge > -9000.0) {
        float edgeDist = terrainHEdge - uWaterLevel; // >0 on land, <0 in water
        float edgeBandWidth = max(uShoreFoamWidth * 1.4, 1.0);

        if (edgeDist < edgeBandWidth) {
          float edgeN1 = fbm(vWorldPos.xz * 0.45 + uTime * 0.04);
          float edgeN2 = fbm(vWorldPos.xz * 1.6  - uTime * 0.08);
          float edgeN3 = fbm(vWorldPos.xz * 3.5  + uTime * 0.11);
          float edgeNoise = (edgeN1 * 0.5 + edgeN2 * 0.3 + edgeN3 * 0.2) - 0.5; // -0.5..0.5

          float warpedDist = edgeDist + edgeNoise * edgeBandWidth * 1.3;

          // Transition window shifted fully into the water side:
          // alpha = 0 for warpedDist >= -edgeBandWidth * 0.35 (this
          // safely covers edgeDist = 0, i.e. the actual mesh edge/old
          // hard line, plus a noise-driven buffer beyond it).
          // alpha = 1 once warpedDist <= -edgeBandWidth (well out in
          // open water).
          edgeAlpha = smoothstep(-edgeBandWidth * 0.35, -edgeBandWidth, warpedDist);
        } else {
          edgeAlpha = 0.0; // well inland — fully transparent
        }
      }
    }

    color = mix(color, uFogColor, fogFac); // dist/fogFac already computed above

    gl_FragColor = vec4(color, uOpacity * edgeAlpha);
  }
`;

export class Water {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {Object} [opts]
   * @param {number} [opts.size=1600]        Total world extent of the quadtree root (square)
   * @param {number} [opts.y=8.4]            World-space Y of the water surface (still-water level)
   * @param {number} [opts.color=0x2a6ea6]   (unused directly — kept for API compat; deep/shallow colors derive from it)
   * @param {number} [opts.reflectivity]     (unused now — kept for API compat, no-op)
   * @param {number} [opts.maxReflectionRes] (unused now — kept for API compat, no-op)
   * @param {number} [opts.reflectionInterval] (unused now — kept for API compat, no-op)
   * @param {number} [opts.amplitude=0.55]   Base wave amplitude
   * @param {number} [opts.wind=1.0]         Wind speed multiplier (affects wavelength + phase speed)
   * @param {number} [opts.windDirDeg=32]    Wind direction in degrees
   * @param {number} [opts.foamAmount=1.0]   Foam intensity multiplier
   * @param {number} [opts.opacity=0.92]     Surface alpha
   * @param {THREE.Vector3} [opts.sunDirection] Directional light direction to light the water with (defaults to a fixed up-ish direction)
   */
  constructor(scene, renderer, opts = {}) {
    this.scene = scene;
    this.renderer = renderer;

    this.rootSize = opts.size ?? 1600;
    this.waterY = opts.y ?? 8.4;
    this.chunkSegments = opts.chunkSegments ?? 14; // lower than the open-ocean demo's 18 — bounded map, keep it cheap
    this.maxDepth = opts.maxDepth ?? 4;
    this.splitFactor = opts.splitFactor ?? 1.9;
    this.altitudeLodStep = opts.altitudeLodStep ?? 90;
    this.scrollSpeedMultiplier = opts.scrollSpeed ?? 1.8; // scales uTime advance — speeds up all wave/foam/normal scroll motion together
    this.scrollSpeedMultiplier = opts.scrollSpeed ?? 1.8; // scales how fast uTime advances — speeds up all wave/foam/normal scroll motion uniformly

    // Kept for API compatibility with main.js's water.excludedFromReflection.push(...)
    // calls — harmless no-op now since there's no reflection pass.
    this.excludedFromReflection = opts.excludedFromReflection ?? [];

    const deepColor = new THREE.Color(opts.deepColor ?? 0x02323f);
    const shallowColor = new THREE.Color(
      opts.shallowColor ?? opts.color ?? 0x2a6ea6,
    );

    this.waveSet = makeWaveSet(opts.windDirDeg ?? 32, opts.waveSeed ?? 1337);
    const packed = packWaves(this.waveSet, opts.amplitude ?? 0.55, opts.wind ?? 1.0);

    // ── Continuously animated sector mask ───────────────────────────────
    // Instead of picking active edges once, we keep a "current" (what's
    // actually sent to the shader) and "target" (what we're easing
    // toward) mask. Every uSectorRepickInterval seconds a new random
    // target is chosen and _current eases toward it over
    // uSectorTransitionTime seconds — so edges fade in/out smoothly
    // rather than popping. The whole wedge pattern also slowly rotates
    // (uSectorRotation) so active edges drift in world space too.
    this._sectorRng = mulberry32(opts.sectorSeed ?? (opts.waveSeed ?? 1337) + 777);
    this._sectorActiveCount = opts.activeSectorCount ?? 3;
    this._sectorRepickInterval = opts.sectorRepickInterval ?? 8.0; // seconds between re-picks
    this._sectorTransitionTime = opts.sectorTransitionTime ?? 3.0; // seconds to ease into a new pick
    this._sectorRotationSpeed = opts.sectorRotationSpeed ?? 0.02; // radians/sec, wedge drift

    this._sectorCurrent = new Float32Array(NUM_WAVE_SECTORS).fill(0);
    this._sectorTarget = new Float32Array(NUM_WAVE_SECTORS).fill(0);
    this._sectorTransitionElapsed = 0;
    this._sectorRepickTimer = 0;
    this._sectorRotation = 0;

    const initialActive = opts.activeSectors
      ? opts.activeSectors.filter((i) => i >= 0 && i < NUM_WAVE_SECTORS)
      : this._pickRandomSectorIndices(this._sectorActiveCount);
    for (const i of initialActive) {
      this._sectorCurrent[i] = 1;
      this._sectorTarget[i] = 1;
    }

    this.sectorMask = this._sectorCurrent; // kept for backward-compat naming

    this.uniforms = {
      uTime: { value: 0 },
      uWaveDir: { value: packed.dir },
      uWaveParams: { value: packed.params },
      uWaveVariance: { value: opts.waveVariance ?? 1.0 },
      uSectorMask: { value: this._sectorCurrent },
      uSectorBlend: { value: opts.sectorBlend ?? 0.35 }, // 0 = hard edge, ~1 = fully smooth blend across a whole sector
      uSectorRotation: { value: 0 },
      uSunDir: { value: (opts.sunDirection ?? new THREE.Vector3(0.35, 0.55, -0.6)).clone().normalize() },
      uSunColor: { value: new THREE.Color(0xfff0d6) },
      uDeepColor: { value: deepColor },
      uShallowColor: { value: shallowColor },
      uFoamColor: { value: new THREE.Color(opts.foamColor ?? 0xf3fbfa) },
      uFoamAmount: { value: opts.foamAmount ?? 2.2 },
      uFoamEnabled: { value: 1.0 },
      // ── Fake reflection tuning ──────────────────────────────────────
      uSkyHorizonColor: { value: new THREE.Color(opts.skyHorizonColor ?? 0x8fb8ba) },
      uSkyZenithColor: { value: new THREE.Color(opts.skyZenithColor ?? 0xd8ecec) },
      uReflectionStrength: { value: opts.reflectionStrength ?? 0.85 },
      uReflectionSharpness: { value: opts.reflectionSharpness ?? 5.0 },
      uSunGlintStrength: { value: opts.sunGlintStrength ?? 1.6 },
      // ── Fake flowing wave-line foam (fragment-only, cheap) ──────────
      uWaveLineDir: { value: new THREE.Vector2(Math.cos((opts.windDirDeg ?? 32) * Math.PI / 180), Math.sin((opts.windDirDeg ?? 32) * Math.PI / 180)) },
      uWaveLineSpeed: { value: opts.waveLineSpeed ?? 0.5 },
      uWaveLineFreq: { value: opts.waveLineFreq ?? 0.04 },
      uWaveLineSharpness: { value: opts.waveLineSharpness ?? 4.0 },
      uWaveLineAmount: { value: opts.waveLineAmount ?? 1.1 },
      uOpacity: { value: opts.opacity ?? 0.92 },
      uCameraPos: { value: new THREE.Vector3() },
      uFogColor: { value: scene.fog ? scene.fog.color.clone() : new THREE.Color(0x9fc7c3) },
      uFogDensity: { value: scene.fog?.density ?? 0.0016 },
      // ── Shoreline foam — populated by setTerrainHeightData(), inert
      // (uHasTerrainMap = 0) until that's called.
      uTerrainHeightMap: { value: null },
      uHasTerrainMap: { value: 0.0 },
      uTerrainWorldSize: { value: 1 },
      uTerrainHeightScale: { value: 1 },
      uTerrainHeightOffset: { value: 0 },
      uWaterLevel: { value: this.waterY },
      uShoreFoamWidth: { value: opts.shoreFoamWidth ?? 18.0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: WATER_VERTEX_SHADER,
      fragmentShader: WATER_FRAGMENT_SHADER,
      transparent: true,
      // depthWrite left OFF (default) — water is transparent, so it
      // should still depth-TEST against nearer opaque/transparent
      // geometry (terrain, the plane's canopy glass, etc.) but must
      // never WRITE its own depth. With depthWrite:true, whichever water
      // chunk rasterizes second at a pixel permanently "wins" over
      // anything meant to draw in front of it (e.g. the cockpit canopy),
      // since Three only sorts transparent objects at the object level,
      // not per-fragment — this is what caused the canopy to disappear
      // behind the water at a distance.
      depthTest: true,
    });

    // Shared unit-plane geometry — every chunk mesh scales/translates this
    // same geometry instead of allocating per-chunk geometry.
    this._unitPlaneGeo = new THREE.PlaneGeometry(1, 1, this.chunkSegments, this.chunkSegments);
    this._unitPlaneGeo.rotateX(-Math.PI / 2);

    this.group = new THREE.Group();
    this.group.position.y = this.waterY;
    this.scene.add(this.group);

    // ── Whole-plane bob — cheap: just oscillates the group's Y each frame,
    // no shader/geometry cost at all.
    this.bobEnabled = opts.bobEnabled ?? true;
    this.bobAmplitude = opts.bobAmplitude ?? 0.15; // world units, peak displacement
    this.bobSpeed = opts.bobSpeed ?? 0.35; // radians/sec
    this._bobPhase = Math.random() * Math.PI * 2; // desync from other water instances, if any

    // Backward-compat alias — old code referenced `water.mesh` (e.g. for
    // disposal bookkeeping). Point it at the group so any stray reference
    // doesn't throw; the single InstancedMesh lives inside this group.
    this.mesh = this.group;

    // ── Single-draw-call chunk rendering ────────────────────────────────
    // Previously every LOD chunk was its own THREE.Mesh, so being near/in
    // the water (low altitude -> higher maxDepthAllowed, plus the surface
    // being close -> heavy nearby splitting) could balloon into 100-300+
    // draw calls. An InstancedMesh collapses however many chunks the
    // quadtree produces into ONE draw call, so chunk count stops costing
    // extra CPU overhead.
    this.maxChunks = opts.maxChunks ?? 220;
    this.instancedMesh = new THREE.InstancedMesh(this._unitPlaneGeo, this.material, this.maxChunks);
    this.instancedMesh.frustumCulled = false; // instance count/bounds change every rebuild
    this.instancedMesh.count = 0;
    this.group.add(this.instancedMesh);

    // ── Explicit render order — force the water to draw BEFORE any
    // transparent cockpit/canopy glass on the plane (which typically
    // renders at Three's default renderOrder = 0, or whatever main.js's
    // plane-loading code assigns). A lower renderOrder value draws
    // earlier. Combined with depthWrite:false above, this guarantees the
    // canopy's fragments — drawn afterward — always depth-test correctly
    // against the water instead of occasionally losing an ambiguous
    // transparent sort.
    this.instancedMesh.renderOrder = -1;

    this._instMatrix = new THREE.Matrix4();
    this._instPos = new THREE.Vector3();
    this._instScale = new THREE.Vector3(1, 1, 1);
    this._instQuat = new THREE.Quaternion();

    this._lodEnabled = true;

    this._camGroundPos = new THREE.Vector3();
    this._rebuildAccum = 0;
    this._rebuildInterval = opts.rebuildInterval ?? 0.12; // seconds between quadtree rebuilds

    this._elapsed = 0;

    // Build once immediately so the water isn't invisible for the first frame.
    this._rebuildQuadtree(0, this.waterY + 200, 0);
  }

  _writeInstance(cx, cz, size) {
    if (this._chunksBuilt >= this.maxChunks) return; // hard safety cap
    this._instPos.set(cx, 0, cz);
    this._instScale.set(size, 1, size);
    this._instMatrix.compose(this._instPos, this._instQuat, this._instScale);
    this.instancedMesh.setMatrixAt(this._chunksBuilt, this._instMatrix);
    this._chunksBuilt++;
  }

  _buildNode(cx, cz, size, depth, camX, camZ, maxDepthAllowed) {
    if (this._chunksBuilt >= this.maxChunks) {
      this._writeInstance(cx, cz, size); // budget exhausted — stop splitting
      return;
    }
    const halfDiag = (size * Math.SQRT2) / 2;
    const dx = cx - camX;
    const dz = cz - camZ;
    const dist = Math.sqrt(dx * dx + dz * dz) - halfDiag;

    const splitThreshold = size * this.splitFactor;
    const shouldSplit = this._lodEnabled && depth < maxDepthAllowed && dist < splitThreshold;

    if (shouldSplit) {
      const half = size / 2;
      const q = half / 2;
      this._buildNode(cx - q, cz - q, half, depth + 1, camX, camZ, maxDepthAllowed);
      this._buildNode(cx + q, cz - q, half, depth + 1, camX, camZ, maxDepthAllowed);
      this._buildNode(cx - q, cz + q, half, depth + 1, camX, camZ, maxDepthAllowed);
      this._buildNode(cx + q, cz + q, half, depth + 1, camX, camZ, maxDepthAllowed);
      return;
    }

    this._writeInstance(cx, cz, size);
  }

  _rebuildQuadtree(camX, camY, camZ) {
    this._chunksBuilt = 0;

    const altitude = Math.max(0, camY - this.waterY);
    const maxDepthAllowed = Math.max(
      0,
      this.maxDepth - Math.floor(altitude / this.altitudeLodStep),
    );

    this._buildNode(0, 0, this.rootSize, 0, camX, camZ, maxDepthAllowed);

    this.instancedMesh.count = this._chunksBuilt;
    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Wires up shoreline foam from the SAME raw heightfield TerrainBuilder
   * uses. `heights` must be TerrainBuilder.heights itself: row-major,
   * size*size, values already normalized 0..1 (TerrainBuilder.getHeight()
   * does heights[row*size+col] * heightScale + heightOffset — this mirrors
   * that exact formula on the GPU side, so shoreline foam lines up with
   * the visible terrain mesh).
   *
   * Do NOT pass the Rapier heightfield conversion from
   * buildRapierHeightfield() — that one is column-major and is a
   * different layout entirely.
   *
   * @param {Float32Array} heights   TerrainBuilder.heights (row-major, size*size, 0..1)
   * @param {number} size            TerrainBuilder.size (grid resolution)
   * @param {number} worldSize       TerrainBuilder.worldSize
   * @param {number} heightScale     TerrainBuilder.heightScale
   * @param {number} [heightOffset=0] TerrainBuilder.heightOffset
   */
  setTerrainHeightData(heights, size, worldSize, heightScale, heightOffset = 0) {
    const data = heights instanceof Float32Array ? heights : new Float32Array(heights);

    const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.FloatType);
    tex.needsUpdate = true;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    // TerrainBuilder's row 0 -> world Z = -worldSize/2 (buildMesh uses
    // row*cellSize - half for Z), matching v = z/worldSize + 0.5 increasing
    // with z the same way row increases with z when flipY=false.
    tex.flipY = false;

    if (this._terrainHeightTex) this._terrainHeightTex.dispose();
    this._terrainHeightTex = tex;

    this.uniforms.uTerrainHeightMap.value = tex;
    this.uniforms.uTerrainWorldSize.value = worldSize;
    this.uniforms.uTerrainHeightScale.value = heightScale;
    this.uniforms.uTerrainHeightOffset.value = heightOffset;
    this.uniforms.uHasTerrainMap.value = 1.0;
  }

  /**
   * Advance wave animation and (throttled) rebuild the quadtree LOD around
   * the current camera position. Call once per frame.
   * @param {number} dt
   * @param {THREE.Camera} [camera] Optional — if provided, drives LOD chunking
   *   and camera-relative lighting/fog. Falls back to origin if omitted.
   */
  update(dt, camera) {
    const _dt = dt ?? 1 / 60;
    this._elapsed += _dt * this.scrollSpeedMultiplier;
    this.uniforms.uTime.value = this._elapsed;

    this._stepSectorAnimation(_dt);

    let camX = 0, camY = this.waterY + 200, camZ = 0;
    if (camera) {
      camX = camera.position.x;
      camY = camera.position.y;
      camZ = camera.position.z;
      this.uniforms.uCameraPos.value.copy(camera.position);
    }

    // Keep fog uniforms in sync in case scene.fog color/density changes at
    // runtime (e.g. weather/time-of-day systems elsewhere in main.js).
    if (this.scene.fog) {
      this.uniforms.uFogColor.value.copy(this.scene.fog.color);
      if (typeof this.scene.fog.density === 'number') {
        this.uniforms.uFogDensity.value = this.scene.fog.density;
      }
    }
        // Keep the fake reflection's horizon tone loosely coupled to fog color
    // so time-of-day/weather changes elsewhere in main.js are reflected
    // (pun intended) in the water without extra render passes.
    if (this.scene.fog && this._syncReflectionToFog !== false) {
      this.uniforms.uSkyHorizonColor.value.lerp(this.scene.fog.color, 0.05);
    }

    // ── Whole-plane bob ────────────────────────────────────────────────
    if (this.bobEnabled) {
      this._bobPhase += _dt * this.bobSpeed;
      const bobOffset = Math.sin(this._bobPhase) * this.bobAmplitude;
      this.group.position.y = this.waterY + bobOffset;

      // Optional: keep the shoreline foam threshold perfectly in sync with
      // the visually-moved surface. Skippable for a very small amplitude —
      // the mismatch is imperceptible below ~0.2 units — but cheap to keep
      // exact since it's just one more uniform write.
      this.uniforms.uWaterLevel.value = this.waterY + bobOffset;
    }

    this._rebuildAccum += _dt;
    if (this._rebuildAccum >= this._rebuildInterval) {
      this._rebuildAccum = 0;
      if (window.__waterDebug) {
        console.log('water chunks:', this._poolCursor,
          'tris/chunk:', this.chunkSegments * this.chunkSegments * 2,
          'total tris:', this._poolCursor * this.chunkSegments * this.chunkSegments * 2);
      }
      // Rebuild around the camera's ground-projected XZ, using the actual
      // world-space camera position (not water-local), since chunk
      // positions inside the group are local coords under this.group at
      // waterY — camX/camZ are XZ-only so the group's Y offset doesn't matter.
      this._rebuildQuadtree(camX, camY, camZ);
    }
  }

  /** Toggle foam layer on/off at runtime. */
  setFoamEnabled(on) {
    this.uniforms.uFoamEnabled.value = on ? 1.0 : 0.0;
  }

    /** Re-pick which angular sectors show waves. Pass an explicit array of
   * sector indices (0..NUM_WAVE_SECTORS-1) to activate them exactly, or a
   * number to randomly pick that many (optionally with a seed for repeatable
   * results). */
  setActiveSectors(indicesOrCount, seed) {
    const NUM = this.uniforms.uSectorMask.value.length;
    const mask = new Float32Array(NUM).fill(0);
    if (Array.isArray(indicesOrCount)) {
      for (const i of indicesOrCount) if (i >= 0 && i < NUM) mask[i] = 1;
    } else {
      const picked = makeSectorMask(NUM, indicesOrCount ?? 3, seed ?? Math.floor(Math.random() * 1e9));
      picked.forEach((v, i) => (mask[i] = v));
    }
    this.sectorMask = mask;
    this.uniforms.uSectorMask.value = mask;
  }

    /** Returns `count` distinct random sector indices (0..NUM_WAVE_SECTORS-1)
   * using this instance's running seeded RNG (so successive calls keep
   * advancing the same sequence rather than repeating). */
  _pickRandomSectorIndices(count) {
    const NUM = this._sectorCurrent.length;
    const idxs = Array.from({ length: NUM }, (_, i) => i);
    for (let i = idxs.length - 1; i > 0; i--) {
      const j = Math.floor(this._sectorRng() * (i + 1));
      [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
    }
    return idxs.slice(0, Math.max(1, Math.min(NUM, count)));
  }

  /** Advances the sector animation: rotates the wedge pattern, and every
   * `_sectorRepickInterval` seconds re-rolls which sectors are active,
   * easing the mask toward the new pick over `_sectorTransitionTime`
   * seconds. Called once per frame from update(). */
  _stepSectorAnimation(dt) {
    // Rotate the wedge pattern continuously.
    this._sectorRotation += dt * this._sectorRotationSpeed;
    this.uniforms.uSectorRotation.value = this._sectorRotation;

    // Time to pick a new target subset of active sectors?
    this._sectorRepickTimer += dt;
    if (this._sectorRepickTimer >= this._sectorRepickInterval) {
      this._sectorRepickTimer = 0;
      this._sectorTransitionElapsed = 0;
      this._sectorPrevSnapshot = this._sectorCurrent.slice(); // Float32Array.slice() copies
      this._sectorTarget.fill(0);
      for (const i of this._pickRandomSectorIndices(this._sectorActiveCount)) {
        this._sectorTarget[i] = 1;
      }
    }

    // Ease _sectorCurrent toward _sectorTarget over _sectorTransitionTime.
    if (this._sectorTransitionElapsed < this._sectorTransitionTime) {
      this._sectorTransitionElapsed += dt;
      const t = Math.min(1, this._sectorTransitionElapsed / this._sectorTransitionTime);
      const eased = t * t * (3 - 2 * t); // smoothstep easing
      for (let i = 0; i < this._sectorCurrent.length; i++) {
        const start = this._sectorPrevSnapshot ? this._sectorPrevSnapshot[i] : this._sectorCurrent[i];
        this._sectorCurrent[i] = start + (this._sectorTarget[i] - start) * eased;
      }
    }

    this.uniforms.uSectorMask.value = this._sectorCurrent;
  }

  /** Adjust wave amplitude/wind/direction at runtime (re-packs the spectrum). */
  setWaveParams({ amplitude, wind, windDirDeg } = {}) {
    if (windDirDeg !== undefined) {
      this.waveSet = makeWaveSet(windDirDeg, 1337);
    }
    const packed = packWaves(
      this.waveSet,
      amplitude ?? this._lastAmplitude ?? 0.55,
      wind ?? this._lastWind ?? 1.0,
    );
    this._lastAmplitude = amplitude ?? this._lastAmplitude;
    this._lastWind = wind ?? this._lastWind;
    this.uniforms.uWaveDir.value = packed.dir;
    this.uniforms.uWaveParams.value = packed.params;
  }

  /** No-op — kept for API compatibility with the old Reflector-based Water,
   * whose setSize() resized the reflection render target. There's no
   * render-target here anymore, so this is intentionally empty. */
  setSize(_width, _height) {}

  /** Remove from scene and free GPU resources. */
  dispose() {
    this.scene.remove(this.group);
    this._unitPlaneGeo.dispose();
    this.material.dispose();
    if (this._terrainHeightTex) {
      this._terrainHeightTex.dispose();
      this._terrainHeightTex = null;
    }
  }
}