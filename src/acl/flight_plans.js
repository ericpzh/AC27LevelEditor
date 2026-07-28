/**
 * ACL FlightPlans parser â€” new game format (type 37/52), ArrivalLeg (type 58), DepartureLeg (type 57).
 *
 * Parse path uses the tokenizer for string-aware boundary finding and the
 * pre-processor + JSON.parse for section content. Write/rebuild path still
 * uses string concatenation (to be migrated to serializer in follow-up).
 */
const fs = require('fs');
const path = require('path');
const { FALLBACK_BASE_DATE_TICKS, APPROACH_MIN_TTL, WARMUP_SEC, GRACE_TTL, TYPE_NUM_FALLBACK_START, ID_OFFSET_FLIGHTPLAN, ID_OFFSET_AIRCRAFT, ID_OFFSET_ANIMATOR, CMD_CONTACT_TOWER, CMD_CLEARED_TO_LAND, DEFAULT_RUNWAY_TAKEOFF_LENGTH, DEFAULT_MODEL_OFFSET, DEFAULT_WAKE_CATEGORY, DEFAULT_RUNWAY_VR_SPEED, TICKS_PER_SECOND_NUM, DEPARTURE_TAXI_SECONDS, ARRIVAL_TAXI_SECONDS, TAXI_SPEED, POSITIVE_TAXI_ACCEL, NEGATIVE_TAXI_ACCEL } = require('./constants');
const { ticksToTime, timeToTicks, _extractBaseDateFromText } = require('../utils/timeUtils');
const { _generateGuid } = require('./world_state');
const { computeProgressRatio, computePathLength, resolveFlyApproachPoints, buildApproachAircraftBlock, buildState5AircraftBlock, buildAnimatorBlock, extractGameTime, computeApproachCap, computePosition, computeDirection, _vec3Sub, _vec3Normalize, _vec3Dist, _detectSchemaVersion } = require('./approach');
const { createTokenizer } = require('./tokenizer');
const { preprocessUnityJson, serializeUnityJson, parseOdinObject } = require('./acl_json');
const { readAclText, writeAcl } = require('./gatcarc');
// resolveConfigTime imported lazily inside _rebuildWorldStateSections
// to avoid circular dependency: config.js requires flight_plans.js for _extractConfig

/**
 * Compute _departureTakeoffTime ticks, falling back to OffBlockTime + taxi-constant
 * when TakeoffTime is empty/0 (the v4 default, where the game computes it dynamically).
 *
 * @param {string|number} takeoffTime â€” TakeoffTime value (HH:MM:SS, ticks string, or falsy)
 * @param {string|number} offBlockTime â€” OffBlockTime value (HH:MM:SS or ticks string)
 * @param {number|string} baseDateTicks â€” base date ticks for this scenario
 * @param {string} [icao] â€” airport ICAO code for per-airport taxi override
 * @returns {string} ticks string, or '0' if no data available
 */
function _computeTakeoffTicks(takeoffTime, offBlockTime, baseDateTicks, icao) {
  const bdt = BigInt(baseDateTicks || FALLBACK_BASE_DATE_TICKS);
  const _toTicks = (t) => {
    if (!t) return 0n;
    const s = String(t);
    if (/^\d+$/.test(s)) return BigInt(s);
    const p = s.split(':');
    const sec = +p[0] * 3600 + (+p[1] || 0) * 60 + (+p[2] || 0);
    return bdt + BigInt(Math.round(sec * 10000000));
  };
  // If TakeoffTime is set (non-empty, non-zero), use it
  if (takeoffTime) {
    const ticks = _toTicks(takeoffTime);
    if (ticks !== 0n) return String(ticks);
  }
  // Fallback: OffBlockTime + per-airport taxi constant
  const obTicks = _toTicks(offBlockTime || 0);
  if (obTicks === 0n) return '0';
  const key = (icao || '').toUpperCase();
  const taxiSec = DEPARTURE_TAXI_SECONDS[key] ?? DEPARTURE_TAXI_SECONDS.default;
  const taxiTicksNum = taxiSec * TICKS_PER_SECOND_NUM;
  return String(obTicks + BigInt(taxiTicksNum));
}

/**
 * Compute _arrivalInBlockTime ticks, falling back to LandingTime + taxi-constant
 * when InBlockTime is empty/0 (the v4 default, where the game computes it dynamically).
 *
 * @param {string|number} landingTime â€” LandingTime value (HH:MM:SS, ticks string, or falsy)
 * @param {string|number} inBlockTime â€” InBlockTime value (HH:MM:SS, ticks string, or falsy)
 * @param {number|string|bigint} baseDateTicks â€” base date ticks for this scenario
 * @param {string} [icao] â€” airport ICAO code for per-airport taxi override
 * @returns {string} ticks string, or '0' if no data available
 */
function _computeArrivalInBlockTicks(landingTime, inBlockTime, baseDateTicks, icao) {
  const bdt = (baseDateTicks != null) ? BigInt(baseDateTicks) : BigInt(FALLBACK_BASE_DATE_TICKS);
  const _toTicks = (t) => {
    if (!t) return 0n;
    const s = String(t);
    if (/^\d+$/.test(s)) return BigInt(s);
    const p = s.split(':');
    const sec = +p[0] * 3600 + (+p[1] || 0) * 60 + (+p[2] || 0);
    return bdt + BigInt(Math.round(sec * 10000000));
  };
  // If InBlockTime is set (non-empty, non-zero), use it
  if (inBlockTime) {
    const ticks = _toTicks(inBlockTime);
    if (ticks !== 0n) return String(ticks);
  }
  // Fallback: LandingTime + per-airport taxi-in constant
  const ltTicks = _toTicks(landingTime || 0);
  if (ltTicks === 0n) return '0';
  const key = (icao || '').toUpperCase();
  const taxiSec = ARRIVAL_TAXI_SECONDS[key] ?? ARRIVAL_TAXI_SECONDS.default;
  const taxiTicksNum = taxiSec * TICKS_PER_SECOND_NUM;
  return String(ltTicks + BigInt(taxiTicksNum));
}

// â”€â”€â”€ Parse WorldState.FlightPlans â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


/**
 * Convert HH:MM:SS time string to seconds since midnight.
 * @param {string} t - time string like "14:15:00"
 * @returns {number} seconds since midnight, or 0 if invalid
 */
function _timeStrToSeconds(t) {
  if (!t) return 0;
  const p = String(t).split(":");
  return +p[0] * 3600 + +p[1] * 60 + (+p[2] || 0);
}

function _parseWorldStateFlightPlans(text, isV4) {
  const log = (msg) => console.log('[ACL-FP]', msg);
  log('_parseWorldStateFlightPlans() START');

  // Auto-detect for backward compat with callers that don't pass isV4
  if (isV4 === undefined) {
    isV4 = _detectSchemaVersion(text) === 4;
  }

  // v4 schema: use StaticData.$blobdoc.StaticItems path
  if (isV4) {
    return _parseStaticDataFlightPlans(text);
  }

  // v2/v3 schema: FlightPlans inside WorldState
  const t = createTokenizer(text);
  const wsSec = t.findSection('WorldState');
  if (!wsSec) {
    log('WorldState NOT FOUND');
    return null;
  }

  // Find FlightPlans within WorldState
  const wsText = t.substring(wsSec.valueStart, wsSec.valueEnd);
  const wsT = createTokenizer(wsText);
  const fpSec = wsT.findSection('FlightPlans');
  if (!fpSec) { log('FlightPlans NOT FOUND inside WorldState'); return null; }

  // Parse FlightPlans section: find $rcontent array (string-aware)
  const fpText = wsT.substring(fpSec.valueStart, fpSec.valueEnd);
  const fpT = createTokenizer(fpText);

  const rcSec = fpT.findSection('$rcontent');
  if (!rcSec) { log('$rcontent NOT FOUND'); return null; }

  // $rcontent is an array that starts with [
  const rcStart = rcSec.valueStart;
  if (fpText[rcStart] !== '[') { log('$rcontent value is not an array'); return null; }

  // Find end of $rcontent array (string-aware)
  const rcEnd = fpT.findArrayEnd(rcStart);
  if (rcEnd === null) { log('cannot find $rcontent end'); return null; }

  // Extract $rlength â€” v2/v3 regex (byte-identical to original editor output)
  const rlMatch = fpText.match(/"\$rlength"\s*:\s*(\d+)/);
  const originalLength = rlMatch ? parseInt(rlMatch[1], 10) : 0;
  log('$rlength: ' + originalLength);

  // Absolute positions in original text
  const absFpStart = wsSec.valueStart + fpSec.keyStart;
  const absRcPos = wsSec.valueStart + fpSec.valueStart + rcStart;
  const fpEnd = wsSec.valueStart + fpSec.valueStart + rcEnd;

  const fpData = {
    fpStart: absFpStart,
    fpBefore: text.substring(0, absRcPos),
    fpAfter: text.substring(fpEnd),
    fpEntries: [],
    fpRlength: originalLength,
  };

  // Parse $rcontent entries using string-aware tokenizer
  const arrayContent = text.substring(absRcPos, fpEnd);
  const arrayT = createTokenizer(arrayContent);

  // The $rcontent array contains $k/$v dictionary entries as objects
  // Each entry: { "$k": "guid", "$v": { ... } }
  _parseDictEntriesToFpData(arrayContent, arrayT, fpData, absRcPos);

  log('parsed entries: ' + fpData.fpEntries.length);

  const flights = [];
  for (const entry of fpData.fpEntries) {
    const flight = _parseFlightPlanEntry(entry.vBlock, false);
    if (flight) flights.push(flight);
  }
  log('converted flights: ' + flights.length);

  if (flights.length === 0) return null;
  return { flights, fpData };
}

// â”€â”€â”€ Parse v4 StaticData.$blobdoc.StaticItems â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _parseStaticDataFlightPlans(text) {
  const log = (msg) => console.log('[ACL-FP]', msg);

  // Navigate: StaticData â†’ $blobdoc â†’ StaticItems â†’ $rcontent
  const t = createTokenizer(text);
  const sdSec = t.findSection('StaticData');
  if (!sdSec) { log('StaticData NOT FOUND'); return null; }

  const sdText = t.substring(sdSec.valueStart, sdSec.valueEnd);
  const sdT = createTokenizer(sdText);

  // Find $blobdoc (the decoded nested binary document)
  const bdSec = sdT.findSection('$blobdoc');
  if (!bdSec) { log('$blobdoc NOT FOUND inside StaticData'); return null; }

  const bdText = sdT.substring(bdSec.valueStart, bdSec.valueEnd);
  const bdT = createTokenizer(bdText);

  // Find StaticItems (the dictionary of static items including flight-plan entries)
  const siSec = bdT.findSection('StaticItems');
  if (!siSec) { log('StaticItems NOT FOUND inside $blobdoc'); return null; }

  const siText = bdT.substring(siSec.valueStart, siSec.valueEnd);
  const siT = createTokenizer(siText);

  // Find $rcontent array
  const rcSec = siT.findSection('$rcontent');
  if (!rcSec) { log('$rcontent NOT FOUND in StaticItems'); return null; }

  const rcStart = rcSec.valueStart;
  if (siText[rcStart] !== '[') { log('$rcontent value is not an array'); return null; }

  const rcEnd = siT.findArrayEnd(rcStart);
  if (rcEnd === null) { log('cannot find $rcontent end'); return null; }

  // Extract $rlength â€” structural, no regex
  const rlSec = siT.findSection('$rlength');
  const originalLength = rlSec ? parseInt(siText.substring(rlSec.valueStart, rlSec.valueEnd), 10) : 0;
  log('StaticItems $rlength: ' + originalLength);

  // Absolute positions in original text
  const absSdStart = sdSec.valueStart;
  const absBdStart = absSdStart + bdSec.valueStart;
  const absSiStart = absBdStart + siSec.valueStart;
  const absRcPos = absSiStart + rcStart;
  const absRcEnd = absSiStart + rcEnd;

  const fpData = {
    fpStart: absSiStart,
    fpBefore: text.substring(0, absRcPos),
    fpAfter: text.substring(absRcEnd),
    fpEntries: [],
    fpRlength: originalLength,
    _isV4: true,
  };

  // Parse $rcontent entries â€” same $k/$v structure as old format
  const arrayContent = text.substring(absRcPos, absRcEnd);
  const arrayT = createTokenizer(arrayContent);

  // Parse all entries, then filter to flight-plan: entries only
  _parseDictEntriesToFpData(arrayContent, arrayT, fpData, absRcPos);

  log('parsed StaticItems entries (all types): ' + fpData.fpEntries.length);

  // Filter to flight-plan entries only (keys start with "flight-plan:")
  const flightEntries = fpData.fpEntries.filter(e => e.k && e.k.startsWith('flight-plan:'));
  log('flight-plan entries: ' + flightEntries.length);

  const flights = [];
  for (const entry of flightEntries) {
    const flight = _parseFlightPlanEntry(entry.vBlock, true);
    if (flight) {
      // Extract the flight plan GUID from the key (format: "flight-plan:REGISTRATION")
      flight._fpGuid = entry.k;
      flights.push(flight);
    }
  }
  log('converted flights: ' + flights.length);

  if (flights.length === 0) return null;
  // Replace fpEntries with filtered set for save/rebuild
  fpData.fpEntries = flightEntries;
  return { flights, fpData };
}

/**
 * Parse $k/$v dictionary entries from a $rcontent array into fpData.fpEntries.
 * Uses string-aware tokenizer for block boundary finding.
 */
function _parseDictEntriesToFpData(content, contentT, fpData, baseOffset) {
  // Find all $k entries
  const kRe = /"\$k"\s*:\s*"([^"]+)"/g;
  let km;
  while ((km = kRe.exec(content)) !== null) {
    const k = km[1];

    // Find the $v block for this entry
    const vKeyIdx = content.indexOf('"$v"', km.index);
    if (vKeyIdx < 0) continue;

    const colonIdx = content.indexOf(':', vKeyIdx);
    if (colonIdx < 0) continue;

    let vBlockStart = colonIdx + 1;
    while (vBlockStart < content.length && ' \t\n\r'.includes(content[vBlockStart])) vBlockStart++;
    if (vBlockStart >= content.length || content[vBlockStart] !== '{') continue;

    const vBlockEnd = contentT.findObjectEnd(vBlockStart);
    if (vBlockEnd === null) continue;

    // Find the block end (the entire { "$k": ..., "$v": ... } object)
    // Walk backward from km.index to find the opening {
    let blockStart = km.index;
    while (blockStart > 0 && content[blockStart] !== '{') blockStart--;

    fpData.fpEntries.push({
      k,
      block: content.substring(blockStart, vBlockEnd),
      vBlock: content.substring(vBlockStart, vBlockEnd),
      _absStart: baseOffset + blockStart,
      _absEnd: baseOffset + vBlockEnd,
    });
  }
}

// â”€â”€â”€ Parse single FlightPlanState entry (type 37) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _parseFlightPlanEntry(vBlock, isV4) {
  try {
    const cleaned = preprocessUnityJson(vBlock);
    const obj = JSON.parse(cleaned);
    return _extractFlightFromParsed(obj, isV4);
  } catch (e) {
    // Fallback to regex extraction for compatibility
    return _parseFlightPlanEntryRegex(vBlock, isV4);
  }
}

/**
 * Extract flight data from a parsed FlightPlanState object.
 * The object was produced by pre-processor + JSON.parse, so DateTime
 * fields have __v sentinel arrays (e.g., { "$type": 3, "__v": ["<ticks>"] }).
 */
function _extractFlightFromParsed(obj, isV4) {
  const f = {};

  f._Registration = obj.Registration || '';
  f.AircraftType = obj.AircraftType || '';
  f.AirlineName = obj.AirlineName || '';
  f.Voice = obj.Voice || '';
  f.Language = obj.Language || '';
  f._fpGuid = '';

  // v4 schema uses InitialArrival/InitialDeparture; v2/v3 uses Arrival/Departure
  const arrLeg = isV4 ? obj.InitialArrival : obj.Arrival;
  const depLeg = isV4 ? obj.InitialDeparture : obj.Departure;

  if (arrLeg && arrLeg !== null) {
    f.isDeparture = false;
    f.CallSign = arrLeg.CallSign || '';
    f.DepartureAirport = arrLeg.OriginAirport || '';
    f.ArrivalAirport = '';
    f.Runway = arrLeg.Runway || '';
    f.Stand = arrLeg.Stand || '';
    f.Airway = arrLeg.STAR || '';

    // DateTime fields have __v sentinel from pre-processor
    const ldt = arrLeg.LandingTime;
    if (ldt && ldt.__v && ldt.__v.length > 0) {
      f.LandingTime = ticksToTime(ldt.__v[0]);
    } else {
      f.LandingTime = '';
    }
    const ibt = arrLeg.InBlockTime;
    if (ibt && ibt.__v && ibt.__v.length > 0) {
      f.InBlockTime = ticksToTime(ibt.__v[0]);
    } else {
      f.InBlockTime = '';
    }
    f.OffBlockTime = '';
    f.TakeoffTime = '';
  } else if (depLeg && depLeg !== null) {
    f.isDeparture = true;
    f.CallSign = depLeg.CallSign || '';
    f.DepartureAirport = '';
    f.ArrivalAirport = depLeg.DestinationAirport || '';
    f.Runway = depLeg.Runway || '';
    f.Stand = depLeg.Stand || '';
    f.Airway = '';

    const obt = depLeg.OffBlockTime;
    if (obt && obt.__v && obt.__v.length > 0) {
      f.OffBlockTime = ticksToTime(obt.__v[0]);
    } else {
      f.OffBlockTime = '';
    }
    const tot = depLeg.TakeoffTime;
    if (tot && tot.__v && tot.__v.length > 0) {
      f.TakeoffTime = ticksToTime(tot.__v[0]);
    } else {
      f.TakeoffTime = '';
    }
    f.LandingTime = '';
    f.InBlockTime = '';
  } else {
    return null;
  }

  return f;
}

/**
 * Legacy regex-based fallback for _parseFlightPlanEntry.
 * Kept for backward compatibility with edge-case ACL files that
 * can't be parsed by the pre-processor + JSON.parse path.
 */
function _parseFlightPlanEntryRegex(vBlock, isV4) {
  const f = {};

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

  // v4 uses InitialArrival/InitialDeparture; v2/v3 uses Arrival/Departure
  const arrField = isV4 ? 'InitialArrival' : 'Arrival';
  const depField = isV4 ? 'InitialDeparture' : 'Departure';
  const arrNull = vBlock.match(new RegExp('"' + arrField + '"\\s*:\\s*null'));
  const depNull = vBlock.match(new RegExp('"' + depField + '"\\s*:\\s*null'));
  const arrIdx = vBlock.indexOf('"' + arrField + '"');
  const depIdx = vBlock.indexOf('"' + depField + '"');
  const hasArrival = arrIdx >= 0 && !arrNull;
  const hasDeparture = depIdx >= 0 && !depNull;

  if (hasArrival) {
    f.isDeparture = false;
    const arrMatch = vBlock.match(new RegExp('"' + arrField + '"\\s*:\\s*\\{'));
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
  } else if (hasDeparture) {
    f.isDeparture = true;
    const depMatch = vBlock.match(new RegExp('"' + depField + '"\\s*:\\s*\\{'));
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
    return null;
  }

  return f;
}


// â”€â”€â”€ Build FlightPlan Arrival leg (type 58) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _buildFlightPlanArrivalLeg(flight, id, baseDateTicks, arrTypeNum) {
  const legId = id + 1;
  const bdt = baseDateTicks || FALLBACK_BASE_DATE_TICKS;
  const cs = (flight.CallSign || '').trim();
  const origin = (flight.DepartureAirport || '');
  const runway = (flight.Runway || '');
  const stand = (flight.Stand || '');
  const star = (flight.Airway || '');
  const landingTicks = timeToTicks(flight.LandingTime || '', bdt);
  const inBlockTicks = timeToTicks(flight.InBlockTime || '', bdt);
  const atn = arrTypeNum || 58;

  const lines = [];
  lines.push('                            {');
  lines.push(`                                "$id": ${legId},`);
  lines.push(`                                "$type": "${atn}|ContextCross.States.FlightPlanArrivalLegState, GroundATC.Core",`);
  if (cs) lines.push(`                                "CallSign": "${cs}",`);
  if (origin) lines.push(`                                "OriginAirport": "${origin}",`);
  lines.push(`                                "LandingTime": { "$type": 3, ${landingTicks} },`);
  lines.push(`                                "InBlockTime": { "$type": 3, ${inBlockTicks} },`);
  if (runway) lines.push(`                                "Runway": "${runway}",`);
  if (stand) lines.push(`                                "Stand": "${stand}",`);
  if (star) lines.push(`                                "STAR": "${star}",`);
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  lines.push('                            }');
  return lines.join('\n');
}

// â”€â”€â”€ Build FlightPlan Departure leg (type 57) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _buildFlightPlanDepartureLeg(flight, id, baseDateTicks, depTypeNum) {
  const legId = id + 1;
  const bdt = baseDateTicks || FALLBACK_BASE_DATE_TICKS;
  const cs = (flight.CallSign || '').trim();
  const dest = (flight.ArrivalAirport || '');
  const runway = (flight.Runway || '');
  const stand = (flight.Stand || '');
  const obTicks = timeToTicks(flight.OffBlockTime || '', bdt);
  const totTicks = timeToTicks(flight.TakeoffTime || '', bdt);
  const dtn = depTypeNum || 57;

  const lines = [];
  lines.push('                            {');
  lines.push(`                                "$id": ${legId},`);
  lines.push(`                                "$type": "${dtn}|ContextCross.States.FlightPlanDepartureLegState, GroundATC.Core",`);
  if (cs) lines.push(`                                "CallSign": "${cs}",`);
  if (dest) lines.push(`                                "DestinationAirport": "${dest}",`);
  lines.push(`                                "OffBlockTime": { "$type": 3, ${obTicks} },`);
  lines.push(`                                "TakeoffTime": { "$type": 3, ${totTicks} },`);
  if (runway) lines.push(`                                "Runway": "${runway}",`);
  if (stand) lines.push(`                                "Stand": "${stand}",`);
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  lines.push('                            }');
  return lines.join('\n');
}

// â”€â”€â”€ Rebuild WorldState.FlightPlans & Aircrafts from scratch â”€â”€

function _rebuildWorldStateSections(aclPath, flights, baseDateTicks, approachCache, aclcfgStartTime, _saveSec) {
  const log = (msg) => console.log('[ACL-REBUILD]', msg);
  const text = readAclText(aclPath);
  const bdt = baseDateTicks || _extractBaseDateFromText(text);
  // Extract ICAO from path: .../Airports/<ICAO>/Levels/...
  const icaoMatch = aclPath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
  const icao = icaoMatch ? icaoMatch[1] : '';
  // Fallback: read startTime from ACL's Config block if not passed
  // Lazy require to avoid circular dependency (config.js â†’ flight_plans.js â†’ config.js)
  if (!aclcfgStartTime) {
    try {
      const { resolveConfigTime } = require('./config');
      const config = resolveConfigTime(text);
      if (config && config.startTime) {
        aclcfgStartTime = config.startTime;
      }
    } catch (_) {}
  }
  log('baseDateTicks: ' + bdt + '  flights: ' + (flights ? flights.length : 0) + ' approachCache: ' + (approachCache ? (approachCache.appPointMap ? approachCache.appPointMap.size : 0) + ' combos' : 'null') + ' startTime: ' + aclcfgStartTime + ' icao: ' + icao);

  // Build type map from ALL full $type declarations in the original file.
  // Preserved segments (segBefore, segAfter) may contain short-form "$type": N
  // references to types whose full declarations live ONLY inside the Aircrafts
  // section (which gets replaced). Capturing these full declarations here lets
  // us expand short-form refs in preserved segments so type resolution survives
  // the Aircrafts rebuild.
  //
  // Type numbers are per-file in Unity's JSON serialization â€” each .acl file gets
  // its own assignments. We seed from the current file first (ground truth), then
  // fill in missing types from the per-file cache (built during initial scan).
  // This survives repeated saves because the cache preserves the original file's
  // type declarations even after non-approach entries are stripped.
  const typeMap = new Map();
  const typeDeclRegex = /"\$type":\s*"(\d+)\|([^"]+)"/g;
  let tdMatch;
  while ((tdMatch = typeDeclRegex.exec(text)) !== null) {
    const num = parseInt(tdMatch[1], 10);
    if (!typeMap.has(num)) {
      typeMap.set(num, tdMatch[2]);
    }
  }
  const typeMapFromFile = typeMap.size;
  // Merge file-specific cached typeMap â€” current file wins (its type declarations
  // are the ground truth), cache fills in types that were lost from prior saves.
  const fileKey = path.basename(aclPath);
  if (approachCache && approachCache.fileTypeMaps) {
    const cachedFileTypes = approachCache.fileTypeMaps.get(fileKey);
    if (cachedFileTypes) {
      for (const [k, v] of cachedFileTypes) {
        if (!typeMap.has(k)) typeMap.set(k, v);
      }
    }
  }
  log('typeMap: ' + typeMap.size + ' type declarations (' + typeMapFromFile + ' from file, ' + (typeMap.size - typeMapFromFile) + ' from cache)');

  // Compute the next available type number for types not found in the file.
  // This guarantees unique numbers â€” no collision with existing types or each other.
  let nextFallbackNum = TYPE_NUM_FALLBACK_START; // above BCL types (0-99)
  for (const num of typeMap.keys()) {
    if (num >= nextFallbackNum) nextFallbackNum = num + 1;
  }

  // Resolve all type numbers needed by builders from the per-file typeMap.
  // This replaces hardcoded numbers that vary between airports and game versions.
  const _tn = (search) => {
    for (const [num, fullName] of typeMap) {
      // Skip generic collection type DECLARATIONS (e.g. Dictionary`2[[...,[AircraftState,...]],...])
      // ONLY when the search itself is not targeting a generic type. Searches for
      // `List`1[[...` or similar generic types contain a backtick and must be allowed
      // through, otherwise List<Vector3> types silently fall back to a colliding default.
      if (fullName.startsWith('System.Collections.Generic') && !search.includes('`')) continue;
      // Legacy exact-substring match (v2/v3 compatibility â€” byte-identical output)
      if (fullName.includes(search)) return num;
    }
    return null;
  };
  const typeNums = {
    acType:           _tn('ContextCross.States.AircraftState,')           || nextFallbackNum++,
    spec:             _tn('ContextCross.States.AircraftSpecificationState,') || nextFallbackNum++,
    dynInternal:      _tn('ContextCross.Dynamics.DynamicInternalState,')   || nextFallbackNum++,
    dynParams:        _tn('ContextCross.Dynamics.States.FlyApproachDynamicsParams,') || nextFallbackNum++,
    acRwy:            _tn('ContextCross.States.AircraftRunwayCoordinateState,') || nextFallbackNum++,
    float3:           _tn('Unity.Mathematics.float3,')                    || nextFallbackNum++,
    vec4:             _tn('UnityEngine.Vector4,')                         || nextFallbackNum++,
    vec4Arr:          _tn('UnityEngine.Vector4[],')                       || nextFallbackNum++,
    waitCmd:          _tn('ContextCross.Enums.ECommand[],')               || nextFallbackNum++,
    recvEvt:          _tn('ContextCross.Events.AircraftEvent[],')         || nextFallbackNum++,
    approachDynParams: _tn('ContextCross.Dynamics.States.ApproachDynamicsParams,') || nextFallbackNum++,
    listVec3:         _tn('List`1[[UnityEngine.Vector3,')                 || nextFallbackNum++,
    animState:        _tn('ContextCross.States.AircraftAnimatorState,')   || nextFallbackNum++,
    animSubState:     _tn('ContextCross.States.AircraftAnimState,')       || nextFallbackNum++,
    fpState:          _tn('ContextCross.States.FlightPlanState,')         || nextFallbackNum++,
    fpArrLeg:         _tn('ContextCross.States.FlightPlanArrivalLegState,') || nextFallbackNum++,
    fpDepLeg:         _tn('ContextCross.States.FlightPlanDepartureLegState,') || nextFallbackNum++,
  };
  log('typeNums: acType=' + typeNums.acType + ' listVec3=' + typeNums.listVec3 + ' animState=' + typeNums.animState + ' animSub=' + typeNums.animSubState + ' fpState=' + typeNums.fpState + ' fpArrLeg=' + typeNums.fpArrLeg + ' fpDepLeg=' + typeNums.fpDepLeg);

  if (!flights || flights.length === 0) {
    log('WARNING: empty flights array, skipping rebuild');
    return;
  }

  // 1. Locate WorldState
  const wsIdx = text.indexOf('"WorldState"');
  if (wsIdx < 0) { log('ERROR: no WorldState section found'); return; }

  // 2. Locate Aircrafts $rcontent boundaries
  const wsText = text.substring(wsIdx);
  const acIdx = wsText.indexOf('"Aircrafts"');
  if (acIdx < 0) { log('ERROR: no Aircrafts section in WorldState'); return; }
  const acFullIdx = wsIdx + acIdx;

  const acSection = text.substring(acFullIdx);
  const acRcMatch = acSection.match(/"\$rcontent"\s*:\s*\[/);
  if (!acRcMatch) { log('ERROR: cannot find Aircrafts $rcontent'); return; }
  const acContentStart = acFullIdx + acRcMatch.index + acRcMatch[0].length;

  let depth = 0, acContentEnd = null;
  for (let i = acContentStart; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ']' && depth === 0) { acContentEnd = i + 1; break; }
  }
  if (acContentEnd === null) { log('ERROR: cannot find Aircrafts $rcontent end'); return; }
  log('Aircrafts $rcontent: ' + acContentStart + ' â†’ ' + acContentEnd);

  // 3. Locate FlightPlans $rcontent boundaries
  const acAfter = text.substring(acContentEnd);
  const fpIdx = acAfter.indexOf('"FlightPlans"');
  if (fpIdx < 0) { log('ERROR: no FlightPlans section after Aircrafts'); return; }
  const fpFullIdx = acContentEnd + fpIdx;

  const fpSection = text.substring(fpFullIdx);
  const fpRcMatch = fpSection.match(/"\$rcontent"\s*:\s*\[/);
  if (!fpRcMatch) { log('ERROR: cannot find FlightPlans $rcontent'); return; }
  const fpContentStart = fpFullIdx + fpRcMatch.index + fpRcMatch[0].length;

  depth = 0; let fpContentEnd = null;
  for (let i = fpContentStart; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ']' && depth === 0) { fpContentEnd = i + 1; break; }
  }
  if (fpContentEnd === null) { log('ERROR: cannot find FlightPlans $rcontent end'); return; }
  log('FlightPlans $rcontent: ' + fpContentStart + ' â†’ ' + fpContentEnd);

  // FlightPlan type numbers resolved from per-file typeMap (see typeNums above).
  // This replaces the old regex-based extraction from the original FlightPlans
  // content; the typeMap lookup is simpler and shares the same source of truth.
  const _fpTypeNum = typeNums.fpState;
  const _fpArrTypeNum = typeNums.fpArrLeg;
  const _fpDepTypeNum = typeNums.fpDepLeg;
  log('FlightPlans type numbers: FlightPlanState=' + _fpTypeNum + ' ArrivalLeg=' + _fpArrTypeNum + ' DepartureLeg=' + _fpDepTypeNum);

  // 4. Build segments â€” also locate AircraftAnimators $rcontent between Aircrafts and FlightPlans
  let segBefore = text.substring(0, acContentStart);
  const betweenText = text.substring(acContentEnd, fpContentStart);
  let segAfter = text.substring(fpContentEnd);

  // 4a. Find AircraftAnimators $rcontent in betweenText
  const aaIdx = betweenText.indexOf('"AircraftAnimators"');
  let aaRcStart = -1, aaRcEnd = -1;
  let preAnimators = betweenText, postAnimators = '';
  if (aaIdx >= 0) {
    const aaSection = betweenText.substring(aaIdx);
    const aaRcMatch = aaSection.match(/"\$rcontent"\s*:\s*\[/);
    if (aaRcMatch) {
      aaRcStart = aaIdx + aaRcMatch.index + aaRcMatch[0].length;
      let depth = 0;
      for (let i = aaRcStart; i < betweenText.length; i++) {
        const c = betweenText[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === ']' && depth === 0) { aaRcEnd = i + 1; break; }
      }
      if (aaRcEnd >= 0) {
        preAnimators = betweenText.substring(0, aaRcStart);
        postAnimators = betweenText.substring(aaRcEnd);
        log('AircraftAnimators $rcontent: ' + aaRcStart + ' â†’ ' + aaRcEnd);
      }
    }
  }

  // 5. Generate new FlightPlans entries (need to know GUIDs for Aircrafts linking)
  const fpEntries = [];
  const fpGuids = []; // parallel to flights array â€” GUID used for each FlightPlan
  for (let i = 0; i < flights.length; i++) {
    // Generate GUID first so we can link AircraftState to it
    const fpGuid = _generateGuid();
    fpGuids.push(fpGuid);
    fpEntries.push(_buildFlightPlanStateEntryWithGuid(flights[i], ID_OFFSET_FLIGHTPLAN + i, bdt, fpGuid, _fpTypeNum, _fpArrTypeNum, _fpDepTypeNum));
  }
  log('generated ' + fpEntries.length + ' FlightPlan entries');

  // 6. Generate Aircrafts entries â€” only State=30 approach aircraft
  // Non-approach entries (State 10/31/5) are NOT preserved: their FlightPlanGuids
  // become stale when FlightPlans are regenerated with new GUIDs.

  // AircraftState $type number resolved from per-file typeMap (was regex-extracted).
  const _acTypeNum = typeNums.acType;

  // Extract the Approach radio channel GUID from the Channels section.
  // We previously tried to extract it from the Aircrafts section, but that fails
  // when the first State=30 entry is a taxiing aircraft (RadioChannelGuid: null)
  // or on re-saves (all RadioChannelGuid values already empty).
  // The Channels section lives in segAfter and is always preserved verbatim.
  const _radioChannelGuid = _extractAppChannelGuid(segAfter);
  const _towerChannelGuid = _extractTowerChannelGuid(segAfter);

  const acEntries = [];
  const animEntries = [];
  if (approachCache && approachCache.appPointMap && approachCache.specDB) {
    // saveTime = scenario start (gameplay begins at Config.startTime + warmup)
    // The game fast-forwards from startTime through warmup before showing the player
    const _toSec = (t) => { const p = String(t).split(':'); return +p[0]*3600 + +p[1]*60 + (+p[2]||0); };
    const startSec = aclcfgStartTime ? _toSec(aclcfgStartTime) : 0;
    // WARMUP_SEC imported from constants â€” game advances from Config.startTime to first flight time

    // Resolve saveTime: explicit > GameTime.CurrentDateTime (authoritative â€” the
    // literal wall-clock time the game wrote when it saved this snapshot) >
    // per-file cache offset (derived from State=30 approach entries â€” calibrates
    // the PR formula to match the game's path-based PR, but can be inaccurate for
    // State=5 aircraft whose effective TAT differs) > warmup fallback.
    let saveSec;
    if (_saveSec != null) {
      saveSec = _saveSec;
      log('saveTime=' + saveSec + 's (explicit)');
    }
    if (saveSec == null) {
      const gameTime = extractGameTime(text);
      if (gameTime != null) {
        saveSec = gameTime;
        log('saveTime=' + saveSec + 's (from GameTime.CurrentDateTime)');
      }
    }
    if (saveSec == null && approachCache && approachCache.saveTimeOffsets) {
      const aclBasename = path.basename(aclPath);
      const cachedSave = approachCache.saveTimeOffsets.get(aclBasename);
      if (cachedSave != null) {
        saveSec = cachedSave;
        log('saveTime=' + saveSec + 's (from cache offset for ' + aclBasename + ')');
      }
    }
    if (saveSec == null) {
      saveSec = startSec + WARMUP_SEC;
      log('saveTime=' + saveSec + 's (startTime=' + startSec + 's +13min warmup fallback)');
    }

    for (let i = 0; i < flights.length; i++) {
      const fl = flights[i];
      const isArrival = (fl.isDeparture === false) ||
        (((fl.LandingTime || '').trim() && !(fl.OffBlockTime || '').trim()));
      if (!isArrival) continue;

      const star = fl.Airway || '';
      const runway = fl.Runway || '';
      if (!star || !runway) continue;

      // Resolve approach procedure name (e.g. "RNAV ILS Z Rwy 19") from the cache.
      // The state5ParamsMap has keys like "procedureName|runway" from original files.
      let approachRoute = star; // fallback to STAR name
      if (approachCache && approachCache.state5ParamsMap) {
        for (const key of approachCache.state5ParamsMap.keys()) {
          const pipeIdx = key.indexOf('|');
          if (pipeIdx > 0 && key.substring(pipeIdx + 1) === runway) {
            approachRoute = key.substring(0, pipeIdx);
            break;
          }
        }
      }

      // Look up AppPointList for this (Route, Runway) combo
      const appKey = star + '|' + runway;
      const appPoints = approachCache.appPointMap.get(appKey);
      if (!appPoints) {
        log('  no AppPointList for "' + appKey + '", skipping Aircraft entry for ' + fl.CallSign);
        continue;
      }

      // Look up totalApproachTime for this Route
      const totalApproachTime = approachCache.totalApproachTimes.get(star);
      if (!totalApproachTime) {
        log('  no totalApproachTime for route "' + star + '", skipping Aircraft entry');
        continue;
      }

      // Look up Specification via Designator mapping.
      // Fall back to direct specDB lookup: in editor/v4 context, AircraftType
      // values ("A320", "B738") are already ICAO designator codes.
      let spec = null;
      const acType = fl.AircraftType || '';
      const designator = approachCache.designatorMap
        ? approachCache.designatorMap.get(acType)
        : null;
      if (designator && approachCache.specDB) {
        spec = approachCache.specDB.get(designator) || null;
      }
      if (!spec && acType && approachCache && approachCache.specDB) {
        spec = approachCache.specDB.get(acType) || null;
      }
      if (!spec) {
        log('  no spec for type "' + (fl.AircraftType || '') + '" (designator=' + designator + '), skipping Aircraft entry');
        continue;
      }

      // Compute ProgressRatio using verified formula with derived saveTime
      const landingSec = _toSec(fl.LandingTime);
      const timeToLanding = landingSec - saveSec; // seconds until landing
      // Clamp timeToLanding to a minimum of 30s for aircraft near landing,
      // but skip aircraft that landed more than 10s before the snapshot.
      // This avoids edge cases where PR â‰ˆ 1.0 places the aircraft at/beyond
      // the last path point (touchdown with Y=0, wrong XZ position).
      // GRACE_TTL imported from constants (max seconds-past-landing before aircraft are skipped)
      if (timeToLanding < GRACE_TTL) {
        log('  SKIP (landed ' + (-timeToLanding) + 's ago): ' + fl.CallSign);
        continue;
      }
      const clampedTTL = timeToLanding < APPROACH_MIN_TTL ? APPROACH_MIN_TTL : timeToLanding;
      const progressRatio = 1.0 - (clampedTTL / totalApproachTime);

      // Gate: only generate if aircraft is mid-approach at snapshot time
      if (progressRatio <= 0.0) {
        log('  SKIP (PR=' + progressRatio.toFixed(3) + ' â‰¤ 0, not started approach): ' + fl.CallSign);
        continue;
      }

      // Resolve FULL FlyApproach path from SceneryData.
      // This gives the complete path (not per-aircraft remaining points from
      // DynamicsParams), enabling correct IAF passage detection for State=30 vs State=5.
      const flyPoints = resolveFlyApproachPoints(text, star, runway);
      if (!flyPoints || flyPoints.length === 0) {
        log('  could not resolve FlyApproach points for ' + star + '/' + runway + ', skipping');
        continue;
      }

      // IAF (Initial Approach Fix) = last point of FlyApproach path.
      // Aircraft past this point are on final approach (State=5, Tower).
      // Aircraft before it are still on the STAR (State=30, Approach).
      const flyLen = computePathLength(flyPoints);
      const appLen = computePathLength(appPoints);
      // Build concatenated path (same as buildFullPath) to include the
      // connecting segment between the last FlyApproach point and the
      // first AppPointList point. flyLen + appLen would miss this gap.
      const combined = [...(flyPoints || []), ...(appPoints || [])];
      const totalLen = computePathLength(combined);

      // IAF boundary: use raw TTL (unclamped) so State classification is accurate.
      // The clamped progressRatio is used for position interpolation downstream.
      const rawTargetDist = (1.0 - timeToLanding / totalApproachTime) * totalLen;

      // Per-airport coordinate scale for converting real-world ceiling to game units
      const airportScale = approachCache?.airportScale;

      if (rawTargetDist >= flyLen) {
        // â”€â”€ State=5: Past IAF, on Tower frequency â”€â”€

        // State=5 entries use approach procedure names as Route (e.g. "RNAV ILS Z Rwy 19"),
        // not STAR names. Try appKey first (STAR|runway), then runway-only key.
        let state5Params = approachCache.state5ParamsMap
          ? approachCache.state5ParamsMap.get(appKey)
          : null;
        if (!state5Params) {
          state5Params = approachCache.state5ParamsMap
            ? approachCache.state5ParamsMap.get(runway)
            : null;
        }
        if (!state5Params) {
          // Fallback: derive State=5 params from AppPointList when no cached
          // State=5 entry exists for this runway. The AppPointList covers the
          // same final-approach segment as PathPointList but stops at the FAF.
          // The real touchdown is further along the approach direction â€” for
          // KJFK 22R, the distToTD from last ppList point is ~108m.
          if (appPoints && appPoints.length >= 2) {
            const lastPt = appPoints[appPoints.length - 1];
            const prevPt = appPoints[appPoints.length - 2];
            const dir = _vec3Normalize(_vec3Sub(lastPt, prevPt));
            // Use per-airport approach cap from 5000ft real-world ceiling.
            // AppPointList points have y=0 in the ACL (Unity XZ plane);
            // Y is always computed from the 3Â° glideslope in buildState5AircraftBlock.
            const approachCap = computeApproachCap(airportScale);
            // Extend touchdown past the last AppPoint by the AppPath length
            // (the glideslope continues ~108m beyond the FAF for KJFK 22R).
            let appPathLen = 0;
            for (let pi = 0; pi < appPoints.length - 1; pi++) {
              appPathLen += _vec3Dist(appPoints[pi], appPoints[pi + 1]);
            }
            const tdExtendDist = appPathLen; // extension past last AppPoint
            const tdPos = {
              x: lastPt.x + dir.x * tdExtendDist,
              y: 0,
              z: lastPt.z + dir.z * tdExtendDist,
            };
            state5Params = {
              pathPointList: appPoints,
              touchDownPosition: tdPos,
              approachDirection: dir,
              initialPosition: { x: appPoints[0].x, y: approachCap, z: appPoints[0].z },
            };
            log('  derived State=5 params from AppPointList for runway ' + runway +
                ' (cap=' + approachCap.toFixed(1) + 'm, tdExt=' + tdExtendDist.toFixed(0) + 'm)');
            if (approachRoute === star) {
              approachRoute = 'RNAV Rwy ' + runway;
            }
          }
        }
        if (!state5Params) {
          log('  no State=5 params for "' + appKey + '" or runway "' + runway + '", falling back to State=30 for ' + fl.CallSign);
          // fall through to State=30 below
        } else {
          // State=5 ProgressRatio hardcoded to 0 in buildState5AircraftBlock.
          // The game recalculates the path-based PR when the level loads.

          log('  build State=5 entry: ' + fl.CallSign + ' ' + star + '/' + runway +
              ' PR=' + progressRatio.toFixed(3) +
              ' timeToLanding=' + timeToLanding.toFixed(0) + 's' +
              ' pastIAF=' + (rawTargetDist - flyLen).toFixed(0) + 'm' +
              ' towerCh=' + (_towerChannelGuid ? 'yes' : 'no'));

          // Determine State=5 sub-type based on time-to-landing:
          //   â‰¥60s â†’ Contact Tower (command 22, no exit selected)
          //   <60s â†’ Cleared to Land (command 23, exit selected)
          // TEMP: always use Contact Tower (22) â€” jumping straight to Cleared to Land (23)
          // prevents the game from initializing the landing state machine, causing
          // NullReferenceException due to missing type declarations (types 41-43, 49-52).
          // const isClearedToLand = timeToLanding < 60; // TEMP: disabled

          // State=5 position path mirrors State=30: STAR FlyApproach + procedure
          // PathPointList + touchdown. flyPoints (STAR) was already resolved
          // above â€” pass it directly instead of re-resolving the procedure's
          // FlyApproach (which would double the ppList segment).

          // Per-airport approach cap: from cached state5 params if available,
          // otherwise computed from 5000ft real-world ceiling via coordinate scale.
          const state5Cap = computeApproachCap(airportScale);

          const result = buildState5AircraftBlock({
            flightPlanGuid: fpGuids[i],
            route: approachRoute,
            spec: spec,
            towerChannelGuid: _towerChannelGuid || _radioChannelGuid,
            state5Params: state5Params,
            flyPoints: flyPoints,
            fullPR: progressRatio,
            approachCap: state5Cap,
            waitingForCommand: CMD_CONTACT_TOWER, // TEMP: always Contact Tower (was: isClearedToLand ? CMD_CLEARED_TO_LAND : CMD_CONTACT_TOWER)
            selectedRunwayExitIndex: -1, // TEMP: always -1 (was: isClearedToLand ? 0 : -1)
            nextId: ID_OFFSET_AIRCRAFT + i * 1000,
            acTypeNum: _acTypeNum,
            typeNums: typeNums,
          });
          const entry = '{"$k": "' + result.guid + '", "$v": ' + result.block + '}';
          acEntries.push(entry);

          const animResult = buildAnimatorBlock(result.guid, {
            nextId: ID_OFFSET_ANIMATOR + i * 100,
            acTypeNum: _acTypeNum,
            typeNums: typeNums,
          });
          const animEntry = '{"$k": "' + animResult.guid + '", "$v": ' + animResult.block + '}';
          animEntries.push(animEntry);
          continue;
        }
      }

      // â”€â”€ State=30: Before IAF, on Approach frequency â”€â”€

      log('  build State=30 entry: ' + fl.CallSign + ' ' + star + '/' + runway +
          ' td=' + timeToLanding + 's PR=' + progressRatio.toFixed(3) +
          ' flyPts=' + flyPoints.length + ' appPts=' + appPoints.length);

      // TouchDownPosition + approachCap for 3Â° glideslope Y in State=30.
      // approachCap computed from 5000ft real-world ceiling via per-airport scale.
      const state5ForRwy = approachCache?.state5ParamsMap?.get(runway);
      let tdPos = state5ForRwy?.touchDownPosition || null;
      let approachCap = computeApproachCap(airportScale);
      // Fallback: derive touchdown from AppPointList when state5ParamsMap lacks
      // this runway. Same derivation as the State=5 fallback â€” extends the last
      // AppPoint segment by 50m to approximate the runway threshold.
      if (!tdPos && appPoints && appPoints.length >= 2) {
        const lastPt = appPoints[appPoints.length - 1];
        const prevPt = appPoints[appPoints.length - 2];
        const dir = _vec3Normalize(_vec3Sub(lastPt, prevPt));
        tdPos = { x: lastPt.x + dir.x * 50, y: 0, z: lastPt.z + dir.z * 50 };
      }

      const result = buildApproachAircraftBlock({
        flightPlanGuid: fpGuids[i],
        route: star,
        flyPoints: flyPoints,
        appPoints: appPoints,
        progressRatio: progressRatio,
        spec: spec,
        radioChannelGuid: _radioChannelGuid,
        touchDownPosition: tdPos,
        approachCap: approachCap,
        nextId: ID_OFFSET_AIRCRAFT + i * 1000,
        acTypeNum: _acTypeNum,
        typeNums: typeNums,
      });
      // Wrap in $k/$v dictionary entry format to match original file
      const entry = '{"$k": "' + result.guid + '", "$v": ' + result.block + '}';
      acEntries.push(entry);

      // Generate matching AircraftAnimators entry
      const animResult = buildAnimatorBlock(result.guid, {
        nextId: ID_OFFSET_ANIMATOR + i * 100,
        acTypeNum: _acTypeNum,
        typeNums: typeNums,
      });
      const animEntry = '{"$k": "' + animResult.guid + '", "$v": ' + animResult.block + '}';
      animEntries.push(animEntry);
    }
  }
  log('generated ' + acEntries.length + ' Aircraft entries + ' + animEntries.length + ' Animator entries');

  // Reset docking state on Jetways entries that reference old aircraft GUIDs.
  // The Aircrafts section is rebuilt with new GUIDs, so DockingAircraftGuid
  // values in the preserved Jetways section become orphaned and cause
  // NullReferenceException in the game. Must run unconditionally.
  segAfter = _resetJetwayDockingState(segAfter, log);

  // 6b. Expand short-form $type references in preserved segments.
  // The regenerated Aircrafts/FlightPlans sections use full-form types, but
  // segBefore and segAfter (copied verbatim from the original file) may contain
  // short-form "$type": N references to types whose full declarations were in
  // the now-replaced Aircrafts $rcontent. The per-file typeMap (seeded from
  // current file + approach cache) ensures correct expansion even after repeated
  // saves. Full-form references self-register with Unity's deserializer.
  if (typeMap.size > 0) {
    segBefore = _expandShortFormTypes(segBefore, typeMap);
    preAnimators = _expandShortFormTypes(preAnimators, typeMap);
    postAnimators = _expandShortFormTypes(postAnimators, typeMap);
    segAfter = _expandShortFormTypes(segAfter, typeMap);
    log('Expanded short-form $type refs in preserved segments');
  }
  segAfter = _fixSingletonStateRefs(segAfter, typeMap);

  // 7. Update $rlength in Aircrafts
  let segBeforeMod = segBefore;
  const acMarker = segBeforeMod.lastIndexOf('"Aircrafts"');
  if (acMarker >= 0) {
    const beforeAc = segBeforeMod.substring(0, acMarker);
    const fromAc = segBeforeMod.substring(acMarker);
    segBeforeMod = beforeAc + fromAc.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${acEntries.length}`);
  }

  // 8. Update $rlength in AircraftAnimators and FlightPlans
  let segBetweenMod = postAnimators; // everything after AircraftAnimators $rcontent
  const fpMarker = segBetweenMod.indexOf('"FlightPlans"');
  if (fpMarker >= 0) {
    const beforeFp = segBetweenMod.substring(0, fpMarker);
    const fromFp = segBetweenMod.substring(fpMarker);
    segBetweenMod = beforeFp + fromFp.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${fpEntries.length}`);
  }

  // Update $rlength in AircraftAnimators
  if (aaIdx >= 0 && aaRcStart >= 0) {
    const aaMarker = preAnimators.lastIndexOf('"AircraftAnimators"');
    if (aaMarker >= 0) {
      const beforeAa = preAnimators.substring(0, aaMarker);
      const fromAa = preAnimators.substring(aaMarker);
      preAnimators = beforeAa + fromAa.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${animEntries.length}`);
    }
  }

  // 9. Assemble and write
  const acContent = acEntries.length > 0
    ? '\n' + acEntries.join(',\n') + '\n            '
    : '';

  const animContent = animEntries.length > 0
    ? '\n' + animEntries.join(',\n') + '\n                '
    : '';

  let newText =
    segBeforeMod + acContent + ']' +
    preAnimators + animContent + ']' +
    segBetweenMod + '\n                ' +
    fpEntries.join(',\n                ') +
    '\n            ]' +
    segAfter;

  // 9a. Expand any remaining short-form $type references in the full output.
  // Preserved segments were already expanded above, and regenerated sections use
  // full-form types. This is a safety net â€” it catches any short-form refs that
  // may have been missed (e.g., inside string-replaced segments). BCL types
  // (DateTime=3, Vector3=16, etc.) are not in typeMap and are left untouched.
  newText = _expandShortFormTypes(newText, typeMap);

  // v2/v3: write as plain text (byte-identical to original editor output)
  fs.writeFileSync(aclPath, newText, 'utf-8');
  log('SUCCESS â€“ file written (' + (newText.length / 1024).toFixed(0) + ' KB, utf-8)');
}

// â”€â”€â”€ Build FlightPlanStateEntry with preset GUID â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _buildFlightPlanStateEntryWithGuid(flight, entryId, baseDateTicks, fpGuid, fpTypeNum, fpArrTypeNum, fpDepTypeNum) {
  const bdt = baseDateTicks || FALLBACK_BASE_DATE_TICKS;
  const reg = flight._Registration || flight.Registration || '';
  const acType = flight.AircraftType || '';
  const airline = flight.AirlineName || '';
  const voice = flight.Voice || '';
  const lang = flight.Language || '';
  const fpt = fpTypeNum || 56;
  const fat = fpArrTypeNum || 58;
  const fdt = fpDepTypeNum || 57;

  const isArrival = (flight.isDeparture === false) ||
    (((flight.LandingTime || '').trim() && !(flight.OffBlockTime || '').trim()));

  const lines = [];
  lines.push('                {');
  lines.push(`                    "$k": "${fpGuid}",`);
  lines.push('                    "$v": {');
  lines.push(`                        "$id": ${entryId},`);
  lines.push(`                        "$type": "${fpt}|ContextCross.States.FlightPlanState, GroundATC.Core",`);
  lines.push(`                        "Guid": "${fpGuid}",`);
  lines.push('                        "Enabled": true,');
  if (reg) lines.push(`                        "Registration": "${reg}",`);
  else lines.push('                        "Registration": null,');
  lines.push(`                        "AircraftType": "${acType}",`);
  lines.push(`                        "AirlineName": "${airline}",`);
  lines.push(`                        "Voice": "${voice}",`);
  lines.push(`                        "Language": "${lang}",`);

  if (isArrival) {
    lines.push('                        "Arrival":');
    lines.push(_buildFlightPlanArrivalLeg(flight, entryId, bdt, fat));
    lines.push('                        "Departure": null');
  } else {
    lines.push('                        "Arrival": null,');
    lines.push('                        "Departure":');
    lines.push(_buildFlightPlanDepartureLeg(flight, entryId, bdt, fdt));
  }

  lines.push('                    }');
  lines.push('                }');
  return lines.join('\n');
}

// â”€â”€â”€ Rebuild Timeline Sections (WindFrames, WeatherFrames, RunwayTimeline) â”€â”€

/** Extract an object section from raw ACL text using string-aware tokenizer. */
function _extractSection(text, sectionKey) {
  const t = createTokenizer(text);
  const range = t.findSection(sectionKey);
  if (!range) return null;
  // Check for null value
  const val = t.substring(range.valueStart, range.valueEnd);
  if (val === 'null') return null;
  return {
    start: range.keyStart,
    end: range.valueEnd,
    content: val,
  };
}

/** Extract level config (startTime, endTime, file paths) from ACL's Config block. */
function _extractConfig(aclText) {
  const sec = _extractSection(aclText, 'Config');
  if (!sec) { console.log('[CONFIG-EXTRACT] Config section NOT FOUND in ACL text (len=' + (aclText ? aclText.length : 0) + ')'); return null; }
  // Use pre-processor + JSON.parse for robust extraction
  try {
    const cleaned = preprocessUnityJson(sec.content);
    const cfg = JSON.parse(cleaned);
    const result = {
      startTime: cfg.startTime || '',
      endTime: cfg.endTime || '',
      flightScheduleFile: cfg.flightScheduleFile || '',
      runwayTimelineFile: cfg.runwayTimelineFile || '',
    };
    console.log('[CONFIG-EXTRACT] startTime=' + result.startTime + ' endTime=' + result.endTime + ' flightScheduleFile=' + result.flightScheduleFile + ' runwayTimelineFile=' + result.runwayTimelineFile);
    return result;
  } catch (e) {
    console.log('[CONFIG-EXTRACT] Parse error, falling back to regex:', e.message);
    // Fallback: regex extraction for backward compat
    const getStr = (name) => {
      const re = new RegExp('"' + name + '"\\s*:\\s*"([^"]*)"');
      const m = sec.content.match(re);
      return m ? m[1] : null;
    };
    return {
      startTime: getStr('startTime') || '',
      endTime: getStr('endTime') || '',
      flightScheduleFile: getStr('flightScheduleFile') || '',
      runwayTimelineFile: getStr('runwayTimelineFile') || '',
    };
  }
}

function _parseTypeNum(typeStr) {
  if (!typeStr) return null;
  const m = typeStr.match(/^"?(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Expand short-form $type references to fully-qualified type strings.
 * Short form:   "$type": 44,
 * Resolved to:  "$type": "44|ContextCross.Events.AircraftEvent[], GroundATC.Core",
 *
 * Only matches bare numeric $type values (not already-qualified "N|..." strings).
 * References whose type ID is not in the typeMap are left as-is.
 */
function _expandShortFormTypes(text, typeMap) {
  if (!typeMap || typeMap.size === 0) return text;
  // Protect CurrentDateTime blocks from expansion â€” the System.DateTime short-form
  // representation must be preserved for extractCurrentDateTime / extractGameTime.
  const protectedBlocks = [];
  const textWithPlaceholders = text.replace(
    /"CurrentDateTime":\s*\{[\s\S]{0,250}?\}/g,
    (match) => {
      protectedBlocks.push(match);
      return '<<<CDT_BLOCK_' + (protectedBlocks.length - 1) + '>>>';
    }
  );
  const expanded = _expandWithBlobdocScopes(textWithPlaceholders, typeMap);
  // Restore protected CurrentDateTime blocks
  return expanded.replace(/<<<CDT_BLOCK_(\d+)>>>/g, (_, idx) => protectedBlocks[parseInt(idx, 10)]);
}

/**
 * Scope-aware bare $type reference expansion.
 *
 * Each $blobdoc in the Odin JSON text is an independent nested document with its
 * own type-numbering scope.  A bare "$type": 3 inside a blobdoc must be expanded
 * using that blobdoc's type declarations, NOT the outer document's assignments.
 * Otherwise the same numeric id can resolve to different type names depending on
 * which scope it lives in, producing "Type id N claimed by both â€¦" during encode.
 *
 * Recurses into nested blobdocs so every bare reference expands against the
 * correct scope's typeMap.
 */
function _expandWithBlobdocScopes(text, outerTypeMap) {
  if (outerTypeMap.size === 0) return text;

  const t = createTokenizer(text);
  const KEY = '"$blobdoc"';
  const KEY_LEN = KEY.length;

  let result = '';
  let pos = 0;

  while (pos < text.length) {
    const keyIdx = text.indexOf(KEY, pos);
    if (keyIdx < 0) {
      // No more blobdocs â€” expand remaining text with the outer typeMap
      result += _replaceBareTypeRefs(text.substring(pos), outerTypeMap);
      break;
    }

    // Only match when "$blobdoc" is a JSON key (preceded by { or , with optional
    // whitespace), not when it appears inside a string value.
    let before = keyIdx - 1;
    while (before >= 0 && ' \t\n\r'.includes(text[before])) before--;
    if (before < 0 || (text[before] !== '{' && text[before] !== ',')) {
      // False positive â€” inside a string value or not a key. Skip past it.
      result += text.substring(pos, keyIdx + KEY_LEN);
      pos = keyIdx + KEY_LEN;
      continue;
    }

    // Find the colon after the key
    let colonIdx = -1;
    for (let i = keyIdx + KEY_LEN; i < text.length; i++) {
      if (text[i] === ':') { colonIdx = i; break; }
      if (!' \t\n\r'.includes(text[i])) break;
    }
    if (colonIdx < 0) {
      result += text.substring(pos);
      break;
    }

    let valStart = colonIdx + 1;
    while (valStart < text.length && ' \t\n\r'.includes(text[valStart])) valStart++;
    if (valStart >= text.length || text[valStart] !== '{') {
      // Value is not an object â€” skip
      result += text.substring(pos, valStart);
      pos = valStart;
      continue;
    }

    // Find the blobdoc object end (string-aware brace matching)
    const valEnd = t.findObjectEnd(valStart);
    if (valEnd === null) {
      result += text.substring(pos);
      break;
    }

    // Expand text before the blobdoc key with the outer typeMap
    result += _replaceBareTypeRefs(text.substring(pos, keyIdx), outerTypeMap);

    // Copy the "$blobdoc": prefix verbatim
    result += text.substring(keyIdx, valStart);

    // Build blobdoc-specific typeMap from declarations inside this blobdoc
    const blobdocText = text.substring(valStart, valEnd);
    const blobMap = new Map();
    const blobDeclRe = /"\$type":\s*"(\d+)\|([^"]+)"/g;
    let bm;
    while ((bm = blobDeclRe.exec(blobdocText)) !== null) {
      const num = parseInt(bm[1], 10);
      if (!blobMap.has(num)) blobMap.set(num, bm[2]);
    }

    // Recurse into blobdoc with its own typeMap (handles nested blobdocs)
    if (blobMap.size > 0) {
      result += _expandWithBlobdocScopes(blobdocText, blobMap);
    } else {
      result += _expandWithBlobdocScopes(blobdocText, outerTypeMap);
    }

    pos = valEnd;
  }

  return result;
}

/** Regex-based bare $type reference expansion for a single scope. */
function _replaceBareTypeRefs(text, typeMap) {
  if (!typeMap || typeMap.size === 0) return text;
  return text.replace(/"\$type":\s*(\d+)\s*([,\}\]])/g, (match, numStr, delimiter) => {
    const num = parseInt(numStr, 10);
    const fullType = typeMap.get(num);
    if (fullType) {
      return '"$type": "' + num + '|' + fullType + '"' + delimiter;
    }
    return match;
  });
}

/**
 * Centralized ID mapper for tracking old â†’ new $id assignments during save.
 *
 * When the save pipeline rebuilds entries (e.g. flight-plan:REG, jetway, aircraft),
 * existing $id values may be replaced with new ones.  Preserved entries that
 * reference the old $id via $iref:N must be updated to point to the new $id.
 *
 * The IdMapper acts as a union-find (disjoint-set) structure:
 *   - map(oldId, newId)  registers a move
 *   - resolve(id)        follows the chain to the canonical current ID
 *   - remapIrefs(text)   rewrites all $iref:N tokens in text where N has been mapped
 *
 * Create one IdMapper per segment (each $blobdoc has its own $id namespace).
 */
class _IdMapper {
  constructor() { this._map = new Map(); }

  /** Register that oldId has been reassigned to newId. No-op if identical or null. */
  map(oldId, newId) {
    if (oldId !== newId && oldId != null && newId != null) {
      this._map.set(oldId, newId);
    }
  }

  /**
   * Follow the mapping chain to find the canonical current ID.
   * Returns id unchanged if not mapped.  Handles transitive chains:
   * if 738â†’1042 and 1042â†’1500, resolve(738) returns 1500.
   */
  resolve(id) {
    let cur = id;
    const visited = new Set();
    while (this._map.has(cur)) {
      if (visited.has(cur)) break; // cycle guard
      visited.add(cur);
      cur = this._map.get(cur);
    }
    return cur;
  }

  /**
   * Scan text for all $iref:N tokens and replace N with resolve(N) where changed.
   * Uses indexOf (not regex) because $iref: is a bare Odin token â€” it never
   * appears inside JSON string values.  Applies replacements back-to-front
   * to avoid position drift.
   *
   * @param {string} text
   * @returns {{ text: string, count: number }}
   */
  remapIrefs(text) {
    if (this._map.size === 0) return { text, count: 0 };
    const prefix = '$iref:';
    const replacements = [];
    let idx = 0;
    while ((idx = text.indexOf(prefix, idx)) !== -1) {
      const numStart = idx + prefix.length;
      let numEnd = numStart;
      while (numEnd < text.length && text[numEnd] >= '0' && text[numEnd] <= '9') numEnd++;
      if (numEnd > numStart) {
        const oldId = parseInt(text.substring(numStart, numEnd), 10);
        const newId = this.resolve(oldId);
        if (newId !== oldId) {
          replacements.push({ start: numStart, end: numEnd, replacement: String(newId) });
        }
      }
      idx = numEnd;
    }
    if (replacements.length === 0) return { text, count: 0 };
    // Apply back-to-front (no position drift)
    replacements.sort((a, b) => b.start - a.start);
    let result = text;
    for (const r of replacements) {
      result = result.substring(0, r.start) + r.replacement + result.substring(r.end);
    }
    return { text: result, count: replacements.length };
  }

  get size() { return this._map.size; }
}

/**
 * Fix dangling $iref references in the SingletonStates section.
 *
 * The Aircrafts rebuild replaces the entire Aircrafts $rcontent, which may
 * contain $id definitions that GameEventScheduler.EventQueue and
 * EventLogger.History reference via $iref.  After rebuild those $id
 * definitions are gone, but the $iref pointers in segAfter remain â€”
 * causing the game to crash on EventLogger.Load (NullReferenceException
 * inside LinkedList constructor).
 *
 * When EventQueue is a $iref, we replace it with an inline empty
 * AircraftEvent[] and update History to point to the new inline queue.
 * This matches the pattern used by the game in healthy files (e.g.
 * ZSJN_19-21.acl).
 *
 * @param {string} segAfter â€” preserved segment after FlightPlans
 * @param {Map<number,string>} typeMap â€” per-file type-number â†’ type-name mapping
 * @returns {string} segAfter with dangling $iref references patched
 */
function _fixSingletonStateRefs(segAfter, typeMap) {
  const tok = createTokenizer(segAfter);

  // Locate EventQueue inside GameEventScheduler
  const eq = tok.findSection('EventQueue');
  if (!eq) return segAfter;

  const eqVal = tok.substring(eq.valueStart, eq.valueEnd);
  if (!eqVal.startsWith('$iref:')) return segAfter; // already inline, healthy

  const eqRefNum = parseInt(eqVal.substring(6), 10);

  // Resolve AircraftEvent[] type number from per-file typeMap
  let evtTypeNum = null;
  if (typeMap) {
    for (const [num, name] of typeMap) {
      if (name === 'ContextCross.Events.AircraftEvent[], GroundATC.Core') {
        evtTypeNum = num;
        break;
      }
    }
  }

  // Generate a unique $id that doesn't collide with anything in segAfter
  let maxId = 0;
  let idSearch = 0;
  while ((idSearch = segAfter.indexOf('"$id":', idSearch)) !== -1) {
    idSearch += 6;
    while (idSearch < segAfter.length && segAfter[idSearch] === ' ') idSearch++;
    let num = '';
    while (idSearch < segAfter.length && segAfter[idSearch] >= '0' && segAfter[idSearch] <= '9') {
      num += segAfter[idSearch++];
    }
    if (num) maxId = Math.max(maxId, parseInt(num, 10));
  }
  const newId = maxId + 1;

  // Build inline empty AircraftEvent[] queue
  const typeStr = evtTypeNum !== null
    ? `"$type": "${evtTypeNum}|ContextCross.Events.AircraftEvent[], GroundATC.Core"`
    : '"$type": 46';
  const newQueue = `{\n                            "$id": ${newId},\n                            ${typeStr},\n                            "$rlength": 0,\n                            "$rcontent": [\n                            ]\n                        }`;

  // Replace EventQueue $iref with inline queue
  let result = segAfter.substring(0, eq.valueStart) + newQueue + segAfter.substring(eq.valueEnd);

  // Update History $iref in EventLogger
  const histTok = createTokenizer(result);
  const hist = histTok.findSection('History');
  if (hist) {
    const histVal = histTok.substring(hist.valueStart, hist.valueEnd);
    if (histVal.startsWith('$iref:')) {
      const histRefNum = parseInt(histVal.substring(6), 10);
      // If History references the same (now-replaced) queue, point it to the new one
      if (histRefNum === eqRefNum) {
        const newRef = `$iref:${newId}`;
        result = result.substring(0, hist.valueStart) + newRef + result.substring(hist.valueEnd);
      } else {
        // History references a different $iref â€” also dangling.  Create a
        // second inline empty queue for it.
        const histNewId = newId + 1;
        const histQueue = `{\n                            "$id": ${histNewId},\n                            ${typeStr},\n                            "$rlength": 0,\n                            "$rcontent": [\n                            ]\n                        }`;
        // We need to find History *position* in result (already have it from
        // histTok above) and replace.  But we also need to fix the EventLogger
        // block so History gets the inline queue.  The cleanest approach:
        // replace the History $iref with the inline queue directly.
        result = result.substring(0, hist.valueStart) + histQueue + result.substring(hist.valueEnd);
      }
    }
  }

  return result;
}

/**
 * Extract the Approach (APP) radio channel GUID from the Channels section.
 * The Channels dictionary is preserved verbatim in segAfter and always contains
 * the correct channel GUIDs independent of the Aircrafts rebuild state.
 *
 * We search for a channel entry with Type=5 (Approach), falling back to
 * ShortCode "APP" if Type is not found.
 */
function _extractAppChannelGuid(segAfter) {
  const chIdx = segAfter.indexOf('"Channels"');
  if (chIdx < 0) return '';
  const chSection = segAfter.substring(chIdx);
  const rcMatch = chSection.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return '';
  const chRcStart = chIdx + rcMatch.index + rcMatch[0].length;
  let depth = 0, chRcEnd = null;
  for (let i = chRcStart; i < segAfter.length; i++) {
    if (segAfter[i] === '{') depth++;
    else if (segAfter[i] === '}') depth--;
    else if (segAfter[i] === ']' && depth === 0) { chRcEnd = i + 1; break; }
  }
  if (chRcEnd === null) return '';
  const chContent = segAfter.substring(chRcStart, chRcEnd);
  // Split on $v blocks to find the APP channel (Type=5 or ShortCode="APP").
  // Field order varies between files (Guid may come before or after Type),
  // so we can't rely on a single regex with fixed field sequence.
  const parts = chContent.split(/"\$v":\s*\{/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    if (/"Type":\s*5\b/.test(block) || /"ShortCode":\s*"APP"/.test(block)) {
      const guidM = block.match(/"Guid":\s*"([\da-f-]+)"/);
      if (guidM) return guidM[1];
    }
  }
  return '';
}

/**
 * Extract the Tower (TWR) radio channel GUID from the Channels section.
 * Same approach as _extractAppChannelGuid but searches for Type=3 or ShortCode "TWR".
 */
function _extractTowerChannelGuid(segAfter) {
  const chIdx = segAfter.indexOf('"Channels"');
  if (chIdx < 0) return '';
  const chSection = segAfter.substring(chIdx);
  const rcMatch = chSection.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return '';
  const chRcStart = chIdx + rcMatch.index + rcMatch[0].length;
  let depth = 0, chRcEnd = null;
  for (let i = chRcStart; i < segAfter.length; i++) {
    if (segAfter[i] === '{') depth++;
    else if (segAfter[i] === '}') depth--;
    else if (segAfter[i] === ']' && depth === 0) { chRcEnd = i + 1; break; }
  }
  if (chRcEnd === null) return '';
  const chContent = segAfter.substring(chRcStart, chRcEnd);
  // Split on $v blocks to find the TWR channel (Type=3 or ShortCode="TWR").
  const parts = chContent.split(/"\$v":\s*\{/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    if (/"Type":\s*3\b/.test(block) || /"ShortCode":\s*"TWR"/.test(block)) {
      const guidM = block.match(/"Guid":\s*"([\da-f-]+)"/);
      if (guidM) return guidM[1];
    }
  }
  return '';
}

/**
 * Reset docking state on Jetways entries whose DockingAircraftGuid references
 * an old aircraft GUID. Since the Aircrafts section is rebuilt with new GUIDs,
 * any non-null DockingAircraftGuid becomes an orphaned reference that causes a
 * Unity NullReferenceException. We reset the 4 docking fields to their empty
 * state: Statusâ†’0, Progressâ†’0, DockingAircraftGuidâ†’null, DockingDoorIndexâ†’-1.
 */
function _resetJetwayDockingState(segAfter, log) {
  const jwIdx = segAfter.indexOf('"Jetways"');
  if (jwIdx < 0) return segAfter;

  // Locate Jetways $rcontent boundaries
  const jwSection = segAfter.substring(jwIdx);
  const rcMatch = jwSection.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return segAfter;
  const jwRcStart = jwIdx + rcMatch.index + rcMatch[0].length;

  let depth = 0, jwRcEnd = null;
  for (let i = jwRcStart; i < segAfter.length; i++) {
    if (segAfter[i] === '{') depth++;
    else if (segAfter[i] === '}') depth--;
    else if (segAfter[i] === ']' && depth === 0) { jwRcEnd = i + 1; break; }
  }
  if (jwRcEnd === null) return segAfter;

  const jwBefore = segAfter.substring(0, jwRcStart);
  const jwContent = segAfter.substring(jwRcStart, jwRcEnd);
  const jwAfter = segAfter.substring(jwRcEnd);

  // Split into individual $v blocks and reset docking fields
  const entries = [];
  // Split on "$v": {  â€” each pair is a $k/$v Jetway entry
  const parts = jwContent.split(/"\$v":\s*\{/);
  // First part is before the first $v (leading whitespace or nothing)
  if (parts[0].trim()) entries.push(parts[0]);

  let resetCount = 0;
  for (let i = 1; i < parts.length; i++) {
    let block = parts[i];
    // Check if this block has a non-null DockingAircraftGuid
    if (/"DockingAircraftGuid":\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/.test(block)) {
      // Reset docking fields to empty state
      block = block
        .replace(/"Status":\s*\d+/, '"Status": 0')
        .replace(/"Progress":\s*\d+(\.\d+)?/, '"Progress": 0')
        .replace(/"DockingAircraftGuid":\s*"[0-9a-f-]+"/, '"DockingAircraftGuid": null')
        .replace(/"DockingDoorIndex":\s*-?\d+/, '"DockingDoorIndex": -1');
      resetCount++;
    }
    entries.push('"$v": {' + block);
  }

  if (resetCount > 0) log('Reset ' + resetCount + ' Jetways docking entries');
  return jwBefore + entries.join('') + jwAfter;
}

/**
 * v4: Reset docking state on jetway entries in the checkpoint frame's
 * RuntimeData blobdoc. When flights are deleted, jetway entries in the
 * frame may still have non-null DockingAircraft fields containing embedded
 * Aircraft objects whose flight-plan $fstrref references are now stale.
 * We detect these by checking $fstrref:"flight-plan:REG" inside the
 * DockingAircraft value against the set of valid registrations, and reset
 * the docking fields: Statusâ†’0, Progressâ†’0, DockingAircraftâ†’null,
 * DockingDoorIndexâ†’-1.
 */
/**
 * Remove orphaned RuntimeEntities entries whose $k references a registration
 * that no longer exists in the header's StaticItems dictionary.
 *
 * When flights are deleted or their registrations change, the rebuilt header
 * StaticItems may not include all the keys referenced by checkpoint frame
 * RuntimeEntities. This causes Unity to throw errors like:
 *
 *   "FlightPlan: static item 'flight-plan:B-OLD' does not exist in
 *    CurrentLevel.StaticField.StaticItems"       (stale flight-plan $k)
 *   "Aircraft 'aircraft:B-OLD' has no flight plan reference"
 *                                                 (orphaned aircraft $k)
 *
 * Step 7a already nulls stale $fstrref values inside the $v blocks, but the
 * $k keys themselves must also be cleaned up.  All three entry types
 * (flight-plan:REG, aircraft:REG, aircraft-animator:aircraft:REG) are fully
 * removed from the $rcontent array when their registration is stale.
 *
 * This is safe because _resetFrameJetwayDockingState preserves the Aircraft
 * object (and its $id namespace with nested shared $iref targets) inside
 * the jetway's DockingAircraft field.  The orphaned aircraft entries use
 * $v: $iref:N to reference that Aircraft â€” when the orphan is removed the
 * $id:N still lives in the jetway, so surviving entries' $iref references
 * remain valid.
 *
 * @param {string} frameText - Decoded checkpoint frame text
 * @param {Set<string>} validRegs - Set of valid flight registrations
 * @param {Function} log
 * @returns {{ text: string, removed: number }}
 */
function _removeOrphanedFlightEntities(frameText, validRegs, renameMap, log) {
  let renamed = 0;

  // â”€â”€ Navigate to RuntimeEntities.$rcontent structurally â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const t = createTokenizer(frameText);
  const reSec = t.findSection('RuntimeEntities');
  if (!reSec) return { text: frameText, removed: 0, renamed: 0 };

  const reText = t.substring(reSec.valueStart, reSec.valueEnd);
  const reT = createTokenizer(reText);
  const rcSec = reT.findSection('$rcontent');
  if (!rcSec) return { text: frameText, removed: 0, renamed: 0 };

  const rcStart = rcSec.valueStart;
  if (reText[rcStart] !== '[') return { text: frameText, removed: 0, renamed: 0 };
  const rcEnd = reT.findArrayEnd(rcStart);
  if (rcEnd === null) return { text: frameText, removed: 0, renamed: 0 };

  // Extract parts for later reassembly. Positions are in frameText space:
  //   beforeRc = everything up to and including [
  //   content  = text between [ and ] (the array entries)
  //   afterRc  = everything from ] onward
  const frameReStart = reSec.valueStart;
  const beforeRc = frameText.substring(0, frameReStart + rcStart + 1);
  const content = reText.substring(rcStart + 1, rcEnd - 1);
  const afterRc = frameText.substring(frameReStart + rcEnd - 1);
  const contentT = createTokenizer(content);

  // â”€â”€ Single-pass entry iteration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const entries = [];  // { text, orphan } â€” orphan removes entry from RuntimeEntities
  let pos = 0;
  while (pos < content.length) {
    while (pos < content.length && ' \t\n\r'.includes(content[pos])) pos++;
    if (pos >= content.length) break;
    if (content[pos] === ',') { pos++; continue; }
    if (content[pos] !== '{') { pos++; continue; }

    const entryEnd = contentT.findObjectEnd(pos);
    if (entryEnd === null) break;
    const entryText = content.substring(pos, entryEnd);
    const entryT = createTokenizer(entryText);

    // Extract $k value structurally (no regex)
    const kSec = entryT.findSection('$k');
    let modifiedEntry = entryText;
    let isOrphan = false;

    if (kSec) {
      const kStrEnd = entryT.skipString(kSec.valueStart);
      if (kStrEnd) {
        const key = entryText.substring(kSec.valueStart + 1, kStrEnd - 1);

        const fpPrefix = 'flight-plan:';
        const acPrefix = 'aircraft:';
        const aaPrefix = 'aircraft-animator:aircraft:';

        if (key.startsWith(fpPrefix)) {
          // â”€â”€ flight-plan:REG â”€â”€
          const reg = key.substring(fpPrefix.length);
          if (!validRegs.has(reg)) {
            if (renameMap && renameMap.has(reg)) {
              // Rename: replace $k value at exact tokenizer-found positions
              const newReg = renameMap.get(reg);
              modifiedEntry =
                entryText.substring(0, kSec.valueStart + 1) +
                fpPrefix + newReg +
                entryText.substring(kStrEnd - 1);
              renamed++;
            } else {
              // Fallback: try StaticItem $fstrref for already-corrupted saves
              const siSec = entryT.findSection('StaticItem');
              let resolved = false;
              if (siSec) {
                const siVal = entryText.substring(siSec.valueStart, siSec.valueEnd);
                const siFpPrefix = '$fstrref:"flight-plan:';
                if (siVal.startsWith(siFpPrefix) && siVal.endsWith('"')) {
                  const siReg = siVal.substring(siFpPrefix.length, siVal.length - 1);
                  if (validRegs.has(siReg)) {
                    modifiedEntry =
                      entryText.substring(0, kSec.valueStart + 1) +
                      fpPrefix + siReg +
                      entryText.substring(kStrEnd - 1);
                    renamed++;
                    resolved = true;
                  }
                }
              }
              if (!resolved) {
                isOrphan = true;
              }
            }
          }
        } else if (key.startsWith(acPrefix) && !key.startsWith(aaPrefix)) {
          // â”€â”€ aircraft:REG (exclude aircraft-animator:aircraft:REG) â”€â”€
          const reg = key.substring(acPrefix.length);
          if (!validRegs.has(reg)) {
            if (renameMap && renameMap.has(reg)) {
              const newReg = renameMap.get(reg);
              modifiedEntry =
                entryText.substring(0, kSec.valueStart + 1) +
                acPrefix + newReg +
                entryText.substring(kStrEnd - 1);
              renamed++;
            } else {
              // Full removal. The orphaned entry's $id values may be
              // referenced via $iref from survivors, but those $id values
              // are owned by the Aircraft inside jetway DockingAircraft
              // (preserved by _resetFrameJetwayDockingState), not by this
              // entry which uses $v: $iref:N.
              isOrphan = true;
            }
          }
        } else if (key.startsWith(aaPrefix)) {
          // â”€â”€ aircraft-animator:aircraft:REG â”€â”€
          const reg = key.substring(aaPrefix.length);
          if (!validRegs.has(reg)) {
            if (renameMap && renameMap.has(reg)) {
              const newReg = renameMap.get(reg);
              modifiedEntry =
                entryText.substring(0, kSec.valueStart + 1) +
                aaPrefix + newReg +
                entryText.substring(kStrEnd - 1);
              renamed++;
            } else {
              isOrphan = true;
            }
          }
        }
      }
    }

    entries.push({ text: modifiedEntry, orphan: isOrphan });
    pos = entryEnd;
  }

  // â”€â”€ Reconstruct â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const kept = entries.filter(e => !e.orphan);
  const removed = entries.length - kept.length;
  let result = frameText;

  if (removed > 0 || renamed > 0) {
    const newContent = kept.map(e => e.text).join(',\n');
    let newBeforeRc = beforeRc;

    // Update $rlength if entries were removed
    if (removed > 0) {
      const rlSec = reT.findSection('$rlength');
      if (rlSec) {
        // rlSec positions are in reText space â†’ map to frameText space
        const oldRlen = parseInt(reText.substring(rlSec.valueStart, rlSec.valueEnd), 10);
        const newRlen = Math.max(0, oldRlen - removed);
        const rlStartF = frameReStart + rlSec.valueStart;
        const rlEndF = frameReStart + rlSec.valueEnd;
        newBeforeRc =
          beforeRc.substring(0, rlStartF) + String(newRlen) +
          beforeRc.substring(rlEndF);
      }
    }

    result = newBeforeRc + newContent + afterRc;
  }

  return { text: result, removed, renamed };
}

/**
 * Clear all entries from the EventLog's LatestEvents dictionary
 * inside the "singleton:event-log" RuntimeEntity entry.
 *
 * On every save, the LatestEvents dictionary is fully cleared to
 * prevent stale "aircraft:REG" entries from accumulating when
 * flights are deleted.  The dictionary metadata fields (e.g. comparer)
 * and structure outside $rcontent/$rlength are preserved.
 */
function _cleanupEventLogLatestEvents(frameText, log) {
  // â”€â”€ Navigate to RuntimeEntities.$rcontent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const t = createTokenizer(frameText);
  const reSec = t.findSection('RuntimeEntities');
  if (!reSec) return { text: frameText, removed: 0 };

  const reText = t.substring(reSec.valueStart, reSec.valueEnd);
  const reT = createTokenizer(reText);
  const rcSec = reT.findSection('$rcontent');
  if (!rcSec) return { text: frameText, removed: 0 };

  const rcStart = rcSec.valueStart;
  if (reText[rcStart] !== '[') return { text: frameText, removed: 0 };
  const rcEnd = reT.findArrayEnd(rcStart);
  if (rcEnd === null) return { text: frameText, removed: 0 };

  const frameReStart = reSec.valueStart;

  // â”€â”€ Find the singleton:event-log entry within RuntimeEntities â”€â”€â”€â”€
  const reContent = reText.substring(rcStart + 1, rcEnd - 1);
  const reContentT = createTokenizer(reContent);

  let elPos = -1;
  let elEntryText = null;
  let pos = 0;
  while (pos < reContent.length) {
    while (pos < reContent.length && ' \t\n\r'.includes(reContent[pos])) pos++;
    if (pos >= reContent.length) break;
    if (reContent[pos] === ',') { pos++; continue; }
    if (reContent[pos] !== '{') { pos++; continue; }

    const entryEnd = reContentT.findObjectEnd(pos);
    if (entryEnd === null) break;
    const entryText = reContent.substring(pos, entryEnd);
    const entryT = createTokenizer(entryText);
    const kSec = entryT.findSection('$k');
    if (kSec) {
      const kStrEnd = entryT.skipString(kSec.valueStart);
      if (kStrEnd) {
        const key = entryText.substring(kSec.valueStart + 1, kStrEnd - 1);
        if (key === 'singleton:event-log') {
          elPos = pos;
          elEntryText = entryText;
          break;
        }
      }
    }
    pos = entryEnd;
  }

  if (elPos < 0) return { text: frameText, removed: 0 };

  // â”€â”€ Navigate into $v.LatestEvents.$rcontent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const elT = createTokenizer(elEntryText);
  const vSec = elT.findSection('$v');
  if (!vSec) return { text: frameText, removed: 0 };

  const vText = elEntryText.substring(vSec.valueStart, vSec.valueEnd);
  const vT = createTokenizer(vText);
  const leSec = vT.findSection('LatestEvents');
  if (!leSec) return { text: frameText, removed: 0 };

  const leText = vText.substring(leSec.valueStart, leSec.valueEnd);
  const leT = createTokenizer(leText);
  const leRcSec = leT.findSection('$rcontent');
  if (!leRcSec) return { text: frameText, removed: 0 };

  const leRcStart = leRcSec.valueStart;
  if (leText[leRcStart] !== '[') return { text: frameText, removed: 0 };
  const leRcEnd = leT.findArrayEnd(leRcStart);
  if (leRcEnd === null) return { text: frameText, removed: 0 };

  // Parts for reassembly (positions relative to leText)
  const leContent = leText.substring(leRcStart + 1, leRcEnd - 1);
  const leContentT = createTokenizer(leContent);

  // â”€â”€ Count existing LatestEvents entries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let entryCount = 0;
  let lePos = 0;
  while (lePos < leContent.length) {
    while (lePos < leContent.length && ' \t\n\r'.includes(leContent[lePos])) lePos++;
    if (lePos >= leContent.length) break;
    if (leContent[lePos] === ',') { lePos++; continue; }
    if (leContent[lePos] !== '{') { lePos++; continue; }
    const entryEnd = leContentT.findObjectEnd(lePos);
    if (entryEnd === null) break;
    entryCount++;
    lePos = entryEnd;
  }

  if (entryCount === 0) {
    return { text: frameText, removed: 0 };
  }

  // â”€â”€ Clear LatestEvents.$rcontent and set $rlength to 0 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const leRlSec = leT.findSection('$rlength');
  let newLeText;
  if (leRlSec) {
    newLeText =
      leText.substring(0, leRlSec.valueStart) + '0' +
      leText.substring(leRlSec.valueEnd, leRcStart + 1) +
      ']' +
      leText.substring(leRcEnd);
  } else {
    // Fallback: just clear the array content
    newLeText =
      leText.substring(0, leRcStart + 1) + ']' +
      leText.substring(leRcEnd);
  }

  // â”€â”€ Reconstruct $v â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const leStartInV = leSec.valueStart;
  const newVText =
    vText.substring(0, leStartInV) + newLeText + vText.substring(leStartInV + leText.length);

  // â”€â”€ Reconstruct event-log entry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const vStartInEl = vSec.valueStart;
  const newElEntry =
    elEntryText.substring(0, vStartInEl) + newVText + elEntryText.substring(vStartInEl + vText.length);

  // â”€â”€ Reconstruct the full frame â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const elStartInRe = frameReStart + rcStart + 1 + elPos;
  const result =
    frameText.substring(0, elStartInRe) + newElEntry +
    frameText.substring(elStartInRe + elEntryText.length);

  return { text: result, removed: entryCount };
}

/**
 * v4: Constructively rebuild jetway RuntimeEntities entries.
 *
 * For each jetway entry in RuntimeEntities, checks if a DEP flight exists
 * on the matching stand.  If no DEP flight exists and the DockingAircraft
 * is non-null, replaces the ENTIRE entry with a clean empty state built
 * from template constants (not patched from the original text).
 *
 * This replaces the modification-based _resetFrameJetwayDockingState with
 * a constructive approach: empty entries are built from scratch, ensuring
 * no stale fields survive.  Active (docked) entries are left as-is since
 * the game's serialization is correct for them.
 *
 * Two-pass design:
 *   Pass 1 â€” Identify stale jetways and collect $idâ†’$type mappings for
 *             shared resources that other entries $iref to.
 *   Pass 2 â€” Build replacement text.  Entries that $iref to $id values
 *             orphaned by a cleared jetway get inline replacements.
 */

/**
 * Extract the $id of the inner AircraftEvent[] from a $v block's
 * _receivedEvents section.  Returns the numeric $id if the entry has
 * an inline AircraftEvent[] definition, or null if it uses $iref
 * or has no _receivedEvents.
 */
function _extractRecvEventsInnerId(vBlock) {
  if (!vBlock) return null;
  const t = createTokenizer(vBlock);
  const reSec = t.findSection('_receivedEvents');
  if (!reSec) return null;
  const reObjText = vBlock.substring(reSec.valueStart, reSec.valueEnd);
  if (!reObjText || reObjText[0] !== '{') return null;
  // The _receivedEvents value is an object with "$id", "$type", and inner value
  const rt = createTokenizer(reObjText);
  // Skip past "$id" and "$type" entries to find the inner value
  const typeSec = rt.findSection('$type');
  if (!typeSec) return null;
  // Inner value starts after $type's value + comma
  let pos = typeSec.valueEnd;
  while (pos < reObjText.length && ' \t\n\r,'.includes(reObjText[pos])) pos++;
  if (pos >= reObjText.length) return null;
  if (reObjText.substring(pos).startsWith('$iref:')) return null; // reference, not definition
  if (reObjText[pos] !== '{') return null;
  // Inline object â€” extract its $id
  const innerEnd = rt.findObjectEnd ? (function() {
    const tt = createTokenizer(reObjText);
    return tt.findObjectEnd(pos);
  })() : null;
  if (innerEnd === null) return null;
  const innerObj = reObjText.substring(pos, innerEnd);
  const it = createTokenizer(innerObj);
  const idSec = it.findSection('$id');
  if (!idSec) return null;
  return parseInt(innerObj.substring(idSec.valueStart, idSec.valueEnd), 10);
}

/**
 * Extract the inner ECommand[] $id from a jetway $v block's _waitingForCommands.
 * Returns null if the entry uses $iref (reference, not definition) or is missing.
 * @param {string} vBlock - the $v value of a jetway entry
 * @returns {number|null} inner ECommand[] $id, or null
 */
function _extractWaitingCmdsInnerId(vBlock) {
  if (!vBlock) return null;
  const t = createTokenizer(vBlock);
  const wcSec = t.findSection('_waitingForCommands');
  if (!wcSec) return null;
  const wcObjText = vBlock.substring(wcSec.valueStart, wcSec.valueEnd);
  if (!wcObjText || wcObjText[0] !== '{') return null;
  const wt = createTokenizer(wcObjText);
  const typeSec = wt.findSection('$type');
  if (!typeSec) return null;
  let pos = typeSec.valueEnd;
  while (pos < wcObjText.length && ' \t\n\r,'.includes(wcObjText[pos])) pos++;
  if (pos >= wcObjText.length) return null;
  if (wcObjText.substring(pos).startsWith('$iref:')) return null;
  if (wcObjText[pos] !== '{') return null;
  const innerEnd = wt.findObjectEnd ? (function() {
    const tt = createTokenizer(wcObjText);
    return tt.findObjectEnd(pos);
  })() : null;
  if (innerEnd === null) return null;
  const innerObj = wcObjText.substring(pos, innerEnd);
  const it = createTokenizer(innerObj);
  const idSec = it.findSection('$id');
  if (!idSec) return null;
  return parseInt(innerObj.substring(idSec.valueStart, idSec.valueEnd), 10);
}

/**
 * Rebuild the _receivedEvents field inside an aircraft entry's $v block
 * to use the shared canonical AircraftEvent[] definition.
 *
 * If recvEventsCache.canonicalId is set, replaces the inner value with
 * $iref:<canonicalId>.  If not yet set (first aircraft), keeps the inline
 * definition and caches its $id as the canonical one.
 *
 * @param {string} entryText - full $k/$v entry text (e.g. {"$k": "aircraft:B-1234", "$v": {...}})
 * @param {object} recvEventsCache - { canonicalId: number|null }
 * @returns {string} entryText with _receivedEvents inner value rebuilt
 */
function _rebuildReceivedEventsInEntry(entryText, _recvEventsCache) {
  // No-op: $iref sharing disabled (caused forward-reference crashes in Unity's
  // JsonDataReader when aircraft entries used $iref to jetway-defined ids).
  return entryText;
  const t = createTokenizer(entryText);

  // Find the $v block
  const vSec = t.findSection('$v');
  if (!vSec) return entryText;
  const vBlock = entryText.substring(vSec.valueStart, vSec.valueEnd);
  if (!vBlock || vBlock[0] !== '{') return entryText;

  // Find _receivedEvents inside $v
  const vt = createTokenizer(vBlock);
  const reSec = vt.findSection('_receivedEvents');
  if (!reSec) return entryText;

  // The _receivedEvents value object
  const reStart = reSec.valueStart;
  const reEnd = vt.findObjectEnd(reStart);
  if (reEnd === null) return entryText;
  const reObj = vBlock.substring(reStart, reEnd);

  // Find the inner value (after "$id" and "$type" entries)
  const rt = createTokenizer(reObj);
  const typeSec = rt.findSection('$type');
  if (!typeSec) return entryText;

  // Inner value starts after $type's value end + commas/whitespace
  let innerStart = typeSec.valueEnd;
  while (innerStart < reObj.length && ' \t\n\r,'.includes(reObj[innerStart])) innerStart++;
  if (innerStart >= reObj.length) return entryText;

  // Find inner value end
  let innerEnd;
  if (reObj.substring(innerStart).startsWith('$iref:')) {
    // $iref:N â€” scan past the digits
    innerEnd = innerStart + 6; // skip "$iref:"
    while (innerEnd < reObj.length && reObj[innerEnd] >= '0' && reObj[innerEnd] <= '9') innerEnd++;
  } else if (reObj[innerStart] === '{') {
    innerEnd = rt.findObjectEnd(innerStart);
    if (innerEnd === null) return entryText;
  } else {
    return entryText; // unrecognized format
  }

  const innerVal = reObj.substring(innerStart, innerEnd);

  if (recvEventsCache.canonicalId !== null) {
    // Already have a canonical definition â€” replace this inner value with $iref
    const newInner = '$iref:' + recvEventsCache.canonicalId;
    if (innerVal === newInner) return entryText; // already correct
    const before = entryText.substring(0, vSec.valueStart + reStart + innerStart);
    const after = entryText.substring(vSec.valueStart + reStart + innerEnd);
    return before + newInner + after;
  } else {
    // First occurrence â€” extract its $id as the canonical one
    if (reObj[innerStart] === '{') {
      const it = createTokenizer(innerVal);
      const idSec = it.findSection('$id');
      if (idSec) {
        recvEventsCache.canonicalId = parseInt(innerVal.substring(idSec.valueStart, idSec.valueEnd), 10);
      }
    }
    // If it's an $iref with no canonical set, that's fine â€” this is the first entry
    // and it's already a reference. The inline definition must be elsewhere in the segment.
    // We just don't set canonicalId in this case.
    return entryText;
  }
}

/**
 * Rebuild the _waitingForCommands field inside an aircraft entry's $v block
 * to use the shared canonical ECommand[] definition.
 *
 * If waitingCmdsCache.canonicalId is set, replaces the inner value with
 * $iref:<canonicalId>.  If not yet set (first aircraft), keeps the inline
 * definition and caches its $id as the canonical one.
 *
 * @param {string} entryText - full $k/$v entry text (e.g. {"$k": "aircraft:B-1234", "$v": {...}})
 * @param {object} waitingCmdsCache - { canonicalId: number|null }
 * @returns {string} entryText with _waitingForCommands inner value rebuilt
 */
function _rebuildWaitingCommandsInEntry(entryText, _waitingCmdsCache) {
  // No-op: $iref sharing disabled (caused forward-reference crashes in Unity's
  // JsonDataReader when aircraft entries used $iref to jetway-defined ids).
  return entryText;
  const t = createTokenizer(entryText);

  // Find the $v block
  const vSec = t.findSection('$v');
  if (!vSec) return entryText;
  const vBlock = entryText.substring(vSec.valueStart, vSec.valueEnd);
  if (!vBlock || vBlock[0] !== '{') return entryText;

  // Find _waitingForCommands inside $v
  const vt = createTokenizer(vBlock);
  const wcSec = vt.findSection('_waitingForCommands');
  if (!wcSec) return entryText;

  // The _waitingForCommands value object
  const wcStart = wcSec.valueStart;
  const wcEnd = vt.findObjectEnd(wcStart);
  if (wcEnd === null) return entryText;
  const wcObj = vBlock.substring(wcStart, wcEnd);

  // Find the inner value (after "$id" and "$type" entries)
  const wt = createTokenizer(wcObj);
  const typeSec = wt.findSection('$type');
  if (!typeSec) return entryText;

  // Inner value starts after $type's value end + commas/whitespace
  let innerStart = typeSec.valueEnd;
  while (innerStart < wcObj.length && ' \t\n\r,'.includes(wcObj[innerStart])) innerStart++;
  if (innerStart >= wcObj.length) return entryText;

  // Find inner value end
  let innerEnd;
  if (wcObj.substring(innerStart).startsWith('$iref:')) {
    // $iref:N â€” scan past the digits
    innerEnd = innerStart + 6; // skip "$iref:"
    while (innerEnd < wcObj.length && wcObj[innerEnd] >= '0' && wcObj[innerEnd] <= '9') innerEnd++;
  } else if (wcObj[innerStart] === '{') {
    innerEnd = wt.findObjectEnd(innerStart);
    if (innerEnd === null) return entryText;
  } else {
    return entryText; // unrecognized format
  }

  const innerVal = wcObj.substring(innerStart, innerEnd);

  if (waitingCmdsCache.canonicalId !== null) {
    // Already have a canonical definition â€” replace this inner value with $iref
    const newInner = '$iref:' + waitingCmdsCache.canonicalId;
    if (innerVal === newInner) return entryText; // already correct
    const before = entryText.substring(0, vSec.valueStart + wcStart + innerStart);
    const after = entryText.substring(vSec.valueStart + wcStart + innerEnd);
    return before + newInner + after;
  } else {
    // First occurrence â€” extract its $id as the canonical one
    if (wcObj[innerStart] === '{') {
      const it = createTokenizer(innerVal);
      const idSec = it.findSection('$id');
      if (idSec) {
        waitingCmdsCache.canonicalId = parseInt(innerVal.substring(idSec.valueStart, idSec.valueEnd), 10);
      }
    }
    return entryText;
  }
}

/**
 * Pre-validation: check for stand occupancy conflicts across all flights.
 *
 * For each stand, collects all flights (ARR + DEP), sorts by their event time
 * (LandingTime for arrivals, OffBlockTime for departures), and verifies that
 * consecutive ARRâ†’DEP pairs have matching registrations (same aircraft).
 *
 * A stand may host multiple sequential turnarounds with different aircraft:
 *   Arr A (REG:X) â†’ Dep B (REG:X) â†’ Arr C (REG:Y) â†’ Dep D (REG:Y)
 * Sorting by time and checking only ARRâ†’DEP neighbors handles this correctly.
 *
 * Throws on conflict â€” called before the save pipeline so the user sees a
 * descriptive error rather than a corrupted save.
 *
 * @param {Array} flights â€” editor state flight objects
 */
function _validateStandConflicts(flights) {
  // Group flights by stand
  const byStand = new Map();
  for (const fl of flights) {
    if (!fl.Stand) continue;
    const standKey = String(fl.Stand).replace(/^0+/, '');
    if (!byStand.has(standKey)) byStand.set(standKey, []);

    const isDep = fl.isDeparture === true;
    const time = isDep ? (fl.OffBlockTime || '') : (fl.LandingTime || '');
    const reg = fl._Registration || fl.Registration || '';
    const cs = fl.CallSign || '';

    byStand.get(standKey).push({ flight: fl, type: isDep ? 'DEP' : 'ARR', time, reg, cs });
  }

  for (const [standKey, entries] of byStand) {
    // Sort by time (HH:MM:SS lexicographic â€” zero-padded, same-day, correct)
    entries.sort((a, b) => a.time.localeCompare(b.time));

    // Check consecutive ARR â†’ DEP pairs
    for (let i = 0; i < entries.length - 1; i++) {
      const curr = entries[i];
      const next = entries[i + 1];

      if (curr.type === 'ARR' && next.type === 'DEP') {
        if (curr.reg !== next.reg) {
          throw new Error(
            `Save aborted: Stand ${standKey} conflict â€” ` +
            `arrival ${curr.cs} (${curr.reg}) at ${curr.time} ` +
            `and departure ${next.cs} (${next.reg}) at ${next.time} ` +
            `have different registrations. ` +
            `A stand cannot hold two different aircraft simultaneously.`
          );
        }
        // Same REG â†’ valid turnaround (aircraft arrives, stays, departs)
      }
      // DEP â†’ ARR: one aircraft left, another arrives later â€” normal
      // DEP â†’ DEP or ARR â†’ ARR: unusual but handled by other validators
    }
  }
}

function _rebuildJetwayEntries(segmentText, flights, validRegs, approachCache, log, idMapper, baseDateTicks, icao) {
  // â”€â”€ Navigate to RuntimeEntities.$rcontent structurally â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const t = createTokenizer(segmentText);
  const reSec = t.findSection('RuntimeEntities');
  if (!reSec) return { text: segmentText, resetCount: 0, activeJetways: [], recvEventsCache: { canonicalId: null }, waitingCmdsCache: { canonicalId: null } };

  const reText = t.substring(reSec.valueStart, reSec.valueEnd);
  const reT = createTokenizer(reText);
  const rcSec = reT.findSection('$rcontent');
  if (!rcSec) return { text: segmentText, resetCount: 0, activeJetways: [], recvEventsCache: { canonicalId: null }, waitingCmdsCache: { canonicalId: null } };

  const rcStart = rcSec.valueStart;
  if (reText[rcStart] !== '[') return { text: segmentText, resetCount: 0, activeJetways: [], recvEventsCache: { canonicalId: null }, waitingCmdsCache: { canonicalId: null } };
  const rcEnd = reT.findArrayEnd(rcStart);
  if (rcEnd === null) return { text: segmentText, resetCount: 0, activeJetways: [], recvEventsCache: { canonicalId: null }, waitingCmdsCache: { canonicalId: null } };

  const frameReStart = reSec.valueStart;
  const content = reText.substring(rcStart + 1, rcEnd - 1);
  const contentT = createTokenizer(content);

  // Build stand â†’ flight lookup (DEP flights only).
  // When multiple DEPs share a stand, keep the one with the earliest OffBlockTime.
  const standFlights = new Map();
  for (const fl of flights) {
    const isDep = fl.isDeparture === true;
    if (isDep && fl.Stand) {
      const standKey = String(fl.Stand).replace(/^0+/, ''); // normalize "02" â†’ "2"
      const existing = standFlights.get(standKey);
      if (!existing || (fl.OffBlockTime || '') < (existing.OffBlockTime || '')) {
        standFlights.set(standKey, fl);
      }
    }
  }

  // Build stand â†’ all arrivals lookup for turnaround detection.
  // A single stand may host multiple sequential turnarounds with different
  // aircraft, so we store an array per stand (not a single value).
  //
  // NOTE: We do NOT filter on fl.LandingTime being truthy. ticksToTime(0)
  // returns "" for midnight (00:00:00), which would incorrectly exclude
  // midnight arrivals from turnaround detection. The time comparison in
  // the turnaround check handles empty strings correctly.
  const standArrFlights = new Map(); // standKey â†’ [arrFlight, ...]
  for (const fl of flights) {
    const isDep = fl.isDeparture === true;
    if (!isDep && fl.Stand != null && fl.Stand !== '') {
      const standKey = String(fl.Stand).replace(/^0+/, '');
      if (!standArrFlights.has(standKey)) standArrFlights.set(standKey, []);
      standArrFlights.get(standKey).push(fl);
    }
  }

  // â”€â”€ PASS 1: Parse entry metadata â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const entryInfos = []; // { entryText, key, isJetway, entryId, vBlock }
  let pos = 0;

  while (pos < content.length) {
    while (pos < content.length && ' \t\n\r'.includes(content[pos])) pos++;
    if (pos >= content.length) break;
    if (content[pos] === ',') { pos++; continue; }
    if (content[pos] !== '{') { pos++; continue; }

    const entryEnd = contentT.findObjectEnd(pos);
    if (entryEnd === null) break;
    const entryText = content.substring(pos, entryEnd);
    const entryT = createTokenizer(entryText);

    const info = { entryText, key: '', isJetway: false, entryId: 0, vBlock: '' };
    const kSec = entryT.findSection('$k');
    if (kSec) {
      const kStrEnd = entryT.skipString(kSec.valueStart);
      if (kStrEnd) {
        info.key = entryText.substring(kSec.valueStart + 1, kStrEnd - 1);
        info.isJetway = info.key.startsWith('jetway:');
      }
    }
    // Extract the $v block to find sub-object $ids later
    const vSec = entryT.findSection('$v');
    if (vSec) info.vBlock = entryText.substring(vSec.valueStart, vSec.valueEnd);
    const idSec = entryT.findSection('$id');
    if (idSec) info.entryId = parseInt(entryText.substring(idSec.valueStart, idSec.valueEnd), 10);

    entryInfos.push(info);
    pos = entryEnd;
  }

  // ---- Extract full-form type declarations from the original text ----
  // When we replace jetway entries in PASS 2, the full-form "$type": "3|..."
  // declarations inside those entries are lost.  If another entry still
  // uses bare "$type": 3, the JSONâ†’binary encoder fails with "unknown type
  // id 3" because the type was never registered in that blobdoc scope.
  // We extract these declarations before rebuilding so the new entries can
  // carry their own full-form type strings.
  const jwTypeMap = new Map();
  const jwDeclRe = /"\$type":\s*"(\d+)\|([^"]+)"/g;
  let jm;
  while ((jm = jwDeclRe.exec(content)) !== null) {
    const num = parseInt(jm[1], 10);
    if (!jwTypeMap.has(num)) jwTypeMap.set(num, jm[2]);
  }

  // ---- Pre-scan: collect old _receivedEvents AircraftEvent[] $id values ----
  // so we can register oldâ†’new mappings in the IdMapper after rebuild.
  const oldRecvEventIds = [];
  const oldWaitingCmdIds = [];
  for (const info of entryInfos) {
    if (info.isJetway) {
      const oldId = _extractRecvEventsInnerId(info.vBlock);
      if (oldId !== null) oldRecvEventIds.push(oldId);
      const oldWcId = _extractWaitingCmdsInnerId(info.vBlock);
      if (oldWcId !== null) oldWaitingCmdIds.push(oldWcId);
    }
  }
  // Caches for the canonical AircraftEvent[] and ECommand[] $ids shared across all entries
  const recvEventsCache = { canonicalId: null };
  const waitingCmdsCache = { canonicalId: null };

  // ---- PASS 2: Rebuild each entry constructively ---------------------
  const segments = [];
  let resetCount = 0;
  const activeJetways = [];
  const exhaustedStands = new Set();
  const exhaustedFlights = new Set();

  for (const info of entryInfos) {
    if (!info.isJetway) {
      segments.push(info.entryText);
      continue;
    }

    const jwNum = info.key.substring('jetway:'.length);
    const standId = String(parseInt(jwNum, 10));
    let depFlight = standFlights.get(standId);
    const flightReg = depFlight ? (depFlight._Registration || depFlight.Registration || '') : '';

    // â”€â”€ Turnaround check â”€â”€
    // When the same stand hosts both an arrival and departure for the same
    // aircraft (matching registration), and the arrival lands before the
    // departure off-block, the aircraft hasn't arrived at the gate yet.
    // The jetway must be empty.
    //
    // Different aircraft at the same stand (different REGs) is normal â€”
    // sequential turnarounds.  Pre-validation (_validateStandConflicts)
    // already caught true conflicts where two different aircraft would
    // occupy the same stand simultaneously.
    if (depFlight) {
      const depReg = depFlight._Registration || depFlight.Registration || '';
      const arrs = standArrFlights.get(standId);
      if (arrs && depReg) {
        const matchingArr = arrs.find(af =>
          (af._Registration || af.Registration || '') === depReg
        );
        if (matchingArr) {
          const depOffBlock = depFlight.OffBlockTime || '';
          const arrLanding = matchingArr.LandingTime || '';
          if (arrLanding < depOffBlock) {
            log('Stand ' + standId + ': turnaround ' + depReg +
              ' â€” arrival ' + arrLanding + ' < off-block ' + depOffBlock +
              ', skipping jetway population');
            depFlight = null;
          }
        }
      }
    }

    // Bilateral exhaustion: both stand AND flight must be fresh.
    // If either was already assigned to a previous jetway, skip â†’ empty jetway.
    if (depFlight && !exhaustedStands.has(standId) && !exhaustedFlights.has(flightReg)) {
      exhaustedStands.add(standId);
      exhaustedFlights.add(flightReg);

      // ---- Active jetway: rebuild DockingAircraft with flight data ----
      const built = _buildActiveJetwayEntry(info, depFlight, approachCache, log, jwTypeMap, baseDateTicks, icao, recvEventsCache, waitingCmdsCache);
      if (built.text !== info.entryText) resetCount++;
      segments.push(built.text);
      activeJetways.push({
        stand: standId,
        reg: built.reg,
        flightPlanId: built.flightPlanId,
        aircraftId: built.aircraftId,
      });
    } else {
      // ---- Empty jetway: write cleared format ---------------------
      const entryT = createTokenizer(info.entryText);
      const idSec = entryT.findSection('$id');
      const entryId = idSec ? parseInt(info.entryText.substring(idSec.valueStart, idSec.valueEnd), 10) : 0;

      const origProgressId = _extractSubId(info.entryText, 'Progress');
      const origDaId = _extractSubId(info.entryText, 'DockingAircraft');
      const origDdiId = _extractSubId(info.entryText, 'DockingDoorIndex');
      const progressId = origProgressId || (entryId + 1);
      const daId = origDaId || (progressId + 1);
      const ddiId = origDdiId || (daId + 1);

      // Use full-form type strings extracted from the original RuntimeEntities
      // so the new entries declare their types even if the original declarations
      // were in the entries being replaced.
      const T3 = jwTypeMap.has(3) ? '"3|' + jwTypeMap.get(3) + '"' : '3';
      const T4 = jwTypeMap.has(4) ? '"4|' + jwTypeMap.get(4) + '"' : '4';
      const T5 = jwTypeMap.has(5) ? '"5|' + jwTypeMap.get(5) + '"' : '5';
      const T6 = jwTypeMap.has(6) ? '"6|' + jwTypeMap.get(6) + '"' : '6';

      segments.push([
        '                            {',
        '                                "$k": "' + info.key + '",',
        '                                "$v": {',
        '                                    "$id": ' + entryId + ',',
        '                                    "$type": ' + T3 + ',',
        '                                    "Status": 0,',
        '                                    "Progress": {',
        '                                        "$id": ' + progressId + ',',
        '                                        "$type": ' + T4 + ',',
        '                                        0',
        '                                    },',
        '                                    "DockingAircraft": {',
        '                                        "$id": ' + daId + ',',
        '                                        "$type": ' + T5 + ',',
        '                                        null',
        '                                    },',
        '                                    "DockingDoorIndex": {',
        '                                        "$id": ' + ddiId + ',',
        '                                        "$type": ' + T6 + ',',
        '                                        -1',
        '                                    },',
        '                                    "TrigEvent": false,',
        '                                    "AutoUndockFinished": false',
        '                                }',
        '                            }',
      ].join('\n'));
      resetCount++;
    }
  }

  // Register oldâ†’new _receivedEvents AircraftEvent[] $id mappings
  // so the centralized $iref remap step can fix preserved entries
  if (recvEventsCache.canonicalId !== null && idMapper) {
    for (const oldId of oldRecvEventIds) {
      idMapper.map(oldId, recvEventsCache.canonicalId);
    }
  }
  if (waitingCmdsCache.canonicalId !== null && idMapper) {
    for (const oldId of oldWaitingCmdIds) {
      idMapper.map(oldId, waitingCmdsCache.canonicalId);
    }
  }

  if (resetCount === 0 && activeJetways.length === 0) return { text: segmentText, resetCount: 0, activeJetways: [], recvEventsCache, waitingCmdsCache };

  // Reconstruct the $rcontent with correct $rlength
  const beforeRc = segmentText.substring(0, frameReStart + rcStart + 1);
  const afterRc = segmentText.substring(frameReStart + rcEnd - 1);
  const newContent = segments.join(',\n');
  const newRlen = segments.length;

  const rlSec = reT.findSection('$rlength');
  let newBeforeRc = beforeRc;
  if (rlSec) {
    const rlStartF = frameReStart + rlSec.valueStart;
    const rlEndF = frameReStart + rlSec.valueEnd;
    newBeforeRc = beforeRc.substring(0, rlStartF) + String(newRlen) + beforeRc.substring(rlEndF);
  }

  log('Reset ' + resetCount + ' jetway docking state(s) (constructive)');
  return { text: newBeforeRc + newContent + afterRc, resetCount, activeJetways, recvEventsCache, waitingCmdsCache };
}

/**
 * Constructively rebuild flight-plan:REG, aircraft:REG, and
 * aircraft-animator:aircraft:REG entries in RuntimeEntities after jetway
 * entries have been rebuilt (Step 7b-1).
 *
 * ALL three entry types are deleted and rebuilt from scratch using the
 * editor's internal flight state.  This replaces the previous approach
 * of preserving aircraft/animator entries and only deleting flight-plan
 * entries â€” now that aircraft:REG entries are generated for new REGs,
 * preserving old entries would leave stale data.
 *
 * Ordering is critical: flight-plan entries MUST come before aircraft/
 * animator/jetway entries so the game can deserialize $id values before
 * $iref references point to them.
 *
 * @param {string} segmentText - decoded text of one segment
 * @param {Array} flights - editor state flight objects
 * @param {BigInt} baseDateTicks - base date in .NET ticks for time conversion
 * @param {Set} validRegs - set of valid registration strings
 * @param {Array} activeJetways - [{ stand, reg, flightPlanId, aircraftId }] from _rebuildJetwayEntries
 * @param {Map} segTypeMap - per-segment type-numberâ†’full-name map (from Step 7a-2)
 * @param {Function} log - logging function
 * @param {_IdMapper} idMapper - per-segment IdMapper for $iref remapping
 * @param {string} icao - airport ICAO code
 * @param {object} recvEventsCache - { canonicalId } for _receivedEvents $iref sharing
 * @param {object} waitingCmdsCache - { canonicalId } for _waitingForCommands $iref sharing
 * @param {object} approachCache - approach cache from buildApproachCache
 * @param {string} fullText - full decoded ACL text (for stand position + approach path resolution)
 * @param {number} saveSec - save time in seconds since midnight
 * @returns {{ text: string, removed: number, added: number }}
 */
/**
 * Parse a RuntimeEntities dictionary entry text into a structured object.
 * Uses preprocessUnityJson + JSON.parse to handle Odin-specific constructs
 * ($iref, $fstrref, typed-value objects, etc.).
 *
 * @param {string} entryText - e.g. '{"$k": "flight-plan:B-1234", "$v": $iref:19}'
 * @returns {{ $k: string, $v: any }}
 */
function _parseEntry(entryText) {
  const preprocessed = preprocessUnityJson(entryText);
  return JSON.parse(preprocessed);
}

/**
 * Serialize a RuntimeEntities dictionary entry object back to Odin JSON text.
 *
 * @param {{ $k: string, $v: any }} entry
 * @param {number} indentUnits - indent level (in 4-space units)
 * @returns {string}
 */
function _serializeEntry(entry, indentUnits) {
  return serializeUnityJson(entry, { indent: indentUnits, indentSize: 4 });
}


/**
 * Reorder RuntimeEntities entries so that every $iref reference appears AFTER
 * the entry that declares the corresponding $id.  Operates on structured
 * objects (parsed via _parseEntry) — NO regex scanning of raw text.
 *
 * Walks each entry's object tree to find $id values and __iref targets.
 * An __iref target is satisfied if it appears in:
 *   - externalIds (from the parent dictionary structure outside $rcontent)
 *   - seenIds (from already-emitted entries)
 *   - the entry's own local $id set (self-contained entries)
 *
 * @param {object[]} entries - parsed entry objects { $k, $v }
 * @param {Function} log - logger
 * @param {Set<number>} externalIds - $id values declared outside $rcontent
 * @returns {object[]} reordered entries
 */

// ── Object-tree walk helpers (reused by _reorderIrefEntries) ─────────

/**
 * Walk an object tree and collect all $id numeric values.
 * @param {object} obj
 * @param {number[]} out
 */
function _collectObjIds(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (typeof obj.$id === 'number' && out.indexOf(obj.$id) < 0) out.push(obj.$id);
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (Array.isArray(v)) {
      for (var j = 0; j < v.length; j++) _collectObjIds(v[j], out);
    } else if (v && typeof v === 'object') {
      _collectObjIds(v, out);
    }
  }
}

/**
 * Walk an object tree and collect all __iref numeric target values.
 * @param {object} obj
 * @param {number[]} out
 */
function _collectObjIrefs(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (typeof obj.__iref === 'number') out.push(obj.__iref);
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (Array.isArray(v)) {
      for (var j = 0; j < v.length; j++) _collectObjIrefs(v[j], out);
    } else if (v && typeof v === 'object') {
      _collectObjIrefs(v, out);
    }
  }
}

// ── OdinEntry — lightweight wrapper around a parsed/serialized entry ──

/**
 * Wraps a RuntimeEntities entry so that metadata ($id, $iref targets)
 * and text serialization are tied to the same object.  This removes the
 * need for ad-hoc { text, ids, irefs } plain-object descriptors and
 * lets the iref reorder algorithm work with clean property accessors.
 *
 * Two construction paths:
 *   1. From an already-structured JS object  — e.g. a newly-built
 *      aircraft or flight-plan entry.  Text is lazy-serialized.
 *   2. From raw Odin text — for preserved ("kept") entries that we
 *      parse once via parseOdinObject to extract metadata but whose
 *      original text we want to emit as-is.
 *
 * @param {object} obj    — Parsed JS object (with $id, __iref, etc.)
 * @param {string} [text] — Pre-serialized text; if omitted, lazy-built
 *                           via _serializeEntry(obj, 6) when needed.
 */
function OdinEntry(obj, text) {
  this.obj = obj;
  this._text = text || null;
  this._ids = undefined;
  this._irefs = undefined;
}

Object.defineProperties(OdinEntry.prototype, {
  ids: {
    get: function() {
      if (this._ids === undefined) {
        this._ids = [];
        _collectObjIds(this.obj, this._ids);
      }
      return this._ids;
    },
    enumerable: true,
  },
  irefs: {
    get: function() {
      if (this._irefs === undefined) {
        this._irefs = [];
        _collectObjIrefs(this.obj, this._irefs);
      }
      return this._irefs;
    },
    enumerable: true,
  },
  text: {
    get: function() {
      if (this._text === null) {
        this._text = _serializeEntry(this.obj, 6);
      }
      return this._text;
    },
    set: function(v) { this._text = v; },
    enumerable: true,
  },
});

// ── Iref-aware entry reordering ──────────────────────────────────────

/**
 * Reorder RuntimeEntities entry descriptors so every $iref target appears
 * AFTER the descriptor that declares the corresponding $id.
 *
 * Each descriptor is { text, ids, irefs }:
 *   - text:  serialized entry string (preserved verbatim for output)
 *   - ids:   array of $id numbers declared WITHIN this entry
 *   - irefs: array of $iref target numbers in this entry
 *
 * Algorithm: linear pass with insert-at-position.  Descriptors whose
 * $iref targets are not yet satisfied are deferred.  When a descriptor
 * declaring a needed $id is emitted, any deferred descriptors waiting
 * for that $id are flushed at the current position.  Self-contained
 * entries (all irefs satisfied by their own ids) pass through directly.
 *
 * @param {{text:string, ids:number[], irefs:number[]}[]} descriptors
 * @param {Function} log
 * @param {Set<number>} externalIds — $id values declared outside $rcontent
 * @returns {{text:string, ids:number[], irefs:number[]}[]} reordered descriptors
 */
function _reorderIrefEntries(descriptors, log, externalIds) {
  var result = [];
  var deferred = new Map(); // targetId → [descriptors waiting for that $id]
  var seenIds = new Set(externalIds || []);

  log('_reorderIrefEntries: ' + descriptors.length + ' descriptors, ' + seenIds.size + ' externalIds');

  function processBatch(batch) {
    for (var i = 0; i < batch.length; i++) {
      var desc = batch[i];
      var ids = desc.ids || [];
      var irefs = desc.irefs || [];

      // Unresolved = $iref targets NOT in seenIds AND NOT in own ids
      var unresolved = [];
      for (var j = 0; j < irefs.length; j++) {
        var tid = irefs[j];
        if (!seenIds.has(tid) && ids.indexOf(tid) < 0) {
          unresolved.push(tid);
        }
      }

      if (unresolved.length > 0) {
        var key = unresolved[0];
        if (!deferred.has(key)) deferred.set(key, []);
        deferred.get(key).push(desc);
        log('  defer: waiting for $id:' + key + ' (unresolved=' + JSON.stringify(unresolved) + ')');
        continue;
      }

      // This descriptor can be emitted at current position
      result.push(desc);

      // Register this descriptor's $id values and flush deferred
      for (var k = 0; k < ids.length; k++) {
        var id = ids[k];
        seenIds.add(id);
        if (deferred.has(id)) {
          var waiting = deferred.get(id);
          deferred.delete(id);
          log('  resolve $id:' + id + ' — flushing ' + waiting.length + ' deferred at position ' + result.length);
          processBatch(waiting);
        }
      }
    }
  }

  processBatch(descriptors);

  // Assert: no unresolved deferred entries
  if (deferred.size > 0) {
    var remaining = 0;
    deferred.forEach(function(w) { remaining += w.length; });
    log('ERROR: _reorderIrefEntries — ' + deferred.size + ' id(s) still have ' +
      remaining + ' deferred entries after reorder (circular or missing $id)');
    deferred.forEach(function(waiting, id) {
      log('  - ' + waiting.length + ' entry(s) waiting for $id:' + id);
    });
    // Fall back to appending them anyway (better than silently dropping)
    deferred.forEach(function(waiting) {
      for (var m = 0; m < waiting.length; m++) result.push(waiting[m]);
    });
  }

  log('_reorderIrefEntries: result=' + result.length + ' entries');
  return result;
}

function _rebuildFlightRuntimeEntities(segmentText, flights, baseDateTicks, validRegs, activeJetways, segTypeMap, log, idMapper, icao, recvEventsCache, waitingCmdsCache, approachCache, fullText, saveSec) {
  // â”€â”€ Navigate to RuntimeEntities.$rcontent structurally â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const t = createTokenizer(segmentText);
  const reSec = t.findSection('RuntimeEntities');
  if (!reSec) return { text: segmentText, removed: 0, added: 0 };

  const reText = t.substring(reSec.valueStart, reSec.valueEnd);
  const reT = createTokenizer(reText);
  const rcSec = reT.findSection('$rcontent');
  if (!rcSec) return { text: segmentText, removed: 0, added: 0 };

  const rcStart = rcSec.valueStart;
  if (reText[rcStart] !== '[') return { text: segmentText, removed: 0, added: 0 };
  const rcEnd = reT.findArrayEnd(rcStart);
  if (rcEnd === null) return { text: segmentText, removed: 0, added: 0 };

  const frameReStart = reSec.valueStart;
  const beforeRc = segmentText.substring(0, frameReStart + rcStart + 1);
  const content = reText.substring(rcStart + 1, rcEnd - 1);
  const afterRc = segmentText.substring(frameReStart + rcEnd - 1);
  const contentT = createTokenizer(content);

  // â”€â”€ Resolve type numbers from segment's type map â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let fpTypeFull = '18|ContextCross.Models.FlightPlan, GroundATC.Core';
  let dtTypeFull = '19|System.DateTime, mscorlib';
  if (segTypeMap) {
    for (const [num, name] of segTypeMap) {
      if (name.startsWith('ContextCross.Models.FlightPlan,')) {
        fpTypeFull = num + '|' + name;
      }
      if (name.startsWith('System.DateTime,')) {
        dtTypeFull = num + '|' + name;
      }
    }
  }
  const FP_TYPE_STR = '"' + fpTypeFull + '"';
  const DT_TYPE_STR = '"' + dtTypeFull + '"';

  // Build reg â†’ flight lookup
  const regFlights = new Map();
  for (const fl of flights) {
    const reg = fl._Registration || fl.Registration || '';
    if (reg) regFlights.set(reg, fl);
  }

  // â”€â”€ PASS 1: Parse entries, remove all flight-plan:REG, aircraft:REG, â”€â”€
  //            and aircraft-animator:aircraft:REG. Keep everything else.
  const keptEntries = [];    // non-rebuilt entries preserved as raw text
  const removedKeys = [];    // flight-plan keys removed (for counting)
  const oldIdMap = new Map(); // reg â†’ old $id (for $iref remapping)
  let pos = 0;
  while (pos < content.length) {
    while (pos < content.length && ' \t\n\r'.includes(content[pos])) pos++;
    if (pos >= content.length) break;
    if (content[pos] === ',') { pos++; continue; }
    if (content[pos] !== '{') { pos++; continue; }

    const entryEnd = contentT.findObjectEnd(pos);
    if (entryEnd === null) break;
    const entryText = content.substring(pos, entryEnd);

    // Check $k value via tokenizer (fast, no full parse)
    const entryT = createTokenizer(entryText);
    const kSec = entryT.findSection('$k');
    let isRebuilt = false; // belongs to one of the three rebuilt types
    if (kSec) {
      const kStrEnd = entryT.skipString(kSec.valueStart);
      if (kStrEnd) {
        const key = entryText.substring(kSec.valueStart + 1, kStrEnd - 1);
        if (key.startsWith('flight-plan:')) {
          isRebuilt = true;
          const reg = key.substring('flight-plan:'.length);
          removedKeys.push(reg);
          const oldId = _extractEntryVId(entryText);
          if (oldId !== null) oldIdMap.set(reg, oldId);
        } else if (key.startsWith('aircraft-animator:aircraft:')) {
          isRebuilt = true; // animator entries fully rebuilt
        } else if (key.startsWith('aircraft:')) {
          isRebuilt = true; // aircraft entries fully rebuilt
        }
      }
    }

    if (!isRebuilt) {
      // Keep non-rebuilt entries (jetway, radio-channel, singleton, etc.)
      // as raw text to avoid lossy roundtrip through preprocessor→serializer.
      // The preprocessor handles common Odin tokens but kept entries can
      // contain deeply-nested ReactiveProperty<Aircraft> structures where
      // _fixTypedValues doesn't recursively handle all edge cases.
      keptEntries.push(entryText);
    }
    pos = entryEnd;
  }

  // â”€â”€ Scan kept entries for max existing $id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const allKeptText = keptEntries.join(',\n');
  let maxId = 0;
  const idRe = /"\$id":\s*(\d+)/g;
  let idMatch;
  while ((idMatch = idRe.exec(allKeptText)) !== null) {
    const val = parseInt(idMatch[1], 10);
    if (val > maxId) maxId = val;
  }
  let nextId = maxId + 1;

  // â”€â”€ Build activeJetways lookup: reg → { stand, reg, flightPlanId, aircraftId } ─
  // Used in PASS 2 to emit $v: $iref:N for registrations whose _flightPlan
  // is already inlined inside the jetway entry.
  // â†’ { aircraftId } â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const jwByReg = new Map();
  if (activeJetways) {
    for (const jw of activeJetways) {
      if (jw.reg) jwByReg.set(jw.reg, jw);
    }
  }

  // â”€â”€ Detect turnaround conflicts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // A REG used for both ARR+DEP needs only ONE aircraft entry.
  // If ARR lands before DEP off-blocks â†’ ARR creates the aircraft (in air).
  // If DEP off-blocks before ARR lands â†’ DEP creates it (at stand).
  const turnaroundWinner = new Map(); // reg â†’ 'arr'|'dep'
  for (const [reg, fl] of regFlights) {
    if (!validRegs.has(reg)) continue;
    // Find if this reg has both ARR and DEP flights
    let arrFlight = null, depFlight = null;
    for (const f of flights) {
      const fr = f._Registration || f.Registration || '';
      if (fr !== reg) continue;
      if (f.isDeparture === true) depFlight = f;
      else arrFlight = f;
    }
    if (arrFlight && depFlight) {
      const arrLT = String(arrFlight.LandingTime || '');
      const depOB = String(depFlight.OffBlockTime || '');
      if (arrLT && depOB) {
        turnaroundWinner.set(reg, arrLT < depOB ? 'arr' : 'dep');
      }
    }
  }

  // â”€â”€ PASS 2: Build new flight-plan:REG entries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const allFpEntries = [];
  const fpIdByReg = new Map(); // reg â†’ fpId (for PASS 3 $iref linking)

  for (const [reg, fl] of regFlights) {
    if (!validRegs.has(reg)) continue;

    // If this registration has a jetway entry (DEP flight at a stand),
    // the _flightPlan is already inlined inside the jetway — emit $iref
    // instead of duplicating the entire object.
    const jwInfo = jwByReg.get(reg);
    if (jwInfo) {
      const fpId = jwInfo.flightPlanId;
      fpIdByReg.set(reg, fpId);
      if (idMapper && oldIdMap.has(reg)) {
        idMapper.map(oldIdMap.get(reg), fpId);
      }

      allFpEntries.push({
        $k: 'flight-plan:' + reg,
        $v: { __iref: fpId },
      });
    } else {
      const isDep = fl.isDeparture === true;

      const arrRunway = isDep ? null : (fl.Runway || null);
      const arrStand = isDep ? null : (fl.Stand || null);
      const arrTicksStr = isDep ? '0' : String(_computeArrivalInBlockTicks(fl.LandingTime, fl.InBlockTime, baseDateTicks, icao));
      const depRunway = isDep ? (fl.Runway || null) : null;
      const depStand = isDep ? (fl.Stand || null) : null;
      const depTicksStr = isDep ? String(_computeTakeoffTicks(fl.TakeoffTime, fl.OffBlockTime, baseDateTicks, icao)) : '0';

      const fpId = nextId++;
      fpIdByReg.set(reg, fpId);
      if (idMapper && oldIdMap.has(reg)) {
        idMapper.map(oldIdMap.get(reg), fpId);
      }

      allFpEntries.push({
        $k: 'flight-plan:' + reg,
        $v: {
          $id: fpId,
          $type: fpTypeFull,
          StaticItem: { __fstrref: 'flight-plan:' + reg },
          _arrivalInBlockTime: {
            $type: dtTypeFull,
            __v: [arrTicksStr],
          },
          _arrivalActualInBlockTime: {
            $type: dtTypeFull,
            __v: ['0'],
          },
          _arrivalRunway: arrRunway,
          _arrivalStand: arrStand,
          _departureTakeoffTime: {
            $type: dtTypeFull,
            __v: [depTicksStr],
          },
          _departureRunway: depRunway,
          _departureStand: depStand,
        },
      });
    }
  }

  // â”€â”€ Scan kept entries for radio-channel $id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The game's aircraft entries $iref to a shared radio-channel entry.
  // Find the first kept entry with $k matching "radio-channel" and snag its $id.
  let radioChannelId = null;
  for (const entryText of keptEntries) {
    const kMatch = entryText.match(/"\$k"\s*:\s*"radio-channel[^"]*"/);
    if (kMatch) {
      const idMatch = entryText.match(/"\$id"\s*:\s*(\d+)/);
      if (idMatch) { radioChannelId = parseInt(idMatch[1], 10); break; }
    }
  }

  // â”€â”€ PASS 3: Build aircraft:REG entries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const allAcEntries = [];
  const acRegToInfo = new Map(); // reg â†’ { acGuid, acEntryId } (for animator linking)

  for (const [reg, fl] of regFlights) {
    if (!validRegs.has(reg)) continue;
    const isDep = fl.isDeparture === true;

    // Turnaround check: skip if this flight type lost the turnaround race
    const winner = turnaroundWinner.get(reg);
    if (winner && winner !== (isDep ? 'dep' : 'arr')) continue;

    // DEP aircraft are covered by STAND entities â€” only ARR gets aircraft:REG
    if (isDep) continue;

    const acGuid = _generateGuid();

    // â”€â”€ Build inline Aircraft entry for ARR (in air on approach) â”€â”€
    const acEntryId = nextId;
    const fpId = fpIdByReg.get(reg) || 0;
    log('  [ac-call] ' + reg + ': building Aircraft entry — star=' + JSON.stringify(fl.Airway) +
      ' runway=' + JSON.stringify(fl.Runway) + ' saveSec=' + saveSec +
      ' LandingTime=' + JSON.stringify(fl.LandingTime) +
      ' hasApproachCache=' + !!approachCache + ' hasFullText=' + !!fullText);
    const result = _buildStandaloneAircraftEntry({
      reg, flight: fl, entryId: acEntryId,
      fpId, radioChannelId,
      isDeparture: false,
      approachCache, fullText, saveSec, icao, baseDateTicks,
      recvEventsCache, waitingCmdsCache,
      segTypeMap, FP_TYPE_STR, DT_TYPE_STR,
      acGuid,
      log,
    });
    if (!result) {
      log('  [ac-call] ' + reg + ': skipped (not on approach or already landed)');
      continue;
    }
    nextId = result.nextId;
    allAcEntries.push(result.entry);
    acRegToInfo.set(reg, { acGuid, acEntryId });
    // Register aircraft id for $iref mapping if needed
    if (idMapper && oldIdMap.has(reg)) {
      idMapper.map(oldIdMap.get(reg), acEntryId);
    }
  }

  // â”€â”€ PASS 4: Build aircraft-animator:aircraft:REG entries â”€â”€â”€â”€â”€â”€â”€â”€
  const allAnimEntries = [];
  // Resolve animator type number from segTypeMap
  let animTypeFull = '51|ContextCross.Models.AircraftAnimator, GroundATC.Core';
  if (segTypeMap) {
    for (const [num, name] of segTypeMap) {
      if (name.startsWith('ContextCross.Models.AircraftAnimator,'))
        animTypeFull = num + '|' + name;
    }
  }

  for (const [reg, fl] of regFlights) {
    if (!validRegs.has(reg)) continue;
    const info = acRegToInfo.get(reg);
    if (!info) continue; // skipped (DEP or turnaround loser)

    const animId = nextId++;

    allAnimEntries.push({
      $k: 'aircraft-animator:aircraft:' + reg,
      $v: {
        $id: animId,
        $type: animTypeFull,
        Aircraft: { __iref: info.acEntryId },
        Version: 3,
        HasSnapshot: true,
        FlapRatio: 0,
        SlatRatio: 0,
        GearRatio: 1,
        IsGearMoving: false,
        GearTargetRatio: 1,
        GoAroundPhase: 0,
        HasGoAroundCommandTick: false,
        GoAroundCommandTick: 0,
        GearRetractIssued: false,
        TakeoffPitchActive: false,
        TakeoffPitchElapsed: 0,
        TakeoffPitchDeg: 0,
      },
    });
  }

  const removedCount = removedKeys.length;
  const addedCount = allFpEntries.length + allAcEntries.length + allAnimEntries.length;

  if (removedCount === 0 && addedCount === 0) {
    return { text: segmentText, removed: 0, added: 0 };
  }

  // Collect $id values declared in the parent dictionary structure
  // (outside $rcontent).  The RuntimeEntities dictionary itself has
  // fields like "comparer" with their own $id (e.g. GenericEqualityComparer).
  // Unity resolves these BEFORE iterating $rcontent, so $iref references
  // to them are already satisfied and should not cause deferral.
  const parentText = segmentText.substring(frameReStart, frameReStart + rcStart);
  const externalIds = new Set();
  const parentIdRe = /"\$id"\s*:\s*(\d+)/g;
  let pm;
  while ((pm = parentIdRe.exec(parentText)) !== null) {
    externalIds.add(parseInt(pm[1], 10));
  }

  // â”€â”€ Reconstruct RuntimeEntities.$rcontent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Assemble entries, then reorder so every $iref:N appears AFTER the
  // entry that declares "$id": N.  This is critical because Unity's
  // OdinSerializer resolves $iref left-to-right — a forward $iref
  // (referencing an $id not yet seen) deserializes as null.
  //
  // _fixIrefOrder collects both local (same-entry) and seen $id values,
  // so self-contained entries (like jetways with internal $id/$iref pairs)
  // pass through correctly without being deferred.  externalIds pre-seeds
  // seenIds with $id values from the parent dictionary (outside $rcontent)
  // that Unity deserializes before the $rcontent array.
  //
  // New entries (flight-plan, aircraft, animator) are structured objects
  // built directly.  Wrap them in OdinEntry (text is lazy-serialized).
  // Kept entries are parsed once via the non-regex parseOdinObject parser
  // to extract $id / $iref metadata; the original text is preserved for
  // output so we don't risk a lossy roundtrip.
  var newObjs = allFpEntries.concat(allAcEntries, allAnimEntries);
  var newDescriptors = newObjs.map(function(obj) {
    return new OdinEntry(obj); // text lazy-serialized on first access
  });

  // Build descriptors for kept entries — parse once with the structural
  // Odin parser (no regex) to extract ids/irefs, keep original text.
  var keptDescriptors = keptEntries.map(function(text) {
    try {
      var result = parseOdinObject(text, 0);
      if (result.error) throw new Error(result.error);
      return new OdinEntry(result.value, text); // preserve original text
    } catch (e) {
      // Defensive: if parsing still fails, emit as-is with empty metadata.
      // The parseOdinObject parser handles all known Odin edge cases, so
      // this should be extremely rare (truncated/corrupt entries).
      log('WARN: could not parse kept entry for iref reorder: ' + e.message);
      return new OdinEntry({}, text);
    }
  });

  var ordered = _reorderIrefEntries(
    newDescriptors.concat(keptDescriptors),
    log,
    externalIds
  );
  var newContent = ordered.map(function(d) { return d.text; }).join(',\n');
  const newRlen = ordered.length;

  // Update $rlength
  const rlSec = reT.findSection('$rlength');
  let newBeforeRc = beforeRc;
  if (rlSec) {
    const rlStartF = frameReStart + rlSec.valueStart;
    const rlEndF = frameReStart + rlSec.valueEnd;
    newBeforeRc = beforeRc.substring(0, rlStartF) + String(newRlen) + beforeRc.substring(rlEndF);
  }

  log('Rebuilt ' + allFpEntries.length + ' flight-plan + ' + allAcEntries.length + ' aircraft + ' + allAnimEntries.length + ' animator RuntimeEntities entry(s) (removed ' + removedCount + ' stale)');
  return { text: newBeforeRc + newContent + afterRc, removed: removedCount, added: addedCount };
}

/**
 * Build a standalone inline Aircraft:REG RuntimeEntities entry for flights
 * that don't have a jetway to embed the Aircraft in (DEP without jetway stand,
 * or ARR in air).
 *
 * Uses the same Aircrafts.Aircraft type hierarchy as _buildActiveJetwayEntry
 * (types 7-29).  Varies _state, _position, _direction, and _flightPlan fields
 * based on whether the aircraft is at a stand or on approach.
 *
 * @param {object} opts
 * @param {string} opts.reg - aircraft registration
 * @param {object} opts.flight - editor flight object
 * @param {number} opts.entryId - first $id for this entry
 * @param {boolean} opts.isDeparture - true for DEP, false for ARR
 * @param {object} opts.approachCache - approach cache
 * @param {string} opts.fullText - full decoded ACL text (for stand/approach resolution)
 * @param {number} opts.saveSec - save time in seconds since midnight
 * @param {string} opts.icao - airport ICAO
 * @param {BigInt} opts.baseDateTicks
 * @param {object} opts.recvEventsCache
 * @param {object} opts.waitingCmdsCache
 * @param {Map} opts.segTypeMap - per-segment type map
 * @param {string} opts.FP_TYPE_STR - pre-resolved FlightPlan $type string
 * @param {string} opts.DT_TYPE_STR - pre-resolved DateTime $type string
 * @param {string} opts.acGuid - aircraft GUID
 * @param {Function} opts.log
 * @returns {{ entryText: string, nextId: number }}
 */
function _buildStandaloneAircraftEntry(opts) {
  const { reg, flight, entryId, fpId, radioChannelId, isDeparture, approachCache, fullText, saveSec,
    icao, baseDateTicks, recvEventsCache, waitingCmdsCache,
    segTypeMap, fpTypeFull, dtTypeFull, acGuid, log } = opts;

  const id = (offset) => entryId + offset;

  const runway = flight.Runway || '';
  const stand = flight.Stand || '';
  const star = flight.Airway || '';
  const acType = flight.AircraftType || '';

  // Bare type strings (no outer quotes — serializeUnityJson adds formatting).
  // Must match _buildActiveJetwayEntry type numbers exactly.
  var T = {
    ac:      '7|ContextCross.Aircrafts.Aircraft, GroundATC.Core',
    spec:    '8|ContextCross.Models.AircraftSpecification, GroundATC.Core',
    float3:  '9|Unity.Mathematics.float3, Unity.Mathematics',
    vec4Arr: '10|UnityEngine.Vector4[], UnityEngine.CoreModule',
    vec4:    '11|UnityEngine.Vector4, UnityEngine.CoreModule',
    dyn:     '12|ContextCross.Dynamics.AircraftDynamicsData, GroundATC.Core',
    dynSt:   '13|R3.ReactiveProperty`1[[ContextCross.Dynamics.Enums.State, GroundATC.Core]], R3',
    coord:   '14|ContextCross.Aircrafts.AircraftRunwayCoordinator, GroundATC.Core',
    rpStrArr:'15|R3.ReactiveProperty`1[[System.String[], mscorlib]], R3',
    strArr:  '16|System.String[], mscorlib',
    vec3:    '17|UnityEngine.Vector3, UnityEngine.CoreModule',
    fp:      '18|ContextCross.Models.FlightPlan, GroundATC.Core',
    dt:      '19|System.DateTime, mscorlib',
    rpState: '20|R3.ReactiveProperty`1[[ContextCross.Aircrafts.Enums.EAircraftState, GroundATC.Core]], R3',
    rpDir:   '21|R3.ReactiveProperty`1[[ContextCross.Aircrafts.Enums.EFlightDirection, GroundATC.Core]], R3',
    rpChan:  '22|R3.ReactiveProperty`1[[ContextCross.Models.RadioChannel, GroundATC.Core]], R3',
    rpPath:  '23|R3.ReactiveProperty`1[[ContextCross.Models.Path, GroundATC.Core]], R3',
    rpStr:   '24|R3.ReactiveProperty`1[[System.String, mscorlib]], R3',
    rpCmdArr:'25|R3.ReactiveProperty`1[[ContextCross.Enums.ECommand[], GroundATC.Core]], R3',
    cmdArr:  '26|ContextCross.Enums.ECommand[], GroundATC.Core',
    rpEvtArr:'27|R3.ReactiveProperty`1[[ContextCross.Events.AircraftEvent[], GroundATC.Core]], R3',
    evtArr:  '28|ContextCross.Events.AircraftEvent[], GroundATC.Core',
    rpVec3:  '29|R3.ReactiveProperty`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], R3',
  };

  // Type strings for DynamicsParams sub-objects (namespace-qualified to avoid
  // per-file type-number drift — these types are always present in v4 aircraft)
  var DYN_PARAMS_TYPE = '54|ContextCross.Dynamics.States.FlyApproachDynamicsParams, GroundATC.Core';
  var LIST_VEC3_TYPE = '53|System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib';

  // ─── Resolve aircraft spec from approachCache ──────────────────────
  var spec = null;
  var designator = approachCache && approachCache.designatorMap
    ? approachCache.designatorMap.get(acType) : null;
  if (designator && approachCache && approachCache.specDB) {
    spec = approachCache.specDB.get(designator) || null;
  }
  if (!spec && acType && approachCache && approachCache.specDB) {
    spec = approachCache.specDB.get(acType) || null;
  }

  var designatorVal = spec?.Designator ?? (acType || 'B738');
  var wakeCat = spec?.WakeTurbulenceCategory ?? 2;
  var wheelBase = spec?.WheelBase ?? 0;
  var wingSpan = spec?.WingSpan ?? 0;
  var runwayVR = spec?.RunwayVRSpeed ?? 140;
  var runwayTO = spec?.RunwayTakeOffLength ?? 2000;
  var mo = spec?.ModelOffset ?? { x: 0, y: 0, z: 0 };
  var dockPoses = spec?.DockingPositions ?? [{ x: -1.742, y: 2.68, z: 14.75, w: 90 }];

  // ─── Determine position & direction ─────────────────────────────
  var posX, posY, posZ, dirX, dirZ;
  var flyPoints = null;
  var appPoints = null;
  var progressRatio = null;
  var timeToLanding = null;
  var aircraftState = 10; // default: parked at stand
  var flightDirection = 0; // 0=departure, 1=arrival
  var dynState = 0; // 0=idle

  if (isDeparture) {
    aircraftState = 10;
    flightDirection = 0;
    dynState = 0;
    var standPos = null;
    if (stand && fullText) {
      try {
        const { _parseStandPositions } = require('./scenery');
        var positions = _parseStandPositions(fullText, true);
        var standId = String(parseInt(stand, 10));
        standPos = positions[standId] || positions[stand] || positions[stand.padStart(2, '0')];
      } catch (_) {
        log('  stand position lookup failed for ' + stand + ': ' + _.message);
      }
    }
    if (standPos) {
      posX = standPos.x; posY = 0; posZ = standPos.y;
      if (standPos.heading != null) {
        var hdgRad = standPos.heading * (Math.PI / 180);
        dirX = Math.sin(hdgRad); dirZ = Math.cos(hdgRad);
      } else {
        dirX = 0.422497481; dirZ = 0.906364143;
      }
    } else {
      throw new Error(
        'v4 DEP aircraft position failed for ' + reg +
        ' — stand=' + JSON.stringify(stand) +
        ' flight.Stand=' + JSON.stringify(flight.Stand)
      );
    }
  } else {
    aircraftState = 30;
    flightDirection = 1;
    dynState = 1;

    log('  [ac-pos] ' + reg + ': ARR pos start — star=' + JSON.stringify(star) +
      ' runway=' + JSON.stringify(runway) + ' saveSec=' + saveSec +
      ' LandingTime=' + JSON.stringify(flight.LandingTime) +
      ' hasApproachCache=' + !!approachCache + ' hasFullText=' + !!fullText);
    if (!star) log('  [ac-pos] ' + reg + ': FAIL — star null/empty');
    if (!runway) log('  [ac-pos] ' + reg + ': FAIL — runway null/empty');
    if (!approachCache) log('  [ac-pos] ' + reg + ': FAIL — approachCache null/undefined');
    if (!fullText) log('  [ac-pos] ' + reg + ': FAIL — fullText null/empty');
    if (saveSec == null) log('  [ac-pos] ' + reg + ': FAIL — saveSec null/undefined');

    if (star && runway && approachCache && fullText && saveSec != null) {
      var appKey = star + '|' + runway;
      appPoints = approachCache.appPointMap
        ? approachCache.appPointMap.get(appKey) : null;
      var totalApproachTime = approachCache.totalApproachTimes
        ? approachCache.totalApproachTimes.get(star) : null;

      if (appPoints && totalApproachTime) {
        var landingSec = _timeStrToSeconds(flight.LandingTime);
        timeToLanding = landingSec - saveSec;

        if (timeToLanding >= GRACE_TTL) {
          var clampedTTL = Math.max(timeToLanding, APPROACH_MIN_TTL);
          progressRatio = 1.0 - (clampedTTL / totalApproachTime);

          if (progressRatio > 0.0) {
            try {
              flyPoints = resolveFlyApproachPoints(fullText, star, runway);
            } catch (flyErr) {
              log('  [ac-pos] ' + reg + ': resolveFlyApproachPoints threw: ' +
                (flyErr.message || flyErr));
            }

            var tdPos = approachCache.runwayThresholds
              ? approachCache.runwayThresholds[runway] : null;
            var airportScale = approachCache.airportScale || 100;
            var approachCap = computeApproachCap(airportScale);

            if (flyPoints && flyPoints.length > 0) {
              var flyLen = computePathLength(flyPoints);
              var appLen = computePathLength(appPoints);
              var combined = flyPoints.concat(appPoints);
              var totalLen = computePathLength(combined);
              var rawTargetDist = (1.0 - timeToLanding / totalApproachTime) * totalLen;
              if (rawTargetDist >= flyLen) { aircraftState = 5; dynState = 2; }

              var posResult = computePosition(flyPoints, appPoints, progressRatio, tdPos, approachCap);
              var dirResult = computeDirection(flyPoints, appPoints, progressRatio, tdPos);
              posX = posResult.x; posY = posResult.y; posZ = posResult.z;
              dirX = dirResult.x; dirZ = dirResult.z;
              log('  inline aircraft ' + reg + ': State=' + aircraftState + ' PR=' + progressRatio.toFixed(3) +
                  ' pos=(' + posX.toFixed(1) + ',' + posY.toFixed(1) + ',' + posZ.toFixed(1) + ')');
            } else {
              var posResult2 = computePosition([], appPoints, progressRatio, null, approachCap);
              var dirResult2 = computeDirection([], appPoints, progressRatio, null);
              posX = posResult2.x; posY = posResult2.y; posZ = posResult2.z;
              dirX = dirResult2.x; dirZ = dirResult2.z;
            }
          }
        }
      }
    }

    if (posX == null) {
      log('  [ac-pos] ' + reg + ': SKIP — position not computed' +
        ' (timeToLanding=' + timeToLanding +
        ' progressRatio=' + (progressRatio != null ? progressRatio.toFixed(4) : 'null') +
        ' flyPoints=' + (flyPoints ? flyPoints.length : 'null') + ')');
      return null;
    }
  }

  // ─── Build structured Aircraft object ──────────────────────────────

  // DockingPositions: Vector4[]
  var dockContent = dockPoses.map(function(p) {
    return { $type: T.vec4, __v: [p.x, p.y, p.z, p.w] };
  });

  // Shared empty string[] — declared once, $iref'd by RunwayCoordinator fields
  var emptyArrId = id(10);
  var emptyArr = { $id: emptyArrId, $type: T.strArr, $rcontent: [] };

  // ReactiveProperty<string[]> helper
  function rpStrArr(idVal, content) {
    return { $id: idVal, $type: T.rpStrArr, __v: [content] };
  }

  // FlyApproachDynamicsParams (only for State=30 ARR with flyPoints)
  var dynParams = null;
  if (aircraftState === 30 && flyPoints && flyPoints.length > 0 && progressRatio != null) {
    function toVec3Arr(pts) {
      return pts.map(function(p) { return { $type: T.vec3, __v: [p.x, 0, p.z] }; });
    }
    dynParams = {
      $id: id(30),
      $type: DYN_PARAMS_TYPE,
      ProgressRatio: progressRatio,
      FlyApproachPathPointList: { $id: id(31), $type: LIST_VEC3_TYPE, $rcontent: toVec3Arr(flyPoints) },
      AppPointList: appPoints && appPoints.length > 0
        ? { $id: id(32), $type: LIST_VEC3_TYPE, $rcontent: toVec3Arr(appPoints) }
        : { $rcontent: [] },
    };
  }

  var entry = {
    $k: 'aircraft:' + reg,
    $v: {
      $id: entryId,
      $type: T.ac,
      Specification: {
        $id: id(4),
        $type: T.spec,
        Designator: designatorVal,
        AerodromeCode: 67,
        WakeTurbulenceCategory: wakeCat,
        WheelBase: wheelBase,
        ModelOffset: { $type: T.float3, __v: [mo.x, mo.y, mo.z] },
        WingSpan: wingSpan,
        DockingPositions: { $id: id(5), $type: T.vec4Arr, $rcontent: dockContent },
        RunwayVRSpeed: runwayVR,
        RunwayTakeOffLength: runwayTO,
      },
      DynamicsData: {
        $id: id(6),
        $type: T.dyn,
        DynamicsState: { $id: id(7), $type: T.dynSt, __v: [dynState] },
        TaxiSpeed: TAXI_SPEED,
        ForwardSpeed: true,
        TargetTaxiSpeed: TAXI_SPEED,
        PositiveTaxiAcceleration: POSITIVE_TAXI_ACCEL,
        NegativeTaxiAcceleration: NEGATIVE_TAXI_ACCEL,
        DynamicsTargetTaxiSpeed: 0,
        DynamicsPositiveTaxiAcceleration: POSITIVE_TAXI_ACCEL,
        DynamicsNegativeTaxiAcceleration: NEGATIVE_TAXI_ACCEL,
        PushbackStopRequested: false,
        TaxiArrivalToSpotPath: null,
        TaxiArrivalToHoldingPointPath: null,
        FrontWheelSteeringAngle: 0,
        DynamicsParams: dynParams,
      },
      AircraftRunwayCoordinator: {
        $id: id(8),
        $type: T.coord,
        TaxiPathUnPassedIntersectionRunwayNames: rpStrArr(id(9), emptyArr),
        TaxiBlockingRunwayNames: rpStrArr(id(11), { __iref: emptyArrId }),
        RunwayFenceCurrentEnterRunways: rpStrArr(id(12), { __iref: emptyArrId }),
        RunwayGuardCurrentEnterRunway: rpStrArr(id(13), { __iref: emptyArrId }),
        CrossRunwayPermissions: rpStrArr(id(14), { __iref: emptyArrId }),
        HoldShortAcknowledgedRunwayNames: rpStrArr(id(15), { __iref: emptyArrId }),
        RunwaySetter: 0,
      },
      TaxiPathStartingPosition: { $type: T.vec3, __v: [0, 0, 0] },
      RollingPresetTaxiPathStartingPosition: { $type: T.vec3, __v: [0, 0, 0] },
      SelectedRunwayEntryIndex: -1,
      SelectedRunwayExitIndex: -1,
      _flightPlan: { __iref: fpId },
      _state: { $id: id(17), $type: T.rpState, __v: [aircraftState] },
      _flightDirection: { $id: id(18), $type: T.rpDir, __v: [flightDirection] },
      _radioChannel: {
        $id: id(19),
        $type: T.rpChan,
        __v: radioChannelId != null ? [{ __iref: radioChannelId }] : [null],
      },
      _jurisdictionRadioChannel: { $id: id(20), $type: T.rpChan, __v: [null] },
      _taxiPath: { $id: id(21), $type: T.rpPath, __v: [null] },
      _rollingPresetTaxiPath: { $id: id(22), $type: T.rpPath, __v: [null] },
      _selectedRunwayEntryRunway: null,
      _route: { $id: id(23), $type: T.rpStr, __v: [star] },
      _waitingForCommands: {
        $id: id(24),
        $type: T.rpCmdArr,
        __v: [{ $id: id(25), $type: T.cmdArr, $rcontent: [] }],
      },
      _receivedEvents: {
        $id: id(26),
        $type: T.rpEvtArr,
        __v: [{ $id: id(27), $type: T.evtArr, $rcontent: [] }],
      },
      _position: {
        $id: id(28),
        $type: T.rpVec3,
        __v: [{ $type: T.vec3, __v: [posX, posY, posZ] }],
      },
      _direction: {
        $id: id(29),
        $type: T.rpVec3,
        __v: [{ $type: T.vec3, __v: [dirX, 0, dirZ] }],
      },
      SelectedPushbackLimitPosition: null,
      SelectedTowPosition: null,
      _isFirstTaxi: false,
    },
  };

  return { entry: entry, nextId: id(dynParams ? 33 : 30) };
}

/**
 * Build a complete active jetway entry from scratch using a hardcoded template.
 * Constructs a full DockingAircraft with Aircraft object for the departure flight.
 * Mirrors the empty-case pattern (hardcoded template with string substitution)
 * but includes the ~35-field Aircraft structure inside DockingAircraft.
 */
function _buildActiveJetwayEntry(info, depFlight, approachCache, log, jwTypeMap, baseDateTicks, icao, recvEventsCache, waitingCmdsCache) {
  const entryId = info.entryId;
  const id = (offset) => entryId + offset;

  const reg = depFlight._Registration || depFlight.Registration || '';
  const runway = depFlight.Runway || '';
  const stand = depFlight.Stand || '';
  const star = depFlight.Airway || '';
  const takeoffTicks = _computeTakeoffTicks(
    depFlight.TakeoffTime || depFlight._departureTakeoffTime,
    depFlight.OffBlockTime,
    baseDateTicks,
    icao
  );
  const fstrref = '$fstrref:"flight-plan:' + reg + '"';

  // Resolve aircraft spec from approachCache, falling back to original entry
  const acType = depFlight.AircraftType || '';
  let spec = null;
  const designator = approachCache && approachCache.designatorMap
    ? approachCache.designatorMap.get(acType) : null;
  if (designator && approachCache && approachCache.specDB) {
    spec = approachCache.specDB.get(designator) || null;
  }
  // Fallback 1: try direct specDB lookup â€” in editor/v4 context, acType
  // values ("A320", "B738") are already ICAO designator codes.
  if (!spec && acType && approachCache && approachCache.specDB) {
    spec = approachCache.specDB.get(acType) || null;
  }
  // Fallback 2: extract spec from the original jetway entry's DockingAircraft
  // (needed for v4 where designatorMap is not populated)
  if (!spec && info.vBlock) {
    const { _extractFallbackSpec } = require('./approach');
    spec = _extractFallbackSpec(info.vBlock);
  }

  const designatorVal = spec?.Designator ?? (acType || 'B738');
  const wakeCat = spec?.WakeTurbulenceCategory ?? DEFAULT_WAKE_CATEGORY;
  const wheelBase = spec?.WheelBase ?? 0;
  const wingSpan = spec?.WingSpan ?? 0;
  const runwayVR = spec?.RunwayVRSpeed ?? DEFAULT_RUNWAY_VR_SPEED;
  const runwayTO = spec?.RunwayTakeOffLength ?? DEFAULT_RUNWAY_TAKEOFF_LENGTH;
  const mo = spec?.ModelOffset ?? DEFAULT_MODEL_OFFSET;
  const dockPoses = spec?.DockingPositions ?? [{ x: -1.742, y: 2.68, z: 14.75, w: 90 }];

  // Fully-qualified type strings â€” no dependency on segment type declarations.
  // These match the types used in the game's jetway save-state serialization.
  const T = {
    ac:      '"7|ContextCross.Aircrafts.Aircraft, GroundATC.Core"',
    spec:    '"8|ContextCross.Models.AircraftSpecification, GroundATC.Core"',
    float3:  '"9|Unity.Mathematics.float3, Unity.Mathematics"',
    vec4Arr: '"10|UnityEngine.Vector4[], UnityEngine.CoreModule"',
    vec4:    '"11|UnityEngine.Vector4, UnityEngine.CoreModule"',
    dyn:     '"12|ContextCross.Dynamics.AircraftDynamicsData, GroundATC.Core"',
    dynSt:   '"13|R3.ReactiveProperty`1[[ContextCross.Dynamics.Enums.State, GroundATC.Core]], R3"',
    coord:   '"14|ContextCross.Aircrafts.AircraftRunwayCoordinator, GroundATC.Core"',
    rpStrArr:'"15|R3.ReactiveProperty`1[[System.String[], mscorlib]], R3"',
    strArr:  '"16|System.String[], mscorlib"',
    vec3:    '"17|UnityEngine.Vector3, UnityEngine.CoreModule"',
    fp:      '"18|ContextCross.Models.FlightPlan, GroundATC.Core"',
    dt:      '"19|System.DateTime, mscorlib"',
    rpState: '"20|R3.ReactiveProperty`1[[ContextCross.Aircrafts.Enums.EAircraftState, GroundATC.Core]], R3"',
    rpDir:   '"21|R3.ReactiveProperty`1[[ContextCross.Aircrafts.Enums.EFlightDirection, GroundATC.Core]], R3"',
    rpChan:  '"22|R3.ReactiveProperty`1[[ContextCross.Models.RadioChannel, GroundATC.Core]], R3"',
    rpPath:  '"23|R3.ReactiveProperty`1[[ContextCross.Models.Path, GroundATC.Core]], R3"',
    rpStr:   '"24|R3.ReactiveProperty`1[[System.String, mscorlib]], R3"',
    rpCmdArr:'"25|R3.ReactiveProperty`1[[ContextCross.Enums.ECommand[], GroundATC.Core]], R3"',
    cmdArr:  '"26|ContextCross.Enums.ECommand[], GroundATC.Core"',
    rpEvtArr:'"27|R3.ReactiveProperty`1[[ContextCross.Events.AircraftEvent[], GroundATC.Core]], R3"',
    evtArr:  '"28|ContextCross.Events.AircraftEvent[], GroundATC.Core"',
    rpVec3:  '"29|R3.ReactiveProperty`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], R3"',
  };

  // Type strings for DynamicsParams sub-objects (namespace-qualified to avoid per-file
  // type-number drift — these types are always present in v4 aircraft entries)
  const DYN_PARAMS_TYPE = '"54|ContextCross.Dynamics.States.FlyApproachDynamicsParams, GroundATC.Core"';
  const LIST_VEC3_TYPE = '"53|System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib"';

  // Use full-form type strings for the top-level RuntimeEntity fields (3-6)
  // extracted from the original segment.  When we replace this entry, its
  // original "$type": "3|..." declaration is lost.  If no other entry declares
  // type 3 in this blobdoc scope, bare "$type": 3 references fail to encode.
  const JT3 = (jwTypeMap && jwTypeMap.has(3)) ? '"3|' + jwTypeMap.get(3) + '"' : '3';
  const JT4 = (jwTypeMap && jwTypeMap.has(4)) ? '"4|' + jwTypeMap.get(4) + '"' : '4';
  const JT5 = (jwTypeMap && jwTypeMap.has(5)) ? '"5|' + jwTypeMap.get(5) + '"' : '5';
  const JT6 = (jwTypeMap && jwTypeMap.has(6)) ? '"6|' + jwTypeMap.get(6) + '"' : '6';

  // Build DockingPositions array
  const dockLines = [];
  for (let i = 0; i < dockPoses.length; i++) {
    const p = dockPoses[i];
    if (i > 0) dockLines.push(',');
    dockLines.push(
      '                                                    {',
      '                                                        "$type": ' + T.vec4 + ',',
      '                                                        ' + p.x + ',',
      '                                                        ' + p.y + ',',
      '                                                        ' + p.z + ',',
      '                                                        ' + p.w,
      '                                                    }');
  }
  const dockInner = dockLines.join('\n');
  const dockStr = dockPoses.length > 0
    ? ('{\n' +
       '                                                    "$id": ' + id(5) + ',\n' +
       '                                                    "$type": ' + T.vec4Arr + ',\n' +
       '                                                    "$rlength": ' + dockPoses.length + ',\n' +
       '                                                    "$rcontent": [\n' + dockInner + '\n' +
       '                                                    ]\n' +
       '                                                }')
    : ('{\n' +
       '                                                    "$id": ' + id(5) + ',\n' +
       '                                                    "$type": ' + T.vec4Arr + ',\n' +
       '                                                    "$rlength": 0,\n' +
       '                                                    "$rcontent": []\n' +
       '                                                }');

  // Shared empty string[] that all RunwayCoordinator fields $iref
  const emptyArrStr = (
    '{\n' +
    '                                                    "$id": ' + id(10) + ',\n' +
    '                                                    "$type": ' + T.strArr + ',\n' +
    '                                                    "$rlength": 0,\n' +
    '                                                    "$rcontent": [\n' +
    '                                                    ]\n' +
    '                                                }');

  const entryText = [
    '                            {',
    '                                "$k": "' + info.key + '",',
    '                                "$v": {',
    '                                    "$id": ' + entryId + ',',
    '                                    "$type": ' + JT3 + ',',
    '                                    "Status": 2,',
    '                                    "Progress": {',
    '                                        "$id": ' + id(1) + ',',
    '                                        "$type": ' + JT4 + ',',
    '                                        1',
    '                                    },',
    '                                    "DockingAircraft": {',
    '                                        "$id": ' + id(2) + ',',
    '                                        "$type": ' + JT5 + ',',
    '                                        {',
    '                                            "$id": ' + id(3) + ',',
    '                                            "$type": ' + T.ac + ',',
    '                                            "Specification": {',
    '                                                "$id": ' + id(4) + ',',
    '                                                "$type": ' + T.spec + ',',
    '                                                "Designator": "' + designatorVal + '",',
    '                                                "AerodromeCode": 67,',
    '                                                "WakeTurbulenceCategory": ' + wakeCat + ',',
    '                                                "WheelBase": ' + wheelBase + ',',
    '                                                "ModelOffset": {',
    '                                                    "$type": ' + T.float3 + ',',
    '                                                    ' + mo.x + ',',
    '                                                    ' + mo.y + ',',
    '                                                    ' + mo.z,
    '                                                },',
    '                                                "WingSpan": ' + wingSpan + ',',
    '                                                "DockingPositions": ' + dockStr + ',',
    '                                                "RunwayVRSpeed": ' + runwayVR + ',',
    '                                                "RunwayTakeOffLength": ' + runwayTO,
    '                                            },',
    '                                            "DynamicsData": {',
    '                                                "$id": ' + id(6) + ',',
    '                                                "$type": ' + T.dyn + ',',
    '                                                "DynamicsState": {',
    '                                                    "$id": ' + id(7) + ',',
    '                                                    "$type": ' + T.dynSt + ',',
    '                                                    0',
    '                                                },',
    '                                                "TaxiSpeed": 0,',
    '                                                "ForwardSpeed": true,',
    '                                                "TargetTaxiSpeed": 0,',
    '                                                "PositiveTaxiAcceleration": 0,',
    '                                                "NegativeTaxiAcceleration": 0,',
    '                                                "DynamicsTargetTaxiSpeed": 0,',
    '                                                "DynamicsPositiveTaxiAcceleration": 0,',
    '                                                "DynamicsNegativeTaxiAcceleration": 0,',
    '                                                "PushbackStopRequested": false,',
    '                                                "TaxiArrivalToSpotPath": null,',
    '                                                "TaxiArrivalToHoldingPointPath": null,',
    '                                                "FrontWheelSteeringAngle": 0,',
    '                                                "DynamicsParams": null',
    '                                            },',
    '                                            "AircraftRunwayCoordinator": {',
    '                                                "$id": ' + id(8) + ',',
    '                                                "$type": ' + T.coord + ',',
    '                                                "TaxiPathUnPassedIntersectionRunwayNames": {',
    '                                                    "$id": ' + id(9) + ',',
    '                                                    "$type": ' + T.rpStrArr + ',',
    '                                                    ' + emptyArrStr,
    '                                                },',
    '                                                "TaxiBlockingRunwayNames": {',
    '                                                    "$id": ' + id(11) + ',',
    '                                                    "$type": ' + T.rpStrArr + ',',
    '                                                    $iref:' + id(10),
    '                                                },',
    '                                                "RunwayFenceCurrentEnterRunways": {',
    '                                                    "$id": ' + id(12) + ',',
    '                                                    "$type": ' + T.rpStrArr + ',',
    '                                                    $iref:' + id(10),
    '                                                },',
    '                                                "RunwayGuardCurrentEnterRunway": {',
    '                                                    "$id": ' + id(13) + ',',
    '                                                    "$type": ' + T.rpStrArr + ',',
    '                                                    $iref:' + id(10),
    '                                                },',
    '                                                "CrossRunwayPermissions": {',
    '                                                    "$id": ' + id(14) + ',',
    '                                                    "$type": ' + T.rpStrArr + ',',
    '                                                    $iref:' + id(10),
    '                                                },',
    '                                                "HoldShortAcknowledgedRunwayNames": {',
    '                                                    "$id": ' + id(15) + ',',
    '                                                    "$type": ' + T.rpStrArr + ',',
    '                                                    $iref:' + id(10),
    '                                                },',
    '                                                "RunwaySetter": 0',
    '                                            },',
    '                                            "TaxiPathStartingPosition": {',
    '                                                "$type": ' + T.vec3 + ',',
    '                                                0,',
    '                                                0,',
    '                                                0',
    '                                            },',
    '                                            "RollingPresetTaxiPathStartingPosition": {',
    '                                                "$type": ' + T.vec3 + ',',
    '                                                0,',
    '                                                0,',
    '                                                0',
    '                                            },',
    '                                            "SelectedRunwayEntryIndex": -1,',
    '                                            "SelectedRunwayExitIndex": -1,',
    '                                            "_flightPlan": {',
    '                                                "$id": ' + id(16) + ',',
    '                                                "$type": ' + T.fp + ',',
    '                                                "StaticItem": ' + fstrref + ',',
    '                                                "_arrivalInBlockTime": {',
    '                                                    "$type": ' + T.dt + ',',
    '                                                    0',
    '                                                },',
    '                                                "_arrivalActualInBlockTime": {',
    '                                                    "$type": ' + T.dt + ',',
    '                                                    0',
    '                                                },',
    '                                                "_arrivalRunway": null,',
    '                                                "_arrivalStand": null,',
    '                                                "_departureTakeoffTime": {',
    '                                                    "$type": ' + T.dt + ',',
    '                                                    ' + takeoffTicks,
    '                                                },',
    '                                                "_departureRunway": "' + runway + '",',
    '                                                "_departureStand": "' + stand + '"',
    '                                            },',
    '                                            "_state": {',
    '                                                "$id": ' + id(17) + ',',
    '                                                "$type": ' + T.rpState + ',',
    '                                                10',
    '                                            },',
    '                                            "_flightDirection": {',
    '                                                "$id": ' + id(18) + ',',
    '                                                "$type": ' + T.rpDir + ',',
    '                                                0',
    '                                            },',
    '                                            "_radioChannel": {',
    '                                                "$id": ' + id(19) + ',',
    '                                                "$type": ' + T.rpChan + ',',
    '                                                null',
    '                                            },',
    '                                            "_jurisdictionRadioChannel": {',
    '                                                "$id": ' + id(20) + ',',
    '                                                "$type": ' + T.rpChan + ',',
    '                                                null',
    '                                            },',
    '                                            "_taxiPath": {',
    '                                                "$id": ' + id(21) + ',',
    '                                                "$type": ' + T.rpPath + ',',
    '                                                null',
    '                                            },',
    '                                            "_rollingPresetTaxiPath": {',
    '                                                "$id": ' + id(22) + ',',
    '                                                "$type": ' + T.rpPath + ',',
    '                                                null',
    '                                            },',
    '                                            "_selectedRunwayEntryRunway": null,',
    '                                            "_route": {',
    '                                                "$id": ' + id(23) + ',',
    '                                                "$type": ' + T.rpStr + ',',
    '                                                "' + star + '"',
    '                                            },',
    '                                            "_waitingForCommands": {\n' +
    '                                                "$id": ' + id(24) + ',\n' +
    '                                                "$type": ' + T.rpCmdArr + ',\n' +
    '                                                {\n' +
    '                                                    "$id": ' + id(25) + ',\n' +
    '                                                    "$type": ' + T.cmdArr + ',\n' +
    '                                                    "$rlength": 0,\n' +
    '                                                    "$rcontent": [\n' +
    '                                                    ]\n' +
    '                                                }\n' +
    '                                            },',
    '                                            "_receivedEvents": {\n' +
    '                                                "$id": ' + id(26) + ',\n' +
    '                                                "$type": ' + T.rpEvtArr + ',\n' +
    '                                                {\n' +
    '                                                    "$id": ' + id(27) + ',\n' +
    '                                                    "$type": ' + T.evtArr + ',\n' +
    '                                                    "$rlength": 0,\n' +
    '                                                    "$rcontent": [\n' +
    '                                                    ]\n' +
    '                                                }\n' +
    '                                            },',
    '                                            "_position": {',
    '                                                "$id": ' + id(28) + ',',
    '                                                "$type": ' + T.rpVec3 + ',',
    '                                                {',
    '                                                    "$type": ' + T.vec3 + ',',
    '                                                    -5.728619,',
    '                                                    0,',
    '                                                    -12.5395947',
    '                                                }',
    '                                            },',
    '                                            "_direction": {',
    '                                                "$id": ' + id(29) + ',',
    '                                                "$type": ' + T.rpVec3 + ',',
    '                                                {',
    '                                                    "$type": ' + T.vec3 + ',',
    '                                                    0.422497481,',
    '                                                    0,',
    '                                                    0.906364143',
    '                                                }',
    '                                            },',
    '                                            "SelectedPushbackLimitPosition": null,',
    '                                            "SelectedTowPosition": null,',
    '                                            "_isFirstTaxi": false',
    '                                        }',
    '                                    },',
    '                                    "DockingDoorIndex": {',
    '                                        "$id": ' + id(30) + ',',
    '                                        "$type": ' + JT6 + ',',
    '                                        0',
    '                                    },',
    '                                    "TrigEvent": true,',
    '                                    "AutoUndockFinished": false',
    '                                }',
    '                            }',
  ].join('\n');
  return {
    text: entryText,
    flightPlanId: id(16),
    aircraftId: id(3),
    reg: reg,
    isDeparture: true,
  };
}


/**
 * Extract the $id value of a named sub-object from an entry's text.
 */
function _extractSubId(entryText, fieldName) {
  const idx = entryText.indexOf('"' + fieldName + '"');
  if (idx < 0) return null;
  const subText = entryText.substring(idx);
  const idIdx = subText.indexOf('"$id"');
  if (idIdx < 0) return null;
  const afterColon = subText.indexOf(':', idIdx);
  if (afterColon < 0) return null;
  let vs = afterColon + 1;
  while (vs < subText.length && ' \t\n\r'.includes(subText[vs])) vs++;
  let ve = vs;
  while (ve < subText.length && subText[ve] >= '0' && subText[ve] <= '9') ve++;
  if (ve > vs) return parseInt(subText.substring(vs, ve), 10);
  return null;
}

/**
 * Extract the $id (or $iref target) from a $k/$v entry's $v block.
 * Used by _rebuildFlightRuntimeEntities to capture the old $id of
 * removed flight-plan:REG entries for $iref remapping later.
 *
 * Handles two formats:
 *   "$v": { "$id": 738, ... }   â†’ returns 738 (inline object)
 *   "$v": $iref:738             â†’ returns 738 (indirect reference)
 *
 * @param {string} entryText - full text of a $k/$v dictionary entry
 * @returns {number|null}
 */
function _extractEntryVId(entryText) {
  const t = createTokenizer(entryText);
  const vSec = t.findSection('$v');
  if (!vSec) return null;
  const vVal = entryText.substring(vSec.valueStart, vSec.valueEnd);
  if (vVal.startsWith('{')) {
    // Inline object: { "$id": N, ... }
    const idIdx = vVal.indexOf('"$id"');
    if (idIdx < 0) return null;
    const colon = vVal.indexOf(':', idIdx) + 1;
    let s = colon;
    while (s < vVal.length && ' \t\n\r'.includes(vVal[s])) s++;
    let e = s;
    while (e < vVal.length && vVal[e] >= '0' && vVal[e] <= '9') e++;
    return e > s ? parseInt(vVal.substring(s, e), 10) : null;
  }
  if (vVal.startsWith('$iref:')) {
    // Indirect reference: $iref:N
    const numPart = vVal.substring(6);
    const digits = numPart.match(/^(\d+)/);
    return digits ? parseInt(digits[1], 10) : null;
  }
  return null;
}

function _resetFrameJetwayDockingState(frameText, validRegs, renameMap, log) {
  // â”€â”€ Navigate to RuntimeEntities.$rcontent structurally â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const t = createTokenizer(frameText);
  const reSec = t.findSection('RuntimeEntities');
  if (!reSec) return { text: frameText, resetCount: 0 };

  const reText = t.substring(reSec.valueStart, reSec.valueEnd);
  const reT = createTokenizer(reText);
  const rcSec = reT.findSection('$rcontent');
  if (!rcSec) return { text: frameText, resetCount: 0 };

  const rcStart = rcSec.valueStart;
  if (reText[rcStart] !== '[') return { text: frameText, resetCount: 0 };
  const rcEnd = reT.findArrayEnd(rcStart);
  if (rcEnd === null) return { text: frameText, resetCount: 0 };

  const frameReStart = reSec.valueStart;
  const beforeRc = frameText.substring(0, frameReStart + rcStart + 1);
  const content = reText.substring(rcStart + 1, rcEnd - 1);
  const afterRc = frameText.substring(frameReStart + rcEnd - 1);
  const contentT = createTokenizer(content);

  // â”€â”€ Iterate entries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const segments = [];
  let resetCount = 0;
  let pos = 0;

  while (pos < content.length) {
    while (pos < content.length && ' \t\n\r'.includes(content[pos])) pos++;
    if (pos >= content.length) break;
    if (content[pos] === ',') { pos++; continue; }
    if (content[pos] !== '{') { pos++; continue; }

    const entryEnd = contentT.findObjectEnd(pos);
    if (entryEnd === null) break;
    const entryText = content.substring(pos, entryEnd);
    const entryT = createTokenizer(entryText);

    const kSec = entryT.findSection('$k');
    let modifiedEntry = entryText;

    if (kSec) {
      const kStrEnd = entryT.skipString(kSec.valueStart);
      if (kStrEnd) {
        const key = entryText.substring(kSec.valueStart + 1, kStrEnd - 1);

        if (key.startsWith('jetway:')) {
          // Check DockingAircraft for stale references
          const daSec = entryT.findSection('DockingAircraft');
          let needsReset = false;

          if (daSec && daSec.valueStart < entryText.length &&
              entryText[daSec.valueStart] === '{') {
            // Scan the bounded DockingAircraft value block for stale $fstrref refs.
            // $fstrref is a value format (not a JSON key) so indexOf is the right
            // tool here â€” but the scan boundary is structurally correct.
            const daValue = entryText.substring(daSec.valueStart, daSec.valueEnd);
            const fpRefPrefix = '$fstrref:"flight-plan:';
            let searchFp = 0;
            while (searchFp < daValue.length) {
              const refIdx = daValue.indexOf(fpRefPrefix, searchFp);
              if (refIdx < 0) break;
              const regStart = refIdx + fpRefPrefix.length;
              const regEnd = daValue.indexOf('"', regStart);
              if (regEnd < 0) break;
              const refReg = daValue.substring(regStart, regEnd);
              if (!validRegs.has(refReg) && !renameMap.has(refReg)) {
                needsReset = true;
                break;
              }
              searchFp = regEnd + 1;
            }
            // Fallback: if $fstrref scan found nothing, the embedded Aircraft
            // may still be stale with "StaticItem": null (step 7a already nulled
            // the $fstrref in a prior pass, or the file was already broken).
            // A valid flight-plan always has a non-null StaticItem.
            if (!needsReset && daValue.includes('"StaticItem": null')) {
              needsReset = true;
            }
          }

          if (needsReset) {
            // Collect all modifications as { start, end, replacement }
            // (positions relative to entryText), then apply back-to-front.
            const mods = [];

            // â”€â”€ Status â†’ 0 â”€â”€
            const statusSec = entryT.findSection('Status');
            if (statusSec) {
              mods.push({
                start: statusSec.valueStart, end: statusSec.valueEnd,
                replacement: '0'
              });
            }

            // â”€â”€ Progress â†’ 0 (Unity struct: { $type:N, VALUE }) â”€â”€
            const progSec = entryT.findSection('Progress');
            if (progSec) {
              const progVal = entryText.substring(progSec.valueStart, progSec.valueEnd);
              const progT = createTokenizer(progVal);
              const progTypeSec = progT.findSection('$type');
              if (progTypeSec) {
                let vp = progTypeSec.valueEnd;
                while (vp < progVal.length && ', \t\n\r'.includes(progVal[vp])) vp++;
                let ve = vp;
                while (ve < progVal.length && progVal[ve] >= '0' && progVal[ve] <= '9') ve++;
                if (ve > vp) {
                  mods.push({
                    start: progSec.valueStart + vp, end: progSec.valueStart + ve,
                    replacement: '0'
                  });
                }
              }
            }

            // â”€â”€ DockingDoorIndex â†’ -1 (Unity struct: { $type:N, VALUE }) â”€â”€
            const ddiSec = entryT.findSection('DockingDoorIndex');
            if (ddiSec) {
              const ddiVal = entryText.substring(ddiSec.valueStart, ddiSec.valueEnd);
              const ddiT = createTokenizer(ddiVal);
              const ddiTypeSec = ddiT.findSection('$type');
              if (ddiTypeSec) {
                let vp = ddiTypeSec.valueEnd;
                while (vp < ddiVal.length && ', \t\n\r'.includes(ddiVal[vp])) vp++;
                let ve = vp;
                if (ddiVal[ve] === '-') ve++;
                while (ve < ddiVal.length && ddiVal[ve] >= '0' && ddiVal[ve] <= '9') ve++;
                if (ve > vp) {
                  mods.push({
                    start: ddiSec.valueStart + vp, end: ddiSec.valueStart + ve,
                    replacement: '-1'
                  });
                }
              }
            }

            // â”€â”€ DockingAircraft Aircraft: null _flightPlan.StaticItem â”€â”€
            // Instead of replacing the entire inner Aircraft object with null
            // (which destroys $id:10 and nested $id:17/32/34 that other entries
            // reference via $iref), keep the structure and null _flightPlan's
            // $fstrref reference.  Step 7a will handle the $fstrref â†’ null
            // replacement globally later â€” we just mark this jetway as stale.
            const daSec2 = entryT.findSection('DockingAircraft');
            if (daSec2) {
              const daValue2 = entryText.substring(daSec2.valueStart, daSec2.valueEnd);
              if (daValue2[0] === '{') {
                const daT = createTokenizer(daValue2);
                const daTypeSec = daT.findSection('$type');
                if (daTypeSec) {
                  // Skip past $type to find the Aircraft inner object
                  let innerPos = daTypeSec.valueEnd;
                  while (innerPos < daValue2.length &&
                         ', \t\n\r'.includes(daValue2[innerPos])) innerPos++;
                  if (innerPos < daValue2.length && daValue2[innerPos] === '{') {
                    const innerEnd = daT.findObjectEnd(innerPos);
                    if (innerEnd !== null) {
                      const acText = daValue2.substring(innerPos, innerEnd);
                      const acT = createTokenizer(acText);
                      const fpSec = acT.findSection('_flightPlan');
                      if (fpSec) {
                        const fpText = acText.substring(fpSec.valueStart, fpSec.valueEnd);
                        const fpT = createTokenizer(fpText);
                        const siSec = fpT.findSection('StaticItem');
                        if (siSec) {
                          const siVal = fpText.substring(siSec.valueStart, siSec.valueEnd);
                          if (siVal !== 'null' && !siVal.startsWith('$fstrref:"')) {
                            // Already handled â€” skip
                          } else {
                            // Null the entire $fstrref or existing null
                            mods.push({
                              start: daSec2.valueStart + innerPos + fpSec.valueStart + siSec.valueStart,
                              end: daSec2.valueStart + innerPos + fpSec.valueStart + siSec.valueEnd,
                              replacement: 'null'
                            });
                          }
                        }
                      }
                    }
                  }
                }
              }
            }

            // Apply modifications back-to-front (no position drift)
            if (mods.length > 0) {
              mods.sort((a, b) => b.start - a.start);
              for (const mod of mods) {
                modifiedEntry =
                  modifiedEntry.substring(0, mod.start) + mod.replacement +
                  modifiedEntry.substring(mod.end);
              }
              resetCount++;
            }
          }
        }
      }
    }

    segments.push(modifiedEntry);
    pos = entryEnd;
  }

  if (resetCount > 0) {
    return {
      text: beforeRc + segments.join(',\n') + afterRc,
      resetCount
    };
  }
  return { text: frameText, resetCount: 0 };
}

function _sectionMeta(sectionText) {
  const idMatch = sectionText.match(/"\$id"\s*:\s*(\d+)/);
  const typeMatch = sectionText.match(/"\$type"\s*:\s*"([^"]+)"|"\$type"\s*:\s*(\d+)/);
  let typeStr = null, typeNum = null;
  if (typeMatch) {
    typeStr = typeMatch[1] || null;
    typeNum = typeMatch[1] ? _parseTypeNum(typeMatch[1]) : parseInt(typeMatch[2], 10);
  }
  return { id: idMatch ? parseInt(idMatch[1], 10) : 0, typeStr, typeNum };
}

function _elemTypeFromRcontent(sectionText) {
  const rcMatch = sectionText.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return null;
  const after = sectionText.substring(rcMatch.index + rcMatch[0].length);
  const brace = after.indexOf('{');
  if (brace < 0) return null;
  const m = after.substring(brace).match(/"\$type"\s*:\s*"([^"]+)"|"\$type"\s*:\s*(\d+)/);
  if (!m) return null;
  return m[1] ? _parseTypeNum(m[1]) : parseInt(m[2], 10);
}

function _generateFramesSection(frames, parentId, elemTypeNum, parentTypeNum, parentName, arrayTypeName, elemTypeName, fieldMap) {
  const L = [];
  const I = '    ';
  L.push(`${I}"${parentName}": {`);
  L.push(`${I}    "$id": ${parentId},`);
  L.push(`${I}    "$type": "${parentTypeNum}|ContextCross.States.${arrayTypeName}, GroundATC.Core",`);
  L.push(`${I}    "$rlength": ${frames.length},`);
  L.push(`${I}    "$rcontent": [`);

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const fid = parentId + 1 + i;
    const keys = Object.keys(fieldMap);
    L.push(`${I}        {`);
    L.push(`${I}            "$id": ${fid},`);
    if (i === 0)
      L.push(`${I}            "$type": "${elemTypeNum}|ContextCross.States.${elemTypeName}, GroundATC.Core",`);
    else
      L.push(`${I}            "$type": ${elemTypeNum},`);

    for (let k = 0; k < keys.length; k++) {
      const jk = keys[k];
      const { acl, type } = fieldMap[jk];
      const comma = (k < keys.length - 1) ? ',' : '';
      if (type === 'string')
        L.push(`${I}            "${acl}": "${f[jk]}"${comma}`);
      else
        L.push(`${I}            "${acl}": ${f[jk]}${comma}`);
    }

    L.push(`${I}        }${i < frames.length - 1 ? ',' : ''}`);
  }

  L.push(`${I}    ]`);
  L.push(`${I}}`);
  return L.join('\n');
}

function _generateRunwayTimelineSection(data, meta) {
  const L = [];
  const I = '    ';
  const ir = data.initialRunways || [];
  const tl = data.timeline || [];

  L.push(`${I}"RunwayTimeline": {`);
  L.push(`${I}    "$id": ${meta.parentId},`);
  L.push(`${I}    "$type": "${meta.parentTypeNum}|ContextCross.States.RunwayTimelineData, GroundATC.Core",`);

  L.push(`${I}    "InitialRunways": {`);
  L.push(`${I}        "$id": ${meta.irId},`);
  // Always emit full-form type declaration so the section is self-contained
  // and doesn't depend on type registration order elsewhere in the file.
  // When irTypeNum is null (should not happen with well-formed input), derive
  // from parent RunwayTimeline type â€” System.String[] is typically the next
  // sequential type number.
  const irTypeNum = meta.irTypeNum != null ? meta.irTypeNum : (meta.parentTypeNum + 1);
  L.push(`${I}        "$type": "${irTypeNum}|System.String[], mscorlib",`);
  L.push(`${I}        "$rlength": ${ir.length},`);
  L.push(`${I}        "$rcontent": [`);
  for (let i = 0; i < ir.length; i++)
    L.push(`${I}            "${ir[i]}"${i < ir.length - 1 ? ',' : ''}`);
  L.push(`${I}        ]`);
  L.push(`${I}    },`);

  L.push(`${I}    "Timeline": {`);
  L.push(`${I}        "$id": ${meta.tlId},`);
  // Always emit full-form type declaration â€” same reasoning as InitialRunways above.
  const tlTypeNum = meta.tlTypeNum != null ? meta.tlTypeNum : (meta.parentTypeNum + 2);
  L.push(`${I}        "$type": "${tlTypeNum}|ContextCross.States.RunwayChangeFrame[], GroundATC.Core",`);
  L.push(`${I}        "$rlength": ${tl.length},`);
  L.push(`${I}        "$rcontent": [`);

  if (tl.length === 0) {
    L.push(`${I}        ]`);
  } else {
    for (let i = 0; i < tl.length; i++) {
      const e = tl[i];
      const ch = e.changes || [];
      const fid = meta.tlId + 1 + i;
      const chId = meta.tlId + 1 + tl.length + i * 3;

      L.push(`${I}            {`);
      L.push(`${I}                "$id": ${fid},`);
      L.push(`${I}                "$type": ${i === 0 ? '"' + meta.tlElemTypeNum + '|ContextCross.States.RunwayChangeFrame, GroundATC.Core"' : meta.tlElemTypeNum},`);
      L.push(`${I}                "Time": "${e.time}",`);

      L.push(`${I}                "Changes": {`);
      L.push(`${I}                    "$id": ${chId},`);
      L.push(`${I}                    "$type": "${meta.changesArrTypeNum}|ContextCross.States.RunwayChange[], GroundATC.Core",`);
      L.push(`${I}                    "$rlength": ${ch.length},`);
      L.push(`${I}                    "$rcontent": [`);

      for (let j = 0; j < ch.length; j++) {
        const c = ch[j];
        const cid = chId + 1 + j;
        L.push(`${I}                        {`);
        L.push(`${I}                            "$id": ${cid},`);
        L.push(`${I}                            "$type": ${j === 0 ? '"' + meta.changeElemTypeNum + '|ContextCross.States.RunwayChange, GroundATC.Core"' : meta.changeElemTypeNum},`);
        L.push(`${I}                            "Source": "${c.source}",`);
        L.push(`${I}                            "Dest": "${c.dest}"`);
        L.push(`${I}                        }${j < ch.length - 1 ? ',' : ''}`);
      }

      L.push(`${I}                    ]`);
      L.push(`${I}                }`);
      L.push(`${I}            }${i < tl.length - 1 ? ',' : ''}`);
    }
    L.push(`${I}        ]`);
  }

  L.push(`${I}    }`);
  L.push(`${I}}`);
  return L.join('\n');
}

/** Parse metadata for RunwayTimeline from existing ACL section. */
function _metaRunway(sectionText) {
  const parent = _sectionMeta(sectionText);

  // InitialRunways
  const irIdx = sectionText.indexOf('"InitialRunways"');
  let irId = 0, irTypeNum = null, irTypeStr = null;
  if (irIdx >= 0) {
    let depth = 0, start = -1, end = -1;
    for (let i = irIdx; i < sectionText.length; i++) {
      if (sectionText[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (sectionText[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (start >= 0) {
      const ir = sectionText.substring(start, end);
      const m = ir.match(/"\$id"\s*:\s*(\d+)/);
      irId = m ? parseInt(m[1], 10) : 0;
      // Match both full "$type": "N|TypeName" and bare "$type": N forms
      const tm = ir.match(/"\$type"\s*:\s*"([^"]+)"|"\$type"\s*:\s*(\d+)/);
      if (tm) {
        if (tm[1]) { irTypeStr = tm[1]; irTypeNum = _parseTypeNum(tm[1]); }
        else { irTypeNum = parseInt(tm[2], 10); }
      }
    }
  }

  // Timeline
  const tlIdx = sectionText.indexOf('"Timeline"');
  let tlId = 0, tlTypeNum = null, tlTypeStr = null;
  let tlElemTypeNum = null;
  let changesArrTypeNum = null, changeElemTypeNum = null;
  if (tlIdx >= 0) {
    let depth = 0, start = -1, end = -1;
    for (let i = tlIdx; i < sectionText.length; i++) {
      if (sectionText[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (sectionText[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (start >= 0) {
      const tl = sectionText.substring(start, end);
      const tm = tl.match(/"\$id"\s*:\s*(\d+)/);
      tlId = tm ? parseInt(tm[1], 10) : 0;
      const ttm = tl.match(/"\$type"\s*:\s*"([^"]+)"|"\$type"\s*:\s*(\d+)/);
      if (ttm) {
        tlTypeStr = ttm[1] || null;
        tlTypeNum = ttm[1] ? _parseTypeNum(ttm[1]) : parseInt(ttm[2], 10);
      }
      tlElemTypeNum = _elemTypeFromRcontent(tl);

      const chIdx = tl.indexOf('"Changes"');
      if (chIdx >= 0) {
        let chDepth = 0, chStart = -1, chEnd = -1;
        for (let i = chIdx; i < tl.length; i++) {
          if (tl[i] === '{') { if (chDepth === 0) chStart = i; chDepth++; }
          else if (tl[i] === '}') { chDepth--; if (chDepth === 0) { chEnd = i + 1; break; } }
        }
        if (chStart >= 0) {
          const ch = tl.substring(chStart, chEnd);
          const ctm = ch.match(/"\$type"\s*:\s*"([^"]+)"|"\$type"\s*:\s*(\d+)/);
          if (ctm) changesArrTypeNum = ctm[1] ? _parseTypeNum(ctm[1]) : parseInt(ctm[2], 10);
          changeElemTypeNum = _elemTypeFromRcontent(ch);
        }
      }
    }
  }

  // Fallback: when timeline is empty, element type numbers can't be
  // extracted from rcontent â€” compute from tlTypeNum using known fixed
  // offsets (RunwayChangeFrame=+1, RunwayChange[]=+2, RunwayChange=+3).
  // Verified across all 24 .acl files â€” offsets never vary.
  if (tlTypeNum !== null) {
    if (tlElemTypeNum === null) tlElemTypeNum = tlTypeNum + 1;
    if (changesArrTypeNum === null) changesArrTypeNum = tlTypeNum + 2;
    if (changeElemTypeNum === null) changeElemTypeNum = tlTypeNum + 3;
  }

  return {
    parentId: parent.id, parentTypeNum: parent.typeNum, parentTypeStr: parent.typeStr,
    irId, irTypeNum, irTypeStr, tlId, tlTypeNum, tlTypeStr, tlElemTypeNum,
    changesArrTypeNum, changeElemTypeNum,
  };
}

/**
 * Patches WindFrames, WeatherFrames, and RunwayTimeline sections in the .acl file
 * to match the current timeline data.
 */
function _rebuildTimelineSections(aclPath, weatherTimeline, windTimeline, runwayTimeline, isV4) {
  const log = (msg) => console.log('[ACL-TIMELINE]', msg);
  let text = isV4 ? readAclText(aclPath) : fs.readFileSync(aclPath, 'utf-8');

  // Sort timelines by time
  const _toSec = (t) => { const p = String(t || '').split(':'); return (parseInt(p[0]) || 0) * 3600 + (parseInt(p[1]) || 0) * 60 + (parseInt(p[2]) || 0); };
  if (weatherTimeline && weatherTimeline.length > 1) weatherTimeline.sort((a, b) => _toSec(a.time) - _toSec(b.time));
  if (windTimeline && windTimeline.length > 1) windTimeline.sort((a, b) => _toSec(a.time) - _toSec(b.time));

  // Helper: replace a section in text
  function replaceSection(text, sectionName, newContent) {
    const sec = _extractSection(text, sectionName);
    if (!sec) { log('WARNING: ' + sectionName + ' section not found, skipping'); return text; }
    const prefix = text.substring(0, sec.start);
    const suffix = text.substring(sec.end);
    return prefix + newContent + suffix;
  }

  // â”€â”€ WeatherFrames â”€â”€
  if (weatherTimeline && weatherTimeline.length) {
    const wsSec = _extractSection(text, 'WeatherFrames');
    if (wsSec) {
      const pMeta = _sectionMeta(wsSec.content);
      const eTypeNum = _elemTypeFromRcontent(wsSec.content);
      const fieldMap = {
        preset: { acl: 'Preset', type: 'string' },
        time:   { acl: 'Time',   type: 'string' },
      };
      const newSection = _generateFramesSection(weatherTimeline, pMeta.id, eTypeNum, pMeta.typeNum, 'WeatherFrames', 'WeatherFrame[]', 'WeatherFrame', fieldMap);
      text = replaceSection(text, 'WeatherFrames', newSection);
      log('WeatherFrames rebuilt (' + weatherTimeline.length + ' entries)');
    }
  }

  // â”€â”€ WindFrames â”€â”€
  if (windTimeline && windTimeline.length) {
    const wsSec = _extractSection(text, 'WindFrames');
    if (wsSec) {
      const pMeta = _sectionMeta(wsSec.content);
      const eTypeNum = _elemTypeFromRcontent(wsSec.content);
      const fieldMap = {
        direction: { acl: 'Direction', type: 'number' },
        speed:     { acl: 'Speed',     type: 'number' },
        time:      { acl: 'Time',      type: 'string' },
      };
      const newSection = _generateFramesSection(windTimeline, pMeta.id, eTypeNum, pMeta.typeNum, 'WindFrames', 'WindFrame[]', 'WindFrame', fieldMap);
      text = replaceSection(text, 'WindFrames', newSection);
      log('WindFrames rebuilt (' + windTimeline.length + ' entries)');
    }
  }

  // â”€â”€ RunwayTimeline â”€â”€
  if (runwayTimeline) {
    const rsSec = _extractSection(text, 'RunwayTimeline');
    if (rsSec) {
      const meta = _metaRunway(rsSec.content);
      const newSection = _generateRunwayTimelineSection(runwayTimeline, meta);
      text = replaceSection(text, 'RunwayTimeline', newSection);
      log('RunwayTimeline rebuilt (initRWs=' + (runwayTimeline.initialRunways || []).length + ', tl=' + (runwayTimeline.timeline || []).length + ')');
    }
  }

  if (isV4) {
    writeAcl(aclPath, text);
    log('Timeline sections written to ACL (' + (isV4 ? 'v4' : 'v2/v3') + ')');
  } else {
    fs.writeFileSync(aclPath, text, 'utf-8');
    log('Timeline sections written to ACL (v2/v3)');
  }
}

// â”€â”€â”€ Parse timeline sections from ACL text â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Parse $rcontent entries from a frames section using string-aware tokenizer. */
function _parseFramesSection(sectionContent) {
  if (!sectionContent) return [];
  const entries = [];

  const t = createTokenizer(sectionContent);
  const rcSec = t.findSection('$rcontent');
  if (!rcSec) return entries;

  const rcStart = rcSec.valueStart;
  if (sectionContent[rcStart] !== '[') return entries;

  // Parse each { ... } block in the array using string-aware tokenizer
  let pos = rcStart + 1; // skip opening [
  while (pos < sectionContent.length) {
    // Skip whitespace
    while (pos < sectionContent.length && ' \t\n\r'.includes(sectionContent[pos])) pos++;
    if (pos >= sectionContent.length) break;

    if (sectionContent[pos] === ']') break; // end of array
    if (sectionContent[pos] === ',') { pos++; continue; }

    if (sectionContent[pos] === '{') {
      const blockEnd = t.findObjectEnd(pos);
      if (blockEnd === null) break;

      const block = sectionContent.substring(pos, blockEnd);

      // Try pre-processor + JSON.parse first
      try {
        const cleaned = preprocessUnityJson(block);
        const parsed = JSON.parse(cleaned);
        // Convert parsed object to lowercase-keyed entry
        const entry = {};
        for (const key of Object.keys(parsed)) {
          if (key === '$type' || key === '$id') continue;
          entry[key.toLowerCase()] = parsed[key];
        }
        entries.push(entry);
      } catch (_) {
        // Fallback to regex extraction
        const entry = {};
        const strRe = /"(\w+)":\s*"([^"]*)"/g;
        let sm;
        while ((sm = strRe.exec(block)) !== null) entry[sm[1].toLowerCase()] = sm[2];
        const numRe = /"(\w+)":\s*(-?\d+)/g;
        let nm;
        while ((nm = numRe.exec(block)) !== null) {
          const key = nm[1].toLowerCase();
          if (!(key in entry)) entry[key] = parseInt(nm[2], 10);
        }
        entries.push(entry);
      }

      pos = blockEnd;
    } else {
      pos++;
    }
  }

  return entries;
}

/** Parse WeatherFrames from ACL text â†’ same format as weather_timeline.json. */
function _parseWeatherFrames(text) {
  const sec = _extractSection(text, 'WeatherFrames');
  if (!sec) return [];
  return _parseFramesSection(sec.content).map(e => ({
    preset: e.preset || '',
    time: e.time || '',
  }));
}

/** Parse WindFrames from ACL text â†’ same format as wind_timeline.json. */
function _parseWindFrames(text) {
  const sec = _extractSection(text, 'WindFrames');
  if (!sec) return [];
  return _parseFramesSection(sec.content).map(e => ({
    direction: e.direction || 0,
    speed: e.speed || 0,
    time: e.time || '',
  }));
}

/** Parse RunwayTimeline from ACL text â†’ same format as runway_timeline_*.json. */
function _parseRunwayTimeline(text) {
  const sec = _extractSection(text, 'RunwayTimeline');
  if (!sec) return { initialRunways: [], timeline: [] };

  const content = sec.content;
  const result = { initialRunways: [], timeline: [] };

  // Parse InitialRunways
  const irIdx = content.indexOf('"InitialRunways"');
  if (irIdx >= 0) {
    const rcMatch = content.substring(irIdx).match(/"\$rcontent"\s*:\s*\[([^\]]*)\]/);
    if (rcMatch) {
      const items = rcMatch[1].match(/"([^"]+)"/g);
      if (items) result.initialRunways = items.map(s => s.replace(/"/g, ''));
    }
  }

  // Parse Timeline
  const tlIdx = content.indexOf('"Timeline"');
  if (tlIdx >= 0) {
    let depth = 0, start = -1, end = -1;
    for (let i = tlIdx; i < content.length; i++) {
      if (content[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (content[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (start >= 0) {
      const tlContent = content.substring(start, end);
      const frames = _parseFramesSection(tlContent);
      result.timeline = frames.map(e => {
        const changes = [];
        // Parse nested Changes array within each frame
        const chIdx = tlContent.indexOf('"Changes"');
        if (chIdx >= 0) {
          const rcMatch = tlContent.substring(chIdx).match(/"\$rcontent"\s*:\s*\[/);
          if (rcMatch) {
            const absRc = chIdx + rcMatch.index + rcMatch[0].length;
            let cd = 0, cs = -1;
            for (let i = absRc; i < tlContent.length; i++) {
              if (tlContent[i] === '{') { if (cd === 0) cs = i; cd++; }
              else if (tlContent[i] === '}') {
                cd--;
                if (cd === 0 && cs >= 0) {
                  const chBlock = tlContent.substring(cs, i + 1);
                  const sm = chBlock.match(/"Source":\s*"([^"]*)"/);
                  const dm = chBlock.match(/"Dest":\s*"([^"]*)"/);
                  if (sm && dm) changes.push({ source: sm[1], dest: dm[1] });
                  cs = -1;
                }
              }
            }
          }
        }
        return { time: e.time || '', changes };
      });
    }
  }

  return result;
}

// â”€â”€â”€ V4 Save: rebuild StaticData.$blobdoc.StaticItems flight-plan entries â”€â”€

function _rebuildStaticDataSections(aclPath, flights, baseDateTicks, approachCache, aclcfgStartTime, _saveSec) {
  const log = (msg) => console.log('[ACL-REBUILD-V4]', msg);
  const text = readAclText(aclPath);
  const bdt = BigInt(baseDateTicks || FALLBACK_BASE_DATE_TICKS);
  const icaoMatch = aclPath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
  const icao = icaoMatch ? icaoMatch[1] : '';

  // Build per-file typeMap (same pattern as _rebuildWorldStateSections)
  // Type numbers are per-file in Unity's JSON serialization â€” each .acl file gets
  // its own assignments. We seed from the current file first (ground truth), then
  // fill in missing types from the per-file cache (built during initial scan).
  const typeMap = new Map();
  const typeDeclRegex = /"\$type":\s*"(\d+)\|([^"]+)"/g;
  let tdMatch;
  while ((tdMatch = typeDeclRegex.exec(text)) !== null) {
    const num = parseInt(tdMatch[1], 10);
    if (!typeMap.has(num)) typeMap.set(num, tdMatch[2]);
  }
  const typeMapFromFile = typeMap.size;
  const fileKey = path.basename(aclPath);
  if (approachCache && approachCache.fileTypeMaps) {
    const cachedFileTypes = approachCache.fileTypeMaps.get(fileKey);
    if (cachedFileTypes) {
      for (const [k, v] of cachedFileTypes) {
        if (!typeMap.has(k)) typeMap.set(k, v);
      }
    }
  }
  let nextFallbackNum = TYPE_NUM_FALLBACK_START;
  for (const num of typeMap.keys()) {
    if (num >= nextFallbackNum) nextFallbackNum = num + 1;
  }
  const _tn = (search) => {
    for (const [num, fullName] of typeMap) {
      if (fullName.startsWith('System.Collections.Generic') && !search.includes('`')) continue;
      // Boundary-aware match: prevent "Vector4[]," from matching search "Vector4,"
      const idx = fullName.indexOf(search);
      if (idx === -1) continue;
      const nextChar = fullName[idx + search.length];
      if (nextChar === undefined || nextChar === ' ' || nextChar === ',') return num;
    }
    return null;
  };

  log('flights: ' + (flights ? flights.length : 0) + ' baseDateTicks: ' + bdt + ' typeMap: ' + typeMap.size + ' (' + typeMapFromFile + ' from file)');

  if (!flights || flights.length === 0) {
    log('WARNING: empty flights array, skipping rebuild');
    return;
  }

  // â”€â”€ Resolve saveTime for approach position computation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Same priority chain as _rebuildWorldStateSections:
  //   GameTime.CurrentDateTime â†’ per-file cache offset â†’ startTime + warmup
  // v4: always use game start time from resolveConfigTime().
  // _saveSec is IGNORED — v4 is not a snapshot save, aircraft positions
  // are computed relative to the scenario's configured start time.
  const _toSec = (t) => { const p = String(t).split(':'); return +p[0] * 3600 + +p[1] * 60 + (+p[2] || 0); };

  // v4: always use game start time from resolveConfigTime, never _saveSec
  let aclcfgST = aclcfgStartTime;
  if (!aclcfgST) {
    try {
      const { resolveConfigTime } = require('./config');
      const cfg = resolveConfigTime(text);
      if (cfg && cfg.startTime) aclcfgST = cfg.startTime;
    } catch (_) {}
  }
  const saveSec = aclcfgST ? _toSec(aclcfgST) : 0;
  log('saveTime=' + saveSec + 's (from resolveConfigTime startTime=' + aclcfgST + ')');

  const t = createTokenizer(text);

  // 1. Navigate to StaticData.$blobdoc.StaticItems.$rcontent
  const sdSec = t.findSection('StaticData');
  if (!sdSec) { log('ERROR: no StaticData section'); return; }
  const sdText = t.substring(sdSec.valueStart, sdSec.valueEnd);
  const sdT = createTokenizer(sdText);

  const bdSec = sdT.findSection('$blobdoc');
  if (!bdSec) { log('ERROR: no $blobdoc section'); return; }
  const bdText = sdT.substring(bdSec.valueStart, bdSec.valueEnd);
  const bdT = createTokenizer(bdText);

  // Build blobdoc-scoped type map â€” each $blobdoc has its own independent
  // type numbering. Type X in the outer document can mean something completely
  // different from type X inside the blobdoc.
  const bdTypeMap = new Map();
  const bdTypeDeclRegex = /"\$type":\s*"(\d+)\|([^"]+)"/g;
  let bdTm;
  while ((bdTm = bdTypeDeclRegex.exec(bdText)) !== null) {
    const num = parseInt(bdTm[1], 10);
    if (!bdTypeMap.has(num)) bdTypeMap.set(num, bdTm[2]);
  }
  const _bdTn = (search) => {
    // Helper: boundary-aware type name match
    const _match = (fullName, search) => {
      const idx = fullName.indexOf(search);
      if (idx === -1) return false;
      const nextChar = fullName[idx + search.length];
      return nextChar === undefined || nextChar === ' ' || nextChar === ',';
    };
    for (const [num, fullName] of bdTypeMap) {
      if (fullName.startsWith('System.Collections.Generic') && !search.includes('`')) continue;
      if (_match(fullName, search)) return num;
    }
    // Fall back to global typeMap, but only if the number isn't already
    // claimed by a different type in this blobdoc (type numbering is per-scope)
    for (const [num, fullName] of typeMap) {
      if (fullName.startsWith('System.Collections.Generic') && !search.includes('`')) continue;
      if (_match(fullName, search)) {
        if (!bdTypeMap.has(num)) return num;
        // Number already taken in blobdoc â€” keep searching for an unclaimed match
      }
    }
    return null;
  };

  const dtTypeNum = _bdTn('System.DateTime,') || 3;
  const arrLegTypeNum = _bdTn('FlightPlanArrivalLeg,') || nextFallbackNum++;
  const depLegTypeNum = _bdTn('FlightPlanDepartureLeg,') || nextFallbackNum++;

  const dtTypeFull = '"' + dtTypeNum + '|System.DateTime, mscorlib"';
  const arrLegTypeFull = '"' + arrLegTypeNum + '|ContextCross.Models.FlightPlanArrivalLeg, GroundATC.Core"';
  const depLegTypeFull = '"' + depLegTypeNum + '|ContextCross.Models.FlightPlanDepartureLeg, GroundATC.Core"';

  log('blobdoc typeMap: ' + bdTypeMap.size + ' types, typeNums: DateTime=' + dtTypeNum + ' ArrivalLeg=' + arrLegTypeNum + ' DepartureLeg=' + depLegTypeNum);

  // Scan $blobdoc for max existing $id to seed our unique counter
  // $id values inside the blobdoc form a flat namespace â€” we must not collide
  let nextId = 1;
  const idRe = /"\$id":\s*(\d+)/g;
  let idMatch;
  while ((idMatch = idRe.exec(bdText)) !== null) {
    const val = parseInt(idMatch[1], 10);
    if (val >= nextId) nextId = val + 1;
  }
  log('max $id in blobdoc: ' + (nextId - 1) + ', nextId: ' + nextId);

  const siSec = bdT.findSection('StaticItems');
  if (!siSec) { log('ERROR: no StaticItems section'); return; }
  const siText = bdT.substring(siSec.valueStart, siSec.valueEnd);
  const siT = createTokenizer(siText);

  const rcSec = siT.findSection('$rcontent');
  if (!rcSec) { log('ERROR: no $rcontent in StaticItems'); return; }
  const rcStart = rcSec.valueStart;
  if (siText[rcStart] !== '[') { log('ERROR: $rcontent is not an array'); return; }
  const rcEnd = siT.findArrayEnd(rcStart);
  if (rcEnd === null) { log('ERROR: cannot find $rcontent end'); return; }

  log('StaticItems $rcontent: ' + rcStart + ' â†’ ' + rcEnd);

  // 2. Find all flight-plan entries within the $rcontent array
  const arrayContent = siText.substring(rcStart + 1, rcEnd - 1); // inside [...]
  const arrT = createTokenizer(siText);

  // Locate the first and last flight-plan entry to determine the replacement range
  // Also capture the $type from the first flight-plan entry (varies per file)
  // And extract CallSign from each old entry for rename detection
  let fpFirstStart = -1, fpLastEnd = -1;
  const fpItemNum = _tn('ContextCross.Models.FlightPlanStaticItem,') || nextFallbackNum++;
  let fpTypeStr = `"$type": "${fpItemNum}|ContextCross.Models.FlightPlanStaticItem, GroundATC.Core"`;
  const oldFpData = []; // [{ oldReg, callsign }]
  let pos = rcStart + 1;
  while (pos < rcEnd) {
    while (pos < rcEnd && ' \t\n\r'.includes(siText[pos])) pos++;
    if (pos >= rcEnd || siText[pos] === ']') break;
    if (siText[pos] === ',') { pos++; continue; }
    if (siText[pos] !== '{') { pos++; continue; }

    const entryEnd = arrT.findObjectEnd(pos);
    if (entryEnd === null) break;
    const entryBlock = siText.substring(pos, entryEnd);

    // Check if this is a flight-plan entry
    if (entryBlock.includes('"$k": "flight-plan:')) {
      // Extract old registration for rename detection
      const oldRegMatch = entryBlock.match(/"\$k":\s*"flight-plan:([^"]+)"/);
      if (oldRegMatch) {
        // Extract CallSign from leg data (arrival or departure)
        let callsign = '';
        const csArrivalMatch = entryBlock.match(/"InitialArrival":\s*\{[^}]*"CallSign":\s*"([^"]+)"/s);
        const csDepartMatch = entryBlock.match(/"InitialDeparture":\s*\{[^}]*"CallSign":\s*"([^"]+)"/s);
        if (csArrivalMatch) callsign = csArrivalMatch[1];
        else if (csDepartMatch) callsign = csDepartMatch[1];
        oldFpData.push({ oldReg: oldRegMatch[1], callsign });
      }

      if (fpFirstStart < 0) {
        fpFirstStart = pos;
        // Capture the $type from the first flight-plan entry (varies per file).
        // ONLY accept the full expanded form "N|TypeName".  A bare "$type": N
        // would not self-register in the blobdoc scope, causing "unknown type id N"
        // during binary encoding.  The default fpTypeStr (line 4800) is already
        // the correct expanded form using the per-file typeMap lookup.
        const typeMatch = entryBlock.match(/"\$type":\s*"(\d+)\|([^"]+)"/);
        if (typeMatch) fpTypeStr = '"$type": "' + typeMatch[1] + '|' + typeMatch[2] + '"';
      }
      fpLastEnd = entryEnd;
      // Skip commas after flight-plan entries
      let afterEnd = entryEnd;
      while (afterEnd < rcEnd && ' \t\n\r'.includes(siText[afterEnd])) afterEnd++;
      if (afterEnd < rcEnd && siText[afterEnd] === ',') fpLastEnd = afterEnd + 1;
    }

    pos = entryEnd;
  }

  // Also find the end of the last entry before flight-plans (for the leading comma)
  if (fpFirstStart >= 0) {
    // Walk backward from fpFirstStart to find the preceding entry's end
    let beforeFp = fpFirstStart - 1;
    while (beforeFp > rcStart && ' \t\n\r'.includes(siText[beforeFp])) beforeFp--;
    if (beforeFp > rcStart && siText[beforeFp] === ',') {
      // Include the leading comma in the replacement
      fpFirstStart = beforeFp;
      while (fpFirstStart > rcStart && ' \t\n\r'.includes(siText[fpFirstStart - 1])) fpFirstStart--;
    }
  }

  log('flight-plan range: ' + fpFirstStart + ' â†’ ' + fpLastEnd +
      ' (found=' + (fpFirstStart >= 0) + ')');

  // 3. Build the replacement text
  const segBefore = fpFirstStart >= 0 ? siText.substring(0, fpFirstStart) : siText.substring(0, rcStart + 1);
  const segAfter = fpLastEnd >= 0 ? siText.substring(fpLastEnd) : siText.substring(rcStart + 1);

  // Generate v4 flight-plan entries
  const fpEntries = [];
  const RESOLVER = { createTokenizer, preprocessUnityJson, findArrayEnd: (txt, start) => createTokenizer(txt).findArrayEnd(start) };

  for (const fl of flights) {
    // Time conversion helpers
    const _timeToTicks = (t) => {
      if (!t) return '0';
      const s = String(t);
      if (/^\d+$/.test(s)) return s; // already numeric ticks
      const p = s.split(':');
      const sec = +p[0] * 3600 + (+p[1] || 0) * 60 + (+p[2] || 0);
      return String(bdt + BigInt(Math.round(sec * 10000000)));
    };

    const isDeparture = fl.isDeparture === true;
    const registration = fl._Registration || fl.Registration || '';

    // Build InitialArrival or InitialDeparture leg
    // Each leg sub-object gets its own $id and $type (v4 OdinSerializer requirement)
    const legId = nextId++;
    let legBlock = '';
    if (isDeparture) {
      const obtTicks = _timeToTicks(fl.OffBlockTime);
      // v4: TakeoffTime always 0 (game computes it dynamically)
      legBlock = [
        '                                "$id": ' + legId + ',',
        '                                "$type": ' + depLegTypeFull + ',',
        '                                "CallSign": "' + (fl.CallSign || '') + '",',
        '                                "DestinationAirport": "' + (fl.ArrivalAirport || '') + '",',
        '                                "OffBlockTime": {',
        '                                    "$type": ' + dtTypeFull + ',',
        '                                    ' + obtTicks,
        '                                },',
        '                                "TakeoffTime": {',
        '                                    "$type": ' + dtTypeFull + ',',
        '                                    0',
        '                                },',
        '                                "Runway": "' + (fl.Runway || '') + '",',
        '                                "Stand": "' + (fl.Stand || '') + '"',
      ].join('\n');
    } else {
      const ldtTicks = _timeToTicks(fl.LandingTime);
      // v4: InBlockTime always 0 (game computes it dynamically)
      legBlock = [
        '                                "$id": ' + legId + ',',
        '                                "$type": ' + arrLegTypeFull + ',',
        '                                "CallSign": "' + (fl.CallSign || '') + '",',
        '                                "OriginAirport": "' + (fl.DepartureAirport || '') + '",',
        '                                "LandingTime": {',
        '                                    "$type": ' + dtTypeFull + ',',
        '                                    ' + ldtTicks,
        '                                },',
        '                                "InBlockTime": {',
        '                                    "$type": ' + dtTypeFull + ',',
        '                                    0',
        '                                },',
        '                                "ActualInBlockTime": {',
        '                                    "$type": ' + dtTypeFull + ',',
        '                                    0',
        '                                },',
        '                                "Runway": "' + (fl.Runway || '') + '",',
        '                                "Stand": "' + (fl.Stand || '') + '",',
        '                                "STAR": "' + (fl.Airway || '') + '"',
      ].join('\n');
    }

    const entry = [
      '                    {',
      '                        "$k": "flight-plan:' + registration + '",',
      '                        "$v": {',
      '                            "$id": ' + nextId++ + ',',
      '                            ' + fpTypeStr + ',',
      '                            "Registration": "' + registration + '",',
      '                            "AircraftType": "' + (fl.AircraftType || '') + '",',
      '                            "AirlineName": "' + (fl.AirlineName || '') + '",',
      '                            "Voice": "' + (fl.Voice || '') + '",',
      '                            "Language": "' + (fl.Language || '') + '",',
      '                            "InitialArrival": ' + (isDeparture ? 'null' : '{\n' + legBlock + '\n                                }') + ',',
      '                            "InitialDeparture": ' + (isDeparture ? '{\n' + legBlock + '\n                                }' : 'null'),
      '                        }',
      '                    }',
    ].join('\n');

    fpEntries.push(entry);
  }

  // 4. Assemble: count existing non-flight-plan entries for $rlength update
  const nonFpCount = (fpFirstStart >= 0)
    ? _countArrayEntries(siText.substring(rcStart + 1, fpFirstStart)) +
      _countArrayEntries(siText.substring(fpLastEnd, rcEnd - 1))
    : _countArrayEntries(siText.substring(rcStart + 1, rcEnd - 1));

  const newRlength = nonFpCount + fpEntries.length;
  log('non-fp entries: ' + nonFpCount + ', fp entries: ' + fpEntries.length + ', total $rlength: ' + newRlength);

  // Update $rlength in StaticItems
  const fpContent = fpEntries.length > 0 ? '\n' + fpEntries.join(',\n') + '\n                ' : '';

  let newSiText;
  if (fpFirstStart >= 0) {
    // Flight-plan entries existed â€” replace them in-place within siText
    newSiText = segBefore + fpContent + segAfter;
  } else {
    // No flight-plan entries yet â€” insert at start of $rcontent array
    const bracketIdx = siText.indexOf('[', rcSec.valueStart);
    const afterBracket = siText.substring(bracketIdx + 1);
    newSiText = siText.substring(0, bracketIdx + 1) + fpContent + afterBracket;
  }

  // Apply $rlength update to the final section text â€” use structural scan
  // to find only the section-level "$rlength" (depth 1) and replace its value,
  // avoiding nested $rlength inside entries' $v blocks.
  const finalSiText = (function() {
    let depth = 0;
    const keyStr = '"$rlength"';
    for (let i = 0; i < newSiText.length - keyStr.length; i++) {
      if (newSiText[i] === '{') { depth++; continue; }
      if (newSiText[i] === '}') { depth--; continue; }
      if (depth === 1 && newSiText.substring(i, i + keyStr.length) === keyStr) {
        const colon = i + keyStr.length;
        let vs = newSiText.indexOf(':', colon) + 1;
        while (vs < newSiText.length && ' \t\n\r'.includes(newSiText[vs])) vs++;
        let ve = vs;
        while (ve < newSiText.length && newSiText[ve] >= '0' && newSiText[ve] <= '9') ve++;
        return newSiText.substring(0, vs) + String(newRlength) + newSiText.substring(ve);
      }
    }
    return newSiText;
  })();

  // 6. Write â€” convert section offsets from bdT space to full text space
  const secKeyGlobal = sdSec.valueStart + bdSec.valueStart + siSec.keyStart;
  const secValueStartGlobal = sdSec.valueStart + bdSec.valueStart + siSec.valueStart;
  const secValueEndGlobal = sdSec.valueStart + bdSec.valueStart + siSec.valueEnd;

  // Reconstruct the full section: "StaticItems": { ... }
  const secPrefix = text.substring(secKeyGlobal, secValueStartGlobal); // e.g. "StaticItems":
  const fullBefore = text.substring(0, secKeyGlobal);
  const fullAfter = text.substring(secValueEndGlobal);
  let newText = fullBefore + secPrefix + finalSiText + fullAfter;

  // 7. Clean up stale $fstrref:"flight-plan:REG" references and reset
  // orphaned jetway docking state in the checkpoint frame.
  //
  // When flights are deleted or their registrations change, the rebuilt
  // flight-plan keys ($k) no longer match preserved $fstrref references in
  // the checkpoint frame. Unity cannot resolve these stale
  // ExternalReferenceByString values and throws:
  //   "Data layout mismatch; skipping past node boundary when exiting array"
  //
  // Additionally, jetway entries in the frame's RuntimeData blobdoc may
  // have non-null DockingAircraft fields containing embedded Aircraft
  // objects whose $fstrref also points to a deleted registration. We reset
  // these jetway entries to their undocked state (Statusâ†’0, Progressâ†’0,
  // DockingAircraftâ†’null, DockingDoorIndexâ†’-1).
  {
    const { RE_FRAME_SENTINEL } = require('./gatcarc');

    const validRegs = new Set();
    for (const fl of flights) {
      const reg = fl._Registration || fl.Registration || '';
      if (reg) validRegs.add(reg);
    }

    // Build renameMap: detect registration renames by matching old entries'
    // CallSign to new flights' CallSign. This prevents the save pipeline
    // from orphaning aircraft entities when only the registration changed.
    const renameMap = new Map(); // oldReg â†’ newReg
    {
      // Build new callsign â†’ registration lookup from current flights
      const csToNewReg = new Map();
      for (const fl of flights) {
        const cs = (fl.CallSign || '').trim();
        if (cs) csToNewReg.set(cs, fl._Registration || fl.Registration || '');
      }

      for (const { oldReg, callsign } of oldFpData) {
        if (validRegs.has(oldReg)) continue; // still valid, not a rename
        const cs = callsign.trim();
        if (!cs) continue;
        const newReg = csToNewReg.get(cs);
        // Only map if the callsign uniquely identifies a new flight with a
        // different registration (avoid ambiguous matches)
        if (newReg && newReg !== oldReg) {
          renameMap.set(oldReg, newReg);
          // Also add oldReg to validRegs so the renamed entries survive cleanup
        }
      }
      if (renameMap.size > 0) {
        log('Detected ' + renameMap.size + ' registration rename(s): ' +
          [...renameMap].map(([o, n]) => o + ' â†’ ' + n).join(', '));
      }
    }

    // 7b. Reset jetway docking state and remove orphaned RuntimeEntities entries.
    // IMPORTANT: 7b MUST run before 7a (stale $fstrref cleanup). 7a nulls
    // $fstrref references that 7b relies on for stale-jetway detection, so
    // 7b is placed first to see the intact $fstrref values in DockingAircraft.
    // RuntimeEntities exist in the header's RuntimeData blob AND in checkpoint
    // frames. We must process all segments â€” not just frames â€” otherwise
    // registration renames leave stale $k keys in single-segment archives.
    const frameDocs = newText.split(RE_FRAME_SENTINEL);
    const sentinelMatch = newText.match(RE_FRAME_SENTINEL);
    const exactSentinel = sentinelMatch ? sentinelMatch[0] : '';
    let frameModified = false;

    // 7a-2. Expand short-form $type references to fully-qualified strings
    // BEFORE any cleanup steps that might remove type declarations.
    //
    // When entries containing "$type": "39|SomeType" declarations are
    // removed from the text (e.g. orphaned aircraft entries in step 7c),
    // any surviving bare "$type": 39 references become unresolvable,
    // causing "unknown type id 39" during binary encoding.  Expanding
    // them first makes every reference self-contained.
    const segTypeMaps = [];
    for (let fi = 0; fi < frameDocs.length; fi++) {
      // Build per-segment typeMap from THIS segment's own declarations.
      // Each GATCARC4 segment is an independent Odin binary document with its
      // own type numbering. Using the global typeMap (conflated from ALL segments)
      // would expand bare $type refs to types from wrong segments, producing
      // "Type id N claimed by both â€¦" errors during binary encoding.
      const segTypeMap = new Map();
      const segDeclRe = /"\$type":\s*"(\d+)\|([^"]+)"/g;
      let sm;
      while ((sm = segDeclRe.exec(frameDocs[fi])) !== null) {
        const num = parseInt(sm[1], 10);
        if (!segTypeMap.has(num)) segTypeMap.set(num, sm[2]);
      }
      segTypeMaps[fi] = segTypeMap;
      const expanded = _expandShortFormTypes(frameDocs[fi], segTypeMap);
      if (expanded !== frameDocs[fi]) {
        frameDocs[fi] = expanded;
        frameModified = true;
      }
    }

    // 7b-1. Rebuild jetway entries constructively in ALL segments (header + frames).
    // Each segment has its own $blobdoc with independent $id namespace, so we create
    // one _IdMapper per segment to track oldâ†’new $id mappings for $iref remapping.
    const segIdMappers = [];
    for (let fi = 0; fi < frameDocs.length; fi++) {
      segIdMappers[fi] = new _IdMapper();
    }
    let totalJwReset = 0;
    const segActiveJetways = [];
    const segRecvEventsCaches = [];
    const segWaitingCmdsCaches = [];
    for (let fi = 0; fi < frameDocs.length; fi++) {
      const result = _rebuildJetwayEntries(frameDocs[fi], flights, validRegs, approachCache, log, segIdMappers[fi], bdt, icao);
      if (result.resetCount > 0) {
        frameDocs[fi] = result.text;
        frameModified = true;
        totalJwReset += result.resetCount;
      }
      segActiveJetways[fi] = result.activeJetways || [];
      segRecvEventsCaches[fi] = result.recvEventsCache || { canonicalId: null };
      segWaitingCmdsCaches[fi] = result.waitingCmdsCache || { canonicalId: null };
    }

    // 7b-2. Re-expand bare $type refs in segments modified by 7b-1.
    // _rebuildJetwayEntries injects new jetway entries with bare "$type": N
    // (integers 3-6 for the top-level RuntimeEntity fields). The full-form
    // type declarations for these ids existed in the ORIGINAL entries that
    // were replaced, so they are no longer in the segment text. We re-expand
    // using the typeMap saved from step 7a-2 (pre-modification) to make every
    // reference self-contained before binary encoding.
    for (let fi = 0; fi < frameDocs.length; fi++) {
      const sm = segTypeMaps[fi];
      if (sm && sm.size > 0) {
        const reexpanded = _expandShortFormTypes(frameDocs[fi], sm);
        if (reexpanded !== frameDocs[fi]) {
          frameDocs[fi] = reexpanded;
          frameModified = true;
        }
      }
    }

    // 7b-3. Rebuild flight-plan:REG, aircraft:REG, and
    // aircraft-animator:aircraft:REG entries in RuntimeEntities constructively.
    // ALL three entry types are deleted and rebuilt from scratch using the
    // editor's internal flight state, ensuring consistency with the header
    // StaticItems and with the jetway entries rebuilt in 7b-1.
    let totalFpRebuilt = 0;
    let totalAcRebuilt = 0;
    let totalAnimRebuilt = 0;
    for (let fi = 0; fi < frameDocs.length; fi++) {
      const result = _rebuildFlightRuntimeEntities(
        frameDocs[fi], flights, bdt, validRegs,
        segActiveJetways[fi] || [], segTypeMaps[fi], log, segIdMappers[fi], icao,
        segRecvEventsCaches[fi],
        segWaitingCmdsCaches[fi],
        approachCache, text, saveSec
      );
      if (result.added > 0 || result.removed > 0) {
        frameDocs[fi] = result.text;
        frameModified = true;
      }
    }

    // 7c. Remove orphaned RuntimeEntities entries whose $k doesn't exist in StaticItems.
    // When a flight's registration changes, the rebuilt StaticItems header has the new
    // key (e.g. "flight-plan:B-99Y2") but runtime segments still carry the old key
    // (e.g. "flight-plan:B-34JP"). The stale $fstrref â†’ null replacement (7a) handles
    // the StaticItem field inside the $v, but the $k itself remains stale. The game
    // uses $k to look up StaticItems[entityKey] and throws:
    //   "FlightPlan: static item 'flight-plan:B-34JP' does not exist in
    //    CurrentLevel.StaticField.StaticItems"
    // We remove/rename these orphaned entries in ALL segments (header + frames).
    let totalOrphanRemoved = 0;
    let totalRenamed = 0;
    for (let fi = 0; fi < frameDocs.length; fi++) {
      const result = _removeOrphanedFlightEntities(frameDocs[fi], validRegs, renameMap, log);
      if (result.removed > 0 || result.renamed > 0) {
        frameDocs[fi] = result.text;
        frameModified = true;
        totalOrphanRemoved += result.removed;
        totalRenamed += result.renamed;
      }
    }
    if (totalOrphanRemoved > 0) {
      log('Removed ' + totalOrphanRemoved + ' orphaned RuntimeEntities entry(s)');
    }
    if (totalRenamed > 0) {
      log('Renamed ' + totalRenamed + ' RuntimeEntities entry key(s) for changed registration(s)');
    }

    // 7d. Clear all EventLog.LatestEvents entries on every save.
    // Prevents stale "aircraft:REG" entries (which cause "has no flight
    // plan reference" errors) from accumulating when flights are deleted
    // or re-registered.  The dictionary metadata (comparer, etc.) is preserved.
    let totalElRemoved = 0;
    for (let fi = 0; fi < frameDocs.length; fi++) {
      const result = _cleanupEventLogLatestEvents(frameDocs[fi], log);
      if (result.removed > 0) {
        frameDocs[fi] = result.text;
        frameModified = true;
        totalElRemoved += result.removed;
      }
    }
    if (totalElRemoved > 0) {
      log('Cleared ' + totalElRemoved + ' EventLog.LatestEvents entry(s)');
    }

    // â”€â”€ Centralized $iref remapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Apply all oldâ†’new $id mappings collected by the per-segment IdMapper
    // instances. This corrects $iref references in preserved entries that
    // pointed to removed/rebuilt objects (e.g. flight-plan:REG entries
    // whose $id values changed during rebuild). Runs AFTER all rebuild/cleanup
    // steps (7b-1 through 7d) so every mapping is registered before we scan.
    let totalIrefRemapped = 0;
    for (let fi = 0; fi < frameDocs.length; fi++) {
      const mapper = segIdMappers[fi];
      if (mapper && mapper.size > 0) {
        const remapResult = mapper.remapIrefs(frameDocs[fi]);
        if (remapResult.count > 0) {
          frameDocs[fi] = remapResult.text;
          frameModified = true;
          totalIrefRemapped += remapResult.count;
        }
      }
    }
    if (totalIrefRemapped > 0) {
      log('Remapped ' + totalIrefRemapped + ' $iref reference(s) to updated $id values');
    }

    if (frameModified) {
      newText = frameDocs.join(exactSentinel);
    }

    // 7a. Replace stale $fstrref â†’ null everywhere, but REMAP for renames.
    // Runs AFTER 7b so the jetway reset step can detect stale DockingAircraft
    // via intact $fstrref references before they are nulled here.
    // Use indexOf scan (not regex) â€” $fstrref is an Odin value format, not a JSON key,
    // so findSection doesn't apply, but pattern scanning with positional replacement
    // applied back-to-front is safe and avoids any regex edge cases.
    let staleReplaced = 0;
    let remappedRefs = 0;
    {
      const fpRefPrefix = '$fstrref:"flight-plan:';
      const replacements = []; // { start, end, replacement }
      let searchFrom = 0;
      while (searchFrom < newText.length) {
        const idx = newText.indexOf(fpRefPrefix, searchFrom);
        if (idx < 0) break;
        const regStart = idx + fpRefPrefix.length;
        const regEnd = newText.indexOf('"', regStart);
        if (regEnd < 0) break;
        const reg = newText.substring(regStart, regEnd);
        if (!validRegs.has(reg)) {
          if (renameMap.has(reg)) {
            remappedRefs++;
            const newReg = renameMap.get(reg);
            replacements.push({
              start: idx,
              end: regEnd + 1, // past the closing "
              replacement: '$fstrref:"flight-plan:' + newReg + '"'
            });
          } else {
            staleReplaced++;
            replacements.push({
              start: idx,
              end: regEnd + 1,
              replacement: 'null'
            });
          }
        }
        searchFrom = regEnd + 1;
      }
      // Apply back-to-front (no position drift)
      if (replacements.length > 0) {
        replacements.sort((a, b) => b.start - a.start);
        for (const r of replacements) {
          newText = newText.substring(0, r.start) + r.replacement + newText.substring(r.end);
        }
      }
    }
    if (staleReplaced > 0) {
      log('Cleaned up ' + staleReplaced + ' stale $fstrref reference(s) â†’ null');
    }
    if (remappedRefs > 0) {
      log('Remapped ' + remappedRefs + ' $fstrref reference(s) to new registration(s)');
    }
  }

  const { writeAcl } = require('./gatcarc');
  const savedFormat = writeAcl(aclPath, newText);
  log('SUCCESS â€“ file written (' + (newText.length / 1024).toFixed(0) + ' KB, ' + savedFormat + ' container)');
}

function _countArrayEntries(arrText) {
  if (!arrText) return 0;
  let count = 0;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < arrText.length; i++) {
    const c = arrText[i];
    if (c === '"' && (i === 0 || arrText[i - 1] !== '\\')) { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) count++; }
  }
  return count;
}

module.exports = {
  _parseWorldStateFlightPlans,
  _parseFlightPlanEntry,
  _buildFlightPlanArrivalLeg,
  _buildFlightPlanDepartureLeg,
  _rebuildWorldStateSections,
  _rebuildStaticDataSections,
  _validateStandConflicts,
  _rebuildTimelineSections,
  _rebuildFlightRuntimeEntities,
  _buildStandaloneAircraftEntry,
  _timeStrToSeconds,
  _extractSection, _extractConfig,
  _extractAppChannelGuid,
  _extractTowerChannelGuid,
  _removeOrphanedFlightEntities,
  _cleanupEventLogLatestEvents,
  _rebuildJetwayEntries,
  _buildActiveJetwayEntry,
  _extractRecvEventsInnerId,
  _rebuildReceivedEventsInEntry,
  _extractWaitingCmdsInnerId,
  _rebuildWaitingCommandsInEntry,
  _resetFrameJetwayDockingState,
  _generateFramesSection,
  _generateRunwayTimelineSection,
  _parseWeatherFrames,
  _parseWindFrames,
  _parseRunwayTimeline,
};
