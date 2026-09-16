// enemyBeltMesh.js — single merged mesh belt with scrolling UV texture
// Place this file alongside enemyTrackSystem.js and import it there.

import * as THREE from 'three';

const BELT_HALF_H  = 0.04;   // half-height of track shoe (Y extent)
// BELT_HALF_W is now computed per-instance from rootTrackWidth
const ARC_VERTS_PER_M = 4;   // curved section: quads per metre of arc length (adjust for quality)
const MIN_ARC_QUADS   = 2;   // minimum quads even for tiny arcs

// ── Procedural grouser texture (created once, shared across all instances) ───
let _sharedTexture = null;
let _sharedTextureRefs = 0;

function _getSharedTexture() {
  if (_sharedTexture) { _sharedTextureRefs++; return _sharedTexture; }

  const W = 32, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Base track plate color — matches track.js belt piece color (0x2a2a2a)
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);

  // Lighter grouser bars — one every 32px, 10px tall
  // ctx.fillStyle = '#ffffff';
  // const BAR_H   = 5;
  // const REPEAT  = 32;
  // for (let y = 0; y < H; y += REPEAT) {
  //   ctx.fillRect(0, y, W, BAR_H);
  // }

  // Subtle edge highlight on each bar (sells the raised ridge)
  // ctx.fillStyle = '#000000';
  // for (let y = 0; y < H; y += REPEAT) {
  //   ctx.fillRect(0, y, W, 2);
  // }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // One tile in U covers the full belt width; V repeats along the belt length
  tex.repeat.set(1, 6);   // 6 = tune so grouser bar spacing looks right at your scale
  tex.needsUpdate = true;

  _sharedTexture = tex;
  _sharedTextureRefs = 1;
  return tex;
}

function _releaseSharedTexture() {
  _sharedTextureRefs--;
  if (_sharedTextureRefs <= 0) {
    _sharedTexture?.dispose();
    _sharedTexture = null;
    _sharedTextureRefs = 0;
  }
}

// ── beltType shader patch — mirrors track.js's per-piece discard patterns ───
// track.js drives these from per-instance LOCAL position (vWorldPos), where
// x runs along belt travel [-halfLen, halfLen] and z runs across belt width
// [-halfW, halfW]. Our continuous strip only has UV (u = across width 0..1,
// v = along full belt length 0..1), so we recover a per-piece "local x" by
// tiling v with pieceCount, exactly like track.js's repeating instances.
function _applyBeltTypeShader(material, beltType, pieceCount) {
  if (!beltType) return { uniforms: null }; // no beltType set at all — no discard

  const uniforms = { uBeltScroll: { value: 0 } };

  // Shared zigzag-chevron generator — mirrors track.js's per-type constants.
  // xN = along-piece axis (-1..1), zN = across-width axis (-1..1)
  function zigzagBlock({ pulseCount, flatFrac, rampFrac, angleSpan, lineWidth, rotateDeg = 180.0 }) {
    return `
      float pieceCount = ${pieceCount.toFixed(1)};
      float scrolledV = vBeltUv.y + uBeltScroll;
      float xN = fract(scrolledV * pieceCount) * 2.0 - 1.0;  // -1..1 along piece length
      float zN = vBeltUv.x * 2.0 - 1.0;                       // -1..1 across width

      const float PULSE_COUNT = ${pulseCount.toFixed(2)};
      const float FLAT_FRAC   = ${flatFrac.toFixed(2)};
      const float RAMP_FRAC   = ${rampFrac.toFixed(2)};
      const float ANGLE_SPAN  = ${angleSpan.toFixed(2)};
      const float LINE_WIDTH  = ${lineWidth.toFixed(2)};
      const float ROTATE_DEG  = ${rotateDeg.toFixed(1)};

      float rotRad = radians(ROTATE_DEG);
      float cosR   = cos(rotRad);
      float sinR   = sin(rotRad);
      float xR     =  xN * cosR - zN * sinR;
      float zR     =  xN * sinR + zN * cosR;

      float periodW  = 2.0 / PULSE_COUNT;
      float zAbs     = abs(zR);
      float zInCycle = mod(zAbs, periodW) / periodW;

      float aEnd = FLAT_FRAC;
      float bEnd = aEnd + RAMP_FRAC;
      float cEnd = bEnd + FLAT_FRAC;

      float wave;
      if (zInCycle < aEnd) {
        wave = 0.0;
      } else if (zInCycle < bEnd) {
        wave = (zInCycle - aEnd) / RAMP_FRAC;
      } else if (zInCycle < cEnd) {
        wave = 1.0;
      } else {
        wave = 1.0 - (zInCycle - cEnd) / RAMP_FRAC;
      }

      float lineCenterX  = (wave - 0.5) * 2.0 * ANGLE_SPAN;
      float distFromLine = abs(xR - lineCenterX);

      if (distFromLine < LINE_WIDTH) discard;
    `;
  }

  material.onBeforeCompile = (shader) => {
    // Merge our uniform into the shader's uniform set
    shader.uniforms.uBeltScroll = uniforms.uBeltScroll;

    shader.fragmentShader = `
      varying vec2 vBeltUv;
      uniform float uBeltScroll;
    ` + shader.fragmentShader;

    shader.vertexShader = `
      varying vec2 vBeltUv;
    ` + shader.vertexShader.replace(
      `#include <uv_vertex>`,
      `#include <uv_vertex>
      vBeltUv = uv;`
    );

    let discardBlock = '';

    if (beltType === 1) {
      // ── Plain belt — seam line only, no other cutout pattern ──────────────
      discardBlock = `
        float pieceCount = ${pieceCount.toFixed(1)};
        float scrolledV  = vBeltUv.y + uBeltScroll;
        float vInPiece    = fract(scrolledV * pieceCount);
        float distToSeam  = min(vInPiece, 1.0 - vInPiece);
        const float SEAM_WIDTH = 0.04;   // tune: fraction of one piece's length
        if (distToSeam < SEAM_WIDTH) discard;
      `;
    } else if (beltType === 2) {
      // ── Center stripe gap + per-piece seam line ───────────────────────────
      discardBlock = `
        float uN = vBeltUv.x * 2.0 - 1.0;   // -1..1 across width
        float stripe = abs(uN);
        if (stripe < 0.10) discard;

        // Transverse seam at each tread boundary — separates individual pieces
        float pieceCount = ${pieceCount.toFixed(1)};
        float scrolledV  = vBeltUv.y + uBeltScroll;
        float vInPiece    = fract(scrolledV * pieceCount);        // 0..1 within this piece
        float distToSeam  = min(vInPiece, 1.0 - vInPiece);         // distance to nearest boundary
        const float SEAM_WIDTH = 0.04;   // tune: fraction of one piece's length
        if (distToSeam < SEAM_WIDTH) discard;
      `;
    } else if (beltType === 3) {
      // ── Zigzag — matches track.js beltType 3 (thin diagonal line) ─────────
      discardBlock = zigzagBlock({
        pulseCount: 4.0, flatFrac: 0.40, rampFrac: 0.20,
        angleSpan: 0.05, lineWidth: 0.05,
      });
    } else if (beltType === 4) {
      // ── Zigzag — matches track.js beltType 4 (wider diagonal line) ────────
      discardBlock = zigzagBlock({
        pulseCount: 4.0, flatFrac: 0.40, rampFrac: 0.20,
        angleSpan: 0.15, lineWidth: 0.1,
      });
    } else if (beltType === 5) {
      // ── Zigzag — matches track.js beltType 5 (wide chevron) ────────────────
      discardBlock = zigzagBlock({
        pulseCount: 4.8, flatFrac: 0.40, rampFrac: 0.10,
        angleSpan: 0.85, lineWidth: 0.2,
      });
    } else if (beltType === 6) {
      // ── Zigzag — matches track.js beltType 6 (sharp step, no ramp) ────────
      discardBlock = zigzagBlock({
        pulseCount: 5.0, flatFrac: 0.40, rampFrac: 0.0,
        angleSpan: 0.85, lineWidth: 0.2,
      });
    } else if (beltType === 7) {
      // ── Four trapezoidal window pockets + center V-rib ─────────────────────
      // (matches track.js beltType 7 — was previously numbered 4 here)
      discardBlock = `
        float pieceCount = ${pieceCount.toFixed(1)};
        float scrolledV = vBeltUv.y + uBeltScroll;
        float xN = fract(scrolledV * pieceCount) * 2.0 - 1.0;  // -1..1 along piece length
        float zN = vBeltUv.x * 2.0 - 1.0;                       // -1..1 across width

        const float BORDER_Z      = 0.14;
        const float BORDER_X      = 0.12;
        const float RIB_HALF_Z    = 0.10;
        const float RIB_TAPER     = 0.55;
        const float SUBDIV_HALF_Z = 0.3;

        bool inBorder = (abs(zN) > 1.0 - BORDER_Z) || (abs(xN) > 1.0 - BORDER_X);

        float ribHalfAtX = RIB_HALF_Z * (1.0 - RIB_TAPER * abs(xN));
        bool inRib = abs(zN) < ribHalfAtX;

        float pocketCenterZ = (ribHalfAtX + (1.0 - BORDER_Z)) * 0.5;
        bool inSubdivRight = abs(zN - pocketCenterZ) < SUBDIV_HALF_Z;
        bool inSubdivLeft  = abs(zN + pocketCenterZ) < SUBDIV_HALF_Z;

        bool isPocket = !inBorder && !inRib && !inSubdivLeft && !inSubdivRight;

        if (isPocket) discard;
      `;
    }

    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <alphatest_fragment>`,
      `
      #include <alphatest_fragment>
      ${discardBlock}
      `
    );
  };

  material.needsUpdate = true;
  return { uniforms };
}

// ── Geometry builder ─────────────────────────────────────────────────────────

// ── Geometry builder ─────────────────────────────────────────────────────────
//
// pathPts: THREE.Vector2[]  — belt path in local body XY space (from _buildSimplePath)
// side:    +1 | -1          — which side of the tank
//
// Returns a BufferGeometry with positions, normals, and UVs.
// The mesh is built in LOCAL body space; EnemyBeltMesh.update() moves it to world.
//
function buildBeltGeometry(pathPts, side, sideZ, trackWidth = 1.0) {
  if (!pathPts || pathPts.length < 2) return new THREE.BufferGeometry();
  const BELT_HALF_W = 0.25 * trackWidth;   // matches track.js: PIECE_W(0.50) * trackWidth / 2

  // ── Step 1: classify each segment as STRAIGHT or CURVED ──────────────────
  // A segment is "curved" if the direction change from the previous segment
  // exceeds a threshold. We decide quad count per segment here.

  const CURVE_THRESHOLD = 0.08; // radians — below this = straight (1 quad)

  const segs = []; // { ax, ay, bx, by, quads }
  for (let i = 0; i < pathPts.length - 1; i++) {
    const a  = pathPts[i];
    const b  = pathPts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    let dirChange = 0;
    if (i > 0) {
      const pa = pathPts[i - 1];
      const pdx = a.x - pa.x, pdy = a.y - pa.y;
      const pLen = Math.sqrt(pdx * pdx + pdy * pdy);
      if (pLen > 0.0001 && len > 0.0001) {
        const dot   = (pdx * dx + pdy * dy) / (pLen * len);
        dirChange = Math.acos(Math.min(1, Math.max(-1, dot)));
      }
    }

    const isCurved = dirChange > CURVE_THRESHOLD;
    const quads    = isCurved
      ? Math.max(MIN_ARC_QUADS, Math.ceil(len * ARC_VERTS_PER_M))
      : 1;

    segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, len, quads });
  }

  // ── Step 2: count total quads → allocate buffers ──────────────────────────
  const totalQuads = segs.reduce((s, sg) => s + sg.quads, 0);
const vertCount  = (totalQuads + 1) * 4; // 4 verts per column (top-outer, top-inner, bot-outer, bot-inner)
const idxCount   = totalQuads * 6 * 4;  // 4 faces (top, bottom, outer, inner) × 2 tris each

  const positions = new Float32Array(vertCount * 3);
  const normals   = new Float32Array(vertCount * 3);
  const uvs       = new Float32Array(vertCount * 2);
  const indices   = new Uint32Array(idxCount);

  // ── Step 3: fill buffers ──────────────────────────────────────────────────
  let vi = 0; // vertex index (column index, 0..totalQuads)
  let ii = 0; // index buffer position
  let vTotal = 0; // running arc length for V coordinate

  // Total path length (for UV normalisation)
  let pathLen = 0;
  for (const sg of segs) pathLen += sg.len;
  const uvScale = 1.0 / Math.max(0.001, pathLen);

  // const nz = side; // normal points outward (Z direction per side)

// Each column = 4 verts:
//   [col*4+0] = top-outer,  [col*4+1] = top-inner
//   [col*4+2] = bot-outer,  [col*4+3] = bot-inner
function emitColumn(x, y, vCoord) {
  const base  = vi * 12;
  const uBase = vi * 8;

  // Always: zA = sideZ + BELT_HALF_W (more positive Z)
  //         zB = sideZ - BELT_HALF_W (more negative Z)
  // For right side (+1): zA is outer, zB is inner
  // For left  side (-1): zA is inner, zB is outer
  // Winding is fixed — no per-side flip needed
  const zA   = sideZ + BELT_HALF_W;
  const zB   = sideZ - BELT_HALF_W;
  const yTop = y + BELT_HALF_H;
  const yBot = y - BELT_HALF_H;

  // top-zA
  positions[base + 0] = x; positions[base + 1] = yTop; positions[base + 2] = zA;
  normals  [base + 0] = 0; normals  [base + 1] = 1;    normals  [base + 2] = 0;
  uvs[uBase + 0] = 0; uvs[uBase + 1] = vCoord;

  // top-zB
  positions[base + 3] = x; positions[base + 4] = yTop; positions[base + 5] = zB;
  normals  [base + 3] = 0; normals  [base + 4] = 1;    normals  [base + 5] = 0;
  uvs[uBase + 2] = 1; uvs[uBase + 3] = vCoord;

  // bot-zA
  positions[base + 6] = x; positions[base + 7] = yBot; positions[base + 8] = zA;
  normals  [base + 6] = 0; normals  [base + 7] = -1;   normals  [base + 8] = 0;
  uvs[uBase + 4] = 0; uvs[uBase + 5] = vCoord;

  // bot-zB
  positions[base + 9] = x; positions[base + 10] = yBot; positions[base + 11] = zB;
  normals  [base + 9] = 0; normals  [base + 10] = -1;   normals  [base + 11] = 0;
  uvs[uBase + 6] = 1; uvs[uBase + 7] = vCoord;

  vi++;
}

function emitQuad(colA, colB) {
  // col layout: [col*4+0]=top-zA, [col*4+1]=top-zB, [col*4+2]=bot-zA, [col*4+3]=bot-zB
  const ta0 = colA*4,   tb0 = colA*4+1, ba0 = colA*4+2, bb0 = colA*4+3;
  const ta1 = colB*4,   tb1 = colB*4+1, ba1 = colB*4+2, bb1 = colB*4+3;

  // TOP face (normal up)
  indices[ii++] = ta0; indices[ii++] = tb0; indices[ii++] = ta1;
  indices[ii++] = tb0; indices[ii++] = tb1; indices[ii++] = ta1;

  // zA side face
  indices[ii++] = ta0; indices[ii++] = ba0; indices[ii++] = ta1;
  indices[ii++] = ba0; indices[ii++] = ba1; indices[ii++] = ta1;

  // zB side face
  indices[ii++] = tb0; indices[ii++] = tb1; indices[ii++] = bb0;
  indices[ii++] = bb0; indices[ii++] = tb1; indices[ii++] = bb1;

  // BOTTOM face (normal down)
  indices[ii++] = ba0; indices[ii++] = bb0; indices[ii++] = ba1;
  indices[ii++] = bb0; indices[ii++] = bb1; indices[ii++] = ba1;
}

  let colIdx = 0;

  for (const sg of segs) {
    const { ax, ay, bx, by, len, quads } = sg;

    for (let q = 0; q < quads; q++) {
      const t  = q / quads;
      const x  = ax + (bx - ax) * t;
      const y  = ay + (by - ay) * t;
      const vC = (vTotal + len * t) * uvScale;

      emitColumn(x, y, vC);
      if (colIdx > 0) emitQuad(colIdx - 1, colIdx);
      colIdx++;
    }

    vTotal += len;
  }

  // Emit the final closing column
  emitColumn(segs[segs.length - 1].bx, segs[segs.length - 1].by, 1.0);
  if (colIdx > 0) emitQuad(colIdx - 1, colIdx);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,       2));
  const idxAttr = new THREE.BufferAttribute(indices, 1);
  idxAttr.gpuType = THREE.UnsignedIntType;
  geo.setIndex(idxAttr);
  return geo;
}

// ── Public class ─────────────────────────────────────────────────────────────

export class EnemyBeltMesh {
  /**
   * @param {THREE.Scene}    scene
   * @param {number}         side   — +1 right, -1 left
   * @param {number}         sideZ  — world-space Z offset of this belt side
   */
  constructor(scene, side, sideZ, trackWidth = 1.0, beltType = 1, pieceCount = 70) {
    this.scene = scene;
    this.side  = side;
    this.sideZ = sideZ;
    this.trackWidth = trackWidth;
    this.beltType   = beltType;

    this._scrollOffset = 0;
// Each instance shares the texture directly — no clone needed.
// _getSharedTexture() already increments the ref count.
this._texture = _getSharedTexture();
this._material = new THREE.MeshStandardMaterial({
  map:       this._texture,
  roughness: 0.55,
  metalness: 0.34,
  side:      THREE.DoubleSide,
});
// ── Force a distinct compiled shader program per beltType/pieceCount ──────
// Without this, Three.js's internal program cache can treat two materials
// with different onBeforeCompile bodies as identical (since the cache key
// ignores onBeforeCompile's contents) and silently reuse ONE compiled GLSL
// program across tanks with different beltTypes — causing the wrong pattern
// to render on some tanks. This key makes each variant compile separately.
this._material.customProgramCacheKey = () => `beltType_${this.beltType}_pc_${pieceCount}`;

// ── Apply track.js-style beltType cutout pattern via shader ───────────────
const { uniforms } = _applyBeltTypeShader(this._material, this.beltType, pieceCount);
this._beltTypeUniforms = uniforms; // null if beltType === 1 (plain)

    this._mesh = new THREE.Mesh(new THREE.BufferGeometry(), this._material);
    this._mesh.castShadow    = false;
    this._mesh.receiveShadow = false;
    this.scene.add(this._mesh);

    // Reusable matrix for world placement
    this._bodyMatrix = new THREE.Matrix4();
    this._oneVec     = new THREE.Vector3(1, 1, 1);
    this._lastPos     = new THREE.Vector3();
this._lastQ       = new THREE.Quaternion();
// this._matrixDirty = true;
  }

  /**
   * Rebuild belt geometry from a new path.
   * Call this only when _pathDirty (matches existing EnemyTrackSystem pattern).
   * @param {THREE.Vector2[]} pathPts
   */
  rebuildFromPath(pathPts) {
    const oldGeo = this._mesh.geometry;
    this._mesh.geometry = buildBeltGeometry(pathPts, this.side, this.sideZ, this.trackWidth);
    oldGeo.dispose();
  }

  /**
   * Call every frame. Scrolls the UV and repositions the mesh in world space.
   * @param {number}             dt
   * @param {number}             throttle   — signed belt speed
   * @param {THREE.Vector3}      worldPos
   * @param {THREE.Quaternion}   worldQ
   */
update(dt, throttle, worldPos, worldQ) {
  // UV scroll
  const beltSpeed = throttle * -0.2;
  this._scrollOffset += beltSpeed * dt;
  const wrapped = ((this._scrollOffset % 1.0) + 1.0) % 1.0;
  this._material.map.offset.y = wrapped;

  // Keep the beltType cutout pattern scrolling in sync with the texture
  if (this._beltTypeUniforms) {
    this._beltTypeUniforms.uBeltScroll.value = wrapped;
  }

  // Only recompose matrix if position or rotation has actually changed
  if (
    !this._lastPos.equals(worldPos) ||
    !this._lastQ.equals(worldQ)
  ) {
    this._bodyMatrix.compose(worldPos, worldQ, this._oneVec);
    this._mesh.matrix.copy(this._bodyMatrix);
    this._mesh.matrixAutoUpdate = false;

    this._lastPos.copy(worldPos);
    this._lastQ.copy(worldQ);
    this._matrixDirty = false;
  }
}

dispose() {
  this.scene.remove(this._mesh);
  this._mesh.geometry.dispose();
  this._material.dispose();
  _releaseSharedTexture();   // this handles disposal when ref count hits 0
}
}