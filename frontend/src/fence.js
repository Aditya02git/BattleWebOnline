// fence.js — Perimeter fences around each polygon (farmland) footprint.
// Posts + horizontal connecting rails are fully instanced: the whole map's
// fences render in exactly 2 draw calls (1 for posts, 1 for rails), no
// matter how many houses/polygons exist. Fences are purely visual +
// proximity-triggered: NO Rapier colliders.
//
// When a tank (player/enemy/friendly) gets within RAIL_TRIGGER_RADIUS of a
// horizontal rail segment, that rail's instance is hidden (zero-scaled) and
// a short particle burst plays at its midpoint. A post is only hidden once
// BOTH rails attached to it have been broken — a post never breaks directly
// from tank proximity anymore.

import * as THREE from 'three';

const RAIL_TRIGGER_RADIUS    = 2.0;  // metres — distance at which a tank breaks a fence rail
const RAIL_TRIGGER_RADIUS_SQ = RAIL_TRIGGER_RADIUS * RAIL_TRIGGER_RADIUS;
const PARTICLE_LIFETIME      = 0.35; // seconds — how long a break burst is visible
const PARTICLE_COUNT         = 5;

// ── Squared distance from point (px,pz) to the segment (ax,az)-(bx,bz),
// in the XZ plane. Pure-primitive, no allocations — safe to call every
// rail x every tank, every frame. ───────────────────────────────────────
function _distSqPointToSegmentXZ(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const apx = px - ax, apz = pz - az;
  const abLenSq = abx * abx + abz * abz;
  let t = abLenSq > 1e-9 ? (apx * abx + apz * abz) / abLenSq : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const cx = ax + abx * t, cz = az + abz * t;
  const dx = px - cx, dz = pz - cz;
  return dx * dx + dz * dz;
}

// ── Shared scratch objects — reused across all matrix builds, zero
// per-post/per-rail allocation ──────────────────────────────────────────
const _m4         = new THREE.Matrix4();
const _pos         = new THREE.Vector3();
const _quat         = new THREE.Quaternion();
const _scale         = new THREE.Vector3();
const _railXAxis     = new THREE.Vector3(1, 0, 0);
const _railDir       = new THREE.Vector3();
const _zeroMatrix    = new THREE.Matrix4().makeScale(0, 0, 0); // collapses an instance to nothing

export class FenceSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {Array<Array<[number, number]>>} polygons - one closed ring of
   *   [worldX, worldZ] points per farmland polygon (from loadFencePolygons)
   * @param {(x:number, z:number) => number} getTerrainY
   * @param {object} opts
   * @param {number} [opts.postsPerRing=14]
   * @param {number} [opts.railHeight=0.08]
   * @param {number} [opts.railThickness=0.05]
   * @param {number} [opts.railYOffset=0.9] - rail height above terrain
   */
  constructor(scene, polygons, getTerrainY, opts = {}) {
    this.scene        = scene;
    this.getTerrainY  = getTerrainY;
    this.postsTarget  = opts.postsPerRing ?? 14;
    this._railHeight    = opts.railHeight    ?? 0.3;
    this._railThickness  = opts.railThickness ?? 0.05;
    this._railYOffset    = opts.railYOffset    ?? 0.45;
    // Horizontal distance the whole fence ring is pushed in/out from the
    // mask-derived polygon boundary. Positive = outward (away from the
    // polygon interior), negative = inward. Sign depends on the polygon's
    // winding order — if it comes out backwards on your maps, just flip
    // the sign you pass in (or negate inside _offsetPolygon below).
    this._ringOffset = opts.ringOffset ?? 0;
    const railTriggerRadius = opts.railTriggerRadius ?? RAIL_TRIGGER_RADIUS;
    this._railTriggerRadiusSq = railTriggerRadius * railTriggerRadius;
    // Chance [0..1] that any given rail starts pre-broken (missing from
    // generation) for a naturally weathered/incomplete fence look. Missing
    // rails behave exactly like tank-broken ones: hidden instance, and they
    // count toward the post-cascade (a post still falls once its OTHER
    // rail breaks for real, even if this one was never there to begin with).
    this._missingRailChance = opts.missingRailChance ?? 0.15;

    this._posts  = []; // { x, z, terrainY, y, alive, index }
    this._rails  = []; // { postA, postB, alive, index }
    this._bursts = []; // active particle bursts

    this._postDirty = false;
    this._railDirty = false;

    // ── Pass 1: compute post + rail placement data for every ring ────────
    for (const polygon of polygons) {
      this._buildFenceRing(polygon);
    }

    // ── Post→rail lookup, so breaking a post can break its attached
    // rails in O(1) instead of scanning every rail ────────────────────────
    this._railsByPost = new Map();
    this._rails.forEach((rail, i) => {
      rail.index = i;
      if (!this._railsByPost.has(rail.postA)) this._railsByPost.set(rail.postA, []);
      if (!this._railsByPost.has(rail.postB)) this._railsByPost.set(rail.postB, []);
      this._railsByPost.get(rail.postA).push(i);
      this._railsByPost.get(rail.postB).push(i);
    });

    // ── Randomly decide which rails start pre-broken (missing) for a
    // naturally weathered/incomplete fence look. Only sets rail.alive here
    // — the post-cascade check is deferred until AFTER postMesh/railMesh
    // and real post/rail indices exist (see below), since it needs both.
    if (this._missingRailChance > 0) {
      for (const rail of this._rails) {
        if (Math.random() < this._missingRailChance) {
          rail.alive = false;
        }
      }
    }

    // ── Instanced posts — ONE mesh for every post across every ring ──────
    this._postGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.0, 4);
    this._postMat = new THREE.MeshStandardMaterial({
      color: 0x36312c,
      roughness: 0.9,
      metalness: 0.0,
    });
    this._postMesh = new THREE.InstancedMesh(
      this._postGeo,
      this._postMat,
      Math.max(1, this._posts.length)
    );
    this._postMesh.castShadow    = false;
    this._postMesh.receiveShadow = false;
    this._postMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // posts get hidden at runtime
    this._postMesh.count = this._posts.length;

    this._posts.forEach((post, i) => {
      post.index = i;
      _m4.makeTranslation(post.x, post.y -0.3, post.z);
      this._postMesh.setMatrixAt(i, _m4);
    });
    this._postMesh.instanceMatrix.needsUpdate = true;
    if (this._posts.length) this._postMesh.computeBoundingSphere(); // else default sphere is wrong for scattered instances
    this.scene.add(this._postMesh);

    // ── Instanced rails — ONE mesh connecting every consecutive post
    // pair (incl. wrap-around) across every ring ──────────────────────────
    // Extra height segments so the vertex shader has geometry to bend into
    // a "top rail" / "bottom rail" split with a thin invisible seam.
    this._railGeo = new THREE.BoxGeometry(1, this._railHeight, this._railThickness, 1, 8, 1);
    this._railMat = this._createRailShaderMaterial();

    // Per-instance pseudo-random seed (rustic variation between spans).
    // One float per instance; written once in _setRailMatrix, never touched
    // again after that (doesn't need per-frame updates).
    const railSeedArray = new Float32Array(Math.max(1, this._rails.length));
    this._railSeedAttr = new THREE.InstancedBufferAttribute(railSeedArray, 1);
    this._railSeedAttr.setUsage(THREE.StaticDrawUsage);
    this._railGeo.setAttribute('instanceRailSeed', this._railSeedAttr);
    this._railMesh = new THREE.InstancedMesh(
      this._railGeo,
      this._railMat,
      Math.max(1, this._rails.length)
    );
    this._railMesh.castShadow    = false;
    this._railMesh.receiveShadow = false;
    this._railMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._railMesh.count = this._rails.length;

    this._rails.forEach((rail, i) => {
      if (rail.alive) {
        this._setRailMatrix(rail);
      } else {
        // Pre-broken rail (random missing-rail generation): start hidden.
        // Still record its midpoint (for consistency/debug) without
        // writing a visible matrix.
        this._railMesh.setMatrixAt(rail.index, _zeroMatrix);
      }
      this._railSeedAttr.setX(i, Math.random());
    });
    this._railSeedAttr.needsUpdate = true;
    this._railMesh.instanceMatrix.needsUpdate = true;
    if (this._rails.length) this._railMesh.computeBoundingSphere();
    this.scene.add(this._railMesh);

    // ── Now that both instanced meshes exist and every post/rail has its
    // real index, apply the post-cascade for any post whose rails are ALL
    // missing from the start (consistent with how a real tank-break cascades).
    if (this._missingRailChance > 0) {
      for (const post of this._posts) {
        this._maybeBreakPostAtInit(post.index);
      }
    }

    // ── Shared particle sprite material (simple additive dots) ───────────
    this._particleMat = new THREE.PointsMaterial({
      color: 0x36312c,
      size: 0.5,
      transparent: false,
      opacity: 1,
      depthWrite: false,
    });
  }

  // ── Rail material: the EXACT same MeshStandardMaterial settings as the
  // posts (same color, same roughness), so there is zero chance of visual
  // mismatch — no hand-rolled lighting approximation anymore. The only
  // custom part is the vertex displacement (top/bottom split + rustic
  // tilt), injected via onBeforeCompile so real PBR lighting/shadows/
  // color-management still apply exactly like every other lit object. ────
  _createRailShaderMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x36312c,     // identical to _postMat
      roughness: 0.9,       // identical to _postMat
      metalness: 0.0,       // identical to _postMat
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSeamWidth   = { value: 0.05 };
      shader.uniforms.uSplitY      = { value: 0.0 };
      shader.uniforms.uTopTilt     = { value: 0.15 };
      shader.uniforms.uBottomTilt  = { value: 0.35 };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `
          #include <common>
          attribute float instanceRailSeed;
          uniform float uSeamWidth;
          uniform float uSplitY;
          uniform float uTopTilt;
          uniform float uBottomTilt;
          varying float vDiscard;

          float hash(float n) { return fract(sin(n) * 43758.5453123); }
          `
        )
        .replace(
          '#include <begin_vertex>',
          `
          #include <begin_vertex>

          bool isTop = transformed.y > uSplitY;
          vDiscard = step(-uSeamWidth * 0.5, transformed.y - uSplitY)
                   * step(transformed.y - uSplitY, uSeamWidth * 0.5);

          float tiltDir = hash(instanceRailSeed) * 2.0 - 1.0;
          float tiltAmt = isTop ? uTopTilt : -uBottomTilt;
          float alongT  = transformed.x + 0.5;

          transformed.y += tiltAmt * tiltDir * alongT * 0.5;
          transformed.y += isTop ? 0.04 : -0.04;
          `
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `
          #include <common>
          varying float vDiscard;
          `
        )
        .replace(
          '#include <dithering_fragment>',
          `
          #include <dithering_fragment>
          if (vDiscard > 0.5) discard;
          `
        );
    };

    return mat;
  }

  // ── Offsets every vertex of a closed polygon ring outward/inward along
// its local normal (miter-joined), by `offset` world units. Used to push
// the generated fence ring closer to or farther from the raw mask
// polygon boundary without touching the underlying mask data. Returns a
// NEW array — the original polygon is left untouched.
_offsetPolygon(polygon, offset) {
  const n = polygon.length;
  if (!offset || n < 3) return polygon;

  const result = [];
  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n];
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];

    const e1x = curr[0] - prev[0], e1z = curr[1] - prev[1];
    const e2x = next[0] - curr[0], e2z = next[1] - curr[1];
    const len1 = Math.hypot(e1x, e1z) || 1;
    const len2 = Math.hypot(e2x, e2z) || 1;

    // Perpendicular (outward-facing, for CW winding) unit normals of the
    // two edges meeting at this vertex.
    const n1x = e1z / len1, n1z = -e1x / len1;
    const n2x = e2z / len2, n2z = -e2x / len2;

    // Bisector of the two normals — the direction this vertex actually
    // needs to move to keep both adjacent edges offset by a uniform
    // perpendicular distance.
    let bx = n1x + n2x, bz = n1z + n2z;
    const blen = Math.hypot(bx, bz);
    if (blen < 1e-6) { bx = n1x; bz = n1z; } else { bx /= blen; bz /= blen; }

    // Miter length correction so sharp corners don't get pushed short —
    // clamped so very sharp/reflex corners don't spike out absurdly far.
    const dot = Math.max(-1, Math.min(1, n1x * n2x + n1z * n2z));
    const halfAngleCos = Math.sqrt((1 + dot) / 2) || 1;
    const miterScale = Math.min(1 / Math.max(halfAngleCos, 0.3), 4);

    result.push([
      curr[0] + bx * offset * miterScale,
      curr[1] + bz * offset * miterScale,
    ]);
  }
  return result;
}
  // ── Compute post + rail placement (data only) for one closed polygon
  // ring. `polygon` is an array of [worldX, worldZ] points; implicitly
  // closed (last point connects back to the first). ─────────────────────
_buildFenceRing(polygon) {
  polygon = this._offsetPolygon(polygon, this._ringOffset);
  const n = polygon.length;
  if (n < 3) return;

    const edges = [];
    let perimeter = 0;
    for (let i = 0; i < n; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % n];
      const edgeLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      edges.push({ from: a, to: b, edgeLen });
      perimeter += edgeLen;
    }
    if (perimeter < 1e-6) return;

    // Distribute postsTarget proportionally around the perimeter so
    // spacing looks even regardless of polygon shape.
    const spacing = perimeter / this.postsTarget;

    const ringPoints = [];
    let dist = 0;

    for (const edge of edges) {
      const [ax, az] = edge.from;
      const [bx, bz] = edge.to;
      const { edgeLen } = edge;

      while (dist <= edgeLen) {
        const t = edgeLen === 0 ? 0 : dist / edgeLen;
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        ringPoints.push([px, pz]);
        dist += spacing;
      }
      dist -= edgeLen;
    }
    if (ringPoints.length < 2) return;

    // ── Register posts for this ring at their GLOBAL index ────────────────
    const ringStartIdx = this._posts.length;
    for (const [px, pz] of ringPoints) {
      const terrainY = this.getTerrainY(px, pz);
      this._posts.push({
        x: px,
        z: pz,
        terrainY,
        y: terrainY + 0.7, // post instance center height (cylinder is 1.4 tall)
        alive: true,
        index: -1,          // assigned once the instanced mesh is built
      });
    }

    // ── Register rails connecting consecutive posts around this ring,
    // including the wrap-around edge back to the first post ──────────────
    const ringCount = ringPoints.length;
    if (ringCount >= 2) {
      const railCount = ringCount === 2 ? 1 : ringCount; // avoid a duplicate A->B/B->A pair
      for (let i = 0; i < railCount; i++) {
        const postA = ringStartIdx + i;
        const postB = ringStartIdx + ((i + 1) % ringCount);
        this._rails.push({ postA, postB, alive: true, index: -1 });
      }
    }
  }

  // ── Build the world matrix for one rail, oriented + stretched to span
  // exactly between its two posts ────────────────────────────────────────
  _setRailMatrix(rail) {
    const a = this._posts[rail.postA];
    const b = this._posts[rail.postB];

    const dx  = b.x - a.x;
    const dz  = b.z - a.z;
    const len = Math.hypot(dx, dz);

    if (len > 1e-6) {
      _railDir.set(dx, 0, dz).normalize();
    } else {
      _railDir.set(1, 0, 0); // degenerate (coincident posts) — direction doesn't matter, length ~0
    }
    _quat.setFromUnitVectors(_railXAxis, _railDir);

    _pos.set(
      (a.x + b.x) / 2,
      (a.terrainY + b.terrainY) / 2 + this._railYOffset,
      (a.z + b.z) / 2
    );
    _scale.set(Math.max(len, 0.001), 1, 1); // BoxGeometry is unit-length on X; scale.x = actual span

    // Remembered so a break burst can be spawned at the rail's position
    // without recomputing it later.
    rail.midX = _pos.x;
    rail.midY = _pos.y;
    rail.midZ = _pos.z;

    _m4.compose(_pos, _quat, _scale);
    this._railMesh.setMatrixAt(rail.index, _m4);
  }

  // ── Spawn a brief particle burst at a broken post's position ───────────
  _spawnBurst(x, y, z) {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const velocities = [];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 2.0;
      velocities.push({
        x: Math.cos(angle) * speed,
        y: 2.0 + Math.random() * 3.0,
        z: Math.sin(angle) * speed,
      });
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = this._particleMat.clone();
    const points = new THREE.Points(geo, material);
    this.scene.add(points);

    this._bursts.push({ points, geo, material, velocities, life: 0 });
  }

  // ── Per-frame: check tank proximity against rail SEGMENTS (not posts),
  // break rails, cascade to posts once both their rails are gone, tick
  // particle bursts, flush any dirty instance buffers ─────────────────────
  update(dt, tankPositions) {
    // ── Proximity destruction — tanks break rails, not posts directly ────
    if (tankPositions && tankPositions.length) {
      for (const rail of this._rails) {
        if (!rail.alive) continue;
        const a = this._posts[rail.postA];
        const b = this._posts[rail.postB];
        for (let i = 0; i < tankPositions.length; i++) {
          const tp = tankPositions[i];
          if (!tp) continue;
          const dsq = _distSqPointToSegmentXZ(tp.x, tp.z, a.x, a.z, b.x, b.z);
          if (dsq < this._railTriggerRadiusSq) {
            this._breakRail(rail);
            break;
          }
        }
      }
    }

    // ── Flush instance matrix updates once per frame, however many
    // posts/rails broke this frame ────────────────────────────────────────
    if (this._postDirty) {
      this._postMesh.instanceMatrix.needsUpdate = true;
      this._postDirty = false;
    }
    if (this._railDirty) {
      this._railMesh.instanceMatrix.needsUpdate = true;
      this._railDirty = false;
    }

    // ── Tick active particle bursts ───────────────────────────────────────
    for (let i = this._bursts.length - 1; i >= 0; i--) {
      const b = this._bursts[i];
      b.life += dt;

      const posAttr = b.geo.getAttribute('position');
      for (let p = 0; p < PARTICLE_COUNT; p++) {
        const v = b.velocities[p];
        posAttr.array[p * 3 + 0] += v.x * dt;
        posAttr.array[p * 3 + 1] += v.y * dt;
        posAttr.array[p * 3 + 2] += v.z * dt;
        v.y -= 9.8 * dt; // gravity
      }
      posAttr.needsUpdate = true;

      b.material.opacity = Math.max(0, 1 - b.life / PARTICLE_LIFETIME);

      if (b.life >= PARTICLE_LIFETIME) {
        this.scene.remove(b.points);
        b.geo.dispose();
        b.material.dispose();
        this._bursts.splice(i, 1);
      }
    }
  }

  // ── Rail broken by tank proximity — hides it, bursts at its midpoint,
  // then checks whether either endpoint post should now fall too ────────
  _breakRail(rail) {
    if (!rail.alive) return;
    rail.alive = false;
    this._railMesh.setMatrixAt(rail.index, _zeroMatrix);
    this._railDirty = true;
    this._spawnBurst(rail.midX, rail.midY, rail.midZ);

    this._maybeBreakPost(rail.postA);
    this._maybeBreakPost(rail.postB);
  }

  // ── A post falls once EVERY rail attached to it is broken. Posts with
  // no rails at all (e.g. a ring too small to generate one) are left
  // standing — nothing destroys them directly anymore. ──────────────────
  _maybeBreakPost(postIndex) {
    const post = this._posts[postIndex];
    if (!post.alive) return;
    if (!this._allRailsDeadForPost(postIndex)) return;
    this._breakPost(post);
  }

  // ── Init-time equivalent of _maybeBreakPost: same "all rails dead"
  // check, but silently marks the post dead with no particle burst (used
  // only when generating a naturally pre-weathered fence at load time). ──
  _maybeBreakPostAtInit(postIndex) {
    const post = this._posts[postIndex];
    if (!post.alive) return;
    if (!this._allRailsDeadForPost(postIndex)) return;

    post.alive = false;
    this._postMesh.setMatrixAt(post.index, _zeroMatrix);
    this._postDirty = true;
    // deliberately no _spawnBurst() here — nothing "broke", it just never existed
  }

  // ── Shared check: true if every rail attached to this post is not alive
  // (either tank-broken or pre-missing). Posts with no rails at all are
  // treated as "not all dead" so they stay standing. ─────────────────────
  _allRailsDeadForPost(postIndex) {
    const railIdxs = this._railsByPost.get(postIndex);
    if (!railIdxs || railIdxs.length === 0) return false;

    for (const ri of railIdxs) {
      if (this._rails[ri].alive) return false;
    }
    return true;
  }

  _breakPost(post) {
    if (!post.alive) return;
    post.alive = false;
    this._postMesh.setMatrixAt(post.index, _zeroMatrix);
    this._postDirty = true;
    this._spawnBurst(post.x, post.y, post.z);
  }

  dispose() {
    this.scene.remove(this._postMesh);
    this._postGeo.dispose();
    this._postMat.dispose();

    this.scene.remove(this._railMesh);
    this._railGeo.dispose();
    this._railMat.dispose();

    this._posts.length = 0;
    this._rails.length = 0;
    this._railsByPost.clear();

    for (const b of this._bursts) {
      this.scene.remove(b.points);
      b.geo.dispose();
      b.material.dispose();
    }
    this._bursts.length = 0;
    this._particleMat.dispose();
  }
}