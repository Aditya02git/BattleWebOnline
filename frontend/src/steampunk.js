import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ── Dimensions — copied verbatim from the HTML ────────────────────────────────
const CRANK_PIN_R = 0.11;
const CONROD_LEN  = 0.42;
const ROD_R       = 0.06;
const HEAD_R      = 0.060;
const CONROD_W    = 0.020;
const CONROD_D    = 0.020;
const ROD_HALF    = 0.5;

// ── Materials — identical colours to the HTML ─────────────────────────────────
const _matDefs = {
  BODY:       [0xc0c0c0, 0.28, 0.82],
  CRANK:      [0x3a3a44, 0.45, 0.75],
  CONROD_VIS: [0x919191, 0.28, 0.82],
};

function _makeMats() {
  const m = (hex, r, mt) => new THREE.MeshStandardMaterial({ color: hex, roughness: r, metalness: mt });
  return {
    MAT_BODY:       m(0xc0c0c0, 0.28, 0.82),
    MAT_ROD:        m(0xffffff, 0.25, 0.85),
    MAT_WHITE:      m(0xffffff, 0.25, 0.85),
    MAT_RED:        m(0xff0000, 0.25, 0.85),
    MAT_PISTON:     m(0xcccccc, 0.30, 0.80),
    MAT_GREEN:      m(0x00ff00, 0.25, 0.85),
    MAT_BLUE:       m(0x0000ff, 0.25, 0.85),
    MAT_CONROD_VIS: m(0x919191, 0.28, 0.82),
    MAT_HEAD:       m(0x5a5a66, 0.50, 0.65),
    MAT_CRANK:      m(0x3a3a44, 0.45, 0.75),
    MAT_CONROD:     m(0x8a5530, 0.40, 0.65),
    MAT_PIN:        m(0xffffff, 0.20, 0.90),
    MAT_IDLER:      new THREE.MeshStandardMaterial({ color: 0x909090, metalness: 0.82, roughness: 0.28, side: THREE.DoubleSide }),
    MAT_SP_DISC:    new THREE.MeshStandardMaterial({ color: 0xf5a623, metalness: 0.65, roughness: 0.35, flatShading: true, side: THREE.DoubleSide }),
    MAT_SP_HUB:     new THREE.MeshStandardMaterial({ color: 0xc97e10, metalness: 0.75, roughness: 0.30, flatShading: true }),
  };
}

// ── addMesh helper (same as HTML) ─────────────────────────────────────────────
function addMesh(parent, geo, material, x=0,y=0,z=0, rx=0,ry=0,rz=0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = false;
  parent.add(m);
  return m;
}


// ── SteampunkWheels ───────────────────────────────────────────────────────────

export class SteampunkWheels {
  constructor(scene, bodyGroup, side, cfg) {
    this.scene = scene;
    this.body  = bodyGroup;
    this.side  = side;
    this.cfg   = cfg;
    this.sprocketRadius = cfg.sprocketRadius ?? 0.16;
    this.idlerRadius    = cfg.idlerRadius    ?? 0.22;

    this._angleR = 0;
    this._angleL = Math.PI;   // 180° offset like HTML

    this._va = new THREE.Vector3();
    this._vb = new THREE.Vector3();

    this._build();
  }

_build() {
  const mats = _makeMats();
  this._mats = Object.values(mats);
  const { MAT_BODY, MAT_CRANK, MAT_CONROD_VIS, MAT_IDLER, MAT_SP_DISC, MAT_SP_HUB, MAT_PISTON, MAT_PIN, MAT_ROD, MAT_HEAD } = mats;
  const { sprocketX, sprocketY, idlerX, idlerY } = this.cfg;
  const outerZ = this.cfg.outerZ ?? 1.0;          // ← from cfg
  const z      = this.side * (outerZ + 0.4);      // pistons/cranks sit 0.3 beyond wheels
  const wheelZ = this.side * outerZ;               // wheels sit exactly at OUTER_Z
    // Store these in _build() after creating crankLen values
  this._crankLenR = this.sprocketRadius * 0.7;
  this._crankLenL = this.idlerRadius * 0.7;
  this._conrodLenR = CONROD_LEN;
  this._conrodLenL = CONROD_LEN;

  const BW     = Math.abs(sprocketX - idlerX) * 0.5;
  const bodyCX = (sprocketX + idlerX) * 0.5;
  const bodyY  = (sprocketY + idlerY) * 0.5;

  // ── Central boiler body ───────────────────────────────────────────────────
  const pistonOffset = ROD_HALF + HEAD_R * 4;
  const headXR = sprocketX - pistonOffset;   // reaches left of sprocket
  const headXL = idlerX    + pistonOffset;   // reaches right of idler (mirror)

  const BH   = 0.22 * (BW / 0.34);
  // Boiler cylinder geo — baked into world-local space
  // Boiler — positioned via scene graph, not baked translation
  const boilerGeoRaw = new THREE.CylinderGeometry(BH, BH, BW * 2, 6);
  boilerGeoRaw.applyMatrix4(new THREE.Matrix4().makeScale(0.25, 0.25, 0.18));
  boilerGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  const boilerGeo = boilerGeoRaw.toNonIndexed(); boilerGeoRaw.dispose();
  const boilerMesh = new THREE.Mesh(boilerGeo, MAT_BODY);
  boilerMesh.position.set(bodyCX, bodyY, z - this.side * 0.1);
  boilerMesh.castShadow = false;
  this.body.add(boilerMesh);
  this._boiler = boilerMesh;

  // Piston R — rod as separate mesh, head at the far end
  const pistonRodGeoR_raw = new THREE.CylinderGeometry(ROD_R, ROD_R, ROD_HALF * 2, 6);
  pistonRodGeoR_raw.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  const pistonRodGeoR = pistonRodGeoR_raw.toNonIndexed(); pistonRodGeoR_raw.dispose();
  const pistonRodMeshR = new THREE.Mesh(pistonRodGeoR, MAT_BODY);
  pistonRodMeshR.position.set(headXR - ROD_HALF, sprocketY, z);  // rod center
  pistonRodMeshR.castShadow = false;
  this.body.add(pistonRodMeshR);

  const pistonHeadMeshR = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 7, 7), MAT_BODY);
  pistonHeadMeshR.position.set(headXR, sprocketY, z);  // head sits at far end of rod
  pistonHeadMeshR.castShadow = false;
  this.body.add(pistonHeadMeshR);

  this._pistonMeshR = pistonRodMeshR;
  this._pistonHeadMeshR = pistonHeadMeshR;

  // Piston L — rod as separate mesh, head at the far end
  const pistonRodGeoL_raw = new THREE.CylinderGeometry(ROD_R, ROD_R, ROD_HALF * 2, 6);
  pistonRodGeoL_raw.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  const pistonRodGeoL = pistonRodGeoL_raw.toNonIndexed(); pistonRodGeoL_raw.dispose();
  const pistonRodMeshL = new THREE.Mesh(pistonRodGeoL, MAT_BODY);
  pistonRodMeshL.position.set(headXL + ROD_HALF, idlerY, z);  // rod center
  pistonRodMeshL.castShadow = false;
  this.body.add(pistonRodMeshL);

  const pistonHeadMeshL = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 7, 7), MAT_BODY);
  pistonHeadMeshL.position.set(headXL, idlerY, z);  // head sits at far end of rod
  pistonHeadMeshL.castShadow = false;
  this.body.add(pistonHeadMeshL);

  this._pistonMeshL = pistonRodMeshL;
  this._pistonHeadMeshL = pistonHeadMeshL;

  // _headR/_headL point to the head ends for conrod anchoring
  this._headR = { position: new THREE.Vector3(headXR, sprocketY, z) };
  this._headL = { position: new THREE.Vector3(headXL, idlerY,    z) };

    // ── Sprocket crank group ──────────────────────────────────────────────────
    this._crankGroupR = new THREE.Group();
    this._crankGroupR.position.set(sprocketX, sprocketY, z);
    this.body.add(this._crankGroupR);

    this._pinGroupR = new THREE.Group();
    this._pinGroupR.position.set(0, this._crankLenR, 0);
    this._crankGroupR.add(this._pinGroupR);

    {
      // Crank arm — BoxGeometry baked to arm-local space
      const armGeoRaw = new THREE.BoxGeometry(0.033, this._crankLenR, 0.022);
      armGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, this._crankLenR * 0.5, this.side * -0.09));
      const armGeo = armGeoRaw.toNonIndexed(); armGeoRaw.dispose();

      // Hub cylinder — baked to arm-local space (hub sits at sprocket center, z offset)
      const hubGeoRaw = new THREE.CylinderGeometry(
        this.sprocketRadius * 0.20, this.sprocketRadius * 0.20, 0.7, 8
      );
      hubGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      // Hub world pos = (sprocketX, sprocketY, wheelZ), crankGroup is at (sprocketX, sprocketY, z)
      // so local offset = (0, 0, wheelZ - z)
      hubGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, wheelZ - z));
      const hubGeo = hubGeoRaw.toNonIndexed(); hubGeoRaw.dispose();

      // Pin cylinder — baked at pin-group offset (0, crankLenR, side*-0.05)
      const pinGeoRaw = new THREE.CylinderGeometry(0.025, 0.025, 0.055 * 2.0, 7);
      pinGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      pinGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, this._crankLenR, this.side * -0.05));
      const pinGeo = pinGeoRaw.toNonIndexed(); pinGeoRaw.dispose();

      const merged = mergeGeometries([armGeo, hubGeo, pinGeo], false);
      const mesh = new THREE.Mesh(merged ?? armGeo, MAT_CRANK);
      mesh.castShadow = false;
      this._crankGroupR.add(mesh);
      this._crankMeshR = mesh;

      [armGeo, hubGeo, pinGeo].forEach(g => g.dispose());
    }

// ── Idler crank group ─────────────────────────────────────────────────────
    this._crankGroupL = new THREE.Group();
    this._crankGroupL.position.set(idlerX, idlerY, z);
    this.body.add(this._crankGroupL);

    this._pinGroupL = new THREE.Group();
    this._pinGroupL.position.set(0, this._crankLenL, 0);
    this._crankGroupL.add(this._pinGroupL);

    {
      const armGeoRaw = new THREE.BoxGeometry(0.033, this._crankLenL, 0.022);
      armGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, this._crankLenL * 0.5, this.side * -0.09));
      const armGeo = armGeoRaw.toNonIndexed(); armGeoRaw.dispose();

      const hubGeoRaw = new THREE.CylinderGeometry(
        this.idlerRadius * 0.20, this.idlerRadius * 0.20, 0.7, 8
      );
      hubGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      hubGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, wheelZ - z));
      const hubGeo = hubGeoRaw.toNonIndexed(); hubGeoRaw.dispose();

      const pinGeoRaw = new THREE.CylinderGeometry(0.025, 0.025, 0.055 * 2.0, 7);
      pinGeoRaw.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      pinGeoRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(0, this._crankLenL, this.side * -0.05));
      const pinGeo = pinGeoRaw.toNonIndexed(); pinGeoRaw.dispose();

      const merged = mergeGeometries([armGeo, hubGeo, pinGeo], false);
      const mesh = new THREE.Mesh(merged ?? armGeo, MAT_CRANK);
      mesh.castShadow = false;
      this._crankGroupL.add(mesh);
      this._crankMeshL = mesh;

      [armGeo, hubGeo, pinGeo].forEach(g => g.dispose());
    }

// Hubs are now baked into the crank merged meshes
    this._sprocketVis = null;
    this._idlerVis    = null;
    this._hubR        = null;
    this._hubL        = null;

    // ── Piston assemblies ─────────────────────────────────────────────────────
    this._pistonGroupR = new THREE.Group();
    this.body.add(this._pistonGroupR);

    this._pistonGroupL = new THREE.Group();
    this.body.add(this._pistonGroupL);

    // ── Store for kinematics ──────────────────────────────────────────────────
    this._sprocketX = sprocketX;
    this._sprocketY = sprocketY;
    this._idlerX    = idlerX;
    this._idlerY    = idlerY;
    this._z         = z;
    this._BW        = BW;

    // ── Connecting rods — world space ─────────────────────────────────────────
    const beamGeoR = new THREE.BoxGeometry(1, CONROD_W * 2, CONROD_D * 2);
    const capGeoR = new THREE.SphereGeometry(0.045, 8, 8);
    capGeoR.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    capGeoR.applyMatrix4(new THREE.Matrix4().makeTranslation(-0.5, 0, 0));
    const mergedConrodR = mergeGeometries([beamGeoR, capGeoR]);
    this._beamR = new THREE.Mesh(mergedConrodR, MAT_CONROD_VIS);
    this._beamR.castShadow = false;
    this.body.add(this._beamR);
    this._bigEndR = this._beamR;

    const beamGeoL = new THREE.BoxGeometry(1, CONROD_W * 2, CONROD_D * 2);
    const capGeoL = new THREE.SphereGeometry(0.045, 8, 8);
    capGeoL.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    capGeoL.applyMatrix4(new THREE.Matrix4().makeTranslation(-0.5, 0, 0));
    const mergedConrodL = mergeGeometries([beamGeoL, capGeoL]);
    this._beamL = new THREE.Mesh(mergedConrodL, MAT_CONROD_VIS);
    this._beamL.castShadow = false;
    this.body.add(this._beamL);
    this._bigEndL = this._beamL;
  }

  // ── update ────────────────────────────────────────────────────────────────

  update(dt, throttle) {
    const beltSpeed = throttle * 0.2;
    const spinDelta = (beltSpeed * dt) / (this.sprocketRadius * 0.05);

    // Advance crank angles — opposite phase like HTML (angleL = angleR + PI)
    this._angleR += spinDelta;
    this._angleL  = this._angleR + Math.PI;

    // Rotate crank groups on Z — pin orbits in XY plane, piston slides along X ✓
    this._crankGroupR.rotation.z = this._angleR;
    this._crankGroupL.rotation.z = this._angleL;
    // Spin sprocket and idler wheels at belt speed (no crank wobble)
    if (this._sprocketVis) this._sprocketVis.rotation.z += spinDelta;
    if (this._idlerVis)    this._idlerVis.rotation.z    += spinDelta;

    const { _sprocketX: spX, _sprocketY: spY, _idlerX: idX, _idlerY: idY, _z: z } = this;
    const reach = this.cfg.steampunkPistonReach ?? 0.5;

    // ── Connecting rods — updateConrod() from HTML ────────────────────────────
this._updateConrod(this._pinGroupR, this._headR, this._beamR);
    this._updateConrod(this._pinGroupL, this._headL, this._beamL);
  }

_updateConrod(pinGroup, headMesh, beam) {
  pinGroup.getWorldPosition(this._va);
  const localA = this.body.worldToLocal(this._va.clone());
  let localB;

  if (headMesh.isObject3D) {
    headMesh.getWorldPosition(this._vb);
    localB = this.body.worldToLocal(this._vb.clone());
  } else {
    localB = headMesh.position.clone(); // already body-local
  }

  const dir = new THREE.Vector3().subVectors(localB, localA);
  const len = dir.length();
  const mid = new THREE.Vector3().addVectors(localA, localB).multiplyScalar(0.5);

  beam.position.copy(mid);
  beam.scale.set(len, 1, 1);

  if (len > 0.001) {
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(1, 0, 0), dir.normalize()
    );
    beam.quaternion.copy(q);
  }
}
dispose() {
  // console.log('[Steampunk] dispose called. boiler parent before remove=', this._boiler?.parent?.type);
  const toRemove = [
    this._boiler,
    this._pistonMeshR,
    this._pistonHeadMeshR,
    this._pistonMeshL,
    this._pistonHeadMeshL,
    this._crankGroupR,
    this._crankGroupL,
    this._pistonGroupR,
    this._pistonGroupL,
    this._beamR,
    this._beamL,
    this._hubR,
    this._hubL,
    this._sprocketVis,
    this._idlerVis,
  ];

  toRemove.forEach(o => {
    if (!o) return;
    // Remove from parent (body group)
    this.body.remove(o);
    // Recursively dispose geometry and material on all meshes inside
    o.traverse(child => {
      if (child.isMesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m?.dispose());
        } else {
          child.material?.dispose();
        }
      }
    });
    // If it's a mesh itself
    if (o.isMesh) {
      o.geometry?.dispose();
      if (Array.isArray(o.material)) {
        o.material.forEach(m => m?.dispose());
      } else {
        o.material?.dispose();
      }
    }
  });

  if (this._mats) {
    this._mats.forEach(m => m?.dispose());
    this._mats = null;
  }

  // Null all refs so GC can collect
  this._boiler          = null;
  this._pistonMeshR     = null;
  this._pistonHeadMeshR = null;
  this._pistonMeshL     = null;
  this._pistonHeadMeshL = null;
  this._crankGroupR     = null;
  this._crankGroupL     = null;
  this._pistonGroupR    = null;
  this._pistonGroupL    = null;
  this._beamR           = null;
  this._beamL           = null;
  this._hubR            = null;
  this._hubL            = null;
  this._sprocketVis     = null;
  this._idlerVis        = null;
}
}