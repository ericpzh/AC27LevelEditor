'use strict';

/**
 * Format-aware demo visibility vs. schedule-trimming helpers (`src/acl/demo_window.js`).
 *
 * Separates two concerns that previously shared `DEMO_VISIBLE_BASES`:
 *   1. Browser/cache level visibility (`isDemoVisibleFile`), which still keeps
 *      all `DEMO_VISIBLE_BASES` filenames visible in the level browser.
 *   2. Load-stage schedule trimming (`shouldTrimDemoSchedule`), which on
 *      GATCARC4 v3 applies ONLY to explicit `.demo.acl` levels so ordinary
 *      levels such as `ZSJN_leisure_1.acl` load and save their full 24-flight
 *      schedule (including pre-checkpoint flights like `CES9197` at `05:45:00`
 *      and `DKH6071` at `05:45:42`). Legacy/v2 levels keep their existing
 *      `DEMO_VISIBLE_BASES` schedule-trimming behavior.
 */

const path = require('path');
const { openAclFile } = require('./archive');
const { WARMUP_SEC, DEMO_VISIBLE_BASES } = require('./constants');

/**
 * Browser / cache visibility predicate (unchanged across formats).
 * @param {string} filePathOrName
 * @returns {boolean}
 */
function isDemoVisibleFile(filePathOrName) {
  const name = path.basename(String(filePathOrName || ''));
  return DEMO_VISIBLE_BASES.has(name);
}

/**
 * Format-aware schedule-trimming predicate.
 * - On `gatcarc4-v3`: true strictly for explicit `.demo.acl` levels.
 * - On legacy / v1 / v2: true for `DEMO_VISIBLE_BASES`.
 *
 * @param {string} filePathOrName
 * @param {string|null|undefined} format
 * @returns {boolean}
 */
function shouldTrimDemoSchedule(filePathOrName, format) {
  const name = path.basename(String(filePathOrName || ''));
  if (!name) return false;
  if (format === 'gatcarc4-v3') {
    return /\.demo\.acl$/i.test(name);
  }
  return DEMO_VISIBLE_BASES.has(name);
}

/**
 * Whether to override `endTime` with `roundNearest5(cdtMin + DEMO_WINDOW_MIN)`
 * in `get-file-info`, `get-airport-files-info`, and `save-acl`.
 *
 * v3 `.demo.acl` levels already carry their intended demo `endTime` in
 * `MetaData.Config` (e.g. `ZSJN_peakdeparture.demo.acl` has `20:30:00`), so
 * the 30-min CDT heuristic is reserved for legacy / non-v3 demo files.
 *
 * @param {string} filePathOrName
 * @param {string|null|undefined} format
 * @returns {boolean}
 */
function shouldApplyLegacyDemoEndTimeOverride(filePathOrName, format) {
  if (format === 'gatcarc4-v3') return false;
  return shouldTrimDemoSchedule(filePathOrName, format);
}

/**
 * Filter a flight array to `[config.startTime, config.endTime)` using integer
 * minutes (`Math.floor`), matching the editor's demo-window semantics.
 *
 * @param {Array<object>} flights
 * @param {object|null} config
 * @returns {{ flights: Array<object>, config: object|null, _currentDateTime: string|null, removedCount: number }}
 */
function filterFlightsToConfigWindow(flights, config) {
  try {
    const toMin = (t) => {
      const p = String(t).split(':');
      return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
    };

    if (config && config.startTime && config.endTime && Array.isArray(flights)) {
      const startMin = toMin(config.startTime);
      const endMin = toMin(config.endTime);
      const before = flights.length;
      const filtered = flights.filter((fl) => {
        const lt = (fl.LandingTime || '').trim();
        const ob = (fl.OffBlockTime || '').trim();
        const flightMin = lt ? toMin(lt) : (ob ? toMin(ob) : Infinity);
        return flightMin >= startMin && flightMin < endMin;
      });
      const removedCount = before - filtered.length;
      return { flights: filtered, config, _currentDateTime: config.startTime, removedCount };
    }
  } catch (_) {}
  return { flights, config, _currentDateTime: null, removedCount: 0 };
}

/**
 * Load an `.acl` level for the editor (`load-acl`, `import-zip`,
 * `restore-latest-backup`, `reload-acl`) with format-aware demo trimming,
 * resolved config, and checkpoint `_saveSec`.
 *
 * @param {string} filePath
 */
function loadLevelForEditor(filePath) {
  const handle = openAclFile(filePath);
  const data = handle.readFlights(filePath);
  let config = handle.readConfigResolved();
  const isDemo = shouldTrimDemoSchedule(filePath, handle.format);

  let _currentDateTime = null;
  let removedCount = 0;
  if (isDemo && data.flights && data.flights.length > 0) {
    const result = filterFlightsToConfigWindow(data.flights, config);
    data.flights = result.flights;
    config = result.config;
    _currentDateTime = result._currentDateTime;
    removedCount = result.removedCount;
  }

  let _saveSec = null;
  try {
    _saveSec = handle.readGameTimeSec();
  } catch (_) {}
  if (_saveSec == null && config && config.startTime) {
    const p = String(config.startTime).split(':');
    _saveSec = parseInt(p[0], 10) * 3600 + parseInt(p[1], 10) * 60 + (parseInt(p[2], 10) || 0) + WARMUP_SEC;
  }

  return {
    handle,
    format: handle.format,
    config,
    _saveSec,
    _currentDateTime,
    isDemo,
    removedCount,
    ...data,
  };
}

module.exports = {
  isDemoVisibleFile,
  shouldTrimDemoSchedule,
  shouldApplyLegacyDemoEndTimeOverride,
  filterFlightsToConfigWindow,
  loadLevelForEditor,
};
