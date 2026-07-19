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
  _rebuildStaticDataSections,
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
const { readAclText } = require('./gatcarc');
const { AclDocument } = require('./acl_document');
const { parseTaxiwayPaths } = require('./taxiway');
const {
  extractSidRunwayMappings, extractMissedApproachMappings,
  buildSidPaths, buildMissedApproachPaths,
  extractApprRunwayMappings,
  buildApprPaths,
} = require('./sid_goaround');

// ─── Schema version detection ──────────────────────────────────

/**
 * Detect whether ACL text uses the v4 schema (StaticData with $blobdoc)
 * or the v2/v3 schema (WorldState section).
 * @param {string} text - Raw ACL text (already decoded from binary if needed)
 * @returns {number} 4 for v4 schema, 3 for v2/v3
 */
function detectSchemaVersion(text) {
  const t = createTokenizer(text);
  // v4 files have StaticData with a nested $blobdoc (decoded binary payload).
  // v2/v3 files have a top-level WorldState section.
  // Check for StaticData first — it's the definitive v4 marker.
  const sdSec = t.findSection('StaticData');
  if (sdSec) {
    const sdText = t.substring(sdSec.valueStart, sdSec.valueEnd);
    const sdT = createTokenizer(sdText);
    if (sdT.findSection('$blobdoc')) return 4;
  }
  return 3;
}

// ─── Load flights from ACL (single source of truth) ───────────

function loadFlights(aclPath) {
  const log = (msg) => console.log('[ACL-LOAD]', path.basename(aclPath), '|', msg);
  log('loadFlights() START');

  const text = readAclText(aclPath);
  const _rawText = text;

  // Detect schema version once — drives all downstream parsing
  const isV4 = detectSchemaVersion(text) === 4;
  log('Schema: ' + (isV4 ? 'v4' : 'v2/v3'));

  let sceneryMaps = { runwayNameToGuid:{}, standIdToGuid:{}, runwayGuidToName:{}, standGuidToId:{} };
  let worldStateData = null;
  let _fromWorldState = false;
  let _fromFlightPlans = false;
  let flights = [];

  try {
    sceneryMaps = _parseSceneryData(text, isV4);

    // Primary: parse FlightPlans directly from ACL
    const fpResult = _parseWorldStateFlightPlans(text, isV4);
    if (fpResult && fpResult.flights && fpResult.flights.length > 0 && fpResult.fpData) {
      log('Found FlightPlans format — using as primary source');
      flights = fpResult.flights;
      worldStateData = fpResult.fpData;
      _fromFlightPlans = true;
    } else if (!isV4) {
      // Fallback: WorldState Aircrafts (v2/v3 only — v4 has no WorldState)
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
    _rawText, isV4,
  };
}

// ─── Extract CurrentDateTime from ACL text ──────────────────

function extractCurrentDateTime(aclText, isV4) {
  // Auto-detect schema version if not explicitly provided (backward compat)
  if (isV4 === undefined) isV4 = detectSchemaVersion(aclText) === 4;

  if (isV4) {
    // v4 schema: MetaData.BaseTime — inline { "$type": 2, <ticks> }
    const t = createTokenizer(aclText);
    const mdSec = t.findSection('MetaData');
    if (mdSec) {
      const mdText = t.substring(mdSec.valueStart, mdSec.valueEnd);
      const mdT = createTokenizer(mdText);
      const btSec = mdT.findSection('BaseTime');
      if (btSec) {
        const btText = mdT.substring(btSec.valueStart, btSec.valueEnd);
        // Structural extraction: find $type key, then parse bare ticks after comma
        const btT = createTokenizer(btText);
        const typeSec = btT.findSection('$type');
        let ticksStr = null;
        if (typeSec) {
          let after = typeSec.valueEnd;
          while (after < btText.length && ' \t\n\r,'.includes(btText[after])) after++;
          if (after < btText.length && (btText[after] === '-' || (btText[after] >= '0' && btText[after] <= '9'))) {
            let numEnd = after;
            if (btText[numEnd] === '-') numEnd++;
            while (numEnd < btText.length && btText[numEnd] >= '0' && btText[numEnd] <= '9') numEnd++;
            if (numEnd > after) ticksStr = btText.substring(after, numEnd);
          }
        }
        if (ticksStr) {
          const ticks = BigInt(ticksStr);
          const { TICKS_PER_DAY } = require('./constants.js');
          const baseTicks = (ticks / TICKS_PER_DAY) * TICKS_PER_DAY;
          const secSinceMidnight = Number((ticks - baseTicks) / 10000000n);
          const h = Math.floor(secSinceMidnight / 3600);
          const m = Math.floor((secSinceMidnight % 3600) / 60);
          const s = secSinceMidnight % 60;
          const timeString = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
          console.log('[extractCurrentDateTime] v4 BaseTime SUCCESS: timeString=' + timeString + ' secSinceMidnight=' + secSinceMidnight);
          return { ticks, secSinceMidnight, timeString };
        }
      }
    }
    console.log('[extractCurrentDateTime] v4 MetaData.BaseTime NOT FOUND');
    return null;
  }

  // v2/v3 schema: GameTime.CurrentDateTime
  const t2 = createTokenizer(aclText);
  const gtSec = t2.findSection('GameTime');
  if (gtSec) {
    const result = _parseDateTimeSection(aclText, gtSec, 'CurrentDateTime');
    if (result) return result;
  }

  console.log('[extractCurrentDateTime] NOT FOUND (no GameTime)');
  return null;
}

/**
 * Parse a DateTime value from a section (shared v2/v3 helper).
 */
function _parseDateTimeSection(aclText, section, fieldName) {
  const t = createTokenizer(aclText);
  const secText = t.substring(section.valueStart, section.valueEnd);
  try {
    const cleaned = preprocessUnityJson(secText);
    const parsed = JSON.parse(cleaned);
    const dt = parsed[fieldName];
    if (dt && dt.__v && dt.__v.length > 0) {
      const ticks = BigInt(dt.__v[0]);
      const { TICKS_PER_DAY } = require('./constants.js');
      const baseTicks = (ticks / TICKS_PER_DAY) * TICKS_PER_DAY;
      const secSinceMidnight = Number((ticks - baseTicks) / 10000000n);
      const h = Math.floor(secSinceMidnight / 3600);
      const m = Math.floor((secSinceMidnight % 3600) / 60);
      const s = secSinceMidnight % 60;
      const timeString = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      console.log('[extractCurrentDateTime] GameTime.' + fieldName + ' SUCCESS: timeString=' + timeString + ' secSinceMidnight=' + secSinceMidnight);
      return { ticks, secSinceMidnight, timeString };
    }
  } catch (e) {
    console.log('[extractCurrentDateTime] JSON parse failed for ' + fieldName + ', falling back to regex:', e.message);
  }

  // Fallback: regex extraction — anchor to "GameTime" first for v2/v3 compatibility
  const gtIdx = aclText.indexOf('"GameTime"');
  if (gtIdx < 0) { console.log('[extractCurrentDateTime] "GameTime" NOT FOUND (fallback)'); return null; }
  const sub = aclText.substring(gtIdx, gtIdx + 2000);
  const dtMatch = sub.match(/"CurrentDateTime"[\s\S]{0,200}?"\$type":\s*(?:"\d+\|[^"]*"|\d+)\s*,\s*(-?\d+)/);
  if (!dtMatch) { console.log('[extractCurrentDateTime] CurrentDateTime regex NO MATCH'); return null; }
  const ticks = parseInt(dtMatch[1], 10);
  const baseTicks = Math.floor(ticks / 864000000000) * 864000000000;
  const secSinceMidnight = Math.round((ticks - baseTicks) / 10000000);
  const h = Math.floor(secSinceMidnight / 3600);
  const m = Math.floor((secSinceMidnight % 3600) / 60);
  const s = secSinceMidnight % 60;
  const timeString = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  console.log('[extractCurrentDateTime] CurrentDateTime SUCCESS (fallback): timeString=' + timeString + ' secSinceMidnight=' + secSinceMidnight);
  return { ticks, secSinceMidnight, timeString };
}

// ─── Generate full ACL from scratch ──────────────────────────

function generateFullAcl(aclPath, flights, _before, _after, _originalBlocks, _worldStateData, _sceneryMaps, _fromWorldState, _fromFlightPlans, approachCache, aclcfgStartTime, _saveSec, isV4) {
  if (isV4) {
    // v4: rebuild StaticData.$blobdoc.StaticItems flight-plan entries (no aircraft generation)
    _rebuildStaticDataSections(aclPath, flights, undefined, approachCache);
  } else {
    // v2/v3: rebuild WorldState.FlightPlans + Aircrafts
    _rebuildWorldStateSections(aclPath, flights, undefined, approachCache, aclcfgStartTime, _saveSec);
  }
}

// ─── Public API ───────────────────────────────────────────────

module.exports = {
  // Public API
  loadFlights, generateFullAcl, extractCurrentDateTime, detectSchemaVersion,
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
  _rebuildStaticDataSections,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
};
