import * as THREE from 'three';
// ═══════════════════════════════════════════════════════════════════════════════
// SNOW SYSTEM  — billboard circles (camera-facing quads rendered as discs)
// ═══════════════════════════════════════════════════════════════════════════════

export class SnowSystem {
  constructor(scene, opts = {}) {
    this.scene = scene;
    const o = opts;

    this.count   = o.count   ?? 100;
    this.spread  = o.spread  ?? 100;
    this.yTop    = o.yTop    ?? 16;
    this.yBottom = o.yBottom ?? -1;
    this.speed   = o.speed   ?? 1.4;
    this.sizeMin = o.sizeMin ?? 0.04;
    this.sizeMax = o.sizeMax ?? 0.14;
    this.drift   = o.drift   ?? 0.6;

    this._color   = o.color   ?? new THREE.Color(0xddeeff);
    this._opacity = o.opacity ?? 0.75;

    this._mesh = null;
    this._build();
  }

  get visible() { return this._mesh?.visible ?? false; }
  set visible(v) { if (this._mesh) this._mesh.visible = v; }

  update(delta, camera) {
    if (!this._mesh?.visible) return;

    this._mesh.position.x = camera.position.x;
    this._mesh.position.z = camera.position.z;

    const mat = this._mesh.material;
    mat.uniforms.uCameraRight.value.setFromMatrixColumn(camera.matrixWorld, 0);
    mat.uniforms.uCameraUp.value.setFromMatrixColumn(camera.matrixWorld, 1);
    mat.uniforms.uTime.value += delta;
  }

  dispose() {
    if (!this._mesh) return;
    this._mesh.geometry.dispose();
    this._mesh.material.dispose();
    this.scene.remove(this._mesh);
    this._mesh = null;
  }

  _build() {
    const N   = this.count;
    const geo = new THREE.BufferGeometry();

    const pos    = new Float32Array(N * 4 * 3);
    const corner = new Float32Array(N * 4 * 2);
    const attrs  = new Float32Array(N * 4 * 3);
    const idx    = new Uint32Array(N * 6);

    for (let i = 0; i < N; i++) {
      const x     = (Math.random() - 0.5) * this.spread;
      const y     = Math.random() * (this.yTop - this.yBottom) + this.yBottom;
      const z     = (Math.random() - 0.5) * this.spread;
      const seed  = Math.random();
      const size  = this.sizeMin + Math.random() * (this.sizeMax - this.sizeMin);
      const phase = Math.random() * Math.PI * 2;

      const base  = i * 12;
      const cBase = i * 8;
      const aBase = i * 12;

      for (let v = 0; v < 4; v++) {
        pos[base + v * 3]     = x;
        pos[base + v * 3 + 1] = y;
        pos[base + v * 3 + 2] = z;
        attrs[aBase + v * 3]     = seed;
        attrs[aBase + v * 3 + 1] = size;
        attrs[aBase + v * 3 + 2] = phase;
      }
      corner[cBase]     = -1; corner[cBase + 1] = -1;
      corner[cBase + 2] =  1; corner[cBase + 3] = -1;
      corner[cBase + 4] = -1; corner[cBase + 5] =  1;
      corner[cBase + 6] =  1; corner[cBase + 7] =  1;

      const iBase = i * 6;
      const v0    = i * 4;
      idx[iBase]     = v0;     idx[iBase + 1] = v0 + 1; idx[iBase + 2] = v0 + 2;
      idx[iBase + 3] = v0 + 1; idx[iBase + 4] = v0 + 3; idx[iBase + 5] = v0 + 2;
    }

    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos,    3));
    geo.setAttribute('aCorner',  new THREE.Float32BufferAttribute(corner, 2));
    geo.setAttribute('aAttrs',   new THREE.Float32BufferAttribute(attrs,  3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite:  false,
      side:        THREE.DoubleSide,
      uniforms: {
        uCameraRight: { value: new THREE.Vector3() },
        uCameraUp:    { value: new THREE.Vector3() },
        uYTop:        { value: this.yTop },
        uYBottom:     { value: this.yBottom },
        uSpeed:       { value: this.speed },
        uDrift:       { value: this.drift },
        uColor:       { value: this._color },
        uOpacity:     { value: this._opacity },
        uTime:        { value: Math.random() * 100 },
      },

      vertexShader: /* glsl */`
        attribute vec2  aCorner;
        attribute vec3  aAttrs;

        uniform vec3  uCameraRight;
        uniform vec3  uCameraUp;
        uniform float uYTop;
        uniform float uYBottom;
        uniform float uSpeed;
        uniform float uDrift;
        uniform float uTime;

        varying vec2  vUV;
        varying float vAlpha;

        void main() {
          float yRange = uYTop - uYBottom;
          float seed   = aAttrs.x;
          float size   = aAttrs.y;
          float phase  = aAttrs.z;

          float travel = mod(uTime * uSpeed + seed * yRange, yRange);
          float dropY  = uYTop - travel;

          float driftX = sin(uTime * 0.7 + phase) * uDrift * 0.5;
          float driftZ = cos(uTime * 0.5 + phase * 1.3) * uDrift * 0.35;

          vec3 anchor = position;
          anchor.y = dropY;
          anchor.x += driftX;
          anchor.z += driftZ;

          vec3 world = anchor
            + uCameraRight * aCorner.x * size
            + uCameraUp    * aCorner.y * size;

          vUV    = aCorner;
          vAlpha = smoothstep(0.0, 0.06, travel / yRange)
                 * smoothstep(1.0, 0.9,  travel / yRange);

          gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        }
      `,

      fragmentShader: /* glsl */`
        uniform vec3  uColor;
        uniform float uOpacity;

        varying vec2  vUV;
        varying float vAlpha;

        void main() {
          float dist = length(vUV);
          if (dist > 1.0) discard;

          float edge  = 1.0 - smoothstep(0.6, 1.0, dist);
          float core  = 1.0 - smoothstep(0.0, 0.4, dist);
          float shape = edge + core * 0.5;

          float alpha = vAlpha * uOpacity * shape;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(uColor + core * 0.3, alpha);
        }
      `,
    });

    this._mesh = new THREE.Mesh(geo, mat);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder   = 2;
    this._mesh.visible       = false;
    this.scene.add(this._mesh);
  }
}