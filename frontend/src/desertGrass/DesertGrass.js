import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import {
  createDesertGrassMaterial,
  createDesertGrassShadowMaterial,
  syncDesertGrassLighting,
} from "./DesertGrassMaterial.js";

const FBX_ROTATION_FIX = new THREE.Euler(0, 0, 0);
const FBX_SCALE_FIX = 1; 

export class DesertGrass {
  /**
   * @param {THREE.Scene}         scene
   * @param {THREE.TextureLoader} texLoader
   * @param {object}              [options]
   * @param {number}              [options.cullDistance=25]
   */
  constructor(scene, texLoader, options = {}) {
    this.scene = scene;
    this._onLoad = options.onLoad ?? null;
    this.grassMat = null;
    this.grassShadowMat = null;
    this.grassDiffuse = null;

    this._cullDistance = options.cullDistance ?? 25;

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

    this.grassDiffuse = loadTex("/Desert_Grass.png", false);

    this.grassMat = createDesertGrassMaterial({
      diffuse: this.grassDiffuse,
      windForce: 0.02,
      windWavesScale: 0.12,
      windSpeed: 0.4,
      anchorBase: true,           // grass blades should stay rooted
      mainColor: new THREE.Color('#0c0c0c'),
      secondColor: new THREE.Color('#5e5d5d'),
      color2Level: -2.0,
      color2Fade: -0.1,
      alphaCutoff: 0.35,
      smoothness: 0.12,
      translucencyInt: 5.0,
      directLightOffset: 0,
      directLightInt: 1,
      indirectLightInt: 1,
    });

    this.grassShadowMat = createDesertGrassShadowMaterial(
      this.grassDiffuse,
      this.grassMat,
      0.35,
    );
  }

  _initLOD() {
    this._grassMeshes = [];
    this.lod = new THREE.LOD();
    this.scene.add(this.lod);
  }

_load() {
  const loader = new FBXLoader();
  loader.load(
    "/Desert_Grass.fbx",
    (fbx) => {
      // NO rotation fix — let the FBX orientation stay as-is
      fbx.scale.setScalar(FBX_SCALE_FIX);
      fbx.updateMatrixWorld(true);

      // Log every mesh's transform so we can diagnose stretching
      fbx.traverse((child) => {
        if (child.isMesh) {
          // console.log(
          //   `[GrassMesh] "${child.name}"`,
          //   `| pos:`, child.position,
          //   `| rot(deg): x=${THREE.MathUtils.radToDeg(child.rotation.x).toFixed(1)} y=${THREE.MathUtils.radToDeg(child.rotation.y).toFixed(1)} z=${THREE.MathUtils.radToDeg(child.rotation.z).toFixed(1)}`,
          //   `| scale:`, child.scale,
          // );

          // Flatten any broken non-uniform scale while preserving world position
          const ws = new THREE.Vector3();
          child.getWorldScale(ws);
          if (Math.abs(ws.x - ws.y) > 0.01 || Math.abs(ws.y - ws.z) > 0.01) {
            // console.warn(`  ↳ Non-uniform world scale detected! Normalizing to 1.`);
            child.scale.set(1, 1, 1);
          }
        }
      });

      const groups = this._extractLODGroups(fbx);

      if (groups["LOD0"]) {
        this.lod.addLevel(groups["LOD0"], 0);
        this._registerGrassMeshes(groups["LOD0"]);
        // console.log(`DesertGrass LOD0: ${groups["LOD0"].children.length} mesh(es)`);
      }

      if (groups["LOD1"]) {
        this.lod.addLevel(groups["LOD1"], 10);
        this._registerGrassMeshes(groups["LOD1"]);
        // console.log(`DesertGrass LOD1: ${groups["LOD1"].children.length} mesh(es)`);
      }

      if (groups["LOD2"]) {
        this.lod.addLevel(groups["LOD2"], 18);
        this._registerGrassMeshes(groups["LOD2"]);
        // console.log(`DesertGrass LOD2: ${groups["LOD2"].children.length} mesh(es)`);
      }

      const cullGroup = new THREE.Group();
      this.lod.addLevel(cullGroup, this._cullDistance);
      // console.log(`DesertGrass cull at ${this._cullDistance}m`);

      if (this.lod.levels.length === 1) {
        console.warn("No LOD groups found in Desert_Grass – treating whole FBX as LOD0");
        const wrapper = new THREE.Group();
        fbx.traverse((c) => {
          if (c.isMesh) this._assignMaterials(c);
        });
        this._registerGrassMeshes(wrapper);
        this.lod.addLevel(wrapper, 0);
      }

      // console.log("✓ Desert_Grass.fbx loaded");
      this._onLoad?.();
    },
    (xhr) => {
      if (xhr.total)
        console.log(`Grass … ${Math.round((xhr.loaded / xhr.total) * 100)}%`);
    },
    (err) => {
      console.warn("DesertGrass FBX load failed – using procedural fallback:", err);
      this._buildFallback();
    },
  );
}

  _assignMaterials(mesh) {
    mesh.material = this.grassMat;
    mesh.customDepthMaterial = this.grassShadowMat;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  }

  _registerGrassMeshes(group) {
    const { grassMat, grassShadowMat, grassDiffuse, _grassMeshes } = this;

    group.traverse((child) => {
      if (!child.isMesh) return;
      child.material = grassMat;
      child.customDepthMaterial = grassShadowMat;
      child.onBeforeShadow = function (rdr, obj, cam, shadowCam, geom, depthMat) {
        depthMat.uniforms.uTime.value = grassMat.uniforms.uTime.value;
        depthMat.uniforms.map.value = grassDiffuse;
      };
      _grassMeshes.push(child);
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
        if (/LOD0/i.test(name)) { lodKey = "LOD0"; break; }
        if (/LOD1/i.test(name)) { lodKey = "LOD1"; break; }
        if (/LOD2/i.test(name)) { lodKey = "LOD2"; break; }
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
    // Simple flat planes approximating clumps of grass
    const mat = this.grassMat;

    const blade = (w, h, px, pz, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.set(px, h / 2, pz);
      m.rotation.y = ry;
      m.castShadow = false;
      return m;
    };

    const lod0 = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI;
      lod0.add(blade(0.4, 0.5, Math.cos(angle) * 0.15, Math.sin(angle) * 0.15, angle));
    }

    const lod1 = new THREE.Group();
    lod1.add(blade(0.6, 0.5, 0, 0, 0));
    lod1.add(blade(0.6, 0.5, 0, 0, Math.PI / 3));

    const cull = new THREE.Group();

    this.lod.addLevel(lod0, 0);
    this.lod.addLevel(lod1, 10);
    this.lod.addLevel(cull, this._cullDistance);

    [lod0, lod1].forEach((g) => this._registerGrassMeshes(g));
    console.log("✓ Procedural desert grass fallback built");
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  /**
   * Call once per frame in the animation loop.
   * @param {number}       elapsed
   * @param {THREE.Camera} camera
   * @param {THREE.Scene}  scene
   */
  update(elapsed, camera, scene) {
    this.grassMat.uniforms.uTime.value = elapsed;
    this.grassShadowMat.uniforms.uTime.value = elapsed;
    syncDesertGrassLighting(this.grassMat, scene);
    this.lod.update(camera);
  }

  getActiveLODLevel() {
    for (let i = 0; i < this.lod.levels.length; i++) {
      if (this.lod.levels[i].object.visible) return i;
    }
    return 0;
  }

  distanceTo(camera) {
    return Math.round(camera.position.distanceTo(this.lod.position));
  }

  getHUDStatus() {
    const lvl = this.getActiveLODLevel();
    return lvl === this.lod.levels.length - 1 ? "CULLED" : `LOD${lvl}`;
  }
}