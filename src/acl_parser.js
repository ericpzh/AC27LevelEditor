/**
 * ACL File Parser — public API entry point (barrel module).
 * Delegates to focused sub-modules for parsing, syncing, and utility operations.
 */
const fs = require('fs');
const path = require('path');

// ─── External modules ────────────────────────────────────────
const {
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
  FALLBACK_BASE_DATE_TICKS,
} = require('./constants');
const { timeToTicks, _extractBaseDateTicks } = require('./time_utils');
const { importCsvFromFile, exportCSV, exportGameCSV, collectUniqueValuesFromCSV } = require('./csv_io');

// ─── Internal sub-modules ────────────────────────────────────
const { _parseSceneryData } = require('./acl_scenery');
const {
  _parseFlightSchedule, _parseFlightBlock,
  _applyChanges, _buildNewBlock,
  _rebuildBlocks, _updateRlength,
} = require('./acl_flights_schedule');
const {
  _generateGuid,
  _parseWorldStateData, _extractFlightsFromWorldState,
  _syncWorldState, _applyWsChanges,
  _applyAircraftStateChanges, _applyWsField,
} = require('./acl_world_state');
const {
  _parseWorldStateFlightPlans, _parseFlightPlanEntry,
  _syncFlightPlans, _applyFlightPlanChanges,
  _buildFlightPlanBlock, _buildFlightPlanStateEntry,
  _buildFlightPlanArrivalLeg, _buildFlightPlanDepartureLeg,
  _rebuildWorldStateSections,
} = require('./acl_flight_plans');
const {
  _enrichFlightsFromSource, sortFlightsChronologically,
  collectUniqueValues, getFileInfo,
  loadAudioCallsigns, mergeAudioCallsigns,
} = require('./acl_utils');

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
  let before = '', after = '', arrayContent = '', originalBlocks = [];
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
      log('Found FlightPlans format (type 37)');
      worldStateData = fpResult.fpData;
      _fromFlightPlans = true;
      _enrichFlightsFromSource(flights, fpResult.flights);
    } else {
      const fsData = _parseFlightSchedule(text);
      if (fsData) {
        log('Found FlightSchedule format, entries=' + fsData.flights.length);
        before = fsData.before;
        after = fsData.after;
        arrayContent = fsData.arrayContent;
        originalBlocks = fsData.originalBlocks;
      }

      const wsData = _parseWorldStateData(text);
      if (wsData && wsData.wsEntries.length > 0) {
        log('Found WorldState Aircrafts, entries=' + wsData.wsEntries.length);
        worldStateData = wsData;
        if (!fsData) {
          _fromWorldState = true;
          const wsFlights = _extractFlightsFromWorldState(wsData, text, sceneryMaps);
          _enrichFlightsFromSource(flights, wsFlights);
        }
      }
    }
  } catch (_) {
    log('ACL structure parse FAILED (continuing with CSV-only): ' + _.message);
  }

  return {
    flights, sceneryMaps, csvPath,
    before, after, arrayContent, originalBlocks,
    worldStateData, _fromWorldState, _fromFlightPlans,
    _rawText,
  };
}

// ─── Save flights ─────────────────────────────────────────────

function saveFlights(aclPath, flights, before, after, arrayContent, originalBlocks, worldStateData, sceneryMaps, _fromWorldState, _fromFlightPlans) {
  if (_fromFlightPlans || _fromWorldState) {
    _rebuildWorldStateSections(aclPath, flights);
    return;
  }

  const baseDateTicks = _extractBaseDateTicks(originalBlocks);
  const newBlocks = _rebuildBlocks(flights, originalBlocks, baseDateTicks);
  const fixedBefore = _updateRlength(before, flights.length);
  let newText = fixedBefore + newBlocks.join(',\n            ') + after;

  if (worldStateData && worldStateData.wsEntries && worldStateData.wsEntries.length > 0) {
    const reParsedWs = _parseWorldStateData(newText);
    if (reParsedWs && reParsedWs.wsEntries.length > 0) {
      newText = _syncWorldState(newText, flights, reParsedWs, sceneryMaps, baseDateTicks);
    }
  }

  fs.writeFileSync(aclPath, newText, 'utf-8');
}

// ─── Generate full ACL from scratch ──────────────────────────

function generateFullAcl(aclPath, flights, headerBefore = '', footerAfter = '', originalBlocks = [], worldStateData = null, sceneryMaps = null, _fromWorldState = false, _fromFlightPlans = false, dynamicsTemplates = null, aclcfgStartTime = null) {
  if (_fromFlightPlans || _fromWorldState) {
    _rebuildWorldStateSections(aclPath, flights, undefined, dynamicsTemplates, aclcfgStartTime);
    return;
  }

  if (headerBefore && headerBefore.includes('"FlightSchedule"')) {
    const baseDateTicks = _extractBaseDateTicks(originalBlocks);
    const newBlocks = _rebuildBlocks(flights, originalBlocks, baseDateTicks);
    const fixedBefore = _updateRlength(headerBefore, flights.length);
    const fixedAfter = footerAfter || '\n        ]\n    }\n}';
    let newText = fixedBefore + newBlocks.join(',\n            ') + fixedAfter;

    if (worldStateData && worldStateData.wsEntries && worldStateData.wsEntries.length > 0) {
      const reParsedWs = _parseWorldStateData(newText);
      if (reParsedWs && reParsedWs.wsEntries.length > 0) {
        newText = _syncWorldState(newText, flights, reParsedWs, sceneryMaps, baseDateTicks);
      }
    }

    fs.writeFileSync(aclPath, newText, 'utf-8');
    return;
  }

  const baseDateTicks = FALLBACK_BASE_DATE_TICKS;

  const HEADER = `{
    "$id": 1,
    "$type": "0|ContextCross.Saves.Level, GroundATC.Core",
    "Guid": "${_generateGuid()}",
    "Config": {
        "$type": "1|ContextCross.Saves.LevelConfig, GroundATC.Core",
        "prototypeName": "",
        "geoDataFile": "geo_data",
        "visualGeoDataFile": "visual_data",
        "radioTemplateFileZH": "radio_template_zh",
        "radioTemplateFileEN": "radio_template_en",
        "channelFile": "radio_channel_config",
        "airportConfigFile": "airport_config",
        "refPoint": {
            "$type": "2|UnityEngine.Vector2, UnityEngine.CoreModule",
            40.64202,
            -73.7856
        },
        "offset": {
            "$type": 2,
            0,
            0
        },
        "scaleFactor": 0.01,
        "offsetDistance": 0.0
    },
    "AirportEquipment": {
        "$type": "32|ContextCross.States.BaseObjectState[], GroundATC.Core",
        "$rlength": 0,
        "$rcontent": []
    },
    "FlightSchedule": {
        "$id": 9379,
        "$type": "33|ContextCross.States.FlightPlanState[], GroundATC.Core",
        "$rlength": ${flights.length},
        "$rcontent": [`;

  const FOOTER = `\n        ]\n    }\n}`;

  const blocks = flights.map((fl, i) => {
    const lines = [];
    lines.push('            {');
    lines.push(`                "$id": ${9380 + i},`);
    lines.push('                "$type": "34|ContextCross.States.FlightPlanState, GroundATC.Core",');
    for (const [fn, ft] of FIELDS) {
      if (ft === 'string') {
        const val = fl[fn] || '';
        lines.push(val ? `                "${fn}": "${val}",` : `                "${fn}": null,`);
      } else if (ft === 'time') {
        const ticks = timeToTicks(fl[fn] || '', baseDateTicks);
        lines.push(`                "${fn}": { "$type": 3, ${ticks} },`);
      }
    }
    if (!fl.PrecedingFlight) lines.push('                "PrecedingFlight": null,');
    const lastIdx = lines.length - 1;
    lines[lastIdx] = lines[lastIdx].replace(/,$/, '');
    lines.push('            }');
    return lines.join('\n');
  });

  const fullText = HEADER + '\n' + blocks.join(',\n') + FOOTER;
  fs.writeFileSync(aclPath, fullText, 'utf-8');
}

// ─── Generate ACL from CSV (uses template) ────────────────────

function generateAclFromCsv(csvPath, aclPath, templatePath) {
  const flights = importCsvFromFile(csvPath);
  if (flights.length === 0) throw new Error('CSV 中没有有效的航班数据');

  let headerBefore = '', footerAfter = '', origBlocks = [];

  if (templatePath && fs.existsSync(templatePath)) {
    const text = fs.readFileSync(templatePath, 'utf-8');
    const data = _parseFlightSchedule(text);
    if (data) {
      headerBefore = data.before;
      footerAfter = data.after;
      origBlocks = data.originalBlocks;
    }
  }

  generateFullAcl(aclPath, flights, headerBefore, footerAfter, origBlocks);
}

// ─── Public API ───────────────────────────────────────────────

module.exports = {
  loadFlights, saveFlights, generateFullAcl,
  exportCSV, exportGameCSV, importCsvFromFile,
  generateAclFromCsv, collectUniqueValuesFromCSV,
  collectUniqueValues, mergeAudioCallsigns,
  getFileInfo, loadAudioCallsigns,
  sortFlightsChronologically,
  // Internal exports (used by tests / csv_io)
  _parseFlightSchedule, _parseWorldStateData, _parseSceneryData,
  _extractFlightsFromWorldState,
  _parseWorldStateFlightPlans, _parseFlightPlanEntry,
  _syncFlightPlans,
  _rebuildWorldStateSections,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
};
