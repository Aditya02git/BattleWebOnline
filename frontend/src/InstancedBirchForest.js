// InstancedBirchForest.js
// Renders all birch trees as: 1 bark draw call + 2 leaves draw calls
// (near = animated wind material, far = static material, no sway).
// Same chunk-based near/far LOD as InstancedFirForest.

import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import {
  createBirchMergedMaterial,
  createBirchMergedShadowMaterial,
  createBirchLod3Material,
  syncLighting,
} from "./materials/BirchMaterial.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export class InstancedBirchForest {
  constructor(scene, texLoader, spots, getTerrainY, opts = {}) {
    this.scene        = scene;
    this.spots        = spots;
    this.getTerrainY  = getTerrainY;
    this._renderer    = opts.renderer ?? null;
    this._snowAmount = opts.snowAmount ?? 0.0;

    this._animRadius = opts.animRadius ?? 140;
    this._chunkSize  = opts.chunkSize  ?? 40;
    this._lodDirty     = false;
    this._lastRebuild  = null;

    this._mergedMesh      = null; // single InstancedMesh: bark + leaves, 1 draw call
    this._mergedMat       = null;
    this.leavesShadowMat  = null;
    this.leavesDiffuse    = null;

    this._lod3Mesh    = null; // billboard InstancedMesh (far tier)
    this._lod3Mat     = null;
    this._lod3Geo     = null;
    this.lod3Diffuse  = null;

    this._ready           = false;

    this._buildChunks();
    this._initMaterials(texLoader);
    this._load();
  }

  // ── Chunking (for near/far LOD grouping) ──────────────────────────────────

  _buildChunks() {
    const cs  = this._chunkSize;
    const map = new Map();
    this._chunkKeyOfIndex = new Array(this.spots.length);

    this.spots.forEach(({ x, z }, i) => {
      const key = `${Math.floor(x / cs)}_${Math.floor(z / cs)}`;
      this._chunkKeyOfIndex[i] = key;
      let c = map.get(key);
      if (!c) { c = { indices: [], sumX: 0, sumZ: 0, sumY: 0 }; map.set(key, c); }
      c.indices.push(i);
      c.sumX += x;
      c.sumZ += z;
      c.sumY += this.getTerrainY(x, z); // ← needed for the chunk's frustum-test sphere center
    });

    this._chunks = [];
    this._chunkByKey = new Map(); // ← used by the fall-animation visibility guard (Fix 3)
    for (const [key, c] of map.entries()) {
      const chunk = {
        key,
        indices: c.indices,
        cx: c.sumX / c.indices.length,
        cz: c.sumZ / c.indices.length,
        avgY: c.sumY / c.indices.length, // ← was missing; fixes frustum sphere sitting at Y=0
        near: true,    // default until first updateLOD() pass corrects it
        visible: true, // default until first updateLOD() pass corrects it
      };
      this._chunks.push(chunk);
      this._chunkByKey.set(key, chunk);
    }
  }

  // ── Materials ─────────────────────────────────────────────────────────────

  _initMaterials(texLoader) {
    const loadTex = (path, srgb = true) => {
      const t = texLoader.load(path);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };

    // Bark and leaves are baked into a single texture atlas.
    // Load it once and reuse the same texture object for both roles —
    // the FBX UVs already point each vertex (leaf or bark) at the
    // correct region of this atlas, so no separate bark texture is needed.
    this.leavesDiffuse = loadTex("/Birch_Leaves.png", false);
    this.barkDiffuse   = this.leavesDiffuse;

    // Separate flat texture for the far-tier billboard (LOD3).
    this.lod3Diffuse = loadTex("/Birch_LOD3.png", false);
    // Single uber-material for merged bark+leaves geometry. Wind is gated
    // per-instance via aWindStrength (set in _rebuildNearFarBuffers).
    this._mergedMat = createBirchMergedMaterial({
      diffuse:         this.leavesDiffuse,
      barkDiffuse:     this.barkDiffuse,
      trunkColor:      new THREE.Color('#9d774f'), // brown tint multiplied over bark texture
      windWavesScale:  0.1,
      windSpeed:       0.508,
      windForce:       0.003, // near value; far handled by aWindStrength=0 per-instance
      mainColor:       new THREE.Color('#586a2b'),
      secondColor:     new THREE.Color('#33401f'),
      color2Level:     -7.5,
      color2Fade:      -0.06,
      alphaCutoff:     0.35,
      barkAlphaCutoff: 0.35,
      snowAmount:      this._snowAmount,
    });
    // this._mergedMat.defines     = { USE_INSTANCING: '' };
    // this._mergedMat.needsUpdate = true;

    this.leavesShadowMat = createBirchMergedShadowMaterial(
      this.leavesDiffuse,
      this._mergedMat,
      0.35,
      this.barkDiffuse,
      0.35,
    );

    this._lod3Mat = createBirchLod3Material({
      diffuse:     this.lod3Diffuse,
      alphaCutoff: 0.35,
      snowAmount:  this._snowAmount, 
    });
  }

  // ── Load FBX, extract LOD2 geometry, build InstancedMeshes ────────────────

  _load() {
    const loader = new FBXLoader();
    loader.load(
      "/Birch_1.fbx",
      (fbx) => {
        const lod2Meshes = [];
        const lod3Meshes = [];
        fbx.traverse((child) => {
          if (!child.isMesh) return;
          let node = child;
          while (node) {
            if (/LOD2/i.test(node.name || "")) {
              lod2Meshes.push(child);
              break;
            }
            if (/LOD3/i.test(node.name || "")) {
              lod3Meshes.push(child);
              break;
            }
            node = node.parent;
          }
        });

        if (lod2Meshes.length === 0) {
          console.warn("InstancedBirchForest: no LOD2 meshes found, falling back to all meshes");
          fbx.traverse((c) => { if (c.isMesh) lod2Meshes.push(c); });
        }
        if (lod3Meshes.length === 0) {
          console.warn("InstancedBirchForest: no LOD3 mesh found, far tier will fall back to near mesh");
        }

        const scaleMat = new THREE.Matrix4().makeScale(0.005, 0.005, 0.005);

        // LOD3 is a plain flat billboard quad — just merge whatever LOD3
        // sub-meshes exist into one geometry, no bark/leaves split needed.
        let lod3Geo = null;
        for (const mesh of lod3Meshes) {
          mesh.updateWorldMatrix(true, false);
          const geo = mesh.geometry.clone();
          geo.applyMatrix4(scaleMat);
          lod3Geo = lod3Geo ? this._mergeGeos(lod3Geo, geo) : geo;
        }

        let barkGeo   = null;
        let leavesGeo = null;

        for (const mesh of lod2Meshes) {
          mesh.updateWorldMatrix(true, false);
          const geo = mesh.geometry.clone();
          geo.applyMatrix4(scaleMat);
          const name = (mesh.name || "").toLowerCase();

          if (name.includes("bark")) {
            barkGeo = barkGeo ? this._mergeGeos(barkGeo, geo) : geo;
          } else {
            leavesGeo = leavesGeo ? this._mergeGeos(leavesGeo, geo) : geo;
          }
        }

        if (!barkGeo && !leavesGeo && lod2Meshes.length > 0) {
          const mesh = lod2Meshes[0];
          const geo  = mesh.geometry.clone();
          geo.applyMatrix4(scaleMat);
          const groups = geo.groups;
          if (groups.length >= 2) {
            barkGeo   = this._geoFromGroup(geo, groups[0]);
            leavesGeo = this._geoFromGroup(geo, groups[1]);
          } else {
            leavesGeo = geo;
          }
        }

        const mergedGeo = this._mergeBarkAndLeaves(barkGeo, leavesGeo);
        this._buildInstances(mergedGeo, lod3Geo);
      },
      undefined,
      (err) => {
        console.warn("InstancedBirchForest: FBX load failed, using procedural fallback", err);
        this._buildFallbackInstances();
      }
    );
  }

  // Tags each geometry with aIsLeaf (0 = bark, 1 = leaves) then merges them
  // into one BufferGeometry so bark + leaves render in a single draw call.
  // NOTE: mergeGeometries requires identical attribute sets across inputs —
  // if barkGeo lacks uv/normal that leavesGeo has (or vice versa), pad the
  // missing attribute with zeros before calling this, or the merge will throw.
  _mergeBarkAndLeaves(barkGeo, leavesGeo) {
  const tag = (geo, isLeaf) => {
    if (!geo) return null;
    const n = geo.attributes.position.count;
    geo.setAttribute('aIsLeaf', new THREE.BufferAttribute(new Float32Array(n).fill(isLeaf ? 1 : 0), 1));
    return geo;
  };

  const parts = [tag(barkGeo, 0), tag(leavesGeo, 1)].filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];

  // Ensure every part has the same attribute set (name + itemSize) before
  // merging — mergeGeometries silently requires this, and a mismatch here
  // (missing uv/normal on bark) is what causes a bad merged buffer, which
  // in turn produces a shader that fails to link for the depth/shadow pass.
  const required = new Map();
  for (const geo of parts) {
    for (const name of Object.keys(geo.attributes)) {
      required.set(name, geo.attributes[name].itemSize);
    }
  }
  for (const geo of parts) {
    const count = geo.attributes.position.count;
    for (const [name, itemSize] of required) {
      if (!geo.attributes[name]) {
        console.warn(`InstancedBirchForest: padding missing "${name}" attribute on a merged part`);
        geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count * itemSize), itemSize));
      }
    }
  }

  try {
    return mergeGeometries(parts, false);
  } catch (e) {
    console.warn("InstancedBirchForest: bark/leaves merge failed, using leaves geo only:", e);
    return parts[parts.length - 1];
  }
}

// Adds aHeightT: normalized [0,1] local-Y position per vertex (0 = base,
  // 1 = tip), used by MERGED_VERT to mask wind sway by height. Computed
  // once on the CPU at load time — no added per-frame cost. Required
  // because MERGED_VERT (shared with fir) now reads this attribute.
  _addHeightAttribute(geo) {
    geo.computeBoundingBox();
    const minY  = geo.boundingBox.min.y;
    const maxY  = geo.boundingBox.max.y;
    const range = Math.max(maxY - minY, 1e-6);

    const pos     = geo.attributes.position;
    const n       = pos.count;
    const heightT = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      heightT[i] = (pos.getY(i) - minY) / range;
    }
    geo.setAttribute('aHeightT', new THREE.BufferAttribute(heightT, 1));
  }

  // ── Geometry helpers ─────────────────────────────────────────────────────

  _mergeGeos(a, b) {
    try {
      return mergeGeometries([a, b], false);
    } catch (e) {
      console.warn("mergeGeometries failed:", e);
      return a;
    }
  }

  _geoFromGroup(geo, group) {
    const result = new THREE.BufferGeometry();
    const { start, count } = group;

    const srcIndex = geo.index;
    if (srcIndex) {
      const indices = srcIndex.array.slice(start, start + count);
      const min = indices.reduce((m, v) => Math.min(m, v), Infinity);
      result.setIndex(Array.from(indices).map(i => i - min));
      for (const name of Object.keys(geo.attributes)) {
        const attr = geo.attributes[name];
        const size = attr.itemSize;
        const uniqueVerts = [...new Set(indices)].sort((a,b)=>a-b);
        const arr = new Float32Array(uniqueVerts.length * size);
        uniqueVerts.forEach((vi, ni) => {
          for (let c = 0; c < size; c++) arr[ni * size + c] = attr.array[vi * size + c];
        });
        result.setAttribute(name, new THREE.BufferAttribute(arr, size));
      }
    } else {
      for (const name of Object.keys(geo.attributes)) {
        const attr = geo.attributes[name];
        const size = attr.itemSize;
        result.setAttribute(name, new THREE.BufferAttribute(
          attr.array.slice(start * size, (start + count) * size), size
        ));
      }
    }

    return result;
  }

  // ── Build InstancedMeshes (bark = single mesh, leaves = near/far split) ───

  _buildInstances(mergedGeo, lod3Geo = null) {
    const count = this.spots.length;

    this._yaw   = new Float32Array(count);
    this._origY = new Float32Array(count);
    this.spots.forEach(({ x, z }, i) => {
      this._yaw[i]   = Math.random() * Math.PI * 2;
      this._origY[i] = this.getTerrainY(x, z);
    });

    if (mergedGeo) {
      this._addHeightAttribute(mergedGeo); // ← ADD: required by shared MERGED_VERT's height-based sway mask

      this._mergedMesh = new THREE.InstancedMesh(mergedGeo, this._mergedMat, count);
      // console.log('[BirchDebug] mergedGeo attributes:', Object.keys(mergedGeo.attributes));
      // console.log('[BirchDebug] leavesShadowMat:', this.leavesShadowMat);
      this._mergedMesh.castShadow    = true;
      this._mergedMesh.receiveShadow = false;
      this._mergedMesh.frustumCulled = false;
      this._mergedMesh.customDepthMaterial = this.leavesShadowMat;

      this._windStrength = new Float32Array(count).fill(1);
      mergedGeo.setAttribute(
        'aWindStrength',
        new THREE.InstancedBufferAttribute(this._windStrength, 1)
      );

      if (this._renderer) {
        try {
          this._renderer.compile(this._mergedMesh, this._dummyCamera ?? (this._dummyCamera = new THREE.PerspectiveCamera()));
        } catch (e) {
          console.error('InstancedBirchForest: shader precompile failed:', e);
        }
      }

      this.scene.add(this._mergedMesh);
    }

    // LOD3 billboard tier — falls back to the near mesh's geometry (still
    // cheap, just not a true billboard) if no LOD3 sub-mesh was found, so
    // the far tier never silently disappears.
    this._lod3Geo = lod3Geo || mergedGeo;
    if (this._lod3Geo) {
      this._lod3Mesh = new THREE.InstancedMesh(this._lod3Geo, this._lod3Mat, count);
      this._lod3Mesh.castShadow    = false; // billboards typically skip shadow casting
      this._lod3Mesh.receiveShadow = false;
      this._lod3Mesh.frustumCulled = false;

      if (this._renderer) {
        try {
          this._renderer.compile(this._lod3Mesh, this._dummyCamera ?? (this._dummyCamera = new THREE.PerspectiveCamera()));
        } catch (e) {
          console.error('InstancedBirchForest: LOD3 shader precompile failed:', e);
        }
      }

      this.scene.add(this._lod3Mesh);
    }

    this._fallAngle   = new Float32Array(count);
    this._fallElapsed = new Float32Array(count);
    this._fallState   = new Uint8Array(count);
    this._fallingSet  = new Set();
    this._lastMatrix  = new Map();
    this._dummy       = new THREE.Object3D();

    this._rebuildNearFarBuffers();

    this._ready = true;
    console.log(`InstancedBirchForest: ${count} trees, 2 draw calls (near + LOD3)`);
  }

  _buildFallbackInstances() {
    const count = this.spots.length;

    const barkGeo   = new THREE.CylinderGeometry(0.18, 0.26, 5, 6);
    const leavesGeo = new THREE.SphereGeometry(2.5, 7, 6);
    leavesGeo.translate(0, 7.5, 0);
    barkGeo.translate(0, 2.5, 0); // fallback bark was offset by +2.5 in old dummy positioning

    const mergedGeo = this._mergeBarkAndLeaves(barkGeo, leavesGeo);

    this._yaw   = new Float32Array(count);
    this._origY = new Float32Array(count);
    this.spots.forEach(({ x, z }, i) => {
      this._yaw[i]   = Math.random() * Math.PI * 2;
      this._origY[i] = this.getTerrainY(x, z);
    });

    this._buildInstances(mergedGeo, null);

    console.log("InstancedBirchForest: procedural fallback, 1 draw call (no LOD3)");
  }

  // ── Near/far chunk LOD ─────────────────────────────────────────────────────

  updateLOD(playerPos, camera, forceAllVisible = false) {
    if (!this._ready || !this._chunks) return;

    const nearR = this._animRadius;
    const farR  = this._animRadius * 1.2; // hysteresis band avoids flicker at the near/far boundary

    // ── Chunk-level frustum test ─────────────────────────────────────────
    if (camera && !forceAllVisible) {
      if (!this._frustum) this._frustum = new THREE.Frustum();
      if (!this._frustumMat) this._frustumMat = new THREE.Matrix4();
      this._frustumMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(this._frustumMat);
    }

    const CHUNK_RADIUS            = this._chunkSize * 0.8;  // approx chunk bounding radius, with margin
    const CHUNK_RADIUS_HYSTERESIS = CHUNK_RADIUS * 1.35;     // inflated radius, used only to KEEP an already-visible chunk visible — since this only re-evaluates every 0.5s (manager-throttled), a chunk sitting right on the frustum edge could otherwise pop in/out every check as the camera pans
    const _testSphere  = this._testSphere ?? (this._testSphere = new THREE.Sphere());

    // ── Chunks containing an in-progress tree-fall animation must never be
    // culled. _rebuildNearFarBuffers() skips indices belonging to invisible
    // chunks — if a falling tree's chunk got culled mid-animation (a fall
    // takes ~2s, spanning several 0.5s LOD checks), its _packedInfo slot
    // would go stale and update() could write its matrix into whatever
    // now-unrelated instance ended up at that packed index.
    const _forcedVisibleChunks = this._fallingSet.size
      ? new Set([...this._fallingSet].map(i => this._chunkKeyOfIndex[i]))
      : null;

    const changedChunks = [];

    for (const chunk of this._chunks) {
      const dx = chunk.cx - playerPos.x;
      const dz = chunk.cz - playerPos.z;
      const dsq = dx * dx + dz * dz;

      let chunkChanged = false;

      const wasNear = chunk.near;
      if (chunk.near && dsq > farR * farR) chunk.near = false;
      else if (!chunk.near && dsq < nearR * nearR) chunk.near = true;
      if (chunk.near !== wasNear) chunkChanged = true;

      // ── Spawn-selection overview: skip the frustum test entirely and
      // force every chunk visible, regardless of where the camera is
      // pointed or where the tank last died. Normal frustum culling
      // resumes automatically on the next call with forceAllVisible=false.
      let visible = true;
      if (camera && !forceAllVisible) {
        if (_forcedVisibleChunks && _forcedVisibleChunks.has(chunk.key)) {
          visible = true;
        } else {
          _testSphere.center.set(chunk.cx, chunk.avgY ?? 0, chunk.cz);
          _testSphere.radius = chunk.visible ? CHUNK_RADIUS_HYSTERESIS : CHUNK_RADIUS;
          visible = this._frustum.intersectsSphere(_testSphere);
        }
      }
      if (chunk.visible !== visible) { chunk.visible = visible; chunkChanged = true; }

      if (chunkChanged) changedChunks.push(chunk);
    }

    // ← This is the actual fix: only touch matrices for chunks that
    // crossed a near/far or visible/invisible boundary THIS check,
    // instead of re-touching every visible tree in the whole forest.
    if (changedChunks.length) this._rebuildNearFarBuffers(changedChunks);
  }
  
  // Writes matrices only for the chunks passed in (defaults to ALL chunks,
  // used for the very first build). No more compaction/repacking — every
  // tree keeps its fixed instance slot (index i) for the mesh's lifetime.
  // Off-screen trees are represented as a zero-scale matrix instead of
  // being removed from the packed array, which is what made every camera
  // rotation trigger an O(all-visible-trees) rebuild before. A zero-scale
  // instance is a degenerate triangle — essentially free to rasterize —
  // so this costs nothing on the GPU side.
  _rebuildNearFarBuffers(chunks = this._chunks) {
    if (!this._mergedMesh) return;

    const dummy = this._dummy;
    const hasLod3 = !!this._lod3Mesh && this._lod3Mesh !== this._mergedMesh;
    const windAttr = this._mergedMesh.geometry.getAttribute('aWindStrength');

    for (const chunk of chunks) {
      for (const i of chunk.indices) {
        // Trees mid-fall are driven every frame by update()'s own
        // writeInstance() calls — never stomp their matrix here, even if
        // their chunk just got marked invisible. Falling trees always use
        // the near (animated) mesh, so force LOD3 to zero-scale for them
        // and keep wind on since they render on the near mesh.
        if (this._fallingSet.has(i)) {
          if (hasLod3) this._zeroLod3Instance(i);
          if (this._windStrength) this._windStrength[i] = 1;
          continue;
        }

        const hidden = this._fallState[i] === 3 || chunk.visible === false;
        // Near tier shows the real mesh; far tier shows the LOD3 billboard —
        // each tier zero-scales itself on the mesh it's NOT using.
        const showNear = !hidden && chunk.near;
        const showLod3 = !hidden && !chunk.near;

        if (showNear) {
          const { x, z } = this.spots[i];
          dummy.position.set(x, this._origY[i], z);
          dummy.rotation.set(0, this._yaw[i], 0);
          dummy.scale.setScalar(1);
        } else {
          dummy.position.set(0, 0, 0);
          dummy.scale.setScalar(0);
        }
        dummy.updateMatrix();
        this._mergedMesh.setMatrixAt(i, dummy.matrix);
        this._windStrength[i] = chunk.near ? 1 : 0;

        if (hasLod3) {
          if (showLod3) {
            const { x, z } = this.spots[i];
            dummy.position.set(x, this._origY[i], z);
            dummy.rotation.set(0, this._yaw[i], 0);
            dummy.scale.setScalar(1);
          } else {
            dummy.position.set(0, 0, 0);
            dummy.scale.setScalar(0);
          }
          dummy.updateMatrix();
          this._lod3Mesh.setMatrixAt(i, dummy.matrix);
        }
      }
    }

    this._mergedMesh.instanceMatrix.needsUpdate = true;
    if (windAttr) windAttr.needsUpdate = true;
    if (hasLod3) this._lod3Mesh.instanceMatrix.needsUpdate = true;
  }

  // Helper: zero-scale a single LOD3 instance (used to hide it behind a
  // falling tree, which always renders on the near/animated mesh instead).
  _zeroLod3Instance(i) {
    const dummy = this._dummy;
    dummy.position.set(0, 0, 0);
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    this._lod3Mesh.setMatrixAt(i, dummy.matrix);
  }

  // Shared by startFallAt() (explicit index, unbounded scan — fine for a
// rare, one-off shell-impact call) and tryKnockDownNear() (chunk-scoped
// search, cheap enough to poll every frame). Puts tree `i` into its
// falling animation state.
_beginFall(i, hitDirX, hitDirZ) {
  this._fallState[i]   = 1;
  this._fallElapsed[i] = 0;
  this._fallingSet.add(i);
  this._fallAngle[i]   = Math.atan2(hitDirX, hitDirZ);
  this._prevElapsed = null;
}

  startFallAt(x, z, hitDirX, hitDirZ) {
    if (!this._ready) return;
    let closest = -1;
    let bestDsq = 9;
    this.spots.forEach(({ x: sx, z: sz }, i) => {
      if (this._fallState[i] !== 0) return;
      const dsq = (sx - x) ** 2 + (sz - z) ** 2;
      if (dsq < bestDsq) { bestDsq = dsq; closest = i; }
    });
    if (closest === -1) return;
    this._beginFall(closest, hitDirX, hitDirZ);
  }

  // ── Crash-impact tree knockdown ─────────────────────────────────────────
// Chunk-scoped nearest-tree search — used by falling plane wreckage.
// Only scans the ~3x3 chunk neighborhood around (x,z) (using the same
// chunking _buildChunks() already set up for LOD) instead of the full
// this.spots array, so it's cheap enough to poll every frame/short-timer
// for however many planes are currently mid-crash. Returns true if a
// tree was knocked down.
tryKnockDownNear(x, z, hitDirX = 0, hitDirZ = 1, radius = 4) {
  if (!this._ready || !this._chunkByKey) return false;

  const cs  = this._chunkSize;
  const cx0 = Math.floor(x / cs);
  const cz0 = Math.floor(z / cs);
  const radiusSq = radius * radius;

  let closest = -1;
  let bestDsq = radiusSq;

  for (let dcx = -1; dcx <= 1; dcx++) {
    for (let dcz = -1; dcz <= 1; dcz++) {
      const chunk = this._chunkByKey.get(`${cx0 + dcx}_${cz0 + dcz}`);
      if (!chunk) continue;
      for (const i of chunk.indices) {
        if (this._fallState[i] !== 0) continue; // already falling/fallen
        const { x: sx, z: sz } = this.spots[i];
        const dsq = (sx - x) ** 2 + (sz - z) ** 2;
        if (dsq < bestDsq) { bestDsq = dsq; closest = i; }
      }
    }
  }

  if (closest === -1) return false;
  this._beginFall(closest, hitDirX, hitDirZ);
  return true;
}

  // ── Per-frame update ──────────────────────────────────────────────────────

  update(elapsed, camera, scene) {
    if (!this._ready) return;
    this._mergedMat.uniforms.uTime.value      = elapsed;
    this.leavesShadowMat.uniforms.uTime.value = elapsed;
    syncLighting(this._mergedMat, scene);

    if (this._fallingSet.size === 0) return;

    const FALL_DUR  = 1.4;
    const SINK_DEL  = 1.4;
    const SINK_DUR  = 0.6;
    const dt = this._prevElapsed != null ? elapsed - this._prevElapsed : 0;
    this._prevElapsed = elapsed;

    let dirty = false;

    const writeInstance = (i, matrix) => {
      this._mergedMesh?.setMatrixAt(i, matrix);
      dirty = true;
    };

    for (const i of this._fallingSet) {
      this._fallElapsed[i] += dt;
      const t = this._fallElapsed[i];

      const { x, z } = this.spots[i];
      const y = this._origY[i];
      const angle = this._fallAngle[i];

      const dummy = this._dummy;
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(1);

      if (t < FALL_DUR) {
        const progress = t / FALL_DUR;
        const eased    = progress * progress * (3 - 2 * progress);
        const tilt     = eased * (Math.PI / 2);
        dummy.rotation.set(Math.cos(angle) * tilt, 0, -Math.sin(angle) * tilt);
        dummy.updateMatrix();
        this._lastMatrix.set(i, dummy.matrix.clone());
        writeInstance(i, dummy.matrix);

      } else if (t < SINK_DEL + SINK_DUR) {
        const sinkT = Math.min((t - SINK_DEL) / SINK_DUR, 1);
        dummy.position.y = y - sinkT * 4;
        dummy.rotation.set(Math.cos(angle) * (Math.PI / 2), 0, -Math.sin(angle) * (Math.PI / 2));
        dummy.updateMatrix();
        this._lastMatrix.set(i, dummy.matrix.clone());
        writeInstance(i, dummy.matrix);

      } else {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        this._fallState[i] = 3;
        this._fallingSet.delete(i);
        this._lastMatrix.delete(i);
        writeInstance(i, dummy.matrix);
      }
    }

    if (dirty && this._mergedMesh) this._mergedMesh.instanceMatrix.needsUpdate = true;
  }
  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose() {
    this._mergedMesh?.geometry.dispose();
    this.scene.remove(this._mergedMesh);

    if (this._lod3Mesh && this._lod3Mesh !== this._mergedMesh) {
      this._lod3Mesh.geometry.dispose();
      this.scene.remove(this._lod3Mesh);
    }
  }
}