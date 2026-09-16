// beltShaderPrewarm.js — compiles all beltType shader variants once at load
// time, off the gameplay critical path, so the first real tank that needs a
// given beltType doesn't pay the shader-compile cost mid-game.

import * as THREE from 'three';
import { EnemyBeltMesh } from './enemyBeltMesh.js';

export async function prewarmBeltShaders(renderer) {
  const tmpScene  = new THREE.Scene();
  // A degenerate default camera can leave the renderer in an odd state
  // during compile — use sane, real values instead of PerspectiveCamera()
  const tmpCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  tmpCamera.position.set(0, 5, 5);
  tmpCamera.lookAt(0, 0, 0);

  for (const beltType of [1, 2, 3, 4]) {
    const belt = new EnemyBeltMesh(tmpScene, 1, 0, 1.0, beltType, 70);
    belt.rebuildFromPath([new THREE.Vector2(0, 0), new THREE.Vector2(1, 0)]);

    // compileAsync resolves only once the GPU has actually finished
    // compiling/linking every material's program — disposing before this
    // resolves is what left a dangling/invalid program handle behind and
    // triggered "glGetProgramiv: Program object expected" at game start.
    await renderer.compileAsync(tmpScene, tmpCamera);

    belt.dispose();
    // Fully clear the scene between variants so no previous belt's mesh
    // lingers and gets swept into the next beltType's compile pass.
    tmpScene.clear();
  }
}