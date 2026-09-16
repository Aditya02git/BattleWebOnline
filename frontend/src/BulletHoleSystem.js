import * as THREE from 'three';

const MAX_DECALS_PER_TARGET = 8;   // per tank/object
const MAX_WORLD_DECALS      = 20;  // for terrain/static hits
const DECAL_SIZE   = 0.35;
const DECAL_LIFE   = 12.0;

export class BulletHoleSystem {
  constructor(scene) {
    this._scene    = scene;
    this._worldDecals = [];  // { mesh, life } — terrain hits, world space
    this._mat      = null;
    this._geo      = null;
    this._ready    = false;

    this._geo = new THREE.PlaneGeometry(1, 1);

    const loader = new THREE.TextureLoader();
    loader.load('/bullet-hole.png', (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      this._mat = new THREE.MeshBasicMaterial({
        map:         tex,
        transparent: true,
        depthWrite:  false,
        polygonOffset:       true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits:  -4,
        side: THREE.DoubleSide,
      });
      this._ready = true;
    });
  }

  /**
   * Spawn a decal attached to a parent Object3D (tank bodyGroup)
   * so it moves with the target.
   * @param {THREE.Vector3}  worldPos
   * @param {THREE.Vector3}  worldNormal
   * @param {THREE.Object3D} parentObject  — bodyGroup of the tank hit
   */
  spawnOnObject(worldPos, worldNormal, parentObject) {
    if (!this._ready || !parentObject) return;

    const mesh = this._makeMesh(worldPos, worldNormal);
    if (!mesh) return;

    // Convert world position to parent local space
    const localPos = parentObject.worldToLocal(worldPos.clone());
    // Convert world normal to parent local space (direction only)
    const localNormal = worldNormal.clone()
      .transformDirection(
        new THREE.Matrix4().copy(parentObject.matrixWorld).invert()
      );

    mesh.position.copy(localPos).addScaledVector(localNormal, 0.04);

    // Orient in local space
    const quat = new THREE.Quaternion();
    const up   = Math.abs(localNormal.y) > 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
    quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal);
    const rollQ = new THREE.Quaternion().setFromAxisAngle(
      localNormal, Math.random() * Math.PI * 2
    );
    quat.premultiply(rollQ);
    mesh.quaternion.copy(quat);

    const size = DECAL_SIZE * (0.7 + Math.random() * 0.5);
    mesh.scale.setScalar(size);
    mesh.renderOrder = 2;

    // Limit decals per object — remove oldest if over cap
    if (!parentObject._bulletHoles) parentObject._bulletHoles = [];
    if (parentObject._bulletHoles.length >= MAX_DECALS_PER_TARGET) {
      const old = parentObject._bulletHoles.shift();
      parentObject.remove(old);
    }

    parentObject.add(mesh);
    parentObject._bulletHoles.push(mesh);
  }

  /**
   * Spawn a world-space decal (terrain, trees, static objects)
   */
  spawnOnWorld(worldPos, worldNormal) {
    if (!this._ready) return;

    if (this._worldDecals.length >= MAX_WORLD_DECALS) {
      const old = this._worldDecals.shift();
      this._scene.remove(old.mesh);
    }

    const mesh = this._makeMesh(worldPos, worldNormal);
    if (!mesh) return;

    mesh.position.copy(worldPos).addScaledVector(worldNormal, 0.04);

    const quat = new THREE.Quaternion();
    quat.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      worldNormal
    );
    const rollQ = new THREE.Quaternion().setFromAxisAngle(
      worldNormal, Math.random() * Math.PI * 2
    );
    quat.premultiply(rollQ);
    mesh.quaternion.copy(quat);

    const size = DECAL_SIZE * (0.7 + Math.random() * 0.5);
    mesh.scale.setScalar(size);
    mesh.renderOrder = 2;

    this._scene.add(mesh);
    this._worldDecals.push({ mesh, life: DECAL_LIFE });
  }

  _makeMesh() {
    if (!this._mat) return null;
    return new THREE.Mesh(this._geo, this._mat);
  }

  update(dt) {
    for (let i = this._worldDecals.length - 1; i >= 0; i--) {
      const d = this._worldDecals[i];
      d.life -= dt;
      if (d.life < 2.0) {
        // Clone material only once for fade
        if (!d.fading) {
          d.fading = true;
          d.mesh.material = this._mat.clone();
        }
        d.mesh.material.opacity = Math.max(0, d.life / 2.0);
      }
      if (d.life <= 0) {
        this._scene.remove(d.mesh);
        if (d.fading) d.mesh.material.dispose();
        this._worldDecals.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const d of this._worldDecals) {
      this._scene.remove(d.mesh);
      if (d.fading) d.mesh.material.dispose();
    }
    this._worldDecals = [];
    this._geo?.dispose();
    this._mat?.dispose();
    this._ready = false;
  }
}