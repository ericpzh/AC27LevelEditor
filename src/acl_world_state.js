/**
 * ACL WorldState parser — TaskFlightState (type 56/54) and AircraftState (type 35).
 */
const {
  TICKS_PER_DAY, FALLBACK_BASE_DATE_TICKS, AIRCRAFT_DESIGNATOR_MAP,
} = require('./constants');
const {
  ticksToTime, timeToTicks, _guessDesignator, _extractBaseDateFromText, ticksToString,
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

// ─── Sync flights back into WorldState ────────────────────────

function _syncWorldState(rawText, flights, wsData, sceneryMaps, baseDateTicks) {
  if (!wsData || !wsData.wsEntries || wsData.wsEntries.length === 0 || !flights || flights.length === 0) return rawText;
  const sm = sceneryMaps || { runwayNameToGuid: {}, standIdToGuid: {} };
  const bdt = baseDateTicks || FALLBACK_BASE_DATE_TICKS;

  const flightByCallSign = {};
  const unmatchedFlights = new Set(flights);
  for (const fl of flights) {
    const cs = (fl.CallSign || '').trim();
    if (cs) flightByCallSign[cs] = fl;
  }

  const taskFlightEntries = [];
  const aircraftStateEntries = [];
  const otherEntries = [];
  for (const entry of wsData.wsEntries) {
    if (entry.vBlock.includes('"$type": 56,') || entry.vBlock.includes('"$type": "56|') ||
        entry.vBlock.includes('"$type": 54,') || entry.vBlock.includes('"$type": "54|')) {
      taskFlightEntries.push(entry);
    } else if (entry.vBlock.includes('"$type": 35,') || entry.vBlock.includes('"$type": "35|')) {
      aircraftStateEntries.push(entry);
    } else {
      otherEntries.push(entry);
    }
  }

  const lastTaskFlightTemplate = taskFlightEntries.length > 0
    ? taskFlightEntries[taskFlightEntries.length - 1].block : null;
  const lastAircraftStateTemplate = aircraftStateEntries.length > 0
    ? aircraftStateEntries[aircraftStateEntries.length - 1].block : null;

  const newTaskFlightBlocks = [];
  const guidMap = {};

  for (const entry of taskFlightEntries) {
    const csMatch = entry.vBlock.match(/"CallSign"\s*:\s*"([^"]*)"/);
    const cs = csMatch ? csMatch[1] : '';
    const flight = flightByCallSign[cs];

    if (flight) {
      const hasDeparture = entry.vBlock.includes('"Departure"') && !entry.vBlock.includes('"Departure": null');
      const isDep = flight.isDeparture !== undefined ? flight.isDeparture : hasDeparture;
      const newBlock = _applyWsChanges(entry.block, flight, bdt, isDep);
      newTaskFlightBlocks.push(newBlock);
      flight._wsEntryIdx = newTaskFlightBlocks.length - 1;

      const kMatch = entry.block.match(/"\$k"\s*:\s*"([^"]*)"/);
      if (kMatch) {
        guidMap[cs] = kMatch[1];
        flight._wsGuid = kMatch[1];
      }
      unmatchedFlights.delete(flight);
    }
  }

  if (lastTaskFlightTemplate && unmatchedFlights.size > 0) {
    for (const flight of unmatchedFlights) {
      const newGuid = _generateGuid();
      const cs = (flight.CallSign || '').trim();
      guidMap[cs] = newGuid;
      flight._wsGuid = newGuid;
      const newBlock = _buildWorldStateTaskEntry(lastTaskFlightTemplate, flight, bdt, newGuid);
      newTaskFlightBlocks.push(newBlock);
      flight._wsEntryIdx = newTaskFlightBlocks.length - 1;
    }
  }

  const newAircraftStateBlocks = [];
  const usedAircraftGuids = new Set();
  for (const entry of aircraftStateEntries) {
    const fpgMatch = entry.vBlock.match(/"FlightPlanGuid"\s*:\s*"([^"]+)"/);
    if (fpgMatch) {
      const fpg = fpgMatch[1];
      const linkedFlight = flights.find(f => f._wsGuid === fpg);
      if (linkedFlight) {
        const newBlock = _applyAircraftStateChanges(entry.block, linkedFlight, sm);
        newAircraftStateBlocks.push(newBlock);
        const acKMatch = entry.block.match(/"\$k"\s*:\s*"([^"]*)"/);
        if (acKMatch) usedAircraftGuids.add(acKMatch[1]);
        continue;
      }
      for (const [oldCs, newGuid] of Object.entries(guidMap)) {
        if (fpg === oldCs || (typeof guidMap[fpg] === 'string' && newGuid !== oldCs)) {
          break;
        }
      }
    }
  }

  for (const flight of flights) {
    if (!flight._wsGuid) continue;
    const alreadyHasAc = newAircraftStateBlocks.some(block =>
      block.includes('"' + flight._wsGuid + '"')
    );
    if (alreadyHasAc) continue;

    if (lastAircraftStateTemplate) {
      const newAcGuid = _generateGuid();
      const newAcBlock = _buildWorldStateAircraftEntry(lastAircraftStateTemplate, flight, sm, newAcGuid);
      newAircraftStateBlocks.push(newAcBlock);
    }
  }

  const newEntryBlocks = [
    ...otherEntries.map(e => e.block),
    ...newTaskFlightBlocks,
    ...newAircraftStateBlocks,
  ];

  const lenMatch = wsData.aircraftsBefore.match(/"\$rlength"\s*:\s*(\d+)/);
  if (lenMatch) {
    wsData.aircraftsBefore = wsData.aircraftsBefore.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${newEntryBlocks.length}`);
  }

  const newArray = newEntryBlocks.join(',\n                ');
  const newText = wsData.aircraftsBefore + '\n' + newArray + '\n' + wsData.aircraftsAfter;
  return newText;
}

// ─── Apply changes to TaskFlightState entry ───────────────────

function _applyWsChanges(block, flight, baseDateTicks, isDeparture) {
  block = _applyWsField(block, 'CallSign', flight.CallSign || '', 'string');
  if (flight._Registration) {
    block = _applyWsField(block, 'Registration', flight._Registration, 'string');
  }
  block = _applyWsField(block, 'AirlineName', flight.AirlineName || '', 'string');
  block = _applyWsField(block, 'AircraftType', flight.AircraftType || '', 'string');
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

// ─── Apply changes to AircraftState entry (type 35) ───────────

function _applyAircraftStateChanges(block, flight, sceneryMaps) {
  const sm = sceneryMaps || {};

  if (flight.Runway && sm.runwayNameToGuid && sm.runwayNameToGuid[flight.Runway]) {
    const newGuid = sm.runwayNameToGuid[flight.Runway];
    block = _applyWsField(block, 'RunwayGuid', newGuid, 'string');
  }

  if (flight.Stand && sm.standIdToGuid && sm.standIdToGuid[flight.Stand]) {
    const newGuid = sm.standIdToGuid[flight.Stand];
    block = _applyWsField(block, 'StandGuid', newGuid, 'string');
  }

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

// ─── Single field patcher in raw JSON text ────────────────────

function _applyWsField(block, fieldName, value, fieldType) {
  if (fieldType === 'string') {
    const val = value || '';
    const m = block.match(new RegExp(`("${fieldName}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`));
    if (m) {
      return block.substring(0, m.index) + m[1] + '"' + val + '"' + block.substring(m.index + m[0].length);
    }
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

module.exports = {
  _generateGuid,
  _parseWorldStateData,
  _extractFlightsFromWorldState,
  _syncWorldState,
  _applyWsChanges,
  _applyAircraftStateChanges,
  _applyWsField,
};
