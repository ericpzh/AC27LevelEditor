/**
 * ACL WorldState parser — TaskFlightState (type 56/54) and AircraftState (type 35).
 * Uses the tokenizer for string-aware structural boundary finding.
 */
import {
  TICKS_PER_DAY, FALLBACK_BASE_DATE_TICKS,
} from './constants';
const {
  ticksToTime, timeToTicks, _extractBaseDateFromText,
} = require('../utils/timeUtils');
const { createTokenizer } = require('./tokenizer');

// ─── GUID generator ───────────────────────────────────────────────

let _cryptoRandomUUID;
try { _cryptoRandomUUID = require('crypto').randomUUID; } catch (_) {}

function _generateGuid() {
  if (_cryptoRandomUUID) return _cryptoRandomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── WorldState parser ────────────────────────────────────────────

function _parseWorldStateData(text) {
  const result = { wsStart: -1, aircraftsBefore: '', aircraftsAfter: '', wsEntries: [], aircraftsRlength: 0 };

  const t = createTokenizer(text);
  const wsSec = t.findSection('WorldState');
  if (!wsSec) return result;
  result.wsStart = wsSec.keyStart;

  const wsText = t.substring(wsSec.valueStart, wsSec.valueEnd);
  const wsT = createTokenizer(wsText);

  // Find Aircrafts sub-section within WorldState
  const acSec = wsT.findSection('Aircrafts');
  if (!acSec) return result;

  const acText = wsT.substring(acSec.valueStart, acSec.valueEnd);
  const acT = createTokenizer(acText);

  // Extract $rlength
  const rlMatch = acText.match(/"\$rlength"\s*:\s*(\d+)/);
  if (rlMatch) result.aircraftsRlength = parseInt(rlMatch[1], 10);

  // Find $rcontent array
  const rcSec = acT.findSection('$rcontent');
  if (!rcSec) return result;

  // Aircrafts $rcontent start position in the original text
  const absRcStart = wsSec.valueStart + acSec.valueStart + rcSec.valueStart;
  result.aircraftsBefore = text.substring(0, absRcStart);

  // Find end of $rcontent array (string-aware)
  const rcEnd = acT.findArrayEnd(rcSec.valueStart);
  if (rcEnd === null) return result;

  const absRcEnd = wsSec.valueStart + acSec.valueStart + rcEnd;
  result.aircraftsAfter = text.substring(absRcEnd);

  // Parse $rcontent entries (each is a $k/$v dictionary entry)
  const arrayContent = text.substring(absRcStart, absRcEnd);
  const arrayT = createTokenizer(arrayContent);

  _parseDictEntries(arrayContent, arrayT, result.wsEntries);

  return result;
}

/**
 * Parse $k/$v dictionary entries from a $rcontent array.
 * Entries are extracted with string-aware boundary detection.
 */
function _parseDictEntries(content, contentT, targetArray) {
  // Find all $k entries
  const kRe = /"\$k"\s*:\s*"([^"]+)"/g;
  let km;
  while ((km = kRe.exec(content)) !== null) {
    const k = km[1];

    // Find the $v block for this entry using string-aware scanning
    const vKeyIdx = content.indexOf('"$v"', km.index);
    if (vKeyIdx < 0) continue;

    const colonIdx = content.indexOf(':', vKeyIdx);
    if (colonIdx < 0) continue;

    let vBlockStart = colonIdx + 1;
    while (vBlockStart < content.length && ' \t\n\r'.includes(content[vBlockStart])) vBlockStart++;
    if (vBlockStart >= content.length || content[vBlockStart] !== '{') continue;

    const vBlockEnd = contentT.findObjectEnd(vBlockStart);
    if (vBlockEnd === null) continue;

    // Build block (the entire $k/$v entry as a single object)
    const blockEnd = _findNextMatchingBrace(content, km.index);
    if (blockEnd === null) continue;

    targetArray.push({
      k,
      block: content.substring(km.index - 1, blockEnd), // include opening {
      vBlock: content.substring(vBlockStart, vBlockEnd),
    });
  }
}

/**
 * Find the closing } of an object starting at `start` which is the first {.
 * Simple brace matcher without string awareness (used only for block extraction,
 * not for critical structural parsing).
 */
function _findNextMatchingBrace(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

// ─── Extract flights from WorldState TaskFlightState entries ──────

function _extractFlightsFromWorldState(wsData, fullText, sceneryMaps) {
  if (!wsData || !wsData.wsEntries || wsData.wsEntries.length === 0) return [];
  const sm = sceneryMaps || { runwayNameToGuid: {}, standIdToGuid: {}, runwayGuidToName: {}, standGuidToId: {} };

  const flights = [];
  const baseDateTicks = _extractBaseDateFromText(fullText);

  for (let ei = 0; ei < wsData.wsEntries.length; ei++) {
    const entry = wsData.wsEntries[ei];
    const vBlock = entry.vBlock;

    // Check type using structural matching (not fragile includes())
    const typeMatch = vBlock.match(/"\$type"\s*:\s*(?:"?\d+)/);
    if (!typeMatch) continue;
    const typeNum = typeMatch[0].match(/\d+/);
    if (!typeNum) continue;
    const tn = parseInt(typeNum[0], 10);
    if (tn !== 56 && tn !== 54) continue; // Only TaskFlightState entries

    const f = { _wsEntryIdx: ei, _wsGuid: entry.k };

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

    // Extract Departure/Arrival leg using string-aware tokenizer
    const vBlockT = createTokenizer(vBlock);

    const depMatch = vBlock.match(/"Departure"\s*:\s*\{/);
    const arrMatch = vBlock.match(/"Arrival"\s*:\s*\{/);

    if (depMatch) {
      f.isDeparture = true;
      const depStart = depMatch.index + depMatch[0].length - 1; // position of {
      const depEnd = vBlockT.findObjectEnd(depStart);
      if (depEnd !== null) {
        const depObj = vBlock.substring(depStart, depEnd);

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
      }
    } else if (arrMatch) {
      f.isDeparture = false;
      const arrStart = arrMatch.index + arrMatch[0].length - 1; // position of {
      const arrEnd = vBlockT.findObjectEnd(arrStart);
      if (arrEnd !== null) {
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
    }

    flights.push(f);
  }

  const arrivals = flights.filter(f => (f.LandingTime || '').trim()).sort((a, b) => (a.LandingTime || '').localeCompare(b.LandingTime || ''));
  const departures = flights.filter(f => (f.OffBlockTime || '').trim()).sort((a, b) => (a.OffBlockTime || '').localeCompare(b.OffBlockTime || ''));
  return [...arrivals, ...departures];
}


module.exports = {
  _generateGuid,
  _parseWorldStateData,
  _extractFlightsFromWorldState,
};
