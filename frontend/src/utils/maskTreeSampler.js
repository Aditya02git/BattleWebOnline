// utils/maskTreeSampler.js
// Scatters world-space tree positions inside black regions of a mask image.
// Black pixel  = valid tree placement area
// White pixel  = excluded (roads, water, clearings, capture points, etc.)

export async function sampleTreePositions(maskImagePath, {
  worldSize   = 800,        // full world width/depth in world units
  count       = 400,        // target number of trees to place
  minDist     = 8,          // minimum spacing between trees (world units)
  maxAttempts = count * 25, // safety cap so we never infinite-loop on a mostly-white mask
} = {}) {
  const img = await loadImage(maskImagePath);

  const canvas = document.createElement('canvas');
  canvas.width  = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);

  const worldHalf = worldSize / 2;

  const isValid = (x, z) => {
    const u = (x + worldHalf) / worldSize;
    const v = (z + worldHalf) / worldSize;
    const px = Math.max(0, Math.min(width  - 1, (u * width)  | 0));
    const py = Math.max(0, Math.min(height - 1, (v * height) | 0));
    const idx = (py * width + px) * 4;
    // Only pure black (0,0,0) counts as valid. Fully transparent pixels are excluded too.
    return data[idx] === 0 && data[idx + 1] === 0 && data[idx + 2] === 0 && data[idx + 3] === 255;
  };

  // Spatial hash grid for O(1)-ish minimum-distance rejection (no O(n²) scan)
  const cellSize = Math.max(minDist, 1);
  const grid = new Map();
  const cellKeyOf = (x, z) => `${Math.floor(x / cellSize)}_${Math.floor(z / cellSize)}`;

  const tooClose = (x, z) => {
    const cx = Math.floor(x / cellSize);
    const cz = Math.floor(z / cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const arr = grid.get(`${cx + dx}_${cz + dz}`);
        if (!arr) continue;
        for (const p of arr) {
          const ddx = p.x - x, ddz = p.z - z;
          if (ddx * ddx + ddz * ddz < minDist * minDist) return true;
        }
      }
    }
    return false;
  };

  const results = [];
  let attempts = 0;

  while (results.length < count && attempts < maxAttempts) {
    attempts++;
    const x = Math.random() * worldSize - worldHalf;
    const z = Math.random() * worldSize - worldHalf;
    if (!isValid(x, z)) continue;
    if (tooClose(x, z)) continue;

    const point = { x, z };
    results.push(point);
    const key = cellKeyOf(x, z);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(point);
  }

  if (results.length < count) {
    console.warn(`sampleTreePositions: only placed ${results.length}/${count} points ` +
                 `(mask too small/dense, or minDist too large) for ${maskImagePath}`);
  }

  return results;
}

function loadImage(path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src = path;
  });
}