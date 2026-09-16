// utils/navGrid.js
// Runtime grid navmesh + A*, built from house-collider AABBs already
// available in main.js (no extra model import needed).

export class NavGrid {
  constructor({ worldHalf, cellSize = 4, tankRadius = 2.2 }) {
    this.worldHalf  = worldHalf;
    this.cellSize   = cellSize;
    this.tankRadius = tankRadius;
    this.cols = Math.ceil((worldHalf * 2) / cellSize);
    this.rows = this.cols;
    this.grid = new Uint8Array(this.cols * this.rows); // 0 free, 1 blocked
  }

  worldToCell(x, z) {
    return {
      cx: Math.floor((x + this.worldHalf) / this.cellSize),
      cz: Math.floor((z + this.worldHalf) / this.cellSize),
    };
  }
  cellToWorld(cx, cz) {
    return {
      x: cx * this.cellSize - this.worldHalf + this.cellSize / 2,
      z: cz * this.cellSize - this.worldHalf + this.cellSize / 2,
    };
  }
  idx(cx, cz) { return cz * this.cols + cx; }
  inBounds(cx, cz) { return cx >= 0 && cz >= 0 && cx < this.cols && cz < this.rows; }
  isBlocked(cx, cz) { return !this.inBounds(cx, cz) || this.grid[this.idx(cx, cz)] === 1; }

  // boxes: [{minX,maxX,minZ,maxZ}, ...] world-space AABBs
  addObstacles(boxes) {
    const r = this.tankRadius;
    for (const b of boxes) {
      const min = this.worldToCell(b.minX - r, b.minZ - r);
      const max = this.worldToCell(b.maxX + r, b.maxZ + r);
      for (let cz = min.cz; cz <= max.cz; cz++)
        for (let cx = min.cx; cx <= max.cx; cx++)
          if (this.inBounds(cx, cz)) this.grid[this.idx(cx, cz)] = 1;
    }
  }

  findPath(fromWorld, toWorld) {
    const start = this.worldToCell(fromWorld.x, fromWorld.z);
    const goal  = this.worldToCell(toWorld.x, toWorld.z);

    if (this.isBlocked(goal.cx, goal.cz)) {
      const nudged = this._nearestFree(goal.cx, goal.cz);
      if (!nudged) return null;
      goal.cx = nudged.cx; goal.cz = nudged.cz;
    }

    const goalIdx = this.idx(goal.cx, goal.cz);
    const open   = new Map();
    const closed = new Set();
    open.set(this.idx(start.cx, start.cz), { f: 0, g: 0, cx: start.cx, cz: start.cz, parent: null });

    const h = (cx, cz) => Math.hypot(cx - goal.cx, cz - goal.cz);
    const neighbors = [
      [1,0,1],[-1,0,1],[0,1,1],[0,-1,1],
      [1,1,Math.SQRT2],[1,-1,Math.SQRT2],[-1,1,Math.SQRT2],[-1,-1,Math.SQRT2],
    ];

    let iterations = 0;
    while (open.size && iterations++ < 4000) {
      let bestKey = -1, best = null;
      for (const [k, n] of open) if (!best || n.f < best.f) { best = n; bestKey = k; }
      open.delete(bestKey);
      closed.add(bestKey);

      if (bestKey === goalIdx) return this._reconstruct(best);

      for (const [dx, dz, cost] of neighbors) {
        const ncx = best.cx + dx, ncz = best.cz + dz;
        if (this.isBlocked(ncx, ncz)) continue;
        const nIdx = this.idx(ncx, ncz);
        if (closed.has(nIdx)) continue;
        const g = best.g + cost;
        const existing = open.get(nIdx);
        if (!existing || g < existing.g) {
          open.set(nIdx, { f: g + h(ncx, ncz), g, cx: ncx, cz: ncz, parent: best });
        }
      }
    }
    return null;
  }

  _nearestFree(cx, cz) {
    for (let r = 1; r < 20; r++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++)
          if (!this.isBlocked(cx + dx, cz + dz)) return { cx: cx + dx, cz: cz + dz };
    return null;
  }

  _reconstruct(node) {
    const raw = [];
    for (let n = node; n; n = n.parent) raw.push(this.cellToWorld(n.cx, n.cz));
    raw.reverse();
    return this._simplify(raw);
  }

  _simplify(points) {
    if (points.length <= 2) return points;
    const out = [points[0]];
    let i = 0;
    while (i < points.length - 1) {
      let j = points.length - 1;
      for (; j > i + 1; j--) if (this._lineOfSight(points[i], points[j])) break;
      out.push(points[j]);
      i = j;
    }
    return out;
  }

  _lineOfSight(a, b) {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (this.cellSize * 0.5));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const c = this.worldToCell(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (this.isBlocked(c.cx, c.cz)) return false;
    }
    return true;
  }
}