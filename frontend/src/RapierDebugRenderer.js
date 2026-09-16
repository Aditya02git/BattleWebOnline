import * as THREE from 'three';

export class RapierDebugRenderer {
  constructor(scene, world) {
    this.mesh = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x00ff00, vertexColors: false })
    );
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.world = world;
  }

  update() {
    if (!this.mesh.visible) return;
    try {
      const { vertices, colors } = this.world.debugRender();
      this.mesh.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      this.mesh.geometry.setAttribute('color',    new THREE.BufferAttribute(colors, 4));
    } catch (err) {
      console.error('[RapierDebugRenderer] debugRender failed:', err);
      this.mesh.visible = false;
    }
  }
}
