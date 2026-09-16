// playerProfile.js — XP, career rank, currency, and K/D profile tracking.
// Persisted to localStorage so progress survives page reloads.

const STORAGE_KEY = 'tankSim_playerProfile_v1';

// ── Server sync config ───────────────────────────────────────────────────
// Set VITE_API_URL in a .env file if the backend isn't on this default.
const API_BASE_URL     = import.meta.env?.VITE_API_URL ?? 'http://localhost:5000';
const SYNC_DEBOUNCE_MS = 4000; // coalesce rapid-fire saves into one push

// ── XP rewards ──────────────────────────────────────────────────────────────
export const XP_REWARDS = {
  KILL:              20,   // destroying an enemy tank
  FIRST_HIT_BONUS:   5,    // bonus if the kill was a one-shot (no prior hits landed)
  CAPTURE_POINT:     50,   // successfully capturing a point
  MATCH_WIN:         100,
  MATCH_DRAW:        50,
  MATCH_LOSS:        0,    // participation XP even on defeat
};

// Currency rewards per match, based on this match's own kill/capture count.
export const MATCH_CURRENCY = {
  KILL_CURRENCY:    5,
  CAPTURE_CURRENCY: 7,
  DRAW_CURRENCY:    25,
  LOSS_CURRENCY:    0,
};

// XP penalty on match loss, scaled by current rank. Rank 1 = no penalty.
const LOSS_XP_PENALTY_PER_RANK = 5;

function _lossPenaltyForRank(rank) {
  return Math.max(0, (rank - 1) * LOSS_XP_PENALTY_PER_RANK);
}

// ── Career rank ladder ───────────────────────────────────────────────────────
// currency1Reward is granted once, the moment the player reaches that rank.
// Add/adjust rows freely — the system just walks this table by xpRequired.
export const RANKS = [
  { rank: 1,  name: 'Recruit',     xpRequired: 0,       currency1Reward: 0    },
  { rank: 2,  name: 'Veteran',     xpRequired: 1000,    currency1Reward: 100  },
  { rank: 3,  name: 'Elite',       xpRequired: 3000,    currency1Reward: 200  },
  { rank: 4,  name: 'Master',      xpRequired: 7000,    currency1Reward: 350  },
  { rank: 5,  name: 'Ace',         xpRequired: 13000,   currency1Reward: 500  },
  { rank: 6,  name: 'Elite Ace',   xpRequired: 22000,   currency1Reward: 700  },
  { rank: 7,  name: 'Hero',        xpRequired: 35000,   currency1Reward: 950  },
  { rank: 8,  name: 'Legend',      xpRequired: 55000,   currency1Reward: 1300 },
  { rank: 9,  name: 'Mythic',      xpRequired: 80000,   currency1Reward: 1800 },
  { rank: 10, name: 'Conqueror',   xpRequired: 120000,  currency1Reward: 2500 },
];

function _rankFromXP(xp) {
  let rank = 1;
  for (const r of RANKS) {
    if (xp >= r.xpRequired) rank = r.rank;
  }
  return rank;
}

function _defaultSeasonStats() {
  return {
    totalKills:    0,
    highestKill:   0,   // best single-match kill count this season
    totalDeaths:   0,   // tracked for K/D calc only — not shown in the UI
    totalCaptures: 0,
    matchesPlayed: 0,
    matchesWon:    0,
    matchesLost:   0,
    matchesDrawn:  0,
  };
}

function _defaultData() {
  return {
    xp:            0,
    rank:          1,
    currentSeason: 1,
    seasonStats:   _defaultSeasonStats(),
    rankStats:     _defaultSeasonStats(),
    rankHistory:   [],
    selectedTankId: 'tiger1',
    selectedPlaneId: 'standardFighter',
    ownedTankIds:  [],   // paid tanks the player has purchased (cost:0 tanks are always available, not tracked here)
    ownedPlaneIds: [],   // paid planes the player has purchased
    previewSelectId:   'tiger1',
    previewSelectType: 'tank',
    selectedTankSkills:  [],
    selectedPlaneSkills: [],
    unlockedTankSkills:  {},   // tankId -> [skillId, ...]
    unlockedPlaneSkills: {},   // planeId -> [skillId, ...]
    settings: {
      enableShadow:         true,
      shadowRes:            1024,
      enableTurretSound:    false,
      enableLensFlare:      true,
      enablePostprocessing: false,
      country:              null,   // ISO 3166-1 alpha-2, e.g. "DE" — null = not set
    },
    currency1:     0,   // active currency — earned at rank-up milestones
    currency2:     0,   // reserved for later — nothing awards this yet
    totalKills:    0,   // lifetime — kept for reference, not shown in the season UI
    totalDeaths:   0,
    totalCaptures: 0,
    matchesPlayed: 0,
    matchesWon:    0,
    matchesLost:   0,
    matchesDrawn:  0,
  };
}

class PlayerProfile {
  constructor() {
    this.data = _defaultData();
    this._syncTimer = null;
    this.isLoggedIn = false;   // ← guests never accrue currency
    this._currentMatchKills = 0;    // running kill count for the in-progress match
    this._currentMatchCaptures = 0; // running capture count for the in-progress match

    // ── Unsaved, in-progress match stats — only folded into the persisted
// profile (and synced to the server) once the match genuinely ends via
// commitMatchStats(). If the player quits early, discardMatchStats()
// wipes these instead, so an incomplete match never leaves any trace
// in kills/deaths/captures/XP/currency.
this._pendingKills          = 0;
this._pendingFirstHitKills  = 0;
this._pendingDeaths         = 0;
this._pendingCaptures       = 0;

    this._load();
    this._initSync(); // fire-and-forget — falls back to local-only on failure
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = { ..._defaultData(), ...parsed };
        // Deep-merge seasonStats/rankStats so a save from before a new
        // stat field was added (e.g. highestKill) doesn't leave it undefined.
        this.data.seasonStats = { ..._defaultSeasonStats(), ...(parsed.seasonStats ?? {}) };
        this.data.rankStats   = { ..._defaultSeasonStats(), ...(parsed.rankStats ?? {}) };
        this.data.rankHistory   = Array.isArray(parsed.rankHistory)   ? parsed.rankHistory   : [];
        this.data.ownedTankIds  = Array.isArray(parsed.ownedTankIds)  ? parsed.ownedTankIds  : [];
        this.data.ownedPlaneIds = Array.isArray(parsed.ownedPlaneIds) ? parsed.ownedPlaneIds : [];
        this.data.unlockedTankSkills  = (parsed.unlockedTankSkills  && typeof parsed.unlockedTankSkills  === 'object') ? parsed.unlockedTankSkills  : {};
        this.data.unlockedPlaneSkills = (parsed.unlockedPlaneSkills && typeof parsed.unlockedPlaneSkills === 'object') ? parsed.unlockedPlaneSkills : {};
      }
    } catch (err) {
      console.warn('[PlayerProfile] Failed to load saved profile, starting fresh:', err);
      this.data = _defaultData();
    }

    // Guests never carry currency across sessions — force to 0 until a
    // real server session confirms login (see _initSync / setLoggedIn).
    // This also covers stale localStorage left over from a prior logged-in
    // session on a shared browser.
    if (!this.isLoggedIn) {
      this.data.currency1 = 0;
      this.data.currency2 = 0;
    }
  }

  // ── Login-state gate — called by the auth UI on login/logout/session-check.
  // Guests keep playing (kills, XP, etc. still track) but currency stays 0.
  setLoggedIn(val) {
    const wasLoggedIn = this.isLoggedIn;
    this.isLoggedIn = !!val;

    if (!this.isLoggedIn && wasLoggedIn) {
      // Transitioning from logged-in → logged-out (explicit logout).
      // Currency, tank selection, and plane selection are account-tied —
      // wipe all three immediately rather than waiting for a full
      // reset()/reload.
      this.data.currency1 = 0;
      this.data.currency2 = 0;

      const defaultTankId = _defaultData().selectedTankId;
      const tankChanged = this.data.selectedTankId !== defaultTankId;
      this.data.selectedTankId = defaultTankId;

      const defaultPlaneId = _defaultData().selectedPlaneId;
      const planeChanged = this.data.selectedPlaneId !== defaultPlaneId;
      this.data.selectedPlaneId = defaultPlaneId;

      this.data.selectedTankSkills  = [];
      this.data.selectedPlaneSkills = [];

      const defaults = _defaultData();
      const previewChanged =
        this.data.previewSelectId !== defaults.previewSelectId ||
        this.data.previewSelectType !== defaults.previewSelectType;
      this.data.previewSelectId   = defaults.previewSelectId;
      this.data.previewSelectType = defaults.previewSelectType;

      this._save();

      if (tankChanged) {
        window.dispatchEvent(new CustomEvent('profile:tank-selected', {
          detail: { tankId: defaultTankId },
        }));
      }
      if (planeChanged) {
        window.dispatchEvent(new CustomEvent('profile:plane-selected', {
          detail: { planeId: defaultPlaneId },
        }));
      }
      if (previewChanged) {
        window.dispatchEvent(new CustomEvent('profile:preview-selected', {
          detail: { previewId: defaults.previewSelectId, previewType: defaults.previewSelectType },
        }));
      }
    } else if (!this.isLoggedIn) {
      // Already logged out (e.g. guest session-check failing) — just
      // make sure currency stays at 0 without touching tank selection.
      this.data.currency1 = 0;
      this.data.currency2 = 0;
      this._save();
    }
  }

  _save() {
    try {
      const toStore = { ...this.data };
      if (!this.isLoggedIn) {
        // Guests never persist currency locally — strip it entirely so
        // reloading (or resuming) as a guest always yields 0, regardless
        // of what's in memory.
        delete toStore.currency1;
        delete toStore.currency2;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    } catch (err) {
      console.warn('[PlayerProfile] Failed to save profile:', err);
    }
    this._scheduleSync();
  }

  // ── Server sync ───────────────────────────────────────────────────────
  // Best-effort — if the user isn't logged in (401/network error), this
  // silently no-ops and the profile just keeps working off localStorage.
  async _initSync() {
    try {
      const res = await fetch(`${API_BASE_URL}/api/profile`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) return; // not logged in, or server unreachable — keep local/guest data as-is

      this.isLoggedIn = true;   // ← server confirmed an active session

      const serverData = await res.json();
      if (!serverData) return;

      // The server is authoritative the moment a session exists — this
      // account's real progress lives there. Overwrite local state instead
      // of merging, since localStorage may hold stale guest-play data or
      // another account's stats left over on a shared browser.
      const fields = [
        'xp', 'currency1', 'currency2',
        'totalKills', 'totalDeaths', 'totalCaptures',
        'matchesPlayed', 'matchesWon', 'matchesLost', 'matchesDrawn',
      ];
      for (const field of fields) {
        const val = Number(serverData[field]);
        this.data[field] = Number.isFinite(val) ? val : 0;
      }
      this.data.rank = Number(serverData.rank) || _rankFromXP(this.data.xp);

      // Season is authoritative from the server — it's the one place that
      // knows whether the 4-month season has rolled over (see
      // applySeasonReset in profile.controller.js). Overwrite local season
      // state entirely rather than merging, same as the counters above.
      this.data.currentSeason = Number(serverData.currentSeason) || 1;
      this.data.seasonStats   = { ..._defaultSeasonStats(), ...(serverData.seasonStats ?? {}) };
      this.data.rankStats     = { ..._defaultSeasonStats(), ...(serverData.rankStats ?? {}) };
      this.data.rankHistory   = Array.isArray(serverData.rankHistory) ? serverData.rankHistory : [];

      if (typeof serverData.selectedTankId === 'string' && serverData.selectedTankId) {
        this.data.selectedTankId = serverData.selectedTankId;
      }
      if (typeof serverData.selectedPlaneId === 'string' && serverData.selectedPlaneId) {
        this.data.selectedPlaneId = serverData.selectedPlaneId;
      }
      if (typeof serverData.previewSelectId === 'string' && serverData.previewSelectId) {
        this.data.previewSelectId = serverData.previewSelectId;
      }
      if (serverData.previewSelectType === 'tank' || serverData.previewSelectType === 'plane') {
        this.data.previewSelectType = serverData.previewSelectType;
      }
      if (Array.isArray(serverData.selectedTankSkills)) {
        this.data.selectedTankSkills = serverData.selectedTankSkills;
      }
      if (Array.isArray(serverData.selectedPlaneSkills)) {
        this.data.selectedPlaneSkills = serverData.selectedPlaneSkills;
      }
      if (serverData.unlockedTankSkills && typeof serverData.unlockedTankSkills === 'object') {
        this.data.unlockedTankSkills = serverData.unlockedTankSkills;
      }
      if (serverData.unlockedPlaneSkills && typeof serverData.unlockedPlaneSkills === 'object') {
        this.data.unlockedPlaneSkills = serverData.unlockedPlaneSkills;
      }
      if (serverData.settings && typeof serverData.settings === 'object') {
        this.data.settings = { ..._defaultData().settings, ...serverData.settings };
      }

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      } catch (err) {
        console.warn('[PlayerProfile] Failed to save synced profile:', err);
      }

      window.dispatchEvent(new CustomEvent('profile:synced', { detail: { ...this.data } }));
    } catch (err) {
      console.warn('[PlayerProfile] Initial sync skipped:', err.message);
    }
  }

  // Debounced push — coalesces several rapid saves (e.g. a few kills in
  // quick succession) into a single network request.
  _scheduleSync() {
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this._pushToServer(false), SYNC_DEBOUNCE_MS);
  }

  async _pushToServer(keepalive = false) {
    this._syncTimer = null;
    try {
      await fetch(`${API_BASE_URL}/api/profile`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        keepalive,
        body: JSON.stringify(this.data),
      });
    } catch (err) {
      console.warn('[PlayerProfile] Sync push failed (will retry next change):', err.message);
    }
  }

  // Forces an immediate push instead of waiting out the debounce timer —
  // useful right after a match ends, or on page unload.
  flushSync() {
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._pushToServer(true);
  }

  // ── Tank selection ────────────────────────────────────────────────────
  // Persisted immediately (not debounced) since it's a deliberate,
  // one-off action rather than a rapid-fire counter update. Falls back
  // to local-only if the user isn't logged in.
  async setSelectedTank(tankId) {
    if (!tankId || this.data.selectedTankId === tankId) return;
    this.data.selectedTankId = tankId;

    // A different tank invalidates whatever skills were picked for the
    // PREVIOUS tank — reset immediately rather than waiting for the
    // research modal's own prune-on-open logic, so nothing stale lingers.
    const skillsChanged = (this.data.selectedTankSkills ?? []).length > 0;
    this.data.selectedTankSkills = [];

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[PlayerProfile] Failed to save selected tank locally:', err);
    }

    window.dispatchEvent(new CustomEvent('profile:tank-selected', { detail: { tankId } }));
    if (skillsChanged) {
      window.dispatchEvent(new CustomEvent('profile:skills-selected', {
        detail: { vehicleType: 'tank', skillIds: [] },
      }));
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/profile/tank`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tankId }),
      });
      if (!res.ok) return; // not logged in — local selection still applies
      const serverProfile = await res.json();
      if (serverProfile?.selectedTankId) {
        this.data.selectedTankId = serverProfile.selectedTankId;
      }
    } catch (err) {
      console.warn('[PlayerProfile] Failed to sync selected tank:', err.message);
    }

    // Push the cleared skill list to the server too — otherwise the old
    // tank's skills stay saved server-side and would reappear next login.
    if (skillsChanged) {
      this.setSelectedSkills('tank', []);
    }
  }

  getSelectedTankId() {
    return this.data.selectedTankId || 'tiger1';
  }

  // ── Plane selection ───────────────────────────────────────────────────
  // Same pattern as setSelectedTank — persisted immediately, falls back
  // to local-only if the user isn't logged in.
  async setSelectedPlane(planeId) {
    if (!planeId || this.data.selectedPlaneId === planeId) return;
    this.data.selectedPlaneId = planeId;

    // A different plane invalidates whatever skills were picked for the
    // PREVIOUS plane — reset immediately, same reasoning as setSelectedTank.
    const skillsChanged = (this.data.selectedPlaneSkills ?? []).length > 0;
    this.data.selectedPlaneSkills = [];

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[PlayerProfile] Failed to save selected plane locally:', err);
    }

    window.dispatchEvent(new CustomEvent('profile:plane-selected', { detail: { planeId } }));
    if (skillsChanged) {
      window.dispatchEvent(new CustomEvent('profile:skills-selected', {
        detail: { vehicleType: 'plane', skillIds: [] },
      }));
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/profile/plane`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planeId }),
      });
      if (!res.ok) return; // not logged in — local selection still applies
      const serverProfile = await res.json();
      if (serverProfile?.selectedPlaneId) {
        this.data.selectedPlaneId = serverProfile.selectedPlaneId;
      }
    } catch (err) {
      console.warn('[PlayerProfile] Failed to sync selected plane:', err.message);
    }

    if (skillsChanged) {
      this.setSelectedSkills('plane', []);
    }
  }

  getSelectedPlaneId() {
    return this.data.selectedPlaneId || 'standardFighter';
  }

  // ── Preview selection ─────────────────────────────────────────────────
  // What the configurator's live preview scene shows. Independent of
  // selectedTankId/selectedPlaneId — lets a player browse/showcase a
  // vehicle in preview without changing their actual battle loadout.
  // Same immediate-persist pattern as setSelectedTank/setSelectedPlane.
  async setPreviewSelect(previewId, previewType) {
    if (!previewId || (previewType !== 'tank' && previewType !== 'plane')) return;
    if (this.data.previewSelectId === previewId && this.data.previewSelectType === previewType) return;

    this.data.previewSelectId   = previewId;
    this.data.previewSelectType = previewType;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[PlayerProfile] Failed to save preview select locally:', err);
    }

    window.dispatchEvent(new CustomEvent('profile:preview-selected', {
      detail: { previewId, previewType },
    }));

    try {
      const res = await fetch(`${API_BASE_URL}/api/profile/preview`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewId, previewType }),
      });
      if (!res.ok) return; // not logged in — local selection still applies
      const serverProfile = await res.json();
      if (serverProfile?.previewSelectId) {
        this.data.previewSelectId   = serverProfile.previewSelectId;
        this.data.previewSelectType = serverProfile.previewSelectType;
      }
    } catch (err) {
      console.warn('[PlayerProfile] Failed to sync preview select:', err.message);
    }
  }

  getPreviewSelectId() {
    return this.data.previewSelectId || this.getSelectedTankId();
  }

  getPreviewSelectType() {
    return this.data.previewSelectType === 'plane' ? 'plane' : 'tank';
  }

  // ── Research skill selection (tank/plane) ───────────────────────────────
  // Same immediate-persist pattern as setSelectedTank/setPreviewSelect.
  // vehicleType: 'tank' | 'plane'. skillIds: array of skill id strings
  // (capped at 5, deduped, client-side — server also enforces this).
  async setSelectedSkills(vehicleType, skillIds) {
    if (vehicleType !== 'tank' && vehicleType !== 'plane') return;
    const field = vehicleType === 'plane' ? 'selectedPlaneSkills' : 'selectedTankSkills';

    const cleaned = [...new Set((skillIds ?? []).filter(id => typeof id === 'string' && id))].slice(0, 5);
    if (JSON.stringify(this.data[field] ?? []) === JSON.stringify(cleaned)) return;

    this.data[field] = cleaned;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[PlayerProfile] Failed to save selected skills locally:', err);
    }

    window.dispatchEvent(new CustomEvent('profile:skills-selected', {
      detail: { vehicleType, skillIds: cleaned },
    }));

    try {
      const res = await fetch(`${API_BASE_URL}/api/profile/skills`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleType, skillIds: cleaned }),
      });
      if (!res.ok) return; // not logged in — local selection still applies
      const serverProfile = await res.json();
      const serverField = serverProfile?.[field];
      if (Array.isArray(serverField)) {
        this.data[field] = serverField;
      }
    } catch (err) {
      console.warn('[PlayerProfile] Failed to sync selected skills:', err.message);
    }
  }

  getSelectedSkills(vehicleType) {
    const field = vehicleType === 'plane' ? 'selectedPlaneSkills' : 'selectedTankSkills';
    return Array.isArray(this.data[field]) ? this.data[field] : [];
  }

  // ── Skill unlocking (per vehicle id) ────────────────────────────────────
  getUnlockedSkills(vehicleType, vehicleId) {
    if (!vehicleId) return [];
    const field = vehicleType === 'plane' ? 'unlockedPlaneSkills' : 'unlockedTankSkills';
    const map = this.data[field] ?? {};
    return Array.isArray(map[vehicleId]) ? map[vehicleId] : [];
  }

  isSkillUnlocked(vehicleType, vehicleId, skillId) {
    return this.getUnlockedSkills(vehicleType, vehicleId).includes(skillId);
  }

  // Unlocks a single skill for a single vehicle id, spending currency1.
  // Same optimistic-update / rollback-on-rejection pattern as
  // purchaseVehicle. Guests can't unlock (no persisted currency to spend).
  async unlockSkill(vehicleType, vehicleId, skillId, cost) {
    if (vehicleType !== 'tank' && vehicleType !== 'plane') return { success: false, reason: 'bad-vehicle-type' };
    if (!vehicleId || !skillId) return { success: false, reason: 'bad-request' };
    if (!this.isLoggedIn) return { success: false, reason: 'not-logged-in' };

    const field = vehicleType === 'plane' ? 'unlockedPlaneSkills' : 'unlockedTankSkills';
    const map = this.data[field] ?? {};
    const already = Array.isArray(map[vehicleId]) ? map[vehicleId] : [];
    if (already.includes(skillId)) return { success: true, reason: 'already-unlocked' };

    const numericCost = Number(cost) || 0;
    if (this.data.currency1 < numericCost) return { success: false, reason: 'insufficient-funds' };

    // Optimistic local update
    this.data.currency1 -= numericCost;
    this.data[field] = { ...map, [vehicleId]: [...already, skillId] };
    this._save();
    window.dispatchEvent(new CustomEvent('profile:skill-unlocked', {
      detail: { vehicleType, vehicleId, skillId, currency1: this.data.currency1 },
    }));

    try {
      const res = await fetch(`${API_BASE_URL}/api/profile/skills/unlock`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleType, vehicleId, skillId, cost: numericCost }),
      });

      if (!res.ok) {
        // Server rejected — roll back the optimistic local change.
        const errBody = await res.json().catch(() => ({}));
        this.data.currency1 += numericCost;
        this.data[field] = { ...map, [vehicleId]: already };
        this._save();
        window.dispatchEvent(new CustomEvent('profile:skill-unlocked', {
          detail: { vehicleType, vehicleId, skillId, currency1: this.data.currency1, failed: true },
        }));
        return { success: false, reason: errBody.message ?? 'server-rejected' };
      }

      const serverProfile = await res.json();
      const serverField = serverProfile?.[field];
      if (serverField && typeof serverField === 'object') this.data[field] = serverField;
      if (typeof serverProfile.currency1 === 'number') this.data.currency1 = serverProfile.currency1;
      this._save();
      return { success: true };
    } catch (err) {
      console.warn('[PlayerProfile] Skill unlock sync failed, kept locally:', err.message);
      return { success: true, reason: 'offline-optimistic' };
    }
  }

  // ── Vehicle ownership ────────────────────────────────────────────────
  getOwnedTankIds()  { return Array.isArray(this.data.ownedTankIds)  ? this.data.ownedTankIds  : []; }
  getOwnedPlaneIds() { return Array.isArray(this.data.ownedPlaneIds) ? this.data.ownedPlaneIds : []; }
  isTankOwned(id)  { return this.getOwnedTankIds().includes(id); }
  isPlaneOwned(id) { return this.getOwnedPlaneIds().includes(id); }

  // Purchases a tank/plane with currency1. Guests can't buy (no persisted
  // currency to spend). Optimistically applies locally, then confirms with
  // the server; rolls back if the server rejects (e.g. stale balance,
  // already-owned race, insufficient funds re-checked server-side).
  async purchaseVehicle(vehicleType, id, cost) {
    if (vehicleType !== 'tank' && vehicleType !== 'plane') return { success: false, reason: 'bad-vehicle-type' };
    if (!this.isLoggedIn) return { success: false, reason: 'not-logged-in' };

    const field = vehicleType === 'plane' ? 'ownedPlaneIds' : 'ownedTankIds';
    const owned = this.data[field] ?? [];
    if (owned.includes(id)) return { success: true, reason: 'already-owned' };

    const numericCost = Number(cost) || 0;
    if (this.data.currency1 < numericCost) return { success: false, reason: 'insufficient-funds' };

    // Optimistic local update
    this.data.currency1 -= numericCost;
    this.data[field] = [...owned, id];
    this._save();
    window.dispatchEvent(new CustomEvent('profile:vehicle-purchased', {
      detail: { vehicleType, id, currency1: this.data.currency1 },
    }));

    try {
      const res = await fetch(`${API_BASE_URL}/api/profile/purchase`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleType, id, cost: numericCost }),
      });

      if (!res.ok) {
        // Server rejected — roll back the optimistic local change.
        const errBody = await res.json().catch(() => ({}));
        this.data.currency1 += numericCost;
        this.data[field] = (this.data[field] ?? []).filter(v => v !== id);
        this._save();
        window.dispatchEvent(new CustomEvent('profile:vehicle-purchased', {
          detail: { vehicleType, id, currency1: this.data.currency1, failed: true },
        }));
        return { success: false, reason: errBody.message ?? 'server-rejected' };
      }

      const serverProfile = await res.json();
      if (Array.isArray(serverProfile.ownedTankIds))  this.data.ownedTankIds  = serverProfile.ownedTankIds;
      if (Array.isArray(serverProfile.ownedPlaneIds)) this.data.ownedPlaneIds = serverProfile.ownedPlaneIds;
      if (typeof serverProfile.currency1 === 'number') this.data.currency1 = serverProfile.currency1;
      this._save();
      return { success: true };
    } catch (err) {
      // Network hiccup — keep the optimistic local purchase; next successful
      // sync (_initSync/_pushToServer) will reconcile it with the server.
      console.warn('[PlayerProfile] Purchase sync failed, kept locally:', err.message);
      return { success: true, reason: 'offline-optimistic' };
    }
  }

  // ── Settings (display/graphics prefs) ───────────────────────────────────
  // Same immediate-persist pattern as setSelectedTank/setPreviewSelect.
  // Accepts a partial patch object (e.g. { enableShadow: false }) and
  // merges it into the existing settings rather than requiring the full
  // set every call.
  async setSettings(patch) {
    if (!patch || typeof patch !== 'object') return;

    const current = this.data.settings ?? _defaultData().settings;
    const merged  = { ...current, ...patch };

    // Skip the round-trip entirely if nothing actually changed.
    if (JSON.stringify(current) === JSON.stringify(merged)) return;

    this.data.settings = merged;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[PlayerProfile] Failed to save settings locally:', err);
    }

    window.dispatchEvent(new CustomEvent('profile:settings-changed', {
      detail: { settings: { ...this.data.settings } },
    }));

    try {
      const res = await fetch(`${API_BASE_URL}/api/profile/settings`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      });
      if (!res.ok) return; // not logged in — local setting still applies
      const serverProfile = await res.json();
      if (serverProfile?.settings) {
        this.data.settings = { ...this.data.settings, ...serverProfile.settings };
      }
    } catch (err) {
      console.warn('[PlayerProfile] Failed to sync settings:', err.message);
    }
  }

  getSettings() {
    return { ..._defaultData().settings, ...(this.data.settings ?? {}) };
  }

  // ── Core XP + rank-up handling ─────────────────────────────────────────
  // `silent` suppresses the floating 'profile:xp-gain' toast (used by
  // main.js's addXpFeedEntry) without affecting the actual XP/rank math.
  // Used for match-end XP grants (kills/captures/result), since that
  // growth is already visualized as an incremental bar animation in the
  // match-end screen (_animateMatchRewards) — showing a floating toast
  // for the same XP at the same moment would be redundant.
  addXP(amount, reason = '', { silent = false } = {}) {
    if (!amount) return;
    // Never let a loss penalty push XP below the floor of the current rank —
    // this system only removes progress toward the *next* rank, it doesn't demote.
    const rankFloor = RANKS.find(r => r.rank === this.data.rank)?.xpRequired ?? 0;
    this.data.xp = Math.max(rankFloor, this.data.xp + amount);

    if (!silent) {
      window.dispatchEvent(new CustomEvent('profile:xp-gain', {
        detail: { amount, reason, totalXP: this.data.xp },
      }));
    }
    // Walk the rank ladder — handles multiple rank-ups from one big XP grant.
    let leveled = false;
    while (true) {
      const nextRank = RANKS.find(r => r.rank === this.data.rank + 1);
      if (!nextRank) break; // already at max rank
      if (this.data.xp < nextRank.xpRequired) break;

      // Snapshot the rank being left behind — this is what powers the
      // "past rank" history view. Only recorded if any stat actually
      // accrued while at this rank (skips a no-op snapshot on instant
      // multi-rank jumps from a huge XP grant).
      const outgoingRank = RANKS.find(r => r.rank === this.data.rank);
      const hasProgress = Object.keys(_defaultSeasonStats()).some(
        (k) => (this.data.rankStats[k] ?? 0) > 0
      );
      if (hasProgress) {
        this.data.rankHistory.push({
          season:     this.data.currentSeason,
          rank:       this.data.rank,
          rankName:   outgoingRank?.name ?? `Rank ${this.data.rank}`,
          stats:      { ...this.data.rankStats },
          achievedAt: new Date().toISOString(),
        });
      }
      this.data.rankStats = _defaultSeasonStats();

      this.data.rank = nextRank.rank;
      if (this.isLoggedIn) {
        this.data.currency1 += nextRank.currency1Reward;   // ← guests get 0
      }
      leveled = true;

      window.dispatchEvent(new CustomEvent('profile:rank-up', {
        detail: {
          rank: nextRank.rank,
          name: nextRank.name,
          currency1Reward: nextRank.currency1Reward,
        },
      }));
    }

    this._save();
    return leveled;
  }

  // ── Event hooks called from gameplay code ──────────────────────────────
  registerKill({ firstHit = false } = {}) {
  // Buffered only — nothing is written to this.data or persisted here.
  this._pendingKills++;
  if (firstHit) this._pendingFirstHitKills++;
  this._currentMatchKills++;

  // Still show the "+XP · Kill" toast immediately for feedback, but mark
  // it as a preview so it's clear this hasn't actually been saved yet.
  const previewXp = XP_REWARDS.KILL + (firstHit ? XP_REWARDS.FIRST_HIT_BONUS : 0);
  window.dispatchEvent(new CustomEvent('profile:xp-gain', {
    detail: { amount: previewXp, reason: firstHit ? 'First-strike kill' : 'Kill', preview: true },
  }));
}

  registerDeath() {
  // Buffered only — see registerKill's comment.
  this._pendingDeaths++;
}

  registerCapture() {
  this._pendingCaptures++;
  this._currentMatchCaptures++;

  window.dispatchEvent(new CustomEvent('profile:xp-gain', {
    detail: { amount: XP_REWARDS.CAPTURE_POINT, reason: 'Point captured', preview: true },
  }));
}

_clearPendingMatchStats() {
  this._pendingKills         = 0;
  this._pendingFirstHitKills = 0;
  this._pendingDeaths        = 0;
  this._pendingCaptures      = 0;
}

// Called ONLY when the match genuinely finishes (applyMatchEnd in main.js).
// Folds every buffered kill/death/capture into the real, persisted totals,
// grants the corresponding XP, then runs the existing match-end logic
// (win/loss/draw XP, currency, matchesPlayed, etc.) and saves once.
commitMatchStats(result) {
  this.data.totalKills             += this._pendingKills;
  this.data.seasonStats.totalKills += this._pendingKills;
  this.data.rankStats.totalKills   += this._pendingKills;

  this.data.totalDeaths             += this._pendingDeaths;
  this.data.seasonStats.totalDeaths += this._pendingDeaths;
  this.data.rankStats.totalDeaths   += this._pendingDeaths;

  this.data.totalCaptures             += this._pendingCaptures;
  this.data.seasonStats.totalCaptures += this._pendingCaptures;
  this.data.rankStats.totalCaptures   += this._pendingCaptures;

  const killXp    = this._pendingKills * XP_REWARDS.KILL
                   + this._pendingFirstHitKills * XP_REWARDS.FIRST_HIT_BONUS;
  const captureXp = this._pendingCaptures * XP_REWARDS.CAPTURE_POINT;

  // ── Silent — all of this match's XP (kills + captures + win/draw/loss,
  // the latter added inside registerMatchEnd below) is folded into one
  // single before→after snapshot that main.js's _animateMatchRewards()
  // plays as an incremental growing-bar animation on the match-end screen.
  // No floating "+XP" toast for any of it — that would just be a
  // redundant, disconnected restatement of the same number.
  if (killXp)    this.addXP(killXp, 'Kill', { silent: true });
  if (captureXp) this.addXP(captureXp, 'Point captured', { silent: true });

  this._clearPendingMatchStats();
  this.registerMatchEnd(result);   // existing logic: matchesPlayed/won/lost, currency, highestKill, _save()
}

// Called when the player leaves BEFORE the match ends (quit / leave match /
// disconnect). Wipes every buffered kill/death/capture so none of it is
// ever written to this.data or synced to the server.
discardMatchStats() {
  this._clearPendingMatchStats();
  this._currentMatchKills    = 0;
  this._currentMatchCaptures = 0;
}

  // result: 'VICTORY' | 'DEFEAT' | 'DRAW'
  registerMatchEnd(result) {
    this.data.matchesPlayed++;
    this.data.seasonStats.matchesPlayed++;
    this.data.rankStats.matchesPlayed++;

    let xp = XP_REWARDS.MATCH_LOSS;
    if (result === 'VICTORY') {
      this.data.matchesWon++;
      this.data.seasonStats.matchesWon++;
      this.data.rankStats.matchesWon++;
      xp = XP_REWARDS.MATCH_WIN;
    } else if (result === 'DRAW') {
      this.data.matchesDrawn++;
      this.data.seasonStats.matchesDrawn++;
      this.data.rankStats.matchesDrawn++;
      xp = XP_REWARDS.MATCH_DRAW;
    } else {
      this.data.matchesLost++;
      this.data.seasonStats.matchesLost++;
      this.data.rankStats.matchesLost++;
      xp = -_lossPenaltyForRank(this.data.rank);   // rank1: 0, rank2: -5, rank3: -10 ...
    }

    // Best single-match kill count — tracked both for the season and for
    // whichever rank is currently in progress.
    if (this._currentMatchKills > this.data.seasonStats.highestKill) {
      this.data.seasonStats.highestKill = this._currentMatchKills;
    }
    if (this._currentMatchKills > this.data.rankStats.highestKill) {
      this.data.rankStats.highestKill = this._currentMatchKills;
    }

    // Currency-1 reward — scaled by THIS match's own kills/captures on a
    // win, flat on a draw, nothing on a loss. Guests never accrue currency
    // (same rule as the rank-up reward below).
    let currencyEarned = 0;
    if (result === 'VICTORY') {
      currencyEarned =
        (MATCH_CURRENCY.CAPTURE_CURRENCY * this._currentMatchCaptures) +
        (MATCH_CURRENCY.KILL_CURRENCY * this._currentMatchKills);
    } else if (result === 'DRAW') {
      currencyEarned = MATCH_CURRENCY.DRAW_CURRENCY;
    } else {
      currencyEarned = MATCH_CURRENCY.LOSS_CURRENCY;
    }

    if (this.isLoggedIn && currencyEarned) {
      this.data.currency1 += currencyEarned;
      window.dispatchEvent(new CustomEvent('profile:currency-earned', {
        detail: { amount: currencyEarned, result, currency1: this.data.currency1 },
      }));
    }

    this._currentMatchKills    = 0;
    this._currentMatchCaptures = 0;

    // Silent — see the comment in commitMatchStats(): this XP is shown
    // exclusively via the match-end screen's animated reward bar, not a
    // separate floating toast.
    this.addXP(xp, `Match ${result.toLowerCase()}`, { silent: true });
    this._save();
  }

  // ── Read helpers ────────────────────────────────────────────────────────
  getKD() {
    const d = this.data.totalDeaths;
    return d > 0 ? this.data.totalKills / d : this.data.totalKills;
  }

  getSeasonKD() {
    const s = this.data.seasonStats ?? _defaultSeasonStats();
    return s.totalDeaths > 0 ? s.totalKills / s.totalDeaths : s.totalKills;
  }

  getRankHistory() {
    return Array.isArray(this.data.rankHistory) ? this.data.rankHistory : [];
  }

  getRankInfo() {
    const current = RANKS.find(r => r.rank === this.data.rank) ?? RANKS[0];
    const next     = RANKS.find(r => r.rank === this.data.rank + 1) ?? null;
    return {
      rank:        current.rank,
      name:        current.name,
      xp:          this.data.xp,
      xpForNext:   next ? next.xpRequired : null,
      isMaxRank:   !next,
    };
  }

  reset() {
    this.data = _defaultData();
    this._save();
  }
}

export const playerProfile = new PlayerProfile();

// Best-effort final sync so a match played right up to tab-close still
// reaches the server. `keepalive: true` (set inside flushSync → 
// _pushToServer) lets the request outlive page teardown.
window.addEventListener('beforeunload', () => {
  playerProfile.flushSync();
});