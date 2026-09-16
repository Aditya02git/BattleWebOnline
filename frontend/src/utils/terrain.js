import * as THREE from 'three'

/**
 * TerrainBuilder
 * Takes height data and creates:
 *   1. Three.js visual mesh (with normals + vertex colors)
 *   2. Rapier heightfield collider data
 */
export class TerrainBuilder {
  constructor({
    heights,       // Float32Array, row-major
    size,          // grid resolution (e.g. 101)
    worldSize = 200,   // total world size in meters
    heightScale = 14,  // max height in meters (matches Blender strength ~2.8 * 5)
    heightOffset = 0   // Y offset
  }) {
    this.heights = heights
    this.size = size         // 101 × 101
    this.cols = size - 1     // 100 cells
    this.worldSize = worldSize
    this.heightScale = heightScale
    this.heightOffset = heightOffset
    this.cellSize = worldSize / (size - 1)  // 2m per cell
  }

  /**
   * Get height at grid position (row, col)
   */
  getHeight(row, col) {
    row = Math.max(0, Math.min(this.size - 1, row))
    col = Math.max(0, Math.min(this.size - 1, col))
    return this.heights[row * this.size + col] * this.heightScale + this.heightOffset
  }

  /**
   * Get interpolated height at world position (x, z)
   */
  getHeightAtWorld(x, z) {
    // Convert world pos to grid coords
    const gx = (x + this.worldSize / 2) / this.cellSize
    const gz = (z + this.worldSize / 2) / this.cellSize

    const col0 = Math.floor(gx)
    const row0 = Math.floor(gz)
    const col1 = col0 + 1
    const row1 = row0 + 1

    const fx = gx - col0
    const fz = gz - row0

    const h00 = this.getHeight(row0, col0)
    const h10 = this.getHeight(row0, col1)
    const h01 = this.getHeight(row1, col0)
    const h11 = this.getHeight(row1, col1)

    // Bilinear interpolation
    return h00 * (1 - fx) * (1 - fz)
         + h10 * fx * (1 - fz)
         + h01 * (1 - fx) * fz
         + h11 * fx * fz
  }

  /**
   * Build Three.js BufferGeometry terrain mesh
   */
buildMesh(renderer = null, mask = null, worldSize = 500, texConfig = {}) {
  const { size, cellSize } = this;
  const half      = this.worldSize / 2; // use the constructor's worldSize, not the local param — keeps vertex placement consistent with getMaskPixel/getFurrowRotation, which both use this.worldSize
  const vertCount = size * size;

  const positions = new Float32Array(vertCount * 3);
  const normals   = new Float32Array(vertCount * 3);
  const uvs       = new Float32Array(vertCount * 2);

  // ── Vertices ──────────────────────────────────────────────────────────────
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const i = row * size + col;
      positions[i * 3 + 0] = col * cellSize - half;
      positions[i * 3 + 1] = this.getHeight(row, col);
      positions[i * 3 + 2] = row * cellSize - half;

      uvs[i * 2 + 0] = col / (size - 1);
      uvs[i * 2 + 1] = row / (size - 1);
    }
  }

  // ── Indices ───────────────────────────────────────────────────────────────
  const cellCount = (size - 1) * (size - 1);
  const indices   = new Uint32Array(cellCount * 6);
  let idx = 0;
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const tl = row * size + col;
      const tr = tl + 1;
      const bl = (row + 1) * size + col;
      const br = bl + 1;
      indices[idx++] = tl; indices[idx++] = bl; indices[idx++] = tr;
      indices[idx++] = tr; indices[idx++] = bl; indices[idx++] = br;
    }
  }

  // ── Normals ───────────────────────────────────────────────────────────────
  const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
  const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _n  = new THREE.Vector3();

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    _v0.fromArray(positions, a * 3);
    _v1.fromArray(positions, b * 3);
    _v2.fromArray(positions, c * 3);
    _e1.subVectors(_v1, _v0);
    _e2.subVectors(_v2, _v0);
    _n.crossVectors(_e1, _e2).normalize();
    for (const vi of [a, b, c]) {
      normals[vi * 3 + 0] += _n.x;
      normals[vi * 3 + 1] += _n.y;
      normals[vi * 3 + 2] += _n.z;
    }
  }
  for (let i = 0; i < vertCount; i++) {
    _n.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]).normalize();
    normals[i * 3]     = _n.x;
    normals[i * 3 + 1] = _n.y;
    normals[i * 3 + 2] = _n.z;
  }

  // ── Geometry ──────────────────────────────────────────────────────────────
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal',   new THREE.BufferAttribute(normals,   3));
  geometry.setAttribute('uv',       new THREE.BufferAttribute(uvs,       2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  // ── Textures ──────────────────────────────────────────────────────────────
  const repeat     = 50;
  const anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 4;
  const loader     = new THREE.TextureLoader();

  const loadTex = (path, srgb = true) => {
  const t = loader.load(path);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  // No repeat, no RepeatWrapping — use UVs as-is (0→1 across whole terrain)
  
  return t;
};

  // Visual material texture — terrain_mat.png covers the whole mesh
  const colorTexPath  = texConfig.colorTex  ?? '/terrain_mat.png';
  const normalTexPath = texConfig.normalTex  ?? '/Grass005_1K-PNG_NormalGL.png';
  const normalRepeat  = texConfig.normalRepeat ?? 50;

  const floorT = loadTex(colorTexPath);
  floorT.flipY = false;

  const floorN = loadTex(normalTexPath, false);
  floorN.flipY = false;
  floorN.wrapS = THREE.RepeatWrapping;
  floorN.wrapT = THREE.RepeatWrapping;
  floorN.repeat.set(normalRepeat, normalRepeat);

  // ── Furrow normal overlay — bakes furrow_normalmap.png into the grass
  // normal map wherever fence.png (the mask) is black, using a 2D canvas.
  // (Custom onBeforeCompile shader-chunk patching was removed — it caused
  // a fragment shader compile error since internal chunk variable names
  // differ across three.js versions.)
  // ── Furrow enable/disable — maps.json can set terrain.furrowEnabled to
  // false to skip the furrow bake entirely (plain grass normal map only,
  // no furrow_normalmap blending, no fence.png mask sampling for this).
  // Defaults to true so existing maps without this field keep working
  // exactly as before.
  const furrowEnabled    = texConfig.furrowEnabled ?? true;
  const furrowNormalPath = texConfig.furrowNormalTex    ?? '/furrow_normalmap.png';
  const furrowMaskPath   = texConfig.furrowMaskTex      ?? '/fence.png';
  const furrowRepeat     = texConfig.furrowNormalRepeat ?? 80;
  const FURROW_BAKE_SIZE = texConfig.furrowBakeSize     ?? 4096;
  // Resolution used to flood-fill fence.png's black fields into separate
  // rotatable regions — doesn't need to match FURROW_BAKE_SIZE, fields are
  // large so this can stay much smaller for speed.
  const FURROW_REGION_SIZE = texConfig.furrowRegionSize ?? 512;
  // Pass a number to get the SAME random per-field rotations every time
  // this map loads; omit/leave undefined for a fresh random layout each load.
  const furrowSeed = texConfig.furrowSeed;
  // How far (in world meters) the furrow normal should be pulled back from
  // non-furrow (e.g. road) areas so furrow lines never blend right up to
  // the edge of fence.png's black regions. 0 disables the offset.
  const furrowRoadOffset = texConfig.furrowRoadOffset ?? 3;

  // ── Road normal config — reuses fence.png as the mask, WHITE = road.
  // This replaces the "white = plain grass" side of the furrow bake below
  // with a road normal map instead, when enabled. Same mask, no separate
  // bake pass — it's folded directly into the furrow bake to avoid a race
  // between two independent async blends both writing material.normalMap.
  const roadEnabled     = texConfig.roadEnabled ?? !!texConfig.roadNormalTex;
  const roadNormalPath  = texConfig.roadNormalTex ?? '/road_normalmap.png';
  const roadRepeat      = texConfig.roadRepeat    ?? 40;

  function _loadImage(path) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = reject;
      img.src = path;
    });
  }

  function _buildTiledCanvas(image, size, repeat) {
    const c   = document.createElement('canvas');
    c.width   = size;
    c.height  = size;
    const ctx = c.getContext('2d');
    const tile = size / repeat;
    for (let y = 0; y < size; y += tile) {
      for (let x = 0; x < size; x += tile) {
        ctx.drawImage(image, x, y, tile, tile);
      }
    }
    return ctx.getImageData(0, 0, size, size);
  }

  // ── Flood-fills fence.png's BLACK regions into separate connected
  // "fields", each getting its own random rotation (cos/sin precomputed
  // per pixel at this lower analysis resolution, not the full bake
  // resolution, so the expensive trig only runs regionSize² times).
  function _computeFieldRotationMap(maskImage, regionSize, seed) {
    const c = document.createElement('canvas');
    c.width  = regionSize;
    c.height = regionSize;
    const ctx = c.getContext('2d');
    ctx.drawImage(maskImage, 0, 0, regionSize, regionSize);
    const data = ctx.getImageData(0, 0, regionSize, regionSize).data;

    const n = regionSize * regionSize;
    const isBlack = new Uint8Array(n);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      isBlack[p] = data[i] < 128 ? 1 : 0; // fence.png: black = furrow field
    }

    const labeled = new Uint8Array(n); // 0 = not yet visited
    const cosMap  = new Float32Array(n); // default cos=1/sin=0 (identity) for
    const sinMap  = new Float32Array(n); // pixels outside any black region

    // Deterministic RNG if a seed is given, so the same map always gets
    // the same per-field rotations across reloads; otherwise random each time.
    let rand = Math.random;
    if (typeof seed === 'number') {
      let s = seed >>> 0;
      rand = () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const stack = new Int32Array(n); // safe upper bound — each pixel pushed once
    let fieldCount = 0;

    for (let start = 0; start < n; start++) {
      if (!isBlack[start] || labeled[start]) continue;

      const angle = rand() * Math.PI * 2;
      const cosT  = Math.cos(angle);
      const sinT  = Math.sin(angle);

      let sp = 0;
      stack[sp++] = start;
      labeled[start] = 1;
      cosMap[start] = cosT;
      sinMap[start] = sinT;

      while (sp > 0) {
        const idx = stack[--sp];
        const x = idx % regionSize;
        const y = (idx / regionSize) | 0;

        if (x > 0) {
          const nb = idx - 1;
          if (isBlack[nb] && !labeled[nb]) { labeled[nb]=1; cosMap[nb]=cosT; sinMap[nb]=sinT; stack[sp++]=nb; }
        }
        if (x < regionSize - 1) {
          const nb = idx + 1;
          if (isBlack[nb] && !labeled[nb]) { labeled[nb]=1; cosMap[nb]=cosT; sinMap[nb]=sinT; stack[sp++]=nb; }
        }
        if (y > 0) {
          const nb = idx - regionSize;
          if (isBlack[nb] && !labeled[nb]) { labeled[nb]=1; cosMap[nb]=cosT; sinMap[nb]=sinT; stack[sp++]=nb; }
        }
        if (y < regionSize - 1) {
          const nb = idx + regionSize;
          if (isBlack[nb] && !labeled[nb]) { labeled[nb]=1; cosMap[nb]=cosT; sinMap[nb]=sinT; stack[sp++]=nb; }
        }
      }
      fieldCount++;
    }

    return { cosMap, sinMap, isBlack, regionSize, fieldCount };
  }

  // ── Bakes furrow_normalmap.png into a full-size normal map, sampled
  // through a per-pixel rotation (looked up from rotMap by field), so
  // each black field in fence.png shows the furrow texture at its own
  // random angle instead of one uniform direction everywhere.
  function _buildRotatedFurrowCanvas(furrowImage, size, repeat, rotMap) {
    const { cosMap, sinMap, regionSize } = rotMap;

    // Sample source at a fixed working resolution — independent of `size`.
    const srcSize = 512;
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width  = srcSize;
    srcCanvas.height = srcSize;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(furrowImage, 0, 0, srcSize, srcSize);
    const src = srcCtx.getImageData(0, 0, srcSize, srcSize).data;

    const out = new ImageData(size, size);

    for (let y = 0; y < size; y++) {
      const ry = Math.min(regionSize - 1, (y / size * regionSize) | 0);
      for (let x = 0; x < size; x++) {
        const rx = Math.min(regionSize - 1, (x / size * regionSize) | 0);
        const rIdx = ry * regionSize + rx;
        const cosT = cosMap[rIdx];
        const sinT = sinMap[rIdx];

        // Rotate the pixel coordinate — this rotates the TILE SPACE, so
        // the furrow texture reads as rotated within this field.
        const rxCoord = x * cosT - y * sinT;
        const ryCoord = x * sinT + y * cosT;

        let u = ((rxCoord / size) * repeat) % 1; if (u < 0) u += 1;
        let v = ((ryCoord / size) * repeat) % 1; if (v < 0) v += 1;

        const sx = Math.min(srcSize - 1, (u * srcSize) | 0);
        const sy = Math.min(srcSize - 1, (v * srcSize) | 0);
        const sIdx = (sy * srcSize + sx) * 4;

        const nx0 = (src[sIdx]     / 255) * 2 - 1;
        const ny0 = (src[sIdx + 1] / 255) * 2 - 1;
        const nzB = src[sIdx + 2]; // blue channel (mostly ~255) passes through unrotated

        // Rotate the sampled normal's XY to match the rotated texture —
        // a tilted bump direction must rotate along with the tile.
        const nxR = nx0 * cosT - ny0 * sinT;
        const nyR = nx0 * sinT + ny0 * cosT;

        const idx = (y * size + x) * 4;
        out.data[idx]     = Math.max(0, Math.min(255, (nxR * 0.5 + 0.5) * 255));
        out.data[idx + 1] = Math.max(0, Math.min(255, (nyR * 0.5 + 0.5) * 255));
        out.data[idx + 2] = nzB;
        out.data[idx + 3] = 255;
      }
    }
    return out;
  }

    // ── Erodes the furrow (black) regions of fence.png by `radius` pixels —
  // i.e. grows the white (non-furrow/road) regions by that much — so the
  // baked furrow normal fades back to plain grass before it reaches a road
  // edge instead of blending right up against it. Uses a separable O(n)
  // sliding-window-maximum (not O(n·radius²)), so large offsets stay cheap.
  // Mutates `data` (a getImageData Uint8ClampedArray) in place.
  function _erodeFurrowMask(data, size, radius) {
    if (radius <= 0) return;
    const n = size * size;
    const gray = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) gray[i] = data[i * 4]; // mask is grayscale, red channel

    const slidingMax1D = (input, output, lineLen, lineCount, rowStride, colStride) => {
      for (let l = 0; l < lineCount; l++) {
        const base = l * rowStride;
        const dq = []; // indices along the line, decreasing values
        for (let j = 0; j < lineLen + radius; j++) {
          if (j < lineLen) {
            const vJ = input[base + j * colStride];
            while (dq.length && input[base + dq[dq.length - 1] * colStride] <= vJ) dq.pop();
            dq.push(j);
          }
          const i = j - radius;
          if (i >= 0) {
            while (dq[0] < i - radius) dq.shift();
            output[base + i * colStride] = input[base + dq[0] * colStride];
          }
        }
      }
    };

    const tmp = new Uint8ClampedArray(n);
    const out = new Uint8ClampedArray(n);
    slidingMax1D(gray, tmp, size, size, size, 1); // horizontal pass (rows)
    slidingMax1D(tmp, out, size, size, 1, size);  // vertical pass (columns)

    for (let i = 0; i < n; i++) {
      const v = out[i];
      data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v;
    }
  }

  // Mask texture — terrain_texture.png decoded to canvas for grass placement
  this._maskCanvas = null;
  this._maskCtx    = null;
  const maskImage  = new THREE.TextureLoader();
  maskImage.load(texConfig.maskTex ?? '/terrain_texture1.png', (tex) => {
    const c   = document.createElement('canvas');
    c.width   = tex.image.width;
    c.height  = tex.image.height;
    // willReadFrequently hints to the browser that getImageData() will be
    // called many times on this canvas (once per grass-placement query in
    // GrassPool.js), so it can pick a CPU-backed buffer instead of GPU-backed,
    // avoiding the readback penalty warning.
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(tex.image, 0, 0);
    this._maskCanvas = c;
    this._maskCtx    = ctx;
  });


  // ── Material ──────────────────────────────────────────────────────────────
  const material = new THREE.MeshStandardMaterial({
    map:         floorT,
    normalMap:   floorN,
    normalScale: new THREE.Vector2(0.3, 0.3),
    roughness:   1.0,
    metalness:   0.0,
  });

  // ── Bake the furrow blend on a canvas, then swap it in as normalMap
  // once ready. Starts out with the plain grass normal map (above) so
  // nothing is blocked/delayed waiting on this to finish. Skipped
  // entirely when furrowEnabled is false — material.normalMap stays the
  // plain floorN grass normal map set above, and _furrowFieldMap (used
  // by GrassPool for furrow-aligned scatter) stays null. ─────────────────
  if (!furrowEnabled && !roadEnabled) {
    // Neither furrow nor road — material.normalMap stays the plain floorN
    // grass normal map set above. Nothing to bake.
    this._furrowFieldMap      = null;
    this._furrowFieldMapReady = true; // mark "attempted" so dependents (e.g. GrassPool) don't wait forever
  } else {
  Promise.all([
    _loadImage(normalTexPath),
    furrowEnabled ? _loadImage(furrowNormalPath) : Promise.resolve(null),
    _loadImage(furrowMaskPath), // same mask drives both furrow (black) and road (white) placement
    roadEnabled ? _loadImage(roadNormalPath) : Promise.resolve(null),
  ]).then(([grassImg, furrowImg, maskImg, roadImg]) => {
    const size = FURROW_BAKE_SIZE;

    const grassData = _buildTiledCanvas(grassImg, size, normalRepeat);
    const roadData  = roadEnabled ? _buildTiledCanvas(roadImg, size, roadRepeat) : null;

    // Furrow rotation map — only computed when furrow is actually enabled.
    // Untouched logic: still keyed off BLACK pixels of the mask.
    const fieldRotMap = furrowEnabled
      ? _computeFieldRotationMap(maskImg, FURROW_REGION_SIZE, furrowSeed)
      : null;
    const furrowData = furrowEnabled
      ? _buildRotatedFurrowCanvas(furrowImg, size, furrowRepeat, fieldRotMap)
      : null;

    // ── Expose the per-field furrow rotation so other systems (e.g.
    // GrassPool) can align scattered objects — like flowers — along the
    // same rows/angle baked into the visual furrow normal map.
    this._furrowFieldMap      = fieldRotMap;
    this._furrowFieldMapReady = true;

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width  = size;
    maskCanvas.height = size;
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.drawImage(maskImg, 0, 0, size, size);
    const maskData = maskCtx.getImageData(0, 0, size, size).data;

    // Pull black (furrow) regions back from white (road) areas — only
    // meaningful when furrow is enabled (nothing to erode otherwise).
    if (furrowEnabled) {
      const offsetPixels = Math.round(furrowRoadOffset * (size / this.worldSize));
      _erodeFurrowMask(maskData, size, offsetPixels);
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width  = size;
    outCanvas.height = size;
    const outCtx  = outCanvas.getContext('2d');
    const outData = outCtx.createImageData(size, size);

    const pxCount = size * size;
    for (let i = 0; i < pxCount; i++) {
      const idx = i * 4;

      if (furrowEnabled) {
        // fence.png: black = furrow area, white = road (if roadEnabled) or
        // plain grass (if not) — same as before, untouched.
        const maskVal = maskData[idx] / 255;
        const t = 1 - maskVal; // furrow blend amount
        const base = roadEnabled ? roadData : grassData;

        outData.data[idx]     = base.data[idx]     * (1 - t) + furrowData.data[idx]     * t;
        outData.data[idx + 1] = base.data[idx + 1] * (1 - t) + furrowData.data[idx + 1] * t;
        outData.data[idx + 2] = base.data[idx + 2] * (1 - t) + furrowData.data[idx + 2] * t;
      } else {
        // furrow OFF, road ON — clean split: white = road, black/remaining = plain grass (normalTex)
        const maskVal = maskData[idx] / 255; // 0 = grass, 1 = road
        outData.data[idx]     = grassData.data[idx]     * (1 - maskVal) + roadData.data[idx]     * maskVal;
        outData.data[idx + 1] = grassData.data[idx + 1] * (1 - maskVal) + roadData.data[idx + 1] * maskVal;
        outData.data[idx + 2] = grassData.data[idx + 2] * (1 - maskVal) + roadData.data[idx + 2] * maskVal;
      }
      outData.data[idx + 3] = 255;
    }
    outCtx.putImageData(outData, 0, 0);

    const blendedTex = new THREE.CanvasTexture(outCanvas);
    blendedTex.colorSpace = THREE.NoColorSpace;
    blendedTex.flipY  = false;
    blendedTex.wrapS  = THREE.RepeatWrapping;
    blendedTex.wrapT  = THREE.RepeatWrapping;
    blendedTex.repeat.set(1, 1); // tiling already baked into the pixels
    blendedTex.needsUpdate = true;

    material.normalMap   = blendedTex;
    material.needsUpdate = true;
  }).catch((err) => {
    console.warn('[Terrain] Furrow/road normal blend failed, falling back to plain grass normal map:', err);
    this._furrowFieldMapReady = true; // mark attempted so dependents (e.g. GrassPool) don't wait forever
  });
  }

  // ── Mesh ──────────────────────────────────────────────────────────────────
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow    = false;
  mesh.name          = 'terrain';
  return mesh;
}

/**
   * Build a cheap, collider-less "skirt" mesh that extends the visual
   * ground outward from the real terrain's edge, falling away into
   * gentle procedural hills so the horizon doesn't show a hard edge
   * or the void beyond the playable area. Uses vertex colors instead
   * of textures — no texture sampling, minimal material cost.
   *
   * @param {number} skirtRadius - how far outward the skirt extends
   *                               (world units) beyond the terrain edge
   * @param {number} ringSegments - subdivisions around the ring (angular)
   * @param {number} radialSegments - subdivisions from edge to outer radius
   */
  buildSkirtMesh(skirtRadius = 1500, ringSegments = 96, radialSegments = 10) {
    const { worldSize, cellSize } = this;
    const half = worldSize / 2;
    const innerRadius = half * Math.SQRT2; // covers the square terrain's corners

    const vertCount = (radialSegments + 1) * ringSegments;
    const positions = new Float32Array(vertCount * 3);
    const colors    = new Float32Array(vertCount * 3);
    const normals    = new Float32Array(vertCount * 3);

    // ── Simple deterministic pseudo-noise (no external dep) ─────────────
    const noise2D = (x, z) => {
      const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
      return s - Math.floor(s); // 0..1
    };
    const smoothNoise = (x, z, scale) => {
      // a few octaves of the hash noise above, blended, for gentle rolling hills
      let v = 0, amp = 1, freq = 1 / scale, norm = 0;
      for (let o = 0; o < 3; o++) {
        v += noise2D(Math.floor(x * freq), Math.floor(z * freq)) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.03;
      }
      return v / norm; // 0..1
    };

    // Color gradient stops: near terrain edge (green) -> far hills (brown/grey)
    const nearColor = new THREE.Color(0x4a6b34);
    const farColor  = new THREE.Color(0x6b5a42);
    const _c = new THREE.Color();

    let vi = 0;
    for (let r = 0; r <= radialSegments; r++) {
      const t = r / radialSegments; // 0 at inner edge, 1 at outer edge
      const radius = innerRadius + t * skirtRadius;

      for (let a = 0; a < ringSegments; a++) {
        const angle = (a / ringSegments) * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;

        let y;
        if (t <= 0.001) {
          // Snap exactly to the real terrain's edge height for a seamless join.
          // Sample using the same bilinear helper the real mesh uses, clamped
          // to the border (getHeightAtWorld already clamps internally via getHeight).
          y = this.getHeightAtWorld(
            THREE.MathUtils.clamp(x, -half, half),
            THREE.MathUtils.clamp(z, -half, half)
          );
        } else {
          // Blend from the edge height down into procedural rolling hills,
          // with the falloff strengthening as t increases (falling-away horizon).
          const edgeY = this.getHeightAtWorld(
            THREE.MathUtils.clamp(x, -half, half),
            THREE.MathUtils.clamp(z, -half, half)
          );
          const hillNoise   = smoothNoise(x, z, 220) - 0.5; // -0.5..0.5
          const hillHeight  = hillNoise * this.heightScale * 1.6;
          const falloff     = -Math.pow(t, 1.6) * this.heightScale * 2.2; // gentle downward slope
          y = edgeY * (1 - t) + (hillHeight + falloff) * t;
        }

        positions[vi * 3 + 0] = x;
        positions[vi * 3 + 1] = y;
        positions[vi * 3 + 2] = z;

        _c.copy(nearColor).lerp(farColor, t);
        colors[vi * 3 + 0] = _c.r;
        colors[vi * 3 + 1] = _c.g;
        colors[vi * 3 + 2] = _c.b;

        vi++;
      }
    }

    // ── Indices — connect ring r to ring r+1 ────────────────────────────
    const cellCount = radialSegments * ringSegments;
    const indices = new Uint32Array(cellCount * 6);
    let ii = 0;
    for (let r = 0; r < radialSegments; r++) {
      for (let a = 0; a < ringSegments; a++) {
        const aNext = (a + 1) % ringSegments;
        const i00 = r * ringSegments + a;
        const i01 = r * ringSegments + aNext;
        const i10 = (r + 1) * ringSegments + a;
        const i11 = (r + 1) * ringSegments + aNext;
        indices[ii++] = i00; indices[ii++] = i10; indices[ii++] = i01;
        indices[ii++] = i01; indices[ii++] = i10; indices[ii++] = i11;
      }
    }

    // ── Normals (flat-ish, computed from triangles) ─────────────────────
    const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
    const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _n  = new THREE.Vector3();
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      _v0.fromArray(positions, a * 3);
      _v1.fromArray(positions, b * 3);
      _v2.fromArray(positions, c * 3);
      _e1.subVectors(_v1, _v0);
      _e2.subVectors(_v2, _v0);
      _n.crossVectors(_e1, _e2).normalize();
      for (const vidx of [a, b, c]) {
        normals[vidx * 3 + 0] += _n.x;
        normals[vidx * 3 + 1] += _n.y;
        normals[vidx * 3 + 2] += _n.z;
      }
    }
    for (let i = 0; i < vertCount; i++) {
      _n.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]).normalize();
      normals[i * 3] = _n.x; normals[i * 3 + 1] = _n.y; normals[i * 3 + 2] = _n.z;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // Cheap material — vertex colors only, no texture sampling at all.
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      fog: true,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'terrainSkirt';
    mesh.receiveShadow = false; // skip shadow receiving on distant filler geometry
    mesh.castShadow    = false;
    mesh.frustumCulled = false; // it's huge and always at least partially in view
    return mesh;
  }

  /**
   * Build Rapier heightfield collider descriptor
   * Rapier expects heights in a specific order:
   *   nrows × ncols Float32Array
   *   nrows = size-1, ncols = size-1... 
   *   Actually Rapier HeightField: (nrows, ncols, heights, scale)
   *   heights.length = (nrows+1)*(ncols+1)
   */
/**
   * Returns {r,g,b} 0-255 of mask at world XZ, or null if canvas not ready.
   */
  getMaskPixel(wx, wz) {
    if (!this._maskCanvas) return null;
    const u  = Math.max(0, Math.min(1, wx / this.worldSize + 0.5));
    const v  = Math.max(0, Math.min(1, wz / this.worldSize + 0.5));
    const px = Math.floor(u * (this._maskCanvas.width  - 1));
    const py = Math.floor(v * (this._maskCanvas.height - 1));
    const d  = this._maskCtx.getImageData(px, py, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  }

  /**
   * Returns {cos, sin} — the furrow rotation of the field at world (wx,wz),
   * matching the same per-field rotation baked into the furrow normal map
   * in buildMesh(). Returns null if the map isn't ready yet, or if the
   * point is outside any black (furrow) region of the furrow mask.
   */
  getFurrowRotation(wx, wz) {
    const map = this._furrowFieldMap;
    if (!map) return null;
    const { cosMap, sinMap, isBlack, regionSize } = map;
    const u  = Math.max(0, Math.min(1, wx / this.worldSize + 0.5));
    const v  = Math.max(0, Math.min(1, wz / this.worldSize + 0.5));
    const px = Math.min(regionSize - 1, Math.floor(u * regionSize));
    const py = Math.min(regionSize - 1, Math.floor(v * regionSize));
    const idx = py * regionSize + px;
    if (!isBlack[idx]) return null;
    return { cos: cosMap[idx], sin: sinMap[idx] };
  }

  buildRapierHeightfield(RAPIER) {
    const { size, worldSize, heightScale } = this

    // Rapier heightfield: rows × cols, heights length = (rows+1)*(cols+1)
    // We have a size×size grid so rows = size-1, cols = size-1
    const nrows = size - 1  // 100
    const ncols = size - 1  // 100

    // The scale vector: x=totalWidth, y=maxHeight, z=totalDepth
    const scale = { x: worldSize, y: heightScale, z: worldSize }

    // Heights must be in row-major Float32Array
    // Values are normalized 0..1 (Rapier scales by scale.y)
    // Rapier HeightField layout: column-major!
    // heights[i + j*(nrows+1)] = height at row i, col j
    const rapierHeights = new Float32Array((nrows + 1) * (ncols + 1))

    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        // Column-major for Rapier
        rapierHeights[col * size + row] = this.heights[row * size + col]
      }
    }

    return { nrows, ncols, heights: rapierHeights, scale }
  }
}