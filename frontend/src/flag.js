// flag.js — Instanced, wind-animated capture-point flags.
//
// Perf design:
//  • ALL poles share one InstancedMesh, ALL flags share one InstancedMesh
//    → 2 draw calls total, regardless of how many capture points exist.
//  • Wind sway is computed entirely in the vertex shader (GPU), driven by
//    a single shared `u_time` uniform. The per-frame JS cost of update()
//    is exactly one float write — no per-vertex or per-instance CPU work.
//  • Owner-color changes (neutral/player/enemy) use setColorAt(), which
//    only runs on the rare capture event, never per frame.
//  • castShadow is off for both meshes — these are small decorative props,
//    not worth an extra shadow-map pass.

import * as THREE from 'three';

export class InstancedFlagSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {Array<{id:string, x:number, z:number, owner:string}>} capturePoints
   * @param {(x:number, z:number) => number} getTerrainY
   * @param {object} [opts]
   */
  constructor(scene, capturePoints, getTerrainY, opts = {}) {
    this.scene         = scene;
    this.capturePoints = capturePoints;
    this.count         = capturePoints.length;
    this._timeUniform  = { value: 0 };

    const poleHeight = opts.poleHeight ?? 5.0;
    const poleRadius = opts.poleRadius ?? 0.05;
    const flagWidth  = opts.flagWidth  ?? 3.56;
    const flagHeight = opts.flagHeight ?? 2.0;
    const flagSegsX  = opts.flagSegsX  ?? 25; // wave smoothness — free, still 1 draw call
    const flagSegsY  = opts.flagSegsY  ?? 25;

    // windStrength: 1.0 = full flap (default), 0.0 = frozen/no flap
    // windSpeed: 1.0 = default cycle speed, >1 = faster flapping, <1 = slower
    // sag: 0.0 = flat/stiff, ~0.1–0.3 = heavy cloth hanging from the pole
    this._windUniform  = { value: opts.windStrength ?? 1.0 };
    this._speedUniform = { value: opts.windSpeed ?? 1.0 };
    this._sagUniform   = { value: opts.sag ?? 0.3 };

    // gustIntensity: 0 = no gusts, just steady flap (old behavior).
    //   ~1.5–2.5 = periodic dramatic whip-cracks well above the base flap.
    // gustFrequency: how often gusts roll through, in cycles per second.
    //   ~0.1–0.2 = a gust every several seconds. Higher = more frequent.
    this._gustIntensityUniform = { value: opts.gustIntensity ?? 2.0 };
    this._gustFreqUniform      = { value: opts.gustFrequency ?? 0.15 };
    // Optional per-frame CPU rotation of each flag around its pole (world
    // Y axis, pivoting at the hinge edge). Off by default since it's the
    // one part of this system that isn't a flat per-frame cost.
    this._poleRotationEnabled = opts.enablePoleRotation ?? false;
    this._flagRotationY = opts.flagRotationY ?? 0; // fixed one-time yaw, pivots at the hinge
    this._ownerColors = {
      neutral: new THREE.Color(0x888888),
      player:  new THREE.Color(0x44aaff),
      enemy:   new THREE.Color(0xff4422),
    };

    // ── Poles — static, cheap, instanced ───────────────────────────────
    const poleGeo = new THREE.CylinderGeometry(poleRadius, poleRadius, poleHeight, 6);
    poleGeo.translate(0, poleHeight / 2, 0); // base sits at ground (y=0 local)
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x7a6d5b, roughness: 0.9 });
    this.poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, this.count);
    this.poleMesh.castShadow    = false;
    this.poleMesh.receiveShadow = false;

    // ── Flag geometry — hinged at local x=0 (the pole side), waves in +x ─
    const flagGeo = new THREE.PlaneGeometry(flagWidth, flagHeight, flagSegsX, flagSegsY);
    flagGeo.translate(flagWidth / 2, 0, 0);

    // Precomputed once at build time: 0 at the hinge, 1 at the free edge.
    // This is what makes the cloth "flap harder" the further it is from
    // the pole — all baked into the geometry, never touched again.
    const posAttr = flagGeo.attributes.position;
    const bend = new Float32Array(posAttr.count);
    for (let i = 0; i < posAttr.count; i++) {
      bend[i] = posAttr.getX(i) / flagWidth;
    }
    flagGeo.setAttribute('bend', new THREE.BufferAttribute(bend, 1));

    // Per-instance randomization so flags don't all flap in sync.
    // x = speed multiplier, y = wind-strength multiplier, z = sag multiplier.
    // Ranges are centered around 1.0 so setWindStrength/setSpeed/setSag
    // still act as global averages that this jitters around.
    const instRand = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      instRand[i * 3 + 0] = 0.75 + Math.random() * 0.5;  // speed  ~0.75–1.25x
      instRand[i * 3 + 1] = 0.7  + Math.random() * 0.6;  // wind   ~0.7–1.3x
      instRand[i * 3 + 2] = 0.6  + Math.random() * 0.8;  // sag    ~0.6–1.4x
    }
    flagGeo.setAttribute('instRand', new THREE.InstancedBufferAttribute(instRand, 3));

    // Per-instance rotation jitter (pole-mesh-level, CPU-side — separate from
    // the GPU wind shader above). Used by _updatePoleRotation() each frame.
    this._rotSeed = new Float32Array(this.count);
    this._rotSpeed = new Float32Array(this.count);
    this._rotAmp = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this._rotSeed[i]  = Math.random() * Math.PI * 2; // random phase offset
      this._rotSpeed[i] = 0.4 + Math.random() * 0.5;    // ~0.4–0.9 rad/s cycle speed (was 0.15–0.4, too slow to notice)
      this._rotAmp[i]   = 0.35 + Math.random() * 0.35;  // ~20–40° max sway around Y (was 3–8.5°, too small to notice)
    }

    // opts.texture can be a URL string or an already-loaded THREE.Texture.
    // Passing a pre-loaded Texture is preferred if you're loading many
    // assets elsewhere and want to share/cache loaders.
    let flagTexture = null;
    if (opts.texture) {
      if (opts.texture.isTexture) {
        flagTexture = opts.texture;
      } else {
        flagTexture = new THREE.TextureLoader().load(opts.texture);
        flagTexture.colorSpace = THREE.SRGBColorSpace;
      }
      // Flag geometry's UV (0,0)-(1,1) already maps across the whole
      // plane, so no wrap/repeat tuning is needed for a single image.
      flagTexture.wrapS = THREE.ClampToEdgeWrapping;
      flagTexture.wrapT = THREE.ClampToEdgeWrapping;
    }

    this.flagMat = new THREE.MeshStandardMaterial({
      color:      0xffffff, // white so the texture's own colors show true;
                             // owner tint is still applied via instanceColor
      map:        flagTexture,
      roughness:  0.75,
      metalness:  0.0,
      side:       THREE.DoubleSide,
      alphaTest:  opts.alphaClip ?? 0.2, // pixels with alpha below this are discarded, not blended
      transparent: false, // keep false — alphaTest gives a hard cutout without sorting issues
    });

    // Inject wind sway into the standard PBR vertex shader so lighting/
    // shadows still work normally — only `transformed` gets displaced.
    this.flagMat.onBeforeCompile = (shader) => {
      shader.uniforms.u_time  = this._timeUniform;
      shader.uniforms.u_wind  = this._windUniform;
      shader.uniforms.u_speed = this._speedUniform;
      shader.uniforms.u_sag   = this._sagUniform;
      shader.uniforms.u_gustIntensity = this._gustIntensityUniform;
      shader.uniforms.u_gustFreq      = this._gustFreqUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float bend;
           attribute vec3 instRand;
           uniform float u_time;
           uniform float u_wind;
           uniform float u_speed;
           uniform float u_sag;
           uniform float u_gustIntensity;
           uniform float u_gustFreq;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           // Per-instance jitter on top of the global uniforms — this is
           // what keeps every flag from flapping in visible lockstep.
           float instSpeed = u_speed * instRand.x;
           float instWind   = u_wind  * instRand.y;
           float instSag    = u_sag   * instRand.z;
           // Random starting phase per flag, derived from the same seed
           // used for speed so it's free (no extra attribute needed).
           float instPhaseOffset = instRand.x * 6.2831853;
           // Second, unrelated offset (from instRand.z) so gust timing
           // doesn't correlate with speed/phase — each flag gusts on its
           // own independent schedule.
           float instGustOffset = instRand.z * 6.2831853;

           // ── Gust envelope ──────────────────────────────────────────
           // A slow sine, clamped to its positive half and sharpened with
           // pow(), so most of the time it sits near 0 (calm) and briefly
           // spikes to 1 (gust) — periods of stillness punctuated by a
           // violent snap, rather than one continuous amplitude.
           float gustPhase    = u_time * u_gustFreq * instSpeed + instGustOffset;
           float gustEnvelope = pow(max(0.0, sin(gustPhase)), 4.0);
           float gustBoost    = 1.0 + gustEnvelope * u_gustIntensity;

           // u_speed scales TIME only (how fast it cycles) — bend * 3.0
           // stays untouched since that's the spatial offset that makes
           // the wave travel down the flag's length, not a speed control.
           float phase = (u_time * instSpeed * 2.0) * 3.1 - bend * 3.0 + instPhaseOffset;
           float wave  = sin(phase) * 0.18 * bend * instWind * gustBoost;
           float wave2 = sin(phase * 1.7 + 1.3) * 0.07 * bend * instWind * gustBoost;
           // Whip-crack: a sharp, fast harmonic that only appears near the
           // peak of a gust (gustEnvelope), giving the snap/crack look
           // real cloth gets under a sudden gust, not just "bigger sine".
           float whip = sin(phase * 4.3 + 0.7) * 0.10 * bend * instWind * gustEnvelope;
           transformed.z += wave + wave2 + whip;
           transformed.y += sin(phase * 0.6) * 0.05 * bend * instWind * gustBoost;
           // Static droop — grows with the SQUARE of distance from the pole,
           // like cloth hanging under its own weight (not wind-driven, so
           // it stays even when u_wind is turned down to near-zero).
           transformed.y -= instSag * bend * bend;`
        );
    };

    this.flagMesh = new THREE.InstancedMesh(flagGeo, this.flagMat, this.count);
    this.flagMesh.castShadow    = false;
    this.flagMesh.receiveShadow = false;

    // ── Place instances + set initial owner color ──────────────────────
    const dummy = new THREE.Object3D();
    capturePoints.forEach((p, i) => {
      const groundY = getTerrainY(p.x, p.z);

      dummy.position.set(p.x, groundY, p.z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      this.poleMesh.setMatrixAt(i, dummy.matrix);

      dummy.position.set(p.x, groundY + poleHeight - flagHeight * 0.55, p.z);
      dummy.rotation.set(0, this._flagRotationY, 0);
      dummy.updateMatrix();
      this.flagMesh.setMatrixAt(i, dummy.matrix);

      // Cache base transform so per-frame rotation updates don't need to
      // re-derive position from capturePoints/getTerrainY every tick.
      this._flagBasePos = this._flagBasePos || new Float32Array(this.count * 3);
      this._flagBasePos[i * 3 + 0] = p.x;
      this._flagBasePos[i * 3 + 1] = groundY + poleHeight - flagHeight * 0.55;
      this._flagBasePos[i * 3 + 2] = p.z;

      this.setOwnerColor(i, p.owner ?? 'neutral');
    });

    // Reusable scratch objects for the per-frame rotation update — avoids
    // allocating a new Object3D/Matrix4 every frame.
    this._rotDummy = new THREE.Object3D();

    this.poleMesh.instanceMatrix.needsUpdate = true;
    this.flagMesh.instanceMatrix.needsUpdate = true;

    scene.add(this.poleMesh);
    scene.add(this.flagMesh);
  }

  /** Call once per frame. The ONLY per-frame cost this system has. */
  /**
   * Call once per frame.
   * Wind-flap (GPU shader) stays a single float write.
   * Pole-pivot rotation, if enabled, is O(count) CPU work — set
   * `enablePoleRotation` in opts, or toggle via setPoleRotationEnabled(),
   * since it's a real per-frame cost unlike the rest of this system.
   */
  update(elapsed) {
    this._timeUniform.value = elapsed;

    if (this._poleRotationEnabled) {
      this._updatePoleRotation(elapsed);
    }
  }

  /** Rotates each flag instance around its pole (local x=0 hinge, i.e. world Y axis at its own base). */
  _updatePoleRotation(elapsed) {
    const dummy = this._rotDummy;
    for (let i = 0; i < this.count; i++) {
      const angle = Math.sin(elapsed * this._rotSpeed[i] + this._rotSeed[i]) * this._rotAmp[i];

      dummy.position.set(
        this._flagBasePos[i * 3 + 0],
        this._flagBasePos[i * 3 + 1],
        this._flagBasePos[i * 3 + 2]
      );
      // Y-axis rotation: since the geometry's hinge edge sits at local
      // x=0 (see flagGeo.translate(flagWidth/2, 0, 0) above), rotating
      // the instance about Y pivots the whole flag around the pole,
      // not around the flag's own center.
      dummy.rotation.set(0, this._flagRotationY + angle, 0);
      dummy.updateMatrix();
      this.flagMesh.setMatrixAt(i, dummy.matrix);
    }
    this.flagMesh.instanceMatrix.needsUpdate = true;
  }

  /** Enable/disable the per-frame pole-pivot rotation loop (off by default — has a real CPU cost). */
  setPoleRotationEnabled(v) {
    this._poleRotationEnabled = !!v;
  }

  /** 1.0 = full flap, 0.0 = frozen (no flap at all). Cheap — one uniform write. */
  setWindStrength(v) {
    this._windUniform.value = v;
  }

  /** 1.0 = default cycle speed, 2.0 = twice as fast, 0.5 = half speed. Cheap — one uniform write. */
  setWindSpeed(v) {
    this._speedUniform.value = v;
  }

  /** 0.0 = flat/stiff, ~0.1–0.3 = heavy drooping cloth. Cheap — one uniform write. */
  setSag(v) {
    this._sagUniform.value = v;
  }

  /** 0 = no gusts (steady flap only). ~1.5–2.5 = dramatic periodic whip-cracks. Cheap — one uniform write. */
  setGustIntensity(v) {
    this._gustIntensityUniform.value = v;
  }

  /** Cycles per second for how often gusts roll through. ~0.1–0.2 = a gust every several seconds. Cheap — one uniform write. */
  setGustFrequency(v) {
    this._gustFreqUniform.value = v;
  }

  /** Call only when a capture point changes hands (rare event, not per-frame). */
  setOwnerColor(index, owner) {
    const c = this._ownerColors[owner] ?? this._ownerColors.neutral;
    this.flagMesh.setColorAt(index, c);
    if (this.flagMesh.instanceColor) this.flagMesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.poleMesh);
    this.scene.remove(this.flagMesh);
    this.poleMesh.geometry.dispose();
    this.poleMesh.material.dispose();
    this.flagMesh.geometry.dispose();
    this.flagMesh.material.dispose();
  }
}