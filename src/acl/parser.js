/**
 * ACL File Parser — public API entry point (barrel module).
 * Delegates to focused sub-modules for parsing, syncing, and utility operations.
 */
const fs = require('fs');
const path = require('path');

// ─── External modules ────────────────────────────────────────
const { FIELDS, FIELD_LABELS, DROPDOWN_FIELDS } = require('./constants.js');
const { exportCSV, exportGameCSV } = require('../utils/csvIo');

// ─── Internal sub-modules ────────────────────────────────────
const { _parseSceneryData, _parseStandPositions, _parseAreas } = require('./scenery');
const {
  _parseWorldStateData, _extractFlightsFromWorldState,
} = require('./world_state');
const {
  _parseWorldStateFlightPlans, _parseFlightPlanEntry,
  _rebuildWorldStateSections,
} = require('./flight_plans');
const {
  sortFlightsChronologically,
  collectUniqueValues, collectRunwayPairs, getFileInfo,
  loadAudioCallsigns, mergeAudioCallsigns,
} = require('./utils');
const { scanGameRoot } = require('./scanner');
const {
  extractSpecificationDB, extractApproachData, extractState5Data, extractTypeMap,
  buildAppPointMap, buildState5ParamsMap, buildFlyFractionMap,
  resolveFlyApproachPoints,
  computeProgressRatio, computePosition, computeDirection,
  buildFullPath, computePathLength, computeApproachCap,
  buildApproachAircraftBlock, buildState5AircraftBlock,
  buildDesignatorMapping, buildApproachCache, buildStarPaths,
  extractStarRunwayMappings,
  serializeApproachCache, deserializeApproachCache,
  extractSaveTime, extractGameTime,
  _parseRunwayThresholds,
} = require('./approach');
const {
  _rebuildTimelineSections, _generateFramesSection, _generateRunwayTimelineSection,
  _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline,
  _extractConfig, _extractTowerChannelGuid,
} = require('./flight_plans');
const { createZip, listZipFiles, extractZip } = require('../utils/zipUtils');
const { createTokenizer } = require('./tokenizer');
const { preprocessUnityJson, serializeUnityJson, isUnityJson } = require('./acl_json');
const { AclDocument } = require('./acl_document');
const { parseTaxiwayPaths } = require('./taxiway');
const {
  extractSidRunwayMappings, extractMissedApproachMappings,
  buildSidPaths, buildMissedApproachPaths,
  extractApprRunwayMappings,
  buildApprPaths,
} = require('./sid_goaround');

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
  // Use tokenizer for section finding + pre-processor + JSON.parse
  const t = createTokenizer(aclText);
  const gtSec = t.findSection('GameTime');
  if (!gtSec) { console.log('[extractCurrentDateTime] "GameTime" NOT FOUND'); return null; }

  const gtText = t.substring(gtSec.valueStart, gtSec.valueEnd);
  try {
    const cleaned = preprocessUnityJson(gtText);
    const parsed = JSON.parse(cleaned);
    const cdt = parsed.CurrentDateTime;
    if (cdt && cdt.__v && cdt.__v.length > 0) {
      const ticks = BigInt(cdt.__v[0]);
      const { TICKS_PER_DAY } = require('./constants.js');
      const baseTicks = (ticks / TICKS_PER_DAY) * TICKS_PER_DAY;
      const secSinceMidnight = Number((ticks - baseTicks) / 10000000n);
      const h = Math.floor(secSinceMidnight / 3600);
      const m = Math.floor((secSinceMidnight % 3600) / 60);
      const s = secSinceMidnight % 60;
      const timeString = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      console.log('[extractCurrentDateTime] SUCCESS: timeString=' + timeString + ' secSinceMidnight=' + secSinceMidnight);
      return { ticks, secSinceMidnight, timeString };
    }
  } catch (e) {
    console.log('[extractCurrentDateTime] JSON parse failed, falling back to regex:', e.message);
  }

  // Fallback: regex extraction (legacy)
  const gtIdx = aclText.indexOf('"GameTime"');
  if (gtIdx < 0) { console.log('[extractCurrentDateTime] "GameTime" NOT FOUND (fallback)'); return null; }
  const sub = aclText.substring(gtIdx, gtIdx + 2000);
  const cdtMatch = sub.match(/"CurrentDateTime"[\s\S]{0,200}?"\$type":\s*(?:"\d+\|[^"]*"|\d+)\s*,\s*(-?\d+)/);
  if (!cdtMatch) { console.log('[extractCurrentDateTime] CurrentDateTime regex NO MATCH'); return null; }
  const ticks = parseInt(cdtMatch[1], 10);
  const baseTicks = Math.floor(ticks / 864000000000) * 864000000000;
  const secSinceMidnight = Math.round((ticks - baseTicks) / 10000000);
  const h = Math.floor(secSinceMidnight / 3600);
  const m = Math.floor((secSinceMidnight % 3600) / 60);
  const s = secSinceMidnight % 60;
  const timeString = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  console.log('[extractCurrentDateTime] SUCCESS (fallback): timeString=' + timeString + ' secSinceMidnight=' + secSinceMidnight);
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
  collectUniqueValues, collectRunwayPairs, mergeAudioCallsigns,
  getFileInfo, loadAudioCallsigns,
  sortFlightsChronologically,
  scanGameRoot,
  extractSpecificationDB, extractApproachData, extractState5Data, extractTypeMap,
  buildAppPointMap, buildState5ParamsMap, buildFlyFractionMap,
  resolveFlyApproachPoints,
  computeProgressRatio, computePosition, computeDirection,
  buildFullPath, computePathLength, computeApproachCap,
  buildApproachAircraftBlock, buildState5AircraftBlock,
  buildDesignatorMapping, buildApproachCache, buildStarPaths,
  extractStarRunwayMappings,
  serializeApproachCache, deserializeApproachCache,
  extractSaveTime, extractGameTime,
  _rebuildTimelineSections, _generateFramesSection, _generateRunwayTimelineSection,
  _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline,
  _extractConfig,
  createZip, listZipFiles, extractZip,
  // New object-based parser (v1.0.10+)
  createTokenizer, preprocessUnityJson, serializeUnityJson, isUnityJson,
  AclDocument,
  // Taxiway + SID / Missed Approach parsers
  parseTaxiwayPaths,
  extractSidRunwayMappings, extractMissedApproachMappings,
  buildSidPaths, buildMissedApproachPaths,
  extractApprRunwayMappings, buildApprPaths,
  // Internal exports (used by tests)
  _parseWorldStateData, _parseSceneryData, _parseStandPositions, _parseAreas,
  _parseRunwayThresholds,
  _extractFlightsFromWorldState,
  _parseWorldStateFlightPlans, _parseFlightPlanEntry,
  _rebuildWorldStateSections,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
};
