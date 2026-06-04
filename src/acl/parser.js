/**
 * ACL File Parser — public API entry point (barrel module).
 * Delegates to focused sub-modules for parsing, syncing, and utility operations.
 */
const fs = require('fs');
const path = require('path');

// ─── External modules ────────────────────────────────────────
const {
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
} = require('../constants');
const { importCsvFromFile, exportCSV, exportGameCSV, collectUniqueValuesFromCSV } = require('../utils/csvIo');

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
const { captureAllDynamicsTemplates } = require('./dynamics');
const {
  _rebuildTimelineSections, _generateFramesSection, _generateRunwayTimelineSection,
  _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline,
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

  // Locate CSV path for reference only (not read)
  let csvPath = null;
  const dir = path.dirname(aclPath);
  const base = path.basename(aclPath, '.acl');
  const cfgPath = path.join(dir, base + '.aclcfg');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.flightScheduleFile) {
        const candidate = path.join(dir, cfg.flightScheduleFile + '.csv');
        if (fs.existsSync(candidate)) csvPath = candidate;
      }
    } catch (_) {}
  }

  return {
    flights, sceneryMaps, csvPath,
    before: '', after: '', arrayContent: '', originalBlocks: [],
    worldStateData, _fromWorldState, _fromFlightPlans,
    _rawText,
  };
}

// ─── Generate full ACL from scratch ──────────────────────────

function generateFullAcl(aclPath, flights, _before, _after, _originalBlocks, _worldStateData, _sceneryMaps, _fromWorldState, _fromFlightPlans, dynamicsTemplates, aclcfgStartTime) {
  _rebuildWorldStateSections(aclPath, flights, undefined, dynamicsTemplates, aclcfgStartTime);
}

// ─── Generate ACL from CSV (uses template) ────────────────────

function generateAclFromCsv(csvPath, aclPath, _templatePath) {
  const flights = importCsvFromFile(csvPath);
  if (flights.length === 0) throw new Error('CSV 中没有有效的航班数据');

  generateFullAcl(aclPath, flights, '', '', [], null, null, false, false);
}

// ─── Public API ───────────────────────────────────────────────

module.exports = {
  // Public API
  loadFlights, generateFullAcl,
  exportCSV, exportGameCSV, importCsvFromFile,
  generateAclFromCsv, collectUniqueValuesFromCSV,
  collectUniqueValues, mergeAudioCallsigns,
  getFileInfo, loadAudioCallsigns,
  sortFlightsChronologically,
  scanGameRoot,
  captureAllDynamicsTemplates,
  _rebuildTimelineSections, _generateFramesSection, _generateRunwayTimelineSection,
  _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline,
  createZip, listZipFiles, extractZip,
  // Internal exports (used by tests)
  _parseWorldStateData, _parseSceneryData,
  _extractFlightsFromWorldState,
  _parseWorldStateFlightPlans, _parseFlightPlanEntry,
  _rebuildWorldStateSections,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
};
