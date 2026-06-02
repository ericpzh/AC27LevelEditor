/**
 * ACL WorldState parser — TaskFlightState (type 56/54) and AircraftState (type 35).
 */
const {
  TICKS_PER_DAY, FALLBACK_BASE_DATE_TICKS,
} = require('./constants');
const {
  ticksToTime, timeToTicks, _extractBaseDateFromText,
} = require('./time_utils');

// ─── GUID generator ───────────────────────────────────────────

let _cryptoRandomUUID;
try { _cryptoRandomUUID = require('crypto').randomUUID; } catch (_) {}

function _generateGuid() {
  if (_cryptoRandomUUID) return _cryptoRandomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── WorldState parser ────────────────────────────────────────

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

  const rlMatch = acSection.match(/"\$rlength"\s*:\s*(\d+)/);
  if (rlMatch) result.aircraftsRlength = parseInt(rlMatch[1], 10);

  const rcPos = acIdx + rcMatch.index + rcMatch[0].length;
  result.aircraftsBefore = text.substring(0, wsIdx + rcPos);
  const absRcPos = wsIdx + rcPos;

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
          const colonIdx = block.indexOf(':', vStart);
          const braceIdx = block.indexOf('{', colonIdx);
          let vDepth = 1;
          let vEnd = braceIdx + 1;
          for (; vEnd < block.length; vEnd++) {
            if (block[vEnd] === '{') vDepth++;
            else if (block[vEnd] === '}') { vDepth--; if (vDepth === 0) break; }
          }
          result.wsEntries.push({
            k: kMatch ? kMatch[1] : '',
            block: block,
            vBlock: block.substring(braceIdx, vEnd + 1),
          });
        }
        entryStart = -1;
      }
    }
  }

  return result;
}

// ─── Extract flights from WorldState TaskFlightState entries ──

function _extractFlightsFromWorldState(wsData, fullText, sceneryMaps) {
  if (!wsData || !wsData.wsEntries || wsData.wsEntries.length === 0) return [];
  const sm = sceneryMaps || { runwayNameToGuid: {}, standIdToGuid: {}, runwayGuidToName: {}, standGuidToId: {} };

  const flights = [];
  const baseDateTicks = _extractBaseDateFromText(fullText);

  for (let ei = 0; ei < wsData.wsEntries.length; ei++) {
    const entry = wsData.wsEntries[ei];
    const vBlock = entry.vBlock;

    if (!vBlock.includes('"$type": 56,') && !vBlock.includes('"$type": "56|') &&
        !vBlock.includes('"$type": 54,') && !vBlock.includes('"$type": "54|')) continue;

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

    const depMatch = vBlock.match(/"Departure"\s*:\s*\{/);
    const arrMatch = vBlock.match(/"Arrival"\s*:\s*\{/);

    if (depMatch) {
      f.isDeparture = true;
      const depStart = depMatch.index + depMatch[0].length;
      let depDepth = 1;
      let depEnd = depStart;
      for (; depEnd < vBlock.length; depEnd++) {
        if (vBlock[depEnd] === '{') depDepth++;
        else if (vBlock[depEnd] === '}') { depDepth--; if (depDepth === 0) break; }
      }
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

  const arrivals = flights.filter(f => (f.LandingTime || '').trim()).sort((a, b) => (a.LandingTime || '').localeCompare(b.LandingTime || ''));
  const departures = flights.filter(f => (f.OffBlockTime || '').trim()).sort((a, b) => (a.OffBlockTime || '').localeCompare(b.OffBlockTime || ''));
  return [...arrivals, ...departures];
}


module.exports = {
  _generateGuid,
  _parseWorldStateData,
  _extractFlightsFromWorldState,
};
