import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  createGrassMaterial,
  createGrassShadowMaterial,
  syncGrassLighting,
} from './materials/GrassMaterial.js';

/** Beyond this distance the entire grass group is hidden (matches Unity "Culled" LOD band). */
const GRASS_CULL_DISTANCE = 20;

/**
 * Usage:
 *   const grass = new Grass(scene, texLoader);
 *   // In animate loop:
 *   grass.update(elapsed, camera, scene);
 */
export class Grass {
  /**
   * @param {THREE.Scene}         scene
   * @param {THREE.TextureLoader} texLoader
   */
  constructor(scene, texLoader, {onLoad} = {}) {
    this.scene = scene;
    this._onLoad   = onLoad;
    this._meshes = [];

    this._initMaterials(texLoader);
    this._initRoot();
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

    this._grassDiffuse = loadTex('/Grass_1.png', false);

    this.mat = createGrassMaterial({
      diffuse:           this._grassDiffuse,
      windForce:         0.01,
      windWavesScale:    0.3,
      windSpeed:         0.4,
      anchorBase:        true,
      color2Level:      -0.29,
      color2Fade:        0.64,
      alphaCutoff:       0.35,
      smoothness:        0.1,
      translucencyInt:   2.0,
      directLightOffset: 0.0,
      directLightInt:    1.0,
      indirectLightInt:  1.0,
    });

    this._shadowMat = createGrassShadowMaterial(this._grassDiffuse, this.mat, 0.35);
  }

  _initRoot() {
    this.root = new THREE.Group();
    this.scene.add(this.root);
  }

  _assignMaterial(mesh) {
    mesh.material            = this.mat;
    mesh.customDepthMaterial = this._shadowMat;
    mesh.castShadow          = false;
    mesh.receiveShadow       = true;

    mesh.onBeforeShadow = (rdr, obj, cam, shadowCam, geom, depthMat) => {
      depthMat.uniforms.uTime.value = this.mat.uniforms.uTime.value;
      depthMat.uniforms.map.value   = this._grassDiffuse;
    };
  }

  _registerMeshes(group) {
    group.traverse((child) => {
      if (!child.isMesh) return;
      this._assignMaterial(child);
      this._meshes.push(child);
    });
  }

  _load() {
    const loader = new FBXLoader();
    loader.load(
      '/Grass_1.fbx',
      (fbx) => {
        fbx.scale.setScalar(0.01);
        fbx.updateMatrixWorld(true);

        const lod0Group = new THREE.Group();
        fbx.traverse((child) => {
          if (!child.isMesh) return;

          let lodKey = 'LOD0';
          let node   = child;
          while (node) {
            const name = node.name || '';
            if (/LOD1/i.test(name) || /LOD2/i.test(name) || /Culled/i.test(name)) {
              lodKey = 'SKIP'; break;
            }
            if (/LOD0/i.test(name)) { lodKey = 'LOD0'; break; }
            node = node.parent;
          }

          if (lodKey === 'LOD0') lod0Group.attach(child);
        });

        if (lod0Group.children.length === 0) {
          console.warn('Grass: no LOD0 tag found – using all meshes');
          fbx.traverse((child) => {
            if (child.isMesh) lod0Group.attach(child);
          });
        }

        this._registerMeshes(lod0Group);
        this.root.add(lod0Group);
        console.log(`Grass_1.fbx loaded  (${this._meshes.length} grass mesh(es))`);
        this._onLoad?.();
      },
      (xhr) => {
        if (xhr.total) console.log(`Grass FBX … ${Math.round(xhr.loaded / xhr.total * 100)}%`);
      },
      (err) => {
        console.warn('Grass FBX load failed – using procedural fallback:', err);
        this._buildFallback();
      }
    );
  }

  _buildFallback() {
    const geo = new THREE.PlaneGeometry(0.5, 0.8, 1, 4);
    const grp = new THREE.Group();

    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(geo, this.mat);
      m.rotation.y    = (i / 3) * Math.PI;
      m.castShadow    = true;
      m.receiveShadow = true;
      m.customDepthMaterial = this._shadowMat;
      grp.add(m);
    }

    this._registerMeshes(grp);
    this.root.add(grp);
    console.log('Procedural fallback grass built');
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  /**
   * Call once per frame in the animation loop.
   * @param {number}       elapsed  - clock.getElapsedTime()
   * @param {THREE.Camera} camera
   * @param {THREE.Scene}  scene
   */
  update(elapsed, camera, scene) {
    this.mat.uniforms.uTime.value        = elapsed;
    this._shadowMat.uniforms.uTime.value = elapsed;
    syncGrassLighting(this.mat, scene);

    const dist        = camera.position.distanceTo(this.root.position);
    this.root.visible = dist <= GRASS_CULL_DISTANCE;
    this._lastDist    = dist;
  }

  /** Returns a human-readable status string for the HUD. */
  getHUDStatus() {
    const dist = Math.round(this._lastDist ?? 0);
    return this.root.visible
      ? `Grass visible (${dist}m)`
      : `Grass culled  (${dist}m)`;
  }
}