import * as THREE from 'three';
import { _NOISE_GLSL } from '../shaders/environmentShaders';
// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOM FOG SYSTEM  — patches THREE.ShaderChunk for FBM animated height fog
// ═══════════════════════════════════════════════════════════════════════════════

export class FogSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object}      opts
   * @param {THREE.Color|number} opts.fogColor      Fog + scene bg color (default #dfe9f3)
   * @param {number}             opts.fogDensity    FogExp2 density       (default 0.0000005)
   * @param {number}             opts.heightFactor  Height falloff        (default 0.05)
   * @param {number}             opts.noiseScale    World-space noise frequency (default 0.00025)
   * @param {number}             opts.noiseSpeed    Animation speed       (default 0.025)
   */
  constructor(scene, opts = {}) {
    this._scene = scene;

    this._fogColor    = new THREE.Color(opts.fogColor    ?? 0xdfe9f3);
    this._fogDensity  = opts.fogDensity  ?? 0.0000005;
    this._heightFactor = opts.heightFactor ?? 0.05;
    this._noiseScale  = opts.noiseScale  ?? 0.00025;
    this._noiseSpeed  = opts.noiseSpeed  ?? 0.025;

    this._visible       = false;
    this._shaders       = [];          // collected via onBeforeCompile
    this._patchedChunks = false;       // only patch once globally

    // Saved originals so we can restore on dispose
    this._origFogFragment    = THREE.ShaderChunk.fog_fragment;
    this._origFogParsFragment = THREE.ShaderChunk.fog_pars_fragment;
    this._origFogVertex      = THREE.ShaderChunk.fog_vertex;
    this._origFogParsVertex  = THREE.ShaderChunk.fog_pars_vertex;

    // Saved scene state
    this._savedFog        = null;
    this._savedBackground = null;
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  get visible() { return this._visible; }

  set visible(v) {
    if (v === this._visible) return;
    this._visible = v;
    if (v) this._activate();
    else   this._deactivate();
  }

  /**
   * Call every frame with elapsed time in seconds.
   * @param {number} elapsed
   */
  update(elapsed) {
    if (!this._visible) return;
    for (const s of this._shaders) {
      if (s.uniforms.fogTime) s.uniforms.fogTime.value = elapsed;
    }
  }

  /**
   * Register a material so its shader receives the fogTime uniform.
   * Call this on every material in your scene that uses fog.
   * @param {THREE.Material} material
   */
  registerMaterial(material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.fogTime = { value: 0.0 };
      this._shaders.push(shader);
    };
    material.needsUpdate = true;
  }

  dispose() {
    this._deactivate();
    // Restore original ShaderChunks
    THREE.ShaderChunk.fog_fragment     = this._origFogFragment;
    THREE.ShaderChunk.fog_pars_fragment = this._origFogParsFragment;
    THREE.ShaderChunk.fog_vertex       = this._origFogVertex;
    THREE.ShaderChunk.fog_pars_vertex  = this._origFogParsVertex;
    this._shaders = [];
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _patchShaderChunks() {
    if (this._patchedChunks) return;
    this._patchedChunks = true;

    THREE.ShaderChunk.fog_pars_fragment = _NOISE_GLSL + `
#ifdef USE_FOG
  uniform float fogTime;
  uniform vec3  fogColor;
  varying vec3  vWorldPosition;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;

    THREE.ShaderChunk.fog_fragment = `
#ifdef USE_FOG
  vec3  fogOrigin    = cameraPosition;
  vec3  fogDirection = normalize(vWorldPosition - fogOrigin);
  float fogDepth     = distance(vWorldPosition, fogOrigin);

  vec3  noiseSampleCoord = vWorldPosition * ${this._noiseScale.toFixed(8)} + vec3(
      0.0, 0.0, fogTime * ${this._noiseSpeed.toFixed(4)});
  float noiseSample = FBM(noiseSampleCoord + FBM(noiseSampleCoord)) * 0.5 + 0.5;
  fogDepth *= mix(noiseSample, 1.0, saturate((fogDepth - 5000.0) / 5000.0));
  fogDepth *= fogDepth;

  float heightFactor = ${this._heightFactor.toFixed(6)};
  float fogFactor = heightFactor * exp(-fogOrigin.y * fogDensity) * (
      1.0 - exp(-fogDepth * fogDirection.y * fogDensity)) / fogDirection.y;
  fogFactor = saturate(fogFactor);

  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
#endif`;

    THREE.ShaderChunk.fog_vertex = `
#ifdef USE_FOG
  vWorldPosition = worldPosition.xyz;
#endif`;

    THREE.ShaderChunk.fog_pars_vertex = `
#ifdef USE_FOG
  varying vec3 vWorldPosition;
#endif`;
  }

  _activate() {
    this._patchShaderChunks();

    // Save and override scene fog + background
    this._savedFog        = this._scene.fog;
    this._savedBackground = this._scene.background;

    this._scene.fog        = new THREE.FogExp2(this._fogColor, this._fogDensity);
    this._scene.background = new THREE.Color(this._fogColor);

    // Force all existing fog-using materials to recompile with new chunks
    this._scene.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m.fog !== false) m.needsUpdate = true;
        }
      }
    });
  }

  _deactivate() {
    // Restore saved scene state
    if (this._savedFog !== null)        this._scene.fog        = this._savedFog;
    if (this._savedBackground !== null) this._scene.background = this._savedBackground;
    this._savedFog        = null;
    this._savedBackground = null;

    this._scene.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m.needsUpdate = true;
      }
    });
  }
}