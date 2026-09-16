// InstancedMapleForest.js
// Renders all maple trees as: 1 trunk+leaf draw call (near = animated wind
// material, far = static billboard, no sway).
// Trees are grouped into world-space chunks; every ~0.5s the manager
// reassigns whole chunks between near/far based on distance to the tank.

import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  createMapleMergedMaterial,
  createMapleMergedShadowMaterial,
  createMapleLod3Material,
  syncMapleLighting,
} from "./materials/MapleMaterial.js";

export class InstancedMapleForest {
  constructor(scene, texLoader, spots, getTerrainY, opts = {}) {
    this.scene       = scene;
    this.spots       = spots;
    this.getTerrainY = getTerrainY;

    this._animRadius = opts.animRadius ?? 140;
    this._chunkSize  = opts.chunkSize  ?? 40;
    this._renderer   = opts.renderer ?? null;
    this._snowAmount = opts.snowAmount ?? 0.0;

    this._mergedMesh   = null; // single InstancedMesh: trunk + leaves, 1 draw call (near tier)
    this._mergedMat    = null;
    this.leafShadowMat = null;
    this.leafDiffuse   = null;

    this._lod3Mesh        = null; // billboard InstancedMesh (far tier)
    this._lod3Mat         = null;
    this._lod3Geo         = null;
    this.lod3Diffuse      = null;

    this._ready          = false;

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
      c.sumY += this.getTerrainY(x, z); // needed for the chunk's frustum-test sphere center
    });

    this._chunks = [];
    this._chunkByKey = new Map(); // used by the fall-animation forced-visibility guard
    for (const [key, c] of map.entries()) {
      const chunk = {
        key,
        indices: c.indices,
        cx: c.sumX / c.indices.length,
        cz: c.sumZ / c.indices.length,
        avgY: c.sumY / c.indices.length,
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

    // Leaf atlas — used for the near-tier canopy. No separate baked bark
    // atlas is supplied for maple, so the trunk falls back to a flat
    // uTrunkColor tint (see createMapleMergedMaterial's uUseBarkMap guard).
this.leafDiffuse = loadTex("/Maple_Leaves.png", false);
this.barkDiffuse = this.leafDiffuse; // reuse the leaf atlas as the bark texture too

    // Separate flat texture for the far-tier billboard (LOD3).
    this.lod3Diffuse = loadTex("/Maple_LOD3.png", false);

    // No Snow_Maple.png yet — snowTex stays null so uUseSnowTex is false;
    // this keeps the constructor signature/opts identical to the other
    // forests so InstancedForestManager can drive it uniformly.
    this.snowTex = null;

    // Single uber-material for merged trunk+leaf geometry. Wind is gated
    // per-instance via aWindStrength (set in _rebuildNearFarBuffers)
    // instead of by swapping materials/meshes.
    this._mergedMat = createMapleMergedMaterial({
      diffuse:         this.leafDiffuse,
      barkDiffuse:     this.barkDiffuse,
      trunkColor:      new THREE.Color('#4a3323'), // brown trunk tint (no bark texture)
      windWavesScale:  0.1,
      windSpeed:       0.6,
      windForce:       0.003, // near value; far handled by aWindStrength=0 per-instance
      mainColor:       new THREE.Color('#586a2b'),
      secondColor:     new THREE.Color('#33401f'),
      color2Level:     -7.5,
      color2Fade:      -0.06,
      alphaCutoff:     0.35,
      barkAlphaCutoff: 0.35,
      snowAmount:      this._snowAmount,
      snowTex:         this.snowTex,
    });
    // USE_INSTANCING is auto-defined by Three.js for InstancedMesh — no manual override needed.

    this.leafShadowMat = createMapleMergedShadowMaterial(
      this.leafDiffuse,
      this._mergedMat,
      0.95,
      this.barkDiffuse,
      0.35,
    );

    this._lod3Mat = createMapleLod3Material({
      diffuse:     this.lod3Diffuse,
      alphaCutoff: 0.35,
    });
  }

  // ── Load FBX, extract LOD2, build InstancedMeshes ─────────────────────────

  _load() {
    const loader = new FBXLoader();
    loader.load(
      "/Maple.fbx",
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
          console.warn("InstancedMapleForest: no LOD2 meshes found, falling back to all meshes");
          fbx.traverse((c) => { if (c.isMesh) lod2Meshes.push(c); });
        }
        if (lod3Meshes.length === 0) {
          console.warn("InstancedMapleForest: no LOD3 mesh found, far tier will fall back to near mesh");
        }

        const scaleMat = new THREE.Matrix4().makeScale(0.005, 0.005, 0.005);

        // LOD3 is a plain flat billboard quad — no trunk/leaf split needed,
        // just merge whatever LOD3 sub-meshes exist into one geometry.
        let lod3Geo = null;
        for (const mesh of lod3Meshes) {
          mesh.updateWorldMatrix(true, false);
          const geo = mesh.geometry.clone();
          geo.applyMatrix4(scaleMat);
          lod3Geo = lod3Geo ? this._mergeGeos(lod3Geo, geo) : geo;
        }

        let trunkGeo = null;
        let leafGeo  = null;

        for (const mesh of lod2Meshes) {
          mesh.updateWorldMatrix(true, false);
          const geo  = mesh.geometry.clone();
          geo.applyMatrix4(scaleMat);
          const name = (mesh.name || "").toLowerCase();

          const isTrunk = name.includes("trunk") || name.includes("bark") || name.includes("stem");
          if (isTrunk) {
            trunkGeo = trunkGeo ? this._mergeGeos(trunkGeo, geo) : geo;
          } else {
            leafGeo  = leafGeo  ? this._mergeGeos(leafGeo,  geo) : geo;
          }
        }

        if (!trunkGeo && !leafGeo && lod2Meshes.length > 0) {
          const mesh   = lod2Meshes[0];
          const geo    = mesh.geometry.clone();
          geo.applyMatrix4(scaleMat);
          const groups = geo.groups;
          if (groups.length >= 2) {
            trunkGeo = this._geoFromGroup(geo, groups[0]);
            leafGeo  = this._geoFromGroup(geo, groups[1]);
          } else {
            leafGeo = geo;
          }
        }

        const mergedGeo = this._mergeTrunkAndLeaf(trunkGeo, leafGeo);
        this._buildInstances(mergedGeo, lod3Geo);
      },
      undefined,
      (err) => {
        console.warn("InstancedMapleForest: FBX load failed, using procedural fallback", err);
        this._buildFallbackInstances();
      }
    );
  }

  // Tags each geometry with aIsLeaf (0 = trunk, 1 = leaf) then merges them
  // into one BufferGeometry so trunk + leaves render in a single draw call.
  // NOTE: mergeGeometries requires identical attribute sets across inputs —
  // if trunkGeo lacks uv/normal that leafGeo has (or vice versa), pad the
  // missing attribute with zeros before calling this, or the merge will throw.
  _mergeTrunkAndLeaf(trunkGeo, leafGeo) {
    const tag = (geo, isLeaf) => {
      if (!geo) return null;
      const n = geo.attributes.position.count;
      geo.setAttribute('aIsLeaf', new THREE.BufferAttribute(new Float32Array(n).fill(isLeaf ? 1 : 0), 1));
      return geo;
    };
    const parts = [tag(trunkGeo, 0), tag(leafGeo, 1)].filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    try {
      return mergeGeometries(parts, false);
    } catch (e) {
      console.warn("InstancedMapleForest: trunk/leaf merge failed, using leaf geo only:", e);
      return parts[parts.length - 1];
    }
  }

  // Adds aHeightT: normalized [0,1] local-Y position per vertex (0 = base,
  // 1 = tip), used by the shader to mask wind sway by height instead of by
  // aIsLeaf. Computed once on the CPU at load time — no added per-frame cost.
  _addHeightAttribute(geo) {
    geo.computeBoundingBox();
    const minY   = geo.boundingBox.min.y;
    const maxY   = geo.boundingBox.max.y;
    const range  = Math.max(maxY - minY, 1e-6);

    const pos      = geo.attributes.position;
    const n        = pos.count;
    const heightT  = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      heightT[i] = (pos.getY(i) - minY) / range;
    }
    geo.setAttribute('aHeightT', new THREE.BufferAttribute(heightT, 1));
  }

  // ── Geometry helpers ──────────────────────────────────────────────────────

  _mergeGeos(a, b) {
    try {
      return mergeGeometries([a, b], false);
    } catch (e) {
      console.warn("InstancedMapleForest: mergeGeometries failed:", e);
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
        const attr        = geo.attributes[name];
        const size        = attr.itemSize;
        const uniqueVerts = [...new Set(indices)].sort((a, b) => a - b);
        const arr         = new Float32Array(uniqueVerts.length * size);
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

  // ── Build InstancedMeshes (trunk+leaf merged mesh, near/far split) ────────

  _buildInstances(mergedGeo, lod3Geo = null) {
    const count = this.spots.length;

    this._yaw   = new Float32Array(count);
    this._origY = new Float32Array(count);
    this._scale = new Float32Array(count); // per-instance height/size variation
    this.spots.forEach(({ x, z }, i) => {
      this._yaw[i]   = Math.random() * Math.PI * 2;
      this._origY[i] = this.getTerrainY(x, z);
      this._scale[i] = 0.8 + Math.random() * 0.4; // uniform scale 0.8–1.2
    });

    if (mergedGeo) {
      this._addHeightAttribute(mergedGeo); // per-vertex height mask for wind

      this._mergedMesh = new THREE.InstancedMesh(mergedGeo, this._mergedMat, count);
      this._mergedMesh.castShadow    = true;
      this._mergedMesh.receiveShadow = false;
      this._mergedMesh.frustumCulled = false;
      this._mergedMesh.customDepthMaterial = this.leafShadowMat;

      // Per-instance wind strength: 1 = animate (near), 0 = static (far).
      // Updated live in _rebuildNearFarBuffers as chunks change tier.
      this._windStrength = new Float32Array(count).fill(1);
      mergedGeo.setAttribute(
        'aWindStrength',
        new THREE.InstancedBufferAttribute(this._windStrength, 1)
      );

      if (this._renderer) {
        try {
          this._renderer.compile(this._mergedMesh, this._dummyCamera ?? (this._dummyCamera = new THREE.PerspectiveCamera()));
        } catch (e) {
          console.error('InstancedMapleForest: shader precompile failed:', e);
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
          console.error('InstancedMapleForest: LOD3 shader precompile failed:', e);
        }
      }

      this.scene.add(this._lod3Mesh);
    }

    this._fallAngle   = new Float32Array(count);
    this._fallElapsed = new Float32Array(count);
    this._fallState   = new Uint8Array(count);
    this._fallingSet  = new Set();
    this._lastMatrix  = new Map(); // index → Matrix4, for trees mid-fall during a rebuild
    this._dummy       = new THREE.Object3D();

    this._rebuildNearFarBuffers();

    this._ready = true;
    console.log(`InstancedMapleForest: ${count} trees, 2 draw calls (near + LOD3)`);
  }

  _buildFallbackInstances() {
    const count = this.spots.length;

    const trunkGeo = new THREE.CylinderGeometry(0.15, 0.22, 4, 6);
    const leafGeo  = new THREE.SphereGeometry(2.6, 8, 6);
    leafGeo.translate(0, 6.5, 0);
    trunkGeo.translate(0, 2.0, 0);

    const mergedGeo = this._mergeTrunkAndLeaf(trunkGeo, leafGeo);

    this._yaw   = new Float32Array(count);
    this._origY = new Float32Array(count);
    this._scale = new Float32Array(count);
    this.spots.forEach(({ x, z }, i) => {
      this._yaw[i]   = Math.random() * Math.PI * 2;
      this._origY[i] = this.getTerrainY(x, z);
      this._scale[i] = 0.8 + Math.random() * 0.4;
    });

    this._buildInstances(mergedGeo, null);

    console.log("InstancedMapleForest: procedural fallback");
  }

  // ── Near/far chunk LOD ─────────────────────────────────────────────────────

  /** Call throttled (e.g. every 0.5s), not every frame. */
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

    const CHUNK_RADIUS            = this._chunkSize * 0.8;
    const CHUNK_RADIUS_HYSTERESIS = CHUNK_RADIUS * 1.35;
    const _testSphere  = this._testSphere ?? (this._testSphere = new THREE.Sphere());

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

    if (changedChunks.length) this._rebuildNearFarBuffers(changedChunks);
  }

  // Writes matrices only for the chunks passed in (defaults to ALL chunks,
  // used for the very first build). Every tree keeps its fixed instance slot
  // (index i) for the mesh's lifetime; off-screen trees are zero-scaled
  // instead of removed/repacked (a degenerate triangle — essentially free
  // to rasterize).
  _rebuildNearFarBuffers(chunks = this._chunks) {
    if (!this._mergedMesh) return;

    const dummy = this._dummy;
    const hasLod3 = !!this._lod3Mesh && this._lod3Mesh !== this._mergedMesh;
    const windAttr = this._mergedMesh.geometry.getAttribute('aWindStrength');

    for (const chunk of chunks) {
      for (const i of chunk.indices) {
        // Trees mid-fall are driven every frame by update()'s own
        // writeInstance() calls — never stomp their matrix here.
        if (this._fallingSet.has(i)) {
          if (hasLod3) this._zeroLod3Instance(i);
          if (this._windStrength) this._windStrength[i] = 1;
          continue;
        }

        const hidden = this._fallState[i] === 3 || chunk.visible === false;
        const showNear = !hidden && chunk.near;
        const showLod3 = !hidden && !chunk.near;

        if (showNear) {
          const { x, z } = this.spots[i];
          dummy.position.set(x, this._origY[i], z);
          dummy.rotation.set(0, this._yaw[i], 0);
          dummy.scale.setScalar(this._scale[i]);
        } else {
          dummy.position.set(0, 0, 0);
          dummy.scale.setScalar(0);
        }
        dummy.updateMatrix();
        this._mergedMesh.setMatrixAt(i, dummy.matrix);
        if (this._windStrength) this._windStrength[i] = chunk.near ? 1 : 0;

        if (hasLod3) {
          if (showLod3) {
            const { x, z } = this.spots[i];
            dummy.position.set(x, this._origY[i], z);
            dummy.rotation.set(0, this._yaw[i], 0);
            dummy.scale.setScalar(this._scale[i]);
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

  // Shared by startFallAt() (explicit index, unbounded scan) and
  // tryKnockDownNear() (chunk-scoped search). Puts tree `i` into its
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
  // Chunk-scoped nearest-tree search — only scans the ~3x3 chunk
  // neighborhood around (x,z), cheap enough to poll every frame/short-timer.
  // Returns true if a tree was knocked down.
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
    this._mergedMat.uniforms.uTime.value    = elapsed;
    this.leafShadowMat.uniforms.uTime.value = elapsed;
    syncMapleLighting(this._mergedMat, scene);

    if (this._fallingSet.size === 0) return;

    const FALL_DUR = 1.4;
    const SINK_DEL = 1.4;
    const SINK_DUR = 0.6;
    const dt = this._prevElapsed != null ? elapsed - this._prevElapsed : 0;
    this._prevElapsed = elapsed;

    let dirty = false;

    const writeInstance = (i, matrix) => {
      this._mergedMesh?.setMatrixAt(i, matrix);
      dirty = true;
    };

    for (const i of this._fallingSet) {
      this._fallElapsed[i] += dt;
      const t     = this._fallElapsed[i];
      const { x, z } = this.spots[i];
      const y     = this._origY[i];
      const angle = this._fallAngle[i];

      const dummy = this._dummy;
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(this._scale[i]);

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