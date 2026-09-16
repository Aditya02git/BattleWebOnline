// DistanceFoliageManager.js — instances DistanceFir.glb / DistanceBush.glb onto
// every "Foliage*" empty found inside the houses.glb hierarchy, using each
// empty's own world transform (position + rotation + scale) as-is.
//
// Usage (see main.js hook-in notes at the bottom of this file):
//
//   import { DistanceFoliageManager } from './DistanceFoliageManager.js';
//   const distanceFoliage = new DistanceFoliageManager();
//   await distanceFoliage.build(root, {
//     firPath:   '/DistanceFir.glb',
//     bushPath:  '/DistanceBush.glb',
//     firRatio:  0.5,   // 50% fir / 50% bush, randomly assigned per-empty
//   });
//   scene.add(distanceFoliage.group);
//
// Call this once per loaded house root (i.e. inside loadHouse(), right after
// `scene.add(root)`), or once per map after all houses are loaded — either
// works since it just walks whatever THREE.Group you hand it looking for
// Object3D children (Empties) named "Foliage*".

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export class DistanceFoliageManager {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'DistanceFoliage';
    this._firMesh  = null; // THREE.InstancedMesh
    this._bushMesh = null; // THREE.InstancedMesh
    this._built    = false;
  }

  /**
   * Scans `root` (a loaded GLTF scene / THREE.Group, e.g. the house root
   * returned by GLTFLoader) for every descendant Object3D whose name starts
   * with "Foliage", then instances DistanceFir/DistanceBush onto those
   * transforms, randomly split by `firRatio`.
   *
   * @param {THREE.Object3D} root - root node to search under (house GLB root)
   * @param {Object} opts
   * @param {string} [opts.firPath]  - path to DistanceFir.glb
   * @param {string} [opts.bushPath] - path to DistanceBush.glb
   * @param {number} [opts.firRatio] - 0..1 probability an empty becomes a fir (rest = bush)
   * @param {number} [opts.seed]     - optional RNG seed for reproducible placement
   */
  async build(root, opts = {}) {
    const {
      firPath  = '/DistanceFir.glb',
      bushPath = '/DistanceBush.glb',
      firRatio = 0.5,
      seed     = null,
    } = opts;

    // ── Collect every "Foliage*" empty under this root ─────────────────────
    const foliageEmpties = [];
    root.updateMatrixWorld(true);
    root.traverse((child) => {
      if (child.name && child.name.startsWith('Foliage')) {
        foliageEmpties.push(child);
      }
    });

    if (foliageEmpties.length === 0) {
      console.warn('[DistanceFoliageManager] No "Foliage*" empties found under root.');
      return;
    }

    // ── Deterministic RNG (optional) so placement is reproducible if a seed
    // is supplied — otherwise falls back to Math.random(). ─────────────────
    const rand = seed != null ? _mulberry32(seed) : Math.random;

    // ── Randomly split empties into fir vs bush buckets, per-empty ─────────
    const firTransforms  = [];
    const bushTransforms = [];

    const _pos   = new THREE.Vector3();
    const _quat  = new THREE.Quaternion();
    const _scale = new THREE.Vector3();

    for (const empty of foliageEmpties) {
      empty.getWorldPosition(_pos);
      empty.getWorldQuaternion(_quat);
      empty.getWorldScale(_scale);

      const target = rand() < firRatio ? firTransforms : bushTransforms;
      target.push({
        position: _pos.clone(),
        quaternion: _quat.clone(),
        scale: _scale.clone(),
      });
    }

    // ── Load both source models in parallel ─────────────────────────────────
    const loader = new GLTFLoader();
    const [firGltf, bushGltf] = await Promise.all([
      firTransforms.length  > 0 ? loader.loadAsync(firPath)  : Promise.resolve(null),
      bushTransforms.length > 0 ? loader.loadAsync(bushPath) : Promise.resolve(null),
    ]);

    if (firGltf)  this._firMesh  = this._buildInstancedMesh(firGltf,  firTransforms,  'DistanceFir');
    if (bushGltf) this._bushMesh = this._buildInstancedMesh(bushGltf, bushTransforms, 'DistanceBush');

    this._built = true;
  }

  /**
   * Builds one InstancedMesh from a loaded GLTF's first mesh, stamping one
   * matrix per transform. If the source GLB has multiple mesh nodes, only
   * the first found mesh is used (typical for a single low-poly distance
   * impostor model — extend this if your source has multiple parts).
   */
  _buildInstancedMesh(gltf, transforms, label) {
    let sourceMesh = null;
    gltf.scene.traverse((child) => {
      if (!sourceMesh && child.isMesh) sourceMesh = child;
    });

    if (!sourceMesh) {
      console.warn(`[DistanceFoliageManager] "${label}" GLB has no mesh — skipped.`);
      return null;
    }

    const geometry = sourceMesh.geometry;
    const material = sourceMesh.material;

    const instMesh = new THREE.InstancedMesh(geometry, material, transforms.length);
    instMesh.name = label;
    instMesh.castShadow    = false;   // perf: distance foliage never casts/receives shadows
    instMesh.receiveShadow = false;
    instMesh.frustumCulled = false;   // instances are spread across the whole map — avoid the
                                       // whole batch popping out when the mesh's own origin (0,0,0)
                                       // leaves view; same reasoning as the flight-cloud field in main.js

    const m = new THREE.Matrix4();
    transforms.forEach((t, i) => {
      m.compose(t.position, t.quaternion, t.scale);
      instMesh.setMatrixAt(i, m);
    });
    instMesh.instanceMatrix.needsUpdate = true;

    this.group.add(instMesh);
    return instMesh;
  }

  dispose() {
    for (const mesh of [this._firMesh, this._bushMesh]) {
      if (!mesh) continue;
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose());
      else mesh.material?.dispose();
      this.group.remove(mesh);
    }
    this._firMesh  = null;
    this._bushMesh = null;
    this._built    = false;
  }
}

// ── Small seeded PRNG (mulberry32) — only used if a seed is passed in ──────
function _mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}