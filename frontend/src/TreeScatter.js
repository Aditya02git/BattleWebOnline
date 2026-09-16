import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export class TreeScatter {
  constructor(scene, world, RAPIER, terrainBuilder, mask, options = {}) {
    this._scene   = scene;
    this._world   = world;
    this._RAPIER  = RAPIER;
    this._terrain = terrainBuilder;
    this._mask    = mask;

    const {
      count         = 200,
      worldSize     = 500,
      minSpacing    = 6,
      modelPaths    = ["/tree1.glb", "/tree2.glb"],
      colliderRadius       = 0.3,
      colliderHeight       = 1.5,
      colliderEnableRange  = 30,   // enable collider within this distance
      colliderDisableRange = 100,  // disable beyond this distance
      onLoad        = null,
    } = options;

    this._worldSize          = worldSize;
    this._onLoad             = onLoad;
    this._colliderEnableRange  = colliderEnableRange;
    this._colliderDisableRange = colliderDisableRange;
    this._colliderRadius     = colliderRadius;
    this._colliderHeight     = colliderHeight;
    this._enableSq  = colliderEnableRange  * colliderEnableRange;
    this._disableSq = colliderDisableRange * colliderDisableRange;

    // Per-tree data
    this._treeData  = [];   // { x, y, z, scale, modelIdx }
    this._bodies    = [];   // rapier bodies — parallel to _treeData
    this._bodyActive = [];  // bool — is collider currently enabled
    this._playerX = 0;
    this._playerZ = 0;
    this._renderRange = options.renderRange ?? 150;  // only draw trees within this distance
    this._renderRangeSq = this._renderRange * this._renderRange;
    this._meshes    = [];   // InstancedMesh per model variant

    this._generate(count, worldSize, minSpacing, modelPaths);
  }

  // ── Build positions ────────────────────────────────────────────────────────
  _buildPositions(count, worldSize, minSpacing, numModels) {
  const maxTries = count * 30;
  const minSq    = minSpacing * minSpacing;
  const placed   = [];

  // ── Spatial grid for O(1) neighbor lookup ─────────────────────────────
  const cellSize = minSpacing;
  const grid     = new Map();
  const DIRS     = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,0],[0,1],[1,-1],[1,0],[1,1]];

  const isTooClose = (x, z) => {
    const cx = Math.floor(x / cellSize);
    const cz = Math.floor(z / cellSize);
    for (const [dx, dz] of DIRS) {
      const p = grid.get(`${cx + dx},${cz + dz}`);
      if (!p) continue;
      const ddx = p.x - x, ddz = p.z - z;
      if (ddx * ddx + ddz * ddz < minSq) return true;
    }
    return false;
  };

  for (let tries = 0; tries < maxTries && placed.length < count; tries++) {
    const x = (Math.random() - 0.5) * worldSize;
    const z = (Math.random() - 0.5) * worldSize;

    if (this._mask && !this._mask.isTree(x, z, worldSize)) continue;
    if (isTooClose(x, z)) continue;

    const key = `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
    grid.set(key, { x, z });

    placed.push({
      x,
      y:        this._terrain.getHeightAtWorld(x, z),
      z,
      scale:    10.0,
      rotY:     Math.random() * Math.PI * 2,
      modelIdx: Math.floor(Math.random() * numModels),
    });
  }
  return placed;
}

  // ── Main async generator ───────────────────────────────────────────────────
  async _generate(count, worldSize, minSpacing, modelPaths) {
    const loader = new GLTFLoader();

    // Load all model templates
    const templates = await Promise.all(
      modelPaths.map(p =>
        new Promise((res, rej) =>
          loader.load(p, g => res(g.scene), undefined, rej)
        )
      )
    );

    // Generate positions
    this._treeData = this._buildPositions(count, worldSize, minSpacing, templates.length);
    const total    = this._treeData.length;

    // ── Build one InstancedMesh per model variant ──────────────────────────
    // Count how many instances each model needs
    const countPerModel = new Array(templates.length).fill(0);
    // const _combinedMatrix = new THREE.Matrix4();
    for (const td of this._treeData) countPerModel[td.modelIdx]++;

    // For each model template, collect all its meshes and build InstancedMeshes
    this._instanceGroups = []; // [modelIdx] → [{ iMesh, geometry, material }]

    this._dummy          = new THREE.Object3D();
    this._combinedMatrix = new THREE.Matrix4();
    const _dummy         = this._dummy;

    for (let mi = 0; mi < templates.length; mi++) {
      const template  = templates[mi];
      const instCount = countPerModel[mi];
      if (instCount === 0) continue;

      const group = [];

      // Walk every mesh inside the template
      template.traverse(child => {
        if (!child.isMesh) return;

        const iMesh = new THREE.InstancedMesh(
          child.geometry,
          child.material,
          instCount
        );
        iMesh.castShadow    = true;
        iMesh.receiveShadow = true;
        iMesh.count         = instCount;
        this._scene.add(iMesh);
        group.push({ iMesh, localMatrix: child.matrixWorld.clone() });
      });

      this._instanceGroups[mi] = group;
    }

    // ── Write instance matrices ────────────────────────────────────────────
    const instanceCounters = new Array(templates.length).fill(0);

    for (const td of this._treeData) {
  if (td._fallen) continue;   // ← ADD THIS LINE right after the for line
      const mi      = td.modelIdx;
      const idx     = instanceCounters[mi]++;
      const group   = this._instanceGroups[mi];
      if (!group) continue;

      _dummy.position.set(td.x, td.y, td.z);
      _dummy.rotation.set(0, td.rotY, 0);
      _dummy.scale.setScalar(td.scale);
      _dummy.updateMatrix();

      for (const { iMesh, localMatrix } of group) {
        this._combinedMatrix.multiplyMatrices(_dummy.matrix, localMatrix);
        iMesh.setMatrixAt(idx, this._combinedMatrix);
      }
    }

    // Upload all instance buffers
    for (const group of this._instanceGroups) {
      if (!group) continue;
      for (const { iMesh } of group) iMesh.instanceMatrix.needsUpdate = true;
    }

    // ── Create Rapier colliders (all start disabled) ───────────────────────
    if (this._world && this._RAPIER) {
      for (const td of this._treeData) {
        const body = this._world.createRigidBody(
          this._RAPIER.RigidBodyDesc.fixed()
            .setTranslation(td.x, td.y + this._colliderHeight, td.z)
        );
        const col = this._world.createCollider(
          this._RAPIER.ColliderDesc
            .cylinder(this._colliderHeight, this._colliderRadius * td.scale),
          body
        );
        // Start disabled — updateColliderLOD() will enable when player is close
        col.setSensor(false);
        col.setActiveEvents(this._RAPIER.ActiveEvents.COLLISION_EVENTS);
        body.setEnabled(false);

        this._bodies.push({ body, col });
        this._bodyActive.push(false);
      }
    }

    this._templates = templates; // store for clone use
    console.log(`[TreeScatter] Placed ${total} trees (${templates.length} model variants, instanced)`);
    this._onLoad?.();
  }

  // ── Call this every frame (or every N frames) with player world position ──
  updateColliderLOD(playerX, playerZ) {
  const enableSq  = this._enableSq;
  const disableSq = this._disableSq;

  for (let i = 0; i < this._treeData.length; i++) {
    const td  = this._treeData[i];
    if (td._fallen) continue;   // ← skip already fallen trees

    const dx  = td.x - playerX;
    const dz  = td.z - playerZ;
    const dsq = dx * dx + dz * dz;

    const entry = this._bodies[i];
    if (!entry) continue;
    const { body } = entry;

    if (dsq < enableSq && !this._bodyActive[i]) {
      body.setEnabled(true);
      this._bodyActive[i] = true;
    } else if (dsq > disableSq && this._bodyActive[i]) {
      body.setEnabled(false);
      this._bodyActive[i] = false;
    }
  }
}

  // ADD this new method:
updateVisibility(playerX, playerZ) {
  this._playerX = playerX;
  this._playerZ = playerZ;

  if (!this._instanceGroups) return;

  const instanceCounters = new Array(this._instanceGroups.length).fill(0);

  for (const td of this._treeData) {
    if (td._fallen) continue;   // ← ADD THIS LINE — was missing!

    const mi  = td.modelIdx;
    const dx  = td.x - playerX;
    const dz  = td.z - playerZ;
    const dsq = dx * dx + dz * dz;
    if (dsq > this._renderRangeSq) continue;

    const group = this._instanceGroups[mi];
    if (!group) continue;

    const idx = instanceCounters[mi]++;

    const dummy = this._dummy;
    dummy.position.set(td.x, td.y, td.z);
    dummy.rotation.set(0, td.rotY, 0);
    dummy.scale.setScalar(td.scale);
    dummy.updateMatrix();

    for (const { iMesh, localMatrix } of group) {
      this._combinedMatrix.multiplyMatrices(dummy.matrix, localMatrix);
      iMesh.setMatrixAt(idx, this._combinedMatrix);
    }
  }

  for (let mi = 0; mi < this._instanceGroups.length; mi++) {
    const group = this._instanceGroups[mi];
    if (!group) continue;
    const count = instanceCounters[mi];
    for (const { iMesh } of group) {
      iMesh.count = count;
      iMesh.instanceMatrix.needsUpdate = true;
    }
  }
}

// ── Tree falling system ────────────────────────────────────────────────────
// Call this when a tree at index `treeIdx` is hit from direction (hitDirX, hitDirZ)
knockTree(treeIdx, hitDirX, hitDirZ, templates) {
  if (this._fallenSet?.has(treeIdx)) return; // already falling
  if (!this._fallenSet) this._fallenSet = new Set();
  this._fallenSet.add(treeIdx);

  const td = this._treeData[treeIdx];
  if (!td) return;

  // Disable collider immediately
  const entry = this._bodies[treeIdx];
  if (entry) {
    entry.body.setEnabled(false);
    this._bodyActive[treeIdx] = false;
  }

  // Hide this tree from the instanced buffer by zeroing its scale
  const group = this._instanceGroups?.[td.modelIdx];
  if (group) {
    const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    // Find which instance index this treeData corresponds to
    let instanceIdx = 0;
    for (let i = 0; i < treeIdx; i++) {
      if (this._treeData[i].modelIdx === td.modelIdx && !this._fallenSet.has(i)) instanceIdx++;
    }
    // We'll just zero-scale the slot — handled properly in next updateVisibility call
  }

  // Mark as fallen so updateVisibility skips it
  td._fallen = true;

  // Spawn a temporary clone mesh for the fall animation
  this._spawnFallingClone(td, treeIdx, hitDirX, hitDirZ, templates);
}

_spawnFallingClone(td, treeIdx, hitDirX, hitDirZ, templates) {
  if (!this._fallingClones) this._fallingClones = [];

  // Build a simple clone group from the instance group
  const group = this._instanceGroups?.[td.modelIdx];
  if (!group) return;

  const pivot = new THREE.Object3D();
  pivot.position.set(td.x, td.y, td.z);
  pivot.rotation.y = td.rotY;
  pivot.scale.setScalar(td.scale);

  for (const { iMesh, localMatrix } of group) {
    const cloneMesh = new THREE.Mesh(iMesh.geometry, iMesh.material);
    cloneMesh.applyMatrix4(localMatrix);
    cloneMesh.castShadow = true;
    pivot.add(cloneMesh);
  }

  this._scene.add(pivot);

  // Fall direction: opposite of hit direction
  const fallDirX = hitDirX;
  const fallDirZ = hitDirZ;
  const angle = Math.atan2(fallDirX, fallDirZ);

  this._fallingClones.push({
    pivot,
    elapsed:  0,
    duration: 1.4,
    sinkDelay: 1.4,
    sinkDuration: 0.6,
    angle,           // rotation axis direction
    startY: td.y,
    done: false,
  });
}

// ── Call this every frame from your game loop ──────────────────────────────
updateFallingTrees(dt) {
  if (!this._fallingClones?.length) return;

  for (const c of this._fallingClones) {
    if (c.done) continue;
    c.elapsed += dt;

    if (c.elapsed < c.duration) {
      // Fall over: rotate pivot around the fall axis
      const t = c.elapsed / c.duration;
      const eased = t * t * (3 - 2 * t); // smoothstep
      const fallAngle = eased * (Math.PI / 2);

      // Tilt the pivot in the fall direction
      c.pivot.rotation.x = Math.cos(c.angle) * fallAngle;  // approximate tilt
      c.pivot.rotation.z = -Math.sin(c.angle) * fallAngle;

    } else {
      // Sinking phase
      const sinkT = Math.min((c.elapsed - c.sinkDelay) / c.sinkDuration, 1);
      c.pivot.position.y = c.startY - sinkT * 4; // sink 4 units down

      if (sinkT >= 1) {
        // Done — remove clone
        this._scene.remove(c.pivot);
        c.pivot.traverse(child => {
          if (child.isMesh) {
            child.geometry?.dispose();
          }
        });
        c.done = true;
      }
    }
  }

  // Clean up finished entries periodically
  if (this._fallingClones.some(c => c.done)) {
    this._fallingClones = this._fallingClones.filter(c => !c.done);
  }
}

  dispose() {
    // Remove all InstancedMeshes
    for (const group of (this._instanceGroups ?? [])) {
      if (!group) continue;
      for (const { iMesh } of group) {
        this._scene.remove(iMesh);
        iMesh.geometry?.dispose();
        if (Array.isArray(iMesh.material)) iMesh.material.forEach(m => m.dispose());
        else iMesh.material?.dispose();
      }
    }
    // Remove all colliders
    for (const { body } of this._bodies) {
      try { this._world.removeRigidBody(body); } catch (_) {}
    }
    for (const c of (this._fallingClones ?? [])) {
  if (!c.done) {
    this._scene.remove(c.pivot);
    c.pivot.traverse(child => {
      if (child.isMesh) child.geometry?.dispose();
    });
  }
}
this._fallingClones = [];
this._fallenSet     = new Set();
    this._instanceGroups = [];
    this._bodies         = [];
    this._bodyActive     = [];
    this._treeData       = [];
  }
}