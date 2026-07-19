/**
 * ACL FlightPlans parser — new game format (type 37/52), ArrivalLeg (type 58), DepartureLeg (type 57).
 *
 * Parse path uses the tokenizer for string-aware boundary finding and the
 * pre-processor + JSON.parse for section content. Write/rebuild path still
 * uses string concatenation (to be migrated to serializer in follow-up).
 */
const fs = require('fs');
const path = require('path');
const { FALLBACK_BASE_DATE_TICKS, APPROACH_MIN_TTL, WARMUP_SEC, GRACE_TTL, TYPE_NUM_FALLBACK_START, ID_OFFSET_FLIGHTPLAN, ID_OFFSET_AIRCRAFT, ID_OFFSET_ANIMATOR, CMD_CONTACT_TOWER, CMD_CLEARED_TO_LAND } = require('./constants');
const { ticksToTime, timeToTicks, _extractBaseDateFromText } = require('../utils/timeUtils');
const { _generateGuid } = require('./world_state');
const { computeProgressRatio, computePathLength, resolveFlyApproachPoints, buildApproachAircraftBlock, buildState5AircraftBlock, buildAnimatorBlock, extractGameTime, computeApproachCap, _vec3Sub, _vec3Normalize, _vec3Dist, _detectSchemaVersion } = require('./approach');
const { createTokenizer } = require('./tokenizer');
const { preprocessUnityJson } = require('./acl_json');
const { readAclText, writeAcl } = require('./gatcarc');

// ─── Parse WorldState.FlightPlans ─────────────────────────────

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

  // Extract $rlength — v2/v3 regex (byte-identical to original editor output)
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

// ─── Parse v4 StaticData.$blobdoc.StaticItems ─────────────

function _parseStaticDataFlightPlans(text) {
  const log = (msg) => console.log('[ACL-FP]', msg);

  // Navigate: StaticData → $blobdoc → StaticItems → $rcontent
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

  // Extract $rlength — structural, no regex
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

  // Parse $rcontent entries — same $k/$v structure as old format
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

// ─── Parse single FlightPlanState entry (type 37) ─────────────

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


// ─── Build FlightPlan Arrival leg (type 58) ───────────────────

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

// ─── Build FlightPlan Departure leg (type 57) ─────────────────

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

// ─── Rebuild WorldState.FlightPlans & Aircrafts from scratch ──

function _rebuildWorldStateSections(aclPath, flights, baseDateTicks, approachCache, aclcfgStartTime, _saveSec) {
  const log = (msg) => console.log('[ACL-REBUILD]', msg);
  const text = readAclText(aclPath);
  const bdt = baseDateTicks || _extractBaseDateFromText(text);
  // Extract ICAO from path: .../Airports/<ICAO>/Levels/...
  const icaoMatch = aclPath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
  const icao = icaoMatch ? icaoMatch[1] : '';
  // Fallback: read startTime from ACL's Config block if not passed
  if (!aclcfgStartTime) {
    try {
      const config = _extractConfig(text);
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
  // Type numbers are per-file in Unity's JSON serialization — each .acl file gets
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
  // Merge file-specific cached typeMap — current file wins (its type declarations
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
  // This guarantees unique numbers — no collision with existing types or each other.
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
      // Legacy exact-substring match (v2/v3 compatibility — byte-identical output)
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
  log('Aircrafts $rcontent: ' + acContentStart + ' → ' + acContentEnd);

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
  log('FlightPlans $rcontent: ' + fpContentStart + ' → ' + fpContentEnd);

  // FlightPlan type numbers resolved from per-file typeMap (see typeNums above).
  // This replaces the old regex-based extraction from the original FlightPlans
  // content; the typeMap lookup is simpler and shares the same source of truth.
  const _fpTypeNum = typeNums.fpState;
  const _fpArrTypeNum = typeNums.fpArrLeg;
  const _fpDepTypeNum = typeNums.fpDepLeg;
  log('FlightPlans type numbers: FlightPlanState=' + _fpTypeNum + ' ArrivalLeg=' + _fpArrTypeNum + ' DepartureLeg=' + _fpDepTypeNum);

  // 4. Build segments — also locate AircraftAnimators $rcontent between Aircrafts and FlightPlans
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
        log('AircraftAnimators $rcontent: ' + aaRcStart + ' → ' + aaRcEnd);
      }
    }
  }

  // 5. Generate new FlightPlans entries (need to know GUIDs for Aircrafts linking)
  const fpEntries = [];
  const fpGuids = []; // parallel to flights array — GUID used for each FlightPlan
  for (let i = 0; i < flights.length; i++) {
    // Generate GUID first so we can link AircraftState to it
    const fpGuid = _generateGuid();
    fpGuids.push(fpGuid);
    fpEntries.push(_buildFlightPlanStateEntryWithGuid(flights[i], ID_OFFSET_FLIGHTPLAN + i, bdt, fpGuid, _fpTypeNum, _fpArrTypeNum, _fpDepTypeNum));
  }
  log('generated ' + fpEntries.length + ' FlightPlan entries');

  // 6. Generate Aircrafts entries — only State=30 approach aircraft
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
    // WARMUP_SEC imported from constants — game advances from Config.startTime to first flight time

    // Resolve saveTime: explicit > GameTime.CurrentDateTime (authoritative — the
    // literal wall-clock time the game wrote when it saved this snapshot) >
    // per-file cache offset (derived from State=30 approach entries — calibrates
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

      // Look up Specification via Designator mapping
      const designator = approachCache.designatorMap
        ? approachCache.designatorMap.get(fl.AircraftType || '')
        : null;
      const spec = designator ? approachCache.specDB.get(designator) : null;
      if (!spec) {
        log('  no spec for type "' + (fl.AircraftType || '') + '" (designator=' + designator + '), skipping Aircraft entry');
        continue;
      }

      // Compute ProgressRatio using verified formula with derived saveTime
      const landingSec = _toSec(fl.LandingTime);
      const timeToLanding = landingSec - saveSec; // seconds until landing
      // Clamp timeToLanding to a minimum of 30s for aircraft near landing,
      // but skip aircraft that landed more than 10s before the snapshot.
      // This avoids edge cases where PR ≈ 1.0 places the aircraft at/beyond
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
        log('  SKIP (PR=' + progressRatio.toFixed(3) + ' ≤ 0, not started approach): ' + fl.CallSign);
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
        // ── State=5: Past IAF, on Tower frequency ──

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
          // The real touchdown is further along the approach direction — for
          // KJFK 22R, the distToTD from last ppList point is ~108m.
          if (appPoints && appPoints.length >= 2) {
            const lastPt = appPoints[appPoints.length - 1];
            const prevPt = appPoints[appPoints.length - 2];
            const dir = _vec3Normalize(_vec3Sub(lastPt, prevPt));
            // Use per-airport approach cap from 5000ft real-world ceiling.
            // AppPointList points have y=0 in the ACL (Unity XZ plane);
            // Y is always computed from the 3° glideslope in buildState5AircraftBlock.
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
          //   ≥60s → Contact Tower (command 22, no exit selected)
          //   <60s → Cleared to Land (command 23, exit selected)
          // TEMP: always use Contact Tower (22) — jumping straight to Cleared to Land (23)
          // prevents the game from initializing the landing state machine, causing
          // NullReferenceException due to missing type declarations (types 41-43, 49-52).
          // const isClearedToLand = timeToLanding < 60; // TEMP: disabled

          // State=5 position path mirrors State=30: STAR FlyApproach + procedure
          // PathPointList + touchdown. flyPoints (STAR) was already resolved
          // above — pass it directly instead of re-resolving the procedure's
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

      // ── State=30: Before IAF, on Approach frequency ──

      log('  build State=30 entry: ' + fl.CallSign + ' ' + star + '/' + runway +
          ' td=' + timeToLanding + 's PR=' + progressRatio.toFixed(3) +
          ' flyPts=' + flyPoints.length + ' appPts=' + appPoints.length);

      // TouchDownPosition + approachCap for 3° glideslope Y in State=30.
      // approachCap computed from 5000ft real-world ceiling via per-airport scale.
      const state5ForRwy = approachCache?.state5ParamsMap?.get(runway);
      let tdPos = state5ForRwy?.touchDownPosition || null;
      let approachCap = computeApproachCap(airportScale);
      // Fallback: derive touchdown from AppPointList when state5ParamsMap lacks
      // this runway. Same derivation as the State=5 fallback — extends the last
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
  // full-form types. This is a safety net — it catches any short-form refs that
  // may have been missed (e.g., inside string-replaced segments). BCL types
  // (DateTime=3, Vector3=16, etc.) are not in typeMap and are left untouched.
  newText = _expandShortFormTypes(newText, typeMap);

  // v2/v3: write as plain text (byte-identical to original editor output)
  fs.writeFileSync(aclPath, newText, 'utf-8');
  log('SUCCESS – file written (' + (newText.length / 1024).toFixed(0) + ' KB, utf-8)');
}

// ─── Build FlightPlanStateEntry with preset GUID ────────────────

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

// ─── Rebuild Timeline Sections (WindFrames, WeatherFrames, RunwayTimeline) ──

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
  // Protect CurrentDateTime blocks from expansion — the System.DateTime type (3)
  // is a standard .NET type, not a custom GroundATC type, and its short-form
  // representation must be preserved for extractCurrentDateTime / extractGameTime.
  const protectedBlocks = [];
  const textWithPlaceholders = text.replace(
    /"CurrentDateTime":\s*\{[\s\S]{0,250}?\}/g,
    (match) => {
      protectedBlocks.push(match);
      return '<<<CDT_BLOCK_' + (protectedBlocks.length - 1) + '>>>';
    }
  );
  const expanded = textWithPlaceholders.replace(/"\$type":\s*(\d+)\s*([,\}\]])/g, (match, numStr, delimiter) => {
    const num = parseInt(numStr, 10);
    const fullType = typeMap.get(num);
    if (fullType) {
      return '"$type": "' + num + '|' + fullType + '"' + delimiter;
    }
    return match;
  });
  // Restore protected CurrentDateTime blocks
  return expanded.replace(/<<<CDT_BLOCK_(\d+)>>>/g, (_, idx) => protectedBlocks[parseInt(idx, 10)]);
}

/**
 * Fix dangling $iref references in the SingletonStates section.
 *
 * The Aircrafts rebuild replaces the entire Aircrafts $rcontent, which may
 * contain $id definitions that GameEventScheduler.EventQueue and
 * EventLogger.History reference via $iref.  After rebuild those $id
 * definitions are gone, but the $iref pointers in segAfter remain —
 * causing the game to crash on EventLogger.Load (NullReferenceException
 * inside LinkedList constructor).
 *
 * When EventQueue is a $iref, we replace it with an inline empty
 * AircraftEvent[] and update History to point to the new inline queue.
 * This matches the pattern used by the game in healthy files (e.g.
 * ZSJN_19-21.acl).
 *
 * @param {string} segAfter — preserved segment after FlightPlans
 * @param {Map<number,string>} typeMap — per-file type-number → type-name mapping
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
        // History references a different $iref — also dangling.  Create a
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
 * state: Status→0, Progress→0, DockingAircraftGuid→null, DockingDoorIndex→-1.
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
  // Split on "$v": {  — each pair is a $k/$v Jetway entry
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

function _sectionMeta(sectionText) {
  const idMatch = sectionText.match(/"\$id"\s*:\s*(\d+)/);
  const typeMatch = sectionText.match(/"\$type"\s*:\s*"([^"]+)"|\$type"\s*:\s*(\d+)/);
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
  const m = after.substring(brace).match(/"\$type"\s*:\s*"([^"]+)"|\$type"\s*:\s*(\d+)/);
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
  L.push(`${I}        "$type": ${meta.irType},`);
  L.push(`${I}        "$rlength": ${ir.length},`);
  L.push(`${I}        "$rcontent": [`);
  for (let i = 0; i < ir.length; i++)
    L.push(`${I}            "${ir[i]}"${i < ir.length - 1 ? ',' : ''}`);
  L.push(`${I}        ]`);
  L.push(`${I}    },`);

  L.push(`${I}    "Timeline": {`);
  L.push(`${I}        "$id": ${meta.tlId},`);
  if (meta.tlTypeStr)
    L.push(`${I}        "$type": "${meta.tlTypeNum}|ContextCross.States.RunwayChangeFrame[], GroundATC.Core",`);
  else
    L.push(`${I}        "$type": ${meta.tlTypeNum},`);
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
  let irId = 0, irType = 8;
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
      const tm = ir.match(/"\$type"\s*:\s*(\d+)/);
      irType = tm ? parseInt(tm[1], 10) : 8;
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
      const ttm = tl.match(/"\$type"\s*:\s*"([^"]+)"|\$type"\s*:\s*(\d+)/);
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
          const ctm = ch.match(/"\$type"\s*:\s*"([^"]+)"|\$type"\s*:\s*(\d+)/);
          if (ctm) changesArrTypeNum = ctm[1] ? _parseTypeNum(ctm[1]) : parseInt(ctm[2], 10);
          changeElemTypeNum = _elemTypeFromRcontent(ch);
        }
      }
    }
  }

  // Fallback: when timeline is empty, element type numbers can't be
  // extracted from rcontent — compute from tlTypeNum using known fixed
  // offsets (RunwayChangeFrame=+1, RunwayChange[]=+2, RunwayChange=+3).
  // Verified across all 24 .acl files — offsets never vary.
  if (tlTypeNum !== null) {
    if (tlElemTypeNum === null) tlElemTypeNum = tlTypeNum + 1;
    if (changesArrTypeNum === null) changesArrTypeNum = tlTypeNum + 2;
    if (changeElemTypeNum === null) changeElemTypeNum = tlTypeNum + 3;
  }

  return {
    parentId: parent.id, parentTypeNum: parent.typeNum, parentTypeStr: parent.typeStr,
    irId, irType, tlId, tlTypeNum, tlTypeStr, tlElemTypeNum,
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

  // ── WeatherFrames ──
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

  // ── WindFrames ──
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

  // ── RunwayTimeline ──
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

// ─── Parse timeline sections from ACL text ────────────────────

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

/** Parse WeatherFrames from ACL text → same format as weather_timeline.json. */
function _parseWeatherFrames(text) {
  const sec = _extractSection(text, 'WeatherFrames');
  if (!sec) return [];
  return _parseFramesSection(sec.content).map(e => ({
    preset: e.preset || '',
    time: e.time || '',
  }));
}

/** Parse WindFrames from ACL text → same format as wind_timeline.json. */
function _parseWindFrames(text) {
  const sec = _extractSection(text, 'WindFrames');
  if (!sec) return [];
  return _parseFramesSection(sec.content).map(e => ({
    direction: e.direction || 0,
    speed: e.speed || 0,
    time: e.time || '',
  }));
}

/** Parse RunwayTimeline from ACL text → same format as runway_timeline_*.json. */
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

// ─── V4 Save: rebuild StaticData.$blobdoc.StaticItems flight-plan entries ──

function _rebuildStaticDataSections(aclPath, flights, baseDateTicks, approachCache) {
  const log = (msg) => console.log('[ACL-REBUILD-V4]', msg);
  const text = readAclText(aclPath);
  const bdt = BigInt(baseDateTicks || FALLBACK_BASE_DATE_TICKS);

  // Build per-file typeMap (same pattern as _rebuildWorldStateSections)
  // Type numbers are per-file in Unity's JSON serialization — each .acl file gets
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

  // Build blobdoc-scoped type map — each $blobdoc has its own independent
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
        // Number already taken in blobdoc — keep searching for an unclaimed match
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
  // $id values inside the blobdoc form a flat namespace — we must not collide
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

  log('StaticItems $rcontent: ' + rcStart + ' → ' + rcEnd);

  // 2. Find all flight-plan entries within the $rcontent array
  const arrayContent = siText.substring(rcStart + 1, rcEnd - 1); // inside [...]
  const arrT = createTokenizer(siText);

  // Locate the first and last flight-plan entry to determine the replacement range
  // Also capture the $type from the first flight-plan entry (varies per file)
  let fpFirstStart = -1, fpLastEnd = -1;
  const fpItemNum = _tn('ContextCross.Models.FlightPlanStaticItem,') || nextFallbackNum++;
  let fpTypeStr = `"$type": "${fpItemNum}|ContextCross.Models.FlightPlanStaticItem, GroundATC.Core"`;
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
      if (fpFirstStart < 0) {
        fpFirstStart = pos;
        // Capture the $type from the first flight-plan entry (varies per file)
        const typeMatch = entryBlock.match(/"\$type":\s*("[^"]*"|\d+)/);
        if (typeMatch) fpTypeStr = '"$type": ' + typeMatch[1];
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

  log('flight-plan range: ' + fpFirstStart + ' → ' + fpLastEnd +
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
      if (!t) return 0n;
      const p = String(t).split(':');
      const sec = +p[0] * 3600 + (+p[1] || 0) * 60 + (+p[2] || 0);
      return bdt + BigInt(Math.round(sec * 10000000));
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
    // Flight-plan entries existed — replace them in-place within siText
    newSiText = segBefore + fpContent + segAfter;
  } else {
    // No flight-plan entries yet — insert at start of $rcontent array
    const bracketIdx = siText.indexOf('[', rcSec.valueStart);
    const afterBracket = siText.substring(bracketIdx + 1);
    newSiText = siText.substring(0, bracketIdx + 1) + fpContent + afterBracket;
  }

  // Apply $rlength update to the final section text — use structural scan
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

  // 6. Write — convert section offsets from bdT space to full text space
  const secKeyGlobal = sdSec.valueStart + bdSec.valueStart + siSec.keyStart;
  const secValueStartGlobal = sdSec.valueStart + bdSec.valueStart + siSec.valueStart;
  const secValueEndGlobal = sdSec.valueStart + bdSec.valueStart + siSec.valueEnd;

  // Reconstruct the full section: "StaticItems": { ... }
  const secPrefix = text.substring(secKeyGlobal, secValueStartGlobal); // e.g. "StaticItems":
  const fullBefore = text.substring(0, secKeyGlobal);
  const fullAfter = text.substring(secValueEndGlobal);
  const newText = fullBefore + secPrefix + finalSiText + fullAfter;

  const { writeAcl } = require('./gatcarc');
  const savedFormat = writeAcl(aclPath, newText);
  log('SUCCESS – file written (' + (newText.length / 1024).toFixed(0) + ' KB, ' + savedFormat + ' container)');
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
  _rebuildTimelineSections,
  _extractSection, _extractConfig,
  _extractAppChannelGuid,
  _extractTowerChannelGuid,
  _generateFramesSection,
  _generateRunwayTimelineSection,
  _parseWeatherFrames,
  _parseWindFrames,
  _parseRunwayTimeline,
};
