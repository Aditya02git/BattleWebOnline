// main.js — Scene setup, physics world, camera, game loop

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  keys,
  onShiftPress,
  onMiddleClick,
  onFire,
  isMouseHeld,
  setInputSuppressed,
  setPointerFrozen,
  setPointerLockElement,
  requestGameplayPointerLock,
  exitGameplayPointerLock,
  isPointerLocked,
  centerVirtualCursor,
  getMouseFlightOffset,
} from "./input.js";
import { Tank } from "./tank.js";
import { Plane } from "./plane.js";
import { RapierDebugRenderer } from "./rapierDebugRenderer.js";
import { OrbitControls } from "three/examples/jsm/Addons.js";
import Stats from "three/addons/libs/stats.module.js";
import {
  generateProceduralHeightmap,
  loadHeightmap,
} from "./utils/heightmap.js";
import { TerrainBuilder } from "./utils/terrain.js";
import { EnemyTankPool, resetEnemyModelCache } from "./enemyTank.js";
import { EnemyTrackSystem } from "./enemyTrack.js";
import { prewarmBeltShaders } from "./beltShaderPrewarm.js";
import { NavGrid } from "./utils/navGrid.js";
import { HealthBar } from "./healthBar.js";
// import { BulletTrailSystem } from './bulletTrail.js';
import { ScopeSystem } from "./scope.js";
import { AudioSystem, ENGINE_DYING_VOLUME_BOOST } from "./audioSystem.js";
import { ProjectileBulletSystem } from "./bullet.js";
import { HouseSmokeSystem } from "./explosion.js";
import { Sky } from "three/addons/objects/Sky.js";
import { getMapById, loadMapTerrain } from "./utils/mapLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { MaskLoader } from "./utils/MaskLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

import { InstancedForestManager } from "./InstancedForestManager.js";
import { sampleTreePositions } from "./utils/maskTreeSampler.js";
// import { FirTree }   from './FirTree.js';
// import { Bush }      from './Bush.js';
import { InstancedBush } from "./InstancedBush.js";
import { GrassPool } from "./GrassPool.js";
import { Water } from "./water.js";
// import { ArtillerySystem } from './artillery.js';
import { AmmoPointSystem } from "./AmmoPoint.js";
import { TrackDecalSystem } from "./trackDecals.js";
import { FriendlyTankPool } from "./friendlyTank.js"; // ← add near top imports, alongside other imports
import { EnemyPlanePool } from "./enemyPlane.js";
import { FriendlyPlanePool } from "./friendlyPlane.js";
import { FriendlyPlaneMarkerSystem } from "./friendlyPlaneMarkers.js";
import { FriendlyTankMarkerSystem } from "./friendlyTankMarkers.js";
import { InstancedFlagSystem } from "./flag.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import { PropSystem } from "./prop.js";
import { CarSystem } from "./car.js";
import { playerProfile, RANKS } from "./playerProfile.js";
import { OptimizedLensFlare } from "./lensFlare.js";
import { KILL_ICON } from "./icons.js";

import { RemotePlayerTank } from "./remotePlayerTank.js";
import { RemotePlayerPlane } from "./remotePlayerPlane.js";
import { io as ioClient } from "socket.io-client";

import { EnemyTank, _buildTrackCfgFromDef } from "./enemyTank.js";
// ─── Init ─────────────────────────────────────────────────────────────────────

export async function init(config = {}) {
  window._lastTankConfig = config;
  resetEnemyModelCache();

  // ── Reset the loading overlay's visual state ───────────────────────────
  // The fade-out at the end of the PREVIOUS match (see the "Fade out the
  // loading bar screen" block near the bottom of this function) leaves a
  // permanent inline opacity:0 on #loading, plus loading-bar stuck at
  // '100%' width and loading-status stuck at 'Ready.' — none of that is
  // ever reset elsewhere. index.html's start-btn handler only flips
  // #loading's display back to 'flex', so on every match after the first,
  // the whole loading screen (including "Initialising" and the status
  // text) renders fully transparent/stale until it fades itself out again
  // at the end of THIS match. Reset everything here, before any of the
  // heavy async loading below even starts.
  const _loadingElReset = document.getElementById("loading");
  if (_loadingElReset) {
    _loadingElReset.style.transition = "none";
    _loadingElReset.style.opacity = "1";
  }
  const _loadingBarReset = document.getElementById("loading-bar");
  if (_loadingBarReset) _loadingBarReset.style.width = "0%";
  const _loadingStatusReset = document.getElementById("loading-status");
  if (_loadingStatusReset) _loadingStatusReset.textContent = "Loading physics…";

  await RAPIER.init({});

  // ── Load the selected plane's own preset (fireSound, gunType, etc.) —
  // config.planeId is just the id string; the full preset with its own
  // fireSound lives in planes.json, same file the configurator reads. ────
  let _planePreset = null;
  let _allPlaneDefs = []; // ← full roster, used so AI pools aren't all locked to one plane
  try {
    const _planesRes = await fetch("/planes.json");
    if (_planesRes.ok) {
      const _planesData = await _planesRes.json();
      _allPlaneDefs = _planesData;
      _planePreset =
        _planesData.find((p) => p.id === config.planeId) ??
        _planesData[0] ??
        null;
    }
  } catch (err) {
    console.warn(
      "[Plane] Failed to load planes.json for fireSound/config lookup:",
      err,
    );
  }

  // Picks a random plane definition from the full roster — used to give
  // each EnemyPlanePool its own varied selection instead of every AI plane
  // pool defaulting to the same single _planePreset (which is only ever
  // meant to describe the LOCAL PLAYER's own selected plane).
  function _randomPlaneDef() {
    if (!_allPlaneDefs.length) return _planePreset;
    return _allPlaneDefs[Math.floor(Math.random() * _allPlaneDefs.length)];
  }

  // ── Research skills — index.html already applies these to tankConfig
  // (config), but Plane.create()'s own `...config, ..._pc` spread lets
  // the plane preset's config win over those skill-boosted values (see
  // the Plane.create() call below). Re-apply them here, AFTER the preset
  // spread, using the preset's own field as the base, so plane skills
  // actually take effect instead of being silently overwritten.
  let _researchSkillsData = [];
  try {
    const _rsRes = await fetch("/research_skills.json");
    if (_rsRes.ok) _researchSkillsData = await _rsRes.json();
  } catch (err) {
    console.warn(
      "[Research] Failed to load research_skills.json in main.js:",
      err,
    );
  }

  function _applySkillEffectTo(cfg, skill) {
    const eff = skill?.effect;
    if (!eff) return;
    const base = cfg[eff.key] ?? eff.default ?? 0;
    let result = base;
    if (eff.type === "multiply") result = base * eff.value;
    else if (eff.type === "add") result = base + eff.value;
    else if (eff.type === "set") result = eff.value;
    cfg[eff.key] = eff.round ? Math.round(result) : result;
  }

  const _selectedPlaneSkillIds = config.selectedPlaneSkills ?? [];
  function _applySelectedSkillsTo(cfg) {
    for (const id of _selectedPlaneSkillIds) {
      const skill = _researchSkillsData.find((s) => s.id === id);
      if (skill) _applySkillEffectTo(cfg, skill);
    }
  }

  // ── Multiplayer squad identity/sizing — computed early since it affects
  // how many AI friendlies get constructed below. Only the host actually
  // runs enemy/friendly AI simulation; everyone else renders proxies of the
  // host's units (see the MULTIPLAYER section further down), and the total
  // squad (real players + AI) is kept at a fixed size regardless of how
  // many real players are in the lobby. ──────────────────────────────────
  const isSquadMultiplayer =
    config.gameMode === "multiplayer" &&
    !!config.lobbyId &&
    Array.isArray(config.lobbyMembers);
  const isHost = isSquadMultiplayer ? !!config.isHost : true;

  // ── Local player's team — 1 or 2, from the lobby roster. Solo play (no
  // lobby) is always team 1 fighting an all-AI team 2, same as before.
  const _localMember = isSquadMultiplayer
    ? config.lobbyMembers.find((m) => m.userId === config.userId)
    : null;
  const localTeam = _localMember?.team ?? 1;

  // ── Per-team real player counts — each team independently fills up to
  // TEAM_SQUAD_SIZE (6) with AI. A team with 6 real players gets 0 AI; a
  // team with 1 real player gets 5 AI, etc.
  const TEAM_SQUAD_SIZE = 6; // real players + AI, per team (unchanged)
  const TEAM_TANK_TARGET = 4; // fixed final composition, every team, always
  const TEAM_PLANE_TARGET = 2; // fixed final composition, every team, always

  const _team1RealCount = isSquadMultiplayer
    ? config.lobbyMembers.filter((m) => (m.team ?? 1) === 1).length
    : 1;
  const _team2RealCount = isSquadMultiplayer
    ? config.lobbyMembers.filter((m) => (m.team ?? 1) === 2).length
    : 0;

  const isTrainingMode = config.gameMode === "training";
  const aiPlayersEnabled = isTrainingMode ? false : (config.aiPlayersEnabled ?? true);
  console.log(
    "[AI DEBUG] config.aiPlayersEnabled =",
    config.aiPlayersEnabled,
    "isTrainingMode =",
    isTrainingMode,
    "→ resolved:",
    aiPlayersEnabled,
  );

  // ══════════════════════════════════════════════════════════════════
  // NEW composition model. Every team always ends at exactly
  // TEAM_TANK_TARGET tanks + TEAM_PLANE_TARGET planes, real players
  // included. AI fills whatever real players on that team are NOT
  // currently occupying — recomputed live (not just once at first
  // deploy), so it reacts correctly to deaths/respawns/vehicle swaps.
  //
  // _realPlayerVehicleChoice: team -> Map(userId -> 'tank' | 'plane')
  // A real player who currently has no live, deployed vehicle (dead,
  // mid-spawn-select, or hasn't deployed yet this match) has NO entry
  // here — they don't occupy a type until they actually deploy into
  // one, which is what frees their reserved slot for AI or for
  // themselves to reselect during that window.
  const _realPlayerVehicleChoice = new Map([
    [1, new Map()],
    [2, new Map()],
  ]);

  // ══════════════════════════════════════════════════════════════════
  // AI composition model.
  //
  // Each team has a fixed "must" floor per type — the AI count that's
  // ALWAYS guaranteed regardless of what real players choose:
  //   tank_must  = max(0, TEAM_TANK_TARGET  - realCountOnTeam)
  //   plane_must = max(0, TEAM_PLANE_TARGET - realCountOnTeam)
  // (i.e. "how many of the target would still need to be AI even if
  // EVERY real player on this team took that type"). This is what
  // guarantees, e.g., 3 AI tanks + 1 AI plane exist from the moment the
  // match starts, before any real player has picked anything — not 4/2
  // (too many AI) and not 3/2 (assumes a type nobody's chosen yet).
  //
  // On top of the must-floor, AI fills exactly the OPPOSITE type for
  // every real player who has ACTUALLY DEPLOYED and committed to a
  // type — never for a real player who hasn't deployed yet. This is
  // the "swing" slot, and it's why a not-yet-deployed real player
  // doesn't cause AI to eagerly fill both the tank AND plane target
  // ahead of time.
  //
  // _realPlayerVehicleChoice: team -> Map(userId -> 'tank' | 'plane')
  // Only ever contains DECIDED (actually deployed) real players. A
  // real player with no entry here simply hasn't deployed yet this
  // life — dying does NOT remove their entry, so their last-deployed
  // type keeps reserving that slot for them (see confirmSpawnSelection
  // for where entries are written).
  function _computeTeamAiTargets(team) {
    if (!aiPlayersEnabled) return { tankBaseline: 0, planeBaseline: 0 };

    const realCount = team === 1 ? _team1RealCount : _team2RealCount;
    const tankMust = Math.max(0, TEAM_TANK_TARGET - realCount);
    const planeMust = Math.max(0, TEAM_PLANE_TARGET - realCount);

    const choices = _realPlayerVehicleChoice.get(team) ?? new Map();
    let decidedTank = 0,
      decidedPlane = 0;
    for (const v of choices.values()) {
      if (v === "plane") decidedPlane++;
      else if (v === "tank") decidedTank++;
    }

    return {
      tankBaseline: Math.min(TEAM_TANK_TARGET, tankMust + decidedPlane),
      planeBaseline: Math.min(TEAM_PLANE_TARGET, planeMust + decidedTank),
    };
  }

  let _team1AiBaseline = _computeTeamAiTargets(1);
  let _team2AiBaseline = _computeTeamAiTargets(2);

  // ── Backward-compat function-style aliases — anything downstream
  // that used to read the old frozen _aiTankBaseline/_aiPlaneBaseline
  // constants now calls these instead, so it always sees the CURRENT
  // value for the local player's own team rather than a stale snapshot
  // taken once at init.
  function _aiTankBaseline_() {
    return (localTeam === 1 ? _team1AiBaseline : _team2AiBaseline).tankBaseline;
  }
  function _aiPlaneBaseline_() {
    return (localTeam === 1 ? _team1AiBaseline : _team2AiBaseline)
      .planeBaseline;
  }

  let gameOver = false;
  let gameStarted = false;
  let isPaused = false;
  // Distinct from gameStarted (which just means "has deployed at least
  // once and never resets"). This tracks whether the player currently has
  // a live, actually-deployed vehicle right now — false while dead or
  // sitting on the spawn-selection screen deciding, true only after a
  // deploy has actually completed. Used so the network payload's
  // `deployed` flag reflects reality instead of being permanently true
  // from the first deploy onward.
  let _isCurrentlyDeployed = false;
  let _spawnSelectionActive = false; // true while the pre-deploy spawn-picker is up

  // ── Player-configurable display settings — config.settings comes from
  // playerProfile.getSettings() (see index.html's start-btn handler),
  // falling back to the same defaults used everywhere else if absent
  // (e.g. an older cached config object without a `settings` field).
  const _settings = config.settings ?? {};
  let enableShadow = _settings.enableShadow ?? true; // ← toggle this to enable/disable tank shadows
  let shadowRes = _settings.shadowRes ?? 1024;
  let enableHouseShadow = true;
  let enablePostprocessing = false; // ← toggle bloom postprocessing on/off
  let enableLensFlare = _settings.enableLensFlare ?? true; // ← toggle this to enable/disable the lens flare entirely

  let enableTurretSound = _settings.enableTurretSound ?? false; // ← toggle this to enable/disable tank shadows
  const TANKS_ENGAGE_AI_PLANES = false; // ← toggle: true = tanks fight AI-controlled planes too, false = tanks only fight real players' planes
  let _lastMgAmmo = -1;
  let _lastSpeedStr = "";
  let _lastGearLabel = ""; // dedup key for the gear/throttle HUD box
  let _lastMultiGunRounds = "";
  let _wasMultiGunReloading = false; // ← edge-detects _reloading flipping true, to fire the reload sound once
  let _wasPlaneMultiGunReloading = false; // ← same edge-detector, for the plane's gunType-3 slot 1
  let _wasHispanoReloading = false; // ← same edge-detector, for the plane's Hispano cannon (slot 6)
  let _lastPlaneMultiGunRounds = ""; // ← HUD dedup key, mirrors _lastMultiGunRounds for the plane
  let _lastMg2Key = "";
  let _lastAiGunKey = ""; // ← HUD dedup key for the AI turret gun ammo/reload slot

  // ── UI focus guard — true when a button/overlay is being interacted with ──
  let _uiClickActive = false;
  const _uiElements = [
    "pause-btn",
    "pause-overlay",
    "pause-resume-btn",
    "pause-end-btn",
    "death-screen",
    "death-menu-btn",
    "configurator",
    "stats-panel",
  ];
  document.addEventListener(
    "mousedown",
    (e) => {
      _uiClickActive = _uiElements.some((id) => {
        const el = document.getElementById(id);
        return el && (el === e.target || el.contains(e.target));
      });
      if (_uiClickActive && audio.isMGPlaying) audio.stopMG();
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    () => {
      if (_uiClickActive) {
        _uiClickActive = false;
        if (audio.isMGPlaying) audio.stopMG();
      }
    },
    true,
  );

  // ── Load map definition + its terrain data module ─────────────────────────
  const mapDef = await getMapById(config.mapId ?? null);
  const terrainData = await loadMapTerrain(mapDef);

  const terrainBuilder = new TerrainBuilder({
    heights: terrainData.heights,
    size: terrainData.size,
    worldSize: terrainData.worldSize,
    heightScale: terrainData.heightScale,
    heightOffset: terrainData.heightOffset ?? 0,
  });

  // ── Renderer ──────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = enableShadow;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = mapDef.sky?.toneMappingExposure ?? 1.1;
  renderer.setClearColor(
    mapDef.sky?.clearColor ? parseInt(mapDef.sky.clearColor, 16) : 0x87ceeb,
  );
  document.body.appendChild(renderer.domElement);
  setPointerLockElement(renderer.domElement);

  // ── Death grayscale — fades the whole scene to black-and-white on death,
  // fades back to color on respawn/redeploy. Pure CSS filter on the canvas
  // itself, so it works identically whether or not postprocessing/bloom is
  // enabled (composer.render() still draws into this same canvas).
  renderer.domElement.style.transition = "filter 1.2s ease";
  renderer.domElement.style.filter = "grayscale(0%) blur(0px) brightness(1)";

  function setDeathGrayscale(active) {
    renderer.domElement.style.filter = active
      ? "grayscale(100%) blur(6px) brightness(0.7)"
      : "grayscale(0%) blur(0px) brightness(1)";
  }

  // ── Pre-compile all belt shader variants once, up front, so the first
  // enemy tank entering NEAR-LOD with a given beltType doesn't pay a
  // mid-gameplay shader-compile stall ────────────────────────────────────
  await prewarmBeltShaders(renderer);

  // ── Stats panel (FPS/MS/MB) ─────────────────────────────────────────────
  const stats = new Stats();
  stats.dom.id = "stats-panel";
  stats.dom.style.cssText +=
    "top:auto; left:0px; top:0px; z-index:200; display:none;";
  document.body.appendChild(stats.dom);

  // ── Block clicks on the FPS/MS/MB stats panel from reaching the game's
  // fire input. Only mousedown is intercepted — that's what actually
  // triggers onFire()/isMouseHeld in input.js. We deliberately do NOT
  // touch 'click' here, since Stats.js's own built-in panel-cycling
  // listener (FPS → MS → MB) is also a 'click' listener on this same
  // element — stopping that would break the panel from being cycled.
  stats.dom.addEventListener("mousedown", (e) => e.stopPropagation(), true);

  // ── Scene ─────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  const _fogDef = mapDef.fog ?? {};
  scene.fog = new THREE.FogExp2(
    _fogDef.color ? parseInt(_fogDef.color, 16) : 0xb0c8e8,
    _fogDef.density ?? 0.0025,
  );

  const _baseFogDensity = scene.fog.density; // ← remembered so we can restore it outside the cloud band
  const _baseFogColor = scene.fog.color.clone(); // ← remembered original fog color, so the high-altitude white-out can fade back to it
  const _WHITE_FOG_COLOR = new THREE.Color(0xffffff); // ← target fog color once fully inside the high-altitude sky band
  const _fogColorScratch = new THREE.Color(); // reused every frame — no per-frame allocation

  // ── Camera ────────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    5000,
  );

  camera.layers.enable(1);

  // ── Post-processing (minimal cost) ─────────────────────────────────────
  // Only bloom is used, and only bright pixels trigger it (threshold 0.9),
  // rendered at 1/4 resolution — this keeps the per-frame cost negligible
  // (~0.1-0.3ms on most GPUs) vs a full-res multi-pass pipeline.
  // ── Post-processing (minimal cost, toggleable) ───────────────────────────
  let composer = null;
  let bloomPass = null;
  let lensFlare = null;
  const lensFlareOpacityRef = { value: 0.45 }; // tune brightness here; passed by reference — lower = dimmer flare

  function buildComposer() {
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    composer.setSize(window.innerWidth, window.innerHeight);

    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth / 4, window.innerHeight / 4),
      0.03, // strength
      0.4, // radius
      0.3, // threshold
    );
    composer.addPass(bloomPass);

    composer.addPass(new OutputPass());
  }

  function disposeComposer() {
    if (!composer) return;
    composer.passes.forEach((p) => p.dispose?.());
    composer.dispose?.();
    composer = null;
    bloomPass = null;
  }

  if (enablePostprocessing) buildComposer();

  // Call this if you flip enablePostprocessing at runtime after init
  function setPostprocessing(on) {
    enablePostprocessing = on;
    if (on && !composer) buildComposer();
    if (!on && composer) disposeComposer();
  }

  function renderFrame() {
    if (enableLensFlare) {
      // ── Force the camera's world matrix current BEFORE projecting the
      // flare position. Without this, lensFlare.update()'s project(camera)
      // call uses matrixWorld from the PREVIOUS frame (only refreshed
      // inside renderer.render(), which runs after this), causing a
      // one-frame lag between the flare's screen position and the sun
      // mesh's actual rendered position. Invisible at normal FOV, but
      // hugely magnified at scope zoom (15-20° FOV), where the same
      // lag reads as a large on-screen offset. ──────────────────────────
      camera.updateMatrixWorld(true);
      lensFlare?.update(camera);
    }
    if (enablePostprocessing && composer) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }

  let camYaw = Math.PI / 2;
  let camPitch = 0.1;
  let camDist = 5;
  const MIN_PITCH = 0.1;
  const MAX_PITCH = 0.3;
  const MIN_DIST = 4.5;
  const MAX_DIST = 6;

  // ── Plane chase-camera zoom — same idea as the tank's camDist/MIN_DIST/
  // MAX_DIST, but separate so zooming one vehicle doesn't affect the other.
  let planeCamDist = 8.5; // starting distance — matches plane.cfg default
  const PLANE_MIN_DIST = 8.0;
  const PLANE_MAX_DIST = 10;

  // ── Camera collision — pulls the camera in along its look-ray when
  // terrain/houses/walls block the desired orbit distance ────────────────
  const CAM_COLLISION_RADIUS = 0.35; // small buffer so camera doesn't clip into geometry
  const CAM_COLLISION_LERP = 18; // pull-in/release smoothing speed
  let _camCollisionDist = camDist; // current collision-adjusted distance (smoothed)

  const _camRayOrigin = new THREE.Vector3();
  const _camRayDir = new THREE.Vector3();
  let _camRapierRay = null; // lazily built once RAPIER is available in this closure

  /**
   * Casts a ray from lookTarget toward desiredCamPos (using the world Rapier
   * instance) and returns the max safe distance the camera can sit at along
   * that direction without clipping through terrain/houses/walls.
   * Falls back to the full desired distance if nothing is hit.
   */
  function _getCameraCollisionDistance(lookTarget, desiredCamPos, fullDist) {
    if (!world || !RAPIER || _physicsBroken) return fullDist;

    _camRayDir.subVectors(desiredCamPos, lookTarget);
    const rayLen = _camRayDir.length();
    if (rayLen < 0.0001) return fullDist;
    _camRayDir.multiplyScalar(1 / rayLen); // normalize

    _camRayOrigin.copy(lookTarget);

    if (!_camRapierRay) {
      _camRapierRay = new RAPIER.Ray(
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
      );
    }
    _camRapierRay.origin.x = _camRayOrigin.x;
    _camRapierRay.origin.y = _camRayOrigin.y;
    _camRapierRay.origin.z = _camRayOrigin.z;
    _camRapierRay.dir.x = _camRayDir.x;
    _camRapierRay.dir.y = _camRayDir.y;
    _camRapierRay.dir.z = _camRayDir.z;

    // Exclude the player tank's own rigid body so the camera ray doesn't
    // immediately self-collide with the tank it's orbiting around.
    const hit = world.castRay(
      _camRapierRay,
      fullDist,
      true, // solid — stop at first surface, not just centroid
      undefined,
      undefined,
      undefined,
      tank.rigidBody ?? undefined,
    );

    if (!hit) return fullDist;

    // Pull the camera in slightly so it doesn't sit exactly on the surface
    return Math.max(MIN_DIST * 0.3, hit.timeOfImpact - CAM_COLLISION_RADIUS);
  }

    // ── Camera-vs-terrain hard clamp — _getCameraCollisionDistance() above
  // only pulls the camera in when something sits directly between the
  // vehicle and the desired camera spot. It does nothing if the desired
  // spot itself is simply below the ground (orbiting over a ridge, a
  // steep downhill slope, or the plane crashing into terrain). This
  // clamps the camera's final Y to stay above the terrain surface
  // directly under it, regardless of how it got there.
  const CAM_TERRAIN_MARGIN = 1.2; // world units of clearance above the ground
  const CAM_WATER_MARGIN = 0.8; // world units of clearance above the water surface

  function _clampCameraAboveTerrain(margin = CAM_TERRAIN_MARGIN) {
    const groundY = terrainBuilder.getHeightAtWorld(
      camera.position.x,
      camera.position.z,
    );
    let minY = groundY + margin;

    // ── Never let the camera dip below the water surface either — only
    // relevant on maps that actually have water enabled. Uses whichever
    // is higher: terrain-based minY or water-based minY, so on dry land
    // above the waterline this has no effect at all.
    if (showWater) {
      const waterY = _waterDef.y ?? terrainData.waterLevel ?? 8.4;
      const waterMinY = waterY + CAM_WATER_MARGIN;
      if (waterMinY > minY) minY = waterMinY;
    }

    if (camera.position.y < minY) {
      camera.position.y = minY;
    }
  }

  // ── Edge-orbit: when cursor is pinned at screen edge in free-aim mode,
  // rotate the camera to keep feeding the turret fresh aim direction ───────
  const EDGE_ORBIT_SENSITIVITY = 0.005; // matches drag-orbit's camYaw -= dx * 0.005
  const EDGE_ORBIT_PX_PER_SEC = 900; // equivalent "drag speed" while pinned at edge

  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  renderer.domElement.addEventListener("mousedown", (e) => {
    if (_spawnSelectionActive) return;
    if (e.button !== 2) return;
    if (e.button === 2 && scope.isScoped) return;
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });
  renderer.domElement.addEventListener("mouseup", () => {
    isDragging = false;
    cancelRepair();
    cancelPlaneRepair();
  });
  renderer.domElement.addEventListener("mouseleave", () => {
    isDragging = false;
    cancelRepair();
    cancelPlaneRepair();
  });
  renderer.domElement.addEventListener("mousemove", (e) => {
    if (_spawnSelectionActive) return;
    if (!isDragging) return;

    // ── Pointer Lock freezes e.clientX/Y at the lock point, so the old
    // "current minus last absolute position" delta is always 0 while
    // locked — that's why right-click-drag orbit stopped responding.
    // e.movementX/Y keep reporting real relative motion under lock (the
    // browser never traps those, only the absolute position), so use
    // them directly instead of diffing clientX/Y in that case. ──────────
    let dx, dy;
    if (isPointerLocked()) {
      dx = e.movementX;
      dy = e.movementY;
    } else {
      dx = e.clientX - lastMouseX;
      dy = e.clientY - lastMouseY;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    }

    camYaw -= dx * 0.005;
    camPitch -= dy * 0.005;
    camPitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, camPitch));
  });
  renderer.domElement.addEventListener("wheel", (e) => {
    if (_spawnSelectionActive) return;
    if (scope.isScoped) return;

    if (vehicleType === "plane") {
      planeCamDist += e.deltaY * 0.02;
      planeCamDist = Math.max(
        PLANE_MIN_DIST,
        Math.min(PLANE_MAX_DIST, planeCamDist),
      );
      return;
    }

    camDist += e.deltaY * 0.02;
    camDist = Math.max(MIN_DIST, Math.min(MAX_DIST, camDist));
  });

  renderer.domElement.addEventListener("contextmenu", (e) =>
    e.preventDefault(),
  );

  // ── Lights ────────────────────────────────────────────────────────────────
  const _al = mapDef.lighting?.ambient ?? {};
  const ambientLight = new THREE.AmbientLight(
    _al.color ? parseInt(_al.color, 16) : 0xc8d8f0,
    _al.intensity ?? 1.5,
  );
  scene.add(ambientLight);

  // const light = new THREE.SpotLight(0xffffff, 2);
  // light.position.set(30, 30, 20);
  // light.castShadow = false;
  // light.penumbra = 1;
  // light.angle = Math.PI / 3;
  // scene.add(light);

  const LIGHT2_OFFSET = new THREE.Vector3(0, 25, 80);

  const _dl = mapDef.lighting?.directional ?? {};
  const _dlp = _dl.position ?? { x: 0, y: 10, z: 20 };
  const light2 = new THREE.DirectionalLight(
    _dl.color ? parseInt(_dl.color, 16) : 0xe8bd99,
    _dl.intensity ?? 15,
  );
  light2.position.set(_dlp.x ?? 0, _dlp.y ?? 10, _dlp.z ?? 20);

  // ── Shadows ──────────────────────────────────────────────────────────────
  light2.castShadow = true;
  light2.shadow.mapSize.set(shadowRes, shadowRes);
  light2.shadow.camera.near = 1;
  light2.shadow.camera.far = 200;
  light2.shadow.camera.left = -40;
  light2.shadow.camera.right = 40;
  light2.shadow.camera.top = 40;
  light2.shadow.camera.bottom = -40;
  light2.shadow.bias = -0.0015;
  light2.shadow.normalBias = 0.02;

  scene.add(light2);
  scene.add(light2.target);

  // ── Sun sphere — small low-poly mesh marking where the directional
  // "sun" light actually is. Without this there's no visible geometry at
  // light2's position, just an invisible DirectionalLight. Position is
  // kept in sync with light2.position every frame (see the three
  // `sunSphereMesh.position.copy(light2.position)` calls added below,
  // right after each light2.position.set(...) call).
  const SUN_SPHERE_RADIUS = 2.5;
  const sunSphereGeo = new THREE.IcosahedronGeometry(SUN_SPHERE_RADIUS, 1); // low-poly facets
  const sunSphereMat = new THREE.MeshBasicMaterial({
    color: _dl.color ? parseInt(_dl.color, 16) : 0xffe6b8,
    fog: false, // stay bright/visible even inside the fog band
    depthWrite: false, // ← don't let the sun's own (finite, ~80-unit) depth
                        //   occlude real geometry drawn after it — trees/
                        //   terrain farther than the sun's literal position
                        //   were being hidden behind it. depthTest stays on
                        //   (default true), so anything actually drawn
                        //   BEFORE the sun (sky overlay, also depthWrite:false)
                        //   still composites correctly.
  });
  const sunSphereMesh = new THREE.Mesh(sunSphereGeo, sunSphereMat);
  sunSphereMesh.castShadow = false;
  sunSphereMesh.receiveShadow = false;
  sunSphereMesh.renderOrder = -998; // draw right after the sky/void floor
  sunSphereMesh.position.copy(light2.position);
  scene.add(sunSphereMesh);

  // ── Altitude-based skybox with smooth crossfade ─────────────────────────
  const hdriLoader = new THREE.TextureLoader();

  const SKY_LOW_PATH = mapDef.sky?.panorama ?? "Panorama_Sky_22-512x512.png";

  // Altitude band the two skies blend across — below SKY_FADE_START it's
  // 100% low sky, above SKY_FADE_END it's 100% high sky, in between is a
  // smooth ease, so climbing/diving never pops.
  const SKY_FADE_START = mapDef.sky?.fadeStartAltitude ?? 245;
  const SKY_FADE_END = mapDef.sky?.fadeEndAltitude ?? 250;

  hdriLoader.load(SKY_LOW_PATH, (texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = texture; // base layer, always visible underneath the overlay sphere
  });

  // ── High-altitude overlay sphere — a big inverted sphere (BackSide),
  // shaded procedurally (no second panorama file to load/decode). Built
  // synchronously — no async texture load, so it's ready the instant the
  // map loads instead of popping in a frame or two later. Faded in/out via
  // uOpacity as the player climbs, same as before.
  let skyOverlayMesh = null;
  if (mapDef.sky?.enableHighAltitudeSky !== false) {
    const HIGH_SKY_ZENITH_COLOR = new THREE.Color(
      mapDef.sky?.highZenithColor
        ? parseInt(mapDef.sky.highZenithColor, 16)
        : 0x4a90d9,
    );
    // ── Horizon color now comes directly from the scene's fog color, so
    // the high-altitude sky sphere blends seamlessly into the horizon fog
    // instead of showing a visible seam at the blend boundary. Falls back
    // to the old default only if scene.fog somehow isn't set yet.
    const HIGH_SKY_HORIZON_COLOR = scene.fog
      ? scene.fog.color.clone()
      : new THREE.Color(
          mapDef.sky?.highHorizonColor
            ? parseInt(mapDef.sky.highHorizonColor, 16)
            : 0x8fb8e8,
        );

    const geo = new THREE.SphereGeometry(2500, 48, 32);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uZenithColor: { value: HIGH_SKY_ZENITH_COLOR },
        uHorizonColor: { value: HIGH_SKY_HORIZON_COLOR },
        uOpacity: { value: 0 },
      },
      vertexShader: `
      varying vec3 vDir;
      void main() {
        // Local (unrotated) vertex position IS the direction from sphere
        // center — the same information an equirect UV lookup would give
        // us, just used directly instead of sampling a texture.
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
      fragmentShader: `
      varying vec3 vDir;
      uniform vec3  uZenithColor;
      uniform vec3  uHorizonColor;
      uniform float uOpacity;
      void main() {
        // vDir.y: -1 straight down .. +1 straight up.
        // Blend band narrowed to sit close to the horizon (0.0 → 0.22)
        // instead of extending up to 0.6 — keeps the zenith blue dominant
        // over most of the sky, with the fog-matched horizon color only
        // taking over in a thin band right at eye level, where it needs
        // to seamlessly meet the ground fog.
        float t = smoothstep(-0.02, 0.05, vDir.y);
        vec3 col = mix(uHorizonColor, uZenithColor, t);
        gl_FragColor = vec4(col, uOpacity);
      }
    `,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false, // terrain/tanks still occlude it normally via depth test
    });

    skyOverlayMesh = new THREE.Mesh(geo, mat);
    skyOverlayMesh.frustumCulled = false; // re-centered on camera every frame — never culled
    skyOverlayMesh.renderOrder = -1000; // draw as early as possible, like a background
    scene.add(skyOverlayMesh);
  }

  function _smoothstep01(edge0, edge1, x) {
    if (edge0 === edge1) return x < edge0 ? 0 : 1;
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  // Call once per frame with the active vehicle's current world Y.
  function updateSkyboxForAltitude(y) {
    if (!skyOverlayMesh) return; // no high-altitude sky configured for this map

    skyOverlayMesh.position.copy(camera.position); // always centered on the viewer, like a real skybox

    // ── Same altitude-based fade factor that drives the high-altitude sky
    // sphere's own opacity — 0 at/under SKY_FADE_START, 1 at/over SKY_FADE_END.
    const targetOpacity =
      y == null ? 0 : _smoothstep01(SKY_FADE_START, SKY_FADE_END, y);

    // ── Blend the scene's fog color toward pure white as the high-altitude
    // sky fades in, fading back to the map's original fog color as the
    // plane descends back out of the band.
    if (scene.fog) {
      _fogColorScratch
        .copy(_baseFogColor)
        .lerp(_WHITE_FOG_COLOR, targetOpacity);
      scene.fog.color.copy(_fogColorScratch);

      // ── Keep the sphere's horizon color locked to the CURRENT (now
      // altitude-blended) scene fog color every frame — guarantees a
      // seamless blend even though fog.color itself is being animated here.
      skyOverlayMesh.material.uniforms.uHorizonColor.value.copy(
        scene.fog.color,
      );
    }

    if (y == null) return;
    skyOverlayMesh.material.uniforms.uOpacity.value = targetOpacity;
    skyOverlayMesh.visible = targetOpacity > 0.001; // skip rendering when fully transparent
  }

  const scope = new ScopeSystem(renderer, camera, {
    holdScope: false,
    scopeType: config.scopeType ?? 1,
    scopeHudStyle: config.scopeHudStyle ?? "old",
    texturePath: `/textures/scope_${config.scopeType ?? 1}.png`,
    gunnerTexturePath: "/textures/gunner_sight.png",
    zoomFOV: 70,
    planeZoomFOV: 45,
    gunnerZoomFOV: 90,
    bombZoomFOV: 70, // ← add — bomb-sight zoom level while flying, tune to taste
    normalFOV: 55,
    planeNormalFOV: 90,
    barrelMinAngle: -0.25,
    barrelMaxAngle: 0.25,
  });

  scope.onScopeEnter = () => tank.turretController?.setScopeLocked(true);
  scope.onScopeExit = () => tank.turretController?.setScopeLocked(false);

  // ── Compass bar ───────────────────────────────────────────────────────────
  const compassStrip = document.getElementById("compass-strip-wrap");

  const COMPASS_WIDTH = 400;
  const COMPASS_FOV_DEG = 120;
  const PPD = 4;
  const STRIP_W = 1440;

  const _compassCamDir = new THREE.Vector3();
  const _compassSph = new THREE.Spherical();

  // ── Compass throttle state ─────────────────────────────────────────────
  let compassAccum = 0;
  const COMPASS_INTERVAL = 1 / 10; // 10 fps
  let lastCompassYaw = Infinity;
  const COMPASS_YAW_THRESHOLD = 0.002; // ~0.1°

  function drawCompassBar() {
    const _tankFwd = new THREE.Vector3();
    if (vehicleType === "plane" && plane) {
      plane.getForwardVector(_tankFwd);
    } else {
      tank.bodyGroup.getWorldDirection(_tankFwd);
    }
    // atan2(x, z) gives yaw where -Z forward = 0 degrees (North)
    const yawRad = Math.atan2(_tankFwd.x, _tankFwd.z);
    const yawDeg = ((yawRad * 180) / Math.PI + 180 + 360) % 360;
    const centerPx = yawDeg * PPD;
    const offsetX = -(centerPx - COMPASS_WIDTH / 2);
    const wrapped = ((offsetX % STRIP_W) + STRIP_W) % STRIP_W;
    compassStrip.style.transform = `translateX(${-wrapped}px)`;
  }
  // ── End compass bar ───────────────────────────────────────────────────────

  // ── Minimap ───────────────────────────────────────────────────────────────
  const MINIMAP_SIZE = 240;
  const WORLD_HALF = 400;

  const minimapEl = document.getElementById("minimap");
  const minimapCanvas = document.getElementById("minimap-canvas");
  const minimapCtx = minimapCanvas.getContext("2d");
  const minimapEnemyEl = document.getElementById("minimap-enemies");
  const minimapPlayer = document.getElementById("minimap-player");

  function buildMinimapBackground() {
    minimapCtx.fillStyle = "rgba(20,30,10,0.85)";
    minimapCtx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    minimapCtx.strokeStyle = "rgba(60,100,30,0.25)";
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
    minimapCtx.fillStyle = "rgba(100,160,60,0.5)";
    minimapCtx.font = "8px monospace";
    minimapCtx.textAlign = "center";
    minimapCtx.fillText("N", MINIMAP_SIZE / 2, 8);
    minimapCtx.fillText("S", MINIMAP_SIZE / 2, MINIMAP_SIZE - 2);
    minimapCtx.textAlign = "left";
    minimapCtx.fillText("W", 2, MINIMAP_SIZE / 2 + 3);
    minimapCtx.textAlign = "right";
    minimapCtx.fillText("E", MINIMAP_SIZE - 2, MINIMAP_SIZE / 2 + 3);
  }
  buildMinimapBackground();

  function worldToMinimap(wx, wz) {
    const x = ((wx + WORLD_HALF) / (WORLD_HALF * 2)) * MINIMAP_SIZE;
    const y = ((wz + WORLD_HALF) / (WORLD_HALF * 2)) * MINIMAP_SIZE;
    return { x, y };
  }

  // ── Friendly dots — same pattern as enemy dots, blue instead of red ───────
  const minimapFriendlyDots = new Map(); // ft → dot element, so we can move it later

  function addFriendlyDotToMinimap(ft, cached) {
    const { x, y } = worldToMinimap(cached.x, cached.z);
    const dot = document.createElement("div");
    dot.style.cssText = `
  position:absolute;
  width:6px; height:6px;
  border-radius:50%;
  background:rgba(68,170,255,0.9);
  left:${x}px; top:${y}px;
  transform:translate(-50%,-50%);
  pointer-events:none;
  filter:drop-shadow(0 0 3px rgba(68,170,255,1));
    `;
    dot._friendly = ft;
    minimapEnemyEl.appendChild(dot);
    minimapFriendlyDots.set(ft, dot);
  }

  function removeFriendlyDotFromMinimap(ft) {
    const dot = minimapFriendlyDots.get(ft);
    if (dot) {
      minimapEnemyEl.removeChild(dot);
      minimapFriendlyDots.delete(ft);
    }
  }

  const minimapFriendlySet = new Set();

  function updateMinimapFriendlies() {
    for (const [ft, cached] of friendlyPosCache.entries()) {
      if (!minimapFriendlySet.has(ft)) {
        minimapFriendlySet.add(ft);
        addFriendlyDotToMinimap(ft, cached);
      } else {
        // ── Move the existing dot to its current position ─────────────────
        const dot = minimapFriendlyDots.get(ft);
        if (dot) {
          const { x, y } = worldToMinimap(cached.x, cached.z);
          dot.style.left = x + "px";
          dot.style.top = y + "px";
        }
      }
    }
    for (const ft of minimapFriendlySet) {
      if (!friendlyPosCache.has(ft)) {
        removeFriendlyDotFromMinimap(ft);
        minimapFriendlySet.delete(ft);
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

    if (Math.abs(x - _lastMinimapX) < 0.5 && Math.abs(y - _lastMinimapY) < 0.5)
      return;
    _lastMinimapX = x;
    _lastMinimapY = y;

    // Get the active vehicle's forward direction — plane uses its own
    // forward getter (local -X, per modelRotY=-90°), NOT getWorldDirection()
    // (which assumes local -Z), same fix already applied to the gun reticle.
    const _tankFwd = new THREE.Vector3();
    if (vehicleType === "plane" && plane) {
      plane.getForwardVector(_tankFwd);
    } else {
      tank.bodyGroup.getWorldDirection(_tankFwd);
    }
    const yawRad = Math.atan2(_tankFwd.z, _tankFwd.x);
    const yawDeg = yawRad * (180 / Math.PI) + 180;

    minimapPlayer.style.left = x + "px";
    minimapPlayer.style.top = y + "px";
    minimapPlayer.style.transform = `translate(-50%,-50%) rotate(${yawDeg}deg)`;
  }
  // ── End minimap ───────────────────────────────────────────────────────────

  // ── Plane gun-aim reticle — projects the averaged gun-point aim
  // direction 150m out in front of the plane, then maps that world point
  // to screen space each frame. Shown only while flying. ─────────────────
  const GUN_RETICLE_DISTANCE = 150; // metres

  // ── Downward pitch correction for the plane's gun aim — the raw forward
  // vector aims a bit too high, so we tilt the aim direction down slightly
  // around the plane's local right axis before projecting the reticle point.
  const GUN_AIM_PITCH_DOWN = THREE.MathUtils.degToRad(0); // ← tune this (degrees)
  const _gunAimRightAxis = new THREE.Vector3();
  const _gunAimPitchQ = new THREE.Quaternion();

  const planeCrosshair = document.createElement("div");
  planeCrosshair.id = "plane-crosshair";
  planeCrosshair.style.cssText = `
    position:fixed; top:0; left:0;
    width:30px; height:30px;
    margin:-15px 0 0 -15px;
    pointer-events:none; z-index:150; display:none;
    will-change:transform;
  `;
  // ── Simple white circle — same reload-ring pattern as TurretController's
  // crosshair (a full-circumference dashed circle whose stroke-dashoffset
  // animates from full to 0 over the reload duration). ────────────────────
  planeCrosshair.innerHTML = `
    <div id="plane-crosshair-ring" style="transform:scale(1); transition:none;">
      <svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg">
        <circle cx="15" cy="15" r="12" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"/>
        <circle cx="15" cy="15" r="12" fill="none" stroke="white" stroke-width="1.5"
          stroke-dasharray="75.4"
          stroke-dashoffset="0"
          stroke-linecap="round"
          transform="rotate(-90 15 15)"
          id="plane-crosshair-fill"/>
      </svg>
    </div>
  `;
  document.body.appendChild(planeCrosshair);

  // ── Scoped-in plane crosshair — a plain fixed cross at screen center,
  // shown in place of the ring reticle whenever the player is scoped into
  // the plane's main gun scope. Unlike planeCrosshair, this never moves —
  // it's always dead-center — so no per-frame transform is needed.
  const planeScopedCrosshair = document.createElement("div");
  planeScopedCrosshair.id = "plane-scoped-crosshair";
  planeScopedCrosshair.style.cssText = `
    position:fixed; top:50%; left:50%;
    width:110px; height:110px;
    margin:-55px 0 0 -55px;
    pointer-events:none; z-index:150; display:none;
  `;
  planeScopedCrosshair.innerHTML = `
    <div id="plane-scoped-reticle-old" style="position:absolute; inset:0;">
      <svg width="110" height="110" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="scoped-reticle-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.2" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g filter="url(#scoped-reticle-glow)">
          <!-- Center Dot -->
          <circle cx="100" cy="100" r="1.0" fill="#D4F0A0" />
          <!-- Outer Ring with Ultra-Thin Smooth Taper at Top -->
          <path d="
            M 100 56.4
            C 121 56.4, 138 76, 138 100
            C 138 124, 121 144, 100 144
            C 79 144, 62 124, 62 100
            C 62 76, 79 56.4, 100 56.4
            Z
            M 100 55.6
            C 122.5 55.6, 139.8 76, 139.8 100
            C 139.8 125.5, 122.5 145.8, 100 145.8
            C 77.5 145.8, 60.2 125.5, 60.2 100
            C 60.2 76, 77.5 55.6, 100 55.6
            Z"
            fill="#D4F0A0" fill-rule="evenodd" />
          <!-- Left Tapered Horizontal Line -->
          <polygon points="85,99 85,101 40,100 40,100" fill="#D4F0A0" />
          <!-- Right Tapered Horizontal Line -->
          <polygon points="115,99 115,101 160,100 160,100" fill="#D4F0A0" />
          <!-- Bottom Tapered Vertical Line -->
          <polygon points="99,144 101,144 100,175 100,175" fill="#D4F0A0" />
        </g>
      </svg>
    </div>
    <div id="plane-scoped-reticle-modern" style="position:absolute; inset:0; display:none; display:flex; align-items:center; justify-content:center;">
      <svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg">
        <line x1="15" y1="4" x2="15" y2="11" stroke="#23de6c" stroke-width="1.5"/>
        <line x1="15" y1="19" x2="15" y2="26" stroke="#23de6c" stroke-width="1.5"/>
        <line x1="4" y1="15" x2="11" y2="15" stroke="#23de6c" stroke-width="1.5"/>
        <line x1="19" y1="15" x2="26" y2="15" stroke="#23de6c" stroke-width="1.5"/>
      </svg>
    </div>
  `;
  document.body.appendChild(planeScopedCrosshair);

  const _planeScopedReticleOldEl = planeScopedCrosshair.querySelector(
    "#plane-scoped-reticle-old",
  );
  const _planeScopedReticleModernEl = planeScopedCrosshair.querySelector(
    "#plane-scoped-reticle-modern",
  );

  // ── Swaps between the classic glowing reticle and the simple modern
  // cross based on the plane's currently-set scopeHudStyle ("old" | "modern") ──
  function _updateScopedCrosshairStyle() {
    const isModern = scope.scopeHudStyle === "modern";
    if (_planeScopedReticleOldEl)
      _planeScopedReticleOldEl.style.display = isModern ? "none" : "block";
    if (_planeScopedReticleModernEl)
      _planeScopedReticleModernEl.style.display = isModern ? "flex" : "none";
  }

  // ── Hit marker for the scoped crosshair — same brackets/animation as
  // planeHitMarker below, just parented to planeScopedCrosshair so it
  // shows up centered on the fixed scope cross instead of the moving
  // free-flight ring reticle.
  const planeScopedHitMarker = document.createElement("div");
  planeScopedHitMarker.id = "plane-scoped-hit-marker";
  planeScopedHitMarker.style.cssText = `
    position:absolute; top:50%; left:50%;
    width:28px; height:28px;
    margin:-14px 0 0 -14px;
    pointer-events:none;
    opacity:0;
    transform:scale(0.6);
    transition:none;
  `;
  planeScopedHitMarker.innerHTML = `
    <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
      <line x1="4" y1="4" x2="9" y2="9"
            stroke="#ffffff" stroke-width="2"/>

      <line x1="24" y1="4" x2="19" y2="9"
            stroke="#ffffff" stroke-width="2"/>

      <line x1="4" y1="24" x2="9" y2="19"
            stroke="#ffffff" stroke-width="2"/>

      <line x1="24" y1="24" x2="19" y2="19"
            stroke="#ffffff" stroke-width="2"/>
    </svg>
  `;
  planeScopedCrosshair.appendChild(planeScopedHitMarker);

  // ── Plane repair cross — standalone fixed element, pinned to screen
  // center (mirrors the tank's own repair-cross fix). It used to be
  // nested inside planeCrosshair, but planeCrosshair's position/visibility
  // is driven every frame by updatePlaneGunReticle() (which tracks the
  // moving gun-aim point, unrelated to repairing) — so the repair ring
  // either got hidden along with the reticle, or sat visually stacked on
  // top of the reticle's own always-full ring at the same spot, looking
  // like a duplicate crosshair. Standing alone here, it's shown/hidden
  // purely by startPlaneRepair()/cancelPlaneRepair()/tickPlaneRepair(),
  // independent of the gun reticle entirely.
  const planeRepairCross = document.createElement("div");
  planeRepairCross.id = "plane-repair-cross";
  planeRepairCross.style.cssText = `
    position: fixed;
    top: 50%; left: 50%;
    width: 30px; height: 30px;
    transform: translate(-50%, -50%);
    display: none;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    z-index: 151;
  `;
  planeRepairCross.innerHTML = `
    <svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg" style="position:absolute; top:0; left:0;">
      <circle cx="15" cy="15" r="12" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"/>
      <circle cx="15" cy="15" r="12" fill="none" stroke="rgb(255, 255, 255)" stroke-width="1.5"
        stroke-dasharray="75.4"
        stroke-dashoffset="75.4"
        stroke-linecap="round"
        transform="rotate(-90 15 15)"
        id="plane-repair-fill"/>
    </svg>
    <svg width="16" height="16" viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg" style="display:block; position:relative;">
      <path fill="#ffffff" d="
        M778,122
        L758,106 L748,108 L665,214 L629,217 L568,166
        L563,131 L638,29 L637,17 L615,0 L595,3
        L545,24 L501,54 L466,92 L451,121 L438,178
        L436,251 L421,294 L30,672 L16,698 L13,732
        L20,756 L34,776 L59,793 L83,799 L110,797 L139,783
        L516,377 L532,368 L550,363 L615,358 L663,349
        L694,335 L715,320 L753,278 L766,257 L779,226
        L786,190 L786,162 Z

        M559,432
        L431,560 L635,762 L658,774 L684,779 L715,775
        L735,766 L759,745 L775,715 L779,691 L778,675
        L767,643 L758,630 Z

        M84,21
        L21,86 L93,202 L162,217 L294,348
        L349,295 L217,162 L201,91 Z
      "/>
    </svg>
  `;
  document.body.appendChild(planeRepairCross);
  const planeRepairFillEl =
    planeRepairCross.querySelector("#plane-repair-fill");

  // ── Plane hit marker — cheap X-flash overlay, nested inside planeCrosshair
  // so it automatically tracks the reticle's position every frame without
  // needing its own per-frame transform update.
  const planeHitMarker = document.createElement("div");
  planeHitMarker.id = "plane-hit-marker";
  planeHitMarker.style.cssText = `
    position:absolute; top:50%; left:50%;
    width:28px; height:28px;
    margin:-14px 0 0 -14px;
    pointer-events:none;
    opacity:0;
    transform:scale(0.6);
    transition:none;
  `;
  planeHitMarker.innerHTML = `
    <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
      <line x1="4" y1="4" x2="9" y2="9"
            stroke="#ffffff" stroke-width="2"/>

      <line x1="24" y1="4" x2="19" y2="9"
            stroke="#ffffff" stroke-width="2"/>

      <line x1="4" y1="24" x2="9" y2="19"
            stroke="#ffffff" stroke-width="2"/>

      <line x1="24" y1="24" x2="19" y2="19"
            stroke="#ffffff" stroke-width="2"/>
    </svg>
  `;
  planeCrosshair.appendChild(planeHitMarker);

  let _planeHitMarkerTimer = null;

  /** Flashes the plane's hit marker — cheap opacity+scale animation, no
   * layout thrash. Safe to call rapidly (e.g. MG spraying an enemy) —
   * each call just restarts the fade from full opacity. */
  function showPlaneHitMarker() {
    if (_planeHitMarkerTimer) clearTimeout(_planeHitMarkerTimer);

    planeHitMarker.style.transition = "none";
    planeHitMarker.style.opacity = "1";
    planeHitMarker.style.transform = "scale(1.15)";

    planeScopedHitMarker.style.transition = "none";
    planeScopedHitMarker.style.opacity = "1";
    planeScopedHitMarker.style.transform = "scale(1.15)";

    // ── Outer ring punch-in — the ring itself scales to 0.7 on hit, then
    // eases back to normal size, independent of the hit-marker brackets.
    // Only exists on the free-flight ring reticle — the scoped cross has
    // no ring to punch.
    const ringEl = document.getElementById("plane-crosshair-ring");
    if (ringEl) {
      ringEl.style.transition = "none";
      ringEl.style.transform = "scale(0.7)";
    }

    // force reflow on both so the transitions below actually animate
    void planeHitMarker.getBoundingClientRect();
    void planeScopedHitMarker.getBoundingClientRect();

    planeHitMarker.style.transition =
      "opacity 0.50s ease-out, transform 0.50s ease-out";
    planeHitMarker.style.opacity = "0";
    planeHitMarker.style.transform = "scale(0.9)";

    planeScopedHitMarker.style.transition =
      "opacity 0.50s ease-out, transform 0.50s ease-out";
    planeScopedHitMarker.style.opacity = "0";
    planeScopedHitMarker.style.transform = "scale(0.9)";

    if (ringEl) {
      ringEl.style.transition = "transform 0.50s ease-out";
      ringEl.style.transform = "scale(1)";
    }

    _planeHitMarkerTimer = setTimeout(() => {
      _planeHitMarkerTimer = null;
    }, 260);
  }

  // ── Plane gun reload ring — mirrors TurretController.startReloadAnimation,
  // just targeting the plane's own crosshair element instead of the tank's.
  function startPlaneReloadAnimation(duration) {
    const arc = document.getElementById("plane-crosshair-fill");
    if (!arc) return;

    arc.style.transition = "none";
    arc.style.strokeDashoffset = "75.4";
    void arc.getBoundingClientRect(); // force reflow so the snap registers
    requestAnimationFrame(() => {
      arc.style.transition = `stroke-dashoffset ${duration}s linear`;
      arc.style.strokeDashoffset = "0";
    });
  }

  // ── Autopilot HUD badge ────────────────────────────────────────────────
  const autopilotBadge = document.createElement("div");
  autopilotBadge.id = "autopilot-badge";
  autopilotBadge.textContent = "AUTOPILOT";
  autopilotBadge.style.cssText = `
    position:fixed; top:70px; left:50%; transform:translateX(-50%);
    font-family:'Courier New',monospace; font-size:13px; font-weight:bold;
    letter-spacing:3px; color:#8dff6a; text-shadow:0 0 8px rgba(120,255,90,0.9);
    pointer-events:none; z-index:150; display:none;
  `;
  document.body.appendChild(autopilotBadge);

    // ── Missile-lock warning — shown while an enemy guided rocket has a
  // live homing lock on the player's plane. Pure CSS pulse, no per-frame
  // JS animation cost; the DOM write only happens on a locked/unlocked
  // state change (see _checkPlayerMissileLock below), not every frame.
  const missileLockBadge = document.createElement("div");
  missileLockBadge.id = "missile-lock-badge";
  missileLockBadge.textContent = "⚠ MISSILE LOCK ⚠";
  missileLockBadge.style.cssText = `
    position:fixed; top:130px; left:50%; transform:translateX(-50%);
    font-family:'Courier New',monospace; font-size:15px; font-weight:bold;
    letter-spacing:2px; color:#ff3322; text-shadow:0 0 10px rgba(255,30,20,0.95);
    pointer-events:none; z-index:150; display:none;
    animation: missile-lock-pulse 0.5s ease-in-out infinite;
  `;
  document.body.appendChild(missileLockBadge);

  const _missileLockStyleEl = document.createElement("style");
  _missileLockStyleEl.textContent = `
    @keyframes missile-lock-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
  `;
  document.head.appendChild(_missileLockStyleEl);

  // ── Play-zone warning badge — shown while the player's plane is outside
  // the 1000x1000 play zone, with a live countdown.
  const playZoneBadge = document.createElement("div");
  playZoneBadge.id = "play-zone-badge";
  playZoneBadge.style.cssText = `
    position:fixed; top:100px; left:50%; transform:translateX(-50%);
    font-family:'Courier New',monospace; font-size:16px; font-weight:bold;
    letter-spacing:2px; color:#ff4422; text-shadow:0 0 8px rgba(255,40,20,0.9);
    pointer-events:none; z-index:150; display:none; text-align:center;
  `;
  document.body.appendChild(playZoneBadge);

  // Scratch objects — reused every frame, zero per-frame allocation
  const _gunReticleOrigin = new THREE.Vector3();
  const _gunReticleDir = new THREE.Vector3();
  const _gunReticleAvgPos = new THREE.Vector3();
  const _gunReticleAvgDir = new THREE.Vector3();
  const _gunReticleWorld = new THREE.Vector3();
  const _gunReticleProj = new THREE.Vector3();

  /**
   * Updates the plane gun-aim reticle position on screen. Averages the
   * world position + forward direction of every active gun point on the
   * plane's currently-mounted MG weapon system (works for both
   * MachineGunSystem's single gun point and MultiGunSystem's array —
   * both expose .getGunPoints()), projects a point GUN_RETICLE_DISTANCE
   * out along the averaged direction, then maps that 3D point to 2D
   * screen space. Hides the reticle if behind the camera or no gun
   * points are available yet (e.g. model still loading).
   */
  /**
   * Computes the plane's current gun-aim world point into `_gunReticleWorld`
   * — origin is the averaged GunPoint_1/2 position (just where the tracers
   * visually start from), but the DIRECTION now comes from the plane's real
   * forward-heading vector (matches rocket direction), not from the gun
   * points' own local rotation. Returns false (and leaves _gunReticleWorld
   * untouched) if there's nothing to aim from yet.
   */
  function updatePlaneGunAimWorld() {
    if (!plane || !plane.bulletSystem?.getGunPoints) return false;
    const gunPoints = plane.bulletSystem.getGunPoints();
    if (!gunPoints || gunPoints.length === 0) return false;

    _gunReticleAvgPos.set(0, 0, 0);
    for (const gp of gunPoints) {
      gp.getWorldPosition(_gunReticleOrigin);
      _gunReticleAvgPos.add(_gunReticleOrigin);
    }
    _gunReticleAvgPos.multiplyScalar(1 / gunPoints.length);

    plane.getForwardVector(_gunReticleAvgDir);
    if (_gunReticleAvgDir.lengthSq() < 0.0001) return false;
    _gunReticleAvgDir.normalize();

    // ── Tilt the aim direction down slightly around the plane's local
    // right axis, so the gun/crosshair converge a bit below the raw nose
    // heading instead of dead-ahead ──────────────────────────────────────
    _gunAimRightAxis.set(0, 0, -1).applyQuaternion(plane.bodyGroup.quaternion);
    _gunAimPitchQ.setFromAxisAngle(_gunAimRightAxis, -GUN_AIM_PITCH_DOWN);
    _gunReticleAvgDir.applyQuaternion(_gunAimPitchQ);

    _gunReticleWorld
      .copy(_gunReticleAvgPos)
      .addScaledVector(_gunReticleAvgDir, GUN_RETICLE_DISTANCE);

    return true;
  }

  function updatePlaneGunReticle() {
    // ── Scoped into the main gun scope — show the plain center cross
    // instead of the moving ring reticle, and skip the gun-aim-world
    // projection entirely (firing code paths already call
    // updatePlaneGunAimWorld() themselves right before they fire, so
    // nothing here depends on it running every frame).
    const isScopedMain =
      vehicleType === "plane" && scope.isScoped && scope.scopeMode === "main";
    if (isScopedMain) {
      planeCrosshair.style.display = "none";
      _updateScopedCrosshairStyle();
      planeScopedCrosshair.style.display = "block";
      return;
    }
    planeScopedCrosshair.style.display = "none";

    if (!updatePlaneGunAimWorld()) {
      planeCrosshair.style.display = "none";
      return;
    }

    _gunReticleProj.copy(_gunReticleWorld).project(camera);

    // Behind the camera — hide rather than show a mirrored/garbage position
    if (_gunReticleProj.z > 1) {
      planeCrosshair.style.display = "none";
      return;
    }

    const halfW = window.innerWidth / 2;
    const halfH = window.innerHeight / 2;
    const x = _gunReticleProj.x * halfW + halfW;
    const y = -_gunReticleProj.y * halfH + halfH;

    planeCrosshair.style.display = "block";
    planeCrosshair.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  // ── Mouse tracking ────────────────────────────────────────────────────────
  const mouse = new THREE.Vector2(0, 0);
  mouse._screenX = window.innerWidth / 2; // raw pixel position — used for crosshair CSS placement
  mouse._screenY = window.innerHeight / 2;
  let _mouseAtLeftEdge = false;
  let _mouseAtRightEdge = false;
  const EDGE_THRESHOLD_PX = 2; // how close to the canvas edge counts as "pinned"

  // ── Pointer freeze (visual only, not browser Pointer Lock) — see
  // input.js's setPointerFrozen for the matching freeze on flight-offset
  // tracking. When true, this handler ignores incoming movement so
  // mouse.x/y and mouse._screenX/Y stay fixed at whatever they were the
  // instant freezing began.
  // ── Global "hide cursor everywhere" stylesheet rule — a `<style>` tag
  // with `* { cursor: none !important; }`. This is the one CSS mechanism
  // guaranteed to beat a plain (non-!important) inline `cursor` style on
  // ANY element under the pointer (e.g. deploySpawnBtn's own button
  // cursor) — an !important rule in an author stylesheet always wins
  // over a non-!important inline style, regardless of selector
  // specificity. Toggled by inserting/removing the <style> tag itself
  // rather than flipping a class, so there's zero ambiguity about
  // whether it's active.
  const _cursorHideStyleEl = document.createElement("style");
  _cursorHideStyleEl.textContent = `* { cursor: none !important; }`;

  // ── Cursor visibility — independent of the deploy-freeze logic below.
  // Hidden any time the player is actively driving/flying; shown on
  // spawn-selection, pause, death, and match-end screens. Idempotent —
  // safe to call repeatedly.
  function hideCursor() {
    document.head.appendChild(_cursorHideStyleEl);
  }
  function showCursor() {
    _cursorHideStyleEl.remove();
  }

  let _pointerVisuallyFrozen = false;
  function _freezePointerVisual() {
    _pointerVisuallyFrozen = true;
    setPointerFrozen(true);
    pointerFreezeOverlay.style.display = "block";
    hideCursor();

    tank.turretController?._crosshair &&
      (tank.turretController._crosshair.style.display = "none");
    tank.turretController?._turretCrosshair &&
      (tank.turretController._turretCrosshair.style.display = "none");
    planeCrosshair.style.display = "none";
  }
  function _unfreezePointerVisual() {
    _pointerVisuallyFrozen = false;
    setPointerFrozen(false);
    pointerFreezeOverlay.style.display = "none";
    // ── Deliberately do NOT call showCursor() here — once the deploy
    // resolves, the player is actively driving/flying, and the cursor
    // should stay hidden through gameplay (see hideCursor()/showCursor()
    // calls at each screen transition below).
  }

  const _onMousemove = (e) => {
    if (_pointerVisuallyFrozen) return;
    const canvas = renderer.domElement;
    const rect = canvas.getBoundingClientRect();

    // ── While pointer-locked, e.clientX/Y no longer track a real moving
    // cursor (the browser traps it), so derive screen position from the
    // SAME virtual cursor input.js is accumulating via movementX/Y. This
    // keeps turret-aim raycasting and the on-screen crosshair in sync
    // with the (invisible, locked) mouse instead of freezing them at
    // whatever position the cursor happened to be at lock time. ─────────
    let clientX, clientY;
    if (isPointerLocked()) {
      const off = getMouseFlightOffset(); // -1..1, same source as flight control
      clientX = rect.left + rect.width * 0.5 + off.x * (rect.width * 0.5);
      clientY = rect.top + rect.height * 0.5 + off.y * (rect.height * 0.5);
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const rawX = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.x = rawX;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    mouse._screenX = clientX;
    mouse._screenY = clientY;

    _mouseAtLeftEdge = clientX - rect.left <= EDGE_THRESHOLD_PX;
    _mouseAtRightEdge = rect.right - clientX <= EDGE_THRESHOLD_PX;
  };
  window.addEventListener("mousemove", _onMousemove);

  // ── Physics world ─────────────────────────────────────────────────────────
  const gravity = { x: 0, y: -9.6, z: 0 };
  const world = new RAPIER.World(gravity);
  world.__RAPIER__ = RAPIER;

  const eventQueue = new RAPIER.EventQueue(true);

  // ── Load mask first, then build terrain ───────────────────────────────────
  const mask = new MaskLoader();
  await mask.load(mapDef.terrain?.maskTex ?? "/mask.png");

  // ── Terrain — pass mask for path blending ─────────────────────────────────
  const terrainMesh = terrainBuilder.buildMesh(
    renderer,
    mask,
    terrainData.worldSize,
    {
      ...(mapDef.terrain ?? {}), // colorTex, normalTex, maskTex, normalRepeat, etc.
      furrowOffsetU: 0, // ← tune this (0 to 1, wraps)
      furrowOffsetV: 0, // ← tune this (0 to 1, wraps)
    },
  );
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  // ── Lens flare — tracks light2 (the sun) via shared position reference ────
  if (enableLensFlare) {
    lensFlare = OptimizedLensFlare(
      {
        lensPosition: light2.position,
        occluders: [terrainMesh], // raycast target for sun-behind-hill occlusion
        anamorphic: false,
        secondaryGhosts: false,
        colorGain: new THREE.Color(0.6, 0.5, 0.5), // ← was (1.5, 1.0, 1.0) — biggest single fix for intensity
        glareSize: 0.25, // ← was 0.55 — lower value = smaller/tighter glare disc
        flareSize: 0.0015, // ← was 0.004 — smaller streak/blade size
        haloScale: 0.35, // ← was 0.5 — smaller secondary halo ring
        ghostScale: 0.15, // ← was 0.3 — smaller/fewer visible secondary ghosts
        baseFov: 55, // ← add this line if you want to change the reference point
      },
      lensFlareOpacityRef,
    );
    scene.add(lensFlare.mesh);
  }

  // ── Mouse → terrain raycast (used by artillery targeting) ─────────────────
  const _artilleryRaycaster = new THREE.Raycaster();
  const _artilleryHit = new THREE.Vector3();

  function _raycastMouseToTerrain() {
    _artilleryRaycaster.setFromCamera(mouse, camera);
    const hits = _artilleryRaycaster.intersectObject(terrainMesh, false);
    if (hits.length === 0) return null;
    _artilleryHit.copy(hits[0].point);
    return _artilleryHit;
  }

  // ── Water ──────────────────────────────────────────────────────────────
  const _waterDef = mapDef.water ?? {};
  const showWater = _waterDef.enabled !== false;
  const water = new Water(scene, renderer, {
    size: 10000,
    y: _waterDef.y ?? terrainData.waterLevel ?? 8.4,
    color: _waterDef.color ? parseInt(_waterDef.color, 16) : 0x2a6ea6,
    // deepColor: 0x0a2a3a,      // ← add this line — deep water tint
    // shallowColor: 0x3a9fd4,   // ← add this line — overrides `color` above
    amplitude: _waterDef.waveAmplitude ?? 0.0,
    wind: _waterDef.wind ?? 1.0,
    windDirDeg: _waterDef.windDirDeg ?? 32,
    // foamAmount: _waterDef.foamAmount ?? 1.0,
    shoreFoamWidth: _waterDef.shoreFoamWidth ?? 0.7,
    scrollSpeed: 3.5,
    bobAmplitude: 0.15,
    bobSpeed: 0.35,
    opacity: _waterDef.opacity ?? 0.85,
    sunDirection: new THREE.Vector3(
      light2.position.x,
      light2.position.y,
      light2.position.z,
    ).normalize(),
  });
  if (showWater) {
    water.setTerrainHeightData(
      terrainBuilder.heights,
      terrainBuilder.size,
      terrainBuilder.worldSize,
      terrainBuilder.heightScale,
      terrainBuilder.heightOffset,
    );
  } else {
    water.dispose();
  }

  const { nrows, ncols, heights, scale } =
    terrainBuilder.buildRapierHeightfield(RAPIER);
  const terrainBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(
      nrows,
      ncols,
      heights,
      new RAPIER.Vector3(scale.x, scale.y, scale.z),
    ).setFriction(0.9),
    terrainBody,
  );

  function exportTerrainAsGLB() {
    const exporter = new GLTFExporter();
    exporter.parse(
      terrainMesh,
      (buffer) => {
        const blob = new Blob([buffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "terrain.glb";
        a.click();
        URL.revokeObjectURL(url);
      },
      (error) => console.error("GLTFExporter error:", error),
      { binary: true }, // ← true = .glb, false = .gltf+json
    );
  }

  // ── Invisible boundary walls ───────────────────────────────────────────────
  // Defaults to half the actual loaded terrain's worldSize (so it always
  // matches whatever map is active), but can be explicitly overridden per-map
  // via mapDef.worldHalf in maps.json (e.g. a map author using a differently
  // scaled terrain/heightmap than its worldSize would otherwise imply).
  const WALL_HALF = mapDef.worldHalf ?? terrainData.worldSize / 2;
  const WALL_H = 20; // wall height
  const WALL_THICK = 1;

  const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  const _boundaryWallColliders = []; // ← NEW — refs so we can toggle collision per vehicle

  [
    { x: WALL_HALF, y: 0, z: 0, hx: WALL_THICK, hy: WALL_H, hz: WALL_HALF },
    { x: -WALL_HALF, y: 0, z: 0, hx: WALL_THICK, hy: WALL_H, hz: WALL_HALF },
    { x: 0, y: 0, z: WALL_HALF, hx: WALL_HALF, hy: WALL_H, hz: WALL_THICK },
    { x: 0, y: 0, z: -WALL_HALF, hx: WALL_HALF, hy: WALL_H, hz: WALL_THICK },
  ].forEach(({ x, y, z, hx, hy, hz }) => {
    const _wallCollider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(x, y, z)
        .setFriction(0.0)
        .setRestitution(0.3),
      wallBody,
    );
    _boundaryWallColliders.push(_wallCollider); // ← NEW
  });

  // ── Toggles the boundary walls' collision on/off — lets the plane fly
  // straight through the map-edge walls while the tank still collides
  // with them normally. ────────────────────────────────────────────────
  function _setBoundaryWallsEnabled(enabled) {
    for (const col of _boundaryWallColliders) {
      col.setEnabled(enabled);
    }
  }

  // ── House GLB: visual mesh + box colliders ────────────────────────────────
  const _houseColliderBodies = [];

  const _houseAABBs = []; // ← world-space AABBs of house colliders, for NavGrid

  const _houseVisualRoots = []; // ← collected for lens-flare occlusion
  const _propDefs = []; // ← Prop_N meshes collected across all loaded houses, for PropSystem

  const _houseSmokePoints = []; // ← world positions of every SmokePoint_N empty node, for HouseSmokeSystem

  // ── Cars — Car_N (intact) / Car_N_smashed (destroyed variant) /
  // Car_collider_N (convex physics + smash-trigger source), found while
  // traversing houses.glb below. Constructed here (before loadHouse is
  // even defined) since loadHouse() calls carSystem.registerMesh() per
  // mesh during its own traversal.
  const carSystem = new CarSystem(scene, RAPIER, world, {
    triggerRadius: mapDef.terrain?.carTriggerRadius ?? 3.0,
    solidCollider: true, // tanks physically collide with parked cars
  });

  async function loadHouse(path) {
    // ── Group colliders by house using their Collider_N name — each distinct
    // N is a separate physical house, even though they all live in one GLB ──
    const _houseGroups = new Map(); // key: houseId string → {minX,maxX,minZ,maxZ}

    function _houseIdFromName(name) {
      // Matches "Collider_1", "Collider_12", etc. Falls back to the full
      // name if the pattern doesn't match, so nothing silently gets dropped.
      const m = name.match(/^Collider_(\d+)/);
      return m ? m[1] : name;
    }
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.load(
        path,
        (gltf) => {
          const root = gltf.scene;

          // ── Collect colliders and visual separately ──────────────────────────
          const colliderMeshes = [];
          let visualMesh = null;

          const visualMeshes = []; // ← collect ALL visual meshes, not just the last one

          root.traverse((child) => {
            // ── SmokePoint_N — empty (non-mesh) nodes marking where looping
            // chimney/vent smoke should originate. Checked BEFORE the
            // isMesh gate below since these are plain Object3D nodes with
            // no geometry of their own.
            if (child.name.startsWith("SmokePoint_")) {
              child.updateMatrixWorld(true);
              const _smokeWorldPos = new THREE.Vector3();
              child.getWorldPosition(_smokeWorldPos);
              _houseSmokePoints.push(_smokeWorldPos);
              return;
            }

            if (!child.isMesh) return;

            if (child.name.startsWith("Collider_")) {
              colliderMeshes.push(child);
            } else if (child.name.startsWith("Prop_")) {
              // Breakable prop — captured for PropSystem below, NOT added
              // as a normal static visual mesh (it's hidden here and
              // rendered instead via PropSystem's own InstancedMesh, so
              // tank-proximity breaking can hide it without touching the
              // rest of the house model).
              child.updateMatrixWorld(true);
              _propDefs.push({
                mesh: child,
                matrixWorld: child.matrixWorld.clone(),
              });
              child.visible = false;
            } else if (carSystem.registerMesh(child)) {
              // Car_N / Car_N_smashed / Car_collider_N — fully handled by
              // CarSystem (visibility + later convex-collider build in
              // carSystem.finalize()). Nothing further to do for this mesh.
            } else {
              // Visual_House mesh — add to scene for rendering
              visualMesh = child;
              visualMeshes.push(child);
              // ── "Puddle" and "Water_Layer" meshes never cast/receive
              // shadows, regardless of enableHouseShadow — a flat puddle
              // decal or water-layer plane self-shadowing or casting a
              // shadow onto the ground looks wrong, so this is
              // hard-disabled rather than tied to the house shadow toggle.
              if (child.name.includes("Puddle") || child.name.includes("Water_Layer")) {
                child.castShadow = false;
                child.receiveShadow = true;
              }
              else if (child.name.includes("Inside")) {
                child.castShadow = false;
                child.receiveShadow = false;
              }  else {
                child.castShadow = enableHouseShadow; // ← house casts shadows
                child.receiveShadow = enableHouseShadow; // ← house receives shadows (e.g. from itself/terrain)

                // ── Alpha-clipped shadows for "Trees" meshes only — without
                // alphaTest, Three's shadow-map pass treats every pixel as
                // fully opaque regardless of the material's alpha map, so a
                // tree's leaf-card texture casts a solid black silhouette
                // instead of a properly cut-out shadow. Scoped to only
                // "Trees"-named meshes so every other house mesh (walls,
                // roofs, props) keeps the cheaper opaque shadow-depth path
                // with zero added per-fragment cost.
                if (child.name.includes("Trees")) {
                  const mats = Array.isArray(child.material)
                    ? child.material
                    : [child.material];
                  for (const mat of mats) {
                    if (mat && mat.map) {
                      mat.alphaTest = mat.alphaTest > 0 ? mat.alphaTest : 0.5;
                      mat.needsUpdate = true;
                    }
                  }
                }
              }
            }
          });

          // ── Add visual to scene ──────────────────────────────────────────────
          if (visualMesh) {
            // Ensure world matrix is up to date
            root.updateMatrixWorld(true);
            scene.add(root);
            _houseVisualRoots.push(root);
          }

          // ── Build Rapier cuboid colliders ────────────────────────────────────
          root.updateMatrixWorld(true);

          for (const mesh of colliderMeshes) {
            // Get world-space position, quaternion, scale
            const worldPos = new THREE.Vector3();
            const worldQuat = new THREE.Quaternion();
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

            // ── Record AABB for NavGrid (axis-aligned, inflated later by tankRadius) ──
            const _colMinX = worldPos.x - hx,
              _colMaxX = worldPos.x + hx;
            const _colMinZ = worldPos.z - hz,
              _colMaxZ = worldPos.z + hz;
            _houseAABBs.push({
              minX: _colMinX,
              maxX: _colMaxX,
              minZ: _colMinZ,
              maxZ: _colMaxZ,
            });

            // Rapier quaternion
            const rq = new RAPIER.Quaternion(
              worldQuat.x,
              worldQuat.y,
              worldQuat.z,
              worldQuat.w,
            );

            const body = world.createRigidBody(
              RAPIER.RigidBodyDesc.fixed()
                .setTranslation(worldPos.x, worldPos.y, worldPos.z)
                .setRotation(rq),
            );

            world.createCollider(
              RAPIER.ColliderDesc.cuboid(hx, hy, hz)
                .setFriction(0.5)
                .setRestitution(0.1),
              body,
            );

            _houseColliderBodies.push(body);

            // Hide collider mesh — it's invisible in-game
            mesh.visible = false;
          }

          console.log(
            `[House] Loaded: ${colliderMeshes.length} colliders, ` +
              `${_houseGroups.size} distinct house(s), visual=${!!visualMesh}`,
          );

          resolve();
        },
        undefined,
        reject,
      );
    });
  }
  // ─── Terrain height helper ────────────────────────────────────────────────────
  const getTerrainY = (x, z) => terrainBuilder.getHeightAtWorld(x, z);

  // Load all houses defined in the map
  const _houseDefs = mapDef.houses ?? [{ path: "/houses.glb" }];
  for (const h of _houseDefs) {
    await loadHouse(h.path);
  } // ← change path to your exported GLB

  if (lensFlare) {
    lensFlare.params.occluders.push(..._houseVisualRoots);
  }
    // ── Chimney/vent smoke — one continuously-looping black smoke emitter
  // per SmokePoint_N node found across all loaded houses.
  console.log(`[Smoke] Found ${_houseSmokePoints.length} SmokePoint_N node(s) in loaded houses`);
  const houseSmokeSystem = new HouseSmokeSystem(scene, _houseSmokePoints, {
    startSize: 15.0,
    endSize: 300.0,
    lifetime: 229.5,            // was 25 — slower rise needs a much longer life to reach the same height
    riseSpeed: 2.2,             // was 20.2
    maxParticlesPerEmitter: 60, // was 40 — bumped up, see note below
    spawnInterval: 4.6,         // was 0.5 — scaled proportionally with lifetime to keep density consistent
    drift: 0.6,
  });
  houseSmokeSystem._prime(houseSmokeSystem.lifetime);

  // ── Breakable props — collected from every "Prop_N" mesh found while
  // loading houses.glb above (see loadHouse(), which pushes into
  // _propDefs and hides the mesh's original static instance).
  console.log(`[Prop] Found ${_propDefs.length} prop mesh instance(s) in loaded houses`);

  const propSystem = new PropSystem(scene, _propDefs, {
    triggerRadius: mapDef.terrain?.propTriggerRadius ?? 2.0,
  });

  // ── Cars — build convex colliders now that every house's Car_N /
  // Car_N_smashed / Car_collider_N mesh has been registered via
  // carSystem.registerMesh() inside loadHouse()'s traversal above.
  carSystem.finalize();
  console.log(`[Car] Registered ${carSystem._cars.size} car(s) across loaded houses`);

  // ── Runtime navmesh (grid + A*) built from house collider AABBs ───────────
  const navGrid = new NavGrid({
    worldHalf: WALL_HALF,
    cellSize: 4,
    tankRadius: 2.4,
  });
  navGrid.addObstacles(_houseAABBs);

  // ── Grass Scatter ──────────────────────────────────────────────────────────
  const texLoader = new THREE.TextureLoader();

  // ── Enemy patrol curve (exported from Blender) + fixed spawn points ────────
  // const patrolCurve = await loadPatrolCurve(mapDef, getTerrainY);
  const ENEMY_SPAWN_POINTS = mapDef.enemySpawnPoints ?? [
    { x: 220, z: 60 },
    { x: -220, z: -60 },
    { x: 40, z: 240 },
  ];

  // ── Capture Points ────────────────────────────────────────────────────────
  const CAPTURE_POINTS = (
    mapDef.capturePoints ?? [
      { id: "A", x: 120, z: 80 },
      { id: "B", x: -150, z: -100 },
      { id: "C", x: 20, z: 200 },
      { id: "D", x: 200, z: -180 },
      { id: "E", x: -180, z: 150 },
    ]
  ).map((p) => ({ ...p }));

  // Resolve Y for each point
  CAPTURE_POINTS.forEach((p) => {
    p.y = getTerrainY(p.x, p.z) + 1.5;
  });

  const CAPTURE_RADIUS = 12; // units — how close to trigger
  const CAPTURE_HOLD_TIME = 7; // seconds to hold C
  // const RESPAWN_DELAY      = 5;    // seconds before player respawns
  const MATCH_DURATION = mapDef.matchDuration ?? 180; // seconds (3 minutes)

  // State per point: 'neutral' | 'player' | 'enemy'
  CAPTURE_POINTS.forEach((p) => {
    p.owner = "neutral";
    p.captureTimer = 0;
    p.capturingBy = null; // 'player' | 'enemy' | null
    p.assignedTank = null; // enemy AI: EnemyTank currently traveling to / holding this point
    p.bombDamage = 0; // cumulative bomb damage from the attacking team since this point was last flipped/reset
    // True while the LOCAL PLAYER's own tank has been physically in range and
    // holding [F] at some point during the current capture attempt on this
    // point. Gates whether registerCapture() (personal XP/profile credit)
    // fires when the capture completes — a friendly AI or teammate finishing
    // the capture on their own should NOT grant the local player personal
    // capture credit, only the team-wide score/ownership should change.
    p._playerContributed = false;
  });

  let playerCaptures = 0;
  let enemyCaptures = 0;
  let matchElapsed = 0;
  let matchEnded = false;

    // ═══════════════ TICKET SYSTEM (Battlefield-style Conquest tickets) ═══════
  const STARTING_TICKETS = mapDef.startingTickets ?? 300;
  const TICKET_LOSS_PER_KILL = mapDef.ticketLossPerKill ?? 1;
  const TICKET_BLEED_INTERVAL = 10; // seconds between bleed ticks
  const TICKET_BLEED_PER_POINT_DIFF = 1; // tickets lost per point-count deficit, per tick

  // Absolute, team-neutral — authoritative only on the HOST, broadcast to
  // guests via match:cp-state / match:timer-state (same pattern as p.owner).
  let team1Tickets = STARTING_TICKETS;
  let team2Tickets = STARTING_TICKETS;
  // localTeam-relative caches, mirrors playerCaptures/enemyCaptures — this
  // is what the HUD and applyMatchEnd() actually read.
  let playerTickets = STARTING_TICKETS;
  let enemyTickets = STARTING_TICKETS;
  let _ticketBleedTimer = TICKET_BLEED_INTERVAL;

  /** Deducts `amount` tickets from `team`, clamps at 0, re-derives the
   * localTeam-relative display cache, and refreshes the HUD. HOST ONLY —
   * no-ops on a guest (team1Tickets/team2Tickets there are just a mirror of
   * whatever the host last broadcast). */
  function _loseTicket(team, amount = 1) {
    if (!isHost) return;
    if (team === 1) team1Tickets = Math.max(0, team1Tickets - amount);
    else if (team === 2) team2Tickets = Math.max(0, team2Tickets - amount);
    playerTickets = localTeam === 1 ? team1Tickets : team2Tickets;
    enemyTickets = localTeam === 1 ? team2Tickets : team1Tickets;
    _updateTicketsHud();
  }

  function _updateTicketsHud() {
    const pEl = document.getElementById("tickets-player");
    const eEl = document.getElementById("tickets-enemy");
    if (pEl) pEl.textContent = playerTickets;
    if (eEl) eEl.textContent = enemyTickets;

    // ── Progress bar — each side's fill width is a % of its own half of
    // the bar (see the flex:1 half-containers in the markup below), so
    // 100% = that team still has its full starting ticket count, and it
    // shrinks toward the center divider as tickets are lost.
    const pPct = Math.max(
      0,
      Math.min(100, (playerTickets / STARTING_TICKETS) * 100),
    );
    const ePct = Math.max(
      0,
      Math.min(100, (enemyTickets / STARTING_TICKETS) * 100),
    );
    const pBar = document.getElementById("tickets-bar-player");
    const eBar = document.getElementById("tickets-bar-enemy");
    if (pBar) pBar.style.width = pPct + "%";
    if (eBar) eBar.style.width = ePct + "%";
  }

  /** Classic Conquest ticket bleed — every TICKET_BLEED_INTERVAL seconds,
   * whichever team holds FEWER capture points loses tickets proportional
   * to the point-count deficit. HOST ONLY. */
  function _tickTicketBleed(dt) {
    if (!isHost || !gameStarted || matchEnded) return;
    _ticketBleedTimer -= dt;
    if (_ticketBleedTimer > 0) return;
    _ticketBleedTimer = TICKET_BLEED_INTERVAL;

    let team1Owned = 0,
      team2Owned = 0;
    for (const p of CAPTURE_POINTS) {
      if (p.owner === 1) team1Owned++;
      else if (p.owner === 2) team2Owned++;
    }
    const diff = team1Owned - team2Owned;
    if (diff > 0) _loseTicket(2, diff * TICKET_BLEED_PER_POINT_DIFF);
    else if (diff < 0) _loseTicket(1, -diff * TICKET_BLEED_PER_POINT_DIFF);
  }

  let _fKeyHeld = false;
  let _fHoldTimer = 0;
  let _nearPoint = null; // the capture point currently in range

  // ── Capture Point 3D markers — instanced wind-animated flags ─────────────
  const flagSystem = new InstancedFlagSystem(
    scene,
    CAPTURE_POINTS,
    getTerrainY,
    {
      texture: "/textures/jp_flag.png",
      enablePoleRotation: true,
      flagRotationY: Math.PI / 2,
    },
  );

  function _setCPColor(p) {
    const idx = CAPTURE_POINTS.indexOf(p);
    flagSystem.setOwnerColor(idx, _ownerColorKey(p.owner));
    _updateCPBadge(p); // ← keep the HUD rhombus in sync with the 3D marker
    _updateCPMarkerColor(p); // ← keep the always-on screen marker in sync too
  }

  // ── Capture HUD ───────────────────────────────────────────────────────────
  const captureHud = document.createElement("div");
  captureHud.style.cssText = `
  position:fixed; top:120px; left:50%; transform:translateX(-50%);
  display:none; flex-direction:column; align-items:center; gap:6px;
  font-family:'Courier New',monospace; pointer-events:none; z-index:102;
`;
  captureHud.innerHTML = `
  <div id="capture-rhombus" style="
    position:relative;
    width:64px; height:64px;
    transform:rotate(45deg) scale(0.7);;
    background:rgba(26,18,16,0.6);
    // border:2px solid #00727e;
    box-shadow:0 0 12px rgba(0,0,0,0.6);
    overflow:hidden;
  ">
    <svg id="capture-wipe-svg" width="64" height="64" viewBox="0 0 64 64"
      style="position:absolute; top:0; left:0; transform:rotate(-45deg) scale(1.5); transform-origin:32px 32px;">
      <path id="capture-wipe-path" d="M32,32 L32,-16 A48,48 0 0,1 32,-16 Z" fill="rgba(68,170,255,1)"></path>
    </svg>
    <div style="
      position:absolute; inset:0;
      display:flex; align-items:center; justify-content:center;
      transform:rotate(-45deg);
      pointer-events:none;
    ">
      <span id="capture-f-letter" style="
        font-family:'Courier New',monospace;
        font-size:26px; font-weight:bold;
        color:#f5f0e8;
        text-shadow:0 0 4px rgba(0,0,0,0.8);
      ">F</span>
    </div>
  </div>
`;
  document.body.appendChild(captureHud);

  // ── Rhombus capture button — clockwise radial wipe ─────────────────────────
  const _capWipePath = () => document.getElementById("capture-wipe-path");

  function setCaptureWipe(pct) {
    // pct: 0 → 100
    const path = _capWipePath();
    if (!path) return;

    if (pct <= 0) {
      path.setAttribute("d", "M32,32 L32,-16 A48,48 0 0,1 32,-16 Z");
      return;
    }
    if (pct >= 100) {
      path.setAttribute(
        "d",
        "M32,32 m -48,0 a 48,48 0 1,0 96,0 a 48,48 0 1,0 -96,0",
      );
      return;
    }

    const angle = (pct / 100) * 360;
    const rad = (angle - 90) * (Math.PI / 180);
    const x = 32 + 48 * Math.cos(rad);
    const y = 32 + 48 * Math.sin(rad);
    const largeArc = angle > 180 ? 1 : 0;

    path.setAttribute("d", `M32,32 L32,-16 A48,48 0 ${largeArc},1 ${x},${y} Z`);
  }

  // ── Score bar (timer + capture-point rhombus row) ──────────────────────────
  const scoreHud = document.createElement("div");
  scoreHud.style.cssText = `
  position:fixed; top:20px; left:50%; transform:translateX(-50%);
  display:none; flex-direction:column; align-items:center; gap:10px;
  font-family:'Courier New',monospace; pointer-events:none; z-index:102;
`;
  scoreHud.innerHTML = `
  <div id="tickets-row" style="
    display:flex; flex-direction:column; align-items:center; gap:4px;
    width:340px;
  ">
    <div style="
      display:flex; align-items:center; justify-content:center; gap:14px;
      width:100%;
    ">
      <span style="color:#44aaff; font-size:13px; font-weight:bold; text-shadow:0 0 4px rgba(0,0,0,0.8);" id="tickets-player">${STARTING_TICKETS}</span>
      <div id="match-timer" style="
        color:#ffffff; font-size:14px; font-weight:bold;
        background:transparent; letter-spacing:0.05em;
      ">3:00</div>
      <span style="color:#ff4422; font-size:13px; font-weight:bold; text-shadow:0 0 4px rgba(0,0,0,0.8);" id="tickets-enemy">${STARTING_TICKETS}</span>
    </div>
    <div id="tickets-bar-wrap" style="
      display:flex; width:100%; height:7px;
      background:rgba(0,0,0,0.55); border:1px solid #2a3a1a;
      border-radius:3px; overflow:hidden;
    ">
      <div style="flex:1; display:flex; justify-content:flex-end;">
        <div id="tickets-bar-player" style="
          height:100%; width:100%; background:#44aaff;
          box-shadow:0 0 6px rgba(68,170,255,0.7);
          transition:width 0.35s ease;
        "></div>
      </div>
      <div style="width:2px; background:rgba(255,255,255,0.5);"></div>
      <div style="flex:1; display:flex; justify-content:flex-start;">
        <div id="tickets-bar-enemy" style="
          height:100%; width:100%; background:#ff4422;
          box-shadow:0 0 6px rgba(255,68,34,0.7);
          transition:width 0.35s ease;
        "></div>
      </div>
    </div>
  </div>
  <div id="cp-badge-row" style="
    display:flex; flex-direction:row; align-items:center; gap:20px;
  "></div>
  <span id="score-player" style="display:none;">0</span>
  <span id="score-enemy"  style="display:none;">0</span>
`;
  document.body.appendChild(scoreHud);

  // ── Capture-point rhombus badges — colored by owner ─────────────────────
  const _cpBadgeColors = {
    neutral: { bg: "rgba(120,120,120,0.55)", border: "#888888" },
    player: { bg: "rgba(30,110,220,0.85)", border: "#44aaff" },
    enemy: { bg: "rgba(210,40,20,0.85)", border: "#ff4422" },
  };

  // ── Resolves a team-neutral p.owner ('neutral' | 1 | 2) into THIS
  // client's own display key ('neutral' | 'player' | 'enemy'), relative to
  // localTeam. Same p.owner value therefore renders blue on one team's
  // screen and red on the other's — exactly like Friendly_N/Enemy_N.
  function _ownerColorKey(owner) {
    if (owner == null || owner === "neutral") return "neutral";
    return owner === localTeam ? "player" : "enemy";
  }

  function _buildCPBadges() {
    const row = document.getElementById("cp-badge-row");
    if (!row) return;
    row.innerHTML = "";
    CAPTURE_POINTS.forEach((p) => {
      const wrap = document.createElement("div");
      wrap.id = `cp-badge-${p.id}`;
      wrap.style.cssText = `
      width:15px; height:15px;
      transform:rotate(45deg);
      background:${_cpBadgeColors.neutral.bg};
      border:1px solid ${_cpBadgeColors.neutral.border};
      display:flex; align-items:center; justify-content:center;
      transition: background 0.25s, border-color 0.25s;
      box-shadow:0 0 4px rgba(0,0,0,0.5);
    `;
      const label = document.createElement("span");
      label.textContent = p.id;
      label.style.cssText = `
      transform:rotate(-45deg);
      color:#f5f0e8; font-size:8px; font-weight:bold;
      text-shadow:0 0 2px rgba(0,0,0,0.8);
    `;
      wrap.appendChild(label);
      row.appendChild(wrap);
    });
  }

  function _updateCPBadge(p) {
    const el = document.getElementById(`cp-badge-${p.id}`);
    if (!el) return;
    const c = _cpBadgeColors[_ownerColorKey(p.owner)] ?? _cpBadgeColors.neutral;
    el.style.background = c.bg;
    el.style.borderColor = c.border;
  }

  _buildCPBadges();

  // ── Always-on screen-space capture point markers ──────────────────────────
  const CP_MARKER_MARGIN = 46; // px inset from screen edge when point is off-screen
  const cpMarkerContainer = document.createElement("div");
  cpMarkerContainer.style.cssText = `
  position:fixed; inset:0; pointer-events:none; z-index:101; display:none;
`;
  document.body.appendChild(cpMarkerContainer);

  // ── Spawn-selection vignette — darkens screen edges while picking a spawn ──
  const spawnVignette = document.createElement("div");
  spawnVignette.style.cssText = `
  position:fixed; inset:0; pointer-events:none; z-index:399; display:none;
  background: radial-gradient(
    ellipse at center,
    rgba(0,0,0,0)   0%,
    rgba(0,0,0,0)   45%,
    rgba(0,0,0,0.95) 100%
  );
  opacity: 0;
  transition: opacity 0.6s ease;
`;
  document.body.appendChild(spawnVignette);

  // ── Pointer-freeze overlay — a full-screen div, topmost z-index, that
  // owns the cursor for the entire viewport while active. This is more
  // reliable than setting `cursor` on body/canvas: any element under the
  // pointer with its OWN explicit cursor rule (e.g. a <button>'s default
  // or app CSS) always wins over an inherited value from an ancestor, even
  // an !important one — so body-level cursor overrides can't be trusted to
  // beat every UI element underneath. This overlay sits ABOVE all of them,
  // so its own cursor style is always what's shown, and it also blocks all
  // clicks/hovers from reaching anything below (desirable here anyway,
  // since input is meant to be frozen during this window).
  const pointerFreezeOverlay = document.createElement("div");
  pointerFreezeOverlay.style.cssText = `
  position:fixed; inset:0; z-index:99999;
  display:none; cursor:none;
  background:transparent;
`;
  document.body.appendChild(pointerFreezeOverlay);

  const _cpMarkerEls = new Map(); // point → {wrap, diamond, dist}

  CAPTURE_POINTS.forEach((p) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = `
    position:absolute; top:0; left:0;
    display:flex; flex-direction:column; align-items:center; gap:2px;
    font-family:'Courier New',monospace; will-change:transform;
  `;
    wrap.innerHTML = `
    <div class="cp-marker-diamond" style="
      width:22px; height:22px; transform:rotate(45deg);
      background:${_cpBadgeColors.neutral.bg};
      border:1px solid ${_cpBadgeColors.neutral.border};
      box-shadow:0 0 6px rgba(0,0,0,0.6);
      display:flex; align-items:center; justify-content:center;
    ">
      <span style="
        transform:rotate(-45deg); color:#f5f0e8;
        font-size:10px; font-weight:bold; text-shadow:0 0 2px rgba(0,0,0,0.8);
      ">${p.id}</span>
    </div>
    <div class="cp-marker-dist" style="
      font-size:10px; color:#e8f0c0; text-shadow:0 0 3px rgba(0,0,0,0.9);
    "></div>
  `;
    cpMarkerContainer.appendChild(wrap);
    _cpMarkerEls.set(p, {
      wrap,
      diamond: wrap.querySelector(".cp-marker-diamond"),
      dist: wrap.querySelector(".cp-marker-dist"),
    });
  });

  const _cpMarkerWorldVec = new THREE.Vector3(); // reused scratch — no per-frame alloc

  // ── CP marker update throttle — was running fully unthrottled every
  // single rendered frame (~85-90fps), doing a DOM style.transform write +
  // textContent write per capture point every time even when nothing
  // visibly changed. Throttled to ~20updates/sec (imperceptible for a
  // slowly-drifting distance readout), plus a per-point dedup cache so a
  // write only happens when the rounded distance or screen position
  // actually changed — mirrors the pattern already used by the compass bar
  // and speed/gear HUD elsewhere in this file. ────────────────────────────
  const CP_MARKER_INTERVAL = 1 / 20; // seconds
  let _cpMarkerAccum = 0;
  const _cpMarkerLastState = new Map(); // point → { x, y, onScreen, distText }

  function _projectToScreenEdge(worldX, worldY, worldZ, margin) {
    _cpMarkerWorldVec.set(worldX, worldY, worldZ).project(camera);

    const behind = _cpMarkerWorldVec.z > 1;
    const ndcX = behind ? -_cpMarkerWorldVec.x : _cpMarkerWorldVec.x;
    const ndcY = behind ? -_cpMarkerWorldVec.y : _cpMarkerWorldVec.y;

    const halfW = window.innerWidth / 2;
    const halfH = window.innerHeight / 2;
    let px = ndcX * halfW;
    let py = -ndcY * halfH;

    const onScreen =
      !behind && ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1;

    if (!onScreen) {
      const boundW = halfW - margin;
      const boundH = halfH - margin;
      const angle = Math.atan2(py, px);
      const scaleX = boundW / Math.max(Math.abs(Math.cos(angle)), 1e-6);
      const scaleY = boundH / Math.max(Math.abs(Math.sin(angle)), 1e-6);
      const scale = Math.min(scaleX, scaleY);
      px = Math.cos(angle) * scale;
      py = Math.sin(angle) * scale;
    }

    return { x: px + halfW, y: py + halfH, onScreen };
  }

  function updateCPScreenMarkers(tPos, dt = 0) {
    // ── Throttle to CP_MARKER_INTERVAL — skip entirely if not enough time
    // has passed since the last actual update. dt defaults to 0 at call
    // sites that don't pass it, which would never accumulate — those call
    // sites are patched below to pass the real per-frame dt.
    _cpMarkerAccum += dt;
    if (_cpMarkerAccum < CP_MARKER_INTERVAL) return;
    _cpMarkerAccum = 0;

    CAPTURE_POINTS.forEach((p) => {
      const el = _cpMarkerEls.get(p);
      if (!el) return;

      const { x, y, onScreen } = _projectToScreenEdge(
        p.x,
        p.y,
        p.z,
        CP_MARKER_MARGIN,
      );
      const rx = Math.round(x);
      const ry = Math.round(y);

      let distText = null;
      if (tPos) {
        const dx = p.x - tPos.x,
          dz = p.z - tPos.z;
        distText = `${Math.round(Math.sqrt(dx * dx + dz * dz))}m`;
      }

      let prev = _cpMarkerLastState.get(p);
      if (!prev) {
        prev = { x: NaN, y: NaN, onScreen: null, distText: null };
        _cpMarkerLastState.set(p, prev);
      }

      // Only touch the DOM when something actually changed
      if (prev.x !== rx || prev.y !== ry || prev.onScreen !== onScreen) {
        el.wrap.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%,-50%) scale(${onScreen ? 1 : 0.85})`;
        el.diamond.style.opacity = onScreen ? "1" : "0.55";
        prev.x = rx;
        prev.y = ry;
        prev.onScreen = onScreen;
      }

      if (distText !== null && distText !== prev.distText) {
        el.dist.textContent = distText;
        prev.distText = distText;
      }
    });
  }

  function _updateCPMarkerColor(p) {
    const el = _cpMarkerEls.get(p);
    if (!el) return;
    const c = _cpBadgeColors[_ownerColorKey(p.owner)] ?? _cpBadgeColors.neutral;
    el.diamond.style.background = c.bg;
    el.diamond.style.borderColor = c.border;
  }

  // ── Minimap capture point dots ────────────────────────────────────────────
  CAPTURE_POINTS.forEach((p) => {
    const { x, y } = worldToMinimap(p.x, p.z);
    const dot = document.createElement("div");
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
    const key = _ownerColorKey(p.owner);
    dot.style.background =
      key === "player" ? "#44aaff" : key === "enemy" ? "#ff4422" : "#888";
  }

  // ── Match end screen ──────────────────────────────────────────────────────
  const matchEndScreen = document.createElement("div");
  matchEndScreen.style.cssText = `
  display:none; position:fixed; inset:0;
  background:rgba(0,0,0,0.6);
  align-items:center; justify-content:center;
  z-index:300; font-family:'Courier New',monospace;
`;
  matchEndScreen.innerHTML = `
  <div style="
    background:#0d0d0d;
    border-top:1px solid #2a3a1a;
    border-bottom:1px solid #2a3a1a;
    padding:2.2rem 3rem;
    min-width:900px;
    max-width:92vw;
    min-height:620px;
    max-height:96vh;
    overflow-y:auto;
    position:relative;
    font-family:'Courier New',monospace;
    color:#c8d8a0;
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:26px;
    -webkit-mask-image: linear-gradient(
      to right,
      transparent 0%,
      black 2%,
      black 98%,
      transparent 100%
    );
    mask-image: linear-gradient(
      to right,
      transparent 0%,
      black 2%,
      black 98%,
      transparent 100%
    );
  ">
    <div id="match-result" style="font-size:28px;letter-spacing:0.15em;"></div>
    <div style="display:flex; flex-direction:column; align-items:center; gap:8px;">
      <div style="font-size:10px; letter-spacing:0.18em; color:#6a8a30;">CAPTURE POINTS</div>
      <div style="display:flex; align-items:center; gap:16px;">
        <div style="
          display:flex; flex-direction: column; align-items:center; gap:10px;
          background:rgba(68,170,255,0.10); border:1px solid rgba(68,170,255,0.35);
          border-radius:4px; padding:6px 16px;
        ">
          <span style="color:#44aaff; font-size:12px; letter-spacing:0.08em; font-weight:bold;">YOUR TEAM</span>
          <span style="color:#e8f0c0; font-size:17px; font-weight:bold;" id="end-player-cap">0</span>
        </div>
        <span style="color:#4a4a3a; font-size:13px;">VS</span>
        <div style="
          display:flex; flex-direction: column; align-items:center; gap:10px;
          background:rgba(255,68,34,0.10); border:1px solid rgba(255,68,34,0.35);
          border-radius:4px; padding:6px 16px;
        ">
          <span style="color:#ff4422; font-size:12px; letter-spacing:0.08em; font-weight:bold;">ENEMY TEAM</span>
          <span style="color:#e8f0c0; font-size:17px; font-weight:bold;" id="end-enemy-cap">0</span>
        </div>
      </div>
    </div>

    <div id="match-rewards" style="
      display:flex; flex-direction:column; align-items:center; gap:14px;
      width:100%; max-width:480px;
      background:rgba(106,138,48,0.06); border:1px solid rgba(106,138,48,0.25);
      border-radius:6px; padding:16px 22px;
    ">
      <div style="display:flex; align-items:center; gap:14px; width:100%;">
        <img id="reward-rank-img" src="" alt="" style="width:48px;height:48px;object-fit:contain;flex-shrink:0;">
        <div style="flex:1; display:flex; flex-direction:column; gap:4px;">
          <div style="display:flex; justify-content:space-between; font-size:10px; color:#6a8a30; letter-spacing:0.08em;">
            <span id="reward-rank-name">RANK 1</span>
            <span id="reward-xp-label">0 / 500 XP</span>
          </div>
          <div style="height:8px; background:#1e2e14; border-radius:4px; overflow:hidden;">
            <div id="reward-xp-bar" style="height:100%; width:0%; background:#6a8a30; transition:width 0.6s ease;"></div>
          </div>
        </div>
      </div>
      <div id="reward-rankup-banner" style="
        display:none; font-size:11px; letter-spacing:0.2em; color:#8dff6a;
        text-shadow:0 0 8px rgba(120,255,90,0.7);
      ">RANK UP!</div>
      <div style="display:flex; align-items:center; gap:5px;">
        <span style="
          width:15px;height:15px;border-radius:50%;background:#c8a030;
          display:flex;align-items:center;justify-content:center;
          font-size:8px;color:#2a1e08;font-weight:bold;
        ">I</span>
        <span id="reward-currency-val" style="font-size:11px; color:#e8f0c0; font-weight:bold;">0</span>
        <span id="reward-currency-gain" style="font-size:7px; color:#8dff6a;"></span>
      </div>
    </div>

    <table id="team-kill-table" style="
      width:100%; max-width:640px; border-collapse:collapse; table-layout:fixed;
      font-family:'Courier New',monospace;
      color:#c8d8a0; font-size:13px; margin-top:4px;
    ">
      <thead>
        <tr>
          <th colspan="2" style="padding:8px 14px; color:#44aaff; font-size:13px; letter-spacing:0.12em; border-bottom:1px solid #2a3a1a; text-align:center;">TEAM 1</th>
          <th colspan="2" style="padding:8px 14px; color:#ff4422; font-size:13px; letter-spacing:0.12em; border-bottom:1px solid #2a3a1a; border-left:1px solid #2a3a1a; text-align:center;">TEAM 2</th>
        </tr>
        <tr>
          <th style="width:35%; padding:6px 14px; color:#6a8a30; font-size:11px; text-align:left;  border-bottom:1px solid #2a3a1a;">NAME</th>
          <th style="width:15%; padding:6px 14px; color:#6a8a30; font-size:11px; text-align:right; border-bottom:1px solid #2a3a1a;">KILLS</th>
          <th style="width:35%; padding:6px 14px; color:#6a8a30; font-size:11px; text-align:left;  border-bottom:1px solid #2a3a1a; border-left:1px solid #2a3a1a;">NAME</th>
          <th style="width:15%; padding:6px 14px; color:#6a8a30; font-size:11px; text-align:right; border-bottom:1px solid #2a3a1a;">KILLS</th>
        </tr>
      </thead>
      <tbody id="team-kill-tbody">
        <!-- Injected by JS -->
      </tbody>
    </table>

    <button id="match-end-menu-btn" style="
      margin-top:12px; padding:12px 32px;
      background:#1e2e14; color:#c8d8a0;
      border:1px solid #6a8a30;
      font-family:'Courier New',monospace;
      font-size:13px; letter-spacing:0.12em;
      cursor:pointer; border-radius:4px;
    ">&#8592; BACK TO MENU</button>
  </div>
`;

  // Renders the Team 1 / Team 2 kill table + MVP line into matchEndScreen
  function _renderKillChart() {
    const tbody = document.getElementById("team-kill-tbody");
    if (!tbody) return;

    // canonical key -> { desc, kills } — combines actual kill counts with
    // every AI unit / real player ever seen this match (so 0-kill entries
    // show up too), keyed by team-neutral identity, never a rendered string.
    const roster = new Map();

    for (const [key, { count, desc }] of killStats.entries()) {
      roster.set(key, { desc, kills: count });
    }
    for (const [stableId, team] of _knownAiStableIds.entries()) {
      const key = "ai:" + stableId;
      if (!roster.has(key))
        roster.set(key, { desc: { kind: "ai", stableId, team }, kills: 0 });
    }
    for (const [uid, { name, team }] of _knownRealPlayers.entries()) {
      const key = "player:" + uid;
      if (!roster.has(key))
        roster.set(key, {
          desc: { kind: "player", uid, team, name },
          kills: 0,
        });
    }

    // ── Safety net: merge any two roster rows that are both real players
    // with the identical display name — shouldn't happen now that every
    // socket emit carries shooterUid, but guards against any straggler
    // synthetic-uid path.
    const _seenPlayerNames = new Map();
    for (const [key, entry] of [...roster.entries()]) {
      if (entry.desc.kind !== "player" || !entry.desc.name) continue;
      const existingKey = _seenPlayerNames.get(entry.desc.name);
      if (!existingKey) {
        _seenPlayerNames.set(entry.desc.name, key);
        continue;
      }
      if (existingKey === key) continue;
      roster.get(existingKey).kills += entry.kills;
      roster.delete(key);
    }

    // ── Split strictly by each entry's REAL team, relative to THIS
    // viewer's own localTeam — never by string-matching the label (that's
    // exactly what silently misfiled a bare "Player" string kill into the
    // wrong column before).
    const team1 = [];
    const team2 = [];
    roster.forEach(({ desc, kills }) => {
      (desc.team === localTeam ? team1 : team2).push({ desc, kills });
    });
    team1.sort((a, b) => b.kills - a.kills);
    team2.sort((a, b) => b.kills - a.kills);

    const combined = [...team1, ...team2].sort((a, b) => b.kills - a.kills);
    const topKills = combined.length ? combined[0].kills : 0;
    const mvpEntry = topKills > 0 ? combined[0] : null;

    // Re-label the static "TEAM 1"/"TEAM 2" headers relative to THIS viewer —
    // "TEAM 1" is meaningless if the viewer is actually on team 2.
    const _headerRow = tbody.parentElement?.querySelector(
      "thead tr:first-child",
    );
    if (_headerRow) {
      const ths = _headerRow.querySelectorAll("th");
      if (ths[0]) ths[0].textContent = `YOUR TEAM (TEAM ${localTeam})`;
      if (ths[1])
        ths[1].textContent = `ENEMY TEAM (TEAM ${localTeam === 1 ? 2 : 1})`;
    }

    tbody.innerHTML = "";
    const rowCount = Math.max(team1.length, team2.length);

    function _renderCell(e, isMvp) {
      if (!e) return { label: "", color: "#556", kills: "" };
      const baseLabel = _labelForKillEntity(e.desc); // always the real name — no "You" override
      const marker = _teamMarker(e.desc);
      return {
        label: `${isMvp ? "★ " : ""}${marker}${baseLabel}`,
        color: _killFeedColor(e.desc),
        kills: e.kills,
      };
    }

    for (let i = 0; i < rowCount; i++) {
      const e1 = team1[i] ?? null;
      const e2 = team2[i] ?? null;

      const isMvp1 = !!(e1 && mvpEntry && e1.desc === mvpEntry.desc);
      const isMvp2 = !!(e2 && mvpEntry && e2.desc === mvpEntry.desc);

      const row = document.createElement("tr");
      const cellStyle = "padding:8px 14px; font-size:13px;";
      const mvpBg1 = isMvp1 ? "background:rgba(255,221,68,0.14);" : "";
      const mvpBg2 = isMvp2 ? "background:rgba(255,221,68,0.14);" : "";

      const c1 = _renderCell(e1, isMvp1);
      const c2 = _renderCell(e2, isMvp2);

      row.innerHTML = `
      <td style="${cellStyle} text-align:left; ${mvpBg1} color:${c1.color};">${c1.label}</td>
      <td style="${cellStyle} text-align:right; ${mvpBg1} color:#e8f0c0;">${c1.kills}</td>
      <td style="${cellStyle} text-align:left; border-left:1px solid #2a3a1a; ${mvpBg2} color:${c2.color};">${c2.label}</td>
      <td style="${cellStyle} text-align:right; ${mvpBg2} color:#e8f0c0;">${c2.kills}</td>
    `;
      tbody.appendChild(row);
    }
  }

  // ── Match-end reward animation — steps the XP bar through every rank
  // boundary crossed (so a big multi-rank XP grant visibly fills and
  // resets instead of jumping straight to the end state), and counts the
  // currency-1 total up from its pre-match-end value to its post value.
  function _animateMatchRewards(before, after, currencyBefore, currencyAfter) {
    const rankImgEl = document.getElementById("reward-rank-img");
    const rankNameEl = document.getElementById("reward-rank-name");
    const xpLabelEl = document.getElementById("reward-xp-label");
    const xpBarEl = document.getElementById("reward-xp-bar");
    const rankupBanner = document.getElementById("reward-rankup-banner");
    const currencyValEl = document.getElementById("reward-currency-val");
    const currencyGainEl = document.getElementById("reward-currency-gain");
    if (!rankNameEl || !xpBarEl) return;

    const currencyGain = Math.max(0, currencyAfter - currencyBefore);
    currencyGainEl.textContent = currencyGain > 0 ? `+${currencyGain}` : "";
    rankupBanner.style.display = after.rank > before.rank ? "block" : "none";

    // Build one "segment" per rank boundary crossed, ending with the
    // final (possibly max) rank — each segment fills its own 0-100% bar.
    const segments = [];
    let curRank = before.rank;
    let curXp = before.xp;
    while (curRank < after.rank) {
      const rankDef = RANKS.find((r) => r.rank === curRank);
      const nextDef = RANKS.find((r) => r.rank === curRank + 1);
      if (!rankDef || !nextDef) break;
      segments.push({
        rank: curRank,
        name: rankDef.name,
        rankStart: rankDef.xpRequired,
        toXp: nextDef.xpRequired,
        xpForNext: nextDef.xpRequired,
        isFinal: false,
      });
      curRank++;
      curXp = nextDef.xpRequired;
    }
    const finalDef = RANKS.find((r) => r.rank === after.rank);
    segments.push({
      rank: after.rank,
      name: after.name,
      rankStart: finalDef?.xpRequired ?? 0,
      toXp: after.xp,
      xpForNext: after.xpForNext,
      isFinal: true,
    });

    let segIdx = 0;
    function playSegment() {
      const seg = segments[segIdx];
      if (!seg) return;

      rankImgEl.src = `/ranks/rank-${seg.rank}.png`;
      rankNameEl.textContent = `RANK ${seg.rank} — ${seg.name.toUpperCase()}`;

      const isMaxFinal = seg.isFinal && after.isMaxRank;
      const span = Math.max(
        1,
        (isMaxFinal ? seg.toXp : seg.xpForNext) - seg.rankStart,
      );
      const fromPct =
        segIdx === 0
          ? Math.min(
              100,
              Math.max(0, ((before.xp - seg.rankStart) / span) * 100),
            )
          : 0;
      const toPct = isMaxFinal
        ? 100
        : Math.min(100, ((seg.toXp - seg.rankStart) / span) * 100);

      xpBarEl.style.transition = "none";
      xpBarEl.style.width = fromPct + "%";
      void xpBarEl.getBoundingClientRect();
      xpBarEl.style.transition = "width 0.6s ease";

      xpLabelEl.textContent = isMaxFinal
        ? `${after.xp} XP (MAX RANK)`
        : `${seg.toXp} / ${seg.xpForNext} XP`;

      requestAnimationFrame(() => {
        xpBarEl.style.width = toPct + "%";
      });

      setTimeout(() => {
        segIdx++;
        if (segIdx < segments.length) playSegment();
      }, 700);
    }
    playSegment();

    // ── Currency count-up ────────────────────────────────────────────
    const CURRENCY_ANIM_MS = 900;
    const _t0 = performance.now();
    function tickCurrency(now) {
      const t = Math.min(1, (now - _t0) / CURRENCY_ANIM_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      currencyValEl.textContent = Math.round(
        currencyBefore + (currencyAfter - currencyBefore) * eased,
      );
      if (t < 1) requestAnimationFrame(tickCurrency);
      else currencyValEl.textContent = currencyAfter;
    }
    requestAnimationFrame(tickCurrency);
  }

  // ── Match-end sequence — runs identically whether triggered locally
  // (host, when its authoritative timer hits zero) or remotely (guest,
  // via match:timer-state telling it the host has ended the match).
  // Pulled out of the old inline match-timer block so both paths share
  // exactly the same logic instead of drifting apart over time.
  function applyMatchEnd() {
    if (matchEnded) return;
    matchEnded = true;

    // ── If spawn-selection was still up (player died right as the timer
    // hit zero), tear it down immediately — the match-end screen takes
    // over and the deploy picker no longer makes sense ──────────────────
    if (_spawnSelectionActive) {
      _spawnSelectionActive = false;
      spawnOrbitControls?.dispose();
      spawnOrbitControls = null;
      spawnMarkerContainer.style.display = "none";
      deploySpawnBtn.style.display = "none";
      vehicleTypeContainer.style.display = "none";
      if (flightCloudMesh) {
        flightCloudMesh.visible = false;
        flightCloudMesh.material.uniforms.uOpacity.value = 0.0;
        flightCloudMesh.material.uniforms.uHoleEnabled.value = 0.0;
      }
      _spawnCloudActive = false;
    }

    // ── Lock player input and freeze enemy AI ─────────────────────────────
    tank._inputLocked = true;
    if (tank.turretController) {
      tank.turretController.enabled = false;
      tank.turretController._crosshair.style.display = "none";
      tank.turretController._turretCrosshair.style.display = "none";
      tank.turretController._rangeDisplay.style.display = "none";
      tank.turretController._matchEnded = true;
    }

    if (tank.rigidBody) {
      tank.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      tank.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    if (plane && !plane.isDead) {
      if (!plane.autopilotEnabled) plane.toggleAutopilot();
      plane._inputLocked = true;
      planeCrosshair.style.display = "none";
      planeScopedCrosshair.style.display = "none"; // ← add
      if (scope.isScoped) scope._exitScope();       // ← add      
    }

    // ── AI freeze — only meaningful on the host, since guests never run
    // the real enemyPool anyway (isHost-gated). Harmless no-op on guests.
    for (const et of enemyPool.getActiveTanks()) {
      if (!et.isDead) {
        et.rigidBody?.setLinvel({ x: 0, y: 0, z: 0 }, true);
        et.rigidBody?.setAngvel({ x: 0, y: 0, z: 0 }, true);
        et.state = "IDLE";
      }
    }

    audio.stopAllEnemyEngines();
    enemyPool._spawnTimer = Infinity;

    // ── Tickets decide the match first; if both teams end with the exact
    // same ticket count, fall back to whichever team currently holds more
    // capture points (playerCaptures/enemyCaptures are already kept in
    // sync — host computes them directly, guests receive them via
    // match:cp-state/match:timer-state — so this tiebreak resolves
    // identically on every client).
    let result;
    if (playerTickets > enemyTickets) {
      result = "VICTORY";
    } else if (playerTickets < enemyTickets) {
      result = "DEFEAT";
    } else if (playerCaptures > enemyCaptures) {
      result = "VICTORY";
    } else if (playerCaptures < enemyCaptures) {
      result = "DEFEAT";
    } else {
      result = "DRAW";
    }

    const _rewardsBeforeRank = playerProfile.getRankInfo();
    const _rewardsBeforeCurrency = playerProfile.data.currency1;

    playerProfile.commitMatchStats(result);

    const _rewardsAfterRank = playerProfile.getRankInfo();
    const _rewardsAfterCurrency = playerProfile.data.currency1;

    document.getElementById("match-result").textContent = result;
    document.getElementById("match-result").style.color =
      result === "VICTORY"
        ? "#44ffaa"
        : result === "DEFEAT"
          ? "#ff4422"
          : "#ffdd44";
    document.getElementById("end-player-cap").textContent = playerCaptures;
    document.getElementById("end-enemy-cap").textContent = enemyCaptures;
    //     document.getElementById("end-player-tickets").textContent = playerTickets;
    // document.getElementById("end-enemy-tickets").textContent = enemyTickets;
    _renderKillChart();
    _animateMatchRewards(
      _rewardsBeforeRank,
      _rewardsAfterRank,
      _rewardsBeforeCurrency,
      _rewardsAfterCurrency,
    );

    document.getElementById("health").style.display = "none";
    stats.dom.style.display = "none";
    document.getElementById("hud-speed").style.display = "none";
    document.getElementById("minimap").style.display = "none";
    document.getElementById("compass-bar").style.display = "none";
    document.getElementById("weapon-hud").style.display = "none";
    cpMarkerContainer.style.display = "none";
    captureHud.style.display = "none";
    scoreHud.style.display = "none";
    teammatesHud.style.display = "none";

    matchEndScreen.style.display = "flex";
    audio._stopEngine?.();
    audio.stopMG?.();
    audio.stopTurret?.();
    exitGameplayPointerLock();
    showCursor();

    // ── Host broadcasts the exact moment/state match-end happened so
    // every guest triggers the identical sequence at (near-)the same
    // instant, instead of waiting for their own drifted local timer.
    if (isHost && matchSocket) {
      matchSocket.emit("match:timer-state", {
        matchElapsed,
        matchEnded: true,
        team1Captures: localTeam === 1 ? playerCaptures : enemyCaptures,
        team2Captures: localTeam === 1 ? enemyCaptures : playerCaptures,
        team1Tickets, // ← NEW
        team2Tickets, // ← NEW
      });
    }
  }

  document.body.appendChild(matchEndScreen);
  document
    .getElementById("match-end-menu-btn")
    .addEventListener("click", returnToMenu);

  // ─── Grass Pool ───────────────────────────────────────────────────────────────
  const grassPool = new GrassPool(scene, texLoader, {
    getTerrainY: getTerrainY,
    terrain: terrainBuilder,
    grassCount: mapDef.grass?.grassCount ?? 5000,
    flowerCount: mapDef.grass?.flowerCount ?? 500,
  });

  // ── Grass impact near the gun muzzle — crushes grass around the tank's
  // own barrel/MG the instant it fires, instead of only at wherever the
  // shot eventually lands. Reused scratch vector — zero allocation per shot.
  const _gunImpactScratch = new THREE.Vector3();
  function _spawnGrassImpactNearGun(muzzleNode) {
    if (!muzzleNode) return;
    muzzleNode.getWorldPosition(_gunImpactScratch);
    grassPool.addImpact(_gunImpactScratch.x, _gunImpactScratch.z);
  }

  // ─── Tree placement — sampled from mask (black = valid tree area) ───────────
  const treeMaskPath =
    mapDef.terrain?.treeMaskTex ?? mapDef.terrain?.maskTex ?? "/mask.png";

const [birchSpots, firSpots, palmSpots, mapleSpots, bushSpots] = await Promise.all([
  sampleTreePositions(treeMaskPath, {
    worldSize: terrainData.worldSize,
    count: mapDef.birchCount ?? 100,
    minDist: 8,
  }),
  sampleTreePositions(treeMaskPath, {
    worldSize: terrainData.worldSize,
    count: mapDef.firCount ?? 100,
    minDist: 8,
  }),
  sampleTreePositions(treeMaskPath, {
    worldSize: terrainData.worldSize,
    count: mapDef.palmCount ?? 100,
    minDist: 8,
  }),
  sampleTreePositions(treeMaskPath, {
    worldSize: terrainData.worldSize,
    count: mapDef.mapleCount ?? 100,
    minDist: 8,
  }),
  sampleTreePositions(treeMaskPath, {
    worldSize: terrainData.worldSize,
    count: mapDef.bushCount ?? 150,
    minDist: 6, // bushes can sit closer together than trees
  }),
]);

  const forestManager = new InstancedForestManager(scene, texLoader, {
    birchSpots,
    firSpots,
    palmSpots,
    mapleSpots,
    getTerrainY,
    animRadius: 75, // trees within this distance of the tank sway; beyond it, static
    chunkSize: 40,
    renderer,
    snow: mapDef.snow === true,
  });

  function onPlaneTreeCollision(x, z, hitDirX, hitDirZ) {
    if (forestManager.palm?.tryKnockDownNear(x, z, hitDirX, hitDirZ)) return;
    if (forestManager.maple?.tryKnockDownNear(x, z, hitDirX, hitDirZ)) return;
    forestManager.birch?.tryKnockDownNear(x, z, hitDirX, hitDirZ);
  }

    // ── Fir-tree static collision resolver (Option B) ───────────────────────
  // Applies a CPU push-out correction against standing fir trees for the
  // player's tank AND every AI tank in both team pools, so a tank driving
  // into a fir trunk stops/slides around it instead of clipping through.
  // No Rapier collider involved — this is a manual position correction
  // right after world.step(), same cost class as the existing camera
  // collision raycast elsewhere in this file.
  const _firPushScratch = { x: 0, z: 0 };

  function _applyFirPushToRigidBody(rigidBody, radius) {
    if (!rigidBody) return;
    const p = rigidBody.translation();
    _firPushScratch.x = p.x;
    _firPushScratch.z = p.z;
    const push = forestManager.fir?.resolveTankCollision(_firPushScratch, radius);
    if (!push) return;
    rigidBody.setTranslation({ x: p.x + push.x, y: p.y, z: p.z + push.z }, true);
    // Zero out horizontal velocity into the obstacle so the tank doesn't
    // keep "pushing" against the trunk every step (feels like a solid stop
    // rather than a springy bounce).
    const v = rigidBody.linvel();
    rigidBody.setLinvel({ x: v.x * 0.2, y: v.y, z: v.z * 0.2 }, true);
  }

  function _resolveFirTreeCollisions() {
    if (!forestManager.fir?._ready) return;

    // Local player's own tank (only meaningful while driving the tank —
    // while flying, tank.rigidBody sits parked at y=-500, far from any
    // tree chunk, so the resolver naturally finds nothing there).
    if (!tank.isDead) {
      _applyFirPushToRigidBody(tank.rigidBody, 2.2);
    }

    // Every AI tank in both team pools — host only, since guests never
    // simulate real AI tanks (their pools are empty locally).
    if (isHost) {
      for (const t of team1Pool.getActiveTanks()) {
        if (!t.isDead) _applyFirPushToRigidBody(t.rigidBody, 2.2);
      }
      for (const t of team2Pool.getActiveTanks()) {
        if (!t.isDead) _applyFirPushToRigidBody(t.rigidBody, 2.2);
      }
    }
  }

// ─── Instanced Bushes ─────────────────────────────────────────────────────────
// Falls back to mask-sampled bushSpots when the map doesn't explicitly define
// bushPositions — same treeMaskPath/mask.png already used for birch/fir/palm/maple.
const bushPositions = (mapDef.bushPositions ?? bushSpots).map(({ x, z }) => ({
  x,
  y: getTerrainY(x, z),
  z,
}));

const instancedBush = new InstancedBush(scene, texLoader, bushPositions);

  const debugRenderer = new RapierDebugRenderer(scene, world);
  debugRenderer.mesh.visible = false;

  // ── Initial spawn position — pulled from map.json ──────────────────────────
  const _initialSpawn = mapDef.spawnPoints?.find(
    (s) => s.id === "player_default",
  ) ??
    mapDef.spawnPoints?.[0] ?? { x: 200, y: 10, z: 100 };
  const INITIAL_SPAWN_POS = {
    x: _initialSpawn.x,
    y: _initialSpawn.y ?? 10,
    z: _initialSpawn.z,
  };

  // ── Per-team player spawn points, resolved to terrain height, for the
  // pre-deploy spawn-selection screen. Each real player only ever sees
  // and picks from THEIR OWN team's spawn set — resolved once via
  // localTeam (set earlier in init(), see Chunk 4a) so a client on team 2
  // gets team 2's markers without any further branching downstream.
  const PLANE_SPAWN_ALTITUDE = config.planeSpawnAltitude ?? 100;

  function _resolveGroundSpawnSet(rawList, fallback) {
    return (rawList?.length ? rawList : fallback).map((p) => ({
      x: p.x,
      y: getTerrainY(p.x, p.z) + 1.5,
      z: p.z,
      id: p.id ?? null,
    }));
  }
  function _resolveAirSpawnSet(rawList, groundFallbackSet) {
    return (
      rawList?.length
        ? rawList
        : groundFallbackSet.map((p) => ({
            x: p.x,
            y: p.y + PLANE_SPAWN_ALTITUDE,
            z: p.z,
            id: p.id,
          }))
    ).map((p) => ({ x: p.x, y: p.y, z: p.z, id: p.id ?? null }));
  }

  const TEAM1_TANK_SPAWNS = _resolveGroundSpawnSet(
    mapDef.team1TankSpawnPoints,
    [INITIAL_SPAWN_POS],
  );
  const TEAM2_TANK_SPAWNS = _resolveGroundSpawnSet(
    mapDef.team2TankSpawnPoints,
    [INITIAL_SPAWN_POS],
  );
  const TEAM1_PLANE_SPAWNS = _resolveAirSpawnSet(
    mapDef.team1PlaneSpawnPoints,
    TEAM1_TANK_SPAWNS,
  );
  const TEAM2_PLANE_SPAWNS = _resolveAirSpawnSet(
    mapDef.team2PlaneSpawnPoints,
    TEAM2_TANK_SPAWNS,
  );

  // ── Backward-compat aliases — everything downstream (spawn-selection
  // screen, deploy flow, etc.) still refers to "my own team's" spawn sets
  // as PLAYER_SPAWN_POINTS / PLANE_SPAWN_POINTS, same names as before.
  // localTeam is already resolved above (Chunk 4a), so these just pick
  // the correct concrete set for whichever team the LOCAL client is on.
  const PLAYER_SPAWN_POINTS =
    localTeam === 1 ? TEAM1_TANK_SPAWNS : TEAM2_TANK_SPAWNS;
  const PLANE_SPAWN_POINTS =
    localTeam === 1 ? TEAM1_PLANE_SPAWNS : TEAM2_PLANE_SPAWNS;

  // ── Tank ──────────────────────────────────────────────────────────────────
  const tank = await Tank.create(scene, world, INITIAL_SPAWN_POS, {
    ...config,
    renderer,
    dustColor: mapDef.dustColor ?? config.dustColor ?? 0x8b6914,
  });

  // ── ADD THIS LINE ────────────────────────────────────────────────────
  tank.onDeath = () => audio._stopEngine();

    // ── Lens flare occlusion — include the player's own tank body so the
  // flare correctly hides when the tank itself blocks line-of-sight to
  // the sun, same as it already does for terrain/houses.
  if (lensFlare) {
    lensFlare.params.occluders.push(tank.bodyGroup);
  }

  // ── Don't show flame/ember particles in the water's reflection — smoke
  // and everything else still reflects normally, only the fire-colored
  // layers (flame, flare/sparks, emissive debris) are excluded.
  {
    const _es = tank.bulletSystem.explosionSystem;
    water.excludedFromReflection.push(
      _es._fireL.points,
      _es._flareL.points,
      _es._emitL.points,
    );
  }

  // ── Tank rocket slot — only shown for tanks configured with enableRockets ──
  const _tankRocketSlotEl = document.getElementById("weapon-slot-5");
  if (_tankRocketSlotEl)
    _tankRocketSlotEl.style.display = tank.cfg.enableRockets ? "flex" : "none";

    // ── Tank MG slot — only shown for tanks whose GLB actually has an
  // MG_Point node (tank.hasMachineGun, set in Tank._loadHullModel()).
  // If the player was somehow left on weapon slot 2 (MG) already selected
  // — e.g. a stale preference — fall back to the main gun (slot 1) so
  // they're never stuck on a hidden, unusable weapon.
  const _tankMgSlotEl = document.getElementById("weapon-slot-2");
  if (_tankMgSlotEl)
    _tankMgSlotEl.style.display = tank.hasMachineGun ? "flex" : "none";
  if (!tank.hasMachineGun && tank.activeWeapon === 2) {
    tank.activeWeapon = 1;
  }

  // ── Tank shadow casting ───────────────────────────────────────────────────
  if (enableShadow) {
    tank.bodyGroup.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true; // tank doesn't need to self-shadow from terrain
      }
    });
  }
  scope.tank = tank;
  tank.turretController?.setCamera(camera);
  scope.turretController = tank.turretController ?? null;

  tank.scopeSystem = scope;

  // ── Teammates panel — lists real players AND friendly AI squadmates on
  // the local player's own team, shown just above the speed HUD ─────────
  let _aiPoolsReady = false; // flips true once friendlyPool/friendlyPlanePool exist — guards the early synchronous _buildTeammatesList() call below from touching them before they're constructed
  const teammatesHud = document.createElement("div");
  teammatesHud.id = "teammates-hud";
  teammatesHud.style.cssText = `
    position:fixed; left:20px; bottom:100px; z-index:9200;
    display:none; flex-direction:column; gap:4px;
    font-family:'Courier New',monospace; pointer-events:none;
  `;
  document.body.appendChild(teammatesHud);

  function _buildTeammatesList() {
    teammatesHud.innerHTML = "";

    const hasRealTeammates =
      isSquadMultiplayer && Array.isArray(config.lobbyMembers);
    const teamMembers = hasRealTeammates
      ? config.lobbyMembers.filter((m) => (m.team ?? 1) === localTeam)
      : [];

    // ── AI friendlies — only ever queried once friendlyPool/friendlyPlanePool
    // actually exist (_aiPoolsReady), so this stays safe even though
    // _buildTeammatesList() is also called once, synchronously, right after
    // this function is defined — long before those pools are constructed.
    const aiFriendlies =
      config.friendlySquadEnabled && _aiPoolsReady
        ? [
            ..._collectFriendlyTanksForMarkers(),
            ..._collectFriendlyPlanesForMarkers(),
          ]
        : [];

    if (teamMembers.length <= 1 && aiFriendlies.length === 0) return; // nothing to show

    const _addRow = (label, isSelf) => {
      const row = document.createElement("div");
      row.style.cssText = `
        display:flex; align-items:center; gap:6px;
        font-size:12px; font-weight:bold;
        color:${isSelf ? "#8dff6a" : "#44aaff"};
        text-shadow:0 0 4px rgba(0,0,0,0.85);
        white-space:nowrap;
      `;
      row.innerHTML = `
        <span style="width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0;box-shadow:0 0 4px currentColor;"></span>
        <span>${label}</span>
      `;
      teammatesHud.appendChild(row);
    };

    if (hasRealTeammates) {
      teamMembers.forEach((m) => {
        const isSelf = m.userId === config.userId;
        _addRow(isSelf ? "You" : (m.fullName ?? "Player"), isSelf);
      });
    } else if (aiFriendlies.length > 0) {
      // No real squadmates — this is a solo-player + AI squad match, so
      // list the local player too, so the panel isn't just a list of bots
      // with no indication of which one is you.
      _addRow("You", true);
    }

    aiFriendlies.forEach((unit) => {
      _addRow(getEntityName(unit), false);
    });
  }

  function _positionTeammatesHud() {
    const speedEl = document.getElementById("hud-speed");
    if (!speedEl) return;
    const rect = speedEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    teammatesHud.style.left = rect.left + "px";
    teammatesHud.style.bottom = window.innerHeight - rect.top + 10 + "px";
  }

  _buildTeammatesList();

  // ── Vehicle switching state ──────────────────────────────────────────
  let plane = null; // created lazily on first plane deploy
  let vehicleType = "tank"; // 'tank' | 'plane' — which one the player currently drives
  let activeVehicle = tank; // convenience alias, kept in sync with vehicleType
  let _deployInProgress = false; // guards double-clicking Deploy while a plane GLB loads
  // let _squadFlexResolved = false; // true once the squad's 5th "flex" friendly (tank or plane, based on the player's first vehicle choice) has been decided
  let _spawnScreenCapacityCheckTimer = 0; // counts down to 0 while the spawn-selection screen is up, re-checking friendly-pool capacity roughly once per second

  // ── Squad capacity check — is a given vehicle type "full" of AI
  // friendlies? Only meaningful in squad mode; solo has 0 friendlies of
  // either type so this always reports false there.
  //
  // IMPORTANT: counts LIVING friendlies only (!isDead), not merely "active"
  // pool slots. A destroyed friendly stays "active" for a long tail after
  // death — EnemyTank/FriendlyTank runs a 15s dissolve (_dissolveTimer=15)
  // and EnemyPlane/FriendlyPlane a 6s fall-and-burn (_dissolveTimer=6)
  // before deactivate() finally frees the slot. Counting those as
  // "occupying a slot" would leave the corresponding Deploy option
  // needlessly disabled for that entire tail, well after the wreck is
  // visibly destroyed on the ground. ───────────────────────────────────────
  /**
   * Counts LIVING friendly AI units of a given type ('tank' | 'plane').
   * On the HOST, the real pools (friendlyPool/friendlyPlanePool) are
   * authoritative — they actually run trySpawn()/update() there, so their
   * getActiveTanks() reflects the true roster. On a GUEST, those same
   * local pool objects exist but NEVER spawn anything — EnemyTankPool/
   * EnemyPlanePool.update() are gated by isHost — so getActiveTanks()
   * on a guest is always empty, which was the actual bug: the plane/tank
   * cap check always saw 0 living units and never disabled the button.
   * A guest's real visibility into the friendly AI roster is the visual
   * proxies in _remoteAIUnits (driven by the host's match:ai-state
   * broadcast) — same source _collectFriendlyPlanesForMarkers() already
   * uses for the exact same "friendly = same team as local player" need.
   */
  function _countLivingFriendlyAI(type) {
    if (isHost) {
      const pool = type === "tank" ? friendlyPool : friendlyPlanePool;
      return pool.getActiveTanks().filter((u) => !u.isDead).length;
    }
    let count = 0;
    const wantTank = type === "tank";
    for (const au of _remoteAIUnits.values()) {
      if (!au || au.isDead || au.team !== localTeam) continue;
      const isTankKind =
        au._aiKind === "team1Tank" || au._aiKind === "team2Tank";
      if (isTankKind === wantTank) count++;
    }
    return count;
  }

  function _isFriendlyPoolFull(type) {
    if (!aiPlayersEnabled) return false;
    if (!config.friendlySquadEnabled) return false;

    // ── Never block re-picking a type before the very first deploy —
    // AI targets pre-deploy assume this player occupies nothing yet
    // (see _computeTeamAiTargets), so both options are always open at
    // that point regardless of live AI counts.
    if (!gameStarted) return false;

    // ── The type this player is about to occupy (or already occupies)
    // is NEVER counted against itself — you can always reselect your
    // own last vehicle type, and picking your currently-selected type
    // on the spawn screen is always allowed.
    const _reservedType = _spawnSelectionActive
      ? _selectedVehicleType
      : vehicleType;
    if (type === _reservedType) return false;

    // ── Total OTHER players (AI + any other real player on this team)
    // currently occupying `type`, compared against the fixed team
    // target for that type. This replaces the old single-pool-cap
    // check: the fixed target (4 tanks / 2 planes) is the actual
    // ceiling now, not whatever the AI pool's current maxTanks/
    // maxPlanes happens to be (which itself is derived FROM this same
    // target — see _applyTeamAiTargets), so comparing against the
    // target directly avoids any order-of-update race between the two.
    const target = type === "tank" ? TEAM_TANK_TARGET : TEAM_PLANE_TARGET;

    const livingAI = _countLivingFriendlyAI(type);

    // Other real players (not this client) on the same team, currently
    // tracked as occupying `type`.
    const choices = _realPlayerVehicleChoice.get(localTeam) ?? new Map();
    let otherRealCount = 0;
    for (const [uid, v] of choices.entries()) {
      if (uid === (config.userId ?? "local")) continue; // that's this client itself — excluded above via _reservedType anyway
      if (v === type) otherRealCount++;
    }

    return livingAI + otherRealCount >= target;
  }
  // ── Track-decal spawn grace — suppresses dirt-trail stamping for a short
  // window after teleporting the tank to a spawn point, since the rigid
  // body can report a spurious velocity spike on the very first physics
  // step after a teleport, which would otherwise stamp a decal at spawn ──
  let _trackDecalGrace = 0;
  const TRACK_DECAL_GRACE_TIME = 0.5; // seconds

  function _parkTank() {
    if (tank.rigidBody) {
      tank.rigidBody.setTranslation({ x: 0, y: -500, z: 0 }, true);
      tank.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      tank.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    tank.bodyGroup.visible = false;
    tank._inputLocked = true;
    tank.bulletSystem?.explosionSystem?.stopDamageFire(tank); // ← don't let a parked tank keep smoking
    tank.smokeSystem?.setVisible(false); // ← hide exhaust/ambient smoke while parked
    // ── Track belt/grouser/bogie/torsion InstancedMeshes are added directly
    // to `scene` (not as children of bodyGroup) and are only repositioned
    // inside Track.update(), which tank.update() drives — and tank.update()
    // is skipped entirely while flying. Without this, the belt (and, for
    // torsion-bar/bogie tanks, the arm + wheel instanced meshes) stay
    // visible and frozen at the tank's last position (e.g. its death spot)
    // instead of the spawn point. Track.setVisible() hides every scene-level
    // mesh the track owns, not just the belt/grouser pair. ─────────────────
    tank.trackLeft?.setVisible(false);
    tank.trackRight?.setVisible(false);
  }

  function _unparkTank(pos) {
    tank._inputLocked = false;
    tank.bodyGroup.visible = true;
    tank.smokeSystem?.setVisible(true); // ← restore exhaust/ambient smoke
    tank.respawn(pos);
    if (tank.rigidBody) {
      tank.rigidBody.setTranslation(pos, true);
      tank.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      tank.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    tank.captureTransformSnapshot?.();
    _trackDecalGrace = TRACK_DECAL_GRACE_TIME;

    // ── Restore track visibility. tank.respawn() calls _buildTracks()
    // internally, which creates brand-new Track instances (new
    // instancedMesh/grouserMesh/bogie/torsion meshes), so this is
    // technically redundant right after respawn — but harmless, and
    // guards against any edge case where trackLeft/trackRight persist
    // across a park/unpark without a full respawn in between. Uses
    // setVisible() rather than toggling instancedMesh/grouserMesh
    // directly so torsion-bar and bogie-wheel instanced meshes (which
    // live directly in `scene`, same as the belt) are restored too. ────
    tank.trackLeft?.setVisible(true);
    tank.trackRight?.setVisible(true);
  }

  function _parkPlane() {
    if (!plane) return;
    if (plane.rigidBody) {
      plane.rigidBody.setTranslation({ x: 0, y: -500, z: 0 }, true);
      plane.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      plane.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    plane.bodyGroup.visible = false;
    plane._inputLocked = true;
    // ── Same leftover-beam issue as the death path — plane.update() (and
    // therefore bulletSystem.update()'s fade-out) stops running entirely
    // once parked, so any mid-flight beam would otherwise freeze in the
    // scene until the plane is flown again. ─────────────────────────────
    plane.bulletSystem?.clearBeams?.();
  }

  if (config.shellSpeed) tank.bulletSystem.setShellSpeed(config.shellSpeed);
  if (config.reloadTime && tank.cfg.gunType !== 3)
    tank.bulletSystem.reloadTime = config.reloadTime;
  if (config.damage) tank.bulletSystem.setDamage(config.damage);

  // ── Research upgrades: turret / barrel turn speed ───────────────────────
  if (tank.turretController) {
    if (config.turretTurnSpeed)
      tank.turretController._turretTurnSpeed = config.turretTurnSpeed;
    if (config.barrelTurnSpeed)
      tank.turretController._barrelTurnSpeed = config.barrelTurnSpeed;
  }

  // ── Per-enemy hit counter — lets us grant a "first-hit kill" XP bonus
  // when a tank goes down in a single shot. Keyed by tank object so it's
  // automatically cleaned up once the enemy is removed from the pool. ────────
  const _enemyHitCounts = new WeakMap();

  function _findNearestEnemyToPos(pos, maxDist = 6) {
    if (!pos) return null;
    let best = null,
      bestDsq = maxDist * maxDist;
    for (const et of _getLocalEnemyTargets()) {
      if (!et.rigidBody) continue;
      const p = et.rigidBody.translation();
      const dx = p.x - pos.x,
        dy = p.y - pos.y,
        dz = p.z - pos.z;
      const dsq = dx * dx + dy * dy + dz * dz;
      if (dsq < bestDsq) {
        bestDsq = dsq;
        best = et;
      }
    }
    return best;
  }

  tank.bulletSystem.onHit = (hitPos, hitEnemyTank, appliedDamage) => {
    const _pPos = tank.rigidBody ? tank.rigidBody.translation() : null;
    const _hitDist =
      _pPos && hitPos ? Math.hypot(hitPos.x - _pPos.x, hitPos.z - _pPos.z) : 0;

    // ── Did this shot land on a REMOTE real player's proxy instead of an
    // AI unit? _findNearestEnemyToPos only searches _getLocalEnemyTargets()
    // (AI only), so proxies need their own proximity check here. Only
    // remote players NOT on the local team are eligible targets at all.
    if (!hitEnemyTank && hitPos) {
      let bestProxy = null,
        bestDsq = 36; // 6m, same radius as _findNearestEnemyToPos
      for (const [_rpUid, rp] of _remotePlayers.entries()) {
        if (!rp || !rp.active || rp.isDead || rp.team === localTeam) continue;
        if (!_remoteDeployed.get(_rpUid)) continue;
        const rpp = rp.bodyGroup.position;
        const dx = rpp.x - hitPos.x,
          dz = rpp.z - hitPos.z;
        const dsq = dx * dx + dz * dz;
        if (dsq < bestDsq) {
          bestDsq = dsq;
          bestProxy = rp;
        }
      }
      if (bestProxy) {
        const targetUserId = _remoteUserIdByProxy.get(bestProxy);
        if (targetUserId && matchSocket) {
          const _dmg =
            appliedDamage ??
            config.damage ??
            tank.bulletSystem.getDamage?.() ??
            25;
          matchSocket.emit("match:hit-remote-player", {
            targetUserId,
            damage: _dmg,
            attackerPos: _pPos,
            shooterTeam: localTeam,
            shooterName: _localDisplayName,
            shooterUid: config.userId ?? "local", // ← NEW — lets the victim key this identically to _knownRealPlayers
          });
        }
        tank.turretController?.showHitMarker();
        audio.playExplosion(_hitDist);
        return;
      }
    }

    // Fall back to the old proximity search only if the bullet system didn't
    // resolve a tank directly (shouldn't normally happen now that onHit
    // reports it explicitly, but kept as a safety net).
    const _hitEnemy = hitEnemyTank ?? _findNearestEnemyToPos(hitPos, 6);
    const _damage =
      appliedDamage ?? config.damage ?? tank.bulletSystem.getDamage?.() ?? 25;
    let _isEnemyKill = false;

    _checkAmmoPointHit(hitPos, _damage);

    if (_hitEnemy) {
      const prevHits = _enemyHitCounts.get(_hitEnemy) ?? 0;
      _enemyHitCounts.set(_hitEnemy, prevHits + 1);

      // On the host, _hitEnemy.takeDamage() has already been applied inside
      // bullet.js's resolution — check post-damage health here to detect a kill.
      _isEnemyKill =
        _hitEnemy.isDead ||
        (typeof _hitEnemy.health === "number" && _hitEnemy.health <= 0);
      if (_isEnemyKill) {
        _hitEnemy._wasOneShotKill = prevHits === 0;
      }

      if (!isHost && matchSocket && _hitEnemy._aiKind) {
        matchSocket.emit("match:damage-ai", {
          id: _hitEnemy._id,
          damage: _damage,
          shooterName: _localDisplayName,
          shooterTeam: localTeam, // ← lets the host credit/label this correctly regardless of who fired
          shooterUid: config.userId ?? "local",
        });
      }
    }

    // ── Only play the hit/explosion sound when something was actually hit
    // (an AI unit, resolved into _hitEnemy above). A shot landing on bare
    // terrain/scenery has no _hitEnemy — previously this still fell through
    // to the plain `else` branch below and played the same explosion sound
    // as a real hit, making terrain shots sound identical to real ones.
    if (!_hitEnemy) return;

    tank.turretController?.showHitMarker();

    if (_isEnemyKill) {
      setTimeout(() => audio.playExplosion(_hitDist), 180);
    } else {
      audio.playExplosion(_hitDist);
    }
  };

  // ── MG relay — mirrors the main gun's onHit above. tank.mgSystem is a
  // separate weapon system instance; without its own onHit wired here,
  // client-side MG hits on enemy proxies never get relayed to the host,
  // so guests' machine-gun fire never actually damages anything.
  // ── MG relay — MachineGunSystem resolves its own enemyTank directly (via
  // enemyResolver(rbHandle) inside fire()), unlike bulletSystem which needs
  // a proximity search in onHit. Use that resolved tank directly instead of
  // re-deriving it from hit position.
  if (tank.mgSystem) {
    tank.mgSystem.onHit = (hitPos, hitEnemyTank) => {
      const _pPos = tank.rigidBody ? tank.rigidBody.translation() : null;
      const _hitDist =
        _pPos && hitPos
          ? Math.hypot(hitPos.x - _pPos.x, hitPos.z - _pPos.z)
          : 0;

      _checkAmmoPointHit(hitPos, tank.mgSystem.damage ?? 8);

      if (!hitEnemyTank && hitPos) {
        let bestProxy = null,
          bestDsq = 16; // MG is short-range/high-precision — tighter radius than the main gun
        for (const [_rpUid, rp] of _remotePlayers.entries()) {
          if (!rp || !rp.active || rp.isDead || rp.team === localTeam) continue;
          if (!_remoteDeployed.get(_rpUid)) continue;
          const rpp = rp.bodyGroup.position;
          const dx = rpp.x - hitPos.x,
            dz = rpp.z - hitPos.z;
          const dsq = dx * dx + dz * dz;
          if (dsq < bestDsq) {
            bestDsq = dsq;
            bestProxy = rp;
          }
        }
        if (bestProxy) {
          const targetUserId = _remoteUserIdByProxy.get(bestProxy);
          if (targetUserId && matchSocket) {
            matchSocket.emit("match:hit-remote-player", {
              targetUserId,
              damage: tank.mgSystem.damage ?? 8,
              attackerPos: _pPos,
              shooterTeam: localTeam,
              shooterName: _localDisplayName,
              shooterUid: config.userId ?? "local",
            });
          }
          tank.turretController?.showHitMarker();
        }
        return;
      }

      if (hitEnemyTank) {
        const prevHits = _enemyHitCounts.get(hitEnemyTank) ?? 0;
        _enemyHitCounts.set(hitEnemyTank, prevHits + 1);

        if (!isHost && matchSocket && hitEnemyTank._aiKind) {
          matchSocket.emit("match:damage-ai", {
            id: hitEnemyTank._id,
            damage: tank.mgSystem.damage ?? 8,
            shooterName: _localDisplayName,
            shooterTeam: localTeam,
            shooterUid: config.userId ?? "local",
          });
        }
        tank.turretController?.showHitMarker();
      }
    };
  }

  // ── Rocket / special-gun (weapon slot 5) relay ───────────────────────────
  // Neither RocketSystem nor SpecialGunSystem ever had onHit wired here
  // before — that's why slot 5 was completely silent on impact. Mirrors
  // tank.bulletSystem.onHit's remote-player/AI relay, but picks the sound
  // based on which variant slot 5 actually is: normal rockets keep their
  // existing explosion sound on hit (launch sound — rocket.ogg — is
  // untouched, still played from audio.playRocket() in the onFire handler);
  // the special-gun variant instead plays the main-gun shot sound on hit.
  if (tank.cfg.enableRockets && tank.rocketSystem) {
    tank.rocketSystem.onHit = (hitPos, hitEnemyTank, appliedDamage) => {
      const _pPos = tank.rigidBody ? tank.rigidBody.translation() : null;
      const _hitDist =
        _pPos && hitPos
          ? Math.hypot(hitPos.x - _pPos.x, hitPos.z - _pPos.z)
          : 0;

      const _dmg =
        appliedDamage ??
        (tank.cfg.specialWeaponType === "gun"
          ? tank.cfg.specialGunDamage
          : tank.cfg.rocketDamage) ??
        60;

      _checkAmmoPointHit(hitPos, _dmg);

      let _didHitSomething = !!hitEnemyTank;

      // ── Direct AI hit already resolved inside bullet.js — just relay to
      // the host if this client is a guest.
      if (hitEnemyTank && !isHost && matchSocket && hitEnemyTank._aiKind) {
        matchSocket.emit("match:damage-ai", {
          id: hitEnemyTank._id,
          damage: _dmg,
          shooterName: _localDisplayName,
          shooterTeam: localTeam,
          shooterUid: config.userId ?? "local",
        });
      }

      // ── No direct AI hit — try a remote real player's proxy by proximity,
      // same radius/pattern as the main gun's own relay above.
      if (!hitEnemyTank && hitPos) {
        let bestProxy = null,
          bestDsq = 36; // 6m
        for (const [_rpUid, rp] of _remotePlayers.entries()) {
          if (!rp || !rp.active || rp.isDead || rp.team === localTeam) continue;
          if (!_remoteDeployed.get(_rpUid)) continue;
          const rpp = rp.bodyGroup.position;
          const dx = rpp.x - hitPos.x,
            dz = rpp.z - hitPos.z;
          const dsq = dx * dx + dz * dz;
          if (dsq < bestDsq) {
            bestDsq = dsq;
            bestProxy = rp;
          }
        }
        if (bestProxy) {
          _didHitSomething = true;
          const targetUserId = _remoteUserIdByProxy.get(bestProxy);
          if (targetUserId && matchSocket) {
            matchSocket.emit("match:hit-remote-player", {
              targetUserId,
              damage: _dmg,
              attackerPos: _pPos,
              shooterTeam: localTeam,
              shooterName: _localDisplayName,
              shooterUid: config.userId ?? "local",
            });
          }
        }
      }

      if (_didHitSomething) tank.turretController?.showHitMarker();

      // ── Impact sound only. The fire/shot sound for the "gun" variant is
      // already played once in the onFire() click handler at the moment
      // the weapon is fired — playing audio.playShot() again here (on hit)
      // made it sound like the special gun fired twice per shot.
      audio.playExplosion(_hitDist);
    };
  }

  // const audio = new AudioSystem();
  // audio.configure(
  //   config.tankSound ?? 'medium',
  //   config.fireSound ?? 1
  // );

  // HUD is hidden until the player clicks Start — shown in startBtn click handler below
  document.getElementById("health").style.display = "none";
  // document.getElementById('hud-fps-wrap').style.display = 'none';
  stats.dom.style.display = "none";
  document.getElementById("compass-bar").style.display = "none";
  document.getElementById("minimap").style.display = "none";
  document.getElementById("hud-speed").style.display = "none";
  document.getElementById("weapon-hud").style.display = "none";
  // document.getElementById('hud-kills').style.display    = 'none';
  cpMarkerContainer.style.display = "none";
  document.getElementById("currency-hud-wrap").style.display = "none"; // ← add this
  teammatesHud.style.display = "none";

  onShiftPress(() => {
    // Once the match has ended, controls are meant to stay locked — don't
    // let Shift flip the plane's forced autopilot back off, or the turret
    // back into free-aim mode.
    if (matchEnded) return;
    if (vehicleType === "plane" && plane) {
      plane.toggleAutopilot();
    } else {
      tank.turretController?.toggle();
    }
  });
  onMiddleClick(() => {
    if (vehicleType === "plane" && plane) {
      if (!plane.bombPoint) return; // this plane has no BombPoint — nothing to scope into
      if (scope.isScoped && scope.scopeMode === "bomb") {
        scope._exitScope();
      } else if (!scope.isScoped) {
        scope._enterScope("bomb");
      }
      return;
    }
    tank.turretController?.fixTarget();
  });

  // const bulletTrail = new BulletTrailSystem(scene);
  // tank.bulletSystem.setTrailSystem(bulletTrail);

  const _scopeGunPointWatcher = setInterval(() => {
    if (tank.turretController?.gunPoint) {
      scope.setGunPoint(tank.turretController.gunPoint);
      clearInterval(_scopeGunPointWatcher);
    }
  }, 100);

  const _scopeScopePointWatcher = setInterval(() => {
    // ← add
    if (tank.turretController?.scopePoint) {
      scope.setScopePoint(tank.turretController.scopePoint);
      clearInterval(_scopeScopePointWatcher);
    }
  }, 100);

  const _scopeBarrelWatcher = setInterval(() => {
    if (tank.turretController?.barrel) {
      scope.barrel = tank.turretController.barrel;
      clearInterval(_scopeBarrelWatcher);
    }
  }, 100);

  // ── Multiplayer: capture local turret/barrel refs + a fire counter that
  // increments every time this client actually fires, so remote clients
  // can trigger a muzzle-flash/tracer the instant it changes ─────────────
  let _localTurretMesh = null;
  let _localBarrelMesh = null;
  let _localFireSeq = 0;
  let _localMgFireSeq = 0; // ← NEW — see Issue 2b below
  let _localTurretWatcherHandle = null;

  // Re-resolves _localTurretMesh/_localBarrelMesh against the tank's CURRENT
  // bodyGroup contents. Must be re-run every time the tank's model is
  // rebuilt (every respawn/redeploy → tank.respawn() reloads a fresh GLB
  // with brand-new Turret/Barrel nodes) — otherwise these refs go stale and
  // freeze, so every OTHER client's proxy for this player stops rotating
  // its turret after the first respawn.
  function _startLocalTurretWatcher() {
    if (_localTurretWatcherHandle) clearInterval(_localTurretWatcherHandle);
    _localTurretMesh = null;
    _localBarrelMesh = null;
    _localTurretWatcherHandle = setInterval(() => {
      tank.bodyGroup.traverse((c) => {
        if (c.name === "Turret") _localTurretMesh = c;
        if (c.name === "Barrel") _localBarrelMesh = c;
      });
      if (_localTurretMesh && _localBarrelMesh) {
        clearInterval(_localTurretWatcherHandle);
        _localTurretWatcherHandle = null;
      }
    }, 200);
  }
  _startLocalTurretWatcher();

  const _scopeGunnerSightWatcher = setInterval(() => {
    // ← add
    if (tank.gunnerSightNode) {
      scope.setGunnerSightNode(tank.gunnerSightNode);
      clearInterval(_scopeGunnerSightWatcher);
    }
  }, 100);

  // ── Player health bar ─────────────────────────────────────────────────────
  const hudEl = document.getElementById("health");
  const playerHpBar = new HealthBar(tank.maxHealth);
  playerHpBar.mount(hudEl, {
    width: 300,
    svg: `<svg width="800px" height="800px" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M4.35009 13.3929L8 16L11.6499 13.3929C13.7523 11.8912 15 9.46667 15 6.88306V3L8 0L1 3V6.88306C1 9.46667 2.24773 11.8912 4.35009 13.3929Z" fill="#ffffff8f"/>
</svg>`,
  });

  // playerHpBar.setArmor(tank.armour, tank.armour);

  // const enemyHpContainer = document.createElement("div");
  // enemyHpContainer.style.cssText = `
  //   position:fixed; top:16px; right:16px;
  //   pointer-events:none;
  //   font-family:monospace; font-size:12px; color:#b8d888;
  // `;
  // document.body.appendChild(enemyHpContainer);

  // ── Hit direction indicator — radial arc, zero per-frame cost, CSS-driven ──
  const HIT_RING_SIZE = 300; // px — overlay square size
  const HIT_RING_RADIUS = 130; // svg units
  const HIT_ARC_DEG = 46; // degrees of arc sweep
  const HIT_ARC_POOL = 5; // simultaneous fade-cycles supported

  const _svgNS = "http://www.w3.org/2000/svg";
  const hitSvg = document.createElementNS(_svgNS, "svg");
  hitSvg.setAttribute("viewBox", "0 0 300 300");
  hitSvg.setAttribute("width", HIT_RING_SIZE);
  hitSvg.setAttribute("height", HIT_RING_SIZE);
  hitSvg.style.cssText = `
  position:fixed; top:50%; left:50%;
  width:${HIT_RING_SIZE}px; height:${HIT_RING_SIZE}px;
  margin:-${HIT_RING_SIZE / 2}px 0 0 -${HIT_RING_SIZE / 2}px;
  pointer-events:none; z-index:150; overflow:visible;
`;
  document.body.appendChild(hitSvg);

  const HIT_CIRCUM = 2 * Math.PI * HIT_RING_RADIUS;
  const HIT_ARC_LEN = HIT_CIRCUM * (HIT_ARC_DEG / 360);

  const _hitArrows = [];
  for (let i = 0; i < HIT_ARC_POOL; i++) {
    const g = document.createElementNS(_svgNS, "g");
    g.setAttribute("transform", "rotate(0 150 150)");
    g.style.opacity = "0";

    const circle = document.createElementNS(_svgNS, "circle");
    circle.setAttribute("cx", 150);
    circle.setAttribute("cy", 150);
    circle.setAttribute("r", HIT_RING_RADIUS);
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", "rgba(255,30,20,0.95)");
    circle.setAttribute("stroke-width", 11);
    circle.setAttribute("stroke-linecap", "round");
    circle.setAttribute(
      "stroke-dasharray",
      `${HIT_ARC_LEN} ${HIT_CIRCUM - HIT_ARC_LEN}`,
    );
    circle.setAttribute("stroke-dashoffset", -HIT_ARC_LEN / 2);
    circle.style.filter = "drop-shadow(0 0 10px rgba(255,20,10,0.9))";

    g.appendChild(circle);
    hitSvg.appendChild(g);
    _hitArrows.push({ g, busy: false, timer: null });
  }

  const _hitFwd = new THREE.Vector3();

  /** Flash a glowing arc on the ring toward attackerPos, then fade it out. */
  function showHitIndicator(attackerPos) {
    if (!attackerPos || !tank.rigidBody) return;

    const pPos = tank.rigidBody.translation();
    const dx = attackerPos.x - pPos.x;
    const dz = attackerPos.z - pPos.z;
    if (dx * dx + dz * dz < 0.01) return; // hit at own position — no direction to show

    // Player's current forward heading — same convention as the compass bar
    tank.bodyGroup.getWorldDirection(_hitFwd);
    const playerYaw = Math.atan2(_hitFwd.x, _hitFwd.z);
    const attackerYaw = Math.atan2(dx, dz);
    // 0deg = directly ahead, increases clockwise as attacker moves to the right
    const relAngleDeg =
      (((((playerYaw - attackerYaw) * 180) / Math.PI) % 360) + 225) % 360;

    let slot = _hitArrows.find((s) => !s.busy) ?? _hitArrows[0];
    if (slot.timer) clearTimeout(slot.timer);
    slot.busy = true;

    slot.g.style.transition = "none";
    slot.g.setAttribute("transform", `rotate(${relAngleDeg - 90} 150 150)`);
    slot.g.style.opacity = "1";

    void slot.g.getBoundingClientRect(); // force reflow so the fade below actually animates
    slot.g.style.transition = "opacity 0.9s ease-out";
    slot.g.style.opacity = "0";

    slot.timer = setTimeout(() => {
      slot.busy = false;
    }, 950);
  }

  // ── Low-health vignette — persistent, intensifies as the active
  // vehicle's health drops. Uses the same damage_effect.png as the flash,
  // but masked to only show at the screen edges (radial-gradient mask)
  // and driven by health fraction rather than being a one-shot flash.
  const damageVignetteEl = document.createElement("div");
  damageVignetteEl.style.cssText = `
    position:fixed; inset:0; z-index:148;
    background-image:url('/textures/damage_effect.png');
    background-size:cover; background-position:center;
    pointer-events:none; opacity:0;
    -webkit-mask-image: radial-gradient(ellipse at center, transparent 40%, black 100%);
    mask-image: radial-gradient(ellipse at center, transparent 40%, black 100%);
    transition: opacity 0.4s ease;
  `;
  document.body.appendChild(damageVignetteEl);

  const DAMAGE_VIGNETTE_START_FRACTION = 0.5; // starts appearing below this health fraction
  const DAMAGE_VIGNETTE_MAX_OPACITY = 0.75;   // opacity at 0 health
  let _lastVignetteOpacityKey = ""; // dedup — avoid writing the DOM every frame for no change

  /** Updates the low-health vignette's opacity from the given health
   * fraction (0..1). Call every frame with whichever vehicle is active. */
  function updateDamageVignette(healthFraction) {
    let targetOpacity = 0;
    if (healthFraction < DAMAGE_VIGNETTE_START_FRACTION) {
      const t = 1 - healthFraction / DAMAGE_VIGNETTE_START_FRACTION; // 0 at threshold → 1 at zero hp
      targetOpacity = t * DAMAGE_VIGNETTE_MAX_OPACITY;
    }
    const key = targetOpacity.toFixed(2);
    if (key === _lastVignetteOpacityKey) return;
    _lastVignetteOpacityKey = key;
    damageVignetteEl.style.opacity = key;
  }

  // ── Damage flash overlay — full-screen damage_effect.png, flashed
  // briefly whenever the LOCAL player (tank or plane) takes a hit from an
  // enemy. Pure opacity fade, CSS-driven — same zero-per-frame-cost pattern
  // as the hit-direction ring/vignette above.
  const damageFlashEl = document.createElement("div");
  damageFlashEl.style.cssText = `
    position:fixed; inset:0; z-index:149;
    background-image:url('/textures/damage_effect.png');
    background-size:cover; background-position:center;
    pointer-events:none; opacity:0;
  `;
  document.body.appendChild(damageFlashEl);

  let _damageFlashTimer = null;

  /** Flashes the full-screen damage overlay, then fades it out. Safe to
   * call rapidly (e.g. a burst of MG hits) — each call restarts the fade
   * from full opacity instead of stacking. */
  function showDamageFlash() {
    if (_damageFlashTimer) clearTimeout(_damageFlashTimer);

    damageFlashEl.style.transition = "none";
    damageFlashEl.style.opacity = "0.85";

    void damageFlashEl.getBoundingClientRect(); // force reflow so the fade below actually animates

    damageFlashEl.style.transition = "opacity 0.6s ease-out";
    damageFlashEl.style.opacity = "0";

    _damageFlashTimer = setTimeout(() => {
      _damageFlashTimer = null;
    }, 620);
  }

  // ── Destruction shockwave — a brief white-hot flash that burns off into
  // a dark radial ring, played ONCE at the moment the LOCAL player's own
  // vehicle is actually destroyed (not on every hit — showDamageFlash
  // above handles regular hits). Pure CSS opacity/scale animation, same
  // zero-per-frame-cost pattern as the other overlays here.
  // ── Destruction blur — a full-screen "frosted glass" overlay that
  // fades in uniformly the instant the LOCAL player's own vehicle is
  // destroyed. Uses backdrop-filter so it blurs EVERYTHING underneath —
  // the 3D canvas AND any HUD elements — not just the WebGL canvas. Pure
  // opacity fade, no transform/scale, so nothing visually "grows" from
  // the center; the whole screen just softens into blur in place.
  const deathBlurEl = document.createElement("div");
  deathBlurEl.style.cssText = `
    position:fixed; inset:0; z-index:152;
    pointer-events:none; opacity:0;
    background: rgba(10,8,6,0.25);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    transition: opacity 1.1s ease-out;
  `;
  document.body.appendChild(deathBlurEl);

  /** Fades in the full-screen destruction blur, timed to land on the
   * exact moment the player's own vehicle dies. */
  function triggerDeathShockwave() {
    deathBlurEl.style.opacity = "1";
  }

  /** Clears the destruction blur — call when a fresh life begins
   * (spawn-selection screen, respawn). */
  function clearDeathBlur() {
    deathBlurEl.style.opacity = "0";
  }

  const audio = new AudioSystem();
  audio.configure(config.tankSound ?? "medium", config.fireSound ?? 1);
  audio._muted = true; // stay silent until Start is clicked

  audio.configurePlaneSound(_planePreset?.config?.planeSound ?? "light");

  // ── Track decals (dirt trail) ──────────────────────────────────────────────
  const trackDecalSystem = new TrackDecalSystem(
    scene,
    "/tread_normal.png",
    mapDef.dustColor ?? config.dustColor ?? 0x333333,
  );

  // ── Ammo Refill Points ────────────────────────────────────────────────────
  const ammoPointSystem = new AmmoPointSystem(
    scene,
    world,
    mapDef.ammoPoints ?? [],
    getTerrainY,
    "/ammo_crate.glb",
  );

  // Add minimap dots once minimap is ready
  ammoPointSystem.addMinimapDots(worldToMinimap, minimapEnemyEl);

  // ── Destructible ammo points / capture points ────────────────────────────
  const AMMO_POINT_HIT_RADIUS = 3.5; // metres — how close a shot/bomb impact must land to damage a crate
  const CAPTURE_POINT_BOMB_RESET_HP = 500; // total cumulative bomb damage needed to reset an enemy-held point to neutral

  // Called from any weapon's onHit callback (tank or plane, shoot or bomb).
  // Destroys the nearest active ammo crate within range of the impact.
  function _checkAmmoPointHit(hitPos, damage = 25) {
    if (!hitPos) return;
    const result = ammoPointSystem.notifyHit(hitPos, damage, AMMO_POINT_HIT_RADIUS);
    if (!result) return;

    const cp = result.point.colliderWorldPos;
    if (result.destroyed) {
      tank.bulletSystem?.explosionSystem?.spawn(
        new THREE.Vector3(cp.x, cp.y, cp.z),
      );
      audio.playExplosion();
    } else {
      // Took damage but survived — a small spark instead of a full
      // explosion, so repeated MG fire doesn't spam explosion sounds.
      tank.bulletSystem?.explosionSystem?.spawnSpark(
        new THREE.Vector3(cp.x, cp.y, cp.z),
      );
    }
  }

  // Actually flips a capture point back to neutral — HOST ONLY, mirrors the
  // ownership-mutation pattern used everywhere else in the capture-point
  // logic (see the isHost-gated block in loop()).
  function _resetCapturePointToNeutral(p) {
    if (p.owner === "neutral") return;
    const vacatedTeam = p.owner;
    p.owner = "neutral";
    p.captureTimer = 0;
    p.capturingBy = null;
    p._playerContributed = false;
    p.bombDamage = 0; // fresh tally — next side to hold it starts clean

    if (vacatedTeam === localTeam) {
      playerCaptures = Math.max(0, playerCaptures - 1);
      document.getElementById("score-player").textContent = playerCaptures;
      document.getElementById("end-player-cap").textContent = playerCaptures;
    } else {
      enemyCaptures = Math.max(0, enemyCaptures - 1);
      document.getElementById("score-enemy").textContent = enemyCaptures;
      document.getElementById("end-enemy-cap").textContent = enemyCaptures;
    }

    _setCPColor(p);
    _updateMinimapCPDot(p);
  }

  // HOST ONLY — accumulates bomb damage on a capture point's tally and
  // resets it to neutral once CAPTURE_POINT_BOMB_RESET_HP total damage has
  // landed on it. The tally itself only ever lives on the host; guests
  // just report raw hits (see the socket relay below) and let the host
  // decide when the threshold is crossed.
  function _applyCapturePointBombDamage(p, damage) {
    p.bombDamage = (p.bombDamage ?? 0) + damage;
    if (p.bombDamage >= CAPTURE_POINT_BOMB_RESET_HP) {
      _resetCapturePointToNeutral(p);
    }
  }

  // Called ONLY from a bomb's onHit callback. If the bomb landed within a
  // capture point's radius and that point is owned by the OPPOSING team
  // relative to shooterTeam, applies its damage toward that point's reset
  // tally. Bombing your own team's point, or a neutral one, does nothing.
  function _checkCapturePointBombReset(hitPos, shooterTeam, damage = 140) {
    if (!hitPos || typeof shooterTeam !== "number") return;

    for (const p of CAPTURE_POINTS) {
      const dx = p.x - hitPos.x;
      const dy = p.y - hitPos.y;
      const dz = p.z - hitPos.z;
      const dsq = dx * dx + dy * dy + dz * dz;
      if (dsq > CAPTURE_RADIUS * CAPTURE_RADIUS) continue;
      if (p.owner === "neutral" || p.owner === shooterTeam) continue;

      if (isHost) {
        _applyCapturePointBombDamage(p, damage);
      } else if (matchSocket) {
        // CAPTURE_POINTS ownership (and its bomb-damage tally) is
        // host-authoritative — relay the raw hit, same pattern as
        // match:damage-ai.
        matchSocket.emit("match:bomb-capture-point", {
          id: p.id,
          shooterTeam,
          damage,
        });
      }

      tank.bulletSystem?.explosionSystem?.spawn(
        new THREE.Vector3(p.x, p.y, p.z),
      );
      audio.playExplosion();
      break; // one bomb only ever affects the single point it lands on
    }
  }

  // ── ONE POOL PER TEAM, not "enemy" vs "friendly" — friendliness to any
  // given viewer is now computed by comparing .team, not by which pool a
  // unit lives in. team1Pool / team2Pool both use EnemyTankPool as the
  // implementation (there's nothing "friendly-specific" left in it — it's
  // just "an AI tank pool tagged with a team").
  //
  // onHitPlayer for BOTH pools shares the same team-relative logic: look at
  // who got hit, resolve their real team (1 or 2), and apply damage/credit
  // however that team relates to whoever's driving locally / whichever
  // remote player owns the victim proxy.
  function _makeTeamHitHandler(shooterTeam) {
    return (
      incomingDamage,
      combatTarget,
      distance = 0,
      attackerPos = null,
      shooterUnit = null,
    ) => {
      const damage = incomingDamage ?? 25;
      if (shooterUnit) _registerEntityStableId(shooterUnit);
      const shooterDesc = shooterUnit ? _describeKillEntity(shooterUnit) : null;

      const _remoteTankRef = combatTarget?.tankRef;
      if (_remoteTankRef?.isRemotePlayer) {
        const targetUserId = _remoteUserIdByProxy.get(_remoteTankRef);
        if (targetUserId && matchSocket) {
          matchSocket.emit("match:hit-remote-player", {
            targetUserId,
            damage,
            attackerPos,
            shooterTeam,
            shooterStableId:
              shooterDesc?.kind === "ai" ? shooterDesc.stableId : null,
            shooterName:
              shooterDesc?.kind === "player" ? shooterDesc.name : null,
          });
        }
        audio.playExplosion(distance);
        return;
      }

      // ── Hit an AI unit (not the local player, not a remote player) ──────
      if (combatTarget && !combatTarget.isPlayer && combatTarget.tankRef) {
        const victim = combatTarget.tankRef;
        // Kill-credit label stays coarse ('enemy'/'friendly') for the
        // EXISTING kill-feed code below, which still reads _lastHitBy as a
        // string — but the meaning is now "relative to the victim's own
        // team", i.e. 'enemy' always means "a unit not on the victim's
        // team hit it", regardless of which absolute team numbers are involved.
        victim._lastHitBy = shooterTeam === victim.team ? "friendly" : "enemy";
        victim._lastHitByPos = attackerPos;
        victim._lastHitByUnit = shooterUnit ?? null;
        victim.takeDamage(damage);
        audio.playExplosion(distance);
        return;
      }

      // ── Hit the LOCAL real player — only apply if the shooter is actually
      // on the opposing team relative to the local player. (AI pools only
      // ever call onHitPlayer when their own _findCombatTarget() already
      // filtered by team, so in practice this is always opposing-team fire
      // reaching the local player — but the guard is cheap insurance.)
      if (shooterTeam === localTeam) return;

      // ── Spawn a hit-impact particle at the PLAYER's own current position —
      // the raycast-driven spark inside bullet.js/MachineGunSystem only
      // fires when the shooter's raycast happens to physically connect,
      // which is a separate (and often misaligned) check from whether
      // damage was actually applied here. Spawning explicitly at the point
      // of damage guarantees the player always sees an effect when hit.
      const _hitVehiclePos =
        vehicleType === "plane" && plane?.rigidBody
          ? plane.rigidBody.translation()
          : tank.rigidBody?.translation();
      if (_hitVehiclePos) {
        tank.bulletSystem.explosionSystem?.spawnSpark(_hitVehiclePos);
      }

      if (vehicleType === "plane" && plane) {
        plane.takeDamage(damage);
        playerHpBar.setHealth(plane.health);
      } else {
        tank.takeDamage(damage);
        playerHpBar.setHealth(tank.health);
      }

      _playerLastHitBy = "enemy";
      _playerLastAttackerPos = attackerPos;

      // ── Fully overwrite killer identity on EVERY hit — never leave
      // stale explicit-name/stableId data from an earlier, non-fatal hit
      // lingering into a later kill landed by a DIFFERENT shooter (this is
      // what caused "client killed host" to show even when a friendly AI
      // of the client's team actually landed the final blow).
      if (shooterDesc?.kind === "player") {
        _playerLastHitByExplicitName = shooterDesc.name ?? null;
        _playerLastHitByShooterUid = shooterDesc.uid ?? null;
        _playerLastHitByStableId = null;
        _playerLastHitByStableTeam = null;
      } else if (shooterDesc?.kind === "ai") {
        _playerLastHitByExplicitName = null;
        _playerLastHitByShooterUid = null;
        _playerLastHitByStableId = shooterDesc.stableId ?? null;
        _playerLastHitByStableTeam = shooterDesc.team ?? shooterTeam;
      } else {
        _playerLastHitByExplicitName = null;
        _playerLastHitByShooterUid = null;
        _playerLastHitByStableId = null;
        _playerLastHitByStableTeam = null;
      }

      if (vehicleType === "plane" && plane) {
        audio.playPlaneImpact();
      } else {
        audio.playImpact();
      }
      audio.playExplosion();
      showHitIndicator(attackerPos);
      showDamageFlash();
    };
  }

  // AI (non-player) spawn points, per team — these feed team1Pool/team2Pool
  // directly (see EnemyTankPool's spawnPoints option), independent of the
  // PLAYER spawn points above. Falls back to a small offset from the
  // player's own team spawn if the map doesn't define these.
  // NOTE: mapDef.enemySpawnPoints / friendlySpawnPoints are LEGACY field
  // names from the pre-team-refactor schema (kept so old maps.json files
  // still load), but their semantics were always "the AI faction that
  // isn't the host's own squad" (enemySpawnPoints) vs "the host's own AI
  // squad" (friendlySpawnPoints) — i.e. relative to team 1 specifically,
  // NOT an absolute team1/team2 mapping. Map authors should migrate to the
  // explicit team1AiSpawnPoints/team2AiSpawnPoints fields going forward.
  const AI_SPAWN_POINTS_TEAM1 = mapDef.team1AiSpawnPoints ??
    mapDef.friendlySpawnPoints ?? [
      {
        x: TEAM1_TANK_SPAWNS[0]?.x ?? INITIAL_SPAWN_POS.x,
        z: TEAM1_TANK_SPAWNS[0]?.z ?? INITIAL_SPAWN_POS.z,
      },
    ];
  const AI_SPAWN_POINTS_TEAM2 = mapDef.team2AiSpawnPoints ??
    mapDef.enemySpawnPoints ?? [
      {
        x: TEAM2_TANK_SPAWNS[0]?.x ?? INITIAL_SPAWN_POS.x + 15,
        z: TEAM2_TANK_SPAWNS[0]?.z ?? INITIAL_SPAWN_POS.z + 10,
      },
    ];

  const team1Pool = new EnemyTankPool(scene, world, terrainBuilder, {
    team: 1,
    isPlayerTeam: localTeam === 1, // ← ADD
    engageAiPlanes: TANKS_ENGAGE_AI_PLANES,
    maxTanks: aiPlayersEnabled
      ? config.friendlySquadEnabled
        ? _team1AiBaseline.tankBaseline
        : 0
      : 0,
    playerTank: tank,
    bulletSystem: tank.bulletSystem,
    explosionSystem: tank.bulletSystem.explosionSystem,
    audioSystem: audio,
    spawnInterval: mapDef.enemySpawnInterval ?? 15,
    navGrid,
    spawnPoints: AI_SPAWN_POINTS_TEAM1,
    capturePoints: CAPTURE_POINTS,
    onHitPlayer: _makeTeamHitHandler(1),
    onMuzzleFlash: (origin) => {
      tank.bulletSystem.explosionSystem?.spawnMuzzleFlash(origin);
      grassPool.addImpact(origin.x, origin.z);
    },
    tanksDataPath: "/enemytanks.json",
  });

  const team2Pool = new EnemyTankPool(scene, world, terrainBuilder, {
    team: 2,
    isPlayerTeam: localTeam === 2,
    engageAiPlanes: TANKS_ENGAGE_AI_PLANES,
    maxTanks: aiPlayersEnabled
      ? config.friendlySquadEnabled
        ? _team2AiBaseline.tankBaseline
        : isSquadMultiplayer
          ? 0
          : 4
      : 0,
    playerTank: tank,
    bulletSystem: tank.bulletSystem,
    explosionSystem: tank.bulletSystem.explosionSystem,
    audioSystem: audio,
    spawnInterval: mapDef.friendlySpawnInterval ?? 15,
    navGrid,
    spawnPoints: AI_SPAWN_POINTS_TEAM2,
    capturePoints: CAPTURE_POINTS,
    onHitPlayer: _makeTeamHitHandler(2),
    onMuzzleFlash: (origin) => {
      tank.bulletSystem.explosionSystem?.spawnMuzzleFlash(origin);
      grassPool.addImpact(origin.x, origin.z);
    },
    tanksDataPath: "/enemytanks.json",
  });

  // ── Backward-compat aliases — a LOT of downstream code in this file
  // still says `enemyPool`/`friendlyPool` meaning "the team I'm NOT on" /
  // "the team I AM on". Since localTeam is fixed per client, these aliases
  // let the rest of the file keep working almost unchanged: they just point
  // at whichever real pool corresponds to "my team" vs "the other team".
  // (True multi-team-relative code — e.g. AI targeting — never uses these
  // aliases; it uses team1Pool/team2Pool + allCandidates directly.)
  const friendlyPool = localTeam === 1 ? team1Pool : team2Pool;
  const enemyPool = localTeam === 1 ? team2Pool : team1Pool;

  // ── Remote-player choice tracking — for EVERY real player, on ANY
  // team (this now applies uniformly whether that player is on the
  // local player's own team or the opposing team, unlike the old
  // "only handles teams != localTeam" version, since same-team remote
  // players now also need their choice tracked for Case B — see
  // _computeTeamAiTargets). Called from the match:state handler
  // (host only — see Change 6).
  //
  // `deployed` gates this the same way the old code did: don't resolve
  // a real player's target-occupying type off a not-yet-deployed
  // default/placeholder vehicleType, only their real post-Deploy choice.
  function _applyRemotePlayerVehicleState(
    userId,
    team,
    vType,
    deployed,
    isDead,
  ) {
    if (!isHost || !config.friendlySquadEnabled || !aiPlayersEnabled) return;
    // Only a genuine, completed deploy updates the reserved slot's type —
    // dying/respawning leaves the last deployed choice in place (see the
    // seeding comment above for why), and a not-yet-deployed placeholder
    // vehicleType must never be trusted.
    if (!deployed) return;
    _setRealPlayerVehicleChoice(team, userId, vType);
  }

  tank.turretController?.setEnemyPool(enemyPool);
  tank.turretController?.setFriendlyPool(friendlyPool);

  // ── Enemy / friendly AI planes ─────────────────────────────────────────────
  function _makeTeamPlaneHitHandler(shooterTeam) {
    return (
      incomingDamage,
      combatTarget,
      distance = 0,
      attackerPos = null,
      shooterUnit = null,
    ) => {
      const damage = incomingDamage ?? 8;

      if (shooterUnit) _registerEntityStableId(shooterUnit);
      const shooterDesc = shooterUnit ? _describeKillEntity(shooterUnit) : null;

      const _remoteTankRef = combatTarget?.tankRef;
      if (_remoteTankRef?.isRemotePlayer) {
        const targetUserId = _remoteUserIdByProxy.get(_remoteTankRef);
        if (targetUserId && matchSocket) {
          matchSocket.emit("match:hit-remote-player", {
            targetUserId,
            damage,
            attackerPos,
            shooterTeam,
            shooterStableId:
              shooterDesc?.kind === "ai" ? shooterDesc.stableId : null,
            shooterName:
              shooterDesc?.kind === "player" ? shooterDesc.name : null,
          });
        }
        audio.playExplosion(distance);
        return;
      }

      if (combatTarget?.tankRef && !combatTarget.isPlayer) {
        const victim = combatTarget.tankRef;
        victim._lastHitBy = shooterTeam === victim.team ? "friendly" : "enemy";
        victim._lastHitByPos = attackerPos;
        victim._lastHitByUnit = shooterUnit ?? null;
        victim.takeDamage(damage);
        audio.playExplosion(distance);
        return;
      }

      if (shooterTeam === localTeam) return;

      const _hitVehiclePos =
        vehicleType === "plane" && plane?.rigidBody
          ? plane.rigidBody.translation()
          : tank.rigidBody?.translation();
      if (_hitVehiclePos) {
        tank.bulletSystem.explosionSystem?.spawnSpark(_hitVehiclePos);
      }

      if (vehicleType === "plane" && plane) {
        plane.takeDamage(damage);
        playerHpBar.setHealth(plane.health);
      } else {
        tank.takeDamage(damage);
        playerHpBar.setHealth(tank.health);
      }

      _playerLastHitBy = "enemy";
      _playerLastAttackerPos = attackerPos;

      // ── Same fix as _makeTeamHitHandler — fully overwrite killer
      // identity on every hit so a later kill by a different attacker
      // can't inherit stale explicit-name/stableId data.
      if (shooterDesc?.kind === "player") {
        _playerLastHitByExplicitName = shooterDesc.name ?? null;
        _playerLastHitByShooterUid = shooterDesc.uid ?? null;
        _playerLastHitByStableId = null;
        _playerLastHitByStableTeam = null;
      } else if (shooterDesc?.kind === "ai") {
        _playerLastHitByExplicitName = null;
        _playerLastHitByShooterUid = null;
        _playerLastHitByStableId = shooterDesc.stableId ?? null;
        _playerLastHitByStableTeam = shooterDesc.team ?? shooterTeam;
      } else {
        _playerLastHitByExplicitName = null;
        _playerLastHitByShooterUid = null;
        _playerLastHitByStableId = null;
        _playerLastHitByStableTeam = null;
      }

      if (vehicleType === "plane" && plane) {
        audio.playPlaneImpact();
      } else {
        audio.playImpact();
      }
      audio.playExplosion();
      showHitIndicator(attackerPos);
      showDamageFlash();
    };
  }

  const team1PlanePool = new EnemyPlanePool(scene, world, terrainBuilder, {
    team: 1,
    onTreeCollision: onPlaneTreeCollision,
    maxPlanes: aiPlayersEnabled
      ? config.friendlySquadEnabled
        ? _team1AiBaseline.planeBaseline
        : 0
      : 0,
    playerVehicle: tank,
    explosionSystem: tank.bulletSystem.explosionSystem,
    audioSystem: audio,
    spawnInterval: mapDef.enemyPlaneSpawnInterval ?? 30,
    initialSpawnDelay: 8,
    // ── Full roster — each spawned AI plane independently rolls a random
    // entry from planes.json (see EnemyPlanePool.trySpawn()), instead of
    // every plane in this pool being forced to the single _planePreset
    // (which describes only the LOCAL PLAYER's own selection).
    planeDefs: _allPlaneDefs.length ? _allPlaneDefs : null,
    // Legacy single-preset fallback fields — only used if planeDefs is empty/unavailable.
    fireSound: _planePreset?.config?.fireSound ?? 1,
    hullHalfExtents: _planePreset?.config?.hullHalfExtents,
    colliderYOffset: _planePreset?.config?.colliderYOffset,
    gunType: _planePreset?.config?.gunType ?? 1,
    gunDamage:
      _planePreset?.config?.gunDamage ?? _planePreset?.config?.mgDamage ?? 20,
    multiGunFireRate: _planePreset?.config?.fireRate ?? undefined,
    modelScale: _planePreset?.config?.modelScale,
    damageEffect: _planePreset?.config?.damageEffect,
    getTerrainY,
    onMuzzleFlash: (origin) => {
      tank.bulletSystem.explosionSystem?.spawnMuzzleFlash(origin);
    },
    onHitPlayer: _makeTeamPlaneHitHandler(1),
  });

  const team2PlanePool = new EnemyPlanePool(scene, world, terrainBuilder, {
    team: 2,
    onTreeCollision: onPlaneTreeCollision,
    maxPlanes: aiPlayersEnabled
      ? config.friendlySquadEnabled
        ? _team2AiBaseline.planeBaseline
        : isSquadMultiplayer
          ? 0
          : 2
      : 0,
    playerVehicle: tank,
    explosionSystem: tank.bulletSystem.explosionSystem,
    audioSystem: audio,
    spawnInterval: mapDef.friendlyPlaneSpawnInterval ?? 30,
    initialSpawnDelay: 4,
    planeDefs: _allPlaneDefs.length ? _allPlaneDefs : null,
    fireSound: _planePreset?.config?.fireSound ?? 1,
    hullHalfExtents: _planePreset?.config?.hullHalfExtents,
    colliderYOffset: _planePreset?.config?.colliderYOffset,
    gunType: _planePreset?.config?.gunType ?? 1,
    gunDamage:
      _planePreset?.config?.gunDamage ?? _planePreset?.config?.mgDamage ?? 20,
    multiGunFireRate: _planePreset?.config?.fireRate ?? undefined,
    modelScale: _planePreset?.config?.modelScale,
    damageEffect: _planePreset?.config?.damageEffect,
    getTerrainY,
    onMuzzleFlash: (origin) => {
      tank.bulletSystem.explosionSystem?.spawnMuzzleFlash(origin);
    },
    onHitPlayer: _makeTeamPlaneHitHandler(2),
  });

  // ── Same backward-compat aliasing pattern as the tank pools above ──────
  const friendlyPlanePool = localTeam === 1 ? team1PlanePool : team2PlanePool;
  const enemyPlanePool = localTeam === 1 ? team2PlanePool : team1PlanePool;

  _aiPoolsReady = true; // safe to query friendly AI pools/markers from here on

  // ── Applies a team's current AI targets (from _computeTeamAiTargets)
  // directly to that team's real pools. HOST ONLY — only the host's pool
  // instances actually simulate/spawn AI (pool.update() is isHost-gated
  // in the main loop); calling setMaxTanks/setMaxPlanes on a guest's own
  // local (non-ticking) pool objects would just create invisible "ghost"
  // units with colliders that never sync to a visible mesh (same failure
  // mode already called out in confirmSpawnSelection()'s comments).
  function _applyTeamAiTargets(team) {
    if (!isHost) return;
    const targets = _computeTeamAiTargets(team);
    const tankPool = team === 1 ? team1Pool : team2Pool;
    const planePool = team === 1 ? team1PlanePool : team2PlanePool;

    if (team === 1) _team1AiBaseline = targets;
    else _team2AiBaseline = targets;

    tankPool.setMaxTanks?.(targets.tankBaseline);
    planePool.setMaxPlanes?.(targets.planeBaseline);
  }

  // ── Records a real player's current vehicle choice for their team and
  // re-applies that team's AI targets. Call this any time a real
  // player's LIVE, DEPLOYED vehicle type becomes known or changes:
  //   - locally, right after this client's own deploy completes
  //   - remotely, from an incoming match:state packet (host only)
  //   - and cleared (see _clearRealPlayerVehicleChoice) the moment a
  //     real player's vehicle is destroyed, so their reserved slot opens
  //     back up for AI (or for themselves) to claim.
  function _setRealPlayerVehicleChoice(team, userId, vType) {
    const choices = _realPlayerVehicleChoice.get(team);
    if (!choices) return;
    if (choices.get(userId) === vType) return; // no change — skip redundant pool calls
    choices.set(userId, vType);
    _applyTeamAiTargets(team);
  }

  // ── Friendly-plane markers — one instanced draw call, works identically
  // on host (real EnemyPlane instances) and guest (RemotePlayerPlane
  // proxies), since both expose .bodyGroup/.isDead and are reachable the
  // same way friendlyPosCache/refreshFriendlyPlaneLastKnownPos already do.
  const friendlyPlaneMarkers = new FriendlyPlaneMarkerSystem(scene);
  const friendlyTankMarkers = new FriendlyTankMarkerSystem(scene);

  // ══════════════════════════════════════════════════════════════════════
  //  MULTIPLAYER — remote player sync
  // ══════════════════════════════════════════════════════════════════════
  // isSquadMultiplayer / isHost were already computed near the top of init()
  let matchSocket = null;
  const _remotePlayers = new Map(); // userId -> RemotePlayerTank | RemotePlayerPlane | null (reserved)
  const _remoteVehicleType = new Map(); // userId -> 'tank' | 'plane'
  const _remoteUserIdByProxy = new Map(); // proxy -> userId, for damage relay back to that guest
  const _remoteDeployed = new Map(); // userId -> bool — true only once that guest has actually deployed a live vehicle (mirrors _isCurrentlyDeployed, but for remote players)
  const NET_SEND_INTERVAL = 1 / 15;
  let _netSendTimer = 0;

  // ── AI sync — only the HOST runs enemy/friendly AI simulation. Every
  // other client renders visual-only proxies driven entirely by the
  // host's broadcast, keyed by each unit's own `_id` so respawns (which
  // regenerate `_id`) are treated as a fresh unit and the old proxy is
  // cleaned up automatically. ─────────────────────────────────────────
  const _remoteAIUnits = new Map(); // composite "kind:id" -> RemotePlayerTank | RemotePlayerPlane | null (reserved)
  const AI_NET_SEND_INTERVAL = 1 / 8;
  let _aiNetSendTimer = 0;

  // ── unit._id is only unique WITHIN the pool that minted it — team1Pool,
  // team2Pool, team1PlanePool, and team2PlanePool each run their own
  // internal counter, so two units from DIFFERENT pools can legitimately
  // share the same numeric id. Keying _remoteAIUnits by id alone let a
  // same-id collision across pools silently collapse into a single proxy:
  // the guest kept whichever unit's model loaded first, but its position
  // kept getting overwritten by whichever unit's packet landed on top.
  // That's the "right position, wrong tank" bug. kind+id together are
  // always unique since kind already encodes which pool the unit is from.
  function _aiUnitKey(u) {
    return `${u.kind}:${u.id}`;
  }

  async function _spawnRemoteTank(userId, playerName, tankId, team = 1) {
    if (_remotePlayers.has(userId)) return;
    _remotePlayers.set(userId, null); // reserve slot against a race from a fast second packet

    let tanksData = [];
    try {
      const r = await fetch("/tanks.json");
      if (r.ok) tanksData = await r.json();
    } catch (err) {
      console.warn(
        "[Multiplayer] Failed to load tanks.json for remote player:",
        err,
      );
    }
    const tankDef = tanksData.find((t) => t.id === tankId) ??
      tanksData[0] ?? { modelPath: "/model/Tank_Tiger_L.glb", config: {} };

    const trackCfg = _buildTrackCfgFromDef(tankDef);
    const { loadModel } = await import("./modelLoader.js");
    const template = await loadModel(
      tankDef.modelPath ?? "/model/Tank_Tiger_L.glb",
    );

    const rt = new RemotePlayerTank(scene, world);
    rt.activate(
      { x: 0, y: -500, z: 0 },
      trackCfg,
      Promise.resolve(template),
      tank.bulletSystem?.explosionSystem ?? null,
      tankDef,
      playerName,
      team,
    );
    rt._audioSystem = audio; // ← ADD — without this, a real remote teammate/opponent's
    //   tank never gets an engine loop either (same root cause
    //   as the AI-unit fix in RemotePlayerTank.update())
    _remotePlayers.set(userId, rt);
    _remoteVehicleType.set(userId, "tank");
    _remoteUserIdByProxy.set(rt, userId);
    // Track every real human seen this match (either side) so the
    // end-of-match chart can list them, and so kill descriptors always
    // resolve their real name regardless of team.
    _registerRealPlayer(userId, playerName, team);
    if (team === localTeam) _knownTeammateNames.add(playerName);
  }

  async function _spawnRemotePlane(userId, playerName, planeId, team = 1) {
    if (_remotePlayers.has(userId)) return;
    _remotePlayers.set(userId, null);

    let planesData = [];
    try {
      const r = await fetch("/planes.json");
      if (r.ok) planesData = await r.json();
    } catch (err) {
      console.warn(
        "[Multiplayer] Failed to load planes.json for remote player:",
        err,
      );
    }
    const planeDef = planesData.find((p) => p.id === planeId) ??
      planesData[0] ?? { modelPath: "/model/Plane_Fighter.glb", config: {} };

    const { loadModel } = await import("./modelLoader.js");
    const template = await loadModel(
      planeDef.modelPath ?? "/model/Plane_Fighter.glb",
    );

    const rp = new RemotePlayerPlane(scene, world);
    rp.activate(
      { x: 0, y: -500, z: 0 },
      Promise.resolve(template),
      plane?.explosionSystem ?? tank.bulletSystem?.explosionSystem ?? null,
      planeDef.modelPath ?? "/model/Plane_Fighter.glb",
      planeDef.config?.hullHalfExtents,
      planeDef.config?.colliderYOffset,
      getTerrainY,
      playerName,
      team,
    );
    rp._audioSystem = audio; // ← ADD — same fix as _spawnRemoteTank: without this, a real
    //   remote teammate/opponent's plane never gets an engine loop
    _remotePlayers.set(userId, rp);
    _remoteVehicleType.set(userId, "plane");
    _remoteUserIdByProxy.set(rp, userId);
    _registerRealPlayer(userId, playerName, team);
    if (team === localTeam) _knownTeammateNames.add(playerName);
  }

  function _removeRemotePlayer(userId) {
    const rp = _remotePlayers.get(userId);
    if (rp) rp.destroyPermanently();
    _remotePlayers.delete(userId);
    _remoteVehicleType.delete(userId);
    _remoteDeployed.delete(userId);
  }

  // ── Spawn a visual-only proxy for one of the HOST's AI units. `u` is one
  // entry from the host's match:ai-state broadcast — it already carries
  // the tankDef/modelPath the host locked in for that unit, so we don't
  // need to re-roll or re-fetch anything, just build the same visuals. ───
  async function _spawnRemoteAiUnit(u) {
    const _key = _aiUnitKey(u);
    if (_remoteAIUnits.has(_key)) return;
    _remoteAIUnits.set(_key, null); // reserve slot against duplicate packets

    const isTank = u.kind === "team1Tank" || u.kind === "team2Tank";
    const { loadModel } = await import("./modelLoader.js");

    if (isTank) {
      const trackCfg = _buildTrackCfgFromDef(u.tankDef);
      const template = await loadModel(
        u.tankDef?.modelPath ?? "/model/Tank_Tiger_L.glb",
      );
      const rt = new RemotePlayerTank(scene, world);
      rt.activate(
        { x: 0, y: -500, z: 0 },
        trackCfg,
        Promise.resolve(template),
        tank.bulletSystem?.explosionSystem ?? null,
        u.tankDef,
        u.name,
        u.team ?? 1,
      );
      rt._aiKind = u.kind;
      rt._id = u.id;
      rt._stableId = u.stableId;
      rt._audioSystem = audio;
      _remoteAIUnits.set(_key, rt);
    } else {
      const template = await loadModel(
        u.modelPath ?? "/model/Plane_Fighter.glb",
      );
      const rp = new RemotePlayerPlane(scene, world);
      rp.activate(
        { x: 0, y: -500, z: 0 },
        Promise.resolve(template),
        plane?.explosionSystem ?? tank.bulletSystem?.explosionSystem ?? null,
        u.modelPath ?? "/model/Plane_Fighter.glb",
        u.hullHalfExtents,
        u.colliderYOffset,
        getTerrainY,
        u.name,
        u.team ?? 1,
      );
      rp._aiKind = u.kind;
      rp._id = u.id;
      rp._stableId = u.stableId;
      rp._audioSystem = audio;
      rp._fireSound = u.fireSound ?? 1;
      _remoteAIUnits.set(_key, rp);
    }
  }

  if (isSquadMultiplayer) {
    matchSocket = ioClient("http://localhost:5000", { withCredentials: true });

    matchSocket.on("connect", () => {
      matchSocket.emit("match:join", { lobbyId: config.lobbyId });
    });

    matchSocket.on("match:state", (data) => {
      const {
        userId,
        vehicleType: vt,
        pos,
        quat,
        speed,
        health,
        isDead,
        turretYaw,
        barrelPitch,
        fireSeq,
        mgFireSeq,
        tankId,
        planeId,
        capturing,
        team,
      } = data;
      if (!userId) return;

      _remoteDeployed.set(userId, !!data.deployed);

      const prevType = _remoteVehicleType.get(userId);
      if (prevType && prevType !== vt) {
        _removeRemotePlayer(userId); // switched tank<->plane — rebuild the instance
      }

      // ── Resolve team: prefer the value sent in the packet (authoritative,
      // reflects that player's own live localTeam), fall back to the lobby
      // roster's static team assignment if the packet is somehow missing it.
      const member = config.lobbyMembers.find((m) => m.userId === userId);
      const resolvedTeam =
        typeof team === "number" ? team : (member?.team ?? 1);

      _applyRemotePlayerVehicleState(
        userId,
        resolvedTeam,
        vt,
        !!data.deployed,
        !!isDead,
      );

      if (!_remotePlayers.has(userId)) {
        const displayName = member?.fullName ?? "Player";
        if (vt === "plane")
          _spawnRemotePlane(userId, displayName, planeId, resolvedTeam);
        else _spawnRemoteTank(userId, displayName, tankId, resolvedTeam);
        return; // first packet only triggers the async spawn; state applies once it resolves
      }

      const rp = _remotePlayers.get(userId);
      if (rp)
        rp.setNetworkState({
          pos,
          quat,
          speed,
          health,
          isDead,
          turretYaw,
          barrelPitch,
          fireSeq,
          mgFireSeq,
          capturing,
          team: resolvedTeam,
        });
    });

    matchSocket.on("match:player-left", ({ userId }) => {
      const member = config.lobbyMembers.find((m) => m.userId === userId);
      const team = member?.team ?? 1;
      const choices = _realPlayerVehicleChoice.get(team);
      if (choices?.has(userId)) {
        choices.delete(userId);
        _applyTeamAiTargets(team);
      }
      _removeRemotePlayer(userId);
    });

    // ── AI state — non-host clients receive the host's live AI roster
    // every packet and reconcile: spawn anything new, update anything
    // existing, and remove any proxy that's no longer in the host's list
    // (respawns get a brand-new `_id`, so the old one just falls off). ──
    matchSocket.on("match:ai-state", ({ units }) => {
      if (isHost) return; // host is authoritative, never consumes this itself
      const seenKeys = new Set();
      for (const u of units) {
        const _key = _aiUnitKey(u);
        seenKeys.add(_key);

        // Track every AI stableId this GUEST has ever seen, regardless of
        // whether a proxy currently exists for it — lets this guest's own
        // end-of-match chart list every AI unit, including 0-kill ones.
        if (u.stableId != null) _knownAiStableIds.set(u.stableId, u.team ?? 1);

        if (!_remoteAIUnits.has(_key)) {
          _spawnRemoteAiUnit(u);
          continue; // state applies once the async spawn resolves on a later packet
        }
        const proxy = _remoteAIUnits.get(_key);
        if (proxy) {
          proxy.setNetworkState({
            pos: u.pos,
            quat: u.quat,
            speed: u.speed,
            health: u.health,
            isDead: u.isDead,
            turretYaw: u.turretYaw,
            barrelPitch: u.barrelPitch,
            fireSeq: u.fireSeq,
            team: u.team,
          });
        }
      }
      for (const key of _remoteAIUnits.keys()) {
        if (!seenKeys.has(key)) {
          const proxy = _remoteAIUnits.get(key);
          if (proxy) proxy.destroyPermanently();
          _remoteAIUnits.delete(key);
        }
      }
    });

    // ── Capture-point state — guests apply the host's authoritative
    // owner/timer/score instead of computing their own locally (see the
    // isHost gate in loop()'s capture-point block).
    matchSocket.on(
      "match:cp-state",
      ({ points, team1Captures, team2Captures, team1Tickets: hostT1Tix, team2Tickets: hostT2Tix }) => {
        if (isHost) return;

        for (const incoming of points) {
          const p = CAPTURE_POINTS.find((cp) => cp.id === incoming.id);
          if (!p) continue;
          const ownerChanged = p.owner !== incoming.owner;
          p.owner = incoming.owner;
          p.captureTimer = incoming.captureTimer;
          p.capturingBy = incoming.capturingBy;
          if (ownerChanged) {
            _setCPColor(p);
            _updateMinimapCPDot(p);
          }
        }

        const _myCaps = localTeam === 1 ? team1Captures : team2Captures;
        const _oppCaps = localTeam === 1 ? team2Captures : team1Captures;

        if (typeof _myCaps === "number" && _myCaps !== playerCaptures) {
          playerCaptures = _myCaps;
          document.getElementById("score-player").textContent = playerCaptures;
          document.getElementById("end-player-cap").textContent =
            playerCaptures;
        }
        if (typeof _oppCaps === "number" && _oppCaps !== enemyCaptures) {
          enemyCaptures = _oppCaps;
          document.getElementById("score-enemy").textContent = enemyCaptures;
          document.getElementById("end-enemy-cap").textContent = enemyCaptures;
        }

        // ← NEW — mirror the host's authoritative ticket counts
        if (typeof hostT1Tix === "number" && typeof hostT2Tix === "number") {
          team1Tickets = hostT1Tix;
          team2Tickets = hostT2Tix;
          playerTickets = localTeam === 1 ? team1Tickets : team2Tickets;
          enemyTickets = localTeam === 1 ? team2Tickets : team1Tickets;
          _updateTicketsHud();
        }
      },
    );

    // ── Match timer / match-end sync — guests mirror the host's
    // authoritative matchElapsed every ~second, and trigger the exact
    // same match-end sequence the instant the host reports matchEnded.
    matchSocket.on(
      "match:timer-state",
      ({
        matchElapsed: hostElapsed,
        matchEnded: hostEnded,
        team1Captures,
        team2Captures,
        team1Tickets: hostT1Tix,
        team2Tickets: hostT2Tix,
      }) => {
        if (isHost) return;

        if (typeof hostElapsed === "number") {
          matchElapsed = hostElapsed;
        }

        if (
          typeof team1Captures === "number" &&
          typeof team2Captures === "number"
        ) {
          playerCaptures = localTeam === 1 ? team1Captures : team2Captures;
          enemyCaptures = localTeam === 1 ? team2Captures : team1Captures;
        }

        // ← NEW — snap final ticket counts so applyMatchEnd()'s
        // playerTickets > enemyTickets check resolves correctly on THIS
        // client the instant it runs below.
        if (typeof hostT1Tix === "number" && typeof hostT2Tix === "number") {
          team1Tickets = hostT1Tix;
          team2Tickets = hostT2Tix;
          playerTickets = localTeam === 1 ? team1Tickets : team2Tickets;
          enemyTickets = localTeam === 1 ? team2Tickets : team1Tickets;
          _updateTicketsHud();
        }

        if (hostEnded && !matchEnded) {
          applyMatchEnd();
        }
      },
    );

    // ── Guest hit-relay — only the host actually owns the real AI
    // instances, so this is where damage from a remote player's shot
    // actually takes effect.
    matchSocket.on(
      "match:damage-ai",
      ({ id, damage, shooterName, shooterTeam, shooterUid }) => {
        if (!isHost) return;
        const allUnits = [
          ...team1Pool.getActiveTanks(),
          ...team2Pool.getActiveTanks(),
          ...team1PlanePool.getActiveTanks(),
          ...team2PlanePool.getActiveTanks(),
        ];
        const unit = allUnits.find((u) => u._id === id);
        if (!unit || unit.isDead) return;

        // ── Only apply damage if the shooter is genuinely on the opposing team
        // relative to this unit's OWN team. A guest could in theory report a
        // damage-ai event for any unit, so this guards against friendly fire
        // being reported as valid damage due to a stale/incorrect client, and
        // is also just the correct game rule: you can't damage your own team's
        // units by shooting them.
        const _resolvedShooterTeam =
          typeof shooterTeam === "number" ? shooterTeam : 1;
        if (_resolvedShooterTeam === unit.team) return; // friendly fire — ignored

        unit._lastHitBy = "enemy"; // relative to the victim: opposing team hit it
        unit._lastHitByPos = unit.rigidBody
          ? unit.rigidBody.translation()
          : null;
        unit._lastHitByExplicitName = shooterName ?? null;
        unit._lastHitByExplicitUid = shooterUid ?? null;
        unit.takeDamage(damage ?? 25);
      },
    );

    // ── Bombed enemy-owned capture point — HOST ONLY. Ownership (and its
    // bomb-damage tally) is host-authoritative, so a guest's bomb just
    // reports the raw hit here; the host decides when the threshold is met.
    matchSocket.on("match:bomb-capture-point", ({ id, shooterTeam, damage }) => {
      if (!isHost) return;
      const p = CAPTURE_POINTS.find((cp) => cp.id === id);
      if (!p) return;
      if (p.owner === "neutral" || p.owner === shooterTeam) return;
      _applyCapturePointBombDamage(p, damage ?? 140);
    });

    matchSocket.on("match:kill", ({ killer, victim }) => {
      recordKillEvent(killer, victim, true);
    });

    matchSocket.on(
      "match:hit-remote-player",
      ({
        targetUserId,
        damage,
        attackerPos,
        shooterTeam,
        shooterName,
        shooterStableId,
        shooterUid,
      }) => {
        if (targetUserId !== config.userId) return;
        const activeVeh = vehicleType === "plane" && plane ? plane : tank;

        // ── Same particle fix as the local-hit handlers above — this is the
        // path used when damage is relayed over the network instead of
        // resolved locally.
        if (activeVeh.rigidBody) {
          tank.bulletSystem.explosionSystem?.spawnSpark(
            activeVeh.rigidBody.translation(),
          );
        }

        activeVeh.takeDamage(damage ?? 25);
        playerHpBar.setHealth(activeVeh.health);
        _playerLastHitBy = "enemy";
        _playerLastAttackerPos = attackerPos;
        _playerLastHitByExplicitName = shooterName ?? null; // ← exact shooter identity, if a real player sent one
        _playerLastHitByShooterUid = shooterUid ?? null; // ← NEW
        _playerLastHitByStableId = shooterStableId ?? null; // ← exact AI shooter identity, if an AI unit sent one
        _playerLastHitByStableTeam =
          typeof shooterTeam === "number" ? shooterTeam : null;
        if (vehicleType === "plane" && plane) {
          audio.playPlaneImpact();
        } else {
          audio.playImpact();
        }
        audio.playExplosion();
        showHitIndicator(attackerPos);
        showDamageFlash();
      },
    );

    matchSocket.on("match:smoke-throw", ({ pos, quat }) => {
      if (!tank._smokeGrenadeSystem) return;
      // Reconstruct the exact same origin/fwd Tank.fire() would compute
      // locally, using the reported rigid-body pos/rot at throw time.
      const _q = new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w);
      const _fwd = new THREE.Vector3(-1, 0, 0).applyQuaternion(_q).normalize();
      const _origin = new THREE.Vector3(
        pos.x + _fwd.x * 2.5,
        pos.y + 1.2,
        pos.z + _fwd.z * 2.5,
      );
      tank._smokeGrenadeSystem.spawnRemoteEffect(_origin, _fwd);
    });
  }

  function sendNetworkStateIfDue(dt) {
    if (!matchSocket) return;
    _netSendTimer -= dt;
    if (_netSendTimer > 0) return;
    _netSendTimer = NET_SEND_INTERVAL;

    const activeVeh = vehicleType === "plane" && plane ? plane : tank;
    if (!activeVeh.bodyGroup) return;

    const p = activeVeh.bodyGroup.position;
    const q = activeVeh.bodyGroup.quaternion;
    const vel = activeVeh.rigidBody?.linvel?.();
    const speed = vel ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) : 0;

    const payload = {
      vehicleType,
      pos: { x: p.x, y: p.y, z: p.z },
      quat: { x: q.x, y: q.y, z: q.z, w: q.w },
      speed,
      health: activeVeh.health,
      isDead: activeVeh.isDead,
      fireSeq: _localFireSeq,
      // Planes can never capture — never report a capturing hold while
      // flying, even if _fKeyHeld is stuck true from some edge case.
      capturing: vehicleType === "tank" ? _fKeyHeld : false,
      team: localTeam, // ← lets every other client (and the host, for AI targeting relevance) know which side this player is on
      // Whether THIS client currently has a live deployed vehicle right
      // now — false while dead/mid-spawn-selection, true only once an
      // actual deploy has completed. Using gameStarted here (which never
      // resets after the first-ever deploy) would let the host resolve
      // this player's squad flex slot off stale in-between state instead
      // of their real, final choice — see _applyRemoteFlexForTeam() below.
      deployed: _isCurrentlyDeployed,
    };

    if (vehicleType === "tank") {
      payload.tankId = playerProfile.getSelectedTankId();
      payload.turretYaw = _localTurretMesh?.rotation.y ?? 0;
      payload.barrelPitch = _localBarrelMesh?.rotation.x ?? 0;
      payload.mgFireSeq = _localMgFireSeq; // ← NEW
    } else {
      payload.planeId = playerProfile.getSelectedPlaneId();
    }

    matchSocket.emit("match:state", payload);
  }

  // ── Host-only: broadcast every active AI unit's transform/state so
  // every other client in the lobby renders the exact same enemies and
  // friendlies, instead of each client rolling its own independent AI. ───
  function _serializeAiUnit(kind, unit) {
    const p = unit.bodyGroup.position;
    const q = unit.bodyGroup.quaternion;
    const isTank = kind === "team1Tank" || kind === "team2Tank";

    // ── Speed — RemotePlayerTank/RemotePlayerPlane.setNetworkState()
    // defaults speed to 0 when the field is missing, which is why every
    // AI proxy's tracks/propeller sat frozen on non-host clients even
    // though position/rotation interpolated fine.
    let speed = 0;
    if (unit.rigidBody) {
      const v = unit.rigidBody.linvel();
      speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    }

    return {
      id: unit._id,
      kind,
      stableId: _entityStableIds.get(unit) ?? null, // ← team-neutral identity, NOT a pre-rendered label — see naming block above
      pos: { x: p.x, y: p.y, z: p.z },
      quat: { x: q.x, y: q.y, z: q.z, w: q.w },
      speed,
      fireSeq: unit._fireSeq ?? 0,
      health: unit.health,
      isDead: unit.isDead,
      team: unit.team ?? 1,
      turretYaw: isTank ? (unit._turretMesh?.rotation.y ?? 0) : undefined,
      barrelPitch: isTank ? (unit._barrelMesh?.rotation.x ?? 0) : undefined,
      tankDef: isTank ? unit._tankDef : undefined,
      modelPath: !isTank
        ? (unit._lockedModelPath ?? _planePreset?.modelPath)
        : undefined,
      hullHalfExtents: !isTank
        ? (unit._lockedHullHalfExtents ?? enemyPlanePool.hullHalfExtents)
        : undefined,
      colliderYOffset: !isTank
        ? (unit._lockedColliderYOffset ?? enemyPlanePool.colliderYOffset)
        : undefined,
      fireSound: !isTank ? (unit._fireSound ?? 1) : undefined,
    };
  }

  function sendAiStateIfDue(dt) {
    if (!isHost || !matchSocket) return;
    _aiNetSendTimer -= dt;
    if (_aiNetSendTimer > 0) return;
    _aiNetSendTimer = AI_NET_SEND_INTERVAL;

    const units = [];
    for (const t of team1Pool.getActiveTanks())
      units.push(_serializeAiUnit("team1Tank", t));
    for (const t of team2Pool.getActiveTanks())
      units.push(_serializeAiUnit("team2Tank", t));
    for (const p of team1PlanePool.getActiveTanks())
      units.push(_serializeAiUnit("team1Plane", p));
    for (const p of team2PlanePool.getActiveTanks())
      units.push(_serializeAiUnit("team2Plane", p));

    matchSocket.emit("match:ai-state", { units });
  }

  // ── Host-only: broadcast capture-point ownership/timer/score state so
  // guests stop computing their own (potentially divergent) conclusion
  // about who owns each point — see the isHost gate in the capture-point
  // logic block in loop() for why this is now required.
  let _cpNetSendTimer = 0;
  const CP_NET_SEND_INTERVAL = 1 / 4; // 4x/sec is plenty — capture timers change slowly

  function sendCpStateIfDue(dt) {
    if (!isHost || !matchSocket) return;
    _cpNetSendTimer -= dt;
    if (_cpNetSendTimer > 0) return;
    _cpNetSendTimer = CP_NET_SEND_INTERVAL;

    matchSocket.emit("match:cp-state", {
      points: CAPTURE_POINTS.map((p) => ({
        id: p.id,
        owner: p.owner,
        captureTimer: p.captureTimer,
        capturingBy: p.capturingBy,
      })),
      team1Captures: localTeam === 1 ? playerCaptures : enemyCaptures,
      team2Captures: localTeam === 1 ? enemyCaptures : playerCaptures,
      team1Tickets, // ← NEW
      team2Tickets, // ← NEW
    });
  }

  let _timerNetSendTimer = 0;
  const TIMER_NET_SEND_INTERVAL = 1; // 1x/sec is plenty for a countdown display

  function sendTimerStateIfDue(dt) {
    if (!isHost || !matchSocket) return;
    if (matchEnded) return; // final state already sent once by applyMatchEnd()
    _timerNetSendTimer -= dt;
    if (_timerNetSendTimer > 0) return;
    _timerNetSendTimer = TIMER_NET_SEND_INTERVAL;

    matchSocket.emit("match:timer-state", {
      matchElapsed,
      matchEnded: false,
    });
  }

  // ── Host-only: build ONE flat, team-tagged candidate list every frame
  // and push it to all four AI pools. Each pool's units filter this down
  // to "not my team" themselves (see _findCombatTarget in enemyTank.js/
  // enemyPlane.js) — this function's only job is assembling the list.
  const _allCandidatesList = []; // reused every frame — no per-frame allocation

  function _buildAiCandidateList() {
    _allCandidatesList.length = 0;

    // ── The LOCAL real player's own active vehicle. Gated on gameStarted
    // so AI never targets the player's parked/inert tank sitting at
    // INITIAL_SPAWN_POS before their very first Deploy — the tank object
    // exists and has a rigidBody from init() onward, but isn't a real,
    // controllable presence in the match until the player actually deploys.
    const localVehicle = vehicleType === "plane" && plane ? plane : tank;
    if (
      gameStarted &&
      localVehicle &&
      !localVehicle.isDead &&
      localVehicle.rigidBody
    ) {
      const p = localVehicle.rigidBody.translation();
      _allCandidatesList.push({
        pos: p,
        rigidBody: localVehicle.rigidBody,
        isPlayer: true,
        tankRef: null, // no AI-style tankRef for the local human player
        team: localTeam,
        isDead: false,
        vehicleType, // ← 'tank' | 'plane' — lets EnemyTank distinguish a
        //   real player's plane from an AI-controlled one
      });
    }

    // ── Every REMOTE real player's proxy — only once that guest has
    // actually deployed a live vehicle (mirrors the gameStarted gate on
    // the local player's own vehicle just above). Without this, a guest
    // sitting on the spawn-selection screen still has a positioned proxy
    // with a real rigid body on the host, and AI would happily target and
    // damage it — damage that then gets relayed back and lands on the
    // guest's tank/plane the moment they actually deploy. ─────────────────
    for (const [userId, rp] of _remotePlayers.entries()) {
      if (!rp || !rp.active || rp.isDead || !rp.rigidBody) continue;
      if (!_remoteDeployed.get(userId)) continue;
      _allCandidatesList.push({
        pos: rp.bodyGroup.position,
        rigidBody: rp.rigidBody,
        isPlayer: true,
        tankRef: rp, // needed so onHitPlayer can resolve isRemotePlayer + relay
        team: rp.team,
        isDead: false,
        // ← Real remote player's vehicle type, tracked separately from `rp`
        // itself since RemotePlayerTank never sets .vehicleType (only
        // RemotePlayerPlane does, via EnemyPlane's constructor).
        vehicleType:
          _remoteVehicleType.get(userId) === "plane" ? "plane" : "tank",
      });
    }

    // ── Every AI unit, both teams (tanks + planes) ─────────────────────
    for (const pool of [team1Pool, team2Pool, team1PlanePool, team2PlanePool]) {
      for (const unit of pool.getActiveTanks()) {
        if (unit.isDead || !unit.rigidBody) continue;
        _allCandidatesList.push({
          pos: unit._cachedPos ?? unit.rigidBody.translation(),
          rigidBody: unit.rigidBody,
          isPlayer: false,
          tankRef: unit,
          team: unit.team,
          isDead: false,
          // EnemyTank instances never set .vehicleType (undefined → 'tank');
          // EnemyPlane's constructor always sets this.vehicleType = 'plane'.
          vehicleType: unit.vehicleType === "plane" ? "plane" : "tank",
        });
      }
    }

    return _allCandidatesList;
  }

  function _pushCandidatesToAiPools() {
    if (!isHost) return;
    const list = _buildAiCandidateList();
    team1Pool.setAllCandidates(list);
    team2Pool.setAllCandidates(list);
    team1PlanePool.setAllCandidates(list);
    team2PlanePool.setAllCandidates(list);
  }

  
  // ── Gathers every currently-live RocketSystem in the match (the local
  // player's own plane, every AI plane in both plane pools) so AI planes
  // can check for an active guided-missile lock on themselves and react
  // with flares. Real remote players' rocket systems aren't visible to
  // the host (only position/state is networked, not weapon internals),
  // so they're omitted here — a reasonable gap, not a regression.
  const _allRocketSystemsList = []; // reused every frame — no per-frame allocation

  function _buildRocketSystemsList() {
    _allRocketSystemsList.length = 0;
    if (plane?.rocketSystem) _allRocketSystemsList.push(plane.rocketSystem);
    for (const pool of [team1PlanePool, team2PlanePool]) {
      for (const p of pool.getActiveTanks()) {
        if (p.rocketSystem) _allRocketSystemsList.push(p.rocketSystem);
      }
    }
    return _allRocketSystemsList;
  }

  function _pushThreatsToAiPlanePools() {
    if (!isHost) return;
    const list = _buildRocketSystemsList();
    team1PlanePool.setThreatRocketSystems(list);
    team2PlanePool.setThreatRocketSystems(list);
  }

  // tank._onRespawnRewire = (newTurretController) => {
  //   newTurretController?.setEnemyPool(enemyPool);
  //   newTurretController?.setFriendlyPool(friendlyPool);
  //   newTurretController?.setCamera(camera);
  // };

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
      _lastKnownEnemyPos.set(et, { x: p.x, y: p.y, z: p.z }); // NEW
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

  const friendlyPosCache = new Map();

  function refreshFriendlyPosCache() {
    // ── "Friendly" here means "same team as the LOCAL player" — team is now
    // the source of truth, not the AI unit's spawn-time pool label. Works
    // identically whether this client is the host (reads the real pools
    // directly) or a guest (reads _remoteAIUnits proxies, filtering by the
    // .team each proxy carries from the host's match:ai-state broadcast).
    const active = [];

    if (isHost) {
      for (const t of team1Pool.getActiveTanks())
        if (t.team === localTeam) active.push(t);
      for (const t of team2Pool.getActiveTanks())
        if (t.team === localTeam) active.push(t);
      for (const p of team1PlanePool.getActiveTanks())
        if (p.team === localTeam) active.push(p);
      for (const p of team2PlanePool.getActiveTanks())
        if (p.team === localTeam) active.push(p);
    } else {
      for (const au of _remoteAIUnits.values()) {
        if (au && au.team === localTeam) active.push(au);
      }
    }

    for (const ft of active) {
      if (ft.isDead || !ft.rigidBody) {
        friendlyPosCache.delete(ft);
        continue;
      }
      const p = ft.rigidBody.translation();
      _lastKnownFriendlyPos.set(ft, { x: p.x, y: p.y, z: p.z }); // NEW
      const cached = friendlyPosCache.get(ft);
      if (cached) {
        cached.x = p.x;
        cached.y = p.y;
        cached.z = p.z;
      } else {
        friendlyPosCache.set(ft, { x: p.x, y: p.y, z: p.z });
      }
    }

    for (const key of friendlyPosCache.keys()) {
      if (!active.includes(key)) {
        friendlyPosCache.delete(key);
      }
    }
  }

  // ── Plane equivalents — feed _lastKnownEnemyPos / _lastKnownFriendlyPos
  // (used by kill-attribution's _nearestByLastKnownPos) with plane positions
  // too. enemyPosCache/friendlyPosCache stay tank-only since those also
  // drive minimap dots. ────────────────────────────────────────────────────
  function refreshEnemyPlaneLastKnownPos() {
    for (const ep of enemyPlanePool.getActiveTanks()) {
      if (ep.isDead || !ep.rigidBody) continue;
      const p = ep.rigidBody.translation();
      _lastKnownEnemyPos.set(ep, { x: p.x, y: p.y, z: p.z });
    }
  }

  function refreshFriendlyPlaneLastKnownPos() {
    for (const fp of friendlyPlanePool.getActiveTanks()) {
      if (fp.isDead || !fp.rigidBody) continue;
      const p = fp.rigidBody.translation();
      _lastKnownFriendlyPos.set(fp, { x: p.x, y: p.y, z: p.z });
    }
  }

  // ── Friendly-plane marker roster — same "friendly = same team as local
  // player" resolution as refreshFriendlyPosCache() uses for tanks, just
  // planes only, and gathered from whichever source is authoritative for
  // THIS client (real AI pools on host, RemotePlayerPlane proxies on guest).
  // Local player's own plane is deliberately excluded.
  function _collectFriendlyPlanesForMarkers() {
    const list = [];

    if (isHost) {
      for (const p of team1PlanePool.getActiveTanks())
        if (p.team === localTeam && !p.isDead) list.push(p);
      for (const p of team2PlanePool.getActiveTanks())
        if (p.team === localTeam && !p.isDead) list.push(p);
    } else {
      for (const au of _remoteAIUnits.values()) {
        if (
          au &&
          au.team === localTeam &&
          !au.isDead &&
          (au._aiKind === "team1Plane" || au._aiKind === "team2Plane")
        ) {
          list.push(au);
        }
      }
    }

    // Remote real teammates flying planes also count as "friendly planes"
    // for marker purposes — their proxy already carries .bodyGroup/.isDead.
    for (const [userId, rp] of _remotePlayers.entries()) {
      if (
        rp &&
        rp.team === localTeam &&
        !rp.isDead &&
        _remoteVehicleType.get(userId) === "plane"
      ) {
        list.push(rp);
      }
    }

    return list;
  }

  function _collectFriendlyTanksForMarkers() {
    const list = [];

    if (isHost) {
      for (const t of team1Pool.getActiveTanks())
        if (t.team === localTeam && !t.isDead) list.push(t);
      for (const t of team2Pool.getActiveTanks())
        if (t.team === localTeam && !t.isDead) list.push(t);
    } else {
      for (const au of _remoteAIUnits.values()) {
        if (
          au &&
          au.team === localTeam &&
          !au.isDead &&
          (au._aiKind === "team1Tank" || au._aiKind === "team2Tank")
        ) {
          list.push(au);
        }
      }
    }

    for (const [userId, rp] of _remotePlayers.entries()) {
      if (
        rp &&
        rp.team === localTeam &&
        !rp.isDead &&
        _remoteVehicleType.get(userId) === "tank"
      ) {
        list.push(rp);
      }
    }

    return list;
  }

  function _tankFirePosition(t) {
    if (!t.rigidBody) return null;
    const p = t.rigidBody.translation();
    return { x: p.x, y: p.y + 0.55, z: p.z };
  }

  // ── Plane damage-fire spawns at the propeller node instead of a fixed
  // hull offset — mirrors _tankFirePosition's shape/contract (plain
  // {x,y,z}, called every frame by ExplosionSystem's fire-follow logic)
  // but reads the propeller's actual current world position each call, so
  // the flame visually tracks the spinning prop instead of a static point.
  const _planeFirePosScratch = new THREE.Vector3();
  function _planeFirePosition(p) {
    // NOTE: no longer gated on p.rigidBody — _die() nulls the rigid body
    // out immediately on death, but the plane keeps falling and trailing
    // smoke (visually, via bodyGroup) all the way to ground impact.
    // getPropellerWorldPosition() already falls back to bodyGroup's own
    // position if the propeller node isn't available, so this keeps
    // working correctly whether the plane is alive or mid-fall.
    p.getPropellerWorldPosition(_planeFirePosScratch);
    return {
      x: _planeFirePosScratch.x,
      y: _planeFirePosScratch.y,
      z: _planeFirePosScratch.z,
    };
  }

  function updateDamageFireEffects() {
    const es = tank.bulletSystem.explosionSystem;

    // ── Player ────────────────────────────────────────────────────────────
    if (
      !tank.isDead &&
      tank.rigidBody &&
      tank.health / tank.maxHealth <= LOW_HEALTH_FRACTION
    ) {
      if (!es.isDamageFireActive(tank))
        es.startDamageFire(tank, () => _tankFirePosition(tank));
    } else {
      es.stopDamageFire(tank);
    }

    // ── Enemies ───────────────────────────────────────────────────────────
    for (const et of enemyPool.getActiveTanks()) {
      if (
        !et.isDead &&
        et.rigidBody &&
        et.health / et.maxHealth <= LOW_HEALTH_FRACTION
      ) {
        if (!es.isDamageFireActive(et))
          es.startDamageFire(et, () => _tankFirePosition(et));
      } else {
        es.stopDamageFire(et);
      }
    }

    // ── Friendlies ────────────────────────────────────────────────────────
    for (const ft of friendlyPool.getActiveTanks()) {
      if (
        !ft.isDead &&
        ft.rigidBody &&
        ft.health / ft.maxHealth <= LOW_HEALTH_FRACTION
      ) {
        if (!es.isDamageFireActive(ft))
          es.startDamageFire(ft, () => _tankFirePosition(ft));
      } else {
        es.stopDamageFire(ft);
      }
    }

    // ── Remote REAL players' own vehicles — both host and guest only ever
    // hold a lightweight proxy (RemotePlayerTank/RemotePlayerPlane) for
    // every OTHER real player; neither side has a full simulated instance
    // for them. setNetworkState() copies the remote player's .health in
    // on every packet, but nothing was ever reading it to drive the
    // damage-fire/smoke effect for these proxies — that's why the host's
    // low health never showed smoke on the guest's screen and vice versa.
    // This block runs unconditionally on BOTH host and guest, since each
    // side needs it for the OTHER side's real player(s).
    for (const [userId, rp] of _remotePlayers.entries()) {
      if (!rp || !rp.active) continue;

      if (rp instanceof RemotePlayerPlane) {
        const rpEs = rp.explosionSystem;
        if (!rpEs) continue;

        if (rp.isDead) {
          if (rp._groundExplosionSpawned) {
            rpEs.stopPlaneDamageSmoke(rp);
          } else if (!rpEs.isPlaneDamageSmokeActive(rp)) {
            rpEs.startPlaneDamageSmoke(rp, () =>
              rp.getPropellerWorldPosition(),
            );
          }
        } else if (
          rp.rigidBody &&
          rp.health / rp.maxHealth <= LOW_HEALTH_FRACTION
        ) {
          if (!rpEs.isPlaneDamageSmokeActive(rp))
            rpEs.startPlaneDamageSmoke(rp, () =>
              rp.getPropellerWorldPosition(),
            );
        } else {
          rpEs.stopPlaneDamageSmoke(rp);
        }
      } else {
        // RemotePlayerTank proxy — mirrors the "Friendlies"/"Enemies" tank
        // blocks above, just sourced from network health instead of local
        // sim health.
        if (
          !rp.isDead &&
          rp.rigidBody &&
          rp.health / rp.maxHealth <= LOW_HEALTH_FRACTION
        ) {
          if (!es.isDamageFireActive(rp))
            es.startDamageFire(rp, () => _tankFirePosition(rp));
        } else {
          es.stopDamageFire(rp);
        }
      }
    }

    // ── Remote AI proxies (guest clients only) — on a guest, the real
    // enemyPool/friendlyPool/enemyPlanePool/friendlyPlanePool never run
    // (update() is isHost-gated in the main loop), so the loops above
    // are always empty there. The only representation of AI units on a
    // guest is _remoteAIUnits (RemotePlayerTank/RemotePlayerPlane
    // proxies driven by the host's match:ai-state broadcast). Without
    // this block, damaged/burning AI tanks and planes never show smoke
    // on any non-host client. Tanks use _tankFirePosition (hull-offset),
    // planes use getPropellerWorldPosition (inherited from EnemyPlane).
    for (const au of _remoteAIUnits.values()) {
      if (!au) continue;

      const isTank = au._aiKind === "team1Tank" || au._aiKind === "team2Tank";

      if (isTank) {
        if (
          !au.isDead &&
          au.rigidBody &&
          au.health / au.maxHealth <= LOW_HEALTH_FRACTION
        ) {
          if (!es.isDamageFireActive(au))
            es.startDamageFire(au, () => _tankFirePosition(au));
        } else {
          es.stopDamageFire(au);
        }
      } else {
        // Plane proxy — uses its own explosionSystem instance (mirrors
        // the enemy/friendly plane branches below), smoke-only, spawned
        // from the propeller node, and continues through the death-fall
        // until it actually hits the ground.
        const auEs = au.explosionSystem;
        if (!auEs) continue;

        if (au.isDead) {
          if (au._groundExplosionSpawned) {
            auEs.stopPlaneDamageSmoke(au);
          } else if (!auEs.isPlaneDamageSmokeActive(au)) {
            auEs.startPlaneDamageSmoke(au, () =>
              au.getPropellerWorldPosition(),
            );
          }
        } else if (
          au.rigidBody &&
          au.health / au.maxHealth <= LOW_HEALTH_FRACTION
        ) {
          if (!auEs.isPlaneDamageSmokeActive(au))
            auEs.startPlaneDamageSmoke(au, () =>
              au.getPropellerWorldPosition(),
            );
        } else {
          auEs.stopPlaneDamageSmoke(au);
        }
      }
    }

    // ── Player's plane — uses the plane's OWN ExplosionSystem instance
    // (plane.js constructs its own, separate from the tank's), spawning
    // white + black smoke only (no fire) from the propeller node.
    //
    // While falling (isDead but not yet _groundExplosionSpawned), keep the
    // smoke going or start it if it wasn't already — a destroyed plane
    // should trail smoke all the way down. Once it has actually hit the
    // ground and blown up (_groundExplosionSpawned true), stop the smoke
    // for good — this block runs every frame for the rest of the match
    // (even after the player switches back to driving the tank), so
    // without this explicit stop the smoke would otherwise be re-started
    // forever since plane.isDead never resets back to false on its own.
    if (plane) {
      const planeEs = plane.explosionSystem;
      if (plane.isDead) {
        if (plane._groundExplosionSpawned) {
          planeEs.stopPlaneDamageSmoke(plane);
        } else if (!planeEs.isPlaneDamageSmokeActive(plane)) {
          planeEs.startPlaneDamageSmoke(plane, () => _planeFirePosition(plane));
        }
      } else if (
        plane.rigidBody &&
        plane.health / plane.maxHealth <= LOW_HEALTH_FRACTION
      ) {
        if (!planeEs.isPlaneDamageSmokeActive(plane))
          planeEs.startPlaneDamageSmoke(plane, () => _planeFirePosition(plane));
      } else {
        planeEs.stopPlaneDamageSmoke(plane);
      }
    }

    // ── Enemy AI planes — smoke continues through the death-fall and only
    // stops once the plane has actually hit the ground (mirrors the
    // player-plane branch above, which gates on _groundExplosionSpawned
    // rather than isDead alone) ──────────────────────────────────────────
    for (const ep of enemyPlanePool.getActiveTanks()) {
      const epEs = ep.explosionSystem;
      if (!epEs) continue;
      if (ep.isDead) {
        if (ep._groundExplosionSpawned) {
          epEs.stopPlaneDamageSmoke(ep);
        } else if (!epEs.isPlaneDamageSmokeActive(ep)) {
          epEs.startPlaneDamageSmoke(ep, () => ep.getPropellerWorldPosition());
        }
      } else if (
        ep.rigidBody &&
        ep.health / ep.maxHealth <= LOW_HEALTH_FRACTION
      ) {
        if (!epEs.isPlaneDamageSmokeActive(ep))
          epEs.startPlaneDamageSmoke(ep, () => ep.getPropellerWorldPosition());
      } else {
        epEs.stopPlaneDamageSmoke(ep);
      }
    }

    // ── Friendly AI planes — same logic ─────────────────────────────────
    for (const fp of friendlyPlanePool.getActiveTanks()) {
      const fpEs = fp.explosionSystem;
      if (!fpEs) continue;
      if (fp.isDead) {
        if (fp._groundExplosionSpawned) {
          fpEs.stopPlaneDamageSmoke(fp);
        } else if (!fpEs.isPlaneDamageSmokeActive(fp)) {
          fpEs.startPlaneDamageSmoke(fp, () => fp.getPropellerWorldPosition());
        }
      } else if (
        fp.rigidBody &&
        fp.health / fp.maxHealth <= LOW_HEALTH_FRACTION
      ) {
        if (!fpEs.isPlaneDamageSmokeActive(fp))
          fpEs.startPlaneDamageSmoke(fp, () => fp.getPropellerWorldPosition());
      } else {
        fpEs.stopPlaneDamageSmoke(fp);
      }
    }
  }

  let killCount = 0;
  // Prefer config.playerName, then this client's own lobby-roster entry
  // (multiplayer — always has the real account fullName), only falling
  // back to the literal 'Player' if truly nothing is available. This was
  // previously defaulting straight to 'Player' whenever config.playerName
  // was empty — exactly why a real guest showed up in the kill chart as a
  // plain "Player" instead of their actual name.
  const _localDisplayName =
    config.playerName || _localMember?.fullName || "Player";

  // ── Known real human player names on our team — local player + every
  // remote teammate currently in the lobby. Used by _renderKillChart() to
  // correctly identify Team 1 members by actual identity, since a real
  // remote player's name (e.g. "John Doe") is neither _localDisplayName
  // (only true on their OWN client) nor a "Friendly_N" AI name.
  const _knownTeammateNames = new Set([_localDisplayName]);

  // ═══════════════ AI naming — team-neutral stable IDs + per-viewer labels ═══════════════
  //
  // PROBLEM this replaces: the old system baked "Friendly_N"/"Enemy_N"
  // directly onto each unit HOST-SIDE (relative to the HOST's own team),
  // then broadcast that fixed string to every guest. A guest on the
  // opposing team would see "Enemy_3" for a unit that's actually on
  // THEIR OWN team, because the label was never re-derived per-viewer.
  //
  // FIX: the host assigns each unit a STABLE, TEAM-NEUTRAL id the instant
  // it spawns — "T1_3" (3rd unit ever spawned on team 1), "T2_1", etc.
  // This id is broadcast (as unit.stableId) instead of a pre-rendered
  // name. Every client — host or guest — then derives "Friendly_N" /
  // "Enemy_N" from that stableId + their OWN localTeam at display time,
  // via getEntityName() below. Same unit, different label per viewer,
  // computed consistently on every client independently.
  const _entityStableIds = new WeakMap(); // unit -> "T1_3" style stable id
  let _team1UnitCounter = 0;
  let _team2UnitCounter = 0;

  // Every AI stableId ever seen this match, on EITHER client role — the
  // host fills this as it mints ids below; every guest fills it from the
  // stableId+team already carried on each match:ai-state packet (see that
  // listener). This is what lets _renderKillChart() list a FULL roster
  // (including 0-kill units) on a guest too — _team1UnitCounter/
  // _team2UnitCounter only ever increment on the host.
  const _knownAiStableIds = new Map(); // stableId -> team

  function _registerEntityStableId(entity) {
    if (!entity || entity.isRemotePlayer || _entityStableIds.has(entity))
      return;
    let stableId;
    if (entity.team === 2) {
      _team2UnitCounter++;
      stableId = `T2_${_team2UnitCounter}`;
    } else {
      _team1UnitCounter++;
      stableId = `T1_${_team1UnitCounter}`;
    }
    _entityStableIds.set(entity, stableId);
    _knownAiStableIds.set(stableId, entity.team ?? 1);
  }

  // Sweeps every currently-active AI unit across all four pools and
  // registers a stable id for any that don't have one yet. HOST ONLY —
  // stable ids are a host-assigned identity, broadcast via
  // _serializeAiUnit()'s `stableId` field; guests never mint their own.
  function _ensureAllEntityNamesRegistered() {
    if (!isHost) return;
    for (const t of team1Pool.getActiveTanks()) _registerEntityStableId(t);
    for (const t of team2Pool.getActiveTanks()) _registerEntityStableId(t);
    for (const p of team1PlanePool.getActiveTanks()) _registerEntityStableId(p);
    for (const p of team2PlanePool.getActiveTanks()) _registerEntityStableId(p);
  }

  /** Given a stable id ("T1_3") and the unit's team, returns the label
   * this LOCAL client should show for it — "Friendly_3" if that team
   * matches localTeam, "Enemy_3" otherwise. Pure function of
   * (stableId, team, localTeam) — same inputs always produce the same
   * output on every client, independently, with no broadcast needed
   * beyond stableId + team themselves. */
  function _labelForStableId(stableId, team) {
    if (!stableId) return null;
    const num = stableId.split("_")[1] ?? "?";
    return team === localTeam ? `Friendly_${num}` : `Enemy_${num}`;
  }

  // ── Team-neutral kill descriptors ───────────────────────────────────────
  // A "descriptor" is what gets stored/broadcast for a kill — NEVER a
  // pre-rendered "Friendly_N"/"Enemy_N" string, since that string only
  // makes sense from whichever client computed it. Real players always
  // carry their real name (identity, not team-relative). AI units carry
  // their team-neutral stableId + team, resolved to a label fresh by
  // EVERY client (host or any guest, on either team) via
  // _labelForKillEntity() below — this is what makes the kill feed/chart
  // correct no matter which side is viewing it.
  const _knownRealPlayers = new Map(); // uid -> { name, team } — every real human seen this match, either side

  function _registerRealPlayer(uid, name, team) {
    if (!uid) return;
    _knownRealPlayers.set(uid, { name, team });
  }

  function _describeKillEntity(entity) {
    if (!entity) return null;

    // The LOCAL human player's own vehicle (tank or plane)
    if (entity === tank || entity === plane) {
      return {
        kind: "player",
        uid: config.userId ?? "local",
        team: localTeam,
        name: _localDisplayName,
      };
    }

    // A remote human player's proxy — must be checked AFTER ruling out an
    // AI proxy (via _aiKind), since AI proxies are also RemotePlayerTank/
    // RemotePlayerPlane instances and would otherwise be misclassified as
    // real players (see getEntityName() for the same fix).
    if (entity.isRemotePlayer && !entity._aiKind) {
      const uid =
        _remoteUserIdByProxy.get(entity) ?? "name:" + entity._playerName;
      return {
        kind: "player",
        uid,
        team: entity.team ?? 1,
        name: entity._playerName ?? "Player",
      };
    }

    // An AI unit (local instance on host, or a proxy standing in for one
    // on a guest) — team-neutral stableId, resolved per-viewer at render
    // time, never baked into a fixed string here.
    const stableId = entity._stableId ?? _entityStableIds.get(entity);
    return { kind: "ai", stableId: stableId ?? null, team: entity.team ?? 1 };
  }

  /** Fallback descriptor for "some unit on this team", used only when the
   * real attacker couldn't be resolved (e.g. it despawned first). Still
   * team-tagged so it renders Friendly/Enemy correctly per-viewer instead
   * of a hardcoded, un-teamed string. */
  function _genericTeamDescriptor(team) {
    return { kind: "ai", stableId: null, team, _generic: true };
  }

  /** Resolves a descriptor to the label THIS client should show — real
   * players always show their real name (identity, not team-relative); AI
   * units resolve Friendly_N/Enemy_N against THIS client's own localTeam,
   * so the exact same descriptor renders correctly on the host or any
   * guest, on either team. */
  function _labelForKillEntity(desc) {
    if (!desc) return "Unknown";
    if (desc.kind === "player") return desc.name || "Player";
    if (desc._generic) return desc.team === localTeam ? "Friendly" : "Enemy";
    return _labelForStableId(desc.stableId, desc.team) ?? "Unknown";
  }

  _registerRealPlayer(config.userId ?? "local", _localDisplayName, localTeam);

  // Attribution scratch — set by the onHitPlayer callbacks below
  let _playerLastHitBy = null; // 'enemy' | null
  let _playerLastAttackerPos = null;
  let _playerLastHitByExplicitName = null; // real shooter name, when the attacker sent one directly
  let _playerLastHitByShooterUid = null; // real shooter uid, when the attacker sent one directly
  let _playerLastHitByStableId = null; // AI shooter's stable id, when the attacker sent one
  let _playerLastHitByStableTeam = null; // that AI shooter's team

  function getEntityName(entity) {
    if (!entity) return "Unknown";
    if (entity === tank || entity === plane) return _localDisplayName;

    // ── AI units (local, host-run instance OR a RemotePlayerTank/Plane
    // proxy standing in for one on a guest) — checked BEFORE the real-
    // remote-player branch below, since an AI proxy is also an instance
    // of RemotePlayerTank/RemotePlayerPlane (entity.isRemotePlayer is
    // true for it too) and would otherwise be misidentified as a real
    // human. _aiKind is only ever set on AI proxies (see
    // _spawnRemoteAiUnit in main.js) — real remote-player proxies never
    // get it — so it's the reliable discriminator here.
    const isAiProxy = !!entity._aiKind;
    if (
      isAiProxy ||
      (!entity.isRemotePlayer && !(entity === tank || entity === plane))
    ) {
      const stableId = entity._stableId ?? _entityStableIds.get(entity);
      if (stableId != null) {
        const label = _labelForStableId(stableId, entity.team);
        if (label) return label;
      }
      // Fallback — entity hasn't been registered yet (shouldn't normally
      // happen; _ensureAllEntityNamesRegistered() runs every frame before
      // any kill is processed). Register it now (host only — no-op on
      // guests, where entity._stableId should already be set from the
      // network packet).
      _registerEntityStableId(entity);
      const freshId = _entityStableIds.get(entity);
      return freshId
        ? (_labelForStableId(freshId, entity.team) ?? "Unknown")
        : "Unknown";
    }

    // ── Real remote human teammates/opponents — always their real name,
    // regardless of team. Color (not name) is what conveys friend/foe for
    // real players — see _killFeedColor().
    if (entity.isRemotePlayer && entity._playerName) {
      return entity._playerName;
    }

    return "Unknown";
  }
  // Last-known world position of every AI unit — kept slightly stale (updated
  // on the existing throttled cache refresh) so a killer can still be
  // resolved to a name even a frame or two after it died/despawned.
  const _lastKnownEnemyPos = new WeakMap();
  const _lastKnownFriendlyPos = new WeakMap();

  // maxDist was 12 — far too tight for a real shooter's position (tank/
  // plane guns fire from well beyond 12m). This is only ever used for
  // kill-feed/MVP attribution (never gameplay), so there's no reason to
  // cap the search radius at all — just find whichever friendly/enemy was
  // genuinely closest to the recorded attacker position.
  function _nearestByLastKnownPos(map, activeList, pos, maxDist = Infinity) {
    if (!pos) return null;
    let best = null,
      bestDsq = maxDist * maxDist;
    for (const e of activeList) {
      const p = map.get(e);
      if (!p) continue;
      const dx = p.x - pos.x,
        dz = p.z - pos.z;
      const dsq = dx * dx + dz * dz;
      if (dsq < bestDsq) {
        bestDsq = dsq;
        best = e;
      }
    }
    return best;
  }

  // ── Unified AI-kill attribution — used for ALL four AI pools (team1/team2
  // tanks + planes) so the killer descriptor is built with IDENTICAL logic
  // no matter which pool the dead unit came from. This replaces the old
  // per-pool duplicated blocks, which had subtly different fallback order
  // and caused inconsistent Friendly_N/Enemy_N vs real-name attribution.
  function _resolveKillerDescForAiVictim(victim) {
    // 1) The LOCAL player's own vehicle landed the kill (set on the host's
    //    OR guest's own bulletSystem.onHit via _enemyHitCounts, mirrored by
    //    the AI's takeDamage() setting _lastHitBy = 'player').
    if (victim._lastHitBy === "player") {
      return _describeKillEntity(
        vehicleType === "plane" && plane ? plane : tank,
      );
    }

    // Only 'enemy' or 'friendly' (i.e. "some AI or remote player on the
    // opposing team relative to the victim" — see _makeTeamHitHandler /
    // the match:damage-ai handler) reach here.
    if (victim._lastHitBy !== "enemy" && victim._lastHitBy !== "friendly") {
      return null;
    }

    // 2) An explicit real-player name was attached (remote human shooter,
    //    relayed via match:damage-ai or match:hit-remote-player). Always the
    //    most trustworthy source — use it before anything else.
    if (victim._lastHitByExplicitName) {
      return {
        kind: "player",
        uid:
          victim._lastHitByExplicitUid ??
          "name:" + victim._lastHitByExplicitName,
        team: victim.team === 1 ? 2 : 1,
        name: victim._lastHitByExplicitName,
      };
    }

    // 3) A direct AI shooter reference was attached (set in
    //    _makeTeamHitHandler / _makeTeamPlaneHitHandler for AI-vs-AI hits).
    if (victim._lastHitByUnit) {
      return _describeKillEntity(victim._lastHitByUnit);
    }

    // 4) Fallback — nearest unit on the OPPOSING team relative to the
    //    victim, computed live (never hardcoded to host's own
    //    friendlyPool/enemyPool aliases, so this stays correct no matter
    //    which team the victim is actually on).
    const opposingTanks =
      victim.team === 1
        ? team2Pool.getActiveTanks()
        : team1Pool.getActiveTanks();
    const opposingPlanes =
      victim.team === 1
        ? team2PlanePool.getActiveTanks()
        : team1PlanePool.getActiveTanks();
    const _attacker = _nearestByLastKnownPos(
      victim.team === 1 ? _lastKnownEnemyPos : _lastKnownFriendlyPos,
      [...opposingTanks, ...opposingPlanes],
      victim._lastHitByPos,
    );
    return _attacker
      ? _describeKillEntity(_attacker)
      : _genericTeamDescriptor(victim.team === 1 ? 2 : 1);
  }

  // Shared entry point — call this for a just-died AI unit from any of the
  // four pools. Handles kill-count/XP crediting AND kill-feed recording.
  function _handleAiUnitDeath(unit) {
    if (!unit.isDead || unit._killCounted) return;
    unit._killCounted = true;

    if (unit._lastHitBy === "player") {
      killCount++;
      playerProfile.registerKill({ firstHit: !!unit._wasOneShotKill });
    }

    const victimDesc = _describeKillEntity(unit);
    const killerDesc = _resolveKillerDescForAiVictim(unit);
    if (killerDesc) recordKillEvent(killerDesc, victimDesc);

    _enemyHitCounts.delete(unit);
  }

  // canonical kill key -> { count, desc } — NEVER keyed by a pre-rendered
  // display string, since the correct label for an AI unit depends on
  // which client (host or guest, which team) is looking at it.
  const killStats = new Map();

  function _killDescKey(desc) {
    if (!desc) return null;
    if (desc.kind === "player") return "player:" + desc.uid;
    if (desc.stableId != null) return "ai:" + desc.stableId;
    return null; // generic/unresolved descriptors aren't tallied for MVP
  }

  function recordKillEvent(killerDesc, victimDesc, _fromNetwork = false) {
    if (!killerDesc || !victimDesc) return;
    const key = _killDescKey(killerDesc);
    if (key) {
      const prev = killStats.get(key);
      killStats.set(key, { count: (prev?.count ?? 0) + 1, desc: killerDesc });
    }
    addKillFeedEntry(killerDesc, victimDesc);

    // ── Ticket system — every destroyed vehicle (AI or real player, tank
    // or plane) costs its own team a ticket. _loseTicket is host-gated
    // internally, so this is safe to call from every client; the host is
    // the only one that actually mutates the counter, whether it detected
    // the kill itself or received it via the match:kill relay below.
    if (victimDesc.team) _loseTicket(victimDesc.team, TICKET_LOSS_PER_KILL);

    if (!_fromNetwork && matchSocket) {
      matchSocket.emit("match:kill", {
        killer: killerDesc,
        victim: victimDesc,
      });
    }
  }
  const killFeedContainer = document.createElement("div");
  killFeedContainer.id = "kill-feed";
  killFeedContainer.style.cssText = `
    position:fixed; top:16px; right:16px; z-index:160;
    display:flex; flex-direction:column; align-items:flex-end; gap:4px;
    font-family:'Courier New',monospace; pointer-events:none;
    max-width:340px;
  `;
  document.body.appendChild(killFeedContainer);

  const KILL_FEED_MAX_ENTRIES = 5;
  const KILL_FEED_DURATION_MS = 4500;

  // desc.team === localTeam → this client's own side, whether it's the
  // local player, a remote teammate, or a friendly AI unit.
  function _killFeedColor(desc) {
    if (desc?.kind === "player" && desc.uid === (config.userId ?? "local"))
      return "#44ffaa"; // you, specifically
    if (desc?.team === localTeam) return "#44aaff"; // your own side
    return "#ff4422"; // opposing side
  }

  // Marker prefixed onto anyone on THIS viewer's own team, so at a glance
  // — regardless of the label text — it's obvious who's a friendly.
  function _teamMarker(desc) {
    return desc?.team === localTeam ? "🛡 " : "";
  }

  function addKillFeedEntry(killerDesc, victimDesc) {
    const killerName = _labelForKillEntity(killerDesc);
    const victimName = _labelForKillEntity(victimDesc);

    const row = document.createElement("div");
    row.style.cssText = `
      background:transparent;
      padding:5px 10px; font-size:15px; color:#e8f0c0;
      opacity:0; transform:translateX(12px);
      transition:opacity 0.25s ease, transform 0.25s ease;
      white-space:nowrap;
    `;
    row.innerHTML =
      `<span style="color:${_killFeedColor(killerDesc)};font-weight:bold;">${_teamMarker(killerDesc)}${killerName}</span>` +
      `<span> ${KILL_ICON} </span>` +
      `<span style="color:${_killFeedColor(victimDesc)};font-weight:bold;">${_teamMarker(victimDesc)}${victimName}</span>`;
    killFeedContainer.appendChild(row);
    requestAnimationFrame(() => {
      row.style.opacity = "1";
      row.style.transform = "translateX(0)";
    });

    while (killFeedContainer.children.length > KILL_FEED_MAX_ENTRIES) {
      killFeedContainer.removeChild(killFeedContainer.firstChild);
    }

    setTimeout(() => {
      row.style.opacity = "0";
      row.style.transform = "translateX(12px)";
      setTimeout(() => row.remove(), 260);
    }, KILL_FEED_DURATION_MS);
  }

  function recordKill(killerName, victimName, _fromNetwork = false) {
    if (!killerName || !victimName) return;
    killStats.set(killerName, (killStats.get(killerName) || 0) + 1);
    addKillFeedEntry(killerName, victimName);
    if (!_fromNetwork && matchSocket) {
      matchSocket.emit("match:kill", { killerName, victimName });
    }
  }
  // ═══════════════ END NEW BLOCK ═══════════════

  // ═══════════════ XP EARNINGS FEED ═══════════════
  // Floating "+100 XP · Kill" toasts, driven entirely by the
  // 'profile:xp-gain' and 'profile:rank-up' events playerProfile.js
  // already dispatches (see addXP()) — no changes needed there.
  const xpFeedContainer = document.createElement("div");
  xpFeedContainer.id = "xp-feed";
  xpFeedContainer.style.cssText = `
    position:fixed; bottom:18%; left:50%; transform:translateX(-50%);
    z-index:9500; display:flex; flex-direction:column;
    align-items:center; gap:6px;
    font-family:'Courier New',monospace; pointer-events:none;
    width:320px;
  `;
  document.body.appendChild(xpFeedContainer);

  const XP_FEED_MAX_ENTRIES = 5;
  const XP_FEED_DURATION_MS = 2600;

  // Maps a `reason` string (passed into addXP()) to a short display label
  // and an accent color — purely cosmetic, falls back gracefully for any
  // reason string not listed here.
  const _xpReasonMeta = {
    Kill: { label: "Kill", color: "#ffffff" },
    "First-strike kill": { label: "One-Shot Kill", color: "#ffffff" },
    "Point captured": { label: "Capture", color: "#ffffff" },
    "Match victory": { label: "Victory", color: "rgb(255, 255, 255)" },
    "Match draw": { label: "Draw", color: "#ffffff" },
    "Match defeat": { label: "Defeat", color: "#ffffff" },
  };

  function addXpFeedEntry(amount, reason) {
    if (!amount) return;
    const meta = _xpReasonMeta[reason] ?? {
      label: reason || "XP",
      color: "#ffffff",
    };

    const row = document.createElement("div");
    row.style.cssText = `
      background:transparent;
      border: none;
      padding:6px 18px; font-size:16px; color:#e8f0c0;
      opacity:0; transform:translateY(-8px) scale(0.9);
      transition:opacity 0.25s ease, transform 0.25s ease;
      white-space:nowrap; border-radius:3px;
      text-align:center;
    `;
    row.innerHTML =
      `<span style="color:${meta.color};font-weight:bold;">+${amount} XP</span>` +
      `<span style="color:#ffffff;"> · ${meta.label}</span>`;
    xpFeedContainer.appendChild(row);

    requestAnimationFrame(() => {
      row.style.opacity = "1";
      row.style.transform = "translateY(0) scale(1)";
    });

    while (xpFeedContainer.children.length > XP_FEED_MAX_ENTRIES) {
      xpFeedContainer.removeChild(xpFeedContainer.firstChild);
    }

    setTimeout(() => {
      row.style.opacity = "0";
      row.style.transform = "translateY(-8px) scale(0.9)";
      setTimeout(() => row.remove(), 260);
    }, XP_FEED_DURATION_MS);
  }

  // ── Rank-up toast — bigger, centered, more dramatic, separate from the
  // small XP feed since a rank-up is a rarer, more significant event ──────
  const rankUpToast = document.createElement("div");
  rankUpToast.style.cssText = `
    position:fixed; top:35%; left:50%; transform:translate(-50%,-50%) scale(0.85);
    z-index:9500; display:none; flex-direction:column; align-items:center; gap:6px;
    font-family:'Courier New',monospace; pointer-events:none;
    opacity:0; transition:opacity 0.4s ease, transform 0.4s ease;
  `;
  rankUpToast.innerHTML = `
    <div style="font-size:11px; letter-spacing:0.3em; color:#8dff6a; text-shadow:0 0 8px rgba(120,255,90,0.8);">RANK UP</div>
    <div id="rank-up-name" style="font-size:28px; font-weight:bold; color:#f5f0e8; letter-spacing:0.08em; text-shadow:0 0 12px rgba(0,0,0,0.9);"></div>
    <div id="rank-up-reward" style="font-size:13px; color:#ffdd44; text-shadow:0 0 6px rgba(0,0,0,0.9);"></div>
  `;
  document.body.appendChild(rankUpToast);

  let _rankUpHideTimer = null;
  function showRankUpToast(name, currency1Reward) {
    if (_rankUpHideTimer) clearTimeout(_rankUpHideTimer);
    const nameEl = document.getElementById("rank-up-name");
    const rewardEl = document.getElementById("rank-up-reward");
    if (nameEl) nameEl.textContent = name;
    if (rewardEl)
      rewardEl.textContent =
        currency1Reward > 0 ? `+${currency1Reward} Credits` : "";

    rankUpToast.style.display = "flex";
    requestAnimationFrame(() => {
      rankUpToast.style.opacity = "1";
      rankUpToast.style.transform = "translate(-50%,-50%) scale(1)";
    });

    _rankUpHideTimer = setTimeout(() => {
      rankUpToast.style.opacity = "0";
      rankUpToast.style.transform = "translate(-50%,-50%) scale(0.85)";
      setTimeout(() => {
        rankUpToast.style.display = "none";
      }, 400);
    }, 3200);
  }

  // ── Wire up the listeners — playerProfile.js already dispatches both
  // events from inside addXP(); this is the only place that needs to
  // listen for them.
  window.addEventListener("profile:xp-gain", (e) => {
    const { amount, reason } = e.detail ?? {};
    addXpFeedEntry(amount, reason);
  });
  window.addEventListener("profile:rank-up", (e) => {
    const { name, currency1Reward } = e.detail ?? {};
    showRankUpToast(name, currency1Reward ?? 0);
  });
  // ═══════════════ END XP EARNINGS FEED ═══════════════

  // ── Repair Kit state ──────────────────────────────────────────────────────
  let repairKits = config.loadout?.repairKits ?? 0;
  const LOW_HEALTH_FRACTION = 0.5; // ← at/under this fraction of maxHealth, a tank catches fire until healed/repaired
  const MAX_REPAIR_HEALTH_FRACTION = 0.5; // heals 50% of maxHealth
  const REPAIR_MAX_SPEED = 0.5; // m/s — tank repair only allowed at/under this speed

  function _tankSpeed() {
    if (!tank.rigidBody) return 0;
    const v = tank.rigidBody.linvel();
    return Math.sqrt(v.x * v.x + v.z * v.z);
  }

  function updateRepairKitHUD() {
    const el = document.getElementById("repair-kit");
    if (!el) return;
    el.textContent = repairKits > 0 ? `x${repairKits}` : "0";
    const slot4 = document.getElementById("weapon-slot-4");
    if (slot4) {
      slot4.style.opacity = repairKits > 0 ? "1" : "0.35";
    }
  }

  let _repairHoldTimer = 0;
  let _repairHolding = false;
  let _repairUpsideDown = false; // cached once when repair starts
  // Tank's own repair duration — index.html already bakes any "repairTime"
  // research skill directly into `config` before this runs, so reading it
  // here just picks up the skill-adjusted value automatically.
  const TANK_REPAIR_HOLD_TIME = config.repairTime ?? 5; // seconds
  // Plane's repair duration is resolved separately (see confirmSpawnSelection,
  // after the plane's own selected-skills are applied) — placeholder default
  // here covers the window before the player's first plane deploy.
  let PLANE_REPAIR_HOLD_TIME = 5; // seconds

  function startRepair() {
    if (repairKits <= 0 || tank.isDead) return;
    if (_tankSpeed() > REPAIR_MAX_SPEED) return;
    const upsideDown = tank.isUpsideDown();
    if (tank.health >= tank.maxHealth && !upsideDown) return;
    if (_repairHolding) return;
    _repairUpsideDown = upsideDown; // cache once here, not every frame
    _repairHolding = true;
    _repairHoldTimer = 0;
    audio.startRepair();
    tank.turretController?.showRepairCross();
  }

  // ── Plane repair — mirrors the tank's hold-to-repair exactly, shares the
  // same repairKits pool, just targets `plane` instead of `tank`. Planes
  // have no isUpsideDown()/rightSelf() concept, so that part is skipped. ────
  let _planeRepairHoldTimer = 0;
  let _planeRepairHolding = false;

  function _setPlaneRepairProgress(fraction) {
    const arc = planeRepairFillEl;
    if (!arc) return;
    const clamped = Math.min(1, Math.max(0, fraction));
    arc.style.transition = "none";
    arc.style.strokeDashoffset = String(75.4 * (1 - clamped));
  }
  function startPlaneRepair() {
    if (repairKits <= 0 || !plane || plane.isDead) return;
    if (plane.health >= plane.maxHealth) return;
    if (_planeRepairHolding) return;
    _planeRepairHolding = true;
    _planeRepairHoldTimer = 0;
    audio.startRepair();
    if (planeRepairCross) planeRepairCross.style.display = "flex";
    _setPlaneRepairProgress(0);
  }

  function cancelPlaneRepair() {
    if (!_planeRepairHolding) return;
    _planeRepairHolding = false;
    _planeRepairHoldTimer = 0;
    audio.stopRepair();
    if (planeRepairCross) planeRepairCross.style.display = "none";
    _setPlaneRepairProgress(0);
    const el = document.getElementById("repair-kit");
    if (el) el.textContent = repairKits > 0 ? `x${repairKits}` : "0";
  }

  function tickPlaneRepair(dt) {
    if (!_planeRepairHolding) return;
    if (repairKits <= 0 || !plane || plane.isDead) {
      cancelPlaneRepair();
      return;
    }
    if (_planeSelectedSlot !== 4) {
      cancelPlaneRepair();
      return;
    }

    _planeRepairHoldTimer += dt;

    const el = document.getElementById("repair-kit");
    if (el) {
      el.textContent = `${Math.min(Math.ceil(_planeRepairHoldTimer), PLANE_REPAIR_HOLD_TIME)}s`;
    }

    _setPlaneRepairProgress(_planeRepairHoldTimer / PLANE_REPAIR_HOLD_TIME);

    if (_planeRepairHoldTimer >= PLANE_REPAIR_HOLD_TIME) {
      _planeRepairHolding = false;
      _planeRepairHoldTimer = 0;
      audio.stopRepair();
      if (planeRepairCross) planeRepairCross.style.display = "none";
      _setPlaneRepairProgress(0);
      repairKits--;

      if (plane.health < plane.maxHealth) {
        const healAmount = Math.floor(
          plane.maxHealth * MAX_REPAIR_HEALTH_FRACTION,
        );
        plane.health = Math.min(plane.maxHealth, plane.health + healAmount);
        playerHpBar.setHealth(plane.health);
      }

      updateRepairKitHUD();
      hudEl.style.transition = "filter 0.1s";
      hudEl.style.filter = "brightness(2) saturate(2)";
      setTimeout(() => {
        hudEl.style.filter = "";
      }, 300);
    }
  }

  function cancelRepair() {
    if (!_repairHolding) return;
    _repairHolding = false;
    _repairHoldTimer = 0;
    audio.stopRepair();
    tank.turretController?.hideRepairCross();
    // Restore the HUD label to the actual kit count
    const el = document.getElementById("repair-kit");
    if (el) el.textContent = repairKits > 0 ? `x${repairKits}` : "0";
  }

  function tickRepair(dt) {
    if (!_repairHolding) return;
    if (repairKits <= 0 || tank.isDead) {
      cancelRepair();
      return;
    }
    if (tank.activeWeapon !== 4) {
      cancelRepair();
      return;
    }
    if (_tankSpeed() > REPAIR_MAX_SPEED) {
      cancelRepair();
      return;
    }

    _repairHoldTimer += dt;

    // Show progress in the HUD label
    const el = document.getElementById("repair-kit");
    if (el) {
      const label =
        _repairUpsideDown && tank.health >= tank.maxHealth
          ? `Flip ${Math.min(Math.ceil(_repairHoldTimer), TANK_REPAIR_HOLD_TIME)}s`
          : `${Math.min(Math.ceil(_repairHoldTimer), TANK_REPAIR_HOLD_TIME)}s`;
      el.textContent = label;
    }

    // Drive the repair-cross ring fill in step with actual hold progress
    tank.turretController?.setRepairProgress(
      _repairHoldTimer / TANK_REPAIR_HOLD_TIME,
    );

    if (_repairHoldTimer >= TANK_REPAIR_HOLD_TIME) {
      _repairHolding = false;
      _repairHoldTimer = 0;
      audio.stopRepair();
      tank.turretController?.hideRepairCross();
      repairKits--;

      // ── Right the tank if it was upside down when repair started ──────────
      if (_repairUpsideDown) {
        tank.rightSelf();
      }

      // ── Heal only if not at full health ───────────────────────────────────
      if (tank.health < tank.maxHealth) {
        const healAmount = Math.floor(
          tank.maxHealth * MAX_REPAIR_HEALTH_FRACTION,
        );
        tank.health = Math.min(tank.maxHealth, tank.health + healAmount);
        playerHpBar.setHealth(tank.health);
      }

      _repairUpsideDown = false;
      updateRepairKitHUD();
      hudEl.style.transition = "filter 0.1s";
      hudEl.style.filter = "brightness(2) saturate(2)";
      setTimeout(() => {
        hudEl.style.filter = "";
      }, 300);
    }
  }

  updateRepairKitHUD();

  // No level system anymore — trySpawn() picks a random tank def per spawn

  // Define resolver once — no allocation on each shot
  // ── On non-host clients enemyPool/enemyPlanePool never spawn anything
  // (see the isHost gate in loop()) — only the visual proxies in
  // _remoteAIUnits exist there. This is the single source of truth for
  // "what can the local player currently shoot at?" on either role.
  function _getLocalEnemyTargets() {
    // "Enemy" here means "not on the local player's team" — team1Pool/
    // team2Pool are just raw AI-by-side, so pick whichever pool pair does
    // NOT match localTeam. This replaces the old enemyPool/enemyPlanePool
    // aliases, which happened to mean the same thing but only because they
    // were hard-wired at construction time — now it's computed live off
    // localTeam so it stays correct even if that ever changes.
    if (isHost) {
      const oppTankPool = localTeam === 1 ? team2Pool : team1Pool;
      const oppPlanePool = localTeam === 1 ? team2PlanePool : team1PlanePool;
      return [
        ...oppTankPool.getActiveTanks(),
        ...oppPlanePool.getActiveTanks(),
      ];
    }
    const list = [];
    for (const proxy of _remoteAIUnits.values()) {
      if (proxy && proxy.team !== localTeam) {
        list.push(proxy);
      }
    }
    return list;
  }

  const _enemyResolver = (rbHandle) => {
    const targets = _getLocalEnemyTargets();
    if (rbHandle === "__all__") return targets;
    return targets.find((t) => t.rigidBody?.handle === rbHandle) ?? null;
  };

  scope.setEnemyResolver(_enemyResolver);

  // ── Missile lock candidates — same AI-unit list as _enemyResolver, PLUS
  // every real opposing-team player's vehicle (their proxy in _remotePlayers,
  // whether that real player is the host or another guest). _enemyResolver
  // deliberately excludes real players (used for gun/mesh-hit resolution,
  // where real players are instead handled via a proximity fallback in
  // main.js's onHit relay) — but a guided rocket's lock-acquisition needs to
  // actually see them as candidates to ever home toward them.
  function _getMissileLockCandidates() {
    const list = _getLocalEnemyTargets();
    for (const rp of _remotePlayers.values()) {
      if (rp && rp.active && !rp.isDead && rp.team !== localTeam) {
        list.push(rp);
      }
    }
    return list;
  }

  const _missileLockResolver = (rbHandle) => {
    const targets = _getMissileLockCandidates();
    if (rbHandle === "__all__") return targets;
    return targets.find((t) => t.rigidBody?.handle === rbHandle) ?? null;
  };

  // Main gun — still click-based
  // Main gun — still click-based
  onFire(() => {
    if (!gameStarted) return;
    if (isPaused) return;
    if (matchEnded) return;
    if (_uiClickActive) return;

    // ── Plane fire routing (Gun handled continuously in the loop). Uses
    // _planeSelectedSlot (the UI slot, 1-4) rather than plane.activeWeapon
    // directly, since slot 3 (repair) has no plane.js weapon equivalent. ────
    if (vehicleType === "plane") {
      if (!plane || plane.isDead) return;
      if (_planeSelectedSlot === 1) return; // Gun handled continuously in loop
      if (_planeSelectedSlot === 2) {
        if (plane.cfg.rocketAuto) return;
        if (plane.rocketAmmo <= 0 || !plane.rocketSystem?.isReady) return;
        updatePlaneGunAimWorld();
        plane.fire(_missileLockResolver, _gunReticleWorld);
        _localFireSeq++;
        _updatePlaneWeaponHud();
        audio.playRocket();
        return;
      }
      if (_planeSelectedSlot === 3) {
        if (plane.bombAmmo <= 0 || !plane.bombSystem?.isReady) return;
        plane.fire(_enemyResolver);
        _localFireSeq++;
        _updatePlaneWeaponHud();
        return;
      }
      if (_planeSelectedSlot === 4) {
        startPlaneRepair();
        return;
      }
      if (_planeSelectedSlot === 6) return; // Hispano handled continuously in the loop
      return;
    }

    if (tank.isDead) return;
    if (tank.activeWeapon === 2) return; // MG handled in loop
    if (tank.activeWeapon === 3) {
      if (smokeCount <= 0) return;
      if (tank._smokeGrenadeSystem && !tank._smokeGrenadeSystem.isReady) return; // ← cooldown gate
      smokeCount--;
      document.getElementById("weapon-ammo-3").textContent = smokeCount;
      tank.fire(_enemyResolver);
      audio.playSmoke();

      // ── Multiplayer: broadcast smoke-throw so the other client(s) spawn
      // the same visual effect locally. Mirrors tank.fire()'s own origin/fwd
      // computation exactly (see Tank.fire()'s activeWeapon===3 branch) so
      // the replayed effect lands in the same place as the original.
      if (matchSocket && tank.rigidBody) {
        const _sp = tank.rigidBody.translation();
        const _srt = tank.rigidBody.rotation();
        matchSocket.emit("match:smoke-throw", {
          pos: { x: _sp.x, y: _sp.y, z: _sp.z },
          quat: { x: _srt.x, y: _srt.y, z: _srt.z, w: _srt.w },
        });
      }
      return;
    }
    if (tank.activeWeapon === 4) {
      startRepair();
      return;
    }

    if (tank.activeWeapon === 5) {
      if (!tank.cfg.enableRockets) return;
      if (tank.specialAmmo <= 0 || !tank.rocketSystem?.isReady) return;
      tank.fire(_enemyResolver);
      _localFireSeq++;
      const _ammo5El = document.getElementById("weapon-ammo-5");
      if (_ammo5El) _ammo5El.textContent = tank.specialAmmo;
      // ── Fire sound must match the weapon's actual type. specialWeaponType
      // can now be "gun", "rockets", or the combined "gun/rockets" — use
      // .includes() instead of a strict === "gun" match so the combined
      // value still resolves correctly. This mirrors the onHit sound
      // selection further up in init() (tank.rocketSystem.onHit).
      if (tank.cfg.specialWeaponType?.includes("gun")) {
        audio.playShot();
      } else {
        audio.playRocket?.();
      }
      return;
    }

    if (tank.cfg.gunType === 3) return; // continuous-fire multi-gun handled in loop, not on click
    if (!tank.bulletSystem.isReloaded) return;
    if (shellCount <= 0) return;
    shellCount--;
    document.getElementById("weapon-ammo-1").textContent = shellCount;
    tank.fire(_enemyResolver);
    _localFireSeq++;
    audio.playShot();
    _spawnGrassImpactNearGun(tank.turretController?.gunPoint);
    setTimeout(() => audio.playReload(), 800);
  });

  const _weaponSlots = [
    document.getElementById("weapon-slot-1"),
    document.getElementById("weapon-slot-2"),
    document.getElementById("weapon-slot-3"),
  ];
  const _rocketSlotEl = document.getElementById("weapon-slot-5"); // ← tank rocket slot

  const _planeWeaponSlotEls = [
    document.getElementById("plane-weapon-slot-1"),
    document.getElementById("plane-weapon-slot-2"),
    document.getElementById("plane-weapon-slot-3"),
  ];

  function _selectWeaponSlot(n) {
    tank.activeWeapon = n;
    _weaponSlots.forEach((el, i) => {
      el.style.border = i + 1 === n ? "1px solid #e8f0c0" : "1px solid #2a3a1a";
      el.style.background =
        i + 1 === n ? "rgba(100,160,60,0.18)" : "rgba(0,0,0,0.65)";
    });
    // Slot 4 highlight (repair kit)
    const slot4 = document.getElementById("weapon-slot-4");
    if (slot4) {
      slot4.style.border = n === 4 ? "1px solid #e8f0c0" : "1px solid #2a3a1a";
      slot4.style.background =
        n === 4 ? "rgba(100,160,60,0.18)" : "rgba(0,0,0,0.65)";
    }
    // Slot 5 highlight (rockets — only present when tank.cfg.enableRockets)
    if (_rocketSlotEl) {
      _rocketSlotEl.style.border =
        n === 5 ? "1px solid #e8f0c0" : "1px solid #2a3a1a";
      _rocketSlotEl.style.background =
        n === 5 ? "rgba(100,160,60,0.18)" : "rgba(0,0,0,0.65)";
    }
  }

  _selectWeaponSlot(1); // default

  // ── Plane weapon slots — 1=Gun, 2=Rocket, 3=Repair, 4=Bomb.
  // plane.activeWeapon keeps its own internal numbering (1=gun, 2=rocket,
  // 3=bomb inside plane.js's fire()); slot 3 (repair) is intercepted here
  // and never forwarded to plane.activeWeapon since plane.js has no
  // concept of a repair weapon — it's handled entirely in main.js, same
  // as the tank's repair kit.
  function _selectPlaneWeaponSlot(n) {
    if (!plane) return;

    // Map UI slot number → plane.js's internal weapon id
    // UI slot: 1=Gun, 2=Rocket, 3=Bomb, 4=Repair, 5=Flare
    // plane.activeWeapon: 1=Gun, 2=Rocket, 3=Bomb (4=repair, 5=flare have no plane.js equivalent)
    const _planeWeaponMap = { 1: 1, 2: 2, 3: 3, 6: 6 };
    if (_planeWeaponMap[n]) {
      plane.activeWeapon = _planeWeaponMap[n];
    }
    // n === 4 (repair) / n === 5 (flare) intentionally leave plane.activeWeapon
    // unchanged — both are driven by _planeSelectedSlot below, not plane.js's fire().
    _planeSelectedSlot = n;

    _planeWeaponSlotEls.forEach((el, i) => {
      if (!el) return;
      el.style.border = i + 1 === n ? "1px solid #e8f0c0" : "1px solid #2a3a1a";
      el.style.background =
        i + 1 === n ? "rgba(100,160,60,0.18)" : "rgba(0,0,0,0.65)";
    });

    const slot4 = document.getElementById("weapon-slot-4");
    if (slot4) {
      slot4.style.border = n === 4 ? "1px solid #e8f0c0" : "1px solid #2a3a1a";
      slot4.style.background =
        n === 4 ? "rgba(100,160,60,0.18)" : "rgba(0,0,0,0.65)";
    }

    const slot5 = document.getElementById("plane-weapon-slot-5");
    if (slot5) {
      slot5.style.border = n === 5 ? "1px solid #e8f0c0" : "1px solid #2a3a1a";
      slot5.style.background =
        n === 5 ? "rgba(100,160,60,0.18)" : "rgba(0,0,0,0.65)";
    }

    const slot6 = document.getElementById("plane-weapon-slot-6");
    if (slot6) {
      slot6.style.border = n === 6 ? "1px solid #e8f0c0" : "1px solid #2a3a1a";
      slot6.style.background =
        n === 6 ? "rgba(100,160,60,0.18)" : "rgba(0,0,0,0.65)";
    }
  }

  function _setFlightHudMode(isFlying) {
    // ── Swap the whole weapon-slot group instead of reusing the tank's —
    // the plane has its own Main Gun / Missile / Bomb icons and ammo
    // counters; only the Repair Kit slot (weapon-slot-4) is shared.
    const tankSlotsWrap = document.getElementById("tank-weapon-slots");
    const planeSlotsWrap = document.getElementById("plane-weapon-slots");
    if (tankSlotsWrap) tankSlotsWrap.style.display = isFlying ? "none" : "flex";
    if (planeSlotsWrap)
      planeSlotsWrap.style.display = isFlying ? "flex" : "none";

    // ── AI gun slot lives inside plane-weapon-slots but has its own
    // visibility rule (only shown for planes with AI guns) — force it
    // hidden immediately on switching away from the plane, so it doesn't
    // show stale state while driving the tank. _updateAiGunHud() will
    // re-show/re-hide it correctly once flying resumes.
    if (!isFlying) {
      const aiSlot = document.getElementById("plane-weapon-slot-ai");
      if (aiSlot) aiSlot.style.display = "none";
      _lastAiGunKey = "";
      const hspSlot = document.getElementById("plane-weapon-slot-6");
      if (hspSlot) hspSlot.style.display = "none";
    }

    planeCrosshair.style.display = isFlying ? "block" : "none";
    if (isFlying) _planeSelectedSlot = 1;
    if (!isFlying) autopilotBadge.style.display = "none";

    // ── Hide the tank's own turret HUD when switching to the plane —
    // tank.turretController.update() (the only place that keeps these
    // positioned/hidden) stops being called once vehicleType !== 'tank',
    // so without this they'd stay frozen on screen wherever the turret
    // last aimed instead of disappearing.
    if (isFlying) {
      tank.turretController?.hideHud();
    }
  }

  function _updatePlaneWeaponHud() {
    if (!plane) return;
    const mgEl = document.getElementById("plane-weapon-ammo-1");
    const rktEl = document.getElementById("plane-weapon-ammo-2");
    const bmbEl = document.getElementById("plane-weapon-ammo-3");
    const flrEl = document.getElementById("plane-weapon-ammo-5");
    const hspEl = document.getElementById("plane-weapon-ammo-6");
    if (mgEl) mgEl.textContent = plane.mgAmmo;
    if (rktEl) rktEl.textContent = plane.rocketAmmo;
    if (bmbEl) bmbEl.textContent = plane.bombAmmo;
    if (flrEl) flrEl.textContent = planeFlareAmmo;
    if (hspEl && plane.hispanoSystem) {
      const _hRounds = plane.hispanoSystem.rounds ?? 0;
      const _hReserve = Math.max(0, (plane.hispanoSystem.totalAmmo ?? 0) - _hRounds);
      hspEl.textContent = plane.hispanoSystem._reloading
        ? `${Math.ceil(plane.hispanoSystem._reloadTimer ?? 0)}s`
        : `${_hRounds}/${_hReserve}`;
    }
  }

  // ── Flare deploy — breaks any active missile lock on the player's plane.
  // Purely main.js-owned state (planeFlareAmmo/_flareDeployCooldown); no
  // plane.js changes required unless you want flares to also visually eject
  // from the airframe (plane.deployFlareEffect?.() below is optional/no-op
  // if plane.js doesn't implement it).
  function deployPlaneFlare() {
    if (!plane || plane.isDead) return;
    if (planeFlareAmmo <= 0) return;
    if (_flareDeployCooldown > 0) return;

    // Actually spawn the flares — this is the call that was missing before.
    // `deployFlareEffect` doesn't exist on Plane, so the optional-chained
    // call was a silent no-op: ammo ticked down here but flareSystem.deploy()
    // (glow billboards + trail ribbons) was never invoked.
    plane.deployFlares();

    // plane.deployFlares() releases cfg.flareCount flares per press (not 1),
    // and is the source of truth for remaining ammo — sync main.js's own
    // HUD-facing counter to it instead of decrementing independently.
    planeFlareAmmo = plane.flareAmmo;
    _flareDeployCooldown = FLARE_COOLDOWN;
    _updatePlaneWeaponHud();

    audio.playFlare?.();

    // Immediately break any active homing lock on this plane, same effect
    // as the missile-lock warning clearing.
    _setMissileLockWarning(false);
  }

  // ── Hides the Rocket (slot 2) / Bomb (slot 3) weapon-slot UI entirely
  // when the currently-mounted plane's GLB has no RocketPoint_L/R or
  // BombPoint nodes (plane.hasRockets / plane.hasBombs, set in
  // plane.js's _loadHullModel()). Gun (slot 1) and Repair (slot 4) are
  // always available regardless of model, so they're untouched here.
  // If the currently-selected slot is one that just got hidden, falls
  // back to the Gun slot so the player isn't left on a dead selection.
  function _updatePlaneWeaponSlotVisibility() {
    if (!plane) return;

    const rocketSlotEl = _planeWeaponSlotEls[1]; // slot 2 — Rocket
    const bombSlotEl = _planeWeaponSlotEls[2]; // slot 3 — Bomb
    const hispanoSlotEl = document.getElementById("plane-weapon-slot-6");

    if (rocketSlotEl)
      rocketSlotEl.style.display = plane.hasRockets ? "flex" : "none";
    if (bombSlotEl) bombSlotEl.style.display = plane.hasBombs ? "flex" : "none";
    if (hispanoSlotEl)
      hispanoSlotEl.style.display = plane.hasHispano ? "flex" : "none";

    const _slotMissing =
      (_planeSelectedSlot === 2 && !plane.hasRockets) ||
      (_planeSelectedSlot === 3 && !plane.hasBombs) ||
      (_planeSelectedSlot === 6 && !plane.hasHispano);
    if (_slotMissing) {
      _selectPlaneWeaponSlot(1);
    }
  }

  // ── AI turret gun HUD — shows only for planes that actually have
  // AI_Gun_N turrets (plane._aiGunSystems.length > 0). Ammo is summed
  // across every gun on the plane; if any gun is currently mid-reload,
  // shows a countdown using whichever reloading gun has the most time
  // left, instead of the ammo count.
  function _updateAiGunHud() {
    const slotEl = document.getElementById("plane-weapon-slot-ai");
    const ammoEl = document.getElementById("plane-weapon-ammo-ai");
    if (!slotEl || !ammoEl) return;

    const guns = plane?._aiGunSystems;
    const hasAiGuns = !!(guns && guns.length > 0 && guns.some((g) => g));

    if (!hasAiGuns) {
      if (slotEl.style.display !== "none") slotEl.style.display = "none";
      return;
    }

    if (slotEl.style.display !== "flex") slotEl.style.display = "flex";

    let totalLoaded = 0;
    let totalReserve = 0;

    const totalArr = plane._aiGunTotalAmmo ?? [];
    for (let i = 0; i < guns.length; i++) {
      const sys = guns[i];
      if (!sys) continue;
      totalLoaded += sys.rounds ?? 0;
      totalReserve += totalArr[i] ?? 0; // remaining pool is already reserve-only (loaded already subtracted at reload time)
    }

    const key = `${totalLoaded}:${totalReserve}`;
    if (key === _lastAiGunKey) return;
    _lastAiGunKey = key;

    ammoEl.textContent = `${totalLoaded}/${totalReserve}`;
  }

  // Apply loadout values
  let shellCount = config.loadout?.shellCount ?? 20;
  let smokeCount = config.loadout?.smokeCount ?? 2;
  let mgAmmo = config.loadout?.mgAmmo ?? 200;

  // Apply loadout values
  if (config.loadout) {
    if (tank.mgSystem) {
      tank.mgSystem.ammo = mgAmmo;
      tank.mgSystem.maxAmmo = mgAmmo;
      tank.mgSystem.rounds = Math.min(tank.mgSystem.magSize, mgAmmo);
    }
    if (config.loadout.repairKits !== undefined) {
      repairKits = config.loadout.repairKits;
    }
  }

  // ── Research upgrades: MG damage ────────────────────────────────────────
  // if (config.mgDamage && tank.mgSystem) {
  //   tank.mgSystem.damage = config.mgDamage;
  // }

  // Initialise HUD counts
  document.getElementById("weapon-ammo-1").textContent =
    tank.cfg.gunType === 3
      ? `${tank.bulletSystem?.rounds ?? 0}/${Math.max(0, shellCount - (tank.bulletSystem?.rounds ?? 0))}`
      : shellCount;
  document.getElementById("weapon-ammo-2").textContent =
    tank.mgSystem && tank.hasMachineGun
      ? `${tank.mgSystem.rounds}/${Math.max(0, mgAmmo - tank.mgSystem.rounds)}`
      : "—";
  document.getElementById("weapon-ammo-3").textContent = smokeCount;
  if (tank.cfg.enableRockets) {
    const _ammo5El = document.getElementById("weapon-ammo-5");
    if (_ammo5El) _ammo5El.textContent = tank.specialAmmo;
  }

  // ── Resets the tank's ammo/kits back to the original loadout — called
  // every time the player deploys the tank via the spawn-selection screen,
  // so a redeployed tank doesn't keep whatever depleted ammo it had at the
  // moment it died (or last returned to the tank from a plane deploy).
  function _resetTankLoadout() {
    shellCount = config.loadout?.shellCount ?? 20;
    smokeCount = config.loadout?.smokeCount ?? 2;
    mgAmmo = config.loadout?.mgAmmo ?? 200;
    repairKits = config.loadout?.repairKits ?? 0;
if (tank.cfg.enableRockets) {
  tank.specialAmmo = config.loadout?.specialAmmo ?? tank.cfg.specialAmmo;
}
if (tank.cfg.enableRockets) {
  tank.specialAmmo = config.loadout?.specialAmmo ?? tank.cfg.specialAmmo;
  if (typeof tank.rocketSystem?.setRemainingAmmo === 'function') {
    tank.rocketSystem.setRemainingAmmo(tank.specialAmmo);
  }
}

    if (tank.mgSystem) {
      tank.mgSystem.ammo = mgAmmo;
      tank.mgSystem.maxAmmo = mgAmmo;
      tank.mgSystem.rounds = Math.min(tank.mgSystem.magSize, mgAmmo);
      tank.mgSystem._reloading = false;
      tank.mgSystem._reloadTimer = 0; // ← clear any in-progress reload countdown from the previous life
    }
    if (tank.bulletSystem) {
      if (tank.cfg.gunType === 3) {
        tank.bulletSystem.rounds = Math.min(
          tank.bulletSystem.maxRounds ?? shellCount,
          shellCount,
        );
      }
      tank.bulletSystem._reloading = false;
      tank.bulletSystem._reloadTimer = 0; // ← same as above, for the main gun
    }

    document.getElementById("weapon-ammo-1").textContent =
      tank.cfg.gunType === 3
        ? `${tank.bulletSystem?.rounds ?? 0}/${Math.max(0, shellCount - (tank.bulletSystem?.rounds ?? 0))}`
        : shellCount;
    document.getElementById("weapon-ammo-2").textContent = tank.mgSystem
      ? `${tank.mgSystem.rounds}/${Math.max(0, mgAmmo - tank.mgSystem.rounds)}`
      : mgAmmo;
    document.getElementById("weapon-ammo-3").textContent = smokeCount;
    if (tank.cfg.enableRockets) {
      const _ammo5El = document.getElementById("weapon-ammo-5");
      if (_ammo5El) _ammo5El.textContent = tank.specialAmmo;
    }
    updateRepairKitHUD();
  }
  // ── Resets the plane's ammo back to its original loadout — called every
  // time the player deploys the plane via the spawn-selection screen, so a
  // redeployed plane doesn't keep whatever depleted ammo it had at the
  // moment it died (or last returned to the plane from a tank deploy).
  function _resetPlaneLoadout() {
    if (!plane) return;

    const _pc = _planePreset?.config ?? {};

    repairKits = config.loadout?.repairKits ?? 0;
    planeFlareAmmo = _pc.loadout?.flareAmmo ?? plane.cfg.flareAmmo;
    plane.flareAmmo = planeFlareAmmo; // keep Plane's own internal counter (used by deployFlares()'s ammo/cooldown gate) in sync with the HUD counter
    _flareDeployCooldown = 0;

    plane.mgAmmo = _pc.loadout?.mgAmmo ?? plane.maxMgAmmo ?? plane.mgAmmo;
    plane.rocketAmmo =
      _pc.loadout?.rocketAmmo ?? plane.maxRocketAmmo ?? plane.rocketAmmo;
    if (typeof plane.rocketSystem?.setRemainingAmmo === 'function') {
      plane.rocketSystem.setRemainingAmmo(plane.rocketAmmo);
    }
    plane.bombAmmo =
      _pc.loadout?.bombAmmo ?? plane.maxBombAmmo ?? plane.bombAmmo;

    if (plane.bulletSystem) {
      const _magCap =
        plane._gunType === 3
          ? (plane.bulletSystem.maxRounds ?? plane.mgAmmo) // MultiGunSystem (gunType 3)
          : (plane.bulletSystem.magSize ?? plane.mgAmmo); // MachineGunSystem
      plane.bulletSystem.rounds = Math.min(_magCap, plane.mgAmmo);
      plane.bulletSystem._reloading = false;
      plane.bulletSystem._reloadTimer = 0;
    }
    if (plane.rocketSystem) {
      plane.rocketSystem._reloading = false;
      plane.rocketSystem._reloadTimer = 0;
    }
    if (plane.bombSystem) {
      plane.bombSystem._reloading = false;
      plane.bombSystem._reloadTimer = 0;
    }
    if (plane.hispanoSystem) {
      plane.hispanoSystem.rounds = plane.hispanoSystem.maxRounds;
      plane.hispanoSystem._reloading = false;
      plane.hispanoSystem._reloadTimer = 0;
    }

    updateRepairKitHUD();

    const el1 = document.getElementById("weapon-ammo-1");
    if (el1) {
      if (plane._gunType === 3) {
        const _rounds = plane.bulletSystem?.rounds ?? 0;
        const _reserve = Math.max(0, plane.mgAmmo - _rounds);
        el1.textContent = `${_rounds}/${_reserve}`;
      } else {
        el1.textContent = plane.mgAmmo;
      }
    }
    document.getElementById("weapon-ammo-2").textContent = plane.rocketAmmo;
    document.getElementById("weapon-ammo-3").textContent = plane.bombAmmo;
    const _flrEl = document.getElementById("plane-weapon-ammo-5");
    if (_flrEl) _flrEl.textContent = planeFlareAmmo;
    _updatePlaneWeaponHud(); // syncs plane-weapon-ammo-6 (Hispano) from the freshly reset system
  }

  window.addEventListener("keydown", (e) => {
    if (vehicleType === "plane") {
      if (e.key === "1") _selectPlaneWeaponSlot(1);
      if (e.key === "2") _selectPlaneWeaponSlot(2);
      if (e.key === "3") _selectPlaneWeaponSlot(3);
      if (e.key === "4") _selectPlaneWeaponSlot(4);
      if (e.key === "6" && plane?.hasHispano) _selectPlaneWeaponSlot(6);
      return;
    }
    if (e.key === "1") _selectWeaponSlot(1);
    if (e.key === "2" && tank.hasMachineGun) _selectWeaponSlot(2);
    if (e.key === "3") _selectWeaponSlot(3);
    if (e.key === "4") _selectWeaponSlot(4);
    if (e.key === "5" && tank.cfg.enableRockets) _selectWeaponSlot(5);
  });
  // ── Manual reload key ("R") ────────────────────────────────────────────
  // Fixes: after an AmmoPoint refill following a 0-magazine state, the
  // gun stays unusable because fire() — which normally kicks off a
  // reload — never runs while isReady/isReloaded is false. "R" forces
  // the reload manually so refilled ammo is actually usable.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "r" && e.key !== "R") return;
    if (!gameStarted || isPaused || matchEnded || _uiClickActive) return;

    if (vehicleType === "plane") {
      if (!plane || plane.isDead) return;
      if (_planeSelectedSlot === 6) {
        manualReloadHispano();
        return;
      }
      if (_planeSelectedSlot !== 1) return; // only the plane's slot-1 gun reloads manually
      manualReloadPlane();
      return;
    }

    if (tank.isDead) return;
    if (tank.activeWeapon === 2) {
      if (!tank.hasMachineGun) return;
      manualReloadMG();
      return;
    }
    if (tank.activeWeapon !== 1) return; // only the main gun reloads manually
    manualReload();
  });

  // ── Landing gear toggle key ("G") — plane only ─────────────────────────
  window.addEventListener("keydown", (e) => {
    if (e.key !== "g" && e.key !== "G") return;
    if (e.repeat) return; // ignore OS key-repeat while held — one press = one toggle
    if (!gameStarted || isPaused || matchEnded || _uiClickActive) return;
    if (vehicleType !== "plane" || !plane || plane.isDead) return;

    plane.toggleLandingGear();
  });

  // ── Flare deploy key ("X") — plane only, works regardless of which
  // weapon slot is currently selected. Calls the same deployPlaneFlare()
  // used by the slot-5 mouse-click path, so ammo/cooldown/lock-break
  // logic is shared and unchanged.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "x" && e.key !== "X") return;
    if (e.repeat) return; // one press = one flare deploy, not continuous while held
    if (!gameStarted || isPaused || matchEnded || _uiClickActive) return;
    if (vehicleType !== "plane" || !plane || plane.isDead) return;

    deployPlaneFlare();
  });

  function manualReloadPlane() {
    const bs = plane?.bulletSystem;
    if (!bs) return;

    if (plane._gunType === 3) {
      // ── MultiGunSystem — mirrors the tank's gunType-3 manual reload ─────
      if (plane.mgAmmo <= 0) return;
      if (bs.rounds >= Math.min(bs.maxRounds, plane.mgAmmo)) return;
      bs._reloading = true;
      bs._reloadTimer = bs.fullReloadTime;
      audio.playMultiGunReload();
      startPlaneReloadAnimation(bs.fullReloadTime);
      _wasPlaneMultiGunReloading = true;
    } else {
      // ── MachineGunSystem — mirrors the tank's manualReloadMG ─────────────
      if (bs._reloading) return;
      if (plane.mgAmmo <= 0) return;
      if (bs.rounds >= Math.min(bs.magSize, plane.mgAmmo)) return;
      bs._reloading = true;
      bs._reloadTimer = bs.fullReloadTime;
      audio.playMGReload();
      startPlaneReloadAnimation(bs.fullReloadTime);
    }
  }

  
  function manualReloadHispano() {
    const hs = plane?.hispanoSystem;
    if (!hs) return;
    if (hs._reloading) return;
    if (hs.rounds >= hs.maxRounds) return;
    hs._reloading = true;
    hs._reloadTimer = hs.fullReloadTime;
    audio.playMultiGunReload();
    startPlaneReloadAnimation(hs.fullReloadTime);
    _wasHispanoReloading = true; // sync the edge-detector so the continuous-fire block doesn't replay the sound next frame
  }

  function manualReload() {
    const bs = tank.bulletSystem;
    if (!bs) return;

    if (tank.cfg.gunType === 3) {
      if (shellCount <= 0) return; // nothing in reserve
      if (bs.rounds >= Math.min(bs.maxRounds, shellCount)) return; // already full
      // Force-(re)start the reload countdown at its full configured duration,
      // instead of silently no-op'ing if a stale background reload was
      // already in progress with only a second or two left on it.
      bs._reloading = true;
      bs._reloadTimer = bs.fullReloadTime;
      audio.playMultiGunReload();
      // Sync the edge-detector so next frame's loop check doesn't see this
      // as a *new* false→true transition and fire the sound a second time.
      _wasMultiGunReloading = true;
    } else {
      if (!bs.isReloaded && shellCount > 0) {
        bs._reloading = false;
        audio.playReload();
      }
    }
  }

  function manualReloadMG() {
    const mg = tank.mgSystem;
    if (!mg) return;
    if (mg._reloading) return;
    if (mgAmmo <= 0) return;
    if (mg.rounds >= Math.min(mg.magSize, mgAmmo)) return;
    mg._reloading = true;
    mg._reloadTimer = mg.fullReloadTime;
    audio.playMGReload();
  }

  // ── Capture key ───────────────────────────────────────────────────────────
  window.addEventListener("keydown", (e) => {
    if (
      (e.key === "f" || e.key === "F") &&
      gameStarted &&
      !isPaused &&
      vehicleType === "tank" &&
      !tank.isDead
    )
      _fKeyHeld = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "f" || e.key === "F") {
      _fKeyHeld = false;
      _fHoldTimer = 0;
      setCaptureWipe(0);
      if (_nearPoint) _nearPoint.captureTimer = 0; // ← fully reset progress on release
    }
  });

  // ── Death screen wiring ───────────────────────────────────────────────────
  const deathScreen = document.getElementById("death-screen");

  function returnToMenu() {
    gameOver = true;
    // ── Incomplete match — discard every buffered kill/death/capture instead
    // of letting it leak into the persisted profile. applyMatchEnd() (which
    // calls playerProfile.commitMatchStats()) is the only path that should
    // ever save match stats; reaching returnToMenu() without matchEnded
    // having been set means the player left before the match finished.
    if (!matchEnded) {
      playerProfile.discardMatchStats();
    }
    exitGameplayPointerLock();
    showCursor(); // ← back to the menu/configurator, cursor must be visible
    _loopHardStopped = true; // ← stop the RAF chain immediately, synchronously —
    //   prevents world.step() from racing with the
    //   staggered cleanup timeouts below, which is what
    //   causes Rapier's "recursive use of an object" panic

    // ── Show cleanup overlay ──────────────────────────────────────────────
    const cleanupOverlay = document.createElement("div");
    cleanupOverlay.style.cssText = `
      position:fixed; inset:0;
      background:#0d0d0d;
      display:flex; flex-direction:column;
      align-items:center; justify-content:center;
      gap:16px; font-family:monospace;
      font-size:13px; color:#6a8a30;
      z-index:9999;
    `;
    const cleanupStatus = document.createElement("div");
    cleanupStatus.textContent = "Cleaning up…";
    const cleanupBarWrap = document.createElement("div");
    cleanupBarWrap.style.cssText =
      "width:260px;height:4px;background:#1a1a1a;border-radius:2px;overflow:hidden;";
    const cleanupBar = document.createElement("div");
    cleanupBar.style.cssText =
      "height:100%;width:0%;background:#6a8a30;transition:width 0.2s;";
    cleanupBarWrap.appendChild(cleanupBar);
    cleanupOverlay.appendChild(cleanupStatus);
    cleanupOverlay.appendChild(cleanupBarWrap);
    document.body.appendChild(cleanupOverlay);

    // ── Hide death screen immediately ─────────────────────────────────────
    deathScreen.style.display = "none";

    // ── Hide the autopilot badge immediately too. loop() stops running the
    // instant gameOver is set below/above, so whatever display state the
    // badge was left in on the last frame (e.g. 'block' if the plane's
    // autopilot was engaged at match end) would otherwise stay frozen on
    // screen through the cleanup overlay and back into the menu. ──────────
    autopilotBadge.style.display = "none";

    // ── Staggered cleanup steps ───────────────────────────────────────────
    const steps = [
      [
        0,
        "15%",
        "Stopping audio…",
        () => {
          audio.dispose();
          if (matchSocket) {
            matchSocket.emit("match:leave", { lobbyId: config.lobbyId });
            matchSocket.disconnect();
            matchSocket = null;
          }
          for (const rp of _remotePlayers.values()) {
            if (rp) rp.destroyPermanently();
          }
          _remotePlayers.clear();
          for (const au of _remoteAIUnits.values()) {
            if (au) au.destroyPermanently();
          }
          _remoteAIUnits.clear();
        },
      ],
      [
        150,
        "30%",
        "Despawning enemies…",
        () => {
          enemyPool.dispose();
          friendlyPool.dispose();
        },
      ],
      [
        300,
        "48%",
        "Destroying tank…",
        () => {
          tank.dispose();
          plane?.dispose();
          trackDecalSystem.dispose();
          enemyPlanePool.dispose();
          friendlyPlanePool.dispose();
        },
      ],
      [
        450,
        "60%",
        "Disposing scope…",
        () => {
          scope.dispose();
          clearInterval(_scopeGunPointWatcher);
          clearInterval(_scopeScopePointWatcher);
          clearInterval(_scopeBarrelWatcher);
          clearInterval(_scopeGunnerSightWatcher);
        },
      ],
      [
        580,
        "70%",
        "Removing terrain…",
        () => {
          terrainMesh.geometry.dispose();
          terrainMesh.material.dispose();
          scene.remove(terrainMesh);
          if (lensFlare) {
            scene.remove(lensFlare.mesh);
            lensFlare.dispose();
            lensFlare = null;
          }
          if (skyOverlayMesh) {
            scene.remove(skyOverlayMesh);
            skyOverlayMesh.geometry.dispose();
            skyOverlayMesh.material.map?.dispose();
            skyOverlayMesh.material.dispose();
            skyOverlayMesh = null;
          }
          scene.remove(sunSphereMesh);
          sunSphereGeo.dispose();
          sunSphereMat.dispose();
        },
      ],
      [
        700,
        "80%",
        "Clearing grass…",
        () => {
          ammoPointSystem.dispose();
          propSystem.dispose();
          carSystem.dispose();
          //         treeInstances.forEach(inst => {
          //   const g = inst.lod ?? inst.root;
          //   scene.remove(g);
          // });
          forestManager.dispose();
          houseSmokeSystem.dispose();
          grassPool.dispose?.();
          instancedBush.dispose();
          if (showWater) water.dispose();

          // ── Capture point flags ────────────────────────────────────────────────
          flagSystem.dispose();
          cpMarkerContainer.remove();
          _cpMarkerEls.clear();

          // ── Friendly plane / tank markers ────────────────────────────────────────
          friendlyPlaneMarkers.dispose();
          friendlyTankMarkers.dispose();

          // ← ADD THIS — clear throttle/dedup state so a fresh match doesn't skip
          // its first few marker updates thinking nothing has changed
          _cpMarkerLastState.clear();
          _cpMarkerAccum = 0;

          if (flightCloudMesh) {
            scene.remove(flightCloudMesh);
            flightCloudMesh.geometry.dispose();
            flightCloudMesh.material.uniforms.map.value?.dispose();
            flightCloudMesh.material.dispose();
            flightCloudMesh = null;
          }
          captureHud.remove();
          scoreHud.remove();
          teammatesHud.remove();
          matchEndScreen.remove();
          planeCrosshair.remove();
          planeScopedCrosshair.remove();
          planeRepairCross.remove();
          killFeedContainer.remove(); // NEW
          xpFeedContainer.remove();
          rankUpToast.remove();
          missileLockBadge.remove();
          _missileLockStyleEl.remove();
          if (_rankUpHideTimer) {
            clearTimeout(_rankUpHideTimer);
            _rankUpHideTimer = null;
          }

          // ── Spawn-selection UI — dispose controls + remove DOM in case a
          // respawn cycle was interrupted (e.g. match ended mid-selection, or
          // player quit to menu from the death screen while it was still up) ────
          spawnOrbitControls?.dispose();
          spawnOrbitControls = null;
          spawnMarkerContainer.remove();
          deploySpawnBtn.remove();
          vehicleTypeContainer.remove();
          spawnVignette.remove();

          // ── Damage overlays — updateDamageVignette()/showDamageFlash() only
          // ever animate these via opacity, and stop being called entirely once
          // matchEnded is true. If the player was mid-flash or at low health
          // (vignette opacity > 0) the instant the match ended, that opacity was
          // never cleared — so damage_effect.png stayed visibly baked onto the
          // screen after returning to the menu. Remove them outright here; a
          // fresh pair is created the next time init() runs.
          damageVignetteEl.remove();
          damageFlashEl.remove();
          deathBlurEl.remove();
          if (_damageFlashTimer) {
            clearTimeout(_damageFlashTimer);
            _damageFlashTimer = null;
          }
        },
      ],

      [
        820,
        "88%",
        "Releasing physics world…",
        () => {
          try {
            world.removeRigidBody(terrainBody);
          } catch (_) {}
          try {
            world.removeRigidBody(wallBody);
          } catch (_) {}
          // ── Remove house collider bodies ──────────────────────────────────────
          for (const body of _houseColliderBodies) {
            try {
              world.removeRigidBody(body);
            } catch (_) {}
          }
          _houseColliderBodies.length = 0;
          try {
            eventQueue.free();
          } catch (_) {}
          try {
            world.free();
          } catch (_) {}
        },
      ],
      [
        920,
        "94%",
        "Disposing renderer…",
        () => {
          debugRenderer.mesh.geometry.dispose();
          debugRenderer.mesh.material.dispose();
          scene.remove(debugRenderer.mesh);
          disposeComposer();
          if (tank._ejectedTurret) {
            scene.remove(tank._ejectedTurret);
            tank._ejectedTurret.traverse((c) => {
              if (c.isMesh) {
                c.geometry?.dispose();
                c.material?.dispose();
              }
            });
            tank._ejectedTurret = null;
          }
          scene.clear();
          renderer.domElement.remove();
          renderer.dispose();
          window.removeEventListener("mousemove", _onMousemove);
          window.removeEventListener("resize", _onResize);
          window.removeEventListener("keydown", _onKeydownDebug);
        },
      ],
      [
        1050,
        "100%",
        "Returning to menu…",
        () => {
          window.startPreviewMusic?.(); // ← fade preview music back in as the menu returns
          const controlsHud = document.querySelector(
            'body > div[style*="bottom: 24px"]',
          );
          controlsHud?.remove();
          document.getElementById("health").style.display = "none";
          // document.getElementById('hud-fps-wrap').style.display       = 'none';
          stats.dom.style.display = "none";
          document.getElementById("compass-bar").style.display = "none";
          document.getElementById("minimap").style.display = "none";
          document.getElementById("hud-speed").style.display = "none";
          document.getElementById("weapon-hud").style.display = "none";
          // document.getElementById('hud-kills').style.display          = 'none';
          // document.getElementById('hud-kills-val').textContent        = '0';
          document.getElementById("currency-hud-wrap").style.display = "flex"; // ← add this
          // document.getElementById('hud-fps').textContent              = '0';
          document.getElementById("hud-speed-val").textContent = "0.0";
          document.getElementById("hud-gear-val").textContent = "N";
          document.getElementById("weapon-ammo-1").textContent = "0";
          document.getElementById("weapon-ammo-2").textContent = "0";
          document.getElementById("weapon-ammo-3").textContent = "0";
          minimapEnemyEl.innerHTML = "";
          enemyPosCache.clear();
          minimapFriendlySet.clear();
          minimapFriendlyDots.clear();
          friendlyPosCache.clear();
          playerHpBar.remove();
          document.getElementById("upload-zone")?.classList.remove("has-file");
          const _fileNameEl = document.getElementById("file-name");
          if (_fileNameEl)
            _fileNameEl.textContent =
              "No file selected — default Tiger I will be used";
          const _modelInputEl = document.getElementById("model-input");
          if (_modelInputEl) _modelInputEl.value = "";
          setTimeout(() => {
            cleanupOverlay.remove();
            // ── Hide panels BEFORE showing configurator to prevent flash ──
            // NOTE: cfg-panel / tank-select-panel visibility is owned by
            // _openPanel()'s CSS classes (panel-hidden / panel-open), not inline
            // display. Clear any inline override instead of forcing 'none' here,
            // or _openPanel() can never show them again afterward.
            document.getElementById("cfg-panel").style.display = "";
            document.getElementById("cfg-close-btn").style.display = "none";
            document.getElementById("tank-select-panel").style.display = "flex";
            document.getElementById("tank-select-close-btn").style.display =
              "none";
            document.getElementById("tank-switcher").style.display = "none";
            document.getElementById("configurator").style.display = "flex";
            document.getElementById("loading").style.display = "none";
            document.getElementById("preview-info-btn").style.display = "flex";
            document.getElementById("auto-rotate-btn").style.display = "flex";
            document.getElementById("preview-top-left-btns").style.display =
              "flex";
            document.getElementById("map-selector-widget").style.display =
              "block";
            document.getElementById("setting-toggle-btn").style.display =
              "flex";
            document.getElementById("store-toggle-btn").style.display = "flex";

            // ── Force all left panels closed on menu return ────────────────────
            setTimeout(() => {
              document.getElementById("cfg-panel").style.display = "";
              document.getElementById("cfg-close-btn").style.display = "none";
              document.getElementById("tank-select-panel").style.display =
                "flex";
              document.getElementById("tank-select-close-btn").style.display =
                "none";
              document.getElementById("tank-switcher").style.display = "none";
              document.getElementById("preview-top-left-btns").style.display =
                "flex";
              document.getElementById("map-selector-widget").style.display =
                "block";
              window._openPanel?.("none");
            }, 50);

            window._openPanel?.("none");

            // ── Restore cfg-panel scroll ───────────────────────────────────
            const _cfgPanel = document.getElementById("cfg-panel");
            if (_cfgPanel) {
              _cfgPanel.style.overflowY = "auto";
              _cfgPanel.style.pointerEvents = "auto";
              _cfgPanel.style.display = ""; // ← was 'none' — this is what permanently broke reopening
              _cfgPanel.scrollTop = _cfgPanel.scrollTop;
            }

            // ── Defensive: also clear any stray inline display on the other two
            // panels, in case they were ever force-closed the same way elsewhere.
            const _planeSelectPanelEl =
              document.getElementById("plane-select-panel");
            if (_planeSelectPanelEl) _planeSelectPanelEl.style.display = "flex";
            const _friendsPanelEl = document.getElementById("friends-panel");
            if (_friendsPanelEl) _friendsPanelEl.style.display = "flex";

            // ── Remove any stale canvas pointer-event blocks ───────────────
            const _oldCanvas = document.querySelector(
              "canvas:not(#preview-canvas):not(#minimap-canvas)",
            );
            if (_oldCanvas) _oldCanvas.remove();

            // ── Dispose stale preview tracks before rebuilding ─────────────
            if (window._previewTracks) {
              window._previewTracks.forEach((t) => {
                try {
                  t.dispose();
                } catch (_) {}
              });
              window._previewTracks.length = 0;
            }

            // ── Reinit physics first, then build tracks + start loop ───────
            window.initPreviewPhysics?.().then(() => {
              window.buildPreviewTracks?.();
              window.loadPreviewModel?.(
                window._lastTankConfig?.modelObjectURL ??
                  window._lastTankConfig?.modelPath ??
                  "/model/Tank_Tiger_L.glb",
              );
              window.startPreviewLoop?.();
            });
          }, 300);
        },
      ],
    ];

    steps.forEach(([delay, width, text, fn]) => {
      setTimeout(() => {
        cleanupStatus.textContent = text;
        cleanupBar.style.width = width;
        fn();
      }, delay);
    });
  }

  document
    .getElementById("death-menu-btn")
    .addEventListener("click", returnToMenu);

  // ── Camera smoothing ──────────────────────────────────────────────────────
  const smoothCamPos = new THREE.Vector3(0, 6, 14);
  const smoothCamLook = new THREE.Vector3();

  // ── Plane chase-camera scratch ──────────────────────────────────────────
  const _planeCamPos = new THREE.Vector3();
  const _planeCamLook = new THREE.Vector3();
  const _planeFwd = new THREE.Vector3();
  const _planeUp = new THREE.Vector3();
  const _planeSmoothPos = new THREE.Vector3();
  const _planeSmoothLook = new THREE.Vector3();
  let _planeMgCooldown = 0; // manual MG fire-rate gate — plane.fire() doesn't self-throttle
  let _planeSelectedSlot = 1; // UI slot currently selected for the plane: 1=Gun, 2=Rocket, 3=Bomb, 4=Repair, 5=Flare
  let planeFlareAmmo = 0; // set per-deploy from the plane preset's loadout
  let _flareDeployCooldown = 0; // simple fire-rate gate for flare deploys
  const FLARE_COOLDOWN = 1.0; // seconds between flare deploys — tune to taste

  // ── Deploy/respawn camera flythrough — fires every time the player
  // spawns or respawns, in either vehicle, not just on first deploy ───────
  let deployCamActive = false;
  let deployCamElapsed = 0;
  const DEPLOY_CAM_DURATION = 1.5; // seconds, "smooth medium speed"

  // ── Death-hold camera — freezes the camera in place at the death spot
  // for a few seconds while the game keeps simulating normally, instead
  // of snapping straight into the (frozen) spawn-picker ──────────────────
  let _deathHoldActive = false;
  let _deathHoldTimer = 0;
  const DEATH_HOLD_DURATION = 2; // seconds

  const _deployCamStartPos = new THREE.Vector3();
  const _deployCamStartLook = new THREE.Vector3();
  const _deployCamEndLook = new THREE.Vector3();
  let _deployCamStartFov = 100;
  let _deployCamTargetFov = 55;

  // ── Flight clouds — GPU-billboarded instanced quads (always face the
  // camera every frame via vertex-shader billboarding), so they read as
  // puffs from ANY viewing angle instead of flat cards seen edge-on.
  // Still ONE draw call (InstancedBufferGeometry) — billboarding is just
  // swapping which basis vectors offset each vertex, no CPU cost. ───────
  let flightCloudMesh = null;
  const CLOUD_LAYER_MIN_ALT = 150;
  const CLOUD_LAYER_MAX_ALT = 300;
  const CLOUD_FOG_DENSITY_MAX = 0.045; // ← tune: higher = thicker whiteout inside the cloud band
  let _spawnCloudActive = false; // ← true while the flight-cloud layer is being shown over spawn-selection

  (function _buildFlightClouds() {
    const cloudTex = texLoader.load(
      "https://mrdoob.com/lab/javascript/webgl/clouds/cloud10.png",
    );
    cloudTex.colorSpace = THREE.SRGBColorSpace;
    cloudTex.magFilter = THREE.LinearFilter;
    cloudTex.minFilter = THREE.LinearMipMapLinearFilter;

    const CLOUD_COUNT = 700;
    const FIELD_HALF = 900;

    const baseGeo = new THREE.PlaneGeometry(120, 120);
    const instGeo = new THREE.InstancedBufferGeometry();
    instGeo.index = baseGeo.index;
    instGeo.attributes.position = baseGeo.attributes.position;
    instGeo.attributes.uv = baseGeo.attributes.uv;

    const offsets = new Float32Array(CLOUD_COUNT * 3);
    const scales = new Float32Array(CLOUD_COUNT);
    const rolls = new Float32Array(CLOUD_COUNT);

    for (let i = 0; i < CLOUD_COUNT; i++) {
      offsets[i * 3 + 0] = (Math.random() * 2 - 1) * FIELD_HALF;
      offsets[i * 3 + 1] = (Math.random() - 0.5) * 25;
      offsets[i * 3 + 2] = (Math.random() * 2 - 1) * FIELD_HALF;
      scales[i] = Math.random() * Math.random() * 3.0 + 1.2;
      rolls[i] = Math.random() * Math.PI * 2;
    }

    instGeo.setAttribute(
      "instanceOffset",
      new THREE.InstancedBufferAttribute(offsets, 3),
    );
    instGeo.setAttribute(
      "instanceScale",
      new THREE.InstancedBufferAttribute(scales, 1),
    );
    instGeo.setAttribute(
      "instanceRoll",
      new THREE.InstancedBufferAttribute(rolls, 1),
    );
    instGeo.instanceCount = CLOUD_COUNT;

    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          map: { value: cloudTex },
          uOpacity: { value: 0.0 },
          uTint: { value: new THREE.Color(0xffffff) }, // ← warm tan tint, matches ground-level cloud shader
          // ── Spawn-select "hole" — punches a soft-edged clear gap through
          // the cloud layer centered on wherever the camera is looking, so
          // the map stays visible in the middle instead of the whole screen
          // being covered. uHoleEnabled gates this off entirely (0) during
          // normal flight, so it never affects clouds seen while piloting.
          uHoleCenter: { value: new THREE.Vector2(0, 0) }, // world XZ point the camera is looking at
          uHoleRadius: { value: 220 }, // world units — fully-clear inner radius
          uHoleFeather: { value: 140 }, // world units — soft fade width beyond uHoleRadius
          uHoleEnabled: { value: 0.0 }, // 0 = hole disabled (normal flight), 1 = hole active (spawn-select)
        },
      ]),
      vertexShader: `
        attribute vec3  instanceOffset;
        attribute float instanceScale;
        attribute float instanceRoll;
        uniform vec2 uHoleCenter;
        varying vec2 vUv;
        varying float vHoleDist;
        #include <fog_pars_vertex>
        void main() {
          vUv = uv;

          // Camera-facing basis vectors pulled straight from the view
          // matrix — this is what makes the quad billboard every frame.
          vec3 cameraRight = vec3(viewMatrix[0].x, viewMatrix[1].x, viewMatrix[2].x);
          vec3 cameraUp    = vec3(viewMatrix[0].y, viewMatrix[1].y, viewMatrix[2].y);

          float c = cos(instanceRoll), s = sin(instanceRoll);
          vec2 rotated = vec2(
            position.x * c - position.y * s,
            position.x * s + position.y * c
          );

          vec3 worldPos = (modelMatrix * vec4(instanceOffset, 1.0)).xyz
                         + (cameraRight * rotated.x + cameraUp * rotated.y) * instanceScale;

          // World-XZ distance from this cloud instance's center to wherever
          // the camera is currently looking — used in the fragment shader to
          // punch the soft hole through the layer.
          vHoleDist = length(instanceOffset.xz - uHoleCenter);

          vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform float uOpacity;
        uniform vec3  uTint;
        uniform float uHoleRadius;
        uniform float uHoleFeather;
        uniform float uHoleEnabled;
        varying vec2 vUv;
        varying float vHoleDist;
        #include <fog_pars_fragment>
        void main() {
          vec4 tex = texture2D(map, vUv);

          // holeFactor is 1.0 (no effect) whenever uHoleEnabled is 0 — this
          // is what keeps normal in-flight clouds completely unaffected.
          // While enabled, it eases from 0 (fully clear) inside uHoleRadius
          // up to 1 (full opacity) over the next uHoleFeather world units.
          float rawHole = smoothstep(uHoleRadius, uHoleRadius + uHoleFeather, vHoleDist);
          float holeFactor = mix(1.0, rawHole, uHoleEnabled);

          float a = tex.a * uOpacity * holeFactor;
          if (a < 0.02) discard;
          // Multiply the texture's own grey/white shading by the tint color —
          // keeps the cloud's natural shadow/highlight shading intact while
          // recoloring it to match the warm ground-level cloud tone instead
          // of rendering stark white against the orange sky.
          vec3 col = tex.rgb * uTint;
          gl_FragColor = vec4(col, a);
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    });

    flightCloudMesh = new THREE.Mesh(instGeo, mat);
    // Instance offsets live outside the base quad's bounding sphere, so
    // frustum culling against that sphere alone would wrongly cull the
    // whole field the moment the mesh's own origin left view.
    flightCloudMesh.frustumCulled = false;
    flightCloudMesh.renderOrder = 4; // ← was 6; must render BEFORE explosion/smoke particle layers (renderOrder 5) so plane damage smoke isn't hidden behind the cloud billboard field
    flightCloudMesh.visible = false;
    flightCloudMesh.position.set(
      0,
      (CLOUD_LAYER_MIN_ALT + CLOUD_LAYER_MAX_ALT) / 2,
      0,
    );
    scene.add(flightCloudMesh);

    // ← ADD: draw the lens flare BEFORE the cloud layer, so clouds visually
    // cover the flare instead of the flare always winning purely because
    // it ignores depth testing (see lensFlare.js's mesh.renderOrder).
    if (lensFlare) {
      lensFlare.mesh.renderOrder = flightCloudMesh.renderOrder - 1;
    }

    baseGeo.dispose();
  })();

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function startDeployCamera() {
    // _deployCamStartPos / _deployCamStartLook are captured directly from
    // the camera's actual last pose on the spawn-selection screen (see
    // confirmSpawnSelection()), so this flythrough always starts exactly
    // where the player left the camera. Runs on EVERY deploy — first spawn
    // and every respawn after — for both tank and plane, never just once.
    deployCamActive = true;
    deployCamElapsed = 0;
    _deployCamStartFov = camera.fov;
  }

  // ── Per-frame scratch vectors — never re-allocated inside the loop ────────
  const _tankPos = new THREE.Vector3(); // tank world position (reused)
  const _playerPos = new THREE.Vector3(); // passed to enemyPool.update
  const _desiredCamPos = new THREE.Vector3(); // camera target position
  const _camOffset = new THREE.Vector3(); // camera orbit offset
  const _barrelDir = new THREE.Vector3();

  const _fenceTankPositions = []; // reused every frame — avoids per-frame array alloc

  // ── Track decal scratch objects ─────────────────────────────────────────
  const _decalWorldQ = new THREE.Quaternion();
  const _decalPosL = new THREE.Vector3();
  const _decalPosR = new THREE.Vector3();
  const _decalOffsetL = new THREE.Vector3();
  const _decalOffsetR = new THREE.Vector3();

  // ── Terrain-climb camera state ────────────────────────────────────────────
  let _lastTankY = 0; // tank Y last frame — used to derive vertical speed
  let _camPitchBias = 0; // extra pitch added to camPitch when climbing/descending
  let _camHeightBias = 0; // extra height offset added to smoothCamPos

  // ── Speed HUD throttle ────────────────────────────────────────────────────
  let speedFrameSkip = 0;

  // ── Enemy cache throttle ──────────────────────────────────────────────────────
  let enemyCacheSkip = 0;
  let friendlyCacheSkip = 0;
  let playerMinimapSkip = 0; // ← ADD THIS — throttles the minimap player dot to every 50 frames, same cadence as friendly dots

  // ── Bullet vec pool — pre-allocated, never re-allocated inside loop ───────────
  // const _bulletVecPool = Array.from({ length: 20 }, () => new THREE.Vector3());

  // ── Resize ────────────────────────────────────────────────────────────────
  const _onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (composer) composer.setSize(window.innerWidth, window.innerHeight);
    water.setSize(window.innerWidth, window.innerHeight);
    _positionTeammatesHud();
  };
  window.addEventListener("resize", _onResize);

  window.addEventListener("keydown", (e) => {
    if (e.key === "]") exportTerrainAsGLB();
  });

  // ── cycleData — updated every frame ───────────────────────────────────────
  const cycleData = {
    now: 0,
    delta: 0,
    elapsed: 0,
    totalPauseTime: 0,
    pauseStartTime: 0,
    waterEnabled: showWater,
    waterY: _waterDef.y ?? terrainData.waterLevel ?? 8.4,
  };

    // ── Missile-lock warning check — throttled, cheap. Only scans the small
  // number of active OPPOSING-team AI planes' rocket systems (each check
  // is O(8) — see RocketSystem.hasActiveLockOn), never the player's own
  // team, never friendly planes. Runs a few times a second, not every frame.
  const MISSILE_LOCK_CHECK_INTERVAL = 0.15;
  let _missileLockCheckTimer = 0;
  let _isPlayerMissileLocked = false;

  function _setMissileLockWarning(active) {
    if (active === _isPlayerMissileLocked) return; // only touch the DOM on an actual state change
    _isPlayerMissileLocked = active;
    missileLockBadge.style.display = active ? "block" : "none";
    if (active) audio.playMissileLockAlert();
  }

  function _checkPlayerMissileLock(dt) {
    _missileLockCheckTimer -= dt;
    if (_missileLockCheckTimer > 0) return;
    _missileLockCheckTimer = MISSILE_LOCK_CHECK_INTERVAL;

    if (
      vehicleType !== "plane" ||
      !plane ||
      plane.isDead ||
      !plane.rigidBody ||
      matchEnded ||
      _spawnSelectionActive
    ) {
      _setMissileLockWarning(false);
      return;
    }

    const rb = plane.rigidBody;
    let locked = false;

    // Only the host actually runs real EnemyPlane instances (with a real
    // RocketSystem) — this check is naturally a no-op on a guest's own
    // local (non-simulating) pool objects, since their getActiveTanks()
    // is always empty there (see the isHost gate in EnemyPlanePool.update()).
    for (const p of team1PlanePool.getActiveTanks()) {
      if (p.team === localTeam || p.isDead) continue;
      if (p.rocketSystem?.hasActiveLockOn(rb)) {
        locked = true;
        break;
      }
    }
    if (!locked) {
      for (const p of team2PlanePool.getActiveTanks()) {
        if (p.team === localTeam || p.isDead) continue;
        if (p.rocketSystem?.hasActiveLockOn(rb)) {
          locked = true;
          break;
        }
      }
    }

    _setMissileLockWarning(locked);
  }
  // ── Game loop ─────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  const FIXED = 1 / 60;
  let accum = 0;
  let _smoothedDt = FIXED; // ← running average render dt, used for visual smoothing only
  let _loopRunning = false; // ← guards against starting the RAF chain twice
  let _loopHardStopped = false; // ← set synchronously by returnToMenu() so no further
  //   RAF frame can call world.step()/touch the physics
  //   world once cleanup (tank.dispose(), etc.) begins
  let _physicsBroken = false; // ← set true the instant world.step() panics — once Rapier's

  function loop() {
    if (gameOver || _loopHardStopped) return;
    if (isPaused) {
      requestAnimationFrame(loop);
      return;
    }

    // NOTE: spawn-selection no longer early-returns here — physics, enemies,
    // friendlies, and the match timer must keep running while the player
    // picks a spawn point. Only camera + player-tank input are swapped out
    // further down (see the two guards below).
    requestAnimationFrame(loop);

    let dt = clock.getDelta();
    // ── Clamp raw dt to avoid spikes from tab-switch, GC pause, alt-tab ────
    dt = Math.min(dt, 1 / 20); // never treat a frame as slower than 20fps worth
    accum += dt;

    // ── Smoothed dt for visual-only springs (suspension, hull tilt, camera) ─
    // Physics still uses the raw fixed-step accumulator below — this is only
    // to stop render-frame jitter from leaking into spring-damper math.
    _smoothedDt += (dt - _smoothedDt) * 0.15;

    cycleData.delta = dt;
    cycleData.elapsed += dt;
    cycleData.now = performance.now();

    // ── Cache translation once — used everywhere below ─────────────────────
    const _tPos = tank.rigidBody ? tank.rigidBody.translation() : null;
    const _activePos =
      vehicleType === "plane" && plane?.rigidBody
        ? plane.rigidBody.translation()
        : _tPos;

    // ── Crossfade skybox based on current altitude — but freeze it at
    // whatever it was the moment the plane died, instead of continuing
    // to track the wreck's falling Y (which would fade the high-altitude
    // sky back out as it descends). Only updates while actively flying
    // alive, or for the tank/ground vehicle as normal.
    if (!(vehicleType === "plane" && plane && plane.isDead)) {
      const _skyboxAltSource =
        vehicleType === "plane" && plane
          ? plane.bodyGroup.position.y
          : _activePos
            ? _activePos.y
            : null;
      updateSkyboxForAltitude(_skyboxAltSource);
    }
    // else: plane is dead — skip the call entirely, leaving
    // skyOverlayMesh.material.uniforms.uOpacity.value exactly as it was.

    // ── Stats panel ──────────────────────────────────────────────────────
    stats.update();

    // ── Mute AI engine sound while the spawn-selection screen owns the
    // camera — covers both the initial pre-deploy screen and any
    // mid-match respawn spawn-pick. AI pools keep updating/patrolling
    // normally underneath; only their engine loops go silent.
    audio._enemyEngineSuppressed = _spawnSelectionActive;

    // ── Same suppression for weapon-fire SFX (player shot/rocket/MG-start
    // and all AI gunfire) while the spawn-selection screen is up.
    audio._fireSfxSuppressed = _spawnSelectionActive;

    // ── Multiplayer: broadcast local transform, tick remote players ─────
    sendNetworkStateIfDue(dt);
    sendAiStateIfDue(dt);
    sendCpStateIfDue(dt);
    sendTimerStateIfDue(dt);
    _pushCandidatesToAiPools();
    _pushThreatsToAiPlanePools();
    EnemyTrackSystem.drainNearQueue(); // ← ADD — guests never run enemyPool.update() (isHost-gated), so this must be ticked independently or every RemotePlayerTank/RemotePlayerPlane proxy's track system stays stuck in 'pending_near' forever (no wheels/belt ever built)
    for (const rp of _remotePlayers.values()) {
      if (rp) rp.update(dt, _activePos);
    }
    for (const au of _remoteAIUnits.values()) {
      if (au) au.update(dt, _activePos);
    }


    // ── Missile-lock warning — internally throttled, safe to call every frame ──
    _checkPlayerMissileLock(dt);

    // Only reset cloud visibility while the player is actively flying-and-
    // alive or on the pre-deploy spawn screen — those branches re-assert
    // visibility/opacity themselves every frame anyway. Once the plane is
    // dead, leave the clouds exactly as they were (see the dead-plane
    // branch below) instead of forcing them off here first.
    if (flightCloudMesh && !(plane && plane.isDead)) {
      flightCloudMesh.visible = false;
    }

    // ── Speed / gear (or throttle, while flying) HUD — throttled to every
    // 10 frames ─────────────────────────────────────────────────────────
    // Gated on _activePos (whichever vehicle is actually being driven),
    // not _tPos (tank-only). If tank.rigidBody ever goes null after the
    // tank dies once, _tPos stays null for the rest of the match, and
    // gating on it silently freezes this entire block — including the
    // gear/throttle label — even after switching to and flying a plane.
    if (_activePos) {
      speedFrameSkip++;
      if (speedFrameSkip >= 10) {
        speedFrameSkip = 0;

        // ── Speed source: while flying, the tank's own rigid body is
        // parked at y=-500 with zero velocity, so reading tank.linvel()
        // here would show a frozen/wrong speed. Use the plane's actual
        // airspeed instead when vehicleType is 'plane'. ─────────────────
        let speedKmh;
        if (vehicleType === "plane" && plane) {
          speedKmh = plane.airspeed * 3.6;
        } else if (tank.rigidBody) {
          const vel = tank.rigidBody.linvel();
          speedKmh =
            Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z) * 3.6;
        } else {
          speedKmh = 0;
        }
        const _speedStr = speedKmh.toFixed(1);
        if (_speedStr !== _lastSpeedStr) {
          _lastSpeedStr = _speedStr;
          document.getElementById("hud-speed-val").textContent = _speedStr;
        }
      }

      // ── Gear box — shows THR/throttle% while flying a plane, GEAR/gear
      // while driving a tank. Cache key is prefixed with the vehicle type,
      // so switching vehicles always differs from whatever was cached
      // before and forces an immediate, correct write.
      if (vehicleType === "plane" && plane) {
        const _throttlePct = `${Math.round(plane.throttle * 100)}%`;
        const _key = "plane:" + _throttlePct;
        if (_key !== _lastGearLabel) {
          _lastGearLabel = _key;
          document.getElementById("hud-gear-label").textContent = "THR";
          document.getElementById("hud-gear-val").textContent = _throttlePct;
        }
      } else if (vehicleType === "tank") {
        const g = tank.gear;
        const label = g < 0 ? `R${Math.abs(g)}` : g === 0 ? "N" : String(g);
        const _key = "tank:" + label;
        if (_key !== _lastGearLabel) {
          _lastGearLabel = _key;
          document.getElementById("hud-gear-label").textContent = "GEAR";
          document.getElementById("hud-gear-val").textContent = label;
        }
      }

      // Smoke grenade cooldown display
      if (tank._smokeGrenadeSystem) {
        const el = document.getElementById("weapon-ammo-3");
        if (el) {
          el.textContent = tank._smokeGrenadeSystem.isReady
            ? smokeCount
            : `${Math.ceil(tank._smokeGrenadeSystem.cooldownRemaining)}s`;
        }
      }
      // Special weapon (slot 5, 'gun' variant) cooldown display
      if (
        tank.cfg.enableRockets &&
        tank.cfg.specialWeaponType?.includes("gun") &&
        tank.rocketSystem
      ) {
        const el5 = document.getElementById("weapon-ammo-5");
        if (el5) {
          el5.textContent =
            tank.rocketSystem.cooldownRemaining > 0
              ? `${Math.ceil(tank.rocketSystem.cooldownRemaining)}s`
              : tank.specialAmmo;
        }
      }
    }

    // ── Fixed physics steps ───────────────────────────────────────────────
    if (!_physicsBroken) {
      while (accum >= FIXED) {
        tank.captureTransformSnapshot(); // ← snapshot pre-step transform for interpolation
        plane?.captureTransformSnapshot?.();
        try {
          world.step(eventQueue);
        } catch (err) {
          console.error(
            "[Physics] world.step panicked — the Rapier world is now unrecoverable " +
              "(internal borrow-guard poisoned), ending the match instead of retrying every frame:",
            err,
          );
          _physicsBroken = true;
          accum = 0;
          break;
        }
        // ── Fir-tree static collision (Option B) — corrects the just-
        // stepped position, once per physics step, so tanks bumping into
        // trees stop/slide instead of driving through them. Only tanks are
        // checked (planes fly over trees; a grounded/crash-landed plane
        // isn't blocked by trunks — tune if you want that too).
        _resolveFirTreeCollisions();
        accum -= FIXED;
      }
    }

    // ── Physics is dead — bail out of the match cleanly instead of running
    // dozens more frames with a corpse of a physics world (which would just
    // rethrow the same error on every future attempt to touch `world`) ─────
    if (_physicsBroken) {
      if (!gameOver) returnToMenu();
      return;
    }

    // ── Interpolation alpha — how far we are between the last physics
    // step and the next one. Used to smooth rendering when render FPS
    // (85-90) doesn't line up with the fixed 60Hz physics rate ────────────
    const _renderAlpha = Math.min(1, accum / FIXED);
    tank.computeRenderTransform(_renderAlpha);
    plane?.computeRenderTransform?.(_renderAlpha);

    // ── Drain collision events AFTER all steps complete ───────────────────
    // Must be outside world.step() to avoid Rapier aliasing error
    eventQueue.drainCollisionEvents((handle1, handle2, started) => {
      if (!started) return;

      const col1 = world.getCollider(handle1);
      const col2 = world.getCollider(handle2);
      if (!col1 || !col2) return;

      const rb1 = col1.parent();
      const rb2 = col2.parent();
      if (!rb1 || !rb2) return;

      // ── Resolve every currently-live PLANE rigid body this client can
      // see: the local player's own plane, plus every AI plane in both
      // team pools (host only — pools are empty on a guest, which is
      // fine since a guest never owns any of these rigid bodies anyway).
      const activePlaneHandles = new Map();
      if (vehicleType === "plane" && plane?.rigidBody) {
        activePlaneHandles.set(plane.rigidBody.handle, plane);
      }
      for (const ep of team1PlanePool.getActiveTanks()) {
        if (ep.rigidBody) activePlaneHandles.set(ep.rigidBody.handle, ep);
      }
      for (const ep of team2PlanePool.getActiveTanks()) {
        if (ep.rigidBody) activePlaneHandles.set(ep.rigidBody.handle, ep);
      }

      const planeUnit =
        activePlaneHandles.get(rb1.handle) ??
        activePlaneHandles.get(rb2.handle) ??
        null;

      if (planeUnit) {
        const otherRb = planeUnit.rigidBody.handle === rb1.handle ? rb2 : rb1;

        // ── House collider bodies — fixed RigidBody.fixed() instances
        // created in loadHouse(), tracked in _houseColliderBodies.
        const isHouse = _houseColliderBodies.includes(otherRb);

        // ── Any tank rigid body — player's own tank + every AI tank in
        // both team pools. A plane clipping its own team's tank, or the
        // player's own currently-parked tank, still counts as a crash —
        // this mirrors real flight-sim behavior (colliding with any solid
        // object destroys the aircraft), not a team-based rule.
        let isTank = otherRb === tank.rigidBody;
        if (!isTank) {
          for (const t of team1Pool.getActiveTanks()) {
            if (t.rigidBody === otherRb) { isTank = true; break; }
          }
        }
        if (!isTank) {
          for (const t of team2Pool.getActiveTanks()) {
            if (t.rigidBody === otherRb) { isTank = true; break; }
          }
        }

        if (isHouse || isTank) {
          // Player's own Plane instance exposes handleObstacleCollision();
          // AI EnemyPlane instances (team1PlanePool/team2PlanePool) expose
          // _dieFromObstacleImpact() instead — same crash-death pipeline,
          // just named/implemented separately since EnemyPlane doesn't
          // extend Plane. Call whichever one this unit actually has.
          if (typeof planeUnit.handleObstacleCollision === 'function') {
            planeUnit.handleObstacleCollision();
          } else if (typeof planeUnit._dieFromObstacleImpact === 'function') {
            planeUnit._dieFromObstacleImpact();
          }
        }
        return;
      }

      // ── Original tank-vs-something resolution (kept as-is; no other
      // logic previously depended on `otherRb` here, so nothing else to
      // preserve beyond the lookup itself).
      if (!tank.rigidBody) return; // tank dead — no rigid body to check

      const activeTankHandles = new Map();
      activeTankHandles.set(tank.rigidBody.handle, tank.rigidBody);
      for (const et of enemyPool.getActiveTanks()) {
        if (et.rigidBody) {
          activeTankHandles.set(et.rigidBody.handle, et.rigidBody);
        }
      }

      const tankRb =
        activeTankHandles.get(rb1.handle) ??
        activeTankHandles.get(rb2.handle) ??
        null;
      const otherRb2 = tankRb?.handle === rb1.handle ? rb2 : rb1;

      if (!tankRb || !otherRb2) return;
    });

    if (debugRenderer.mesh.visible) {
      try {
        debugRenderer.update();
      } catch (err) {
        console.error("[DebugRenderer] update failed, disabling:", err);
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

    // ── Tank update — skipped while the spawn-selection screen is up,
    // since there's no player-controlled tank to drive input for yet
    // (it's dead/respawning), and camera is driven by OrbitControls instead ─
    if (!_spawnSelectionActive) {
      if (vehicleType === "plane" && plane) {
        // ── Roll only inverts when rear-view is toggled on (V pressed) while
        // in chase cam. Normal forward chase cam and scope view both keep
        // regular (non-inverted) roll — only rearViewActive flips it.
        plane.update(
          _smoothedDt,
          keys,
          camera,
          mouse,
          cycleData,
          getTerrainY,
          scope.rearViewActive,
          scope.isScoped,
          onPlaneTreeCollision,
        );
        // ── Enemy tanks killed while flying still spawn death-smoke through
        // the TANK's explosion system (enemyPool was wired to it at
        // construction and is never re-pointed at the plane's). tank.update()
        // doesn't run in this branch, so nothing else ticks those particles —
        // without this they're spawned but never animated/rendered. ─────────
        tank.bulletSystem?.explosionSystem?.update(dt, camera, renderer);
        // ── Same problem for the parked tank's dust/splash trail — tank.update()
        // never runs while flying, so any dust cloud mid-fade at the moment of
        // takeoff would otherwise freeze in place for the rest of the flight. ─
        tank.dustSystem?.tickIdle(dt);
      } else {
        tank.update(_smoothedDt, keys, camera, mouse, cycleData);
        // ── Keep a dead/falling plane's own update ticking even after the
        // player has switched back to the tank — plane.update() is the ONLY
        // place that calls plane.explosionSystem.update(), so once vehicleType
        // stops being 'plane' that particle system (crash explosion, damage
        // smoke fade-out) would otherwise freeze mid-animation instead of
        // finishing and disappearing. Safe to call unconditionally here —
        // Plane.update()'s isDead branch ignores keys/mouse entirely and only
        // advances the fall/impact animation + ticks explosionSystem.
        if (plane && plane.isDead) {
          plane.update(
            _smoothedDt,
            keys,
            camera,
            mouse,
            cycleData,
            getTerrainY,
            scope.rearViewActive,
          );
        }
      }
      if (
        vehicleType === "tank" &&
        tank.turretController &&
        !tank.isDead &&
        enableTurretSound &&
        !isPaused
      ) {
        tank.turretController.update(
          dt,
          camera,
          mouse,
          null,
          world,
          tank.rigidBody,
          scope,
          audio,
        );
      }
    } else {
      // ── Spawn-selection is active (pre-deploy or mid-match respawn) —
      // tank.update() is skipped here, but the death explosion's fire/
      // smoke/spark particles must keep animating instead of freezing
      // on the exact frame the player died ───────────────────────────────
      tank.bulletSystem?.explosionSystem?.update(dt, camera, renderer);
      if (tank.smokeSystem && tank.bodyGroup.visible)
        tank.smokeSystem.update(cycleData);
      tank.dustSystem?.tickIdle(dt);
      // ── Same freeze problem as above, but for the spawn-selection screen —
      // if the player died in the plane and is now picking a new spawn point,
      // plane.update() (the only thing driving the crash-explosion particles
      // and the fall-to-ground animation itself) never runs during this
      // window either, unless we tick it here too.
      if (plane && plane.isDead) {
        plane.update(
          dt,
          keys,
          camera,
          mouse,
          cycleData,
          getTerrainY,
          scope.rearViewActive,
        );
      }
    }

    // ── Track decals (dirt trail under the treads) — tank only ─────────────
    if (_trackDecalGrace > 0) {
      _trackDecalGrace = Math.max(0, _trackDecalGrace - dt);
    }

    if (
      vehicleType === "tank" &&
      !tank.isDead &&
      !isPaused &&
      _trackDecalGrace <= 0
    ) {
      tank.bodyGroup.getWorldQuaternion(_decalWorldQ);
      const _outerZ = tank.cfg.outerZ ?? 1.0;

      _decalOffsetL.set(0, 0, -_outerZ).applyQuaternion(_decalWorldQ);
      _decalOffsetR.set(0, 0, _outerZ).applyQuaternion(_decalWorldQ);

      tank.bodyGroup.getWorldPosition(_decalPosL).add(_decalOffsetL);
      tank.bodyGroup.getWorldPosition(_decalPosR).add(_decalOffsetR);

      // Snap decal Y to actual terrain height under each track
      _decalPosL.y = getTerrainY(_decalPosL.x, _decalPosL.z);
      _decalPosR.y = getTerrainY(_decalPosR.x, _decalPosR.z);

      const _decalVel = tank.rigidBody ? tank.rigidBody.linvel() : null;
      const _decalSpeed = _decalVel
        ? Math.sqrt(_decalVel.x * _decalVel.x + _decalVel.z * _decalVel.z)
        : 0;

      trackDecalSystem.update(
        _smoothedDt,
        _decalPosL,
        _decalPosR,
        _decalWorldQ,
        _decalSpeed,
      );
    } else {
      // Not actively driving the tank right now (flying, dead, or mid-
      // respawn) — still tick the fade on ALREADY-PLACED decals every
      // frame, otherwise they freeze mid-fade the instant you leave the
      // tank. Passing speed=0 guarantees _tryStamp() never lays down a
      // new decal here — only existing ones age out on schedule.
      trackDecalSystem.update(
        _smoothedDt,
        _decalPosL,
        _decalPosR,
        _decalWorldQ,
        0,
      );
    }

    if (vehicleType === "tank" && !tank.isDead && !_spawnSelectionActive && gameStarted) {
      const vel = tank.rigidBody?.linvel();
      const avgThrottle = vel
        ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) / 3.5
        : 0;
      audio.update(dt, avgThrottle, avgThrottle > 0.05);

      // ── Water sound — only when this map actually has water ────────────────
      const _waterLevel = _waterDef.y ?? terrainData.waterLevel ?? 8.4;
      const _isInWater = showWater && _tPos && _tPos.y < _waterLevel + 0.5;
      const _tankSpeed = vel ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) : 0;

      if (_isInWater && _tankSpeed > 0.5) {
        if (!audio.isWaterPlaying) audio.startWater();
        audio.updateWater(true, _tankSpeed);
      } else if (_isInWater) {
        // Still in water but not moving — fade out but keep loop alive
        audio.updateWater(false, 0);
      } else {
        // Left the water entirely (or map has no water) — tear down
        if (audio.isWaterPlaying) audio.stopWater();
      }
    } else if (vehicleType === "plane" && plane && !plane.isDead && !_spawnSelectionActive && gameStarted) {
      // Plane engine pitch/volume tracks throttle input directly (0..1),
      // rather than derived ground speed like the tank branch above.
      const throttleNorm = plane.throttle ?? 0;
      audio.update(dt, throttleNorm, throttleNorm > 0.05);

      // ── Water sound — plays whenever the plane is low enough over the
      // water surface to be kicking up spray, same height band
      // PlaneWaterSplash itself uses (waterSplashMaxHeight above the
      // surface down to waterSplashMinHeight below it), so the sound
      // tracks the visible splash particles rather than a separate rule.
      const _pWaterLevel = _waterDef.y ?? terrainData.waterLevel ?? 8.4;
      const _planeY = plane.bodyGroup?.position.y;
      const _heightAboveWater =
        _planeY != null ? _planeY - _pWaterLevel : Infinity;
      const _maxH = plane.cfg.waterSplashMaxHeight ?? 4.0;
      const _minH = plane.cfg.waterSplashMinHeight ?? -1.5;
      const _planeOverWater =
        showWater && _heightAboveWater <= _maxH && _heightAboveWater >= _minH;

      const _pVel = plane.rigidBody?.linvel();
      const _planeSpeed = _pVel
        ? Math.sqrt(_pVel.x * _pVel.x + _pVel.z * _pVel.z)
        : 0;

      if (_planeOverWater && _planeSpeed > 0.5) {
        if (!audio.isWaterPlaying) audio.startWater();
        audio.updateWater(true, _planeSpeed);
      } else if (_planeOverWater) {
        audio.updateWater(false, 0);
      } else {
        if (audio.isWaterPlaying) audio.stopWater();
      }
    } else if (
      vehicleType === "plane" &&
      plane &&
      plane.isDead &&
      !plane._groundExplosionSpawned
    ) {
      // ── Destroyed and still falling — keep the engine loop running but sag
      // its pitch toward a low dying drone (dyingPitchFactor=0) and boost its
      // volume so it stays audible through the fall, same treatment AI planes
      // already get via updateEnemyEngine()'s dyingPitchFactor/volumeBoost.
      // Once the wreck hits the ground (_groundExplosionSpawned), stop it
      // outright instead — see the block below.
      audio.update(dt, 0, false, 0, ENGINE_DYING_VOLUME_BOOST);
    } else if (
      vehicleType === "plane" &&
      plane &&
      plane.isDead &&
      plane._groundExplosionSpawned
    ) {
      // ── Wreck has hit the ground — cut the engine cleanly instead of
      // leaving it droning forever.
      audio._stopEngine();
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

    // ── Plane continuous gun fire while mouse held ───────────────────────
    if (
      vehicleType === "plane" &&
      plane &&
      _planeSelectedSlot === 1 &&
      !plane.isDead &&
      !isPaused &&
      !matchEnded &&
      !_uiClickActive
    ) {
      updatePlaneGunAimWorld(); // ← refresh aim point this frame before firing

      if (plane._gunType === 3) {
        if (isMouseHeld && plane.bulletSystem?.isReady && plane.mgAmmo > 0) {
          plane.fire(_enemyResolver, _gunReticleWorld);
          _localFireSeq++;
          plane.mgAmmo = Math.max(0, plane.mgAmmo - 1); // drains the total pool
          _updatePlaneWeaponHud();
          audio.playShot(); // ← per-volley cannon sound, same as tank gunType 3
        }

        // Total pool empty — force the internal magazine dry and cancel any
        // in-progress auto-reload so it stops refilling forever.
        if (plane.mgAmmo <= 0 && plane.bulletSystem) {
          plane.bulletSystem.rounds = 0;
          plane.bulletSystem._reloading = false;
        }

        // Clamp the magazine so a reload never tops up past the total pool.
        if (plane.bulletSystem && plane.bulletSystem.rounds > plane.mgAmmo) {
          plane.bulletSystem.rounds = plane.mgAmmo;
        }

        // Play the reload cue the instant a reload starts (auto or otherwise).
        const _pmgReloading = plane.bulletSystem?._reloading ?? false;
        if (_pmgReloading && !_wasPlaneMultiGunReloading) {
          audio.playMultiGunReload();
          startPlaneReloadAnimation(
            plane.bulletSystem._reloadTimer ??
              plane.bulletSystem.fullReloadTime,
          );
        }
        _wasPlaneMultiGunReloading = _pmgReloading;

        // ── Ammo HUD — "magazine / reserve", or "Xs" while reloading ─────────
        const _pmgRounds = plane.bulletSystem?.rounds ?? 0;
        const _pmgReserve = Math.max(0, plane.mgAmmo - _pmgRounds);
        const _pmgReloadSecs = _pmgReloading
          ? Math.ceil(plane.bulletSystem._reloadTimer)
          : 0;
        const _pmgKey = `${_pmgRounds}:${_pmgReserve}:${_pmgReloading}:${_pmgReloadSecs}`;
        if (_pmgKey !== _lastPlaneMultiGunRounds) {
          _lastPlaneMultiGunRounds = _pmgKey;
          const el = document.getElementById("plane-weapon-ammo-1");
          if (el) {
            el.textContent = _pmgReloading
              ? `${_pmgReloadSecs}s`
              : `${_pmgRounds}/${_pmgReserve}`;
          }
        }

        if (audio.isMGPlaying) audio.stopMG(); // gunType 3 never uses the MG loop
      } else {
        _planeMgCooldown -= dt;
        if (
          isMouseHeld &&
          plane.mgAmmo > 0 &&
          _planeMgCooldown <= 0 &&
          plane.bulletSystem?.isReady
        ) {
          plane.fire(_enemyResolver, _gunReticleWorld);
          _localFireSeq++;
          plane.mgAmmo = Math.max(0, plane.mgAmmo - 1);
          _planeMgCooldown = plane.cfg.mgFireRate ?? 0.1;
          _updatePlaneWeaponHud();
          if (!audio.isMGPlaying) audio.startMG();
        } else if (!isMouseHeld && audio.isMGPlaying) {
          audio.stopMG();
        } else if (
          (plane.mgAmmo <= 0 || plane.bulletSystem?._reloading) &&
          audio.isMGPlaying
        ) {
          audio.stopMG();
        }

        const mg = plane.bulletSystem;
        if (mg && mg.rounds <= 0 && !mg._reloading && plane.mgAmmo > 0) {
          mg._reloading = true;
          mg._reloadTimer = mg.fullReloadTime;
          if (audio.isMGPlaying) audio.stopMG();
          audio.playMGReload();
          startPlaneReloadAnimation(mg.fullReloadTime);
        }

        if (mg && mg.rounds > plane.mgAmmo) {
          mg.rounds = plane.mgAmmo;
        }
      }
    } else if (vehicleType === "plane" && audio.isMGPlaying) {
      audio.stopMG();
    }

    // ── Plane continuous rocket fire while mouse held (auto-fire planes only) ──
    if (
      vehicleType === "plane" &&
      plane &&
      plane.cfg.rocketAuto &&
      _planeSelectedSlot === 2 &&
      !plane.isDead &&
      !isPaused &&
      !matchEnded &&
      !_uiClickActive
    ) {
      updatePlaneGunAimWorld(); // refresh aim point every frame while held, same as the gun

      if (isMouseHeld) {
        plane.setRocketFireHeld(
          true,
          _missileLockResolver,
          () => _gunReticleWorld,
        );
      } else {
        plane.setRocketFireHeld(false);
      }
    } else if (plane?.rocketSystem) {
      // Not on rocket slot / not auto / dead / paused / UI-blocked — make sure
      // auto-fire isn't left running from a moment ago.
      plane.rocketSystem.setAutoFireHeld(false);
    }

    
    // ── Plane continuous Hispano fire while mouse held ─────────────────────
    if (
      vehicleType === "plane" &&
      plane &&
      plane.hasHispano &&
      _planeSelectedSlot === 6 &&
      !plane.isDead &&
      !isPaused &&
      !matchEnded &&
      !_uiClickActive
    ) {
      updatePlaneGunAimWorld();
      const hs = plane.hispanoSystem;

      if (isMouseHeld && hs?.isReady) {
        hs.fire(plane.rigidBody, null, null, null, false, _enemyResolver, _gunReticleWorld);
        _localFireSeq++;
        _updatePlaneWeaponHud();
        audio.playHispanoShot();
        plane.triggerFireShake('hispano');
      }

      // ── Play the reload cue the instant a reload starts — either an
      // auto-reload (magazine emptied out mid-fire) or a manual "R" press
      // (see manualReloadHispano()). Edge-detected the same way the tank's
      // and plane's own MultiGun reload sound is (_wasMultiGunReloading /
      // _wasPlaneMultiGunReloading), so it only fires once per reload cycle
      // instead of every frame while reloading.
      const _hspReloading = hs?._reloading ?? false;
      if (_hspReloading && !_wasHispanoReloading) {
        audio.playMultiGunReload();
        startPlaneReloadAnimation(hs._reloadTimer ?? hs.fullReloadTime);
      }
      _wasHispanoReloading = _hspReloading;
    }

    // ── Continuous MG fire while mouse held (tank) ─────────────────────────
    // Only call when MG is actually ready — avoids tank.fire() overhead when timer hasn't elapsed
    if (
      vehicleType === "tank" &&
      tank.activeWeapon === 2 &&
      !tank.isDead &&
      !isPaused &&
      !matchEnded &&
      !_uiClickActive
    ) {
      if (isMouseHeld && tank.mgSystem?.isReady && mgAmmo > 0) {
        tank.fire(_enemyResolver);
        _localMgFireSeq++; // ← separate from _localFireSeq — main gun and MG replay at different mount points
        mgAmmo = Math.max(0, mgAmmo - 1); // ← drains the total reserve pool
        if (!audio.isMGPlaying) audio.startMG();
      } else if (!isMouseHeld && audio.isMGPlaying) {
        audio.stopMG();
      } else if ((tank.mgSystem?.isEmpty || mgAmmo <= 0) && audio.isMGPlaying) {
        audio.stopMG();
      }

      // ── Total pool empty — force magazine dry, cancel any in-progress reload ─
      if (mgAmmo <= 0 && tank.mgSystem) {
        tank.mgSystem.rounds = 0;
        tank.mgSystem._reloading = false;
      }

      // ── Clamp magazine so a reload never tops up past what's left in the pool ─
      if (tank.mgSystem && tank.mgSystem.rounds > mgAmmo) {
        tank.mgSystem.rounds = mgAmmo;
      }

      // ── Auto-reload — once the magazine runs dry, kick off a reload
      // automatically as long as there's reserve ammo left to draw from.
      // Mirrors manualReloadMG()'s logic, just triggered without the "R" key. ──
      if (
        tank.mgSystem &&
        tank.mgSystem.rounds <= 0 &&
        !tank.mgSystem._reloading &&
        mgAmmo > 0
      ) {
        tank.mgSystem._reloading = true;
        tank.mgSystem._reloadTimer = tank.mgSystem.fullReloadTime;
        audio.playMGReload();
      }

      // ── Ammo HUD — "loaded/reserve", or "Xs" while reloading ─────────────────
      const _mg2Rounds = tank.mgSystem?.rounds ?? 0;
      const _mg2Reloading = tank.mgSystem?._reloading ?? false;
      const _mg2Reserve = Math.max(0, mgAmmo - _mg2Rounds);
      const _mg2ReloadSecs = _mg2Reloading
        ? Math.ceil(tank.mgSystem._reloadTimer)
        : 0;
      const _mg2Key = `${_mg2Rounds}:${_mg2Reserve}:${_mg2Reloading}:${_mg2ReloadSecs}`;
      if (_mg2Key !== _lastMg2Key) {
        _lastMg2Key = _mg2Key;
        const el = document.getElementById("weapon-ammo-2");
        if (el) {
          el.textContent = _mg2Reloading
            ? `${_mg2ReloadSecs}s`
            : `${_mg2Rounds}/${_mg2Reserve}`;
        }
      }
    } else if (vehicleType === "tank" && audio.isMGPlaying) {
      audio.stopMG();
    }

    // ── Continuous main-gun fire while mouse held — only engages for gunType 3
    // (multi-barrel main gun). gunType 1/2 remain click-to-fire via onFire(). ──
    if (
      vehicleType === "tank" &&
      tank.activeWeapon === 1 &&
      tank.cfg.gunType === 3 &&
      !tank.isDead &&
      !isPaused &&
      !matchEnded &&
      !_uiClickActive
    ) {
      if (isMouseHeld && tank.bulletSystem?.isReady && shellCount > 0) {
        tank.fire(_enemyResolver);
        _localFireSeq++;
        shellCount = Math.max(0, shellCount - 1); // ← drains the total pool, not just the magazine
        audio.playShot(); // ← main-gun shot sound per volley, same as gunType 1/2, instead of the MG loop
      }

      // ── Total pool is empty — force the internal magazine dry and cancel
      // any in-progress auto-reload so it stops refilling forever ────────────
      if (shellCount <= 0 && tank.bulletSystem) {
        tank.bulletSystem.rounds = 0;
        tank.bulletSystem._reloading = false;
      }

      // ── Clamp the magazine so a reload never tops up past what's actually
      // left in the total pool (e.g. pool=30 shouldn't refill a 50-round mag) ─
      if (tank.bulletSystem && tank.bulletSystem.rounds > shellCount) {
        tank.bulletSystem.rounds = shellCount;
      }

      // ── Play the reload cue the instant a reload starts — either an
      // auto-reload (magazine emptied out mid-fire) or a manual "R" press.
      // manualReload() pre-syncs _wasMultiGunReloading = true and plays the
      // sound itself, so this block only fires on the auto-reload path. ──────
      const _mgReloading = tank.bulletSystem?._reloading ?? false;
      if (_mgReloading && !_wasMultiGunReloading) {
        audio.playMultiGunReload();
      }
      _wasMultiGunReloading = _mgReloading;

      // ── Ammo HUD — "magazine / reserve" (reserve = pool minus what's loaded) ─
      const _mgRounds = tank.bulletSystem?.rounds ?? 0;
      const _mgReserve = Math.max(0, shellCount - _mgRounds);
      const _mgReloadSecs = _mgReloading
        ? Math.ceil(tank.bulletSystem._reloadTimer)
        : 0;
      const _mgKey = `${_mgRounds}:${_mgReserve}:${_mgReloading}:${_mgReloadSecs}`;
      if (_mgKey !== _lastMultiGunRounds) {
        _lastMultiGunRounds = _mgKey;
        const el = document.getElementById("weapon-ammo-1");
        if (el) {
          el.textContent = _mgReloading
            ? `${_mgReloadSecs}s`
            : `${_mgRounds}/${_mgReserve}`;
        }
      }
    }

    tickRepair(dt);
    tickPlaneRepair(dt);
    if (_flareDeployCooldown > 0) _flareDeployCooldown -= dt;
    updateDamageFireEffects();

    // ── Low-health vignette — tracks whichever vehicle is currently active.
    // While the active vehicle is dead (or spawn-selection owns the
    // screen), this is SKIPPED entirely rather than forced to a clear
    // value — health sits at 0 after death, so recomputing every frame
    // would force the vignette back to full intensity, then instantly
    // re-clear it via its own fast (0.4s) transition, before the death
    // block's intentional graceful 1.2s fade (synced with the
    // black-and-white transition) ever gets a chance to play out.
    // Skipping the update just freezes the vignette at whatever it
    // looked like the instant death occurred, so that later fade is
    // the only thing that ever touches its opacity again.
    if (gameStarted && !matchEnded && !_spawnSelectionActive) {
      const _vignetteVeh = vehicleType === "plane" && plane ? plane : tank;
      const _vignetteDead = _vignetteVeh?.isDead ?? false;
      if (!_vignetteDead) {
        const _vignetteFrac =
          _vignetteVeh && _vignetteVeh.maxHealth > 0
            ? _vignetteVeh.health / _vignetteVeh.maxHealth
            : 1;
        updateDamageVignette(_vignetteFrac);
      }
      // else: dead — leave the vignette untouched until the death
      // block's one-time fade-to-0 runs.
    }

    // ── Match timer ───────────────────────────────────────────────────────────
    // IMPORTANT: matchElapsed is only ADVANCED by the HOST (or always, in solo
    // play, where isHost is forced true). Every client previously ran its own
    // independent countdown starting from whenever THAT client's gameStarted
    // flipped true — since host and guests deploy at different real-world
    // moments (guest waits on lobby join / asset loads), their timers drifted
    // apart from frame one, and each client independently declared matchEnded
    // the instant ITS OWN countdown hit zero, causing separate match-end
    // triggers instead of a single synchronized one. The host now owns
    // matchElapsed and broadcasts it (+ the matchEnded transition) via
    // match:timer-state; guests just render whatever the host reports and
    // trigger the identical match-end sequence in response (see the
    // applyMatchEnd() helper + the match:timer-state listener below).
    if (gameStarted && !matchEnded) {
      if (isHost) {
        matchElapsed += dt;
      }
      _tickTicketBleed(dt); // ← NEW — capture-point ticket bleed

      const remaining = Math.max(0, MATCH_DURATION - matchElapsed);
      const mm = Math.floor(remaining / 60);
      const ss = Math.floor(remaining % 60);
      document.getElementById("match-timer").textContent =
        `${mm}:${ss.toString().padStart(2, "0")}`;

      // ← NEW — sudden-death: match ends the instant either team hits 0
      // tickets, not just when the clock runs out.
      if (
        isHost &&
        (remaining <= 0 || team1Tickets <= 0 || team2Tickets <= 0) &&
        !matchEnded
      ) {
        applyMatchEnd();
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
    // NOTE: this must keep running even while the player is dead/respawning/
    // spawn-picking (_tPos is null in that window) — otherwise AI-controlled
    // enemy and friendly tanks stop making capture progress entirely just
    // because the player's own tank doesn't currently exist. Only the
    // player's own physical-proximity check below needs to be gated on _tPos.
    //
    // IMPORTANT: ownership/timer/score MUTATION only ever happens on the HOST
    // (or always, in solo play, where isHost is forced true). Every client was
    // previously computing capture state independently from its own local view
    // of "who's nearby" — different players see different enemy/friendly
    // positions at different times (and guests never see real AI at all, since
    // enemyPool/friendlyPool only run host-side), so each client could reach a
    // different conclusion about who owns a point. The host is now the single
    // source of truth; it broadcasts CAPTURE_POINTS state via match:cp-state,
    // and guests just apply whatever they're told (see the match:cp-state
    // listener near the other match:* socket handlers).
    if (gameStarted && !matchEnded) {
      _nearPoint = null;

      // ── Physical proximity check — every client does this locally, purely
      // for its own capture-prompt HUD (F-key hint), regardless of host/guest.
      CAPTURE_POINTS.forEach((p) => {
        if (_tPos) {
          const dx = p.x - _tPos.x;
          const dz = p.z - _tPos.z;
          const dsq = dx * dx + dz * dz;
          if (dsq < CAPTURE_RADIUS * CAPTURE_RADIUS && !tank.isDead)
            _nearPoint = p;
        }
      });

      if (isHost) {
        CAPTURE_POINTS.forEach((p) => {
          // ── Physical player proximity — planes can never capture, so this
          // is forced false whenever the host is currently flying, regardless
          // of the (parked) tank's position or _fKeyHeld state.
          let playerPhysicallyInRange = false;
          if (_tPos && vehicleType === "tank") {
            const dx = p.x - _tPos.x;
            const dz = p.z - _tPos.z;
            const dsq = dx * dx + dz * dz;
            playerPhysicallyInRange =
              dsq < CAPTURE_RADIUS * CAPTURE_RADIUS && !tank.isDead;
          }

          // ── Friendly proximity — counts as "player team", captures passively ──
          let friendlyInRange = false;
          for (const [ft, cached] of friendlyPosCache.entries()) {
            const fx = p.x - cached.x;
            const fz = p.z - cached.z;
            if (fx * fx + fz * fz < CAPTURE_RADIUS * CAPTURE_RADIUS) {
              friendlyInRange = true;
              break;
            }
          }

          // ── Remote real players, split by team relative to the HOST's own
          // localTeam — this is the piece that was missing: a remote player on
          // the OPPOSING team was previously being lumped into "player team
          // capturing" (since the old check never looked at rp.team at all),
          // which meant an enemy real player capturing a point got wrongly
          // credited to the host's own team. Now each remote player is bucketed
          // into either the "my team" or "opposing team" tally, so an enemy
          // player's capture correctly turns the point red on the host's screen
          // and blue on that player's own screen (via p.owner + _ownerColorKey).
          //
          // Planes can never capture — checked defensively against the remote
          // player's reported vehicleType, not just relying on the guest to
          // have honestly zeroed out `capturing` client-side.
          let remotePlayerCapturing = false; // same-team remote, holding F, in range
          let remotePlayerInRange = false; // same-team remote, merely in range
          let enemyRemotePlayerCapturing = false; // opposing-team remote, holding F, in range
          let enemyRemotePlayerInRange = false; // opposing-team remote, merely in range

          for (const [userId, rp] of _remotePlayers.entries()) {
            if (!rp || !rp.bodyGroup || rp.isDead) continue;
            if (_remoteVehicleType.get(userId) !== "tank") continue;
            const rpPos = rp.bodyGroup.position;
            const fx = p.x - rpPos.x;
            const fz = p.z - rpPos.z;
            if (fx * fx + fz * fz >= CAPTURE_RADIUS * CAPTURE_RADIUS) continue;

            if (rp.team === localTeam) {
              remotePlayerInRange = true;
              if (rp._netCapturing) remotePlayerCapturing = true;
            } else {
              enemyRemotePlayerInRange = true;
              if (rp._netCapturing) enemyRemotePlayerCapturing = true;
            }
          }

          // ── Enemy AI proximity (unchanged — passive, no key needed) ───────────
          let enemyAiInRange = false;
          for (const [et, cached] of enemyPosCache.entries()) {
            const ex = p.x - cached.x;
            const ez = p.z - cached.z;
            if (ex * ex + ez * ez < CAPTURE_RADIUS * CAPTURE_RADIUS) {
              enemyAiInRange = true;
              break;
            }
          }

          // "Player team" is actively capturing if: the local player is in range
          // and holding [F], OR a same-team remote human is in range and holding
          // [F], OR an AI friendly is in range (passive, no key needed).
          const playerTeamCapturing =
            (playerPhysicallyInRange && _fKeyHeld) ||
            remotePlayerCapturing ||
            friendlyInRange;
          const playerTeamInRange =
            playerPhysicallyInRange || friendlyInRange || remotePlayerInRange;

          // ── Record genuine personal contribution — only the local player's
          // OWN tank physically in range and holding [F] counts, never a
          // friendly AI or teammate capturing on their own.
          if (playerPhysicallyInRange && _fKeyHeld && p.owner !== localTeam) {
            p._playerContributed = true;
          }

          // "Enemy team" mirrors the above: AI is passive, real opposing players
          // need to be holding [F].
          const enemyTeamCapturing =
            enemyAiInRange || enemyRemotePlayerCapturing;
          const enemyTeamInRange = enemyAiInRange || enemyRemotePlayerInRange;

          // ── Capture progress ──────────────────────────────────────────────────
          // p.owner now stores the ACTUAL team number (localTeam / opposing
          // team), never the host-relative strings 'player'/'enemy' — this is
          // what gets broadcast via match:cp-state, so every guest can resolve
          // its own blue/red color relative to ITS OWN localTeam (see
          // _ownerColorKey), instead of inheriting the host's perspective.
          const _oppTeamForCp = localTeam === 1 ? 2 : 1;

          if (playerTeamCapturing && p.owner !== localTeam) {
            p.captureTimer += dt;
            p.capturingBy = localTeam;
            if (p.captureTimer >= CAPTURE_HOLD_TIME) {
              p.captureTimer = 0;
              p.capturingBy = null;
              if (p.owner === _oppTeamForCp)
                enemyCaptures = Math.max(0, enemyCaptures - 1);
              p.owner = localTeam;
              p.bombDamage = 0; // fresh tally under new ownership
              playerCaptures++;
              document.getElementById("score-player").textContent =
                playerCaptures;
              _setCPColor(p);
              _updateMinimapCPDot(p);
              // ── Personal capture credit — ONLY when the local player's own
              // tank actually contributed. A point finished purely by a
              // friendly AI (passive) or a remote teammate holding F does not
              // grant the local player XP/profile capture credit, even though
              // the team-wide score above still counts it.
              if (p._playerContributed) {
                playerProfile.registerCapture();
              }
              p._playerContributed = false;
            }
          } else if (
            enemyTeamCapturing &&
            !playerTeamInRange &&
            p.owner !== _oppTeamForCp
          ) {
            p.captureTimer += dt * 0.4; // enemies capture slower
            p.capturingBy = _oppTeamForCp;
            if (p.captureTimer >= CAPTURE_HOLD_TIME) {
              p.captureTimer = 0;
              p.capturingBy = null;
              if (p.owner === localTeam)
                playerCaptures = Math.max(0, playerCaptures - 1);
              p.owner = _oppTeamForCp;
              p.bombDamage = 0; // fresh tally under new ownership
              enemyCaptures++;
              document.getElementById("score-enemy").textContent =
                enemyCaptures;
              _setCPColor(p);
              _updateMinimapCPDot(p);
              document.getElementById("score-player").textContent =
                playerCaptures;
              p._playerContributed = false; // point flipped to the enemy — clear any stale progress flag
            }
          } else {
            // Decay timer when neither side is capturing
            p.captureTimer = Math.max(0, p.captureTimer - dt * 0.5);
            p.capturingBy = null;
            if (p.captureTimer === 0) p._playerContributed = false; // progress fully reset — clear the flag too
          }
        });
      }

      // ── Capture HUD — every client shows this locally based on its own
      // _nearPoint + the (possibly host-authoritative, possibly locally
      // computed) captureTimer on that point. Compares against localTeam now
      // that p.owner is a team-neutral team number, not a host-relative
      // 'player' string. ────────────────────────────────────────────────────
      if (_nearPoint && _nearPoint.owner !== localTeam && !tank.isDead) {
        captureHud.style.display = "flex";
        const pct = Math.min(
          (_nearPoint.captureTimer / CAPTURE_HOLD_TIME) * 100,
          100,
        );
        setCaptureWipe(pct);
      } else {
        captureHud.style.display = "none";
      }
    }

    // ── Prop / car proximity check — player + enemies + friendlies can
    // break props and smash parked cars. Same gathered position list is
    // reused for both systems since the criteria (nearby tank) is identical.
    if (_tPos) {
      _fenceTankPositions.length = 0;
      _fenceTankPositions.push(_tPos);
      for (const [, cached] of enemyPosCache.entries())
        _fenceTankPositions.push(cached);
      for (const [, cached] of friendlyPosCache.entries())
        _fenceTankPositions.push(cached);
      propSystem.update(dt, _fenceTankPositions);
      carSystem.update(dt, _fenceTankPositions);
    }

    // ── Ammo Refill Points — active vehicle only (tank OR plane, whichever
    // is currently deployed). Position, "is dead" check, ammo shape, and the
    // refill callback all switch based on vehicleType so the same crates work
    // for both without the plane silently reading/writing tank ammo fields. ──
    const _ammoRefillIsDead =
      vehicleType === "plane" && plane ? plane.isDead : tank.isDead;

    if (vehicleType === "plane" && plane) {
      // ── AI turret gun ammo — only present when this plane actually has
      // AI_Gun_N turrets built (plane._aiGunSystems.length > 0). Current
      // state reads the live reserve pool (_aiGunTotalAmmo[i], reserve-only
      // — see plane.js), plus whatever's still loaded in each gun's
      // magazine, so "full" means reserve+loaded together match the max.
      const _hasAiGuns = !!(
        plane._aiGunSystems &&
        plane._aiGunSystems.length > 0 &&
        plane._aiGunSystems.some((g) => g)
      );
      let _aiGunAmmoState = undefined;
      let _aiGunAmmoMax = undefined;
      if (_hasAiGuns) {
        _aiGunAmmoState = plane._aiGunSystems.map(
          (sys, i) => (sys ? sys.rounds : 0) + (plane._aiGunTotalAmmo[i] ?? 0),
        );
        _aiGunAmmoMax = plane._aiGunSystems.map(
          (_, i) => plane.cfg.aiGunTotalAmmo ?? plane.cfg.aiGunMagSize * 3,
        );
      }

      ammoPointSystem.update(
        dt,
        _activePos,
        _ammoRefillIsDead,
        isPaused,
        matchEnded,
        "plane",
        // current ammo state
        {
          mgAmmo: plane.mgAmmo,
          rocketAmmo: plane.rocketAmmo,
          bombAmmo: plane.bombAmmo,
          repairKits,
          aiGunAmmo: _aiGunAmmoState,
        },
        // starting loadout (refill target) — pulled from the plane preset's own loadout
        {
          mgAmmo: _planePreset?.config?.loadout?.mgAmmo ?? 150,
          rocketAmmo: _planePreset?.config?.loadout?.rocketAmmo ?? 6,
          bombAmmo: _planePreset?.config?.loadout?.bombAmmo ?? 4,
          repairKits: config.loadout?.repairKits ?? 0,
          aiGunAmmoMax: _aiGunAmmoMax,
        },
        // callback — apply refill to live plane state
        (filled) => {
          plane.mgAmmo = filled.mgAmmo;
          plane.rocketAmmo = filled.rocketAmmo;
          plane.bombAmmo = filled.bombAmmo;
          repairKits = filled.repairKits;
          if (typeof plane.rocketSystem?.setRemainingAmmo === 'function') {
            plane.rocketSystem.setRemainingAmmo(plane.rocketAmmo);
          }

          if (plane.bulletSystem && plane.bulletSystem.rounds > plane.mgAmmo) {
            plane.bulletSystem.rounds = plane.mgAmmo; // clamp mag to refilled pool
          }

          // ── AI turret guns — refill each gun's reserve pool to full, and
          // top up its currently-loaded magazine too (so a gun that was
          // sitting empty/mid-reload is immediately combat-ready again,
          // rather than only its reserve being restocked).
          if (filled.aiGunAmmo && plane._aiGunSystems) {
            for (let i = 0; i < plane._aiGunSystems.length; i++) {
              const sys = plane._aiGunSystems[i];
              if (!sys) continue;
              const fullTotal = filled.aiGunAmmo[i] ?? 0;
              const magCap = plane.cfg.aiGunMagSize;
              sys.rounds = Math.min(magCap, fullTotal);
              plane._aiGunTotalAmmo[i] = fullTotal - sys.rounds;
              // Cancel any in-progress reload — the magazine is already full.
              sys._reloading = false;
              sys._reloadTimer = 0;
            }
            _lastAiGunKey = ""; // force the AI-gun HUD label to refresh immediately
          }

          _updatePlaneWeaponHud();
          updateRepairKitHUD();
          _updateAiGunHud();
        },
      );
    } else {
      // ── Rockets — only include rocketAmmo in the ammo-point state/loadout
      // for tanks that actually have them, so _isAmmoFull()/_doRefill() skip
      // the field entirely for every other tank.
      const _tankAmmoState = {
        shellCount,
        mgAmmo: tank.mgSystem?.ammo ?? mgAmmo,
        smokeCount,
        repairKits,
      };
      const _tankLoadoutTarget = {
        shellCount: config.loadout?.shellCount ?? 20,
        mgAmmo: config.loadout?.mgAmmo ?? 150,
        smokeCount: config.loadout?.smokeCount ?? 2,
        repairKits: config.loadout?.repairKits ?? 0,
      };
      if (tank.cfg.enableRockets) {
        _tankAmmoState.specialAmmo = tank.specialAmmo;
        _tankLoadoutTarget.specialAmmo =
          config.loadout?.specialAmmo ?? tank.cfg.specialAmmo;
      }

      ammoPointSystem.update(
        dt,
        _activePos,
        _ammoRefillIsDead,
        isPaused,
        matchEnded,
        "tank",
        _tankAmmoState,
        _tankLoadoutTarget,
        // callback — apply refill to live tank state
        (filled) => {
          shellCount = filled.shellCount;
          mgAmmo = filled.mgAmmo;
          smokeCount = filled.smokeCount;
          repairKits = filled.repairKits;
          if (tank.cfg.enableRockets && filled.specialAmmo !== undefined) {
            tank.specialAmmo = filled.specialAmmo;
            const _ammo5El = document.getElementById("weapon-ammo-5");
            if (_ammo5El) _ammo5El.textContent = tank.specialAmmo;
            if (typeof tank.rocketSystem?.setRemainingAmmo === 'function') {
              tank.rocketSystem.setRemainingAmmo(tank.specialAmmo);
            }
          }

          // Sync HUD
          if (tank.cfg.gunType === 3) {
            if (tank.bulletSystem && tank.bulletSystem.rounds > shellCount) {
              tank.bulletSystem.rounds = shellCount; // clamp mag to refilled pool
            }
            const _refillRounds = tank.bulletSystem?.rounds ?? 0;
            const _refillReserve = Math.max(0, shellCount - _refillRounds);
            document.getElementById("weapon-ammo-1").textContent =
              `${_refillRounds}/${_refillReserve}`;
          } else {
            document.getElementById("weapon-ammo-1").textContent = shellCount;
          }
          document.getElementById("weapon-ammo-3").textContent = smokeCount;
          updateRepairKitHUD();

          // Sync MG system
          if (tank.mgSystem) {
            tank.mgSystem.ammo = mgAmmo;
            tank.mgSystem.maxAmmo = mgAmmo;
            if (tank.mgSystem.rounds > mgAmmo) tank.mgSystem.rounds = mgAmmo;
            document.getElementById("weapon-ammo-2").textContent = tank.mgSystem
              ._reloading
              ? `${Math.ceil(tank.mgSystem._reloadTimer)}s`
              : `${tank.mgSystem.rounds}/${Math.max(0, mgAmmo - tank.mgSystem.rounds)}`;
          }
        },
      );
    }

    // ── Death screen ──────────────────────────────────────────────────────
    const _deadVehicle = vehicleType === "plane" && plane ? plane : tank;
    if (_deadVehicle._readyToShowDeath && !_deadVehicle._deathScreenShown) {
      _deadVehicle._deathScreenShown = true;
      audio.playDeath();
      audio._stopEngine();

      // ── Fade out both damage overlays on death — smoothly, over the same
      // duration as the black-and-white transition, rather than snapping
      // to 0 instantly. Whatever opacity they were at the moment of death
      // eases down to fully clear across the death-hold window.
      if (_damageFlashTimer) {
        clearTimeout(_damageFlashTimer);
        _damageFlashTimer = null;
      }
      damageFlashEl.style.transition = "opacity 1.2s ease";
      damageFlashEl.style.opacity = "0";

      damageVignetteEl.style.transition = "opacity 1.2s ease";
      damageVignetteEl.style.opacity = "0";
      _lastVignetteOpacityKey = "0.00";

      // ── Fade the whole scene to black-and-white + blurred as the death
      // screen takes over — the 1.2s CSS transition means it finishes
      // drifting into full grayscale/blur a moment after the death
      // screen/death-hold camera appears, rather than popping instantly.
      setDeathGrayscale(true);
      triggerDeathShockwave(); // one-shot flash/ring burst at the exact moment of death

      // ── XP / profile: register death (feeds K/D) ──────────────────────────
      playerProfile.registerDeath();

      // ── Kill feed for the local player's own death ─────────────────────────
      // Only recorded when there was an ACTUAL attacker (_playerLastHitBy was
      // set to 'enemy' by onHitPlayer / the match:hit-remote-player relay).
      // A self-inflicted death — e.g. the plane crashing into terrain via
      // _checkGroundCollision()'s takeDamage(maxHealth) call, which has no
      // attacker at all — must NOT show up in the kill feed as "Enemy killed
      // You". Previously killerDesc always defaulted to a generic enemy
      // descriptor and recordKillEvent() fired unconditionally, so any
      // no-attacker death (ground collision, fall damage, etc.) was wrongly
      // attributed to "Enemy".
      {
        if (_playerLastHitBy === "enemy") {
          let killerDesc = _genericTeamDescriptor(localTeam === 1 ? 2 : 1);
          if (_playerLastHitByExplicitName) {
            killerDesc = {
              kind: "player",
              uid:
                _playerLastHitByShooterUid ??
                "name:" + _playerLastHitByExplicitName,
              team: localTeam === 1 ? 2 : 1,
              name: _playerLastHitByExplicitName,
            };
          } else if (_playerLastHitByStableId) {
            // Exact AI shooter identity, sent directly by the host — this is
            // what fixes "any host-side tank shows up as the host's name":
            // an AI teammate's kill is now labeled as ITSELF, not guessed via
            // nearest-real-player proximity (which always found the host when
            // the host was the only real player nearby).
            killerDesc = {
              kind: "ai",
              stableId: _playerLastHitByStableId,
              team: _playerLastHitByStableTeam ?? (localTeam === 1 ? 2 : 1),
            };
          } else {
            const _attacker = _nearestByLastKnownPos(
              _lastKnownEnemyPos,
              [
                ...enemyPool.getActiveTanks(),
                ...enemyPlanePool.getActiveTanks(),
              ],
              _playerLastAttackerPos,
            );
            if (_attacker) {
              killerDesc = _describeKillEntity(_attacker);
            } else if (_playerLastAttackerPos) {
              // A remote human's kill never appears in enemyPool/enemyPlanePool
              // (those are AI-only pools) — search remote proxies by proximity
              // too, so a real guest's kill isn't stuck showing as generic 'Enemy'.
              let bestProxy = null,
                bestDsq = 3600; // 60m, cosmetic only
              for (const [_rpUid, rp] of _remotePlayers.entries()) {
                if (!rp || !rp.active || rp.isDead || rp.team === localTeam)
                  continue;
                if (!_remoteDeployed.get(_rpUid)) continue;
                const rpp = rp.bodyGroup.position;
                const dx = rpp.x - _playerLastAttackerPos.x,
                  dz = rpp.z - _playerLastAttackerPos.z;
                const dsq = dx * dx + dz * dz;
                if (dsq < bestDsq) {
                  bestDsq = dsq;
                  bestProxy = rp;
                }
              }
              if (bestProxy) killerDesc = _describeKillEntity(bestProxy);
            }
          }
          recordKillEvent(
            killerDesc,
            _describeKillEntity(
              vehicleType === "plane" && plane ? plane : tank,
            ),
          );
        }
        _playerLastHitBy = null;
        _playerLastAttackerPos = null;
        _playerLastHitByExplicitName = null;
        _playerLastHitByShooterUid = null;
        _playerLastHitByStableId = null;
        _playerLastHitByStableTeam = null;
      }
      // document.getElementById('pause-btn').style.display = 'none';

      if (!matchEnded) {
        // ── Respawn path during match — hold the camera at the death spot for
        // DEATH_HOLD_DURATION seconds (game keeps running normally) before
        // handing off to the spawn-picker, instead of freezing instantly ──────
        deathScreen.style.display = "none";
        document.getElementById("death-menu-btn").style.display = "none";
        _deathHoldActive = true;
        _deathHoldTimer = DEATH_HOLD_DURATION;
      } else {
        // ── Permanent death after match ends ──────────────────────────────────
        document.getElementById("death-kills").textContent = killCount;
        document.getElementById("death-menu-btn").style.display = "block";
        deathScreen.style.display = "flex";
        exitGameplayPointerLock();
        showCursor();
      }

      // ── Exit scope immediately if active ─────────────────────────────────
      if (scope.isScoped) {
        scope._exitScope();
        tank.turretController?.setScopeLocked?.(false);
      }

      // ── Full turret/aim state reset immediately on death — clears enabled/
      // fixed-target/laser/lock-on state, not just the visible crosshairs, so
      // respawn doesn't inherit whatever aim mode was active at time of death ─
      tank.turretController?.resetOnDeath?.();
      document.getElementById("weapon-hud").style.display = "none";
      document.getElementById("minimap").style.display = "none";
      document.getElementById("hud-speed").style.display = "none";
      // document.getElementById('hud-kills').style.display    = 'none';
      document.getElementById("compass-bar").style.display = "none";
      // document.getElementById('hud-fps-wrap').style.display = 'none';
      // stats.dom.style.display = 'none';
      document.getElementById("health").style.display = "none";
    }

    // ── Enemy pool update — uses the ACTIVE vehicle's position, not
    // always the tank's. While flying, tank.rigidBody is parked at
    // y=-500 (see _parkTank()), so feeding enemy AI _tPos here would aim
    // them at the parked tank instead of the plane. _activePos already
    // resolves to whichever vehicle is actually being flown/driven. ──────
    if (_activePos) {
      _playerPos.set(_activePos.x, _activePos.y, _activePos.z);
    }
    // Always update enemies regardless of whether player rigidBody exists.
    // AI pools now run from the moment the host's loop starts (i.e. as
    // soon as "Ready!" is clicked and enterSpawnSelection() kicks off the
    // RAF chain) — no longer frozen until the player's first Deploy. This
    // is what lets the baseline squad (3 AI tanks + 1 AI plane per team)
    // already be spawned and patrolling by the time the player is looking
    // at the spawn-selection screen. See _buildAiCandidateList() below for
    // the guard that keeps AI from targeting the player's still-parked,
    // not-yet-deployed tank in the meantime.
    if (!matchEnded && isHost && gameStarted) {
      team1Pool.update(dt, _playerPos);
      team2Pool.update(dt, _playerPos);
      team1PlanePool.update(dt, _playerPos);
      team2PlanePool.update(dt, _playerPos);
      _ensureAllEntityNamesRegistered();
    } else if (matchEnded && isHost) {
      // Match over — only tick dissolve animations on dead tanks, skip AI/spawning
      for (const pool of [team1Pool, team2Pool]) {
        for (const t of pool.getActiveTanks()) {
          if (t._dissolveActive) t._tickDissolve(dt);
          t._ownBulletSystem?.update(dt);
        }
      }
    }

    // ── Enemy position cache — throttled to every 30 frames. No longer
    // drives any minimap rendering (enemy dots removed); still needed for
    // capture-point proximity checks, fence-break proximity, and kill
    // attribution (_lastKnownEnemyPos / _nearestByLastKnownPos). ──────────
    enemyCacheSkip++;
    if (enemyCacheSkip >= 120) {
      enemyCacheSkip = 0;
      refreshEnemyPosCache();
      refreshEnemyPlaneLastKnownPos();
    }

    // ── Friendly cache + minimap — throttled to every 30 frames ───────────
    friendlyCacheSkip++;
    if (friendlyCacheSkip >= 120) {
      friendlyCacheSkip = 0;
      refreshFriendlyPosCache();
      refreshFriendlyPlaneLastKnownPos(); // NEW — keeps kill attribution working for friendly planes
      updateMinimapFriendlies();
      _buildTeammatesList(); // keep AI-squad names in the teammates panel current as units spawn/die
    }

    // ── Friendly-plane markers — updated every frame (cheap: just a
    // position write per active marker), but hidden during spawn-
    // selection/death-hold since those branches return early before
    // reaching here anyway. getEntityName() already resolves the correct
    // per-viewer label (real name for real players, Friendly_N for AI).
    // ── Suppress friendly-name markers while spawn-selection owns the
    // camera — pass an empty list so any currently-shown markers are
    // cleaned up/hidden instead of continuing to update with names.
    friendlyPlaneMarkers.update(
      _spawnSelectionActive ? [] : _collectFriendlyPlanesForMarkers(),
      getEntityName,
    );
    friendlyTankMarkers.update(
      _spawnSelectionActive ? [] : _collectFriendlyTanksForMarkers(),
      getEntityName,
    );

    // ── Minimap player dot — throttled to every 50 frames, same cadence
    // as the friendly dots (previously ran every frame with only a 0.5px
    // movement dedup) ─────────────────────────────────────────────────────
    playerMinimapSkip++;
    if (playerMinimapSkip >= 120) {
      playerMinimapSkip = 0;
      updateMinimapPlayer(_activePos);
    }

    // ── Kill counter — unified across all 4 AI pools (see
    // _handleAiUnitDeath above), so tank/plane and team1/team2 kills are
    // all attributed with identical logic.
    for (const et of enemyPool.getActiveTanks()) _handleAiUnitDeath(et);
    for (const ep of enemyPlanePool.getActiveTanks()) _handleAiUnitDeath(ep);
    for (const ft of friendlyPool.getActiveTanks()) _handleAiUnitDeath(ft);
    for (const fp of friendlyPlanePool.getActiveTanks()) _handleAiUnitDeath(fp);

    // ── BirchTree / FirTree proximity-based fall trigger ──────────────────
    // Skip while the tank is dead/respawning or the spawn-picker is up —
    // otherwise trees near the death spot keep re-triggering fall state
    // every frame while the camera is held/orbiting, leaving them stuck
    // mid-animation ("half visible") when viewed from the spawn-select view.
    if (_tPos && !tank.isDead && !_spawnSelectionActive && !_deathHoldActive) {
      // ── Instanced forest fall triggers ────────────────────────────────
      // NOTE: fir is intentionally excluded here — fir trees now act as
      // static obstacles for tanks (see _resolveFirTreeCollisions()) rather
      // than falling on tank contact. They still fall for plane crashes via
      // onPlaneTreeCollision(), which is unaffected by this change.
      const _tx = _tPos.x;
      const _tz = _tPos.z;

      for (const forest of [
        forestManager.birch,
        forestManager.palm,
        forestManager.maple,
      ]) {
        if (!forest._ready) continue;
        for (let i = 0; i < forest.spots.length; i++) {
          if (forest._fallState[i] !== 0) continue;
          const { x: sx, z: sz } = forest.spots[i];
          const dx = sx - _tx;
          const dz = sz - _tz;
          const dsq = dx * dx + dz * dz;
          if (dsq < 4) {
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
    // Always tick grass — even while the player tank is dead/despawned/respawning —
    // otherwise uTime (wind sway) and chunk-LOD visibility freeze on the exact
    // frame the tank dies, and stay frozen until respawn. Fall back to the
    // camera position for culling when there's no live tank translation.
    {
      const _grassTrackedPos = _tPos
        ? { x: _tPos.x, y: _tPos.y, z: _tPos.z }
        : { x: camera.position.x, y: camera.position.y, z: camera.position.z };
      grassPool.update(
        cycleData.elapsed,
        { position: _grassTrackedPos },
        scene,
        camera,
      );
    }

    // ─── Water update ───────────────────────────────────────────────────────
    if (showWater) water.update(dt, camera);
        // ─── House smoke (chimneys) ─────────────────────────────────────────────
    houseSmokeSystem.update(dt, camera, renderer);

    // ─── Tree / Bush update ───────────────────────────────────────────────────────
    // treeInstances.forEach(inst => inst.update(cycleData.elapsed, camera, scene));
    // Force every forest chunk visible while the spawn-selection overview is
    // up — otherwise frustum culling (evaluated against the death-moment
    // camera) leaves everything except the last on-screen chunks hidden when
    // viewed from the new top-down spawn-picker camera.
    forestManager.update(
      cycleData.elapsed,
      dt,
      camera,
      scene,
      _activePos,
      _spawnSelectionActive,
    );
    instancedBush.update(cycleData.elapsed, camera, scene);

    flagSystem.update(cycleData.elapsed);

    // ── Death-hold: camera stays frozen where it is, game keeps simulating ──
    if (_deathHoldActive) {
      if (matchEnded) {
        // ── Match ended while we were waiting out the death-hold —
        // cancel the hold and show the permanent death screen instead of
        // ever handing off to the spawn-selection screen. The match-end
        // screen (matchEndScreen) was already raised by the match-timer
        // block earlier this frame; the death screen simply layers on
        // top of it, same as the existing "died after match already
        // ended" path below does. ───────────────────────────────────────
        _deathHoldActive = false;
        _deathHoldTimer = 0;
        document.getElementById("death-kills").textContent = killCount;
        document.getElementById("death-menu-btn").style.display = "block";
        deathScreen.style.display = "flex";
        showCursor();
        // fall through to normal per-frame rendering below (no early return)
      } else {
        _deathHoldTimer -= dt;
        if (_deathHoldTimer <= 0) {
          _deathHoldActive = false;
          enterSpawnSelection();
        }
        updateCPScreenMarkers(null, dt);
        renderFrame();
        return;
      }
    }

    // ── Spawn-selection: everything above this point (physics step,
    // enemyPool.update, friendlyPool.update, capture points, match timer)
    // has already run normally this frame. Only the camera is handed off
    // to OrbitControls here, so the world keeps moving while the player
    // picks where to deploy ────────────────────────────────────────────────
    if (_spawnSelectionActive) {
      spawnOrbitControls?.update();
      _updateSpawnMarkerPositions();

      // ── Keep vehicle-type availability live while the screen is up —
      // checked every ~0.25s so a friendly dying (freeing up that vehicle
      // type's slot) re-enables the corresponding Deploy option quickly,
      // instead of leaving the player stuck looking at a disabled button
      // for up to a full second. ────────────────────────────────────────
      _spawnScreenCapacityCheckTimer -= dt;
      if (_spawnScreenCapacityCheckTimer <= 0) {
        _spawnScreenCapacityCheckTimer = 0.25;
        _refreshVehicleTypeAvailability();
      }

      // ── Fade in the flight-cloud layer over the spawn-select view. It's
      // reset to invisible at the top of loop() (`flightCloudMesh.visible =
      // false`), so it must be re-armed here every frame this branch runs.
      if (flightCloudMesh && _spawnCloudActive) {
        flightCloudMesh.visible = true;
        const fadeIn = Math.min(
          flightCloudMesh.material.uniforms.uOpacity.value + dt / 0.6,
          0.85,
        );
        flightCloudMesh.material.uniforms.uOpacity.value = fadeIn;
        // Keep the cloud hole locked to wherever the spawn-select camera is
        // looking (harmless now that panning is disabled, but keeps this
        // correct if the target is ever moved again in the future).
        if (spawnOrbitControls) {
          flightCloudMesh.material.uniforms.uHoleCenter.value.set(
            spawnOrbitControls.target.x,
            spawnOrbitControls.target.z,
          );
        }
      }

      renderFrame();
      return;
    }

    if (vehicleType === "plane" && plane && !plane.isDead && plane.rigidBody) {
      // Model is authored with modelRotY = -90°, so the visual nose points
      // along local +X (not -Z) relative to bodyGroup's own rotation.
      _planeFwd.set(-1, 0, 0).applyQuaternion(plane.bodyGroup.quaternion);

      // ── IMPORTANT: use WORLD up here, not the plane's own tilted up.
      // The plane's local up rotates with pitch — during a steep climb it
      // swings toward horizontal (and past it), so the height offset stops
      // lifting the camera above the plane and the plane visually flies
      // off the top of the screen. World-up keeps the vertical offset
      // consistent no matter how steeply the plane is pitched. ───────────
      _planeUp.set(0, 1, 0);

      // ── Use the scroll-adjustable zoom distance, and scale height with
      // it so the camera keeps the same viewing ANGLE at any zoom level
      // instead of getting steeper/more overhead as dist shrinks ─────────
      const baseDist = plane.cfg.cameraFollowDistance ?? 14;
      const baseHeight = plane.cfg.cameraFollowHeight ?? 3.5;
      const _rearFlip = scope.rearViewActive ? -1 : 1;

      // ── Rear-view sits a bit closer/lower than the forward chase-cam —
      // tune these to taste (1.0 = identical to forward view)
      const REAR_VIEW_DIST_SCALE = 3.5;
      const REAR_VIEW_HEIGHT_SCALE = 0.0;

      const dist =
        planeCamDist * (scope.rearViewActive ? REAR_VIEW_DIST_SCALE : 1.0);
      const height =
        Math.max(1.8, baseHeight * (planeCamDist / baseDist)) *
        (scope.rearViewActive ? REAR_VIEW_HEIGHT_SCALE : 1.0);

      _planeCamLook.copy(plane.bodyGroup.position);

      // ── Rear-view: flip the camera to the opposite side of the plane,
      // looking back along the tail instead of ahead of the nose. Only
      // affects the chase-cam's placement — flight input/physics are
      // untouched, and this never applies while scoped (scope forces
      // rearViewActive = false on entry). ─────────────────────────────
      _planeCamPos
        .copy(plane.bodyGroup.position)
        .addScaledVector(_planeFwd, -dist * _rearFlip)
        .addScaledVector(_planeUp, height);

      if (deployCamActive) {
        // ── Deploy/respawn flythrough (plane) — fires every time the
        // player spawns as a plane, not just the first. Eases from
        // wherever the camera was left on the spawn-selection screen
        // (_deployCamStartPos/_deployCamStartLook, captured in
        // confirmSpawnSelection()) into the plane's normal chase-cam pose
        // computed just above. Mirrors the tank's own block below. ──────
        deployCamElapsed += dt;
        const t = Math.min(deployCamElapsed / DEPLOY_CAM_DURATION, 1);
        const k = easeInOutCubic(t);

        camera.position.lerpVectors(_deployCamStartPos, _planeCamPos, k);
        _clampCameraAboveTerrain(); // ← NEW
        _deployCamEndLook.copy(_planeCamLook);
        _planeSmoothLook.lerpVectors(_deployCamStartLook, _deployCamEndLook, k);
        camera.lookAt(_planeSmoothLook);

        camera.fov = THREE.MathUtils.lerp(_deployCamStartFov, _deployCamTargetFov, k);
        camera.updateProjectionMatrix();

        if (t >= 1) {
          deployCamActive = false;
          _planeSmoothPos.copy(_planeCamPos);
          _planeSmoothLook.copy(_planeCamLook);
          audio.startEngine();
        }
      } else {
        if (_planeSmoothPos.lengthSq() === 0) {
          _planeSmoothPos.copy(_planeCamPos);
        }

        // ── Only the camera's POSITION is smoothed/lagged (nice trailing
        // feel when turning). The look target is NOT lagged — it snaps to
        // the plane's actual current position every frame. If the look
        // target lagged too (like position does), a fast vertical climb
        // would outrun it: the camera would be looking at where the plane
        // WAS a moment ago, which is below where it is NOW, pushing the
        // plane visually toward the top of the screen the harder it climbs.
        // Snapping the look target eliminates that drift entirely. ────────
        const camLag = 1.0 - Math.pow(0.015, dt);
        _planeSmoothPos.lerp(_planeCamPos, camLag);
        _planeSmoothLook.copy(_planeCamLook);

        camera.position.copy(_planeSmoothPos);

        // ── Apply camera shake offset — mirrors the tank's own shake
        // application further down in the loop. plane._shakeOffset is
        // already computed every frame inside Plane.update()'s shake-decay
        // block (driven by plane.takeDamage() → _triggerCameraShake()); it
        // just was never being read anywhere, so hits on the plane never
        // visibly shook the camera.
        if (plane._shakeOffset) {
          camera.position.x += plane._shakeOffset.x;
          camera.position.y += plane._shakeOffset.y;
        }

        _clampCameraAboveTerrain(); // ← NEW — keeps the chase cam out of hills/ground
        camera.lookAt(_planeSmoothLook);
      }

      // ── Shadow frustum follows the plane while flying — mirrors the
      // tank-branch logic further below, which only runs when NOT flying
      // (this branch returns before ever reaching it). Without this,
      // light2 stays parked at the tank's last position/spawn point, so
      // the plane casts no shadow (or a stale one) while airborne. ───────
      const _planePos = plane.bodyGroup.position;
      light2.position.set(
        _planePos.x + LIGHT2_OFFSET.x,
        _planePos.y + LIGHT2_OFFSET.y,
        _planePos.z + LIGHT2_OFFSET.z,
      );
      light2.target.position.set(_planePos.x, _planePos.y, _planePos.z);
      light2.target.updateMatrixWorld();
      sunSphereMesh.position.copy(light2.position);

      // ── Flight clouds — fully opaque once you've climbed into/through the
      // altitude band; only fades while still below it approaching from the
      // ground, never dissolves again once reached (above or below the band).
      if (flightCloudMesh) {
        const alt = _planePos.y;
        const band = THREE.MathUtils.clamp(
          (alt - CLOUD_LAYER_MIN_ALT) /
            (CLOUD_LAYER_MAX_ALT - CLOUD_LAYER_MIN_ALT),
          0,
          1,
        );
        const fade = Math.min(1, band * 2);

        flightCloudMesh.visible = true;
        flightCloudMesh.material.uniforms.uOpacity.value = 0.85 * fade;
        // Position is fixed — set once at construction, never moved again.
      }

      compassAccum += dt;
      if (compassAccum >= COMPASS_INTERVAL) {
        compassAccum -= COMPASS_INTERVAL;
        drawCompassBar();
      }

      // ── Scope override — must run every frame while flying, exactly
      // like it already does further down for the tank. Without this
      // call, entering the scope while airborne shows the overlay but
      // the camera itself never moves to ScopePoint, since this branch
      // returns before the tank's camera code — the only other place
      // scope.update() is called — is ever reached.
      scope.update();

      _updateAiGunHud(); // ← AI turret gun ammo/reload — no-ops (hides) if this plane has no AI guns
      updatePlaneGunReticle(); // keep the free-flight reticle visible even while scoped
      autopilotBadge.style.display = plane.autopilotEnabled ? "block" : "none";

      if (plane.isOutOfPlayZone) {
        playZoneBadge.style.display = "block";
        playZoneBadge.textContent = `RETURN TO THE PLAY ZONE — ${Math.ceil(plane.outOfZoneTimeRemaining)}s`;
      } else {
        playZoneBadge.style.display = "none";
      }

      // ── Capture-point screen markers — this branch returns early every
      // frame while flying, so without this call here the markers freeze
      // at whatever position/state they were in the instant the player
      // switched to the plane (e.g. from spawn-selection or the tank's
      // last frame) and never update again for the rest of the flight.
      updateCPScreenMarkers(plane.bodyGroup.position, dt);

      renderFrame();
      return;
    }

    // ── Plane just died and is still falling/tumbling (the ~1.8s window
    // before _readyToShowDeath flips and death-hold takes over) — keep the
    // camera anchored on the falling wreck instead of falling through to
    // the tank-orbit branch below, which would otherwise orbit the PARKED
    // tank sitting at y=-500 and make the camera appear "lost". Simply
    // holds the camera's last relative offset from the plane and keeps
    // looking at it as it tumbles/falls. ─────────────────────────────────
    if (vehicleType === "plane" && plane && plane.isDead) {
      // ── Immediately drop out of the scope view the instant the plane
      // dies — don't wait for the death screen's own _exitScope() call,
      // which only fires once _readyToShowDeath flips (after the fall
      // animation). Without this, the scope's canvas overlay/modern-HUD/
      // enemy-markers/bearing-indicator stay frozen on screen for the
      // entire fall.
      if (scope.isScoped) scope._exitScope();

      planeCrosshair.style.display = "none";
      planeScopedCrosshair.style.display = "none"; // ← NEW — this is the piece that was never cleared
      autopilotBadge.style.display = "none";
      playZoneBadge.style.display = "none";

      // ── Freeze the flight-cloud layer exactly as it was at the moment
      // of death — never fade or hide it while falling. The top-of-frame
      // `flightCloudMesh.visible = false` reset (see the start of loop())
      // would otherwise hide it the instant isDead flips, so re-assert
      // visibility/opacity here every frame using whatever opacity it
      // last had.
      if (flightCloudMesh) {
        flightCloudMesh.visible = true;
        // uOpacity is left untouched — stays at whatever value it had
        // the moment the plane died.
      }

      _planeCamLook.copy(plane.bodyGroup.position);

      // Reuse whatever offset the camera already had relative to the plane
      // the instant it died, so there's no pop — just keep tracking that
      // same relative vantage point as the wreck falls.
      _planeCamPos
        .copy(_planeSmoothPos)
        .sub(_planeSmoothLook)
        .add(_planeCamLook);

      const posLag = 1.0 - Math.pow(0.02, dt);
      const lookLag = 1.0 - Math.pow(0.01, dt);
      _planeSmoothPos.lerp(_planeCamPos, posLag);
      _planeSmoothLook.lerp(_planeCamLook, lookLag);

      camera.position.copy(_planeSmoothPos);

      // ── Apply camera shake offset — same as the alive chase-cam branch.
      // Needed here too since the killing hit's shake plays out entirely
      // during this falling/dead camera branch, not the alive one.
      if (plane._shakeOffset) {
        camera.position.x += plane._shakeOffset.x;
        camera.position.y += plane._shakeOffset.y;
      }

      _clampCameraAboveTerrain(); // ← NEW — camera stays above ground even as the wreck falls behind a hill
      camera.lookAt(_planeSmoothLook);

      // ── Keep the shadow-casting light tracking the falling wreck too ────
      const _planeDeadPos = plane.bodyGroup.position;
      light2.position.set(
        _planeDeadPos.x + LIGHT2_OFFSET.x,
        _planeDeadPos.y + LIGHT2_OFFSET.y,
        _planeDeadPos.z + LIGHT2_OFFSET.z,
      );
      light2.target.position.set(
        _planeDeadPos.x,
        _planeDeadPos.y,
        _planeDeadPos.z,
      );
      light2.target.updateMatrixWorld();
      sunSphereMesh.position.copy(light2.position);

      updateCPScreenMarkers(null, dt);
      renderFrame();
      return;
    }

    // ── Camera: orbit + follow (tank) — zero allocations ────────────────────
    // ← ADD THIS GUARD — while a deploy is still resolving (specifically:
    // the FIRST-EVER plane deploy, where `await Plane.create(...)` is still
    // loading the GLB and `plane` is momentarily null), don't fall through
    // to the tank's fallback camera-follow using its stale/un-parked
    // position — that's what caused the brief "camera on the ground" flash.
    // Just hold the current frame (the exact pose left over from the
    // spawn-selection screen) until the deploy finishes and hands the
    // camera off to the correct vehicle's own branch.
    if (_deployInProgress) {
      renderFrame();
      return;
    }

    if (!_tPos) {
      renderFrame();
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
      _tPos.z + LIGHT2_OFFSET.z,
    );
    light2.target.position.set(_tPos.x, _tPos.y, _tPos.z);
    light2.target.updateMatrixWorld();
    sunSphereMesh.position.copy(light2.position);

    // ── Deploy/respawn flythrough (tank) — fires every time the player
    // spawns or respawns as a tank, not just the first. Overrides normal
    // camera follow until it finishes ────────────────────────────────────
    if (deployCamActive) {
      deployCamElapsed += dt;
      const t = Math.min(deployCamElapsed / DEPLOY_CAM_DURATION, 1);
      const k = easeInOutCubic(t);

      // Compute the normal gameplay camera target so we can ease into exactly
      // where the follow-cam would have been anyway (no pop on handoff)
      _camOffset.set(
        camDist * Math.sin(camYaw) * Math.cos(camPitch),
        camDist * Math.sin(camPitch),
        camDist * Math.cos(camYaw) * Math.cos(camPitch),
      );
      _desiredCamPos.copy(_tankPos).add(_camOffset);

      camera.position.lerpVectors(_deployCamStartPos, _desiredCamPos, k);
      _clampCameraAboveTerrain(); // ← NEW
      _deployCamEndLook.copy(_tankPos);
      smoothCamLook.lerpVectors(_deployCamStartLook, _deployCamEndLook, k);
      camera.lookAt(smoothCamLook);

      camera.fov = THREE.MathUtils.lerp(_deployCamStartFov, _deployCamTargetFov, k);
      camera.updateProjectionMatrix();

      if (t >= 1) {
        deployCamActive = false;
        smoothCamPos.copy(_desiredCamPos);

        // ── Engine sound kicks in once the deploy flythrough ends ─────
        audio.startEngine();
      }

      scope.update();
      compassAccum += dt;
      if (compassAccum >= COMPASS_INTERVAL) {
        compassAccum -= COMPASS_INTERVAL;
        drawCompassBar();
      }
      updateCPScreenMarkers(_tPos, dt);
      renderFrame();
      return; // skip normal camera-follow logic this frame
    }

    // Camera offset — reuses _camOffset scratch
    _camOffset.set(
      camDist * Math.sin(camYaw) * Math.cos(camPitch),
      camDist * Math.sin(camPitch),
      camDist * Math.cos(camYaw) * Math.cos(camPitch),
    );

    // Desired position — reuses _desiredCamPos scratch
    _desiredCamPos.copy(_tankPos).add(_camOffset);

    // ── Terrain-climb camera feel ─────────────────────────────────────────
    // Derive tank vertical speed from Y delta, then lag the camera pitch
    // and height so it "lumbers" up hills and dips into valleys.
    const tankY = _tPos ? _tPos.y : _lastTankY;
    const vertVel = (tankY - _lastTankY) / Math.max(dt, 0.001); // units/s
    _lastTankY = tankY;

    // How much the camera pitch and height respond to climbing — tune these
    const CLIMB_PITCH_SCALE = 0.018; // radians of extra pitch per unit/s vertical
    const CLIMB_HEIGHT_SCALE = 0.55; // extra world-units of height per unit/s vertical
    const CLIMB_SETTLE_SPEED = 3.5; // how fast the bias decays back to zero

    const targetPitchBias = THREE.MathUtils.clamp(
      vertVel * CLIMB_PITCH_SCALE,
      -0.18,
      0.18,
    );
    const targetHeightBias = THREE.MathUtils.clamp(
      vertVel * CLIMB_HEIGHT_SCALE,
      -1.8,
      1.8,
    );

    // Lag the bias so it doesn't snap instantly — feels like camera inertia
    _camPitchBias +=
      (targetPitchBias - _camPitchBias) * Math.min(1, dt * CLIMB_SETTLE_SPEED);
    _camHeightBias +=
      (targetHeightBias - _camHeightBias) *
      Math.min(1, dt * CLIMB_SETTLE_SPEED);

    // Recompute desired cam position with biased pitch
    const _climbPitch = camPitch + _camPitchBias;
    _camOffset.set(
      camDist * Math.sin(camYaw) * Math.cos(_climbPitch),
      camDist * Math.sin(_climbPitch) + _camHeightBias,
      camDist * Math.cos(camYaw) * Math.cos(_climbPitch),
    );
    _desiredCamPos.copy(_tankPos).add(_camOffset);

    // ── Camera collision — shrink the orbit distance if something blocks
    // the line of sight between the tank and the desired camera position ──
    const _safeDist = _getCameraCollisionDistance(
      _tankPos,
      _desiredCamPos,
      camDist,
    );
    _camCollisionDist +=
      (_safeDist - _camCollisionDist) * Math.min(1, dt * CAM_COLLISION_LERP);

    if (_camCollisionDist < camDist - 0.01) {
      // Something is blocking — recompute desired position at the clamped
      // distance, keeping the same yaw/pitch/climb-bias direction.
      _camOffset.set(
        _camCollisionDist * Math.sin(camYaw) * Math.cos(_climbPitch),
        _camCollisionDist * Math.sin(_climbPitch) + _camHeightBias,
        _camCollisionDist * Math.cos(camYaw) * Math.cos(_climbPitch),
      );
      _desiredCamPos.copy(_tankPos).add(_camOffset);
    }

    // ── Realistic camera lag ──────────────────────────────────────────────
    const posLag = 1.0 - Math.pow(0.012, _smoothedDt);
    const lookLag = 1.0 - Math.pow(0.001, _smoothedDt);

    smoothCamPos.lerp(_desiredCamPos, posLag);
    smoothCamLook.lerp(_tankPos, lookLag);

    camera.position.copy(smoothCamPos);

    // ── Apply camera shake offset ─────────────────────────────────────────
    if (tank._shakeOffset) {
      camera.position.x += tank._shakeOffset.x;
      camera.position.y += tank._shakeOffset.y;
    }
    _clampCameraAboveTerrain(); // ← NEW — never let the orbit camera dip below ground
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
        const vV = speed * _barrelDir.y;
        const vH = speed * Math.sqrt(1 - _barrelDir.y * _barrelDir.y);
        const h0 = 1.5;
        const g = 22;
        const disc = vV * vV + 2 * g * h0;
        const tof = (vV + Math.sqrt(disc)) / g;
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
    updateCPScreenMarkers(_tPos, dt);
    renderFrame();
  }

  const _onKeydownDebug = (e) => {
    if (e.key === "B" || e.key === "b") {
      debugRenderer.mesh.visible = !debugRenderer.mesh.visible;
    }
  };
  window.addEventListener("keydown", _onKeydownDebug);

  // ── Pointer Lock can be exited by the BROWSER itself (Esc key is
  // reserved and can't be intercepted) without us ever calling
  // exitGameplayPointerLock(). Detect that here and treat it exactly like
  // the player opening the pause menu, so game state/UI never drifts out
  // of sync with "is the cursor actually free right now". ────────────────
  document.addEventListener("pointerlockchange", () => {
    const stillLocked = isPointerLocked();
    if (
      !stillLocked &&
      gameStarted &&
      !isPaused &&
      !_activeVehicleIsDead() &&
      !matchEnded &&
      !gameOver &&
      !_spawnSelectionActive
    ) {
      openPause();
    }
  });

  // ── Hide loading screen + show Start button ───────────────────────────────
  const loadingEl = document.getElementById("loading");
  const hudEl2 = document.getElementById("health");
  const barEl = document.getElementById("loading-bar");
  const statusEl = document.getElementById("loading-status");

  // ── Animate loading steps ─────────────────────────────────────────────────
  const loadingSteps = [
    [0, "10%", "Initialising physics…"],
    [200, "25%", "Building terrain…"],
    [400, "45%", "Loading tank model…"],
    [650, "60%", "Building tracks & wheels…"],
    [900, "75%", "Spawning enemies…"],
    [1100, "88%", "Loading audio…"],
    [1300, "100%", "Ready."],
  ];
  loadingSteps.forEach(([delay, width, text]) => {
    setTimeout(() => {
      barEl.style.width = width;
      if (statusEl) statusEl.textContent = text;
    }, delay);
  });

  // Build the start button overlay
  const startOverlay = document.createElement("div");
  startOverlay.style.cssText = `
      position: fixed;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #0d0d0d;
      z-index: 9999;
    `;
  startOverlay.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  const startBtn = document.createElement("button");
  startBtn.textContent = "Ready!";
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
  startBtn.addEventListener("mouseenter", () => {
    startBtn.style.background = "rgba(70,120,30,0.95)";
    startBtn.style.transform = "scale(1.04)";
  });
  startBtn.addEventListener("mouseleave", () => {
    startBtn.style.background = "rgba(40,70,20,0.85)";
    startBtn.style.transform = "scale(1)";
  });

  startOverlay.appendChild(startBtn);

  // ── Pre-deploy spawn-selection screen ───────────────────────────────────
  // ── Pre-deploy / post-death spawn-selection screen ──────────────────────
  let spawnOrbitControls = null;
  let _selectedSpawnPoint = null;
  let _spawnSelectionLocked = false; // true once Deploy has been clicked — freezes point/type selection until the next spawn-selection screen
  const _spawnMarkerEls = new Map(); // spawnPoint -> DOM el (tank/ground spawn points)
  const _planeSpawnMarkerEls = new Map(); // spawnPoint -> DOM el (plane/airborne spawn points)
  const _spawnProjScratch = new THREE.Vector3();
  const _spawnSelectionCentroid = new THREE.Vector3(); // reused each frame for cloud position

  const spawnMarkerContainer = document.createElement("div");
  spawnMarkerContainer.style.cssText = `
    position:fixed; inset:0; pointer-events:none; z-index:400; display:none;
  `;
  document.body.appendChild(spawnMarkerContainer);

  const deploySpawnBtn = document.createElement("button");
  deploySpawnBtn.textContent = "Deploy";
  deploySpawnBtn.disabled = true;
  deploySpawnBtn.style.cssText = `
    position:fixed; right:32px; bottom:32px; z-index:401; display:none;
    padding:9px 28px; font-size:16px; font-family:monospace; font-weight:bold;
    letter-spacing:2px; color:#d4f0a0; background:rgba(40,70,20,0.85);
    border:1px solid #6aaa30; cursor:pointer; text-transform:uppercase;
    opacity:0.4; transition:background 0.15s, transform 0.1s, opacity 0.15s;
  `;
  deploySpawnBtn.addEventListener("mouseenter", () => {
    if (deploySpawnBtn.disabled) return;
    deploySpawnBtn.style.background = "rgba(70,120,30,0.95)";
    deploySpawnBtn.style.transform = "scale(1.04)";
  });
  deploySpawnBtn.addEventListener("mouseleave", () => {
    deploySpawnBtn.style.background = "rgba(40,70,20,0.85)";
    deploySpawnBtn.style.transform = "scale(1)";
  });
  document.body.appendChild(deploySpawnBtn);

  // ── Vehicle-type selection (Tank / Plane) — shown center-bottom during
  // spawn-selection. Deploy stays disabled until BOTH a spawn point and a
  // vehicle type have been chosen.
  let _selectedVehicleType = null; // 'tank' | 'plane' | null

  const vehicleTypeContainer = document.createElement("div");
  vehicleTypeContainer.style.cssText = `
    position:fixed; left:50%; bottom:32px; transform:translateX(-50%);
    z-index:401; display:none; gap:12px;
    font-family:'Courier New',monospace;
  `;
  document.body.appendChild(vehicleTypeContainer);

  function _buildVehicleTypeBtn(type, label) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.dataset.vehicleType = type;
    btn.style.cssText = `
      padding:10px 26px; font-size:13px; font-family:monospace; font-weight:bold;
      letter-spacing:1.5px; color:#a0b880; background:rgba(0,0,0,0.6);
      border:1px solid #2a3a1a; cursor:pointer; text-transform:uppercase;
      border-radius:4px; transition:background 0.15s, border-color 0.15s, color 0.15s;
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      _selectVehicleType(type);
    });
    vehicleTypeContainer.appendChild(btn);
    return btn;
  }

  const tankTypeBtn = _buildVehicleTypeBtn("tank", "🛡  Tank");
  const planeTypeBtn = _buildVehicleTypeBtn("plane", "✈  Plane");

  function _selectVehicleType(type) {
    if (_spawnSelectionLocked) return;
    // Reject picking a vehicle type whose friendly AI slots are already
    // full — see _isFriendlyPoolFull(). This should already be prevented by
    // the button itself being disabled (see _refreshVehicleTypeAvailability),
    // but guard here too in case this is ever called programmatically.
    if (_isFriendlyPoolFull(type)) return;

    _selectedVehicleType = type;

    [tankTypeBtn, planeTypeBtn].forEach((btn) => {
      const active = btn.dataset.vehicleType === type;
      btn.style.background = active
        ? "rgba(100,220,90,0.75)"
        : "rgba(0,0,0,0.6)";
      btn.style.borderColor = active ? "#8dff6a" : "#2a3a1a";
      btn.style.color = active ? "#0a1006" : "#a0b880";
    });

    // ── Only ever show the spawn markers relevant to the chosen vehicle —
    // tanks and planes have separate spawn locations now, so mixing both
    // sets on screen would let the player pick a plane's airborne spot
    // while deploying a tank, or vice versa.
    const activeList =
      type === "plane" ? PLANE_SPAWN_POINTS : PLAYER_SPAWN_POINTS;
    const activeMarkers =
      type === "plane" ? _planeSpawnMarkerEls : _spawnMarkerEls;
    const inactiveMarkers =
      type === "plane" ? _spawnMarkerEls : _planeSpawnMarkerEls;

    inactiveMarkers.forEach((el) => {
      el.style.display = "none";
    });
    _selectSpawnPoint(activeList[0], activeMarkers); // sensible default; user can still pick another

    _updateDeployButtonState();

    // ── NOTE: this is a TENTATIVE selection, not yet a deploy — the
    // real player doesn't "occupy" this type (for AI-target purposes)
    // until confirmSpawnSelection() actually deploys them into it (see
    // Change 5). Tentatively clicking around the two buttons must NOT
    // shrink/grow AI pool caps, or clicking Tank→Plane→Tank while
    // deciding could destroy/respawn live AI units on every click.
  }

  // ── Disable/grey out whichever vehicle-type button is at squad capacity,
  // and re-point selection at the other type if the currently-selected one
  // just became full (e.g. an AI friendly of that type spawned while the
  // player was sitting on the spawn-selection screen). Called every time
  // the spawn-selection screen is (re)entered, and once per second while
  // it's up, so a slot opening/closing updates the UI promptly. ───────────
  function _refreshVehicleTypeAvailability() {
    const tankFull = _isFriendlyPoolFull("tank");
    const planeFull = _isFriendlyPoolFull("plane");

    tankTypeBtn.disabled = tankFull;
    planeTypeBtn.disabled = planeFull;
    tankTypeBtn.style.opacity = tankFull ? "0.35" : "1";
    planeTypeBtn.style.opacity = planeFull ? "0.35" : "1";
    tankTypeBtn.style.cursor = tankFull ? "not-allowed" : "pointer";
    planeTypeBtn.style.cursor = planeFull ? "not-allowed" : "pointer";

    // If the currently-selected type just became full, bump the player to
    // whichever type still has room (there's always at least one free slot
    // in practice, since the player's own vehicle never counts against
    // either pool's cap).
    if (_selectedVehicleType === "tank" && tankFull && !planeFull) {
      _selectVehicleType("plane");
    } else if (_selectedVehicleType === "plane" && planeFull && !tankFull) {
      _selectVehicleType("tank");
    }
  }

  function _updateDeployButtonState() {
    const ready = !!_selectedSpawnPoint && !!_selectedVehicleType;
    deploySpawnBtn.disabled = !ready;
    deploySpawnBtn.style.opacity = ready ? "1" : "0.4";
  }

  PLAYER_SPAWN_POINTS.forEach((p, i) => {
    const el = document.createElement("div");
    el.style.cssText = `
      position:absolute; top:0; left:0;
      display:flex; flex-direction:column; align-items:center; gap:4px;
      pointer-events:auto; cursor:pointer; will-change:transform;
      font-family:'Courier New',monospace;
    `;
    el.innerHTML = `
      <div class="spawn-marker-dot" style="
        width:26px; height:26px; border-radius:50%;
        background:rgba(30,110,220,0.55); border:2px solid #44aaff;
        box-shadow:0 0 10px rgba(68,170,255,0.8);
        display:flex; align-items:center; justify-content:center;
        color:#f5f0e8; font-size:11px; font-weight:bold;
      ">${i + 1}</div>
      <div style="font-size:10px; color:#d4f0a0; text-shadow:0 0 3px rgba(0,0,0,0.9);">SPAWN</div>
    `;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      _selectSpawnPoint(p, _spawnMarkerEls);
    });
    spawnMarkerContainer.appendChild(el);
    _spawnMarkerEls.set(p, el);
  });

  // ── Plane spawn markers — same visual pattern as tank markers, built
  // into the same container but kept hidden until vehicle type = 'plane'
  // (see _selectVehicleType below).
  PLANE_SPAWN_POINTS.forEach((p, i) => {
    const el = document.createElement("div");
    el.style.cssText = `
      position:absolute; top:0; left:0;
      display:flex; flex-direction:column; align-items:center; gap:4px;
      pointer-events:auto; cursor:pointer; will-change:transform;
      font-family:'Courier New',monospace;
    `;
    el.innerHTML = `
      <div class="spawn-marker-dot" style="
        width:26px; height:26px; border-radius:50%;
        background:rgba(30,110,220,0.55); border:2px solid #44aaff;
        box-shadow:0 0 10px rgba(68,170,255,0.8);
        display:flex; align-items:center; justify-content:center;
        color:#f5f0e8; font-size:11px; font-weight:bold;
      ">${i + 1}</div>
      <div style="font-size:10px; color:#d4f0a0; text-shadow:0 0 3px rgba(0,0,0,0.9);">✈ SPAWN</div>
    `;
    el.style.display = "none"; // hidden until 'plane' is the selected vehicle type
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      _selectSpawnPoint(p, _planeSpawnMarkerEls);
    });
    spawnMarkerContainer.appendChild(el);
    _planeSpawnMarkerEls.set(p, el);
  });

  function _selectSpawnPoint(p, markerMap = _spawnMarkerEls) {
    if (_spawnSelectionLocked) return;
    _selectedSpawnPoint = p;
    markerMap.forEach((el, point) => {
      const dot = el.querySelector(".spawn-marker-dot");
      if (point === p) {
        dot.style.background = "rgba(100,220,90,0.75)";
        dot.style.borderColor = "#8dff6a";
        dot.style.boxShadow = "0 0 14px rgba(120,255,90,0.9)";
      } else {
        dot.style.background = "rgba(30,110,220,0.55)";
        dot.style.borderColor = "#44aaff";
        dot.style.boxShadow = "0 0 10px rgba(68,170,255,0.8)";
      }
    });
    _updateDeployButtonState();
  }

  function _updateSpawnMarkerPositions() {
    const activeMap =
      _selectedVehicleType === "plane" ? _planeSpawnMarkerEls : _spawnMarkerEls;
    activeMap.forEach((el, p) => {
      _spawnProjScratch.set(p.x, p.y, p.z).project(camera);
      const onScreen =
        _spawnProjScratch.z < 1 &&
        _spawnProjScratch.x >= -1.2 &&
        _spawnProjScratch.x <= 1.2 &&
        _spawnProjScratch.y >= -1.2 &&
        _spawnProjScratch.y <= 1.2;
      if (!onScreen) {
        el.style.display = "none";
        return;
      }
      el.style.display = "flex";
      const x = (_spawnProjScratch.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-_spawnProjScratch.y * 0.5 + 0.5) * window.innerHeight;
      el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%,-50%)`;
    });
  }

  function enterSpawnSelection() {
    _spawnSelectionActive = true;
    scope.spawnSelectionActive = true;   // block the "V" gunner-sight toggle while this screen is up
    sunSphereMesh.visible = false; // hide the sun sphere while the spawn-selection map is up

    // ── Clear the death grayscale the moment the spawn-selection screen
    // takes over — it was only ever meant to cover the death-hold window
    // (turret-eject/fall + camera hold), not the spawn-picker itself.
    setDeathGrayscale(false);
    clearDeathBlur();
    _spawnSelectionLocked = false; // fresh screen — selection unlocked again
    _isCurrentlyDeployed = false; // no live vehicle until confirmSpawnSelection() completes
    _unfreezePointerVisual(); // guard against a leftover freeze from an interrupted prior deploy
    exitGameplayPointerLock(); // ← free the cursor for map panning/marker clicks on this screen

    // ── NOTE: _realPlayerVehicleChoice is intentionally left untouched
    // here. Dying does not clear this client's tracked vehicle type —
    // their last-deployed choice keeps reserving that slot's AI target
    // exactly as before, so the corresponding Deploy button on the
    // spawn-selection screen is never blocked for their OWN last type
    // (see _isFriendlyPoolFull's _reservedType exemption), and the only
    // thing that ever frees up the OTHER type is an actual living AI
    // unit of that type dying (see _countLivingFriendlyAI).
    setInputSuppressed(true); // ← block fire input while the pan-camera owns left-click
    stats.dom.style.display = "none";
    showCursor(); // ← spawn map needs the cursor for panning/clicking markers

    // ── Defensive scope reset — guarantees the camera is never handed to
    // the spawn-selection view still zoomed in, even if death happened
    // through an edge case that skipped the normal exitScope() call ──────
    if (scope.isScoped) {
      scope._exitScope();
    }
    // ── Wide FOV for the spawn-selection overview screen — gives a much
    // broader view of the map while picking a spawn point/vehicle, then
    // gets reset back to normal the instant the player actually deploys
    // (see confirmSpawnSelection(), which restores the vehicle's own
    // normal FOV once camera control hands back to gameplay).
    camera.fov = 110;
    camera.updateProjectionMatrix();

    // ── Lighter fog for the spawn-selection overview — the elevated
    // top-down camera makes normal ground-level fog density look overly
    // hazy at the long viewing distances involved here. Restored back to
    // normal in confirmSpawnSelection() once the player deploys.
    if (scene.fog) {
      scene.fog.density = _baseFogDensity * 0.15; // tune this multiplier to taste
    }

    if (startOverlay.parentNode) {
      startOverlay.style.transition = "opacity 0.3s";
      startOverlay.style.opacity = "0";
      setTimeout(() => startOverlay.remove(), 300);
    }

    // ── Centroid of all spawn points, so the top view frames all of them ──
    const centroid = new THREE.Vector3();
    PLAYER_SPAWN_POINTS.forEach((p) =>
      centroid.add(new THREE.Vector3(p.x, p.y, p.z)),
    );
    centroid.divideScalar(PLAYER_SPAWN_POINTS.length);
    _spawnSelectionCentroid.copy(centroid);

    // ── Hold at the intro flythrough's first-frame pose, re-centered on
    // the spawn points instead of a single tank position ──────────────────
    camera.position.set(centroid.x + 35, 400, centroid.z + 35);
    camera.lookAt(centroid);

    spawnOrbitControls = new OrbitControls(camera, renderer.domElement);
    spawnOrbitControls.target.copy(centroid);
    spawnOrbitControls.enablePan = false; // ← panning disabled during spawn selection
    spawnOrbitControls.enableRotate = false;
    spawnOrbitControls.enableZoom = false;
    // ── Pan on the world-horizontal plane instead of the camera's tilted
    // screen plane — otherwise dragging to pan drifts the height (Y) since
    // the camera looks down at an angle ─────────────────────────────────
    spawnOrbitControls.screenSpacePanning = false;
    spawnOrbitControls.maxPolarAngle = Math.PI / 2.1; // keep it top-down-ish
    spawnOrbitControls.minDistance = 40;
    spawnOrbitControls.maxDistance = 1600;
    // ── Swap default mouse mapping — left-click drags/pans the map, right-
    // click rotates instead. Feels more natural for a top-down spawn-select
    // view than OrbitControls' default (left=rotate, right=pan) ───────────
    spawnOrbitControls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    spawnOrbitControls.update();

    spawnMarkerContainer.style.display = "block";
    // NOTE: do NOT set this to 'auto' — spawnMarkerContainer is a
    // full-screen (inset:0) overlay. Making the whole container
    // clickable blocks every mousedown/mousemove meant for
    // OrbitControls' panning on the canvas underneath. Each individual
    // spawn marker (`el`) already sets its own `pointer-events:auto`
    // (see where _spawnMarkerEls/_planeSpawnMarkerEls are built), so
    // the container itself must stay 'none' to let clicks pass through
    // to the canvas everywhere except directly on a marker dot.
    spawnMarkerContainer.style.pointerEvents = "none";
    deploySpawnBtn.style.display = "block";
    vehicleTypeContainer.style.display = "flex";
    vehicleTypeContainer.style.pointerEvents = "auto";

    // ── Squad capacity gating — must run BEFORE _selectVehicleType() below,
    // since it may need to redirect away from a type that's now full. ──────
    _refreshVehicleTypeAvailability();

    // Selects a sensible default spawn point for whichever vehicle type is
    // active (defaults to 'tank' on first-ever entry) and shows only that
    // type's markers — also re-applies active button styling on a
    // mid-match respawn re-entering this screen.
    _selectVehicleType(_selectedVehicleType ?? "tank");

    // ── Hide capture-point screen markers — they freeze at their last
    // computed position since updateCPScreenMarkers() isn't called while
    // spawn-selection owns the camera ────────────────────────────────────
    cpMarkerContainer.style.display = "none";

    // ── Hide friendly-name UI while spawn-selection owns the screen ──────
    teammatesHud.style.display = "none";

    // ── Fade in the spawn-selection vignette ──────────────────────────────
    spawnVignette.style.display = "block";
    requestAnimationFrame(() => {
      spawnVignette.style.opacity = "1";
    });

    // ── Show the flight-cloud layer over the spawn-selection view. Its
    // position is fixed (set once in _buildFlightClouds) and already spans
    // the whole map, so no repositioning is needed here — just fade it in. ─
    if (flightCloudMesh) {
      flightCloudMesh.material.uniforms.uOpacity.value = 0.0; // fades in via loop below
      // Punch a clear hole through the cloud layer centered on the spawn
      // points' centroid — that's exactly where the camera is looking
      // (spawnOrbitControls.target was just set to it above) — so the map
      // stays visible in the middle instead of being fully obscured.
      flightCloudMesh.material.uniforms.uHoleCenter.value.set(
        centroid.x,
        centroid.z,
      );
      flightCloudMesh.material.uniforms.uHoleEnabled.value = 1.0;
      flightCloudMesh.visible = true;
      _spawnCloudActive = true;
    }

    // ── Only kick the RAF chain if it isn't already running (mid-match
    // respawns reuse the loop that's already going) ───────────────────────
    if (!_loopRunning) {
      _loopRunning = true;
      loop();
    }
  }

  deploySpawnBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!_selectedSpawnPoint || deploySpawnBtn.disabled) return;
    // ── Lock the spawn point/vehicle-type selection the instant Deploy is
    // clicked. confirmSpawnSelection() is async (e.g. awaits Plane.create()
    // on a first plane deploy) — without this, a stray click on another
    // spawn marker or vehicle-type button during that window could change
    // _selectedSpawnPoint/_selectedVehicleType out from under the deploy
    // that's already in flight.
    _spawnSelectionLocked = true;
    spawnMarkerContainer.style.pointerEvents = "none";
    vehicleTypeContainer.style.pointerEvents = "none";
    _freezePointerVisual(); // hide + freeze the cursor while the deploy resolves
    confirmSpawnSelection();
  });

  async function confirmSpawnSelection() {
    if (_deployInProgress) return;
    _deployInProgress = true;
    deploySpawnBtn.disabled = true;
    deploySpawnBtn.textContent = "Deploying…";
    // ── Capture the camera's exact pose at the moment spawn-selection
    // ends — this becomes the START of the deploy intro flythrough below,
    // replacing the old fixed-offset formula so the camera transitions
    // smoothly FROM wherever the player left it on the spawn map TO the
    // vehicle they're about to pilot, instead of snapping to a formulaic
    // point first. Must be captured before spawnOrbitControls is disposed.
    _deployCamStartPos.copy(camera.position);
    _deployCamStartLook.copy(
      spawnOrbitControls ? spawnOrbitControls.target : camera.position,
    );

    // ── Restore normal fog density now that the player is deploying back
    // into the ground-level view (see enterSpawnSelection(), which
    // lowered it for the top-down overview).
    if (scene.fog) {
      scene.fog.density = _baseFogDensity;
    }

    // ── Squad AI-target resolution — applied HERE, at actual deploy
    // confirmation, every time (first deploy and every respawn alike).
    // Records that this real player now occupies _selectedVehicleType on
    // their own team, then recomputes + applies that team's AI targets
    // (4 tanks / 2 planes minus whatever real players currently occupy).
    // On a GUEST this only updates local tracking state (harmless, keeps
    // this client's own _isFriendlyPoolFull() UI check accurate) — the
    // actual host-side pool mutation happens when the resulting
    // deployed:true match:state packet reaches _applyRemotePlayerVehicleState
    // on the host (see Change 6). On the HOST (including solo/non-squad
    // play, where isHost is always true), _setRealPlayerVehicleChoice
    // below applies directly to the real, live pools via _applyTeamAiTargets.
    if (config.friendlySquadEnabled && aiPlayersEnabled) {
      _setRealPlayerVehicleChoice(
        localTeam,
        config.userId ?? "local",
        _selectedVehicleType,
      );
    }

    _spawnSelectionActive = false;
    scope.spawnSelectionActive = false;   // re-enable the "V" gunner-sight toggle now that gameplay resumes
    sunSphereMesh.visible = true; // restore the sun sphere now that the player is deploying
    setInputSuppressed(false); // ← re-arm fire input now that spawn-select is done
    spawnOrbitControls?.dispose();
    spawnOrbitControls = null;
    spawnMarkerContainer.style.display = "none";
    spawnMarkerContainer.style.pointerEvents = "none"; // reset for next spawn-selection entry
    deploySpawnBtn.style.display = "none";
    vehicleTypeContainer.style.display = "none";

    if (typeof window._forceReleaseMouseHold === "function") {
      window._forceReleaseMouseHold();
    }

    spawnVignette.style.opacity = "0";
    setTimeout(() => {
      spawnVignette.style.display = "none";
    }, 600);

    if (flightCloudMesh) {
      flightCloudMesh.visible = false;
      flightCloudMesh.material.uniforms.uOpacity.value = 0.0;
      flightCloudMesh.material.uniforms.uHoleEnabled.value = 0.0; // ← hole only applies during spawn-select
    }
    _spawnCloudActive = false;

    const pos = {
      x: _selectedSpawnPoint.x,
      y: _selectedSpawnPoint.y,
      z: _selectedSpawnPoint.z,
    };
    vehicleType = _selectedVehicleType; // 'tank' | 'plane'

    // ── Planes can never capture points — clear any stale F-hold state
    // from before the switch so it doesn't leak into flight.
    if (vehicleType === "plane") {
      _fKeyHeld = false;
      _fHoldTimer = 0;
      setCaptureWipe(0);
    }

    if (vehicleType === "plane") {
      _setBoundaryWallsEnabled(false); // ← NEW — plane ignores the map-edge walls
      // _selectedSpawnPoint is already one of PLANE_SPAWN_POINTS at this
      // point — only plane markers were visible/clickable while 'plane'
      // was the selected vehicle type — so it's already at flight
      // altitude and needs no ground-point + offset resolution.
      const planeSpawnPos = {
        x: _selectedSpawnPoint.x,
        y: _selectedSpawnPoint.y,
        z: _selectedSpawnPoint.z,
      };

      const _pc = _planePreset?.config ?? {}; // ← hoisted out of the if/else so it's available below too

      if (!plane) {
        // ── Strip tank-only research-skill fields before basing the plane's
        // config on the shared `config` object. index.html applies the
        // TANK's selected skills directly onto the shared tankConfig/config
        // object before it ever reaches main.js — and some skill effect
        // keys are shared between the tank and plane skill lists (e.g.
        // "repairTime", "mgReloadTime"), so config.repairTime may already
        // be the TANK's own skill-adjusted value. Spreading `...config`
        // unfiltered would silently carry that into the plane's config
        // even when the plane has no matching skill selected at all.
        const _configForPlane = { ...config };
        delete _configForPlane.repairTime;
        delete _configForPlane.mgReloadTime;

        const _planeCreateParams = {
          ..._configForPlane,
          ..._pc, // ← plane's own preset config (gunType, fireSound, mgDamage, etc.) wins over the tank's
          gravity: 15.0,
          maxSpeed: _pc.maxSpeed ?? 20,
          boostMaxSpeed: _pc.boostMaxSpeed ?? 40,
          minSpeed: undefined,
          cruiseSpeed: undefined,
          mgAmmo: undefined,
          gunType: _pc.gunType ?? 3,
          // ── modelScale/modelOffset*/modelRot* must NEVER fall through to the
          // TANK's own config values (tankConfig.modelScale etc., spread in via
          // ...config above) — those are tuned for the tank model and are
          // wildly wrong for a plane. Only the plane preset's own config (_pc)
          // or plane.js's own built-in defaults should ever apply here.
          modelScale: _pc.modelScale ?? undefined,
          modelOffsetX: _pc.modelOffsetX ?? undefined,
          modelOffsetY: _pc.modelOffsetY ?? undefined,
          modelOffsetZ: _pc.modelOffsetZ ?? undefined,
          modelRotX: _pc.modelRotX ?? undefined,
          modelRotY: _pc.modelRotY ?? undefined,
          modelRotZ: _pc.modelRotZ ?? undefined,
          // ── Spawn throttle / gear / autopilot state all come from the MAP
          // config, not the plane preset — different maps can want planes to
          // spawn cruising vs. idling, gear up vs. down, or autopilot on/off.
          initialThrottle: mapDef.plane?.initialThrottle ?? 0.5,
          landingGearDown: mapDef.plane?.landingGearDown ?? true,
          initialAutopilotOn: mapDef.plane?.autopilotOn ?? true,
          renderer,
          modelPath:
            window._selectedPlaneModelPath ??
            _planePreset?.modelPath ??
            config.planeModelPath ??
            undefined,
          loadout: {
            mgAmmo: _pc.loadout?.mgAmmo ?? undefined,
            rocketAmmo: _pc.loadout?.rocketAmmo ?? undefined,
            bombAmmo: _pc.loadout?.bombAmmo ?? undefined,
            hispanoAmmo: _pc.loadout?.hispanoAmmo ?? undefined,
          },
        };

        // ← MUST run after every spread/explicit-override above — this is what
        // actually makes plane research skills take effect, instead of being
        // silently clobbered by `..._pc`.
        _applySelectedSkillsTo(_planeCreateParams);

        // Resolve the plane's repair-time skill NOW, so tickPlaneRepair (which
        // reads PLANE_REPAIR_HOLD_TIME live via closure every frame) reflects
        // it from this deploy onward.
        PLANE_REPAIR_HOLD_TIME = _planeCreateParams.repairTime ?? 5;

        plane = await Plane.create(
          scene,
          world,
          planeSpawnPos,
          _planeCreateParams,
        );

                // ── Lens flare occlusion — include the plane body so the flare
        // hides correctly when the plane itself blocks the sun.
        if (lensFlare) {
          lensFlare.params.occluders.push(plane.bodyGroup);
        }

        // ── Play the crash-explosion sound when the plane hits the ground and
        // blows up. Assigned once here since `plane` is only ever created once
        // (subsequent lives reuse this same instance via plane.respawn()).
        plane.onGroundExplosion = (impactPos, kind) => {
          if (kind === "impact") {
            audio.playExplosion(); // wreck actually hitting the ground
          } else {
            audio.playPlaneExplosion(); // moment of destruction (mid-air)
          }
        };

        // ── Auto-fire rocket feedback — RocketSystem.onAutoFire (set inside
        // plane.js) already decrements ammo; this appends the HUD/audio/network
        // side-effects main.js owns, same as the single-shot path in onFire().
        const _planeAutoFireBase = plane.rocketSystem.onAutoFire;
        plane.rocketSystem.onAutoFire = () => {
          _planeAutoFireBase?.();
          _localFireSeq++;
          _updatePlaneWeaponHud();
          audio.playRocket();
          plane.triggerFireShake('rocket');
        };

        _resetPlaneLoadout();

        // ── Plane weapon → remote-player hit relay ──────────────────────────────
        // Mirrors tank.bulletSystem.onHit / tank.mgSystem.onHit further up in
        // init(). Without this, a plane's gun/rocket raycast (or a bomb's blast
        // sweep) can catch a REAL remote player's plane/tank — not an AI unit,
        // so _enemyResolver/resolver('__all__') never finds it — and the hit was
        // simply dropped: no damage applied anywhere, nothing relayed over the
        // socket to that player's own client. Set up fresh on every plane deploy
        // since plane.bulletSystem/rocketSystem/bombSystem are rebuilt whenever
        // the Plane instance itself is (re)constructed.
        //
        // Direct-hit weapons (gun, rocket): single target, flat damage.
        // hitEnemyTank tells us whether the resolver already found (and damaged)
        // an AI unit — if so, skip the remote-player search entirely.
        const _relayPlaneDirectHit =
          (weaponDamageFallback) => (hitPos, hitEnemyTank, damage) => {
            const _pPos = plane.rigidBody
              ? plane.rigidBody.translation()
              : null;
            const dist =
              _pPos && hitPos
                ? Math.hypot(hitPos.x - _pPos.x, hitPos.z - _pPos.z)
                : 0;

            const _dmg = damage ?? weaponDamageFallback ?? 20;

            _checkAmmoPointHit(hitPos, _dmg);
            // ── Tracks whether we actually hit a target (AI unit or real player) —
            // stays false only for a plain terrain/scenery hit, which is the only
            // case that should skip the hit sound below.
            let _didHitSomething = false;
            // ── Hoisted so the final sound-selection check below can see it,
            // whether it was set by the direct hitEnemyTank branch or the
            // proximity-fallback branch further down.
            let bestProxy = null;

            if (hitEnemyTank) {
              // hitEnemyTank being truthy at all means SOMETHING was hit, whether
              // it's a host-side EnemyTank/EnemyPlane instance (no _aiKind field)
              // or a guest-side AI proxy (_aiKind set) or a real player's proxy —
              // so this must be set unconditionally here, before branching on
              // _aiKind below.
              _didHitSomething = true;

              if (hitEnemyTank._aiKind) {
                // ── Resolved directly to an AI unit proxy — see comment below for why
                // this only relays on guests, not the host.
                if (!isHost && matchSocket) {
                  matchSocket.emit("match:damage-ai", {
                    id: hitEnemyTank._id,
                    damage: _dmg,
                    shooterName: _localDisplayName,
                    shooterTeam: localTeam,
                    shooterUid: config.userId ?? "local",
                  });
                }
              } else if (hitEnemyTank.isRemotePlayer) {
                // ── Resolved directly to a real remote player's proxy (now
                // possible since guided rockets use _missileLockResolver, which
                // includes real players as candidates). No proximity guessing
                // needed — we already have the exact proxy via rigidBody match.
                // Relays regardless of isHost: whichever client fired this shot
                // needs to tell the ACTUAL owner of that vehicle they got hit,
                // since our own copy of them is just a passive proxy either way.
                const targetUserId = _remoteUserIdByProxy.get(hitEnemyTank);
                if (targetUserId && matchSocket) {
                  matchSocket.emit("match:hit-remote-player", {
                    targetUserId,
                    damage: _dmg,
                    attackerPos: _pPos,
                    shooterTeam: localTeam,
                    shooterName: _localDisplayName,
                    shooterUid: config.userId ?? "local",
                  });
                }
              }
              // else: a host-side, directly-simulated EnemyTank/EnemyPlane instance
              // (no _aiKind, not a RemotePlayerTank/Plane proxy) — damage was
              // already applied locally inside bullet.js's fire(), nothing further
              // to relay. _didHitSomething is already true, so the sound still plays.
            } else if (hitPos) {
              // ── Nothing resolved directly (e.g. the gun's plain _enemyResolver
              // doesn't include real players at all) — fall back to proximity
              // search, same as before.
              let bestDsq = 36; // 6m — matches tank.bulletSystem.onHit's proximity radius
              for (const [_rpUid, rp] of _remotePlayers.entries()) {
                if (!rp || !rp.active || rp.isDead || rp.team === localTeam)
                  continue;
                if (!_remoteDeployed.get(_rpUid)) continue;
                const rpp = rp.bodyGroup.position;
                const dx = rpp.x - hitPos.x,
                  dz = rpp.z - hitPos.z;
                const dsq = dx * dx + dz * dz;
                if (dsq < bestDsq) {
                  bestDsq = dsq;
                  bestProxy = rp;
                }
              }
              if (bestProxy) {
                _didHitSomething = true;
                const targetUserId = _remoteUserIdByProxy.get(bestProxy);
                if (targetUserId && matchSocket) {
                  matchSocket.emit("match:hit-remote-player", {
                    targetUserId,
                    damage: _dmg,
                    attackerPos: _pPos,
                    shooterTeam: localTeam,
                    shooterName: _localDisplayName,
                    shooterUid: config.userId ?? "local",
                  });
                }
              }
            }

            // ── Only play the hit sound when an actual target (AI unit, AI proxy,
            // or real player) was hit — a shot landing on bare terrain has neither
            // hitEnemyTank nor a resolved bestProxy, so _didHitSomething stays false.
            // ── No hit sound is played for the player's own plane weapons landing
            // a hit — intentionally silent here. Still show the hit marker when an
            // actual enemy unit (AI or real player) was hit — not for terrain.
            if (_didHitSomething) {
              showPlaneHitMarker();
            }
          };

        // ── Rocket-specific hit relay — identical damage/relay logic to
        // _relayPlaneDirectHit, but ALWAYS plays the explosion sound on any hit
        // (terrain included), unlike the gun's now-silent version. Rockets
        // should feel impactful even when they miss a target and just detonate
        // on the ground/a building.
        const _relayPlaneRocketHit =
          (weaponDamageFallback) => (hitPos, hitEnemyTank, damage) => {
            const _pPos = plane.rigidBody
              ? plane.rigidBody.translation()
              : null;
            const dist =
              _pPos && hitPos
                ? Math.hypot(hitPos.x - _pPos.x, hitPos.z - _pPos.z)
                : 0;

            const _dmg = damage ?? weaponDamageFallback ?? 20;

            _checkAmmoPointHit(hitPos, _dmg);
            // ── Tracks whether an actual enemy unit (AI or real player) was hit,
            // as opposed to the rocket just detonating on terrain/scenery — the
            // hit marker only flashes for the former.
            let _hitAnEnemy = false;

            if (hitEnemyTank) {
              _hitAnEnemy = true;
              if (hitEnemyTank._aiKind) {
                if (!isHost && matchSocket) {
                  matchSocket.emit("match:damage-ai", {
                    id: hitEnemyTank._id,
                    damage: _dmg,
                    shooterName: _localDisplayName,
                    shooterTeam: localTeam,
                    shooterUid: config.userId ?? "local",
                  });
                }
              } else if (hitEnemyTank.isRemotePlayer) {
                const targetUserId = _remoteUserIdByProxy.get(hitEnemyTank);
                if (targetUserId && matchSocket) {
                  matchSocket.emit("match:hit-remote-player", {
                    targetUserId,
                    damage: _dmg,
                    attackerPos: _pPos,
                    shooterTeam: localTeam,
                    shooterName: _localDisplayName,
                    shooterUid: config.userId ?? "local",
                  });
                }
              }
            } else if (hitPos) {
              let bestProxy = null,
                bestDsq = 36;
              for (const [_rpUid, rp] of _remotePlayers.entries()) {
                if (!rp || !rp.active || rp.isDead || rp.team === localTeam)
                  continue;
                if (!_remoteDeployed.get(_rpUid)) continue;
                const rpp = rp.bodyGroup.position;
                const dx = rpp.x - hitPos.x,
                  dz = rpp.z - hitPos.z;
                const dsq = dx * dx + dz * dz;
                if (dsq < bestDsq) {
                  bestDsq = dsq;
                  bestProxy = rp;
                }
              }
              if (bestProxy) {
                _hitAnEnemy = true;
                const targetUserId = _remoteUserIdByProxy.get(bestProxy);
                if (targetUserId && matchSocket) {
                  matchSocket.emit("match:hit-remote-player", {
                    targetUserId,
                    damage: _dmg,
                    attackerPos: _pPos,
                    shooterTeam: localTeam,
                    shooterName: _localDisplayName,
                    shooterUid: config.userId ?? "local",
                  });
                }
              }
            }

            // ── Always play the explosion sound on any rocket hit — target or
            // terrain — unlike the gun's relay which stays silent entirely.
            audio.playExplosion(dist);

            // ── Hit marker only flashes when an actual enemy unit was struck —
            // not for a rocket detonating on bare terrain/scenery.
            if (_hitAnEnemy) {
              showPlaneHitMarker();
            }
          };

        // ── AI turret guns — feed them the same enemy candidate list the
        // player's own weapons use, and relay their hits through the same
        // path (network relay for real opposing players, direct damage for
        // AI units).
        plane.setAiGunEnemyResolver(_enemyResolver);
        plane.onAiGunHit = _relayPlaneDirectHit(plane.cfg.aiGunDamage);
        // ── AI turret guns fire independently of the player's own weapons
        // (see Plane._updateAiGuns) — dedicated Shot_6.ogg, distinct from
        // the main gun's fireSound.
        plane.onAiGunFire = () => {
          audio.playAiGunShot();
        };

        if (plane.bulletSystem) {
          plane.bulletSystem.onHit = _relayPlaneDirectHit(plane.cfg.gunDamage);
        }
        if (plane.rocketSystem) {
          plane.rocketSystem.onHit = _relayPlaneRocketHit(
            plane.cfg.rocketDamage,
          );
        }
        if (plane.hispanoSystem) {
          plane.hispanoSystem.onHit = _relayPlaneDirectHit(plane.cfg.hispanoDamage);
        }

        // AoE weapon (bomb): onHit fires once per impact with hitEnemyTank always
        // null (bombs never resolve a single victim through onHit — see
        // bomb.js's _resolveBlast, which fires onHit BEFORE sweeping the AI
        // list). Falloff-scaled damage is applied to every real remote player
        // within blastRadius, mirroring the same falloff formula
        // BombSystem._resolveBlast already applies to AI tanks.
        if (plane.bombSystem) {
          // bomb.js's _resolveBlast calls onHit(position, null, this.damage)
          // — the third arg is the bomb's actual configured damage.
          plane.bombSystem.onHit = (hitPos, _unusedTarget, damage) => {
            const _pPos = plane.rigidBody
              ? plane.rigidBody.translation()
              : null;
            const dist =
              _pPos && hitPos
                ? Math.hypot(hitPos.x - _pPos.x, hitPos.z - _pPos.z)
                : 0;
            audio.playExplosion(dist);

            const _bombDmg = damage ?? plane.cfg.bombDamage ?? 140;
            _checkAmmoPointHit(hitPos, _bombDmg);
            _checkCapturePointBombReset(hitPos, localTeam, _bombDmg);

            if (!hitPos || !matchSocket || isHost) return; // host applies bomb damage locally already
            const blastRadius = plane.cfg.bombBlastRadius ?? 14;
            const baseDamage = plane.cfg.bombDamage ?? 140;

            for (const [_rpUid, rp] of _remotePlayers.entries()) {
              if (!rp || !rp.active || rp.isDead || rp.team === localTeam)
                continue;
              if (!_remoteDeployed.get(_rpUid)) continue;
              const rpp = rp.bodyGroup.position;
              const rDist = Math.hypot(
                rpp.x - hitPos.x,
                rpp.y - hitPos.y,
                rpp.z - hitPos.z,
              );
              if (rDist > blastRadius) continue;

              const falloff = 1 - rDist / blastRadius;
              const dmg = Math.round(baseDamage * Math.max(0.15, falloff));

              const targetUserId = _remoteUserIdByProxy.get(rp);
              if (targetUserId) {
                matchSocket.emit("match:hit-remote-player", {
                  targetUserId,
                  damage: dmg,
                  attackerPos: _pPos,
                  shooterTeam: localTeam,
                  shooterName: _localDisplayName,
                  shooterUid: config.userId ?? "local",
                });
              }
            }

            // ── Same blast sweep, but against AI unit proxies (_remoteAIUnits) —
            // without this, a guest's bombs never damage AI tanks/planes either.
            for (const au of _remoteAIUnits.values()) {
              if (!au || !au.active || au.isDead || au.team === localTeam)
                continue;
              const aup = au.bodyGroup.position;
              const aDist = Math.hypot(
                aup.x - hitPos.x,
                aup.y - hitPos.y,
                aup.z - hitPos.z,
              );
              if (aDist > blastRadius) continue;

              const falloff = 1 - aDist / blastRadius;
              const dmg = Math.round(baseDamage * Math.max(0.15, falloff));

              matchSocket.emit("match:damage-ai", {
                id: au._id,
                damage: dmg,
                shooterName: _localDisplayName,
                shooterTeam: localTeam,
                shooterUid: config.userId ?? "local",
              });
            }
          };
        }
      } else {
        plane.bodyGroup.visible = true;
        plane._inputLocked = false;
        scope.setScopePoint?.(null); // ← defensively drop any stale reference before the async reload starts
        scope.setBombPoint?.(null); // ← same for the bomb-sight's BombPoint reference
        plane.respawn(planeSpawnPos);

        // ← ADD THIS — respawn()'s GLB reload happens asynchronously
        // in the background, but the plane's TRANSFORM doesn't need to
        // wait for that. Force bodyGroup + rigidBody to the new spawn
        // point right now, synchronously, so the very next rendered
        // frame — and therefore the camera, which reads
        // plane.bodyGroup.position every frame — already sees the
        // correct spawn location instead of lingering at wherever the
        // plane last was (e.g. its crash site) for a few frames.
        plane.bodyGroup.position.set(
          planeSpawnPos.x,
          planeSpawnPos.y,
          planeSpawnPos.z,
        );
        if (plane.rigidBody) {
          plane.rigidBody.setTranslation(planeSpawnPos, true);
          plane.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
          plane.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }

        _resetPlaneLoadout(); // ← fresh ammo/kits every time the plane is (re)deployed
      }

      // ── Switch the shared audio system's fire sound to the plane's own,
      // so gunType-3 playShot() calls use the plane's fireSound instead of
      // whatever the tank was last configured with. Must run on EVERY
      // plane deploy (not just plane creation) — a tank deploy in between
      // re-points `audio` at the tank's fireSound via its own
      // audio.configure() call, so redeploying an already-existing plane
      // needs to reclaim it here too. ─────────────────────────────────────
      audio.configure(
        config.tankSound ?? "medium",
        _pc.fireSound ?? config.fireSound ?? 1,
      );
      audio.configurePlaneSound(_pc.planeSound ?? "light");
      audio.setActiveEngineSound("plane");

      _parkTank();
      activeVehicle = plane;
      _setFlightHudMode(true);
      _updatePlaneWeaponSlotVisibility(); // ← hide Rocket/Bomb slots if this plane has no mount points for them
      _selectPlaneWeaponSlot(1);
      _updatePlaneWeaponHud();
      enemyPool.setActivePlayerVehicle(plane);
      enemyPlanePool.setActivePlayerVehicle(plane);
      friendlyPlanePool.setActivePlayerVehicle(plane);

      // ── Scope: point it at the plane instead of the tank while flying.
      // Without this, isDead-gating still checks the (possibly dead or
      // parked) tank, and the scope camera has no ScopePoint to follow
      // at all — it just silently keeps whatever it had before. ─────────
      scope.tank = plane;
      scope.turretController = null; // plane has no turret — bearing/range/angle HUD stays hidden

      scope.vehicleType = "plane";
      scope.rearViewActive = false; // fresh life/redeploy starts facing forward
      scope.setScopeType(_pc.scopeType ?? 1); // plane's own scope texture, from its preset
      scope.setScopeHudStyle(_pc.scopeHudStyle ?? "old"); // this plane's crosshair vs. F16-style HUD

      // ── Non-scoped chase-cam FOV while flying (scope.planeNormalFOV) —
      // only applied here directly if not currently scoped; if scoped,
      // the scope.isScoped-guarded exitScope() call further below already
      // handles resetting camera.fov correctly via _getActiveNormalFOV()
      // (which now reads this.vehicleType, already set above).
      if (!scope.isScoped) {
        _deployCamTargetFov = scope.planeNormalFOV;
      }

      if (plane.scopePoint) {
        scope.setScopePoint(plane.scopePoint);
      } else {
        const _scopePlaneWatcher = setInterval(() => {
          if (plane.scopePoint) {
            scope.setScopePoint(plane.scopePoint);
            _updatePlaneWeaponSlotVisibility();
            clearInterval(_scopePlaneWatcher);
          }
        }, 100);
      }

      // ← add — same polling pattern for BombPoint, feeding the
      // downward bomb-sight scope view (middle-mouse-button toggle).
      if (plane.bombPoint) {
        scope.setBombPoint(plane.bombPoint);
      } else {
        const _scopeBombWatcher = setInterval(() => {
          if (plane.bombPoint) {
            scope.setBombPoint(plane.bombPoint);
            clearInterval(_scopeBombWatcher);
          }
        }, 100);
      }

      if (scope.isScoped) scope._exitScope(); // don't carry a tank-scope view into the cockpit

      // Reset chase-cam smoothing so the new life doesn't inherit the
      // previous life's crash-camera offset/position.
      _planeSmoothPos.set(0, 0, 0);
      _planeSmoothLook.set(0, 0, 0);

      playerHpBar.setMaxHealth(plane.maxHealth);
      playerHpBar.setHealth(plane.health);
    } else {
      _setBoundaryWallsEnabled(true); // ← NEW — tank collides with the map-edge walls again
      if (plane) _parkPlane();
      scope.setBombPoint?.(null); // ← tank has no bomb-sight; drop any leftover plane reference
      _unparkTank(pos);
      _startLocalTurretWatcher(); // ← NEW — re-resolve against the freshly rebuilt model
      _resetTankLoadout(); // ← fresh ammo/kits every time the tank is (re)deployed
      activeVehicle = tank;
      _setFlightHudMode(false);
      _selectWeaponSlot(1);
      enemyPool.setActivePlayerVehicle(tank);
      enemyPlanePool.setActivePlayerVehicle(tank);
      friendlyPlanePool.setActivePlayerVehicle(tank);

      // ── Restore the tank's own fire sound (in case it was swapped to
      // the plane's fireSound during a previous plane deploy this life) ──
      audio.configure(config.tankSound ?? "medium", config.fireSound ?? 1);

      audio.setActiveEngineSound("tank");

      // ── Scope: point it back at the tank. Without this, scope.tank/
      // scope.turretController are left pointing at the plane from a
      // previous deploy this life, so entering scope in the tank would
      // either do nothing or read stale state. ───────────────────────
      scope.tank = tank;
      scope.turretController = tank.turretController ?? null;

      scope.vehicleType = "tank";
      scope.rearViewActive = false;
      scope.setScopeType(config.scopeType ?? 1); // back to the tank's own scope texture
      scope.setScopeHudStyle(config.scopeHudStyle ?? "old"); // tanks always use the classic crosshair

      if (!scope.isScoped) {
        _deployCamTargetFov = scope.normalFOV;
      }

      if (tank.turretController?.scopePoint) {
        scope.setScopePoint(tank.turretController.scopePoint);
      } else {
        const _scopeTankWatcher = setInterval(() => {
          if (tank.turretController?.scopePoint) {
            scope.setScopePoint(tank.turretController.scopePoint);
            clearInterval(_scopeTankWatcher);
          }
        }, 100);
      }
      if (scope.isScoped) scope._exitScope(); // don't carry a plane-scope view into the tank

      playerHpBar.setMaxHealth(tank.maxHealth);
      playerHpBar.setHealth(tank.health);
    }

    // ── Deploy camera flythrough — now used for BOTH first deploy and
    // every subsequent respawn, and for BOTH vehicle types. Eases from
    // wherever the camera was left on the spawn-selection screen (captured
    // above) into the vehicle's normal follow-cam pose; audio.startEngine()
    // is triggered from inside loop() once each vehicle's intro branch
    // finishes (see the plane-alive and tank camera sections below).
    startDeployCamera();

    if (!gameStarted) {
      gameStarted = true;

      hudEl2.style.display = "block";
      stats.dom.style.display = "block";
      document.getElementById("compass-bar").style.display = "block";
      document.getElementById("minimap").style.display = "block";
      document.getElementById("hud-speed").style.display = "block";
      document.getElementById("weapon-hud").style.display = "flex";
      // document.getElementById('hud-kills').style.display    = 'block';
      scoreHud.style.display = "flex";
      cpMarkerContainer.style.display = "block";
      captureHud.style.display = "none";
      teammatesHud.style.display = "flex";
      _positionTeammatesHud();
    } else {
      deathScreen.style.display = "none";
      audio.reviveAudio();
      stats.dom.style.display = "flex";
      document.getElementById("weapon-hud").style.display = "flex";
      document.getElementById("minimap").style.display = "block";
      document.getElementById("hud-speed").style.display = "block";
      // document.getElementById('hud-kills').style.display    = 'block';
      document.getElementById("compass-bar").style.display = "block";
      document.getElementById("health").style.display = "block";
      cpMarkerContainer.style.display = "block";
      teammatesHud.style.display = "flex";
      _positionTeammatesHud();
    }

    _isCurrentlyDeployed = true; // now genuinely live — safe for the network payload to report deployed:true
    _deployInProgress = false;
    deploySpawnBtn.disabled = false;
    deploySpawnBtn.textContent = "Deploy";
    _unfreezePointerVisual(); // restore normal cursor + tracking now that the deploy has resolved

    // ── Lock the cursor to the canvas now that we're actually driving/
    // flying — this is what prevents the mouse from wandering off the
    // game window during gameplay. Browsers require this call to happen
    // inside a user gesture in SOME cases, but since this fires from the
    // Deploy button's click handler (a real user gesture), it's safe here.
    centerVirtualCursor();
    requestGameplayPointerLock();
  }

  setTimeout(() => {
    // Fade out the loading bar screen first
    loadingEl.style.transition = "opacity 0.4s";
    loadingEl.style.opacity = "0";
    setTimeout(() => {
      loadingEl.style.display = "none";
      // Show the start button over the frozen scene
      document.body.appendChild(startOverlay);
    }, 400);
  }, 200);

  // Start button click — enter spawn-selection screen instead of starting immediately.
  // Audio resumes here (music starts) since this is the first real user
  // gesture in the flow — before the spawn-selection screen even opens.
  startBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    audio._muted = false;
    audio._resume?.();
    enterSpawnSelection();
  });

  // ── Pause menu wiring ─────────────────────────────────────────────────────
  const pauseBtn = document.getElementById("pause-btn");
  const pauseOverlay = document.getElementById("pause-overlay");
  const pauseResumeBtn = document.getElementById("pause-resume-btn");
  const pauseEndBtn = document.getElementById("pause-end-btn");

  // ── Which vehicle is actually being driven right now determines whether
  // pause should be allowed — using tank.isDead unconditionally was wrong
  // once flying a plane, since tank.isDead can be stuck `true` from an
  // earlier tank death that was never reset via tank.respawn(). ──────────
  function _activeVehicleIsDead() {
    return vehicleType === "plane" && plane ? plane.isDead : tank.isDead;
  }

  function openPause() {
    if (!gameStarted || _activeVehicleIsDead() || gameOver) return;
    isPaused = true;
    audio.stopTurret();
    audio.stopAllEnemyEngines();
    audio._stopEngine?.(); // ← stop engine sound while paused
    if (vehicleType === "plane" && audio.isMGPlaying) audio.stopMG(); // ← also stop plane's gun loop
    if (audio.isWaterPlaying) audio.stopWater(); // ← stop water loop while paused (loop() stops calling updateWater(), so it would otherwise play forever)
    pauseOverlay.style.display = "flex";
    exitGameplayPointerLock(); // ← free the cursor so the player can click pause-menu buttons
    showCursor();
  }

  function closePause() {
    isPaused = false;
    clock.getDelta(); // discard the huge elapsed-during-pause delta
    accum = 0; // drop any leftover physics accumulator backlog
    audio.reviveAudio?.(); // ← restart engine sound (mirrors respawn behavior)
    pauseOverlay.style.display = "none";
    hideCursor();
    centerVirtualCursor(); // avoid inheriting wherever the free cursor was left
    requestGameplayPointerLock(); // ← re-lock now that we're back to driving/flying
  }
  // pauseBtn.addEventListener('click', () => {
  //   if (isPaused) closePause(); else openPause();
  // });
  pauseResumeBtn.addEventListener("click", closePause);

  pauseEndBtn.addEventListener("click", () => {
    closePause();
    // pauseBtn.style.display = 'none';
    returnToMenu();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && gameStarted && !_activeVehicleIsDead()) {
      isPaused ? closePause() : openPause();
    }
  });
}
