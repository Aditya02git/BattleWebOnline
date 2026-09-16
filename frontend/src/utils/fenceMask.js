// utils/fenceMask.js
// Loads a black/white mask image (e.g. fence.png) and extracts one closed
// polygon contour per black region. Black regions divided by thin white
// lines naturally become separate connected components during flood fill,
// so each one becomes its own fenced polygon.

const BLACK_THRESHOLD      = 165;   // luminance below this counts as "black"/fenced
const MIN_COMPONENT_PIXELS = 40;   // skip tiny noise specks
const DECIMATE_MIN_DIST_PX = 3;    // min pixel-space spacing between kept contour points

function _loadImageData(path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = reject;
    img.src = path;
  });
}

// 8-direction offsets, clockwise starting from North.
const _DX = [0, 1, 1, 1, 0, -1, -1, -1];
const _DY = [-1, -1, 0, 1, 1, 1, 0, -1];

/** Moore-Neighbor boundary trace of a single connected component.
 *  `inside(x,y)` returns true if (x,y) belongs to the component. */
function _traceContour(inside, startX, startY) {
  const contour = [[startX, startY]];
  let cx = startX, cy = startY;
  let backDir = 7; // we "arrived" at the start pixel from the west (background)
  let firstStep = null;
  const maxSteps = 200000;

  for (let step = 0; step < maxSteps; step++) {
    let found = false;
    for (let i = 1; i <= 8; i++) {
      const dir = (backDir + i) % 8;
      const nx = cx + _DX[dir];
      const ny = cy + _DY[dir];
      if (inside(nx, ny)) {
        backDir = (dir + 4) % 8; // direction pointing back to where we came from
        cx = nx; cy = ny;
        contour.push([cx, cy]);
        found = true;
        break;
      }
    }
    if (!found) break; // isolated single pixel — nothing more to trace

    if (firstStep === null) {
      firstStep = [cx, cy];
    } else if (cx === startX && cy === startY) {
      break; // back at the starting pixel — contour closed
    }
  }
  return contour;
}

function _decimate(points, minDist) {
  if (points.length < 3) return points;
  const out = [points[0]];
  let last = points[0];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const dx = p[0] - last[0];
    const dy = p[1] - last[1];
    if (dx * dx + dy * dy >= minDist * minDist) {
      out.push(p);
      last = p;
    }
  }
  return out;
}

/**
 * Loads a fence mask image and returns one array of world-space [x,z]
 * points per black polygon found in the image. Points form an open ring
 * (FenceSystem connects the last point back to the first).
 *
 * @param {string} path - image path, e.g. '/fence.png'
 * @param {object} opts
 * @param {number} opts.worldSize - must match your terrain's worldSize
 * @param {boolean} [opts.flipX]
 * @param {boolean} [opts.flipZ]
 */
export async function loadFencePolygons(path, opts = {}) {
  const worldSize = opts.worldSize ?? 800;
  const flipX     = opts.flipX ?? false;
  const flipZ     = opts.flipZ ?? false;

  const imageData = await _loadImageData(path);
  const { width: w, height: h, data } = imageData;

  const isBlack = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    isBlack[i] = (r + g + b) / 3 < BLACK_THRESHOLD ? 1 : 0;
  }

  const visited = new Uint8Array(w * h);
  const polygons = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!isBlack[idx] || visited[idx]) continue;

      // ── Flood fill this component (4-connectivity) ─────────────────────
      const compPixels = [];
      const stack = [[x, y]];
      visited[idx] = 1;
      let minX = x, maxX = x, minY = y, maxY = y;

      while (stack.length) {
        const [cx, cy] = stack.pop();
        compPixels.push(cx + cy * w);
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;

        const neighbors = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nIdx = ny * w + nx;
          if (isBlack[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            stack.push([nx, ny]);
          }
        }
      }

      if (compPixels.length < MIN_COMPONENT_PIXELS) continue;

      // ── Local padded mask for tracing ───────────────────────────────────
      const bw = maxX - minX + 3;
      const bh = maxY - minY + 3;
      const local = new Uint8Array(bw * bh);
      for (const p of compPixels) {
        const px = p % w, py = (p - px) / w;
        local[(py - minY + 1) * bw + (px - minX + 1)] = 1;
      }
      const inside = (lx, ly) =>
        lx >= 0 && ly >= 0 && lx < bw && ly < bh && local[ly * bw + lx] === 1;

      // Topmost-then-leftmost pixel = deterministic trace start.
      let startLX = -1, startLY = -1;
      outer:
      for (let ly = 0; ly < bh; ly++) {
        for (let lx = 0; lx < bw; lx++) {
          if (local[ly * bw + lx] === 1) { startLX = lx; startLY = ly; break outer; }
        }
      }
      if (startLX < 0) continue;

      const localContour = _traceContour(inside, startLX, startLY);
      const decimated = _decimate(localContour, DECIMATE_MIN_DIST_PX);

      const worldPoints = decimated.map(([lx, ly]) => {
        const px = lx + minX - 1;
        const py = ly + minY - 1;
        let u = px / w;
        let v = py / h;
        if (flipX) u = 1 - u;
        if (flipZ) v = 1 - v;
        return [(u - 0.5) * worldSize, (v - 0.5) * worldSize];
      });

      polygons.push(worldPoints);
    }
  }

  return polygons;
}