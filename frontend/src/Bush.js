import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import {
  createBushLeavesMaterial,
  createBushShadowMaterial,
  syncBushLighting,
} from "./materials/BushMaterial.js";

/**
 * Usage:
 *   const bush = new Bush(scene, texLoader);
 *   // In animate loop:
 *   bush.update(elapsed, camera, scene);
 */

export class Bush {
  /**
   * @param {THREE.Scene}         scene
   * @param {THREE.TextureLoader} texLoader
   * @param {object}              [options]
   * @param {number}              [options.cullDistance=25]  Distance at which the bush is fully culled.
   */
  constructor(scene, texLoader, options = {}) {
    this.scene = scene;
    this._onLoad = options.onLoad ?? null;
    this.leavesMat = null;
    this.leavesShadowMat = null;
    this.leavesDiffuse = null;

    // Distance beyond LOD1 at which the bush disappears entirely
    this._cullDistance = options.cullDistance ?? 100;

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

    // Bush leaf atlas — alpha channel drives cutout
    this.leavesDiffuse = loadTex("/Bush_Leaves.png", false);

    this.leavesMat = createBushLeavesMaterial({
      diffuse: this.leavesDiffuse,
      windForce: 0.4,
      windWavesScale: 0.08,
      windSpeed: 0.508,
      anchorBase: false,
      mainColor:           new THREE.Color('#3c7726'),
      secondColor:         new THREE.Color('#3c7726'),
      color2Level:      -0.29,
      color2Fade:        0.64,
      alphaCutoff:       0.35,
      smoothness:        0.1,
      translucencyInt:   2.0,
      directLightOffset: 0.0,
      directLightInt:    1.0,
      indirectLightInt:  1.0,
    });

    this.leavesShadowMat = createBushShadowMaterial(
      this.leavesDiffuse,
      this.leavesMat,
      0.35,
    );
  }

  _initLOD() {
    this._leavesMeshes = [];
    this.lod = new THREE.LOD();
    this.scene.add(this.lod);
  }

  _load() {
    const loader = new FBXLoader();
    loader.load(
      "/Bush.fbx",
      (fbx) => {
        // Scale the raw FBX down — bush assets are authored large
        fbx.scale.setScalar(0.01);
        fbx.updateMatrixWorld(true);

        const groups = this._extractLODGroups(fbx);

        // LOD0 — full detail
        // LOD0 skipped — always using LOD1 (simplified)

        // LOD1 — simplified
        if (groups["LOD1"]) {
          this.lod.addLevel(groups["LOD1"], 0);
          this._registerLeavesMeshes(groups["LOD1"]);
          console.log(`Bush LOD1: ${groups["LOD1"].children.length} mesh(es)`);
        }

        // LOD2 / cull — empty group so Three.js LOD switches to "nothing"
        const cullGroup = new THREE.Group();
        this.lod.addLevel(cullGroup, this._cullDistance);
        console.log(`Bush cull at ${this._cullDistance}m`);

        // Fallback: FBX had no LOD groups at all
        if (this.lod.levels.length === 0) {
          console.warn(
            "No LOD groups found in bush – treating whole FBX as LOD0",
          );
          const wrapper = new THREE.Group();
          wrapper.scale.setScalar(0.008);
          wrapper.add(fbx);
          fbx.traverse((c) => {
            if (c.isMesh) this._assignMaterials(c);
          });
          this._registerLeavesMeshes(wrapper);
          this.lod.addLevel(wrapper, 0);
          const cull = new THREE.Group();
          this.lod.addLevel(cull, this._cullDistance);
        }

        console.log("✓ AN_Bush.fbx loaded");
        this._onLoad?.();
      },
      (xhr) => {
        if (xhr.total)
          console.log(
            `Bush FBX … ${Math.round((xhr.loaded / xhr.total) * 100)}%`,
          );
      },
      (err) => {
        console.warn("Bush FBX load failed – using procedural fallback:", err);
        this._buildFallback();
      },
    );
  }

  _assignMaterials(mesh) {
    const { leavesMat, leavesShadowMat } = this;

    // Bushes are foliage-only — every mesh gets the leaves material
    mesh.material = leavesMat;
    mesh.customDepthMaterial = leavesShadowMat;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  }

  _registerLeavesMeshes(group) {
    const { leavesMat, leavesShadowMat, leavesDiffuse, _leavesMeshes } = this;

    group.traverse((child) => {
      if (!child.isMesh) return;
      child.material = leavesMat;
      child.customDepthMaterial = leavesShadowMat;
      child.onBeforeShadow = function (
        rdr,
        obj,
        cam,
        shadowCam,
        geom,
        depthMat,
      ) {
        depthMat.uniforms.uTime.value = leavesMat.uniforms.uTime.value;
        depthMat.uniforms.map.value = leavesDiffuse;
      };
      _leavesMeshes.push(child);
    });
  }

  _extractLODGroups(fbx) {
    const collected = [];
    fbx.traverse((child) => {
      if (!child.isMesh) return;
      let lodKey = null;
      let node = child;
      while (node) {
        const name = node.name || "";
        if (/LOD0/i.test(name)) {
          lodKey = "LOD0";
          break;
        }
        if (/LOD1/i.test(name)) {
          lodKey = "LOD1";
          break;
        }
        // LOD2 in the FBX is intentionally ignored — we replace it with an empty cull group
        node = node.parent;
      }
      // Meshes with no LOD tag default to LOD0
      collected.push({ mesh: child, lodKey: lodKey || "LOD1" });
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
    const { leavesMat } = this;

    // Simple sphere cluster approximating a round bush
    const cluster = (r, px, py, pz) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), leavesMat);
      m.position.set(px, py, pz);
      m.castShadow = false;
      return m;
    };

    const lod0 = new THREE.Group();
    lod0.add(cluster(0.9, 0.0, 0.9, 0.0));
    lod0.add(cluster(0.7, 0.6, 0.8, 0.5));
    lod0.add(cluster(0.7, -0.5, 0.75, 0.4));
    lod0.add(cluster(0.6, 0.2, 1.3, -0.3));

    const lod1 = new THREE.Group();
    lod1.add(cluster(1.1, 0.0, 0.9, 0.0));

    const cull = new THREE.Group(); // empty — fully culled

    this.lod.addLevel(lod1, 0);
    this.lod.addLevel(cull, this._cullDistance);

    this._registerLeavesMeshes(lod1);
    console.log("✓ Procedural bush fallback built");
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  /**
   * Call once per frame in the animation loop.
   * @param {number}          elapsed  - clock.getElapsedTime()
   * @param {THREE.Camera}    camera
   * @param {THREE.Scene}     scene
   */
  update(elapsed, camera, scene) {
    this.leavesMat.uniforms.uTime.value = elapsed;
    this.leavesShadowMat.uniforms.uTime.value = elapsed;
    syncBushLighting(this.leavesMat, scene);
    this.lod.update(camera);
  }

  /**
   * Returns the active LOD level index.
   * Level 2 means the bush is currently culled.
   */
  getActiveLODLevel() {
    for (let i = 0; i < this.lod.levels.length; i++) {
      if (this.lod.levels[i].object.visible) return i;
    }
    return 0;
  }

  /** Distance from camera to bush LOD origin. */
  distanceTo(camera) {
    return Math.round(camera.position.distanceTo(this.lod.position));
  }

  /** Returns a HUD string, noting when the bush is culled. */
  getHUDStatus() {
    const lvl = this.getActiveLODLevel();
    const dist = this.distanceTo; // bound per-call at the call site
    const tag = lvl === 2 ? "CULLED" : `LOD${lvl}`;
    return tag;
  }
}
