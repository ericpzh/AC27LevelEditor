/**
 * ACL File Parser (Node.js) - enhanced
 * Handles Newtonsoft.Json serialization with $type + $rcontent.
 */
const fs = require('fs');
const path = require('path');

const NET_EPOCH_OFFSET = 621355968000000000n;
const TICKS_PER_SECOND = 10000000n;
const TICKS_PER_DAY = 86400n * TICKS_PER_SECOND; // 864000000000n

// Fallback base date ticks: ~2000-01-01 midnight UTC
// Used when no original file is available to extract the date portion from timestamps.
const FALLBACK_BASE_DATE_TICKS = 630822816000000000;

// ─── AircraftType → Designator mapping  ──────────────────
// Maps the long AircraftType names (from FlightSchedule/TaskFlightState) to
// ICAO aircraft designators (used in AircraftState.Specification.Designator).
const AIRCRAFT_DESIGNATOR_MAP = {
  'BOEING 737-800': 'B738',  'B737-800': 'B738',  'B738': 'B738',
  'BOEING 737-700': 'B737',  'B737-700': 'B737',  'B737': 'B737',
  'BOEING 737-900': 'B739',  'B737-900': 'B739',  'B739': 'B739',
  'BOEING 777-300ER': 'B77W', 'B777-300ER': 'B77W', 'B77W': 'B77W',
  'BOEING 777-200': 'B772',  'B777-200': 'B772',  'B772': 'B772',
  'BOEING 777-200LR': 'B77L', 'B777-200LR': 'B77L', 'B77L': 'B77L',
  'BOEING 787-8': 'B788',   'B787-8': 'B788',   'B788': 'B788',
  'BOEING 787-9': 'B789',   'B787-9': 'B789',   'B789': 'B789',
  'BOEING 787-10': 'B78X',  'B787-10': 'B78X',  'B78X': 'B78X',
  'BOEING 747-400': 'B744', 'B747-400': 'B744', 'B744': 'B744',
  'BOEING 757-200': 'B752', 'B757-200': 'B752', 'B752': 'B752',
  'BOEING 767-300': 'B763', 'B767-300': 'B763', 'B763': 'B763',
  'AIRBUS A320': 'A320',    'A320': 'A320',
  'AIRBUS A320NEO': 'A20N', 'A320NEO': 'A20N',   'A20N': 'A20N',
  'AIRBUS A319': 'A319',    'A319': 'A319',
  'AIRBUS A321': 'A321',    'A321': 'A321',
  'AIRBUS A321NEO': 'A21N', 'A321NEO': 'A21N',   'A21N': 'A21N',
  'AIRBUS A330-300': 'A333', 'A330-300': 'A333', 'A333': 'A333',
  'AIRBUS A330-200': 'A332', 'A330-200': 'A332', 'A332': 'A332',
  'AIRBUS A350-900': 'A359', 'A350-900': 'A359', 'A359': 'A359',
  'AIRBUS A350-1000': 'A35K','A350-1000': 'A35K','A35K': 'A35K',
  'AIRBUS A380': 'A388',    'A380': 'A388',
  'EMBRAER E190': 'E190',   'E190': 'E190',
  'EMBRAER E170': 'E170',   'E170': 'E170',
  'EMBRAER E195': 'E195',   'E195': 'E195',
  'BOMBARDIER CRJ-700': 'CRJ7', 'CRJ-700': 'CRJ7', 'CRJ7': 'CRJ7',
  'BOMBARDIER CRJ-900': 'CRJ9', 'CRJ-900': 'CRJ9', 'CRJ9': 'CRJ9',
};

function _guessDesignator(aircraftType) {
  if (!aircraftType) return null;
  const key = aircraftType.trim().toUpperCase();
  // Direct lookup
  if (AIRCRAFT_DESIGNATOR_MAP[key]) return AIRCRAFT_DESIGNATOR_MAP[key];
  // If it already looks like an ICAO designator (e.g. "B738", "A320")
  if (/^[A-Z]\d{2,3}[A-Z]?$/.test(key)) return key;
  // Try partial match: strip manufacturer prefix
  for (const prefix of ['BOEING ', 'AIRBUS ', 'EMBRAER ', 'BOMBARDIER ']) {
    if (key.startsWith(prefix)) {
      const suffix = key.substring(prefix.length);
      if (AIRCRAFT_DESIGNATOR_MAP[suffix]) return AIRCRAFT_DESIGNATOR_MAP[suffix];
      // Convert common patterns: "777-300ER" → "B77W", "A320" → "A320"
      if (/^[A-Z]\d{2,3}/.test(suffix)) return suffix;
    }
  }
  return null;
}

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
  // Fallback: use the known game-wide base date (~2000-01-01)
  // This is needed when the backup file has been regenerated and lost the absolute ticks
  return FALLBACK_BASE_DATE_TICKS;
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
  AircraftType: '机型', Airway: '进场程序',
  Registration: '注册号', Voice: '语音', Language: '语言',
};

// Fields that get dropdown menus
const DROPDOWN_FIELDS = [
  'AircraftType', 'AirlineCode',
  'Stand', 'Runway', 'DepartureAirport', 'ArrivalAirport',
  'Voice', 'Language', 'Registration', 'Airway',
];

function loadFlights(aclPath) {
  const log = (msg) => console.log('[ACL-LOAD]', path.basename(aclPath), '|', msg);
  log('loadFlights() START');
  const text = fs.readFileSync(aclPath, 'utf-8');
  log('file size=' + text.length + ' bytes');
  const data = _parseFlightSchedule(text);
  if (data) {
    log('FlightSchedule FOUND, flights=' + data.flights.length);
    const sceneryMaps = _parseSceneryData(text);
    const worldStateData = _parseWorldStateData(text);
    return { flights: data.flights, before: data.before, after: data.after, arrayContent: data.arrayContent, originalBlocks: data.originalBlocks, originalLength: data.originalLength, worldStateData, sceneryMaps, _rawText: text };
  }
  log('FlightSchedule NOT found, trying FlightPlans...');
  // Fallback 1: extract flights from WorldState.FlightPlans (new game format, type 37)
  const fpResult = _parseWorldStateFlightPlans(text);
  log('FlightPlans result: ' + (fpResult ? 'found, flights=' + (fpResult.flights ? fpResult.flights.length : 'NULL') : 'NULL'));
  if (fpResult && fpResult.flights && fpResult.flights.length > 0) {
    log('FlightPlans -> returning ' + fpResult.flights.length + ' flights');
    const sceneryMaps = _parseSceneryData(text);
    return {
      flights: fpResult.flights,
      before: '', after: '', arrayContent: '', originalBlocks: [], originalLength: fpResult.flights.length,
      worldStateData: fpResult.fpData, sceneryMaps,
      _fromFlightPlans: true, _rawText: text
    };
  }
  log('FlightPlans EMPTY, trying WorldState.Aircrafts...');
  // Fallback 2: extract flights from WorldState.Aircrafts (TaskFlightState entries, old format)
  const wsData = _parseWorldStateData(text);
  log('WorldStateData: entries=' + (wsData.wsEntries ? wsData.wsEntries.length : 0) + ' aircraftsRlength=' + wsData.aircraftsRlength);
  const wsFlights = _extractFlightsFromWorldState(wsData, text);
  log('WorldState extracted flights: ' + (wsFlights ? wsFlights.length : 'NULL'));
  if (!wsFlights || wsFlights.length === 0) throw new Error('No FlightSchedule or WorldState flight data found in .acl file');
  log('WorldState -> returning ' + wsFlights.length + ' flights');
  const sceneryMaps = _parseSceneryData(text);
  return {
    flights: wsFlights,
    before: '', after: '', arrayContent: '', originalBlocks: [], originalLength: wsFlights.length,
    worldStateData: wsData, sceneryMaps,
    _fromWorldState: true, _rawText: text
  };
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

// ─── SceneryData parser: extract Runway Name→GUID and Stand Identifier→GUID ──

function _parseSceneryData(text) {
  const runwayNameToGuid = {};
  const standIdToGuid = {};
  const runwayGuidToName = {};
  const standGuidToId = {};

  const sdIdx = text.indexOf('"SceneryData"');
  if (sdIdx < 0) return { runwayNameToGuid, standIdToGuid, runwayGuidToName, standGuidToId };

  const sdText = text.substring(sdIdx);

  // Parse Runways section
  const rwIdx = sdText.indexOf('"Runways"');
  if (rwIdx >= 0) {
    const rwSection = sdText.substring(rwIdx);
    // Each runway entry looks like: "$k": "guid", ... "$v": { ... "Name": "4L" ... }
    // Find all "$k" GUIDs followed by "Name" within reasonable distance
    const kRe = /"\$k"\s*:\s*"([a-f0-9-]+)"/g;
    let km;
    while ((km = kRe.exec(rwSection)) !== null) {
      const guid = km[1];
      const ahead = rwSection.substring(km.index, km.index + 3000);
      const nameMatch = ahead.match(/"Name"\s*:\s*"([^"]+)"/);
      if (nameMatch) {
        runwayNameToGuid[nameMatch[1]] = guid;
        runwayGuidToName[guid] = nameMatch[1];
      }
    }
  }

  // Parse StandGroup / Stands section
  const sgIdx = sdText.indexOf('"StandGroup"');
  if (sgIdx >= 0) {
    const sgSection = sdText.substring(sgIdx);
    const kRe = /"\$k"\s*:\s*"([a-f0-9-]+)"/g;
    let km;
    while ((km = kRe.exec(sgSection)) !== null) {
      const guid = km[1];
      const ahead = sgSection.substring(km.index, km.index + 3000);
      const idMatch = ahead.match(/"Identifier"\s*:\s*"([^"]+)"/);
      if (idMatch) {
        standIdToGuid[idMatch[1]] = guid;
        standGuidToId[guid] = idMatch[1];
      }
    }
  }

  return { runwayNameToGuid, standIdToGuid, runwayGuidToName, standGuidToId };
}

// ─── WorldState parser ───────────────────────────────────────

/**
 * Extract raw WorldState data for in-place patching on save.
 * Returns: {
 *   wsStart: absolute text position of "WorldState" block start,
 *   aircraftsBefore: text before Aircrafts $rcontent array,
 *   aircraftsAfter: text after Aircrafts $rcontent array,
 *   wsEntries: array of { k, vBlock } (raw text blocks with $k GUID and $v object text),
 *   aircraftsRlength: count value
 * }
 */
function _parseWorldStateData(text) {
  const result = { wsStart: -1, aircraftsBefore: '', aircraftsAfter: '', wsEntries: [], aircraftsRlength: 0 };

  const wsIdx = text.indexOf('"WorldState"');
  if (wsIdx < 0) return result;
  result.wsStart = wsIdx;

  const wsText = text.substring(wsIdx);
  const acIdx = wsText.indexOf('"Aircrafts"');
  if (acIdx < 0) return result;

  const acSection = wsText.substring(acIdx);
  const rcMatch = acSection.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return result;

  // Get $rlength before the array
  const rlMatch = acSection.match(/"\$rlength"\s*:\s*(\d+)/);
  if (rlMatch) result.aircraftsRlength = parseInt(rlMatch[1], 10);

  const rcPos = acIdx + rcMatch.index + rcMatch[0].length;
  result.aircraftsBefore = text.substring(0, wsIdx + rcPos);
  const absRcPos = wsIdx + rcPos;

  // Find the end of the $rcontent array
  let depth = 0;
  let endPos = null;
  for (let i = absRcPos; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { let j = i + 1; while (j < text.length && ' \t\n\r'.includes(text[j])) j++; if (j < text.length && text[j] === ']') { endPos = j + 1; break; } } }
    else if (c === ']' && depth === 0) { endPos = i + 1; break; }
  }
  if (endPos === null) endPos = text.length;

  result.aircraftsAfter = text.substring(endPos);

  // Parse entries inside the $rcontent array
  const arrayContent = text.substring(absRcPos, endPos);
  depth = 0;
  let entryStart = -1;
  for (let i = 0; i < arrayContent.length; i++) {
    const ch = arrayContent[i];
    if (ch === '{') { if (depth === 0) entryStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && entryStart >= 0) {
        const block = arrayContent.substring(entryStart, i + 1);
        const kMatch = block.match(/"\$k"\s*:\s*"([^"]+)"/);
        const vStart = block.indexOf('"$v"');
        if (vStart >= 0) {
          // Find $v value: after ":" find the { and match closing }
          const colonIdx = block.indexOf(':', vStart);
          const braceIdx = block.indexOf('{', colonIdx);
          // Find matching closing brace
          let vDepth = 1;
          let vEnd = braceIdx + 1;
          for (; vEnd < block.length; vEnd++) {
            if (block[vEnd] === '{') vDepth++;
            else if (block[vEnd] === '}') { vDepth--; if (vDepth === 0) break; }
          }
          result.wsEntries.push({
            k: kMatch ? kMatch[1] : '',
            block: block, // full "$k"/"$v" entry text
            vBlock: block.substring(braceIdx, vEnd + 1) // just the $v object text
          });
        }
        entryStart = -1;
      }
    }
  }

  return result;
}

/**
 * Extract flights from WorldState TaskFlightState entries.
 * These are $type 56 entries that contain the flight schedule data.
 */
function _extractFlightsFromWorldState(wsData, fullText, sceneryMaps) {
  if (!wsData || !wsData.wsEntries || wsData.wsEntries.length === 0) return [];
  const sm = sceneryMaps || { runwayNameToGuid: {}, standIdToGuid: {}, runwayGuidToName: {}, standGuidToId: {} };

  const flights = [];
  const baseDateTicks = _extractBaseDateFromText(fullText);

  for (let ei = 0; ei < wsData.wsEntries.length; ei++) {
    const entry = wsData.wsEntries[ei];
    const block = entry.block;
    const vBlock = entry.vBlock;

    // Check if this is a TaskFlightState ($type 56 old, $type 54 new)
    if (!vBlock.includes('"$type": 56,') && !vBlock.includes('"$type": "56|') &&
        !vBlock.includes('"$type": 54,') && !vBlock.includes('"$type": "54|')) continue;

    const f = { _wsEntryIdx: ei, _wsGuid: entry.k };

    // Extract top-level fields from TaskFlightState
    const csMatch = vBlock.match(/"CallSign"\s*:\s*"([^"]*)"/);
    const alMatch = vBlock.match(/"AirlineName"\s*:\s*"([^"]*)"/);
    const atMatch = vBlock.match(/"AircraftType"\s*:\s*"([^"]*)"/);
    const voiceMatch = vBlock.match(/"Voice"\s*:\s*"([^"]*)"/);
    const langMatch = vBlock.match(/"Language"\s*:\s*"([^"]*)"/);
    const regMatch = vBlock.match(/"Registration"\s*:\s*"([^"]*)"/);

    f.CallSign = csMatch ? csMatch[1] : '';
    f.AirlineName = alMatch ? alMatch[1] : '';
    f.AircraftType = atMatch ? atMatch[1] : '';
    f.Voice = voiceMatch ? voiceMatch[1] : '';
    f.Language = langMatch ? langMatch[1] : '';
    f._Registration = regMatch ? regMatch[1] : '';

    // Extract Departure sub-object
    const depMatch = vBlock.match(/"Departure"\s*:\s*\{/);
    const arrMatch = vBlock.match(/"Arrival"\s*:\s*\{/);
    const arrNull = vBlock.match(/"Arrival"\s*:\s*null/);

    if (depMatch) {
      f.isDeparture = true;
      // Find Departure object bounds
      const depStart = depMatch.index + depMatch[0].length;
      let depDepth = 1;
      let depEnd = depStart;
      for (; depEnd < vBlock.length; depEnd++) {
        if (vBlock[depEnd] === '{') depDepth++;
        else if (vBlock[depEnd] === '}') { depDepth--; if (depDepth === 0) break; }
      }
      const depObj = vBlock.substring(depStart, depEnd);

      // Parse departure fields
      const destMatch = depObj.match(/"DestinationAirport"\s*:\s*"([^"]*)"/);
      const rwMatch = depObj.match(/"Runway"\s*:\s*"([^"]*)"/);
      const stMatch = depObj.match(/"Stand"\s*:\s*"([^"]*)"/);
      const obtMatch = depObj.match(/"OffBlockTime"\s*:\s*\{\s*"\$type"\s*:\s*\d+\s*,\s*(-?\d+)\s*\}/);
      const totMatch = depObj.match(/"TakeoffTime"\s*:\s*\{\s*"\$type"\s*:\s*\d+\s*,\s*(-?\d+)\s*\}/);

      f.DepartureAirport = '';
      f.ArrivalAirport = destMatch ? destMatch[1] : '';
      f.Runway = rwMatch ? rwMatch[1] : '';
      f.Stand = stMatch ? stMatch[1] : '';
      f.OffBlockTime = obtMatch ? ticksToTime(obtMatch[1]) : '';
      f.TakeoffTime = totMatch ? ticksToTime(totMatch[1]) : '';
      f.LandingTime = '';
      f.InBlockTime = '';
      f.Airway = '';
    } else if (arrMatch) {
      f.isDeparture = false;
      const arrStart = arrMatch.index + arrMatch[0].length;
      let arrDepth = 1;
      let arrEnd = arrStart;
      for (; arrEnd < vBlock.length; arrEnd++) {
        if (vBlock[arrEnd] === '{') arrDepth++;
        else if (vBlock[arrEnd] === '}') { arrDepth--; if (arrDepth === 0) break; }
      }
      const arrObj = vBlock.substring(arrStart, arrEnd);

      const origMatch = arrObj.match(/"OriginAirport"\s*:\s*"([^"]*)"/);
      const rwMatch = arrObj.match(/"Runway"\s*:\s*"([^"]*)"/);
      const stMatch = arrObj.match(/"Stand"\s*:\s*"([^"]*)"/);
      const starMatch = arrObj.match(/"STAR"\s*:\s*"([^"]*)"/);
      const ldtMatch = arrObj.match(/"LandingTime"\s*:\s*\{\s*"\$type"\s*:\s*\d+\s*,\s*(-?\d+)\s*\}/);
      const ibtMatch = arrObj.match(/"InBlockTime"\s*:\s*\{\s*"\$type"\s*:\s*\d+\s*,\s*(-?\d+)\s*\}/);

      f.DepartureAirport = origMatch ? origMatch[1] : '';
      f.ArrivalAirport = '';
      f.Runway = rwMatch ? rwMatch[1] : '';
      f.Stand = stMatch ? stMatch[1] : '';
      f.Airway = starMatch ? starMatch[1] : '';
      f.LandingTime = ldtMatch ? ticksToTime(ldtMatch[1]) : '';
      f.InBlockTime = ibtMatch ? ticksToTime(ibtMatch[1]) : '';
      f.OffBlockTime = '';
      f.TakeoffTime = '';
    }

    flights.push(f);
  }

  // Sort: arrivals (LandingTime non-empty) first by LandingTime, then departures by OffBlockTime
  const arrivals = flights.filter(f => (f.LandingTime || '').trim()).sort((a, b) => (a.LandingTime || '').localeCompare(b.LandingTime || ''));
  const departures = flights.filter(f => (f.OffBlockTime || '').trim()).sort((a, b) => (a.OffBlockTime || '').localeCompare(b.OffBlockTime || ''));
  return [...arrivals, ...departures];
}

/**
 * Extract base date ticks from the file (from WorldState or BaseTime).
 */
function _extractBaseDateFromText(text) {
  // Try BaseTime field first
  const btMatch = text.match(/"BaseTime"\s*:\s*\{\s*"\$type"\s*:\s*3\s*,\s*(-?\d+)\s*\}/);
  if (btMatch) {
    const ticks = BigInt(btMatch[1]);
    return Number((ticks / TICKS_PER_DAY) * TICKS_PER_DAY);
  }
  // Try to find from WorldState departure/arrival times
  const wsIdx = text.indexOf('"WorldState"');
  if (wsIdx >= 0) {
    const wsText = text.substring(wsIdx);
    const timeMatch = wsText.match(/"(?:OffBlockTime|LandingTime|TakeoffTime|InBlockTime)"\s*:\s*\{\s*"\$type"\s*:\s*3\s*,\s*(-?\d+)\s*\}/);
    if (timeMatch) {
      const ticks = BigInt(timeMatch[1]);
      if (ticks > TICKS_PER_DAY) {
        return Number((ticks / TICKS_PER_DAY) * TICKS_PER_DAY);
      }
    }
  }
  return FALLBACK_BASE_DATE_TICKS;
}

/**
 * Sync edited flights back into the WorldState section of the raw text.
 * Returns the fully updated text.
 */
function _syncWorldState(rawText, flights, wsData, sceneryMaps, baseDateTicks) {
  if (!wsData || !wsData.wsEntries || wsData.wsEntries.length === 0 || !flights || flights.length === 0) return rawText;
  const sm = sceneryMaps || { runwayNameToGuid: {}, standIdToGuid: {} };
  const bdt = baseDateTicks || FALLBACK_BASE_DATE_TICKS;

  // Build a CallSign → flight lookup for quick matching
  const flightByCallSign = {};
  for (const fl of flights) {
    const cs = (fl.CallSign || '').trim();
    if (cs) flightByCallSign[cs] = fl;
  }

  // Build array of updated entry blocks
  const newEntryBlocks = [];
  for (let ei = 0; ei < wsData.wsEntries.length; ei++) {
    const entry = wsData.wsEntries[ei];
    let newBlock = entry.block;

    // Check if this is a TaskFlightState (type 56 old, type 54 new)
    if (entry.vBlock.includes('"$type": 56,') || entry.vBlock.includes('"$type": "56|') ||
        entry.vBlock.includes('"$type": 54,') || entry.vBlock.includes('"$type": "54|')) {
      // Find the CallSign in this entry
      const csMatch = entry.vBlock.match(/"CallSign"\s*:\s*"([^"]*)"/);
      const cs = csMatch ? csMatch[1] : '';
      const flight = flightByCallSign[cs];

      if (flight) {
        // Detect departure vs arrival from the WorldState entry (has Departure or Arrival sub-object)
        const hasDeparture = entry.vBlock.includes('"Departure"') && !entry.vBlock.includes('"Departure": null');
        const hasArrival = entry.vBlock.includes('"Arrival"') && !entry.vBlock.includes('"Arrival": null');
        // Use explicit flag if available (when loaded from WorldState), else infer from entry
        const isDep = flight.isDeparture !== undefined ? flight.isDeparture : hasDeparture;
        // Update top-level fields in the entry
        newBlock = _applyWsChanges(newBlock, flight, bdt, isDep);

        // Also update this flight's _wsEntryIdx to match the new order
        flight._wsEntryIdx = newEntryBlocks.length;
      }
    } else if (entry.vBlock.includes('"$type": 35,') || entry.vBlock.includes('"$type": "35|')) {
      // This is an AircraftState entry - find linked TaskFlightState by FlightPlanGuid
      const fpgMatch = entry.vBlock.match(/"FlightPlanGuid"\s*:\s*"([^"]+)"/);
      if (fpgMatch) {
        const fpg = fpgMatch[1];
        // Find TaskFlightState with this Guid
        const linkedFlight = flights.find(f => f._wsGuid === fpg);
        if (linkedFlight) {
          // Update RunwayGuid, StandGuid, Designator in AircraftState
          newBlock = _applyAircraftStateChanges(newBlock, linkedFlight, sm);
        }
      }
    }

    newEntryBlocks.push(newBlock);
  }

  // Update $rlength
  const lenMatch = wsData.aircraftsBefore.match(/"\$rlength"\s*:\s*(\d+)/);
  if (lenMatch) {
    const oldLen = parseInt(lenMatch[1], 10);
    wsData.aircraftsBefore = wsData.aircraftsBefore.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${newEntryBlocks.length}`);
  }

  // Reconstruct full text
  const newArray = newEntryBlocks.join(',\n                ');
  const newText = wsData.aircraftsBefore + '\n' + newArray + '\n' + wsData.aircraftsAfter;
  return newText;
}

/**
 * Apply flight changes to a WorldState TaskFlightState entry block (raw text).
 */
function _applyWsChanges(block, flight, baseDateTicks, isDeparture) {
  // Update CallSign
  block = _applyWsField(block, 'CallSign', flight.CallSign || '', 'string');
  // Update Registration
  if (flight._Registration) {
    block = _applyWsField(block, 'Registration', flight._Registration, 'string');
  }
  // Update AirlineName
  block = _applyWsField(block, 'AirlineName', flight.AirlineName || '', 'string');
  // Update AircraftType
  block = _applyWsField(block, 'AircraftType', flight.AircraftType || '', 'string');
  // Update Voice
  block = _applyWsField(block, 'Voice', flight.Voice || '', 'string');
  // Update Language
  block = _applyWsField(block, 'Language', flight.Language || '', 'string');

  // Update Departure or Arrival sub-object
  if (isDeparture) {
    // Find Departure object and update fields within it
    const depMatch = block.match(/"Departure"\s*:\s*\{/);
    if (depMatch) {
      const depStart = depMatch.index + depMatch[0].length;
      let depDepth = 1;
      let depEnd = depStart;
      for (; depEnd < block.length; depEnd++) {
        if (block[depEnd] === '{') depDepth++;
        else if (block[depEnd] === '}') { depDepth--; if (depDepth === 0) break; }
      }
      let depObj = block.substring(depStart, depEnd);

      // Update fields inside Departure
      depObj = _applyWsField(depObj, 'DestinationAirport', flight.ArrivalAirport || '', 'string');
      depObj = _applyWsField(depObj, 'Runway', flight.Runway || '', 'string');
      depObj = _applyWsField(depObj, 'Stand', flight.Stand || '', 'string');
      depObj = _applyWsField(depObj, 'OffBlockTime', ticksToString(timeToTicks(flight.OffBlockTime || '', baseDateTicks)), 'ticks');
      depObj = _applyWsField(depObj, 'TakeoffTime', ticksToString(timeToTicks(flight.TakeoffTime || '', baseDateTicks)), 'ticks');

      block = block.substring(0, depStart) + depObj + block.substring(depEnd);
    }
  } else {
    const arrMatch = block.match(/"Arrival"\s*:\s*\{/);
    if (arrMatch) {
      const arrStart = arrMatch.index + arrMatch[0].length;
      let arrDepth = 1;
      let arrEnd = arrStart;
      for (; arrEnd < block.length; arrEnd++) {
        if (block[arrEnd] === '{') arrDepth++;
        else if (block[arrEnd] === '}') { arrDepth--; if (arrDepth === 0) break; }
      }
      let arrObj = block.substring(arrStart, arrEnd);

      arrObj = _applyWsField(arrObj, 'OriginAirport', flight.DepartureAirport || '', 'string');
      arrObj = _applyWsField(arrObj, 'Runway', flight.Runway || '', 'string');
      arrObj = _applyWsField(arrObj, 'Stand', flight.Stand || '', 'string');
      arrObj = _applyWsField(arrObj, 'STAR', flight.Airway || '', 'string');
      arrObj = _applyWsField(arrObj, 'LandingTime', ticksToString(timeToTicks(flight.LandingTime || '', baseDateTicks)), 'ticks');
      arrObj = _applyWsField(arrObj, 'InBlockTime', ticksToString(timeToTicks(flight.InBlockTime || '', baseDateTicks)), 'ticks');

      block = block.substring(0, arrStart) + arrObj + block.substring(arrEnd);
    }
  }

  return block;
}

/**
 * Apply changes to an AircraftState entry (type 35) - updates RunwayGuid, StandGuid, Designator.
 */
function _applyAircraftStateChanges(block, flight, sceneryMaps) {
  const sm = sceneryMaps || {};

  // Update RunwayGuid if runway name changed
  if (flight.Runway && sm.runwayNameToGuid && sm.runwayNameToGuid[flight.Runway]) {
    const newGuid = sm.runwayNameToGuid[flight.Runway];
    block = _applyWsField(block, 'RunwayGuid', newGuid, 'string');
  }

  // Update StandGuid if stand name changed
  if (flight.Stand && sm.standIdToGuid && sm.standIdToGuid[flight.Stand]) {
    const newGuid = sm.standIdToGuid[flight.Stand];
    block = _applyWsField(block, 'StandGuid', newGuid, 'string');
  }

  // Update Designator in Specification (AircraftState sync)
  if (flight.AircraftType) {
    const designator = _guessDesignator(flight.AircraftType);
    if (designator) {
      const specMatch = block.match(/"Specification"\s*:\s*\{/);
      if (specMatch) {
        const specStart = specMatch.index + specMatch[0].length;
        let specDepth = 1;
        let specEnd = specStart;
        for (; specEnd < block.length; specEnd++) {
          if (block[specEnd] === '{') specDepth++;
          else if (block[specEnd] === '}') { specDepth--; if (specDepth === 0) break; }
        }
        let specObj = block.substring(specStart, specEnd);
        specObj = _applyWsField(specObj, 'Designator', designator, 'string');
        block = block.substring(0, specStart) + specObj + block.substring(specEnd);
      }
    }
  }

  return block;
}

/**
 * Apply a single field change in a raw JSON text block.
 * @param {'string'|'ticks'} fieldType
 */
function _applyWsField(block, fieldName, value, fieldType) {
  if (fieldType === 'string') {
    const val = value || '';
    // Try to find existing string value
    const m = block.match(new RegExp(`("${fieldName}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`));
    if (m) {
      return block.substring(0, m.index) + m[1] + '"' + val + '"' + block.substring(m.index + m[0].length);
    }
    // Try null value
    const mNull = block.match(new RegExp(`("${fieldName}"\\s*:\\s*)null`));
    if (mNull && val) {
      return block.substring(0, mNull.index) + mNull[1] + '"' + val + '"' + block.substring(mNull.index + mNull[0].length);
    }
  } else if (fieldType === 'ticks') {
    const val = value || '0';
    const m = block.match(new RegExp(`("${fieldName}"\\s*:\\s*\\{\\s*"\\$type"\\s*:\\s*\\d+\\s*,\\s*)(-?\\d+)(\\s*\\})`));
    if (m) {
      const start = m.index + m[1].length;
      const end = start + m[2].length;
      return block.substring(0, start) + val + block.substring(end);
    }
  }
  return block;
}

function ticksToString(ticks) {
  return String(ticks);
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

/**
 * Build a new $rcontent array block string from flights, applying changes to
 * existing originalBlocks and cloning the last block for new flights.
 * Returns the rebuilt array text (without before/after brackets).
 */
function _rebuildBlocks(flights, originalBlocks, baseDateTicks) {
  const newBlocks = [];
  for (let i = 0; i < flights.length; i++) {
    if (i < originalBlocks.length) {
      newBlocks.push(_applyChanges(originalBlocks[i], flights[i], baseDateTicks));
    } else {
      const template = originalBlocks.length > 0 ? originalBlocks[originalBlocks.length - 1] : null;
      newBlocks.push(_buildNewBlock(flights[i], template, baseDateTicks));
    }
  }
  return newBlocks;
}

function saveFlights(aclPath, flights, before, after, arrayContent, originalBlocks, worldStateData, sceneryMaps, _fromWorldState, _fromFlightPlans) {
  // If loaded from FlightPlans (new game format), only patch FlightPlans section
  if (_fromFlightPlans && worldStateData && worldStateData.fpBefore) {
    const text = fs.readFileSync(aclPath, 'utf-8');
    const baseDateTicks = _extractBaseDateFromText(text);
    const newText = _syncFlightPlans(text, flights, worldStateData, baseDateTicks);
    fs.writeFileSync(aclPath, newText, 'utf-8');
    return;
  }

  // If loaded from WorldState (no FlightSchedule section), only patch WorldState
  if (_fromWorldState && worldStateData) {
    const text = fs.readFileSync(aclPath, 'utf-8');
    const baseDateTicks = _extractBaseDateFromText(text);
    const newText = _syncWorldState(text, flights, worldStateData, sceneryMaps, baseDateTicks);
    fs.writeFileSync(aclPath, newText, 'utf-8');
    return;
  }

  // Normal FlightSchedule-based save
  const baseDateTicks = _extractBaseDateTicks(originalBlocks);
  const newBlocks = _rebuildBlocks(flights, originalBlocks, baseDateTicks);
  const fixedBefore = _updateRlength(before, flights.length);
  let newText = fixedBefore + newBlocks.join(',\n            ') + after;

  // Also sync WorldState entries if available
  if (worldStateData && worldStateData.wsEntries && worldStateData.wsEntries.length > 0) {
    newText = _syncWorldState(newText, flights, worldStateData, sceneryMaps, baseDateTicks);
  }

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
    // Deterministic $id based on CallSign to avoid collisions across saves
    const cs = (flight.CallSign || 'UNKNOWN');
    let hash = 0;
    for (let i = 0; i < cs.length; i++) hash = ((hash << 5) - hash + cs.charCodeAt(i)) | 0;
    const newId = 90000 + (Math.abs(hash) % 90000);
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
  // Registration map: "AirlineName|AircraftType" → Set<Registration>
  const regMap = new Map();

  for (const aclPath of aclPaths) {
    const text = fs.readFileSync(aclPath, 'utf-8');
    // Scan FlightSchedule first, fall back to WorldState
    let data = _parseFlightSchedule(text);
    let flights;
    if (data) {
      flights = data.flights;
    } else {
      const wsData = _parseWorldStateData(text);
      const sceneryMaps = _parseSceneryData(text);
      flights = _extractFlightsFromWorldState(wsData, text, sceneryMaps);
    }
    if (!flights || flights.length === 0) continue;
    for (const fl of flights) {
      for (const field of DROPDOWN_FIELDS) {
        if (field === 'AirlineCode') {
          // AirlineCode is the first 3 chars of CallSign
          const code = (fl.CallSign || '').trim().substring(0, 3);
          if (code) values[field].add(code);
        } else if (field === 'Registration') {
          const reg = fl._Registration || fl.Registration || '';
          if (reg) values[field].add(reg);
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
      // Build Registration map: AirlineCode(ICAO) × AircraftType → Registrations
      const reg = (fl._Registration || fl.Registration || '').trim();
      if (acCode && acType && reg) {
        const key = acCode + '|' + acType;
        if (!regMap.has(key)) regMap.set(key, new Set());
        regMap.get(key).add(reg);
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
  // Store registration map (AirlineName|AircraftType → registrations)
  result._registrationMap = {};
  for (const [key, set] of regMap) {
    result._registrationMap[key] = [...set].sort();
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
    let data = _parseFlightSchedule(text);
    let flights;
    let error = null;
    if (data) {
      flights = data.flights;
    } else {
      // Fallback 1: WorldState.FlightPlans (newer game format, type 52)
      const fpResult = _parseWorldStateFlightPlans(text);
      if (fpResult && fpResult.flights && fpResult.flights.length > 0) {
        flights = fpResult.flights;
      } else {
        // Fallback 2: WorldState.Aircrafts (older TaskFlightState format, type 56/54)
        const wsData = _parseWorldStateData(text);
        const sceneryMaps = _parseSceneryData(text);
        flights = _extractFlightsFromWorldState(wsData, text, sceneryMaps);
      }
      if (!flights || flights.length === 0) {
        error = 'No FlightSchedule or WorldState flight data';
      }
    }
    if (error) return { error, filename: path.basename(aclPath), size: stat.size };

    let arrivals = 0, departures = 0;
    for (const fl of flights) {
      if ((fl.LandingTime || '').trim()) arrivals++;
      else if ((fl.OffBlockTime || '').trim()) departures++;
    }
    return {
      filename: path.basename(aclPath),
      path: aclPath,
      size: stat.size,
      flightCount: flights.length,
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
function generateFullAcl(aclPath, flights, headerBefore = '', footerAfter = '', originalBlocks = [], worldStateData = null, sceneryMaps = null, _fromWorldState = false, _fromFlightPlans = false) {
  // If loaded from FlightPlans (new game format), only patch FlightPlans section
  if (_fromFlightPlans && worldStateData && worldStateData.fpBefore) {
    const text = fs.readFileSync(aclPath, 'utf-8');
    const baseDateTicks = _extractBaseDateFromText(text);
    const newText = _syncFlightPlans(text, flights, worldStateData, baseDateTicks);
    fs.writeFileSync(aclPath, newText, 'utf-8');
    return;
  }

  // If loaded from WorldState (no FlightSchedule section), only patch WorldState
  if (_fromWorldState && worldStateData) {
    const text = fs.readFileSync(aclPath, 'utf-8');
    const baseDateTicks = _extractBaseDateFromText(text);
    const newText = _syncWorldState(text, flights, worldStateData, sceneryMaps, baseDateTicks);
    fs.writeFileSync(aclPath, newText, 'utf-8');
    return;
  }

  // If we have a valid header (before), use it as base and just build the flight blocks
  if (headerBefore && headerBefore.includes('"FlightSchedule"')) {
    const baseDateTicks = _extractBaseDateTicks(originalBlocks);
    const newBlocks = _rebuildBlocks(flights, originalBlocks, baseDateTicks);
    const fixedBefore = _updateRlength(headerBefore, flights.length);
    // If footerAfter is empty, generate closing brackets
    const fixedAfter = footerAfter || '\n        ]\n    }\n}';
    let newText = fixedBefore + newBlocks.join(',\n            ') + fixedAfter;

    // Also sync WorldState entries if available
    if (worldStateData && worldStateData.wsEntries && worldStateData.wsEntries.length > 0) {
      newText = _syncWorldState(newText, flights, worldStateData, sceneryMaps, baseDateTicks);
    }

    fs.writeFileSync(aclPath, newText, 'utf-8');
    return;
  }

  // No valid template → generate minimal ACL from scratch
  // Use the fallback base date so timestamps contain the full date portion.
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
        const ticks = timeToTicks(fl[fn] || '', baseDateTicks);
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
  // Use same format as game CSV for consistency
  const headers = 'registration,arrivalCallSign,originAirport,landingTime,arrivalStand,arrivalRunway,arrivalSTAR,departureCallSign,destinationAirport,offBlockTime,departureStand,departureRunway,airline,aircraftType,voice,language';
  const rows = [headers];
  for (const fl of flights) {
    const isArrival = !fl.isDeparture && !!(fl.LandingTime || '').trim();
    const isDeparture = fl.isDeparture || !!(fl.OffBlockTime || '').trim();
    const reg = fl._Registration || '';

    rows.push([
      reg,
      isArrival ? (fl.CallSign || '') : '',
      isArrival ? (fl.DepartureAirport || '') : '',
      isArrival ? (fl.LandingTime || '') : '',
      isArrival ? (fl.Stand || '') : '',
      isArrival ? (fl.Runway || '') : '',
      isArrival ? (fl.Airway || '') : '',
      isDeparture ? (fl.CallSign || '') : '',
      isDeparture ? (fl.ArrivalAirport || '') : '',
      isDeparture ? (fl.OffBlockTime || '') : '',
      isDeparture ? (fl.Stand || '') : '',
      isDeparture ? (fl.Runway || '') : '',
      fl.AirlineName || '', fl.AircraftType || '', fl.Voice || '', fl.Language || ''
    ].join(','));
  }
  fs.writeFileSync(csvPath, rows.join('\n'), 'utf-8');
}

/**
 * Export flights to the game-compatible CSV format (13 columns, no airway/precedingFlight).
 * The game reads this CSV directly via flightScheduleFile in .aclcfg.
 */
function exportGameCSV(flights, csvPath) {
  // Post-update game CSV format (16 columns): registration, arrivalCallSign, originAirport, landingTime,
  // arrivalStand, arrivalRunway, arrivalSTAR, departureCallSign, destinationAirport, offBlockTime,
  // departureStand, departureRunway, airline, aircraftType, voice, language
  const headers = 'registration,arrivalCallSign,originAirport,landingTime,arrivalStand,arrivalRunway,arrivalSTAR,departureCallSign,destinationAirport,offBlockTime,departureStand,departureRunway,airline,aircraftType,voice,language';
  const rows = [headers];
  for (const fl of flights) {
    const isArrival = !fl.isDeparture && !!(fl.LandingTime || '').trim();
    const isDeparture = fl.isDeparture || !!(fl.OffBlockTime || '').trim();
    const reg = fl._Registration || '';

    rows.push([
      reg,
      // Arrival columns
      isArrival ? (fl.CallSign || '') : '',
      isArrival ? (fl.DepartureAirport || '') : '',
      isArrival ? (fl.LandingTime || '') : '',
      isArrival ? (fl.Stand || '') : '',
      isArrival ? (fl.Runway || '') : '',
      isArrival ? (fl.Airway || '') : '',
      // Departure columns
      isDeparture ? (fl.CallSign || '') : '',
      isDeparture ? (fl.ArrivalAirport || '') : '',
      isDeparture ? (fl.OffBlockTime || '') : '',
      isDeparture ? (fl.Stand || '') : '',
      isDeparture ? (fl.Runway || '') : '',
      // Shared columns
      fl.AirlineName || '', fl.AircraftType || '', fl.Voice || '', fl.Language || ''
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

  const isNewFormat = 'registration' in colMap;

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

    if (isNewFormat) {
      // New format: registration, arrivalCallSign, originAirport, landingTime, arrivalStand,
      //   arrivalRunway, arrivalSTAR, departureCallSign, destinationAirport, offBlockTime,
      //   departureStand, departureRunway, airline, aircraftType, voice, language
      const arrCall = get('arrivalcallsign');
      const depCall = get('departurecallsign');
      const isArrival = !!arrCall;

      const f = {
        CallSign: isArrival ? arrCall : depCall,
        DepartureAirport: isArrival ? get('originairport') : '',
        ArrivalAirport: isArrival ? '' : get('destinationairport'),
        Stand: isArrival ? get('arrivalstand') : get('departurestand'),
        Runway: isArrival ? get('arrivalrunway') : get('departurerunway'),
        LandingTime: isArrival ? get('landingtime') : '',
        InBlockTime: '',
        OffBlockTime: isArrival ? '' : get('offblocktime'),
        TakeoffTime: '',
        AirlineName: get('airline'),
        AircraftType: get('aircrafttype'),
        Airway: isArrival ? get('arrivalstar') : '',
        Voice: get('voice'),
        Language: get('language'),
        PrecedingFlight: '',
        _Registration: get('registration'),
        isDeparture: !isArrival,
      };
      flights.push(f);
    } else {
      // Old format: callSign,departure,arrival,stand,runway,offBlockTime,takeOffTime,landingTime,inBlockTime,airline,aircraftType,airway,voice,language,precedingFlight
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
      // Infer isDeparture
      if ((f.OffBlockTime || '').trim()) f.isDeparture = true;
      else if ((f.LandingTime || '').trim()) f.isDeparture = false;
      flights.push(f);
    }
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

/**
 * Merge two audio callsign dictionaries (e.g. EN + ZH).
 * @param {object|null} primary - first audio data { byAirline, allCallsigns, allAirlines }
 * @param {object|null} secondary - second audio data { byAirline, allCallsigns, allAirlines }
 * @returns {{ byAirline: Record<string, string[]>, allCallsigns: string[], allAirlines: string[] }}
 */
function mergeAudioCallsigns(primary, secondary) {
  if (!primary) primary = { byAirline: {}, allCallsigns: [], allAirlines: [] };
  if (!secondary) secondary = { byAirline: {}, allCallsigns: [], allAirlines: [] };
  const allAirlines = [...new Set([...primary.allAirlines, ...secondary.allAirlines])].sort();
  const byAirline = {};
  for (const code of allAirlines) {
    byAirline[code] = [...new Set([
      ...(primary.byAirline[code] || []), ...(secondary.byAirline[code] || [])
    ])].sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }
  const allCallsigns = [...new Set([...primary.allCallsigns, ...secondary.allCallsigns])].sort();
  return { byAirline, allCallsigns, allAirlines };
}

/**
 * Scan a single CSV file and collect unique values for dropdown fields.
 * @param {string} csvPath - path to CSV file
 * @returns {object} - { Stand, Runway, DepartureAirport, ArrivalAirport, AircraftType, Voice, Language, _voiceOptions }
 */
function collectUniqueValuesFromCSV(csvPath) {
  console.log('══════════════════════ [CSV-COLLECT] ══════════════════════');
  console.log('[CSV-COLLECT] csvPath:', csvPath);
  console.log('[CSV-COLLECT] exists:', fs.existsSync(csvPath));

  const result = {
    Stand: new Set(), Runway: new Set(),
    DepartureAirport: new Set(), ArrivalAirport: new Set(),
    AircraftType: new Set(), Voice: new Set(), Language: new Set(),
    Registration: new Set(), Airway: new Set(),
    _voiceOptions: new Set(),
  };
  const regMap = new Map();

  if (!fs.existsSync(csvPath)) {
    console.log('[CSV-COLLECT] FILE NOT FOUND, returning empty!');
    return { Stand:[], Runway:[], DepartureAirport:[], ArrivalAirport:[], AircraftType:[], Voice:[], Language:[], Registration:[], Airway:[], _voiceOptions:[], _registrationMap: {} };
  }

  const text = fs.readFileSync(csvPath, 'utf-8');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  console.log('[CSV-COLLECT] total lines:', lines.length);

  // ── NEW header detection: match against actual game CSV column names (case-insensitive) ──
  const knownFieldsLower = new Set([
    'registration', 'arrivalcallsign', 'departurecallsign', 'callsign',
    'originairport', 'destinationairport', 'departureairport', 'arrivalairport',
    'arrivalstand', 'departurestand', 'stand',
    'arrivalrunway', 'departurerunway', 'runway',
    'arrivalstar', 'airway',  'star',
    'aircrafttype', 'airline', 'airlinename',
    'voice', 'language',
    'landingtime', 'offblocktime', 'takeofftime', 'inblocktime',
  ]);

  let headerIdx = -1;
  let headers = [];
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const row = lines[i];
    const cols = row.split(',').map(c => c.replace(/^"|"$/g, '').trim().toLowerCase());
    const matchCount = cols.filter(c => knownFieldsLower.has(c)).length;
    console.log(`[CSV-COLLECT] header scan row ${i}: cols=${JSON.stringify(cols)} matchCount=${matchCount}`);
    if (matchCount >= 2) {
      headerIdx = i;
      headers = row.split(',').map(c => c.replace(/^"|"$/g, '').trim());
      console.log('[CSV-COLLECT] ✅ HEADER FOUND at row', i, '->', JSON.stringify(headers));
      break;
    }
  }

  if (headerIdx < 0) {
    console.log('[CSV-COLLECT] ❌ NO HEADER FOUND in first 10 rows!');
  }

  const startRow = headerIdx >= 0 ? headerIdx + 1 : 0;
  console.log('[CSV-COLLECT] parsing data rows from index', startRow, 'to', lines.length - 1);

  // keyMap: lowercased header → output key
  const keyMap = {
    'stand': 'Stand', 'arrivalstand': 'Stand', 'departurestand': 'Stand',
    'runway': 'Runway', 'arrivalrunway': 'Runway', 'departurerunway': 'Runway',
    'departureairport': 'DepartureAirport', 'originairport': 'DepartureAirport', 'departure': 'DepartureAirport',
    'arrivalairport': 'ArrivalAirport', 'destinationairport': 'ArrivalAirport', 'arrival': 'ArrivalAirport',
    'aircrafttype': 'AircraftType',
    'voice': 'Voice',
    'language': 'Language',
    'registration': 'Registration',
    'airway': 'Airway', 'arrivalstar': 'Airway', 'star': 'Airway',
  };

  // Build compat cross-ref: Airline(ICAO) ↔ AircraftType
  const csvCompatAirlineToAircraft = new Map();
  const csvCompatAircraftToAirline = new Map();

  let rowsProcessed = 0;
  for (let i = startRow; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
    if (cols.length < 2) continue;
    rowsProcessed++;

    for (let j = 0; j < cols.length; j++) {
      const val = cols[j];
      if (!val) continue;
      const fieldName = (headers[j] || '').toLowerCase();
      if (keyMap[fieldName]) {
        result[keyMap[fieldName]].add(val);
      }
    }

    // Build registration map & compat cross-ref
    const getVal = (name) => {
      const idx = headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
      return idx >= 0 && idx < cols.length ? cols[idx] : '';
    };
    const reg = getVal('registration');
    const airline = getVal('airline');
    const acType = getVal('aircraftType');
    if (reg && airline && acType) {
      const key = airline + '|' + acType;
      if (!regMap.has(key)) regMap.set(key, new Set());
      regMap.get(key).add(reg);
    }
    // Build compat: airline(ICAO) ↔ aircraftType
    if (airline && acType) {
      if (!csvCompatAirlineToAircraft.has(airline)) csvCompatAirlineToAircraft.set(airline, new Set());
      csvCompatAirlineToAircraft.get(airline).add(acType);
      if (!csvCompatAircraftToAirline.has(acType)) csvCompatAircraftToAirline.set(acType, new Set());
      csvCompatAircraftToAirline.get(acType).add(airline);
    }
  }
  console.log('[CSV-COLLECT] rows processed:', rowsProcessed);

  // Convert Sets to sorted arrays
  const output = {};
  for (const key of Object.keys(result)) {
    if (key === '_voiceOptions') {
      output[key] = [...result[key]].sort((a, b) => a.localeCompare(b));
      continue;
    }
    const arr = [...result[key]];
    const allNumeric = arr.length > 0 && arr.every(v => /^\d+(\.\d+)?$/.test(v));
    if (allNumeric) {
      arr.sort((a, b) => parseFloat(a) - parseFloat(b));
    } else {
      arr.sort((a, b) => a.localeCompare(b));
    }
    output[key] = arr;
  }

  output._registrationMap = {};
  for (const [k, v] of regMap) {
    output._registrationMap[k] = [...v].sort();
  }

  // Build compat from CSV: Airline(ICAO) ↔ AircraftType
  output._compat = { airlineToAircraft: {}, aircraftToAirline: {} };
  for (const [k, v] of csvCompatAirlineToAircraft) {
    output._compat.airlineToAircraft[k] = [...v].sort();
  }
  for (const [k, v] of csvCompatAircraftToAirline) {
    output._compat.aircraftToAirline[k] = [...v].sort();
  }

  // ── DUMP ALL RESULTS ──
  console.log('[CSV-COLLECT] ═══ FINAL RESULTS ═══');
  for (const [k, v] of Object.entries(output)) {
    if (k === '_registrationMap') {
      console.log(`[CSV-COLLECT]   ${k}: ${Object.keys(v).length} keys`);
    } else {
      console.log(`[CSV-COLLECT]   ${k} (${v.length}):`, JSON.stringify(v));
    }
  }
  console.log('═════════════════════════════════════════════════════════');

  return output;
}

/**
 * Load aircraft call signs that have audio clips for a given airport.
 * Reads audio_clips_en.json and returns callsigns grouped by airline.
 * @returns {{ byAirline: Record<string, string[]>, allCallsigns: string[], allAirlines: string[] }}
 */
function loadAudioCallsigns(jsonPath) {
  const empty = { byAirline: {}, allCallsigns: [], allAirlines: [] };
  if (!fs.existsSync(jsonPath)) return empty;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const clips = (data.audioClips || []).filter(c => (c.types || []).includes('AircraftCallSign'));
    const byAirline = {};
    const allCallsigns = [];
    for (const clip of clips) {
      const name = (clip.name || '').trim();
      if (!name) continue;
      allCallsigns.push(name);
      // Airline code = first 3 uppercase letters
      const m = name.match(/^([A-Z]{3})(\S+)/);
      if (m) {
        const code = m[1];
        const num = m[2];
        if (!byAirline[code]) byAirline[code] = [];
        byAirline[code].push(num);
      }
    }
    // Sort numeric parts naturally
    for (const code of Object.keys(byAirline)) {
      byAirline[code].sort((a, b) => {
        const na = parseInt(a, 10), nb = parseInt(b, 10);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });
    }
    const allAirlines = Object.keys(byAirline).sort();
    return { byAirline, allCallsigns, allAirlines };
  } catch (_) {
    return empty;
  }
}

// ─── WorldState.FlightPlans parser (new game format, type 37) ────────

/**
 * Parse WorldState.FlightPlans dictionary $rcontent and extract flight schedule data.
 * Returns { flights, fpData } where fpData contains the raw positions for in-place save patching.
 */
function _parseWorldStateFlightPlans(text) {
  const log = (msg) => console.log('[ACL-FP]', msg);
  log('_parseWorldStateFlightPlans() START');
  const fpIdx = text.indexOf('"FlightPlans"');
  log('FlightPlans index: ' + fpIdx);
  if (fpIdx < 0) return null;

  // Make sure it's inside WorldState, not somewhere else
  const wsIdx = text.indexOf('"WorldState"');
  log('WorldState index: ' + wsIdx + ', fpIdx < wsIdx? ' + (fpIdx < wsIdx));
  if (wsIdx < 0 || fpIdx < wsIdx) return null;

  const afterFP = text.substring(fpIdx);
  const rcMatch = afterFP.match(/"\$rcontent"\s*:\s*\[/);
  log('$rcontent match: ' + !!rcMatch);
  if (!rcMatch) return null;

  const absRcPos = fpIdx + rcMatch.index + rcMatch[0].length;

  // Extract $rlength
  const beforeRcRaw = text.substring(fpIdx, absRcPos);
  const rlMatch = beforeRcRaw.match(/"\$rlength"\s*:\s*(\d+)/);
  const originalLength = rlMatch ? parseInt(rlMatch[1], 10) : 0;
  log('$rlength: ' + originalLength);

  // Find end of FlightPlans $rcontent array
  let depth = 0, endPos = null;
  for (let i = absRcPos; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
        if (j < text.length && text[j] === ']') { endPos = j + 1; break; }
      }
    } else if (c === ']' && depth === 0) { endPos = i + 1; break; }
  }
  log('endPos: ' + endPos);
  if (endPos === null) return null;

  const fpData = {
    fpStart: fpIdx,
    fpBefore: text.substring(0, absRcPos),
    fpAfter: text.substring(endPos),
    fpEntries: [],
    fpRlength: originalLength,
  };

  // Parse individual FlightPlan entries from the $rcontent array
  const arrayContent = text.substring(absRcPos, endPos);
  log('arrayContent length: ' + arrayContent.length);
  depth = 0;
  let entryStart = -1;
  for (let i = 0; i < arrayContent.length; i++) {
    const ch = arrayContent[i];
    if (ch === '{') { if (depth === 0) entryStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && entryStart >= 0) {
        const block = arrayContent.substring(entryStart, i + 1);
        const kMatch = block.match(/"\$k"\s*:\s*"([^"]+)"/);
        const vStart = block.indexOf('"$v"');
        if (vStart >= 0) {
          const colonIdx = block.indexOf(':', vStart);
          const braceIdx = block.indexOf('{', colonIdx);
          let vDepth = 1;
          let vEnd = braceIdx + 1;
          for (; vEnd < block.length; vEnd++) {
            if (block[vEnd] === '{') vDepth++;
            else if (block[vEnd] === '}') { vDepth--; if (vDepth === 0) break; }
          }
          fpData.fpEntries.push({
            k: kMatch ? kMatch[1] : '',
            block: block,
            vBlock: block.substring(braceIdx, vEnd + 1),
            _absStart: absRcPos + entryStart,
            _absEnd: absRcPos + i + 1,
          });
        }
        entryStart = -1;
      }
    }
  }
  log('parsed entries: ' + fpData.fpEntries.length);

  // Convert FlightPlanState entries to our flight record format
  const flights = [];
  for (const entry of fpData.fpEntries) {
    const flight = _parseFlightPlanEntry(entry.vBlock);
    if (flight) flights.push(flight);
  }
  log('converted flights: ' + flights.length);

  if (flights.length === 0) return null;
  return { flights, fpData };
}

/**
 * Parse a single FlightPlanState $v block (type 37) into our flight record format.
 */
function _parseFlightPlanEntry(vBlock) {
  const f = {};

  // Top-level fields
  const regMatch = vBlock.match(/"Registration"\s*:\s*"([^"]*)"/);
  const atMatch = vBlock.match(/"AircraftType"\s*:\s*"([^"]*)"/);
  const alMatch = vBlock.match(/"AirlineName"\s*:\s*"([^"]*)"/);
  const voiceMatch = vBlock.match(/"Voice"\s*:\s*"([^"]*)"/);
  const langMatch = vBlock.match(/"Language"\s*:\s*"([^"]*)"/);

  f._Registration = regMatch ? regMatch[1] : '';
  f.AircraftType = atMatch ? atMatch[1] : '';
  f.AirlineName = alMatch ? alMatch[1] : '';
  f.Voice = voiceMatch ? voiceMatch[1] : '';
  f.Language = langMatch ? langMatch[1] : '';
  f._fpGuid = '';

  // Check Arrival vs Departure
  const arrNull = vBlock.match(/"Arrival"\s*:\s*null/);
  const depNull = vBlock.match(/"Departure"\s*:\s*null/);

  const arrIdx = vBlock.indexOf('"Arrival"');
  const depIdx = vBlock.indexOf('"Departure"');

  if (arrIdx >= 0 && !arrNull) {
    f.isDeparture = false;
    const arrMatch = vBlock.match(/"Arrival"\s*:\s*\{/);
    if (arrMatch) {
      const objStart = arrMatch.index + arrMatch[0].length;
      let aDepth = 1;
      let aEnd = objStart;
      for (; aEnd < vBlock.length; aEnd++) {
        if (vBlock[aEnd] === '{') aDepth++;
        else if (vBlock[aEnd] === '}') { aDepth--; if (aDepth === 0) break; }
      }
      const arrObj = vBlock.substring(objStart, aEnd);

      const csMatch = arrObj.match(/"CallSign"\s*:\s*"([^"]*)"/);
      const origMatch = arrObj.match(/"OriginAirport"\s*:\s*"([^"]*)"/);
      const rwMatch = arrObj.match(/"Runway"\s*:\s*"([^"]*)"/);
      const stMatch = arrObj.match(/"Stand"\s*:\s*"([^"]*)"/);
      const starMatch = arrObj.match(/"STAR"\s*:\s*"([^"]*)"/);
      const ldtMatch = arrObj.match(/"LandingTime"\s*:\s*\{\s*"\$type"\s*:\s*\d+\s*,\s*(-?\d+)\s*\}/);
      const ibtMatch = arrObj.match(/"InBlockTime"\s*:\s*\{\s*"\$type"\s*:\s*\d+\s*,\s*(-?\d+)\s*\}/);

      f.CallSign = csMatch ? csMatch[1] : '';
      f.DepartureAirport = origMatch ? origMatch[1] : '';
      f.ArrivalAirport = '';
      f.Runway = rwMatch ? rwMatch[1] : '';
      f.Stand = stMatch ? stMatch[1] : '';
      f.Airway = starMatch ? starMatch[1] : '';
      f.LandingTime = ldtMatch ? ticksToTime(ldtMatch[1]) : '';
      f.InBlockTime = ibtMatch ? ticksToTime(ibtMatch[1]) : '';
      f.OffBlockTime = '';
      f.TakeoffTime = '';
    }
  } else if (depIdx >= 0 && !depNull) {
    f.isDeparture = true;
    const depMatch = vBlock.match(/"Departure"\s*:\s*\{/);
    if (depMatch) {
      const objStart = depMatch.index + depMatch[0].length;
      let dDepth = 1;
      let dEnd = objStart;
      for (; dEnd < vBlock.length; dEnd++) {
        if (vBlock[dEnd] === '{') dDepth++;
        else if (vBlock[dEnd] === '}') { dDepth--; if (dDepth === 0) break; }
      }
      const depObj = vBlock.substring(objStart, dEnd);

      const csMatch = depObj.match(/"CallSign"\s*:\s*"([^"]*)"/);
      const destMatch = depObj.match(/"DestinationAirport"\s*:\s*"([^"]*)"/);
      const rwMatch = depObj.match(/"Runway"\s*:\s*"([^"]*)"/);
      const stMatch = depObj.match(/"Stand"\s*:\s*"([^"]*)"/);
      const obtMatch = depObj.match(/"OffBlockTime"\s*:\s*\{\s*"\$type"\s*:\s*\d+\s*,\s*(-?\d+)\s*\}/);
      const totMatch = depObj.match(/"TakeoffTime"\s*:\s*\{\s*"\$type"\s*:\s*\d+\s*,\s*(-?\d+)\s*\}/);

      f.CallSign = csMatch ? csMatch[1] : '';
      f.DepartureAirport = '';
      f.ArrivalAirport = destMatch ? destMatch[1] : '';
      f.Runway = rwMatch ? rwMatch[1] : '';
      f.Stand = stMatch ? stMatch[1] : '';
      f.Airway = '';
      f.OffBlockTime = obtMatch ? ticksToTime(obtMatch[1]) : '';
      f.TakeoffTime = totMatch ? ticksToTime(totMatch[1]) : '';
      f.LandingTime = '';
      f.InBlockTime = '';
    }
  } else {
    return null; // skip entries with both null
  }

  return f;
}

/**
 * Sync edited flights back into WorldState.FlightPlans entries (in-place text patching).
 */
function _syncFlightPlans(rawText, flights, fpData, baseDateTicks) {
  if (!fpData || !fpData.fpEntries || fpData.fpEntries.length === 0 || !flights || flights.length === 0) return rawText;
  const bdt = baseDateTicks || FALLBACK_BASE_DATE_TICKS;

  // Build CallSign → flight lookup
  const flightByCallSign = {};
  for (const fl of flights) {
    const cs = (fl.CallSign || '').trim();
    if (cs) flightByCallSign[cs] = fl;
  }

  // Update each FlightPlan entry block
  const newEntryBlocks = [];
  for (const entry of fpData.fpEntries) {
    let newBlock = entry.block;
    const csMatch = entry.vBlock.match(/"CallSign"\s*:\s*"([^"]*)"/);
    if (!csMatch) {
      // Try Registration
      const regMatch = entry.vBlock.match(/"Registration"\s*:\s*"([^"]*)"/);
      if (!regMatch) { newEntryBlocks.push(newBlock); continue; }
      // Match by Registration instead of CallSign
      const reg = regMatch[1];
      const flight = flights.find(f => f._Registration === reg);
      if (flight) newBlock = _applyFlightPlanChanges(newBlock, flight, bdt);
      newEntryBlocks.push(newBlock);
      continue;
    }

    const cs = csMatch[1];
    let flight = flightByCallSign[cs];

    // If CallSign changed, try to find the entry whose old CallSign isn't in the new list
    if (!flight) {
      // Match by Registration fallback
      const regMatch2 = entry.vBlock.match(/"Registration"\s*:\s*"([^"]*)"/);
      if (regMatch2) {
        flight = flights.find(f => f._Registration === regMatch2[1]);
      }
    }

    if (flight) {
      newBlock = _applyFlightPlanChanges(newBlock, flight, bdt);
    }
    newEntryBlocks.push(newBlock);
  }

  // Handle new flights: append to the array by cloning the last entry template
  const existingCount = fpData.fpEntries.length;
  for (let i = existingCount; i < flights.length; i++) {
    const templateBlock = fpData.fpEntries.length > 0 ? fpData.fpEntries[fpData.fpEntries.length - 1].block : null;
    if (templateBlock) {
      const newBlock = _buildFlightPlanBlock(flights[i], templateBlock, bdt);
      newEntryBlocks.push(newBlock);
    }
  }

  // Update $rlength
  let newBefore = fpData.fpBefore;
  const lenMatch = newBefore.match(/"\$rlength"\s*:\s*(\d+)/);
  if (lenMatch) {
    newBefore = newBefore.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${newEntryBlocks.length}`);
  }

  // Make sure section is inside WorldState context
  const beforeWsIdx = newBefore.indexOf('"FlightPlans"');
  let beforeWs = newBefore;
  if (beforeWsIdx >= 0) {
    // Keep everything before FlightPlans (including WorldState header) intact
    // newBefore already starts at FlightPlans position, so it's fine
  }

  // Reconstruct full text: before + entries + after
  // fpAfter contains the rest after FlightPlans $rcontent array
  let finalText = beforeWs + '\n' + newEntryBlocks.join(',\n                ') + '\n' + fpData.fpAfter;

  // Double-check: the fpAfter might start with a closing bracket that already exists
  // or whitespace — the parser captured it precisely, so just concatenate.
  return finalText;
}

/**
 * Apply flight changes to a FlightPlanState entry block (raw text).
 */
function _applyFlightPlanChanges(block, flight, baseDateTicks) {
  // Update top-level fields
  const isDeparture = block.indexOf('"Departure"') >= 0 && !block.match(/"Departure"\s*:\s*null/);
  const isArrival = block.indexOf('"Arrival"') >= 0 && !block.match(/"Arrival"\s*:\s*null/);

  block = _applyWsField(block, 'Registration', flight._Registration || '', 'string');
  block = _applyWsField(block, 'AircraftType', flight.AircraftType || '', 'string');
  block = _applyWsField(block, 'AirlineName', flight.AirlineName || '', 'string');
  block = _applyWsField(block, 'Voice', flight.Voice || '', 'string');
  block = _applyWsField(block, 'Language', flight.Language || '', 'string');

  if (isDeparture) {
    const depMatch = block.match(/"Departure"\s*:\s*\{/);
    if (depMatch) {
      const depStart = depMatch.index + depMatch[0].length;
      let depDepth = 1;
      let depEnd = depStart;
      for (; depEnd < block.length; depEnd++) {
        if (block[depEnd] === '{') depDepth++;
        else if (block[depEnd] === '}') { depDepth--; if (depDepth === 0) break; }
      }
      let depObj = block.substring(depStart, depEnd);

      depObj = _applyWsField(depObj, 'CallSign', flight.CallSign || '', 'string');
      depObj = _applyWsField(depObj, 'DestinationAirport', flight.ArrivalAirport || '', 'string');
      depObj = _applyWsField(depObj, 'Runway', flight.Runway || '', 'string');
      depObj = _applyWsField(depObj, 'Stand', flight.Stand || '', 'string');
      depObj = _applyWsField(depObj, 'OffBlockTime', ticksToString(timeToTicks(flight.OffBlockTime || '', baseDateTicks)), 'ticks');
      depObj = _applyWsField(depObj, 'TakeoffTime', ticksToString(timeToTicks(flight.TakeoffTime || '', baseDateTicks)), 'ticks');

      block = block.substring(0, depStart) + depObj + block.substring(depEnd);
    }
  } else if (isArrival) {
    const arrMatch = block.match(/"Arrival"\s*:\s*\{/);
    if (arrMatch) {
      const arrStart = arrMatch.index + arrMatch[0].length;
      let arrDepth = 1;
      let arrEnd = arrStart;
      for (; arrEnd < block.length; arrEnd++) {
        if (block[arrEnd] === '{') arrDepth++;
        else if (block[arrEnd] === '}') { arrDepth--; if (arrDepth === 0) break; }
      }
      let arrObj = block.substring(arrStart, arrEnd);

      arrObj = _applyWsField(arrObj, 'CallSign', flight.CallSign || '', 'string');
      arrObj = _applyWsField(arrObj, 'OriginAirport', flight.DepartureAirport || '', 'string');
      arrObj = _applyWsField(arrObj, 'Runway', flight.Runway || '', 'string');
      arrObj = _applyWsField(arrObj, 'Stand', flight.Stand || '', 'string');
      arrObj = _applyWsField(arrObj, 'STAR', flight.Airway || '', 'string');
      arrObj = _applyWsField(arrObj, 'LandingTime', ticksToString(timeToTicks(flight.LandingTime || '', baseDateTicks)), 'ticks');
      arrObj = _applyWsField(arrObj, 'InBlockTime', ticksToString(timeToTicks(flight.InBlockTime || '', baseDateTicks)), 'ticks');

      block = block.substring(0, arrStart) + arrObj + block.substring(arrEnd);
    }
  }

  return block;
}

/**
 * Build a new FlightPlan entry by cloning a template and replacing its values.
 */
function _buildFlightPlanBlock(flight, templateBlock, baseDateTicks) {
  if (!templateBlock) return '{}';
  // Clone and apply changes
  return _applyFlightPlanChanges(templateBlock, flight, baseDateTicks);
}

module.exports = {
  loadFlights, saveFlights, generateFullAcl, exportCSV, exportGameCSV, importCsvFromFile, generateAclFromCsv,
  collectUniqueValues, collectUniqueValuesFromCSV, mergeAudioCallsigns, getFileInfo, loadAudioCallsigns,
  _parseFlightSchedule, _parseWorldStateData, _parseSceneryData, _extractFlightsFromWorldState,
  _parseWorldStateFlightPlans, _parseFlightPlanEntry, _syncFlightPlans,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS
};
