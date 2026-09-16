// utils/enemyCurve.js — wraps a Blender-exported polyline into a smooth,
// arc-length-parameterised patrol curve enemy tanks can follow.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export class PatrolCurve {
  /**
   * @param {Array<{x:number, z:number, y?:number}>} points  raw points exported from Blender
   * @param {Function} getTerrainY  (x,z) => y, used to snap curve to ground height
   * @param {boolean}  closed        true = loops back to start (recommended for patrol routes)
   */
  constructor(points, getTerrainY, closed = true) {
    this.closed = closed;
    const vecs = points.map(p => new THREE.Vector3(
      p.x,
      getTerrainY ? getTerrainY(p.x, p.z) + 1.2 : (p.y ?? 0),
      p.z
    ));
    this._curve = new THREE.CatmullRomCurve3(vecs, closed, 'catmullrom', 0.5);

    // Pre-sample so `advance()` can move tanks at a constant world-space speed
    this._samples = 400;
    const lengths = this._curve.getLengths(this._samples);
    this.length   = lengths[lengths.length - 1];
  }

  /** World-space point at normalised t (0..1) along the curve. */
  getPointAt(t) {
    return this._curve.getPointAt(((t % 1) + 1) % 1);
  }

  /** Advance a normalised t forward by `dist` world units, wrapping/clamping. */
  advance(t, dist) {
    const targetLen = t * this.length + dist;
    if (this.closed) {
      const wrapped = ((targetLen % this.length) + this.length) % this.length;
      return this.length > 0 ? wrapped / this.length : 0;
    }
    return this.length > 0 ? THREE.MathUtils.clamp(targetLen, 0, this.length) / this.length : 0;
  }

  /** Closest normalised t to a world position — coarse search, fine enough for AI. */
  closestT(pos) {
    let bestT = 0, bestD = Infinity;
    for (let i = 0; i <= this._samples; i++) {
      const t = i / this._samples;
      const p = this._curve.getPointAt(t);
      const d = p.distanceToSquared(pos);
      if (d < bestD) { bestD = d; bestT = t; }
    }
    return bestT;
  }
}

/**
 * Extract an ordered list of {x,z} points from a curve that was exported
 * from Blender as a mesh/line inside a .glb file.
 */
async function loadCurvePointsFromGLB(path) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(path);

  let curveMesh = null;
  gltf.scene.traverse((child) => {
    if (child.isMesh || child.isLine) curveMesh = child;
  });
  if (!curveMesh) throw new Error(`[enemyCurve] No mesh/line found in ${path}`);

  curveMesh.updateWorldMatrix(true, false);
  const posAttr = curveMesh.geometry.attributes.position;
  const points  = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i).applyMatrix4(curveMesh.matrixWorld);
    points.push({ x: v.x, z: v.z });
  }
  return points;
}

/**
 * Load curve points either from an inline array on the map definition
 * (mapDef.enemyCurve = [{x,z}, ...]) or from a separate JSON file
 * (mapDef.enemyCurvePath = '/maps/mymap_curve.json') or a .glb file
 * exported from Blender (mapDef.enemyCurvePath = '/curve.glb').
 */
export async function loadPatrolCurve(mapDef, getTerrainY) {
  let points = mapDef.enemyCurve ?? null;
  if (!points && mapDef.enemyCurvePath) {
    if (mapDef.enemyCurvePath.endsWith('.glb') || mapDef.enemyCurvePath.endsWith('.gltf')) {
      points = await loadCurvePointsFromGLB(mapDef.enemyCurvePath);
    } else {
      const res = await fetch(mapDef.enemyCurvePath);
      points = await res.json();
    }
  }
  if (!points || points.length < 2) {
    console.warn('[enemyCurve] No enemyCurve/enemyCurvePath on mapDef — enemies will fall back to random-point patrol.');
    return null;
  }
  return new PatrolCurve(points, getTerrainY, mapDef.enemyCurveClosed ?? true);
}