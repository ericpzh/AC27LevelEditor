/**
 * ACL FlightPlans parser — new game format (type 37/52), ArrivalLeg (type 58), DepartureLeg (type 57).
 *
 * Parse path uses the tokenizer for string-aware boundary finding and the
 * pre-processor + JSON.parse for section content. Write/rebuild path still
 * uses string concatenation (to be migrated to serializer in follow-up).
 */
const path = require('path');
const { FALLBACK_BASE_DATE_TICKS, APPROACH_MIN_TTL, GRACE_TTL, TYPE_NUM_FALLBACK_START, CMD_CONTACT_TOWER, DEFAULT_RUNWAY_TAKEOFF_LENGTH, DEFAULT_MODEL_OFFSET, DEFAULT_WAKE_CATEGORY, DEFAULT_RUNWAY_VR_SPEED, TICKS_PER_DAY, TICKS_PER_SECOND_NUM, DEPARTURE_TAXI_SECONDS, ARRIVAL_TAXI_SECONDS, TAXI_SPEED, POSITIVE_TAXI_ACCEL, NEGATIVE_TAXI_ACCEL, DYNAMICS_POSITIVE_TAXI_ACCEL, DYNAMICS_NEGATIVE_TAXI_ACCEL } = require('./constants');
const { ticksToTime } = require('../utils/timeUtils');
const { computePathLength, resolveFlyApproachPoints, computeApproachCap, computePosition, computeDirection } = require('./approach');
const { createTokenizer } = require('./tokenizer');
const { preprocessUnityJson, serializeUnityJson, parseOdinObject } = require('./acl_json');
const { readAclText, writeAcl } = require('./gatcarc');

/**
 * Compute _departureTakeoffTime ticks, falling back to OffBlockTime + taxi-constant
 * when TakeoffTime is empty/0 (the v4 default, where the game computes it dynamically).
 *
 * @param {string|number} takeoffTime — TakeoffTime value (HH:MM:SS, ticks string, or falsy)
 * @param {string|number} offBlockTime — OffBlockTime value (HH:MM:SS or ticks string)
 * @param {number|string} baseDateTicks — base date ticks for this scenario
 * @param {string} [icao] — airport ICAO code for per-airport taxi override
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
 * @param {string|number} landingTime — LandingTime value (HH:MM:SS, ticks string, or falsy)
 * @param {string|number} inBlockTime — InBlockTime value (HH:MM:SS, ticks string, or falsy)
 * @param {number|string|bigint} baseDateTicks — base date ticks for this scenario
 * @param {string} [icao] — airport ICAO code for per-airport taxi override
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

// ─── Parse WorldState.FlightPlans ─────────────────────────────


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

function _parseWorldStateFlightPlans(text) {
  const log = (msg) => console.log('[ACL-FP]', msg);
  log('_parseWorldStateFlightPlans() START');

  // v4 schema: use StaticData.$blobdoc.StaticItems path
  return _parseStaticDataFlightPlans(text);
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
    const flight = _parseFlightPlanEntry(entry.vBlock);
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

function _parseFlightPlanEntry(vBlock) {
  const cleaned = preprocessUnityJson(vBlock);
  const obj = JSON.parse(cleaned);
  return _extractFlightFromParsed(obj);
}

/**
 * Extract flight data from a parsed FlightPlanState object.
 * The object was produced by pre-processor + JSON.parse, so DateTime
 * fields have __v sentinel arrays (e.g., { "$type": 3, "__v": ["<ticks>"] }).
 */
function _extractFlightFromParsed(obj) {
  const f = {};

  f._Registration = obj.Registration || '';
  f.AircraftType = obj.AircraftType || '';
  f.AirlineName = obj.AirlineName || '';
  f.Voice = obj.Voice || '';
  f.Language = obj.Language || '';
  f._fpGuid = '';

  // v4 schema uses InitialArrival/InitialDeparture
  const arrLeg = obj.InitialArrival;
  const depLeg = obj.InitialDeparture;

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
  // Protect CurrentDateTime blocks from expansion — the System.DateTime short-form
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
 * which scope it lives in, producing "Type id N claimed by both …" during encode.
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
      // No more blobdocs — expand remaining text with the outer typeMap
      result += _replaceBareTypeRefs(text.substring(pos), outerTypeMap);
      break;
    }

    // Only match when "$blobdoc" is a JSON key (preceded by { or , with optional
    // whitespace), not when it appears inside a string value.
    let before = keyIdx - 1;
    while (before >= 0 && ' \t\n\r'.includes(text[before])) before--;
    if (before < 0 || (text[before] !== '{' && text[before] !== ',')) {
      // False positive — inside a string value or not a key. Skip past it.
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
      // Value is not an object — skip
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
 * Centralized ID mapper for tracking old → new $id assignments during save.
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
   * if 738→1042 and 1042→1500, resolve(738) returns 1500.
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
   * Uses indexOf (not regex) because $iref: is a bare Odin token — it never
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
 * v4: Reset docking state on jetway entries in the checkpoint frame's
 * RuntimeData blobdoc. When flights are deleted, jetway entries in the
 * frame may still have non-null DockingAircraft fields containing embedded
 * Aircraft objects whose flight-plan $fstrref references are now stale.
 * We detect these by checking $fstrref:"flight-plan:REG" inside the
 * DockingAircraft value against the set of valid registrations, and reset
 * the docking fields: Status→0, Progress→0, DockingAircraft→null,
 * DockingDoorIndex→-1.
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
 * $v: $iref:N to reference that Aircraft — when the orphan is removed the
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

  // ── Navigate to RuntimeEntities.$rcontent structurally ──────────
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

  // ── Single-pass entry iteration ─────────────────────────────────
  const entries = [];  // { text, orphan } — orphan removes entry from RuntimeEntities
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
          // ── flight-plan:REG ──
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
          // ── aircraft:REG (exclude aircraft-animator:aircraft:REG) ──
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
          // ── aircraft-animator:aircraft:REG ──
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

  // ── Reconstruct ─────────────────────────────────────────────────
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
        // rlSec positions are in reText space → map to frameText space
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
  // ── Navigate to RuntimeEntities.$rcontent ───────────────────────
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

  // ── Find the singleton:event-log entry within RuntimeEntities ────
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

  // ── Navigate into $v.LatestEvents.$rcontent ─────────────────────
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

  // ── Count existing LatestEvents entries ──────────────────────────
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

  // ── Clear LatestEvents.$rcontent and set $rlength to 0 ──────────
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

  // ── Reconstruct $v ──────────────────────────────────────────────
  const leStartInV = leSec.valueStart;
  const newVText =
    vText.substring(0, leStartInV) + newLeText + vText.substring(leStartInV + leText.length);

  // ── Reconstruct event-log entry ─────────────────────────────────
  const vStartInEl = vSec.valueStart;
  const newElEntry =
    elEntryText.substring(0, vStartInEl) + newVText + elEntryText.substring(vStartInEl + vText.length);

  // ── Reconstruct the full frame ──────────────────────────────────
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
 *   Pass 1 — Identify stale jetways and collect $id→$type mappings for
 *             shared resources that other entries $iref to.
 *   Pass 2 — Build replacement text.  Entries that $iref to $id values
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
  // Inline object — extract its $id
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
 * @param {object} _recvEventsCache - { canonicalId: number|null }
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
    // $iref:N — scan past the digits
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
    // Already have a canonical definition — replace this inner value with $iref
    const newInner = '$iref:' + recvEventsCache.canonicalId;
    if (innerVal === newInner) return entryText; // already correct
    const before = entryText.substring(0, vSec.valueStart + reStart + innerStart);
    const after = entryText.substring(vSec.valueStart + reStart + innerEnd);
    return before + newInner + after;
  } else {
    // First occurrence — extract its $id as the canonical one
    if (reObj[innerStart] === '{') {
      const it = createTokenizer(innerVal);
      const idSec = it.findSection('$id');
      if (idSec) {
        recvEventsCache.canonicalId = parseInt(innerVal.substring(idSec.valueStart, idSec.valueEnd), 10);
      }
    }
    // If it's an $iref with no canonical set, that's fine — this is the first entry
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
 * @param {object} _waitingCmdsCache - { canonicalId: number|null }
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
    // $iref:N — scan past the digits
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
    // Already have a canonical definition — replace this inner value with $iref
    const newInner = '$iref:' + waitingCmdsCache.canonicalId;
    if (innerVal === newInner) return entryText; // already correct
    const before = entryText.substring(0, vSec.valueStart + wcStart + innerStart);
    const after = entryText.substring(vSec.valueStart + wcStart + innerEnd);
    return before + newInner + after;
  } else {
    // First occurrence — extract its $id as the canonical one
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
 * consecutive ARR→DEP pairs have matching registrations (same aircraft).
 *
 * A stand may host multiple sequential turnarounds with different aircraft:
 *   Arr A (REG:X) → Dep B (REG:X) → Arr C (REG:Y) → Dep D (REG:Y)
 * Sorting by time and checking only ARR→DEP neighbors handles this correctly.
 *
 * Throws on conflict — called before the save pipeline so the user sees a
 * descriptive error rather than a corrupted save.
 *
 * @param {Array} flights — editor state flight objects
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
    // Sort by time (HH:MM:SS lexicographic — zero-padded, same-day, correct)
    entries.sort((a, b) => a.time.localeCompare(b.time));

    // Check consecutive ARR → DEP pairs
    for (let i = 0; i < entries.length - 1; i++) {
      const curr = entries[i];
      const next = entries[i + 1];

      if (curr.type === 'ARR' && next.type === 'DEP') {
        if (curr.reg !== next.reg) {
          throw new Error(
            `Save aborted: Stand ${standKey} conflict — ` +
            `arrival ${curr.cs} (${curr.reg}) at ${curr.time} ` +
            `and departure ${next.cs} (${next.reg}) at ${next.time} ` +
            `have different registrations. ` +
            `A stand cannot hold two different aircraft simultaneously.`
          );
        }
        // Same REG → valid turnaround (aircraft arrives, stays, departs)
      }
      // DEP → ARR: one aircraft left, another arrives later — normal
      // DEP → DEP or ARR → ARR: unusual but handled by other validators
    }
  }
}

/**
 * Extract the world-state snapshot time (seconds since midnight) from a
 * GATCARC4 segment's GameTime.CurrentDateTime, or null when the segment has
 * none (e.g. the header segment, whose jetways are session-start state).
 *
 * The game writes an EMPTY jetway entry when a stand's departure aircraft has
 * already off-blocked at the snapshot time (aircraft departed) and a populated
 * entry when the departure is still at the gate. The jetway rebuild must apply
 * the same rule, or a save would resurrect departed aircraft at the gate (and,
 * without an approach cache, crash trying to build an active jetway from an
 * empty original entry).
 */
function _extractSegmentSnapshotSec(segmentText) {
  // v4 serialization: "CurrentDateTime": { "$id": N, "$type": "...", { "$type": N, <ticks> } }
  const m = segmentText.match(/"CurrentDateTime":\s*\{\s*"\$id":\s*\d+,\s*"\$type":\s*"[^"]*",\s*\{\s*"\$type":\s*\d+,\s*(-?\d+)\s*\}\s*\}/);
  if (!m) return null;
  try {
    const ticks = BigInt(m[1]);
    // TICKS_PER_DAY is BigInt — divide by BigInt TICKS_PER_SECOND, not the Number variant
    return Number((((ticks % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY) / 10000000n);
  } catch (_) {
    return null;
  }
}

function _rebuildJetwayEntries(segmentText, flights, validRegs, approachCache, log, idMapper, baseDateTicks, icao, fpIdByReg, standPositions, strArrCache, recvEventsCache, waitingCmdsCache) {
  // ── Navigate to RuntimeEntities.$rcontent structurally ──────────
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

  // Build stand → flight lookup (DEP flights only).
  // When multiple DEPs share a stand, keep the one with the earliest OffBlockTime.
  const standFlights = new Map();
  for (const fl of flights) {
    const isDep = fl.isDeparture === true;
    if (isDep && fl.Stand) {
      const standKey = String(fl.Stand).replace(/^0+/, ''); // normalize "02" → "2"
      const existing = standFlights.get(standKey);
      if (!existing || (fl.OffBlockTime || '') < (existing.OffBlockTime || '')) {
        standFlights.set(standKey, fl);
      }
    }
  }

  // Build stand → all arrivals lookup for turnaround detection.
  // A single stand may host multiple sequential turnarounds with different
  // aircraft, so we store an array per stand (not a single value).
  //
  // NOTE: We do NOT filter on fl.LandingTime being truthy. ticksToTime(0)
  // returns "" for midnight (00:00:00), which would incorrectly exclude
  // midnight arrivals from turnaround detection. The time comparison in
  // the turnaround check handles empty strings correctly.
  const standArrFlights = new Map(); // standKey → [arrFlight, ...]
  for (const fl of flights) {
    const isDep = fl.isDeparture === true;
    if (!isDep && fl.Stand != null && fl.Stand !== '') {
      const standKey = String(fl.Stand).replace(/^0+/, '');
      if (!standArrFlights.has(standKey)) standArrFlights.set(standKey, []);
      standArrFlights.get(standKey).push(fl);
    }
  }

  // ── PASS 1: Parse entry metadata ──────────────────────────────────
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
  // uses bare "$type": 3, the JSON→binary encoder fails with "unknown type
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
  // so we can register old→new mappings in the IdMapper after rebuild.
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
  // recvEventsCache / waitingCmdsCache hold the canonical AircraftEvent[] and
  // ECommand[] $ids shared across all entries; they are created by the caller
  // (per segment) so 7b-1 and 7b-3 claim from the same dynamic allocator.

  // ── Claim the canonical empty string[] $id from the shared dynamic allocator ──
  // (see segStrArrCanonicalIds in _rebuildStaticDataSections).  The first entry
  // that emits an AircraftRunwayCoordinator (usually the first active jetway)
  // defines the array inline at this id; every later entry $iref's it.  The id is
  // claimed from the dynamic allocator — NOT from the entry's static
  // entryId+offset range — because overlapping jetway ranges (entryIds 8 apart,
  // template offsets up to 38) can collide: jetway:01 id(33)=36 equals
  // jetway:02 id(25)=36, and a duplicate $id that is an $iref target crashes the
  // game's JsonDataReader with a NullReferenceException.  Advance the allocator
  // past the worst-case rebuilt jetway ids and past every flight-plan id first.
  if (strArrCache && strArrCache.alloc) {
    let jwMaxId = 0;
    for (const jwInfo of entryInfos) {
      if (jwInfo.isJetway && jwInfo.entryId + 38 > jwMaxId) jwMaxId = jwInfo.entryId + 38;
    }
    let fpMaxId = 0;
    if (fpIdByReg) {
      for (const fid of fpIdByReg.values()) { if (fid > fpMaxId) fpMaxId = fid; }
    }
    const strArrSeed = Math.max(jwMaxId, fpMaxId);
    if (strArrCache.alloc.v < strArrSeed + 1) strArrCache.alloc.v = strArrSeed + 1;
    if (strArrCache.canonicalId === null) strArrCache.canonicalId = strArrCache.alloc.v++;
  }

  // Claim the canonical empty AircraftEvent[] (recvEvents) and ECommand[]
  // (waitingCmds) $ids from the same shared dynamic allocator (see
  // segRecvEventsCache / segWaitingCmdsCache).  The strArr claim above already
  // seeded the allocator past every rebuilt-jetway and flight-plan id, so the
  // ids claimed here can never collide with a static entryId+offset $id.
  if (recvEventsCache && recvEventsCache.alloc && recvEventsCache.canonicalId === null) {
    recvEventsCache.canonicalId = recvEventsCache.alloc.v++;
  }
  if (waitingCmdsCache && waitingCmdsCache.alloc && waitingCmdsCache.canonicalId === null) {
    waitingCmdsCache.canonicalId = waitingCmdsCache.alloc.v++;
  }

  // ---- PASS 2: Rebuild each entry constructively ---------------------
  const segments = [];
  let resetCount = 0;
  const activeJetways = [];
  const exhaustedStands = new Set();
  const exhaustedFlights = new Set();

  // Snapshot time of this segment (seconds since midnight), or null when the
  // segment has no CurrentDateTime (header segment).  Departures whose
  // OffBlockTime has already passed at the snapshot are treated as departed —
  // empty jetway — matching the game's own entries.
  const segmentSnapshotSec = _extractSegmentSnapshotSec(segmentText);

  for (const info of entryInfos) {
    if (!info.isJetway) {
      segments.push(info.entryText);
      continue;
    }

    const jwNum = info.key.substring('jetway:'.length);
    const standId = String(parseInt(jwNum, 10));
    let depFlight = standFlights.get(standId);
    const flightReg = depFlight ? (depFlight._Registration || depFlight.Registration || '') : '';

    // ── Turnaround check ──
    // When the same stand hosts both an arrival and departure for the same
    // aircraft (matching registration), and the arrival lands before the
    // departure off-block, the aircraft hasn't arrived at the gate yet.
    // The jetway must be empty.
    //
    // Different aircraft at the same stand (different REGs) is normal —
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
              ' — arrival ' + arrLanding + ' < off-block ' + depOffBlock +
              ', skipping jetway population');
            depFlight = null;
          }
        }
      }
    }

    // Departure already off-blocked at this segment's snapshot time?
    // The game writes an empty jetway entry when the aircraft has already
    // departed (off-block <= snapshot); the rebuild must not dock it again.
    if (depFlight && segmentSnapshotSec != null && depFlight.OffBlockTime) {
      const ob = String(depFlight.OffBlockTime).split(':');
      if (ob.length >= 2) {
        const offSec = parseInt(ob[0], 10) * 3600 + (parseInt(ob[1], 10) || 0) * 60 + (parseInt(ob[2], 10) || 0);
        if (offSec <= segmentSnapshotSec) {
          log('Stand ' + standId + ': departure ' + (depFlight._Registration || depFlight.Registration || '') +
            ' — off-block ' + depFlight.OffBlockTime + ' <= snapshot, already departed, ' +
            'skipping jetway population');
          depFlight = null;
        }
      }
    }

    // Bilateral exhaustion: both stand AND flight must be fresh.
    // If either was already assigned to a previous jetway, skip → empty jetway.
    let built = null;
    if (depFlight && !exhaustedStands.has(standId) && !exhaustedFlights.has(flightReg)) {
      exhaustedStands.add(standId);
      exhaustedFlights.add(flightReg);

      // ---- Active jetway: rebuild DockingAircraft with flight data ----
      try {
        built = _buildActiveJetwayEntry(info, depFlight, approachCache, log, jwTypeMap, baseDateTicks, icao, recvEventsCache, waitingCmdsCache, fpIdByReg, standPositions, strArrCache);
      } catch (e) {
        // No spec data (no approach cache + empty original entry, or an
        // aircraft type missing from the specDB): write an empty jetway
        // rather than failing the whole save.
        log('Stand ' + standId + ': jetway rebuild failed (' + e.message + ') — writing empty jetway');
        built = null;
      }
    }

    if (built && built.text) {
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

  // Register old→new _receivedEvents AircraftEvent[] $id mappings
  // so the centralized $iref remap step can fix preserved entries
  if (recvEventsCache && recvEventsCache.canonicalId !== null && idMapper) {
    for (const oldId of oldRecvEventIds) {
      idMapper.map(oldId, recvEventsCache.canonicalId);
    }
  }
  if (waitingCmdsCache && waitingCmdsCache.canonicalId !== null && idMapper) {
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
 * entries — now that aircraft:REG entries are generated for new REGs,
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
 * @param {Map} segTypeMap - per-segment type-number→full-name map (from Step 7a-2)
 * @param {Function} log - logging function
 * @param {string} icao - airport ICAO code
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
 * objects (parsed via _parseEntry) � NO regex scanning of raw text.
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

// -- Object-tree walk helpers (reused by _reorderIrefEntries) ---------

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

// -- OdinEntry � lightweight wrapper around a parsed/serialized entry --

/**
 * Wraps a RuntimeEntities entry so that metadata ($id, $iref targets)
 * and text serialization are tied to the same object.  This removes the
 * need for ad-hoc { text, ids, irefs } plain-object descriptors and
 * lets the iref reorder algorithm work with clean property accessors.
 *
 * Two construction paths:
 *   1. From an already-structured JS object  � e.g. a newly-built
 *      aircraft or flight-plan entry.  Text is lazy-serialized.
 *   2. From raw Odin text � for preserved ("kept") entries that we
 *      parse once via parseOdinObject to extract metadata but whose
 *      original text we want to emit as-is.
 *
 * @param {object} obj    � Parsed JS object (with $id, __iref, etc.)
 * @param {string} [text] � Pre-serialized text; if omitted, lazy-built
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

// -- Iref-aware entry reordering --------------------------------------

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
 * @param {Set<number>} externalIds � $id values declared outside $rcontent
 * @returns {{text:string, ids:number[], irefs:number[]}[]} reordered descriptors
 */
function _reorderIrefEntries(descriptors, log, externalIds) {
  var result = [];
  var deferred = new Map(); // targetId ? [descriptors waiting for that $id]
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
          log('  resolve $id:' + id + ' � flushing ' + waiting.length + ' deferred at position ' + result.length);
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
    log('ERROR: _reorderIrefEntries � ' + deferred.size + ' id(s) still have ' +
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

function _rebuildFlightRuntimeEntities(segmentText, flights, baseDateTicks, validRegs, segTypeMap, log, idMapper, icao, approachCache, fullText, saveSec, activeJetways, precomputedFpIdByReg, strArrCache, recvEventsCache, waitingCmdsCache) {
  // ── Navigate to RuntimeEntities.$rcontent structurally ──────────
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

  // ── Resolve type numbers from segment's type map ────────────────
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

  // Build reg → flight lookup
  const regFlights = new Map();
  for (const fl of flights) {
    const reg = fl._Registration || fl.Registration || '';
    if (reg) regFlights.set(reg, fl);
  }

  // Build reg → aircraftId lookup from activeJetways for $iref linking.
  // When a DEP flight has an active jetway with a populated DockingAircraft,
  // the Aircraft at jetway.aircraftId serves as the canonical Aircraft for
  // that registration.  Both aircraft:REG and aircraft-animator:aircraft:REG
  // entries should $iref to it instead of duplicating the Aircraft inline.
  const regToJetwayAcId = new Map();
  if (activeJetways && Array.isArray(activeJetways)) {
    for (const jw of activeJetways) {
      if (jw.reg && jw.aircraftId != null) {
        regToJetwayAcId.set(jw.reg, jw.aircraftId);
      }
    }
  }

  // ── PASS 1: Parse entries, remove all flight-plan:REG, aircraft:REG, ──
  //            and aircraft-animator:aircraft:REG. Keep everything else,
  //            partitioned by $k prefix for controlled final ordering.
  // Order: jetway → radio-channel → flight-plan → singleton →
  //        aircraft+animator pairs → other
  const keptJw = [];         // jetway:*
  const keptRadio = [];      // radio-channel*
  const keptSingleton = [];  // singleton:*
  const keptOther = [];      // anything else
  const removedKeys = [];    // flight-plan keys removed (for counting)
  const oldIdMap = new Map(); // reg ? old $id (for $iref remapping)
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
    let key = '';
    if (kSec) {
      const kStrEnd = entryT.skipString(kSec.valueStart);
      if (kStrEnd) {
        key = entryText.substring(kSec.valueStart + 1, kStrEnd - 1);
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
      // as raw text to avoid lossy roundtrip through preprocessor?serializer.
      // The preprocessor handles common Odin tokens but kept entries can
      // contain deeply-nested ReactiveProperty<Aircraft> structures where
      // _fixTypedValues doesn't recursively handle all edge cases.
      // Partition by $k prefix for controlled final ordering.
      var entryObj = { text: entryText, key: key };
      if (key.startsWith('jetway:'))            keptJw.push(entryObj);
      else if (key.startsWith('radio-channel')) keptRadio.push(entryObj);
      else if (key.startsWith('singleton:'))    keptSingleton.push(entryObj);
      else                                      keptOther.push(entryObj);
    }
    pos = entryEnd;
  }

  // ── Scan kept entries for max existing $id ──────────────────────
  const allKeptText = [].concat(keptJw, keptRadio, keptSingleton, keptOther)
      .map(function(e) { return e.text; }).join(',\n');
  let maxId = 0;
  const idRe = /"\$id":\s*(\d+)/g;
  let idMatch;
  while ((idMatch = idRe.exec(allKeptText)) !== null) {
    const val = parseInt(idMatch[1], 10);
    if (val > maxId) maxId = val;
  }
  let nextId = maxId + 1;

  // ── Detect turnaround conflicts ──────────────────────────────────
  // A REG used for both ARR+DEP needs only ONE aircraft entry.
  // If ARR lands before DEP off-blocks → ARR creates the aircraft (in air).
  // If DEP off-blocks before ARR lands → DEP creates it (at stand).
  const turnaroundWinner = new Map(); // reg → 'arr'|'dep'
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

  // --- PASS 2: Build new flight-plan:REG entries --------------------------------
  const allFpEntries = [];
  // Use pre-computed fpIdByReg from caller if available, otherwise build locally
  const fpIdByReg = precomputedFpIdByReg || new Map(); // reg ? fpId (for PASS 3 $iref linking)
  const usePrecomputedIds = !!precomputedFpIdByReg;
  // When using precomputed IDs, advance nextId past the highest flight-plan $id
  // so PASS 3 aircraft entry IDs don't collide with flight-plan entry IDs.
  if (usePrecomputedIds) {
    for (const fid of fpIdByReg.values()) {
      if (fid >= nextId) nextId = fid + 1;
    }
  }

  for (const [reg, fl] of regFlights) {
    if (!validRegs.has(reg)) continue;
    const isDep = fl.isDeparture === true;

    const arrRunway = isDep ? null : (fl.Runway || null);
    const arrStand = isDep ? null : (fl.Stand || null);
    const arrTicksStr = isDep ? '0' : String(_computeArrivalInBlockTicks(fl.LandingTime, fl.InBlockTime, baseDateTicks, icao));
    const depRunway = isDep ? (fl.Runway || null) : null;
    const depStand = isDep ? (fl.Stand || null) : null;
    const depTicksStr = isDep ? String(_computeTakeoffTicks(fl.TakeoffTime, fl.OffBlockTime, baseDateTicks, icao)) : '0';

    // Use pre-computed fpId if available, otherwise assign sequentially and
    // register the local assignment so PASS 3 can still find it via fpIdByReg.
    const fpId = usePrecomputedIds ? fpIdByReg.get(reg) : nextId++;
    if (!usePrecomputedIds) fpIdByReg.set(reg, fpId);
    if (idMapper && oldIdMap.has(reg)) {
      idMapper.map(oldIdMap.get(reg), fpId);
    }

    allFpEntries.push({
      $k: 'flight-plan:' + reg,
      // When a jetway already hosts the Aircraft with an inline _flightPlan
      // (defined at an earlier position in $rcontent), make this entry thin
      // so it $iref's back to the canonical flight-plan in the jetway.
      // Otherwise, keep the full inline object as the canonical source.
      $v: regToJetwayAcId.has(reg)
        ? { __iref: fpId }
        : {
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

  // ── Claim the canonical empty string[] $id from the shared dynamic
  //    allocator (see segStrArrCanonicalIds).  The jetway rebuild (7b-1)
  //    claims it first when jetway entries exist; otherwise we claim it here
  //    before any aircraft entry is built, so the first emitted coordinator
  //    can define it inline and all later entries $iref it.  The id comes
  //    from the dynamic allocator — seeded past every static $id (kept
  //    entries incl. rebuilt jetways) and every flight-plan id — so it can
  //    never collide with another $id in this blobdoc.  A duplicate $id that
  //    is an $iref target crashes the game's JsonDataReader
  //    (NullReferenceException on the old entryId+33 layout: jetway:01
  //    id(33)=36 collided with jetway:02 id(25)=36).  Also advance nextId
  //    past the claimed id so aircraft/animator ranges never reach it.
  if (strArrCache && strArrCache.alloc) {
    let strArrSeedMax = maxId; // kept entries (incl. rebuilt jetway text)
    if (fpIdByReg) {
      for (const fid of fpIdByReg.values()) { if (fid > strArrSeedMax) strArrSeedMax = fid; }
    }
    if (strArrCache.alloc.v < strArrSeedMax + 1) strArrCache.alloc.v = strArrSeedMax + 1;
    if (strArrCache.canonicalId === null) strArrCache.canonicalId = strArrCache.alloc.v++;
    if (nextId < strArrCache.alloc.v) nextId = strArrCache.alloc.v;
  }
  // Claim the canonical empty AircraftEvent[] (recvEvents) and ECommand[]
  // (waitingCmds) $ids from the same shared dynamic allocator (see
  // segRecvEventsCache / segWaitingCmdsCache).  The strArr claim above already
  // seeded the allocator past every static $id and flight-plan id, so these
  // ids can never collide.  Advance nextId past each claim so aircraft/animator
  // ranges never reach them.
  if (recvEventsCache && recvEventsCache.alloc) {
    if (recvEventsCache.canonicalId === null) recvEventsCache.canonicalId = recvEventsCache.alloc.v++;
    if (nextId < recvEventsCache.alloc.v) nextId = recvEventsCache.alloc.v;
  }
  if (waitingCmdsCache && waitingCmdsCache.alloc) {
    if (waitingCmdsCache.canonicalId === null) waitingCmdsCache.canonicalId = waitingCmdsCache.alloc.v++;
    if (nextId < waitingCmdsCache.alloc.v) nextId = waitingCmdsCache.alloc.v;
  }

  // --- Resolve radio-channel Type from StaticItems ----------------------
  // The game's aircraft entries $iref to a shared radio-channel entry.
  // keptRadio entries are keyed like "radio-channel:118.55" but the Type
  // (2=GND, 3=TWR, 5=APP) lives in StaticItems.  Parse StaticItems to
  // build a key→Type map, then match keptRadio by key to find the correct
  // $id for tower (Type 3) and approach (Type 5).
  const radioChannelTypeMap = new Map();
  if (fullText) {
    const siT = createTokenizer(fullText);
    const siSdSec = siT.findSection('StaticData');
    if (siSdSec) {
      const siSdText = siT.substring(siSdSec.valueStart, siSdSec.valueEnd);
      const siSdT = createTokenizer(siSdText);
      const siBdSec = siSdT.findSection('$blobdoc');
      if (siBdSec) {
        const siBdText = siSdT.substring(siBdSec.valueStart, siBdSec.valueEnd);
        const siBdT = createTokenizer(siBdText);
        const siSiSec = siBdT.findSection('StaticItems');
        if (siSiSec) {
          const siSiText = siBdT.substring(siSiSec.valueStart, siSiSec.valueEnd);
          const siSiT = createTokenizer(siSiText);
          const siRcSec = siSiT.findSection('$rcontent');
          if (siRcSec) {
            const siRcStart = siRcSec.valueStart;
            if (siSiText[siRcStart] === '[') {
              const siRcEnd = siSiT.findArrayEnd(siRcStart);
              if (siRcEnd !== null) {
                const siArr = siSiText.substring(siRcStart, siRcEnd);
                const kRe = /"\$k"\s*:\s*"([^"]+)"/g;
                let km;
                while ((km = kRe.exec(siArr)) !== null) {
                  const rck = km[1];
                  if (!rck.startsWith('radio-channel:')) continue;
                  // Find $v block and extract Type
                  const vIdx = siArr.indexOf('"$v"', km.index);
                  if (vIdx < 0) continue;
                  const colonIdx = siArr.indexOf(':', vIdx);
                  if (colonIdx < 0) continue;
                  let vStart = colonIdx + 1;
                  while (vStart < siArr.length && ' \t\n\r'.includes(siArr[vStart])) vStart++;
                  if (vStart >= siArr.length || siArr[vStart] !== '{') continue;
                  const siArrT = createTokenizer(siArr);
                  const vEnd = siArrT.findObjectEnd(vStart);
                  if (vEnd === null) continue;
                  const vBlock = siArr.substring(vStart, vEnd);
                  const vT = createTokenizer(vBlock);
                  const typeSec = vT.findSection('Type');
                  if (typeSec) {
                    const typeVal = parseInt(vBlock.substring(typeSec.valueStart, typeSec.valueEnd), 10);
                    if (!isNaN(typeVal)) radioChannelTypeMap.set(rck, typeVal);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // --- Match keptRadio entries by key against StaticItems type map ------
  let towerChannelId = null;   // Type 3
  let apprChannelId = null;    // Type 5
  for (var _rci = 0; _rci < keptRadio.length; _rci++) {
    var _rct = keptRadio[_rci].text;
    var _rck = keptRadio[_rci].key;
    const idMatch = _rct.match(/"\$id"\s*:\s*(\d+)/);
    if (!idMatch) continue;
    const rcId = parseInt(idMatch[1], 10);
    const rcType = radioChannelTypeMap.get(_rck);
    if (rcType === 3) towerChannelId = rcId;
    if (rcType === 5) apprChannelId = rcId;
  }

  // --- PASS 3 & 4 combined: Build aircraft:REG + aircraft-animator:aircraft:REG ---
  // Each iteration produces a pair [aircraftEntry, animatorEntry] so they stay
  // adjacent in final output.  The acPairs flat array of descriptors is built
  // later; here we just collect the structured objects.
  const acPairs = [];  // [[aircraftObj, animatorObj], ...]
  const acRegToInfo = new Map(); // reg ? { aircraftRefId } (for animator linking)

  // Resolve animator type number from segTypeMap (needed per-pair)
  let animTypeFull = '51|ContextCross.Models.AircraftAnimator, GroundATC.Core';
  if (segTypeMap) {
    for (const [num, name] of segTypeMap) {
      if (name.startsWith('ContextCross.Models.AircraftAnimator,'))
        animTypeFull = num + '|' + name;
    }
  }

  for (const [reg, fl] of regFlights) {
    if (!validRegs.has(reg)) continue;
    const isDep = fl.isDeparture === true;

    // Turnaround check: skip if this flight type lost the turnaround race
    const winner = turnaroundWinner.get(reg);
    if (winner && winner !== (isDep ? 'dep' : 'arr')) continue;

    // ── Check for active jetway → create $iref entry ─────────────────
    // If this DEP flight has an active (populated) jetway, its Aircraft
    // already lives inside the jetway's DockingAircraft at a known $id.
    // Create an $iref pointer instead of duplicating the Aircraft inline.
    const jetwayAcId = isDep ? regToJetwayAcId.get(reg) : null;
    if (jetwayAcId != null) {
      const acRefEntry = {
        $k: 'aircraft:' + reg,
        $v: { __iref: jetwayAcId },
      };
      acRegToInfo.set(reg, { aircraftRefId: jetwayAcId });
      // Register old→new $id mapping for centralized $iref remap step
      if (idMapper && oldIdMap.has(reg)) {
        idMapper.map(oldIdMap.get(reg), jetwayAcId);
      }
      log('  [ac-iref] ' + reg + ': $iref:' + jetwayAcId + ' (jetway Aircraft)');
      // Build animator paired with this $iref aircraft entry
      const animId = nextId++;
      const animEntry = {
        $k: 'aircraft-animator:aircraft:' + reg,
        $v: {
          $id: animId,
          $type: animTypeFull,
          Aircraft: { __iref: jetwayAcId },
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
      };
      acPairs.push([acRefEntry, animEntry]);
      continue; // skip standalone build
    }

    // Build inline Aircraft entry (ARR in-air on approach, DEP parked at stand)
    const acEntryId = nextId;
    log('  [ac-call] ' + reg + ': building Aircraft entry � star=' + JSON.stringify(fl.Airway) +
      ' runway=' + JSON.stringify(fl.Runway) + ' saveSec=' + saveSec +
      ' LandingTime=' + JSON.stringify(fl.LandingTime) +
      ' hasApproachCache=' + !!approachCache + ' hasFullText=' + !!fullText);
    const result = _buildStandaloneAircraftEntry({
      reg, flight: fl, entryId: acEntryId,
      towerChannelId,
      apprChannelId,
      isDeparture: isDep,
      approachCache, fullText, saveSec, icao, baseDateTicks,
      segTypeMap,
      log,
      fpId: fpIdByReg.get(reg),
      strArrCache,
      recvEventsCache,
      waitingCmdsCache,
    });
    if (!result) {
      log('  [ac-call] ' + reg + ': skipped (not on approach or already landed)');
      continue;
    }
    nextId = result.nextId;
    acRegToInfo.set(reg, { aircraftRefId: acEntryId });
    // Register aircraft id for $iref mapping if needed
    if (idMapper && oldIdMap.has(reg)) {
      idMapper.map(oldIdMap.get(reg), acEntryId);
    }

    // Build paired animator entry referencing this aircraft via $iref
    // Gear is down (1) for parked (state 10) and final approach (state 5);
    // gear is up (0) only during STAR approach (state 30, before IAF).
    const gearRatio = result.aircraftState === 30 ? 0 : 1;
    const animId2 = nextId++;
    const animEntry2 = {
      $k: 'aircraft-animator:aircraft:' + reg,
      $v: {
        $id: animId2,
        $type: animTypeFull,
        Aircraft: { __iref: acEntryId },
        Version: 3,
        HasSnapshot: true,
        FlapRatio: 0,
        SlatRatio: 0,
        GearRatio: gearRatio,
        IsGearMoving: false,
        GearTargetRatio: gearRatio,
        GoAroundPhase: 0,
        HasGoAroundCommandTick: false,
        GoAroundCommandTick: 0,
        GearRetractIssued: false,
        TakeoffPitchActive: false,
        TakeoffPitchElapsed: 0,
        TakeoffPitchDeg: 0,
      },
    };
    acPairs.push([result.entry, animEntry2]);
  }

  const removedCount = removedKeys.length;
  const addedCount = allFpEntries.length + acPairs.length * 2; // each pair = 2 entries

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

  // ── Reconstruct RuntimeEntities.$rcontent ──────────────────────
  // Assemble entries in a deterministic order that satisfies all
  // $iref dependencies in input order, so _reorderIrefEntries is a
  // pass-through with zero deferrals:
  //   jetway → radio-channel → flight-plan → singleton →
  //   aircraft+animator pairs → other
  //
  // This order is safe because the only $iref dependency chain is
  // radio-channel → aircraft → aircraft-animator.  Jetway entries have
  // _radioChannel: null (no outbound $iref), flight-plan entries use
  // only $fstrref (string references), and singletons are self-contained.

  // Helper to build OdinEntry descriptors from kept entry objects.
  // Kept entries preserve original text to avoid lossy roundtrip.
  function _buildKeptDescs(entries) {
    return entries.map(function(e) {
      try {
        var result = parseOdinObject(e.text, 0);
        if (result.error) throw new Error(result.error);
        return new OdinEntry(result.value, e.text);
      } catch (err) {
        log('WARN: could not parse kept entry for iref reorder: ' + err.message);
        return new OdinEntry({}, e.text);
      }
    });
  }

  // Build descriptors for new flight-plan entries
  var fpDescs = allFpEntries.map(function(obj) { return new OdinEntry(obj); });

  // Build descriptors for aircraft+animator pairs (flattened)
  var acPairDescs = [];
  for (var pi = 0; pi < acPairs.length; pi++) {
    var pair = acPairs[pi];
    acPairDescs.push(new OdinEntry(pair[0])); // aircraft:REG
    acPairDescs.push(new OdinEntry(pair[1])); // aircraft-animator:aircraft:REG
  }

  // Assemble in desired order: jetway → radio-channel → flight-plan →
  //   singleton → aircraft+animator pairs → other
  var orderedInput = [].concat(
    _buildKeptDescs(keptJw),
    _buildKeptDescs(keptRadio),
    fpDescs,
    _buildKeptDescs(keptSingleton),
    acPairDescs,
    _buildKeptDescs(keptOther)
  );

  var ordered = _reorderIrefEntries(orderedInput, log, externalIds);
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

  log('Rebuilt ' + allFpEntries.length + ' flight-plan + ' + acPairs.length + ' aircraft+animator pairs RuntimeEntities entry(s) (removed ' + removedCount + ' stale)');
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
 * @param {Map} opts.segTypeMap - per-segment type map
 * @param {Function} opts.log
 * @returns {{ entry: object, nextId: number }}
 */
function _buildStandaloneAircraftEntry(opts) {
  const { reg, flight, entryId, towerChannelId, apprChannelId, isDeparture, approachCache, fullText, saveSec,
    icao, baseDateTicks, segTypeMap, log, fpId, strArrCache, recvEventsCache, waitingCmdsCache } = opts;

  const id = (offset) => entryId + offset;

  const runway = flight.Runway || '';
  const stand = flight.Stand || '';
  const star = flight.Airway || '';
  const acType = flight.AircraftType || '';

  // Resolve type names to explicit "N|TypeName" form using the segment's own
  // type map.  Each GATCARC4 segment (header payload, checkpoint frame, each
  // $blobdoc) is an independent Odin binary document with its own numbering.
  // Using the segment's numbers guarantees consistency with full-form type refs
  // already expanded in kept entries by _expandShortFormTypes (step 7a-2).
  //
  // Types not present in segTypeMap get a fresh number above maxSegNum � this
  // prevents auto-assignment from reclaiming IDs still referenced by kept entries.
  var typeNumByName = new Map();
  var maxSegNum = 0;
  if (segTypeMap) {
    for (const [_sn, _sname] of segTypeMap) {
      typeNumByName.set(_sname, _sn);
      if (_sn > maxSegNum) maxSegNum = _sn;
    }
  }
  var _freshNum = maxSegNum + 1;
  var _resolveType = function (plainName) {
    if (typeNumByName.has(plainName)) {
      return typeNumByName.get(plainName) + '|' + plainName;
    }
    return (_freshNum++) + '|' + plainName;
  };

  // Fully-qualified type strings with explicit segment-consistent numbers.
  // FlyApproachDynamicsParams is used for State=30 (DynamicsState=1).
  // ApproachDynamicsParams is used for State=5 (DynamicsState=2).
  var FLY_DYN_PARAMS_TYPE = _resolveType('ContextCross.Dynamics.States.FlyApproachDynamicsParams, GroundATC.Core');
  var APPROACH_DYN_PARAMS_TYPE = _resolveType('ContextCross.Dynamics.States.ApproachDynamicsParams, GroundATC.Core');
  var LIST_VEC3_TYPE = _resolveType('System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib');

  var T = {
    ac:      _resolveType('ContextCross.Aircrafts.Aircraft, GroundATC.Core'),
    spec:    _resolveType('ContextCross.Models.AircraftSpecification, GroundATC.Core'),
    float3:  _resolveType('Unity.Mathematics.float3, Unity.Mathematics'),
    vec4Arr: _resolveType('UnityEngine.Vector4[], UnityEngine.CoreModule'),
    vec4:    _resolveType('UnityEngine.Vector4, UnityEngine.CoreModule'),
    dyn:     _resolveType('ContextCross.Dynamics.AircraftDynamicsData, GroundATC.Core'),
    dynSt:   _resolveType('R3.ReactiveProperty`1[[ContextCross.Dynamics.Enums.State, GroundATC.Core]], R3'),
    coord:   _resolveType('ContextCross.Aircrafts.AircraftRunwayCoordinator, GroundATC.Core'),
    rpStrArr:_resolveType('R3.ReactiveProperty`1[[System.String[], mscorlib]], R3'),
    strArr:  _resolveType('System.String[], mscorlib'),
    vec3:    _resolveType('UnityEngine.Vector3, UnityEngine.CoreModule'),
    fp:      _resolveType('ContextCross.Models.FlightPlan, GroundATC.Core'),
    dt:      _resolveType('System.DateTime, mscorlib'),
    rpState: _resolveType('R3.ReactiveProperty`1[[ContextCross.Aircrafts.Enums.EAircraftState, GroundATC.Core]], R3'),
    rpDir:   _resolveType('R3.ReactiveProperty`1[[ContextCross.Aircrafts.Enums.EFlightDirection, GroundATC.Core]], R3'),
    rpChan:  _resolveType('R3.ReactiveProperty`1[[ContextCross.Models.RadioChannel, GroundATC.Core]], R3'),
    rpPath:  _resolveType('R3.ReactiveProperty`1[[ContextCross.Models.Path, GroundATC.Core]], R3'),
    rpStr:   _resolveType('R3.ReactiveProperty`1[[System.String, mscorlib]], R3'),
    rpCmdArr:_resolveType('R3.ReactiveProperty`1[[ContextCross.Enums.ECommand[], GroundATC.Core]], R3'),
    cmdArr:  _resolveType('ContextCross.Enums.ECommand[], GroundATC.Core'),
    rpEvtArr:_resolveType('R3.ReactiveProperty`1[[ContextCross.Events.AircraftEvent[], GroundATC.Core]], R3'),
    evtArr:  _resolveType('ContextCross.Events.AircraftEvent[], GroundATC.Core'),
    rpVec3:  _resolveType('R3.ReactiveProperty`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], R3'),
  };

  // --- Resolve aircraft spec from approachCache ----------------------
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
  var dockPoses = spec?.DockingPositions;
  if (!dockPoses || !dockPoses.length) {
    console.log('[FP Standalone] MISSING DockingPositions for spec=' + (spec?.Designator || '?') + ' spec=' + JSON.stringify(spec));
    throw new Error(
      '[APPROACH] Missing DockingPositions for aircraft type "' + (acType || 'unknown') +
      '" — type not found in approach cache specDB.'
    );
  }

  // --- Determine position & direction -----------------------------
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
      // Direction: normalize(NosePosition - TailPosition) = tail→nose unit vector.
      // Compute directly from nose/tail — the cached heading uses a different
      // convention (atan2(-dz, dx)) that does not match the game engine.
      var sdx = standPos.noseX - standPos.tailX;
      var sdz = standPos.noseZ - standPos.tailZ;
      var slen = Math.sqrt(sdx * sdx + sdz * sdz);
      if (slen > 0.0001) {
        dirX = sdx / slen;
        dirZ = sdz / slen;
      } else {
        dirX = 0; dirZ = 1;
      }
      // Position: offset from nose by WheelBase backward along direction.
      // Game engine formula: position = NosePosition - WheelBase * direction.
      var wb = spec?.WheelBase ?? 0;
      posX = standPos.noseX - wb * dirX;
      posY = 0;
      posZ = standPos.noseZ - wb * dirZ;
    } else {
      log('  [ac-pos] ' + reg + ': SKIP � stand position not found' +
        ' stand=' + JSON.stringify(stand) +
        ' flight.Stand=' + JSON.stringify(flight.Stand));
      return null;
    }
  } else {
    aircraftState = 30;
    flightDirection = 1;
    dynState = 1;

    log('  [ac-pos] ' + reg + ': ARR pos start � star=' + JSON.stringify(star) +
      ' runway=' + JSON.stringify(runway) + ' saveSec=' + saveSec +
      ' LandingTime=' + JSON.stringify(flight.LandingTime) +
      ' hasApproachCache=' + !!approachCache + ' hasFullText=' + !!fullText);
    if (!star) log('  [ac-pos] ' + reg + ': FAIL � star null/empty');
    if (!runway) log('  [ac-pos] ' + reg + ': FAIL � runway null/empty');
    if (!approachCache) log('  [ac-pos] ' + reg + ': FAIL � approachCache null/undefined');
    if (!fullText) log('  [ac-pos] ' + reg + ': FAIL � fullText null/empty');
    if (saveSec == null) log('  [ac-pos] ' + reg + ': FAIL � saveSec null/undefined');

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

            // FIX: use approach procedure TouchDownPosition (from state5ParamsMap) instead of
            // runwayThresholds.  _parseRunwayThresholds returns {thresholds:[pos1,pos2]} — an
            // array of runway threshold positions — NOT the approach procedure's touchdown
            // point.  Passing this to computePosition causes buildFullPath's _vec3Dist to
            // return NaN (undefined.x - undefined), so the touchdown segment is never appended
            // to the path, and the glideslope Y is computed from a wrong remaining distance.
            var tdPos = null;
            var s5ForTdPos = approachCache.state5ParamsMap
              ? approachCache.state5ParamsMap.get(appKey) : null;
            if (!s5ForTdPos) {
              s5ForTdPos = approachCache.state5ParamsMap
                ? approachCache.state5ParamsMap.get(runway) : null;
            }
            if (s5ForTdPos && s5ForTdPos.touchDownPosition) {
              tdPos = s5ForTdPos.touchDownPosition;
            } else {
              // Fallback to runway thresholds (only correct for runways with no procedure data)
              tdPos = approachCache.runwayThresholds
                ? approachCache.runwayThresholds[runway] : null;
            }

            var airportScale = approachCache.airportScale || 100;
            var approachCap = computeApproachCap(airportScale);

            if (flyPoints && flyPoints.length > 0) {
              var flyLen = computePathLength(flyPoints);
              var appLen = computePathLength(appPoints);
              var combined = flyPoints.concat(appPoints);
              var totalLen = computePathLength(combined);
              // Include touchdown distance so totalLen matches TAT denominator
              // (scenery-derived TAT includes tdDist from computeFullTerminalPath).
              var tdDistLen = 0;
              if (tdPos && tdPos.x != null && appPoints.length > 0) {
                var lastApp = appPoints[appPoints.length - 1];
                tdDistLen = Math.sqrt(
                  (lastApp.x - tdPos.x) ** 2 + (lastApp.z - tdPos.z) ** 2
                );
                totalLen += tdDistLen;
              }
              var rawTargetDist = (1.0 - timeToLanding / totalApproachTime) * totalLen;
              if (rawTargetDist >= flyLen) { aircraftState = 5; dynState = 2; }

              var posResult = computePosition(flyPoints, appPoints, progressRatio, tdPos, approachCap);
              var dirResult = computeDirection(flyPoints, appPoints, progressRatio, tdPos);
              posX = posResult.x; posY = posResult.y; posZ = posResult.z;
              dirX = dirResult.x; dirZ = dirResult.z;
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
      log('  [ac-pos] ' + reg + ': SKIP � position not computed' +
        ' (timeToLanding=' + timeToLanding +
        ' progressRatio=' + (progressRatio != null ? progressRatio.toFixed(4) : 'null') +
        ' flyPoints=' + (flyPoints ? flyPoints.length : 'null') + ')');
      return null;
    }
  }

  // --- Resolve radio channel based on aircraft state -------------------
  // State=5 (past IAF) → Tower (Type 3); State=30 (before IAF) → Approach (Type 5)
  var channelId = null;
  if (aircraftState === 5)  channelId = towerChannelId;
  if (aircraftState === 30) channelId = apprChannelId;
  // State=10 (DEP parked) stays null

  // --- State=5 approach procedure params -----------------------------
  // State=5 aircraft need PathPointList + TouchDownPosition + ApproachDirection +
  // InitialPosition instead of FlyApproachPathPointList/AppPointList.
  var state5Params = null;
  if (aircraftState === 5) {
    state5Params = approachCache.state5ParamsMap
      ? approachCache.state5ParamsMap.get(appKey) : null;
    if (!state5Params) {
      state5Params = approachCache.state5ParamsMap
        ? approachCache.state5ParamsMap.get(runway) : null;
    }
    if (!state5Params) {
      // No cached State=5 params for this runway. The approach cache must
      // always be populated when the runway has a valid approach procedure.
      throw new Error(
        '[flight_plans get-aircraft-positions] No State=5 params for runway "' +
        runway + '" (appKey="' + appKey +
        '"). state5ParamsMap must be populated at cache-build time.'
      );
    }
  }

  // State=5 aircraft use the approach procedure name (e.g., "RNAV ILS Z Rwy 19")
  // instead of the STAR name (e.g., "UBSS6W") for the _route field.
  var routeValue = star;
  if (aircraftState === 5 && state5Params && state5Params.routeName) {
    routeValue = state5Params.routeName;
  }

  // --- Build structured Aircraft object ------------------------------

  // DockingPositions: Vector4[]
  console.log(
    '[FP Standalone] DockingPositions spec=' + (spec?.Designator || '?') +
    ' dockPosesLen=' + (dockPoses ? dockPoses.length : 0) +
    ' T.vec4=' + T.vec4 +
    ' dockPoses=' + JSON.stringify(dockPoses)
  );
  var dockContent = dockPoses.map(function(p) {
    return { $type: T.vec4, __v: [p.x, p.y, p.z, p.w] };
  });

  // ReactiveProperty<string[]> helper.  The inner string[] (always empty in
  // generated entries) is shared across ALL aircraft via a single canonical
  // definition: the first entry that emits one defines it inline and records
  // its $id; every later entry $iref's back to it instead of duplicating
  // { $id, $type, $rlength: 0, $rcontent: [] } (see segStrArrCanonicalIds).
  // The canonical $id was claimed from the segment's dynamic allocator before
  // the aircraft loop (so it never collides with static entryId+offset ids or
  // with other entries' ranges); the first emitter writes the full definition
  // at that id.
  function rpStrArr(idVal, innerId) {
    var content;
    if (strArrCache && strArrCache.canonicalEmitted) {
      content = { __iref: strArrCache.canonicalId };
    } else {
      var canonicalInnerId = innerId;
      if (strArrCache) {
        canonicalInnerId = strArrCache.canonicalId !== null ? strArrCache.canonicalId : innerId;
        strArrCache.canonicalEmitted = true;
      }
      content = { $id: canonicalInnerId, $type: T.strArr, $rcontent: [] };
    }
    return { $id: idVal, $type: T.rpStrArr, __v: [content] };
  }

  // ReactiveProperty<ECommand[]>/ReactiveProperty<AircraftEvent[]> helper for
  // _waitingForCommands and _receivedEvents.  The empty-array definition is
  // shared across ALL entries via one canonical $id per segment (same pattern
  // as rpStrArr — see segRecvEventsCache / segWaitingCmdsCache).  NON-empty
  // content (State=5 _waitingForCommands = [CMD_CONTACT_TOWER]) is never
  // shared: it stays inline at its own id and does not claim/emit the
  // canonical definition, so a later empty entry still defines the shared
  // array.
  function rpSharedArr(idVal, rpTypeName, innerId, innerTypeName, cache, content) {
    var hasContent = content && content.length > 0;
    var inner;
    if (!hasContent && cache && cache.canonicalEmitted) {
      inner = { __iref: cache.canonicalId };
    } else if (!hasContent && cache) {
      var canonicalInnerId = cache.canonicalId !== null ? cache.canonicalId : innerId;
      cache.canonicalEmitted = true;
      inner = { $id: canonicalInnerId, $type: innerTypeName, $rcontent: content };
    } else {
      inner = { $id: innerId, $type: innerTypeName, $rcontent: content };
    }
    return { $id: idVal, $type: rpTypeName, __v: [inner] };
  }

  // DynamicsParams: structure depends on aircraft state.
  // State=30 (STAR approach, DynamicsState=1): FlyApproachDynamicsParams + FlyApproachPathPointList + AppPointList
  // State=5  (final approach, DynamicsState=2): ApproachDynamicsParams + PathPointList + TouchDownPosition + ...
  var dynParams = null;
  if (aircraftState === 30 && flyPoints && flyPoints.length > 0 && progressRatio != null) {
    function toVec3Arr(pts) {
      return pts.map(function(p) { return { $type: T.vec3, __v: [p.x, 0, p.z] }; });
    }
    dynParams = {
      $id: id(30),
      $type: FLY_DYN_PARAMS_TYPE,
      ProgressRatio: progressRatio,
      FlyApproachPathPointList: { $id: id(31), $type: LIST_VEC3_TYPE, $rcontent: toVec3Arr(flyPoints) },
      AppPointList: appPoints && appPoints.length > 0
        ? { $id: id(32), $type: LIST_VEC3_TYPE, $rcontent: toVec3Arr(appPoints) }
        : { $rcontent: [] },
    };
  } else if (aircraftState === 5 && state5Params && progressRatio != null) {
    var ppList = state5Params.pathPointList || [];
    // InitialPosition Y: hardcoded 15.24 (= 5000ft approach ceiling at 100m/unit scale).
    // The stored path points have Y=0 (game engine computes altitude internally from
    // touchDownPosition + path distance), but InitialPosition stores the approach ceiling
    // altitude directly. Every original game file uses 15.24 regardless of airport.
    dynParams = {
      $id: id(30),
      $type: APPROACH_DYN_PARAMS_TYPE,
      ProgressRatio: progressRatio,
      TouchDownPosition: { $type: T.vec3, __v: [state5Params.touchDownPosition.x, state5Params.touchDownPosition.y || 0, state5Params.touchDownPosition.z] },
      ApproachDirection: { $type: T.vec3, __v: [state5Params.approachDirection.x, state5Params.approachDirection.y || 0, state5Params.approachDirection.z] },
      CommandedGoAround: false,
      InitialPosition: { $type: T.vec3, __v: [state5Params.initialPosition.x, 15.24, state5Params.initialPosition.z] },
      PathPointList: ppList.length > 0
        ? { $id: id(31), $type: LIST_VEC3_TYPE, $rcontent: ppList.map(function(p) { return { $type: T.vec3, __v: [p.x, 0, p.z] }; }) }
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
        TaxiSpeed: isDeparture ? 0 : TAXI_SPEED,
        ForwardSpeed: true,
        TargetTaxiSpeed: isDeparture ? 0 : TAXI_SPEED,
        PositiveTaxiAcceleration: isDeparture ? 0 : POSITIVE_TAXI_ACCEL,
        NegativeTaxiAcceleration: isDeparture ? 0 : NEGATIVE_TAXI_ACCEL,
        DynamicsTargetTaxiSpeed: 0,
        // Final approach (dynState=2, aircraftState=5) uses the boosted dynamics
        // accel override; everything else matches the static values (1/-2).
        DynamicsPositiveTaxiAcceleration: dynState === 2 ? DYNAMICS_POSITIVE_TAXI_ACCEL : (isDeparture ? 0 : POSITIVE_TAXI_ACCEL),
        DynamicsNegativeTaxiAcceleration: dynState === 2 ? DYNAMICS_NEGATIVE_TAXI_ACCEL : (isDeparture ? 0 : NEGATIVE_TAXI_ACCEL),
        PushbackStopRequested: false,
        TaxiArrivalToSpotPath: null,
        TaxiArrivalToHoldingPointPath: null,
        FrontWheelSteeringAngle: 0,
        DynamicsParams: isDeparture ? null : dynParams,
      },
      AircraftRunwayCoordinator: {
        $id: id(8),
        $type: T.coord,
        TaxiPathUnPassedIntersectionRunwayNames: rpStrArr(id(9), id(33)),
        TaxiBlockingRunwayNames: rpStrArr(id(11), id(34)),
        RunwayFenceCurrentEnterRunways: rpStrArr(id(12), id(35)),
        RunwayGuardCurrentEnterRunway: rpStrArr(id(13), id(36)),
        CrossRunwayPermissions: rpStrArr(id(14), id(37)),
        HoldShortAcknowledgedRunwayNames: rpStrArr(id(15), id(38)),
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
        __v: channelId != null ? [{ __iref: channelId }] : [null],
      },
      _jurisdictionRadioChannel: {
        $id: id(20),
        $type: T.rpChan,
        __v: channelId != null ? [{ __iref: channelId }] : [null],
      },
      _taxiPath: { $id: id(21), $type: T.rpPath, __v: [null] },
      _rollingPresetTaxiPath: { $id: id(22), $type: T.rpPath, __v: [null] },
      _selectedRunwayEntryRunway: null,
      _route: { $id: id(23), $type: T.rpStr, __v: [routeValue] },
      _waitingForCommands: rpSharedArr(id(24), T.rpCmdArr, id(25), T.cmdArr, waitingCmdsCache, aircraftState === 5 ? [CMD_CONTACT_TOWER] : []),
      _receivedEvents: rpSharedArr(id(26), T.rpEvtArr, id(27), T.evtArr, recvEventsCache, []),
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

  return { entry: entry, nextId: id(39), aircraftState: aircraftState };
}

/**
 * Build a complete active jetway entry from scratch using a hardcoded template.
 * Constructs a full DockingAircraft with Aircraft object for the departure flight.
 * Mirrors the empty-case pattern (hardcoded template with string substitution)
 * but includes the ~35-field Aircraft structure inside DockingAircraft.
 */
function _buildActiveJetwayEntry(info, depFlight, approachCache, log, jwTypeMap, baseDateTicks, icao, recvEventsCache, waitingCmdsCache, fpIdByReg, standPositions, strArrCache) {
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
  const fpId = fpIdByReg ? fpIdByReg.get(reg) : null;
  const fstrref = '$fstrref:"flight-plan:' + reg + '"';

  // Resolve aircraft spec from approachCache, falling back to original entry
  const acType = depFlight.AircraftType || '';
  let spec = null;
  const designator = approachCache && approachCache.designatorMap
    ? approachCache.designatorMap.get(acType) : null;
  if (designator && approachCache && approachCache.specDB) {
    spec = approachCache.specDB.get(designator) || null;
  }
  // Fallback 1: try direct specDB lookup — in editor/v4 context, acType
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
  const dockPoses = spec?.DockingPositions;
  if (!dockPoses || !dockPoses.length) {
    console.log('[FP Jetway] MISSING DockingPositions for spec=' + (spec?.Designator || '?') + ' spec=' + JSON.stringify(spec));
    throw new Error(
      '[APPROACH] Missing DockingPositions for aircraft type "' + (acType || 'unknown') +
      '" — type not found in approach cache specDB.'
    );
  }

  // --- Compute position & direction from stand nose/tail -------------
  // Game engine formula: position = NosePosition - WheelBase * direction
  //                     direction = normalize(NosePosition - TailPosition)
  var jwPosX = 0, jwPosY = 0, jwPosZ = 0, jwDirX = 0, jwDirZ = 1;
  if (stand && standPositions) {
    var jwStandId = String(parseInt(stand, 10));
    var jwStandPos = standPositions[jwStandId] || standPositions[stand] || standPositions[stand.padStart(2, '0')];
    if (jwStandPos) {
      var jwSdx = jwStandPos.noseX - jwStandPos.tailX;
      var jwSdz = jwStandPos.noseZ - jwStandPos.tailZ;
      var jwSlen = Math.sqrt(jwSdx * jwSdx + jwSdz * jwSdz);
      if (jwSlen > 0.0001) {
        jwDirX = jwSdx / jwSlen;
        jwDirZ = jwSdz / jwSlen;
      }
      var jwWb = spec?.WheelBase ?? 0;
      jwPosX = jwStandPos.noseX - jwWb * jwDirX;
      jwPosZ = jwStandPos.noseZ - jwWb * jwDirZ;
    }
  }

  // Fully-qualified type strings — no dependency on segment type declarations.
  // These match the types used in the game's jetway save-state serialization.
  // Build reverse name->number lookup from the segment's type declarations
  // collected from RuntimeEntities entries (jwTypeMap).  This ensures the
  // jetway entry's type IDs are consistent with full-form type refs already
  // expanded by _expandShortFormTypes, preventing id-reclamation collisions.
  var _jwTypeNumByName = new Map();
  var _jwMaxNum = 0;
  if (jwTypeMap) {
    for (const [_sn, _sname] of jwTypeMap) {
      _jwTypeNumByName.set(_sname, _sn);
      if (_sn > _jwMaxNum) _jwMaxNum = _sn;
    }
  }
  var _jwFreshNum = _jwMaxNum + 1;
  var _jwResolveType = function (plainName) {
    if (_jwTypeNumByName.has(plainName)) {
      return '"' + _jwTypeNumByName.get(plainName) + '|' + plainName + '"';
    }
    return '"' + (_jwFreshNum++) + '|' + plainName + '"';
  };

  // Dynamic type strings with explicit segment-consistent numbers.
  var DYN_PARAMS_TYPE = _jwResolveType('ContextCross.Dynamics.States.ApproachDynamicsParams, GroundATC.Core');
  var LIST_VEC3_TYPE = _jwResolveType('System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib');

  var T = {
    ac:      _jwResolveType('ContextCross.Aircrafts.Aircraft, GroundATC.Core'),
    spec:    _jwResolveType('ContextCross.Models.AircraftSpecification, GroundATC.Core'),
    float3:  _jwResolveType('Unity.Mathematics.float3, Unity.Mathematics'),
    vec4Arr: _jwResolveType('UnityEngine.Vector4[], UnityEngine.CoreModule'),
    vec4:    _jwResolveType('UnityEngine.Vector4, UnityEngine.CoreModule'),
    dyn:     _jwResolveType('ContextCross.Dynamics.AircraftDynamicsData, GroundATC.Core'),
    dynSt:   _jwResolveType('R3.ReactiveProperty`1[[ContextCross.Dynamics.Enums.State, GroundATC.Core]], R3'),
    coord:   _jwResolveType('ContextCross.Aircrafts.AircraftRunwayCoordinator, GroundATC.Core'),
    rpStrArr:_jwResolveType('R3.ReactiveProperty`1[[System.String[], mscorlib]], R3'),
    strArr:  _jwResolveType('System.String[], mscorlib'),
    vec3:    _jwResolveType('UnityEngine.Vector3, UnityEngine.CoreModule'),
    fp:      _jwResolveType('ContextCross.Models.FlightPlan, GroundATC.Core'),
    dt:      _jwResolveType('System.DateTime, mscorlib'),
    rpState: _jwResolveType('R3.ReactiveProperty`1[[ContextCross.Aircrafts.Enums.EAircraftState, GroundATC.Core]], R3'),
    rpDir:   _jwResolveType('R3.ReactiveProperty`1[[ContextCross.Aircrafts.Enums.EFlightDirection, GroundATC.Core]], R3'),
    rpChan:  _jwResolveType('R3.ReactiveProperty`1[[ContextCross.Models.RadioChannel, GroundATC.Core]], R3'),
    rpPath:  _jwResolveType('R3.ReactiveProperty`1[[ContextCross.Models.Path, GroundATC.Core]], R3'),
    rpStr:   _jwResolveType('R3.ReactiveProperty`1[[System.String, mscorlib]], R3'),
    rpCmdArr:_jwResolveType('R3.ReactiveProperty`1[[ContextCross.Enums.ECommand[], GroundATC.Core]], R3'),
    cmdArr:  _jwResolveType('ContextCross.Enums.ECommand[], GroundATC.Core'),
    rpEvtArr:_jwResolveType('R3.ReactiveProperty`1[[ContextCross.Events.AircraftEvent[], GroundATC.Core]], R3'),
    evtArr:  _jwResolveType('ContextCross.Events.AircraftEvent[], GroundATC.Core'),
    rpVec3:  _jwResolveType('R3.ReactiveProperty`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], R3'),
  };

  // Use full-form type strings for the top-level RuntimeEntity fields (3-6)
  // extracted from the original segment.  When we replace this entry, its
  // original "$type": "3|..." declaration is lost.  If no other entry declares
  // type 3 in this blobdoc scope, bare "$type": 3 references fail to encode.
  const JT3 = (jwTypeMap && jwTypeMap.has(3)) ? '"3|' + jwTypeMap.get(3) + '"' : '3';
  const JT4 = (jwTypeMap && jwTypeMap.has(4)) ? '"4|' + jwTypeMap.get(4) + '"' : '4';
  const JT5 = (jwTypeMap && jwTypeMap.has(5)) ? '"5|' + jwTypeMap.get(5) + '"' : '5';
  const JT6 = (jwTypeMap && jwTypeMap.has(6)) ? '"6|' + jwTypeMap.get(6) + '"' : '6';

  // Build DockingPositions array
  console.log(
    '[FP Jetway] DockingPositions spec=' + (spec?.Designator || '?') +
    ' dockPosesLen=' + (dockPoses ? dockPoses.length : 0) +
    ' T.vec4=' + T.vec4 +
    ' dockPoses=' + JSON.stringify(dockPoses)
  );
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

  function inlineEmptyStrArr(innerId) {
    return (
    '{\n' +
    '                                                    "$id": ' + innerId + ',\n' +
    '                                                    "$type": ' + T.strArr + ',\n' +
    '                                                    "$rlength": 0,\n' +
    '                                                    "$rcontent": [\n' +
    '                                                    ]\n' +
    '                                                }');
  }

  // Empty string[] inner values are shared across all aircraft via one canonical
  // definition per segment (see segStrArrCanonicalIds): the first entry emits the
  // full inline array and records its $id; every later entry emits a bare $iref.
  // The canonical $id was claimed from the segment's dynamic allocator before
  // PASS 2 (so it never collides with static entryId+offset ids); the first
  // emitter here writes the full definition at that id.
  function sharedStrArrInner(innerId) {
    if (strArrCache && strArrCache.canonicalEmitted) {
      return '$iref:' + strArrCache.canonicalId;
    }
    let canonicalInnerId = innerId;
    if (strArrCache) {
      canonicalInnerId = strArrCache.canonicalId !== null ? strArrCache.canonicalId : innerId;
      strArrCache.canonicalEmitted = true;
    }
    return inlineEmptyStrArr(canonicalInnerId);
  }

  // Shared empty-array inner value for _waitingForCommands (ECommand[]) and
  // _receivedEvents (AircraftEvent[]).  Same pattern as sharedStrArrInner:
  // the first emitter writes the full inline definition at the canonical $id
  // (claimed from the segment's dynamic allocator — see segRecvEventsCache /
  // segWaitingCmdsCache); every later entry emits a bare $iref instead of
  // duplicating { $id, $type, $rlength: 0, $rcontent: [] }.
  function sharedEmptyArrayInner(cache, innerId, typeStr) {
    if (cache && cache.canonicalEmitted) {
      return '$iref:' + cache.canonicalId;
    }
    let canonicalInnerId = innerId;
    if (cache) {
      canonicalInnerId = cache.canonicalId !== null ? cache.canonicalId : innerId;
      cache.canonicalEmitted = true;
    }
    return (
    '{\n' +
    '                                                    "$id": ' + canonicalInnerId + ',\n' +
    '                                                    "$type": ' + typeStr + ',\n' +
    '                                                    "$rlength": 0,\n' +
    '                                                    "$rcontent": [\n' +
    '                                                    ]\n' +
    '                                                }');
  }

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
    '                                                    ' + sharedStrArrInner(id(33)),
    '                                                },',
    '                                                "TaxiBlockingRunwayNames": {',
    '                                                    "$id": ' + id(11) + ',',
    '                                                    "$type": ' + T.rpStrArr + ',',
    '                                                    ' + sharedStrArrInner(id(34)),
    '                                                },',
    '                                                "RunwayFenceCurrentEnterRunways": {',
    '                                                    "$id": ' + id(12) + ',',
    '                                                    "$type": ' + T.rpStrArr + ',',
    '                                                    ' + sharedStrArrInner(id(35)),
    '                                                },',
    '                                                "RunwayGuardCurrentEnterRunway": {',
    '                                                    "$id": ' + id(13) + ',',
    '                                                    "$type": ' + T.rpStrArr + ',',
    '                                                    ' + sharedStrArrInner(id(36)),
    '                                                },',
    '                                                "CrossRunwayPermissions": {',
    '                                                    "$id": ' + id(14) + ',',
    '                                                    "$type": ' + T.rpStrArr + ',',
    '                                                    ' + sharedStrArrInner(id(37)),
    '                                                },',
    '                                                "HoldShortAcknowledgedRunwayNames": {',
    '                                                    "$id": ' + id(15) + ',',
    '                                                    "$type": ' + T.rpStrArr + ',',
    '                                                    ' + sharedStrArrInner(id(38)),
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
'                                                "$id": ' + fpId + ',',
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
    '                                                ' + sharedEmptyArrayInner(waitingCmdsCache, id(25), T.cmdArr) + '\n' +
    '                                            },',
    '                                            "_receivedEvents": {\n' +
    '                                                "$id": ' + id(26) + ',\n' +
    '                                                "$type": ' + T.rpEvtArr + ',\n' +
    '                                                ' + sharedEmptyArrayInner(recvEventsCache, id(27), T.evtArr) + '\n' +
    '                                            },',
    '                                            "_position": {',
    '                                                "$id": ' + id(28) + ',',
    '                                                "$type": ' + T.rpVec3 + ',',
    '                                                {',
    '                                                    "$type": ' + T.vec3 + ',',
    '                                                    ' + jwPosX + ',',
    '                                                    0,',
    '                                                    ' + jwPosZ,
    '                                                }',
    '                                            },',
    '                                            "_direction": {',
    '                                                "$id": ' + id(29) + ',',
    '                                                "$type": ' + T.rpVec3 + ',',
    '                                                {',
    '                                                    "$type": ' + T.vec3 + ',',
    '                                                    ' + jwDirX + ',',
    '                                                    0,',
    '                                                    ' + jwDirZ,
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
    flightPlanId: fpId,
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
 *   "$v": { "$id": 738, ... }   → returns 738 (inline object)
 *   "$v": $iref:738             → returns 738 (indirect reference)
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
  // ── Navigate to RuntimeEntities.$rcontent structurally ──────────
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

  // ── Iterate entries ─────────────────────────────────────────────
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
            // tool here — but the scan boundary is structurally correct.
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

            // ── Status → 0 ──
            const statusSec = entryT.findSection('Status');
            if (statusSec) {
              mods.push({
                start: statusSec.valueStart, end: statusSec.valueEnd,
                replacement: '0'
              });
            }

            // ── Progress → 0 (Unity struct: { $type:N, VALUE }) ──
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

            // ── DockingDoorIndex → -1 (Unity struct: { $type:N, VALUE }) ──
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

            // ── DockingAircraft Aircraft: null _flightPlan.StaticItem ──
            // Instead of replacing the entire inner Aircraft object with null
            // (which destroys $id:10 and nested $id:17/32/34 that other entries
            // reference via $iref), keep the structure and null _flightPlan's
            // $fstrref reference.  Step 7a will handle the $fstrref → null
            // replacement globally later — we just mark this jetway as stale.
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
                            // Already handled — skip
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
  // from parent RunwayTimeline type — System.String[] is typically the next
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
  // Always emit full-form type declaration — same reasoning as InitialRunways above.
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
    irId, irTypeNum, irTypeStr, tlId, tlTypeNum, tlTypeStr, tlElemTypeNum,
    changesArrTypeNum, changeElemTypeNum,
  };
}

/**
 * Patches WindFrames, WeatherFrames, and RunwayTimeline sections in the .acl file
 * to match the current timeline data.
 */
function _rebuildTimelineSections(aclPath, weatherTimeline, windTimeline, runwayTimeline) {
  const log = (msg) => console.log('[ACL-TIMELINE]', msg);
  let text = readAclText(aclPath);

  // Sort timelines by time
  const _toSec = (t) => { const p = String(t || '').split(':'); return (parseInt(p[0]) || 0) * 3600 + (parseInt(p[1]) || 0) * 60 + (parseInt(p[2]) || 0); };
  if (weatherTimeline && weatherTimeline.length > 1) weatherTimeline.sort((a, b) => _toSec(a.time) - _toSec(b.time));
  if (windTimeline && windTimeline.length > 1) windTimeline.sort((a, b) => _toSec(a.time) - _toSec(b.time));

  _rebuildV4TimelineSections(aclPath, text, weatherTimeline, windTimeline, runwayTimeline, log);
}

// ─── V4: MetaData object-based timeline rebuild ──────────────

/**
 * Rebuild WeatherFrames, WindFrames, and RunwayTimeline in a v4 ACL file
 * by parsing MetaData as an Odin JSON object, modifying its sub-sections,
 * and serializing the whole MetaData back.
 *
 * This matches the DynamicEntities pattern: load -> modify -> serialize.
 */
function _rebuildV4TimelineSections(aclPath, text, weatherTimeline, windTimeline, runwayTimeline, log) {
  // 1. Find MetaData section and extract its value text
  const t = createTokenizer(text);
  const mdSec = t.findSection('MetaData');
  if (!mdSec) { log('ERROR: MetaData section not found'); return; }

  let mdVal = t.substring(mdSec.valueStart, mdSec.valueEnd);

  // Helper: find a sub-section key within the current mdVal text.
  // Must be called fresh each time (creates a new tokenizer against current mdVal).
  function findSubSection(sectionName) {
    const mt = createTokenizer(mdVal);
    const sec = mt.findSection(sectionName);
    if (!sec) return null;
    return {
      start: sec.keyStart,
      end: sec.valueEnd,
      content: mdVal.substring(sec.valueStart, sec.valueEnd),
    };
  }

  // ── WeatherFrames ──
  if (weatherTimeline && weatherTimeline.length) {
    const sec = findSubSection('WeatherFrames');
    if (sec) {
      const pMeta = _sectionMeta(sec.content);
      const eTypeNum = _elemTypeFromRcontent(sec.content);
      const newSection = _generateFramesSection(weatherTimeline, pMeta.id, eTypeNum, pMeta.typeNum, 'WeatherFrames', 'WeatherFrame[]', 'WeatherFrame', {
        preset: { acl: 'Preset', type: 'string' },
        time:   { acl: 'Time',   type: 'string' },
      });
      mdVal = mdVal.substring(0, sec.start) + newSection + mdVal.substring(sec.end);
      log('WeatherFrames rebuilt (' + weatherTimeline.length + ' entries)');
    }
  }

  // ── WindFrames ──
  if (windTimeline && windTimeline.length) {
    const sec = findSubSection('WindFrames');
    if (sec) {
      const pMeta = _sectionMeta(sec.content);
      const eTypeNum = _elemTypeFromRcontent(sec.content);
      const newSection = _generateFramesSection(windTimeline, pMeta.id, eTypeNum, pMeta.typeNum, 'WindFrames', 'WindFrame[]', 'WindFrame', {
        direction: { acl: 'Direction', type: 'number' },
        speed:     { acl: 'Speed',     type: 'number' },
        time:      { acl: 'Time',      type: 'string' },
      });
      mdVal = mdVal.substring(0, sec.start) + newSection + mdVal.substring(sec.end);
      log('WindFrames rebuilt (' + windTimeline.length + ' entries)');
    }
  }

  // ── RunwayTimeline ──
  if (runwayTimeline) {
    const sec = findSubSection('RunwayTimeline');
    if (sec) {
      const meta = _metaRunway(sec.content);

      // Fix type number conflicts
      const usedSet = new Set();
      const tdRe = /"\$type":\s*"(\d+)\|/g;
      let tdM;
      while ((tdM = tdRe.exec(text)) !== null) usedSet.add(parseInt(tdM[1], 10));
      const _resolve = (num) => {
        if (num == null) return num;
        let c = num;
        while (usedSet.has(c)) c++;
        usedSet.add(c);
        return c;
      };
      const otle = meta.tlElemTypeNum;
      const oca  = meta.changesArrTypeNum;
      const oce  = meta.changeElemTypeNum;
      meta.tlElemTypeNum      = _resolve(meta.tlElemTypeNum);
      meta.changesArrTypeNum  = _resolve(meta.changesArrTypeNum);
      meta.changeElemTypeNum  = _resolve(meta.changeElemTypeNum);
      if (meta.tlElemTypeNum !== otle || meta.changesArrTypeNum !== oca || meta.changeElemTypeNum !== oce) {
        log('typeNums fixed: tlElem=' + otle + '->' + meta.tlElemTypeNum + ' changesArr=' + oca + '->' + meta.changesArrTypeNum + ' changeElem=' + oce + '->' + meta.changeElemTypeNum);
      }

      const newSection = _generateRunwayTimelineSection(runwayTimeline, meta);
      mdVal = mdVal.substring(0, sec.start) + newSection + mdVal.substring(sec.end);
      log('RunwayTimeline rebuilt (initRWs=' + (runwayTimeline.initialRunways || []).length + ', tl=' + (runwayTimeline.timeline || []).length + ')');
    }
  }

  // 2. Replace MetaData value in full text (keeps the "MetaData": key intact)
  text = text.substring(0, mdSec.valueStart) + mdVal + text.substring(mdSec.valueEnd);

  // 3. Write back
  writeAcl(aclPath, text);
  log('Timeline sections rebuilt in MetaData (v4)');
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

function _rebuildStaticDataSections(aclPath, flights, baseDateTicks, approachCache, aclcfgStartTime, _saveSec) {
  const log = (msg) => console.log('[ACL-REBUILD-V4]', msg);
  const text = readAclText(aclPath);
  const bdt = BigInt(baseDateTicks || FALLBACK_BASE_DATE_TICKS);
  const icaoMatch = aclPath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
  const icao = icaoMatch ? icaoMatch[1] : '';

  // Build per-file typeMap
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

  // ── Resolve saveTime for approach position computation ──────────
  // Always use game start time from resolveConfigTime().
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

  const _assertBdTn = (search, label) => {
    const val = _bdTn(search);
    if (val == null) throw new Error(
      `[V4-BUILD] _rebuildStaticDataSections: blobdoc type "${label}" not in bdTypeMap.\n` +
      `  Search: "${search}"\n  typeMap (${bdTypeMap.size}): ${[...bdTypeMap.entries()].map(([k, v]) => `${k}?${v}`).join(', ')}`
    );
    return val;
  };
  const dtTypeNum = _assertBdTn('System.DateTime,', 'DateTime');
  const arrLegTypeNum = _assertBdTn('FlightPlanArrivalLeg,', 'FlightPlanArrivalLeg');
  const depLegTypeNum = _assertBdTn('FlightPlanDepartureLeg,', 'FlightPlanDepartureLeg');

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
  // And extract CallSign from each old entry for rename detection
  let fpFirstStart = -1, fpLastEnd = -1;
  const fpItemNum = (() => {
    const val = _tn('ContextCross.Models.FlightPlanStaticItem,');
    if (val == null) throw new Error(
      `[FLIGHT-PLANS] _rebuild: type "FlightPlanStaticItem" not in typeMap.\n` +
      `  Search: "ContextCross.Models.FlightPlanStaticItem,"\n  typeMap (${typeMap.size}): ${[...typeMap.entries()].slice(0, 30).map(([k, v]) => `${k}?${v}`).join(', ')}`
    );
    return val;
  })();
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
  // these jetway entries to their undocked state (Status→0, Progress→0,
  // DockingAircraft→null, DockingDoorIndex→-1).
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
    const renameMap = new Map(); // oldReg → newReg
    {
      // Build new callsign → registration lookup from current flights
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
          [...renameMap].map(([o, n]) => o + ' → ' + n).join(', '));
      }
    }

    // 7b. Reset jetway docking state and remove orphaned RuntimeEntities entries.
    // IMPORTANT: 7b MUST run before 7a (stale $fstrref cleanup). 7a nulls
    // $fstrref references that 7b relies on for stale-jetway detection, so
    // 7b is placed first to see the intact $fstrref values in DockingAircraft.
    // RuntimeEntities exist in the header's RuntimeData blob AND in checkpoint
    // frames. We must process all segments — not just frames — otherwise
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
      // "Type id N claimed by both …" errors during binary encoding.
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

    // Pre-compute fpIdByReg per segment so both 7b-1 (jetway rebuild) and
    // 7b-3 (flight runtime entities rebuild) use the same flight-plan $id values.
    // This must happen after type expansion (so all $id values are visible) and
    // before jetway rebuild.
    // Jetway aircraft inline _flightPlan with $id:fpId at the TOP of $rcontent;
    // flight-plan:REG (MIDDLE) becomes thin $iref:fpId pointing BACK to it;
    // standalone aircraft (BOTTOM) use _flightPlan: $iref:fpId.
    // All $iref refs are backward → _reorderIrefEntries preserves hardcoded order.
    const segMaxId = [];
    const segFpIdByReg = [];
    for (let fi = 0; fi < frameDocs.length; fi++) {
      const idRe = /"\$id":\s*(\d+)/g;
      let maxId = 0;
      let idMatch;
      while ((idMatch = idRe.exec(frameDocs[fi])) !== null) {
        const val = parseInt(idMatch[1], 10);
        if (val > maxId) maxId = val;
      }
      // Jetway entries are rebuilt (7b-1) with static $ids up to entryId+38
      // even when they were previously empty/thin (ids only up to entryId+3),
      // so the segment's effective max $id must account for that expansion —
      // otherwise precomputed flight-plan ids (and the strArr canonical seed
      // below) could collide with ids emitted by rebuilt jetways.
      const jwRe = /\{"\$k":\s*"jetway:[^"]*",\s*"\$v":\s*\{\s*"\$id":\s*(\d+)/g;
      let jwM;
      while ((jwM = jwRe.exec(frameDocs[fi])) !== null) {
        const jwId = parseInt(jwM[1], 10);
        if (jwId + 38 > maxId) maxId = jwId + 38;
      }
      segMaxId[fi] = maxId;
      const sortedRegs = [...validRegs].sort();
      const fpIdByReg = new Map();
      sortedRegs.forEach(function (reg, i) { fpIdByReg.set(reg, maxId + 1 + i); });
      segFpIdByReg.push(fpIdByReg);
    }

    // 7b-1. Rebuild jetway entries constructively in ALL segments (header + frames).
    // Each segment has its own $blobdoc with independent $id namespace, so we create
    // one _IdMapper per segment to track old→new $id mappings for $iref remapping.
    const segIdMappers = [];
    for (let fi = 0; fi < frameDocs.length; fi++) {
      segIdMappers[fi] = new _IdMapper();
    }
    // Per-segment canonical $id cache for the empty string[] arrays shared across
    // aircraft entries (TaxiPathUnPassedIntersectionRunwayNames etc.).  The first
    // entry in a segment that emits one of these arrays defines it inline; every
    // later entry $iref's back to that canonical definition.  Per-segment because
    // each $blobdoc has its own independent $id namespace.
    //
    // canonicalId:   the shared empty string[] $id, CLAIMED from the dynamic
    //                allocator below — NOT from an entry's static entryId+offset
    //                range.  Jetway static ranges overlap (entryIds 8 apart,
    //                template offsets up to 38), so an entryId+33 canonical
    //                collided with another jetway's id(25), and a duplicate $id
    //                that is an $iref target crashes the game's JsonDataReader
    //                (NullReferenceException on load).
    // canonicalEmitted: whether the full inline definition has been written yet
    //                (the claimed id may have been reserved by 7b-1 while the
    //                first emitter is in 7b-3, or vice versa).
    // alloc:         shared dynamic id allocator for the segment; seeded past the
    //                segment's max static $id (incl. jetway rebuild expansion).
    const segStrArrCanonicalIds = [];
    const segRecvEventsCache = [];
    const segWaitingCmdsCache = [];
    for (let fi = 0; fi < frameDocs.length; fi++) {
      // All three caches share ONE allocator: they claim canonical $ids from
      // the same dynamic namespace, so recvEvents/waitingCmds ids can never
      // collide with the strArr id (or with each other).
      const segAlloc = { v: segMaxId[fi] + 1 };
      segStrArrCanonicalIds[fi] = {
        canonicalId: null,
        canonicalEmitted: false,
        alloc: segAlloc,
      };
      segRecvEventsCache[fi] = {
        canonicalId: null,
        canonicalEmitted: false,
        alloc: segAlloc,
      };
      segWaitingCmdsCache[fi] = {
        canonicalId: null,
        canonicalEmitted: false,
        alloc: segAlloc,
      };
    }
    let totalJwReset = 0;
    const segActiveJetways = []; // per-segment [{ stand, reg, aircraftId }]

    // Parse stand positions once for all jetway entry rebuilds.
    // _rebuildJetwayEntries needs nose/tail positions to compute aircraft
    // parking positions (NosePosition - WheelBase * direction).
    var v4StandPositions = null;
    try {
      const { _parseStandPositions } = require('./scenery');
      v4StandPositions = _parseStandPositions(text, true);
    } catch (_) {
      log('  stand position parse for jetway rebuild failed: ' + _.message);
    }

    for (let fi = 0; fi < frameDocs.length; fi++) {
      const result = _rebuildJetwayEntries(frameDocs[fi], flights, validRegs, approachCache, log, segIdMappers[fi], bdt, icao, segFpIdByReg[fi], v4StandPositions, segStrArrCanonicalIds[fi], segRecvEventsCache[fi], segWaitingCmdsCache[fi]);
      segActiveJetways[fi] = result.activeJetways;
      if (result.resetCount > 0) {
        frameDocs[fi] = result.text;
        frameModified = true;
        totalJwReset += result.resetCount;
      }
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
        segTypeMaps[fi], log, segIdMappers[fi], icao,
        approachCache, text, saveSec,
        segActiveJetways[fi],
        segFpIdByReg[fi],
        segStrArrCanonicalIds[fi],
        segRecvEventsCache[fi],
        segWaitingCmdsCache[fi]
      );
      if (result.added > 0 || result.removed > 0) {
        frameDocs[fi] = result.text;
        frameModified = true;
      }
    }

    // 7c. Remove orphaned RuntimeEntities entries whose $k doesn't exist in StaticItems.
    // When a flight's registration changes, the rebuilt StaticItems header has the new
    // key (e.g. "flight-plan:B-99Y2") but runtime segments still carry the old key
    // (e.g. "flight-plan:B-34JP"). The stale $fstrref → null replacement (7a) handles
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

    // ── Centralized $iref remapping ──────────────────────────────────
    // Apply all old→new $id mappings collected by the per-segment IdMapper
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

    // 7a. Replace stale $fstrref → null everywhere, but REMAP for renames.
    // Runs AFTER 7b so the jetway reset step can detect stale DockingAircraft
    // via intact $fstrref references before they are nulled here.
    // Use indexOf scan (not regex) — $fstrref is an Odin value format, not a JSON key,
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
      log('Cleaned up ' + staleReplaced + ' stale $fstrref reference(s) → null');
    }
    if (remappedRefs > 0) {
      log('Remapped ' + remappedRefs + ' $fstrref reference(s) to new registration(s)');
    }
  }

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
