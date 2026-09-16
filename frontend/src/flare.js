import * as THREE from 'three';

// ── Tunables ─────────────────────────────────────────────────────────────
const FLARE_MAX          = 32;    // simultaneous flares in flight — a burst of 3-4 plus overlap headroom
const FLARE_LIFETIME     = 4.0;  // seconds a flare burns/decoys before despawning
const FLARE_GRAVITY      = 0.0;
const FLARE_DRAG         = 0.35; // per-second decay on horizontal velocity — flares shed speed fast, unlike shells
const FLARE_EJECT_SPEED  = 14;   // world-units/sec, relative to the plane, at moment of deploy
const FLARE_EJECT_STAGGER = 0.2; // seconds between each flare's release within a burst — 0 = simultaneous

// Decoy strength fades out over the back half of the burn — a flare stops
// being a useful decoy well before it visually disappears.
const FLARE_DECOY_FADE_START = 0.5; // fraction of FLARE_LIFETIME remaining at which strength starts fading

// ── Trail ring-buffer — identical technique to Plane._buildWingtipVortexMeshes
// / _pushVortexSample / _uploadVortexGeometry, just parameterized per flare
// slot instead of per-wingtip. Small (short) trail — flares don't need the
// long streak a wingtip vortex does.
const TRAIL_LENGTH        = 50;     // sample points per flare's trail ribbon
const TRAIL_SAMPLE_INTERVAL = 1 / 30;
const TRAIL_WIDTH          = 0.1;

// ── Glow billboard — small additive cross-plane (two perpendicular planes),
// same cheap trick bullet.js uses for its beam visuals: reads as a glow from
// most viewing angles without a true camera-facing billboard (which would
// need a camera reference threaded into update()).
const GLOW_SIZE = 0.35;

function _makeGlowTexture() {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, 'rgba(255,240,180,1)');
  grad.addColorStop(0.35, 'rgba(255,160,40,0.9)');
  grad.addColorStop(1.0, 'rgba(255,80,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(cv);
}

const _glowTex = _makeGlowTexture();
const _glowPlaneA = new THREE.PlaneGeometry(GLOW_SIZE, GLOW_SIZE);
const _glowPlaneB = _glowPlaneA.clone().rotateY(Math.PI / 2);

// Merge the two crossed planes into one geometry — one InstancedMesh, one
// draw call for all FLARE_MAX glow billboards combined.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
const _glowGeo = mergeGeometries([_glowPlaneA, _glowPlaneB], false);
_glowPlaneA.dispose();
_glowPlaneB.dispose();

const _glowMat = new THREE.MeshBasicMaterial({
  map: _glowTex,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  fog: false,
});

const _glowDummy = new THREE.Object3D();
const _zeroScale  = new THREE.Matrix4().makeScale(0, 0, 0);

export class FlareSystem {
  constructor(scene) {
    this.scene = scene;

    // ── Ballistic state — flat arrays, zero per-flare allocation, same
    // pattern as ProjectileBulletSystem in bullet.js.
    this._active = new Uint8Array(FLARE_MAX);
    this._px = new Float32Array(FLARE_MAX);
    this._py = new Float32Array(FLARE_MAX);
    this._pz = new Float32Array(FLARE_MAX);
    this._vx = new Float32Array(FLARE_MAX);
    this._vy = new Float32Array(FLARE_MAX);
    this._vz = new Float32Array(FLARE_MAX);
    this._life = new Float32Array(FLARE_MAX);
    
    // ── Pending queue — flares waiting out their stagger delay before
    // joining the active pool. deploy() isn't a per-frame hot path, so a
    // plain array of small objects here is fine (unlike the active pool).
    this._pending = [];

    // ── Glow billboard pool — single InstancedMesh, all flares share it.
    this._glowMesh = new THREE.InstancedMesh(_glowGeo, _glowMat, FLARE_MAX);
    this._glowMesh.frustumCulled = false;
    this._glowMesh.count = 0;
    scene.add(this._glowMesh);
    for (let i = 0; i < FLARE_MAX; i++) this._glowMesh.setMatrixAt(i, _zeroScale);
    this._glowMesh.instanceMatrix.needsUpdate = true;

    // ── Per-flare trail ribbons — mirrors Plane._vortexMeshes/_vortexBuffers
    // exactly, just FLARE_MAX slots instead of 2 wingtips. Built once up
    // front (cheap: tiny geometry, hidden when unused), reused across every
    // flare that occupies that slot over the system's lifetime.
    this._trailMeshes  = new Array(FLARE_MAX).fill(null);
    this._trailBuffers = new Array(FLARE_MAX).fill(null);
    this._trailSampleAccum = new Float32Array(FLARE_MAX);
    this._buildTrailMeshes();

    // Scratch — zero allocation in hot paths
    this._scratchDir   = new THREE.Vector3();
    this._scratchRight  = new THREE.Vector3();
    this._scratchUp      = new THREE.Vector3(0, 1, 0);
    this._scratchWander  = new THREE.Vector3();

    // Decoy query result — reused array, refilled each getDecoyPositions() call
    this._decoyResult = [];
  }

  _buildTrailMeshes() {
    const N = TRAIL_LENGTH;
    for (let s = 0; s < FLARE_MAX; s++) {
      const vertCount = N * 2;
      const positions = new Float32Array(vertCount * 3);
      const colors    = new Float32Array(vertCount * 4);
      const indices = [];
      for (let i = 0; i < N - 1; i++) {
        const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
        indices.push(a, b, c,  b, d, c);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(colors, 4));
      geo.setIndex(indices);
      // geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20);

      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        vertexColors: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        fog: false,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 4;
      // World-space positions are written straight into this mesh's own
      // buffer each frame (see _uploadTrail), but the mesh transform never
      // moves and its boundingSphere is a fixed 20-unit sphere at world
      // origin, never recomputed as the flare travels. With frustumCulled
      // left on, Three.js culls the trail against that stale sphere and
      // drops it whenever the flare is far from world (0,0,0) or the
      // sphere just doesn't line up with the camera frustum — causing the
      // intermittent "trail doesn't appear" behavior. Trails are cheap
      // (tiny geometry), so just skip culling entirely, matching the glow
      // InstancedMesh's frustumCulled = false.
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.scene.add(mesh);

      this._trailMeshes[s] = mesh;

      const ring = new Array(N);
      for (let i = 0; i < N; i++) ring[i] = new THREE.Vector3();
      this._trailBuffers[s] = { positions, colors, ring, head: 0, count: 0 };
    }
  }

  /**
   * Deploys a burst of flares from a world-space origin, kicked backward/
   * outward from the given forward+up basis (matches how a real flare
   * dispenser ejects behind and slightly below the aircraft).
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} planeForward
   * @param {THREE.Vector3} planeUp
   * @param {THREE.Vector3} planeVel      — plane's current velocity, flares inherit it
   * @param {number}        count
   */
  deploy(origin, planeForward, planeUp, planeVel, count = 3, getLiveState = null) {
    for (let n = 0; n < count; n++) {
      const delay = n * FLARE_EJECT_STAGGER;

      if (delay <= 0) {
        // First flare (and any if stagger is 0) fires immediately, using
        // the origin/forward/velocity snapshot passed in for THIS call.
        this._releaseFlareFrom(origin, planeForward, planeVel);
      } else {
        // Later flares wait out their delay in the pending queue.
        // getLiveState (if provided) is re-invoked at the moment each one
        // actually activates, so it spawns from wherever the plane IS BY
        // THEN — not wherever it was at the instant deploy() was called.
        // Without this, a moving plane leaves staggered flares hanging
        // behind at the original press-the-key position. Falls back to a
        // CLONED snapshot (never the live scratch objects, which get
        // overwritten elsewhere before this fires) if no getter is given.
        this._pending.push({
          timer: delay,
          getLiveState,
          origin: getLiveState ? null : origin.clone(),
          planeForward: getLiveState ? null : planeForward.clone(),
          planeVel: getLiveState ? null : { x: planeVel.x, y: planeVel.y, z: planeVel.z },
        });
      }
    }
  }

  // Computes the kick velocity from an origin/forward/velocity snapshot and
  // activates one flare. Shared by the immediate-release path in deploy()
  // and the staggered-release path in update().
  _releaseFlareFrom(origin, planeForward, planeVel) {
    const spreadAngle = (Math.random() - 0.5) * 0.9; // radians, side-to-side scatter
    const kickX = -planeForward.x + Math.sin(spreadAngle) * 0.6;
    const kickY = -0.3 + Math.random() * 0.2;

    const vx = planeVel.x + kickX * FLARE_EJECT_SPEED;
    const vy = planeVel.y + kickY * FLARE_EJECT_SPEED;
    const vz = planeVel.z + (-planeForward.z) * FLARE_EJECT_SPEED + Math.sin(spreadAngle) * 3;

    this._activateFlare(origin.x, origin.y, origin.z, vx, vy, vz);
  }

  // Activates one flare into the flat pool. Same body as the old inline
  // code that used to live directly in deploy() — factored out so update()
  // can call it too once a pending (staggered) flare's timer expires.
  _activateFlare(ox, oy, oz, vx, vy, vz) {
    let slot = -1;
    for (let i = 0; i < FLARE_MAX; i++) {
      if (!this._active[i]) { slot = i; break; }
    }
    if (slot === -1) return; // pool full — drop silently

    this._active[slot] = 1;
    this._life[slot]   = FLARE_LIFETIME;
    this._px[slot] = ox;
    this._py[slot] = oy;
    this._pz[slot] = oz;
    this._vx[slot] = vx;
    this._vy[slot] = vy;
    this._vz[slot] = vz;

    // Reset this slot's trail so a reused slot doesn't jump-connect to
    // wherever the previous flare in this slot last was. Seed the ring
    // with two coincident points at the spawn position so a trail segment
    // already exists on the very first update() call, instead of waiting
    // for two full TRAIL_SAMPLE_INTERVAL ticks to accumulate before the
    // buffer has the minimum 2 points _uploadTrail() needs to draw.
    const buf = this._trailBuffers[slot];
    buf.head  = 1;
    buf.count = 2;
    buf.ring[0].set(ox, oy, oz);
    buf.ring[1].set(ox, oy, oz);
    this._trailSampleAccum[slot] = 0;
  }

    /**
   * Immediately deactivates every in-flight flare and hides their trail
   * meshes/glow billboards. Used when the owning plane dies — without
   * this, any flares still burning at the moment of death simply freeze
   * in place (update() stops being called while isDead is true) instead
   * of disappearing, leaving a visible frozen artifact until the next
   * respawn's update() calls happen to burn them down naturally.
   */
  clearAll() {
    this._pending.length = 0;
    for (let i = 0; i < FLARE_MAX; i++) {
      this._active[i] = 0;
      this._life[i]   = 0;
      if (this._trailMeshes[i]) this._trailMeshes[i].visible = false;
      if (this._trailBuffers[i]) this._trailBuffers[i].count = 0;
    }
    this._glowMesh.count = 0;
    this._glowMesh.visible = false;
  }

  /**
   * Returns active decoy points for missile homing to check against:
   * [{ x, y, z, strength }], strength 1→0 as the flare burns out.
   * Reuses one array/objects across calls — do NOT retain the returned
   * array past the same frame.
   */
  getDecoyPositions() {
    this._decoyResult.length = 0;
    for (let i = 0; i < FLARE_MAX; i++) {
      if (!this._active[i]) continue;
      const lifeFrac = this._life[i] / FLARE_LIFETIME; // 1 → 0
      let strength = 1;
      if (lifeFrac < FLARE_DECOY_FADE_START) {
        strength = lifeFrac / FLARE_DECOY_FADE_START;
      }
      this._decoyResult.push({
        x: this._px[i], y: this._py[i], z: this._pz[i], strength,
      });
    }
    return this._decoyResult;
  }

  update(dt) {
    // ── Advance pending (staggered) flares and release any whose delay
    // has elapsed. Iterate backward so splicing mid-loop is safe.
    for (let p = this._pending.length - 1; p >= 0; p--) {
      const pend = this._pending[p];
      pend.timer -= dt;
      if (pend.timer <= 0) {
        if (pend.getLiveState) {
          const live = pend.getLiveState();
          this._releaseFlareFrom(live.origin, live.forward, live.vel);
        } else {
          this._releaseFlareFrom(pend.origin, pend.planeForward, pend.planeVel);
        }
        this._pending.splice(p, 1);
      }
    }

    let anyActive = false;
    let glowIdx = 0;

    for (let i = 0; i < FLARE_MAX; i++) {
      if (!this._active[i]) continue;
      anyActive = true;

      this._vy[i] -= FLARE_GRAVITY * dt;
      const dragFactor = Math.max(0, 1 - FLARE_DRAG * dt);
      this._vx[i] *= dragFactor;
      this._vz[i] *= dragFactor;

      this._px[i] += this._vx[i] * dt;
      this._py[i] += this._vy[i] * dt;
      this._pz[i] += this._vz[i] * dt;

      this._life[i] -= dt;
      if (this._life[i] <= 0) {
        this._active[i] = 0;
        this._trailMeshes[i].visible = false;
        continue;
      }

      // ── Glow billboard — oriented by velocity like bullet.js's tracers,
      // not true camera-billboarded (avoids threading a camera ref in here).
      const speed = Math.hypot(this._vx[i], this._vy[i], this._vz[i]);
      if (speed > 0.01) {
        this._scratchDir.set(this._vx[i] / speed, this._vy[i] / speed, this._vz[i] / speed);
      } else {
        this._scratchDir.set(0, -1, 0);
      }
      _glowDummy.position.set(this._px[i], this._py[i], this._pz[i]);
      _glowDummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this._scratchDir);
      const lifeFrac = this._life[i] / FLARE_LIFETIME;
      const scale = 0.7 + lifeFrac * 0.6; // shrinks slightly as it burns out
      _glowDummy.scale.set(scale, scale, scale);
      _glowDummy.updateMatrix();
      this._glowMesh.setMatrixAt(glowIdx, _glowDummy.matrix);
      glowIdx++;

      // ── Trail sample ────────────────────────────────────────────────
      this._trailSampleAccum[i] += dt;
      if (this._trailSampleAccum[i] >= TRAIL_SAMPLE_INTERVAL) {
        this._trailSampleAccum[i] = 0;
        const buf = this._trailBuffers[i];
        buf.head = (buf.head + 1) % TRAIL_LENGTH;
        buf.ring[buf.head].set(this._px[i], this._py[i], this._pz[i]);
        if (buf.count < TRAIL_LENGTH) buf.count++;
      }
      this._uploadTrail(i);
    }

    this._glowMesh.count = glowIdx;
    this._glowMesh.visible = glowIdx > 0;
    if (anyActive) this._glowMesh.instanceMatrix.needsUpdate = true;
  }

  _uploadTrail(slot) {
    const mesh = this._trailMeshes[slot];
    const buf  = this._trailBuffers[slot];
    const N = TRAIL_LENGTH;

    if (buf.count < 2) { mesh.visible = false; return; }

    const posAttr = mesh.geometry.attributes.position;
    const colAttr = mesh.geometry.attributes.color;
    const positions = buf.positions;
    const colors    = buf.colors;

    for (let i = 0; i < buf.count; i++) {
      const ringIdx  = (buf.head - i + N) % N;
      const p        = buf.ring[ringIdx];
      const olderIdx = (buf.head - Math.min(i + 1, buf.count - 1) + N) % N;
      const older    = buf.ring[olderIdx];

      this._scratchDir.subVectors(p, older);
      if (this._scratchDir.lengthSq() < 1e-8) this._scratchDir.set(0, 1, 0);
      this._scratchDir.normalize();

      const tailFade = 1 - (i / Math.max(1, buf.count - 1));

      this._scratchRight
        .crossVectors(this._scratchDir, this._scratchUp)
        .normalize()
        .multiplyScalar(TRAIL_WIDTH);
      if (this._scratchRight.lengthSq() < 1e-8) this._scratchRight.set(TRAIL_WIDTH, 0, 0);

      const vA = i * 2, vB = i * 2 + 1;
      positions[vA * 3]     = p.x - this._scratchRight.x;
      positions[vA * 3 + 1] = p.y - this._scratchRight.y;
      positions[vA * 3 + 2] = p.z - this._scratchRight.z;
      positions[vB * 3]     = p.x + this._scratchRight.x;
      positions[vB * 3 + 1] = p.y + this._scratchRight.y;
      positions[vB * 3 + 2] = p.z + this._scratchRight.z;

      const alpha = tailFade * tailFade * 0.85;
      colors[vA * 4]     = colors[vB * 4]     = 1;
      colors[vA * 4 + 1] = colors[vB * 4 + 1] = 0.55;
      colors[vA * 4 + 2] = colors[vB * 4 + 2] = 0.15;
      colors[vA * 4 + 3] = colors[vB * 4 + 3] = alpha;
    }

    for (let i = buf.count; i < N; i++) {
      const vA = i * 2, vB = i * 2 + 1;
      colors[vA * 4 + 3] = colors[vB * 4 + 3] = 0;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate  = true;
    mesh.visible = true;
  }

  dispose() {
    this.scene.remove(this._glowMesh);
    this._glowMesh.count = 0;
    for (let s = 0; s < FLARE_MAX; s++) {
      const mesh = this._trailMeshes[s];
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}