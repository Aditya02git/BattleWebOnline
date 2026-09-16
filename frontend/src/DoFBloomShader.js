import * as THREE from 'three';

export const DoFBloomShader = {
  uniforms: {
    tDiffuse:       { value: null },
    tDepth:         { value: null },
    tBright:        { value: null },
    uFocus:         { value: 0.5 },
    uFocusRange:    { value: 0.08 },
    uBokehRadius:   { value: 8.0 },
    uBloomStrength: { value: 1.2 },
    uResolution:    { value: new THREE.Vector2() },
    uNear:          { value: 0.1 },
    uFar:           { value: 100.0 },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tBright;
    uniform float     uFocus;
    uniform float     uFocusRange;
    uniform float     uBokehRadius;
    uniform float     uBloomStrength;
    uniform vec2      uResolution;
    uniform float     uNear;
    uniform float     uFar;

    varying vec2 vUv;

    // ── depth helpers ──────────────────────────────────────────
    float linearDepth(float d) {
      float z = d * 2.0 - 1.0;
      return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
    }

    float cocRadius(float depth) {
      float linearD = linearDepth(depth) / uFar;
      float coc = (linearD - uFocus) / max(uFocusRange, 0.001);
      return clamp(coc, -1.0, 1.0) * uBokehRadius;
    }

    // ── hex bokeh DoF (18 taps, 3 rings) ──────────────────────
    vec4 hexBokeh(vec2 uv, float radius) {
      if (abs(radius) < 0.5) return texture2D(tDiffuse, uv);

      vec2 texel = 1.0 / uResolution;
      vec4 color = vec4(0.0);
      float total = 0.0;

      vec2 hex[6];
      hex[0] = vec2( 1.0,  0.0);
      hex[1] = vec2( 0.5,  0.866);
      hex[2] = vec2(-0.5,  0.866);
      hex[3] = vec2(-1.0,  0.0);
      hex[4] = vec2(-0.5, -0.866);
      hex[5] = vec2( 0.5, -0.866);

      for (int ring = 1; ring <= 3; ring++) {
        float r = radius * (float(ring) / 3.0);
        for (int i = 0; i < 6; i++) {
          vec2  offset   = hex[i] * r * texel;
          float tapDepth = texture2D(tDepth, uv + offset).r;
          float tapCoc   = cocRadius(tapDepth);
          float weight   = step(abs(radius) * 0.5, abs(tapCoc));
          color += texture2D(tDiffuse, uv + offset) * weight;
          total += weight;
        }
      }

      color += texture2D(tDiffuse, uv);
      total += 1.0;
      return color / total;
    }

    // ── 13-tap tent bloom on the bright buffer ─────────────────
    vec3 tentBloom(vec2 uv) {
      vec2 t = 1.0 / uResolution;
      vec3 c = vec3(0.0);

      // inner ring
      c += texture2D(tBright, uv + vec2(-t.x,  t.y) * 2.0).rgb * 1.0;
      c += texture2D(tBright, uv + vec2( t.x,  t.y) * 2.0).rgb * 1.0;
      c += texture2D(tBright, uv + vec2(-t.x, -t.y) * 2.0).rgb * 1.0;
      c += texture2D(tBright, uv + vec2( t.x, -t.y) * 2.0).rgb * 1.0;

      // mid ring
      c += texture2D(tBright, uv + vec2(-t.x,  0.0) * 3.5).rgb * 0.75;
      c += texture2D(tBright, uv + vec2( t.x,  0.0) * 3.5).rgb * 0.75;
      c += texture2D(tBright, uv + vec2( 0.0,  t.y) * 3.5).rgb * 0.75;
      c += texture2D(tBright, uv + vec2( 0.0, -t.y) * 3.5).rgb * 0.75;

      // outer ring
      c += texture2D(tBright, uv + vec2(-t.x,  t.y) * 5.5).rgb * 0.5;
      c += texture2D(tBright, uv + vec2( t.x,  t.y) * 5.5).rgb * 0.5;
      c += texture2D(tBright, uv + vec2(-t.x, -t.y) * 5.5).rgb * 0.5;
      c += texture2D(tBright, uv + vec2( t.x, -t.y) * 5.5).rgb * 0.5;

      // centre
      c += texture2D(tBright, uv).rgb * 2.0;

      return c / 10.0;
    }

    void main() {
      float depth  = texture2D(tDepth, vUv).r;
      float radius = cocRadius(depth);
      vec4  dofCol = hexBokeh(vUv, radius);
      vec3  bloom  = tentBloom(vUv) * uBloomStrength;

      gl_FragColor = vec4(dofCol.rgb + bloom, 1.0);
    }
  `
};