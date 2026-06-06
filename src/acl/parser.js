/**
 * ACL File Parser — public API entry point (barrel module).
 * Delegates to focused sub-modules for parsing, syncing, and utility operations.
 */
const fs = require('fs');
const path = require('path');

// ─── External modules ────────────────────────────────────────
import {
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
} from './constants';
const { exportCSV, exportGameCSV } = require('../utils/csvIo');

// ─── Internal sub-modules ────────────────────────────────────
const { _parseSceneryData } = require('./scenery');
const {
  _parseWorldStateData, _extractFlightsFromWorldState,
} = require('./world_state');
const {
  _parseWorldStateFlightPlans, _parseFlightPlanEntry,
  _rebuildWorldStateSections,
} = require('./flight_plans');
const {
  sortFlightsChronologically,
  collectUniqueValues, getFileInfo,
  loadAudioCallsigns, mergeAudioCallsigns,
} = require('./utils');
const { scanGameRoot } = require('./scanner');
const {
  extractSpecificationDB, extractApproachData,
  buildAppPointMap, computeTotalApproachTimes,
  resolveFlyApproachPoints,
  computeProgressRatio, computePosition, computeDirection,
  buildFullPath, computePathLength,
  buildApproachAircraftBlock,
  buildDesignatorMapping, buildApproachCache,
  serializeApproachCache, deserializeApproachCache,
  extractSaveTime, extractGameTime,
} = require('./approach');
const {
  _rebuildTimelineSections, _generateFramesSection, _generateRunwayTimelineSection,
  _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline,
  _extractConfig,
} = require('./flight_plans');
const { createZip, listZipFiles, extractZip } = require('../utils/zipUtils');

// ─── Load flights from ACL (single source of truth) ───────────

function loadFlights(aclPath) {
  const log = (msg) => console.log('[ACL-LOAD]', path.basename(aclPath), '|', msg);
  log('loadFlights() START');

  const text = fs.readFileSync(aclPath, 'utf-8');
  const _rawText = text;

  let sceneryMaps = { runwayNameToGuid:{}, standIdToGuid:{}, runwayGuidToName:{}, standGuidToId:{} };
  let worldStateData = null;
  let _fromWorldState = false;
  let _fromFlightPlans = false;
  let flights = [];

  try {
    sceneryMaps = _parseSceneryData(text);

    // Primary: parse FlightPlans directly from ACL
    const fpResult = _parseWorldStateFlightPlans(text);
    if (fpResult && fpResult.flights && fpResult.flights.length > 0 && fpResult.fpData) {
      log('Found FlightPlans format — using as primary source');
      flights = fpResult.flights;
      worldStateData = fpResult.fpData;
      _fromFlightPlans = true;
    } else {
      // Fallback: WorldState Aircrafts (older format)
      const wsData = _parseWorldStateData(text);
      if (wsData && wsData.wsEntries.length > 0) {
        log('Found WorldState Aircrafts — using as primary source');
        worldStateData = wsData;
        _fromWorldState = true;
        flights = _extractFlightsFromWorldState(wsData, text, sceneryMaps);
      }
    }
  } catch (e) {
    log('ACL structure parse FAILED: ' + e.message);
    throw e;
  }

  if (flights.length === 0) throw new Error('No flight data found in ACL');

  // Locate CSV path from ACL's Config block for reference only (not read)
  let csvPath = null;
  const dir = path.dirname(aclPath);
  const config = _extractConfig(text);
  if (config && config.flightScheduleFile) {
    const candidate = path.join(dir, config.flightScheduleFile + '.csv');
    if (fs.existsSync(candidate)) csvPath = candidate;
  }

  return {
    flights, sceneryMaps, csvPath,
    before: '', after: '', arrayContent: '', originalBlocks: [],
    worldStateData, _fromWorldState, _fromFlightPlans,
    _rawText,
  };
}

// ─── Extract CurrentDateTime from ACL text ──────────────────

function extractCurrentDateTime(aclText) {
  const gtIdx = aclText.indexOf('"GameTime"');
  if (gtIdx < 0) { console.log('[extractCurrentDateTime] "GameTime" NOT FOUND'); return null; }
  const sub = aclText.substring(gtIdx, gtIdx + 2000);
  // Match both short-form "$type": 3, <ticks> and expanded "$type": "3|...", <ticks>
  const cdtMatch = sub.match(/"CurrentDateTime"[\s\S]{0,200}?"\$type":\s*(?:"\d+\|[^"]*"|\d+)\s*,\s*(-?\d+)/);
  if (!cdtMatch) { console.log('[extractCurrentDateTime] CurrentDateTime regex NO MATCH'); return null; }
  const ticks = parseInt(cdtMatch[1], 10);
  const baseTicks = Math.floor(ticks / 864000000000) * 864000000000;
  const secSinceMidnight = Math.round((ticks - baseTicks) / 10000000);
  const h = Math.floor(secSinceMidnight / 3600);
  const m = Math.floor((secSinceMidnight % 3600) / 60);
  const s = secSinceMidnight % 60;
  const timeString = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  console.log('[extractCurrentDateTime] SUCCESS: timeString=' + timeString + ' secSinceMidnight=' + secSinceMidnight);
  return { ticks, secSinceMidnight, timeString };
}

// ─── Generate full ACL from scratch ──────────────────────────

function generateFullAcl(aclPath, flights, _before, _after, _originalBlocks, _worldStateData, _sceneryMaps, _fromWorldState, _fromFlightPlans, approachCache, aclcfgStartTime, _saveSec) {
  _rebuildWorldStateSections(aclPath, flights, undefined, approachCache, aclcfgStartTime, _saveSec);
}

// ─── Public API ───────────────────────────────────────────────

module.exports = {
  // Public API
  loadFlights, generateFullAcl, extractCurrentDateTime,
  exportCSV, exportGameCSV,
  collectUniqueValues, mergeAudioCallsigns,
  getFileInfo, loadAudioCallsigns,
  sortFlightsChronologically,
  scanGameRoot,
  extractSpecificationDB, extractApproachData,
  buildAppPointMap, computeTotalApproachTimes,
  resolveFlyApproachPoints,
  computeProgressRatio, computePosition, computeDirection,
  buildFullPath, computePathLength,
  buildApproachAircraftBlock,
  buildDesignatorMapping, buildApproachCache,
  serializeApproachCache, deserializeApproachCache,
  extractSaveTime, extractGameTime,
  _rebuildTimelineSections, _generateFramesSection, _generateRunwayTimelineSection,
  _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline,
  _extractConfig,
  createZip, listZipFiles, extractZip,
  // Internal exports (used by tests)
  _parseWorldStateData, _parseSceneryData,
  _extractFlightsFromWorldState,
  _parseWorldStateFlightPlans, _parseFlightPlanEntry,
  _rebuildWorldStateSections,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
};
