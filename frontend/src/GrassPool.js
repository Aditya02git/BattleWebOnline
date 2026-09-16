import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  createGrassMaterial,
  createGrassShadowMaterial,
  syncGrassLighting,
  MAX_GRASS_IMPACTS,
} from './materials/GrassMaterial.js';
import {
  createFlowersMaterial,
  createFlowersShadowMaterial,
  syncFlowersLighting,
} from './materials/FlowersMaterial.js';

const TERRAIN_SIZE     = 600;
const GRASS_Y_MIN      = 0.0;
const GRASS_LOD_RADIUS = 90;
const GRASS_CHUNK_SIZE = 40; // meters per chunk — grass is grouped spatially and culled per-chunk, not per-instance
const MAX_TRIES        = 20;
const COLOR_THRESHOLD  = 20;
const GRASS_CULL_CAMERA_Y = 25;
const GRASS_CULL_FADE_BAND = 25;

// ── Furrow-aligned flower placement ─────────────────────────────────────
const FURROW_LINE_SPACING  = 3.0;  // world units between furrow rows — tune to match the furrow texture's visual line spacing
const FURROW_FILL_STEP = 3.0; // world units between grid samples for continuous flower coverage — smaller = denser, no gaps


const FURROW_ALONG_JITTER  = 0.0;  // jitter along the row so flowers don't look evenly spaced like beads
const FURROW_ACROSS_JITTER = 0.0;  // small jitter across the row so they hug it without looking glued on

function colorDist(a, b) {
  return Math.sqrt((a.r-b.r)**2 + (a.g-b.g)**2 + (a.b-b.b)**2);
}
function isBlackOrWhite(c) {
  const brightness = (c.r+c.g+c.b)/3;
  const spread = Math.max(c.r,c.g,c.b) - Math.min(c.r,c.g,c.b);
  return spread < 40 && (brightness < 40 || brightness > 215);
}
function isGreen(c) {
  return c.g > 100 && c.g > c.r*1.3 && c.g > c.b*1.3;
}
function toThreeColor(c) {
  return new THREE.Color(c.r/255, c.g/255, c.b/255);
}

export class GrassPool {
  constructor(scene, texLoader, opts = {}) {
    this._scene       = scene;
    this._getY        = opts.getTerrainY ?? (() => 0);
    this._terrain     = opts.terrain     ?? null;
    this._grassCount  = opts.grassCount  ?? 2000;
    this._flowerCount = opts.flowerCount ?? 500;

    // Pre-allocated scratch objects — never re-allocated inside loop
    this._mat4       = new THREE.Matrix4();
    this._frustum    = new THREE.Frustum();
    this._frustumMat = new THREE.Matrix4();
    this._frustumPt  = new THREE.Vector3();
    this._visibility = {};

    this._grassChunks    = [];   // [{ mesh, centerX, centerZ, radius }]
    this._grassPositions = [];
    this._grassReady     = false;
    this._highCulled     = false; 

    // ── Impact ring buffer — fixed-size, no allocation per shot. Newest
    // impact overwrites the oldest slot once the buffer is full.
    this._elapsed        = 0;
    this._impactData     = Array.from({ length: MAX_GRASS_IMPACTS }, () => new THREE.Vector4(0, 0, -9999, 0));
    this._impactWriteIdx = 0;
    this._impactCount    = 0;

    this._flowerClusters = [];
    this._clustersBuilt  = false;

    this._grassMat       = null;
    this._grassShadowMat = null;
    this._grassDiffuse   = null;
    this._flowerDiffuse  = null;
    this._grassGeo       = null;
    this._flowerGeo      = null;

    this._initMaterials(texLoader);
    this._loadGeo(texLoader);
  }

  // ─── Materials ─────────────────────────────────────────────────────────────

  _initMaterials(texLoader) {
    const loadTex = (path) => {
      const t = texLoader.load(path);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    };

    this._grassDiffuse = loadTex('/Grass_1.png');
    this._grassMat = createGrassMaterial({
      diffuse:           this._grassDiffuse,
      windForce:         0.01,
      windWavesScale:    0.3,
      windSpeed:         0.4,
      anchorBase:        true,
      mainColor:         new THREE.Color('#586a2b'),   // ← was implicit default, now dirt-matched base
      secondColor:       new THREE.Color('#33401f'),   // ← was '#5f642e' == mainColor, gradient was inert
      color2Level:      -0.29,
      color2Fade:        0.64,
      alphaCutoff:       0.35,
      smoothness:        0.1,
      translucencyInt:   2.0,
      directLightOffset: 0.0,
      directLightInt:    1.0,
      indirectLightInt:  1.0,
      impactDuration:    1.6,   // ← ADD — was defaulting to 0.8
      impactDecay:       1.5,   // ← ADD — was defaulting to 4.0
    });

    // ← ADD THESE 2 LINES: share the same impact buffer flowers already use
    this._grassMat.uniforms.uImpactData.value = this._impactData;

    this._grassShadowMat = createGrassShadowMaterial(
    this._grassDiffuse, this._grassMat, 0.35
    );
    this._flowerDiffuse = loadTex('/Flowers.png');
  }

  // ─── Geometry loading ──────────────────────────────────────────────────────

  _loadGeo() {
    let grassDone = false, flowerDone = false;
    const tryScatter = () => {
      if (grassDone && flowerDone) this._waitForMaskThenScatter();
    };

    new FBXLoader().load('/Grass_1.fbx',
      (fbx) => { this._grassGeo = this._extractGeo(fbx); grassDone = true; tryScatter(); },
      undefined,
      () => {
        const g = new THREE.PlaneGeometry(0.5, 0.8, 1, 4);
        g.rotateY(Math.PI / 4);
        this._grassGeo = g; grassDone = true; tryScatter();
      }
    );

    new FBXLoader().load('/Flowers.fbx',
      (fbx) => { this._flowerGeo = this._extractGeo(fbx); flowerDone = true; tryScatter(); },
      undefined,
      () => {
        this._flowerGeo = new THREE.PlaneGeometry(0.4, 0.7, 1, 4);
        flowerDone = true; tryScatter();
      }
    );
  }

  _extractGeo(fbx) {
    fbx.scale.setScalar(0.01);
    fbx.updateMatrixWorld(true);
    const geos = [];
    fbx.traverse((child) => {
      if (!child.isMesh) return;
      let skip = false, node = child;
      while (node) {
        const n = node.name || '';
        if (/LOD1|LOD2|Culled/i.test(n)) { skip = true; break; }
        if (/LOD0/i.test(n)) break;
        node = node.parent;
      }
      if (skip) return;
      child.updateMatrixWorld(true);
      const c = child.geometry.clone();
      c.applyMatrix4(child.matrixWorld);
      geos.push(c);
    });
    if (geos.length === 0) {
      fbx.traverse((child) => {
        if (!child.isMesh) return;
        child.updateMatrixWorld(true);
        const c = child.geometry.clone();
        c.applyMatrix4(child.matrixWorld);
        geos.push(c);
      });
    }
    return geos.length === 1 ? geos[0] : this._mergeGeos(geos);
  }

  _mergeGeos(geos) {
    let totalVerts = 0, totalIdx = 0;
    for (const g of geos) {
      totalVerts += g.attributes.position.count;
      if (g.index) totalIdx += g.index.count;
    }
    const positions = new Float32Array(totalVerts * 3);
    const normals   = new Float32Array(totalVerts * 3);
    const uvs       = new Float32Array(totalVerts * 2);
    const indices   = totalIdx > 0 ? new Uint32Array(totalIdx) : null;
    let ii = 0, vBase = 0;
    for (const g of geos) {
      const cnt = g.attributes.position.count;
      positions.set(g.attributes.position.array, vBase * 3);
      if (g.attributes.normal) normals.set(g.attributes.normal.array, vBase * 3);
      if (g.attributes.uv)     uvs.set(g.attributes.uv.array, vBase * 2);
      if (g.index && indices) {
        for (const idx of g.index.array) indices[ii++] = idx + vBase;
      }
      vBase += cnt;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal',   new THREE.BufferAttribute(normals,   3));
    merged.setAttribute('uv',       new THREE.BufferAttribute(uvs,       2));
    if (indices) merged.setIndex(new THREE.BufferAttribute(indices, 1));
    return merged;
  }

  // ─── Wait for mask ─────────────────────────────────────────────────────────

  _waitForMaskThenScatter() {
    // Also wait for the terrain's furrow field map (used by _alignToFurrow)
    // — _furrowFieldMapReady is set on success AND failure, so this never
    // hangs forever if the furrow bake errors out.
    const ready = () =>
      !this._terrain || (this._terrain._maskCanvas && this._terrain._furrowFieldMapReady);

    if (ready()) { this._scatter(); return; }
    const interval = setInterval(() => {
      if (ready()) {
        clearInterval(interval);
        this._scatter();
      }
    }, 100);
  }

  // ─── Furrow-aligned placement ────────────────────────────────────────────
  // Snaps (x,z) onto the nearest furrow "row" for whichever field it falls
  // in, using the SAME per-field rotation TerrainBuilder baked into the
  // furrow normal map — so flowers read as growing along the furrow lines
  // instead of scattering randomly. Points outside any furrow field (or
  // before the map is ready) pass through unchanged.
  _alignToFurrow(x, z) {
    const rot = this._terrain?.getFurrowRotation?.(x, z);
    if (!rot) return { x, z };

    const { cos, sin } = rot;

    // World -> this field's rotated local space
    const rx = x * cos - z * sin;
    const rz = x * sin + z * cos;

    // Rows run parallel to the field's local Z axis — snap the
    // across-furrow coordinate (rx) to the nearest row.
    const snappedRx = Math.round(rx / FURROW_LINE_SPACING) * FURROW_LINE_SPACING
                     + (Math.random() - 0.5) * FURROW_ACROSS_JITTER;
    const jitteredRz = rz + (Math.random() - 0.5) * FURROW_ALONG_JITTER;

    // Rotated local space -> world
    return {
      x: snappedRx * cos + jitteredRz * sin,
      z: -snappedRx * sin + jitteredRz * cos,
    };
  }

  // ─── Scatter ───────────────────────────────────────────────────────────────

  _scatter() {
    const totalSpots   = this._grassCount + this._flowerCount;
    const grassSpots   = [];
    const colorBuckets = [];

    const findCluster = (c) => {
      for (const b of colorBuckets) {
        if (colorDist(b.color, c) < COLOR_THRESHOLD) return b;
      }
      return null;
    };

    for (let i = 0; i < totalSpots; i++) {
      const pos = this._samplePosition();
      if (!pos) continue;
      const [x, z, y] = pos;

      const pixel = this._terrain?.getMaskPixel(x, z);
      if (!pixel) { grassSpots.push({ x, y, z }); continue; }
      if (isBlackOrWhite(pixel)) continue;
      if (isGreen(pixel)) { grassSpots.push({ x, y, z }); continue; }

      continue; // flower placement for colored regions is handled by _fillFurrowRows below, after this loop
    }

    this._fillFurrowRows(colorBuckets, findCluster);

    const allGrassSpots = [
      ...grassSpots,
      ...colorBuckets.flatMap(b => b.grassSpots),
    ];
    this._grassPositions = allGrassSpots.map(p => ({
      ...p,
      sx:    1.5 + Math.random() * 0.3,
      sy:    1.5 + Math.random() * 0.3,
      angle: Math.random() * Math.PI * 2,
    }));
    this._grassChunks = this._buildChunks(
      this._grassPositions, this._grassGeo, this._grassMat, this._grassShadowMat
    );
    this._grassReady = true;

    for (const bucket of colorBuckets) {
      if (bucket.flowerSpots.length === 0) continue;
      const flowerColor = toThreeColor(bucket.color);
      const mat = createFlowersMaterial({
        diffuse:           this._flowerDiffuse,
        windForce:         0.01,
        windWavesScale:    0.25,
        windSpeed:         0.35,
        anchorBase:        true,
        mainColor:         flowerColor,
        secondColor:       new THREE.Color('#586a2b'),
        flowerStart:       0.6,
        colorBlend:        0.12,
        alphaCutoff:       0.35,
        smoothness:        0.1,
        translucencyInt:   3.0,
        directLightOffset: 0.0,
        directLightInt:    1.0,
        indirectLightInt:  1.0,
        impactDuration:    1.6,   // ← ADD
        impactDecay:       1.5,   // ← ADD
      });
      const shadowMat = createFlowersShadowMaterial(
        this._flowerDiffuse, mat, 0.35
      );

      // Point this flower cluster's impact uniforms at the SAME shared
      // buffer grass uses — one addImpact() call disturbs grass AND every
      // flower cluster simultaneously, no extra bookkeeping needed.
      mat.uniforms.uImpactData.value  = this._impactData;
      shadowMat.uniforms.uImpactData.value = this._impactData;

      const positions = bucket.flowerSpots.map(p => ({
        ...p,
        sx:    2.1 + Math.random() * 0.3,
        sy:    2.1 + Math.random() * 0.3,
        angle: Math.random() * Math.PI * 2,
      }));
      const mesh = this._buildIM(this._flowerGeo, mat, shadowMat, positions.length);
      this._flowerClusters.push({ color: bucket.color, mesh, positions, mat, shadowMat });
    }

    this._clustersBuilt = true;
    console.log(`GrassPool: ${this._grassPositions.length} grass in ${this._grassChunks.length} chunks, ${colorBuckets.length} flower cluster(s)`);
  }

  // ─── Dense fill along furrow rows ───────────────────────────────────────
  // Random sampling alone leaves gaps — only a few of the totalSpots draws
  // land inside any given colored region. This walks a fine grid over the
  // whole terrain instead, and for every grid point that falls inside a
  // furrow field + colored mask area, snaps it onto its row using the
  // EXACT SAME _alignToFurrow() used everywhere else (unchanged), so
  // alignment stays correct while coverage becomes continuous.
  _fillFurrowRows(colorBuckets, findCluster) {
    if (!this._terrain) return;

    const half = TERRAIN_SIZE / 2;
    const seen = new Set(); // dedupe grid points that snap to the same row slot

    for (let z = -half; z <= half; z += FURROW_FILL_STEP) {
      for (let x = -half; x <= half; x += FURROW_FILL_STEP) {
        const rot = this._terrain.getFurrowRotation(x, z);
        if (!rot) continue; // outside any furrow field

        const pixel = this._terrain.getMaskPixel(x, z);
        if (!pixel || isBlackOrWhite(pixel) || isGreen(pixel)) continue;

        const aligned = this._alignToFurrow(x, z);

        // Dedupe key — since FURROW_ALONG_JITTER/ACROSS_JITTER are 0,
        // aligned.x/z are deterministic per row slot, so rounding is a
        // safe, stable dedupe key.
        const key = `${aligned.x.toFixed(2)}_${aligned.z.toFixed(2)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const ay = this._getY(aligned.x, aligned.z);

        let bucket = findCluster(pixel);
        if (!bucket) {
          bucket = { color: pixel, flowerSpots: [] };
          colorBuckets.push(bucket);
        }
        bucket.flowerSpots.push({ x: aligned.x, y: ay, z: aligned.z });
      }
    }
  }

  _buildIM(geo, mat, shadowMat, count) {
    if (count === 0) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow    = false;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = shadowMat;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, zero);
    mesh.instanceMatrix.needsUpdate = true;
    this._scene.add(mesh);
    return mesh;
  }

  // ─── Chunked grass build ────────────────────────────────────────────────────
  // Groups instances into GRASS_CHUNK_SIZE×GRASS_CHUNK_SIZE cells. Each chunk is
  // its own InstancedMesh with matrices set ONCE (StaticDrawUsage — never touched
  // again). Per-frame cost becomes "is this chunk's center within range" instead
  // of a distance+frustum+matrix-write check for every single blade.
  _buildChunks(positions, geo, mat, shadowMat) {
    if (!positions.length) return [];

    const groups = new Map();
    for (const p of positions) {
      const cx  = Math.floor(p.x / GRASS_CHUNK_SIZE);
      const cz  = Math.floor(p.z / GRASS_CHUNK_SIZE);
      const key = `${cx},${cz}`;
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(p);
    }

    const chunks = [];
    const mat4   = new THREE.Matrix4();

    for (const items of groups.values()) {
      const count = items.length;
      const mesh  = new THREE.InstancedMesh(geo, mat, count);

      // Set once — no per-frame instanceMatrix.needsUpdate, no GPU buffer re-upload.
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.frustumCulled       = true;  // let three.js's own camera-frustum cull handle this chunk
      mesh.castShadow          = false;
      mesh.receiveShadow       = true;
      mesh.customDepthMaterial = shadowMat;

      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

      for (let i = 0; i < count; i++) {
        const p = items[i];
        const cos = Math.cos(p.angle), sin = Math.sin(p.angle);
        mat4.set(
          p.sx * cos, 0,  p.sx * sin, p.x,
          0,          p.sy, 0,        p.y,
         -p.sx * sin, 0,  p.sx * cos, p.z,
          0,          0,  0,          1
        );
        mesh.setMatrixAt(i, mat4);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();

      this._scene.add(mesh);
      chunks.push({
        mesh,
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
        radius:  Math.sqrt((maxX - minX) ** 2 + (maxZ - minZ) ** 2) / 2,
      });
    }

    return chunks;
  }

  // ─── Per-frame chunk visibility — replaces per-instance LOD loop for grass ───
  _updateChunkVisibility(chunks, cubeX, cubeZ) {
    for (const chunk of chunks) {
      const dx   = chunk.centerX - cubeX;
      const dz   = chunk.centerZ - cubeZ;
      // distance to the chunk's nearest edge, not its center — avoids
      // hiding a chunk early just because its center is far away
      const dist = Math.sqrt(dx * dx + dz * dz) - chunk.radius;
      chunk.mesh.visible = dist <= GRASS_LOD_RADIUS;
    }
  }

  _samplePosition() {
    for (let t = 0; t < MAX_TRIES; t++) {
      const x = (Math.random() - 0.5) * TERRAIN_SIZE;
      const z = (Math.random() - 0.5) * TERRAIN_SIZE;
      const y = this._getY(x, z);
      if (y >= GRASS_Y_MIN) return [x, z, y];
    }
    return null;
  }

  // ─── Per-frame LOD ─────────────────────────────────────────────────────────

  _updateInstanceLOD(mesh, positions, cubeX, cubeZ, uuid, camera) {
    if (!mesh) return;
    const r2 = GRASS_LOD_RADIUS * GRASS_LOD_RADIUS;
    let needsUpdate = false;

    // Update frustum from camera — zero allocations (uses pre-allocated scratch)
    if (camera) {
      this._frustumMat.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
      );
      this._frustum.setFromProjectionMatrix(this._frustumMat);
    }

    if (!this._visibility[uuid]) this._visibility[uuid] = {};
    const vis = this._visibility[uuid];

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (!p) continue;
      const dx = p.x - cubeX;
      const dz = p.z - cubeZ;

      // Distance check first (cheap) — frustum check only if within radius
      let inRange = (dx * dx + dz * dz) <= r2;
      if (inRange && camera) {
        this._frustumPt.set(p.x, p.y, p.z);
        inRange = this._frustum.containsPoint(this._frustumPt);
      }

      if (inRange === vis[i]) continue;
      vis[i] = inRange;

      if (inRange) {
        const cos = Math.cos(p.angle), sin = Math.sin(p.angle);
        this._mat4.set(
          p.sx * cos, 0,  p.sx * sin, p.x,
          0,          p.sy, 0,        p.y,
         -p.sx * sin, 0,  p.sx * cos, p.z,
          0,          0,  0,          1
        );
      } else {
        this._mat4.makeScale(0, 0, 0);
      }
      mesh.setMatrixAt(i, this._mat4);
      needsUpdate = true;
    }

    if (needsUpdate) mesh.instanceMatrix.needsUpdate = true;

    // Hide entire draw call when nothing visible — saves the draw call entirely
    const anyVisible = Object.values(vis).some(v => v === true);
    mesh.visible = anyVisible;
  }

  // ─── Impact API — call this once per bullet/shell impact near the ground.
  // Zero geometry, zero per-shot allocation: just overwrites one slot in a
  // fixed 8-entry buffer and pushes it to the GPU. Safe to call rapidly
  // (MG fire etc.) — old impacts simply age out on their own in the shader.
  addImpact(x, z) {
    if (!this._grassMat || !this._grassShadowMat) return;

    const slot = this._impactData[this._impactWriteIdx];
    slot.set(x, z, this._elapsed, 0);
    this._impactWriteIdx = (this._impactWriteIdx + 1) % MAX_GRASS_IMPACTS;
    this._impactCount    = Math.min(this._impactCount + 1, MAX_GRASS_IMPACTS);

    this._grassMat.uniforms.uImpactCount.value       = this._impactCount;
    this._grassShadowMat.uniforms.uImpactCount.value = this._impactCount;

    // ── Same buffer, same count — flowers react identically to grass. ──
    for (const cl of this._flowerClusters) {
      cl.mat.uniforms.uImpactCount.value       = this._impactCount;
      cl.shadowMat.uniforms.uImpactCount.value = this._impactCount;
    }
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  update(elapsed, tracked, scene, camera = null) {
  this._elapsed = elapsed; // cached for addImpact()'s timestamp
  if (this._grassMat) {
    this._grassMat.uniforms.uTime.value       = elapsed;
    this._grassShadowMat.uniforms.uTime.value = elapsed;
    syncGrassLighting(this._grassMat, scene);
  }
  for (const cl of this._flowerClusters) {
    cl.mat.uniforms.uTime.value       = elapsed;
    cl.shadowMat.uniforms.uTime.value = elapsed;
    syncFlowersLighting(cl.mat, scene);
  }

  if (!this._grassReady || !this._clustersBuilt) return;

  // ── Smooth fade as camera rises through the cull band, instead of a
  // hard visibility flip — grass dissolves via the hashed-alpha dither
  // rather than popping in one frame.
  const camY = camera ? camera.position.y : 0;
  const fade = THREE.MathUtils.clamp(
    (GRASS_CULL_CAMERA_Y - camY) / GRASS_CULL_FADE_BAND, 0, 1
  );
  if (this._grassMat)       this._grassMat.uniforms.uHeightFade.value       = fade;
  if (this._grassShadowMat) this._grassShadowMat.uniforms.uHeightFade.value = fade;
  for (const cl of this._flowerClusters) {
    cl.mat.uniforms.uHeightFade.value       = fade;
    cl.shadowMat.uniforms.uHeightFade.value = fade;
  }

  // Fully cull (skip distance/frustum math + draw calls entirely) only
  // once completely faded out — same perf shortcut as before.
  if (fade <= 0) {
    if (!this._highCulled) {
      this.setVisible(false);
      this._highCulled = true;
    }
    return;
  }
  if (this._highCulled) {
    this._highCulled = false;
  }

  // Camera position for culling — correctly handles zoom-out
  const cubeX = camera ? camera.position.x : tracked.position.x;
  const cubeZ = camera ? camera.position.z : tracked.position.z;

  this._updateChunkVisibility(this._grassChunks, cubeX, cubeZ);

  for (const cl of this._flowerClusters) {
    this._updateInstanceLOD(
      cl.mesh, cl.positions, cubeX, cubeZ,
      `flower_${cl.color.r}_${cl.color.g}_${cl.color.b}`, camera
    );
  }
}

  getActiveLODLevel() { return 0; }

  setVisible(v) {
    for (const c of this._grassChunks) c.mesh.visible = v;
    for (const cl of this._flowerClusters) { if (cl.mesh) cl.mesh.visible = v; }
  }

  dispose() {
    for (const c of this._grassChunks) {
      this._scene.remove(c.mesh);
    }
    this._grassGeo?.dispose();
    this._grassMat?.dispose();
    this._grassShadowMat?.dispose();
    this._grassDiffuse?.dispose();

    for (const cl of this._flowerClusters) {
      if (cl.mesh) this._scene.remove(cl.mesh);
      this._flowerGeo?.dispose();
      cl.mat?.dispose();
      cl.shadowMat?.dispose();
    }
    this._flowerDiffuse?.dispose();

    this._grassChunks    = [];
    this._flowerClusters = [];
    this._grassPositions = [];
    this._visibility     = {};
  }
}