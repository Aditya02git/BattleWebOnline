import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { _NOISE_GLSL } from './shaders/environmentShaders';
import { FogSystem } from './systems/FogSystem';
import { RainSystem } from './systems/RainSystem';
import { SnowSystem } from './systems/SnowSystem';

// ═══════════════════════════════════════════════════════════════════════════════
// WEATHER SYSTEM  — unified controller
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Modes:
 *   'none'      — clear sky
 *   'rain'      — rain ribbons
 *   'snow'      — snowflake discs
 *   'foggy'     — animated FBM height fog via ShaderChunk injection
 */
export class WeatherSystem {
  /**
   * @param {THREE.Scene}          scene
   * @param {THREE.WebGLRenderer}  renderer
   * @param {object}               [opts]
   * @param {string}               [opts.mode='none']
   *
   * — Rain options —
   * @param {number}  [opts.rainCount=800]
   * @param {number}  [opts.rainSpeed=14]
   * @param {number}  [opts.rainWindAngle=0]
   * @param {number}  [opts.rainWindStrength=0.18]
   *
   * — Snow options —
   * @param {number}  [opts.snowCount=600]
   * @param {number}  [opts.snowSpeed=1.4]
   *
   * — customFog options —
   * @param {THREE.Color|number} [opts.fogColor=0xdfe9f3]
   * @param {number}             [opts.fogDensity=0.0000005]
   * @param {number}             [opts.fogHeightFactor=0.05]
   * @param {number}             [opts.fogNoiseScale=0.00025]
   * @param {number}             [opts.fogNoiseSpeed=0.025]
   */
  constructor(scene, renderer, opts = {}) {
    this.scene    = scene;
    this.renderer = renderer;
    this._mode    = 'none';

    this._rain = new RainSystem(scene, {
      count:        opts.rainCount        ?? 100,
      speed:        opts.rainSpeed        ?? 14,
      windAngle:    opts.rainWindAngle    ?? 0,
      windStrength: opts.rainWindStrength ?? 0.18,
    });

    this._snow = new SnowSystem(scene, {
      count: opts.snowCount ?? 100,
      speed: opts.snowSpeed ?? 1.4,
    });

    this._customFog = new FogSystem(scene, {
      fogColor:      opts.fogColor        ?? 0xdfe9f3,
      fogDensity:    opts.fogDensity      ?? 0.0000005,
      heightFactor:  opts.fogHeightFactor ?? 0.05,
      noiseScale:    opts.fogNoiseScale   ?? 0.00025,
      noiseSpeed:    opts.fogNoiseSpeed   ?? 0.025,
    });

    if (opts.mode && opts.mode !== 'none') this.setMode(opts.mode);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get mode() { return this._mode; }

  setMode(mode) {
    if (mode === this._mode) return;
    this._deactivateAll();
    this._mode = mode;
    this._activateMode(mode);
  }

  /**
   * Register a scene material so it receives the fogTime uniform.
   * Only needed for customFog mode — call on every fog-bearing material.
   */
  registerFogMaterial(material) {
    this._customFog.registerMaterial(material);
  }

  update(delta, elapsed, camera) {
    this._rain.update(delta, camera);
    this._snow.update(delta, camera);
    this._customFog.update(elapsed);
  }

  dispose() {
    this._rain.dispose();
    this._snow.dispose();
    this._customFog.dispose();
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _deactivateAll() {
    this._rain.visible      = false;
    this._snow.visible      = false;
    this._customFog.visible = false;
  }

  _activateMode(mode) {
    switch (mode) {
      case 'rain':
        this._rain.visible = true;
        break;
      case 'snow':
        this._snow.visible = true;
        break;
      case 'foggy':
        this._customFog.visible = true;
        break;
      case 'none':
      default:
        break;
    }
  }
}