/**
 * ACL File Parser (Node.js)
 * Handles Newtonsoft.Json serialization with $type + $rcontent.
 * Parses FlightSchedule.$rcontent entries, preserving all other data untouched.
 */

const fs = require('fs');
const path = require('path');

// .NET DateTime epoch: 1/1/0001 00:00:00 UTC
// JavaScript epoch: 1/1/1970
// Difference: 621355968000000000 ticks
const NET_EPOCH_OFFSET = 621355968000000000n;
const TICKS_PER_SECOND = 10000000n;

function ticksToTime(ticks) {
  if (ticks === 0 || ticks === '0' || ticks === 0n) return '';
  const ticksBig = BigInt(ticks);
  // .NET ticks to JS milliseconds: (ticks - offset) / 10000
  const ms = Number((ticksBig - NET_EPOCH_OFFSET) / 10000n);
  const d = new Date(ms);
  return d.toISOString().substring(11, 19); // HH:MM:SS
}

function timeToTicks(timeStr) {
  if (!timeStr || !timeStr.trim()) return 0;
  try {
    const parts = timeStr.trim().split(':').map(Number);
    if (parts.length !== 3) return 0;
    const totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    return totalSeconds * Number(TICKS_PER_SECOND);
  } catch {
    return 0;
  }
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
  CallSign: '呼号',
  DepartureAirport: '出发',
  ArrivalAirport: '到达',
  Stand: '停机位',
  Runway: '跑道',
  OffBlockTime: '推出',
  TakeoffTime: '起飞',
  LandingTime: '落地',
  InBlockTime: '入位',
  AirlineName: '航司',
  AircraftType: '机型',
  Voice: '语音',
  Language: '语言',
};

function loadFlights(aclPath) {
  const text = fs.readFileSync(aclPath, 'utf-8');

  // Find "FlightSchedule" key
  const fsMatch = text.match(/"FlightSchedule"\s*:\s*\{/);
  if (!fsMatch) throw new Error('FlightSchedule not found in .acl file');

  // Find $rcontent array AFTER "FlightSchedule"
  const afterFS = text.substring(fsMatch.index);
  const rcMatch = afterFS.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) throw new Error('$rcontent not found in FlightSchedule');

  const pos = fsMatch.index + rcMatch.index + rcMatch[0].length;

  // Find matching ']' by tracking nested {} depth
  let depth = 0;
  let endPos = null;
  for (let i = pos; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
        if (j < text.length && text[j] === ']') {
          endPos = i + 1;
          break;
        }
      }
    } else if (c === ']' && depth === 0) {
      endPos = i;
      break;
    }
  }

  if (endPos === null) throw new Error('Could not find end of $rcontent array');

  const before = text.substring(0, pos);
  const after = text.substring(endPos);
  const arrayContent = text.substring(pos, endPos);

  // Parse each FlightPlanState entry
  const flights = [];
  const originalBlocks = [];
  depth = 0;
  let entryStart = -1;

  for (let i = 0; i < arrayContent.length; i++) {
    const ch = arrayContent[i];
    if (ch === '{') {
      if (depth === 0) entryStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && entryStart >= 0) {
        const block = arrayContent.substring(entryStart, i + 1);
        originalBlocks.push(block);
        const flight = parseFlightBlock(block);
        if (flight) flights.push(flight);
        entryStart = -1;
      }
    }
  }

  return { flights, before, after, arrayContent, originalBlocks };
}

function parseFlightBlock(block) {
  const flight = {};

  for (const [fieldName, fieldType] of FIELDS) {
    if (fieldType === 'string') {
      const m = block.match(new RegExp(`"${fieldName}"\\s*:\\s*"([^"]*)"`));
      flight[fieldName] = m ? m[1] : '';
    } else if (fieldType === 'time') {
      const m = block.match(new RegExp(`"${fieldName}"\\s*:\\s*\\{\\s*"\\$type"\\s*:\\s*3\\s*,\\s*(-?\\d+)\\s*\\}`));
      flight[fieldName] = m ? ticksToTime(m[1]) : '';
    }
  }

  return flight;
}

function saveFlights(aclPath, flights, before, after, arrayContent, originalBlocks) {
  const newBlocks = [];

  for (let i = 0; i < flights.length; i++) {
    if (i < originalBlocks.length) {
      newBlocks.push(applyChanges(originalBlocks[i], flights[i]));
    } else {
      const template = originalBlocks.length > 0 ? originalBlocks[originalBlocks.length - 1] : null;
      newBlocks.push(buildNewBlock(flights[i], template));
    }
  }

  const newArray = newBlocks.join(',\n            ');
  const newText = before + newArray + after;

  fs.writeFileSync(aclPath, newText, 'utf-8');
}

function applyChanges(block, flight) {
  for (const [fieldName, fieldType] of FIELDS) {
    if (fieldType === 'string') {
      const val = flight[fieldName] || '';
      const m = block.match(new RegExp(`("${fieldName}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`));
      if (m) {
        if (val) {
          block = block.substring(0, m.index) + m[1] + '"' + val + '"' + block.substring(m.index + m[0].length);
        } else {
          block = block.substring(0, m.index) + m[1] + 'null' + block.substring(m.index + m[0].length);
        }
      } else {
        // Try replacing null
        const mNull = block.match(new RegExp(`("${fieldName}"\\s*:\\s*)null`));
        if (mNull && val) {
          block = block.substring(0, mNull.index) + mNull[1] + '"' + val + '"' + block.substring(mNull.index + mNull[0].length);
        }
      }
    } else if (fieldType === 'time') {
      const timeStr = flight[fieldName] || '';
      const ticks = timeToTicks(timeStr);
      const m = block.match(new RegExp(`("${fieldName}"\\s*:\\s*\\{\\s*"\\$type"\\s*:\\s*3\\s*,\\s*)(-?\\d+)(\\s*\\})`));
      if (m) {
        const start = m.index + m[1].length;
        const end = start + m[2].length;
        block = block.substring(0, start) + String(ticks) + block.substring(end);
      }
    }
  }
  return block;
}

function buildNewBlock(flight, templateBlock) {
  if (templateBlock) {
    let block = templateBlock;
    const newId = Math.floor(Math.random() * 10000) + 90000;
    block = block.replace(/"\$id"\s*:\s*\d+/, `"$id": ${newId}`);
    return applyChanges(block, flight);
  }

  // Fallback
  const lines = ['{'];
  lines.push('                "$id": 90000,');
  lines.push('                "$type": 34,');
  for (const [fieldName, fieldType] of FIELDS) {
    if (fieldType === 'string') {
      const val = flight[fieldName] || '';
      lines.push(val ? `                "${fieldName}": "${val}",` : `                "${fieldName}": null,`);
    } else if (fieldType === 'time') {
      const ticks = timeToTicks(flight[fieldName] || '');
      lines.push(`                "${fieldName}": {`);
      lines.push('                    "$type": 3,');
      lines.push(`                    ${ticks}`);
      lines.push('                },');
    }
  }
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  lines.push('            }');
  return lines.join('\n');
}

function exportCSV(flights, csvPath) {
  const headers = [
    'callSign', 'departure', 'arrival', 'stand', 'runway',
    'offBlockTime', 'takeOffTime', 'landingTime', 'inBlockTime',
    'airline', 'aircraftType', 'voice', 'language'
  ];
  const rows = [headers.join(',')];

  for (const fl of flights) {
    const row = [
      fl.CallSign || '',
      fl.DepartureAirport || '',
      fl.ArrivalAirport || '',
      fl.Stand || '',
      fl.Runway || '',
      fl.OffBlockTime || '',
      fl.TakeoffTime || '',
      fl.LandingTime || '',
      fl.InBlockTime || '',
      fl.AirlineName || '',
      fl.AircraftType || '',
      fl.Voice || '',
      fl.Language || '',
    ];
    rows.push(row.join(','));
  }

  fs.writeFileSync(csvPath, rows.join('\n'), 'utf-8');
}

function importCSV(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];

  const header = lines[0].toLowerCase().split(',').map(h => h.trim());
  const colMap = {};
  header.forEach((col, i) => { colMap[col] = i; });

  const fieldMap = {
    callsign: 'CallSign',
    departure: 'DepartureAirport',
    arrival: 'ArrivalAirport',
    stand: 'Stand',
    runway: 'Runway',
    offblocktime: 'OffBlockTime',
    takeofftime: 'TakeoffTime',
    landingtime: 'LandingTime',
    inblocktime: 'InBlockTime',
    airline: 'AirlineName',
    aircrafttype: 'AircraftType',
    voice: 'Voice',
    language: 'Language',
    pushbacktime: 'OffBlockTime',
    departuretime: 'TakeoffTime',
    arrivaltime: 'InBlockTime',
  };

  const flights = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim());
    const flight = {};
    for (const [col, idx] of Object.entries(colMap)) {
      const mapped = fieldMap[col];
      if (mapped && idx < parts.length) {
        flight[mapped] = parts[idx];
      }
    }
    for (const [fn] of FIELDS) {
      if (!(fn in flight)) flight[fn] = '';
    }
    if (flight.CallSign) flights.push(flight);
  }
  return flights;
}

function countStats(flights) {
  let arrivals = 0, departures = 0;
  for (const fl of flights) {
    if ((fl.LandingTime || '').trim()) arrivals++;
    if ((fl.OffBlockTime || '').trim()) departures++;
  }
  return { arrivals, departures };
}

module.exports = {
  loadFlights, saveFlights, exportCSV, importCSV, countStats,
  FIELDS, FIELD_LABELS
};
