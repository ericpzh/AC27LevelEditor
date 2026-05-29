/**
 * ACL File Parser (Node.js) - enhanced
 * Handles Newtonsoft.Json serialization with $type + $rcontent.
 */
const fs = require('fs');
const path = require('path');

const NET_EPOCH_OFFSET = 621355968000000000n;
const TICKS_PER_SECOND = 10000000n;

function ticksToTime(ticks) {
  if (ticks === 0 || ticks === '0' || ticks === 0n) return '';
  const ticksBig = BigInt(ticks);
  const ms = Number((ticksBig - NET_EPOCH_OFFSET) / 10000n);
  const d = new Date(ms);
  return d.toISOString().substring(11, 19);
}

function timeToTicks(timeStr) {
  if (!timeStr || !timeStr.trim()) return 0;
  try {
    const parts = timeStr.trim().split(':').map(Number);
    if (parts.length !== 3) return 0;
    const totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    return totalSeconds * Number(TICKS_PER_SECOND);
  } catch { return 0; }
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
  ['Voice', 'string'],
  ['Language', 'string'],
];

const FIELD_LABELS = {
  CallSign: '呼号', DepartureAirport: '出发', ArrivalAirport: '到达',
  Stand: '停机位', Runway: '跑道', OffBlockTime: '推出', TakeoffTime: '起飞',
  LandingTime: '落地', InBlockTime: '入位', AirlineName: '航司',
  AircraftType: '机型', Voice: '语音', Language: '语言',
};

// Fields that get dropdown menus
const DROPDOWN_FIELDS = [
  'AircraftType', 'AirlineName', 'Voice', 'Language',
  'Stand', 'Runway', 'DepartureAirport', 'ArrivalAirport',
];

function loadFlights(aclPath) {
  const text = fs.readFileSync(aclPath, 'utf-8');
  const data = _parseFlightSchedule(text);
  if (!data) throw new Error('FlightSchedule not found in .acl file');
  return { flights: data.flights, before: data.before, after: data.after, arrayContent: data.arrayContent, originalBlocks: data.originalBlocks };
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
  return { flights, before, after, arrayContent, originalBlocks };
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
  const newBlocks = [];
  for (let i = 0; i < flights.length; i++) {
    if (i < originalBlocks.length) {
      newBlocks.push(_applyChanges(originalBlocks[i], flights[i]));
    } else {
      const template = originalBlocks.length > 0 ? originalBlocks[originalBlocks.length - 1] : null;
      newBlocks.push(_buildNewBlock(flights[i], template));
    }
  }
  const newArray = newBlocks.join(',\n            ');
  const newText = before + newArray + after;
  fs.writeFileSync(aclPath, newText, 'utf-8');
}

function _applyChanges(block, flight) {
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
      const ticks = timeToTicks(flight[fn] || '');
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

function _buildNewBlock(flight, templateBlock) {
  if (templateBlock) {
    let block = templateBlock;
    const newId = Math.floor(Math.random() * 10000) + 90000;
    block = block.replace(/"\$id"\s*:\s*\d+/, `"$id": ${newId}`);
    return _applyChanges(block, flight);
  }
  const lines = ['{'];
  lines.push('                "$id": 90000,');
  lines.push('                "$type": 34,');
  for (const [fn, ft] of FIELDS) {
    if (ft === 'string') {
      const val = flight[fn] || '';
      lines.push(val ? `                "${fn}": "${val}",` : `                "${fn}": null,`);
    } else if (ft === 'time') {
      const ticks = timeToTicks(flight[fn] || '');
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

  for (const aclPath of aclPaths) {
    const text = fs.readFileSync(aclPath, 'utf-8');
    // Only scan the FlightSchedule section
    const data = _parseFlightSchedule(text);
    if (!data) continue;
    for (const fl of data.flights) {
      for (const field of DROPDOWN_FIELDS) {
        if (fl[field] && fl[field].trim()) values[field].add(fl[field].trim());
      }
    }
  }
  const result = {};
  for (const [key, set] of Object.entries(values)) {
    result[key] = [...set].sort((a, b) => a.localeCompare(b));
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

function exportCSV(flights, csvPath) {
  const headers = 'callSign,departure,arrival,stand,runway,offBlockTime,takeOffTime,landingTime,inBlockTime,airline,aircraftType,voice,language';
  const rows = [headers];
  for (const fl of flights) {
    rows.push([
      fl.CallSign || '', fl.DepartureAirport || '', fl.ArrivalAirport || '',
      fl.Stand || '', fl.Runway || '', fl.OffBlockTime || '', fl.TakeoffTime || '',
      fl.LandingTime || '', fl.InBlockTime || '', fl.AirlineName || '',
      fl.AircraftType || '', fl.Voice || '', fl.Language || ''
    ].join(','));
  }
  fs.writeFileSync(csvPath, rows.join('\n'), 'utf-8');
}

module.exports = {
  loadFlights, saveFlights, exportCSV, collectUniqueValues, getFileInfo,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS
};
