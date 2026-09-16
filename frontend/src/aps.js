// aps.js — Active Protection System (Afganit-style shockwave interceptor)

import * as THREE from 'three';

const APS_SHOCKWAVE_MAX_RADIUS = 18;
const APS_SHOCKWAVE_SPEED      = 10;  // units/sec expansion
const APS_SHOCKWAVE_LIFETIME   = APS_SHOCKWAVE_MAX_RADIUS / APS_SHOCKWAVE_SPEED;

export class APSSystem {
  constructor(scene) {
    this.scene   = scene;
    this.active  = false;   // is APS armed (slot 5 selected)
    this._waves  = [];      // active shockwave instances

    // Shockwave visual — expanding sphere wireframe
    this._geo = new THREE.SphereGeometry(1, 16, 10);
    this._mat = new THREE.MeshBasicMaterial({
//   color:       0xffffff,
  transparent: true,
  opacity:     0.00,
  depthWrite:  false,
//   side:        THREE.BackSide,  // only inner surface — gives rim glow look
//   blending:    THREE.AdditiveBlending,
});

    // Scratch
    this._scratchSphere = new THREE.Sphere();
    this._scratchProjPos = new THREE.Vector3();
  }

  // ── Fire a shockwave from tank world position ─────────────────────────────
  fire(tankWorldPos) {
    const mesh = new THREE.Mesh(this._geo, this._mat.clone());
    mesh.position.copy(tankWorldPos);
    mesh.position.y += 0.8;
    mesh.scale.setScalar(0.1);
    this.scene.add(mesh);

    this._waves.push({
      mesh,
      radius:   0.1,
      lifetime: APS_SHOCKWAVE_LIFETIME,
      dead:     false,
    });
  }

  // ── Update — expand waves, check projectile intercept ────────────────────
  // projSystem: ProjectileBulletSystem or BulletSystem instance
  // ── Update — expand waves, check projectile intercept ────────────────────
  // projSystems: array of ProjectileBulletSystem instances (one per enemy gunType-2 tank)
  update(dt, projSystems) {
    if (this._waves.length === 0) return;

    // Normalise: accept a single system or an array
    const systems = Array.isArray(projSystems)
      ? projSystems
      : (projSystems ? [projSystems] : []);

    for (const wave of this._waves) {
      if (wave.dead) continue;

      const prevRadius   = wave.radius;
      wave.lifetime     -= dt;
      wave.radius       += APS_SHOCKWAVE_SPEED * dt;

      // Fade as it expands
      const t = wave.radius / APS_SHOCKWAVE_MAX_RADIUS;
      wave.mesh.material.opacity = (1 - t) * 0.55;
      wave.mesh.scale.setScalar(wave.radius);

      // Expire
      if (wave.lifetime <= 0 || wave.radius >= APS_SHOCKWAVE_MAX_RADIUS) {
        this._killWave(wave);
        continue;
      }

      const cx = wave.mesh.position.x;
      const cy = wave.mesh.position.y;
      const cz = wave.mesh.position.z;

      // ── Check every enemy projectile system ──────────────────────────────
      for (const projSystem of systems) {
        if (!projSystem || !projSystem._active) continue;

        for (let i = 0; i < projSystem._active.length; i++) {
          // type 2 = enemy shot, type 1 = player shot — only block enemy
          if (projSystem._active[i] !== 2) continue;

          const px = projSystem._px[i];
          const py = projSystem._py[i];
          const pz = projSystem._pz[i];

          const dx   = px - cx;
          const dy   = py - cy;
          const dz   = pz - cz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

          // Kill projectile the moment the expanding shell surface reaches it:
          // was outside last frame (dist >= prevRadius) and inside this frame (dist <= wave.radius)
          if (dist <= wave.radius && dist >= prevRadius - 0.5) {
            this._scratchProjPos.set(px, py, pz);
            projSystem.explosionSystem?.spawnShellHit(this._scratchProjPos);
            projSystem.onHit?.();
            projSystem._killProjectile(i);
          }
        }
      }
    }

    // Purge dead waves
    this._waves = this._waves.filter(w => !w.dead);
  }

  _killWave(wave) {
    wave.dead = true;
    this.scene.remove(wave.mesh);
    wave.mesh.material.dispose();
  }

  dispose() {
    for (const wave of this._waves) {
      this.scene.remove(wave.mesh);
      wave.mesh.material.dispose();
    }
    this._waves = [];
    this._geo.dispose();
    this._mat.dispose();
  }
}