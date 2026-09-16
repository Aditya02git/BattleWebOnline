// InstancedForestManager.js
// Single entry point for both tree forests — one update() call, one dispose(),
// and drives the near/far chunk-based animation LOD for both.

import { InstancedBirchForest } from './InstancedBirchForest.js';
import { InstancedFirForest }   from './InstancedFirForest.js';
import { InstancedPalmForest }  from './InstancedPalmForest.js';
import { InstancedMapleForest } from './InstancedMapleForest.js';

const LOD_CHECK_INTERVAL = 0.5; // seconds between chunk near/far re-evaluation

export class InstancedForestManager {
  constructor(scene, texLoader, { birchSpots, firSpots, palmSpots, mapleSpots, getTerrainY, animRadius = 140, chunkSize = 40, renderer, snow = false }) {
  const snowAmount = snow ? 1.0 : 0.0;
  this.birch = new InstancedBirchForest(scene, texLoader, birchSpots, getTerrainY, { animRadius, chunkSize, renderer, snowAmount });
  this.fir   = new InstancedFirForest(scene, texLoader, firSpots,   getTerrainY, { animRadius, chunkSize, renderer, snowAmount });
  this.palm  = new InstancedPalmForest(scene, texLoader, palmSpots, getTerrainY, { animRadius, chunkSize, renderer, snowAmount });
  this.maple = new InstancedMapleForest(scene, texLoader, mapleSpots, getTerrainY, { animRadius, chunkSize, renderer, snowAmount });
  this._lodTimer = 0;
}

  get ready() { return this.birch._ready && this.fir._ready && this.palm._ready && this.maple._ready; }

  /**
   * Call once per frame instead of calling each forest's update() separately.
   * @param {boolean} forceAllNear - true while the spawn-selection overview
   *   camera is active. Bypasses the normal playerPos-based LOD throttling
   *   and instead evaluates every chunk as "near" from the camera's own
   *   position, so the full forest is visible from the top-down view
   *   regardless of where the tank died. Normal LOD resumes automatically
   *   once this goes false again (the next real playerPos-based check
   *   naturally re-culls anything now far from the tank).
   */
  update(elapsed, dt, camera, scene, playerPos, forceAllVisible = false) {
    this.birch.update(elapsed, camera, scene);
    this.fir.update(elapsed, camera, scene);
    this.palm.update(elapsed, camera, scene);
    this.maple.update(elapsed, camera, scene);

    if (forceAllVisible) {
      const refPos = playerPos ?? { x: camera?.position.x ?? 0, z: camera?.position.z ?? 0 };
      this.birch.updateLOD(refPos, camera, true);
      this.fir.updateLOD(refPos, camera, true);
      this.palm.updateLOD(refPos, camera, true);
      this.maple.updateLOD(refPos, camera, true); 
      this._lodTimer = 0;
      return;
    }

    if (!playerPos) return;

    this._lodTimer += dt;
    if (this._lodTimer >= LOD_CHECK_INTERVAL) {
      this._lodTimer = 0;
      this.birch.updateLOD(playerPos, camera);
      this.fir.updateLOD(playerPos, camera);
      this.palm.updateLOD(playerPos, camera);
      this.maple.updateLOD(playerPos, camera);
    }
  }

  dispose() {
    this.birch.dispose();
    this.fir.dispose();
    this.palm.dispose();
    this.maple.dispose();
  }
}