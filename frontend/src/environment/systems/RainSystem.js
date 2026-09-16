import * as THREE from 'three';
// ═══════════════════════════════════════════════════════════════════════════════
// RAIN SYSTEM  — billboard ribbon lines (camera-facing)
// ═══════════════════════════════════════════════════════════════════════════════

export class RainSystem {
  constructor(scene, opts = {}) {
    this.scene = scene;
    const o = opts;

    this.count        = o.count        ?? 100;
    this.spread       = o.spread       ?? 100;
    this.yTop         = o.yTop         ?? 18;
    this.yBottom      = o.yBottom      ?? -1;
    this.speed        = o.speed        ?? 14;
    this.length       = o.length       ?? 1.55;
    this.thickness    = o.thickness    ?? 0.022;
    this.windAngle    = o.windAngle    ?? 0;
    this.windStrength = o.windStrength ?? 0.18;

    this._color   = o.color   ?? new THREE.Color('#ffffff');
    this._opacity = o.opacity ?? 0.45;

    this._mesh = null;
    this._build();
  }

  get visible() { return this._mesh?.visible ?? false; }
  set visible(v) { if (this._mesh) this._mesh.visible = v; }

  update(delta, camera) {
    if (!this._mesh?.visible) return;

    this._mesh.position.x = camera.position.x;
    this._mesh.position.y = camera.position.y; 
    this._mesh.position.z = camera.position.z;

    const mat = this._mesh.material;
    mat.uniforms.uCameraRight.value.setFromMatrixColumn(camera.matrixWorld, 0);
    mat.uniforms.uCameraUp.value.setFromMatrixColumn(camera.matrixWorld, 1);
    mat.uniforms.uDelta.value = delta;
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
    const seed   = new Float32Array(N * 4);
    const idx    = new Uint32Array(N * 6);

    const rand = () => Math.random();

    for (let i = 0; i < N; i++) {
      const x = (rand() - 0.5) * this.spread;
      const y = rand() * (this.yTop - this.yBottom) + this.yBottom;
      const z = (rand() - 0.5) * this.spread;
      const s = rand();

      const base  = i * 12;
      const cBase = i * 8;
      const sBase = i * 4;

      for (let v = 0; v < 4; v++) {
        pos[base + v * 3]     = x;
        pos[base + v * 3 + 1] = y;
        pos[base + v * 3 + 2] = z;
        seed[sBase + v] = s;
      }
      corner[cBase + 0] = -1; corner[cBase + 1] = 0;
      corner[cBase + 2] =  1; corner[cBase + 3] = 0;
      corner[cBase + 4] = -1; corner[cBase + 5] = 1;
      corner[cBase + 6] =  1; corner[cBase + 7] = 1;

      const iBase = i * 6;
      const v0    = i * 4;
      idx[iBase]     = v0;     idx[iBase + 1] = v0 + 1; idx[iBase + 2] = v0 + 2;
      idx[iBase + 3] = v0 + 1; idx[iBase + 4] = v0 + 3; idx[iBase + 5] = v0 + 2;
    }

    geo.setAttribute('position',    new THREE.Float32BufferAttribute(pos,    3));
    geo.setAttribute('aCorner',     new THREE.Float32BufferAttribute(corner, 2));
    geo.setAttribute('aSeed',       new THREE.Float32BufferAttribute(seed,   1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite:  false,
      side:        THREE.DoubleSide,
      uniforms: {
        uCameraRight:  { value: new THREE.Vector3() },
        uCameraUp:     { value: new THREE.Vector3() },
        uYTop:         { value: this.yTop },
        uYBottom:      { value: this.yBottom },
        uSpeed:        { value: this.speed },
        uLength:       { value: this.length },
        uThickness:    { value: this.thickness },
        uWindAngle:    { value: this.windAngle },
        uWindStrength: { value: this.windStrength },
        uColor:        { value: this._color },
        uOpacity:      { value: this._opacity },
        uTime:         { value: Math.random() * 100 },
        uDelta:        { value: 0 },
      },

      vertexShader: /* glsl */`
        attribute vec2 aCorner;
        attribute float aSeed;

        uniform vec3  uCameraRight;
        uniform vec3  uCameraUp;
        uniform float uYTop;
        uniform float uYBottom;
        uniform float uSpeed;
        uniform float uLength;
        uniform float uThickness;
        uniform float uWindAngle;
        uniform float uWindStrength;
        uniform float uTime;

        varying float vAlpha;
        varying float vV;

        void main() {
          float yRange = uYTop - uYBottom;
          float phase  = aSeed * yRange;
          float travel = mod(uTime * uSpeed + phase, yRange);
          float dropY  = uYTop - travel;

          vec3 anchor = position;
          anchor.y = dropY;
          anchor.x += sin(uWindAngle) * uWindStrength * travel;
          anchor.z += cos(uWindAngle) * uWindStrength * travel;

          vec3 right = uCameraRight * aCorner.x * uThickness;
          vec3 up    = -uCameraUp   * aCorner.y * uLength;
          vec3 world = anchor + right + up;

          vV     = aCorner.y;
          vAlpha = smoothstep(0.0, 0.08, travel / yRange)
                 * smoothstep(1.0, 0.85, travel / yRange);

          gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        }
      `,

      fragmentShader: /* glsl */`
        uniform vec3  uColor;
        uniform float uOpacity;

        varying float vAlpha;
        varying float vV;

        void main() {
          float bright = mix(0.4, 1.0, vV);
          float alpha  = vAlpha * uOpacity * bright;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(uColor * bright, alpha);
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