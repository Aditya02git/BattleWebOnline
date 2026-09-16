import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
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
} from './track.js';
import { EnemyBeltMesh } from './enemyBeltMesh.js';
import { SteampunkWheels } from './steampunk.js';

// ── LOD distance thresholds ────────────────────────────────────────────────────
// const LOD_NEAR_DIST = 150;
// const LOD_MID_DIST  = 300;
// const LOD_HYST      = 3;

// // Pre-squared thresholds — avoids sqrt every frame in update()
// const LOD_NEAR_DIST_SQ = (LOD_NEAR_DIST - LOD_HYST) ** 2;
// const LOD_MID_DIST_SQ  = (LOD_MID_DIST  + LOD_HYST) ** 2;
// const LOD_NEAR_OUT_SQ  = (LOD_NEAR_DIST + LOD_HYST) ** 2;
// const LOD_MID_OUT_SQ   = (LOD_MID_DIST  + LOD_HYST) ** 2;

// ── Track geometry constants (must match track.js) ────────────────────────────
const PIECE_W  = 0.50;
const PIECE_H  = 0.10;
const PIECE_T  = 0.06;
const PARALLEL_WHEEL_GAP = 0.30;   // ← ADD THIS — inboard offset of parallel companion wheel
// const OUTER_Z  = 1.0;

// const rwR = cfg.roadWheelRadius          ?? 0.22;
//   const spR = cfg.sprocketRadius ?? cfg.steampunkSprocketRadius ?? 0.24;
//   const idR = cfg.idlerRadius    ?? cfg.steampunkIdlerRadius    ?? 0.18;
//   // const rrR = 0.12;

function _buildSimplePath(cfg, wheelCurrentY) {
  const pts = [];
  const {
    roadWheelXPositions, sprocketX, idlerX,
    roadWheelY, sprocketY, idlerY,
    returnRollers,
  } = cfg;

  // Use every other wheel when interleaved, otherwise all of them
const enableInOut = cfg.enableInAndOutWheels ?? false;

  // When interleaved, roadWheelXPositions is the full expanded list (e.g. 10 entries).
  // Filter to outer wheels only (even indices) for the belt path.
  // wheelCurrentY must match — build it from the same even-index filter.
  const wxArr = enableInOut
    ? roadWheelXPositions.filter((_, i) => i % 2 === 0)
    : roadWheelXPositions;

  // wheelCurrentY is passed in as a flat array matching roadWheelXPositions length.
  // Filter the same way so indices stay aligned.
  const wyArr = enableInOut
    ? wheelCurrentY.filter((_, i) => i % 2 === 0)
    : wheelCurrentY;

  // Safety: if wyArr is shorter than wxArr (mismatched arrays), pad with roadWheelY
  while (wyArr.length < wxArr.length) wyArr.push(cfg.roadWheelY);


const rwR = cfg.roadWheelRadius ?? 0.22;
  const spR = cfg.sprocketRadius ?? cfg.steampunkSprocketRadius ?? 0.24;
  const idR = cfg.idlerRadius    ?? cfg.steampunkIdlerRadius    ?? 0.18;
  const rrR = 0.12;
  const SAG = 0.06;
  const SUB = 3;
  // ── Idler arc (front bottom) ──────────────────────────────────────────────
  const IDLER_SEGS   = 4;
  const idlerArcStart = Math.PI * 0.5;
  const idlerArcEnd   = Math.PI * 1.2;
  for (let s = 0; s <= IDLER_SEGS; s++) {
    const a = idlerArcStart + (idlerArcEnd - idlerArcStart) * (s / IDLER_SEGS);
    pts.push(new THREE.Vector2(idlerX + Math.cos(a) * idR, idlerY + Math.sin(a) * idR));
  }

  // ── Idler exit → first road wheel ────────────────────────────────────────
  {
    const ax = idlerX + Math.cos(idlerArcEnd) * idR;
    const ay = idlerY + Math.sin(idlerArcEnd) * idR;
    const bx = wxArr[0];
    const by = wyArr[0] - rwR;
    for (let s = 1; s <= SUB; s++) {
      const t = s / SUB;
      pts.push(new THREE.Vector2(ax + (bx - ax) * t, ay + (by - ay) * t));
    }
  }

  // ── Road wheels bottom run (gentle sag curve) ─────────────────────────────
  {
    const BOTTOM_SEGS = 10;
    const ax  = wxArr[0];
    const ay  = wyArr[0] - rwR;
    const bx  = wxArr[wxArr.length - 1];
    const by  = wyArr[wxArr.length - 1] - rwR;
    const cpx = (ax + bx) * 0.5;
    const cpy = (ay + by) * 0.5 - 0.02;   // fixed — not driven by JSON config
    for (let s = 1; s <= BOTTOM_SEGS; s++) {
      const t  = s / BOTTOM_SEGS;
      const mt = 1 - t;
      pts.push(new THREE.Vector2(
        mt * mt * ax + 2 * mt * t * cpx + t * t * bx,
        mt * mt * ay + 2 * mt * t * cpy + t * t * by
      ));
    }
  }

  // ── Last road wheel → sprocket bottom ────────────────────────────────────
  {
    const ax = wxArr[wxArr.length - 1];
    const ay = wyArr[wxArr.length - 1] - rwR;
    const bx = sprocketX;
    const by = sprocketY - spR;
    for (let s = 1; s <= SUB; s++) {
      const t = s / SUB;
      pts.push(new THREE.Vector2(ax + (bx - ax) * t, ay + (by - ay) * t));
    }
  }

  // ── Sprocket arc ──────────────────────────────────────────────────────────
  const SP_SEGS    = 4;
  const spArcStart = Math.PI * 1.5;
  const spArcEnd   = Math.PI * 2.5;
  for (let s = 1; s <= SP_SEGS; s++) {
    const a = spArcStart + (spArcEnd - spArcStart) * (s / SP_SEGS);
    pts.push(new THREE.Vector2(sprocketX + Math.cos(a) * spR, sprocketY + Math.sin(a) * spR));
  }

  // ── Top run with sag ──────────────────────────────────────────────────────
  const TOP_SEGS    = 6;
  const rollersSorted = (returnRollers ?? []).slice().sort((a, b) => b.x - a.x);
  const topAnchors = [
    new THREE.Vector2(sprocketX + Math.cos(spArcEnd) * spR, sprocketY + Math.sin(spArcEnd) * spR),
    ...rollersSorted.map(r => new THREE.Vector2(r.x, r.y + rrR)),
    new THREE.Vector2(idlerX + Math.cos(idlerArcStart) * idR, idlerY + Math.sin(idlerArcStart) * idR),
  ];
  for (let i = 0; i < topAnchors.length - 1; i++) {
    const a       = topAnchors[i];
    const b       = topAnchors[i + 1];
    const spanLen = Math.abs(b.x - a.x);
    const segSag  = SAG * (spanLen / 1.0);
    const cpx     = (a.x + b.x) * 0.5;
    const cpy     = (a.y + b.y) * 0.5 - segSag;
    const startS  = i === 0 ? 0 : 1;
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

function _buildWheelInstancedMesh(cfg, side) {
  const enableInOut        = cfg.enableInAndOutWheels ?? false;
  const positions          = cfg.roadWheelXPositions;
  const outerZ             = cfg.outerZ ?? 1.0;
  const innerZ             = outerZ - 0.07;
  const GAP_BETWEEN_WHEELS = 0.06;
  const roadWheelRadius    = cfg.roadWheelRadius ?? 0.25;
  const wheelType          = cfg.roadWheelType   ?? 1;
  const wheelColor         = cfg.wheelColor      ?? 0xfcd6a9;

  // ── Build geometry based on wheelType ──────────────────────────────────────
  let mergedGeo;

  if (wheelType === 2) {
    // ── Type 2: hollow ring + disk cap + double cylinder + hub + connector ───
    const SEGS     = 16;
    const HUB_SEGS = 8;
    const ringWidth = 0.2 * (cfg.rootTrackWidth ?? 1.0);

    const OUTER_R   = roadWheelRadius;
    const INNER_R   = roadWheelRadius * 0.83;
    const THICKNESS = ringWidth;
    const DISK_T    = roadWheelRadius * 0.043;
    const HUB_R     = roadWheelRadius * 0.43;
    const HUB_R_OUT = roadWheelRadius * 0.17;
    const HUB_T     = THICKNESS * 1.05;
    const GAP       = ringWidth * 0.2;
    const CON_R     = roadWheelRadius * 0.29;

    const wheelAOffset = (side > 0 ?  1 : -1) * (GAP / 2 + THICKNESS / 2);
    const wheelBOffset = (side > 0 ? -1 :  1) * (GAP / 2 + THICKNESS / 2);
    const diskOffset   = (side > 0 ? -1 :  1) * (THICKNESS / 2 + DISK_T / 2);
    const capFOffset   = side > 0 ? -HUB_T / 2 :  HUB_T / 2;
    const capBOffset   = side > 0 ?  HUB_T / 2 : -HUB_T / 2;
    const capFRotX     = side > 0 ? -Math.PI / 2 :  Math.PI / 2;
    const capBRotX     = side > 0 ?  Math.PI / 2 : -Math.PI / 2;

    // Ring
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

    // Disk cap
    const diskGeoRaw = new THREE.CylinderGeometry(INNER_R, INNER_R, DISK_T, SEGS);
    diskGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, diskOffset + wheelAOffset, 0));
    const diskGeo = diskGeoRaw.toNonIndexed(); diskGeoRaw.dispose();

    // WheelB cylinder
    const cylGeoRaw = new THREE.CylinderGeometry(OUTER_R, OUTER_R, THICKNESS, SEGS);
    cylGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelBOffset, 0));
    const cylGeo = cylGeoRaw.toNonIndexed(); cylGeoRaw.dispose();

    // Hub
    const hubGeoRaw = side > 0
      ? new THREE.CylinderGeometry(HUB_R_OUT, HUB_R,     HUB_T, HUB_SEGS)
      : new THREE.CylinderGeometry(HUB_R,     HUB_R_OUT, HUB_T, HUB_SEGS);
    hubGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset, 0));
    const hubGeo = hubGeoRaw.toNonIndexed(); hubGeoRaw.dispose();

    // Cap front
    const capFGeoRaw = new THREE.CircleGeometry(HUB_R_OUT, HUB_SEGS);
    capFGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(capFRotX));
    capFGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, capFOffset + wheelAOffset, 0));
    const capFGeo = capFGeoRaw.toNonIndexed(); capFGeoRaw.dispose();

    // Cap back
    const capBGeoRaw = new THREE.CircleGeometry(HUB_R, HUB_SEGS);
    capBGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(capBRotX));
    capBGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, capBOffset + wheelAOffset, 0));
    const capBGeo = capBGeoRaw.toNonIndexed(); capBGeoRaw.dispose();

    // Connector axle
    const conGeoRaw = new THREE.CylinderGeometry(CON_R, CON_R, GAP, HUB_SEGS);
    const conGeo = conGeoRaw.toNonIndexed(); conGeoRaw.dispose();

    mergedGeo = mergeGeometries(
      [ringGeo, diskGeo, cylGeo, hubGeo, capFGeo, capBGeo, conGeo], false
    );
    [ringGeo, diskGeo, cylGeo, hubGeo, capFGeo, capBGeo, conGeo].forEach(g => g.dispose());
    if (mergedGeo) applyRadialTwoToneColors(mergedGeo, OUTER_R, wheelColor, 0x888888, 0.75);

} else if (wheelType === 3) {
    // ── Type 3: spoked disc + hub cylinder ───────────────────────────────────
    const THICK     = 0.2 * (cfg.rootTrackWidth ?? 1.0) * 0.7;
    const OUTER_R   = roadWheelRadius + 0.02;
    const RIM_IN_R  = roadWheelRadius * 0.78;
    const HUB_R     = roadWheelRadius * 0.32;
    const N_SPOKES  = 8;
    const GAP_FRAC  = 0.60;
    const HUB_CYL_R = roadWheelRadius * 0.18;
    const HUB_THICK = THICK + 0.05;
    const TWO_PI    = Math.PI * 2;
    const pitch     = TWO_PI / N_SPOKES;
    const halfGap   = (pitch / 2) * GAP_FRAC;

    const face = new THREE.Shape();
    face.absarc(0, 0, OUTER_R, 0, TWO_PI, false);
    const boreHole = new THREE.Path();
    boreHole.absarc(0, 0, roadWheelRadius * 0.07, 0, TWO_PI, true);
    face.holes.push(boreHole);
    for (let i = 0; i < N_SPOKES; i++) {
      const center = pitch * i;
      const a0 = center - halfGap;
      const a1 = center + halfGap;
      const h  = new THREE.Path();
      h.moveTo(HUB_R * Math.cos(a0), HUB_R * Math.sin(a0));
      h.lineTo(RIM_IN_R * Math.cos(a0), RIM_IN_R * Math.sin(a0));
      h.absarc(0, 0, RIM_IN_R, a0, a1, false);
      h.lineTo(HUB_R * Math.cos(a1), HUB_R * Math.sin(a1));
      h.absarc(0, 0, HUB_R, a1, a0, true);
      face.holes.push(h);
    }
    const wheelGeo3 = new THREE.ExtrudeGeometry(face, {
      depth: THICK, bevelEnabled: false, steps: 1, curveSegments: 6,
    });
    wheelGeo3.center();
    wheelGeo3.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));

    const hubGeoRaw3 = new THREE.CylinderGeometry(HUB_CYL_R, HUB_CYL_R, HUB_THICK, 5, 1, false);
    const hubGeo3    = hubGeoRaw3.toNonIndexed(); hubGeoRaw3.dispose();

    mergedGeo = mergeGeometries([wheelGeo3, hubGeo3], false);
    [wheelGeo3, hubGeo3].forEach(g => g.dispose());
    if (mergedGeo) applyRadialTwoToneColors(mergedGeo, OUTER_R, wheelColor, 0x888888, 0.75);

} else if (wheelType === 4) {
    // ── Type 4: hollow ring + disk cap + second cylinder + hub + caps ─────────
    const SEGS      = 7;
    const HUB_SEGS  = 8;
    const ringWidth4 = 0.2 * (cfg.rootTrackWidth ?? 1.0);
    const THICK4     = ringWidth4 * 0.7;
    const DISK_T4    = THICK4 / 2;
    const OUTER_R4   = roadWheelRadius + 0.02;
    const INNER_R4   = roadWheelRadius * 0.83;
    const HUB_R4     = roadWheelRadius * 0.3;
    const HUB_T4     = THICK4 * 1.05;
    const GAP4       = ringWidth4 * 0.2;

    const wheelAOffset4 = (side > 0 ?  1 : -1) * (GAP4 / 2 + THICK4 / 2);
    const wheelBOffset4 = (side > 0 ? -1 :  1) * (GAP4 / 2 + THICK4 / 2);
    const diskOffset4   = (side > 0 ? -1 :  1) * (THICK4 / 2 - DISK_T4 / 2);

    // Hollow ring
    const shape4 = new THREE.Shape();
    shape4.absarc(0, 0, OUTER_R4, 0, Math.PI * 2, false);
    const hole4 = new THREE.Path();
    hole4.absarc(0, 0, INNER_R4, 0, Math.PI * 2, true);
    shape4.holes.push(hole4);
    const ringGeo4 = new THREE.ExtrudeGeometry(shape4, {
      depth: THICK4, bevelEnabled: false, curveSegments: 5,
    });
    ringGeo4.center();
    ringGeo4.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    ringGeo4.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset4, 0));

    // Disk cap
    const diskGeoRaw4 = new THREE.CylinderGeometry(INNER_R4, INNER_R4, DISK_T4, 14);
    diskGeoRaw4.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset4 + diskOffset4, 0));
    const diskGeo4 = diskGeoRaw4.toNonIndexed(); diskGeoRaw4.dispose();

    // Second cylinder
    const cylGeoRaw4 = new THREE.CylinderGeometry(OUTER_R4, OUTER_R4, THICK4, 10);
    cylGeoRaw4.rotateY(Math.PI / 3.2);
    cylGeoRaw4.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelBOffset4, 0));
    const cylGeo4 = cylGeoRaw4.toNonIndexed(); cylGeoRaw4.dispose();

    // Hub
    const hubGeoRaw4 = new THREE.CylinderGeometry(HUB_R4, HUB_R4, HUB_T4, HUB_SEGS);
    hubGeoRaw4.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset4, 0));
    const hubGeo4 = hubGeoRaw4.toNonIndexed(); hubGeoRaw4.dispose();

    // Cap front
    const capFRotX4  = side > 0 ?  Math.PI / 2 : -Math.PI / 2;
    const capFRaw4   = new THREE.CircleGeometry(HUB_R4, HUB_SEGS);
    capFRaw4.applyMatrix4(new THREE.Matrix4().makeRotationX(capFRotX4));
    capFRaw4.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset4 + HUB_T4 / 2, 0));
    const capFGeo4 = capFRaw4.toNonIndexed(); capFRaw4.dispose();

    // Cap back
    const capBRotX4  = side > 0 ? -Math.PI / 2 :  Math.PI / 2;
    const capBRaw4   = new THREE.CircleGeometry(HUB_R4, HUB_SEGS);
    capBRaw4.applyMatrix4(new THREE.Matrix4().makeRotationX(capBRotX4));
    capBRaw4.applyMatrix4(new THREE.Matrix4().makeTranslation(0, wheelAOffset4 - HUB_T4 / 2, 0));
    const capBGeo4 = capBRaw4.toNonIndexed(); capBRaw4.dispose();

    mergedGeo = mergeGeometries(
      [ringGeo4, diskGeo4, cylGeo4, hubGeo4, capFGeo4, capBGeo4], false
    );
    [ringGeo4, diskGeo4, cylGeo4, hubGeo4, capFGeo4, capBGeo4].forEach(g => g.dispose());
    if (mergedGeo) applyRadialTwoToneColors(mergedGeo, OUTER_R4, wheelColor, 0x888888, 0.75);

} else if (wheelType === 5) {
    // ── Type 5: barrel ring + annular faces + lathe hub dishes + axle ────────
    const SEG5     = 12;
    const HUB_PTS5 = 3;

    const OUTER_R5 = roadWheelRadius + 0.02;
    const INNER_R5 = OUTER_R5 * 0.775;
    const ringWidth5 = 0.2 * (cfg.rootTrackWidth ?? 1.0);
    const HALF_W5  = ringWidth5 * 0.15;
    const HUB_R5   = OUTER_R5 * 0.183;
    const HUB_X5   = OUTER_R5 * 0.007;
    const HUB_PAD5 = OUTER_R5 * 0.023;

    const allGeos5 = [];

    // Outer hollow barrel
    const barrelRaw5 = new THREE.CylinderGeometry(OUTER_R5, OUTER_R5, HALF_W5 * 2, SEG5, 1, true);
    const barrelGeo5 = barrelRaw5.toNonIndexed(); barrelRaw5.dispose();
    allGeos5.push(barrelGeo5);

    // Flat annular face rings (front + back)
    function buildAnnulus5(yPos) {
      const shape = new THREE.Shape();
      shape.absarc(0, 0, OUTER_R5, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, INNER_R5, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      const raw = new THREE.ShapeGeometry(shape, 6);
      raw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      raw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, yPos, 0));
      const geo = raw.toNonIndexed();
      raw.dispose();
      return geo;
    }
    allGeos5.push(buildAnnulus5( HALF_W5));
    allGeos5.push(buildAnnulus5(-HALF_W5));

    // Curved hub dishes (LatheGeometry)
    const hubDepth5 = HALF_W5 - HUB_X5;
    const hubPoints5 = [];
    for (let i = 0; i <= HUB_PTS5; i++) {
      const t     = i / HUB_PTS5;
      const angle = t * Math.PI * 0.5;
      const r = HUB_R5 + HUB_PAD5 + (INNER_R5 - HUB_R5) * Math.sin(angle);
      const h = hubDepth5 * (1 - Math.cos(angle));
      hubPoints5.push(new THREE.Vector2(r, h));
    }
    const hubLatheRaw5 = new THREE.LatheGeometry(hubPoints5, SEG5);
    hubLatheRaw5.computeVertexNormals();

    const hubFrontRaw5 = hubLatheRaw5.clone();
    hubFrontRaw5.applyMatrix4(new THREE.Matrix4().makeTranslation(0, HUB_X5, 0));
    const hubFrontGeo5 = hubFrontRaw5.toNonIndexed(); hubFrontRaw5.dispose();
    allGeos5.push(hubFrontGeo5);

    const hubBackRaw5 = hubLatheRaw5.clone();
    hubBackRaw5.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
    hubBackRaw5.applyMatrix4(new THREE.Matrix4().makeTranslation(0, -HUB_X5, 0));
    const hubBackGeo5 = hubBackRaw5.toNonIndexed(); hubBackRaw5.dispose();
    allGeos5.push(hubBackGeo5);

    hubLatheRaw5.dispose();

    // Axle cylinder
    const axleR5   = HUB_R5 + HUB_PAD5;
    const axleRaw5 = new THREE.CylinderGeometry(axleR5, axleR5, HUB_X5 * 10, SEG5, 1, false);
    const axleGeo5 = axleRaw5.toNonIndexed(); axleRaw5.dispose();
    allGeos5.push(axleGeo5);

    mergedGeo = mergeGeometries(allGeos5, false);
    allGeos5.forEach(g => g.dispose());
    if (mergedGeo) applyRadialTwoToneColors(mergedGeo, OUTER_R5, wheelColor, 0x888888, 0.75);

} else {
    // ── Type 1 (default): disc + outer ring + hub cylinders ──────────────────
    const trackWidth1 = cfg.rootTrackWidth ?? 1.0;
    const ringWidth1  = 0.2 * trackWidth1;
    const ringThick1  = 0.09;
    const ringOuterR1 = roadWheelRadius + ringThick1 * 0.5;

    const discGeoRaw1 = new THREE.CylinderGeometry(roadWheelRadius - 0.05, roadWheelRadius, ringWidth1, 12);
    const ringGeoRaw1 = new THREE.CylinderGeometry(ringOuterR1, ringOuterR1, ringWidth1 * 0.45, 12);
    const hubGeoRaw1  = new THREE.CylinderGeometry(0.055, 0.055, ringWidth1 * 1.15, 5);
    const discGeo1 = discGeoRaw1.toNonIndexed(); discGeoRaw1.dispose();
    const ringGeo1 = ringGeoRaw1.toNonIndexed(); ringGeoRaw1.dispose();
    const hubGeo1  = hubGeoRaw1.toNonIndexed();  hubGeoRaw1.dispose();

    mergedGeo = mergeGeometries([discGeo1, ringGeo1, hubGeo1], false);
    [discGeo1, ringGeo1, hubGeo1].forEach(g => g.dispose());
    if (mergedGeo) applyRadialTwoToneColors(mergedGeo, ringOuterR1, wheelColor, 0x888888, 0.75);
  }

  // ── Shared: material + valid positions + InstancedMesh ────────────────────
  const mat = new THREE.MeshStandardMaterial({
    color:     0x4d4d4d,
    roughness: 0.9,
    metalness: 0.1,
    vertexColors: !!mergedGeo,
    side: THREE.DoubleSide,
  });

  const validWheels = [];
  positions.forEach((x, i) => {
    if (enableInOut && i === 0) return;
    if (enableInOut && i === positions.length - 1 && i % 2 === 0) return;
    const isInner = enableInOut && (i % 2 === 1);
    const z = enableInOut
      ? side * (isInner ? innerZ : outerZ + GAP_BETWEEN_WHEELS)
      : side * outerZ;
    validWheels.push({ x, z, y: cfg.roadWheelY });
  });

  const mesh = new THREE.InstancedMesh(mergedGeo, mat, validWheels.length);
  mesh.castShadow    = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;

  const dummy = new THREE.Object3D();
  validWheels.forEach(({ x, z, y }, idx) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(Math.PI / 2, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(idx, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;

  // ── NEW: Parallel simple companion wheels — one per OUTER wheel position ──
  let parallelMesh = null;
  let parallelPositions = [];

  if (enableInOut) {
    parallelPositions = [];
    positions.forEach((x, i) => {
      if (i === 0) return;
      if (i === positions.length - 1 && i % 2 === 0) return;
      if (i % 2 !== 0) return;   // only outer-wheel indices get a companion

      const outerZLocal = outerZ + GAP_BETWEEN_WHEELS;
      const z = side * (outerZLocal - PARALLEL_WHEEL_GAP);
      parallelPositions.push({ x, y: cfg.roadWheelY, z });
    });

    if (parallelPositions.length > 0) {
      const parallelGeo = new THREE.CylinderGeometry(
        roadWheelRadius * 1.05, roadWheelRadius * 1.05,
        0.07 * (cfg.rootTrackWidth ?? 1.0), 16
      );
      const parallelMat = new THREE.MeshStandardMaterial({
        color: 0x000000, roughness: 0.9, metalness: 0.1,
      });
      parallelMesh = new THREE.InstancedMesh(parallelGeo, parallelMat, parallelPositions.length);
      parallelMesh.castShadow    = false;
      parallelMesh.receiveShadow = false;
      parallelMesh.frustumCulled = false;

      const pDummy = new THREE.Object3D();
      parallelPositions.forEach(({ x, y, z }, idx) => {
        pDummy.position.set(x, y, z);
        pDummy.rotation.set(Math.PI / 2, 0, 0);
        pDummy.updateMatrix();
        parallelMesh.setMatrixAt(idx, pDummy.matrix);
      });
      parallelMesh.instanceMatrix.needsUpdate = true;
    }
  }

  return { mesh, validWheels, parallelMesh, parallelPositions };
}

// ─────────────────────────────────────────────────────────────────────────────

export class EnemyTrackSystem {
  /**
   * @param {THREE.Scene}    scene
   * @param {THREE.Object3D} bodyGroup  – the tank body group (local-space parent)
   * @param {number}         side       – +1 right / -1 left
   * @param {object}         cfg        – same cfg shape as Track (track.js)
   */
  constructor(scene, bodyGroup, side, cfg) {
    this.scene = scene;
    this.body  = bodyGroup;
    this.side  = side;
    this.cfg   = cfg;
    this.rate  = 0;   // belt scroll offset (used in NEAR mode only)

    // ── Reusable objects for hot path (avoid per-frame allocation) ─────────
    this._cachedPathPts = null;
    this._pathDirty     = true;

    // ── LOD state ──────────────────────────────────────────────────────────
    this._mode   = null;

    // NEAR
    this._nearWheels   = [];
    this._nearSprocket = null;
    this._nearIdler    = null;
    this._nearBelt     = null;   // ← single EnemyBeltMesh instead of per-link arrays
    this._rollerInstancedMesh = null;
    this._rollerPositions     = null;

this._steampunk = null;

// ── Bogie state ───────────────────────────────────────────────────────────
this._bogieArmInstanced   = null;
this._bogieWheelInstanced = null;
this._bogieBeamInstanced  = null;
this._bogieArmPivotX      = null;
this._bogieArmPivotYArr   = null;
this._bogieArmRotZ        = null;
this._bogieWheelSpin      = null;
this._bogieHalfSpan       = 0;
this._bogieWheelR         = 0;
this._bogieS              = 0;
this._bogieArmPivotY      = 0;
this._bogieDummy          = new THREE.Object3D();
this._bogiePairCount      = 0;
this.bogieArmAngles       = [];


// ── Torsion bar state ─────────────────────────────────────────────────────
this._torsionArmInstanced = null;
this._torsionDummy        = new THREE.Object3D();
// Fixed constants — must match track.js buildTorsionArmGeometry()
this._TORSION_ARM_LEN = 0.54 * ((cfg.roadWheelRadius ?? 0.25) / 0.25);
this._TORSION_ARM_ANG = cfg.torsionArmAngle ?? (-Math.PI * 0.18 + Math.PI);

// No LOD system — every track always builds full NEAR-quality geometry.
// Still routed through the build queue so multiple tanks spawning on the
// same frame don't all build heavy geometry synchronously (stutter guard).
this._mode = 'pending_near';
EnemyTrackSystem._nearQueue.push(this);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FAR mode — cylinder stub wheels, no rotation, no belt
  // ══════════════════════════════════════════════════════════════════════════

// _enterFar() {
//   if (this._mode === 'near') this._clearNear();
//   if (this._mode === 'mid')  this._clearMid();
//   this._mode = 'far';
// }

// _clearFar() {
//   // Nothing to clear — wheels are owned by NEAR and cleared in _clearNear()
// }


//   _updateFar() {
//     // Nothing — no rotation, no belt, nothing to compute each frame
//   }

  // ══════════════════════════════════════════════════════════════════════════
  // MID mode — cylinder stub wheels WITH rotation + static belt
  // ══════════════════════════════════════════════════════════════════════════

// _enterMid() {
//   if (this._mode === 'near') this._clearNear();

//   const { mesh, validWheels } = _buildWheelInstancedMesh(this.cfg, this.side);
//   this._wheelInstancedMesh = mesh;
//   this._wheelPositions     = validWheels;
//   this._wheelDummy         = new THREE.Object3D();
//   this._wheelRotY          = 0;
//   this.body.add(this._wheelInstancedMesh);

//   this._mode = 'mid';
// }

// _clearMid() {
//   if (this._wheelInstancedMesh) {
//     this.body.remove(this._wheelInstancedMesh);
//     this._wheelInstancedMesh.geometry.dispose();
//     this._wheelInstancedMesh.material.dispose();
//     this._wheelInstancedMesh = null;
//     this._wheelPositions     = null;
//   }
// }

// _updateMid(dt, throttle) {
//   if (!this._wheelInstancedMesh || !this._wheelPositions) return;
//   const refRadius = this.cfg.roadWheelRadius ?? 0.25;
//   const spinDelta = (throttle * 1.4 * dt) / refRadius;
//   this._wheelRotY += spinDelta;
//   this._wheelPositions.forEach(({ x, z, y }, idx) => {
//     this._wheelDummy.position.set(x, y, z);
//     this._wheelDummy.rotation.set(Math.PI / 2, this._wheelRotY, 0);
//     this._wheelDummy.updateMatrix();
//     this._wheelInstancedMesh.setMatrixAt(idx, this._wheelDummy.matrix);
//   });
//   this._wheelInstancedMesh.instanceMatrix.needsUpdate = true;
// }

  // ══════════════════════════════════════════════════════════════════════════
  // NEAR mode — full player-quality wheels + scrolling belt (no raycasts)
  // ══════════════════════════════════════════════════════════════════════════

_enterNear() {
const enableInOut = this.cfg.enableInAndOutWheels ?? false;
  const outerZ      = this.cfg.outerZ ?? 1.0;

  // ── Road wheels OR bogie ──────────────────────────────────────────────────
  if (this.cfg.enableBogieWheels) {
    this._buildBogieNear();
  } else {
    const { mesh: rwMesh, validWheels, parallelMesh, parallelPositions } =
      _buildWheelInstancedMesh(this.cfg, this.side);
    this._wheelInstancedMesh = rwMesh;
    this._wheelPositions     = validWheels;
    this._wheelDummy         = new THREE.Object3D();
    this._wheelRotY          = 0;
    this.body.add(this._wheelInstancedMesh);

    // ── NEW: parallel companion wheels ────────────────────────────────────
    this._parallelWheelInstancedMesh = parallelMesh;
    this._parallelWheelPositions     = parallelPositions;
    if (this._parallelWheelInstancedMesh) {
      this.body.add(this._parallelWheelInstancedMesh);
    }
  }
  this._nearWheels = [];
  

  // ── Return rollers ────────────────────────────────────────────────────────
  const rollers = this.cfg.returnRollers ?? [];
  if (rollers.length > 0) {
    const rrR     = 0.12;
    const rrWidth = 0.14 * (this.cfg.rootTrackWidth ?? 1.0);
    const rrDiscRaw = new THREE.CylinderGeometry(rrR - 0.02, rrR, rrWidth, 10);
    const rrRingRaw = new THREE.CylinderGeometry(rrR + 0.02, rrR + 0.02, rrWidth * 0.4, 10);
    const rrHubRaw  = new THREE.CylinderGeometry(0.03, 0.03, rrWidth * 1.1, 5);
    const rrDisc = rrDiscRaw.toNonIndexed(); rrDiscRaw.dispose();
    const rrRing = rrRingRaw.toNonIndexed(); rrRingRaw.dispose();
    const rrHub  = rrHubRaw.toNonIndexed();  rrHubRaw.dispose();
    const rrGeo  = mergeGeometries([rrDisc, rrRing, rrHub], false);
    if (rrGeo) applyRadialTwoToneColors(rrGeo, rrR + 0.02, this.cfg.wheelColor ?? 0xfcd6a9, 0x4d4d4d, 0.75);
    [rrDisc, rrRing, rrHub].forEach(g => g.dispose());

    const rrMat = new THREE.MeshStandardMaterial({ color: 0x4d4d4d, roughness: 0.9, metalness: 0.1, vertexColors: true });
    this._rollerInstancedMesh = new THREE.InstancedMesh(rrGeo, rrMat, rollers.length);
    this._rollerInstancedMesh.castShadow    = false;
    this._rollerInstancedMesh.receiveShadow = false;
    this._rollerInstancedMesh.frustumCulled = false;

    const rrDummy = new THREE.Object3D();
    this._rollerPositions = rollers.map(r => ({ x: r.x, y: r.y, z: this.side * outerZ }));
    this._rollerPositions.forEach(({ x, y, z }, idx) => {
      rrDummy.position.set(x, y, z);
      rrDummy.rotation.set(Math.PI / 2, 0, 0);
      rrDummy.updateMatrix();
      this._rollerInstancedMesh.setMatrixAt(idx, rrDummy.matrix);
    });
    this._rollerInstancedMesh.instanceMatrix.needsUpdate = true;
    this.body.add(this._rollerInstancedMesh);
  } else {
    this._rollerInstancedMesh = null;
    this._rollerPositions     = null;
  }

  // ── Sprocket ──────────────────────────────────────────────────────────────
  const spR = this.cfg.sprocketRadius ?? this.cfg.steampunkSprocketRadius ?? 0.2;
this._nearSprocket = makeSprockedMesh(spR, 0.15 * (this.cfg.rootTrackWidth ?? 1.0), 0x4d4d4d, 14, 0.045, 0.055, 0.14, this.cfg.sprocketWheelType ?? 1, this.side, this.cfg.wheelColor ?? 0xfcd6a9);  this._nearSprocket.rotation.x = Math.PI / 2;
  this._nearSprocket.position.set(this.cfg.sprocketX, this.cfg.sprocketY, this.side * outerZ);
  this._nearSprocket.castShadow = false;
  this._nearSprocket.traverse(c => { if (c.isMesh) { c.castShadow = false; c.receiveShadow = false; } });
  this.body.add(this._nearSprocket);

  // ── Idler ─────────────────────────────────────────────────────────────────
  const idR = this.cfg.idlerRadius ?? this.cfg.steampunkIdlerRadius ?? 0.14;
this._nearIdler = makeSprockedMesh(idR, 0.3 * (this.cfg.rootTrackWidth ?? 1.0), 0x4d4d4d, 10, 0.035, 0.048, 0.14, this.cfg.idlerWheelType ?? 5, this.side, this.cfg.wheelColor ?? 0xfcd6a9);  this._nearIdler.rotation.x = Math.PI / 2;
  this._nearIdler.position.set(this.cfg.idlerX, this.cfg.idlerY, this.side * outerZ);
  this._nearIdler.castShadow = false;
  this._nearIdler.traverse(c => { if (c.isMesh) { c.castShadow = false; c.receiveShadow = false; } });
  this.body.add(this._nearIdler);

  // ── Belt ──────────────────────────────────────────────────────────────────
  const sideZ = this.side * outerZ;
  this._nearBelt = new EnemyBeltMesh(
    this.scene, this.side, sideZ,
    this.cfg.rootTrackWidth  ?? 1.0,
    this.cfg.beltType        ?? 1,
    this.cfg.trackPieceCount ?? 70
  );

// ── Steampunk overlay ─────────────────────────────────────────────────────
  if (this._steampunk) {
    this._steampunk.dispose();
    this._steampunk = null;
  }
  if (this.cfg.enableSteampunkWheel === true) {
    this.body.updateWorldMatrix(true, false);
    this._steampunk = new SteampunkWheels(this.scene, this.body, this.side, {
      ...this.cfg,
      outerZ: this.cfg.outerZ ?? 1.0,
    });
    // console.log('[Steampunk] body is:', this.body, 'body.type:', this.body?.type, 'body.uuid:', this.body?.uuid);
  }

  this._pathDirty = true;
  this._buildTorsionBarsNear();
  this._mode = 'near';
}

_buildBogieNear() {
  const c           = this.cfg;
  const enableInOut = c.enableInAndOutWheels ?? false;
  const bogieType   = c.bogieSystemType ?? 1;
  const s           = (c.bogieWheelSystemSize ?? 1) * 1.5;
  const PIECE_T_LOCAL = 0.06;

  const halfSpan = (bogieType === 2 || bogieType === 3 || bogieType === 4)
    ? 0.18 * s
    : (c.bogieArmLength ?? 0.28) * s;

  const wheelR = 0.17 * s;
  const wheelW = bogieType === 1 ? 0.25 * s : 0.10 * s;

  this._bogieWheelR   = wheelR + 0.045;
  this._bogieHalfSpan = halfSpan;
  this._bogieS        = s;

  const beltContactY   = c.roadWheelY - (c.roadWheelRadius ?? 0.25) - PIECE_T_LOCAL;
  this._bogieArmPivotY = beltContactY + this._bogieWheelR;

  const baseX = enableInOut
    ? c.roadWheelXPositions.filter((_, i) => i % 2 === 0)
    : c.roadWheelXPositions;

  const wheelsPerArm = (bogieType === 2 || bogieType === 3 || bogieType === 4) ? 4 : 2;
  const armCount     = baseX.length;
  const wheelCount   = armCount * wheelsPerArm;

  this.bogieArmAngles     = new Array(armCount).fill(0);
  this._bogieBaseX        = baseX.slice();
  this._bogieArmPivotX    = baseX.slice();
  this._bogieArmPivotYArr = new Float32Array(armCount).fill(this._bogieArmPivotY);
  this._bogieArmRotZ      = new Float32Array(armCount).fill(0);
  this._bogieWheelSpin    = new Float32Array(wheelCount).fill(0);

  // ── Wheel geometry — reuse track.js builder directly ─────────────────────
  const wheelGeo = buildBogieWheelGeometry(wheelR, wheelW, c.bogieWheelType ?? 1, 0x4d4d4d, c.wheelColor ?? 0xfcd6a9);
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x4d4d4d, roughness: 0.9, metalness: 0.1, vertexColors: true,
  });
  this._bogieWheelInstanced = new THREE.InstancedMesh(wheelGeo, wheelMat, wheelCount);
  this._bogieWheelInstanced.castShadow    = false;
  this._bogieWheelInstanced.frustumCulled = false;
  this.scene.add(this._bogieWheelInstanced);
  wheelGeo.dispose();

  // ── Arm geometry — reuse track.js builder per type ────────────────────────
  let armGeoMerged;
  const armMat = new THREE.MeshStandardMaterial({
    color: 0x474747, roughness: 0.80, metalness: 0.30,
  });

  if (bogieType === 2) {
    const g1Raw = makeBogieArmMeshType2(halfSpan, s,  1);
    const g2Raw = makeBogieArmMeshType2(halfSpan, s, -1);
    const g1 = g1Raw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
    const g2 = g2Raw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
    g1Raw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });
    g2Raw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });
    armGeoMerged = mergeGeometries([g1, g2], false) ?? g1;
    g1.dispose(); g2.dispose();

  } else if (bogieType === 3) {
    const g1Raw = makeBogieArmMeshType3(halfSpan, s,  1);
    const g2Raw = makeBogieArmMeshType3(halfSpan, s, -1);
    const g1 = g1Raw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
    const g2 = g2Raw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
    g1Raw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });
    g2Raw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });
    armGeoMerged = mergeGeometries([g1, g2], false) ?? g1;
    g1.dispose(); g2.dispose();

  } else if (bogieType === 4) {
    const gRaw = makeBogieArmMeshType4(halfSpan, s);
    armGeoMerged = gRaw.children[0]?.geometry?.clone() ?? new THREE.BufferGeometry();
    gRaw.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });

    // Equalising beams for type 4
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
    }
    this._bogiePairCount = pairCount;

  } else {
    // Type 1 — use generic buildBogieArmGeometry
    armGeoMerged = buildBogieArmGeometry(halfSpan, s, this.side, 1);
  }

  this._bogieArmInstanced = new THREE.InstancedMesh(armGeoMerged, armMat, armCount);
  this._bogieArmInstanced.castShadow    = false;
  this._bogieArmInstanced.frustumCulled = false;
  this.scene.add(this._bogieArmInstanced);
  armGeoMerged.dispose();

  this._bogieDummy         = new THREE.Object3D();
  this._wheelInstancedMesh = null;
  this._wheelPositions     = null;

  // Write initial matrices
  this._updateBogieMatrices(new THREE.Matrix4(), new THREE.Quaternion());
}

_buildTorsionBarsNear() {
  if (this._torsionArmInstanced) return;

  const c = this.cfg;
  if (!c.enableTorsionBars || c.enableBogieWheels || (c.enableInAndOutWheels ?? false)) return;

  const count  = c.roadWheelXPositions.length;
  const armMat = new THREE.MeshStandardMaterial({
    color:     0x3d3d3d,
    roughness: 0.5,
    metalness: 0.5,
  });

  // Primary arm
  const armGeo = buildTorsionArmGeometry(c.roadWheelRadius ?? 0.25, this.side);
  this._torsionArmInstanced = new THREE.InstancedMesh(armGeo, armMat, count);
  this._torsionArmInstanced.castShadow    = false;
  this._torsionArmInstanced.frustumCulled = false;
  this.scene.add(this._torsionArmInstanced);
  armGeo.dispose();

  // Secondary arm (doubleSide)
  this._torsionArmInstanced2 = null;
  if (c.doubleSideTorsionArm) {
    const armGeo2 = buildTorsionArmGeometry(c.roadWheelRadius ?? 0.25, -this.side);
    this._torsionArmInstanced2 = new THREE.InstancedMesh(armGeo2, armMat, count);
    this._torsionArmInstanced2.castShadow    = false;
    this._torsionArmInstanced2.frustumCulled = false;
    this.scene.add(this._torsionArmInstanced2);
    armGeo2.dispose();
  }

  // Precompute fixed pivot points — same formula as track.js
  const ARM_LEN  = 0.54 * ((c.roadWheelRadius ?? 0.25) / 0.25);
  const REST_ANG = c.torsionArmAngle ?? (-Math.PI * 0.18 + Math.PI);
  this._TORSION_ARM_LEN = ARM_LEN;
  this._TORSION_ARM_ANG = REST_ANG;
  this._torsionPivots = c.roadWheelXPositions.map((wheelX) => ({
    x: wheelX    - ARM_LEN * Math.cos(REST_ANG),
    y: c.roadWheelY - ARM_LEN * Math.sin(REST_ANG),
  }));

  this._updateTorsionMatrices(new THREE.Matrix4(), new THREE.Quaternion());
}

_updateTorsionMatrices(bodyMatrix, bodyQ) {
  if (!this._torsionArmInstanced) return;

  const c      = this.cfg;
  const sideZ  = this.side * ((c.outerZ ?? 1.0) - 0.25);
  const sideZ2 = this.side * ((c.outerZ ?? 1.0) + 0.14 * (c.rootTrackWidth ?? 1.0));
  const d      = this._torsionDummy;
  const zVec   = new THREE.Vector3(0, 0, 1);
  const armQ   = new THREE.Quaternion();
  const finalQ = new THREE.Quaternion();
  const localPos = new THREE.Vector3();
  const worldPos = new THREE.Vector3();

  const ARM_LEN  = this._TORSION_ARM_LEN;
  const REST_ANG = this._TORSION_ARM_ANG;

  c.roadWheelXPositions.forEach((wheelX, i) => {
    // Use precomputed fixed pivot — same as track.js
    const pivot = this._torsionPivots?.[i] ?? {
      x: wheelX       - ARM_LEN * Math.cos(REST_ANG),
      y: c.roadWheelY - ARM_LEN * Math.sin(REST_ANG),
    };

    // Arm angle at rest (no suspension in enemy — always rest position)
    const dy    = c.roadWheelY - pivot.y;
    const restDx = wheelX - pivot.x;
    const armAngle = Math.atan2(dy, restDx);

    armQ.setFromAxisAngle(zVec, armAngle);
    finalQ.copy(bodyQ).multiply(armQ);

    // Primary arm
    localPos.set(pivot.x, pivot.y, sideZ);
    worldPos.copy(localPos).applyMatrix4(bodyMatrix);
    d.position.copy(worldPos);
    d.quaternion.copy(finalQ);
    d.updateMatrix();
    this._torsionArmInstanced.setMatrixAt(i, d.matrix);

    // Secondary arm (doubleSide)
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
}

_updateBogieMatrices(bodyMatrix, bodyQ) {
  if (!this._bogieArmInstanced || !this._bogieWheelInstanced) return;

  const bogieType    = this.cfg.bogieSystemType ?? 1;
  const halfSpan     = this._bogieHalfSpan;
  const sideZ        = this.side * (this.cfg.outerZ ?? 1.0);
  const s            = this._bogieS;
  const wheelsPerArm = (bogieType === 2 || bogieType === 3 || bogieType === 4) ? 4 : 2;
  const d            = this._bogieDummy;
  const zAxis        = new THREE.Vector3(0, 0, 1);
  const xAxis        = new THREE.Vector3(0, 0, 1);
  const armLocalQ    = new THREE.Quaternion();
  const finalQ       = new THREE.Quaternion();
  const localPos     = new THREE.Vector3();
  const worldPos     = new THREE.Vector3();
  const spinQ        = new THREE.Quaternion();
  const zGap         = 0.08 * s;
  const armCount     = this._bogieArmPivotX.length;
  const pivotTopY    = 0.17 * s * 1.1;   // for beam placement (type 4)

  // Wheel offsets per type — mirrors track.js exactly
  const oz_L = -0.05 * s;
  const oz_R =  0.05 * s;
  const offsetsMap = {
    1: [
      { ox: -halfSpan, oz: 0, absZ: false },
      { ox:  halfSpan, oz: 0, absZ: false },
    ],
    2: [
      { ox: -halfSpan, oz: oz_L - 0.1 * s, absZ: false },
      { ox: -halfSpan, oz: oz_L + 0.1 * s, absZ: false },
      { ox:  halfSpan, oz: oz_R - 0.1 * s, absZ: false },
      { ox:  halfSpan, oz: oz_R + 0.1 * s, absZ: false },
    ],
    3: [
      { ox: -halfSpan, oz: sideZ + zGap, absZ: true },
      { ox: -halfSpan, oz: sideZ - zGap, absZ: true },
      { ox:  halfSpan, oz: sideZ + zGap, absZ: true },
      { ox:  halfSpan, oz: sideZ - zGap, absZ: true },
    ],
    4: [
      { ox: -halfSpan, oz: sideZ + zGap, absZ: true },
      { ox: -halfSpan, oz: sideZ - zGap, absZ: true },
      { ox:  halfSpan, oz: sideZ + zGap, absZ: true },
      { ox:  halfSpan, oz: sideZ - zGap, absZ: true },
    ],
  };
  const offsets = offsetsMap[bogieType] ?? offsetsMap[1];

  for (let i = 0; i < armCount; i++) {
    const pivotX = this._bogieArmPivotX[i];
    const pivotY = this._bogieArmPivotYArr[i] - 0.1;
    const rotZ   = this._bogieArmRotZ[i];

    armLocalQ.setFromAxisAngle(zAxis, rotZ);
    finalQ.copy(bodyQ).multiply(armLocalQ);

    // Arm
    localPos.set(pivotX, pivotY, sideZ);
    worldPos.copy(localPos).applyMatrix4(bodyMatrix);
    d.position.copy(worldPos);
    d.quaternion.copy(finalQ);
    d.updateMatrix();
    this._bogieArmInstanced.setMatrixAt(i, d.matrix);

    // Wheels
    offsets.forEach(({ ox, oz, absZ }, w) => {
      const wi = i * wheelsPerArm + w;
      spinQ.setFromAxisAngle(xAxis, this._bogieWheelSpin[wi] ?? 0);

      const localWheelOffset = new THREE.Vector3(ox, 0, absZ ? 0 : oz);
      localWheelOffset.applyQuaternion(armLocalQ);

      const wheelLocalPos = new THREE.Vector3(
        pivotX + localWheelOffset.x,
        pivotY + localWheelOffset.y,
        absZ ? oz : sideZ + localWheelOffset.z
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

  // ── Type 4: equalising beams ──────────────────────────────────────────────
  if (bogieType === 4 && this._bogieBeamInstanced) {
    const beamQ = new THREE.Quaternion();
    for (let p = 0; p < this._bogiePairCount; p++) {
      const iA  = p * 2;
      const iB  = p * 2 + 1;
      const xA  = this._bogieArmPivotX[iA];
      const xB  = this._bogieArmPivotX[iB];
      const yA  = this._bogieArmPivotYArr[iA] - 0.1 + pivotTopY;
      const yB  = this._bogieArmPivotYArr[iB] - 0.1 + pivotTopY;
      const tiltZ = Math.atan2(yB - yA, xB - xA);
      beamQ.setFromAxisAngle(zAxis, tiltZ);
      finalQ.copy(bodyQ).multiply(beamQ);
      localPos.set((xA + xB) * 0.5, (yA + yB) * 0.5, sideZ);
      worldPos.copy(localPos).applyMatrix4(bodyMatrix);
      d.position.copy(worldPos);
      d.quaternion.copy(finalQ);
      d.updateMatrix();
      this._bogieBeamInstanced.setMatrixAt(p, d.matrix);
    }
    this._bogieBeamInstanced.instanceMatrix.needsUpdate = true;
  }
}

_clearNear() {
  this._nearWheels.forEach(group => {
    group.traverse(child => {
      if (child.isMesh) {
        child.geometry?.dispose();
        if (child.material?.dispose) child.material.dispose();
      }
    });
    this.body.remove(group);
  });
  this._nearWheels = [];

  if (this._wheelInstancedMesh) {
  this.body.remove(this._wheelInstancedMesh);
  this._wheelInstancedMesh.geometry.dispose();
  this._wheelInstancedMesh.material.dispose();
  this._wheelInstancedMesh = null;
  this._wheelPositions = null;
}

  // ── NEW: parallel companion wheels ────────────────────────────────────────
  if (this._parallelWheelInstancedMesh) {
    this.body.remove(this._parallelWheelInstancedMesh);
    this._parallelWheelInstancedMesh.geometry.dispose();
    this._parallelWheelInstancedMesh.material.dispose();
    this._parallelWheelInstancedMesh = null;
    this._parallelWheelPositions = null;
  }

  if (this._nearSprocket) {
    this._nearSprocket.traverse(child => {
      if (child.isMesh) {
        child.geometry?.dispose();
        if (child.material?.dispose) child.material.dispose();
      }
    });
    this.body.remove(this._nearSprocket);
    this._nearSprocket = null;
  }

  if (this._nearIdler) {
    this._nearIdler.traverse(child => {
      if (child.isMesh) {
        child.geometry?.dispose();
        if (child.material?.dispose) child.material.dispose();
      }
    });
    this.body.remove(this._nearIdler);
    this._nearIdler = null;
  }

  if (this._nearBelt) {
    this._nearBelt.dispose();
    this._nearBelt = null;
  }
  if (this._rollerInstancedMesh) {
    this.body.remove(this._rollerInstancedMesh);
    this._rollerInstancedMesh.geometry.dispose();
    this._rollerInstancedMesh.material.dispose();
    this._rollerInstancedMesh = null;
    this._rollerPositions     = null;
  }
if (this._steampunk) {
    this._steampunk.dispose();
    this._steampunk = null;
  }

  // ── Bogie meshes ──────────────────────────────────────────────────────────
  if (this._bogieArmInstanced) {
    this.scene.remove(this._bogieArmInstanced);
    this._bogieArmInstanced.geometry.dispose();
    this._bogieArmInstanced.material.dispose();
    this._bogieArmInstanced = null;
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

}

_updateNear(dt, throttle, worldPos, worldQ, suspensionOffsets) {
  const beltSpeed = throttle * 1.4;
  const refRadius = this.cfg.roadWheelRadius ?? 0.22;
  const spinDelta = (beltSpeed * dt) / refRadius;

  const bodyMatrix = new THREE.Matrix4().compose(
    worldPos, worldQ, new THREE.Vector3(1, 1, 1)
  );

  // ── Torsion bars (static — no suspension animation) ───────────────────────
  if (this._torsionArmInstanced) {
    this._updateTorsionMatrices(bodyMatrix, worldQ);
  }

  // ── Bogie wheels ──────────────────────────────────────────────────────────
  if (this.cfg.enableBogieWheels) {
    if (this._bogieWheelSpin) {
      for (let i = 0; i < this._bogieWheelSpin.length; i++) {
        this._bogieWheelSpin[i] += spinDelta;
      }
    }
    this._updateBogieMatrices(bodyMatrix, worldQ);
  } else {
    // ── Standard road wheel spin ────────────────────────────────────────────
    if (this._wheelInstancedMesh && this._wheelPositions) {
      this._wheelRotY = (this._wheelRotY ?? 0) + spinDelta;
      this._wheelPositions.forEach(({ x, z, y }, idx) => {
        this._wheelDummy.position.set(x, y, z);
        this._wheelDummy.rotation.set(Math.PI / 2, this._wheelRotY, 0);
        this._wheelDummy.updateMatrix();
        this._wheelInstancedMesh.setMatrixAt(idx, this._wheelDummy.matrix);
      });
      this._wheelInstancedMesh.instanceMatrix.needsUpdate = true;
    }

    // ── NEW: spin the parallel companion wheels too ────────────────────────
    if (this._parallelWheelInstancedMesh && this._parallelWheelPositions) {
      this._parallelWheelPositions.forEach(({ x, y, z }, idx) => {
        this._wheelDummy.position.set(x, y, z);
        this._wheelDummy.rotation.set(Math.PI / 2, this._wheelRotY ?? 0, 0);
        this._wheelDummy.updateMatrix();
        this._parallelWheelInstancedMesh.setMatrixAt(idx, this._wheelDummy.matrix);
      });
      this._parallelWheelInstancedMesh.instanceMatrix.needsUpdate = true;
    }
  }

  if (this._nearSprocket) this._nearSprocket.rotation.y += spinDelta;
  if (this._nearIdler)    this._nearIdler.rotation.y    += spinDelta;

  // ── Belt path rebuild ─────────────────────────────────────────────────────
  if (!this._cachedPathPts || this._pathDirty) {
    let fixedY;
    if (this.cfg.enableBogieWheels && this._bogieArmPivotYArr) {
      fixedY = Array.from(this.cfg.roadWheelXPositions).map((_, i) => {
        const armIdx = this.cfg.enableInAndOutWheels ? Math.floor(i / 2) : i;
        return (this._bogieArmPivotYArr[armIdx] ?? this.cfg.roadWheelY) - 0.1;
      });
    } else {
      fixedY = new Array(this.cfg.roadWheelXPositions.length).fill(this.cfg.roadWheelY);
    }

    this._cachedPathPts = _buildSimplePath(this.cfg, fixedY);
    if (this._cachedPathPts && this._cachedPathPts.length >= 2) {
      this._nearBelt.rebuildFromPath(this._cachedPathPts);
    }
    this._pathDirty = false;
  }

// ── Return roller spin ────────────────────────────────────────────────────
  if (this._rollerInstancedMesh && this._rollerPositions) {
    if (!this._wheelDummy) this._wheelDummy = new THREE.Object3D();
    this._rollerPositions.forEach(({ x, y, z }, idx) => {
      this._wheelDummy.position.set(x, y, z);
      this._wheelDummy.rotation.set(Math.PI / 2, this._wheelRotY ?? 0, 0);
      this._wheelDummy.updateMatrix();
      this._rollerInstancedMesh.setMatrixAt(idx, this._wheelDummy.matrix);
    });
    this._rollerInstancedMesh.instanceMatrix.needsUpdate = true;
  }

  if (this._steampunk) this._steampunk.update(dt, throttle);
  this._nearBelt.update(dt, throttle, worldPos, worldQ);
}

  // ══════════════════════════════════════════════════════════════════════════
  // Public update — called every frame
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * @param {number}          dt
   * @param {number}          throttle          – signed speed value
   * @param {THREE.Vector3}   worldPos          – tank world position
   * @param {THREE.Quaternion} worldQ           – tank world rotation
   * @param {number[]|null}   suspensionOffsets – per-wheel vertical offsets
   * @param {THREE.Vector3}   playerPos         – used for LOD distance check
   */
update(dt, throttle, worldPos, worldQ, suspensionOffsets, playerPos) {
  // LOD system removed — tracks always render at full (NEAR) quality.
  // `playerPos` is kept in the signature only for call-site compatibility
  // (EnemyTank.update / friendlyTank.js still pass it) but is unused here.
  if (this._mode === 'near') {
    this._updateNear(dt, throttle, worldPos, worldQ, suspensionOffsets);
  }
  // 'pending_near' means it's sitting in the build queue waiting for
  // drainNearQueue() to call _enterNear() — nothing to do until then.
}

  // ══════════════════════════════════════════════════════════════════════════
  // Dispose — remove all meshes from scene/body
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Dispose only the belt mesh, leaving wheels/sprocket/idler/bogie intact.
   * Safe to call in any mode (no-op if not in 'near' mode, since belt only exists there).
   */
  disposeBelt() {
    if (this._nearBelt) {
      this._nearBelt.dispose();
      this._nearBelt = null;
    }
  }

  dispose() {
    this._clearNear();  // owns all wheels, sprocket, idler, belt
    // this._clearMid();
  }
}

// ── Cross-tank NEAR-build throttling ─────────────────────────────────────────
// _enterNear() is expensive (geometry builds + possible shader compiles).
// If several tanks cross the LOD-near threshold on the same frame, building
// them all synchronously causes a visible stutter. Instead, queue them and
// drain a small number per frame from EnemyTankPool.update().
EnemyTrackSystem._nearQueue = [];
EnemyTrackSystem.MAX_NEAR_BUILDS_PER_FRAME = 1;

EnemyTrackSystem.drainNearQueue = function () {
  let n = EnemyTrackSystem.MAX_NEAR_BUILDS_PER_FRAME;
  while (n-- > 0 && EnemyTrackSystem._nearQueue.length) {
    const sys = EnemyTrackSystem._nearQueue.shift();
    if (sys._mode === 'pending_near') sys._enterNear();
  }
};