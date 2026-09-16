// smokeGrenade.js — Smoke screen deployment
//
// fire() deploys a 4-point smoke screen across the tank's front arc,
// matching the reference layout (top-down view):
//
//        Pt.2 ──────── Pt.3      (front-left / front-right corners, slightly ahead)
//       /                  \
//   Pt.1                    Pt.4  (sides, trailing back toward the rear)
//
// All 4 clouds spawn simultaneously, each via explosionSystem.spawnSmokeCloud().

import * as THREE from 'three';

// Fixed local-space offsets (in the tank's own forward/right basis, world units)
// for each of the 4 screen points.
//   x = sideways  (+ = right of tank center)
//   z = forward   (+ = ahead of the tank's front edge, - = trailing toward rear)
// Tune these to match your tank's actual scale — these are derived from the
// proportions in the reference sketch, not measured from a real model.
const SCREEN_POINTS = [
  { x: -4.5, z: -1.0 }, // Pt.1 — left side, trailing behind the front edge
  { x: -2.0, z:  0.8 }, // Pt.2 — left-front corner, just ahead of the front edge
  { x:  2.0, z:  0.8 }, // Pt.3 — right-front corner, just ahead of the front edge
  { x:  4.5, z: -1.0 }, // Pt.4 — right side, trailing behind the front edge
];

const _up    = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _world = new THREE.Vector3();

export class SmokeGrenadeSystem {
  constructor(scene, explosionSystem) {
    this.scene = scene;
    this.explosionSystem = explosionSystem;

    this.cooldownDuration = 30;   // seconds
    this.cooldownRemaining = 0;   // 0 = ready to fire
  }

  get isReady() {
    return this.cooldownRemaining <= 0;
  }

  /**
   * Deploy a 4-point smoke screen across the tank's front arc, all at once.
   *
   * @param {THREE.Vector3} position - tank position (screen origin)
   * @param {THREE.Vector3} forward  - tank's normalized forward direction (xz-plane)
   * @param {THREE.Vector3} [right]  - tank's normalized right direction.
   *                                   If omitted, computed as forward × up,
   *                                   which assumes three.js's common
   *                                   "forward = -Z" convention. Pass `right`
   *                                   explicitly if your tank uses a different
   *                                   forward convention (e.g. +Z), or the
   *                                   screen will mirror left/right.
   */
  fire(position, forward, right) {
    if (!this.explosionSystem || !position || !forward) return;
    if (!this.isReady) return;   // still on cooldown

    if (!right) {
      _right.crossVectors(forward, _up).normalize();
      right = _right;
    }

    for (let k = 0; k < SCREEN_POINTS.length; k++) {
      const p = SCREEN_POINTS[k];
      _world.copy(position)
        .addScaledVector(right,   p.x)
        .addScaledVector(forward, p.z);

      this.explosionSystem.spawnSmokeCloud(_world);
    }

    this.cooldownRemaining = this.cooldownDuration;   // start cooldown
  }

  // ── Cosmetic-only replay for remote clients — spawns the same 4-point
  // smoke screen as fire(), but never checks or touches cooldownRemaining.
  // Used when another player's smoke throw is relayed over the network:
  // the receiving client should SEE the effect without it consuming their
  // own local cooldown/ammo (those are tracked independently per-client
  // in main.js and only apply to the player's own weapon use).
  spawnRemoteEffect(position, forward, right) {
    if (!this.explosionSystem || !position || !forward) return;

    if (!right) {
      _right.crossVectors(forward, _up).normalize();
      right = _right;
    }

    for (let k = 0; k < SCREEN_POINTS.length; k++) {
      const p = SCREEN_POINTS[k];
      _world.copy(position)
        .addScaledVector(right,   p.x)
        .addScaledVector(forward, p.z);

      this.explosionSystem.spawnSmokeCloud(_world);
    }
    // Intentionally no cooldownRemaining write — this is a visual echo only.
  }

  update(dt) {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);
    }
  }

  dispose() {
    // Nothing to dispose
  }
}