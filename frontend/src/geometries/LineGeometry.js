import * as THREE from 'three';

// ─── LineGeometry ─────────────────────────────────────────────────────────────

export class LineGeometry extends THREE.BufferGeometry {
  constructor(points = []) {
    super();
    this.type = 'LineGeometry';

    const count = points.length;

    const positions  = new Float32Array(count * 3 * 2);
    const directions = new Float32Array(count * 3 * 2);
    const ratios     = new Float32Array(count * 2);
    const indices    = new Uint16Array((count - 1) * 2 * 3);

    for (let i = 0; i < count; i++) {
      const i2 = i * 2;
      const i6 = i * 6;

      const point     = points[i];
      const nextPoint = points[Math.min(i + 1, count - 1)];

      // Position (two verts per point — left/right ribbon edge)
      positions[i6 + 0] = point.x;
      positions[i6 + 1] = point.y;
      positions[i6 + 2] = point.z;

      positions[i6 + 3] = point.x;
      positions[i6 + 4] = point.y;
      positions[i6 + 5] = point.z;

      // Direction
      const dir = nextPoint.clone().sub(point).normalize();

      directions[i6 + 0] = dir.x;
      directions[i6 + 1] = dir.y;
      directions[i6 + 2] = dir.z;

      directions[i6 + 3] = dir.x;
      directions[i6 + 4] = dir.y;
      directions[i6 + 5] = dir.z;

      // Ratio (0 → 1 along the line)
      ratios[i2 + 0] = i / (count - 1);
      ratios[i2 + 1] = i / (count - 1);

      // Indices (two triangles per segment)
      if (i < count - 1) {
        indices[i6 + 0] = i2 + 2;
        indices[i6 + 1] = i2;
        indices[i6 + 2] = i2 + 1;
        indices[i6 + 3] = i2 + 1;
        indices[i6 + 4] = i2 + 3;
        indices[i6 + 5] = i2 + 2;
      }
    }

    this.setAttribute('position',  new THREE.Float32BufferAttribute(positions,  3));
    this.setAttribute('direction', new THREE.Float32BufferAttribute(directions, 3));
    this.setAttribute('ratio',     new THREE.Float32BufferAttribute(ratios,     1));
    this.setIndex(new THREE.Uint16BufferAttribute(indices, 1));
  }
}