import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import {
  createBirchBarkMaterial,
  createBirchLeavesMaterial,
  createLeavesShadowMaterial,
  syncLighting,
} from "./materials/BirchMaterial.js";

/**
 * Loads and manages the birch tree LOD object.
 *
 * Usage:
 *   const birch = new BirchTree(scene, texLoader);
 *   // In animate loop:
 *   birch.update(elapsed, camera, scene);
 */
export class BirchTree {
  /**
   * @param {THREE.Scene}         scene
   * @param {THREE.TextureLoader} texLoader
   */
  constructor(scene, texLoader, { onLoad } = {}) {
    this.scene = scene;
    this._onLoad = onLoad;
    this.leavesMat = null;
    this.leavesShadowMat = null;
    this.leavesDiffuse = null;

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

    this.leavesDiffuse = loadTex("/Birch_Leaves.png", false);

    this._barkShadowMat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.FrontSide,
    });

    this._barkMat = createBirchBarkMaterial({
      color:     new THREE.Color('#4f3626'),
      roughness: 0.85,
      metalness: 0.0,
    });
    this._barkMat.shadowSide = THREE.FrontSide;

    this.leavesMat = createBirchLeavesMaterial({
      diffuse: this.leavesDiffuse,
      windForce: 0.4,
      windWavesScale: 0.08,
      windSpeed: 0.508,
      anchorBase: false,
      mainColor:         new THREE.Color(0.04, 0.18, 0.05),
      secondColor:       new THREE.Color(0.08, 0.28, 0.07),
      color2Level: -7.5,
      color2Fade: -0.06,
      alphaCutoff: 0.35,
      smoothness: 0.1,
      translucencyInt: 8.0,
      directLightOffset: 0,
      directLightInt: 1,
      indirectLightInt: 1,
    });

    this.leavesShadowMat = createLeavesShadowMaterial(
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
      "/Birch_2.fbx",
      (fbx) => {
        const wrapper = new THREE.Group();
        wrapper.scale.setScalar(0.01);
        wrapper.add(fbx);
        wrapper.updateMatrixWorld(true);

        const groups = this._extractLODGroups(fbx);
        const distances = { LOD0: 0, LOD1: 15, LOD2: 35 };

        ["LOD0", "LOD1", "LOD2"].forEach((key) => {
          if (groups[key]) {
            this.lod.addLevel(groups[key], distances[key]);
            this._registerLeavesMeshes(groups[key]);
            console.log(
              `Birch ${key}: ${groups[key].children.length} mesh(es)`,
            );
          }
        });

        if (this.lod.levels.length === 0) {
          console.warn(
            "No LOD groups found in birch – treating whole FBX as LOD0",
          );
          fbx.traverse((c) => {
            if (c.isMesh) this._assignMaterials(c);
          });
          this._registerLeavesMeshes(wrapper);
          this.lod.addLevel(wrapper, 0);
        }

        console.log("Birch_1.fbx loaded");
        this._onLoad?.();
      },
      (xhr) => {
        if (xhr.total)
          console.log(
            `Birch FBX … ${Math.round((xhr.loaded / xhr.total) * 100)}%`,
          );
      },
      (err) => {
        console.warn("Birch FBX load failed – using procedural fallback:", err);
        this._buildFallback();
      },
    );
  }

  _assignMaterials(mesh) {
    const {
      _barkMat: barkMat,
      leavesMat,
      _barkShadowMat: barkShadowMat,
    } = this;

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((_, i) =>
        i === 0 ? barkMat : leavesMat,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.onBeforeShadow = function (
        rdr,
        obj,
        cam,
        shadowCam,
        geom,
        depthMat,
        group,
      ) {
        if (!group) return;
        const groupMat = obj.material[group.materialIndex];
        if (groupMat === leavesMat) {
          depthMat.uniforms.uTime.value = leavesMat.uniforms.uTime.value;
          depthMat.uniforms.map.value = this.leavesDiffuse;
        }
      }.bind(this);
    } else {
      const n = (mesh.name || "").toLowerCase();
      if (n.includes("bark")) {
        mesh.material = barkMat;
        mesh.customDepthMaterial = barkShadowMat;
      } else {
        mesh.material = leavesMat;
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  }

  _registerLeavesMeshes(group) {
    const { leavesMat, leavesShadowMat, leavesDiffuse, _leavesMeshes } = this;

    group.traverse((child) => {
      if (!child.isMesh) return;
      if (Array.isArray(child.material)) {
        child.customDepthMaterial = leavesShadowMat;
        _leavesMeshes.push(child);
      } else if (child.material === leavesMat) {
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
      }
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
        if (/LOD2/i.test(name)) {
          lodKey = "LOD2";
          break;
        }
        node = node.parent;
      }
      collected.push({ mesh: child, lodKey: lodKey || "LOD0" });
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
    const {
      _barkMat: barkMat,
      leavesMat,
      _barkShadowMat: barkShadowMat,
    } = this;

    const leafCluster = (r, py, px = 0, pz = 0) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), leavesMat);
      m.position.set(px, py, pz);
      m.castShadow = true;
      return m;
    };
    const makeTrunk = (segs = 8) => {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.26, 5, segs),
        barkMat,
      );
      m.position.y = 2.5;
      m.castShadow = true;
      m.customDepthMaterial = barkShadowMat;
      return m;
    };

    const lod0 = new THREE.Group();
    lod0.add(makeTrunk(10));
    lod0.add(leafCluster(2.2, 6.5));
    lod0.add(leafCluster(1.8, 8.2, 0.9, 0.3));
    lod0.add(leafCluster(1.6, 7.8, -0.7, -0.5));
    lod0.add(leafCluster(1.4, 9.2, -0.3, 0.4));

    const lod1 = new THREE.Group();
    lod1.add(makeTrunk(7));
    lod1.add(leafCluster(2.6, 7.3));

    const lod2 = new THREE.Group();
    lod2.add(makeTrunk(5));
    lod2.add(leafCluster(3.0, 7.5));

    this.lod.addLevel(lod0, 0);
    this.lod.addLevel(lod1, 15);
    this.lod.addLevel(lod2, 35);
    [lod0, lod1, lod2].forEach((g) => this._registerLeavesMeshes(g));
    console.log("Procedural fallback tree built");
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
  this.leavesMat.uniforms.uTime.value = elapsed;
  this.leavesShadowMat.uniforms.uTime.value = elapsed;
  syncLighting(this.leavesMat, scene);
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

  /** Distance from camera to tree LOD origin (useful for HUD). */
  distanceTo(camera) {
    return Math.round(camera.position.distanceTo(this.lod.position));
  }
}
