// main.js — Scene setup, physics world, bumpers, camera, game loop

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { keys, onShiftPress, onMiddleClick, onFire, isMouseHeld } from './input.js';
import { Tank } from './tank.js';
import { RapierDebugRenderer } from './rapierDebugRenderer.js';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { generateProceduralHeightmap, loadHeightmap } from './utils/heightmap.js';
import { TerrainBuilder } from './utils/terrain.js';
import { EnemyTankPool, resetEnemyModelCache } from './enemyTank.js';
import { HealthBar } from './healthBar.js';
// import { BulletTrailSystem } from './bulletTrail.js';
import { ScopeSystem } from './scope.js';
import { AudioSystem } from './audioSystem.js';
import { ProjectileBulletSystem } from './bullet.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { getMapById, loadMapTerrain } from './utils/mapLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MaskLoader }   from './utils/MaskLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { InstancedBirchForest } from './InstancedBirchForest.js';
import { InstancedFirForest } from './InstancedFirForest.js';
// import { FirTree }   from './FirTree.js';
// import { Bush }      from './Bush.js';
import { InstancedBush } from './InstancedBush.js';
import { GrassPool } from './GrassPool.js';
import { Water } from './water.js';
import { APSSystem } from './aps.js';
import { AmmoPointSystem } from './AmmoPoint.js';

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function init(config = {}) {
  window._lastTankConfig = config;
  resetEnemyModelCache();
  await RAPIER.init();

  let gameOver = false;
  let gameStarted = false;
  let isPaused = false;
  let enableShadow = true;   // ← toggle this to enable/disable tank shadows
  let _lastMgAmmo = -1;
  let _lastSpeedStr = '';

  // ── UI focus guard — true when a button/overlay is being interacted with ──
  let _uiClickActive = false;
  const _uiElements = [
    'pause-btn', 'pause-overlay', 'pause-resume-btn', 'pause-end-btn',
    'death-screen', 'death-menu-btn', 'configurator',
  ];
  document.addEventListener('mousedown', (e) => {
    _uiClickActive = _uiElements.some(id => {
      const el = document.getElementById(id);
      return el && (el === e.target || el.contains(e.target));
    });
    if (_uiClickActive && audio.isMGPlaying) audio.stopMG();
  }, true);

  document.addEventListener('mouseup', () => {
    if (_uiClickActive) {
      _uiClickActive = false;
      if (audio.isMGPlaying) audio.stopMG();
    }
  }, true);

// ── Load map definition + its terrain data module ─────────────────────────
const mapDef      = await getMapById(config.mapId ?? null);
const terrainData = await loadMapTerrain(mapDef);

const terrainBuilder = new TerrainBuilder({
  heights:      terrainData.heights,
  size:         terrainData.size,
  worldSize:    terrainData.worldSize,
  heightScale:  terrainData.heightScale,
  heightOffset: terrainData.heightOffset ?? 0,
});

  // ── Renderer ──────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = enableShadow;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  renderer.toneMapping       = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = mapDef.sky?.toneMappingExposure ?? 1.1;
  renderer.setClearColor(
    mapDef.sky?.clearColor ? parseInt(mapDef.sky.clearColor, 16) : 0x87ceeb
  );
  document.body.appendChild(renderer.domElement);

  // ── Scene ─────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  const _fogDef = mapDef.fog ?? {};
scene.fog = new THREE.FogExp2(
  _fogDef.color   ? parseInt(_fogDef.color,   16) : 0xb0c8e8,
  _fogDef.density ?? 0.0025
);
  

  // ── Camera ────────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);

  camera.layers.enable(1);

  let camYaw   = Math.PI / 2;
  let camPitch = 0.1;
  let camDist  = 6;
  const MIN_PITCH = 0.1;
  const MAX_PITCH = 1.4;
  const MIN_DIST  = 6;
  const MAX_DIST  = 10;

  // ── Edge-orbit: when cursor is pinned at screen edge in free-aim mode,
  // rotate the camera to keep feeding the turret fresh aim direction ───────
  const EDGE_ORBIT_SENSITIVITY = 0.005; // matches drag-orbit's camYaw -= dx * 0.005
  const EDGE_ORBIT_PX_PER_SEC  = 900;   // equivalent "drag speed" while pinned at edge

  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  renderer.domElement.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    if (e.button === 2 && scope.isScoped) return;
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });
renderer.domElement.addEventListener('mouseup',    () => { isDragging = false; cancelRepair(); });
  renderer.domElement.addEventListener('mouseleave', () => { isDragging = false; cancelRepair(); });
  renderer.domElement.addEventListener('mousemove',  (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    camYaw   -= dx * 0.005;
    camPitch -= dy * 0.005;
    camPitch  = Math.max(MIN_PITCH, Math.min(MAX_PITCH, camPitch));
  });
  renderer.domElement.addEventListener('wheel', (e) => {
    if (scope.isScoped) return;
    camDist += e.deltaY * 0.02;
    camDist  = Math.max(MIN_DIST, Math.min(MAX_DIST, camDist));
  });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  // ── Lights ────────────────────────────────────────────────────────────────
  const _al = mapDef.lighting?.ambient ?? {};
  const ambientLight = new THREE.AmbientLight(
    _al.color     ? parseInt(_al.color, 16) : 0xc8d8f0,
    _al.intensity ?? 1.5
  );
  scene.add(ambientLight);

  // const light = new THREE.SpotLight(0xffffff, 2);
  // light.position.set(30, 30, 20);
  // light.castShadow = false;
  // light.penumbra = 1;
  // light.angle = Math.PI / 3;
  // scene.add(light);

  const LIGHT2_OFFSET = new THREE.Vector3(20,30,80);

  const _dl  = mapDef.lighting?.directional ?? {};
  const _dlp = _dl.position ?? { x: 0, y: 10, z: 20 };
  const light2 = new THREE.DirectionalLight(
    _dl.color     ? parseInt(_dl.color, 16) : 0xe8bd99,
    _dl.intensity ?? 15
  );
  light2.position.set(_dlp.x ?? 0, _dlp.y ?? 10, _dlp.z ?? 20);

  // ── Shadows ──────────────────────────────────────────────────────────────
  light2.castShadow = true;
  light2.shadow.mapSize.set(256, 256);
  light2.shadow.camera.near   = 1;
  light2.shadow.camera.far    = 200;
  light2.shadow.camera.left   = -40;
  light2.shadow.camera.right  =  40;
  light2.shadow.camera.top    =  40;
  light2.shadow.camera.bottom = -40;
  light2.shadow.bias       = -0.0015;
  light2.shadow.normalBias = 0.02;

  scene.add(light2);
  scene.add(light2.target);

const hdriLoader = new THREE.TextureLoader();
hdriLoader.load(
  mapDef.sky?.panorama ?? 'Panorama_Sky_22-512x512.png',
  function (texture) {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = texture;
  }
);

// // ── Sky + Sun + Clouds ────────────────────────────────────────────────────
// const sun = new THREE.Vector3();

// const sky = new Sky();
// sky.scale.setScalar(10000);
// scene.add(sky);

// const skyUniforms = sky.material.uniforms;
// skyUniforms['turbidity'].value       = 4;
// skyUniforms['rayleigh'].value        = 3.5;
// skyUniforms['mieCoefficient'].value  = 0.003;
// skyUniforms['mieDirectionalG'].value = 0.7;
// skyUniforms['cloudCoverage'].value   = 0.4;
// skyUniforms['cloudDensity'].value    = 0.5;
// skyUniforms['cloudElevation'].value  = 0.5;

// const skyParameters = {
//   elevation: 8,
//   azimuth:   180,
// };

// const _pmremGenerator = new THREE.PMREMGenerator(renderer);
// const _sceneEnv       = new THREE.Scene();
// let   _skyRenderTarget;

// function updateSun() {
//   const phi   = THREE.MathUtils.degToRad(90 - skyParameters.elevation);
//   const theta = THREE.MathUtils.degToRad(skyParameters.azimuth);
//   sun.setFromSphericalCoords(1, phi, theta);

//   sky.material.uniforms['sunPosition'].value.copy(sun);
//   light2.position.set(
//     sun.x * 100 + 20,
//     sun.y * 100 + 70,
//     sun.z * 100 + 10
//   );
//   light2.target.position.set(0, 0, 0);
//   light2.target.updateMatrixWorld();

//   if (_skyRenderTarget !== undefined) _skyRenderTarget.dispose();
//   _sceneEnv.add(sky);
//   _skyRenderTarget     = _pmremGenerator.fromScene(_sceneEnv);
//   scene.add(sky);
//   scene.environment    = _skyRenderTarget.texture;
// }

// updateSun();
// // ── End Sky ───────────────────────────────────────────────────────────────

  const scope = new ScopeSystem(renderer, camera, {
    holdScope:   false,
    texturePath: '/textures/scope_1.ktx2',
    gunnerTexturePath: '/textures/gunner_sight.png',   // ← add
    zoomFOV:     70,
    gunnerZoomFOV: 90,                                  // ← add, tune to taste
    normalFOV:   55,
    barrelMinAngle: -0.25,
    barrelMaxAngle:  0.25,
  });

  scope.onScopeEnter = () => tank.turretController?.setScopeLocked(true);
  scope.onScopeExit  = () => tank.turretController?.setScopeLocked(false);

  // ── Compass bar ───────────────────────────────────────────────────────────
  const compassStrip = document.getElementById('compass-strip-wrap');

  const COMPASS_WIDTH   = 400;
  const COMPASS_FOV_DEG = 120;
  const PPD             = 4;
  const STRIP_W         = 1440;

  const _compassCamDir  = new THREE.Vector3();
  const _compassSph     = new THREE.Spherical();

  // ── Compass throttle state ─────────────────────────────────────────────
  let compassAccum        = 0;
  const COMPASS_INTERVAL  = 1 / 15;   // 30 fps cap
  let lastCompassYaw      = Infinity;
  const COMPASS_YAW_THRESHOLD = 0.002; // ~0.1°

function drawCompassBar() {
  const _tankFwd = new THREE.Vector3();
  tank.bodyGroup.getWorldDirection(_tankFwd);
  // atan2(x, z) gives yaw where -Z forward = 0 degrees (North)
  const yawRad = Math.atan2(_tankFwd.x, _tankFwd.z);
  const yawDeg = ((yawRad * 180 / Math.PI) + 180 + 360) % 360;
  const centerPx = yawDeg * PPD;
  const offsetX  = -(centerPx - COMPASS_WIDTH / 2);
  const wrapped  = ((offsetX % STRIP_W) + STRIP_W) % STRIP_W;
  compassStrip.style.transform = `translateX(${-wrapped}px)`;
}
  // ── End compass bar ───────────────────────────────────────────────────────


  // ── Minimap ───────────────────────────────────────────────────────────────
  const MINIMAP_SIZE   = 240;
  const WORLD_HALF     = 400;

  const minimapEl      = document.getElementById('minimap');
  const minimapCanvas  = document.getElementById('minimap-canvas');
  const minimapCtx     = minimapCanvas.getContext('2d');
  const minimapEnemyEl = document.getElementById('minimap-enemies');
  const minimapPlayer  = document.getElementById('minimap-player');

  function buildMinimapBackground() {
    minimapCtx.fillStyle = 'rgba(20,30,10,0.85)';
    minimapCtx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    minimapCtx.strokeStyle = 'rgba(60,100,30,0.25)';
    minimapCtx.lineWidth = 0.5;
    const step = MINIMAP_SIZE / 5;
    for (let i = 0; i <= 5; i++) {
      minimapCtx.beginPath();
      minimapCtx.moveTo(i * step, 0);
      minimapCtx.lineTo(i * step, MINIMAP_SIZE);
      minimapCtx.stroke();
      minimapCtx.beginPath();
      minimapCtx.moveTo(0, i * step);
      minimapCtx.lineTo(MINIMAP_SIZE, i * step);
      minimapCtx.stroke();
    }
    minimapCtx.fillStyle = 'rgba(100,160,60,0.5)';
    minimapCtx.font = '8px monospace';
    minimapCtx.textAlign = 'center';
    minimapCtx.fillText('N', MINIMAP_SIZE / 2, 8);
    minimapCtx.fillText('S', MINIMAP_SIZE / 2, MINIMAP_SIZE - 2);
    minimapCtx.textAlign = 'left';
    minimapCtx.fillText('W', 2, MINIMAP_SIZE / 2 + 3);
    minimapCtx.textAlign = 'right';
    minimapCtx.fillText('E', MINIMAP_SIZE - 2, MINIMAP_SIZE / 2 + 3);
  }
  buildMinimapBackground();

  function worldToMinimap(wx, wz) {
    const x = ((wx + WORLD_HALF) / (WORLD_HALF * 2)) * MINIMAP_SIZE;
    const y = ((wz + WORLD_HALF) / (WORLD_HALF * 2)) * MINIMAP_SIZE;
    return { x, y };
  }

  function addEnemyDotToMinimap(et, cached) {
    const { x, y } = worldToMinimap(cached.x, cached.z);
    const dot = document.createElement('div');
    dot.dataset.enemyId = enemyPool.getActiveTanks().indexOf(et);
    dot.style.cssText = `
  position:absolute;
  width:6px; height:6px;
  border-radius:50%;
  background:rgba(255,0,0,0.9);
  left:${x}px; top:${y}px;
  transform:translate(-50%,-50%);
  pointer-events:none;
  filter:drop-shadow(0 0 3px rgba(255,0,0,1));
    `;
    dot._enemy = et;
    minimapEnemyEl.appendChild(dot);
  }

  function removeEnemyDotFromMinimap(et) {
    for (const dot of minimapEnemyEl.children) {
      if (dot._enemy === et) {
        minimapEnemyEl.removeChild(dot);
        return;
      }
    }
  }

  const minimapEnemySet = new Set();

  function updateMinimapEnemies() {
    for (const [et, cached] of enemyPosCache.entries()) {
      if (!minimapEnemySet.has(et)) {
        minimapEnemySet.add(et);
        addEnemyDotToMinimap(et, cached);
      }
    }
    for (const et of minimapEnemySet) {
      if (!enemyPosCache.has(et)) {
        removeEnemyDotFromMinimap(et);
        minimapEnemySet.delete(et);
      }
    }
  }

  // ── Minimap player — skip write when position hasn't changed ─────────────
  let _lastMinimapX = -1;
  let _lastMinimapY = -1;

  // Updated to accept cached tPos instead of calling translation() itself
function updateMinimapPlayer(tPos) {
  if (!tPos) return;
  const { x, y } = worldToMinimap(tPos.x, tPos.z);

  if (Math.abs(x - _lastMinimapX) < 0.5 && Math.abs(y - _lastMinimapY) < 0.5) return;
  _lastMinimapX = x;
  _lastMinimapY = y;

  // Get tank's actual forward direction from bodyGroup
  const _tankFwd = new THREE.Vector3();
  tank.bodyGroup.getWorldDirection(_tankFwd);
  const yawRad = Math.atan2(_tankFwd.z, _tankFwd.x);
const yawDeg = yawRad * (180 / Math.PI) + 180;

  minimapPlayer.style.left = x + 'px';
  minimapPlayer.style.top  = y + 'px';
  minimapPlayer.style.transform = `translate(-50%,-50%) rotate(${yawDeg}deg)`;
}
  // ── End minimap ───────────────────────────────────────────────────────────

  // ── Mouse tracking ────────────────────────────────────────────────────────
// ── Mouse tracking ────────────────────────────────────────────────────────
  const mouse = new THREE.Vector2(0, 0);
  let _mouseAtLeftEdge  = false;
  let _mouseAtRightEdge = false;
  const EDGE_THRESHOLD_PX = 2; // how close to the canvas edge counts as "pinned"

  const _onMousemove = (e) => {
    const canvas = renderer.domElement;
    const rect   = canvas.getBoundingClientRect();
    const rawX = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    mouse.x =  rawX;
    mouse.y = -((e.clientY - rect.top)  / rect.height)  * 2 + 1;

    _mouseAtLeftEdge  = (e.clientX - rect.left) <= EDGE_THRESHOLD_PX;
    _mouseAtRightEdge = (rect.right - e.clientX) <= EDGE_THRESHOLD_PX;
  };
  window.addEventListener('mousemove', _onMousemove);

  // ── Physics world ─────────────────────────────────────────────────────────
  const gravity = { x: 0, y: -19.6, z: 0 };
  const world   = new RAPIER.World(gravity);
  world.__RAPIER__ = RAPIER;

  const eventQueue = new RAPIER.EventQueue(true);

// ── Load mask first, then build terrain ───────────────────────────────────
const mask = new MaskLoader();
await mask.load(mapDef.terrain?.maskTex ?? '/mask.png');

// ── Terrain — pass mask for path blending ─────────────────────────────────
const terrainMesh = terrainBuilder.buildMesh(
  renderer,
  mask,
  terrainData.worldSize,
  mapDef.terrain ?? {}   // ← passes colorTex, normalTex, maskTex, normalRepeat
);
terrainMesh.receiveShadow = true;
scene.add(terrainMesh);

// ── Water ──────────────────────────────────────────────────────────────
const _waterDef  = mapDef.water ?? {};
const showWater  = _waterDef.enabled !== false;
const water = new Water(scene, renderer, {
  size:  terrainData.worldSize,
  y:     _waterDef.y     ?? terrainData.waterLevel ?? 8.4,
  color: _waterDef.color ? parseInt(_waterDef.color, 16) : 0x2a6ea6,
  maxReflectionRes:   128,
  reflectionInterval: 5,
});
if (!showWater) water.dispose();

  const { nrows, ncols, heights, scale } = terrainBuilder.buildRapierHeightfield(RAPIER);
  const terrainBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc
      .heightfield(nrows, ncols, heights, new RAPIER.Vector3(scale.x, scale.y, scale.z))
      .setFriction(0.9),
    terrainBody
  );

  function exportTerrainAsGLB() {
  const exporter = new GLTFExporter();
  exporter.parse(
    terrainMesh,
    (buffer) => {
      const blob = new Blob([buffer], { type: 'application/octet-stream' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'terrain.glb';
      a.click();
      URL.revokeObjectURL(url);
    },
    (error) => console.error('GLTFExporter error:', error),
    { binary: true }   // ← true = .glb, false = .gltf+json
  );
}

  // ── Invisible boundary walls ───────────────────────────────────────────────
const WALL_HALF  = 400;   // matches worldSize / 2
const WALL_H     = 20;    // wall height
const WALL_THICK = 1;

const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

[
  { x:  WALL_HALF, y: 0, z: 0,         hx: WALL_THICK, hy: WALL_H, hz: WALL_HALF },
  { x: -WALL_HALF, y: 0, z: 0,         hx: WALL_THICK, hy: WALL_H, hz: WALL_HALF },
  { x:  0,         y: 0, z:  WALL_HALF, hx: WALL_HALF,  hy: WALL_H, hz: WALL_THICK },
  { x:  0,         y: 0, z: -WALL_HALF, hx: WALL_HALF,  hy: WALL_H, hz: WALL_THICK },
].forEach(({ x, y, z, hx, hy, hz }) => {
  world.createCollider(
    RAPIER.ColliderDesc
      .cuboid(hx, hy, hz)
      .setTranslation(x, y, z)
      .setFriction(0.0)
      .setRestitution(0.3),
    wallBody
  );
});

  // buildBumpers(scene, world, RAPIER);

  // ── House GLB: visual mesh + box colliders ────────────────────────────────
const _houseColliderBodies = [];

async function loadHouse(path) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(path, (gltf) => {
      const root = gltf.scene;

      // ── Collect colliders and visual separately ──────────────────────────
      const colliderMeshes = [];
      let visualMesh = null;

      root.traverse((child) => {
        if (!child.isMesh) return;

        if (child.name.startsWith('Collider_')) {
          colliderMeshes.push(child);
        } else {
          // Visual_House mesh — add to scene for rendering
          visualMesh = child;
        }
      });

      // ── Add visual to scene ──────────────────────────────────────────────
      if (visualMesh) {
        // Ensure world matrix is up to date
        root.updateMatrixWorld(true);
        scene.add(root);
      }

      // ── Build Rapier cuboid colliders ────────────────────────────────────
      root.updateMatrixWorld(true);

      for (const mesh of colliderMeshes) {
        // Get world-space position, quaternion, scale
        const worldPos   = new THREE.Vector3();
        const worldQuat  = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        mesh.matrixWorld.decompose(worldPos, worldQuat, worldScale);

        // geometry bounding box gives us the LOCAL half-extents
        // (works whether or not transform is applied in Blender)
        mesh.geometry.computeBoundingBox();
        const bbox = mesh.geometry.boundingBox;
        const localHalf = new THREE.Vector3();
        bbox.getSize(localHalf).multiplyScalar(0.5);

        // World half-extents = local half-extents * world scale
        const hx = localHalf.x * worldScale.x;
        const hy = localHalf.y * worldScale.y;
        const hz = localHalf.z * worldScale.z;

        // Rapier quaternion
        const rq = new RAPIER.Quaternion(
          worldQuat.x,
          worldQuat.y,
          worldQuat.z,
          worldQuat.w
        );

        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed()
            .setTranslation(worldPos.x, worldPos.y, worldPos.z)
            .setRotation(rq)
        );

        world.createCollider(
          RAPIER.ColliderDesc
            .cuboid(hx, hy, hz)
            .setFriction(0.5)
            .setRestitution(0.1),
          body
        );

        _houseColliderBodies.push(body);

        // Hide collider mesh — it's invisible in-game
        mesh.visible = false;
      }

      console.log(
        `[House] Loaded: ${colliderMeshes.length} colliders, visual=${!!visualMesh}`
      );
      resolve();
    }, undefined, reject);
  });
}

// Load all houses defined in the map
const _houseDefs = mapDef.houses ?? [{ path: '/houses.glb' }];
for (const h of _houseDefs) {
  await loadHouse(h.path);
}   // ← change path to your exported GLB

  // ── Grass Scatter ──────────────────────────────────────────────────────────
  const texLoader = new THREE.TextureLoader();
  
  // ─── Terrain height helper ────────────────────────────────────────────────────
const getTerrainY = (x, z) => terrainBuilder.getHeightAtWorld(x, z);

// ── Capture Points ────────────────────────────────────────────────────────
const CAPTURE_POINTS = (mapDef.capturePoints ?? [
  { id: 'A', x:  120, z:  80 },
  { id: 'B', x: -150, z: -100 },
  { id: 'C', x:   20, z:  200 },
  { id: 'D', x:  200, z: -180 },
  { id: 'E', x: -180, z:  150 },
]).map(p => ({ ...p }));

// Resolve Y for each point
CAPTURE_POINTS.forEach(p => { p.y = getTerrainY(p.x, p.z) + 1.5; });

const CAPTURE_RADIUS     = 12;   // units — how close to trigger
const CAPTURE_HOLD_TIME  = 7;    // seconds to hold C
const RESPAWN_DELAY      = 5;    // seconds before player respawns
const MATCH_DURATION = mapDef.matchDuration ?? 180;  // seconds (3 minutes)

// State per point: 'neutral' | 'player' | 'enemy'
CAPTURE_POINTS.forEach(p => {
  p.owner        = 'neutral';
  p.captureTimer = 0;
  p.capturingBy  = null; // 'player' | 'enemy' | null
});

let playerCaptures = 0;
let enemyCaptures  = 0;
let matchElapsed   = 0;
let matchEnded     = false;
let _respawnTimer  = 0;
let _isRespawning  = false;
let _pendingRespawn = false;   // ← add this
let _cKeyHeld      = false;
let _cHoldTimer    = 0;
let _nearPoint     = null; // the capture point currently in range

// ── Capture Point 3D markers ──────────────────────────────────────────────
const _cpMeshes = {};   // id → { ring, pole, label }
const _cpMat = {
  neutral: new THREE.MeshStandardMaterial({ color: 0x888888, emissive: 0x444444 }),
  player:  new THREE.MeshStandardMaterial({ color: 0x44aaff, emissive: 0x1144aa }),
  enemy:   new THREE.MeshStandardMaterial({ color: 0xff4422, emissive: 0xaa1100 }),
};

CAPTURE_POINTS.forEach(p => {
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.15, 6, 8),
    _cpMat.neutral.clone()
  );
  pole.position.set(p.x, p.y + 3, p.z);
  scene.add(pole);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(CAPTURE_RADIUS, 0.3, 8, 32),
    _cpMat.neutral.clone()
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.set(p.x, p.y + 0.3, p.z);
  scene.add(ring);

  _cpMeshes[p.id] = { pole, ring };
});

function _setCPColor(p) {
  const src = _cpMat[p.owner];
  const m   = _cpMeshes[p.id];
  m.pole.material.color.copy(src.color);
  m.pole.material.emissive.copy(src.emissive);
  m.ring.material.color.copy(src.color);
  m.ring.material.emissive.copy(src.emissive);
}

// ── Capture HUD ───────────────────────────────────────────────────────────
const captureHud = document.createElement('div');
captureHud.style.cssText = `
  position:fixed; bottom:90px; left:50%; transform:translateX(-50%);
  display:none; flex-direction:column; align-items:center; gap:6px;
  font-family:'Courier New',monospace; pointer-events:none; z-index:102;
`;
captureHud.innerHTML = `
  <div id="capture-label" style="font-size:13px;color:#e8f0c0;letter-spacing:0.12em;">
    HOLD <span style="color:#ffdd44;font-size:16px;font-weight:bold;">[C]</span> TO CAPTURE
  </div>
  <div style="width:200px;height:5px;background:#1a1a1a;border-radius:3px;overflow:hidden;">
    <div id="capture-bar" style="height:100%;width:0%;background:#ffdd44;transition:width 0.1s;"></div>
  </div>
`;
document.body.appendChild(captureHud);

// ── Score bar ─────────────────────────────────────────────────────────────
const scoreHud = document.createElement('div');
scoreHud.style.cssText = `
  position:fixed; top:60px; left:50%; transform:translateX(-50%);
  display:none; flex-direction:row; align-items:center; gap:14px;
  font-family:'Courier New',monospace; font-size:12px; color:#c8d8a0;
  background:rgba(0,0,0,0.55); padding:6px 16px;
  border:1px solid #2a3a1a; border-radius:4px;
  pointer-events:none; z-index:102;
`;
scoreHud.innerHTML = `
  <span style="color:#44aaff;">YOU <span id="score-player">0</span></span>
  <span style="color:#888;">|</span>
  <span id="match-timer" style="color:#e8f0c0;font-size:14px;">3:00</span>
  <span style="color:#888;">|</span>
  <span style="color:#ff4422;"><span id="score-enemy">0</span> ENEMY</span>
`;
document.body.appendChild(scoreHud);

// ── Minimap capture point dots ────────────────────────────────────────────
CAPTURE_POINTS.forEach(p => {
  const { x, y } = worldToMinimap(p.x, p.z);
  const dot = document.createElement('div');
  dot.id = `cp-dot-${p.id}`;
  dot.style.cssText = `
    position:absolute; width:10px; height:10px;
    border-radius:50%; background:#888;
    left:${x}px; top:${y}px;
    transform:translate(-50%,-50%);
    pointer-events:none;
    font-family:monospace; font-size:8px; color:#fff;
    display:flex; align-items:center; justify-content:center;
    font-weight:bold;
  `;
  dot.textContent = p.id;
  minimapEnemyEl.appendChild(dot);
});

function _updateMinimapCPDot(p) {
  const dot = document.getElementById(`cp-dot-${p.id}`);
  if (!dot) return;
  dot.style.background =
    p.owner === 'player'  ? '#44aaff' :
    p.owner === 'enemy'   ? '#ff4422' : '#888';
}

// ── Match end screen ──────────────────────────────────────────────────────
const matchEndScreen = document.createElement('div');
matchEndScreen.style.cssText = `
  display:none; position:fixed; inset:0;
  background:rgba(0,0,0,0.82);
  flex-direction:column; align-items:center; justify-content:center;
  gap:18px; font-family:'Courier New',monospace; color:#c8d8a0; z-index:300;
`;
matchEndScreen.innerHTML = `
  <div id="match-result" style="font-size:28px;letter-spacing:0.15em;"></div>
  <div style="font-size:13px;color:#a0b880;">
    CAPTURES — YOU: <span id="end-player-cap">0</span>
    &nbsp;|&nbsp; ENEMY: <span id="end-enemy-cap">0</span>
  </div>
  <div style="font-size:13px;color:#a0b880;">
    TOTAL KILLS: <span id="end-kills">0</span>
  </div>
  <button id="match-end-menu-btn" style="
    margin-top:12px; padding:12px 32px;
    background:#1e2e14; color:#c8d8a0;
    border:1px solid #6a8a30;
    font-family:'Courier New',monospace;
    font-size:13px; letter-spacing:0.12em;
    cursor:pointer; border-radius:4px;
  ">&#8592; BACK TO MENU</button>
`;
document.body.appendChild(matchEndScreen);
document.getElementById('match-end-menu-btn').addEventListener('click', returnToMenu);

// ─── Grass Pool ───────────────────────────────────────────────────────────────
const grassPool = new GrassPool(scene, texLoader, {
  getTerrainY:  getTerrainY,
  terrain:      terrainBuilder,
  grassCount:   mapDef.grass?.grassCount  ?? 5000,
  flowerCount:  mapDef.grass?.flowerCount ?? 500,
});

// ─── Birch positions (used by InstancedBirchForest) ──────────────────────────
const birchSpots = mapDef.birchSpots ?? [];

const firSpots = mapDef.firSpots ?? [];

const instancedFirForest = new InstancedFirForest(
  scene, texLoader, firSpots, getTerrainY
);

const instancedBirchForest = new InstancedBirchForest(
  scene, texLoader, birchSpots, getTerrainY
);

// ─── Trees & Bushes ───────────────────────────────────────────────────────────
// const treeSpots = [];

// const treeInstances = treeSpots.map(({ cls, x, z }) => {
//   const inst = new cls(scene, texLoader, {});
//   const targetGroup = inst.lod ?? inst.root;
//   targetGroup.position.set(x, getTerrainY(x, z), z);
//   return inst;
// });

// ─── Instanced Bushes ─────────────────────────────────────────────────────────
const bushPositions = (mapDef.bushPositions ?? [])
  .map(({ x, z }) => ({ x, y: getTerrainY(x, z), z }));

const instancedBush = new InstancedBush(scene, texLoader, bushPositions);

  const debugRenderer = new RapierDebugRenderer(scene, world);
  debugRenderer.mesh.visible = false;

  // ── Tank ──────────────────────────────────────────────────────────────────
  const tank = await Tank.create(scene, world, { x: 0, y: 10, z: 0 }, config);

  // ── Tank shadow casting ───────────────────────────────────────────────────
  if (enableShadow) {
    tank.bodyGroup.traverse((child) => {
      if (child.isMesh) {
        child.castShadow    = true;
        child.receiveShadow = false; // tank doesn't need to self-shadow from terrain
      }
    });
  }
  scope.tank = tank;
  tank.turretController?.setCamera(camera);
  scope.turretController = tank.turretController ?? null;

  tank.scopeSystem = scope;

if (config.shellSpeed)  tank.bulletSystem.setShellSpeed(config.shellSpeed);
if (config.reloadTime)  tank.bulletSystem.reloadTime = config.reloadTime;
if (config.damage)     tank.bulletSystem.setDamage(config.damage);
tank.bulletSystem.onHit = (hitPos, isEnemyKill) => {
  if (isEnemyKill) {
    setTimeout(() => audio.playExplosion(), 180);
  } else {
    audio.playExplosion();
  }
};
// const audio = new AudioSystem();
// audio.configure(
//   config.tankSound ?? 'medium',
//   config.fireSound ?? 1
// );

// HUD is hidden until the player clicks Start — shown in startBtn click handler below
document.getElementById('health').style.display     = 'none';
document.getElementById('hud-fps-wrap').style.display = 'none';
document.getElementById('compass-bar').style.display  = 'none';
document.getElementById('minimap').style.display      = 'none';
document.getElementById('hud-speed').style.display    = 'none';
document.getElementById('weapon-hud').style.display   = 'none';
document.getElementById('hud-kills').style.display    = 'none';

  onShiftPress(() => tank.turretController?.toggle());
  onMiddleClick(() => tank.turretController?.fixTarget());

  // const bulletTrail = new BulletTrailSystem(scene);
  // tank.bulletSystem.setTrailSystem(bulletTrail);

  const _scopeGunPointWatcher = setInterval(() => {
    if (tank.turretController?.gunPoint) {
      scope.setGunPoint(tank.turretController.gunPoint);
      clearInterval(_scopeGunPointWatcher);
    }
  }, 100);

  const _scopeBarrelWatcher = setInterval(() => {
    if (tank.turretController?.barrel) {
      scope.barrel = tank.turretController.barrel;
      clearInterval(_scopeBarrelWatcher);
    }
  }, 100);

  const _scopeGunnerSightWatcher = setInterval(() => {   // ← add
    if (tank.gunnerSightNode) {
      scope.setGunnerSightNode(tank.gunnerSightNode);
      clearInterval(_scopeGunnerSightWatcher);
    }
  }, 100);

  // ── Player health bar ─────────────────────────────────────────────────────
  const hudEl = document.getElementById('health');
  const playerHpBar = new HealthBar(tank.health);
  playerHpBar.mount(hudEl, {
    width: 300,
    svg: `<svg width="800px" height="800px" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M4.35009 13.3929L8 16L11.6499 13.3929C13.7523 11.8912 15 9.46667 15 6.88306V3L8 0L1 3V6.88306C1 9.46667 2.24773 11.8912 4.35009 13.3929Z" fill="#ffffff8f"/>
</svg>`
  });

  playerHpBar.setArmor(tank.armour, tank.armour);

  const enemyHpContainer = document.createElement('div');
  enemyHpContainer.style.cssText = `
    position:fixed; top:16px; right:16px;
    pointer-events:none;
    font-family:monospace; font-size:12px; color:#b8d888;
  `;
  document.body.appendChild(enemyHpContainer);

const audio = new AudioSystem();
audio.configure(
  config.tankSound ?? 'medium',
  config.fireSound ?? 1
);
audio._muted = true;  // stay silent until Start is clicked

// ── Active Protection System ──────────────────────────────────────────────
const aps = new APSSystem(scene);
let apsCharges = config.loadout?.apsCharges ?? 30;

// ── Ammo Refill Points ────────────────────────────────────────────────────
const ammoPointSystem = new AmmoPointSystem(
  scene,
  mapDef.ammoPoints ?? [],
  getTerrainY,
  '/ammo_crate.glb'
);

// Add minimap dots once minimap is ready
ammoPointSystem.addMinimapDots(worldToMinimap, minimapEnemyEl);

function updateAPSHud() {
  const el = document.getElementById('weapon-slot-5-ammo');
  if (el) el.textContent = apsCharges > 0 ? `x${apsCharges}` : '0';
  const slot5 = document.getElementById('weapon-slot-5');
  if (slot5) slot5.style.opacity = apsCharges > 0 ? '1' : '0.35';
}
updateAPSHud();

const enemyPool = new EnemyTankPool(scene, world, terrainBuilder, {
  maxTanks:        7,
  playerTank:      tank,
  bulletSystem:    tank.bulletSystem,
  explosionSystem: tank.bulletSystem.explosionSystem,
  audioSystem:     audio,
  spawnInterval:   mapDef.enemySpawnInterval ?? 15,

  onEnemyShoot: null,

onHitPlayer: (incomingDamage) => {
  const damage = incomingDamage ?? 25;
  const armorAbsorb = Math.min(tank.armour, damage);
  tank.armour -= armorAbsorb;
  const healthDamage = damage - armorAbsorb;
  playerHpBar.setArmor(tank.armour, tank.maxHealth);
  if (healthDamage > 0) {
    tank.takeDamage(healthDamage);
    playerHpBar.setHealth(tank.health);
  } else {
    tank._triggerCameraShake(damage);  // ← shake even when armour absorbs all damage
  }
  audio.playImpact();
  audio.playExplosion();
},

  onMuzzleFlash: (origin) => {
    tank.bulletSystem.explosionSystem?.spawnMuzzleFlash(origin);
  },
  tanksDataPath: '/enemytanks.json',
});

  const enemyPosCache = new Map();

function refreshEnemyPosCache() {
  const active = enemyPool.getActiveTanks();

  // Always refresh positions for all living enemies
  for (const et of active) {
    if (et.isDead || !et.rigidBody) {
      enemyPosCache.delete(et);
      continue;
    }
    const p = et.rigidBody.translation();
    // Reuse existing object if present to avoid allocation
    const cached = enemyPosCache.get(et);
    if (cached) {
      cached.x = p.x;
      cached.y = p.y;
      cached.z = p.z;
    } else {
      enemyPosCache.set(et, { x: p.x, y: p.y, z: p.z });
    }
  }

  // Clean up removed tanks
  for (const key of enemyPosCache.keys()) {
    if (!active.includes(key)) {
      enemyPosCache.delete(key);
    }
  }
}

  let killCount = 0;
  let currentLevel = 1;

  // ── Repair Kit state ──────────────────────────────────────────────────────
let repairKits = config.loadout?.repairKits ?? 0;
const MAX_REPAIR_HEALTH_FRACTION = 0.5; // heals 50% of maxHealth

function updateRepairKitHUD() {
  const el = document.getElementById('repair-kit');
  if (!el) return;
  el.textContent = repairKits > 0 ? `x${repairKits}` : '0';
  const slot4 = document.getElementById('weapon-slot-4');
  if (slot4) {
    slot4.style.opacity = repairKits > 0 ? '1' : '0.35';
  }
}

let _repairHoldTimer   = 0;
let _repairHolding     = false;
const REPAIR_HOLD_TIME = 8; // seconds

function startRepair() {
  if (repairKits <= 0 || tank.isDead) return;
  if (tank.health >= tank.maxHealth) return;  // ← add this
  if (_repairHolding) return;
  _repairHolding   = true;
  _repairHoldTimer = 0;
}

function cancelRepair() {
  if (!_repairHolding) return;
  _repairHolding   = false;
  _repairHoldTimer = 0;
  // Restore the HUD label to the actual kit count
  const el = document.getElementById('repair-kit');
  if (el) el.textContent = repairKits > 0 ? `x${repairKits}` : '0';
}

function tickRepair(dt) {
  if (!_repairHolding) return;
  if (repairKits <= 0 || tank.isDead) { cancelRepair(); return; }
  if (tank.activeWeapon !== 4)        { cancelRepair(); return; }

  _repairHoldTimer += dt;

  // Show progress in the HUD label (counts up to 8)
  const el = document.getElementById('repair-kit');
  if (el) el.textContent = `${Math.min(Math.ceil(_repairHoldTimer), REPAIR_HOLD_TIME)}s`;

  if (_repairHoldTimer >= REPAIR_HOLD_TIME) {
    _repairHolding   = false;
    _repairHoldTimer = 0;
    const healAmount = Math.floor(tank.maxHealth * MAX_REPAIR_HEALTH_FRACTION);
    const newHealth  = Math.min(tank.maxHealth, tank.health + healAmount);
    repairKits--;
    tank.health = newHealth;
    playerHpBar.setHealth(tank.health);
    updateRepairKitHUD();
    hudEl.style.transition = 'filter 0.1s';
    hudEl.style.filter     = 'brightness(2) saturate(2)';
    setTimeout(() => { hudEl.style.filter = ''; }, 300);
  }
}

updateRepairKitHUD();

  enemyPool._defsReady.then(() => enemyPool.setLevel(currentLevel));

// Define resolver once — no allocation on each shot
// REPLACE with:
const _enemyResolver = (rbHandle) => {
  if (rbHandle === '__all__') return enemyPool.getActiveTanks();
  return enemyPool.getActiveTanks().find(t => t.rigidBody?.handle === rbHandle) ?? null;
};

// Main gun — still click-based
// Main gun — still click-based
onFire(() => {
  if (!gameStarted) return;
  if (tank.isDead) return;
  if (isPaused) return;
  if (matchEnded) return;
  if (_uiClickActive) return;
  if (tank.activeWeapon === 2) return;  // MG handled in loop
  if (tank.activeWeapon === 3) {
    if (smokeCount <= 0) return;
    smokeCount--;
    document.getElementById('weapon-ammo-3').textContent = smokeCount;
    tank.fire(_enemyResolver);
    audio.playSmoke();
    return;
  }
  if (tank.activeWeapon === 4) {
    startRepair();
    return;
  }
  if (tank.activeWeapon === 5) {
    if (apsCharges <= 0) return;
    apsCharges--;
    updateAPSHud();
    const tankPos = new THREE.Vector3();
    tank.bodyGroup.getWorldPosition(tankPos);
    aps.fire(tankPos);
    return;
  }
  if (!tank.bulletSystem.isReloaded) return;
  if (shellCount <= 0) return;
  shellCount--;
  document.getElementById('weapon-ammo-1').textContent = shellCount;
  tank.fire(_enemyResolver);
  audio.playShot();
  setTimeout(() => audio.playReload(), 800);
});

const _weaponSlots = [
    document.getElementById('weapon-slot-1'),
    document.getElementById('weapon-slot-2'),
    document.getElementById('weapon-slot-3'),
  ];

function _selectWeaponSlot(n) {
  tank.activeWeapon = n;
  _weaponSlots.forEach((el, i) => {
    el.style.border = (i + 1) === n
      ? '1px solid #e8f0c0'
      : '1px solid #2a3a1a';
    el.style.background = (i + 1) === n
      ? 'rgba(100,160,60,0.18)'
      : 'rgba(0,0,0,0.65)';
  });
  // Slot 4 highlight (repair kit)
  // Slot 4 highlight (repair kit)
  const slot4 = document.getElementById('weapon-slot-4');
  if (slot4) {
    slot4.style.border     = n === 4 ? '1px solid #e8f0c0' : '1px solid #2a3a1a';
    slot4.style.background = n === 4 ? 'rgba(100,160,60,0.18)' : 'rgba(0,0,0,0.65)';
  }
  // Slot 5 highlight (APS)
  const slot5 = document.getElementById('weapon-slot-5');
  if (slot5) {
    slot5.style.border     = n === 5 ? '1px solid #e8f0c0' : '1px solid #2a3a1a';
    slot5.style.background = n === 5 ? 'rgba(100,160,60,0.18)' : 'rgba(0,0,0,0.65)';
  }
}

  _selectWeaponSlot(1);   // default

  // Apply loadout values
let shellCount = config.loadout?.shellCount ?? 20;
let smokeCount = config.loadout?.smokeCount ?? 2;
let mgAmmo     = config.loadout?.mgAmmo     ?? 200;

// Apply loadout values
if (config.loadout) {
  if (tank.mgSystem) {
    tank.mgSystem.ammo    = mgAmmo;
    tank.mgSystem.maxAmmo = mgAmmo;
  }
  if (config.loadout.repairKits !== undefined) {
    repairKits = config.loadout.repairKits;
  }
}

// Initialise HUD counts
document.getElementById('weapon-ammo-1').textContent = shellCount;
document.getElementById('weapon-ammo-2').textContent = mgAmmo;
document.getElementById('weapon-ammo-3').textContent = smokeCount;

window.addEventListener('keydown', (e) => {
  if (e.key === '1') _selectWeaponSlot(1);
  if (e.key === '2') _selectWeaponSlot(2);
  if (e.key === '3') _selectWeaponSlot(3);
  if (e.key === '4') _selectWeaponSlot(4);
  if (e.key === '5') _selectWeaponSlot(5);
});

// ── Capture key ───────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if ((e.key === 'c' || e.key === 'C') && gameStarted && !tank.isDead && !isPaused)
    _cKeyHeld = true;
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'c' || e.key === 'C') {
    _cKeyHeld      = false;
    _cHoldTimer    = 0;
    document.getElementById('capture-bar').style.width = '0%';
  }
});

// ── Death screen wiring ───────────────────────────────────────────────────
  const deathScreen = document.getElementById('death-screen');

  function returnToMenu() {
    gameOver = true;

    // ── Show cleanup overlay ──────────────────────────────────────────────
    const cleanupOverlay = document.createElement('div');
    cleanupOverlay.style.cssText = `
      position:fixed; inset:0;
      background:#0d0d0d;
      display:flex; flex-direction:column;
      align-items:center; justify-content:center;
      gap:16px; font-family:monospace;
      font-size:13px; color:#6a8a30;
      z-index:9999;
    `;
    const cleanupStatus = document.createElement('div');
    cleanupStatus.textContent = 'Cleaning up…';
    const cleanupBarWrap = document.createElement('div');
    cleanupBarWrap.style.cssText = 'width:260px;height:4px;background:#1a1a1a;border-radius:2px;overflow:hidden;';
    const cleanupBar = document.createElement('div');
    cleanupBar.style.cssText = 'height:100%;width:0%;background:#6a8a30;transition:width 0.2s;';
    cleanupBarWrap.appendChild(cleanupBar);
    cleanupOverlay.appendChild(cleanupStatus);
    cleanupOverlay.appendChild(cleanupBarWrap);
    document.body.appendChild(cleanupOverlay);

    // ── Hide death screen immediately ─────────────────────────────────────
    deathScreen.style.display = 'none';

    // ── Staggered cleanup steps ───────────────────────────────────────────
    const steps = [
      [0,   '15%', 'Stopping audio…',           () => { audio.dispose(); }],
      [150, '30%', 'Despawning enemies…',        () => { enemyPool.dispose(); }],
      [300, '48%', 'Destroying tank…',           () => { tank.dispose(); aps.dispose(); }],
      [450, '60%', 'Disposing scope…',           () => { scope.dispose(); clearInterval(_scopeGunPointWatcher); clearInterval(_scopeBarrelWatcher); clearInterval(_scopeGunnerSightWatcher); }],
      [580, '70%', 'Removing terrain…',          () => {
        terrainMesh.geometry.dispose();
        terrainMesh.material.dispose();
        scene.remove(terrainMesh);
      }],
      [700, '80%', 'Clearing grass…', () => {
        ammoPointSystem.dispose(); 
//         treeInstances.forEach(inst => {
//   const g = inst.lod ?? inst.root;
//   scene.remove(g);
// });
instancedBirchForest.dispose();
instancedFirForest.dispose();
grassPool.dispose?.();
instancedBush.dispose();
if (showWater) water.dispose();
// ── Capture point meshes ──────────────────────────────────────────────
CAPTURE_POINTS.forEach(p => {
  const m = _cpMeshes[p.id];
  if (!m) return;
  scene.remove(m.pole); m.pole.geometry.dispose(); m.pole.material.dispose();
  scene.remove(m.ring); m.ring.geometry.dispose(); m.ring.material.dispose();
});
captureHud.remove();
scoreHud.remove();
matchEndScreen.remove();
      }],
      [820, '88%', 'Releasing physics world…',   () => {
        try { world.removeRigidBody(terrainBody); } catch(_) {}
        try { world.removeRigidBody(wallBody); }    catch(_) {}
        // ── Remove house collider bodies ──────────────────────────────────────
        for (const body of _houseColliderBodies) {
          try { world.removeRigidBody(body); } catch(_) {}
        }
        _houseColliderBodies.length = 0;
        try { eventQueue.free(); }                  catch(_) {}
        try { world.free(); }                       catch(_) {}
      }],
      [920, '94%', 'Disposing renderer…',        () => {
        debugRenderer.mesh.geometry.dispose();
        debugRenderer.mesh.material.dispose();
        scene.remove(debugRenderer.mesh);
        if (tank._ejectedTurret) {
          scene.remove(tank._ejectedTurret);
          tank._ejectedTurret.traverse(c => {
            if (c.isMesh) { c.geometry?.dispose(); c.material?.dispose(); }
          });
          tank._ejectedTurret = null;
        }
        scene.clear();
        renderer.domElement.remove();
        renderer.dispose();
        window.removeEventListener('mousemove', _onMousemove);
        window.removeEventListener('resize',    _onResize);
        window.removeEventListener('keydown',   _onKeydownDebug);
      }],
      [1050,'100%','Returning to menu…',         () => {
        enemyHpContainer.remove();
        const controlsHud = document.querySelector('body > div[style*="bottom: 24px"]');
        controlsHud?.remove();
        document.getElementById('health').style.display             = 'none';
        document.getElementById('hud-fps-wrap').style.display       = 'none';
        document.getElementById('compass-bar').style.display        = 'none';
        document.getElementById('minimap').style.display            = 'none';
        document.getElementById('hud-speed').style.display          = 'none';
        document.getElementById('weapon-hud').style.display         = 'none';
        document.getElementById('hud-kills').style.display          = 'none';
        document.getElementById('hud-kills-val').textContent        = '0';
        document.getElementById('hud-fps').textContent              = '0';
        document.getElementById('hud-speed-val').textContent        = '0.0';
        document.getElementById('hud-gear-val').textContent         = 'N';
        document.getElementById('weapon-ammo-1').textContent        = '0';
        document.getElementById('weapon-ammo-2').textContent        = '0';
        document.getElementById('weapon-ammo-3').textContent        = '0';
        minimapEnemyEl.innerHTML = '';
        minimapEnemySet.clear();
        enemyPosCache.clear();
        playerHpBar.remove();
        document.getElementById('upload-zone').classList.remove('has-file');
        document.getElementById('file-name').textContent = 'No file selected — default Tiger I will be used';
        document.getElementById('model-input').value = '';
        setTimeout(() => {
        cleanupOverlay.remove();
        // ── Hide panels BEFORE showing configurator to prevent flash ──
        document.getElementById('cfg-panel').style.display             = 'none';
        document.getElementById('cfg-close-btn').style.display         = 'none';
        document.getElementById('tank-select-panel').style.display     = 'none';
        document.getElementById('tank-select-close-btn').style.display = 'none';
        document.getElementById('tank-switcher').style.display         = 'none';
        document.getElementById('configurator').style.display          = 'flex';
        document.getElementById('loading').style.display               = 'none';
        document.getElementById('preview-info-btn').style.display      = 'flex';
        document.getElementById('auto-rotate-btn').style.display       = 'flex';
        document.getElementById('preview-top-left-btns').style.display = 'flex';
        document.getElementById('map-selector-widget').style.display   = 'block';

        // ── Force all left panels closed on menu return ────────────────────
        setTimeout(() => {
          document.getElementById('cfg-panel').style.display             = 'none';
          document.getElementById('cfg-close-btn').style.display         = 'none';
          document.getElementById('tank-select-panel').style.display     = 'none';
          document.getElementById('tank-select-close-btn').style.display = 'none';
          document.getElementById('tank-switcher').style.display         = 'none';
          document.getElementById('preview-top-left-btns').style.display = 'flex';
          document.getElementById('map-selector-widget').style.display   = 'block';
          window._openPanel?.('none');
        }, 50);

          window._openPanel?.('none');

          // ── Restore cfg-panel scroll ───────────────────────────────────
          const _cfgPanel = document.getElementById('cfg-panel');
          if (_cfgPanel) {
            _cfgPanel.style.overflowY    = 'auto';
            _cfgPanel.style.pointerEvents = 'auto';
            _cfgPanel.style.display      = 'none';
            _cfgPanel.scrollTop = _cfgPanel.scrollTop;
          }

          // ── Remove any stale canvas pointer-event blocks ───────────────
          const _oldCanvas = document.querySelector('canvas:not(#preview-canvas):not(#minimap-canvas)');
          if (_oldCanvas) _oldCanvas.remove();

          // ── Dispose stale preview tracks before rebuilding ─────────────
          if (window._previewTracks) {
            window._previewTracks.forEach(t => { try { t.dispose(); } catch(_) {} });
            window._previewTracks.length = 0;
          }

          // ── Reinit physics first, then build tracks + start loop ───────
          window.initPreviewPhysics?.().then(() => {
            window.buildPreviewTracks?.();
            window.loadPreviewModel?.(
              window._lastTankConfig?.modelObjectURL ??
              window._lastTankConfig?.modelPath ??
              '/model/Tank_Tiger_L.glb'
            );
            window.startPreviewLoop?.();
          });
        }, 3000);
      }],
    ];

steps.forEach(([delay, width, text, fn]) => {
      setTimeout(() => {
        cleanupStatus.textContent = text;
        cleanupBar.style.width    = width;
        fn();
      }, delay);
    });
  }

  document.getElementById('death-menu-btn').addEventListener('click', returnToMenu);

// ── Camera smoothing ──────────────────────────────────────────────────────
  const smoothCamPos  = new THREE.Vector3(0, 6, 14);
  const smoothCamLook = new THREE.Vector3();

  // ── Intro flythrough camera ────────────────────────────────────────────
  let introActive   = false;
  let introElapsed   = 0;
  const INTRO_DURATION = 4; // seconds, "smooth medium speed"
  const _introStartPos  = new THREE.Vector3();
  const _introStartLook = new THREE.Vector3();
  const _introEndLook   = new THREE.Vector3();

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function startIntroCamera(tankWorldPos) {
    introActive  = true;
    introElapsed = 0;

    // High overview position — tweak height/offset to taste for your terrain size
    _introStartPos.set(tankWorldPos.x + 150, 150, tankWorldPos.z + 70); // tiny z offset avoids a degenerate lookAt
    _introStartLook.set(tankWorldPos.x, tankWorldPos.y, tankWorldPos.z);

    camera.position.copy(_introStartPos);
    camera.lookAt(_introStartLook);
  }

  // ── Per-frame scratch vectors — never re-allocated inside the loop ────────
  const _tankPos        = new THREE.Vector3();   // tank world position (reused)
  const _playerPos      = new THREE.Vector3();   // passed to enemyPool.update
  const _desiredCamPos  = new THREE.Vector3();   // camera target position
  const _camOffset      = new THREE.Vector3();   // camera orbit offset
  const _barrelDir      = new THREE.Vector3();

  // ── Speed HUD throttle ────────────────────────────────────────────────────
  let speedFrameSkip = 0;

// ── Enemy cache throttle ──────────────────────────────────────────────────────
let enemyCacheSkip = 0;

// ── Bullet vec pool — pre-allocated, never re-allocated inside loop ───────────
// const _bulletVecPool = Array.from({ length: 20 }, () => new THREE.Vector3());

  // ── Resize ────────────────────────────────────────────────────────────────
  const _onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    water.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', _onResize);

  window.addEventListener('keydown', (e) => {
  if (e.key === 'X' || e.key === 'x') exportTerrainAsGLB();
});

  // ── cycleData — updated every frame ───────────────────────────────────────
  const cycleData = {
    now:            0,
    delta:          0,
    elapsed:        0,
    totalPauseTime: 0,
    pauseStartTime: 0,
  };

  // ── Respawn ───────────────────────────────────────────────────────────────
const _playerSpawn = mapDef.spawnPoints?.find(s => s.id === 'player_default')
                  ?? mapDef.spawnPoints?.[0]
                  ?? { x: 198, y: 10, z: 0 };
const SPAWN_POS = { x: _playerSpawn.x, y: _playerSpawn.y ?? 10, z: _playerSpawn.z };

function _doRespawn() {
  _isRespawning = false;
  _respawnTimer = 0;

  // Rebuild physics + reset tank state via respawn()
  tank.respawn(SPAWN_POS);
  audio.reviveAudio();
  playerHpBar.setHealth(tank.health);
  playerHpBar.setArmor(tank.armour, tank.maxHealth);
  deathScreen.style.display    = 'none';
  document.getElementById('pause-btn').style.display    = 'flex';
  document.getElementById('weapon-hud').style.display   = 'flex';
  document.getElementById('minimap').style.display      = 'block';
  document.getElementById('hud-speed').style.display    = 'block';
  document.getElementById('hud-kills').style.display    = 'block';
  document.getElementById('compass-bar').style.display  = 'block';
  document.getElementById('hud-fps-wrap').style.display = 'block';
  document.getElementById('health').style.display       = 'block';
}

  // ── Game loop ─────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  const FIXED = 1 / 60;
  let accum  = 0;
  let frameCount = 0;
  let timeSum    = 0;

function loop() {
    if (gameOver) return;
    if (isPaused) { requestAnimationFrame(loop); return; }

    requestAnimationFrame(loop);

// ── Deferred respawn — runs before any world.step() or castRay() ──────
    if (_pendingRespawn) {
      _pendingRespawn = false;
      _doRespawn();
      return; // skip the rest of this frame entirely — let the new body settle first
      // NOTE: requestAnimationFrame(loop) was already called once at the
      // top of this function — calling it again here double-scheduled
      // loop(), causing world.step() to run twice per frame and triggering
      // Rapier's "recursive use of an object" panic, which then broke the
      // respawn flow on subsequent attempts.
    }

    const dt = clock.getDelta();
    accum   += dt;

    cycleData.delta   = dt;
    cycleData.elapsed += dt;
    cycleData.now     = performance.now();

    // ── Cache translation once — used everywhere below ─────────────────────
    const _tPos = tank.rigidBody ? tank.rigidBody.translation() : null;

    // ── FPS counter ───────────────────────────────────────────────────────
    frameCount++;
    timeSum += dt;

    if (frameCount === 30) {
      const fps = Math.round(frameCount / timeSum);
      document.getElementById('hud-fps').textContent = fps;
      frameCount = 0;
      timeSum    = 0;
    }

    // ── Speed / gear HUD — throttled to every 10 frames ───────────────────
    if (_tPos) {
      speedFrameSkip++;
      if (speedFrameSkip >= 10) {
        speedFrameSkip = 0;
        const vel = tank.rigidBody.linvel();
        const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
        const _speedStr = (speed * 3.6).toFixed(1);
        if (_speedStr !== _lastSpeedStr) {
          _lastSpeedStr = _speedStr;
          document.getElementById('hud-speed-val').textContent = _speedStr;
        }
      }
      if (window._tankGearChanged) {
        window._tankGearChanged = false;
        const g = tank.gear;
        const label = g === -1 ? 'R' : g === 0 ? 'N' : String(g);
        document.getElementById('hud-gear-val').textContent = label;
      }
      // Update MG ammo display — only write when value changes
      const _mgAmmo = tank.mgSystem?.ammo ?? 0;
      if (_mgAmmo !== _lastMgAmmo) {
        _lastMgAmmo = _mgAmmo;
        document.getElementById('weapon-ammo-2').textContent = _mgAmmo;
      }
    }

// ── Fixed physics steps ───────────────────────────────────────────────
    while (accum >= FIXED) {
      try {
        world.step(eventQueue);
      } catch (err) {
        console.error('[Physics] world.step failed, skipping frame:', err);
        accum = 0;
        break;
      }
      accum -= FIXED;
    }

    // ── Drain collision events AFTER all steps complete ───────────────────
    // Must be outside world.step() to avoid Rapier aliasing error
    eventQueue.drainCollisionEvents((handle1, handle2, started) => {
      if (!started) return;
      if (!tank.rigidBody) return;   // tank dead — no rigid body to check

      const col1 = world.getCollider(handle1);
      const col2 = world.getCollider(handle2);
      if (!col1 || !col2) return;

      const rb1 = col1.parent();
      const rb2 = col2.parent();
      if (!rb1 || !rb2) return;

      const activeTankHandles = new Map();
      if (tank.rigidBody) {
        activeTankHandles.set(tank.rigidBody.handle, tank.rigidBody);
      }
      for (const et of enemyPool.getActiveTanks()) {
        if (et.rigidBody) {
          activeTankHandles.set(et.rigidBody.handle, et.rigidBody);
        }
      }

      const tankRb  = activeTankHandles.get(rb1.handle)
                   ?? activeTankHandles.get(rb2.handle)
                   ?? null;
      const otherRb = tankRb?.handle === rb1.handle ? rb2 : rb1;

      if (!tankRb || !otherRb) return;
    });

    if (debugRenderer.mesh.visible) {
      try {
        debugRenderer.update();
      } catch (err) {
        console.error('[DebugRenderer] update failed, disabling:', err);
        debugRenderer.mesh.visible = false;
      }
    }

    // ── Edge-orbit: spin camera when cursor is pinned at left/right edge,
    // but only while in free-aim mode (not scoped) and turret aiming enabled ─
    if (!scope.isScoped && tank.turretController?.enabled) {
      if (_mouseAtRightEdge) {
        camYaw -= EDGE_ORBIT_PX_PER_SEC * EDGE_ORBIT_SENSITIVITY * dt;
      } else if (_mouseAtLeftEdge) {
        camYaw += EDGE_ORBIT_PX_PER_SEC * EDGE_ORBIT_SENSITIVITY * dt;
      }
    }

    // ── Tank update ───────────────────────────────────────────────────────
    tank.update(dt, keys, camera, mouse, cycleData);

    if (!tank.isDead) {
  const vel = tank.rigidBody?.linvel();
  const avgThrottle = vel ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) / 3.5 : 0;
  audio.update(dt, avgThrottle, avgThrottle > 0.05);

  // ── Water sound ───────────────────────────────────────────────────────
  const _waterLevel = _waterDef.y ?? terrainData.waterLevel ?? 8.4;
  const _isInWater  = _tPos && _tPos.y < _waterLevel + 0.5;
  const _tankSpeed  = vel ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) : 0;

  if (_isInWater && _tankSpeed > 0.5) {
    if (!audio.isWaterPlaying) audio.startWater();
    audio.updateWater(true, _tankSpeed);
  } else if (_isInWater) {
    // Still in water but not moving — fade out but keep loop alive
    audio.updateWater(false, 0);
  } else {
    // Left the water entirely — tear down
    if (audio.isWaterPlaying) audio.stopWater();
  }
}
// ── Bullet trail — zero allocations, pool reused each frame ──────────
    // bulletPositions.clear();
    // let _bulletPoolIdx = 0;
    // for (const b of tank.bulletSystem.bullets) {
    //   if (b.trailId !== undefined && _bulletPoolIdx < _bulletVecPool.length) {
    //     const p = b.rigidBody.translation();
    //     _bulletVecPool[_bulletPoolIdx].set(p.x, p.y, p.z);
    //     bulletPositions.set(b.trailId, _bulletVecPool[_bulletPoolIdx]);
    //     _bulletPoolIdx++;
    //   }
    // }
    // bulletTrail.update(dt, bulletPositions);

    // ── Continuous MG fire while mouse held ───────────────────────────────
// Only call when MG is actually ready — avoids tank.fire() overhead when timer hasn't elapsed
if (tank.activeWeapon === 2 && !tank.isDead && !isPaused && !matchEnded && !_uiClickActive) {
  if (isMouseHeld && tank.mgSystem?.isReady) {
    tank.fire(_enemyResolver);
    if (!audio.isMGPlaying) audio.startMG();
  } else if (!isMouseHeld && audio.isMGPlaying) {
    audio.stopMG();
  } else if (tank.mgSystem?.isEmpty && audio.isMGPlaying) {
    audio.stopMG();
  }
} else if (audio.isMGPlaying) {
  audio.stopMG();
}

tickRepair(dt);

// ── Match timer ───────────────────────────────────────────────────────────
if (gameStarted && !matchEnded) {
  matchElapsed += dt;
  const remaining = Math.max(0, MATCH_DURATION - matchElapsed);
  const mm = Math.floor(remaining / 60);
  const ss = Math.floor(remaining % 60);
  document.getElementById('match-timer').textContent =
    `${mm}:${ss.toString().padStart(2, '0')}`;

  if (remaining <= 0 && !matchEnded) {
    matchEnded = true;

    // ── Lock player input and freeze enemy AI ─────────────────────────────
    tank._inputLocked = true;
    // Disable turret control and hide all crosshairs
    if (tank.turretController) {
      tank.turretController.enabled = false;
      tank.turretController._crosshair.style.display      = 'none';
      tank.turretController._turretCrosshair.style.display = 'none';
      tank.turretController._rangeDisplay.style.display    = 'none';
      tank.turretController._matchEnded                   = true;
    }

    // Brake the player tank to a stop
    if (tank.rigidBody) {
      tank.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      tank.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    // Deactivate all living enemy tanks immediately
    for (const et of enemyPool.getActiveTanks()) {
      if (!et.isDead) {
        // Brake them first so they don't slide
        et.rigidBody?.setLinvel({ x: 0, y: 0, z: 0 }, true);
        et.rigidBody?.setAngvel({ x: 0, y: 0, z: 0 }, true);
        et.state = 'IDLE';   // drop out of AI FSM — update() skips IDLE
      }
    }

    // Stop auto-spawning new enemies
    enemyPool._spawnTimer = Infinity;

    // ── Show match end screen ─────────────────────────────────────────────
    const result = playerCaptures > enemyCaptures ? 'VICTORY' :
                   playerCaptures < enemyCaptures ? 'DEFEAT'  : 'DRAW';
    document.getElementById('match-result').textContent   = result;
    document.getElementById('match-result').style.color   =
      result === 'VICTORY' ? '#44ffaa' :
      result === 'DEFEAT'  ? '#ff4422' : '#ffdd44';
    document.getElementById('end-player-cap').textContent = playerCaptures;
    document.getElementById('end-enemy-cap').textContent  = enemyCaptures;
    document.getElementById('end-kills').textContent      = killCount;
    matchEndScreen.style.display = 'flex';
    audio._stopEngine?.();
    audio.stopMG?.();
    document.getElementById('pause-btn').style.display = 'none';
  }
}

// ── Respawn timer ─────────────────────────────────────────────────────────
if (_isRespawning && !matchEnded) {
  _respawnTimer -= dt;
  // Show countdown on death screen
  const el = document.getElementById('death-kills');
  if (el) el.textContent =
    `${killCount} kills — respawning in ${Math.ceil(_respawnTimer)}s`;
  if (_respawnTimer <= 0) {
    _isRespawning = false;
    _pendingRespawn = true;   // ← defer to next frame start
  }
}

// ── Override death screen to use respawn instead of staying dead ──────────
// if (tank._readyToShowDeath && !tank._deathScreenShown && !matchEnded) {
//   // (already handled above in the existing death block — add respawn trigger)
//   _isRespawning = true;
//   _respawnTimer = RESPAWN_DELAY;
//   // Hide the main menu button on death screen during match
//   document.getElementById('death-menu-btn').style.display = 'none';
// }

// ── Capture point logic ───────────────────────────────────────────────────
if (_tPos && gameStarted && !matchEnded) {
  _nearPoint = null;

  CAPTURE_POINTS.forEach(p => {
    const dx  = p.x - _tPos.x;
    const dz  = p.z - _tPos.z;
    const dsq = dx * dx + dz * dz;

    // ── Player proximity ──────────────────────────────────────────────────
    const playerInRange = dsq < CAPTURE_RADIUS * CAPTURE_RADIUS && !tank.isDead;
    if (playerInRange) _nearPoint = p;

    // ── Enemy proximity (any active enemy) ───────────────────────────────
    let enemyInRange = false;
    for (const [et, cached] of enemyPosCache.entries()) {
      const ex  = p.x - cached.x;
      const ez  = p.z - cached.z;
      if (ex * ex + ez * ez < CAPTURE_RADIUS * CAPTURE_RADIUS) {
        enemyInRange = true;
        break;
      }
    }

    // ── Capture progress ──────────────────────────────────────────────────
    const prevOwner = p.owner;

    if (playerInRange && _cKeyHeld && p.owner !== 'player') {
      p.captureTimer += dt;
      p.capturingBy   = 'player';
      if (p.captureTimer >= CAPTURE_HOLD_TIME) {
        p.captureTimer = 0;
        p.capturingBy  = null;
        if (p.owner === 'enemy') enemyCaptures = Math.max(0, enemyCaptures - 1);
        p.owner = 'player';
        playerCaptures++;
        document.getElementById('score-player').textContent = playerCaptures;
        _setCPColor(p);
        _updateMinimapCPDot(p);
      }
    } else if (enemyInRange && !playerInRange && p.owner !== 'enemy') {
      p.captureTimer += dt * 0.4; // enemies capture slower
      p.capturingBy   = 'enemy';
      if (p.captureTimer >= CAPTURE_HOLD_TIME) {
        p.captureTimer = 0;
        p.capturingBy  = null;
        if (p.owner === 'player') playerCaptures = Math.max(0, playerCaptures - 1);
        p.owner = 'enemy';
        enemyCaptures++;
        document.getElementById('score-enemy').textContent = enemyCaptures;
        _setCPColor(p);
        _updateMinimapCPDot(p);
        document.getElementById('score-player').textContent = playerCaptures;
      }
    } else {
      // Decay timer when neither is capturing
      p.captureTimer = Math.max(0, p.captureTimer - dt * 0.5);
      p.capturingBy  = null;
    }
  });

  // ── Capture HUD ──────────────────────────────────────────────────────────
  if (_nearPoint && _nearPoint.owner !== 'player' && !tank.isDead) {
    captureHud.style.display = 'flex';
    if (_cKeyHeld) {
      _cHoldTimer += dt;
      const pct = Math.min(_cHoldTimer / CAPTURE_HOLD_TIME * 100, 100);
      document.getElementById('capture-bar').style.width = pct + '%';
    } else {
      _cHoldTimer = 0;
      document.getElementById('capture-bar').style.width = '0%';
    }
  } else {
    captureHud.style.display = 'none';
    _cHoldTimer = 0;
  }
}

// ── APS: collect all enemy projectile systems (gunType 2 enemies only) ────
const _apsSystems = [];
for (const et of enemyPool.getActiveTanks()) {
  if (et._ownBulletSystem) _apsSystems.push(et._ownBulletSystem);
}
aps.update(dt, _apsSystems);

// ── Ammo point refill system ──────────────────────────────────────────────
ammoPointSystem.update(
  dt,
  _tPos,
  tank.isDead,
  isPaused,
  matchEnded,
  // current ammo state
  { shellCount, mgAmmo:     tank.mgSystem?.ammo ?? mgAmmo, smokeCount, repairKits, apsCharges },
  // starting loadout (refill target)
  {
    shellCount:  config.loadout?.shellCount  ?? 20,
    mgAmmo:      config.loadout?.mgAmmo      ?? 150,
    smokeCount:  config.loadout?.smokeCount  ?? 2,
    repairKits:  config.loadout?.repairKits  ?? 0,
    apsCharges:  config.loadout?.apsCharges  ?? 30,
  },
  // callback — apply refill to live state
  (filled) => {
    shellCount  = filled.shellCount;
    mgAmmo      = filled.mgAmmo;
    smokeCount  = filled.smokeCount;
    repairKits  = filled.repairKits;
    apsCharges  = filled.apsCharges;

    // Sync HUD
    document.getElementById('weapon-ammo-1').textContent = shellCount;
    document.getElementById('weapon-ammo-2').textContent = mgAmmo;
    document.getElementById('weapon-ammo-3').textContent = smokeCount;
    updateRepairKitHUD();
    updateAPSHud();

    // Sync MG system
    if (tank.mgSystem) {
      tank.mgSystem.ammo    = mgAmmo;
      tank.mgSystem.maxAmmo = mgAmmo;
    }
  }
);

    // ── Death screen ──────────────────────────────────────────────────────
if (tank._readyToShowDeath && !tank._deathScreenShown) {
  tank._deathScreenShown = true;
  audio.playDeath();
  audio._stopEngine();
  document.getElementById('pause-btn').style.display = 'none';

  if (!matchEnded) {
    // ── Respawn path during match ─────────────────────────────────────────
    _isRespawning = true;
    _respawnTimer = RESPAWN_DELAY;
    deathScreen.style.display = 'flex';
    document.getElementById('death-menu-btn').style.display = 'none';
    document.getElementById('death-kills').textContent =
      `${killCount} kills — respawning in ${RESPAWN_DELAY}s`;
  } else {
    // ── Permanent death after match ends ──────────────────────────────────
    document.getElementById('death-kills').textContent = killCount;
    document.getElementById('death-menu-btn').style.display = 'block';
    deathScreen.style.display = 'flex';
  }

    // ── Exit scope immediately if active ─────────────────────────────────
  if (scope.isScoped) {
    scope._exitScope();
    tank.turretController?.setScopeLocked?.(false);
  }

  // ── Hide crosshairs immediately on death ──────────────────────────────
  tank.turretController?._crosshair      && (tank.turretController._crosshair.style.display      = 'none');
  tank.turretController?._turretCrosshair && (tank.turretController._turretCrosshair.style.display = 'none');
  tank.turretController?._rangeDisplay   && (tank.turretController._rangeDisplay.style.display   = 'none');
  document.getElementById('weapon-hud').style.display   = 'none';
  document.getElementById('minimap').style.display      = 'none';
  document.getElementById('hud-speed').style.display    = 'none';
  document.getElementById('hud-kills').style.display    = 'none';
  document.getElementById('compass-bar').style.display  = 'none';
  document.getElementById('hud-fps-wrap').style.display = 'none';
  document.getElementById('health').style.display       = 'none';
}

    // ── Enemy pool update — uses cached _tPos ─────────────────────────────
    // ── Enemy pool update — keep running even while player is dead ────────
    if (_tPos) {
      _playerPos.set(_tPos.x, _tPos.y, _tPos.z);
    }
    // Always update enemies regardless of whether player rigidBody exists
    if (!matchEnded) {
      enemyPool.update(dt, _playerPos);
    } else {
      // Match over — only tick dissolve animations on dead tanks, skip AI/spawning
      for (const et of enemyPool.getActiveTanks()) {
        if (et._dissolveActive) et._tickDissolve(dt);
        et._ownBulletSystem?.update(dt);
      }
    }

    // ── Enemy cache — throttled to every 15 frames ────────────────────────
    enemyCacheSkip++;
    if (enemyCacheSkip >= 15) {
      enemyCacheSkip = 0;
      refreshEnemyPosCache();
      updateMinimapEnemies();
    }

    // ── Minimap player dot — skips write when position unchanged ──────────
    updateMinimapPlayer(_tPos);

    // ── Kill counter / level progression ──────────────────────────────────
    for (const et of enemyPool.getActiveTanks()) {
      if (et.isDead && !et._killCounted) {
        et._killCounted = true;
        killCount++;
        document.getElementById('hud-kills-val').textContent = killCount;

        const newLevel = Math.floor(killCount / 3) + 1;
        if (newLevel !== currentLevel) {
          currentLevel = newLevel;
          enemyPool.setLevel(currentLevel);
          console.log(`[Level] Advanced to level ${currentLevel} — spawning ${enemyPool._currentDef?.name}`);
        }
      }
    }

    // ── BirchTree / FirTree proximity-based fall trigger ──────────────────
    if (_tPos) {
      // ── Instanced forest fall triggers ────────────────────────────────
      const _tx = _tPos.x;
      const _tz = _tPos.z;

      for (const forest of [instancedBirchForest, instancedFirForest]) {
        if (!forest._ready) continue;
        for (let i = 0; i < forest.spots.length; i++) {
          if (forest._fallState[i] !== 0) continue;
          const { x: sx, z: sz } = forest.spots[i];
          const dx  = sx - _tx;
          const dz  = sz - _tz;
          const dsq = dx * dx + dz * dz;
          if (dsq < 9) {
            const len = Math.sqrt(dsq) || 1;
            forest.startFallAt(sx, sz, dx / len, dz / len);
            audio.playTreeFall();
          }
        }
      }

      // ── Individual (non-instanced) tree fall triggers — kept for FirTree if any remain
      // for (const inst of treeInstances) {
      //   if (inst._fallen || inst._falling) continue;
      //   if (typeof inst.startFall !== 'function') continue;
      //   const root = inst.lod ?? inst.root;
      //   if (!root) continue;
      //   const tx  = root.position.x - _tx;
      //   const tz  = root.position.z - _tz;
      //   const dsq = tx * tx + tz * tz;
      //   if (dsq < 9) {
      //     const len = Math.sqrt(dsq) || 1;
      //     inst.startFall(tx / len, tz / len);
      //     audio.playTreeFall();
      //   }
      // }
    }
    // ─── Grass pool update ────────────────────────────────────────────────────────
if (_tPos) {
  grassPool.update(cycleData.elapsed, { position: { x: _tPos.x, y: _tPos.y, z: _tPos.z } }, scene, camera);
}

// ─── Water update ───────────────────────────────────────────────────────
if (showWater) water.update(dt);

// ─── Tree / Bush update ───────────────────────────────────────────────────────
// treeInstances.forEach(inst => inst.update(cycleData.elapsed, camera, scene));
instancedBirchForest.update(cycleData.elapsed, camera, scene);
instancedFirForest.update(cycleData.elapsed, camera, scene);
instancedBush.update(cycleData.elapsed, camera, scene);

// ── Camera: orbit + follow — zero allocations ─────────────────────────
    if (!_tPos) {
      renderer.render(scene, camera);
      return;
    }

    // tankTarget reuses _tankPos scratch
    // tankTarget reuses _tankPos scratch
    _tankPos.set(_tPos.x, _tPos.y + 1.2, _tPos.z);

    // ── Shadow frustum follows tank — must run every frame, even during
    // the intro flythrough, otherwise light2 stays at its stale initial
    // position/target until intro ends, causing a visible shadow "jump" ───
    light2.position.set(
      _tPos.x + LIGHT2_OFFSET.x,
      _tPos.y + LIGHT2_OFFSET.y,
      _tPos.z + LIGHT2_OFFSET.z
    );
    light2.target.position.set(_tPos.x, _tPos.y, _tPos.z);
    light2.target.updateMatrixWorld();

    // ── Intro flythrough — overrides normal camera follow until it finishes ─
    if (introActive) {
      introElapsed += dt;
      const t = Math.min(introElapsed / INTRO_DURATION, 1);
      const k = easeInOutCubic(t);

      // Compute the normal gameplay camera target so we can ease into exactly
      // where the follow-cam would have been anyway (no pop on handoff)
      _camOffset.set(
        camDist * Math.sin(camYaw)  * Math.cos(camPitch),
        camDist * Math.sin(camPitch),
        camDist * Math.cos(camYaw)  * Math.cos(camPitch),
      );
      _desiredCamPos.copy(_tankPos).add(_camOffset);

      camera.position.lerpVectors(_introStartPos, _desiredCamPos, k);
      _introEndLook.copy(_tankPos);
      smoothCamLook.lerpVectors(_introStartLook, _introEndLook, k);
      camera.lookAt(smoothCamLook);

      if (t >= 1) {
        introActive = false;
        smoothCamPos.copy(_desiredCamPos); // hand off cleanly to normal follow-cam
      }

      scope.update();
      compassAccum += dt;
      if (compassAccum >= COMPASS_INTERVAL) {
        compassAccum -= COMPASS_INTERVAL;
        drawCompassBar();
      }
      renderer.render(scene, camera);
      return; // skip normal camera-follow logic this frame
    }

    // Camera offset — reuses _camOffset scratch
    _camOffset.set(
      camDist * Math.sin(camYaw)  * Math.cos(camPitch),
      camDist * Math.sin(camPitch),
      camDist * Math.cos(camYaw)  * Math.cos(camPitch),
    );

    // Camera offset — reuses _camOffset scratch
    _camOffset.set(
      camDist * Math.sin(camYaw)  * Math.cos(camPitch),
      camDist * Math.sin(camPitch),
      camDist * Math.cos(camYaw)  * Math.cos(camPitch),
    );

    // Desired position — reuses _desiredCamPos scratch
    _desiredCamPos.copy(_tankPos).add(_camOffset);

    smoothCamPos.lerp(_desiredCamPos, dt * 8);
    smoothCamLook.lerp(_tankPos,      dt * 8);

    camera.position.copy(smoothCamPos);
    // ── Apply camera shake offset ─────────────────────────────────────────
    if (tank._shakeOffset) {
      camera.position.x += tank._shakeOffset.x;
      camera.position.y += tank._shakeOffset.y;
    }
    camera.lookAt(smoothCamLook);

// ── Shadow frustum follows tank ─────────────────────────────────────────
    // light2.position.set(
    //   _tPos.x + LIGHT2_OFFSET.x,
    //   _tPos.y + LIGHT2_OFFSET.y,
    //   _tPos.z + LIGHT2_OFFSET.z
    // );
    // light2.target.position.set(_tPos.x, _tPos.y, _tPos.z);
    // light2.target.updateMatrixWorld();

// ── Barrel angle → predicted range in scope HUD ───────────────────────
if (scope.isScoped && tank.turretController?.gunPoint) {
  tank.turretController.gunPoint.getWorldDirection(_barrelDir);

  // Barrel elevation angle
  const barrelAngle = Math.asin(_barrelDir.y);
  scope.setBarrelAngle(barrelAngle);

  // Predicted range — only for projectile gun type
  if (tank.cfg.gunType === 2) {
    const speed = tank.bulletSystem.bulletSpeed;
    const vV    = speed * _barrelDir.y;
    const vH    = speed * Math.sqrt(1 - _barrelDir.y * _barrelDir.y);
    const h0    = 1.5;
    const g     = 22;
    const disc  = vV * vV + 2 * g * h0;
    const tof   = (vV + Math.sqrt(disc)) / g;
    const range = vH * tof;
    scope.setPredictedRange(Math.max(23, range));
  }
}
    scope.update();

    // ── Compass — throttled to 30fps, skipped when camera is still ────────
compassAccum += dt;
if (compassAccum >= COMPASS_INTERVAL) {
  compassAccum -= COMPASS_INTERVAL;
  drawCompassBar();
}

// ── Animate sky clouds ────────────────────────────────────────────────
    // sky.material.uniforms['time'].value = cycleData.elapsed;
    renderer.render(scene, camera);
  }

  const _onKeydownDebug = (e) => {
    if (e.key === 'B' || e.key === 'b') {
      debugRenderer.mesh.visible = !debugRenderer.mesh.visible;
    }
  };
  window.addEventListener('keydown', _onKeydownDebug);

// ── Hide loading screen + show Start button ───────────────────────────────
  const loadingEl  = document.getElementById('loading');
  const hudEl2     = document.getElementById('health');
  const barEl      = document.getElementById('loading-bar');
  const statusEl   = document.getElementById('loading-status');

  // ── Animate loading steps ─────────────────────────────────────────────────
  const loadingSteps = [
    [0,   '10%',  'Initialising physics…'],
    [200, '25%',  'Building terrain…'],
    [400, '45%',  'Loading tank model…'],
    [650, '60%',  'Building tracks & wheels…'],
    [900, '75%',  'Spawning enemies…'],
    [1100,'88%',  'Loading audio…'],
    [1300,'100%', 'Ready.'],
  ];
  loadingSteps.forEach(([delay, width, text]) => {
    setTimeout(() => {
      barEl.style.width  = width;
      if (statusEl) statusEl.textContent = text;
    }, delay);
  });

  // Build the start button overlay
  const startOverlay = document.createElement('div');
  startOverlay.style.cssText = `
      position: fixed;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: transparent;
      z-index: 9999;
    `;
    startOverlay.addEventListener('click', (e) => {
      e.stopPropagation();
    });

  const startBtn = document.createElement('button');
  startBtn.textContent = 'On the way!';
  startBtn.style.cssText = `
    padding: 9px 28px;
    font-size: 16px;
    font-family: monospace;
    font-weight: bold;
    letter-spacing: 2px;
    color: #d4f0a0;
    background: rgba(40,70,20,0.85);
    border: 1px solid #6aaa30;
    cursor: pointer;
    text-transform: uppercase;
    transition: background 0.15s, transform 0.1s;
  `;
  startBtn.addEventListener('mouseenter', () => {
    startBtn.style.background = 'rgba(70,120,30,0.95)';
    startBtn.style.transform  = 'scale(1.04)';
  });
  startBtn.addEventListener('mouseleave', () => {
    startBtn.style.background = 'rgba(40,70,20,0.85)';
    startBtn.style.transform  = 'scale(1)';
  });

  startOverlay.appendChild(startBtn);

  setTimeout(() => {
    // Fade out the loading bar screen first
    loadingEl.style.transition = 'opacity 0.4s';
    loadingEl.style.opacity    = '0';
    setTimeout(() => {
      loadingEl.style.display = 'none';
      // Show the start button over the frozen scene
      document.body.appendChild(startOverlay);
    }, 400);
  }, 200);

// Start button click — remove overlay, show HUD, begin loop
  startBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    gameStarted = true;

    // ── Kick off the high-overview → gameplay camera flythrough ───────────
    const _introTPos = tank.rigidBody ? tank.rigidBody.translation() : { x: 0, y: 10, z: 0 };
    startIntroCamera(_introTPos);
    startOverlay.style.transition = 'opacity 0.3s';
    startOverlay.style.opacity    = '0';
    audio._muted = false;
    audio._resume?.();
    setTimeout(() => {
      startOverlay.remove();
      hudEl2.style.display = 'block';
      // ── Reveal all HUD elements on game start ──
      document.getElementById('hud-fps-wrap').style.display = 'block';
      document.getElementById('compass-bar').style.display  = 'block';
      document.getElementById('minimap').style.display      = 'block';
      document.getElementById('hud-speed').style.display    = 'block';
      document.getElementById('weapon-hud').style.display   = 'flex';
document.getElementById('hud-kills').style.display    = 'block';
      scoreHud.style.display   = 'flex';
      captureHud.style.display = 'none'; // shown only when near a point
      document.getElementById('pause-btn').style.display     = 'flex';
    }, 300);
    loop();
  });

  // ── Pause menu wiring ─────────────────────────────────────────────────────
  const pauseBtn       = document.getElementById('pause-btn');
  const pauseOverlay   = document.getElementById('pause-overlay');
  const pauseResumeBtn = document.getElementById('pause-resume-btn');
  const pauseEndBtn    = document.getElementById('pause-end-btn');

  function openPause() {
    if (!gameStarted || tank.isDead || gameOver) return;
    isPaused = true;
    pauseOverlay.style.display = 'flex';
  }

  function closePause() {
    isPaused = false;
    clock.getDelta();          // discard the huge elapsed-during-pause delta
    accum = 0;                 // drop any leftover physics accumulator backlog
    pauseOverlay.style.display = 'none';
  }

  pauseBtn.addEventListener('click', () => {
    if (isPaused) closePause(); else openPause();
  });
  pauseResumeBtn.addEventListener('click', closePause);

  pauseEndBtn.addEventListener('click', () => {
    closePause();
    pauseBtn.style.display = 'none';
    returnToMenu();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && gameStarted && !tank.isDead) {
      isPaused ? closePause() : openPause();
    }
  });
}

// ─── Bumpers ──────────────────────────────────────────────────────────────────

function buildBumpers(scene, world, RAPIER) {
  const bumperMat = new THREE.MeshStandardMaterial({ color: 0x8b6914, roughness: 0.8, metalness: 0.1 });

  const configs = [
    { type: 'cylinder', x:  0,  z: 0,    r: 0.22, h: 3 },
    { type: 'cylinder', x: -1,  z: 0,    r: 0.22, h: 3 },
    { type: 'cylinder', x:  1,  z: 0,    r: 0.22, h: 3 },
    { type: 'cylinder', x:  9,  z: -1.5, r: 0.22, h: 3 },
    { type: 'cylinder', x: 12,  z:  0.5, r: 0.22, h: 3 },
    { type: 'cylinder', x: 15,  z: -1.5, r: 0.22, h: 3 },
    { type: 'cylinder', x: -10, z: 0,    r: 0.22, h: 3 },
  ];

  configs.forEach((c) => {
    if (c.type === 'cylinder') {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(c.r, c.r, c.h, 32), bumperMat);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(c.x, 0, c.z);
      mesh.castShadow    = true;
      mesh.receiveShadow = true;
      scene.add(mesh);

      [-c.h / 2, c.h / 2].forEach((offset) => {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(c.r, 0.02, 8, 48),
          new THREE.MeshStandardMaterial({ color: 0xf0c040, roughness: 0.5 })
        );
        ring.position.set(c.x, 0, c.z + offset);
        scene.add(ring);
      });

      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(c.x, 0, c.z));
      const q = new RAPIER.Quaternion(Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4));
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(c.h / 2, c.r).setRotation(q).setFriction(0.5),
        body
      );
    }
  });
}