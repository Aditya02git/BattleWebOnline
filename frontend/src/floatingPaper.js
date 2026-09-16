import * as THREE from 'three';

/**
 * FloatingPaper — instanced, wind-blown paper scraps for a preview scene.
 * Self-contained: owns its own InstancedMesh, per-instance sim state, and
 * gust controller. Call update(dt, elapsed) once per frame.
 */
export class FloatingPaper {
  constructor(scene, opts = {}) {
    this.scene   = scene;
    this.COUNT   = opts.count ?? 120;
    this.center  = opts.center ? opts.center.clone() : new THREE.Vector3(0, 0, 0);

    // Rectangular scatter area (half-extents along X and Z).
    this.halfX = opts.halfX ?? opts.bound ?? 6;
    this.halfZ = opts.halfZ ?? opts.bound ?? 6;

    this._restYOffset = opts.restY ?? 0.02;
    this.RESTY = (opts.groundY ?? 0) + this._restYOffset;

    this.texturePath = opts.texturePath ?? null;

    this.enabled = true;

    this._buildMesh();
    this._buildState();
    this._buildWindController();
  }

  _buildMesh() {
    const paperGeo = new THREE.PlaneGeometry(0.35, 0.25, 2, 1);

    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: 0 },
    };

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: true,
    });

    if (this.texturePath) {
      const texLoader = new THREE.TextureLoader();
      texLoader.load(
        this.texturePath,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          this.material.map = tex;
          this.material.needsUpdate = true;
        },
        undefined,
        (err) => console.warn('[FloatingPaper] Failed to load texture:', err)
      );
    } else {
      this.material.color.setRGB(0.92, 0.90, 0.84);
    }

    // Inject the wind-fold vertex displacement into MeshStandardMaterial's
    // own (fully shadow-capable) shader, instead of hand-writing a
    // ShaderMaterial that has to reimplement Three.js's shadow pipeline
    // from scratch.
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.uniforms.uWind = this.uniforms.uWind;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `
        #include <common>
        attribute float aRandom;
        attribute float aSpeed;
        attribute float aLift;
        uniform float uTime;
        uniform float uWind;
        varying float vFold;
        `
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        float phase = aRandom * 6.2831853;
        float along = position.x * 4.5;
        float amp = mix(0.02, 0.16, uWind) * aLift * (0.4 + 0.6 * aRandom);
        float wave = sin(along + uTime * (3.0 + aSpeed * 2.2) + phase);
        transformed.z += wave * amp;
        vFold = wave * aLift;
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `
        #include <common>
        varying float vFold;
        `
      );

      // Subtle brightening on the up-flexed part of the fold, purely
      // cosmetic — safe to remove if you don't want it.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        gl_FragColor.rgb *= mix(0.9, 1.12, 0.5 + 0.5 * vFold);
        #include <dithering_fragment>
        `
      );

      this._shaderRef = shader;
    };

    this.mesh = new THREE.InstancedMesh(paperGeo, this.material, this.COUNT);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    paperGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100);

    this.scene.add(this.mesh);

    const aRandom = new Float32Array(this.COUNT);
    const aSpeed  = new Float32Array(this.COUNT);
    const aLift   = new Float32Array(this.COUNT);
    for (let i = 0; i < this.COUNT; i++) {
      aRandom[i] = Math.random();
      aSpeed[i]  = Math.random();
      aLift[i]   = 0;
    }
    paperGeo.setAttribute('aRandom', new THREE.InstancedBufferAttribute(aRandom, 1));
    paperGeo.setAttribute('aSpeed',  new THREE.InstancedBufferAttribute(aSpeed, 1));
    this._aLift = aLift;
    this._aLiftAttr = new THREE.InstancedBufferAttribute(aLift, 1);
    this._aLiftAttr.setUsage(THREE.DynamicDrawUsage);
    paperGeo.setAttribute('aLift', this._aLiftAttr);
  }

  _buildState() {
    this.state = [];
    this._dummy = new THREE.Object3D();
    const c = this.center;

    for (let i = 0; i < this.COUNT; i++) {
      const s = {
        x: c.x + (Math.random() * 2 - 1) * this.halfX,
        z: c.z + (Math.random() * 2 - 1) * this.halfZ,
        vx: 0, vz: 0,
        yaw: Math.random() * Math.PI * 2,
        spin: (Math.random() * 2 - 1) * 1.2,
        lift: 0,
        liftFactor: 0.25 + Math.random() * 0.6,
        tiltX: 0, tiltZ: 0,
        scale: 1.0 + Math.random() * 0.5
      };
      this.state.push(s);

      this._dummy.position.set(s.x, this.RESTY, s.z);
      this._dummy.rotation.set(-Math.PI / 2, s.yaw, 0, 'YXZ');
      this._dummy.scale.setScalar(s.scale);
      this._dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this._dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  _buildWindController() {
    this.windStrength = 0;
    this.windTarget = 0;
    this.phaseTimer = 2.0;
    this.inGust = false;
    this.windDirAngle = 0;
    this.windDirTargetAngle = 0;
    this._pickNextPhase();
  }

  _pickNextPhase() {
    if (this.inGust) {
      this.inGust = false;
      this.windTarget = 0;
      this.phaseTimer = 10.0 + Math.random() * 15.0;
    } else {
      this.inGust = true;
      this.windTarget = 0.4 + Math.random() * 0.5;
      this.phaseTimer = 2.5 + Math.random() * 4.0;
      this.windDirTargetAngle = Math.random() * Math.PI * 2;
    }
  }

  /**
   * Re-center and optionally resize the scatter area, e.g. once the
   * warehouse's Floor mesh bounding box resolves.
   */
  setCenter(vec3, groundY, halfX, halfZ) {
    this.center.copy(vec3);
    if (groundY !== undefined) {
      this.RESTY = groundY + this._restYOffset;
    }
    if (halfX !== undefined) this.halfX = halfX;
    if (halfZ !== undefined) this.halfZ = halfZ;

    // Re-scatter existing instances into the new area immediately,
    // instead of waiting for them to drift/wrap into place over time.
    this._rescatter();
  }

  _rescatter() {
    const c = this.center;
    const dummy = this._dummy;
    for (let i = 0; i < this.COUNT; i++) {
      const s = this.state[i];
      s.x = c.x + (Math.random() * 2 - 1) * this.halfX;
      s.z = c.z + (Math.random() * 2 - 1) * this.halfZ;
      s.lift = 0;
      s.tiltX = 0;
      s.tiltZ = 0;

      dummy.position.set(s.x, this.RESTY, s.z);
      dummy.rotation.set(-Math.PI / 2, s.yaw, 0, 'YXZ');
      dummy.scale.setScalar(s.scale);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setVisible(v) {
    this.mesh.visible = v;
  }

  update(dt, elapsed) {
    if (!this.enabled) return;

    this.uniforms.uTime.value = elapsed;

    this.phaseTimer -= dt;
    if (this.phaseTimer <= 0) this._pickNextPhase();

    const rate = this.inGust ? 1.2 : 0.7;
    this.windStrength += (this.windTarget - this.windStrength) * Math.min(1, dt * rate);
    if (this.windStrength < 0.003) this.windStrength = 0;

    this.windDirAngle += (this.windDirTargetAngle - this.windDirAngle) * Math.min(1, dt * 0.5);
    this.uniforms.uWind.value = this.windStrength;

    const windX = Math.cos(this.windDirAngle) * this.windStrength;
    const windZ = Math.sin(this.windDirAngle) * this.windStrength;

    const c = this.center;
    const dummy = this._dummy;

    for (let i = 0; i < this.COUNT; i++) {
      const s = this.state[i];
      const turb = 0.5 + 0.5 * Math.sin(elapsed * (1.4 + s.liftFactor) + i * 1.7);

      const accel = 2.2 * turb;
      s.vx += (windX * accel - s.vx * (1.4 - this.windStrength * 0.6)) * dt;
      s.vz += (windZ * accel - s.vz * (1.4 - this.windStrength * 0.6)) * dt;
      s.x += s.vx * dt;
      s.z += s.vz * dt;

      if (s.x > c.x + this.halfX) s.x = c.x - this.halfX;
      if (s.x < c.x - this.halfX) s.x = c.x + this.halfX;
      if (s.z > c.z + this.halfZ) s.z = c.z - this.halfZ;
      if (s.z < c.z - this.halfZ) s.z = c.z + this.halfZ;

      if (this.windStrength < 0.02) {
        s.lift = Math.max(0, s.lift - dt * 1.5);
        s.vx *= 0.9;
        s.vz *= 0.9;
      } else {
        const liftTarget = this.windStrength * s.liftFactor * (0.6 + 0.4 * turb);
        const liftRate = liftTarget > s.lift ? 3.0 : 1.1;
        s.lift += (liftTarget - s.lift) * Math.min(1, dt * liftRate);
      }
      if (s.lift < 0.002) s.lift = 0;

      if (this.windStrength < 0.02) {
        s.tiltX = 0;
        s.tiltZ = 0;
      } else {
        const tiltTargetX = s.lift * 0.9 * Math.sin(elapsed * 2.0 + i);
        const tiltTargetZ = s.lift * 0.9 * Math.cos(elapsed * 1.6 + i * 0.5);
        s.tiltX += (tiltTargetX - s.tiltX) * Math.min(1, dt * 3.0);
        s.tiltZ += (tiltTargetZ - s.tiltZ) * Math.min(1, dt * 3.0);
      }
      s.yaw += s.spin * s.lift * dt;

      dummy.position.set(s.x, this.RESTY + s.lift, s.z);
      dummy.rotation.set(-Math.PI / 2 + s.tiltX, s.yaw, s.tiltZ, 'YXZ');
      dummy.scale.setScalar(s.scale);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);

      this._aLift[i] = Math.min(1, s.lift / Math.max(0.05, s.liftFactor));
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this._aLiftAttr.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    if (this.material.map) this.material.map.dispose();
    this.material.dispose();
  }
}