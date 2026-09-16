// input.js
const keys = {
  // ── Tank fields (unchanged) ─────────────────────────────────────────
  forward:  false,
  backward: false,
  left:     false,
  right:    false,

  // ── Plane flight-control fields — read by plane.js applyInput() ───────
  // pitchUp/pitchDown/rollLeft/rollRight are no longer driven by keys —
  // they're now driven by cursor offset from screen center (see
  // getMouseFlightOffset below). Kept here as inert stubs in case
  // anything else still reads them.
  pitchUp:    false,
  pitchDown:  false,
  rollLeft:   false,
  rollRight:  false,

  // ── Yaw (rudder) — A/D only ─────────────────────────────────────────
  yawLeft:    false,  // A — rudder left
  yawRight:   false,  // D — rudder right

  boost:      false,  // Space — throttle boost
};

// ── Cursor offset from screen center — read live by plane.js each frame,
// and also used by main.js to build the turret-aim NDC coords. This is
// now a VIRTUAL cursor position — while Pointer Lock is active (normal
// gameplay), the browser's real cursor is hidden/locked at the canvas
// center and never actually moves; instead we accumulate movementX/Y
// deltas into this virtual position ourselves, clamped to the window
// bounds. That's what makes "cursor can't leave the canvas" work: there
// IS no real cursor moving around to leave it. When NOT pointer-locked
// (menus, pause, spawn-selection, death screen) this just mirrors the
// real absolute cursor position, exactly like before. ─────────────────────
let _mouseClientX = window.innerWidth  / 2;
let _mouseClientY = window.innerHeight / 2;

// ── Pointer freeze — when true, incoming mouse movement (real or locked)
// is ignored so _mouseClientX/_mouseClientY (and therefore
// getMouseFlightOffset()) stay exactly where they were the instant
// freezing began. Purely visual/input freeze — separate from Pointer
// Lock — so absolute-position-based systems elsewhere keep working
// unchanged once unfrozen. ─────────────────────────────────────────────
let _pointerFrozen = false;
export function setPointerFrozen(frozen) {
  _pointerFrozen = frozen;
}

// ── Pointer Lock state/helpers ──────────────────────────────────────────
// The canvas element pointer lock is requested against. main.js sets this
// once via setPointerLockElement(renderer.domElement) right after the
// renderer is created.
let _pointerLockEl = null;
export function setPointerLockElement(el) {
  _pointerLockEl = el;
}

export function isPointerLocked() {
  return document.pointerLockElement === _pointerLockEl && !!_pointerLockEl;
}

// Requests pointer lock on the game canvas — call this whenever gameplay
// input should take over (deploy, resume from pause, etc.). No-ops
// harmlessly if already locked or if the element isn't set yet.
export function requestGameplayPointerLock() {
  if (!_pointerLockEl) return;
  if (document.pointerLockElement === _pointerLockEl) return;
  _pointerLockEl.requestPointerLock?.();
}

// Releases pointer lock — call this whenever a UI screen needs the real
// system cursor back (pause menu, death screen, spawn-selection, return
// to main menu). The browser also does this automatically on Esc.
export function exitGameplayPointerLock() {
  if (document.pointerLockElement) {
    document.exitPointerLock?.();
  }
}

// Re-center the virtual cursor — useful right after entering pointer lock
// or after a screen transition, so flight/aim doesn't inherit a stale
// off-center offset from whatever the last real cursor position was.
export function centerVirtualCursor() {
  _mouseClientX = window.innerWidth  / 2;
  _mouseClientY = window.innerHeight / 2;
}

/**
 * Returns the cursor's offset from screen center, normalized to roughly
 * -1..1 range (clamped), where x: -1 = left edge, +1 = right edge,
 * y: -1 = top edge, +1 = bottom edge. Safe to call every frame — this is
 * a live read, not a consumed/cleared accumulator.
 */
export function getMouseFlightOffset() {
  const halfW = window.innerWidth  / 2;
  const halfH = window.innerHeight / 2;
  const nx = (_mouseClientX - halfW) / halfW;
  const ny = (_mouseClientY - halfH) / halfH;
  return {
    x: Math.max(-1, Math.min(1, nx)),
    y: Math.max(-1, Math.min(1, ny)),
  };
}

export let isMouseHeld = false;

let _onShiftPress  = null;
let _onMiddleClick = null;
let _onFire        = null;

// ── Suppression flag — set true while a UI mode (e.g. spawn-selection)
// is intercepting mouse clicks for its own purpose (panning, etc.), so a
// leftover left-click-hold doesn't get read as "still firing" once that
// mode ends and control hands back to the tank/turret loop. ────────────
let _inputSuppressed = false;

export function setInputSuppressed(suppressed) {
  _inputSuppressed = suppressed;
  if (suppressed) {
    isMouseHeld = false;   // force-release immediately when suppression begins
  }
}

export function onShiftPress(fn)  { _onShiftPress  = fn; }
export function onMiddleClick(fn) { _onMiddleClick = fn; }
export function onFire(fn)        { _onFire        = fn; }

window.addEventListener('mousemove', (e) => {
  if (_pointerFrozen) return;

  if (document.pointerLockElement === _pointerLockEl && _pointerLockEl) {
    // ── Locked: the real cursor doesn't move (browser hides/traps it),
    // so accumulate the reported movement deltas into our own virtual
    // position instead, clamped to the window so it can never wander off
    // toward some huge/negative value even under fast mouse flicks. ─────
    _mouseClientX = Math.max(0, Math.min(window.innerWidth,  _mouseClientX + e.movementX));
    _mouseClientY = Math.max(0, Math.min(window.innerHeight, _mouseClientY + e.movementY));
  } else {
    // ── Not locked (menus, pause, spawn-selection, death screen) — mirror
    // the real absolute cursor position, exactly as before. ─────────────
    _mouseClientX = e.clientX;
    _mouseClientY = e.clientY;
  }
});

window.addEventListener('mousedown', (e) => {
  if (_inputSuppressed) return;
  if (e.button === 0) {
    isMouseHeld = true;
    _onFire?.();
  }
  if (e.button === 1) { e.preventDefault(); _onMiddleClick?.(); }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) isMouseHeld = false;
});

window.addEventListener('mouseleave', () => {
  isMouseHeld = false;
});

window.addEventListener('keydown', (e) => {
  switch (e.code) {

    // ── Forward ─────────────────────────────────────────────────────
    case 'KeyW':
    case 'ArrowUp':
      keys.forward = true;
      break;

    // ── Backward ────────────────────────────────────────────────────
    case 'KeyS':
    case 'ArrowDown':
      keys.backward = true;
      break;

    // ── A / Left Arrow — tank steering AND plane yaw/rudder ─────────
    case 'KeyA':
    case 'ArrowLeft':
      keys.left = true;
      keys.yawLeft = true;
      break;

    // ── D / Right Arrow — tank steering AND plane yaw/rudder ────────
    case 'KeyD':
    case 'ArrowRight':
      keys.right = true;
      keys.yawRight = true;
      break;

    // ── Boost ───────────────────────────────────────────────────────
    case 'Space':
      keys.boost = true;
      break;

    case 'ShiftLeft':
    case 'ShiftRight':
      _onShiftPress?.();
      break;
  }
});

window.addEventListener('keyup', (e) => {
  switch (e.code) {

    // ── Forward ─────────────────────────────────────────────────────
    case 'KeyW':
    case 'ArrowUp':
      keys.forward = false;
      break;

    // ── Backward ────────────────────────────────────────────────────
    case 'KeyS':
    case 'ArrowDown':
      keys.backward = false;
      break;

    // ── A / Left Arrow ──────────────────────────────────────────────
    case 'KeyA':
    case 'ArrowLeft':
      keys.left = false;
      keys.yawLeft = false;
      break;

    // ── D / Right Arrow ─────────────────────────────────────────────
    case 'KeyD':
    case 'ArrowRight':
      keys.right = false;
      keys.yawRight = false;
      break;

    // ── Boost ───────────────────────────────────────────────────────
    case 'Space':
      keys.boost = false;
      break;
  }
});


export { keys };