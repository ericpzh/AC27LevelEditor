// ─── gameCallsigns — the trustworthy global flight-number pool ───────────────
//
// The game pre-records a captain-callsign clip for every flight it can speak and
// throws `InvalidOperationException: ... failed to allocate callsign '<CS>' for
// crew voice '<voice>'` for a number it has no recording of.
//
// `catalog.bin` is NOT a reliable allow-list: it lists more callsigns than are
// actually allocatable (verified in-game — `KLM982`/`KLM983`/`KLM984` are in the
// catalog but crash), and allocatability is additionally voice / airport-bundle
// scoped (a Chinese-carrier callsign like `CCA9052` is real but only allocates
// for a Chinese-captain voice). See `references/data-flow.md`.
//
// The trustworthy source is the union of callsigns the game's own levels ship:
// every one is proven to load against its shipped voice. `unionFlightNums`
// merges each airport's per-airport `_flightNums` (collected from that airport's
// `.acl` schedules during the root scan) into one install-global pool, so the
// Flight # picker can offer numbers beyond the current airport's own schedule
// without ever offering one the game cannot speak. Airline validity stays
// per-airport (a foreign airline fails even with a recorded callsign).
//
// Plain CommonJS only — required from electron/main.js and tests.
'use strict';

function _numericCompare(a, b) {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

/**
 * Merge any number of `airline designator → numbers[]` maps into one install-
 * global map (union + numeric sort). The caller passes every airport's
 * `dropdownValues._flightNums`; the result is the set of callsigns the game
 * actually ships, grouped by airline.
 *
 * @param {Array<Record<string, string[]>>} maps
 * @returns {Record<string, string[]>}
 */
function unionFlightNums(maps) {
  const sets = {};
  for (const map of (maps || [])) {
    if (!map) continue;
    for (const [code, nums] of Object.entries(map)) {
      const set = sets[code] || (sets[code] = new Set());
      for (const n of (nums || [])) set.add(String(n));
    }
  }
  const out = {};
  for (const code of Object.keys(sets).sort()) out[code] = [...sets[code]].sort(_numericCompare);
  return out;
}

module.exports = { unionFlightNums };
