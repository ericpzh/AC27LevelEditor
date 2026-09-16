'use strict';

// ─── Persisted UI prefs (cache.json `flags` bag) ─────────────
// Whitelisted keys the renderer may read/write via `get-cache-flag` /
// `set-cache-flag` (electron/main.js). Keeping the whitelist + merge logic
// here (pure, no electron require) lets the guards be unit-tested.

const CACHE_FLAG_KEYS = ['liveryModHintDismissed'];

function isCacheFlagKey(key) {
  return CACHE_FLAG_KEYS.includes(key);
}

// Read a flag off a parsed cache payload. Unknown keys are rejected.
// Missing flag/false/null all read as `false`.
function readCacheFlag(cacheData, key) {
  if (!isCacheFlagKey(key)) return { success: false, error: 'BAD_FLAG' };
  const flags = cacheData && cacheData.flags;
  return { success: true, value: Boolean(flags && flags[key]) };
}

// Merge a boolean flag into a parsed cache payload (mutates and returns it).
// A missing payload is refused: callers must never create a cache.json from a
// flag write (a version-matching record with no gameRoot/airports would make
// boot treat the cache as ready).
function writeCacheFlag(cacheData, key, value) {
  if (!isCacheFlagKey(key)) return { success: false, error: 'BAD_FLAG' };
  if (!cacheData) return { success: false, error: 'NO_CACHE' };
  cacheData.flags = { ...(cacheData.flags || {}), [key]: Boolean(value) };
  return { success: true, data: cacheData };
}

module.exports = { CACHE_FLAG_KEYS, isCacheFlagKey, readCacheFlag, writeCacheFlag };
