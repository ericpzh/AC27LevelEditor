/**
 * ACL File Parser (Node.js) - enhanced
 * Handles Newtonsoft.Json serialization with $type + $rcontent.
 */
const fs = require('fs');
const path = require('path');

const NET_EPOCH_OFFSET = 621355968000000000n;
const TICKS_PER_SECOND = 10000000n;
const TICKS_PER_DAY = 86400n * TICKS_PER_SECOND; // 864000000000n

function ticksToTime(ticks) {
  if (ticks === 0 || ticks === '0' || ticks === 0n) return '';
  const ticksBig = BigInt(ticks);
  const ms = Number((ticksBig - NET_EPOCH_OFFSET) / 10000n);
  const d = new Date(ms);
  return d.toISOString().substring(11, 19);
}

function timeToTicks(timeStr, baseDateTicks) {
  if (!timeStr || !timeStr.trim()) return 0;
  try {
    const parts = timeStr.trim().split(':').map(Number);
    if (parts.length !== 3) return 0;
    const totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    const timeOfDayTicks = totalSeconds * Number(TICKS_PER_SECOND);
    return baseDateTicks ? baseDateTicks + timeOfDayTicks : timeOfDayTicks;
  } catch { return 0; }
}

/**
 * Extract the "midnight" ticks (base date) from the first absolute timestamp found
 * in the original ACL flight blocks. This preserves the date portion so timeOfDay
 * from CSV can be recombined into a full absolute DateTime.
 */
function _extractBaseDateTicks(originalBlocks) {
  for (const block of originalBlocks) {
    for (const [fn, ft] of FIELDS) {
      if (ft === 'time') {
        const m = block.match(new RegExp(`"${fn}"\\s*:\\s*\\{\\s*"\\$type"\\s*:\\s*(\\d+)\\s*,\\s*(-?\\d+)\\s*\\}`));
        if (m) {
          const absTicks = BigInt(m[2]);
          if (absTicks > TICKS_PER_DAY) {
            return Number((absTicks / TICKS_PER_DAY) * TICKS_PER_DAY);
          }
        }
      }
    }
  }
  // Fallback: use the known game-wide base date (630822816000000000 = ~2000-01-01)
  // This is needed when the backup file has been regenerated and lost the absolute ticks
  return 630822816000000000;
}

const FIELDS = [
  ['CallSign', 'string'],
  ['DepartureAirport', 'string'],
  ['ArrivalAirport', 'string'],
  ['Stand', 'string'],
  ['Runway', 'string'],
  ['OffBlockTime', 'time'],
  ['TakeoffTime', 'time'],
  ['LandingTime', 'time'],
  ['InBlockTime', 'time'],
  ['AirlineName', 'string'],
  ['AircraftType', 'string'],
  ['Airway', 'string'],
  ['Voice', 'string'],
  ['Language', 'string'],
];

const FIELD_LABELS = {
  CallSign: '呼号', DepartureAirport: '出发', ArrivalAirport: '到达',
  Stand: '停机位', Runway: '跑道', OffBlockTime: '推出', TakeoffTime: '起飞',
  LandingTime: '落地', InBlockTime: '入位', AirlineName: '航司',
  AircraftType: '机型', Airway: '航路',
  Voice: '语音', Language: '语言',
};

// Fields that get dropdown menus
const DROPDOWN_FIELDS = [
  'AircraftType', 'AirlineCode',
  'Stand', 'Runway', 'DepartureAirport', 'ArrivalAirport',
];

function loadFlights(aclPath) {
  const text = fs.readFileSync(aclPath, 'utf-8');
  const data = _parseFlightSchedule(text);
  if (!data) throw new Error('FlightSchedule not found in .acl file');
  return { flights: data.flights, before: data.before, after: data.after, arrayContent: data.arrayContent, originalBlocks: data.originalBlocks, originalLength: data.originalLength };
}

function _parseFlightSchedule(text) {
  const fsMatch = text.match(/"FlightSchedule"\s*:\s*\{/);
  if (!fsMatch) return null;
  const afterFS = text.substring(fsMatch.index);
  const rcMatch = afterFS.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return null;

  const pos = fsMatch.index + rcMatch.index + rcMatch[0].length;
  let depth = 0, endPos = null;
  for (let i = pos; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
        if (j < text.length && text[j] === ']') { endPos = i + 1; break; }
      }
    } else if (c === ']' && depth === 0) { endPos = i; break; }
  }
  if (endPos === null) return null;

  // Extract $rlength from the before section
  const beforeRaw = text.substring(0, pos);
  const rlMatch = beforeRaw.match(/"\$rlength"\s*:\s*(\d+)/);
  const originalLength = rlMatch ? parseInt(rlMatch[1], 10) : 0;

  const before = text.substring(0, pos);
  const after = text.substring(endPos);
  const arrayContent = text.substring(pos, endPos);
  const flights = [], originalBlocks = [];
  depth = 0; let entryStart = -1;
  for (let i = 0; i < arrayContent.length; i++) {
    const ch = arrayContent[i];
    if (ch === '{') { if (depth === 0) entryStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && entryStart >= 0) {
        const block = arrayContent.substring(entryStart, i + 1);
        originalBlocks.push(block);
        const flight = _parseFlightBlock(block);
        if (flight) flights.push(flight);
        entryStart = -1;
      }
    }
  }
  return { flights, before, after, arrayContent, originalBlocks, originalLength };
}

function _updateRlength(text, newCount) {
  // Only update $rlength within the FlightSchedule section, not the first one in file
  const fsIdx = text.indexOf('"FlightSchedule"');
  if (fsIdx >= 0) {
    const beforeFS = text.substring(0, fsIdx);
    const afterFS = text.substring(fsIdx);
    const updated = afterFS.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${newCount}`);
    return beforeFS + updated;
  }
  return text.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${newCount}`);
}

function _parseFlightBlock(block) {
  const flight = {};
  for (const [fn, ft] of FIELDS) {
    if (ft === 'string') {
      const m = block.match(new RegExp(`"${fn}"\\s*:\\s*"([^"]*)"`));
      flight[fn] = m ? m[1] : '';
    } else if (ft === 'time') {
      const m = block.match(new RegExp(`"${fn}"\\s*:\\s*\\{\\s*"\\$type"\\s*:\\s*(\\d+)\\s*,\\s*(-?\\d+)\\s*\\}`));
      flight[fn] = m ? ticksToTime(m[2]) : '';
    }
  }
  return flight;
}

function saveFlights(aclPath, flights, before, after, arrayContent, originalBlocks) {
  const baseDateTicks = _extractBaseDateTicks(originalBlocks);
  const newBlocks = [];
  for (let i = 0; i < flights.length; i++) {
    if (i < originalBlocks.length) {
      newBlocks.push(_applyChanges(originalBlocks[i], flights[i], baseDateTicks));
    } else {
      const template = originalBlocks.length > 0 ? originalBlocks[originalBlocks.length - 1] : null;
      newBlocks.push(_buildNewBlock(flights[i], template, baseDateTicks));
    }
  }
  // Update $rlength in before to match actual flight count
  const fixedBefore = _updateRlength(before, flights.length);
  const newArray = newBlocks.join(',\n            ');
  const newText = fixedBefore + newArray + after;
  fs.writeFileSync(aclPath, newText, 'utf-8');
}

function _applyChanges(block, flight, baseDateTicks) {
  for (const [fn, ft] of FIELDS) {
    if (ft === 'string') {
      const val = flight[fn] || '';
      const m = block.match(new RegExp(`("${fn}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`));
      if (m) {
        block = block.substring(0, m.index) + m[1] + '"' + val + '"' + block.substring(m.index + m[0].length);
      } else {
        const mNull = block.match(new RegExp(`("${fn}"\\s*:\\s*)null`));
        if (mNull && val) {
          block = block.substring(0, mNull.index) + mNull[1] + '"' + val + '"' + block.substring(mNull.index + mNull[0].length);
        }
      }
    } else if (ft === 'time') {
      const ticks = timeToTicks(flight[fn] || '', baseDateTicks);
      const m = block.match(new RegExp(`("${fn}"\\s*:\\s*\\{\\s*"\\$type"\\s*:\\s*\\d+\\s*,\\s*)(-?\\d+)(\\s*\\})`));
      if (m) {
        const start = m.index + m[1].length;
        const end = start + m[2].length;
        block = block.substring(0, start) + String(ticks) + block.substring(end);
      }
    }
  }
  return block;
}

function _buildNewBlock(flight, templateBlock, baseDateTicks) {
  if (templateBlock) {
    let block = templateBlock;
    const newId = Math.floor(Math.random() * 10000) + 90000;
    block = block.replace(/"\$id"\s*:\s*\d+/, `"$id": ${newId}`);
    return _applyChanges(block, flight, baseDateTicks);
  }
  const lines = ['{'];
  lines.push('                "$id": 90000,');
  lines.push('                "$type": 34,');
  for (const [fn, ft] of FIELDS) {
    if (ft === 'string') {
      const val = flight[fn] || '';
      lines.push(val ? `                "${fn}": "${val}",` : `                "${fn}": null,`);
    } else if (ft === 'time') {
      const ticks = timeToTicks(flight[fn] || '', baseDateTicks);
      lines.push(`                "${fn}": { "$type": 3, ${ticks} },`);
    }
  }
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  lines.push('            }');
  return lines.join('\n');
}

// ─── Quick scan ──────────────────────────────────────────

/**
 * Lightweight scan: extract unique values for dropdown fields from one or more ACL files.
 * Uses regex over raw text — does NOT fully parse JSON.
 */
function collectUniqueValues(aclPaths) {
  const values = {};
  for (const field of DROPDOWN_FIELDS) values[field] = new Set();

  // Cross-reference: AirlineCode ↔ AircraftType
  const airlineAircraft = new Map(); // AirlineCode → Set<AircraftType>
  const aircraftAirline = new Map(); // AircraftType → Set<AirlineCode>

  for (const aclPath of aclPaths) {
    const text = fs.readFileSync(aclPath, 'utf-8');
    // Only scan the FlightSchedule section
    const data = _parseFlightSchedule(text);
    if (!data) continue;
    for (const fl of data.flights) {
      for (const field of DROPDOWN_FIELDS) {
        if (field === 'AirlineCode') {
          // AirlineCode is the first 3 chars of CallSign
          const code = (fl.CallSign || '').trim().substring(0, 3);
          if (code) values[field].add(code);
        } else if (fl[field] && fl[field].trim()) {
          values[field].add(fl[field].trim());
        }
      }
      // Build cross-reference from this flight's pairing
      const acCode = (fl.CallSign || '').trim().substring(0, 3);
      const acType = (fl.AircraftType || '').trim();
      if (acCode && acType) {
        if (!airlineAircraft.has(acCode)) airlineAircraft.set(acCode, new Set());
        airlineAircraft.get(acCode).add(acType);
        if (!aircraftAirline.has(acType)) aircraftAirline.set(acType, new Set());
        aircraftAirline.get(acType).add(acCode);
      }
    }
  }
  const result = {};
  for (const [key, set] of Object.entries(values)) {
    const arr = [...set];
    // If all values are numeric (e.g. parking stands like "1","2","10"), sort as numbers
    const allNumeric = arr.every(v => /^\d+(\.\d+)?$/.test(v));
    if (allNumeric) {
      arr.sort((a, b) => parseFloat(a) - parseFloat(b));
    } else {
      arr.sort((a, b) => a.localeCompare(b));
    }
    result[key] = arr;
  }
  // Store cross-reference mapping
  result._compat = { airlineToAircraft: {}, aircraftToAirline: {} };
  for (const [k, v] of airlineAircraft) {
    result._compat.airlineToAircraft[k] = [...v].sort();
  }
  for (const [k, v] of aircraftAirline) {
    result._compat.aircraftToAirline[k] = [...v].sort();
  }
  return result;
}

/**
 * Get basic info about an ACL file without deep parsing.
 */
function getFileInfo(aclPath) {
  try {
    const stat = fs.statSync(aclPath);
    const text = fs.readFileSync(aclPath, 'utf-8');
    const data = _parseFlightSchedule(text);
    if (!data) return { error: 'No FlightSchedule found', filename: path.basename(aclPath), size: stat.size };

    let arrivals = 0, departures = 0;
    for (const fl of data.flights) {
      if ((fl.LandingTime || '').trim()) arrivals++;
      else if ((fl.OffBlockTime || '').trim()) departures++;
    }
    return {
      filename: path.basename(aclPath),
      path: aclPath,
      size: stat.size,
      flightCount: data.flights.length,
      arrivals,
      departures,
    };
  } catch (err) {
    return { error: err.message, filename: path.basename(aclPath), size: 0 };
  }
}

/**
 * Generate a complete .acl file from scratch using flight data.
 * Preserves the original header from the loaded file if available,
 * otherwise creates a minimal valid structure.
 */
function generateFullAcl(aclPath, flights, headerBefore = '', footerAfter = '', originalBlocks = []) {
  // If we have a valid header (before), use it as base and just build the flight blocks
  if (headerBefore && headerBefore.includes('"FlightSchedule"')) {
    const baseDateTicks = _extractBaseDateTicks(originalBlocks);
    const newBlocks = [];
    for (let i = 0; i < flights.length; i++) {
      if (i < originalBlocks.length) {
        newBlocks.push(_applyChanges(originalBlocks[i], flights[i], baseDateTicks));
      } else {
        const template = originalBlocks.length > 0 ? originalBlocks[originalBlocks.length - 1] : null;
        newBlocks.push(_buildNewBlock(flights[i], template, baseDateTicks));
      }
    }
    const fixedBefore = _updateRlength(headerBefore, flights.length);
    // If footerAfter is empty, generate closing brackets
    const fixedAfter = footerAfter || '\n        ]\n    }\n}';
    const newArray = newBlocks.join(',\n            ');
    const newText = fixedBefore + newArray + fixedAfter;
    fs.writeFileSync(aclPath, newText, 'utf-8');
    return;
  }

  // No valid template → generate minimal ACL from scratch
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

  // Build flight blocks with sequential IDs starting from 9380
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
        const ticks = timeToTicks(fl[fn] || '');
        lines.push(`                "${fn}": { "$type": 3, ${ticks} },`);
      }
    }
    // Add missing required fields with defaults
    if (!fl.PrecedingFlight) lines.push('                "PrecedingFlight": null,');
    // Remove trailing comma on last line
    const lastIdx = lines.length - 1;
    lines[lastIdx] = lines[lastIdx].replace(/,$/, '');
    lines.push('            }');
    return lines.join('\n');
  });

  const fullText = HEADER + '\n' + blocks.join(',\n') + FOOTER;
  fs.writeFileSync(aclPath, fullText, 'utf-8');
}

function _generateGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function exportCSV(flights, csvPath) {
  const headers = 'callSign,departure,arrival,stand,runway,offBlockTime,takeOffTime,landingTime,inBlockTime,airline,aircraftType,airway,voice,language,precedingFlight';
  const rows = [headers];
  for (const fl of flights) {
    rows.push([
      fl.CallSign || '', fl.DepartureAirport || '', fl.ArrivalAirport || '',
      fl.Stand || '', fl.Runway || '', fl.OffBlockTime || '', fl.TakeoffTime || '',
      fl.LandingTime || '', fl.InBlockTime || '', fl.AirlineName || '',
      fl.AircraftType || '',
      fl.Airway || '', fl.Voice || '', fl.Language || '',
      fl.PrecedingFlight || ''
    ].join(','));
  }
  fs.writeFileSync(csvPath, rows.join('\n'), 'utf-8');
}

/**
 * Read CSV file and return flight objects.
 * CSV columns: callSign,departure,arrival,stand,runway,offBlockTime,takeOffTime,landingTime,inBlockTime,airline,aircraftType,airway,voice,language,precedingFlight
 */
function importCsvFromFile(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf-8').trim();
  const lines = text.split('\n');
  if (lines.length < 2) return []; // header only or empty

  // Parse header to determine column mapping
  const header = lines[0].trim().toLowerCase().split(',');
  const colMap = {};
  header.forEach((name, i) => { colMap[name.trim()] = i; });

  const flights = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 7) continue;

    const get = (name) => {
      const idx = colMap[name];
      return idx !== undefined && idx < cols.length ? (cols[idx] || '').trim() : '';
    };

    const f = {
      CallSign: get('callsign'),
      DepartureAirport: get('departure'),
      ArrivalAirport: get('arrival'),
      Stand: get('stand'),
      Runway: get('runway'),
      OffBlockTime: get('offblocktime'),
      TakeoffTime: get('takeofftime'),
      LandingTime: get('landingtime'),
      InBlockTime: get('inblocktime'),
      AirlineName: get('airline'),
      AircraftType: get('aircrafttype'),
      Airway: get('airway'),
      Voice: get('voice'),
      Language: get('language'),
      PrecedingFlight: get('precedingflight'),
    };
    flights.push(f);
  }
  return flights;
}

/**
 * Generate ACL from CSV file, preserving original header/footer from an existing ACL template.
 * If templatePaths are given, reads the first valid one for header/footer.
 */
function generateAclFromCsv(csvPath, aclPath, templatePath) {
  const flights = importCsvFromFile(csvPath);
  if (flights.length === 0) throw new Error('CSV 中没有有效的航班数据');

  let headerBefore = '', footerAfter = '', origBlocks = [];

  if (templatePath && fs.existsSync(templatePath)) {
    // Extract before/after from template ACL
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

module.exports = {
  loadFlights, saveFlights, generateFullAcl, exportCSV, importCsvFromFile, generateAclFromCsv,
  collectUniqueValues, getFileInfo, _parseFlightSchedule,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS
};
