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
  _parseWorldStateFlightPlans, _parseFlightPlanEntry,
  _rebuildStaticDataSections,
  _validateStandConflicts,
} = require('./flight_plans');
const {
  sortFlightsChronologically,
  collectUniqueValues, collectRunwayPairs, extractV4RunwayPairs, getFileInfo,
  loadAudioCallsigns, mergeAudioCallsigns,
  parseAirlineCountryRegistry, loadAirlineCountryRegistry,
} = require('./utils');
const { scanGameRoot, findGameRoot } = require('./scanner');
const {
  extractSpecificationDB, extractApproachData, extractState5Data, extractTypeMap,
  buildAppPointMap, buildState5ParamsMap, buildFlyFractionMap,
  resolveFlyApproachPoints,
  computeProgressRatio, computePosition, computeDirection,
  buildFullPath, computePathLength, computeApproachCap,
  buildApproachAircraftBlock, buildState5AircraftBlock,
  buildDesignatorMapping, jetwayKeyStandCandidates, buildApproachCache, buildStarPaths,
  extractStarRunwayMappings,
  serializeApproachCache, deserializeApproachCache,
  extractGameTime,
  _parseRunwayThresholds,
} = require('./approach');
const {
  _rebuildTimelineSections, _generateFramesSection, _generateRunwayTimelineSection,
  _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline,
  _extractConfig, _extractTowerChannelGuid,
} = require('./flight_plans');
const { createZip, listZipFiles, extractZip, readZipEntries } = require('../utils/zipUtils');
const { createTokenizer } = require('./tokenizer');
const { preprocessUnityJson, serializeUnityJson, isUnityJson, parseOdinValue, parseOdinObject, parseOdinArray } = require('./acl_json');
const { openAcl, openAclFile, detectAclFormat } = require('./archive');
const { AclDocument } = require('./acl_document');
const { parseTaxiwayPaths } = require('./taxiway');
const {
  extractSidRunwayMappings, extractMissedApproachMappings,
  buildSidPaths, buildMissedApproachPaths,
  extractApprRunwayMappings,
  buildApprPaths,
} = require('./sid_goaround');
const {
  isDemoVisibleFile,
  shouldTrimDemoSchedule,
  shouldApplyLegacyDemoEndTimeOverride,
  filterFlightsToConfigWindow,
  loadLevelForEditor,
} = require('./demo_window');
const {
  clearV3AudioCache,
  loadV3VoiceCatalog,
  loadV3ClipIndex,
  loadV3ChannelConfig,
  lookupV3Callsigns,
  lookupV3CallsignsForAirport,
  loadV3AirportAudio,
  peekAclFormat,
  hasV2AudioClips,
  hasV3AudioAssets,
  resolveAirportAudioMode,
  computeAudioSourceSignature,
} = require('./v3/audio');

// ─── Load flights from ACL (single source of truth) ───────────

function loadFlights(aclPath) {
  const log = (msg) => console.log('[ACL-LOAD]', path.basename(aclPath), '|', msg);
  log('loadFlights() START');

  const handle = openAclFile(aclPath);
  const result = handle.readFlights(aclPath);
  if (!result.flights || result.flights.length === 0) {
    log('No flight data found in ACL — returning empty schedule (0-flight level)');
  }
  return result;
}

// ─── Extract CurrentDateTime from ACL text ──────────────────

function extractCurrentDateTime(aclText) {
  const t = createTokenizer(aclText);
  // ── v4: Try GameTime.CurrentDateTime first (WorldState snapshot) ──
  // For scenario files this is the post-warmup snapshot time.
  // For demo files it matches MetaData.BaseTime (both = save snapshot).
  const cdtIdx = aclText.indexOf('"CurrentDateTime"');
  if (cdtIdx >= 0) {
    const afterKey = aclText.indexOf(':', cdtIdx);
    if (afterKey >= 0) {
      let vStart = afterKey + 1;
      while (vStart < aclText.length && ' \t\n\r'.includes(aclText[vStart])) vStart++;
      if (aclText[vStart] === '{') {
        // v4 structure: "CurrentDateTime": { "$id":N, "$type":"...", { "$type":N, <ticks> } }
        const sub = aclText.substring(vStart, vStart + 2000);
        const tickMatch = sub.match(/\{\s*"\$type"\s*:\s*\d+\s*,\s*(-?\d+)\s*\}/);
        if (tickMatch) {
          const ticks = BigInt(tickMatch[1]);
          const { TICKS_PER_DAY } = require('./constants.js');
          const baseTicks = (ticks / TICKS_PER_DAY) * TICKS_PER_DAY;
          const secSinceMidnight = Number((ticks - baseTicks) / 10000000n);
          const h = Math.floor(secSinceMidnight / 3600);
          const m = Math.floor((secSinceMidnight % 3600) / 60);
          const s = secSinceMidnight % 60;
          const timeString = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
          console.log('[extractCurrentDateTime] v4 GameTime.CurrentDateTime SUCCESS: timeString=' + timeString + ' secSinceMidnight=' + secSinceMidnight);
          return { ticks, secSinceMidnight, timeString };
        }
      }
    }
    console.log('[extractCurrentDateTime] v4 GameTime.CurrentDateTime NOT PARSED, falling back to MetaData.BaseTime');
  }

  // v4 fallback: MetaData.BaseTime — inline { "$type": 2, <ticks> }
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

// ─── Generate full ACL from scratch ──────────────────────────

function generateFullAcl(aclPath, flights, _before, _after, _originalBlocks, _sceneryMaps, approachCache, aclcfgStartTime, _saveSec) {
  // Pre-validation: detect stand occupancy conflicts before save
  _validateStandConflicts(flights);

  const handle = openAclFile(aclPath);
  if (handle.format === 'gatcarc4-v3') {
    handle.applyEdits({
      flights,
      sceneryMaps: _sceneryMaps,
      approachCache,
      filePath: aclPath,
      _saveSec,
    });
    handle.saveToFile(aclPath);
    return;
  }

  // The renderer's stand list (sceneryMaps.standIdToGuid keys) doubles as the
  // complete stand pool for the game-compat stand normalization.
  const standPool = (_sceneryMaps && _sceneryMaps.standIdToGuid)
    ? Object.keys(_sceneryMaps.standIdToGuid)
    : null;

  // v4: rebuild StaticData.$blobdoc.StaticItems flight-plan entries (no aircraft generation)
  _rebuildStaticDataSections(aclPath, flights, undefined, approachCache, aclcfgStartTime, _saveSec, standPool);
}

// ─── Public API ───────────────────────────────────────────────

module.exports = {
  // Public API
  loadFlights, generateFullAcl, extractCurrentDateTime,
  openAcl, openAclFile, detectAclFormat,
  exportCSV, exportGameCSV,
  collectUniqueValues, collectRunwayPairs, extractV4RunwayPairs, mergeAudioCallsigns,
  getFileInfo, loadAudioCallsigns,
  parseAirlineCountryRegistry, loadAirlineCountryRegistry,
  sortFlightsChronologically,
  scanGameRoot, findGameRoot,
  extractSpecificationDB, extractApproachData, extractState5Data, extractTypeMap,
  buildAppPointMap, buildState5ParamsMap, buildFlyFractionMap,
  resolveFlyApproachPoints,
  computeProgressRatio, computePosition, computeDirection,
  buildFullPath, computePathLength, computeApproachCap,
  buildApproachAircraftBlock, buildState5AircraftBlock,
  buildDesignatorMapping, jetwayKeyStandCandidates, buildApproachCache, buildStarPaths,
  extractStarRunwayMappings,
  serializeApproachCache, deserializeApproachCache,
  extractGameTime,
  _rebuildTimelineSections, _generateFramesSection, _generateRunwayTimelineSection,
  _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline,
  _extractConfig,
  createZip, listZipFiles, extractZip, readZipEntries,
  // New object-based parser
  createTokenizer, preprocessUnityJson, serializeUnityJson, isUnityJson,
  parseOdinValue, parseOdinObject, parseOdinArray,
  AclDocument,
  // Taxiway + SID / Missed Approach parsers
  parseTaxiwayPaths,
  extractSidRunwayMappings, extractMissedApproachMappings,
  buildSidPaths, buildMissedApproachPaths,
  extractApprRunwayMappings, buildApprPaths,
  // Format-aware demo window + v3 audio metadata loaders
  isDemoVisibleFile,
  shouldTrimDemoSchedule,
  shouldApplyLegacyDemoEndTimeOverride,
  filterFlightsToConfigWindow,
  loadLevelForEditor,
  clearV3AudioCache,
  loadV3VoiceCatalog,
  loadV3ClipIndex,
  loadV3ChannelConfig,
  lookupV3Callsigns,
  lookupV3CallsignsForAirport,
  loadV3AirportAudio,
  peekAclFormat,
  hasV2AudioClips,
  hasV3AudioAssets,
  resolveAirportAudioMode,
  computeAudioSourceSignature,
  // Internal exports (used by tests)
  _parseSceneryData, _parseStandPositions, _parseAreas,
  _parseRunwayThresholds,
  _parseWorldStateFlightPlans, _parseFlightPlanEntry,
  _rebuildStaticDataSections,
  _validateStandConflicts,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
};
