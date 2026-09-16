import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import {
  createDesertGrassMaterial,
  createDesertGrassShadowMaterial,
  syncDesertGrassLighting,
} from "./desertGrass/DesertGrassMaterial.js";

/**
 * InstancedGrassRenderer
 *
 * Facts extracted directly from Desert_Grass.fbx:
 *   - 1 mesh only: "Plane.001" under node "LOD 0"
 *   - No LOD1 / LOD2 nodes in this file
 *   - FBX units = centimetres  →  FBXLoader auto-applies 0.01 scale on rootnode
 *   - Raw vertex Y range: -76.96 to +280.41 cm
 *   - After 0.01 scale:   -0.770 to +2.804 m
 *   - Y_REBASE = +0.7696 shifts blade roots to Y=0
 *
 * Strategy:
 *   1. Load FBX once, clone raw geometry (no matrixWorld baking)
 *   2. Apply 0.01 unit-conversion scale to vertices
 *   3. Shift Y by +0.7696 so roots sit at Y=0
 *   4. Build ONE InstancedMesh, stamp N transforms from GrassScatter
 *   5. frustumCulled=false because InstancedMesh bounding sphere is at origin
 *
 * Performance fixes:
 *   - Scratch Matrix4 + Vector3 allocated once, reused every frame (no GC)
 *   - Positions baked into a Float32Array at load time — getMatrixAt (GPU
 *     readback) is never called in the hot update loop
 */
export class InstancedGrassRenderer {
  constructor(scene, texLoader, transforms, options = {}) {
    this._scene      = scene;
    this._transforms = transforms;
    this._onLoad     = options.onLoad ?? null;
    this._cullDist   = options.cullDistance ?? 30;
    this._visible    = null;
    this._activeCount = 0;

    // ── Pre-allocated scratch — never re-created inside update() ──────────
    this._scratchMat = new THREE.Matrix4();
    this._scratchPos = new THREE.Vector3();

    // ── Baked positions — avoids getMatrixAt() GPU readback every frame ───
    this._positions  = new Float32Array(transforms.length * 3);
    for (let i = 0; i < transforms.length; i++) {
      this._scratchPos.setFromMatrixPosition(transforms[i]);
      this._positions[i * 3 + 0] = this._scratchPos.x;
      this._positions[i * 3 + 1] = this._scratchPos.y;
      this._positions[i * 3 + 2] = this._scratchPos.z;
    }

    this._mesh          = null;
    this.grassMat       = null;
    this.grassShadowMat = null;
    this.grassDiffuse   = null;

    this._initMaterials(texLoader);
    this._load();
  }

  // ─── Materials ─────────────────────────────────────────────────────────────

  _initMaterials(texLoader) {
    const loadTex = (path, srgb = true) => {
      const t = texLoader.load(path);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };

    this.grassDiffuse = loadTex("/Desert_Grass.png", false);

    this.grassMat = createDesertGrassMaterial({
      diffuse:           this.grassDiffuse,
      windForce:         0.02,
      windWavesScale:    0.12,
      windSpeed:         0.4,
      anchorBase:        true,
      mainColor:         new THREE.Color('#0f2c00'),
      secondColor:       new THREE.Color('#2e2f00'),
      color2Level:       -2.0,
      color2Fade:        -0.1,
      alphaCutoff:       0.35,
      smoothness:        0.12,
      translucencyInt:   5.0,
      directLightOffset: 0,
      directLightInt:    1,
      indirectLightInt:  1,
    });

    this.grassShadowMat = createDesertGrassShadowMaterial(
      this.grassDiffuse,
      this.grassMat,
      0.35,
    );
  }

  // ─── Load FBX ──────────────────────────────────────────────────────────────

  _load() {
    const loader = new FBXLoader();
    loader.load("/Desert_Grass.fbx", (fbx) => {

      // FBXLoader already converts cm→m internally on the geometry vertices.
      // Do NOT apply fbx.scale — that value (100) is a display hint, not a vertex multiplier.
      // The raw geometry is already in metres.

      const geoms = [];
      fbx.traverse((child) => {
        if (!child.isMesh) return;
        geoms.push(child.geometry);
      });

      if (geoms.length === 0) {
        console.warn("[GrassInst] No meshes found in FBX, using fallback");
        this._buildFallback();
        return;
      }

      const merged = this._mergeGeometries(geoms);

      // Rebase Y so blade roots sit at exactly Y=0
      merged.computeBoundingBox();
      const minY = merged.boundingBox.min.y;
      const pos  = merged.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        pos.setY(i, pos.getY(i) - minY);
      }
      pos.needsUpdate = true;
      merged.computeBoundingBox();

      console.log(`[GrassInst] minY was ${minY.toFixed(4)}m, rebased to 0`);
      console.log(`[GrassInst] blade height after rebase: ${merged.boundingBox.max.y.toFixed(3)}m`);
      console.log(`[GrassInst] building InstancedMesh with ${this._transforms.length} instances`);

      const mesh = new THREE.InstancedMesh(
        merged,
        this.grassMat,
        this._transforms.length,
      );
      mesh.castShadow    = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;

      for (let i = 0; i < this._transforms.length; i++) {
        mesh.setMatrixAt(i, this._transforms[i]);
      }
      mesh.instanceMatrix.needsUpdate = true;

      this._scene.add(mesh);
      this._mesh = mesh;

      this._visible = new Uint8Array(this._transforms.length);
      this._visible.fill(1);

      this._onLoad?.();
    },
    undefined,
    (err) => {
      console.warn("[GrassInst] FBX load failed, using fallback:", err);
      this._buildFallback();
    });
  }

  // ─── Geometry merge ────────────────────────────────────────────────────────

  _mergeGeometries(geoms) {
    const attrs  = ['position', 'normal', 'uv'];
    const total  = geoms.reduce((s, g) => s + (g.attributes.position?.count ?? 0), 0);
    const merged = new THREE.BufferGeometry();

    for (const attr of attrs) {
      if (!geoms[0].attributes[attr]) continue;
      const itemSize = geoms[0].attributes[attr].itemSize;
      const arr      = new Float32Array(total * itemSize);
      let offset     = 0;
      for (const g of geoms) {
        const src = g.attributes[attr]?.array;
        if (src) arr.set(src, offset);
        offset += (g.attributes[attr]?.count ?? 0) * itemSize;
      }
      merged.setAttribute(attr, new THREE.BufferAttribute(arr, itemSize));
    }

    const allIndexed = geoms.every(g => g.index);
    if (allIndexed) {
      let vtxOffset = 0;
      const indices = [];
      for (const g of geoms) {
        const idx = g.index.array;
        for (let i = 0; i < idx.length; i++) indices.push(idx[i] + vtxOffset);
        vtxOffset += g.attributes.position.count;
      }
      merged.setIndex(indices);
    }

    return merged;
  }

  // ─── Fallback ──────────────────────────────────────────────────────────────

  _buildFallback() {
    const p1 = new THREE.PlaneGeometry(0.5, 1.0);
    const p2 = p1.clone();
    p2.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
    [p1, p2].forEach(p => {
      const pos = p.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + 0.5);
      pos.needsUpdate = true;
    });
    const merged = this._mergeGeometries([p1, p2]);
    p1.dispose();
    p2.dispose();

    const mesh = new THREE.InstancedMesh(merged, this.grassMat, this._transforms.length);
    for (let i = 0; i < this._transforms.length; i++) mesh.setMatrixAt(i, this._transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    this._scene.add(mesh);
    this._mesh = mesh;

    this._visible = new Uint8Array(this._transforms.length);
    this._visible.fill(1);

    this._onLoad?.();
  }

  // ─── Per-frame update ──────────────────────────────────────────────────────

  
  // REPLACE the entire update() method with this:
update(elapsed, camera, scene) {
  if (!this._mesh || !this.grassMat) return;

  this.grassMat.uniforms.uTime.value       = elapsed;
  this.grassShadowMat.uniforms.uTime.value = elapsed;
  syncDesertGrassLighting(this.grassMat, scene);

  const cullDistSq = this._cullDist * this._cullDist;
  const camX       = camera.position.x;
  const camZ       = camera.position.z;

  let slot = 0;  // next free slot in the compact buffer

  for (let i = 0; i < this._transforms.length; i++) {
    const px  = this._positions[i * 3 + 0];
    const pz  = this._positions[i * 3 + 2];
    const dx  = px - camX;
    const dz  = pz - camZ;

    if (dx * dx + dz * dz > cullDistSq) continue;  // skip — outside range

    this._mesh.setMatrixAt(slot, this._transforms[i]);
    slot++;
  }

  // Only draw the instances that are actually in range
  this._mesh.count              = slot;
  this._mesh.instanceMatrix.needsUpdate = true;
}

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  dispose() {
    if (this._mesh) {
      this._scene.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._mesh = null;
    }
    this.grassMat?.dispose();
    this.grassShadowMat?.dispose();
    this.grassDiffuse?.dispose();
  }
}