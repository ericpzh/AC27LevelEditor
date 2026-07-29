/**
 * Centralized ACL config resolution.
 *
 * Single source of truth for resolving a level's start/end time:
 *   Config.startTime from the ACL, overridden by GameTime.CurrentDateTime if present.
 *
 * Every consumer — editor toolbar, validation bounds, browser file list, demo
 * filtering — should derive its time window from resolveConfigTime().
 */
// Lazy requires inside resolveConfigTime() to avoid circular dependency:
// config.js → flight_plans.js/parser.js → utils.js → config.js

/**
 * Extract the Config block from ACL raw text and override startTime with
 * GameTime.CurrentDateTime (the player's actual in-game time, which includes
 * the warmup period).
 *
 * @param {string} rawText — full ACL file text
 * @returns {object|null} config with startTime/endTime/flightScheduleFile/runwayTimelineFile,
 *                        or null if extraction failed
 */
function resolveConfigTime(rawText) {
  // Lazy requires to avoid circular dependency (config.js ↔ flight_plans.js/parser.js ↔ utils.js)
  const { _extractConfig } = require('./flight_plans');
  const { extractCurrentDateTime } = require('./parser');
  const { roundSecondsToMinute, minutesToTimeStr } = require('../utils/timeUtils');
  const config = _extractConfig(rawText);
  if (config) {
    try {
      const cdt = extractCurrentDateTime(rawText);
      if (cdt && cdt.timeString) {
        // Round UP to next minute for start time (ceil), so the scenario window
        // begins at or after the actual save time, not before.
        const startMin = roundSecondsToMinute(cdt.secSinceMidnight, true);
        const roundedStartTime = minutesToTimeStr(startMin);
        console.log('[resolveConfigTime] OVERRIDE startTime: ' + config.startTime + ' -> ' + roundedStartTime + ' (ceil-rounded from CDT=' + cdt.timeString + ')');
        config.startTime = roundedStartTime;
      } else {
        console.log('[resolveConfigTime] NO CDT (cdt=' + JSON.stringify(cdt) + '), keeping: ' + config.startTime);
      }
    } catch (e) {
      console.log('[resolveConfigTime] CDT extraction THREW:', e.message);
    }
  } else {
    console.log('[resolveConfigTime] _extractConfig returned NULL');
  }
  return config;
}

/**
 * Resolve startTime/endTime for UI display from ACL raw text.
 *
 * Thin wrapper around resolveConfigTime — returns only { startTime, endTime }
 * derived from Config.startTime / Config.endTime, with CDT override applied.
 * No fallback to flight times or other synthetic values.
 *
 * @param {string} rawText — full ACL file text
 * @returns {{ startTime: string|null, endTime: string|null }}
 */
function resolveDisplayTimes(rawText) {
  const config = resolveConfigTime(rawText);
  return {
    startTime: (config && config.startTime) || null,
    endTime: (config && config.endTime) || null,
  };
}

module.exports = { resolveConfigTime, resolveDisplayTimes };
