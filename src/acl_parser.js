/**
 * ACL File Parser — public API entry point (barrel module).
 * Delegates to focused sub-modules for parsing, syncing, and utility operations.
 */
const fs = require('fs');
const path = require('path');

// ─── External modules ────────────────────────────────────────
const {
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
} = require('./constants');
const { importCsvFromFile, exportCSV, exportGameCSV, collectUniqueValuesFromCSV } = require('./csv_io');

// ─── Internal sub-modules ────────────────────────────────────
const { _parseSceneryData } = require('./acl_scenery');
const {
  _parseWorldStateData, _extractFlightsFromWorldState,
} = require('./acl_world_state');
const {
  _parseWorldStateFlightPlans, _parseFlightPlanEntry,
  _rebuildWorldStateSections,
} = require('./acl_flight_plans');
const {
  _enrichFlightsFromSource, sortFlightsChronologically,
  collectUniqueValues, getFileInfo,
  loadAudioCallsigns, mergeAudioCallsigns,
} = require('./acl_utils');
const { scanGameRoot } = require('./acl_scanner');
const { captureAllDynamicsTemplates } = require('./acl_dynamics');
const {
  _rebuildTimelineSections, _generateFramesSection, _generateRunwayTimelineSection,
} = require('./acl_flight_plans');
const { createZip, listZipFiles, extractZip } = require('./zip_utils');

// ─── Load flights ─────────────────────────────────────────────

function loadFlights(aclPath) {
  const log = (msg) => console.log('[ACL-LOAD]', path.basename(aclPath), '|', msg);
  log('loadFlights() START');

  const dir = path.dirname(aclPath);
  const base = path.basename(aclPath, '.acl');
  const cfgPath = path.join(dir, base + '.aclcfg');

  let csvPath = null;
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.flightScheduleFile) {
        const candidate = path.join(dir, cfg.flightScheduleFile + '.csv');
        if (fs.existsSync(candidate)) { csvPath = candidate; log('CSV found via aclcfg'); }
      }
    } catch (_) {}
  }

  if (!csvPath) {
    const tm = base.match(/_(\d{2}-\d{2})$/);
    if (tm) {
      const candidate = path.join(dir, 'flight_schedule_' + tm[1] + '.csv');
      if (fs.existsSync(candidate)) { csvPath = candidate; log('CSV found by suffix fallback'); }
    }
  }

  if (!csvPath) throw new Error('No flight schedule CSV found. Expected .aclcfg with flightScheduleFile, or flight_schedule_HH-HH.csv next to .acl.');

  const flights = importCsvFromFile(csvPath);
  log('CSV parsed: ' + flights.length + ' flights');
  if (flights.length === 0) throw new Error('CSV contains no valid flight data');

  let sceneryMaps = { runwayNameToGuid:{}, standIdToGuid:{}, runwayGuidToName:{}, standGuidToId:{} };
  let worldStateData = null;
  let _fromWorldState = false;
  let _fromFlightPlans = false;
  let _rawText = '';

  try {
    const text = fs.readFileSync(aclPath, 'utf-8');
    _rawText = text;
    sceneryMaps = _parseSceneryData(text);

    const fpResult = _parseWorldStateFlightPlans(text);
    if (fpResult && fpResult.flights && fpResult.flights.length > 0 && fpResult.fpData) {
      log('Found FlightPlans format');
      worldStateData = fpResult.fpData;
      _fromFlightPlans = true;
      _enrichFlightsFromSource(flights, fpResult.flights);
    } else {
      const wsData = _parseWorldStateData(text);
      if (wsData && wsData.wsEntries.length > 0) {
        log('Found WorldState Aircrafts, entries=' + wsData.wsEntries.length);
        worldStateData = wsData;
        _fromWorldState = true;
        const wsFlights = _extractFlightsFromWorldState(wsData, text, sceneryMaps);
        _enrichFlightsFromSource(flights, wsFlights);
      }
    }
  } catch (_) {
    log('ACL structure parse FAILED (continuing with CSV-only): ' + _.message);
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
  createZip, listZipFiles, extractZip,
  // Internal exports (used by tests)
  _parseWorldStateData, _parseSceneryData,
  _extractFlightsFromWorldState,
  _parseWorldStateFlightPlans, _parseFlightPlanEntry,
  _rebuildWorldStateSections,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
};
