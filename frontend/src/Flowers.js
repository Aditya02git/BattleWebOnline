import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  createFlowersMaterial,
  createFlowersShadowMaterial,
  syncFlowersLighting,
} from './materials/FlowersMaterial.js';

/**
 * Usage:
 *   const flowers = new Flowers(scene, texLoader);
 *   // In animate loop:
 *   flowers.update(elapsed, camera, scene);
 */

/** Beyond this distance the flowers group is hidden entirely. */
const FLOWERS_CULL_DISTANCE = 20;

export class Flowers {
  /**
   * @param {THREE.Scene}         scene
   * @param {THREE.TextureLoader} texLoader
   * @param {object}              [options]
   * @param {number}              [options.cullDistance=20]
   */
  constructor(scene, texLoader, options = {}, {onLoad} = {}) {
    this.scene         = scene;
    this._onLoad = onLoad;
    this._meshes       = [];
    this._lastDist     = 0;
    this._cullDistance = options.cullDistance ?? FLOWERS_CULL_DISTANCE;

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

    // Flower atlas — alpha channel drives cutout
    this._diffuse = loadTex('/Flowers.png', false);

    this.mat = createFlowersMaterial({
      diffuse:           this._diffuse,
      windForce:         0.01,
      windWavesScale:    0.3,
      windSpeed:         0.4,
      anchorBase:        true,
      mainColor:         new THREE.Color(1.0, 0.08, 0.58),   // magenta-pink flower head
      secondColor:       new THREE.Color(0.12, 0.40, 0.06),  // green stem

      // ── KEY: UV.y-based color split ──────────────────────────────────────
      // flowerStart = UV.y threshold where pink begins.
      //   0.6 → bottom 60% of UV is green stem, top 40% is pink flower head
      //   Raise toward 1.0 to make stem area larger (more green)
      //   Lower toward 0.0 to make flower head area larger (more pink)
      flowerStart:       0.6,

      // colorBlend = softness of the green↔pink transition (0 = hard edge)
      colorBlend:        0.12,
      // ─────────────────────────────────────────────────────────────────────

      alphaCutoff:       0.35,
      smoothness:        0.1,
      translucencyInt:   3.0,
      directLightOffset: 0.0,
      directLightInt:    1.0,
      indirectLightInt:  1.0,
    });

    this._shadowMat = createFlowersShadowMaterial(this._diffuse, this.mat, 0.35);
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
      depthMat.uniforms.map.value   = this._diffuse;
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
      '/Flowers.fbx',
      (fbx) => {
        fbx.scale.setScalar(0.01);
        fbx.updateMatrixWorld(true);

        // Extract LOD0 only — skip LOD1 / LOD2 / Culled bands
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

        // If FBX has no LOD tags at all, use everything
        if (lod0Group.children.length === 0) {
          console.warn('Flowers: no LOD0 tag found – using all meshes');
          fbx.traverse((child) => {
            if (child.isMesh) lod0Group.attach(child);
          });
        }

        this._registerMeshes(lod0Group);
        this.root.add(lod0Group);
        console.log(`Flowers.fbx loaded  (${this._meshes.length} mesh(es))`);
        this._onLoad?.();
      },
      (xhr) => {
        if (xhr.total) console.log(`Flowers FBX … ${Math.round(xhr.loaded / xhr.total * 100)}%`);
      },
      (err) => {
        console.warn('Flowers FBX load failed – using procedural fallback:', err);
        this._buildFallback();
      }
    );
  }

  _buildFallback() {
    // Simple crossed-plane fallback — two quads forming an X
    const geo = new THREE.PlaneGeometry(0.4, 0.7, 1, 4);
    const grp = new THREE.Group();

    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(geo, this.mat);
      m.rotation.y    = (i / 2) * Math.PI;
      m.position.y    = 0.35;
      m.castShadow    = true;
      m.receiveShadow = true;
      m.customDepthMaterial = this._shadowMat;
      grp.add(m);
    }

    this._registerMeshes(grp);
    this.root.add(grp);
    console.log('Procedural fallback flowers built');
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
    syncFlowersLighting(this.mat, scene);

    const dist        = camera.position.distanceTo(this.root.position);
    this._lastDist    = dist;
    this.root.visible = dist <= this._cullDistance;
  }

  /** Returns a human-readable HUD string. */
  getHUDStatus() {
    const dist = Math.round(this._lastDist);
    return this.root.visible
      ? `Flowers visible (${dist}m)`
      : `Flowers culled  (${dist}m)`;
  }
}