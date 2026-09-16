import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  createFirTrunkMaterial,
  createFirBranchMaterial,
  createBranchShadowMaterial,
  syncFirLighting,
} from './materials/FirMaterial.js';

/**
 * Usage:
 *   const fir = new FirTree(scene, texLoader);
 *   // In animate loop:
 *   fir.update(elapsed, camera, scene);
 */

export class FirTree {
  /**
   * @param {THREE.Scene}         scene
   * @param {THREE.TextureLoader} texLoader
   */
  constructor(scene, texLoader, { onLoad } = {}) {
    this.scene           = scene;
    this._onLoad   = onLoad;
    this.branchMat       = null;
    this.branchShadowMat = null;
    this.branchDiffuse   = null;

    this._initMaterials(texLoader);
    this._initLOD();
    this._load();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _initMaterials(texLoader) {
    const loadTex = (path, srgb = true) => {
      const t = texLoader.load(path);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };

    // Branch / needle texture  (alpha channel drives cutout)
    this.branchDiffuse = loadTex('/Fir_Branch.png', false);

    this._trunkShadowMat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side:         THREE.FrontSide,
    });

    this._trunkMat = createFirTrunkMaterial({
      color:     new THREE.Color('#4f3626'),
      roughness: 0.9,
      metalness: 0.0,
    });
    this._trunkMat.shadowSide = THREE.FrontSide;

    this.branchMat = createFirBranchMaterial({
      diffuse:           this.branchDiffuse,
      windForce:         0.4,
      windWavesScale:    0.08,
      windSpeed:         0.508,
      anchorBase:        false,
      mainColor:         new THREE.Color(0.04, 0.18, 0.05),
      secondColor:       new THREE.Color(0.08, 0.28, 0.07),
      color2Level:      -7.5,
      color2Fade:       -0.06,
      alphaCutoff:       0.35,
      smoothness:        0.05,
      translucencyInt:   10.0,
      directLightOffset: 0,
      directLightInt:    1,
      indirectLightInt:  1,
    });

    this.branchShadowMat = createBranchShadowMaterial(
      this.branchDiffuse,
      this.branchMat,
      0.35
    );
  }

  _initLOD() {
    this._branchMeshes = [];
    this.lod = new THREE.LOD();
    this.scene.add(this.lod);
  }

  _load() {
    const loader = new FBXLoader();
    loader.load(
      '/Fir_2.fbx',
      (fbx) => {
        const wrapper = new THREE.Group();
        wrapper.scale.setScalar(0.015);
        wrapper.add(fbx);
        wrapper.updateMatrixWorld(true);

        const groups    = this._extractLODGroups(fbx);
        const distances = { LOD0: 0, LOD1: 15, LOD2: 35 };

        ['LOD0', 'LOD1', 'LOD2'].forEach((key) => {
          if (groups[key]) {
            this.lod.addLevel(groups[key], distances[key]);
            this._registerBranchMeshes(groups[key]);
            console.log(`Fir ${key}: ${groups[key].children.length} mesh(es)`);
          }
        });

        if (this.lod.levels.length === 0) {
          console.warn('No LOD groups found in fir – treating whole FBX as LOD0');
          fbx.traverse((c) => { if (c.isMesh) this._assignMaterials(c); });
          this._registerBranchMeshes(wrapper);
          this.lod.addLevel(wrapper, 0);
        }

        console.log('Fir_1.fbx loaded');
        this._onLoad?.();
      },
      (xhr) => {
        if (xhr.total) console.log(`Fir FBX … ${Math.round(xhr.loaded / xhr.total * 100)}%`);
      },
      (err) => {
        console.warn('Fir FBX load failed – using procedural fallback:', err);
        this._buildFallback();
      }
    );
  }

  _assignMaterials(mesh) {
    const {
      _trunkMat:       trunkMat,
      branchMat,
      _trunkShadowMat: trunkShadowMat,
    } = this;

    if (Array.isArray(mesh.material)) {
      // Multi-material slot: slot 0 = trunk, slot 1 = branches
      mesh.material = mesh.material.map((_, i) => (i === 0 ? trunkMat : branchMat));
      mesh.castShadow    = true;
      mesh.receiveShadow = true;
      mesh.onBeforeShadow = function(rdr, obj, cam, shadowCam, geom, depthMat, group) {
        if (!group) return;
        const groupMat = obj.material[group.materialIndex];
        if (groupMat === branchMat) {
          depthMat.uniforms.uTime.value = branchMat.uniforms.uTime.value;
          depthMat.uniforms.map.value   = this.branchDiffuse;
        }
      }.bind(this);
    } else {
      const n = (mesh.name || '').toLowerCase();
      const isTrunk = n.includes('trunk') || n.includes('bark') || n.includes('stem');
      if (isTrunk) {
        mesh.material            = trunkMat;
        mesh.customDepthMaterial = trunkShadowMat;
      } else {
        // Default to branch material for needles/branches
        mesh.material = branchMat;
      }
      mesh.castShadow    = true;
      mesh.receiveShadow = true;
    }
  }

  _registerBranchMeshes(group) {
    const { branchMat, branchShadowMat, branchDiffuse, _branchMeshes } = this;

    group.traverse((child) => {
      if (!child.isMesh) return;
      if (Array.isArray(child.material)) {
        child.customDepthMaterial = branchShadowMat;
        _branchMeshes.push(child);
      } else if (child.material === branchMat) {
        child.customDepthMaterial = branchShadowMat;
        child.onBeforeShadow = function(rdr, obj, cam, shadowCam, geom, depthMat) {
          depthMat.uniforms.uTime.value = branchMat.uniforms.uTime.value;
          depthMat.uniforms.map.value   = branchDiffuse;
        };
        _branchMeshes.push(child);
      }
    });
  }

  _extractLODGroups(fbx) {
    const collected = [];
    fbx.traverse((child) => {
      if (!child.isMesh) return;
      let lodKey = null;
      let node   = child;
      while (node) {
        const name = node.name || '';
        if (/LOD0/i.test(name)) { lodKey = 'LOD0'; break; }
        if (/LOD1/i.test(name)) { lodKey = 'LOD1'; break; }
        if (/LOD2/i.test(name)) { lodKey = 'LOD2'; break; }
        node = node.parent;
      }
      collected.push({ mesh: child, lodKey: lodKey || 'LOD0' });
    });

    const buckets = {};
    for (const { mesh, lodKey } of collected) {
      this._assignMaterials(mesh);
      if (!buckets[lodKey]) buckets[lodKey] = new THREE.Group();
      buckets[lodKey].attach(mesh);
    }
    return buckets;
  }

  _buildFallback() {
    const { _trunkMat: trunkMat, branchMat, _trunkShadowMat: trunkShadowMat } = this;

    // Fir silhouette: narrow cone stacked in tiers
    const makeTier = (r, h, py) => {
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 10), branchMat);
      m.position.y = py;
      m.castShadow = true;
      return m;
    };
    const makeTrunk = (segs = 8) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, 4, segs), trunkMat);
      m.position.y = 2.0;
      m.castShadow = true;
      m.customDepthMaterial = trunkShadowMat;
      return m;
    };

    const lod0 = new THREE.Group();
    lod0.add(makeTrunk(10));
    lod0.add(makeTier(2.2, 3.0, 5.0));
    lod0.add(makeTier(1.8, 2.8, 7.2));
    lod0.add(makeTier(1.3, 2.4, 9.0));
    lod0.add(makeTier(0.8, 2.0, 10.5));

    const lod1 = new THREE.Group();
    lod1.add(makeTrunk(7));
    lod1.add(makeTier(2.2, 7.5, 7.0));

    const lod2 = new THREE.Group();
    lod2.add(makeTrunk(5));
    lod2.add(makeTier(2.4, 8.0, 7.5));

    this.lod.addLevel(lod0, 0);
    this.lod.addLevel(lod1, 15);
    this.lod.addLevel(lod2, 35);
    [lod0, lod1, lod2].forEach((g) => this._registerBranchMeshes(g));
    console.log('Procedural fir fallback built');
  }

  // ─── Falling ───────────────────────────────────────────────────────────────

startFall(hitDirX, hitDirZ) {
  if (this._falling || this._fallen) return;
  this._falling  = true;
  this._elapsed  = 0;
  this._duration = 1.4;
  this._sinkDelay    = 1.4;
  this._sinkDuration = 0.6;
  this._angle    = Math.atan2(hitDirX, hitDirZ);
  this._startY   = this.lod.position.y;
}

  // ─── Public ────────────────────────────────────────────────────────────────

  /**
   * Call once per frame in the animation loop.
   * @param {number}          elapsed  - clock.getElapsedTime()
   * @param {THREE.Camera}    camera
   * @param {THREE.Scene}     scene
   */
update(elapsed, camera, scene) {
  this.branchMat.uniforms.uTime.value = elapsed;
  this.branchShadowMat.uniforms.uTime.value = elapsed;
  syncFirLighting(this.branchMat, scene);
  this.lod.update(camera);

  // ── Falling animation ──────────────────────────────────────────────────
  if (this._falling && !this._fallen) {
    this._elapsed += (elapsed - (this._prevElapsed ?? elapsed));

    if (this._elapsed < this._duration) {
      const t      = this._elapsed / this._duration;
      const eased  = t * t * (3 - 2 * t);
      const angle  = eased * (Math.PI / 2);
      this.lod.rotation.x =  Math.cos(this._angle) * angle;
      this.lod.rotation.z = -Math.sin(this._angle) * angle;
    } else {
      const sinkT = Math.min(
        (this._elapsed - this._sinkDelay) / this._sinkDuration, 1
      );
      this.lod.position.y = this._startY - sinkT * 4;
      if (sinkT >= 1) {
        this._fallen  = true;
        this._falling = false;
        this.lod.visible = false;
      }
    }
  }
  this._prevElapsed = elapsed;
}
  /** Returns the active LOD level index (useful for HUD). */
  getActiveLODLevel() {
    for (let i = 0; i < this.lod.levels.length; i++) {
      if (this.lod.levels[i].object.visible) return i;
    }
    return 0;
  }

  /** Distance from camera to tree LOD origin. */
  distanceTo(camera) {
    return Math.round(camera.position.distanceTo(this.lod.position));
  }
}