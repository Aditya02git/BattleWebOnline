// ═══════════════════════════════════════════════════════════════════════════
// SHARED GLSL CHUNKS
// ═══════════════════════════════════════════════════════════════════════════

export const SIMPLEX_NOISE_GLSL = /* glsl */`
vec3 _mod289(vec3 x){ return x - floor(x*(1./289.))*289.; }
vec4 _mod289(vec4 x){ return x - floor(x*(1./289.))*289.; }
vec4 _permute(vec4 x){ return _mod289((x*34.+1.)*x); }
vec4 _taylorInvSqrt(vec4 r){ return 1.79284291400159 - r*0.85373472095314; }

float snoise(vec3 v){
  const vec2 C = vec2(1./6., 1./3.);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - 0.5;
  i = _mod289(i);
  vec4 p = _permute(_permute(_permute(
    i.z + vec4(0.,i1.z,i2.z,1.))
    + i.y + vec4(0.,i1.y,i2.y,1.))
    + i.x + vec4(0.,i1.x,i2.x,1.));
  vec4 j  = p - 49.*floor(p*(1./49.));
  vec4 x_ = floor(j*(1./7.));
  vec4 y_ = floor(j - 7.*x_);
  vec4 x  = (x_*2.+.5)/7.-1.;
  vec4 y  = (y_*2.+.5)/7.-1.;
  vec4 h  = 1.-abs(x)-abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.+1.;
  vec4 s1 = floor(b1)*2.+1.;
  vec4 sh = -step(h, vec4(0.));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 g0 = vec3(a0.xy, h.x);
  vec3 g1 = vec3(a0.zw, h.y);
  vec3 g2 = vec3(a1.xy, h.z);
  vec3 g3 = vec3(a1.zw, h.w);
  vec4 norm = _taylorInvSqrt(vec4(dot(g0,g0),dot(g1,g1),dot(g2,g2),dot(g3,g3)));
  g0*=norm.x; g1*=norm.y; g2*=norm.z; g3*=norm.w;
  vec4 m = max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
  m=m*m; m=m*m;
  return 42.*dot(m,vec4(dot(x0,g0),dot(x1,g1),dot(x2,g2),dot(x3,g3)));
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// GRASS IMPACT GLSL — shared by GRASS_VERT + GRASS_SHADOW_VERT.
// Bends/crushes grass blades near recent bullet-impact points, driven
// entirely by a small uniform array — no extra geometry, no CPU cost
// beyond writing ~8 floats into a buffer when a shot lands.
// NOTE: assumes `uniform float uTime;` is already declared in the shader
// that includes this chunk (both GRASS_VERT and GRASS_SHADOW_VERT already
// declare it) — do not redeclare it here or GLSL will fail to compile.
// ═══════════════════════════════════════════════════════════════════════════
export const GRASS_IMPACT_GLSL = /* glsl */`
#define MAX_GRASS_IMPACTS 8

uniform vec4  uImpactData[MAX_GRASS_IMPACTS]; // xy = world x,z ; z = startTime ; w unused
uniform int   uImpactCount;
uniform float uImpactRadius;
uniform float uImpactStrength;
uniform float uImpactDuration;
uniform float uImpactDecay;

// worldXZY: this blade instance's world position (xz used for distance).
// heightMask: 0..1, how much of the blade's height should react (tip vs base).
// impactAmt (out): strongest active envelope this vertex is under — feed to
// the fragment shader to darken/crush the color, purely cosmetic.
vec3 grassImpactOffset(vec3 worldXZY, float heightMask, out float impactAmt) {
  vec3  offset = vec3(0.0);
  impactAmt    = 0.0;

  for (int i = 0; i < MAX_GRASS_IMPACTS; i++) {
    if (i >= uImpactCount) break;

    vec2  center  = uImpactData[i].xy;
    float start   = uImpactData[i].z;
    float elapsed = uTime - start;
    if (elapsed < 0.0 || elapsed > uImpactDuration) continue;

    vec2  toBlade = worldXZY.xz - center;
    float dist    = length(toBlade);
    float falloff = 1.0 - smoothstep(0.0, uImpactRadius, dist);
    if (falloff <= 0.0) continue;

    float envelope = falloff * exp(-elapsed * uImpactDecay) * uImpactStrength;
    vec2  dir      = dist > 0.0001 ? toBlade / dist : vec2(0.0);

    offset.xz  += dir * envelope * heightMask;   // push outward from the impact
    offset.y   -= envelope * heightMask * 0.6;   // crush the blade down
    impactAmt   = max(impactAmt, envelope);
  }

  return offset;
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// BRANCH VERTEX SHADER
// ═══════════════════════════════════════════════════════════════════════════

export const BRANCH_VERT = /* glsl */`
${SIMPLEX_NOISE_GLSL}

uniform float uTime;
uniform float uWindForce;
uniform float uWindWavesScale;
uniform float uWindSpeed;
uniform bool  uAnchorBase;

varying vec2  vUv;
varying vec3  vWorldPos;
varying vec3  vWorldNormal;
varying float vObjectY;
varying vec3  vViewDir;

void main(){
  vUv = uv;

  #ifdef USE_INSTANCING
    vec4 localPos = instanceMatrix * vec4(position, 1.0);
  #else
    vec4 localPos = vec4(position, 1.0);
  #endif

  vec4 worldPos4 = modelMatrix * localPos;
  vWorldPos      = worldPos4.xyz;

  #ifdef USE_INSTANCING
    vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  #else
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
  #endif

  vObjectY = localPos.y;

  float t        = uTime * (uWindSpeed * 5.0);
  float noise    = snoise((localPos.xyz + t) * uWindWavesScale);
  float windDisp = noise;

  if(uAnchorBase){
    windDisp *= pow(uv.y, 2.0);
  }
  windDisp *= uWindForce * 30.0;

  vec3 displaced = localPos.xyz + vec3(windDisp, windDisp * 0.3, windDisp);
  vec4 mvPos     = modelViewMatrix * vec4(displaced, 1.0);
  vViewDir       = normalize(-mvPos.xyz);

  gl_Position = projectionMatrix * mvPos;
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// BRANCH FRAGMENT SHADER
// Fir-specific: deeper, cooler greens; stronger translucency for needles
// ═══════════════════════════════════════════════════════════════════════════

export const BRANCH_FRAG = /* glsl */`
precision highp float;

uniform sampler2D uDiffuse;
uniform vec3  uMainColor;
uniform vec3  uSecondColor;
uniform float uColor2Level;
uniform float uColor2Fade;
uniform float uAlphaCutoff;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbientColor;

varying vec2  vUv;
varying float vObjectY;
varying vec3  vWorldNormal;

void main(){
  vec4 tex = texture2D(uDiffuse, vUv);
  if(tex.a < uAlphaCutoff) discard;

  float t2    = clamp((vObjectY + uColor2Level) * (uColor2Fade * 2.0), 0.0, 1.0);
  vec3 albedo = mix(uMainColor, uSecondColor, t2) * tex.rgb;

  vec3  N     = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float diff  = max(dot(N, -normalize(uLightDir)), 0.0);
  vec3  color = albedo * (uAmbientColor + uLightColor * diff);

  gl_FragColor = vec4(pow(max(color, vec3(0.0)), vec3(1.0/2.2)), 1.0);
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// LEAVES VERTEX SHADER
// ═══════════════════════════════════════════════════════════════════════════

export const LEAVES_VERT = /* glsl */`
${SIMPLEX_NOISE_GLSL}

uniform float uTime;
uniform float uWindForce;
uniform float uWindWavesScale;
uniform float uWindSpeed;
uniform bool  uAnchorBase;

varying vec2  vUv;
varying vec3  vWorldPos;
varying vec3  vWorldNormal;
varying float vObjectY;
varying vec3  vViewDir;

void main(){
  vUv = uv;

  #ifdef USE_INSTANCING
    vec4 localPos  = instanceMatrix * vec4(position, 1.0);
  #else
    vec4 localPos  = vec4(position, 1.0);
  #endif

  vec4 worldPos4 = modelMatrix * localPos;
  vWorldPos      = worldPos4.xyz;

  #ifdef USE_INSTANCING
    vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  #else
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
  #endif

  vObjectY = localPos.y;

  float t        = uTime * (uWindSpeed * 5.0);
  float noise    = snoise((localPos.xyz + t) * uWindWavesScale);
  float windDisp = noise;

  if(uAnchorBase){
    windDisp *= pow(uv.y, 2.0);
  }
  windDisp *= uWindForce * 30.0;

  vec3 displaced = localPos.xyz + vec3(windDisp, windDisp * 0.3, windDisp);
  vec4 mvPos     = modelViewMatrix * vec4(displaced, 1.0);
  vViewDir       = normalize(-mvPos.xyz);

  gl_Position = projectionMatrix * mvPos;
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// LEAVES FRAGMENT SHADER
// ═══════════════════════════════════════════════════════════════════════════

export const LEAVES_FRAG = /* glsl */`
precision highp float;

uniform sampler2D uDiffuse;
uniform vec3  uMainColor;
uniform vec3  uSecondColor;
uniform float uColor2Level;
uniform float uColor2Fade;
uniform float uAlphaCutoff;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbientColor;

varying vec2  vUv;
varying float vObjectY;
varying vec3  vWorldNormal;

void main(){
  vec4 tex = texture2D(uDiffuse, vUv);
  if(tex.a < 0.01) discard; // ← CHANGED: only clip fully-transparent texels, real fade comes from blending now

  float t2    = clamp((vObjectY + uColor2Level) * (uColor2Fade * 2.0), 0.0, 1.0);
  vec3 albedo = mix(uMainColor, uSecondColor, t2) * tex.rgb;

  vec3  N      = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float NdotL  = dot(N, -normalize(uLightDir));
  float diff   = abs(NdotL) * 0.6 + 0.4;
  vec3  color  = albedo * (uAmbientColor + uLightColor * diff);

  gl_FragColor = vec4(pow(max(color, vec3(0.0)), vec3(1.0/2.2)), tex.a); // ← CHANGED: pass real alpha instead of 1.0
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// MERGED VERTEX SHADER — bark/trunk + leaves/branch in one draw call.
// Identical wind math to BRANCH_VERT/LEAVES_VERT, gated by:
//   aIsLeaf       (per-vertex:   0 = bark/trunk, 1 = leaf/branch)
//   aWindStrength (per-instance: 0 = far/static, 1 = near/animated)
// ═══════════════════════════════════════════════════════════════════════════

export const MERGED_VERT = /* glsl */`
${SIMPLEX_NOISE_GLSL}

uniform float uTime;
uniform float uWindForce;
uniform float uWindWavesScale;
uniform float uWindSpeed;
uniform bool  uAnchorBase;

attribute float aIsLeaf;
attribute float aWindStrength;
attribute float aHeightT;

varying vec2  vUv;
varying vec3  vWorldPos;
varying vec3  vWorldNormal;
varying float vObjectY;
varying vec3  vViewDir;
varying float vIsLeaf;
varying float vFogDepth;

void main(){
  vUv    = uv;
  vIsLeaf = aIsLeaf;

  #ifdef USE_INSTANCING
    vec4 localPos = instanceMatrix * vec4(position, 1.0);
  #else
    vec4 localPos = vec4(position, 1.0);
  #endif

  vec4 worldPos4 = modelMatrix * localPos;
  vWorldPos      = worldPos4.xyz;

  #ifdef USE_INSTANCING
    vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  #else
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
  #endif

  vObjectY = localPos.y;

  float t        = uTime * (uWindSpeed * 5.0);
  float noise    = snoise((localPos.xyz + t) * uWindWavesScale);
  float windDisp = noise;

  if(uAnchorBase){
    windDisp *= pow(uv.y, 2.0);
  }
  windDisp *= uWindForce * 30.0;

  // Sway ramps in across the top 70% of the tree (bottom 30% stays anchored),
  // for both bark and leaves. One smoothstep — same cost as the old multiply.
  float heightMask = smoothstep(0.3, 0.45, aHeightT);
  windDisp *= heightMask * aWindStrength;

  vec3 displaced = localPos.xyz + vec3(windDisp, windDisp * 0.3, windDisp);
  vec4 mvPos     = modelViewMatrix * vec4(displaced, 1.0);
  vViewDir       = normalize(-mvPos.xyz);
  vFogDepth      = -mvPos.z; // ← ADD: view-space distance, used for fog blend in fragment shader

  gl_Position = projectionMatrix * mvPos;
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// MERGED FRAGMENT SHADER — FIR (trunk one-sided diffuse + branch one-sided diffuse)
// ═══════════════════════════════════════════════════════════════════════════

export const MERGED_FIR_FRAG = /* glsl */`
precision highp float;

uniform sampler2D uDiffuse;      // branch/needle texture
uniform sampler2D uBarkDiffuse;  // bark texture (optional — same baked atlas as uDiffuse)
uniform bool  uUseBarkMap;
uniform vec3  uTrunkColor;       // tint multiplied over bark texture (or flat color if no map)
uniform vec3  uMainColor;
uniform vec3  uSecondColor;
uniform float uColor2Level;
uniform float uColor2Fade;
uniform float uAlphaCutoff;
uniform float uBarkAlphaCutoff;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbientColor;
uniform float uSnowAmount;   // 0 = no snow, 1 = full frost
uniform sampler2D uSnowTex;  // ← CHANGED: Snow_Fir.png overlay, replaces the flat-color tint
uniform bool  uUseSnowTex;   // ← ADD
uniform bool  uFogEnabled;   // ← ADD
uniform vec3  uFogColor;     // ← ADD
uniform float uFogNear;      // ← ADD
uniform float uFogFar;       // ← ADD
uniform bool  uFogExp2;      // ← ADD
uniform float uFogDensity;   // ← ADD

varying vec2  vUv;
varying float vObjectY;
varying vec3  vWorldNormal;
varying float vIsLeaf;
varying float vFogDepth;     // ← ADD

void main(){
  vec3  N    = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float diff = max(dot(N, -normalize(uLightDir)), 0.0);

  vec3 color;
  if (vIsLeaf > 0.5) {
    vec4 tex = texture2D(uDiffuse, vUv);
    if (tex.a < uAlphaCutoff) discard;
    float t2    = clamp((vObjectY + uColor2Level) * (uColor2Fade * 2.0), 0.0, 1.0);
    vec3 albedo = mix(uMainColor, uSecondColor, t2) * tex.rgb;

    // ← CHANGED: sample the snow texture instead of a flat tint
    if (uUseSnowTex) {
      vec4  snowTex     = texture2D(uSnowTex, vUv);
      float snowFactor  = smoothstep(0.3, 0.9, N.y) * uSnowAmount * snowTex.a;
      albedo = mix(albedo, snowTex.rgb, snowFactor);
    }

    color = albedo * (uAmbientColor + uLightColor * diff);
  } else {
    vec3 barkAlbedo = uTrunkColor;
    if (uUseBarkMap) {
      vec4 barkTex = texture2D(uBarkDiffuse, vUv);
      if (barkTex.a < uBarkAlphaCutoff) discard;
      barkAlbedo = barkTex.rgb * uTrunkColor;
    }
      // ← CHANGED: sample the snow texture instead of a flat tint
      if (uUseSnowTex) {
        vec4  snowTex     = texture2D(uSnowTex, vUv);
        float snowFactor  = smoothstep(0.4, 0.95, N.y) * uSnowAmount * snowTex.a * 0.6;
        barkAlbedo = mix(barkAlbedo, snowTex.rgb, snowFactor);
      }

    color = barkAlbedo * (uAmbientColor + uLightColor * diff);
  }

  vec3 outColor = pow(max(color, vec3(0.0)), vec3(1.0/2.2));

  // ← ADD: manual fog blend (ShaderMaterial doesn't get Three's auto fog)
  if (uFogEnabled) {
    float fogFactor = uFogExp2
      ? 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth)
      : smoothstep(uFogNear, uFogFar, vFogDepth);
    outColor = mix(outColor, uFogColor, fogFactor);
  }

  gl_FragColor = vec4(outColor, 1.0);
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// MERGED FRAGMENT SHADER — BIRCH (trunk one-sided diffuse + leaves two-sided/translucent)
// ═══════════════════════════════════════════════════════════════════════════

export const MERGED_BIRCH_FRAG = /* glsl */`
precision highp float;

uniform sampler2D uDiffuse;      // leaves texture
uniform sampler2D uBarkDiffuse;  // bark texture (optional)
uniform bool  uUseBarkMap;
uniform vec3  uTrunkColor;
uniform vec3  uMainColor;
uniform vec3  uSecondColor;
uniform float uColor2Level;
uniform float uColor2Fade;
uniform float uAlphaCutoff;
uniform float uBarkAlphaCutoff;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbientColor;
uniform bool  uFogEnabled;   // ← ADD
uniform vec3  uFogColor;     // ← ADD
uniform float uFogNear;      // ← ADD
uniform float uFogFar;       // ← ADD
uniform bool  uFogExp2;      // ← ADD
uniform float uFogDensity;   // ← ADD

varying vec2  vUv;
varying float vObjectY;
varying vec3  vWorldNormal;
varying float vIsLeaf;
varying float vFogDepth;     // ← ADD (already written by shared MERGED_VERT if you applied the fir fix)

void main(){
  vec3 N = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);

  vec3 color;
  if (vIsLeaf > 0.5) {
    vec4 tex = texture2D(uDiffuse, vUv);
    if (tex.a < uAlphaCutoff) discard;
    float t2      = clamp((vObjectY + uColor2Level) * (uColor2Fade * 2.0), 0.0, 1.0);
    vec3  albedo  = mix(uMainColor, uSecondColor, t2) * tex.rgb;
    float NdotL   = dot(N, -normalize(uLightDir));
    float diff    = abs(NdotL) * 0.6 + 0.4; // two-sided translucency approximation

    color = albedo * (uAmbientColor + uLightColor * diff);
  } else {
    vec3 barkAlbedo = uTrunkColor;
    if (uUseBarkMap) {
      vec4 barkTex = texture2D(uBarkDiffuse, vUv);
      if (barkTex.a < uBarkAlphaCutoff) discard;
      barkAlbedo = barkTex.rgb * uTrunkColor;
    }
    float diff = max(dot(N, -normalize(uLightDir)), 0.0);

    color = barkAlbedo * (uAmbientColor + uLightColor * diff);
  }

  vec3 outColor = pow(max(color, vec3(0.0)), vec3(1.0/2.2));

  // ← ADD: manual fog blend (ShaderMaterial doesn't get Three's auto fog)
  if (uFogEnabled) {
    float fogFactor = uFogExp2
      ? 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth)
      : smoothstep(uFogNear, uFogFar, vFogDepth);
    outColor = mix(outColor, uFogColor, fogFactor);
  }

  gl_FragColor = vec4(outColor, 1.0);
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// SHADOW VERTEX SHADER  ← THIS WAS MISSING
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// SHADOW VERTEX SHADER — non-instanced (trees, bushes)
// ═══════════════════════════════════════════════════════════════════════════

export const SHADOW_VERT = /* glsl */`
${SIMPLEX_NOISE_GLSL}

uniform float uTime;
uniform float uWindForce;
uniform float uWindWavesScale;
uniform float uWindSpeed;
uniform bool  uAnchorBase;

varying vec2 vUv;

void main(){
  vUv = uv;

  float t        = uTime * (uWindSpeed * 5.0);
  float noise    = snoise((position + t) * uWindWavesScale);
  float windDisp = noise;

  if(uAnchorBase){
    windDisp *= pow(uv.y, 2.0);
  }
  windDisp *= uWindForce * 30.0;

  vec3 displaced = position + vec3(windDisp, windDisp * 0.3, windDisp);
  gl_Position    = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// SHADOW VERTEX SHADER — instanced (flowers pool)
// ═══════════════════════════════════════════════════════════════════════════

export const SHADOW_VERT_INSTANCED = /* glsl */`
#define USE_INSTANCING
${SIMPLEX_NOISE_GLSL}

uniform float uTime;
uniform float uWindForce;
uniform float uWindWavesScale;
uniform float uWindSpeed;
uniform bool  uAnchorBase;

varying vec2 vUv;

void main(){
  vUv = uv;

  vec4 localPos  = instanceMatrix * vec4(position, 1.0);

  float t        = uTime * (uWindSpeed * 5.0);
  float noise    = snoise((localPos.xyz + t) * uWindWavesScale);
  float windDisp = noise;

  if(uAnchorBase){
    windDisp *= pow(uv.y, 2.0);
  }
  windDisp *= uWindForce * 30.0;

  vec3 displaced = localPos.xyz + vec3(windDisp, windDisp * 0.3, windDisp);
  gl_Position    = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// SHADOW FRAGMENT SHADER
// ═══════════════════════════════════════════════════════════════════════════

export const SHADOW_FRAG = /* glsl */`
precision highp float;
#include <packing>

uniform sampler2D map;
uniform float     alphaTest;
uniform sampler2D barkMap;
uniform bool      uUseBarkMap;
uniform float     barkAlphaTest;

varying vec2 vUv;
#ifdef USE_LEAF_MASK
varying float vIsLeaf;
#endif

void main(){
  #ifdef USE_LEAF_MASK
    if (vIsLeaf > 0.5) {
      float a = texture2D(map, vUv).a;
      if (a < alphaTest) discard;
    } else if (uUseBarkMap) {
      float a = texture2D(barkMap, vUv).a;
      if (a < barkAlphaTest) discard;
    }
  #else
    float a = texture2D(map, vUv).a;
    if (a < alphaTest) discard;
  #endif

  gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
}
`;

export const MERGED_SHADOW_VERT = /* glsl */`

${SIMPLEX_NOISE_GLSL}

uniform float uTime;
uniform float uWindForce;
uniform float uWindWavesScale;
uniform float uWindSpeed;
uniform bool  uAnchorBase;

attribute float aIsLeaf;
attribute float aWindStrength;
attribute float aHeightT;

varying vec2  vUv;
varying float vIsLeaf;

void main(){
  vUv     = uv;
  vIsLeaf = aIsLeaf;

  #ifdef USE_INSTANCING
    vec4 localPos = instanceMatrix * vec4(position, 1.0);
  #else
    vec4 localPos = vec4(position, 1.0);
  #endif

  float t        = uTime * (uWindSpeed * 5.0);
  float noise    = snoise((localPos.xyz + t) * uWindWavesScale);
  float windDisp = noise;

  if(uAnchorBase){
    windDisp *= pow(uv.y, 2.0);
  }
  windDisp *= uWindForce * 30.0;
  float heightMask = smoothstep(0.3, 0.45, aHeightT);
  windDisp *= heightMask * aWindStrength;

  vec3 displaced = localPos.xyz + vec3(windDisp, windDisp * 0.3, windDisp);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

export const GRASS_VERT = /* glsl */`
#define USE_INSTANCING
${SIMPLEX_NOISE_GLSL}

uniform float uTime;
uniform float uWindForce;
uniform float uWindWavesScale;
uniform float uWindSpeed;
uniform bool  uAnchorBase;

${GRASS_IMPACT_GLSL}

varying vec2  vUv;
varying vec3  vWorldPos;
varying vec3  vWorldNormal;
varying float vObjectY;
varying vec3  vViewDir;
varying float vFogDepth;
varying float vImpactAmt;

void main(){
  vUv = uv;

  vec4 localPos  = instanceMatrix * vec4(position, 1.0);
  vec4 worldPos4 = modelMatrix * localPos;
  vWorldPos      = worldPos4.xyz;
  vWorldNormal   = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vObjectY       = position.y;

  float t        = uTime * (uWindSpeed * 5.0);
  float noise    = snoise((localPos.xyz + t) * uWindWavesScale);
  float windDisp = noise;

  if(uAnchorBase){
    windDisp *= pow(clamp(uv.y, 0.0, 1.0), 2.0);
  }
  windDisp *= uWindForce * 30.0;

  float impactAmt;
  vec3  impactOffset = grassImpactOffset(worldPos4.xyz, clamp(uv.y, 0.0, 1.0), impactAmt);
  vImpactAmt = impactAmt;

  vec3 displaced = localPos.xyz + vec3(windDisp, windDisp * 0.1, windDisp * 0.8) + impactOffset;
  vec4 mvPos     = modelViewMatrix * vec4(displaced, 1.0);
  vViewDir       = normalize(-mvPos.xyz);
  vFogDepth      = -mvPos.z;

  gl_Position = projectionMatrix * mvPos;
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// GRASS FRAGMENT SHADER
// Second color overlay via UV_Base (vertex Y height), same as AZURE shader
// ═══════════════════════════════════════════════════════════════════════════

export const GRASS_FRAG = /* glsl */`
precision highp float;

uniform sampler2D uDiffuse;
uniform vec3  uMainColor;
uniform vec3  uSecondColor;
uniform float uColor2Level;
uniform float uColor2Fade;
uniform float uAlphaCutoff;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbientColor;
uniform bool  uFogEnabled;
uniform vec3  uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform bool  uFogExp2;
uniform float uFogDensity;
uniform float uHeightFade; // ← ADD: 1 = fully visible, 0 = fully faded (camera-height cull)
uniform float uAlphaBoost; // ← ADD: >1 = more opaque blades

varying vec2  vUv;
varying float vObjectY;
varying vec3  vWorldNormal;
varying float vFogDepth;
varying float vImpactAmt;

void main(){
  vec4 tex = texture2D(uDiffuse, vUv);
  if(tex.a < 0.01) discard;

  float t2    = clamp((vObjectY + uColor2Level) * uColor2Fade, 0.0, 1.0);
  vec3 albedo = mix(uMainColor, uSecondColor, t2) * tex.rgb;
  albedo *= mix(1.0, 0.55, clamp(vImpactAmt, 0.0, 1.0)); // crushed/impact darkening

  vec3  N     = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float diff  = abs(dot(N, -normalize(uLightDir))) * 0.8 + 0.2;
  vec3  color = albedo * (uAmbientColor + uLightColor * diff);

  vec3 outColor = pow(max(color, vec3(0.0)), vec3(1.0/2.2));

  if (uFogEnabled) {
    float fogFactor = uFogExp2
      ? 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth)
      : smoothstep(uFogNear, uFogFar, vFogDepth);
    outColor = mix(outColor, uFogColor, fogFactor);
  }

  float boostedAlpha = clamp(tex.a * uAlphaBoost, 0.0, 1.0);
  gl_FragColor = vec4(outColor, boostedAlpha * uHeightFade);
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// BUSH (INSTANCED) FRAGMENT SHADER — alpha blend variant of GRASS_FRAG
// ═══════════════════════════════════════════════════════════════════════════

export const BUSH_FRAG = /* glsl */`
precision highp float;

uniform sampler2D uDiffuse;
uniform vec3  uMainColor;
uniform vec3  uSecondColor;
uniform float uColor2Level;
uniform float uColor2Fade;
uniform float uAlphaCutoff;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbientColor;
uniform bool  uFogEnabled;
uniform vec3  uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform bool  uFogExp2;
uniform float uFogDensity;

varying vec2  vUv;
varying float vObjectY;
varying vec3  vWorldNormal;
varying float vFogDepth;

void main(){
  vec4 tex = texture2D(uDiffuse, vUv);
  if(tex.a < uAlphaCutoff) discard;

  float t2    = clamp((vObjectY + uColor2Level) * uColor2Fade, 0.0, 1.0);
  vec3 albedo = mix(uMainColor, uSecondColor, t2) * tex.rgb;

  vec3  N     = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float diff  = abs(dot(N, -normalize(uLightDir))) * 0.8 + 0.2;
  vec3  color = albedo * (uAmbientColor + uLightColor * diff);

  vec3 outColor = pow(max(color, vec3(0.0)), vec3(1.0/2.2));

  if (uFogEnabled) {
    float fogFactor = uFogExp2
      ? 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth)
      : smoothstep(uFogNear, uFogFar, vFogDepth);
    outColor = mix(outColor, uFogColor, fogFactor);
  }

  gl_FragColor = vec4(outColor, 1.0);
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// SHADOW VERTEX SHADER  (matches wind so shadows stay in sync)
// ═══════════════════════════════════════════════════════════════════════════

export const GRASS_SHADOW_VERT = /* glsl */`
#define USE_INSTANCING
${SIMPLEX_NOISE_GLSL}

uniform float uTime;
uniform float uWindForce;
uniform float uWindWavesScale;
uniform float uWindSpeed;
uniform bool  uAnchorBase;

${GRASS_IMPACT_GLSL}

varying vec2 vUv;

void main(){
  vUv = uv;

  vec4 localPos  = instanceMatrix * vec4(position, 1.0);
  vec4 worldPos4 = modelMatrix * localPos;

  float t        = uTime * (uWindSpeed * 5.0);
  float noise    = snoise((localPos.xyz + t) * uWindWavesScale);
  float windDisp = noise;

  if(uAnchorBase){
    windDisp *= pow(clamp(uv.y, 0.0, 1.0), 2.0);
  }
  windDisp *= uWindForce * 30.0;

  float impactAmt;
  vec3  impactOffset = grassImpactOffset(worldPos4.xyz, clamp(uv.y, 0.0, 1.0), impactAmt);

  vec3 displaced = localPos.xyz + vec3(windDisp, windDisp * 0.1, windDisp * 0.8) + impactOffset;
  gl_Position    = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

export const FLOWERS_SHADOW_VERT = /* glsl */`
#define USE_INSTANCING
${SIMPLEX_NOISE_GLSL}

uniform float uTime;
uniform float uWindForce;
uniform float uWindWavesScale;
uniform float uWindSpeed;
uniform bool  uAnchorBase;

${GRASS_IMPACT_GLSL}

varying vec2 vUv;

void main(){
  vUv = uv;

  vec4 localPos  = instanceMatrix * vec4(position, 1.0);
  vec4 worldPos4 = modelMatrix * localPos;

  float t        = uTime * (uWindSpeed * 5.0);
  float noise    = snoise((localPos.xyz + t) * uWindWavesScale);
  float windDisp = noise;

  if(uAnchorBase){
    windDisp *= pow(clamp(uv.y, 0.0, 1.0), 2.0);
  }
  windDisp *= uWindForce * 30.0;

  float impactAmt;
  vec3  impactOffset = grassImpactOffset(worldPos4.xyz, clamp(uv.y, 0.0, 1.0), impactAmt);

  vec3 displaced = localPos.xyz + vec3(windDisp, windDisp * 0.1, windDisp * 0.8) + impactOffset;
  gl_Position    = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// SHADOW FRAGMENT SHADER
// ═══════════════════════════════════════════════════════════════════════════

export const GRASS_SHADOW_FRAG = /* glsl */`
precision highp float;

uniform sampler2D map;
uniform float     alphaTest;
uniform float     uHeightFade; // ← ADD

varying vec2 vUv;

void main(){
  // As uHeightFade drops toward 0, the effective threshold rises toward 1.0,
  // so more of the shadow-casting texel area gets clipped — shadow thins
  // out in step with the visible grass instead of vanishing in one frame.
  float threshold = mix(1.0, alphaTest, uHeightFade);
  if(texture2D(map, vUv).a < threshold) discard;
  gl_FragColor = vec4(1.0);
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// FLOWERS SHADOW FRAGMENT SHADER — same as SHADOW_FRAG but with height-fade
// ═══════════════════════════════════════════════════════════════════════════

export const FLOWERS_SHADOW_FRAG = /* glsl */`
precision highp float;
#include <packing>

uniform sampler2D map;
uniform float     alphaTest;
uniform float     uHeightFade;

varying vec2 vUv;

void main(){
  float threshold = mix(1.0, alphaTest, uHeightFade);
  if(texture2D(map, vUv).a < threshold) discard;
  gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// FLOWERS VERTEX SHADER
// anchorBase=true → UV.y-weighted sway, stem pinned at root
// ═══════════════════════════════════════════════════════════════════════════

export const FLOWERS_VERT = /* glsl */`
#define USE_INSTANCING
${SIMPLEX_NOISE_GLSL}

uniform float uTime;
uniform float uWindForce;
uniform float uWindWavesScale;
uniform float uWindSpeed;
uniform bool  uAnchorBase;

${GRASS_IMPACT_GLSL}

varying vec2  vUv;
varying vec3  vWorldPos;
varying vec3  vWorldNormal;
varying vec3  vViewDir;
varying float vImpactAmt;

void main(){
  vUv = uv;

  vec4 localPos  = instanceMatrix * vec4(position, 1.0);
  vec4 worldPos4 = modelMatrix * localPos;
  vWorldPos      = worldPos4.xyz;
  vWorldNormal   = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);

  float t        = uTime * (uWindSpeed * 5.0);
  float noise    = snoise((localPos.xyz + t) * uWindWavesScale);
  float windDisp = noise;

  if(uAnchorBase){
    windDisp *= pow(clamp(uv.y, 0.0, 1.0), 2.0);
  }
  windDisp *= uWindForce * 30.0;

  float impactAmt;
  vec3  impactOffset = grassImpactOffset(worldPos4.xyz, clamp(uv.y, 0.0, 1.0), impactAmt);
  vImpactAmt = impactAmt;

  vec3 displaced = localPos.xyz + vec3(windDisp, windDisp * 0.1, windDisp * 0.8) + impactOffset;
  vec4 mvPos     = modelViewMatrix * vec4(displaced, 1.0);
  vViewDir       = normalize(-mvPos.xyz);

  gl_Position = projectionMatrix * mvPos;
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// FLOWERS FRAGMENT SHADER
//
// KEY FIX: Uses vUv.y (0=stem base → 1=flower head tip) for the color blend.
// This is scale-independent and always correct regardless of FBX transform.
//
// uFlowerStart  = UV.y threshold where pink begins (default 0.6)
//                 → below this = green stem, above = pink flower
// uColorBlend   = softness of the transition (default 0.15)
// ═══════════════════════════════════════════════════════════════════════════

export const FLOWERS_FRAG = /* glsl */`
precision highp float;

uniform sampler2D uDiffuse;
uniform vec3  uMainColor;
uniform vec3  uSecondColor;
uniform float uFlowerStart;
uniform float uColorBlend;
uniform float uAlphaCutoff;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbientColor;
uniform float uHeightFade;

varying vec2  vUv;
varying vec3  vWorldNormal;
varying float vImpactAmt;

void main(){
  vec4 tex = texture2D(uDiffuse, vUv);
  if(tex.a < 0.01) discard; // only clip fully-transparent texels, real fade comes from blending

  float t2    = 1.0 - smoothstep(uFlowerStart - uColorBlend, uFlowerStart + uColorBlend, vUv.y);
  vec3 albedo = mix(uMainColor, uSecondColor, t2) * tex.rgb;
  albedo *= mix(1.0, 0.55, clamp(vImpactAmt, 0.0, 1.0)); // crushed/impact darkening

  vec3  N     = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float diff  = abs(dot(N, -normalize(uLightDir))) * 0.6 + 0.4;
  vec3  color = albedo * (uAmbientColor + uLightColor * diff);

  gl_FragColor = vec4(pow(max(color, vec3(0.0)), vec3(1.0/2.2)), tex.a * uHeightFade);
  
}
`;




// ─── Water Floor Shaders ───────────────────────────────────────────────────
export const WATER_VERT = /* glsl */ `
  varying vec2 vWorldPos;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos     = worldPos.xz;
    gl_Position   = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const WATER_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uScale;
  uniform float uSmoothness;
  uniform float uEdgeThreshold;
  uniform float uEdgeSoftness;
  uniform float uFlowX;
  uniform float uFlowZ;
  uniform float uCellSpeed;
  uniform float uNoiseScale;
  uniform float uNoiseFlowSpeed;
  uniform float uDistortAmount;
  uniform vec3  uDeepColor;
  uniform vec3  uMidColor;
  uniform float uMidPos;
  uniform vec3  uHighlight;
  uniform float uOpacity;
  uniform float uDeepOpacity;
  uniform float uFadeDistance;
  uniform float uFadeStrength;
  uniform vec2  uCamXZ;

  uniform vec2  uRippleCenters[8];
  uniform float uRippleTimes[8];
  uniform int   uRippleCount;
  uniform float uRippleSpeed;
  uniform float uRippleWidth;
  uniform float uRippleStrength;
  uniform float uRippleDecay;
  uniform int   uRippleRings;
  uniform float uRippleSpacing;

  varying vec2 vWorldPos;

  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }

  float smin(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * h * k / 6.0;
  }

  vec2 cellPt(vec2 seed) {
    return 0.5 + 0.5 * sin(uTime * uCellSpeed + 6.2831 * seed);
  }

  float voronoiF1(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float md = 8.0;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec2 n  = vec2(float(x), float(y));
        vec2 pt = cellPt(hash2(i + n));
        md = min(md, length(n + pt - f));
      }
    return md;
  }

  float voronoiSF1(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float res = 8.0;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec2 n  = vec2(float(x), float(y));
        vec2 pt = cellPt(hash2(i + n));
        res = smin(res, length(n + pt - f), uSmoothness);
      }
    return res;
  }

  float nHash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(nHash(i),                  nHash(i + vec2(1.0, 0.0)), f.x),
      mix(nHash(i + vec2(0.0, 1.0)), nHash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 2; i++) { v += a * vnoise(p); p *= 2.0; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 noiseUV   = vWorldPos * uNoiseScale + vec2(uTime * uNoiseFlowSpeed, 0.0);
    float noiseFac = fbm(noiseUV);
    vec2 distort   = vec2(noiseFac - 0.5) * uDistortAmount;

    vec2 uv = vWorldPos * uScale + vec2(uFlowX, uFlowZ) * uTime + distort;

    float f1  = voronoiF1(uv);
    float sf1 = voronoiSF1(uv);
    float edge = f1 - sf1;

    float t = smoothstep(uEdgeThreshold - uEdgeSoftness,
                         uEdgeThreshold + uEdgeSoftness, edge);

    float safeMP = max(uMidPos, 0.0001);
    float seg0   = clamp(t / safeMP, 0.0, 1.0);
    float seg1   = clamp((t - safeMP) / max(1.0 - safeMP, 0.0001), 0.0, 1.0);
    float inSeg1 = step(safeMP, t);
    vec3 color   = mix(
      mix(uDeepColor, uMidColor, seg0),
      mix(uMidColor,  uHighlight, seg1),
      inSeg1
    );

    float rippleAcc = 0.0;
    for (int i = 0; i < 8; i++) {
      float isOn    = step(float(i), float(uRippleCount) - 0.5);
      float elapsed = max(uTime - uRippleTimes[i], 0.0);
      float d       = length(vWorldPos - uRippleCenters[i]);
      for (int r = 0; r < 4; r++) {
        float rIsOn  = step(float(r), float(uRippleRings) - 0.5);
        float re     = max(elapsed - float(r) * uRippleSpacing, 0.0);
        float ringR  = re * uRippleSpeed;
        float ringDist = abs(d - ringR);
        float ring   = 1.0 - smoothstep(0.0, uRippleWidth, ringDist);
        float fade   = exp(-re * uRippleDecay);
        rippleAcc   += ring * fade * isOn * rIsOn;
      }
    }
    float ripple = clamp(rippleAcc * uRippleStrength, 0.0, 1.0);
    color = mix(color, uHighlight, ripple);

    float dist = length(vWorldPos - uCamXZ);
    float fade = 1.0 - pow(clamp(dist / uFadeDistance, 0.0, 1.0), uFadeStrength);
    float alpha = mix(uDeepOpacity, 1.0, max(t, ripple)) * uOpacity * fade;
    gl_FragColor = vec4(color, alpha);
  }
`;

// ─── Seabed Floor Shaders ──────────────────────────────────────────────────
export const SEABED_VERT = /* glsl */ `
  varying vec2 vWorldPos;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos     = worldPos.xz;
    gl_Position   = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const SEABED_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uScale;
  uniform float uCellSpeed;
  uniform float uFlowX;
  uniform float uFlowZ;
  uniform float uEdgeThreshold;
  uniform float uEdgeSoftness;
  uniform vec3  uDeepColor;
  uniform vec3  uHighlight;
  uniform float uFadeDistance;
  uniform float uFadeStrength;
  uniform vec2  uCamXZ;

  varying vec2 vWorldPos;

  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }
  float smin(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * h * k / 6.0;
  }
  vec2 cellPt(vec2 seed) {
    return 0.5 + 0.5 * sin(uTime * uCellSpeed + 6.2831 * seed);
  }
  float voronoiF1(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float md = 8.0;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec2 n  = vec2(float(x), float(y));
        vec2 pt = cellPt(hash2(i + n));
        md = min(md, length(n + pt - f));
      }
    return md;
  }
  float voronoiSF1(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float res = 8.0;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec2 n  = vec2(float(x), float(y));
        vec2 pt = cellPt(hash2(i + n));
        res = smin(res, length(n + pt - f), 0.4);
      }
    return res;
  }

  void main() {
    vec2  uv   = vWorldPos * uScale + vec2(uFlowX, uFlowZ) * uTime;
    float f1   = voronoiF1(uv);
    float sf1  = voronoiSF1(uv);
    float edge = f1 - sf1;
    float t    = smoothstep(uEdgeThreshold - uEdgeSoftness,
                            uEdgeThreshold + uEdgeSoftness, edge);
    vec3  color = mix(uDeepColor, uHighlight, t);
    float dist  = length(vWorldPos - uCamXZ);
    float fade  = 1.0 - pow(clamp(dist / uFadeDistance, 0.0, 1.0), uFadeStrength);
    gl_FragColor = vec4(color, fade);
  }
`;

// ─── Wave Simulation Shaders ───────────────────────────────────────────────
export const WAVE_VERT = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const WAVE_FRAG = /* glsl */ `
  uniform sampler2D uWaveTex;
  uniform sampler2D uInjection;
  uniform float     uTexelSize;
  uniform float     uResolution;
  uniform float     uSpeed;
  uniform float     uDamping;
  uniform float     uInjectStr;
  uniform float     uInjectAmp;
  uniform float     uBorderWidth;

  void main() {
    vec2 uv    = gl_FragCoord.xy / uResolution;
    float cur  = texture2D(uWaveTex, uv).r;
    float prev = texture2D(uWaveTex, uv).g;
    float left  = texture2D(uWaveTex, uv + vec2(-uTexelSize, 0.0)).r;
    float right = texture2D(uWaveTex, uv + vec2( uTexelSize, 0.0)).r;
    float up    = texture2D(uWaveTex, uv + vec2(0.0,  uTexelSize)).r;
    float down  = texture2D(uWaveTex, uv + vec2(0.0, -uTexelSize)).r;
    float laplacian = left + right + up + down - 4.0 * cur;
    float next = 2.0 * cur - prev + uSpeed * laplacian;
    next *= uDamping;
    float edge   = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    float border = smoothstep(0.0, uBorderWidth, edge);
    next *= border;
    float inject = texture2D(uInjection, uv).r;
    next = mix(next, uInjectAmp, inject * uInjectStr);
    next = clamp(next, -1.0, 1.0);
    gl_FragColor = vec4(next, cur, 0.0, 1.0);
  }
`;

export const INJ_VERT = /* glsl */ `
  varying float vWorldY;
  void main() {
    vec4 wp   = modelMatrix * vec4(position, 1.0);
    vWorldY   = wp.y;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const INJ_FRAG = /* glsl */ `
  uniform float uWaterY;
  uniform float uBandWidth;
  varying float vWorldY;
  void main() {
    float d = abs(vWorldY - uWaterY);
    if (d > uBandWidth) discard;
    float s = 1.0 - smoothstep(0.0, uBandWidth, d);
    gl_FragColor = vec4(s, 0.0, 0.0, 1.0);
  }
`;

export const DISP_VERT = /* glsl */ `
  varying vec2 vWorldXZ;
  void main() {
    vec4 wp     = modelMatrix * vec4(position, 1.0);
    vWorldXZ    = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const DISP_FRAG = /* glsl */ `
  uniform sampler2D uWaveTex;
  uniform vec2  uCenter;
  uniform float uWaveSize;
  uniform float uTexelSize;
  uniform float uGradScale;
  uniform float uRingThreshold;
  uniform float uEdgeSharpness;
  uniform vec3  uColor;
  uniform float uOpacity;
  varying vec2 vWorldXZ;

  void main() {
    float u =  (vWorldXZ.x - uCenter.x) / (uWaveSize * 2.0) + 0.5;
    float v = -(vWorldXZ.y - uCenter.y) / (uWaveSize * 2.0) + 0.5;
    vec2 uv = vec2(u, v);
    if (any(lessThan(uv, vec2(0.01))) || any(greaterThan(uv, vec2(0.99)))) discard;
    float dx = texture2D(uWaveTex, uv + vec2( uTexelSize, 0.0)).r
             - texture2D(uWaveTex, uv - vec2( uTexelSize, 0.0)).r;
    float dy = texture2D(uWaveTex, uv + vec2(0.0,  uTexelSize)).r
             - texture2D(uWaveTex, uv - vec2(0.0,  uTexelSize)).r;
    float grad = length(vec2(dx, dy)) * uGradScale;
    float halfEdge = mix(0.35, 0.01, uEdgeSharpness);
    float ring     = smoothstep(uRingThreshold - halfEdge, uRingThreshold + halfEdge, grad);
    if (ring < 0.01) discard;
    gl_FragColor = vec4(uColor, ring * uOpacity);
  }
`;