// track.js — Ghost-piece tank belt system
// Implements the mechanism from the diagram:
//   1. Ghost pieces follow road-wheel heights (invisible anchor positions)
//   2. Dynamic pieces interpolate between anchors
//   3. Rate (driven by wheel rotation) lerps visible pieces → belt slides

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SteampunkWheels } from './steampunk.js';

// const TRACK_PIECE_COUNT = 70;   // total visible belt pieces per side
const PIECE_W = 0.50;           // track link width (local Z) Default 0.38
const PIECE_H = 0.10;           // track link height
const PIECE_T = 0.06;           // track link thickness

const OUTER_Z = 1.5;  // change the outer-wheel position here irrespective of ENABLE_IN_OUT_WHEELS value , the inner-wheels will automatically adjust maintaining the gap of 0.06
const GAP_BETWEEN_WHEELS = 0.10;
const PARALLEL_WHEEL_GAP = 0.30;  // ← ADD THIS — inboard offset of the parallel companion wheel from the outer wheel

// const INNER_Z_local = this._outerZ - 0.07;

// ─── helpers ────────────────────────────────────────────────────────────────

function makePieceMesh(color = 0x2a2a2a) {
  const geo = new THREE.BoxGeometry(PIECE_H, PIECE_T, PIECE_W);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.9,
    metalness: 0.3,
  });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = false;
  return m;
}

// ─── Radial two-tone paint helper ────────────────────────────────────────────
// Colors vertices based on distance from the wheel's rotation axis (Y axis,
// since wheel geometry is built with cylinder/lathe axis = Y before the
// group's rotation.x = PI/2 is applied). Vertices within splitFraction of
// outerRadius get innerColorHex, the rest get outerColorHex.
function applyRadialTwoToneColors(geometry, outerRadius, innerColorHex, outerColorHex, splitFraction = 0.7) {
  const posAttr = geometry.attributes.position;
  const count   = posAttr.count;
  const colors  = new Float32Array(count * 3);

  const innerColor = new THREE.Color(innerColorHex);
  const outerColor = new THREE.Color(outerColorHex);
  const splitR     = outerRadius * splitFraction;

  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);
    const r = Math.sqrt(x * x + z * z);
    const c = r <= splitR ? innerColor : outerColor;
    colors[i * 3]     = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Paints an entire geometry with one flat color. Use this for flat shapes
// built via THREE.Shape + ExtrudeGeometry (solid disks, annulus rings) —
// these are triangulated from boundary vertices only (no center point),
// so a distance-based gradient (applyRadialTwoToneColors) can't work on
// them reliably; every vertex sits at the same radius.
function paintGeometryUniform(geometry, colorHex) {
  const posAttr = geometry.attributes.position;
  const count   = posAttr.count;
  const colors  = new Float32Array(count * 3);
  const c = new THREE.Color(colorHex);

  for (let i = 0; i < count; i++) {
    colors[i * 3]     = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Build a sprocket or idler wheel with evenly-spaced rectangular teeth.
 *
 * @param {number} radius   – pitch-circle radius of the wheel body
 * @param {number} width    – axial thickness (local Y after rotation.x = π/2)
 * @param {number} color    – hex colour for the body
 * @param {number} toothCount – number of teeth (sprocket needs more, idler fewer)
 * @param {number} toothH   – radial height of each tooth
 * @param {number} toothW   – circumferential width of each tooth (local X)
 * @param {number} toothT   – axial depth of each tooth (local Z == width axis)
 */
// ─── Wheel type 1: solid disc + hollow toothed side rings + hub ──────────────

function makeWheelType1(radius, width, color = 0xc0c0c0, wheelColor = 0xfcd6a9) {
  const group = new THREE.Group();

  const MAIN_R     = radius;
  const MAIN_THICK = width - 0.1;
  const RING_INNER = radius * 0.52;
  const RING_BASE  = radius * 1.0;
  const TOOTH_H    = radius * 0.15;
  const TOOTH_N    = 12;
  const RING_T     = width * 0.18;
  const HUB_R      = radius * 0.28;
  const HUB_THICK  = MAIN_THICK + RING_T * 2 + 0.04;

  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.9,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  function buildToothRing() {
    const shape  = new THREE.Shape();
    const TWO_PI = Math.PI * 2;
    const pitch  = TWO_PI / TOOTH_N;
    const pts    = [];

    for (let i = 0; i < TOOTH_N; i++) {
      const a0   = pitch * i;
      const amid = a0 + pitch * 0.5;
      const a1   = a0 + pitch;
      const r    = RING_BASE;
      const rt   = RING_BASE + TOOTH_H;
      pts.push(new THREE.Vector2(r  * Math.cos(a0),   r  * Math.sin(a0)));
      pts.push(new THREE.Vector2(rt * Math.cos(amid),  rt * Math.sin(amid)));
      pts.push(new THREE.Vector2(r  * Math.cos(a1),   r  * Math.sin(a1)));
    }
    shape.setFromPoints(pts);

    const hole = new THREE.Path();
    hole.absarc(0, 0, RING_INNER, 0, Math.PI * 2, true);
    shape.holes.push(hole);

    return new THREE.ExtrudeGeometry(shape, {
      depth: RING_T,
      bevelEnabled: false,
      curveSegments: 6,
    });
  }

  const ringOffset = MAIN_THICK * 0.5 + RING_T * 0.5;

  // Build indexed geometries
  const midGeoRaw = new THREE.CylinderGeometry(MAIN_R, MAIN_R, MAIN_THICK, 8, 1, false);
  const hubGeoRaw = new THREE.CylinderGeometry(HUB_R,  HUB_R,  HUB_THICK, 8, 1, false);

  const ringGeoLRaw = buildToothRing();
  ringGeoLRaw.center();
  ringGeoLRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  ringGeoLRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0,  ringOffset, 0));

  const ringGeoRRaw = buildToothRing();
  ringGeoRRaw.center();
  ringGeoRRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  ringGeoRRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, -ringOffset, 0));

  // Convert ALL to non-indexed so mergeGeometries is happy
  const midGeo   = midGeoRaw.toNonIndexed();   // CylinderGeometry is indexed
  const hubGeo   = hubGeoRaw.toNonIndexed();   // CylinderGeometry is indexed
  const ringGeoL = ringGeoLRaw;                // ExtrudeGeometry already non-indexed
  const ringGeoR = ringGeoRRaw;                // ExtrudeGeometry already non-indexed

  // Dispose the originals
  [midGeoRaw, hubGeoRaw, ringGeoLRaw, ringGeoRRaw].forEach(g => g.dispose());

  const merged = mergeGeometries([midGeo, hubGeo, ringGeoL, ringGeoR], false);

  if (merged) {
    const wheelOuterR = RING_BASE + TOOTH_H;   // farthest radial extent (tooth tips)
    applyRadialTwoToneColors(merged, wheelOuterR, wheelColor, color, 0.4);
    mat.vertexColors = true;
  }

  if (!merged) {
    // Fallback — add all as separate meshes so wheel never disappears
    [midGeo, hubGeo, ringGeoL, ringGeoR].forEach(g => {
      group.add(new THREE.Mesh(g, mat));
    });
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  [midGeo, hubGeo, ringGeoL, ringGeoR].forEach(g => g.dispose());

  return group;
}


// ─── Wheel type 2: extruded spoked disc + hub cylinder ───────────────────────

function makeWheelType2(radius, width, color = 0x0c0c0c0, wheelColor = 0xfcd6a9) {
  const group = new THREE.Group();

  const OUTER_R   = radius;
  const RIM_IN_R  = radius * 0.78;
  const HUB_R     = radius * 0.32;
  const BORE_R    = radius * 0.07;
  const THICK     = width;
  const N_SPOKES  = 8;
  const GAP_FRAC  = 0.60;
  const HUB_CYL_R = radius * 0.18;
  const HUB_THICK = THICK + 0.05;

  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });

  const TWO_PI  = Math.PI * 2;
  const pitch   = TWO_PI / N_SPOKES;
  const halfGap = (pitch / 2) * GAP_FRAC;

  // Outer disc face with spoke cutouts
  const face = new THREE.Shape();
  face.absarc(0, 0, OUTER_R, 0, TWO_PI, false);

  // Central bore
  const boreHole = new THREE.Path();
  boreHole.absarc(0, 0, BORE_R, 0, TWO_PI, true);
  face.holes.push(boreHole);

  // Spoke gaps
  for (let i = 0; i < N_SPOKES; i++) {
    const center = pitch * i;
    const a0     = center - halfGap;
    const a1     = center + halfGap;

    const hole = new THREE.Path();
    hole.moveTo(HUB_R * Math.cos(a0), HUB_R * Math.sin(a0));
    hole.lineTo(RIM_IN_R * Math.cos(a0), RIM_IN_R * Math.sin(a0));
    hole.absarc(0, 0, RIM_IN_R, a0, a1, false);
    hole.lineTo(HUB_R * Math.cos(a1), HUB_R * Math.sin(a1));
    hole.absarc(0, 0, HUB_R, a1, a0, true);
    face.holes.push(hole);
  }

  // ExtrudeGeometry — already non-indexed, bake rotation into geo
  const wheelGeo = new THREE.ExtrudeGeometry(face, {
    depth: THICK,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 6,
  });
  wheelGeo.center();
  wheelGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));

  // CylinderGeometry — indexed, must convert to non-indexed
  const hubGeoRaw = new THREE.CylinderGeometry(HUB_CYL_R, HUB_CYL_R, HUB_THICK, 8, 1, false);
  const hubGeo    = hubGeoRaw.toNonIndexed();
  hubGeoRaw.dispose();

  // Merge into single draw call
  const merged = mergeGeometries([wheelGeo, hubGeo], false);

  if (merged) {
    applyRadialTwoToneColors(merged, OUTER_R, wheelColor, color, 0.75);
    mat.vertexColors = true;
  }

  if (!merged) {
    // Fallback — add separately so wheel never disappears
    group.add(new THREE.Mesh(wheelGeo, mat));
    group.add(new THREE.Mesh(hubGeo,   mat));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  [wheelGeo, hubGeo].forEach(g => g.dispose());

  return group;
}

// ─── Wheel type 3: spoked disc + center disk + hub cylinder ──────────────────

function makeWheelType3(radius, width, color = 0xc0c0c0, wheelColor = 0xfcd6a9) {
  const group = new THREE.Group();

  const OUTER_R       = radius;
  const RIM_IN_R      = radius * 0.78;
  const HUB_R         = radius * 0.32;
  const THICK         = width;
  const N_SPOKES      = 8;
  const GAP_FRAC      = 0.60;
  const HUB_CYL_R     = radius * 0.18;
  const HUB_CYL_THICK = THICK + 0.05;
  const DISK_R        = RIM_IN_R;
  const DISK_THICK    = THICK * 0.5;

  // Single unified material — all parts same color/properties
  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });

  const TWO_PI  = Math.PI * 2;
  const pitch   = TWO_PI / N_SPOKES;
  const halfGap = (pitch / 2) * GAP_FRAC;

  // Spoked face
  const face = new THREE.Shape();
  face.absarc(0, 0, OUTER_R, 0, TWO_PI, false);

  for (let i = 0; i < N_SPOKES; i++) {
    const center = pitch * i;
    const a0     = center - halfGap;
    const a1     = center + halfGap;

    const hole = new THREE.Path();
    hole.moveTo(HUB_R * Math.cos(a0), HUB_R * Math.sin(a0));
    hole.lineTo(RIM_IN_R * Math.cos(a0), RIM_IN_R * Math.sin(a0));
    hole.absarc(0, 0, RIM_IN_R, a0, a1, false);
    hole.lineTo(HUB_R * Math.cos(a1), HUB_R * Math.sin(a1));
    hole.absarc(0, 0, HUB_R, a1, a0, true);
    face.holes.push(hole);
  }

  // ExtrudeGeometry — already non-indexed, bake rotation into geo
  const wheelGeo = new THREE.ExtrudeGeometry(face, {
    depth: THICK,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 6,
  });
  wheelGeo.center();
  wheelGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));

  // CylinderGeometries — indexed, convert to non-indexed
  const diskGeoRaw = new THREE.CylinderGeometry(DISK_R,    DISK_R,    DISK_THICK,    16, 1, false);
  const hubGeoRaw  = new THREE.CylinderGeometry(HUB_CYL_R, HUB_CYL_R, HUB_CYL_THICK, 8, 1, false);

  const diskGeo = diskGeoRaw.toNonIndexed();
  const hubGeo  = hubGeoRaw.toNonIndexed();

  diskGeoRaw.dispose();
  hubGeoRaw.dispose();

  // Merge all three into single draw call
  const merged = mergeGeometries([wheelGeo, diskGeo, hubGeo], false);

  if (merged) {
    applyRadialTwoToneColors(merged, OUTER_R, wheelColor, color, 0.75);
    mat.vertexColors = true;
  }

  if (!merged) {
    // Fallback — add separately so wheel never disappears
    group.add(new THREE.Mesh(wheelGeo, mat));
    group.add(new THREE.Mesh(diskGeo,  mat));
    group.add(new THREE.Mesh(hubGeo,   mat));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  [wheelGeo, diskGeo, hubGeo].forEach(g => g.dispose());

  return group;
}

// ─── Wheel type 4: hollow ring + disk cap + straight hub + end caps ───────────

function makeWheelType4(radius, width, color = 0xc0c0c0, wheelColor = 0xfcd6a9) {
  const group = new THREE.Group();

  const SEGS     = 16;
  const HUB_SEGS = 8;

  const OUTER_R   = radius;
  const INNER_R   = radius * 0.75;
  const THICKNESS = width;          // ring thickness (thickest)
  const DISK_T    = width * 0.5;   // disk is very thin — just a flat plate
  const HUB_R     = radius * 0.22;
  const HUB_T     = THICKNESS * 1.1; // hub slightly wider than ring

  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.9,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  // ── Hollow tyre band (thickest part) ─────────────────────────────────────
  const ringShape = new THREE.Shape();
  ringShape.absarc(0, 0, OUTER_R, 0, Math.PI * 2, false);
  const ringHole = new THREE.Path();
  ringHole.absarc(0, 0, INNER_R, 0, Math.PI * 2, true);
  ringShape.holes.push(ringHole);

  const ringGeo = new THREE.ExtrudeGeometry(ringShape, {
    depth: THICKNESS,
    bevelEnabled: false,
    curveSegments: SEGS,
  });
  ringGeo.center();
  ringGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));

  // ── Thin solid disk — centered in the middle of the wheel ────────────────
  const diskShape = new THREE.Shape();
  diskShape.absarc(0, 0, INNER_R, 0, Math.PI * 2, false);

  const diskGeo = new THREE.ExtrudeGeometry(diskShape, {
    depth: DISK_T,
    bevelEnabled: false,
    curveSegments: SEGS,
  });
  diskGeo.center();
  diskGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  // sits centered at Y=0 (middle of the wheel) — no translation needed

  // ── Hub cylinder (slightly wider than ring) ───────────────────────────────
  const hubGeoRaw = new THREE.CylinderGeometry(HUB_R, HUB_R, HUB_T, HUB_SEGS);
  const hubGeo    = hubGeoRaw.toNonIndexed();
  hubGeoRaw.dispose();

  // ── Hub cap front ────────────────────────────────────────────────────────
  const capFGeoRaw = new THREE.CircleGeometry(HUB_R, HUB_SEGS);
  capFGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  capFGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, HUB_T / 2, 0));
  const capFGeo = capFGeoRaw.toNonIndexed();
  capFGeoRaw.dispose();

  // ── Hub cap back ─────────────────────────────────────────────────────────
  const capBGeoRaw = new THREE.CircleGeometry(HUB_R, HUB_SEGS);
  capBGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  capBGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, -HUB_T / 2, 0));
  const capBGeo = capBGeoRaw.toNonIndexed();
  capBGeoRaw.dispose();

 // ── Paint each piece explicitly before merging — these are shape-extruded
  // flat pieces with no interior vertex gradient, so paint solid colors
  // per-piece instead of computing a radial split on the merged result ──────
  paintGeometryUniform(ringGeo,  color);           // tire band → outer/dark color
  paintGeometryUniform(diskGeo,  wheelColor); // hub disk  → configurable inner color
  paintGeometryUniform(hubGeo,   wheelColor); // hub cylinder
  paintGeometryUniform(capFGeo,  wheelColor); // hub cap front
  paintGeometryUniform(capBGeo,  wheelColor); // hub cap back

  // ── Merge all ────────────────────────────────────────────────────────────
  const merged = mergeGeometries(
    [ringGeo, diskGeo, hubGeo, capFGeo, capBGeo], false
  );

  if (merged) {
    mat.vertexColors = true;
  }

  if (!merged) {
    [ringGeo, diskGeo, hubGeo, capFGeo, capBGeo].forEach(g => {
      group.add(new THREE.Mesh(g, mat));
    });
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  [ringGeo, diskGeo, hubGeo, capFGeo, capBGeo].forEach(g => g.dispose());

  return group;
}

// ─── Wheel type 5: hollow ring + holed disk (lightening holes) + hub ──────────

function makeWheelType5(radius, width, color = 0xc0c0c0, wheelColor = 0xfcd6a9) {
  const group = new THREE.Group();

  const SEGS     = 8;
  const HUB_SEGS = 8;

  const OUTER_R   = radius;
  const INNER_R   = radius * 0.83;
  const THICKNESS = width;
  const DISK_T    = width * 0.7;
  const HUB_R     = radius * 0.23;
  const HUB_T     = THICKNESS - 0.05;

  const N_HOLES     = 6;
  const HOLE_R      = radius * 0.20;
  const HOLE_CIRCLE = radius * 0.47;
  const HOLE_SEGS   = 4;

  // Single unified material
  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.9,
    flatShading: false,
    side: THREE.DoubleSide,
  });

  // ── Hollow outer ring — ExtrudeGeometry (non-indexed), bake rotation ──────
  const ringShape = new THREE.Shape();
  ringShape.absarc(0, 0, OUTER_R, 0, Math.PI * 2, false);
  const ringHole = new THREE.Path();
  ringHole.absarc(0, 0, INNER_R, 0, Math.PI * 2, true);
  ringShape.holes.push(ringHole);

  const ringGeo = new THREE.ExtrudeGeometry(ringShape, {
    depth: THICKNESS,
    bevelEnabled: false,
    curveSegments: SEGS,
  });
  ringGeo.center();
  ringGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));

  // ── Disk with bore + lightening holes — ExtrudeGeometry (non-indexed) ─────
  const diskShape = new THREE.Shape();
  diskShape.absarc(0, 0, INNER_R, 0, Math.PI * 2, false);

  const boreHole = new THREE.Path();
  boreHole.absarc(0, 0, HUB_R, 0, Math.PI * 2, true);
  diskShape.holes.push(boreHole);

  for (let i = 0; i < N_HOLES; i++) {
    const angle = (i / N_HOLES) * Math.PI * 2;
    const cx = Math.cos(angle) * HOLE_CIRCLE;
    const cy = Math.sin(angle) * HOLE_CIRCLE;
    const h = new THREE.Path();
    h.absarc(cx, cy, HOLE_R, 0, Math.PI * 2, true);
    diskShape.holes.push(h);
  }

  const diskGeo = new THREE.ExtrudeGeometry(diskShape, {
    depth: DISK_T,
    bevelEnabled: false,
    curveSegments: HOLE_SEGS,
  });
  diskGeo.center();
  diskGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));

  // ── Hub cylinder — CylinderGeometry (indexed), convert ───────────────────
  const hubGeoRaw = new THREE.CylinderGeometry(HUB_R, HUB_R, HUB_T, HUB_SEGS);
  const hubGeo    = hubGeoRaw.toNonIndexed();
  hubGeoRaw.dispose();

  // ── Cap front — CircleGeometry (indexed), bake rotation + position ────────
  const capFGeoRaw = new THREE.CircleGeometry(HUB_R, HUB_SEGS);
  capFGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  capFGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, HUB_T / 2, 0));
  const capFGeo = capFGeoRaw.toNonIndexed();
  capFGeoRaw.dispose();

  // ── Cap back — CircleGeometry (indexed), bake rotation + position ─────────
  const capBGeoRaw = new THREE.CircleGeometry(HUB_R, HUB_SEGS);
  capBGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  capBGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, -HUB_T / 2, 0));
  const capBGeo = capBGeoRaw.toNonIndexed();
  capBGeoRaw.dispose();

  // ── Merge all into single draw call ──────────────────────────────────────
  const merged = mergeGeometries([ringGeo, diskGeo, hubGeo, capFGeo, capBGeo], false);

  if (merged) {
    applyRadialTwoToneColors(merged, OUTER_R, wheelColor, color, 0.75);
    mat.vertexColors = true;
  }

  if (!merged) {
    // Fallback — add separately so wheel never disappears
    [ringGeo, diskGeo, hubGeo, capFGeo, capBGeo].forEach(g => {
      group.add(new THREE.Mesh(g, mat));
    });
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  [ringGeo, diskGeo, hubGeo, capFGeo, capBGeo].forEach(g => g.dispose());

  return group;
}

// ─── Wheel type 6: barrel ring + annular faces + lathe hub dishes + axle capsule + bolts ───

function makeWheelType6(radius, width, color = 0xc0c0c0, wheelColor = 0xfcd6a9) {
  const group = new THREE.Group();

  const SEG     = 12;
  const HUB_PTS = 3;

  const OUTER_R = radius;
  const INNER_R = radius * 0.775;
  const HUB_R   = radius * 0.183;
  const HALF_W  = width * 0.5;
  const BOLT_W  = width * 1.1;
  const HUB_X   = radius * 0.007;
  const HUB_W   = width;

  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });

  const allGeos = [];

  // 1. Outer hollow barrel (open-ended cylinder)
  const barrelRaw = new THREE.CylinderGeometry(OUTER_R, OUTER_R, HALF_W * 2, SEG, 1, true);
  barrelRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(0));
  const barrelGeo = barrelRaw.toNonIndexed();
  barrelRaw.dispose();
  allGeos.push(barrelGeo);

  // 2. Flat annular face rings (front + back)
  function buildAnnulus(yPos) {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, OUTER_R, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, INNER_R, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const raw = new THREE.ShapeGeometry(shape, 6);
    raw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    raw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, yPos, 0));
    const geo = raw.toNonIndexed();
    raw.dispose();
    return geo;
  }
  allGeos.push(buildAnnulus( HALF_W));
  allGeos.push(buildAnnulus(-HALF_W));

  // 3. Curved hub dishes (LatheGeometry)
  const hubDepth = HALF_W - HUB_X + 0.01;
  const HUB_PAD  = radius * 0.023;
  const hubPoints = [];
  for (let i = 0; i <= HUB_PTS; i++) {
    const t     = i / HUB_PTS;
    const angle = t * Math.PI * 0.5;
    const r = HUB_R + HUB_PAD + (INNER_R - HUB_R) * Math.sin(angle);
    const h = hubDepth * (1 - Math.cos(angle));
    hubPoints.push(new THREE.Vector2(r, h));
  }
  const hubLatheRaw = new THREE.LatheGeometry(hubPoints, SEG);
  hubLatheRaw.computeVertexNormals();

  // Front dish
  const hubFrontRaw = hubLatheRaw.clone();
  hubFrontRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, -0.5 * width, 0));
  const hubFrontGeo = hubFrontRaw.toNonIndexed();
  hubFrontRaw.dispose();
  allGeos.push(hubFrontGeo);

  // Back dish (mirrored via 180° X rotation — preserves winding/normals)
  const hubBackRaw = hubLatheRaw.clone();
  hubBackRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
  hubBackRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0.5 * width, 0));
  const hubBackGeo = hubBackRaw.toNonIndexed();
  hubBackRaw.dispose();
  allGeos.push(hubBackGeo);

  hubLatheRaw.dispose();

  // 4. Axle cylinder
  const axleR   = HUB_R + HUB_PAD;
  const axleRaw = new THREE.CylinderGeometry(axleR * 2, axleR * 2, HUB_W, SEG, 1, false);
  const axleGeo = axleRaw.toNonIndexed();
  axleRaw.dispose();
  allGeos.push(axleGeo);

  // 4b. Capsule in center (cylinder + two sphere caps)
  const capsuleR      = radius * 0.26;
  const capsuleLength = width * 1.1;

  const capCylRaw = new THREE.CylinderGeometry(capsuleR, capsuleR, capsuleLength, 8, 1);
  const capCylGeo = capCylRaw.toNonIndexed();
  capCylRaw.dispose();
  allGeos.push(capCylGeo);

  const sphereRaw = new THREE.SphereGeometry(capsuleR, 8, 8);

  const sphereLGeo = sphereRaw.toNonIndexed();
  sphereLGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(0,  capsuleLength * 0.5, 0));
  allGeos.push(sphereLGeo);

  const sphereRGeo = sphereRaw.toNonIndexed();
  sphereRGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, -capsuleLength * 0.5, 0));
  allGeos.push(sphereRGeo);

  sphereRaw.dispose();

  // 5. Axle bolts (cylinders around capsule)
  const axleBoltR     = capsuleR + radius * 0.06;
  const axleBoltCount = 5;
  const axleBoltRaw   = new THREE.CylinderGeometry(radius * 0.046, radius * 0.046, BOLT_W, 5, 1);

  for (let i = 0; i < axleBoltCount; i++) {
    const angle = (i / axleBoltCount) * Math.PI * 2;
    const bGeo  = axleBoltRaw.clone();
    bGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(
      Math.sin(angle) * axleBoltR,
      0,
      Math.cos(angle) * axleBoltR
    ));
    const bGeoNI = bGeo.toNonIndexed();
    bGeo.dispose();
    allGeos.push(bGeoNI);
  }
  axleBoltRaw.dispose();

  // 6. Trapezoid bolts around rim
  function makeTrapezoidGeo(innerW, outerW, innerD, outerD, height) {
    const hw = height * 0.5;
    const positions = new Float32Array([
      -innerD*0.5, -innerW*0.5, -hw,
      -innerD*0.5,  innerW*0.5, -hw,
       innerD*0.5,  innerW*0.5, -hw,
       innerD*0.5, -innerW*0.5, -hw,
      -outerD*0.5, -outerW*0.5,  hw,
      -outerD*0.5,  outerW*0.5,  hw,
       outerD*0.5,  outerW*0.5,  hw,
       outerD*0.5, -outerW*0.5,  hw,
    ]);
    const indices = [
      0,1,2, 0,2,3,
      4,6,5, 4,7,6,
      1,5,6, 1,6,2,
      0,3,7, 0,7,4,
      0,4,5, 0,5,1,
      3,2,6, 3,6,7,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  const boltCount = 10;
  const boltR     = HUB_R + HUB_PAD + (INNER_R - HUB_R) * 0.7;

  for (let i = 0; i < boltCount; i++) {
    const angle = (i / boltCount) * Math.PI * 2;
    const sinA  = Math.sin(angle);
    const cosA  = Math.cos(angle);

    const boltGeoRaw = makeTrapezoidGeo(
      radius * 0.3,   // innerW
      HALF_W * 1.95,   // outerW
      radius * 0.1,   // innerD
      radius * 0.2,   // outerD
      radius * 0.6   // height
    );

    // The trapezoid's local Z is the radial direction; rotate so Z points outward
    // Original prototype: bolt.rotation.x = -angle rotates around X
    // In track.js axis convention (Y is axle), we rotate around Y
    boltGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationY(angle));
    boltGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(
      sinA * boltR,
      HUB_X,
      cosA * boltR
    ));

    const boltGeoNI = boltGeoRaw.toNonIndexed();
    boltGeoRaw.dispose();
    allGeos.push(boltGeoNI);
  }

  // ── Merge all into single draw call ──────────────────────────────────────
  allGeos.forEach(g => {
  if (g.hasAttribute('uv')) g.deleteAttribute('uv');
  if (g.hasAttribute('uv2')) g.deleteAttribute('uv2');
  });
  const merged = mergeGeometries(allGeos, false);

  if (merged) {
    applyRadialTwoToneColors(merged, OUTER_R, wheelColor, color, 0.75);
    mat.vertexColors = true;
  }

  if (!merged) {
    allGeos.forEach(g => group.add(new THREE.Mesh(g, mat)));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  allGeos.forEach(g => g.dispose());

  return group;
}

function makeWheelType7(radius, width, color = 0xc0c0c0, side = 1, wheelColor = 0xfcd6a9) {
  const group = new THREE.Group();

  const SEG     = 12;
  const HUB_PTS = 3;

  const OUTER_R = radius;
  const INNER_R = radius * 0.775;
  const HUB_R   = radius * 0.183;
  const HALF_W  = width * 0.5;
  const BOLT_W  = width * 1.1;
  const HUB_X   = radius * 0.007;
  const HUB_W   = width;

  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });

  const allGeos = [];

  // 1. Outer hollow barrel (open-ended cylinder)
  const barrelRaw1 = new THREE.CylinderGeometry(OUTER_R, OUTER_R, HALF_W * 0.6, SEG, 1, true);
  barrelRaw1.applyMatrix4(new THREE.Matrix4().makeRotationX(0));
  barrelRaw1.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0.125, 0));
  const barrelGeo1 = barrelRaw1.toNonIndexed();
  barrelRaw1.dispose();
  allGeos.push(barrelGeo1);

  const barrelRaw2 = new THREE.CylinderGeometry(OUTER_R, OUTER_R, HALF_W * 0.6, SEG, 1, true);
  barrelRaw2.applyMatrix4(new THREE.Matrix4().makeRotationX(0));
  barrelRaw2.applyMatrix4(new THREE.Matrix4().makeTranslation(0, -0.125, 0));
  const barrelGeo2 = barrelRaw2.toNonIndexed();
  barrelRaw2.dispose();
  allGeos.push(barrelGeo2);

  // 2. Flat annular face rings (front + back)
  function buildAnnulus(yPos) {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, OUTER_R, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, INNER_R, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const raw = new THREE.ShapeGeometry(shape, 6);
    raw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    raw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, yPos, 0));
    const geo = raw.toNonIndexed();
    raw.dispose();
    return geo;
  }
  allGeos.push(buildAnnulus( HALF_W));
  allGeos.push(buildAnnulus(-HALF_W));

  // 3. Curved hub dish cylinder — taper direction flips with side
  // side =  1 (right): big face outward → radiusTop = big, radiusBottom = small
  // side = -1 (left):  big face outward → radiusTop = small, radiusBottom = big
  const hubCylRaw = new THREE.CylinderGeometry(
    side > 0 ? HUB_R * 2.5 : OUTER_R,   // radiusTop
    side > 0 ? OUTER_R     : HUB_R * 2.5, // radiusBottom
    HALF_W * 2.2,
    SEG,
    1,
    false
  );
  hubCylRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, side * 0.05, 0));
  const hubCylGeo = hubCylRaw.toNonIndexed();
  hubCylRaw.dispose();
  allGeos.push(hubCylGeo);

  // 4. Axle cylinder
  const HUB_PAD = radius * 0.02;   
  // const axleR   = HUB_R + HUB_PAD;
  // const axleRaw = new THREE.CylinderGeometry(axleR * 3, axleR * 3, HUB_W, SEG, 1, false);
  // const axleGeo = axleRaw.toNonIndexed();
  // axleRaw.dispose();
  // allGeos.push(axleGeo);

  // 4b. Capsule in center (cylinder + two sphere caps)
  const capsuleR      = radius * 0.26;
  const capsuleLength = width * 1.1;


  // 5. Axle bolts (cylinders around capsule)
  const axleBoltR     = capsuleR + radius * 0.001;
  const axleBoltCount = 5;
  const axleBoltRaw   = new THREE.CylinderGeometry(radius * 0.08, radius * 0.08, BOLT_W * 1.4, 5, 1);

  for (let i = 0; i < axleBoltCount; i++) {
    const angle = (i / axleBoltCount) * Math.PI * 2;
    const bGeo  = axleBoltRaw.clone();
    bGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(
      Math.sin(angle) * axleBoltR,
      0,
      Math.cos(angle) * axleBoltR
    ));
    const bGeoNI = bGeo.toNonIndexed();
    bGeo.dispose();
    allGeos.push(bGeoNI);
  }
  axleBoltRaw.dispose();

  // 6. Trapezoid bolts around rim
  function makeTrapezoidGeo(innerW, outerW, innerD, outerD, height) {
    const hw = height * 0.5;
    const positions = new Float32Array([
      -innerD*0.5, -innerW*0.5, -hw,
      -innerD*0.5,  innerW*0.5, -hw,
       innerD*0.5,  innerW*0.5, -hw,
       innerD*0.5, -innerW*0.5, -hw,
      -outerD*0.5, -outerW*0.5,  hw,
      -outerD*0.5,  outerW*0.5,  hw,
       outerD*0.5,  outerW*0.5,  hw,
       outerD*0.5, -outerW*0.5,  hw,
    ]);
    const indices = [
      0,1,2, 0,2,3,
      4,6,5, 4,7,6,
      1,5,6, 1,6,2,
      0,3,7, 0,7,4,
      0,4,5, 0,5,1,
      3,2,6, 3,6,7,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  const boltCount = 10;
  const boltR     = HUB_R + HUB_PAD + (INNER_R - HUB_R) * 0.7;

  for (let i = 0; i < boltCount; i++) {
    const angle = (i / boltCount) * Math.PI * 2;
    const sinA  = Math.sin(angle);
    const cosA  = Math.cos(angle);

    const boltGeoRaw = makeTrapezoidGeo(
      radius * 1.5,   // innerW
      HALF_W * 1.95,   // outerW
      radius * 0.2,   // innerD
      radius * 0.2,   // outerD
      radius * 0.6   // height
    );

    // The trapezoid's local Z is the radial direction; rotate so Z points outward
    // Original prototype: bolt.rotation.x = -angle rotates around X
    // In track.js axis convention (Y is axle), we rotate around Y
    boltGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationY(angle));
    boltGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(
      sinA * boltR,
      HUB_X,
      cosA * boltR
    ));

    const boltGeoNI = boltGeoRaw.toNonIndexed();
    boltGeoRaw.dispose();
    allGeos.push(boltGeoNI);
  }

  // ── Merge all into single draw call ──────────────────────────────────────
  allGeos.forEach(g => {
  if (g.hasAttribute('uv')) g.deleteAttribute('uv');
  if (g.hasAttribute('uv2')) g.deleteAttribute('uv2');
  });
  const merged = mergeGeometries(allGeos, false);

  if (merged) {
    applyRadialTwoToneColors(merged, OUTER_R, wheelColor, color, 0.75);
    mat.vertexColors = true;
  }

  if (!merged) {
    allGeos.forEach(g => group.add(new THREE.Mesh(g, mat)));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  allGeos.forEach(g => g.dispose());

  return group;
}

// ─── Router: replaces the old makeSprockedMesh() call ────────────────────────

function makeSprockedMesh(radius, width, color, _tc, _th, _tw, _tt, wheelType = 1, side = 1, wheelColor = 0xfcd6a9) {
  if (wheelType === 2) return makeWheelType2(radius, width, color, wheelColor);
  if (wheelType === 3) return makeWheelType3(radius, width, color, wheelColor);
  if (wheelType === 4) return makeWheelType4(radius, width, color, wheelColor);
  if (wheelType === 5) return makeWheelType5(radius, width, color, wheelColor);
  if (wheelType === 6) return makeWheelType6(radius, width, color, wheelColor);
  if (wheelType === 7) return makeWheelType7(radius, width, color, side, wheelColor);
  return makeWheelType1(radius, width, color, wheelColor);
}

/**
 * Build a road-wheel or return-roller visual:
 *   • a thin outer ring  (small radius, low-poly cylinder)
 *   • a central hub cube
 *   connected by four thin spoke-like quads (optional, cheap visual interest)
 *
 * @param {number} outerRadius – outer ring radius
 * @param {number} ringWidth     – axial thickness of the main disc
 * @param {number} color         – hex colour
 * @param {number} hubSize       – half-extent of the central cube
 * @param {number} ringThickness – radial thickness of the thin outer offset ring
 */
function makeRoadWheelMesh(
  outerRadius,
  ringWidth,
  color = 0xc0c0c0,
  hubSize   = 0.06,
  ringThick = 0.09,
  wheelType = 1,
  side = 1,
  wheelColor = 0xfcd6a9
) {
  // ── Route to type 2 ────────────────────────────────────────────────────────
  if (wheelType === 2) return makeRoadWheelType2(outerRadius, ringWidth, color, side, wheelColor);
  if (wheelType === 3) return makeRoadWheelType3(outerRadius, ringWidth, color, side, wheelColor);
  if (wheelType === 4) return makeRoadWheelType4(outerRadius, ringWidth, color, side, wheelColor);
  if (wheelType === 5) return makeRoadWheelType5(outerRadius, ringWidth, color, side, wheelColor);


  // ── Type 1 — single merged draw call ──────────────────────────────────────
  const group = new THREE.Group();
  const mat   = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.1 });

  const ringOuterR = outerRadius + 0.02;
  const ringBodyW  = ringWidth * 0.45;

  // All three are CylinderGeometry (indexed) — convert all to non-indexed
  const discGeoRaw = new THREE.CylinderGeometry(outerRadius - ringThick * 0.8, outerRadius - ringThick * 0.8, ringWidth, 12);
  const ringGeoRaw = new THREE.CylinderGeometry(ringOuterR, ringOuterR, ringBodyW, 12);
  const hubGeoRaw  = new THREE.CylinderGeometry(hubSize, hubSize, ringWidth * 1.5, 5);

  const discGeo = discGeoRaw.toNonIndexed();
  const ringGeo = ringGeoRaw.toNonIndexed();
  const hubGeo  = hubGeoRaw.toNonIndexed();

  [discGeoRaw, ringGeoRaw, hubGeoRaw].forEach(g => g.dispose());

  // Merge all into single draw call
  const merged = mergeGeometries([discGeo, ringGeo, hubGeo], false);

  if (merged) {
    applyRadialTwoToneColors(merged, ringOuterR, wheelColor, color, 0.75);
    mat.vertexColors = true;
  }

  if (!merged) {
    // Fallback — add separately so wheel never disappears
    [discGeo, ringGeo, hubGeo].forEach(g => {
      group.add(new THREE.Mesh(g, mat));
    });
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  [discGeo, ringGeo, hubGeo].forEach(g => g.dispose());

  return group;
}

function makeRoadWheelType2(outerRadius, ringWidth, color = 0xc0c0c0, side = 1, wheelColor = 0xfcd6a9) {
  const group = new THREE.Group();

  const SEGS     = 16;
  const HUB_SEGS = 8;

  const OUTER_R   = outerRadius + 0.02; //the 0.045 value is calulated from the first roadwheel ,it is assumed as base, and since the wheel radi has 0.045 extra radius so that the wheel touch the belt
  const INNER_R   = outerRadius * 0.83;
  const THICKNESS = ringWidth * 0.7;
  const DISK_T    = outerRadius * 0.043;
  const HUB_R     = outerRadius * 0.44;
  const HUB_R_OUT = outerRadius * 0.30;
  const HUB_T     = THICKNESS * 1.05;
  const GAP       = ringWidth * 0.2;
  const CON_R     = outerRadius * 0.29;

  // Single unified material
  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.9,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  const wheelAOffset = (side > 0 ?  1 : -1) * (GAP / 2 + THICKNESS / 2);
  const wheelBOffset = (side > 0 ? -1 :  1) * (GAP / 2 + THICKNESS / 2);
  const diskOffset   = (side > 0 ? -1 :  1) * (THICKNESS / 2 + DISK_T / 2);
  const capFOffset   = side > 0 ? -HUB_T / 2 :  HUB_T / 2;
  const capBOffset   = side > 0 ?  HUB_T / 2 : -HUB_T / 2;
  const capFRotX     = side > 0 ? -Math.PI / 2 :  Math.PI / 2;
  const capBRotX     = side > 0 ?  Math.PI / 2 : -Math.PI / 2;

  // ── Ring (ExtrudeGeometry — non-indexed) ───────────────────────────────────
  const shape = new THREE.Shape();
  shape.absarc(0, 0, OUTER_R, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, INNER_R, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const ringGeo = new THREE.ExtrudeGeometry(shape, {
    depth: THICKNESS, bevelEnabled: false, curveSegments: 8,
  });
  ringGeo.center();
  ringGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  ringGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset, 0));

  // ── Disk cap (CylinderGeometry — indexed → non-indexed) ───────────────────
  const diskGeoRaw = new THREE.CylinderGeometry(INNER_R, INNER_R, DISK_T, SEGS);
  diskGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, diskOffset + wheelAOffset, 0));
  const diskGeo = diskGeoRaw.toNonIndexed();
  diskGeoRaw.dispose();

  // ── WheelB cylinder (CylinderGeometry — indexed → non-indexed) ────────────
  const cylGeoRaw = new THREE.CylinderGeometry(OUTER_R, OUTER_R, THICKNESS, SEGS);
  cylGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelBOffset, 0));
  const cylGeo = cylGeoRaw.toNonIndexed();
  cylGeoRaw.dispose();

  // ── Hub (CylinderGeometry — indexed → non-indexed) ────────────────────────
  const hubGeoRaw = side > 0
    ? new THREE.CylinderGeometry(HUB_R_OUT, HUB_R,     HUB_T, HUB_SEGS)
    : new THREE.CylinderGeometry(HUB_R,     HUB_R_OUT, HUB_T, HUB_SEGS);
  hubGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset, 0));
  const hubGeo = hubGeoRaw.toNonIndexed();
  hubGeoRaw.dispose();

  // ── Cap front (CircleGeometry — indexed → non-indexed) ────────────────────
  const capFGeoRaw = new THREE.CircleGeometry(HUB_R_OUT, HUB_SEGS);
  capFGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(capFRotX));
  capFGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, capFOffset + wheelAOffset, 0));
  const capFGeo = capFGeoRaw.toNonIndexed();
  capFGeoRaw.dispose();

  // ── Connector axle (CylinderGeometry — indexed → non-indexed) ────────────
  const conGeoRaw = new THREE.CylinderGeometry(CON_R, CON_R, GAP, HUB_SEGS);
  const conGeo    = conGeoRaw.toNonIndexed();
  conGeoRaw.dispose();

  // ── Merge ALL into single draw call ───────────────────────────────────────
  const merged = mergeGeometries(
    [ringGeo, diskGeo, cylGeo, hubGeo, capFGeo, conGeo], false
  );

  if (merged) {
    applyRadialTwoToneColors(merged, OUTER_R, wheelColor, color, 0.75);
    mat.vertexColors = true;
  }

  if (!merged) {
    // Fallback — add separately so wheel never disappears
    [ringGeo, diskGeo, cylGeo, hubGeo, capFGeo, conGeo].forEach(g => {
      group.add(new THREE.Mesh(g, mat));
    });
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  [ringGeo, diskGeo, cylGeo, hubGeo, capFGeo, conGeo].forEach(g => g.dispose());

  return group;
}

function makeRoadWheelType3(outerRadius, ringWidth, color = 0xc0c0c0, side = 1, wheelColor = 0xfcd6a9) {
  const group = new THREE.Group();

  const OUTER_R   = outerRadius + 0.02;
  const RIM_IN_R  = outerRadius * 0.78;
  const HUB_R     = outerRadius * 0.32;
  const THICK     = ringWidth * 0.7;
  const N_SPOKES  = 8;
  const GAP_FRAC  = 0.60;
  const HUB_CYL_R = outerRadius * 0.18;
  const HUB_THICK = THICK + 0.05;

  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });

  const TWO_PI  = Math.PI * 2;
  const pitch   = TWO_PI / N_SPOKES;
  const halfGap = (pitch / 2) * GAP_FRAC;

  const face = new THREE.Shape();
  face.absarc(0, 0, OUTER_R, 0, TWO_PI, false);

  const boreHole = new THREE.Path();
  boreHole.absarc(0, 0, outerRadius * 0.07, 0, TWO_PI, true);
  face.holes.push(boreHole);

  for (let i = 0; i < N_SPOKES; i++) {
    const center = pitch * i;
    const a0     = center - halfGap;
    const a1     = center + halfGap;
    const hole   = new THREE.Path();
    hole.moveTo(HUB_R * Math.cos(a0), HUB_R * Math.sin(a0));
    hole.lineTo(RIM_IN_R * Math.cos(a0), RIM_IN_R * Math.sin(a0));
    hole.absarc(0, 0, RIM_IN_R, a0, a1, false);
    hole.lineTo(HUB_R * Math.cos(a1), HUB_R * Math.sin(a1));
    hole.absarc(0, 0, HUB_R, a1, a0, true);
    face.holes.push(hole);
  }

  const wheelGeo = new THREE.ExtrudeGeometry(face, {
    depth: THICK,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 6,
  });
  wheelGeo.center();
  wheelGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));

  const hubGeoRaw = new THREE.CylinderGeometry(HUB_CYL_R, HUB_CYL_R, HUB_THICK, 5, 1, false);
  const hubGeo    = hubGeoRaw.toNonIndexed();
  hubGeoRaw.dispose();

  const merged = mergeGeometries([wheelGeo, hubGeo], false);

  if (merged) {
    applyRadialTwoToneColors(merged, OUTER_R, wheelColor, color, 0.75);
    mat.vertexColors = true;
  }

  if (!merged) {
    group.add(new THREE.Mesh(wheelGeo, mat));
    group.add(new THREE.Mesh(hubGeo,   mat));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  [wheelGeo, hubGeo].forEach(g => g.dispose());
  return group;
}

function makeRoadWheelType4(outerRadius, ringWidth, color = 0xc0c0c0, side = 1, wheelColor = 0xfcd6a9 ) {
  const group = new THREE.Group();

  const SEGS     = 7;
  const HUB_SEGS = 8;

  const OUTER_R   = outerRadius + 0.02;
  const INNER_R   = outerRadius * 0.83;
  const THICKNESS = ringWidth * 0.7;
  const DISK_T    = THICKNESS / 2;
  const HUB_R     = outerRadius * 0.3;
  const HUB_T     = THICKNESS * 1.05;
  const GAP       = ringWidth * 0.2;

  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.9,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  const wheelAOffset = (side > 0 ?  1 : -1) * (GAP / 2 + THICKNESS / 2);
  const wheelBOffset = (side > 0 ? -1 :  1) * (GAP / 2 + THICKNESS / 2);
  // disk sits on the inner face of wheelA, direction flips with side
  const diskOffset   = (side > 0 ? -1 :  1) * (THICKNESS / 2 - DISK_T / 2);

  // ── Hollow ring ──────────────────────────────────────────────────────────
  const shape = new THREE.Shape();
  shape.absarc(0, 0, OUTER_R, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, INNER_R, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const ringGeo = new THREE.ExtrudeGeometry(shape, {
    depth: THICKNESS,
    bevelEnabled: false,
    curveSegments: 5,
  });
  ringGeo.center();
  ringGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  ringGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset, 0));

  // ── Disk cap ─────────────────────────────────────────────────────────────
  const diskGeoRaw = new THREE.CylinderGeometry(INNER_R, INNER_R, DISK_T, 14);
  diskGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(
    0,
    wheelAOffset + diskOffset,   // ← side-aware
    0
  ));
  const diskGeo = diskGeoRaw.toNonIndexed();
  diskGeoRaw.dispose();

  // ── WheelB cylinder ───────────────────────────────────────────────────────
  const cylGeoRaw = new THREE.CylinderGeometry(OUTER_R, OUTER_R, THICKNESS, 10);
  cylGeoRaw.rotateY(side > 0 ? Math.PI / 3.2 : -Math.PI / 3.2);
  cylGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelBOffset, 0));
  const cylGeo = cylGeoRaw.toNonIndexed();
  cylGeoRaw.dispose();

  // ── Hub cylinder ──────────────────────────────────────────────────────────
  const hubGeoRaw = new THREE.CylinderGeometry(HUB_R, HUB_R, HUB_T, HUB_SEGS);
  hubGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset, 0));
  const hubGeo = hubGeoRaw.toNonIndexed();
  hubGeoRaw.dispose();

  // ── Cap front ─────────────────────────────────────────────────────────────
  const capFRotX = side > 0 ?  Math.PI / 2 : -Math.PI / 2;
  const capFGeoRaw = new THREE.CircleGeometry(HUB_R, HUB_SEGS);
  capFGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(capFRotX));
  capFGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset + HUB_T / 2, 0));
  const capFGeo = capFGeoRaw.toNonIndexed();
  capFGeoRaw.dispose();

  // ── Cap back ──────────────────────────────────────────────────────────────
  const capBRotX = side > 0 ? -Math.PI / 2 :  Math.PI / 2;
  const capBGeoRaw = new THREE.CircleGeometry(HUB_R, HUB_SEGS);
  capBGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(capBRotX));
  capBGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset - HUB_T / 2, 0));
  const capBGeo = capBGeoRaw.toNonIndexed();
  capBGeoRaw.dispose();

  // ── Merge ─────────────────────────────────────────────────────────────────
  const merged = mergeGeometries([ringGeo, diskGeo, cylGeo, hubGeo, capFGeo, capBGeo], false);

  if (merged) {
    applyRadialTwoToneColors(merged, OUTER_R, wheelColor, color, 0.75);
    mat.vertexColors = true;
  }

  if (!merged) {
    [ringGeo, diskGeo, cylGeo, hubGeo, capFGeo, capBGeo].forEach(g => {
      group.add(new THREE.Mesh(g, mat));
    });
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  [ringGeo, diskGeo, cylGeo, hubGeo, capFGeo, capBGeo].forEach(g => g.dispose());
  return group;
}

// ⬇⬇⬇ ADD THIS NEW FUNCTION ⬇⬇⬇

function makeRoadWheelType5(outerRadius, ringWidth, color = 0xc0c0c0, side = 1, wheelColor = 0xfcd6a9) {
  const group = new THREE.Group();

  const SEG     = 12;   // radial segments — barrel + hub lathe resolution
  const HUB_PTS = 3;    // hub-dish curve resolution

  const OUTER_R = outerRadius + 0.02;
  const INNER_R = OUTER_R * 0.775;
  const HALF_W  = ringWidth * 0.15;
  const HUB_R   = OUTER_R * 0.183;
  const HUB_X   = OUTER_R * 0.007;
  const HUB_PAD = OUTER_R * 0.023;   // small radial offset baked into hub/axle radius

  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });

  const allGeos = [];

  // ── Outer hollow barrel — open-ended cylinder, axis already = Y ───────────
  const barrelRaw = new THREE.CylinderGeometry(OUTER_R, OUTER_R, HALF_W * 2, SEG, 1, true);
  const barrelGeo = barrelRaw.toNonIndexed();
  barrelRaw.dispose();
  allGeos.push(barrelGeo);

  // ── Flat annular face rings (front + back) ─────────────────────────────────
  function buildAnnulus(yPos) {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, OUTER_R, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, INNER_R, 0, Math.PI * 2, true);
    shape.holes.push(hole);

    const raw = new THREE.ShapeGeometry(shape, 6);
    // Shape lies in XY by default — rotate so its circular face is perpendicular
    // to Y (matches the barrel's cross-section), then push it out to ±HALF_W.
    raw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    raw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, yPos, 0));
    const geo = raw.toNonIndexed();
    raw.dispose();
    return geo;
  }
  allGeos.push(buildAnnulus( HALF_W));
  allGeos.push(buildAnnulus(-HALF_W));

  // ── Curved hub dishes — LatheGeometry revolves around Y by default ─────────
  const hubDepth = HALF_W - HUB_X;
  const hubPoints = [];
  for (let i = 0; i <= HUB_PTS; i++) {
    const t     = i / HUB_PTS;
    const angle = t * Math.PI * 0.5;
    const r = HUB_R + HUB_PAD + (INNER_R - HUB_R) * Math.sin(angle);
    const h = hubDepth * (1 - Math.cos(angle));
    hubPoints.push(new THREE.Vector2(r, h));
  }
  const hubLatheRaw = new THREE.LatheGeometry(hubPoints, SEG);
  hubLatheRaw.computeVertexNormals();

  // Front dish: hub end (y=0) → +HUB_X, rim end (y=hubDepth) → +HALF_W
  const hubFrontRaw = hubLatheRaw.clone();
  hubFrontRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, HUB_X, 0));
  const hubFrontGeo = hubFrontRaw.toNonIndexed();
  hubFrontRaw.dispose();
  allGeos.push(hubFrontGeo);

  // Back dish: mirror in Y, hub end → -HUB_X, rim end → -HALF_W
  // Back dish: mirror in Y via a proper rotation (NOT a reflection scale —
  // negative-scale mirrors flip normals but not winding order, which breaks
  // lighting). A 180° rotation about X gives the same mirrored shape since
  // the lathe profile is rotationally symmetric, but keeps winding/normals consistent.
  const hubBackRaw = hubLatheRaw.clone();
  hubBackRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
  hubBackRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, -HUB_X, 0));
  const hubBackGeo = hubBackRaw.toNonIndexed();
  hubBackRaw.dispose();
  allGeos.push(hubBackGeo);

  hubLatheRaw.dispose();

  // ── Axle cylinder, axis = Y ────────────────────────────────────────────────
  const axleR = HUB_R + HUB_PAD;
  const axleRaw = new THREE.CylinderGeometry(axleR, axleR, HUB_X * 10, SEG, 1, false);
  const axleGeo = axleRaw.toNonIndexed();
  axleRaw.dispose();
  allGeos.push(axleGeo);

  // ── Merge into a single draw call ──────────────────────────────────────────
  const merged = mergeGeometries(allGeos, false);

  if (merged) {
    applyRadialTwoToneColors(merged, OUTER_R, wheelColor, color, 0.75);
    mat.vertexColors = true;
  }

  if (!merged) {
    allGeos.forEach(g => group.add(new THREE.Mesh(g, mat)));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);

  allGeos.forEach(g => g.dispose());

  return group;
}

// ⬆⬆⬆ END NEW FUNCTION ⬆⬆⬆

function makeBogieWheelMesh(outerRadius, width, type = 1) {
  if (type === 2) return makeBogieWheelMeshType2(outerRadius, width);

  // ── Original Type 1 (unchanged) ──────────────────────────────────────────
  const group = new THREE.Group();
  const OUTER_R = outerRadius + 0.045;
  const mat = new THREE.MeshStandardMaterial({ color: 0x4d4d4d, roughness: 0.9, metalness: 0.1 });
  const geos = [];

  const midGeo = new THREE.CylinderGeometry(OUTER_R, OUTER_R, width * 0.55, 12);
  midGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  geos.push(midGeo);

  const innerGeo = new THREE.CylinderGeometry(OUTER_R * 0.58, OUTER_R * 0.58, width * 0.6, 6);
  innerGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  geos.push(innerGeo);

  const merged = mergeGeometries(geos);
  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);
  geos.forEach(g => g.dispose());
  return group;
}

function makeBogieWheelMeshType2(outerRadius, width, color = 0x2e2e2e, wheelColor = 0xfcd6a9) {
  const group = new THREE.Group();

  const mat = (c, rough, metal) => new THREE.MeshStandardMaterial({
    color: c, roughness: rough, metalness: metal, vertexColors: true,
  });

  const midR  = outerRadius * 0.72;
  const midGeoRaw = new THREE.CylinderGeometry(midR, midR, width * 0.55, 16);
  midGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const midGeo = midGeoRaw.toNonIndexed();
  midGeoRaw.dispose();

  const innerR = outerRadius * 0.42;
  const innerGeoRaw = new THREE.CylinderGeometry(innerR, innerR, width * 0.8, 8);
  innerGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const innerGeo = innerGeoRaw.toNonIndexed();
  innerGeoRaw.dispose();

  const hubR = outerRadius * 0.15;
  const hubGeoRaw = new THREE.CylinderGeometry(hubR, hubR, width * 1.2, 5);
  hubGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const hubGeo = hubGeoRaw.toNonIndexed();
  hubGeoRaw.dispose();

  paintGeometryUniform(midGeo,   color);
  paintGeometryUniform(innerGeo, wheelColor);
  paintGeometryUniform(hubGeo,   wheelColor);

  const merged = mergeGeometries([midGeo, innerGeo, hubGeo], false);

  if (!merged) {
    const meshes = [
      [midGeo,   mat(color,      0.65, 0.45)],
      [innerGeo, mat(wheelColor, 0.60, 0.50)],
      [hubGeo,   mat(wheelColor, 0.70, 0.50)],
    ];
    meshes.forEach(([g, m]) => group.add(new THREE.Mesh(g, m)));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat(color, 0.65, 0.45));
  mesh.castShadow = false;
  group.add(mesh);

  [midGeo, innerGeo, hubGeo].forEach(g => g.dispose());
  return group;
}

function makeBogieArmMesh(halfSpan, s = 1.0, side = 1, type = 1) {
  if (type === 2) return makeBogieArmMeshType2(halfSpan, s, side);

  // ── Original Type 1 (unchanged) ──────────────────────────────────────────
  const group = new THREE.Group();
  group.userData.parts = [];

  const barThick = 0.030 * s;
  const barDepth = 0.02  * s;
  const frameZ   = 0.10  * s * -side;
  const frameZ2  = 0.10  * s *  side;

  const bottomY       = 0;
  const topY          = 0.17 * s * 1.1;
  const topCenterPinY = 0.17 * s * 1.5;

  const mat = new THREE.MeshStandardMaterial({
    color: this.wheelColor, roughness: 0.77, metalness: 0.38,
  });

  const allGeos = [];

  function addBar(ax, ay, bx, by, z) {
    const len  = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    const midX = (ax + bx) * 0.5;
    const midY = (ay + by) * 0.5;
    const ang  = Math.atan2(by - ay, bx - ax);
    const geo  = new THREE.BoxGeometry(len, barThick, barDepth);
    geo.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(midX, midY, z)
        .multiply(new THREE.Matrix4().makeRotationZ(ang))
    );
    allGeos.push(geo);
  }

  function addPin(atX, atY, r, z) {
    const geoRaw = new THREE.CylinderGeometry(r, r, barDepth * 2.2, 6);
    geoRaw.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(atX, atY, z)
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    );
    allGeos.push(geoRaw.toNonIndexed());
    geoRaw.dispose();
  }

  for (const fz of [frameZ, frameZ2]) {
    addBar(-halfSpan, bottomY,  0, bottomY + 0.03 * s, fz);
    addBar( halfSpan, bottomY,  0, bottomY + 0.03 * s, fz);
    addBar(-halfSpan, bottomY, -halfSpan, topY,         fz);
    addBar( halfSpan, bottomY,  halfSpan, topY,         fz);
    addBar(-halfSpan, topY,     0, topCenterPinY,       fz);
    addBar( halfSpan, topY,     0, topCenterPinY,       fz);
    addPin(-halfSpan, bottomY, 0.030 * s, fz);
    addPin( halfSpan, bottomY, 0.030 * s, fz);
    addPin(-halfSpan, topY,    0.030 * s, fz);
    addPin( halfSpan, topY,    0.030 * s, fz);
  }

  // Body shape
  const botW      = 0.04 * s;   // narrow base half-width
  const shoulderW = 0.12 * s;   // half-width at the shoulder kink
  const topW      = 0.12 * s;   // half-width at the top (flat, same as shoulder -> vertical walls)
  const shH       = 0.18 * s;   // height of the shoulder kink
  const h         = 0.28 * s;   // total height (flat top)
  const depth     = 0.25 * s;

  const shape = new THREE.Shape();
  shape.moveTo(-botW, 0);
  shape.lineTo(botW, 0);
  shape.lineTo(shoulderW, shH);
  shape.lineTo(topW, h);
  shape.lineTo(-topW, h);
  shape.lineTo(-shoulderW, shH);
  shape.closePath();

  const bodyGeo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  bodyGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, -depth * 0.5));
  allGeos.push(bodyGeo);

  const allGeosNI = allGeos.map(toNonIndexedSafe);

  const merged = mergeGeometries(allGeosNI, false);

  if (!merged) {
    allGeosNI.forEach(g => group.add(new THREE.Mesh(g, mat)));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);
  allGeosNI.forEach(g => g.dispose());
  return group;
}

function makeBogieArmMeshType2(halfSpan, s = 1.0, side = 1) {
  const group = new THREE.Group();
  group.userData.parts = [];

  const barThick      = 0.030 * s;
  const barDepth      = 0.02  * s;
  const frameZ        = 0.10  * s * -side;
  const frameZ2       = 0.10  * s *  side;
  const bottomY       = 0;
  const topY          = 0.17  * s * 1.1;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x474747, roughness: 0.80, metalness: 0.30,
  });

  const allGeos = [];

  function addBar(ax, ay, bx, by, z) {
    const len  = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    const midX = (ax + bx) * 0.5;
    const midY = (ay + by) * 0.5;
    const ang  = Math.atan2(by - ay, bx - ax);
    const geo  = new THREE.BoxGeometry(len, barThick, barDepth);
    geo.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(midX, midY, z)
        .multiply(new THREE.Matrix4().makeRotationZ(ang))
    );
    allGeos.push(geo);
  }

  function addPin(atX, atY, r, z) {
    const geoRaw = new THREE.CylinderGeometry(r, r, barDepth * 2.2, 5);
    geoRaw.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(atX, atY, z)
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    );
    allGeos.push(geoRaw.toNonIndexed());
    geoRaw.dispose();
  }

  // ── Horizontal bottom bar (both frames + middle) ──────────────────────────
  for (const fz of [frameZ, frameZ2, 0]) {
    addBar(-halfSpan, bottomY, halfSpan, bottomY, fz);
  }

  // ── Diagonal bars: bottom ends → top center (both frames) ─────────────────
  for (const fz of [frameZ, frameZ2]) {
    addBar(-halfSpan, bottomY, 0, topY, fz);
    addBar( halfSpan, bottomY, 0, topY, fz);
  }

  // ── Pins at bottom corners + top center (both frames + middle) ────────────
  for (const fz of [frameZ, frameZ2, 0]) {
    addPin(-halfSpan, bottomY, 0.042 * s, fz);
    addPin( halfSpan, bottomY, 0.042 * s, fz);
  }
  for (const fz of [frameZ, frameZ2]) {
    addPin(0, topY, 0.030 * s, fz);
  }

  const allGeosNI = allGeos.map(toNonIndexedSafe);

  const merged = mergeGeometries(allGeosNI, false);

  if (!merged) {
    allGeosNI.forEach(g => group.add(new THREE.Mesh(g, mat)));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);
  allGeosNI.forEach(g => g.dispose());
  return group;
}

// ─── Bogie arm mesh — Type 3 (rectangular frame + cylindrical pivot) ─────────

function makeBogieArmMeshType3(halfSpan, s = 1.0, side = 1) {
  const group = new THREE.Group();
  group.userData.parts = [];

  const barThick = 0.030 * s;
  const barDepth = 0.020 * s;
  const frameZ   = 0.10  * s * -side;
  const frameZ2  = 0.10  * s *  side;

  const bottomY = 0;
  const topY    = 0.17 * s * 1.1;
  const midY    = topY * 0.5;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x474747, roughness: 0.80, metalness: 0.30,
  });

  const allGeos = [];

  function addBar(ax, ay, bx, by, z) {
    const len  = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    const midX = (ax + bx) * 0.5;
    const midY = (ay + by) * 0.5;
    const ang  = Math.atan2(by - ay, bx - ax);
    const geo  = new THREE.BoxGeometry(len, barThick, barDepth);
    geo.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(midX, midY, z)
        .multiply(new THREE.Matrix4().makeRotationZ(ang))
    );
    allGeos.push(geo);
  }

  function addPin(atX, atY, r, z) {
    const geoRaw = new THREE.CylinderGeometry(r, r, barDepth * 2.2, 5);
    geoRaw.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(atX, atY, z)
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    );
    allGeos.push(geoRaw.toNonIndexed());
    geoRaw.dispose();
  }

  // ── Rectangular frame: both outer planes + middle cross-bars ──────────────
  for (const fz of [frameZ, frameZ2]) {
    // Bottom horizontal bar
    // addBar(-halfSpan, bottomY, halfSpan, bottomY, fz);
    // // Top horizontal bar
    // addBar(-halfSpan, topY, halfSpan, topY, fz);
    // // Left vertical bar
    // addBar(-halfSpan, bottomY, -halfSpan, topY, fz);
    // // Right vertical bar
    // addBar( halfSpan, bottomY,  halfSpan, topY, fz);
    // Corner pins
    addPin(-halfSpan, bottomY, 0.042 * s, fz);
    addPin( halfSpan, bottomY, 0.042 * s, fz);
    // addPin(-halfSpan, topY,    0.030 * s, fz);
    // addPin( halfSpan, topY,    0.030 * s, fz);
  }

  addBar(halfSpan, bottomY, halfSpan, topY, 0);
  addBar(-halfSpan, topY, halfSpan, topY, 0);
  addBar(-halfSpan, bottomY, -halfSpan, topY, 0);
  addBar(-halfSpan, midY, halfSpan, midY, 0);
  // Bottom cross-bar at Z=0
  addBar(-halfSpan, bottomY, halfSpan, bottomY, 0);

  // Middle pins at Z=0
  addPin(-halfSpan, bottomY, 0.042 * s, 0);
  addPin( halfSpan, bottomY, 0.042 * s, 0);
  addPin(-halfSpan, topY, 0.042 * s, 0);
  addPin( halfSpan, topY, 0.042 * s, 0);

  // ── Cylindrical pivot body at top-center ──────────────────────────────────
  const pivotR     = 0.05  * s;
  const pivotThick = Math.abs(frameZ2 - frameZ) + barDepth * 2;
  const pivotGeoRaw = new THREE.CylinderGeometry(pivotR, pivotR, pivotThick, 8);
  pivotGeoRaw.applyMatrix4(
    new THREE.Matrix4()
      .makeTranslation(0, topY/2, 0)
      .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2))
  );
  allGeos.push(pivotGeoRaw.toNonIndexed());
  pivotGeoRaw.dispose();

  // ── Cylindrical pivot body at top-center ──────────────────────────────────
  const jointR     = 0.04  * s;
  const jointThick = Math.abs(frameZ2 - frameZ) - barDepth * 2;
  const jointGeoRaw_1 = new THREE.CylinderGeometry(jointR, jointR, jointThick, 5);
  jointGeoRaw_1.applyMatrix4(
    new THREE.Matrix4()
      .makeTranslation(0.035 * s, 0, 0)
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
  );
  allGeos.push(jointGeoRaw_1.toNonIndexed());
  jointGeoRaw_1.dispose();

  const jointGeoRaw_2 = new THREE.CylinderGeometry(jointR, jointR, jointThick, 5);
  jointGeoRaw_2.applyMatrix4(
    new THREE.Matrix4()
      .makeTranslation(-0.035 * s, 0, 0)
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
  );
  allGeos.push(jointGeoRaw_2.toNonIndexed());
  jointGeoRaw_2.dispose();

  // ── Convert indexed geos, merge all ───────────────────────────────────────
  const allGeosNI = allGeos.map(toNonIndexedSafe);

  const merged = mergeGeometries(allGeosNI, false);

  if (!merged) {
    allGeosNI.forEach(g => group.add(new THREE.Mesh(g, mat)));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);
  allGeosNI.forEach(g => g.dispose());
  return group;
}

// ─── Bogie arm mesh — Type 4 (triangular arm matching doc 6) ─────────────────

function makeBogieArmMeshType4(halfSpan, s = 1.0) {
  const group = new THREE.Group();
  group.userData.parts = [];

  const barThick = 0.030 * s;
  const barDepth = 0.020 * s;
  const bottomY  = 0;
  const topY     = 0.13* s * 1.1;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x474747, roughness: 0.80, metalness: 0.30,
  });

  const allGeos = [];

  function addBar(ax, ay, bx, by, z) {
    const len  = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    const midX = (ax + bx) * 0.5;
    const midY = (ay + by) * 0.5;
    const ang  = Math.atan2(by - ay, bx - ax);
    const geo  = new THREE.BoxGeometry(len, barThick, barDepth);
    geo.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(midX, midY, z)
        .multiply(new THREE.Matrix4().makeRotationZ(ang))
    );
    allGeos.push(geo);
  }

  function addPin(atX, atY, r, z) {
    const geoRaw = new THREE.CylinderGeometry(r, r, barDepth * 4, 5);
    geoRaw.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(atX, atY, z)
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    );
    allGeos.push(geoRaw.toNonIndexed());
    geoRaw.dispose();
  }

  // Both frame planes + middle
  for (const fz of [-0.10 * s, 0, 0.10 * s]) {
    // Bottom horizontal bar
    addBar(-halfSpan, bottomY, halfSpan, bottomY, fz);
  }

  // Diagonal bars: bottom ends → top center (both outer frames only)
  for (const fz of [-0.10 * s, 0.10 * s]) {
    addBar( halfSpan, bottomY, 0, topY, fz);
    addBar(-halfSpan, bottomY, 0, topY, fz);
    // Vertical center bar
    addBar(0, bottomY, 0, topY, fz);
  }

  // Pins
  for (const fz of [-0.10 * s, 0, 0.10 * s]) {
    addPin( halfSpan, bottomY, 0.042 * s, fz);
    addPin(-halfSpan, bottomY, 0.042 * s, fz);
  }
  for (const fz of [-0.10 * s, 0.10 * s]) {
    addPin(0, topY, 0.042 * s, fz);
  }

  const allGeosNI = allGeos.map(toNonIndexedSafe);

  const merged = mergeGeometries(allGeosNI, false);

  if (!merged) {
    const m = new THREE.MeshStandardMaterial({ color: 0x474747, roughness: 0.80, metalness: 0.30 });
    allGeosNI.forEach(g => group.add(new THREE.Mesh(g, m)));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);
  allGeosNI.forEach(g => g.dispose());
  return group;
}

function makeBogieArmMeshType5(halfSpan, s = 1.0,side = 1, showFirstWheelLink = false, isLastArm = false) {
  const group = new THREE.Group();
  group.userData.parts = [];

  const barThick = 0.05 * s;
  const barDepth = 0.05 * s;   // thicker in Z so single centered arm has visual mass
  const bottomY  = 0;
  const topY     = 0.34 * s * 1.1;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x474747, roughness: 0.80, metalness: 0.30,
  });

  const allGeos = [];

  // Single Z plane — centered between the two wheel Z offsets (which are ±zGap)
  // Arms sit at Z=0 in arm-local space; wheels are offset ±zGap from there
  const fz = 0;

  function addBar(ax, ay, bx, by) {
    const len  = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    const midX = (ax + bx) * 0.5;
    const midY = (ay + by) * 0.5;
    const ang  = Math.atan2(by - ay, bx - ax);
    const geo  = new THREE.BoxGeometry(len, barThick, barDepth);
    geo.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(midX, midY, fz)
        .multiply(new THREE.Matrix4().makeRotationZ(ang))
    );
    allGeos.push(geo);
  }

  function addCentralCylinder(atX, atY, r) {
    const cenDepth = 0.2 * s;
    const geo  = new THREE.CylinderGeometry(r, r, cenDepth, 6);
    geo.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(atX, atY, fz)
        .multiply(new THREE.Matrix4().makeRotationZ(0))
    );
    allGeos.push(geo);
  }

  function addPin(atX, atY, r) {
    // Pin runs along Z axis to visually connect the two wheel Z positions
    const pinDepth = 0.3 * s;   // long enough to reach both wheel Z offsets
    const geoRaw = new THREE.CylinderGeometry(r, r, pinDepth, 6);
    geoRaw.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(atX, atY, fz)
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    );
    allGeos.push(geoRaw.toNonIndexed());
    geoRaw.dispose();
  }

  function addConnector(atX, atY, r) {
    // Pin runs along Z axis to visually connect the two wheel Z positions
    const pinDepth = 0.5 * s;   // long enough to reach both wheel Z offsets
    const geoRaw = new THREE.CylinderGeometry(r, r, pinDepth, 6);
    geoRaw.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(atX, atY, (-pinDepth/2 + 0.05) * side)
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    );
    allGeos.push(geoRaw.toNonIndexed());
    geoRaw.dispose();
  }

  // ── Base geometry — single centered arm ──────────────────────────────────

  // Bottom horizontal bar spanning the two main wheel positions
  addBar(-halfSpan, bottomY, halfSpan, bottomY);

  // Diagonal bars: bottom ends → top center
  // addBar( halfSpan, bottomY, 0, topY);
  // addBar(-halfSpan, bottomY, 0, topY);

  // Vertical center bar
  addBar(0, bottomY, 0, topY);

  // Pins at wheel attachment points (long pins span both Z wheel positions)
  addPin( halfSpan, bottomY, 0.042 * s);
  addPin(-halfSpan, bottomY, 0.042 * s);
  addConnector(0, topY,            0.030 * s);
  addCentralCylinder(0, topY/2, 0.050 * s)

  // ── firstWheelLink geometry ───────────────────────────────────────────────
  // first arm: link extends LEFT  → -halfSpan * 3
  // last arm:  link extends RIGHT → +halfSpan * 3
  if (showFirstWheelLink) {
    const sign    = isLastArm ? 1 : -1;
    const linkX   = sign * halfSpan * 3;
    const anchorX = sign * halfSpan;

    // Horizontal bar from main wheel to link wheel
    addBar(anchorX, bottomY, linkX, bottomY);

    // Diagonal bar from link wheel up to top pivot
    addBar(linkX, bottomY, 0, topY);

    // Pin at link wheel position
    addPin(linkX, bottomY, 0.042 * s);
  }

  // ── Merge ─────────────────────────────────────────────────────────────────
  const allGeosNI = allGeos.map(toNonIndexedSafe);

  const merged = mergeGeometries(allGeosNI, false);

  if (!merged) {
    const m = new THREE.MeshStandardMaterial({ color: 0x474747, roughness: 0.80, metalness: 0.30 });
    allGeosNI.forEach(g => group.add(new THREE.Mesh(g, m)));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);
  allGeosNI.forEach(g => g.dispose());
  return group;
}

// ─── Equalising beam — connects two adjacent bogie arm pivots ─────────────────

function makeEqualisingBeamGeo(bogieSpan, s = 1.0, side = 1) {
  const group = new THREE.Group();

  const beamH     = 0.030 * s;
  const beamDepth = 0.10  * s;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x474747, roughness: 0.80, metalness: 0.30,
  });

  const allGeos = [];

  // Main beam layers (5 stacked boxes of decreasing width — matches doc 6)
  const layers = [
    { w: 1.0, h: 1.0, d: 1.0,  y: 0      },
    { w: 0.85, h: 0.5, d: 0.85, y:  0.02  },
    { w: 0.85, h: 0.5, d: 0.85, y: -0.02  },
    { w: 0.60, h: 0.5, d: 0.70, y:  0.03  },
    { w: 0.60, h: 0.5, d: 0.70, y: -0.03  },
  ];

  layers.forEach(({ w, h, d, y }) => {
    const geo = new THREE.BoxGeometry(bogieSpan * w, beamH * h, beamDepth * d);
    geo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, y, 0));
    allGeos.push(geo);
  });

  // Centre boss (tapered cylinder)
  const bossRaw = new THREE.CylinderGeometry(0.060 * s, 0.025 * s, beamDepth * 1.5, 8);
  bossRaw.applyMatrix4(
    new THREE.Matrix4()
      .makeTranslation(0, 0.08, 0)
      .multiply(new THREE.Matrix4().makeRotationZ(0))
  );
  allGeos.push(bossRaw.toNonIndexed());
  bossRaw.dispose();

  // Boss holder cylinder
  const holderRaw = new THREE.CylinderGeometry(0.03 * s, 0.03 * s, beamDepth * 2, 8);
  holderRaw.applyMatrix4(
    new THREE.Matrix4()
      .makeTranslation(0, 0.10, 0)
      .multiply(new THREE.Matrix4().makeRotationZ(0))
  );
  allGeos.push(holderRaw.toNonIndexed());
  holderRaw.dispose();

// Contact block at top — Z offset flips with side
  const contactRaw = new THREE.BoxGeometry(0.06 * s, 0.03 * s, 0.20 * s);
  contactRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0.185, -0.10 * side));
  allGeos.push(contactRaw);

  const allGeosNI = allGeos.map(toNonIndexedSafe);

  const merged = mergeGeometries(allGeosNI, false);

  if (!merged) {
    allGeosNI.forEach(g => group.add(new THREE.Mesh(g, mat)));
    return group;
  }

  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  group.add(mesh);
  allGeosNI.forEach(g => g.dispose());
  return group;
}

// ─── Instanced bogie helpers ──────────────────────────────────────────────────

function buildBogieWheelGeometry(outerRadius, width, type = 1, color = 0xc0c0c0, wheelColor = 0xfcd6a9) {
    if (type === 2) {
    const group = makeBogieWheelMeshType2(outerRadius, width, color, wheelColor);
    return group.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
  }

  const OUTER_R = outerRadius * 0.75;

  const midGeoRaw = new THREE.CylinderGeometry(OUTER_R, OUTER_R, width * 0.25, 12);
  midGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const midGeo = midGeoRaw.toNonIndexed();
  midGeoRaw.dispose();

  const innerGeoRaw = new THREE.CylinderGeometry(OUTER_R * 0.58, OUTER_R * 0.58, width * 0.45, 9);
  innerGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const innerGeo = innerGeoRaw.toNonIndexed();
  innerGeoRaw.dispose();

  paintGeometryUniform(midGeo,   color);
  paintGeometryUniform(innerGeo, wheelColor);

  const geos = [midGeo, innerGeo];
  const merged = mergeGeometries(geos, false);
  geos.forEach(g => g.dispose());
  return merged;
}

// ─── Conjugated return roller geometry (Bogie System Type 6) ────────────────
// Same rim + hollow-ring + hub construction used by the main return rollers
// in _buildBelt(), but standalone so it can be instanced per bogie arm.
function buildConjugatedRollerGeometry(radius, trackWidth = 1.0, color = 0x4d4d4d, wheelColor = 0xfcd6a9) {
  const rimRaw = new THREE.CylinderGeometry(radius, radius, 0.07 * trackWidth, 8);
  rimRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const rimGeo = rimRaw.toNonIndexed();

  const HOLLOW_INNER_R = radius * 0.65;
  const HOLLOW_DEPTH   = 0.1 * trackWidth;

  const hollowShape = new THREE.Shape();
  hollowShape.absarc(0, 0, radius, 0, Math.PI * 2, false);
  const hollowHole = new THREE.Path();
  hollowHole.absarc(0, 0, HOLLOW_INNER_R, 0, Math.PI * 2, true);
  hollowShape.holes.push(hollowHole);

  const hollowRaw = new THREE.ExtrudeGeometry(hollowShape, {
    depth: HOLLOW_DEPTH,
    bevelEnabled: false,
    curveSegments: 6,
  });
  hollowRaw.center();
  const hollowGeo = hollowRaw.toNonIndexed();

  const hubRaw = new THREE.CylinderGeometry(radius * 0.3, radius * 0.3, trackWidth * 0.14, 6);
  hubRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const hubGeo = hubRaw.toNonIndexed();

  paintGeometryUniform(rimGeo,    wheelColor);
  paintGeometryUniform(hubGeo,    wheelColor);
  paintGeometryUniform(hollowGeo, color);

  const merged = mergeGeometries([rimGeo, hubGeo, hollowGeo], false) ?? rimGeo;
  rimGeo.dispose();
  hubGeo.dispose();
  hollowGeo.dispose();

  return merged;
}

// Returns the 4 local Z offsets used by Type 3 wheel placement
function getBogieT3WheelOffsets(s) {
  const zGap = 0.08 * s;   // Z separation between the two wheel pairs
  return [
    { ox: 0, oz: -zGap },  // wheel 0: left pair, front
    { ox: 0, oz:  zGap },  // wheel 1: left pair, back
    { ox: 0, oz: -zGap },  // wheel 2: right pair, front  (placed at +halfSpan X)
    { ox: 0, oz:  zGap },  // wheel 3: right pair, back
  ];
}

function buildBogieArmGeometry(halfSpan, s = 1.0, side = 1, type = 1, includeRollerMount = false) {
  if (type === 2) {
    const group = makeBogieArmMeshType2(halfSpan, s, side);
    return group.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
  }

  const barThick = 0.030 * s;
  const barDepth = 0.05  * s;
  const frameZ   = 0.10  * s * -side;
  const frameZ2  = 0.10  * s *  side;

  const bottomY       = 0;
  const topY          = 0.1 * s * 1.1;
  const topCenterPinY = 0.17 * s * 1.5;

  const allGeos = [];

  function addBar(ax, ay, bx, by, z) {
    const len  = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    const midX = (ax + bx) * 0.5;
    const midY = (ay + by) * 0.5;
    const ang  = Math.atan2(by - ay, bx - ax);
    const geo  = new THREE.BoxGeometry(len, barThick, barDepth);
    geo.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(midX, midY, z)
        .multiply(new THREE.Matrix4().makeRotationZ(ang))
    );
    allGeos.push(geo);
  }

  function addPin(atX, atY, r, z) {
    const geoRaw = new THREE.CylinderGeometry(r, r, barDepth * 1.5, 6);
    geoRaw.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(atX, atY, z)
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    );
    allGeos.push(geoRaw.toNonIndexed());
    geoRaw.dispose();
  }

  for (const fz of [frameZ, frameZ2]) {
    addBar(-halfSpan, bottomY,  0, bottomY + 0.03 * s, fz);
    addBar( halfSpan, bottomY,  0, bottomY + 0.03 * s, fz);

    addBar(-halfSpan, bottomY, -halfSpan + 0.15, topY,         fz);
    addBar( halfSpan, bottomY,  halfSpan - 0.15, topY,         fz);

    addBar(-halfSpan + 0.1, topY - 0.05, 0, topCenterPinY - 0.2,       fz);
    addBar( halfSpan - 0.1, topY - 0.05, 0, topCenterPinY - 0.2,       fz);

    addPin(-halfSpan, bottomY, 0.030 * s, fz);
    addPin( halfSpan, bottomY, 0.030 * s, fz);

    addPin(-halfSpan + 0.125, topY - 0.04,    0.030 * s, fz);
    addPin( halfSpan - 0.125, topY - 0.04,    0.030 * s, fz);

    // for returnroller — only when this arm needs the roller mount (Bogie Type 6)
    if (includeRollerMount) {
      addBar(halfSpan, topY + 0.27,  0, topY + 0.125 * s, fz);
      addBar(halfSpan, topY + 0.27,  0, topY * s, fz);
      addPin( halfSpan, topY + 0.27, 0.030 * s, fz);
    }
  }

  // Body shape
  const botW      = 0.04 * s;
  const shoulderW = 0.12 * s;
  const topW      = 0.12 * s;
  const shH       = 0.18 * s;
  const h         = 0.28 * s;
  const depth     = 0.25 * s;

  const shape = new THREE.Shape();
  shape.moveTo(-botW, 0);
  shape.lineTo(botW, 0);
  shape.lineTo(shoulderW, shH);
  shape.lineTo(topW, h);
  shape.lineTo(-topW, h);
  shape.lineTo(-shoulderW, shH);
  shape.closePath();

  const bodyGeo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  bodyGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, -depth * 0.5));
  allGeos.push(bodyGeo);

  const allGeosNI = allGeos.map(toNonIndexedSafe);

  const merged = mergeGeometries(allGeosNI, false);
  if (merged) merged.computeVertexNormals();
  allGeosNI.forEach(g => g.dispose());
  return merged;
}


// ─── Safe non-indexed conversion — never calls toNonIndexed() twice ─────────
function toNonIndexedSafe(geo) {
  if (!geo.index) return geo;   // already non-indexed
  const ni = geo.toNonIndexed();
  geo.dispose();
  return ni;
}

// ─── Torsion Bar Suspension Arm ───────────────────────────────────────────────

// ─── Torsion Bar Arm Geometry (instanced, fixed shape) ────────────────────────

function buildTorsionArmGeometry(rwRadius = 0.25, side = 1) {
  const ARM_LEN = 0.54 * (rwRadius / 0.25);
  const ARM_W   = 0.075 * (rwRadius / 0.25);
  const ARM_H   = 0.075 * (rwRadius / 0.25);
  const HUB_R   = 0.07 * (rwRadius / 0.25);
  const HUB_L   = 0.1;

  const allGeos = [];

  // ── Main arm bar — origin at pivot end ───────────────────────────────────
  const barGeo = new THREE.BoxGeometry(ARM_LEN* 0.82, ARM_H, ARM_W);
  barGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(ARM_LEN * 0.5, 0, -0.05 * side));
  allGeos.push(barGeo);

  // ── Pivot hub ─────────────────────────────────────────────────────────────
  const hubRaw = new THREE.CylinderGeometry(HUB_R, HUB_R, HUB_L, 8);
  hubRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  hubRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, 0.05 * -side));
  allGeos.push(hubRaw.toNonIndexed());
  hubRaw.dispose();

  // ── Wheel-end hub ─────────────────────────────────────────────────────────
  const tipRaw = new THREE.CylinderGeometry(HUB_R * 0.9, HUB_R * 0.9, HUB_L * 3, 8);
  tipRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  tipRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(ARM_LEN, 0, 0.05 * side));
  allGeos.push(tipRaw.toNonIndexed());
  tipRaw.dispose();

  const allGeosNI = allGeos.map(g => {
    if (g.index === null) return g;   // already non-indexed — skip
    const ni = g.toNonIndexed();
    g.dispose();
    return ni;
  });

  const merged = mergeGeometries(allGeosNI, false);
  allGeosNI.forEach(g => g.dispose());
  return merged ?? new THREE.BufferGeometry();
}

// ─── Bogie Type 1 helpers: body and arm-bars as separate geometries ────────────

/**
 * Center body only — the extruded shape, no bars.
 * Pivots at local origin (center of the body base).
 */
function _buildBogieBodyGeometry(halfSpan, s = 1.0) {
  const botW      = 0.04 * s;   // narrow base half-width
  const shoulderW = 0.12 * s;   // half-width at the shoulder kink
  const topW      = 0.12 * s;   // half-width at the top (same as shoulder -> vertical walls)
  const shH       = 0.18 * s;   // height of the shoulder kink
  const h         = 0.28 * s;   // total height (flat top)
  const depth     = 0.25 * s;

  const shape = new THREE.Shape();
  shape.moveTo(-botW, 0);
  shape.lineTo(botW, 0);
  shape.lineTo(shoulderW, shH);
  shape.lineTo(topW, h);
  shape.lineTo(-topW, h);
  shape.lineTo(-shoulderW, shH);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, -depth * 0.5));
  return geo;
}

/**
 * Arm bars only (both frame planes, diagonal + horizontal bars + pins).
 * NO body shape. Origin at arm pivot center so rotation works correctly.
 */
function _buildBogieArmBarGeometry(halfSpan, s = 1.0, side = 1) {
  const barThick = 0.030 * s;
  const barDepth = 0.02  * s;
  const frameZ   = 0.10  * s * -side;
  const frameZ2  = 0.10  * s *  side;

  const bottomY       = 0;
  const topY          = 0.17 * s * 1.1;
  const topCenterPinY = 0.17 * s * 1.5;

  const allGeos = [];

  function addBar(ax, ay, bx, by, z) {
    const len  = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    const midX = (ax + bx) * 0.5;
    const midY = (ay + by) * 0.5;
    const ang  = Math.atan2(by - ay, bx - ax);
    const geo  = new THREE.BoxGeometry(len, barThick, barDepth);
    geo.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(midX, midY, z)
        .multiply(new THREE.Matrix4().makeRotationZ(ang))
    );
    allGeos.push(geo);
  }

  function addPin(atX, atY, r, z) {
    const raw = new THREE.CylinderGeometry(r, r, barDepth * 2.2, 6);
    raw.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(atX, atY, z)
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    );
    allGeos.push(raw.toNonIndexed());
    raw.dispose();
  }

  for (const fz of [frameZ, frameZ2]) {
    addBar(-halfSpan, bottomY,  0, bottomY + 0.03 * s, fz);
    addBar( halfSpan, bottomY,  0, bottomY + 0.03 * s, fz);
    addBar(-halfSpan, bottomY, -halfSpan, topY,         fz);
    addBar( halfSpan, bottomY,  halfSpan, topY,         fz);
    addBar(-halfSpan, topY,     0, topCenterPinY,       fz);
    addBar( halfSpan, topY,     0, topCenterPinY,       fz);
    addPin(-halfSpan, bottomY, 0.030 * s, fz);
    addPin( halfSpan, bottomY, 0.030 * s, fz);
    addPin(-halfSpan, topY,    0.030 * s, fz);
    addPin( halfSpan, topY,    0.030 * s, fz);
  }

  const allGeosNI = allGeos.map(toNonIndexedSafe);

  const merged = mergeGeometries(allGeosNI, false);
  allGeosNI.forEach(g => g.dispose());
  return merged ?? new THREE.BufferGeometry();
}

export {
  makeSprockedMesh,
  makeRoadWheelMesh,
  buildBogieWheelGeometry,
  buildBogieArmGeometry,
  makeBogieArmMeshType2,
  makeBogieArmMeshType3,
  makeBogieArmMeshType4,
  makeEqualisingBeamGeo,
  buildTorsionArmGeometry,
  applyRadialTwoToneColors,
  paintGeometryUniform,
  PIECE_T,   // ← add this
};

// ─── Track class ─────────────────────────────────────────────────────────────

export class Track {
  /**
   * @param {THREE.Scene}      scene
   * @param {THREE.Object3D}   tankBody
   * @param {number}           side       – +1 = right, -1 = left
   * @param {object}           cfg        – {
   *                                          roadWheelXPositions,  // 6 or 12 entries
   *                                          sprocketX, sprocketY,
   *                                          idlerX,    idlerY,
   *                                          returnRollers,
   *                                          topRunSag,
   *                                          enableInAndOutWheels
   *                                        }
   */
  constructor(scene, tankBody, side, cfg) {
    this.scene    = scene;
    this.body     = tankBody;
    this.side     = side;
    this.cfg      = cfg;
    this._trackWidth = cfg.rootTrackWidth ?? 1.0;  // 1.0 = default, 1.5 = 50% wider
    this.sprocketWheelType = cfg.sprocketWheelType ?? 1;
    this.idlerWheelType    = cfg.idlerWheelType    ?? 1;
    this.roadWheelType   = cfg.roadWheelType   ?? 1;
    this.wheelColor      = cfg.wheelColor      ?? 0xfcd6a9;
    this.hideLastRw      = cfg.hideLastRw      ?? true;
    this.beltType        = cfg.beltType        ?? 1;
    this.rate     = 0;
    // ── Dynamic top-run state ─────────────────────────────────────────────────
    this._topRunVel  = [];   // velocity per anchor (Y)
    this._topRunDisp = [];   // current displacement per anchor (Y)
    this._topRunX    = [];   // X position of each anchor (populated in _buildPath)
    this._outerZ = cfg.outerZ ?? OUTER_Z;

    // ── Bogie config (mirrors C# TrackSystem) ─────────────────────────────────
    this.enableBogieWheels    = cfg.enableBogieWheels    ?? false;
    this.bogieWheelSystemSize = cfg.bogieWheelSystemSize ?? 1.0;
    this.bogieArmAngleRange   = cfg.bogieArmAngleRange ?? 45
    this.bogieArmLength       = cfg.bogieArmLength       ?? 0.5;

    // Runtime bogie state (populated in _buildWheels when enabled)
    this.bogieArmMeshes  = [];
    this.bogieArm2Meshes  = [];
    this.bogieArmAngles  = [];   // current smoothed rotation per arm (degrees)
    this.bogieSystemType = cfg.bogieSystemType ?? 1;
    this.bogieArmVisualOffsetY = cfg.bogieArmVisualOffsetY ?? 0.1;

    this.wheelRot = 0;

    this._trackPieceCount = cfg.trackPieceCount ?? 70;

    // ── Torsion bar config ────────────────────────────────────────────────────
    this.enableTorsionBars     = cfg.enableTorsionBars ?? false;
    this._torsionArmInstanced  = null;
    this._torsionDummy         = new THREE.Object3D();

    // Fixed arm shape constants — must match buildTorsionArmGeometry()
    // Must match the formula inside buildTorsionArmGeometry
    this._TORSION_ARM_LEN = 0.54 * ((cfg.roadWheelRadius ?? 0.25) / 0.25);
    this._TORSION_ARM_ANG = cfg.torsionArmAngle ?? (-Math.PI * 0.18 + Math.PI);
    this._doubleSideTorsionArm = cfg.doubleSideTorsionArm ?? false;
    this._torsionWheelSpin    = null;   // Float32Array, allocated in _buildWheels
    this._torsionRwInstanced  = null;
    this._torsionRwDummy      = null;
    // this._TORSION_ARM_ANG = Math.PI * 1.18 + Math.PI;  // fixed rest angle (tweak this value)

    this._buildWheels();
    this._buildBelt();

this.steampunk = cfg.enableSteampunkWheel
  ? new SteampunkWheels(scene, tankBody, side, { ...cfg, outerZ: this._outerZ })
  : null;
  }

  // ── wheel visuals ──────────────────────────────────────────────────────────
  //
  // roadWheelXPositions is already the full interleaved list (12 entries) when
  // enableInAndOutWheels=true, or the plain 6-entry list when false.
  //
  // For the interleaved case:
  //   even index (0,2,4...) → outer wheel  (Z = OUTER_Z)
  //   odd  index (1,3,5...) → inner wheel  (Z = INNER_Z)

_buildWheels() {
  const { roadWheelXPositions } = this.cfg;
  const enableInOut = this.cfg.enableInAndOutWheels ?? false;

  const positions = enableInOut
    ? roadWheelXPositions.slice(0, roadWheelXPositions.length - 1)
    : roadWheelXPositions;

  // ── Branch: bogie system ─────────────────────────────────────────────────
if (this.enableBogieWheels) {

  // ── Route to Type 2 entirely different architecture ──────────────────────
if (this.bogieSystemType === 2) {
  this._buildBogieSystemType2();
} else if (this.bogieSystemType === 3) {
  this._buildBogieSystemType3();
} else if (this.bogieSystemType === 4) {
  this._buildBogieSystemType4();
} else if (this.bogieSystemType === 5) {
  this._buildBogieSystemType5();
} else if (this.bogieSystemType === 6) {
  this._buildBogieSystemType6();
} else {

    // ── Original Type 1 instanced system (unchanged) ────────────────────────
    const s        = this.bogieWheelSystemSize * 1.5;
    const halfSpan = this.bogieArmLength * s;
    const wheelR   = 0.17 * s + 0.045;
    const wheelWidth = 0.25 * s;
    this._bogieWheelR  = wheelR;
    this._bogieHalfSpan = halfSpan;
    this._bogieS        = s;

    const beltContactY   = this.cfg.roadWheelY - (this.cfg.roadWheelRadius ?? 0.25) - PIECE_T;
    this._bogieArmPivotY = beltContactY + (this._bogieWheelR - 0.045);

    const baseX = enableInOut
      ? roadWheelXPositions.filter((_, i) => i % 2 === 0)
      : roadWheelXPositions;

    const armCount   = baseX.length;
    const wheelCount = armCount * 2;

    this.bogieArmAngles = new Array(armCount).fill(0);
    this._bogieBaseX    = baseX;

    const armGeo = buildBogieArmGeometry(halfSpan, s, this.side, this.bogieArmType);
    const armMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.wheelColor).multiplyScalar(0.1),
      roughness: 0.9,
      metalness: 0.1,
    });
    this._bogieArmInstanced = new THREE.InstancedMesh(armGeo, armMat, armCount);
    this._bogieArmInstanced.castShadow    = false;
    this._bogieArmInstanced.frustumCulled = false;
    this.scene.add(this._bogieArmInstanced);
    armGeo.dispose();

    const wheelGeo = buildBogieWheelGeometry(wheelR, wheelWidth, this.bogieWheelType, 0x4d4d4d, this.wheelColor);
    const wheelMat = new THREE.MeshStandardMaterial({
      color: 0x4d4d4d, roughness: 0.9, metalness: 0.1, vertexColors: true,
    });

    this._bogieWheelInstanced = new THREE.InstancedMesh(wheelGeo, wheelMat, wheelCount);
    this._bogieWheelInstanced.castShadow    = false;
    this._bogieWheelInstanced.frustumCulled = false;
    this.scene.add(this._bogieWheelInstanced);
    wheelGeo.dispose();

    this._bogieDummy = new THREE.Object3D();
    this.bogieArmMeshes  = [];
    this.roadWheelMeshes = [];

    this._bogieArmPivotX    = baseX.slice();
    this._bogieArmPivotYArr = new Float32Array(armCount).fill(this._bogieArmPivotY);
    this._bogieArmRotZ      = new Float32Array(armCount).fill(0);
    this._bogieWheelSpin    = new Float32Array(wheelCount).fill(0);

    this.wheelInitialY = new Array(wheelCount).fill(this._bogieArmPivotY);
    this.wheelCurrentY = [...this.wheelInitialY];

    this._updateBogieInstanceMatrices(new THREE.Matrix4(), new THREE.Quaternion());

  }
 } else {
    const INNER_Z_local = this._outerZ - 0.07;
    // ── Original non-bogie path (unchanged) ─────────────────────────────────
this.wheelInitialY = positions.filter((_, i) => {
  if (!enableInOut) return true;
  if (i === 0) return false;
  if (i === positions.length - 1 && i % 2 === 0 && this.hideLastRw) return false;
  return true;
}).map(() => this.cfg.roadWheelY);
this.wheelCurrentY = [...this.wheelInitialY];

// ── Filtered X positions matching wheelInitialY ───────────────────────────
this._rwXPositions = positions.filter((_, i) => {
  if (!enableInOut) return true;
  if (i === 0) return false;
  if (i === positions.length - 1 && i % 2 === 0 && this.hideLastRw) return false;
  return true;
});

if (this.enableTorsionBars) {
  // ── Instanced road wheels for torsion bar mode ──────────────────────────
  // Build geometry from the first road wheel type — same geo for all instances
  const rwGeoGroup = makeRoadWheelMesh(
    this.cfg.roadWheelRadius, 0.2 * this._trackWidth,
    0x4d4d4d, 0.055, 0.09, this.roadWheelType, this.side, this.wheelColor
  );
  // Clone geometry and bake the rotation.x = PI/2 that the group normally carries
  const rwGeoRaw = rwGeoGroup.children[0]?.geometry?.clone()
    ?? new THREE.BufferGeometry();
  rwGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const rwGeoSource = rwGeoRaw;
  rwGeoGroup.traverse(c => {
    if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
  });

  const rwMat = new THREE.MeshStandardMaterial({
    color:     0x4d4d4d,
    roughness: 0.9,
    metalness: 0.1,
    vertexColors: true,
    side:      THREE.DoubleSide,   // FIX: matches makeRoadWheelType5's internal material.
                                    // Without this, one of the two flat annular face rings
                                    // (front/back) is culled because buildAnnulus() bakes the
                                    // same normal direction onto both rings, and FrontSide
                                    // culling (the default) removes whichever ring ends up
                                    // facing away from the camera-relative winding order.
  });

  const rwCount = this._rwXPositions.length;
  this._torsionRwInstanced = new THREE.InstancedMesh(rwGeoSource, rwMat, rwCount);
  this._torsionRwInstanced.castShadow    = false;
  this._torsionRwInstanced.frustumCulled = false;
  this.scene.add(this._torsionRwInstanced);
  rwGeoSource.dispose();

  this._torsionRwDummy  = new THREE.Object3D();
  this.roadWheelMeshes  = [];   // empty — instanced handles positioning

} else {
  // ── Original individual meshes (non-torsion path) ────────────────────────
  this.roadWheelMeshes = positions.map((x, i) => {
    if (enableInOut && i === 0) return null;
    if (enableInOut && i === positions.length - 1 && i % 2 === 0 && this.hideLastRw) return null;

    const z = enableInOut
      ? this.side * (i % 2 === 0 ? this._outerZ + GAP_BETWEEN_WHEELS : INNER_Z_local)
      : this.side * this._outerZ;

    const m = makeRoadWheelMesh(
      this.cfg.roadWheelRadius, 0.2 * this._trackWidth,
      0x4d4d4d, 0.055, 0.09, this.roadWheelType, this.side, this.wheelColor
    );
    m.rotation.x = Math.PI / 2;
    m.position.set(x, this.cfg.roadWheelY, z);
    this.body.add(m);
    return m;
  }).filter(Boolean);

  // ── NEW: Parallel simple companion wheel for each OUTER wheel ────────────
  // Same width/radius as the detailed road wheel, just a plain cylinder,
  // sitting slightly inboard of the outer wheel. Array is kept index-aligned
  // with roadWheelMeshes / wheelCurrentY (null slot for inner-wheel positions).
  this.parallelWheelMeshes = enableInOut
    ? positions
        .map((x, i) => {
          if (i === 0) return undefined;
          if (i === positions.length - 1 && i % 2 === 0 && this.hideLastRw) return undefined;
          if (i % 2 !== 0) return null;   // inner-wheel slot — no parallel mesh, keep alignment

          const outerZLocal = this._outerZ + GAP_BETWEEN_WHEELS;
          const z = this.side * (outerZLocal - PARALLEL_WHEEL_GAP);

          const geo = new THREE.CylinderGeometry(
            this.cfg.roadWheelRadius * 1.05, this.cfg.roadWheelRadius * 1.05,
            0.07 * this._trackWidth, 16
          );
          const mat = new THREE.MeshStandardMaterial({
            color: 0x000000, roughness: 0.9, metalness: 0.1,
          });
          const m = new THREE.Mesh(geo, mat);
          m.rotation.x = Math.PI / 2;
          m.position.set(x, this.cfg.roadWheelY, z);
          this.body.add(m);
          return m;
        })
        .filter(v => v !== undefined)
    : [];
}
  }

// ── Sprocket ───────────────────────────────────────────────────────────────────
// NEW
{
  const spR = this.cfg.sprocketRadius ?? 0.2;
  const sprocketWidth = this.cfg.sprocketWidth ?? (0.15 * this._trackWidth);
  this.sprocket = makeSprockedMesh(spR, sprocketWidth, 0x4d4d4d, 14, 0.045, 0.055, 0.14, this.sprocketWheelType, this.side, this.wheelColor);
  this.sprocket.rotation.x = Math.PI / 2;
  this.sprocket.position.set(this.cfg.sprocketX, this.cfg.sprocketY, this.side * this._outerZ);
  this.body.add(this.sprocket);
  this._spR = spR;
}

// ── Idler ──────────────────────────────────────────────────────────────────────
// NEW
{
  const idR = this.cfg.idlerRadius ?? 0.14;
  const idlerWidth = this.cfg.idlerWidth ?? (0.15 * this._trackWidth);
  this.idler = makeSprockedMesh(idR, idlerWidth, 0x4d4d4d, 10, 0.035, 0.048, 0.14, this.idlerWheelType, this.side, this.wheelColor);
  this.idler.rotation.x = Math.PI / 2;
  this.idler.position.set(this.cfg.idlerX, this.cfg.idlerY, this.side * this._outerZ);
  this.body.add(this.idler);
  this._idR = idR;
}

// ── Return rollers (instanced) ─────────────────────────────────────────────
  this.returnRollerMeshes = [];
  {
    const rollers = this.cfg.returnRollers;
    const count   = rollers.length;

    if (count > 0) {
      const r0 = rollers[0].radius ?? 0.12;

      const rimRaw = new THREE.CylinderGeometry(r0, r0, 0.07 * this._trackWidth, 8);
      rimRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      const rimGeo = toNonIndexedSafe(rimRaw);

      // ── Hollow cylinder — same outer radius as rim ──────────────────────────
      const HOLLOW_INNER_R = r0 * 0.65;              // tweak: how thick the wall is
      const HOLLOW_DEPTH   = 0.1 * this._trackWidth; // tweak: same depth as rim

      const hollowShape = new THREE.Shape();
      hollowShape.absarc(0, 0, r0, 0, Math.PI * 2, false);
      const hollowHole = new THREE.Path();
      hollowHole.absarc(0, 0, HOLLOW_INNER_R, 0, Math.PI * 2, true);
      hollowShape.holes.push(hollowHole);

      const hollowRaw = new THREE.ExtrudeGeometry(hollowShape, {
        depth: HOLLOW_DEPTH,
        bevelEnabled: false,
        curveSegments: 6,
      });
      hollowRaw.center();
      hollowRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(0));
      const hollowGeo = toNonIndexedSafe(hollowRaw);

      const hubRaw = new THREE.CylinderGeometry(r0 * 0.3, r0 * 0.3, this._trackWidth * 0.14, 6);
      hubRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      const hubGeo = toNonIndexedSafe(hubRaw);

      paintGeometryUniform(rimGeo,    this.wheelColor);
      paintGeometryUniform(hubGeo,    this.wheelColor);
      paintGeometryUniform(hollowGeo, 0x4d4d4d);

      const merged = mergeGeometries([rimGeo, hubGeo, hollowGeo], false) ?? rimGeo;
      rimGeo.dispose();
      hubGeo.dispose();
      hollowGeo.dispose();   // ← add this

      const mat = new THREE.MeshStandardMaterial({
        color: 0x4d4d4d, roughness: 0.9, metalness: 0.1, vertexColors: true,
      });


      this._rrInstanced = new THREE.InstancedMesh(merged, mat, count);
      this._rrInstanced.castShadow    = false;
      this._rrInstanced.frustumCulled = false;
      merged.dispose();

      this._rrConfigs = rollers.map(r => ({ x: r.x, y: r.y }));
      this._rrDummy   = new THREE.Object3D();
      this._rrSpin    = new Float32Array(count).fill(0);

      this.scene.add(this._rrInstanced);
    } else {
      this._rrInstanced = null;
      this._rrConfigs   = [];
      this._rrDummy     = null;
      this._rrSpin      = null;
    }
  }

  // ── Torsion bar arms ──────────────────────────────────────────────────────
// ── Torsion bar instanced mesh (1 draw call per side) ─────────────────────
if (this.enableTorsionBars && !this.enableBogieWheels) {
  const enableInOut = this.cfg.enableInAndOutWheels ?? false;
  if (!enableInOut) {
    const count  = this.cfg.roadWheelXPositions.length;
    const armMat = new THREE.MeshStandardMaterial({
      color:     0x3d3d3d,
      roughness: 0.5,
      metalness: 0.5,
    });

    // Primary arm — bar offset follows this.side
    const armGeo = buildTorsionArmGeometry(this.cfg.roadWheelRadius ?? 0.25, this.side);
    this._torsionArmInstanced = new THREE.InstancedMesh(armGeo, armMat, count);
    this._torsionArmInstanced.castShadow    = false;
    this._torsionArmInstanced.frustumCulled = false;
    this.scene.add(this._torsionArmInstanced);
    armGeo.dispose();

    // Second arm — bar offset is flipped (-this.side) so it mirrors the first
    this._torsionArmInstanced2 = null;
    if (this._doubleSideTorsionArm) {
      const armGeo2 = buildTorsionArmGeometry(this.cfg.roadWheelRadius ?? 0.25, -this.side);
      this._torsionArmInstanced2 = new THREE.InstancedMesh(armGeo2, armMat, count);
      this._torsionArmInstanced2.castShadow    = false;
      this._torsionArmInstanced2.frustumCulled = false;
      this.scene.add(this._torsionArmInstanced2);
      armGeo2.dispose();
    }

    // ── Wheel spin tracker ────────────────────────────────────────────────
    this._torsionWheelSpin = new Float32Array(count).fill(0);
    // Write initial matrices
    // Pre-compute fixed pivot points (hull attachment) — one per wheel
// Pivot = wheel_rest_position - ARM_LEN * (cos(REST_ANG), sin(REST_ANG))
// This is computed ONCE and never changes, even if REST_ANG slider moves.
this._torsionPivots = this.cfg.roadWheelXPositions.map((wheelX) => ({
  x: wheelX - this._TORSION_ARM_LEN * Math.cos(this._TORSION_ARM_ANG),
  y: this.cfg.roadWheelY - this._TORSION_ARM_LEN * Math.sin(this._TORSION_ARM_ANG),
}));

// Recompute ARM_LEN from current radius — must stay in sync with buildTorsionArmGeometry
this._TORSION_ARM_LEN = 0.54 * ((this.cfg.roadWheelRadius ?? 0.25) / 0.25);

// Pre-compute fixed pivot points (hull attachment) — one per wheel
this._torsionPivots = this.cfg.roadWheelXPositions.map((wheelX) => ({
  x: wheelX             - this._TORSION_ARM_LEN * Math.cos(this._TORSION_ARM_ANG),
  y: this.cfg.roadWheelY - this._TORSION_ARM_LEN * Math.sin(this._TORSION_ARM_ANG),
}));

// Write initial matrices
this._updateTorsionMatrices(
  new THREE.Matrix4(),
  new THREE.Quaternion(),
  this.cfg.roadWheelXPositions.map(() => this.cfg.roadWheelY)
);
  }
}

}

// ── Bogie System Type 2 — 4-wheel group-based architecture ───────────────────

_buildBogieSystemType2() {
  const { roadWheelXPositions } = this.cfg;
  const enableInOut = this.cfg.enableInAndOutWheels ?? false;

  const s        = this.bogieWheelSystemSize * 1.5;
  const halfSpan = 0.11 * s;
  const wheelR   = 0.17 * s + 0.045;
  const wheelW   = 0.16 * s;

  this._bogieWheelR   = wheelR;
  this._bogieHalfSpan = halfSpan;
  this._bogieS        = s;

  const beltContactY   = this.cfg.roadWheelY - (this.cfg.roadWheelRadius ?? 0.25) - PIECE_T;
  this._bogieArmPivotY = beltContactY + (this._bogieWheelR - 0.045);

  const baseX = enableInOut
    ? roadWheelXPositions.filter((_, i) => i % 2 === 0)
    : roadWheelXPositions;

  const armCount   = baseX.length;
  const wheelCount = armCount * 4;  // 4 wheels per arm

  this.bogieArmAngles     = new Array(armCount).fill(0);
  this._bogieBaseX        = baseX.slice();
  this._bogieArmPivotX    = baseX.slice();
  this._bogieArmPivotYArr = new Float32Array(armCount).fill(this._bogieArmPivotY);
  this._bogieArmRotZ      = new Float32Array(armCount).fill(0);
  this._bogieWheelSpin    = new Float32Array(wheelCount).fill(0);

  this.wheelInitialY = new Array(wheelCount).fill(this._bogieArmPivotY);
  this.wheelCurrentY = [...this.wheelInitialY];

// ── Build merged arm geometry (both frames combined into one geometry) ─────
  const armGeo1Raw = makeBogieArmMeshType2(halfSpan, s,  1);
  const armGeo2Raw = makeBogieArmMeshType2(halfSpan, s, -1);
  const armGeo1 = armGeo1Raw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
  const armGeo2 = armGeo2Raw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
  armGeo1Raw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });
  armGeo2Raw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });

  const armGeoMerged = mergeGeometries([armGeo1, armGeo2], false) ?? armGeo1;
  armGeo1.dispose();
  armGeo2.dispose();

  const armMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(this.wheelColor).multiplyScalar(0.1),
    roughness: 0.9,
    metalness: 0.1,
  });

  // Single instanced mesh — both mirrored frames baked into one geometry
  this._bogieArmInstanced  = new THREE.InstancedMesh(armGeoMerged, armMat, armCount);
  this._bogieArm2Instanced = null;   // no longer needed
  this._bogieArmInstanced.castShadow    = false;
  this._bogieArmInstanced.frustumCulled = false;
  this.scene.add(this._bogieArmInstanced);
  armGeoMerged.dispose();

  // ── Wheel geometry ─────────────────────────────────────────────────────────
  const wheelGeo = buildBogieWheelGeometry(wheelR, wheelW, this.bogieWheelType, 0x4d4d4d, this.wheelColor);
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x4d4d4d, roughness: 0.9, metalness: 0.1, vertexColors: true,
  });

  this._bogieWheelInstanced = new THREE.InstancedMesh(wheelGeo, wheelMat, wheelCount);
  this._bogieWheelInstanced.castShadow    = false;
  this._bogieWheelInstanced.frustumCulled = false;
  this.scene.add(this._bogieWheelInstanced);
  wheelGeo.dispose();

  this._bogieDummy     = new THREE.Object3D();
  this._bogieT2Groups  = null;   // not used in instanced path
  this.bogieArmMeshes  = [];
  this.roadWheelMeshes = [];
}

// ── Bogie System Type 3 — rectangular frame, 4 wheels per arm ────────────────

_buildBogieSystemType3() {
  const { roadWheelXPositions } = this.cfg;
  const enableInOut = this.cfg.enableInAndOutWheels ?? false;

  const s        = this.bogieWheelSystemSize * 1.5;
  const halfSpan = 0.18 * s;   // wider than Type 1/2 to match rectangular frame
  const wheelR   = 0.17 * s + 0.045;
  const wheelW   = 0.2 * s;   // narrower individual wheels (4 per arm)

  this._bogieWheelR   = wheelR;
  this._bogieHalfSpan = halfSpan;
  this._bogieS        = s;

  const beltContactY   = this.cfg.roadWheelY - (this.cfg.roadWheelRadius ?? 0.25) - PIECE_T;
  this._bogieArmPivotY = beltContactY + (this._bogieWheelR - 0.045);

  const baseX = enableInOut
    ? roadWheelXPositions.filter((_, i) => i % 2 === 0)
    : roadWheelXPositions;

  const armCount   = baseX.length;
  const wheelCount = armCount * 4;   // 4 wheels per arm

  this.bogieArmAngles     = new Array(armCount).fill(0);
  this._bogieBaseX        = baseX.slice();
  this._bogieArmPivotX    = baseX.slice();
  this._bogieArmPivotYArr = new Float32Array(armCount).fill(this._bogieArmPivotY);
  this._bogieArmRotZ      = new Float32Array(armCount).fill(0);
  this._bogieWheelSpin    = new Float32Array(wheelCount).fill(0);

  this.wheelInitialY = new Array(wheelCount).fill(this._bogieArmPivotY);
  this.wheelCurrentY = [...this.wheelInitialY];

  // ── Arm geometry: build both mirrored frames, merge into one geo ──────────
  const armRaw1 = makeBogieArmMeshType3(halfSpan, s,  1);
  const armRaw2 = makeBogieArmMeshType3(halfSpan, s, -1);
  const armGeo1 = armRaw1.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
  const armGeo2 = armRaw2.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
  armRaw1.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });
  armRaw2.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });

  const armGeoMerged = mergeGeometries([armGeo1, armGeo2], false) ?? armGeo1;
  armGeo1.dispose();
  armGeo2.dispose();

  const armMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(this.wheelColor).multiplyScalar(0.1),
    roughness: 0.9,
    metalness: 0.1,
  });

  this._bogieArmInstanced  = new THREE.InstancedMesh(armGeoMerged, armMat, armCount);
  this._bogieArm2Instanced = null;
  this._bogieArmInstanced.castShadow    = false;
  this._bogieArmInstanced.frustumCulled = false;
  this.scene.add(this._bogieArmInstanced);
  armGeoMerged.dispose();

  // ── Wheel geometry ─────────────────────────────────────────────────────────
  const wheelGeo = buildBogieWheelGeometry(wheelR, wheelW, this.bogieWheelType, 0x4d4d4d, this.wheelColor);
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x4d4d4d, roughness: 0.9, metalness: 0.1, vertexColors: true,
  });

  this._bogieWheelInstanced = new THREE.InstancedMesh(wheelGeo, wheelMat, wheelCount);
  this._bogieWheelInstanced.castShadow    = false;
  this._bogieWheelInstanced.frustumCulled = false;
  this.scene.add(this._bogieWheelInstanced);
  wheelGeo.dispose();

  this._bogieDummy     = new THREE.Object3D();
  this._bogieT2Groups  = null;
  this.bogieArmMeshes  = [];
  this.roadWheelMeshes = [];
}

// ── Bogie System Type 4 — paired units connected by equalising beam ───────────

_buildBogieSystemType4() {
  const { roadWheelXPositions } = this.cfg;
  const enableInOut = this.cfg.enableInAndOutWheels ?? false;

  const s        = this.bogieWheelSystemSize * 1.5;
  const halfSpan = 0.18 * s;
  const wheelR   = 0.17 * s + 0.045;
  const wheelW   = 0.16 * s;

  this._bogieWheelR   = wheelR;
  this._bogieHalfSpan = halfSpan;
  this._bogieS        = s;

  const beltContactY   = this.cfg.roadWheelY - (this.cfg.roadWheelRadius ?? 0.25) - PIECE_T;
  this._bogieArmPivotY = beltContactY + (this._bogieWheelR - 0.045);

  const baseX = enableInOut
    ? roadWheelXPositions.filter((_, i) => i % 2 === 0)
    : roadWheelXPositions;

  const armCount   = baseX.length;
  const wheelCount = armCount * 4;  // 4 wheels per arm

  this.bogieArmAngles     = new Array(armCount).fill(0);
  this._bogieBaseX        = baseX.slice();
  this._bogieArmPivotX    = baseX.slice();
  this._bogieArmPivotYArr = new Float32Array(armCount).fill(this._bogieArmPivotY);
  this._bogieArmRotZ      = new Float32Array(armCount).fill(0);
  this._bogieWheelSpin    = new Float32Array(wheelCount).fill(0);

  this.wheelInitialY = new Array(wheelCount).fill(this._bogieArmPivotY);
  this.wheelCurrentY = [...this.wheelInitialY];

  // ── Arm geometry ──────────────────────────────────────────────────────────
  const armRaw = makeBogieArmMeshType4(halfSpan, s);
  const armGeo = armRaw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
  armRaw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });

  const armMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(this.wheelColor).multiplyScalar(0.1),
    roughness: 0.9,
    metalness: 0.1,
  });

  this._bogieArmInstanced  = new THREE.InstancedMesh(armGeo, armMat, armCount);
  this._bogieArm2Instanced = null;
  this._bogieArmInstanced.castShadow    = false;
  this._bogieArmInstanced.frustumCulled = false;
  this.scene.add(this._bogieArmInstanced);
  armGeo.dispose();

  // ── Equalising beam — one per adjacent pair of arms ───────────────────────
  // pairs: (0,1), (2,3), (4,5) etc — floor(armCount/2) beams
  const pairCount = Math.floor(armCount / 2);

  if (pairCount > 0) {
    const firstPairSpan = Math.abs(baseX[1] - baseX[0]);
    const beamRaw = makeEqualisingBeamGeo(firstPairSpan, s, this.side);
    const beamGeo = beamRaw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
    beamRaw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });

    this._bogieBeamInstanced = new THREE.InstancedMesh(beamGeo, armMat, pairCount);
    this._bogieBeamInstanced.castShadow    = false;
    this._bogieBeamInstanced.frustumCulled = false;
    this.scene.add(this._bogieBeamInstanced);
    beamGeo.dispose();
  } else {
    this._bogieBeamInstanced = null;
  }

  this._bogiePairCount = pairCount;

  // ── Wheel geometry ─────────────────────────────────────────────────────────
  const wheelGeo = buildBogieWheelGeometry(wheelR, wheelW, this.bogieWheelType, 0x4d4d4d, this.wheelColor);
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x4d4d4d, roughness: 0.9, metalness: 0.1, vertexColors: true,
  });

  this._bogieWheelInstanced = new THREE.InstancedMesh(wheelGeo, wheelMat, wheelCount);
  this._bogieWheelInstanced.castShadow    = false;
  this._bogieWheelInstanced.frustumCulled = false;
  this.scene.add(this._bogieWheelInstanced);
  wheelGeo.dispose();

  this._bogieDummy     = new THREE.Object3D();
  this._bogieT2Groups  = null;
  this.bogieArmMeshes  = [];
  this.roadWheelMeshes = [];
}

_buildBogieSystemType5() {
  const { roadWheelXPositions } = this.cfg;
  const enableInOut = this.cfg.enableInAndOutWheels ?? false;

  const s        = this.bogieWheelSystemSize * 1.5;
  const halfSpan = 0.18 * s;
  const wheelR   = 0.17 * s + 0.045;
  const wheelW   = 0.16 * s;

  this._bogieWheelR   = wheelR;
  this._bogieHalfSpan = halfSpan;
  this._bogieS        = s;

  const beltContactY   = this.cfg.roadWheelY - (this.cfg.roadWheelRadius ?? 0.25) - PIECE_T;
  this._bogieArmPivotY = beltContactY + (this._bogieWheelR - 0.045);

  const baseX = enableInOut
    ? roadWheelXPositions.filter((_, i) => i % 2 === 0)
    : roadWheelXPositions;

  const armCount = baseX.length;

  // ── Disable flags ─────────────────────────────────────────────────────────
  // cfg.disableEndWheelLinks = { front: false, back: false }
  // front = first arm link (idler side), back = last arm link (sprocket side)
  const disableFront = this.cfg.disableEndWheelLinks?.front ?? false;
  const disableBack  = this.cfg.disableEndWheelLinks?.back  ?? false;

  const frontLinkActive = !disableFront;
  const backLinkActive  = !disableBack;

  // Wheel count:
  //   every arm        → 4 wheels (2 positions × 2 Z pairs)
  //   first arm link   → +2 wheels (1 extra position × 2 Z pairs)
  //   last arm link    → +2 wheels
  const linkWheelCount =
    (frontLinkActive ? 2 : 0) +
    (backLinkActive  ? 2 : 0);
  const baseWheelCount = armCount * 4;
  const totalWheelCount = baseWheelCount + linkWheelCount;

  this._bogieT5FrontLinkActive = frontLinkActive;
  this._bogieT5BackLinkActive  = backLinkActive;
  this._bogieT5ArmCount        = armCount;
  this._bogieT5BaseWheelCount  = baseWheelCount;

  this.bogieArmAngles     = new Array(armCount).fill(0);
  this._bogieBaseX        = baseX.slice();
  this._bogieArmPivotX    = baseX.slice();
  this._bogieArmPivotYArr = new Float32Array(armCount).fill(this._bogieArmPivotY);
  this._bogieArmRotZ      = new Float32Array(armCount).fill(0);
  this._bogieWheelSpin    = new Float32Array(totalWheelCount).fill(0);

  this.wheelInitialY = new Array(totalWheelCount).fill(this._bogieArmPivotY);
  this.wheelCurrentY = [...this.wheelInitialY];

  // ── Build arm geometries per slot ─────────────────────────────────────────
  // We need up to 3 arm variants:
  //   A) end arm WITH link  (first or last)
  //   B) middle arm         (no link)
  // We build separate InstancedMeshes for each variant to avoid
  // per-instance geometry differences.

  // Count how many arms fall into each category
  const endWithLinkIndices    = [];
  const middleIndices         = [];

  for (let i = 0; i < armCount; i++) {
    const isFirst = i === 0;
    const isLast  = i === armCount - 1;
    const hasLink = (isFirst && frontLinkActive) || (isLast && backLinkActive);
    if (hasLink) endWithLinkIndices.push(i);
    else         middleIndices.push(i);
  }

  this._bogieT5EndIndices    = endWithLinkIndices;
  this._bogieT5MiddleIndices = middleIndices;

  const armMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(this.wheelColor).multiplyScalar(0.1),
    roughness: 0.9,
    metalness: 0.1,
  });

  // ── Middle arm instanced mesh ─────────────────────────────────────────────
  this._bogieArmInstanced  = null;
  if (middleIndices.length > 0) {
    const midRaw = makeBogieArmMeshType5(halfSpan, s, this.side, false, false);
    const midGeo = midRaw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
    midRaw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });

    this._bogieArmInstanced = new THREE.InstancedMesh(midGeo, armMat, middleIndices.length);
    this._bogieArmInstanced.castShadow    = false;
    this._bogieArmInstanced.frustumCulled = false;
    this.scene.add(this._bogieArmInstanced);
    midGeo.dispose();
  }

  // ── End arm instanced meshes (front link + back link, separate) ───────────
  this._bogieT5FrontArmInstanced = null;
  this._bogieT5BackArmInstanced  = null;

  if (frontLinkActive && armCount > 0) {
    // First arm: isLastArm = false → link extends LEFT
    const fRaw = makeBogieArmMeshType5(halfSpan, s, this.side, true, false);
    const fGeo = fRaw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
    fRaw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });

    this._bogieT5FrontArmInstanced = new THREE.InstancedMesh(fGeo, armMat, 1);
    this._bogieT5FrontArmInstanced.castShadow    = false;
    this._bogieT5FrontArmInstanced.frustumCulled = false;
    this.scene.add(this._bogieT5FrontArmInstanced);
    fGeo.dispose();
  }

  if (backLinkActive && armCount > 1) {
    // Last arm: isLastArm = true → link extends RIGHT
    const bRaw = makeBogieArmMeshType5(halfSpan, s, this.side, true, true);
    const bGeo = bRaw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
    bRaw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });

    this._bogieT5BackArmInstanced = new THREE.InstancedMesh(bGeo, armMat, 1);
    this._bogieT5BackArmInstanced.castShadow    = false;
    this._bogieT5BackArmInstanced.frustumCulled = false;
    this.scene.add(this._bogieT5BackArmInstanced);
    bGeo.dispose();
  }

  // ── Wheel geometry (shared across all arms) ───────────────────────────────
  const wheelGeo = buildBogieWheelGeometry(wheelR, wheelW, this.bogieWheelType, 0x4d4d4d, this.wheelColor);
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x4d4d4d, roughness: 0.9, metalness: 0.1, vertexColors: true,
  });

  this._bogieWheelInstanced = new THREE.InstancedMesh(wheelGeo, wheelMat, totalWheelCount);
  this._bogieWheelInstanced.castShadow    = false;
  this._bogieWheelInstanced.frustumCulled = false;
  this.scene.add(this._bogieWheelInstanced);
  wheelGeo.dispose();

  this._bogieDummy     = new THREE.Object3D();
  this._bogieT2Groups  = null;
  this.bogieArmMeshes  = [];
  this.roadWheelMeshes = [];
}

// ── Bogie System Type 6 — Type 1 arm/wheel + a conjugated return roller ──────

_buildBogieSystemType6() {
  const { roadWheelXPositions } = this.cfg;
  const enableInOut = this.cfg.enableInAndOutWheels ?? false;

  // ── Identical arm/wheel geometry to Bogie System Type 1 ───────────────────
  const s           = this.bogieWheelSystemSize * 1.5;
  const halfSpan    = this.bogieArmLength * s;
  const wheelR      = 0.17 * s + 0.045;
  const wheelWidth  = 0.25 * s;
  this._bogieWheelR   = wheelR;
  this._bogieHalfSpan = halfSpan;
  this._bogieS        = s;

  const beltContactY   = this.cfg.roadWheelY - (this.cfg.roadWheelRadius ?? 0.25) - PIECE_T;
  this._bogieArmPivotY = beltContactY + (this._bogieWheelR - 0.045);

  const baseX = enableInOut
    ? roadWheelXPositions.filter((_, i) => i % 2 === 0)
    : roadWheelXPositions;

  const armCount   = baseX.length;
  const wheelCount = armCount * 2;

  this.bogieArmAngles = new Array(armCount).fill(0);
  this._bogieBaseX    = baseX;

  const armGeo = buildBogieArmGeometry(halfSpan, s, this.side, 1, true);
  const armMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.wheelColor).multiplyScalar(0.1),
      roughness: 0.9,
      metalness: 0.1,
  });
  this._bogieArmInstanced = new THREE.InstancedMesh(armGeo, armMat, armCount);
  this._bogieArmInstanced.castShadow    = false;
  this._bogieArmInstanced.frustumCulled = false;
  this.scene.add(this._bogieArmInstanced);
  armGeo.dispose();

  const wheelGeo = buildBogieWheelGeometry(wheelR, wheelWidth, 1, 0x4d4d4d, this.wheelColor);
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x4d4d4d, roughness: 0.9, metalness: 0.1, vertexColors: true,
  });
  this._bogieWheelInstanced = new THREE.InstancedMesh(wheelGeo, wheelMat, wheelCount);
  this._bogieWheelInstanced.castShadow    = false;
  this._bogieWheelInstanced.frustumCulled = false;
  this.scene.add(this._bogieWheelInstanced);
  wheelGeo.dispose();

  this._bogieDummy     = new THREE.Object3D();
  this.bogieArmMeshes  = [];
  this.roadWheelMeshes = [];

  this._bogieArmPivotX    = baseX.slice();
  this._bogieArmPivotYArr = new Float32Array(armCount).fill(this._bogieArmPivotY);
  this._bogieArmRotZ      = new Float32Array(armCount).fill(0);
  this._bogieWheelSpin    = new Float32Array(wheelCount).fill(0);

  this.wheelInitialY = new Array(wheelCount).fill(this._bogieArmPivotY);
  this.wheelCurrentY = [...this.wheelInitialY];

  // ── NEW: conjugated return roller — one per bogie arm ─────────────────────
  const rollerR = this.cfg.returnRollers?.[0]?.radius ?? 0.12;
  const rollerGeo = buildConjugatedRollerGeometry(rollerR, this._trackWidth, 0x4d4d4d, this.wheelColor);
  const rollerMat = new THREE.MeshStandardMaterial({
    color: 0x4d4d4d, roughness: 0.9, metalness: 0.1, vertexColors: true,
  });
  this._bogieRRInstanced = new THREE.InstancedMesh(rollerGeo, rollerMat, armCount);
  this._bogieRRInstanced.castShadow    = false;
  this._bogieRRInstanced.frustumCulled = false;
  this.scene.add(this._bogieRRInstanced);
  rollerGeo.dispose();

  this._bogieRRDummy = new THREE.Object3D();
  this._bogieRRSpin  = new Float32Array(armCount).fill(0);

  // Roller sits above the arm's top-center pivot pin (topCenterPinY), +0.2 higher
  const topCenterPinY = 0.17 * s * 1.5;
  this._bogieRRYOffset = topCenterPinY + 0.05;
  this._bogieRRXOffset = 0.35;

  this._updateBogieInstanceMatrices(new THREE.Matrix4(), new THREE.Quaternion());
}

  // ── belt / ghost system ────────────────────────────────────────────────────

_buildBelt() {
  // ── Track piece (body only) ──────────────────────────────────────────────
  // NEW — trapezoidal track link (outer face narrower than inner face)
const TAPER = 0.72;   // outer face is 72% of inner face width — tweak this (0.5–0.95)

const halfH  = PIECE_H * 0.5;
const halfT  = PIECE_T * 0.5;
const halfW  = PIECE_W * this._trackWidth * 0.5;
const halfWO = halfW * TAPER;   // outer (visible) face half-width

// 8 vertices: inner face (4) + outer face (4)
// Inner face: full width, at -halfT (wheel side)
// Outer face: tapered width, at +halfT (ground/visible side)
//
//   inner face (y = -halfT):   z from -halfW  to +halfW
//   outer face (y = +halfT):   z from -halfWO to +halfWO
//
// Vertex layout:
//   0: inner, -x, -z   1: inner, +x, -z
//   2: inner, +x, +z   3: inner, -x, +z
//   4: outer, -x, -z   5: outer, +x, -z
//   6: outer, +x, +z   7: outer, -x, +z

const positions = new Float32Array([
  // inner face (y = +halfT) — full width (this side faces the wheels)
  -halfH,  halfT, -halfW,   // 0
   halfH,  halfT, -halfW,   // 1
   halfH,  halfT,  halfW,   // 2
  -halfH,  halfT,  halfW,   // 3
  // outer face (y = -halfT) — tapered width (this side faces outward/ground)
  -halfH, -halfT, -halfWO,  // 4
   halfH, -halfT, -halfWO,  // 5
   halfH, -halfT,  halfWO,  // 6
  -halfH, -halfT,  halfWO,  // 7
]);

// 6 faces × 2 triangles × 3 indices = 36
const indices = [
  // inner face  (faces inward toward wheels)
  0, 2, 1,   0, 3, 2,
  // outer face  (faces outward — the visible tapered face)
  4, 5, 6,   4, 6, 7,
  // left side   (z negative side — tapered)
  0, 1, 5,   0, 5, 4,
  // right side  (z positive side — tapered)
  2, 3, 7,   2, 7, 6,
  // front end   (x positive)
  1, 2, 6,   1, 6, 5,
  // back end    (x negative)
  3, 0, 4,   3, 4, 7,
];

const pieceGeoRaw = new THREE.BufferGeometry();
pieceGeoRaw.setAttribute('position', new THREE.BufferAttribute(positions, 3));
pieceGeoRaw.setIndex(indices);
pieceGeoRaw.computeVertexNormals();

const pieceGeo = toNonIndexedSafe(pieceGeoRaw);

  // ── Triangle fin (extruded wedge) ─────────────────────────────────────────
  const triHeight  = 0.06;
  const triWidth   = 0.03;
  const triThick   = 0.015;
  const triOffsetY = 0.07;

  const triShape = new THREE.Shape();
  triShape.moveTo(-triWidth, 0);
  triShape.lineTo( triWidth, 0);
  triShape.lineTo( 0.015,        triHeight);
  triShape.lineTo( -0.015,        triHeight);
  triShape.closePath();

  const triExtGeoRaw = new THREE.ExtrudeGeometry(triShape, {
    depth:        triThick,
    bevelEnabled: false,
  });
  triExtGeoRaw.center();
  triExtGeoRaw.applyMatrix4(
    new THREE.Matrix4().makeTranslation(0.062, triOffsetY, 0)
  );
  // Strip UVs so mergeGeometries doesn't fail — piece geo has no UVs
  triExtGeoRaw.deleteAttribute('uv');

  // ── Clone pieceGeo BEFORE disposing so both belt types can use it ─────────
  const pieceGeoClone = pieceGeo.clone();

  const pieceMerged  = mergeGeometries([pieceGeo,      triExtGeoRaw], false);
  const pieceMerged2 = mergeGeometries([pieceGeoClone, triExtGeoRaw], false);

  triExtGeoRaw.dispose();
  pieceGeo.dispose();
  pieceGeoClone.dispose();

  const pieceFinal  = pieceMerged  ?? pieceGeo;
  const pieceFinal2 = pieceMerged2 ?? pieceGeoClone;

  const pieceMat = new THREE.MeshStandardMaterial({
    color:     0x2a2a2a,
    roughness: 1.0,
    metalness: 0.0,
  });

if (this.beltType === 2) {
  pieceMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = `
      varying vec3 vWorldPos;
    ` + shader.fragmentShader;

    shader.vertexShader = `
      varying vec3 vWorldPos;
    ` + shader.vertexShader.replace(
      `#include <begin_vertex>`,
      `#include <begin_vertex>
      vWorldPos = position;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <alphatest_fragment>`,
      `
      #include <alphatest_fragment>
      float halfW = ${(PIECE_W * 0.5).toFixed(4)};
      float stripe = abs(vWorldPos.z / halfW);
      float finHeight = ${(triOffsetY + triHeight).toFixed(4)};
      // skip discard for fin geometry (above belt surface)
      bool isFin = vWorldPos.y > ${(PIECE_T * 0.5).toFixed(4)};
      if (stripe < 0.05 && !isFin) discard;
      `
    );
  };

    this.instancedMesh = new THREE.InstancedMesh(pieceFinal2, pieceMat, this._trackPieceCount);
  } else if (this.beltType === 3) {
  // ── Zigzag chevron gap pattern ("/  \_/  \_/  \_/  \") ────────────────────
  pieceMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = `
      varying vec3 vWorldPos;
    ` + shader.fragmentShader;

    shader.vertexShader = `
      varying vec3 vWorldPos;
    ` + shader.vertexShader.replace(
      `#include <begin_vertex>`,
      `#include <begin_vertex>
      vWorldPos = position;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <alphatest_fragment>`,
      `
      #include <alphatest_fragment>
      float halfW   = ${(PIECE_W * 0.5).toFixed(4)};
      float halfLen = ${(PIECE_H * 0.5).toFixed(4)};
      bool  isFin   = vWorldPos.y > ${(PIECE_T * 0.5).toFixed(4)};

      const float PULSE_COUNT = 4.0;
      const float FLAT_FRAC   = 0.40;
      const float RAMP_FRAC   = 0.20;
      const float ANGLE_SPAN  = 0.05;
      const float LINE_WIDTH  = 0.05;
      const float ROTATE_DEG  = 180.0;   // rotate the whole pattern (degrees)

      float rotRad = radians(ROTATE_DEG);
      float cosR   = cos(rotRad);
      float sinR   = sin(rotRad);
      float xR     =  vWorldPos.x * cosR - vWorldPos.z * sinR;
      float zR     =  vWorldPos.x * sinR + vWorldPos.z * cosR;

      float fullW    = halfW * 2.0;
      float periodW  = fullW / PULSE_COUNT;

      // Measure from center and mirror — guarantees left/right symmetry
      float zAbs     = abs(zR);                       // 0 .. halfW
      float zInCycle = mod(zAbs, periodW) / periodW;   // 0..1 within this pulse, mirrored

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

      float lineCenterX  = (wave - 0.5) * halfLen * 2.0 * ANGLE_SPAN;
      float distFromLine = abs(xR - lineCenterX);

      if (distFromLine < halfLen * LINE_WIDTH && !isFin) discard;
      `
    );
  };

  this.instancedMesh = new THREE.InstancedMesh(pieceFinal2, pieceMat, this._trackPieceCount);

} else if (this.beltType === 4) {
  // ── Zigzag chevron gap pattern ("/  \_/  \_/  \_/  \") ────────────────────
  pieceMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = `
      varying vec3 vWorldPos;
    ` + shader.fragmentShader;

    shader.vertexShader = `
      varying vec3 vWorldPos;
    ` + shader.vertexShader.replace(
      `#include <begin_vertex>`,
      `#include <begin_vertex>
      vWorldPos = position;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <alphatest_fragment>`,
      `
      #include <alphatest_fragment>
      float halfW   = ${(PIECE_W * 0.5).toFixed(4)};
      float halfLen = ${(PIECE_H * 0.5).toFixed(4)};
      bool  isFin   = vWorldPos.y > ${(PIECE_T * 0.5).toFixed(4)};

      const float PULSE_COUNT = 4.0;
      const float FLAT_FRAC   = 0.40;
      const float RAMP_FRAC   = 0.20;
      const float ANGLE_SPAN  = 0.15;
      const float LINE_WIDTH  = 0.1;
      const float ROTATE_DEG  = 180.0;   // rotate the whole pattern (degrees)

      float rotRad = radians(ROTATE_DEG);
      float cosR   = cos(rotRad);
      float sinR   = sin(rotRad);
      float xR     =  vWorldPos.x * cosR - vWorldPos.z * sinR;
      float zR     =  vWorldPos.x * sinR + vWorldPos.z * cosR;

      float fullW    = halfW * 2.0;
      float periodW  = fullW / PULSE_COUNT;

      // Measure from center and mirror — guarantees left/right symmetry
      float zAbs     = abs(zR);                       // 0 .. halfW
      float zInCycle = mod(zAbs, periodW) / periodW;   // 0..1 within this pulse, mirrored

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

      float lineCenterX  = (wave - 0.5) * halfLen * 2.0 * ANGLE_SPAN;
      float distFromLine = abs(xR - lineCenterX);

      if (distFromLine < halfLen * LINE_WIDTH && !isFin) discard;
      `
    );
  };

  this.instancedMesh = new THREE.InstancedMesh(pieceFinal2, pieceMat, this._trackPieceCount);

} else if (this.beltType === 5) {
  // ── Zigzag chevron gap pattern ("/  \_/  \_/  \_/  \") ────────────────────
  pieceMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = `
      varying vec3 vWorldPos;
    ` + shader.fragmentShader;

    shader.vertexShader = `
      varying vec3 vWorldPos;
    ` + shader.vertexShader.replace(
      `#include <begin_vertex>`,
      `#include <begin_vertex>
      vWorldPos = position;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <alphatest_fragment>`,
      `
      #include <alphatest_fragment>
      float halfW   = ${(PIECE_W * 0.5).toFixed(4)};
      float halfLen = ${(PIECE_H * 0.5).toFixed(4)};
      bool  isFin   = vWorldPos.y > ${(PIECE_T * 0.5).toFixed(4)};

      const float PULSE_COUNT = 4.8;
      const float FLAT_FRAC   = 0.40;
      const float RAMP_FRAC   = 0.10;
      const float ANGLE_SPAN  = 0.85;
      const float LINE_WIDTH  = 0.2;
      const float ROTATE_DEG  = 180.0;   // rotate the whole pattern (degrees)

      float rotRad = radians(ROTATE_DEG);
      float cosR   = cos(rotRad);
      float sinR   = sin(rotRad);
      float xR     =  vWorldPos.x * cosR - vWorldPos.z * sinR;
      float zR     =  vWorldPos.x * sinR + vWorldPos.z * cosR;

      float fullW    = halfW * 2.0;
      float periodW  = fullW / PULSE_COUNT;

      // Measure from center and mirror — guarantees left/right symmetry
      float zAbs     = abs(zR);                       // 0 .. halfW
      float zInCycle = mod(zAbs, periodW) / periodW;   // 0..1 within this pulse, mirrored

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

      float lineCenterX  = (wave - 0.5) * halfLen * 2.0 * ANGLE_SPAN;
      float distFromLine = abs(xR - lineCenterX);

      if (distFromLine < halfLen * LINE_WIDTH && !isFin) discard;
      `
    );
  };

  this.instancedMesh = new THREE.InstancedMesh(pieceFinal2, pieceMat, this._trackPieceCount);

} else if (this.beltType === 6) {
  // ── Zigzag chevron gap pattern ("/  \_/  \_/  \_/  \") ────────────────────
  pieceMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = `
      varying vec3 vWorldPos;
    ` + shader.fragmentShader;

    shader.vertexShader = `
      varying vec3 vWorldPos;
    ` + shader.vertexShader.replace(
      `#include <begin_vertex>`,
      `#include <begin_vertex>
      vWorldPos = position;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <alphatest_fragment>`,
      `
      #include <alphatest_fragment>
      float halfW   = ${(PIECE_W * 0.5).toFixed(4)};
      float halfLen = ${(PIECE_H * 0.5).toFixed(4)};
      bool  isFin   = vWorldPos.y > ${(PIECE_T * 0.5).toFixed(4)};

      const float PULSE_COUNT = 5.0;
      const float FLAT_FRAC   = 0.4;
      const float RAMP_FRAC   = 0.0;
      const float ANGLE_SPAN  = 0.85;
      const float LINE_WIDTH  = 0.2;
      const float ROTATE_DEG  = 180.0;   // rotate the whole pattern (degrees)

      float rotRad = radians(ROTATE_DEG);
      float cosR   = cos(rotRad);
      float sinR   = sin(rotRad);
      float xR     =  vWorldPos.x * cosR - vWorldPos.z * sinR;
      float zR     =  vWorldPos.x * sinR + vWorldPos.z * cosR;

      float fullW    = halfW * 2.0;
      float periodW  = fullW / PULSE_COUNT;

      // Measure from center and mirror — guarantees left/right symmetry
      float zAbs     = abs(zR);                       // 0 .. halfW
      float zInCycle = mod(zAbs, periodW) / periodW;   // 0..1 within this pulse, mirrored

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

      float lineCenterX  = (wave - 0.5) * halfLen * 2.0 * ANGLE_SPAN;
      float distFromLine = abs(xR - lineCenterX);

      if (distFromLine < halfLen * LINE_WIDTH && !isFin) discard;
      `
    );
  };

  this.instancedMesh = new THREE.InstancedMesh(pieceFinal2, pieceMat, this._trackPieceCount);

} else if (this.beltType === 7) {
  // ── Four trapezoidal window pockets + center V-rib + two subdividers ──────
  pieceMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = `
      varying vec3 vWorldPos;
    ` + shader.fragmentShader;

    shader.vertexShader = `
      varying vec3 vWorldPos;
    ` + shader.vertexShader.replace(
      `#include <begin_vertex>`,
      `#include <begin_vertex>
      vWorldPos = position;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <alphatest_fragment>`,
      `
      #include <alphatest_fragment>
      float halfW   = ${(PIECE_W * 0.5).toFixed(4)};
      float halfLen = ${(PIECE_H * 0.5).toFixed(4)};
      bool  isFin   = vWorldPos.y > ${(PIECE_T * 0.5).toFixed(4)};

      // ── Tunables ──────────────────────────────────────────────────────────
      const float BORDER_Z     = 0.14;   // solid outer frame width (fraction of halfW, each side)
      const float BORDER_X     = 0.12;   // solid outer frame length (fraction of halfLen, each end)
      const float RIB_HALF_Z   = 0.10;   // half-width of the solid center V-rib (fraction of halfW)
      const float RIB_TAPER    = 0.55;   // 0..1, how much the rib narrows toward its tip (V shape)
      const float SUBDIV_HALF_Z = 0.3; // half-width of each secondary divider

      float zN = vWorldPos.z / halfW;    // -1 .. 1  (width axis)
      float xN = vWorldPos.x / halfLen;  // -1 .. 1  (length axis)

      // Solid outer frame — never discard near the piece edges
      bool inBorder = (abs(zN) > 1.0 - BORDER_Z) || (abs(xN) > 1.0 - BORDER_X);

      // Solid center V-rib — widest at center (xN = 0), narrows toward both ends
      float ribHalfAtX = RIB_HALF_Z * (1.0 - RIB_TAPER * abs(xN));
      bool inRib = abs(zN) < ribHalfAtX;

      // Secondary dividers — bisect each of the two pockets down their own
      // centers, splitting each trapezoidal window into two (4 windows total)
      float pocketCenterZ = (ribHalfAtX + (1.0 - BORDER_Z)) * 0.5;
      bool inSubdivRight = abs(zN - pocketCenterZ) < SUBDIV_HALF_Z;
      bool inSubdivLeft  = abs(zN + pocketCenterZ) < SUBDIV_HALF_Z;

      bool isPocket = !inBorder && !inRib && !inSubdivLeft && !inSubdivRight;

      if (isPocket && !isFin) discard;
      `
    );
  };

  this.instancedMesh = new THREE.InstancedMesh(pieceFinal2, pieceMat, this._trackPieceCount);

} else {
  this.instancedMesh = new THREE.InstancedMesh(pieceFinal, pieceMat, this._trackPieceCount);
}

  this.instancedMesh.castShadow    = false;
  this.instancedMesh.receiveShadow = false;
  this.instancedMesh.frustumCulled = false;
  this.scene.add(this.instancedMesh);

  // ── Grouser (separate material) ──────────────────────────────────────────
  const grouserGeoRaw = new THREE.BoxGeometry(0.04, 0.04, PIECE_W * 0.75 * this._trackWidth);
  grouserGeoRaw.applyMatrix4(
    new THREE.Matrix4().makeTranslation(PIECE_T * 0.5 + 0.04, 0, 0)
  );
  const grouserGeo = toNonIndexedSafe(grouserGeoRaw);

  const grouserMat = new THREE.MeshStandardMaterial({
    color:     0x2a2a2a,   // ← tweak grouser colour independently here
    roughness: 1.0,
    metalness: 0.0,
  });

  this.grouserMesh = new THREE.InstancedMesh(grouserGeo, grouserMat, this._trackPieceCount);
  this.grouserMesh.castShadow    = false;
  this.grouserMesh.receiveShadow = false;
  this.grouserMesh.frustumCulled = false;
  this.scene.add(this.grouserMesh);

  this._dummy = new THREE.Object3D();
}

// ── Bogie instanced matrix writer ─────────────────────────────────────────

_updateBogieInstanceMatrices(bodyMatrix, bodyQ) {
    if (!this._bogieArmInstanced) return;

    const armCount   = this._bogieArmPivotX.length;
    const halfSpan   = this._bogieHalfSpan;
    const sideZ      = this.side * this._outerZ;
    const d          = this._bogieDummy;
    const zAxis      = new THREE.Vector3(0, 0, 1);
    const xAxis      = new THREE.Vector3(0, 0, 1);
    const armLocalQ  = new THREE.Quaternion();
    const finalQ     = new THREE.Quaternion();
    const localPos   = new THREE.Vector3();
    const worldPos   = new THREE.Vector3();
    const wheelSpinQ = new THREE.Quaternion();

    for (let i = 0; i < armCount; i++) {
      const pivotX = this._bogieArmPivotX[i];
      const pivotY = this._bogieArmPivotYArr[i] + 0.055;
      const rotZ   = this._bogieArmRotZ[i];
      const offsetY = -0.1;

      // ── Arm instance ──────────────────────────────────────────────────────
      armLocalQ.setFromAxisAngle(zAxis, rotZ);
      finalQ.copy(bodyQ).multiply(armLocalQ);

      localPos.set(pivotX, pivotY + offsetY, sideZ);
      worldPos.copy(localPos).applyMatrix4(bodyMatrix);

      d.position.copy(worldPos);
      d.quaternion.copy(finalQ);
      d.updateMatrix();
      this._bogieArmInstanced.setMatrixAt(i, d.matrix);

      // ── Two wheel instances ───────────────────────────────────────────────
      for (let w = 0; w < 2; w++) {
        const wi      = i * 2 + w;
        const offsetX = (w === 0 ? -1 : 1) * halfSpan;
        const spinQ   = new THREE.Quaternion();
        spinQ.setFromAxisAngle(xAxis, this._bogieWheelSpin[wi]);

        const localWheelOffset = new THREE.Vector3(offsetX, offsetY, 0);
        localWheelOffset.applyQuaternion(armLocalQ);

        const wheelLocalPos = new THREE.Vector3(
          pivotX + localWheelOffset.x,
          pivotY + localWheelOffset.y,
          sideZ  + localWheelOffset.z
        );
        worldPos.copy(wheelLocalPos).applyMatrix4(bodyMatrix);

        finalQ.copy(bodyQ).multiply(armLocalQ).multiply(spinQ);

        d.position.copy(worldPos);
        d.quaternion.copy(finalQ);
        d.updateMatrix();
        this._bogieWheelInstanced.setMatrixAt(wi, d.matrix);
      }

      // ── NEW: conjugated return roller (Bogie Type 6 only) ──────────────────
      if (this._bogieRRInstanced) {
        const rd = this._bogieRRDummy;
        const rollerSpinQ = new THREE.Quaternion();
        rollerSpinQ.setFromAxisAngle(xAxis, this._bogieRRSpin[i] ?? 0);

        const rrOffsetX = this._bogieRRXOffset ?? 0;
        const rollerLocalOffset = new THREE.Vector3(rrOffsetX, offsetY + this._bogieRRYOffset, 0);
        rollerLocalOffset.applyQuaternion(armLocalQ);

        const rollerLocalPos = new THREE.Vector3(
          pivotX + rollerLocalOffset.x,
          pivotY + rollerLocalOffset.y,
          sideZ  + rollerLocalOffset.z
        );
        worldPos.copy(rollerLocalPos).applyMatrix4(bodyMatrix);

        finalQ.copy(bodyQ).multiply(armLocalQ).multiply(rollerSpinQ);

        rd.position.copy(worldPos);
        rd.quaternion.copy(finalQ);
        rd.updateMatrix();
        this._bogieRRInstanced.setMatrixAt(i, rd.matrix);
      }
    }

    this._bogieArmInstanced.instanceMatrix.needsUpdate   = true;
    this._bogieWheelInstanced.instanceMatrix.needsUpdate = true;
    if (this._bogieRRInstanced) {
      this._bogieRRInstanced.instanceMatrix.needsUpdate = true;
    }
  }

_updateBogieT2Groups(bodyMatrix, bodyQ) {
  if (!this._bogieArmInstanced) return;

  const halfSpan = this._bogieHalfSpan;
  const sideZ    = this.side * this._outerZ;
  const d        = this._bogieDummy;
  const zAxis    = new THREE.Vector3(0, 0, 1);
  const xAxis    = new THREE.Vector3(0, 0, 1);
  const armLocalQ  = new THREE.Quaternion();
  const finalQ     = new THREE.Quaternion();
  const localPos   = new THREE.Vector3();
  const worldPos   = new THREE.Vector3();

  // 4 wheel offsets per arm (local X offset from pivot, local Z offset)
  const oz_L = -0.05 * this._bogieS;
  const oz_R =  0.05 * this._bogieS;
  const wheelOffsets = [
    { ox: -halfSpan, oz: oz_L - 0.1 * this._bogieS },
    { ox: -halfSpan, oz: oz_L + 0.1 * this._bogieS },
    { ox:  halfSpan, oz: oz_R - 0.1 * this._bogieS },
    { ox:  halfSpan, oz: oz_R + 0.1 * this._bogieS },
  ];

  const armCount = this._bogieArmPivotX.length;

  for (let i = 0; i < armCount; i++) {
    const pivotX  = this._bogieArmPivotX[i];
    const pivotY  = this._bogieArmPivotYArr[i] - 0.055;
    const rotZ    = this._bogieArmRotZ[i];

    armLocalQ.setFromAxisAngle(zAxis, rotZ);
    finalQ.copy(bodyQ).multiply(armLocalQ);

    // ── Arm frame 1 ───────────────────────────────────────────────────────
    localPos.set(pivotX, pivotY, sideZ);
    worldPos.copy(localPos).applyMatrix4(bodyMatrix);
    d.position.copy(worldPos);
    d.quaternion.copy(finalQ);
    d.updateMatrix();
    this._bogieArmInstanced.setMatrixAt(i, d.matrix);

    // ── Arm frame 2 (same position/rotation — mirror baked into geometry) ─
    // this._bogieArm2Instanced.setMatrixAt(i, d.matrix);

    // ── 4 wheels ──────────────────────────────────────────────────────────
    const spinQ = new THREE.Quaternion();
    wheelOffsets.forEach(({ ox, oz }, w) => {
      const wi = i * 4 + w;

      spinQ.setFromAxisAngle(xAxis, this._bogieWheelSpin[wi] ?? 0);

      // Rotate wheel offset by arm tilt
      const localWheelOffset = new THREE.Vector3(ox, 0, oz);
      localWheelOffset.applyQuaternion(armLocalQ);

      const wheelLocalPos = new THREE.Vector3(
        pivotX + localWheelOffset.x,
        pivotY + localWheelOffset.y,
        sideZ  + localWheelOffset.z
      );
      worldPos.copy(wheelLocalPos).applyMatrix4(bodyMatrix);

      finalQ.copy(bodyQ).multiply(armLocalQ).multiply(spinQ);

      d.position.copy(worldPos);
      d.quaternion.copy(finalQ);
      d.updateMatrix();
      this._bogieWheelInstanced.setMatrixAt(wi, d.matrix);
    });
  }

  this._bogieArmInstanced.instanceMatrix.needsUpdate  = true;
  // this._bogieArm2Instanced.instanceMatrix.needsUpdate = true;
  this._bogieWheelInstanced.instanceMatrix.needsUpdate = true;
}

_updateBogieT3Groups(bodyMatrix, bodyQ) {
  if (!this._bogieArmInstanced) return;

  const halfSpan = this._bogieHalfSpan;
  const sideZ    = this.side * this._outerZ;
  const d        = this._bogieDummy;
  const zAxis    = new THREE.Vector3(0, 0, 1);
  const xAxis    = new THREE.Vector3(0, 0, 1);   // wheel spin axis
  const armLocalQ  = new THREE.Quaternion();
  const finalQ     = new THREE.Quaternion();
  const localPos   = new THREE.Vector3();
  const worldPos   = new THREE.Vector3();

  const s    = this._bogieS;
  const zGap = 0.08 * s;   // must match getBogieT3WheelOffsets

  // 4 wheel slots per arm:
  //   0,1 → left endpoint  (ox = -halfSpan), z = ±zGap
  //   2,3 → right endpoint (ox = +halfSpan), z = ±zGap
  const wheelOffsets = [
    { ox: -halfSpan, oz: sideZ + zGap  },
    { ox: -halfSpan, oz: sideZ - zGap  },
    { ox:  halfSpan, oz: sideZ + zGap  },
    { ox:  halfSpan, oz: sideZ - zGap  },
  ];

  const armCount = this._bogieArmPivotX.length;

  for (let i = 0; i < armCount; i++) {
    const pivotX = this._bogieArmPivotX[i];
    const pivotY = this._bogieArmPivotYArr[i] - 0.055;
    const rotZ   = this._bogieArmRotZ[i];

    armLocalQ.setFromAxisAngle(zAxis, rotZ);
    finalQ.copy(bodyQ).multiply(armLocalQ);

    // ── Arm ───────────────────────────────────────────────────────────────
    localPos.set(pivotX, pivotY, sideZ);
    worldPos.copy(localPos).applyMatrix4(bodyMatrix);
    d.position.copy(worldPos);
    d.quaternion.copy(finalQ);
    d.updateMatrix();
    this._bogieArmInstanced.setMatrixAt(i, d.matrix);

    // ── 4 wheels ──────────────────────────────────────────────────────────
    const spinQ = new THREE.Quaternion();
    wheelOffsets.forEach(({ ox, oz }, w) => {
      const wi = i * 4 + w;

      spinQ.setFromAxisAngle(xAxis, this._bogieWheelSpin[wi] ?? 0);

      // Rotate the X offset by the arm tilt, keep Z absolute (not rotated by arm)
      const localWheelOffset = new THREE.Vector3(ox, 0, 0);
      localWheelOffset.applyQuaternion(armLocalQ);

      const wheelLocalPos = new THREE.Vector3(
        pivotX + localWheelOffset.x,
        pivotY + localWheelOffset.y,
        oz                              // absolute world-Z (sideZ ± zGap)
      );
      worldPos.copy(wheelLocalPos).applyMatrix4(bodyMatrix);

      finalQ.copy(bodyQ).multiply(armLocalQ).multiply(spinQ);
      d.position.copy(worldPos);
      d.quaternion.copy(finalQ);
      d.updateMatrix();
      this._bogieWheelInstanced.setMatrixAt(wi, d.matrix);
    });
  }

  this._bogieArmInstanced.instanceMatrix.needsUpdate   = true;
  this._bogieWheelInstanced.instanceMatrix.needsUpdate = true;
}

_updateBogieT4Groups(bodyMatrix, bodyQ) {
  if (!this._bogieArmInstanced) return;

  const halfSpan = this._bogieHalfSpan;
  const sideZ    = this.side * this._outerZ;
  const s        = this._bogieS;
  const d        = this._bogieDummy;
  const zAxis    = new THREE.Vector3(0, 0, 1);
  const xAxis    = new THREE.Vector3(0, 0, 1);
  const armLocalQ  = new THREE.Quaternion();
  const finalQ     = new THREE.Quaternion();
  const localPos   = new THREE.Vector3();
  const worldPos   = new THREE.Vector3();

  const zGap = 0.08 * s;

  // Same 4-wheel layout as Type 3
  const wheelOffsets = [
    { ox: -halfSpan, oz: sideZ + zGap },
    { ox: -halfSpan, oz: sideZ - zGap },
    { ox:  halfSpan, oz: sideZ + zGap },
    { ox:  halfSpan, oz: sideZ - zGap },
  ];

  const armCount = this._bogieArmPivotX.length;
  const pivotTopY = 0.17 * s * 1.1;   // matches makeBogieArmMeshType4 topY

  for (let i = 0; i < armCount; i++) {
    const pivotX = this._bogieArmPivotX[i];
    const pivotY = this._bogieArmPivotYArr[i] - 0.055;
    const rotZ   = this._bogieArmRotZ[i];

    armLocalQ.setFromAxisAngle(zAxis, rotZ);
    finalQ.copy(bodyQ).multiply(armLocalQ);

    // ── Arm ───────────────────────────────────────────────────────────────
    localPos.set(pivotX, pivotY, sideZ);
    worldPos.copy(localPos).applyMatrix4(bodyMatrix);
    d.position.copy(worldPos);
    d.quaternion.copy(finalQ);
    d.updateMatrix();
    this._bogieArmInstanced.setMatrixAt(i, d.matrix);

    // ── 4 wheels ──────────────────────────────────────────────────────────
    const spinQ = new THREE.Quaternion();
    wheelOffsets.forEach(({ ox, oz }, w) => {
      const wi = i * 4 + w;
      spinQ.setFromAxisAngle(xAxis, this._bogieWheelSpin[wi] ?? 0);

      const localWheelOffset = new THREE.Vector3(ox, 0, 0);
      localWheelOffset.applyQuaternion(armLocalQ);

      const wheelLocalPos = new THREE.Vector3(
        pivotX + localWheelOffset.x,
        pivotY + localWheelOffset.y,
        oz
      );
      worldPos.copy(wheelLocalPos).applyMatrix4(bodyMatrix);

      finalQ.copy(bodyQ).multiply(armLocalQ).multiply(spinQ);
      d.position.copy(worldPos);
      d.quaternion.copy(finalQ);
      d.updateMatrix();
      this._bogieWheelInstanced.setMatrixAt(wi, d.matrix);
    });
  }

  // ── Equalising beams — one per adjacent arm pair ──────────────────────
  if (this._bogieBeamInstanced) {
    const beamQ = new THREE.Quaternion();

    for (let p = 0; p < this._bogiePairCount; p++) {
      const iA = p * 2;
      const iB = p * 2 + 1;

      const xA     = this._bogieArmPivotX[iA];
      const xB     = this._bogieArmPivotX[iB];
      const yA     = this._bogieArmPivotYArr[iA] - 0.1 + pivotTopY;
      const yB     = this._bogieArmPivotYArr[iB] - 0.1 + pivotTopY;

      // Beam sits at midpoint of the two arm top pivots
      const beamX  = (xA + xB) * 0.5;
      const beamY  = (yA + yB) * 0.5;

      // Beam tilts to match the height difference between paired arms
      const dx     = xB - xA;
      const dy     = yB - yA;
      const tiltZ  = Math.atan2(dy, dx) * 2;  // beam rotates to follow arm height diff

      beamQ.setFromAxisAngle(zAxis, tiltZ);
      finalQ.copy(bodyQ).multiply(beamQ);

      localPos.set(beamX, beamY, sideZ);
      worldPos.copy(localPos).applyMatrix4(bodyMatrix);

      d.position.copy(worldPos);
      d.quaternion.copy(finalQ);
      d.updateMatrix();
      this._bogieBeamInstanced.setMatrixAt(p, d.matrix);
    }

    this._bogieBeamInstanced.instanceMatrix.needsUpdate = true;
  }

  this._bogieArmInstanced.instanceMatrix.needsUpdate   = true;
  this._bogieWheelInstanced.instanceMatrix.needsUpdate = true;
}

_updateBogieT5Groups(bodyMatrix, bodyQ) {
  const halfSpan   = this._bogieHalfSpan;
  const sideZ      = this.side * this._outerZ;
  const s          = this._bogieS;
  const d          = this._bogieDummy;
  const zAxis      = new THREE.Vector3(0, 0, 1);
  const xAxis      = new THREE.Vector3(0, 0, 1);
  const armLocalQ  = new THREE.Quaternion();
  const finalQ     = new THREE.Quaternion();
  const localPos   = new THREE.Vector3();
  const worldPos   = new THREE.Vector3();

  const zGap = 0.08 * s;
  const armCount = this._bogieArmPivotX.length;

  // ── Wheel offset slots per arm (4 base wheels) ────────────────────────────
  // slot 0: ox = -halfSpan, oz = sideZ + zGap
  // slot 1: ox = -halfSpan, oz = sideZ - zGap
  // slot 2: ox = +halfSpan, oz = sideZ + zGap
  // slot 3: ox = +halfSpan, oz = sideZ - zGap
  const baseWheelOffsets = [
    { ox: -halfSpan, oz: sideZ + zGap },
    { ox: -halfSpan, oz: sideZ - zGap },
    { ox:  halfSpan, oz: sideZ + zGap },
    { ox:  halfSpan, oz: sideZ - zGap },
  ];

  // Link wheel offsets (extra 2 wheels for end arms)
  // front arm (isLast=false): link at -halfSpan*3
  // back  arm (isLast=true):  link at +halfSpan*3
  const frontLinkWheelOffsets = [
    { ox: -halfSpan * 3, oz: sideZ + zGap },
    { ox: -halfSpan * 3, oz: sideZ - zGap },
  ];
  const backLinkWheelOffsets = [
    { ox: halfSpan * 3, oz: sideZ + zGap },
    { ox: halfSpan * 3, oz: sideZ - zGap },
  ];

  // ── Wheel instance index layout ───────────────────────────────────────────
  // [0 .. armCount*4 - 1]         → base wheels (4 per arm, all arms)
  // [armCount*4 .. +1]            → front link wheels (if active)
  // [armCount*4 + 2 .. +3]        → back link wheels  (if active)
  const baseLinkOffset  = armCount * 4;
  const backLinkOffset  = baseLinkOffset + (this._bogieT5FrontLinkActive ? 2 : 0);

  let midSlot  = 0;   // counter into _bogieArmInstanced (middle arms)

  const spinQ = new THREE.Quaternion();

  for (let i = 0; i < armCount; i++) {
    const pivotX = this._bogieArmPivotX[i];
    const pivotY = this._bogieArmPivotYArr[i] - 0.055;
    const rotZ   = this._bogieArmRotZ[i];

    armLocalQ.setFromAxisAngle(zAxis, rotZ);
    finalQ.copy(bodyQ).multiply(armLocalQ);

    localPos.set(pivotX, pivotY, sideZ);
    worldPos.copy(localPos).applyMatrix4(bodyMatrix);
    d.position.copy(worldPos);
    d.quaternion.copy(finalQ);
    d.updateMatrix();

    const isFirst = i === 0;
    const isLast  = i === armCount - 1;
    const hasFrontLink = isFirst && this._bogieT5FrontLinkActive;
    const hasBackLink  = isLast  && this._bogieT5BackLinkActive;

    // ── Place arm into correct instanced mesh ─────────────────────────────
    if (hasFrontLink && this._bogieT5FrontArmInstanced) {
      this._bogieT5FrontArmInstanced.setMatrixAt(0, d.matrix);
    } else if (hasBackLink && this._bogieT5BackArmInstanced) {
      this._bogieT5BackArmInstanced.setMatrixAt(0, d.matrix);
    } else if (this._bogieArmInstanced) {
      this._bogieArmInstanced.setMatrixAt(midSlot++, d.matrix);
    }

    // ── Place 4 base wheels ───────────────────────────────────────────────
    baseWheelOffsets.forEach(({ ox, oz }, w) => {
      const wi = i * 4 + w;
      spinQ.setFromAxisAngle(xAxis, this._bogieWheelSpin[wi] ?? 0);

      const localWheelOffset = new THREE.Vector3(ox, 0, 0);
      localWheelOffset.applyQuaternion(armLocalQ);

      const wheelLocalPos = new THREE.Vector3(
        pivotX + localWheelOffset.x,
        pivotY + localWheelOffset.y,
        oz
      );
      worldPos.copy(wheelLocalPos).applyMatrix4(bodyMatrix);
      finalQ.copy(bodyQ).multiply(armLocalQ).multiply(spinQ);

      d.position.copy(worldPos);
      d.quaternion.copy(finalQ);
      d.updateMatrix();
      this._bogieWheelInstanced.setMatrixAt(wi, d.matrix);
    });

    // ── Place front link wheels (first arm only) ──────────────────────────
    if (hasFrontLink) {
      frontLinkWheelOffsets.forEach(({ ox, oz }, w) => {
        const wi = baseLinkOffset + w;
        spinQ.setFromAxisAngle(xAxis, this._bogieWheelSpin[wi] ?? 0);

        const localWheelOffset = new THREE.Vector3(ox, 0, 0);
        localWheelOffset.applyQuaternion(armLocalQ);

        const wheelLocalPos = new THREE.Vector3(
          pivotX + localWheelOffset.x,
          pivotY + localWheelOffset.y,
          oz
        );
        worldPos.copy(wheelLocalPos).applyMatrix4(bodyMatrix);
        finalQ.copy(bodyQ).multiply(armLocalQ).multiply(spinQ);

        d.position.copy(worldPos);
        d.quaternion.copy(finalQ);
        d.updateMatrix();
        this._bogieWheelInstanced.setMatrixAt(wi, d.matrix);
      });
    }

    // ── Place back link wheels (last arm only) ────────────────────────────
    if (hasBackLink) {
      backLinkWheelOffsets.forEach(({ ox, oz }, w) => {
        const wi = backLinkOffset + w;
        spinQ.setFromAxisAngle(xAxis, this._bogieWheelSpin[wi] ?? 0);

        const localWheelOffset = new THREE.Vector3(ox, 0, 0);
        localWheelOffset.applyQuaternion(armLocalQ);

        const wheelLocalPos = new THREE.Vector3(
          pivotX + localWheelOffset.x,
          pivotY + localWheelOffset.y,
          oz
        );
        worldPos.copy(wheelLocalPos).applyMatrix4(bodyMatrix);
        finalQ.copy(bodyQ).multiply(armLocalQ).multiply(spinQ);

        d.position.copy(worldPos);
        d.quaternion.copy(finalQ);
        d.updateMatrix();
        this._bogieWheelInstanced.setMatrixAt(wi, d.matrix);
      });
    }
  }

  if (this._bogieArmInstanced)         this._bogieArmInstanced.instanceMatrix.needsUpdate         = true;
  if (this._bogieT5FrontArmInstanced)  this._bogieT5FrontArmInstanced.instanceMatrix.needsUpdate  = true;
  if (this._bogieT5BackArmInstanced)   this._bogieT5BackArmInstanced.instanceMatrix.needsUpdate   = true;
  this._bogieWheelInstanced.instanceMatrix.needsUpdate = true;
}

_updateTorsionMatrices(bodyMatrix, bodyQ, wheelCurrentY) {
  if (!this._torsionArmInstanced) return;

  const { roadWheelXPositions } = this.cfg;
  const sideZ  = this.side * (this._outerZ - 0.25);
  const sideZ2 = this.side * (this._outerZ + 0.14 * this._trackWidth);
  const d      = this._torsionDummy;
  const zAxis  = new THREE.Quaternion();
  const armQ   = new THREE.Quaternion();
  const finalQ = new THREE.Quaternion();
  const zVec   = new THREE.Vector3(0, 0, 1);
  const localPos = new THREE.Vector3();
  const worldPos = new THREE.Vector3();

  // Always recompute from current radius so it matches rebuilt geometry
  const ARM_LEN  = 0.54 * ((this.cfg.roadWheelRadius ?? 0.25) / 0.25);
  const REST_ANG = this._TORSION_ARM_ANG;

  // Also keep _TORSION_ARM_LEN in sync for anything else that reads it
  this._TORSION_ARM_LEN = ARM_LEN;

  // Recompute pivots if ARM_LEN changed (e.g. radius slider moved)
  if (!this._torsionPivots || this._torsionPivots.length !== roadWheelXPositions.length
      || Math.abs(this._torsionPivots[0].x - (roadWheelXPositions[0] - ARM_LEN * Math.cos(REST_ANG))) > 0.0001) {
    this._torsionPivots = roadWheelXPositions.map((wheelX) => ({
      x: wheelX              - ARM_LEN * Math.cos(REST_ANG),
      y: this.cfg.roadWheelY - ARM_LEN * Math.sin(REST_ANG),
    }));
  }

  roadWheelXPositions.forEach((wheelX, i) => {
    const restWheelY    = this.cfg.roadWheelY;
    const currentWheelY = wheelCurrentY[i] ?? restWheelY;

    // ── Fixed pivot — stored at build time, never recalculated ───────────────
    // Falls back to recomputing if _torsionPivots not yet set (first call)
    const pivot = this._torsionPivots?.[i] ?? {
      x: wheelX    - ARM_LEN * Math.cos(REST_ANG),
      y: restWheelY - ARM_LEN * Math.sin(REST_ANG),
    };

    // ── Current arm angle: pivot is fixed, wheel Y changes → angle changes ──
    // tip = pivot + ARM_LEN*(cos θ, sin θ)
    // We want tip.y = currentWheelY, tip.x = wheelX (X doesn't change for
    // a vertical suspension input — only Y changes)
    // So: sin θ = (currentWheelY - pivot.y) / ARM_LEN
    //     cos θ = (wheelX        - pivot.x) / ARM_LEN  ← use this to pick correct quadrant
    // Suspension moves wheel Y; X is constrained to stay on the arc circle.
    // Solve: tip is always ARM_LEN from pivot.
    // Given tip.y = currentWheelY, find tip.x on the circle.
    // dy = currentWheelY - pivot.y
    // dx = sqrt(ARM_LEN^2 - dy^2)  — take same sign as rest dx
    const dy      = currentWheelY - pivot.y;
    const dyClamp = Math.max(-ARM_LEN, Math.min(ARM_LEN, dy));
    const restDx  = wheelX - pivot.x;
    const arcDx   = Math.sqrt(Math.max(0, ARM_LEN * ARM_LEN - dyClamp * dyClamp))
                    * Math.sign(restDx);
    const armAngle = Math.atan2(dyClamp, arcDx);

    // ── Arm mesh: placed at fixed pivot, rotated to armAngle ─────────────────
    armQ.setFromAxisAngle(zVec, armAngle);
    finalQ.copy(bodyQ).multiply(armQ);

    localPos.set(pivot.x, pivot.y, sideZ);
    worldPos.copy(localPos).applyMatrix4(bodyMatrix);
    d.position.copy(worldPos);
    d.quaternion.copy(finalQ);
    d.updateMatrix();
    this._torsionArmInstanced.setMatrixAt(i, d.matrix);

    // ── Road wheel mesh: tip of arm = fixed wheelX, suspension-driven Y ──────
    // ── Road wheel mesh: follows exact arc tip position ───────────────────────
    // tip = pivot + ARM_LEN * (cos(armAngle), sin(armAngle))
    // Both X and Y change as the arm swings — X is NOT fixed during arc motion
    // ── Road wheel: arc tip position ──────────────────────────────────────────
    const tipX = pivot.x + ARM_LEN * Math.cos(armAngle);
    const tipY = pivot.y + ARM_LEN * Math.sin(armAngle);

    if (this._torsionRwInstanced && this._torsionRwDummy) {
      // ── Instanced path (torsion bar mode) ──────────────────────────────────
      // rwIndex maps roadWheelXPositions index → instanced slot
      // _rwXPositions was built with the same filter as wheelInitialY
      const rwIndex = this._rwXPositions.indexOf(roadWheelXPositions[i]);
      if (rwIndex >= 0) {
        const rwD = this._torsionRwDummy;

        // Wheel spins around its local X axis (rotation.x = PI/2 baked into geo)
        // We apply wheel spin as a Z rotation in body space after bodyQ
        const spinQ = new THREE.Quaternion();
        spinQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), this._torsionWheelSpin?.[rwIndex] ?? 0);

        const rwFinalQ = new THREE.Quaternion().copy(bodyQ).multiply(spinQ);

        const rwLocalPos = new THREE.Vector3(tipX, tipY, this.side * this._outerZ);
        const rwWorldPos = rwLocalPos.clone().applyMatrix4(bodyMatrix);

        rwD.position.copy(rwWorldPos);
        rwD.quaternion.copy(rwFinalQ);
        rwD.updateMatrix();
        this._torsionRwInstanced.setMatrixAt(rwIndex, rwD.matrix);
      }
    } else if (this.roadWheelMeshes[i]) {
      // ── Fallback individual mesh path ──────────────────────────────────────
      this.roadWheelMeshes[i].position.x = tipX;
      this.roadWheelMeshes[i].position.y = tipY;
    }

    // ── Secondary arm (doubleSide) ────────────────────────────────────────────
    if (this._torsionArmInstanced2) {
      localPos.set(pivot.x, pivot.y, sideZ2);
      worldPos.copy(localPos).applyMatrix4(bodyMatrix);
      d.position.copy(worldPos);
      d.quaternion.copy(finalQ);
      d.updateMatrix();
      this._torsionArmInstanced2.setMatrixAt(i, d.matrix);
    }
  });

  this._torsionArmInstanced.instanceMatrix.needsUpdate = true;
  if (this._torsionArmInstanced2) {
    this._torsionArmInstanced2.instanceMatrix.needsUpdate = true;
  }
  if (this._torsionRwInstanced) {
    this._torsionRwInstanced.instanceMatrix.needsUpdate = true;
  }
}
  // ── Ground sampling ───────────────────────────────────────────────────────

_sampleGroundY(localX, fallbackY, rwR) {
    const RAPIER = this.world?.__RAPIER__;
    if (!RAPIER || !this._bodyMatrix || !this._tankRigidBody) return fallbackY;
    try {
      if (this._tankRigidBody.isValid && !this._tankRigidBody.isValid()) return fallbackY;
    } catch (_) { return fallbackY; }

    const sideZ = this.side * this._outerZ;
    const localPos  = new THREE.Vector3(localX, fallbackY, sideZ);
    const worldPos  = localPos.clone().applyMatrix4(this._bodyMatrix);

    const rayOriginY = worldPos.y + 1.5;
    const ray = new RAPIER.Ray(
      { x: worldPos.x, y: rayOriginY, z: worldPos.z },
      { x: 0, y: -1, z: 0 }
    );

    const hit = this.world.castRay(
      ray, 3.0, true,
      undefined, undefined, undefined,
      this._tankRigidBody
    );

    if (!hit) return fallbackY;

    const hitWorldY = rayOriginY - hit.timeOfImpact;
    const excess    = hitWorldY - worldPos.y;

    if (excess <= 0.01) return fallbackY;

    return fallbackY + excess;
  }

  /**
 * Cast a downward ray at (localX, baseY) and return how much
 * the ground is above the base rest position (positive = bump up).
 * Returns 0 if physics world is not available.
 */
_sampleWheelGroundLift(localX, baseY, wheelR) {
  const RAPIER = this.world?.__RAPIER__;
  if (!RAPIER || !this._bodyMatrix || !this._tankRigidBody) return 0;
  try {
    if (this._tankRigidBody.isValid && !this._tankRigidBody.isValid()) return 0;
  } catch (_) { return 0; }

  const sideZ    = this.side * this._outerZ;
  const localPos = new THREE.Vector3(localX, baseY + wheelR + 0.5, sideZ);
  const worldPos = localPos.applyMatrix4(this._bodyMatrix);

  const ray = new RAPIER.Ray(
    { x: worldPos.x, y: worldPos.y, z: worldPos.z },
    { x: 0, y: -1, z: 0 }
  );

  const hit = this.world.castRay(
    ray, wheelR + 1.0, true,
    undefined, undefined, undefined,
    this._tankRigidBody
  );

  if (!hit) return 0;

  const hitWorldY  = worldPos.y - hit.timeOfImpact;
  const restWorldY = new THREE.Vector3(localX, baseY, sideZ)
    .applyMatrix4(this._bodyMatrix).y;

  // How far above the rest position is the ground contact point?
  const groundContactY = hitWorldY + wheelR;
  return Math.max(0, groundContactY - restWorldY);
}

// ── Bogie System Type 6: current world/body-local positions of each ─────────
// arm's conjugated return roller, mirroring the placement math used in
// _updateBogieInstanceMatrices so the belt path matches what's rendered.
_getBogieRollerAnchors() {
  if (!this._bogieArmPivotX || this._bogieRRYOffset == null) return [];

  const offsetY = -0.1;   // must match _updateBogieInstanceMatrices
  const localX  = this._bogieRRXOffset ?? 0;
  const localY  = offsetY + this._bogieRRYOffset;

  return this._bogieArmPivotX.map((pivotX, i) => {
    const pivotY = (this._bogieArmPivotYArr?.[i] ?? this._bogieArmPivotY) + 0.055;
    const rotZ   = this._bogieArmRotZ?.[i] ?? 0;
    const cos = Math.cos(rotZ), sin = Math.sin(rotZ);

    // Same rotation as Vector3.applyQuaternion(armLocalQ) for a Z-axis rotation
    const rx = localX * cos - localY * sin;
    const ry = localX * sin + localY * cos;

    return { x: pivotX + rx, y: pivotY + ry };
  });
}

  // ── Belt path ─────────────────────────────────────────────────────────────

_buildPath() {
    const pts = [];

    const { roadWheelXPositions, sprocketX, idlerX } = this.cfg;
    const enableInOut = this.cfg.enableInAndOutWheels ?? false;

const pathWheelX = (() => {
  if (this.enableBogieWheels) {
    // Expand each bogie arm pivot into its individual wheel X positions
    const baseX    = this._bogieBaseX ?? [];
    const halfSpan = this._bogieHalfSpan ?? 0;
    const expanded = [];

    for (let i = 0; i < baseX.length; i++) {
      // Left wheel of arm (idler side) then right wheel (sprocket side)
      // baseX is sorted front→rear so -halfSpan is toward idler, +halfSpan toward sprocket
      expanded.push(baseX[i] - halfSpan);
      expanded.push(baseX[i] + halfSpan);
    }

    // Sort by X so belt flows correctly front to back
    // (idler is at most negative X, sprocket at most positive)
    expanded.sort((a, b) => a - b);

    // Remove near-duplicates (adjacent arms whose wheels are very close)
    const deduped = [expanded[0]];
    for (let i = 1; i < expanded.length; i++) {
      if (Math.abs(expanded[i] - deduped[deduped.length - 1]) > 0.01) {
        deduped.push(expanded[i]);
      }
    }
    return deduped;
  }

  if (enableInOut) {
    const outerOnly = roadWheelXPositions.filter((_, i) => i % 2 === 0);
    const innerOnly = roadWheelXPositions.filter((_, i) => i % 2 === 1);
    const result = this.hideLastRw ? outerOnly.slice(0, -1) : outerOnly;
    result[0] = innerOnly[0] ?? result[0];
    return result;
  }

  return roadWheelXPositions;
})();

// Build a lookup: X position → current Y from wheelCurrentY
// wheelInitialY/wheelCurrentY entries correspond to the meshes in roadWheelMeshes,
// which were built from `positions` with index 0 (and optionally last) skipped.
// So we rebuild the full outer-X → Y map using wheelInitialY as the base.
const pathWheelY = this.enableBogieWheels
  ? (() => {
      // For each expanded wheel X, find which arm it belongs to and
      // use that arm's current pivot Y (with tilt applied)
      const baseX    = this._bogieBaseX ?? [];
      const halfSpan = this._bogieHalfSpan ?? 0;

      return pathWheelX.map((wx) => {
        // Find the closest arm pivot to this wheel X
        let bestArm  = 0;
        let bestDist = Infinity;
        for (let i = 0; i < baseX.length; i++) {
          const d = Math.abs(wx - baseX[i]);
          if (d < bestDist) { bestDist = d; bestArm = i; }
        }

        const armPivotY  = (this._bogieArmPivotYArr?.[bestArm] ?? this._bogieArmPivotY)
                           - this.bogieArmVisualOffsetY;
        const rotZ       = this._bogieArmRotZ?.[bestArm] ?? 0;

        // Apply arm tilt: wheel Y offset from pivot due to rotation
        const offsetX    = wx - baseX[bestArm];
        const tiltDeltaY = Math.sin(rotZ) * offsetX;

        return armPivotY + tiltDeltaY;
      });
    })()
  : pathWheelX.map(() => this.cfg.roadWheelY);
if (enableInOut && !this.enableBogieWheels) {
  pathWheelX.forEach((x, pi) => {
    const rawIdx = roadWheelXPositions.indexOf(x);
    // rawIdx 0 was skipped in _buildWheels, so wheelCurrentY[rawIdx - 1]
    const wyIdx = rawIdx - 1;
    if (wyIdx >= 0 && wyIdx < this.wheelCurrentY.length) {
      pathWheelY[pi] = this.wheelCurrentY[wyIdx];
    } else {
      // This wheel was skipped in _buildWheels (first or last).
      // Use the nearest valid neighbour's Y instead of cfg default.
      if (pi === 0 && this.wheelCurrentY.length > 0) {
        pathWheelY[pi] = this.wheelCurrentY[0];
      } else if (pi === pathWheelX.length - 1 && this.wheelCurrentY.length > 0) {
        pathWheelY[pi] = this.wheelCurrentY[this.wheelCurrentY.length - 1];
      } else {
        pathWheelY[pi] = this.cfg.roadWheelY;
      }
    }
  });
}

    const wheelY = pathWheelY;
    const roadWheelOffset_X = 0.01;

const rwR = this.enableBogieWheels
  ? (this._bogieWheelR ?? (0.17 * this.bogieWheelSystemSize * 1.5 + 0.045)) - PIECE_T
  : (this.cfg.roadWheelRadius ?? 0.25) + PIECE_T;
    const spR = this._spR;   // ← was: 0.24
    const idR = this._idR;   // ← was: 0.18
    const rrR = this.cfg.returnRollers[0]?.radius ?? 0.12;

    const SUB      = 8;
    const TOP_SEGS = 12;

    const idlerCY = this.cfg.idlerY;
    const spCY    = this.cfg.sprocketY;
    const SAG        = this.cfg.topRunSag    ?? 0.08;
    const BOTTOM_SAG = this.cfg.bottomRunSag ?? 0.02;

    const spArcFactor    = this.cfg.spArcFactor    ?? 1.55;
    const idlerArcFactor = this.cfg.idlerArcFactor ?? 1.2;

    const rollersSorted = (this.cfg.returnRollers ?? [])
      .slice()
      .sort((a, b) => b.x - a.x);

    let spArcEnd;
    let idlerArcStart;

    if (rollersSorted.length === 0) {
      spArcEnd      = Math.PI * 2.5;
      idlerArcStart = Math.PI * 0.5;
    } else {
      const rearRoller  = rollersSorted[0];
      const frontRoller = rollersSorted[rollersSorted.length - 1];

      const spExitAngle = Math.atan2(
        (rearRoller.y  + rrR) - spCY,
        rearRoller.x  - sprocketX
      ); //old unused currently
      
      spArcEnd = Math.PI * 2.5;

      const idEntryAngle = Math.atan2(
        (frontRoller.y + rrR) - idlerCY,
        frontRoller.x - idlerX
      );
      idlerArcStart = Math.max(
        Math.PI * 0.55,
        idEntryAngle >= 0 ? idEntryAngle : idEntryAngle + Math.PI * 2
      );
    }

    const idlerArcEnd = Math.PI * idlerArcFactor;

    // ── Idler arc ─────────────────────────────────────────────────────────────
    const IDLER_SEGS = 8;
    for (let s = 0; s <= IDLER_SEGS; s++) {
      const a = idlerArcStart + (idlerArcEnd - idlerArcStart) * (s / IDLER_SEGS);
      pts.push(new THREE.Vector2(
        idlerX  + Math.cos(a) * idR,
        idlerCY + Math.sin(a) * idR
      ));
    }

    // ── Idler bottom → first road wheel (straight, no sag) ───────────────────
    // {
    //   const ax = idlerX + Math.cos(idlerArcEnd) * idR;
    //   const ay = idlerCY + Math.sin(idlerArcEnd) * idR;
    //   const bx = pathWheelX[0];
    //   const by = wheelY[0] - rwR;

    //   for (let s = 1; s <= SUB; s++) {
    //     const t  = s / SUB;
    //     const px = ax + (bx - ax) * t;
    //     const sy = ay + (by - ay) * t;
    //     const gy = this._sampleGroundY(px, sy, rwR);
    //     pts.push(new THREE.Vector2(px, Math.max(sy, gy)));
    //   }
    // }
// ── Idler bottom → first road wheel (tangent-matched transition) ──────────
    {
      const ax = idlerX  + Math.cos(idlerArcEnd) * idR;
      const ay = idlerCY + Math.sin(idlerArcEnd) * idR;

      // First road wheel tangent contact point (belt arrives from the left/idler side)
      const firstWheelArrivalAng = -Math.PI * 0.5 - Math.PI * 0.12;
      const bx = pathWheelX[0] + Math.cos(firstWheelArrivalAng) * rwR;
      const by = pathWheelY[0] + Math.sin(firstWheelArrivalAng) * rwR;

      // Tangent direction leaving idler arc at idlerArcEnd
      const idlerTangentX = -Math.sin(idlerArcEnd);
      const idlerTangentY =  Math.cos(idlerArcEnd);

      // Tangent direction arriving at first road wheel
      const rwTangentX = -Math.sin(firstWheelArrivalAng);
      const rwTangentY =  Math.cos(firstWheelArrivalAng);

      const IDLER_TRANSITION_SAG = this.cfg.idlerTransitionSag ?? 0.33;
      const spanLen = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);

      // Control points follow the tangent directions scaled by span length
      const cp1x = ax + idlerTangentX * spanLen * IDLER_TRANSITION_SAG;
      const cp1y = ay + idlerTangentY * spanLen * IDLER_TRANSITION_SAG;
      const cp2x = bx - rwTangentX   * spanLen * IDLER_TRANSITION_SAG;
      const cp2y = by - rwTangentY   * spanLen * IDLER_TRANSITION_SAG;

      // Cubic bezier with tangent-matched control points
      for (let s = 1; s <= SUB; s++) {
        const t  = s / SUB;
        const mt = 1 - t;
        const px = mt*mt*mt*ax + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*bx;
        const py = mt*mt*mt*ay + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*by;
        const gy = this._sampleGroundY(px, py, rwR);
        pts.push(new THREE.Vector2(px, Math.max(py, gy)));
      }
    }

// ── Wheel to wheel — belt hugs bottom of each road wheel individually ────
    {
      const SEG_BETWEEN = 8;

      for (let w = 0; w < pathWheelX.length - 1; w++) {
        const cx1 = pathWheelX[w];
        const cy1 = pathWheelY[w];
        const cx2 = pathWheelX[w + 1];
        const cy2 = pathWheelY[w + 1];

        // Find the tangent line between two adjacent wheel circles (external tangent)
        const dx   = cx2 - cx1;
        const dy   = cy2 - cy1;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Angle from wheel1 center to wheel2 center
        const centerAng = Math.atan2(dy, dx);

        // Since both wheels have same radius, external tangent is parallel to center line
        // tangent point on each wheel is directly below (offset by -PI/2 from center angle)
        const tangentOffset = -Math.PI * 0.5;

        const exitAng1  = centerAng + tangentOffset;
        const entryAng2 = centerAng + tangentOffset;

        // Arc under current wheel from previous segment exit to this segment exit
        if (w === 0) {
          // First wheel: arc from idler-transition arrival angle to tangent exit
          const arrivalAng = -Math.PI * 0.5 - Math.PI * 0.12;
          const ARC_SEGS   = 5;
          for (let a = 1; a <= ARC_SEGS; a++) {
            const ang = arrivalAng + (exitAng1 - arrivalAng) * (a / ARC_SEGS);
            const wx  = cx1 + Math.cos(ang) * rwR;
            const wy  = cy1 + Math.sin(ang) * rwR;
            const gy  = this._sampleGroundY(wx, wy, rwR);
            pts.push(new THREE.Vector2(wx, Math.max(wy, gy)));
          }
        } else {
          // Mid wheels: arc from previous entry angle to this exit angle
          const prevCx    = pathWheelX[w - 1];
          const prevCy    = pathWheelY[w - 1];
          const prevDx    = cx1 - prevCx;
          const prevDy    = cy1 - prevCy;
          const prevCAng  = Math.atan2(prevDy, prevDx);
          const arrivalAng = prevCAng + tangentOffset;

          const ARC_SEGS = 4;
          for (let a = 1; a <= ARC_SEGS; a++) {
            const ang = arrivalAng + (exitAng1 - arrivalAng) * (a / ARC_SEGS);
            const wx  = cx1 + Math.cos(ang) * rwR;
            const wy  = cy1 + Math.sin(ang) * rwR;
            const gy  = this._sampleGroundY(wx, wy, rwR);
            pts.push(new THREE.Vector2(wx, Math.max(wy, gy)));
          }
        }

        // Straight tangent segment between wheel w and wheel w+1
        // Sagging segment between wheel w and wheel w+1
        const sx = cx1 + Math.cos(exitAng1)  * rwR;
        const sy = cy1 + Math.sin(exitAng1)  * rwR;
        const ex = cx2 + Math.cos(entryAng2) * rwR;
        const ey = cy2 + Math.sin(entryAng2) * rwR;

        // Tangent directions at exit and entry points (for cubic bezier)
        const exitTanX  =  Math.cos(exitAng1  + Math.PI * 0.5);
        const exitTanY  =  Math.sin(exitAng1  + Math.PI * 0.5);
        const entryTanX =  Math.cos(entryAng2 + Math.PI * 0.5);
        const entryTanY =  Math.sin(entryAng2 + Math.PI * 0.5);

        const segLen = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2);

        // Control points: follow tangent out of wheel, sag pulls them down
        const cp1x = sx + exitTanX  * segLen * 0.4;
        const cp1y = sy + exitTanY  * segLen * 0.4 - BOTTOM_SAG;
        const cp2x = ex - entryTanX * segLen * 0.4;
        const cp2y = ey - entryTanY * segLen * 0.4 - BOTTOM_SAG;

        for (let s = 1; s <= SEG_BETWEEN; s++) {
          const t  = s / SEG_BETWEEN;
          const mt = 1 - t;
          const px = mt*mt*mt*sx + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*ex;
          const py = mt*mt*mt*sy + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*ey;
          const gy = this._sampleGroundY(px, py, rwR);
          pts.push(new THREE.Vector2(px, Math.max(py, gy)));
        }
      }

      // Arc under the last wheel — from tangent arrival to sprocket transition
      {
        const lastIdx   = pathWheelX.length - 1;
        const prevCx    = pathWheelX[lastIdx - 1];
        const prevCy    = pathWheelY[lastIdx - 1];
        const dx        = pathWheelX[lastIdx] - prevCx;
        const dy        = pathWheelY[lastIdx] - prevCy;
        const centerAng = Math.atan2(dy, dx);
        const arrivalAng = centerAng - Math.PI * 0.5;
        const departAng  = -Math.PI * 0.5 + Math.PI * 0.12;

        const ARC_SEGS = 5;
        for (let a = 1; a <= ARC_SEGS; a++) {
          const ang = arrivalAng + (departAng - arrivalAng) * (a / ARC_SEGS);
          const wx  = pathWheelX[lastIdx] + Math.cos(ang) * rwR;
          const wy  = pathWheelY[lastIdx] + Math.sin(ang) * rwR;
          const gy  = this._sampleGroundY(wx, wy, rwR);
          pts.push(new THREE.Vector2(wx, Math.max(wy, gy)));
        }
      }
    }

    // ── Last road wheel → sprocket bottom (straight) ──────────────────────────
// ── Last road wheel → sprocket bottom (tangent-matched transition) ────────
    {
      const lastIdx = pathWheelX.length - 1;

      // Last road wheel departs at its right tangent point
      const lastWheelDepartAng = -Math.PI * 0.5 + Math.PI * 0.12;
      const ax = pathWheelX[lastIdx] + Math.cos(lastWheelDepartAng) * rwR;
      const ay = pathWheelY[lastIdx] + Math.sin(lastWheelDepartAng) * rwR;

      // Sprocket entry point at bottom
      const spEntryAng = Math.PI * spArcFactor ;
      const bx = sprocketX + Math.cos(spEntryAng) * spR;
      const by = spCY      + Math.sin(spEntryAng) * spR;

      // Tangent direction leaving last road wheel
      const rwTangentX =  Math.cos(lastWheelDepartAng + Math.PI * 0.5);
      const rwTangentY =  Math.sin(lastWheelDepartAng + Math.PI * 0.5);

      // Tangent direction arriving at sprocket entry
      const spTangentX = -Math.sin(spEntryAng);
      const spTangentY =  Math.cos(spEntryAng);

      const SPROCKET_TRANSITION_SAG = this.cfg.sprocketTransitionSag ?? 0.1;
      const spanLen = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);

      const cp1x = ax + rwTangentX * spanLen * 0.4;
      const cp1y = ay + rwTangentY * spanLen * 0.15 - SPROCKET_TRANSITION_SAG;
      const cp2x = bx - spTangentX * spanLen * 0.4;
      const cp2y = by - spTangentY * spanLen * 0.15 - SPROCKET_TRANSITION_SAG;

      for (let s = 1; s <= SUB; s++) {
        const t  = s / SUB;
        const mt = 1 - t;
        const px = mt*mt*mt*ax + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*bx;
        const py = mt*mt*mt*ay + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*by;
        const gy = this._sampleGroundY(px, py, rwR);
        pts.push(new THREE.Vector2(px, Math.max(py, gy)));
      }
    }

    // ── Sprocket arc ──────────────────────────────────────────────────────────
    const spArcStart = Math.PI * spArcFactor;
    const SP_SEGS    = 8;
    for (let s = 1; s <= SP_SEGS; s++) {
      const a = spArcStart + (spArcEnd - spArcStart) * (s / SP_SEGS);
      pts.push(new THREE.Vector2(
        sprocketX + Math.cos(a) * spR,
        spCY      + Math.sin(a) * spR
      ));
    }

    // ── Top run (with sag) ────────────────────────────────────────────────────
const roadWheelTopY = pathWheelX.slice(1).map((x, i) => ({
  x,
  y: pathWheelY[i + 1] + rwR,
}));

// ── NEW: Bogie System Type 6 conjugated-roller anchors ────────────────────
const isBogieT6         = this.enableBogieWheels && this.bogieSystemType === 6;
const bogieRollerAnchors = isBogieT6 ? this._getBogieRollerAnchors() : [];

const hasReturnRollers = rollersSorted.length > 0 || bogieRollerAnchors.length > 0;

// ── Build raw anchor list ─────────────────────────────────────────────────
const rawTopAnchors = [
  new THREE.Vector2(
    sprocketX + Math.cos(spArcEnd) * spR,
    spCY      + Math.sin(spArcEnd) * spR
  ),
  ...rollersSorted.map(r => new THREE.Vector2(r.x, r.y + rrR)),
  ...bogieRollerAnchors.map(r => new THREE.Vector2(r.x, r.y + rrR)),
  ...(!hasReturnRollers ? roadWheelTopY.map(w => new THREE.Vector2(w.x, w.y + PIECE_T)) : []),
  new THREE.Vector2(
    idlerX  + Math.cos(idlerArcStart) * idR,
    idlerCY + Math.sin(idlerArcStart) * idR
  ),
].sort((a, b) => b.x - a.x);

// ── Publish anchor X positions for the physics step ───────────────────────
// (sprocket and idler endpoints are pinned — exclude index 0 and last)
this._topRunX = rawTopAnchors.map(a => a.x);

// ── Apply dynamic displacements (lazily initialise if size changed) ────────
if (this._topRunDisp.length !== rawTopAnchors.length) {
  this._topRunDisp = new Float32Array(rawTopAnchors.length);
  this._topRunVel  = new Float32Array(rawTopAnchors.length);
}

// Sprocket (index 0) and idler (last index) are mechanically fixed — pin them.
// All interior anchors (return rollers / road wheel tops) get dynamic lift.
const topAnchors = rawTopAnchors.map((a, i) => {
  const pinned = (i === 0 || i === rawTopAnchors.length - 1);
  const disp   = pinned ? 0 : (this._topRunDisp[i] ?? 0);
  return new THREE.Vector2(a.x, a.y + disp);
});

    for (let i = 0; i < topAnchors.length - 1; i++) {
      const a       = topAnchors[i];
      const b       = topAnchors[i + 1];
      const spanLen = Math.abs(b.x - a.x);
      const segSag  = SAG * (spanLen / 1.0);
      const cpx     = (a.x + b.x) * 0.5;
      const cpy     = (a.y + b.y) * 0.5 - segSag;

      const startS = i === 0 ? 0 : 1;
      for (let s = startS; s <= TOP_SEGS; s++) {
        const t  = s / TOP_SEGS;
        const mt = 1 - t;
        pts.push(new THREE.Vector2(
          mt * mt * a.x + 2 * mt * t * cpx + t * t * b.x,
          mt * mt * a.y + 2 * mt * t * cpy + t * t * b.y
        ));
      }
    }

    return pts;
  }

  // ── Resample path into N evenly spaced points + tangent angles ────────────

  _resamplePath(pts, n, offset) {
    const lens = [0];
    for (let i = 1; i < pts.length; i++) {
      lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
    }
    const total = lens[lens.length - 1];

    // ── Guard against degenerate/empty paths (prevents NaN in instanceMatrix,
    // which shows up as GPU-side "division by zero" warnings) ───────────────
    if (!pts.length || !total || total <= 0.0001) {
      const out = [];
      for (let i = 0; i < n; i++) out.push({ x: 0, y: 0, ang: 0 });
      return out;
    }

    const step = total / n;

    const out = [];
    for (let i = 0; i < n; i++) {
      let s = ((i + offset) * step) % total;
      if (s < 0) s += total;

      let seg = 0;
      for (let j = 1; j < lens.length; j++) {
        if (lens[j] >= s) { seg = j - 1; break; }
      }
      seg = Math.min(seg, pts.length - 2);

      const t  = (s - lens[seg]) / Math.max(0.0001, lens[seg + 1] - lens[seg]);
      const px = pts[seg].x + (pts[seg + 1].x - pts[seg].x) * t;
      const py = pts[seg].y + (pts[seg + 1].y - pts[seg].y) * t;

      const dx  = pts[seg + 1].x - pts[seg].x;
      const dy  = pts[seg + 1].y - pts[seg].y;
      const ang = Math.atan2(dy, dx);

      out.push({ x: px, y: py, ang });
    }
    return out;
  }

  // ── Top-run physics step ──────────────────────────────────────────────────
//
// Call ONCE per frame BEFORE _buildPath().
// wheelLifts  – array of { x, lift } — one entry per road wheel / bogie wheel
// dt          – frame delta seconds
//
_stepTopRunPhysics(wheelLifts, dt, beltSpeed = 0) {
  const anchors = this._topRunX;
  if (!anchors || anchors.length === 0) return;

  const n = anchors.length;

  // Lazily initialise arrays when anchor count changes
  if (this._topRunDisp.length !== n) {
    this._topRunDisp = new Float32Array(n);
    this._topRunVel  = new Float32Array(n);
  }

  // ── Speed influence — normalise belt speed to 0..1 ────────────────────────
// ── Acceleration influence — driven by rate of speed change, not speed itself
  const prevBeltSpeed      = this._prevBeltSpeed ?? beltSpeed;
  const beltAccel          = Math.abs(beltSpeed - prevBeltSpeed) / Math.max(dt, 0.001);
  this._prevBeltSpeed      = beltSpeed;

  // Smooth the raw acceleration so a single-frame spike doesn't immediately die
  this._smoothBeltAccel    = (this._smoothBeltAccel ?? 0) * 0.85 + beltAccel * 0.15;

  // Normalise: 0 = coasting at constant speed, 1 = hard acceleration/braking
  const MAX_ACCEL = 0.8;   // accel value that counts as "full" effect — tune this
  const speedT    = Math.min(1.0, this._smoothBeltAccel / MAX_ACCEL);

  // ── Tuning knobs ──────────────────────────────────────────────────────────
  const SPRING      = 60.0;
  const DAMPING     = 1.2;
  const INFLUENCE   = 50;
  // At rest: small baseline so belt isn't completely dead even when still
  // At full speed: full lift scale and coupling
  const LIFT_SCALE  = 2.15 + 0.55 * speedT;
  const MAX_DISP    = 0.05 + 0.13 * speedT;

  // ── Accumulate upward force from every wheel onto each anchor ─────────────
  const force = new Float32Array(n);

  for (const { x: wx, lift } of wheelLifts) {
    if (lift <= 0.001) continue;
    for (let i = 0; i < n; i++) {
      const dist = Math.abs(anchors[i] - wx);
      if (dist > INFLUENCE) continue;
      // Gaussian-shaped influence — peaks directly above the wheel, fades sideways
      const w = Math.exp(-(dist * dist) / (INFLUENCE * INFLUENCE * 0.4));
      force[i] += lift * LIFT_SCALE * w;
    }
  }

  // ── Integrate spring–damper per anchor, with neighbour coupling ───────────
  // Coupling propagates displacement as a travelling wave along the top run.
  // _topRunDir: +1 = idler→sprocket (forward), -1 = sprocket→idler (reverse)
  // anchors are sorted sprocket→idler (index 0 = sprocket, last = idler)
  // so "forward travel" means the wave moves from high index → low index.

  const COUPLING   = 160 * speedT;   // how strongly each anchor pulls its neighbour
                              // 0 = no wave, 0.5 = strong wave, >0.6 gets unstable
  const dir = this._topRunDir ?? 1;   // set from outside each frame

  // neighbour index the wave propagates FROM (upstream in travel direction)
  // dir=+1 (fwd): upstream = higher index (idler side)
  // dir=-1 (rev): upstream = lower  index (sprocket side)
  const upstream = (i) => (dir > 0 ? i + 1 : i - 1);

  for (let i = 0; i < n; i++) {
    const ui = upstream(i);
    const neighbourDisp = (ui >= 0 && ui < n) ? this._topRunDisp[ui] : 0;

    // Coupling force: pull toward upstream neighbour's displacement
    const coupleForce = COUPLING * (neighbourDisp - this._topRunDisp[i]);

    const accel = force[i] + coupleForce
                - SPRING * this._topRunDisp[i]
                - DAMPING * this._topRunVel[i];

    this._topRunVel[i]  += accel * dt;
    this._topRunDisp[i] += this._topRunVel[i] * dt;
    this._topRunDisp[i]  = Math.max(0, Math.min(MAX_DISP, this._topRunDisp[i]));
  }
}

  // ── public update ─────────────────────────────────────────────────────────

update(dt, throttle, worldPos, worldQ, suspensionOffsets, world, tankRigidBody) {
  const n = this._trackPieceCount;

  this.world          = world;
  this._tankRigidBody = (tankRigidBody && tankRigidBody.isValid && !tankRigidBody.isValid())
    ? null
    : tankRigidBody;

  // ── Single bodyMatrix definition — used everywhere below ─────────────────
  const bodyMatrix = new THREE.Matrix4().compose(worldPos, worldQ, new THREE.Vector3(1, 1, 1));
  this._bodyMatrix = bodyMatrix;

  // 1. Update wheel heights from suspension offsets
  if (suspensionOffsets) {
if (this.enableBogieWheels) {

    const armCount = this._bogieArmPivotX.length;
    const halfSpan = this._bogieHalfSpan;

    for (let i = 0; i < armCount; i++) {
      const pivotX = this._bogieArmPivotX[i];
      const baseY  = this.cfg.roadWheelY;

      const liftL = this._sampleWheelGroundLift(
        pivotX - halfSpan, baseY, this._bogieWheelR
      );
      const liftR = this._sampleWheelGroundLift(
        pivotX + halfSpan, baseY, this._bogieWheelR
      );

      const avgLift = (liftL + liftR) * 0.5;
      const targetY = baseY + avgLift;
      this._bogieArmPivotYArr[i] +=
        (targetY - this._bogieArmPivotYArr[i]) * Math.min(1, dt * 12);

      const differential   = liftR - liftL;
      const targetAngleDeg = Math.max(
        -this.bogieArmAngleRange,
        Math.min(
          this.bogieArmAngleRange,
          differential * (this.bogieArmAngleRange / 0.3)
        )
      );
      const targetAngleRad = THREE.MathUtils.degToRad(targetAngleDeg);
      this.bogieArmAngles[i] +=
        (targetAngleRad - this.bogieArmAngles[i]) * Math.min(1, dt * 10);
      this._bogieArmRotZ[i] = this.bogieArmAngles[i];

      const wheelsPerArm =
        (this.bogieSystemType === 2 ||
         this.bogieSystemType === 3 ||
         this.bogieSystemType === 4) ? 4 : 2;

      for (let w = 0; w < wheelsPerArm; w++) {
        const lift = w === 0 ? liftL : liftR;
        const idx  = i * wheelsPerArm + w;
        if (idx < this.wheelCurrentY.length) {
          const target = this.wheelInitialY[idx] + lift;
          this.wheelCurrentY[idx] +=
            (target - this.wheelCurrentY[idx]) * Math.min(1, dt * 12);
        }
      }
    }
} else {
      // Original non-bogie suspension
const enableInOut = this.cfg.enableInAndOutWheels ?? false;
for (let i = 0; i < this.wheelCurrentY.length; i++) {
  const offsetIdx = enableInOut ? i + 1 : i;
  const target = this.wheelInitialY[i] + (suspensionOffsets[offsetIdx] || 0);
this.wheelCurrentY[i] += (target - this.wheelCurrentY[i]) * Math.min(1, dt * 20);
  // Torsion bar wheels: position is set by arc in _updateTorsionMatrices, not here
  if (this.roadWheelMeshes[i] && !this.enableTorsionBars) {
    this.roadWheelMeshes[i].position.y = this.wheelCurrentY[i];
  }
  // ── NEW: keep the parallel companion wheel in sync with its outer wheel ──
  if (this.parallelWheelMeshes && this.parallelWheelMeshes[i] && !this.enableTorsionBars) {
    this.parallelWheelMeshes[i].position.y = this.wheelCurrentY[i];
  }
}
    }
  }

  // 2. Advance belt sliding rate
// Use a single shared value — beltSpeed — for BOTH rate and spinDelta
// so belt pieces and road wheels are guaranteed to stay in sync at all gears.
const beltSpeed = throttle * 0.32;   // ← exact original formula, nothing changed
const refRadius = 0.04;
this.rate      += (beltSpeed * dt) / (1 / this._trackPieceCount);

// 3. Spin all wheel groups — spinDelta derived from same beltSpeed
// OLD bug: spinDelta = beltSpeed * dt / refRadius  → spun wheels too fast
// FIX:     match the rate accumulation scale exactly
const spinDelta = beltSpeed * dt / refRadius;
  if (this.enableBogieWheels) {
    if (this._bogieWheelSpin) {
      for (let i = 0; i < this._bogieWheelSpin.length; i++) {
        this._bogieWheelSpin[i] += spinDelta;
      }
    }
    if (this._bogieRRSpin) {
      for (let i = 0; i < this._bogieRRSpin.length; i++) {
        this._bogieRRSpin[i] += spinDelta * 0.5;
      }
    }
  } else {
    if (this._torsionRwInstanced && this._torsionWheelSpin) {
      // Spin instanced torsion road wheels
      for (let i = 0; i < this._torsionWheelSpin.length; i++) {
        this._torsionWheelSpin[i] += spinDelta;
      }
    } else {
      this.roadWheelMeshes.forEach(m => { m.rotation.y += spinDelta; });
      // ── NEW: spin the parallel companion wheels too ─────────────────────
      if (this.parallelWheelMeshes && this.parallelWheelMeshes.length) {
        this.parallelWheelMeshes.forEach(m => { if (m) m.rotation.y += spinDelta; });
      }
    }
  }
  this.sprocket.rotation.y += spinDelta;
  this.idler.rotation.y    += spinDelta;
  if (this._rrSpin) {
    for (let i = 0; i < this._rrSpin.length; i++) {
      this._rrSpin[i] += spinDelta * 0.5;
    }
  }

  // 3b. Step top-run dynamic physics
{
  // Collect wheel lifts — one entry per road wheel or bogie wheel position
  const wheelLifts = [];

  if (this.enableBogieWheels) {
    const baseX    = this._bogieBaseX ?? [];
    const halfSpan = this._bogieHalfSpan ?? 0;
    for (let i = 0; i < baseX.length; i++) {
      const liftL = Math.max(0, (this._bogieArmPivotYArr?.[i] ?? this.cfg.roadWheelY) - this.cfg.roadWheelY);
      const liftR = liftL;
      wheelLifts.push({ x: baseX[i] - halfSpan, lift: liftL });
      wheelLifts.push({ x: baseX[i] + halfSpan, lift: liftR });
    }
  } else {
    const enableInOut = this.cfg.enableInAndOutWheels ?? false;
    const wxArr = enableInOut
      ? this.cfg.roadWheelXPositions.filter((_, i) => i % 2 === 0)
      : this.cfg.roadWheelXPositions;
    for (let i = 0; i < this.wheelCurrentY.length; i++) {
      const lift = Math.max(0, this.wheelCurrentY[i] - this.wheelInitialY[i]);
      wheelLifts.push({ x: wxArr[i] ?? 0, lift });
    }
  }

  // Wave travels in belt movement direction
    this._topRunDir = throttle >= 0 ? 1 : -1;
  this._stepTopRunPhysics(wheelLifts, dt, Math.abs(throttle) * 0.32);
}
  // 4. Rebuild path + resample
  const pathPts = this._buildPath();
  const samples = this._resamplePath(pathPts, n, this.rate);

  // 5. Place visible track pieces in world space
  const sideZ = this.side * this._outerZ;

  // 5a. Update bogie instanced matrices
  if (this.enableBogieWheels) {
    if (this.bogieSystemType === 2) {
      this._updateBogieT2Groups(bodyMatrix, worldQ);
    } else if (this.bogieSystemType === 3) {
      this._updateBogieT3Groups(bodyMatrix, worldQ);
    } else if (this.bogieSystemType === 4) {
      this._updateBogieT4Groups(bodyMatrix, worldQ);
    } else if (this.bogieSystemType === 5) {
      this._updateBogieT5Groups(bodyMatrix, worldQ);
    } else {
      this._updateBogieInstanceMatrices(bodyMatrix, worldQ);
    }
  }

  // 5b. Update torsion bar matrices — bodyMatrix is guaranteed defined here
  if (this.enableTorsionBars && this._torsionArmInstanced) {
    this._updateTorsionMatrices(bodyMatrix, worldQ, this.wheelCurrentY);
  }

  // 5b-2. Update return roller instanced matrices
  if (this._rrInstanced && this._rrConfigs.length > 0) {
    const sideZ  = this.side * this._outerZ;
    const xAxis  = new THREE.Vector3(0, 0, 1);
    const spinQ  = new THREE.Quaternion();
    const finalQ = new THREE.Quaternion();
    const lp     = new THREE.Vector3();
    const wp     = new THREE.Vector3();
    const d      = this._rrDummy;

    this._rrConfigs.forEach(({ x, y }, i) => {
      spinQ.setFromAxisAngle(xAxis, this._rrSpin[i]);
      finalQ.copy(worldQ).multiply(spinQ);

      lp.set(x, y, sideZ);
      wp.copy(lp).applyMatrix4(bodyMatrix);

      d.position.copy(wp);
      d.quaternion.copy(finalQ);
      d.updateMatrix();
      this._rrInstanced.setMatrixAt(i, d.matrix);
    });

    this._rrInstanced.instanceMatrix.needsUpdate = true;
  }

  // 5c. Place belt pieces
  const zAxis         = new THREE.Vector3(0, 0, 1);
  const localTangentQ = new THREE.Quaternion();
  const finalQ        = new THREE.Quaternion();
  const localPos      = new THREE.Vector3();
  const worldPiecePos = new THREE.Vector3();

  samples.forEach((s, i) => {
    localPos.set(s.x, s.y, sideZ);
    worldPiecePos.copy(localPos).applyMatrix4(bodyMatrix);

    localTangentQ.setFromAxisAngle(zAxis, s.ang);
    finalQ.copy(worldQ).multiply(localTangentQ);

    this._dummy.position.copy(worldPiecePos);
    this._dummy.quaternion.copy(finalQ);
    this._dummy.updateMatrix();
    this.instancedMesh.setMatrixAt(i, this._dummy.matrix);
    this.grouserMesh.setMatrixAt(i, this._dummy.matrix);
  });

  this.instancedMesh.instanceMatrix.needsUpdate = true;
  this.grouserMesh.instanceMatrix.needsUpdate   = true;

  this.steampunk?.update(dt, throttle);
}

setEndWheelLinksVisible(frontVisible, backVisible) {
  // No-op: visibility changes require a full rebuild for Type 5
  // (instanced mesh count depends on link state)
  // Caller should use buildPreviewTracks() instead
}

// ── Toggle visibility of every scene-level object this track owns ──────────
// this.body (previewTrackRoot) already covers sprocket/idler/roadWheelMeshes
// since those are added via this.body.add(...) — toggling this.body.visible
// handles them. Everything below is added directly to `scene` instead, so
// it needs to be hidden explicitly.
setVisible(visible) {
  if (this.instancedMesh) this.instancedMesh.visible = visible;
  if (this.grouserMesh)   this.grouserMesh.visible   = visible;

  if (this._bogieArmInstanced)        this._bogieArmInstanced.visible        = visible;
  if (this._bogieArm2Instanced)       this._bogieArm2Instanced.visible       = visible;
  if (this._bogieWheelInstanced)      this._bogieWheelInstanced.visible      = visible;
  if (this._bogieBeamInstanced)       this._bogieBeamInstanced.visible       = visible;
  if (this._bogieT5FrontArmInstanced) this._bogieT5FrontArmInstanced.visible = visible;
  if (this._bogieT5BackArmInstanced)  this._bogieT5BackArmInstanced.visible  = visible;
  if (this._bogieRRInstanced)         this._bogieRRInstanced.visible         = visible;

  if (this._rrInstanced) this._rrInstanced.visible = visible;

  if (this._torsionRwInstanced)   this._torsionRwInstanced.visible   = visible;
  if (this._torsionArmInstanced)  this._torsionArmInstanced.visible  = visible;
  if (this._torsionArmInstanced2) this._torsionArmInstanced2.visible = visible;

  this.steampunk?.setVisible?.(visible);
}

dispose() {
  // ── Belt instanced meshes ─────────────────────────────────────────────────
  this.scene.remove(this.instancedMesh);
  this.instancedMesh.geometry.dispose();
  this.instancedMesh.material.dispose();

  this.scene.remove(this.grouserMesh);
  this.grouserMesh.geometry.dispose();
  this.grouserMesh.material.dispose();

  // ── Individual road wheel meshes ──────────────────────────────────────────
  for (const m of this.roadWheelMeshes) {
    if (!m) continue;
    this.body.remove(m);
    m.traverse(c => {
      if (c.isMesh) {
        c.geometry?.dispose();
        c.material?.dispose();
      }
    });
  }
  this.roadWheelMeshes = [];

  // ── NEW: Parallel companion wheel meshes ──────────────────────────────────
  for (const m of (this.parallelWheelMeshes || [])) {
    if (!m) continue;
    this.body.remove(m);
    m.geometry?.dispose();
    m.material?.dispose();
  }
  this.parallelWheelMeshes = [];

  // ── Sprocket + idler ──────────────────────────────────────────────────────
  if (this.sprocket) {
    this.body.remove(this.sprocket);
    this.sprocket.traverse(c => {
      if (c.isMesh) { c.geometry?.dispose(); c.material?.dispose(); }
    });
    this.sprocket = null;
  }
  if (this.idler) {
    this.body.remove(this.idler);
    this.idler.traverse(c => {
      if (c.isMesh) { c.geometry?.dispose(); c.material?.dispose(); }
    });
    this.idler = null;
  }

  // ── Bogie instanced meshes ────────────────────────────────────────────────
  if (this._bogieBodyInstanced) {
    this.scene.remove(this._bogieBodyInstanced);
    this._bogieBodyInstanced.geometry.dispose();
    this._bogieBodyInstanced.material.dispose();
    this._bogieBodyInstanced = null;
  }
  if (this._bogieArmInstanced) {
    this.scene.remove(this._bogieArmInstanced);
    this._bogieArmInstanced.geometry.dispose();
    this._bogieArmInstanced.material.dispose();
    this._bogieArmInstanced = null;
  }
  if (this._bogieArm2Instanced) {
    this.scene.remove(this._bogieArm2Instanced);
    this._bogieArm2Instanced.geometry.dispose();
    this._bogieArm2Instanced.material.dispose();
    this._bogieArm2Instanced = null;
  }
  if (this._bogieWheelInstanced) {
    this.scene.remove(this._bogieWheelInstanced);
    this._bogieWheelInstanced.geometry.dispose();
    this._bogieWheelInstanced.material.dispose();
    this._bogieWheelInstanced = null;
  }
  if (this._bogieBeamInstanced) {
    this.scene.remove(this._bogieBeamInstanced);
    this._bogieBeamInstanced.geometry.dispose();
    this._bogieBeamInstanced.material.dispose();
    this._bogieBeamInstanced = null;
  }
  if (this._bogieT5FrontArmInstanced) {
    this.scene.remove(this._bogieT5FrontArmInstanced);
    this._bogieT5FrontArmInstanced.geometry.dispose();
    this._bogieT5FrontArmInstanced.material.dispose();
    this._bogieT5FrontArmInstanced = null;
  }
  if (this._bogieT5BackArmInstanced) {
    this.scene.remove(this._bogieT5BackArmInstanced);
    this._bogieT5BackArmInstanced.geometry.dispose();
    this._bogieT5BackArmInstanced.material.dispose();
    this._bogieT5BackArmInstanced = null;
  }

  if (this._bogieRRInstanced) {
    this.scene.remove(this._bogieRRInstanced);
    this._bogieRRInstanced.geometry.dispose();
    this._bogieRRInstanced.material.dispose();
    this._bogieRRInstanced = null;
  }

  // ── Return rollers ────────────────────────────────────────────────────────
  if (this._rrInstanced) {
    this.scene.remove(this._rrInstanced);
    this._rrInstanced.geometry.dispose();
    this._rrInstanced.material.dispose();
    this._rrInstanced = null;
  }

  // ── Torsion bar instanced meshes ──────────────────────────────────────────
  if (this._torsionRwInstanced) {
    this.scene.remove(this._torsionRwInstanced);
    this._torsionRwInstanced.geometry.dispose();
    this._torsionRwInstanced.material.dispose();
    this._torsionRwInstanced = null;
  }
  if (this._torsionArmInstanced) {
    this.scene.remove(this._torsionArmInstanced);
    this._torsionArmInstanced.geometry.dispose();
    this._torsionArmInstanced.material.dispose();
    this._torsionArmInstanced = null;
  }
  if (this._torsionArmInstanced2) {
    this.scene.remove(this._torsionArmInstanced2);
    this._torsionArmInstanced2.geometry.dispose();
    this._torsionArmInstanced2.material.dispose();
    this._torsionArmInstanced2 = null;
  }

  // ── Steampunk wheels ──────────────────────────────────────────────────────
  this.steampunk?.dispose();
}
}