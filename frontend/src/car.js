// car.js — Cars loaded from houses.glb: "Car_N" (visual mesh, always
// present/visible) and "Car_collider_N" (used to build a convex Rapier
// collider for physical blocking + as the proximity trigger for the
// crush effect). There is no separate "smashed" mesh — crushing is done
// entirely via a vertex shader that pushes each car's own vertices above
// a certain local height downward toward a crush plane, animated over
// time once triggered.

import * as THREE from 'three';

const CAR_TRIGGER_RADIUS = 3.0; // metres — distance at which a tank crushes a car
const PARTICLE_LIFETIME = 0.4;
const PARTICLE_COUNT = 8;
const CRUSH_DURATION = 0.5; // seconds — how long the crush animation takes to fully settle

// Matches "Car_1", "car_12", etc. — case-insensitive, trailing index only.
const RE_CAR_INTACT = /^car_(\d+)$/i;
const RE_CAR_COLLIDER = /^car_collider_(\d+)$/i;

function _classifyCarMesh(name) {
  let m = name.match(RE_CAR_COLLIDER);
  if (m) return { kind: 'collider', index: m[1] };
  m = name.match(RE_CAR_INTACT);
  if (m) return { kind: 'intact', index: m[1] };
  return null;
}

// ── Injects the crush displacement into a material via onBeforeCompile.
// Works with any standard/physical material (keeps real PBR lighting) —
// same pattern fence.js uses for its rail-bend shader. Each car gets its
// OWN material clone + own uniforms object, so crushing one car never
// affects another that happens to share the same source material. ───────
function _installCrushShader(material, localMinY, localMaxY, localUpAxisVec) {
  const uniforms = {
    uCrushAmount: { value: 0 }, // 0 = pristine, 1 = fully crushed
    uCrushMinY: { value: localMinY },
    uCrushMaxY: { value: Math.max(localMaxY, localMinY + 0.001) }, // avoid div-by-zero on a flat mesh
    uCrushDrop: { value: Math.max(0.15, (localMaxY - localMinY) * 0.5) }, // world units the roofline sinks at full crush
    // Local-space direction that corresponds to WORLD up (0,1,0), so the
    // shader always pushes vertices toward the ground regardless of how
    // this mesh's own geometry axes are oriented relative to the world
    // (e.g. a car exported Z-up, or with a baked rotation on the mesh).
    uCrushDownLocal: { value: localUpAxisVec.clone().multiplyScalar(-1) },
    // Local-space direction that corresponds to the mesh's OWN geometric
    // "height" axis — used only to measure heightT (which vertices count
    // as "high"/roof vs "low"/underside). This can differ from world-up
    // if the mesh's local bounding box is tallest along a different axis
    // than uCrushDownLocal, but for a normally-oriented car these are the
    // same axis, just opposite sign conceptually (kept separate for clarity).
    uCrushUpLocal: { value: localUpAxisVec.clone() },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `
        #include <common>
        uniform float uCrushAmount;
        uniform float uCrushMinY;
        uniform float uCrushMaxY;
        uniform float uCrushDrop;
        uniform vec3  uCrushDownLocal;
        uniform vec3  uCrushUpLocal;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>

        // Project this vertex onto the mesh's own "up" axis (not
        // necessarily local +Y — see uCrushUpLocal, resolved on the CPU
        // from the geometry's actual bounding box) to get its height
        // within [uCrushMinY, uCrushMaxY], then normalize to 0..1.
        float vertHeight = dot(transformed, uCrushUpLocal);
        float heightT = clamp((vertHeight - uCrushMinY) / (uCrushMaxY - uCrushMinY), 0.0, 1.0);

        // Only vertices in the upper half contribute to the crush, eased
        // in smoothly from the midpoint so there's no hard seam partway
        // up the car's body.
        float crushWeight = smoothstep(0.35, 1.0, heightT);

        // Displace along the direction that corresponds to WORLD-down —
        // guarantees the roof always sinks toward the ground visually,
        // regardless of which local axis this mesh's geometry treats as
        // "up" internally (fixes cars crushing sideways/backwards instead
        // of downward when the model's local axes don't match world axes).
        transformed += uCrushDownLocal * (crushWeight * uCrushAmount * uCrushDrop);
        `,
      );
  };

  // Force a re-link of the shader program next render — required so
  // onBeforeCompile above actually takes effect. WebGLRenderer only calls
  // onBeforeCompile again when a material's version changes / on first use,
  // so this ensures it's picked up immediately.
  material.needsUpdate = true;

  return uniforms;
}

export class CarSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {RAPIER} RAPIER - the RAPIER module (world.__RAPIER__ works)
   * @param {RAPIER.World} world
   * @param {object} opts
   * @param {number} [opts.triggerRadius]
   * @param {boolean} [opts.solidCollider=true] - true = tanks physically
   *   collide with cars; false = sensor-only (tanks drive through, only
   *   the crush trigger fires).
   */
  constructor(scene, RAPIER, world, opts = {}) {
    this.scene = scene;
    this.RAPIER = RAPIER;
    this.world = world;
    this._triggerRadiusSq =
      (opts.triggerRadius ?? CAR_TRIGGER_RADIUS) *
      (opts.triggerRadius ?? CAR_TRIGGER_RADIUS);
    this._solidCollider = opts.solidCollider ?? true;

    // index -> { mesh, colliderMesh, x, y, z, crushed, crushing,
    //            crushElapsed, uniforms, rigidBody, collider }
    this._cars = new Map();
    this._bursts = [];
    this._crushing = []; // cars currently mid-animation — ticked each frame

    this._particleMat = new THREE.PointsMaterial({
      color: 0x888888,
      size: 0.6,
      transparent: false,
      opacity: 1,
      depthWrite: false,
    });
  }

  /** Registers one mesh found while traversing a loaded house GLB. Call
   * this for EVERY mesh in the traversal — it silently ignores anything
   * that doesn't match the Car_N / Car_collider_N naming. Returns true if
   * the mesh was claimed (caller should skip normal visual/collider
   * handling for it), false otherwise. */
  registerMesh(mesh) {
    const cls = _classifyCarMesh(mesh.name);
    if (!cls) return false;

    let entry = this._cars.get(cls.index);
    if (!entry) {
      entry = {
        mesh: null,
        colliderMesh: null,
        x: 0,
        y: 0,
        z: 0,
        crushed: false,
        crushing: false,
        crushElapsed: 0,
        uniforms: null,
        rigidBody: null,
        collider: null,
      };
      this._cars.set(cls.index, entry);
    }

    if (cls.kind === 'intact') {
      entry.mesh = mesh;
      mesh.visible = true;
    } else if (cls.kind === 'collider') {
      entry.colliderMesh = mesh;
      mesh.visible = false; // colliders are never rendered
    }

    return true;
  }

  /** Call once after every house GLB has finished loading and every mesh
   * has been passed through registerMesh(). Builds convex Rapier colliders
   * for every car that has a Car_collider_N mesh, caches each car's
   * world-space centroid for the proximity trigger, and installs the
   * crush shader on each car's visual material. */
  finalize() {
    for (const [index, entry] of this._cars.entries()) {
      if (!entry.mesh) {
        console.warn(`[Car] Car_collider_${index} has no matching Car_${index} mesh — skipping`);
        continue;
      }

      // ── Install the crush shader on this car's own material. Clone it
      // first — glTF exports frequently share one material across many
      // instances, and cloning guarantees this car's uCrushAmount uniform
      // is fully independent of every other car (and of the original
      // shared material, which stays untouched for anything else using it).
      //
      // ── Resolve WORLD up (0,1,0) into this mesh's LOCAL space, since
      // meshes can carry an arbitrary baked rotation (from Blender export,
      // parenting, etc.) — using raw local +Y as "up" is what caused the
      // crush to visually push the front of the car backward instead of
      // the roof downward on models whose local Y isn't aligned with
      // world Y. mesh.matrixWorld already includes every ancestor's
      // transform, so this correctly accounts for the whole export chain.
      entry.mesh.updateMatrixWorld(true);
      const _worldToLocalRot = new THREE.Matrix4()
        .extractRotation(entry.mesh.matrixWorld)
        .invert();
      const localUpAxisVec = new THREE.Vector3(0, 1, 0)
        .applyMatrix4(_worldToLocalRot)
        .normalize();

      // ── Bounding-box extent measured ALONG that resolved local-up axis
      // (not raw bbox.min.y/max.y, which assumes local Y is the tall axis).
      // Projects every vertex onto localUpAxisVec and takes the min/max —
      // correctly captures "how tall is this car" even if the geometry's
      // actual up-facing axis is X or Z locally.
      const _posAttr = entry.mesh.geometry.attributes.position;
      let localMinY = Infinity;
      let localMaxY = -Infinity;
      const _vScratch = new THREE.Vector3();
      for (let i = 0; i < _posAttr.count; i++) {
        _vScratch.set(_posAttr.getX(i), _posAttr.getY(i), _posAttr.getZ(i));
        const h = _vScratch.dot(localUpAxisVec);
        if (h < localMinY) localMinY = h;
        if (h > localMaxY) localMaxY = h;
      }

      const applyToMaterial = (mat) => {
        const cloned = mat.clone();
        const uniforms = _installCrushShader(cloned, localMinY, localMaxY, localUpAxisVec);
        return { cloned, uniforms };
      };

      if (Array.isArray(entry.mesh.material)) {
        const uniformsList = [];
        entry.mesh.material = entry.mesh.material.map((mat) => {
          const { cloned, uniforms } = applyToMaterial(mat);
          uniformsList.push(uniforms);
          return cloned;
        });
        // Multi-material mesh — drive every submaterial's uniform in lockstep.
        entry.uniforms = {
          get value() {
            return uniformsList[0]?.uCrushAmount.value ?? 0;
          },
          set value(v) {
            for (const u of uniformsList) u.uCrushAmount.value = v;
          },
        };
      } else {
        const { cloned, uniforms } = applyToMaterial(entry.mesh.material);
        entry.mesh.material = cloned;
        entry.uniforms = uniforms.uCrushAmount;
      }

      if (!entry.colliderMesh) {
        console.warn(`[Car] Car_${index} has no matching Car_collider_${index} — skipping physics/trigger for it`);
        continue;
      }

      const mesh = entry.colliderMesh;
      mesh.updateMatrixWorld(true);

      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      const worldScale = new THREE.Vector3();
      mesh.matrixWorld.decompose(worldPos, worldQuat, worldScale);

      entry.x = worldPos.x;
      entry.y = worldPos.y;
      entry.z = worldPos.z;

      // ── Build a convex hull from the collider mesh's own local-space
      // vertex positions, scaled by world scale (Rapier convex hulls are
      // defined in the rigid body's local frame, so world scale is baked
      // into the point cloud directly).
      const posAttr = mesh.geometry.attributes.position;
      if (!posAttr) {
        console.warn(`[Car] Car_collider_${index} has no position attribute — skipping`);
        continue;
      }
      const points = new Float32Array(posAttr.count * 3);
      for (let i = 0; i < posAttr.count; i++) {
        points[i * 3 + 0] = posAttr.getX(i) * worldScale.x;
        points[i * 3 + 1] = posAttr.getY(i) * worldScale.y;
        points[i * 3 + 2] = posAttr.getZ(i) * worldScale.z;
      }

      const RAPIER = this.RAPIER;
      const rq = new RAPIER.Quaternion(worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w);

      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(worldPos.x, worldPos.y, worldPos.z)
          .setRotation(rq),
      );

      const colliderDesc = RAPIER.ColliderDesc.convexHull(points);
      if (!colliderDesc) {
        console.warn(`[Car] Failed to build convex hull for Car_collider_${index} (degenerate geometry?) — skipping physics`);
        this.world.removeRigidBody(body);
        continue;
      }
      colliderDesc.setFriction(0.6).setRestitution(0.1);
      if (!this._solidCollider) colliderDesc.setSensor(true);

      const collider = this.world.createCollider(colliderDesc, body);

      entry.rigidBody = body;
      entry.collider = collider;
    }
  }

  _spawnBurst(x, y, z) {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const velocities = [];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const angle = Math.random() * Math.PI * 2;
      const speed = 2.0 + Math.random() * 2.5;
      velocities.push({
        x: Math.cos(angle) * speed,
        y: 2.5 + Math.random() * 3.5,
        z: Math.sin(angle) * speed,
      });
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = this._particleMat.clone();
    const points = new THREE.Points(geo, material);
    this.scene.add(points);

    this._bursts.push({ points, geo, material, velocities, life: 0 });
  }

  _startCrush(entry) {
    if (entry.crushed || entry.crushing) return;
    entry.crushing = true;
    entry.crushElapsed = 0;
    this._crushing.push(entry);
    this._spawnBurst(entry.x, entry.y + 0.6, entry.z);
  }

  /**
   * Per-frame: check tank proximity against every not-yet-crushed car's
   * collider centroid, start the crush animation on contact, tick both
   * in-progress crush animations and particle bursts.
   * @param {number} dt
   * @param {Array<{x:number,y:number,z:number}>} tankPositions
   */
  update(dt, tankPositions) {
    if (tankPositions && tankPositions.length) {
      for (const entry of this._cars.values()) {
        if (entry.crushed || entry.crushing || !entry.collider) continue;
        for (let i = 0; i < tankPositions.length; i++) {
          const tp = tankPositions[i];
          if (!tp) continue;
          const dx = tp.x - entry.x;
          const dz = tp.z - entry.z;
          if (dx * dx + dz * dz < this._triggerRadiusSq) {
            this._startCrush(entry);
            break;
          }
        }
      }
    }

    // ── Tick in-progress crush animations ─────────────────────────────
    for (let i = this._crushing.length - 1; i >= 0; i--) {
      const entry = this._crushing[i];
      entry.crushElapsed += dt;
      const t = Math.min(1, entry.crushElapsed / CRUSH_DURATION);
      // ease-out — fast initial impact, settles smoothly
      const eased = 1 - Math.pow(1 - t, 3);
      if (entry.uniforms) entry.uniforms.value = eased;

      if (t >= 1) {
        entry.crushing = false;
        entry.crushed = true;
        this._crushing.splice(i, 1);
      }
    }

    for (let i = this._bursts.length - 1; i >= 0; i--) {
      const b = this._bursts[i];
      b.life += dt;

      const posAttr = b.geo.getAttribute('position');
      for (let p = 0; p < PARTICLE_COUNT; p++) {
        const v = b.velocities[p];
        posAttr.array[p * 3 + 0] += v.x * dt;
        posAttr.array[p * 3 + 1] += v.y * dt;
        posAttr.array[p * 3 + 2] += v.z * dt;
        v.y -= 9.8 * dt;
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

  dispose() {
    for (const entry of this._cars.values()) {
      if (entry.rigidBody) {
        try {
          this.world.removeRigidBody(entry.rigidBody);
        } catch (_) {}
      }
      // Cloned per-car materials — dispose them (geometry is shared with
      // the original GLB scene graph, owned/disposed elsewhere).
      if (entry.mesh) {
        const mats = Array.isArray(entry.mesh.material)
          ? entry.mesh.material
          : [entry.mesh.material];
        for (const m of mats) m?.dispose?.();
      }
    }
    this._cars.clear();
    this._crushing.length = 0;

    for (const b of this._bursts) {
      this.scene.remove(b.points);
      b.geo.dispose();
      b.material.dispose();
    }
    this._bursts.length = 0;
    this._particleMat.dispose();
  }
}