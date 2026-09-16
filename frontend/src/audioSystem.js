// audioSystem.js — Centralized audio manager for tank game
//
// Sounds expected in /public/sounds/:
//   Engine:     Light_Tank.ogg, Medium_Tank.ogg, Heavy_Tank.ogg, Modern_Tank.ogg
//   Shot:       Shot_1.ogg, Shot_2.ogg
//   Impact:     Impact_1.ogg, Impact_2.ogg
//   Explosion:  Explosion_1.ogg, Explosion_2.ogg
//   Death:      Death_1.ogg
//   Music:      Distant_War.ogg

const SOUNDS_PATH = '/sounds/';

// Master volume levels — tune these to balance the mix
const VOL = {
  engine:      0.8,
  planeEngine: 0.8,   // ← ADD THIS — separate volume for AI plane engines (independent of tank VOL.engine)
  flyby:       0.5,   // ← ADD — one-shot close pass "whoosh"
  afterpass:   0.5,   // ← ADD — one-shot receding tail after a flyby
  shot:        0.70,
  rocket:      0.75,
  impact:      0.55,
  explosion:   1.0,
  death:       0.75,
  music:       1.00,
  mg:          0.3,
  smoke:       0.6,
  reload:      0.3,
  water:       0.5,
  turret:      0.2,
  artillery:   0.4,
  repair:      1.0,
};

// Engine pitch range mapped to tank speed (0–1 normalised throttle)
const ENGINE_PITCH_IDLE = 0.55;
const ENGINE_PITCH_MAX  = 1.30;

// How low the engine pitch is allowed to sag while a destroyed unit is
// falling/burning — pitch spools down toward this floor as the engine
// fades out, instead of freezing at whatever pitch it had the instant
// it died.
const ENGINE_DYING_PITCH_MIN = 0.32;

// Volume multiplier applied while a plane is falling/dying — boosts it
// above the normal cruising volume so the low, dying-engine drone stays
// clearly audible over the fall instead of getting quiet and easy to miss.
export const ENGINE_DYING_VOLUME_BOOST = 1.7;

// How fast pitch lerps toward target (higher = snappier)
const PITCH_LERP = 3.0;

// Fire-sound hearing range — gunfire carries further than engine noise
const SHOT_HEARING_NEAR = 20;   // metres — full volume within this range
const SHOT_HEARING_FAR  = 250;  // metres — inaudible beyond this range

// Explosion hearing range — explosions carry further than gunfire
const EXPLOSION_HEARING_NEAR = 25;   // metres — full volume within this range
const EXPLOSION_HEARING_FAR  = 300;  // metres — inaudible beyond this range

// ── ADD THIS ────────────────────────────────────────────────────────────
// Enemy engine hearing range — ground vehicles use the tight default
// (matches updateEnemyEngine's old hardcoded 30/120), but aircraft spawn
// and fight at 140–280m, well beyond that range. Reusing 30/120 for planes
// meant _distanceAttenuation() always returned 0 — the loop was created
// and running, just permanently silent.
const ENGINE_HEARING_NEAR       = 30;
const ENGINE_HEARING_FAR        = 120;
const PLANE_ENGINE_HEARING_NEAR = 40;
const PLANE_ENGINE_HEARING_FAR  = 320;

// ── ADD THIS ────────────────────────────────────────────────────────────
// Per-type tank engine sound files — mirrors the map used by configure()
// for the player's own tank, so each AI tank can use its own tankDef-
// defined engine sound instead of inheriting whatever engine sound the
// local player's tank currently happens to be using.
const TANK_ENGINE_FILES = {
  light:  'Light_Tank.ogg',
  medium: 'Medium_Tank.ogg',
  heavy:  'Heavy_Tank.ogg',
  modern: 'Modern_Tank.ogg',
};
// ── END ADD ──────────────────────────────────────────────────────────────


export class AudioSystem {
  constructor() {
    this._ctx        = null;   // AudioContext — created on first user gesture
    this._masterGain = null;
    this._musicGain  = null;
    this._sfxGain    = null;

    // Buffers cache — key → AudioBuffer
    this._buffers = new Map();

    // Engine loop nodes
    this._engineSource = null;
    this._engineGain   = null;
    this._enginePitch  = ENGINE_PITCH_IDLE;   // current (smoothed)
    this._engineTarget = ENGINE_PITCH_IDLE;   // target

    // Which sound files to use (set by configure() / configurePlaneSound())
    this._tankEngineFile  = 'Light_Tank.ogg';    // tank engine sound
    this._planeEngineFile = 'Light_Plane.ogg';   // plane engine sound
    this._engineFile      = this._tankEngineFile; // ← currently active engine buffer
    this._shotFile        = 'Shot_1.ogg';

    this._ready      = false;   // true once AudioContext is running
    this._muted      = false;

    // ← ADD — while true, updateEnemyEngine() fades any already-running AI
    // engine loop to silence and skips creating new ones entirely (used to
    // mute AI engine noise while the player is on the spawn-selection
    // screen — AI is still simulating/patrolling, just silently, from the
    // player's point of view).
    this._enemyEngineSuppressed = false;

    // ← ADD — while true, all gunfire SFX (player shot/rocket/MG-start and
    // AI shot) are skipped entirely. Same purpose as
    // _enemyEngineSuppressed above, just covering weapon fire instead of
    // engine loops — AI keeps shooting/simulating underneath, it's purely
    // an audio mute for the spawn-selection screen.
    this._fireSfxSuppressed = false;

    // Resume is now triggered explicitly from the Deploy button click in
    // main.js — not from any stray click/keydown — so music/engine start
    // at a predictable moment instead of whichever gesture happens first.
    this._resumeHandler = () => this._resume();
  }

  // ── Configuration ─────────────────────────────────────────────────────────

  /**
   * Call once after reading tanks.json.
   * @param {string} tankSound  — 'light' | 'medium' | 'heavy' | 'modern'
   * @param {number} fireSound  — 1 | 2
   */
  configure(tankSound = 'light', fireSound = 1) {
    const map = {
      light:  'Light_Tank.ogg',
      medium: 'Medium_Tank.ogg',
      heavy:  'Heavy_Tank.ogg',
      modern: 'Modern_Tank.ogg',
    };
    this._tankEngineFile = map[tankSound] ?? 'Light_Tank.ogg';
    this._engineFile     = this._tankEngineFile;   // ← default; overridden by setActiveEngineSound('plane') when flying
    this._shotFile       = `Shot_${fireSound}.ogg`;
  }

  /**
   * Call once the plane preset is resolved (mirrors configure() for tanks).
   * @param {string} planeSound — 'light' | 'heavy' | 'modern_light' | 'modern_heavy'
   */
  configurePlaneSound(planeSound = 'light') {
    const map = {
      light:        'Light_Plane.ogg',
      heavy:        'Heavy_Plane.ogg',
      modern_light: 'Modern_Light_Plane.ogg',
      modern_heavy: 'Modern_Heavy_Plane.ogg',
    };
    this._planeEngineFile = map[planeSound] ?? 'Light_Plane.ogg';
  }
  // ── Init / resume ─────────────────────────────────────────────────────────

  async _resume() {
  if (this._ready || this._resuming) return;
  this._resuming = true;

  this._ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Master → sfx/music gain tree
    this._masterGain = this._ctx.createGain();
    this._masterGain.gain.value = 1.0;
    this._masterGain.connect(this._ctx.destination);

    this._sfxGain = this._ctx.createGain();
    this._sfxGain.gain.value = 1.0;
    this._sfxGain.connect(this._masterGain);

    this._musicGain = this._ctx.createGain();
    this._musicGain.gain.value = VOL.music;
    this._musicGain.connect(this._masterGain);

    if (this._ctx.state === 'suspended') await this._ctx.resume();

    // Pre-load all sounds in parallel
    await this._preload([
      this._engineFile,
      'Light_Tank.ogg',        // ← ADD — every possible AI tank engine sound,
      'Medium_Tank.ogg',       //   not just whichever one the player picked
      'Heavy_Tank.ogg',
      'Modern_Tank.ogg',
      'Light_Plane.ogg',
      'Heavy_Plane.ogg',
      'Modern_Light_Plane.ogg',
      'Modern_Heavy_Plane.ogg',
      'ai_plane_engine.ogg',   // ← enemy/friendly AI plane engine loop
      'flyby.ogg',             // ← ADD — close-pass one-shot
      'afterpass.ogg',         // ← ADD — receding tail one-shot
      this._shotFile,
      'Shot_1.ogg',   // always preload both — enemies use Shot_1 regardless
      'Shot_2.ogg',
      'Shot_3.ogg',
      'Shot_4.ogg',
      'Shot_5.ogg',
      'Shot_6.ogg',   // ← AI turret gun fire sound (plane.js's AI_Gun_N turrets)
      'Shot_7.ogg',   // ← Hispano cannon fire sound
      'rocket.ogg',
      'flare.ogg',
      'alert.ogg',
      'Impact_1.ogg',
      'Impact_2.ogg',
      'Plane_Impact_1.ogg',
      'Plane_Impact_2.ogg',
      'Plane_Impact_3.ogg',
      'Explosion_1.ogg',
      'Explosion_2.ogg',
      'plane_explosion.ogg',
      'Death_1.ogg',
      'Distant_War.ogg',
      'mg_loop.ogg',
      'mg_end.ogg',
      'mg_reload.ogg',
      'Smoke.ogg',
      'Reload_1.ogg',
      'Reload_2.ogg',
      'Reload_3.ogg',
      'tree_fall.ogg',
      'running_water.ogg',
      'Turret.ogg',
      'repair.ogg',
      'incoming_artillery_1.ogg',
      'incoming_artillery_2.ogg',
      'incoming_artillery_3.ogg'
    ]);

    this._ready = true;

    // Only music auto-starts here. Engine sound is started explicitly via
    // startEngine() once real gameplay begins (after the intro flythrough
    // on first deploy), so it doesn't overlap the cinematic deploy moment.
    this._startMusic();
  }

  async _preload(files) {
    await Promise.all(files.map(f => this._loadBuffer(f)));
  }

  async _loadBuffer(filename) {
    if (this._buffers.has(filename)) return this._buffers.get(filename);
    try {
      const res  = await fetch(SOUNDS_PATH + filename);
      const data = await res.arrayBuffer();
      const buf  = await this._ctx.decodeAudioData(data);
      this._buffers.set(filename, buf);
      return buf;
    } catch (e) {
      console.warn(`[AudioSystem] Failed to load ${filename}:`, e);
      return null;
    }
  }

  // ── Playback helpers ──────────────────────────────────────────────────────

  /**
   * Play a one-shot sound effect.
   * @param {string}  filename
   * @param {number}  volume   0–1
   * @param {number}  pitch    playback rate multiplier
   * @param {number}  pitchVariance  ± random pitch variance
   */
  _playOnce(filename, volume = 1, pitch = 1, pitchVariance = 0, delaySeconds = 0) {
    if (!this._ready) return;
    const buf = this._buffers.get(filename);
    if (!buf) return;

    const src  = this._ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch + (Math.random() - 0.5) * pitchVariance;

    const gain = this._ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(this._sfxGain);

    src.start(this._ctx.currentTime + delaySeconds);
  }

    // ── ADD THIS WHOLE METHOD ─────────────────────────────────────────────
  /**
   * Same as _playOnce but routes through a StereoPannerNode so a sound
   * can be placed left/right relative to the listener — used for plane
   * flybys, where the direction of the pan sweep is a big part of what
   * sells "something just flew past me".
   * @param {number} pan  -1 (full left) .. 1 (full right)
   */
  _playOnceSpatial(filename, volume = 1, pitch = 1, pitchVariance = 0, pan = 0) {
    if (!this._ready) return;
    const buf = this._buffers.get(filename);
    if (!buf) return;

    const src  = this._ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch + (Math.random() - 0.5) * pitchVariance;

    const gain = this._ctx.createGain();
    gain.gain.value = volume;

    const panner = this._ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));

    src.connect(gain);
    gain.connect(panner);
    panner.connect(this._sfxGain);

    src.start();
  }
  // ── END ADD ──────────────────────────────────────────────────────────

  // ── Engine loop ───────────────────────────────────────────────────────────

  _startEngine() {
    if (!this._ready || this._dead) return;
    const buf = this._buffers.get(this._engineFile);
    if (!buf) return;

    this._engineGain = this._ctx.createGain();
    this._engineGain.gain.value = VOL.engine;
    this._engineGain.connect(this._sfxGain);

    this._engineSource = this._ctx.createBufferSource();
    this._engineSource.buffer = buf;
    this._engineSource.loop   = true;
    this._engineSource.playbackRate.value = ENGINE_PITCH_IDLE;
    this._engineSource.connect(this._engineGain);
    this._engineSource.start();
  }

  /** Public entry point — call once real gameplay should start making
   * engine noise (e.g. after the intro flythrough finishes on first
   * deploy). Safe to call repeatedly; no-ops if already playing or the
   * context isn't ready yet. */
  startEngine() {
    if (this._engineSource) return;
    this._startEngine();
  }

  /**
   * Switches which engine buffer is currently playing — call whenever the
   * player switches between tank and plane. If the loop is already
   * running it's restarted on the new buffer (preserving current pitch,
   * so the switch doesn't audibly snap to idle); if not running yet, this
   * just changes which file the next startEngine()/reviveAudio() uses.
   * @param {string} vehicleType — 'tank' | 'plane'
   */
  setActiveEngineSound(vehicleType) {
    const nextFile = vehicleType === 'plane' ? this._planeEngineFile : this._tankEngineFile;
    if (nextFile === this._engineFile) return;   // already correct
    this._engineFile = nextFile;
    if (this._engineSource) {
      const pitch = this._enginePitch;
      this._stopEngine();
      this._startEngine();
      if (this._engineSource) {
        this._engineSource.playbackRate.value = pitch;
        this._enginePitch  = pitch;
        this._engineTarget = pitch;
      }
    }
  }

  _stopEngine() {
    if (this._engineSource) {
      try { this._engineSource.stop(); } catch (_) {}
      this._engineSource.disconnect();
      this._engineSource = null;
    }
    if (this._engineGain) {
      this._engineGain.gain.setTargetAtTime(0, this._ctx?.currentTime ?? 0, 0.1);
      this._engineGain.disconnect();
      this._engineGain = null;
    }
  }

  // ── Background music ──────────────────────────────────────────────────────

  _startMusic() {
    if (!this._ready) return;
    const buf = this._buffers.get('Distant_War.ogg');
    if (!buf) return;

    const src  = this._ctx.createBufferSource();
    src.buffer = buf;
    src.loop   = true;
    src.connect(this._musicGain);
    src.start();
    this._musicSource = src;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Call every frame from the game loop.
   * @param {number} dt            delta time in seconds
   * @param {number} throttle      normalised 0–1 (avg of left+right throttle)
   * @param {boolean} isMoving     whether tank is actually moving
   */
  update(dt, throttle = 0, isMoving = false, dyingPitchFactor = 1, volumeBoost = 1) {
    if (!this._ready || !this._engineSource || this._dead) return;

    // Target pitch based on throttle + idle floor
    const t = Math.abs(throttle);
    const liveTargetPitch = ENGINE_PITCH_IDLE + (ENGINE_PITCH_MAX - ENGINE_PITCH_IDLE) * Math.min(t, 1);

    // ── dyingPitchFactor: 1 = normal (unchanged behavior), 0 = fully
    // sagged to ENGINE_DYING_PITCH_MIN — same convention as
    // updateEnemyEngine()'s AI-plane dying sag, applied here so the
    // PLAYER's own plane engine can sag toward a low dying drone too
    // while it falls after being destroyed.
    const clampedPitchFactor = Math.max(0, Math.min(1, dyingPitchFactor));
    this._engineTarget = ENGINE_DYING_PITCH_MIN + (liveTargetPitch - ENGINE_DYING_PITCH_MIN) * clampedPitchFactor;

    // Smooth toward target
    this._enginePitch = this._enginePitch + (this._engineTarget - this._enginePitch) * Math.min(1, dt * PITCH_LERP);
    this._engineSource.playbackRate.value = this._enginePitch;

    // Slight volume swell when moving, boosted while dying so the low
    // drone stays clearly audible over the fall instead of fading out.
    if (this._engineGain) {
      const targetVol = (isMoving ? VOL.engine * 1.15 : VOL.engine) * volumeBoost;
      this._engineGain.gain.value += (targetVol - this._engineGain.gain.value) * Math.min(1, dt * 3);
    }
  }

  /** Called when player fires */
  /** Called when player fires */
  playShot() {
    if (this._fireSfxSuppressed) return;
    this._playOnce(this._shotFile, VOL.shot, 1.0, 0.08);
  }

  /** Called when the plane fires an unguided rocket */
  playRocket() {
    if (this._fireSfxSuppressed) return;
    this._playOnce('rocket.ogg', VOL.rocket, 1.0, 0.06);
  }

  /** Called when the plane deploys flares (countermeasures) */
  playFlare() {
    if (this._fireSfxSuppressed) return;
    this._playOnce('flare.ogg', VOL.rocket, 1.0, 0.05);
  }

  /** Called the instant an enemy missile lock is acquired on the player's plane */
  playMissileLockAlert() {
    if (this._fireSfxSuppressed) return;
    this._playOnce('alert.ogg', VOL.rocket, 1.0, 0.0);
  }

  /** Called when any enemy fires */
  playEnemyShot(fireSound = null, distance = 0) {
    if (!this._ready || this._fireSfxSuppressed) return;

    // ── Distance culling — this is the actual optimization: bail out
    // before creating a BufferSource + GainNode for a shot that's too far
    // away to hear at all (Web Audio node creation is the expensive part,
    // not the volume math). ────────────────────────────────────────────
    const atten = this._distanceAttenuation(distance, SHOT_HEARING_NEAR, SHOT_HEARING_FAR);
    if (atten <= 0.01) return;

    let file;
    if (fireSound) {
      file = `Shot_${fireSound}.ogg`;
      if (!this._buffers.has(file)) file = 'Shot_1.ogg';
    } else {
      file = this._buffers.has(this._shotFile) ? this._shotFile : 'Shot_1.ogg';
    }
    this._playOnce(file, VOL.shot * 0.6 * atten, 0.82, 0.10);
  }

  /** Called when a plane's AI turret gun (AI_Gun_N) fires — always
   * Shot_6.ogg, regardless of the plane's own main-gun fireSound.
   * @param {number} distance  metres from the player (listener); omit/0
   *   for the player's own plane's turret guns (always full volume). */
  playAiGunShot(distance = 0) {
    if (!this._ready || this._fireSfxSuppressed) return;

    const atten = this._distanceAttenuation(distance, SHOT_HEARING_NEAR, SHOT_HEARING_FAR);
    if (atten <= 0.01) return;

    const file = this._buffers.has('Shot_6.ogg') ? 'Shot_6.ogg' : 'Shot_1.ogg';
    this._playOnce(file, VOL.shot * 0.6 * atten, 0.82, 0.10);
  }
    /** Called when the plane's Hispano cannon (slot 6) fires — always
   * Shot_7.ogg, regardless of the plane's own main-gun fireSound. */
  playHispanoShot() {
    if (this._fireSfxSuppressed) return;
    this._playOnce('Shot_7.ogg', VOL.shot, 1.0, 0.08);
  }

  /**
   * Distance-based volume falloff for enemy engines.
   * Full volume within ENGINE_HEARING_NEAR, linearly fades to 0 at ENGINE_HEARING_FAR.
   */
  _distanceAttenuation(distance, near = 30, far = 120) {
    if (distance <= near) return 1;
    if (distance >= far)  return 0;
    return 1 - (distance - near) / (far - near);
  }

  /**
   * Per-enemy engine update — each enemy gets its own looping source
   * keyed by a unique id string.
   */
  updateEnemyEngine(id, dt, throttle = 0, isMoving = false, distance = 0, isPlane = false, dyingPitchFactor = 1, volumeBoost = 1, tankSound = 'light', planeSound = 'light') {
    if (!this._ready || this._dead) return;

    // Create engine node for this enemy if it doesn't exist yet
    if (!this._enemyEngines) this._enemyEngines = new Map();

    // ── Suppressed (spawn-selection screen) — never create a fresh node,
    // and fade any existing one toward silence instead of updating its
    // pitch/volume normally. AI keeps moving/patrolling underneath this;
    // only its engine audio is muted.
    if (this._enemyEngineSuppressed) {
      const existing = this._enemyEngines.get(id);
      if (existing) {
        existing.gainNode.gain.value += (0 - existing.gainNode.gain.value) * Math.min(1, dt * 4);
      }
      return;
    }

    if (!this._enemyEngines.has(id)) {
      // ← FIX: use THIS unit's own tankSound (from its tankDef), not the
      // local player's currently-selected engine file. Previously every
      // AI tank shared this._tankEngineFile (the player's own sound)
      // regardless of what tank type it actually was.
      const engineFile = isPlane
        ? 'ai_plane_engine.ogg'
        : (TANK_ENGINE_FILES[tankSound] ?? this._tankEngineFile);
      const buf = this._buffers.get(engineFile);
      if (!buf) return;

      const gainNode = this._ctx.createGain();
      gainNode.gain.value = (isPlane ? VOL.planeEngine : VOL.engine) * 0.4;   // enemies quieter than player
      gainNode.connect(this._sfxGain);

      const src = this._ctx.createBufferSource();
      src.buffer = buf;
      src.loop   = true;
      src.playbackRate.value = ENGINE_PITCH_IDLE;
      src.connect(gainNode);
      src.start();

      this._enemyEngines.set(id, { src, gainNode, pitch: ENGINE_PITCH_IDLE, isPlane });
    }

    const node = this._enemyEngines.get(id);

    // ── dyingPitchFactor: 1 = normal live pitch (default, unchanged
    // behavior for a healthy unit), 0 = fully sagged to ENGINE_DYING_PITCH_MIN.
    // A dying plane passes 0 so the pitch smoothly (via PITCH_LERP) drops
    // to a low drone right away and STAYS there for the whole fall.
    const clampedPitchFactor = Math.max(0, Math.min(1, dyingPitchFactor));
    const liveTargetPitch = ENGINE_PITCH_IDLE + (ENGINE_PITCH_MAX - ENGINE_PITCH_IDLE) * Math.min(Math.abs(throttle), 1);
    const targetPitch = ENGINE_DYING_PITCH_MIN + (liveTargetPitch - ENGINE_DYING_PITCH_MIN) * clampedPitchFactor;
    node.pitch += (targetPitch - node.pitch) * Math.min(1, dt * PITCH_LERP);
    node.src.playbackRate.value = node.pitch;

    const baseVolSource = node.isPlane ? VOL.planeEngine : VOL.engine;
    const baseVol = isMoving ? baseVolSource * 0.45 : baseVolSource * 0.35;

    const near = node.isPlane ? PLANE_ENGINE_HEARING_NEAR : ENGINE_HEARING_NEAR;
    const far  = node.isPlane ? PLANE_ENGINE_HEARING_FAR  : ENGINE_HEARING_FAR;
    const attenuation = this._distanceAttenuation(distance, near, far);

    // ── volumeBoost: 1 = normal (default, unchanged for a healthy unit).
    // A dying plane passes ENGINE_DYING_VOLUME_BOOST to stay clearly
    // audible — no gradual fade-to-silence anymore; the loop is stopped
    // outright (cleanly, via stopEnemyEngine's own short fade) the instant
    // the plane hits the ground, see enemyPlane.js.
    const targetVol = baseVol * attenuation * volumeBoost;
    node.gainNode.gain.value += (targetVol - node.gainNode.gain.value) * Math.min(1, dt * 3);
  }

  /** Stop and remove an enemy engine loop — fades briefly instead of an
   * instant stop, as a safety net for any deactivation path that skips
   * the dissolve fade-out above, so the loop never cuts off with an
   * audible click/pop. */
  stopEnemyEngine(id) {
    if (!this._enemyEngines?.has(id)) return;
    const node = this._enemyEngines.get(id);
    this._enemyEngines.delete(id);   // free the slot immediately — a fresh call for the same id starts clean

    if (this._ctx) {
      node.gainNode.gain.setTargetAtTime(0, this._ctx.currentTime, 0.12);
    }
    setTimeout(() => {
      try { node.src.stop(); } catch (_) {}
      node.src.disconnect();
      node.gainNode.disconnect();
    }, 220);
  }

    /** Stop ALL active enemy engine loops — call on pause */
  stopAllEnemyEngines() {
    if (!this._enemyEngines) return;
    for (const id of [...this._enemyEngines.keys()]) {
      this.stopEnemyEngine(id);
    }
  }

  /** Called on bullet impact (non-explosive) */
  playImpact() {
    const file = Math.random() < 0.5 ? 'Impact_1.ogg' : 'Impact_2.ogg';
    this._playOnce(file, VOL.impact, 1.0, 0.12);
  }

  // ← ADD THIS NEW METHOD
  /** Called on bullet/rocket impact against a PLANE (player or AI) —
   * picks randomly from 3 variants instead of the generic tank impact sound. */
  playPlaneImpact() {
    const files = ['Plane_Impact_1.ogg', 'Plane_Impact_2.ogg', 'Plane_Impact_3.ogg'];
    const file  = files[Math.floor(Math.random() * files.length)];
    this._playOnce(file, VOL.impact, 1.0, 0.12);
  }

  /**
   * Called when an explosion spawns.
   * @param {number} distance  metres from the player (listener). Omit/0
   *   for explosions that happen at the player's own location (e.g. the
   *   player dying or getting hit directly) — those stay full volume.
   */
  playExplosion(distance = 0) {
    if (this._fireSfxSuppressed) return;
    const atten = this._distanceAttenuation(distance, EXPLOSION_HEARING_NEAR, EXPLOSION_HEARING_FAR);
    if (atten <= 0.01) return;   // too far to hear — skip node creation entirely
    const file = Math.random() < 0.5 ? 'Explosion_1.ogg' : 'Explosion_2.ogg';
    this._playOnce(file, VOL.explosion * atten, 1.0, 0.06, 0.18);
  }

  // ← ADD THIS NEW METHOD
  /**
   * Called when a PLANE (player or AI) is destroyed — dedicated explosion
   * sound, distinct from the generic tank/vehicle explosion.
   * @param {number} distance  metres from the player (listener). Omit/0
   *   for explosions at the player's own location.
   */
  playPlaneExplosion(distance = 0) {
    if (this._fireSfxSuppressed) return;
    const atten = this._distanceAttenuation(distance, EXPLOSION_HEARING_NEAR, EXPLOSION_HEARING_FAR);
    if (atten <= 0.01) return;
    this._playOnce('plane_explosion.ogg', VOL.explosion * atten, 1.0, 0.06, 0.18);
  }

    // ── ADD THIS WHOLE BLOCK ───────────────────────────────────────────────
  /**
   * Called the instant a plane crosses close enough to the player to
   * count as a "flyby" — a loud, panned one-shot layered on top of the
   * plane's ambient engine loop. Slight pitch-up sells an approaching
   * aircraft (mini doppler effect).
   * @param {number} pan    -1 (full left) .. 1 (full right)
   * @param {number} pitch  playback rate multiplier
   */
  playPlaneFlyby(pan = 0, pitch = 1.05) {
    if (this._enemyEngineSuppressed) return;
    this._playOnceSpatial('flyby.ogg', VOL.flyby, pitch, 0.03, pan);
  }

  /**
   * Called once a plane that already triggered playPlaneFlyby() has
   * pulled far enough away again — the receding tail. Slight pitch-down
   * sells it moving away.
   * @param {number} pan    -1 (full left) .. 1 (full right)
   * @param {number} pitch  playback rate multiplier
   */
  playPlaneAfterpass(pan = 0, pitch = 0.88) {
    if (this._enemyEngineSuppressed) return;
    this._playOnceSpatial('afterpass.ogg', VOL.afterpass, pitch, 0.03, pan);
  }
  // ── END ADD ──────────────────────────────────────────────────────────

  /** Called when an artillery barrage is called in — plays a random
   * "incoming" warning sound, once per barrage (not per shell). */
  playIncomingArtillery() {
    if (this._fireSfxSuppressed) return;
    const n    = 1 + Math.floor(Math.random() * 3); // 1, 2, or 3
    const file = `incoming_artillery_${n}.ogg`;
    this._playOnce(file, VOL.artillery, 1.0, 0.04);
  }

  /** Called when a smoke grenade is fired */
  playSmoke() {
    this._playOnce('Smoke.ogg', VOL.smoke, 1.0, 0.05);
  }
  /** Called when main gun starts reloading */
  playReload() {
    this._reloadToggle = !this._reloadToggle;
    const file = this._reloadToggle ? 'Reload_1.ogg' : 'Reload_2.ogg';
    this._playOnce(file, VOL.reload, 1.0, 0.04);
  }

  /** Called when the MG starts reloading (manual "R" or auto-reload) */
  playMGReload() {
    this._playOnce('mg_reload.ogg', VOL.reload, 1.0, 0.04);
  }

  /** Called when the multi-gun (gunType 3) starts its full reload — either
   *  the automatic reload after the magazine empties, or a manual "R" press */
  playMultiGunReload() {
    this._playOnce('Reload_3.ogg', VOL.reload, 1.0, 0.04);
  }

  /** Called when a tree starts falling */
playTreeFall() {
  this._playOnce('tree_fall.ogg', 0.7, 1.0, 0.12);
}
/** Start water movement loop — call when tank enters water */
startWater() {
  if (!this._ready || this._waterSource) return;
  const buf = this._buffers.get('running_water.ogg');
  if (!buf) return;

  this._waterGain = this._ctx.createGain();
  this._waterGain.gain.value = 0;
  this._waterGain.connect(this._sfxGain);

  this._waterSource = this._ctx.createBufferSource();
  this._waterSource.buffer = buf;
  this._waterSource.loop   = true;
  this._waterSource.connect(this._waterGain);
  this._waterSource.start();
}

/** Stop water movement loop — call when tank leaves water or stops */
/** Fade out and stop water movement loop — call when tank leaves water entirely */
stopWater() {
  if (!this._waterSource) return;

  const src  = this._waterSource;
  const gain = this._waterGain;
  this._waterSource = null;
  this._waterGain   = null;

  if (gain) {
    gain.gain.setTargetAtTime(0, this._ctx.currentTime, 0.4);
  }
  setTimeout(() => {
    try { src.stop(); } catch (_) {}
    src.disconnect();
    gain?.disconnect();
  }, 900);
}

/** Fade water volume in/out based on speed — call every frame */
updateWater(isInWater, speed) {
  if (!this._ready || !this._waterGain) return;

  if (!this._waterSource) {
    // Loop was stopped — restart it if we need sound again
    if (isInWater && speed > 0.5) this.startWater();
    return;
  }

  const targetVol = (isInWater && speed > 0.5) ? VOL.water : 0;
  this._waterGain.gain.setTargetAtTime(targetVol, this._ctx.currentTime, 0.3);
}

get isWaterPlaying() {
  return !!this._waterSource;
}

  /** Start the MG loop — call when mouse is held and weapon = 2 */
startMG() {
  if (!this._ready || this._mgSource || this._fireSfxSuppressed) return;
  const buf = this._buffers.get('mg_loop.ogg');
  if (!buf) return;

  this._mgGain = this._ctx.createGain();
  this._mgGain.gain.value = VOL.mg;
  this._mgGain.connect(this._sfxGain);

  this._mgSource = this._ctx.createBufferSource();
  this._mgSource.buffer = buf;
  this._mgSource.loop   = true;
  this._mgSource.connect(this._mgGain);
  this._mgSource.start();
}

/** Stop the MG loop and play the tail-off sound */
stopMG() {
  if (!this._mgSource) return;

  try { this._mgSource.stop(); } catch (_) {}
  this._mgSource.disconnect();
  this._mgSource = null;

  if (this._mgGain) {
    this._mgGain.disconnect();
    this._mgGain = null;
  }

  // Play the wind-down tail
  this._playOnce('mg_end.ogg', VOL.mg, 1.0, 0.0);
}

/** Returns true if MG loop is currently playing */
get isMGPlaying() {
  return !!this._mgSource;
}
/** Start turret rotation loop — call when turret is actively rotating */
startTurret() {
  if (!this._ready || this._turretSource) return;
  const buf = this._buffers.get('Turret.ogg');
  if (!buf) return;

  this._turretGain = this._ctx.createGain();
  this._turretGain.gain.value = 0;
  this._turretGain.connect(this._sfxGain);

  this._turretSource = this._ctx.createBufferSource();
  this._turretSource.buffer = buf;
  this._turretSource.loop   = true;
  this._turretSource.connect(this._turretGain);
  this._turretSource.start();
}

/** Fade out and stop turret rotation loop */
stopTurret() {
  if (!this._turretSource) return;
  if (this._turretGain) {
    this._turretGain.gain.setTargetAtTime(0, this._ctx.currentTime, 0.15);
  }
  const src  = this._turretSource;
  const gain = this._turretGain;
  this._turretSource = null;
  this._turretGain   = null;
  setTimeout(() => {
    try { src.stop(); }  catch (_) {}
    src.disconnect();
    gain?.disconnect();
  }, 600);
}

/** Fade turret volume in/out smoothly each frame */
updateTurret(isRotating, dt) {
  if (!this._ready) return;
  if (isRotating && !this._turretSource) this.startTurret();
  if (!this._turretGain) return;
  const targetVol = isRotating ? VOL.turret : 0;
  this._turretGain.gain.setTargetAtTime(targetVol, this._ctx.currentTime, 0.08);
  if (!isRotating && this._turretSource) {
    // tear down after fade
    this._turretFadeTimer = (this._turretFadeTimer ?? 0) + dt;
    if (this._turretFadeTimer > 0.5) {
      this._turretFadeTimer = 0;
      this.stopTurret();
    }
  } else {
    this._turretFadeTimer = 0;
  }
}

get isTurretPlaying() {
  return !!this._turretSource;
}

// ← ADD THIS WHOLE BLOCK ─────────────────────────────────────────────
/** Start the repair loop — call the instant a repair action begins */
startRepair() {
  if (!this._ready || this._repairSource) return;
  const buf = this._buffers.get('repair.ogg');
  if (!buf) return;

  this._repairGain = this._ctx.createGain();
  this._repairGain.gain.value = VOL.repair;
  this._repairGain.connect(this._sfxGain);

  this._repairSource = this._ctx.createBufferSource();
  this._repairSource.buffer = buf;
  this._repairSource.loop   = true;
  this._repairSource.connect(this._repairGain);
  this._repairSource.start();
}

/** Stop the repair loop — call when repair completes OR is cancelled */
stopRepair() {
  if (!this._repairSource) return;
  try { this._repairSource.stop(); } catch (_) {}
  this._repairSource.disconnect();
  this._repairSource = null;

  if (this._repairGain) {
    this._repairGain.disconnect();
    this._repairGain = null;
  }
}

get isRepairPlaying() {
  return !!this._repairSource;
}
// ← END ADD ──────────────────────────────────────────────────────────

/** Called when player tank dies */
playDeath() {
    this._dead = true;

    // Stop player engine
    this._stopEngine();
    this.stopMG();
    this.stopWater();
    this.stopTurret();
    this.stopRepair();

    // Stop ALL enemy engines
    if (this._enemyEngines) {
      for (const id of [...this._enemyEngines.keys()]) {
        this.stopEnemyEngine(id);
      }
    }

    // Music is intentionally left playing — only the sfx bus (engine, MG,
    // turret, water, gunfire, explosions) is muted below. This keeps the
    // background track continuous through death and spawn-selection.

    // Mute sfx gain so nothing else bleeds through
    if (this._sfxGain) {
      this._sfxGain.gain.setTargetAtTime(0, this._ctx.currentTime, 0.3);
    }

    // Play death sound directly on master so it bypasses the muted sfx gain
    const buf = this._buffers.get('Death_1.ogg');
    if (buf) {
      const src  = this._ctx.createBufferSource();
      src.buffer = buf;
      const g    = this._ctx.createGain();
      g.gain.value = VOL.death;
      src.connect(g);
      g.connect(this._masterGain);
      src.start();
    }
  }

  /** Called when player tank respawns — undo everything playDeath() did */
  reviveAudio() {
    this._dead = false;

    // Restore sfx gain (was ramped to 0 in playDeath)
    if (this._sfxGain) {
      this._sfxGain.gain.cancelScheduledValues(this._ctx.currentTime);
      this._sfxGain.gain.setTargetAtTime(1, this._ctx.currentTime, 0.05);
    }

    // Restart engine loop
    this._stopEngine();   // safety — clear any stale nodes first
    this._startEngine();

    // Restart background music
    if (!this._musicSource) {
      this._startMusic();
    }
  }
  
  /** Mute / unmute everything */
  setMuted(muted) {
    this._muted = muted;
    if (this._masterGain) {
      this._masterGain.gain.value = muted ? 0 : 1;
    }
  }

  toggleMute() {
    this.setMuted(!this._muted);
  }

  /** Full teardown */
  dispose() {
    this._dead = false;
    this._stopEngine();
    this.stopMG();
    this.stopWater();
    this.stopTurret();
    this.stopRepair();
    if (this._enemyEngines) {
      for (const id of this._enemyEngines.keys()) this.stopEnemyEngine(id);
    }
    if (this._musicSource) {
      try { this._musicSource.stop(); } catch (_) {}
    }
    if (this._ctx) {
      this._ctx.close();
      this._ctx = null;
    }
    this._buffers.clear();
    this._ready = false;
    window.removeEventListener('click',   this._resumeHandler);
    window.removeEventListener('keydown', this._resumeHandler);
  }
}