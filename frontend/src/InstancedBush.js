import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GRASS_VERT, BUSH_FRAG, SHADOW_VERT_INSTANCED, SHADOW_FRAG } from "./shaders/shaders.js";

/**
 * InstancedBush — renders many bushes in a single draw call.
 * Wind animation works via the shared LEAVES_VERT shader (uTime uniform).
 *
 * Usage:
 *   const ib = new InstancedBush(scene, texLoader, positions);
 *   // in loop:
 *   ib.update(elapsed, camera, scene);
 */
export class InstancedBush {
  /**
   * @param {THREE.Scene}         scene
   * @param {THREE.TextureLoader} texLoader
   * @param {Array<{x,y,z}>}      positions   - world positions for each bush
   * @param {object}              [opts]
   */
  constructor(scene, texLoader, positions, opts = {}) {
    this.scene     = scene;
    this.positions = positions;
    this._meshes   = [];   // instanced meshes added to scene
    this._mat      = null;
    this._shadowMat = null;

    this._cullDistance = opts.cullDistance ?? 120;
    this._lodDistance  = opts.lodDistance  ?? 100; // switch LOD1 -> LOD2 beyond this distance

    this._initMaterial(texLoader);
    this._load();
  }

  // ─── Materials ─────────────────────────────────────────────────────────────

_initMaterial(texLoader) {
  const tex = texLoader.load("/Bush_Leaves.png");
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  this._diffuse = tex;

  // Import GRASS_VERT/GRASS_FRAG — they are instancing-aware (USE_INSTANCING + instanceMatrix)
  this._mat = new THREE.ShaderMaterial({
    vertexShader:   GRASS_VERT,
    fragmentShader: BUSH_FRAG,
    side:           THREE.DoubleSide,
    transparent:    false,
    depthWrite:     true,
    depthTest:      true,
    uniforms: {
      uDiffuse:        { value: tex },
      uTime:           { value: 0 },
      uWindForce:      { value: 0.002 },
      uWindWavesScale: { value: 0.1 },
      uWindSpeed:      { value: 0.508 },
      uAnchorBase:     { value: false },
      uMainColor:      { value: new THREE.Color('#586a2b') },
      uSecondColor:    { value: new THREE.Color('#33401f') },
      uColor2Level:    { value: -3.0 },
      uColor2Fade:     { value: -0.1 },
      uAlphaCutoff:    { value: 0.35 },
      uLightDir:       { value: new THREE.Vector3(0, 1, 0.5).normalize() },
      uLightColor:     { value: new THREE.Color(1.0, 0.95, 0.85) },
      uAmbientColor:   { value: new THREE.Color(0.28, 0.38, 0.3) },
      uFogEnabled:     { value: false },
      uFogColor:       { value: new THREE.Color(0xffffff) },
      uFogNear:        { value: 1 },
      uFogFar:         { value: 1000 },
      uFogExp2:        { value: false },
      uFogDensity:     { value: 0.00025 },
    },
  });

  this._shadowMat = new THREE.ShaderMaterial({
    vertexShader:   SHADOW_VERT_INSTANCED,
    fragmentShader: SHADOW_FRAG,
    side:           THREE.DoubleSide,
    uniforms: {
      uTime:           { value: 0 },
      uWindForce:      { value: 0.01 },
      uWindWavesScale: { value: 0.09 },
      uWindSpeed:      { value: 0.5 },
      uAnchorBase:     { value: false },
      map:             { value: tex },
      alphaTest:       { value: 0.35 },
    },
  });

  // Far LOD material — reuses same shader/texture, wind disabled (fully static)
  this._matFar = this._mat.clone();
  this._matFar.uniforms.uWindForce = { value: 0 };
}

  // ─── Load FBX + build instanced meshes ────────────────────────────────────

_load() {
  const loader = new FBXLoader();
  loader.load(
    "/Bush.fbx",
    (fbx) => {
      const SCALE = 0.0075;
      fbx.updateMatrixWorld(true);

      const lod1Geoms = this._extractLODGeoms(fbx, SCALE, /LOD1/i);
      const lod2Geoms = this._extractLODGeoms(fbx, SCALE, /LOD2/i);

      if (lod1Geoms.length === 0) {
        console.warn("[InstancedBush] No LOD1 meshes — using ALL meshes as fallback");
        const scaleMatrix = new THREE.Matrix4().makeScale(SCALE, SCALE, SCALE);
        fbx.traverse(c => {
          if (c.isMesh) {
            const g = c.geometry.clone();
            g.applyMatrix4(scaleMatrix);
            lod1Geoms.push(g);
          }
        });
      }

      if (lod1Geoms.length === 0) {
        console.error("[InstancedBush] Still no geometry — building sphere fallback");
        this._buildFallback();
        return;
      }

      this._buildInstanced(lod1Geoms, lod2Geoms);
      console.log(
        `[InstancedBush] ${this.positions.length} bushes — LOD1: ${lod1Geoms.length} sub-mesh(es), LOD2: ${lod2Geoms.length} sub-mesh(es)`
      );
    },
    undefined,
    (err) => {
      console.error("[InstancedBush] FBX load failed:", err);
      this._buildFallback();
    }
  );
}

_extractLODGeoms(fbx, scale, lodRegex) {
  const geoms = [];
  const scaleMatrix = new THREE.Matrix4().makeScale(scale, scale, scale);

  fbx.updateMatrixWorld(true);
  fbx.traverse((child) => {
    if (!child.isMesh) return;

    // Walk up to find the nearest ancestor (or self) carrying an LODx marker
    let matches = false;
    let node = child;
    while (node) {
      const name = node.name || "";
      if (/LOD\d+/i.test(name)) {
        matches = lodRegex.test(name);
        break;
      }
      node = node.parent;
    }
    if (!matches) return;

    const g = child.geometry.clone();
    g.applyMatrix4(scaleMatrix);
    geoms.push(g);
  });
  return geoms;
}

  _buildInstancedSet(geoms, material, shadowMaterial = null) {
    const count = this.positions.length;
    const dummy = new THREE.Object3D();
    const meshes = [];

    for (const geom of geoms) {
      const mesh = new THREE.InstancedMesh(geom, material, count);
      if (shadowMaterial) mesh.customDepthMaterial = shadowMaterial;
      mesh.castShadow    = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;

      for (let i = 0; i < count; i++) {
        const { x, y, z } = this.positions[i];
        const seed  = Math.sin(i * 127.1 + 311.7) * 43758.5;
        const rotY  = (seed - Math.floor(seed)) * Math.PI * 2;
        const scale = 0.85 + ((Math.sin(i * 269.5) * 43758.5) % 1) * 0.3;

        dummy.position.set(x, y, z);
        dummy.rotation.set(0, rotY, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }

      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
      meshes.push(mesh);
    }

    return meshes;
  }

  _buildInstanced(lod1Geoms, lod2Geoms) {
    // Fallback: if no LOD2 sub-meshes were exported yet, reuse LOD1 geometry for the far tier
    const farGeoms = lod2Geoms.length ? lod2Geoms : lod1Geoms;

    this._meshesLOD1 = this._buildInstancedSet(lod1Geoms, this._mat, this._shadowMat);
    this._meshesLOD2 = this._buildInstancedSet(farGeoms, this._matFar, null);
    this._meshes = [...this._meshesLOD1, ...this._meshesLOD2];

    // per-instance LOD state: "near" | "far" | "hidden"
    this._instanceLOD = new Array(this.positions.length).fill(null);
  }

  _buildFallback() {
    // Simple sphere geometry fallback
    const geom = new THREE.SphereGeometry(0.9, 7, 6);
    this._buildInstanced([geom], []);
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  /**
   * Call once per frame.
   * @param {number}       elapsed
   * @param {THREE.Camera} camera
   * @param {THREE.Scene}  scene
   */
  update(elapsed, camera, scene) {
  this._mat.uniforms.uTime.value       = elapsed;
  this._shadowMat.uniforms.uTime.value = elapsed;
  this._syncLighting(scene);
  this._syncFog(scene);
  this._updateLOD(camera);
}

_updateLOD(camera) {
  // Only re-check every 10 frames — LOD switching doesn't need per-frame precision
  this._cullFrame = (this._cullFrame ?? 0) + 1;
  if (this._cullFrame % 10 !== 0) return;
  if (!this._instanceLOD) return; // meshes not built yet

  const camPos = camera.position;
  const dummy  = new THREE.Object3D();
  const nearSq = this._lodDistance * this._lodDistance;

  let lod1Visible = false;
  let lod2Visible = false;

  for (let i = 0; i < this.positions.length; i++) {
    const { x, y, z } = this.positions[i];
    const dx = camPos.x - x, dy = camPos.y - y, dz = camPos.z - z;
    const dsq = dx * dx + dy * dy + dz * dz;

    // Only two states now — no far-distance cull, LOD2 always shows beyond lodDistance
    const target = dsq < nearSq ? "near" : "far";
    if (target === "near") lod1Visible = true;
    if (target === "far")  lod2Visible = true;

    if (this._instanceLOD[i] === target) continue; // no change, skip matrix rewrite
    this._instanceLOD[i] = target;

    const seed  = Math.sin(i * 127.1 + 311.7) * 43758.5;
    const rotY  = (seed - Math.floor(seed)) * Math.PI * 2;
    const scale = 0.85 + ((Math.sin(i * 269.5) * 43758.5) % 1) * 0.3;

    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rotY, 0);

    // LOD1 (near, wind) — visible only when target === "near"
    dummy.scale.setScalar(target === "near" ? scale : 0);
    dummy.updateMatrix();
    for (const mesh of this._meshesLOD1) mesh.setMatrixAt(i, dummy.matrix);

    // LOD2 (far, static) — visible whenever target === "far", no upper distance limit
    dummy.scale.setScalar(target === "far" ? scale : 0);
    dummy.updateMatrix();
    for (const mesh of this._meshesLOD2) mesh.setMatrixAt(i, dummy.matrix);
  }

  for (const mesh of this._meshesLOD1) mesh.instanceMatrix.needsUpdate = true;
  for (const mesh of this._meshesLOD2) mesh.instanceMatrix.needsUpdate = true;

  for (const mesh of this._meshesLOD1) mesh.visible = lod1Visible;
  for (const mesh of this._meshesLOD2) mesh.visible = lod2Visible;
}

  _syncLighting(scene) {
    scene.traverse((obj) => {
      if (obj.isDirectionalLight) {
        const dir = new THREE.Vector3();
        obj.getWorldDirection(dir);   // shader negates internally
        for (const mat of [this._mat, this._matFar]) {
          mat.uniforms.uLightDir.value.copy(dir);
          mat.uniforms.uLightColor.value
            .copy(obj.color)
            .multiplyScalar(obj.intensity * 0.5);
        }
      }
      if (obj.isAmbientLight) {
        for (const mat of [this._mat, this._matFar]) {
          mat.uniforms.uAmbientColor.value
            .copy(obj.color)
            .multiplyScalar(obj.intensity * 0.3);
        }
      }
    });
  }

  _syncFog(scene) {
    const fog = scene.fog;
    for (const mat of [this._mat, this._matFar]) {
      if (!fog) {
        mat.uniforms.uFogEnabled.value = false;
        continue;
      }
      mat.uniforms.uFogEnabled.value = true;
      mat.uniforms.uFogColor.value.copy(fog.color);

      if (fog.isFogExp2) {
        mat.uniforms.uFogExp2.value    = true;
        mat.uniforms.uFogDensity.value = fog.density;
      } else {
        mat.uniforms.uFogExp2.value = false;
        mat.uniforms.uFogNear.value = fog.near;
        mat.uniforms.uFogFar.value  = fog.far;
      }
    }
  }

  /** Remove from scene and free GPU memory. */
  dispose() {
    for (const mesh of this._meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this._mat.dispose();
    this._matFar.dispose();
    this._shadowMat.dispose();
    this._diffuse.dispose();
    this._meshes.length = 0;
    this._meshesLOD1 = [];
    this._meshesLOD2 = [];
  }
}