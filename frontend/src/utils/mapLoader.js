/**
 * MapLoader
 * Fetches maps.json and dynamically imports per-map terrain data.
 */

let _mapsCache = null;

// Statically discovered by Vite at build time — each entry's value is a
// lazy loader function. This is what makes terrainData_2.js/_3.js etc.
// actually get bundled and included in the production build, instead of
// being an unresolvable runtime path.
const terrainModules = import.meta.glob('/src/utils/terrainData*.js');

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
 * Loads the terrainData module for the given map definition, using the
 * glob-based module map above so it works both in dev and in a production
 * build (where raw /src files are not deployed/servable).
 */
export async function loadMapTerrain(mapDef) {
  const path = mapDef?.terrain?.dataPath;

  if (!path) {
    const mod = await import('./terrainData.js');
    return mod.terrainData;
  }

  const loader = terrainModules[path];
  if (!loader) {
    console.error(
      `[MapLoader] No bundled terrain module for path "${path}". ` +
      `Known paths:`, Object.keys(terrainModules),
    );
    // Fallback so the game doesn't hard-crash — uses the default terrain.
    const mod = await import('./terrainData.js');
    return mod.terrainData;
  }

  const mod = await loader();
  return mod.terrainData;
}