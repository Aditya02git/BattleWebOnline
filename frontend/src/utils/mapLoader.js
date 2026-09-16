/**
 * MapLoader
 * Fetches maps.json and dynamically imports per-map terrain data.
 */

let _mapsCache = null;

export async function loadMapsData() {
  if (_mapsCache) return _mapsCache;
  const r = await fetch('/maps.json');
  if (!r.ok) throw new Error(`Failed to load maps.json: ${r.status}`);
  _mapsCache = await r.json();
  return _mapsCache;
}

export async function getMapById(id) {
  const maps = await loadMapsData();
  return maps.find(m => m.id === id) ?? maps[0];
}

/**
 * Dynamically imports the terrainData module for the given map definition.
 * Returns the terrainData export from that module.
 */
export async function loadMapTerrain(mapDef) {
  const path = mapDef?.terrain?.dataPath;
  if (!path) {
    // Fallback: static import of the default terrainData
    const mod = await import('./terrainData.js');
    return mod.terrainData;
  }
  // Dynamic import — path must be a bare module specifier or absolute URL
  const mod = await import(/* @vite-ignore */ path);
  return mod.terrainData;
}