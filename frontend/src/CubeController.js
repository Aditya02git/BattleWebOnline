import * as THREE from 'three';

/**
 * CubeController — an orange player cube driven by WASD keys.
 *
 * • Moves in camera-relative directions (forward/back/strafe).
 * • Snaps Y to a terrain height sampler each frame.
 * • Exposes `object` (the THREE.Mesh) for other systems to track.
 *
 * Usage:
 *   const cube = new CubeController(scene, camera, { getTerrainY });
 *   // In animate:
 *   cube.update(delta, camera);
 */
export class CubeController {
  /**
   * @param {THREE.Scene}  scene
   * @param {object}       [opts]
   * @param {(x,z)=>number} [opts.getTerrainY]  Height sampler
   * @param {number}        [opts.speed=28]      Units per second
   * @param {number}        [opts.halfExtent=350] Terrain boundary clamp
   */
  constructor(scene, opts = {}) {
    this._getY      = opts.getTerrainY ?? (() => 0);
    this._speed     = opts.speed       ?? 28;
    this._halfSize  = opts.halfExtent  ?? 350;

    this._keys      = {};
    this._moveDir   = new THREE.Vector3();
    this._camDir    = new THREE.Vector3();
    this._camRight  = new THREE.Vector3();
    this._up        = new THREE.Vector3(0, 1, 0);

    this._buildMesh(scene);
    this._bindKeys();
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  _buildMesh(scene) {
    // Player cube
    const geo = new THREE.BoxGeometry(2, 2, 2);
    const mat = new THREE.MeshStandardMaterial({
      color:            0xff6622,
      roughness:        0.4,
      metalness:        0.5,
      emissive:         0xff3300,
      emissiveIntensity:0.08,
    });
    this.object = new THREE.Mesh(geo, mat);
    this.object.castShadow    = true;
    this.object.receiveShadow = false;
    scene.add(this.object);

    // Soft shadow disc on ground
    const discGeo = new THREE.CircleGeometry(1.8, 24);
    discGeo.rotateX(-Math.PI / 2);
    const discMat = new THREE.MeshBasicMaterial({
      color:       0x000000,
      transparent: true,
      opacity:     0.22,
      depthWrite:  false,
    });
    this._disc = new THREE.Mesh(discGeo, discMat);
    scene.add(this._disc);

    // Place at world origin to start
    const startY = this._getY(0, 0) + 1.0;
    this.object.position.set(0, startY, 0);
    this._disc.position.set(0, startY - 0.98, 0);
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => { this._keys[e.code] = true;  });
    window.addEventListener('keyup',   (e) => { this._keys[e.code] = false; });
  }

  // ─── Public ──────────────────────────────────────────────────────────────

  /**
   * Call once per frame.
   * @param {number}       delta   clock.getDelta()
   * @param {THREE.Camera} camera  Used to derive move directions
   */
  update(delta, camera) {
    const k = this._keys;
    const moving = k['KeyW'] || k['KeyS'] || k['KeyA'] || k['KeyD'];

    this._moveDir.set(0, 0, 0);

    if (moving) {
      // Flat camera-relative forward/right
      camera.getWorldDirection(this._camDir);
      this._camDir.y = 0;
      this._camDir.normalize();
      this._camRight.crossVectors(this._camDir, this._up).normalize();

      if (k['KeyW']) this._moveDir.addScaledVector(this._camDir,   1);
      if (k['KeyS']) this._moveDir.addScaledVector(this._camDir,  -1);
      if (k['KeyA']) this._moveDir.addScaledVector(this._camRight, -1);
      if (k['KeyD']) this._moveDir.addScaledVector(this._camRight,  1);

      if (this._moveDir.lengthSq() > 0) {
        this._moveDir.normalize();
        this.object.position.x += this._moveDir.x * this._speed * delta;
        this.object.position.z += this._moveDir.z * this._speed * delta;

        // Clamp to terrain bounds
        const H = this._halfSize;
        this.object.position.x = Math.max(-H, Math.min(H, this.object.position.x));
        this.object.position.z = Math.max(-H, Math.min(H, this.object.position.z));

        // Face direction of travel
        this.object.rotation.y = Math.atan2(this._moveDir.x, this._moveDir.z);
      }
    }

    // Always snap Y to terrain
    const groundY = this._getY(this.object.position.x, this.object.position.z);
    this.object.position.y  = groundY + 1.0;
    this._disc.position.set(
      this.object.position.x,
      groundY + 0.02,   // just above surface
      this.object.position.z
    );
  }
}