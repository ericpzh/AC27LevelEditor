/**
 * ACL FlightPlans parser — new game format (type 37/52), ArrivalLeg (type 58), DepartureLeg (type 57).
 */
const fs = require('fs');
const path = require('path');
const { FALLBACK_BASE_DATE_TICKS } = require('./constants');
const { ticksToTime, timeToTicks, _extractBaseDateFromText, ticksToString } = require('./time_utils');
const { _applyWsField, _generateGuid } = require('./acl_world_state');
const { calcProgressRatio, buildAircraftEntry } = require('./acl_dynamics');

// ─── Parse WorldState.FlightPlans ─────────────────────────────

function _parseWorldStateFlightPlans(text) {
  const log = (msg) => console.log('[ACL-FP]', msg);
  log('_parseWorldStateFlightPlans() START');
  const fpIdx = text.indexOf('"FlightPlans"');
  log('FlightPlans index: ' + fpIdx);
  if (fpIdx < 0) return null;

  const wsIdx = text.indexOf('"WorldState"');
  log('WorldState index: ' + wsIdx + ', fpIdx < wsIdx? ' + (fpIdx < wsIdx));
  if (wsIdx < 0 || fpIdx < wsIdx) return null;

  const afterFP = text.substring(fpIdx);
  const rcMatch = afterFP.match(/"\$rcontent"\s*:\s*\[/);
  log('$rcontent match: ' + !!rcMatch);
  if (!rcMatch) return null;

  const absRcPos = fpIdx + rcMatch.index + rcMatch[0].length;

  const beforeRcRaw = text.substring(fpIdx, absRcPos);
  const rlMatch = beforeRcRaw.match(/"\$rlength"\s*:\s*(\d+)/);
  const originalLength = rlMatch ? parseInt(rlMatch[1], 10) : 0;
  log('$rlength: ' + originalLength);

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

  const flights = [];
  for (const entry of fpData.fpEntries) {
    const flight = _parseFlightPlanEntry(entry.vBlock);
    if (flight) flights.push(flight);
  }
  log('converted flights: ' + flights.length);

  if (flights.length === 0) return null;
  return { flights, fpData };
}

// ─── Parse single FlightPlanState entry (type 37) ─────────────

function _parseFlightPlanEntry(vBlock) {
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
    return null;
  }

  return f;
}

// ─── Sync flights into FlightPlans ────────────────────────────

function _syncFlightPlans(rawText, flights, fpData, baseDateTicks) {
  if (!fpData || !fpData.fpEntries || fpData.fpEntries.length === 0 || !flights || flights.length === 0) return rawText;
  const bdt = baseDateTicks || FALLBACK_BASE_DATE_TICKS;

  const flightByCallSign = {};
  for (const fl of flights) {
    const cs = (fl.CallSign || '').trim();
    if (cs) flightByCallSign[cs] = fl;
  }

  const newEntryBlocks = [];
  for (const entry of fpData.fpEntries) {
    let newBlock = entry.block;
    const csMatch = entry.vBlock.match(/"CallSign"\s*:\s*"([^"]*)"/);
    if (!csMatch) {
      const regMatch = entry.vBlock.match(/"Registration"\s*:\s*"([^"]*)"/);
      if (!regMatch) { newEntryBlocks.push(newBlock); continue; }
      const reg = regMatch[1];
      const flight = flights.find(f => f._Registration === reg);
      if (flight) newBlock = _applyFlightPlanChanges(newBlock, flight, bdt);
      newEntryBlocks.push(newBlock);
      continue;
    }

    const cs = csMatch[1];
    let flight = flightByCallSign[cs];

    if (!flight) {
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

  const existingCount = fpData.fpEntries.length;
  for (let i = existingCount; i < flights.length; i++) {
    const templateBlock = fpData.fpEntries.length > 0 ? fpData.fpEntries[fpData.fpEntries.length - 1].block : null;
    if (templateBlock) {
      const newBlock = _buildFlightPlanBlock(flights[i], templateBlock, bdt);
      newEntryBlocks.push(newBlock);
    }
  }

  let newBefore = fpData.fpBefore;
  const lenMatch = newBefore.match(/"\$rlength"\s*:\s*(\d+)/);
  if (lenMatch) {
    newBefore = newBefore.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${newEntryBlocks.length}`);
  }

  let finalText = newBefore + '\n                ' + newEntryBlocks.join(',\n                ') + '\n            ]' + fpData.fpAfter;
  return finalText;
}

// ─── Apply flight changes to a FlightPlanState entry ──────────

function _applyFlightPlanChanges(block, flight, baseDateTicks) {
  block = _applyWsField(block, 'Registration', flight._Registration || '', 'string');
  block = _applyWsField(block, 'AircraftType', flight.AircraftType || '', 'string');
  block = _applyWsField(block, 'AirlineName', flight.AirlineName || '', 'string');
  block = _applyWsField(block, 'Voice', flight.Voice || '', 'string');
  block = _applyWsField(block, 'Language', flight.Language || '', 'string');

  const isDeparture = block.indexOf('"Departure"') >= 0 && !block.match(/"Departure"\s*:\s*null/);
  const isArrival = block.indexOf('"Arrival"') >= 0 && !block.match(/"Arrival"\s*:\s*null/);

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

// ─── Build new FlightPlan block from template ─────────────────

function _buildFlightPlanBlock(flight, templateBlock, baseDateTicks) {
  if (!templateBlock) return '{}';
  return _applyFlightPlanChanges(templateBlock, flight, baseDateTicks);
}

// ─── Build FlightPlan Arrival leg (type 58) ───────────────────

function _buildFlightPlanArrivalLeg(flight, id, baseDateTicks) {
  const legId = id + 1;
  const bdt = baseDateTicks || FALLBACK_BASE_DATE_TICKS;
  const cs = (flight.CallSign || '').trim();
  const origin = (flight.DepartureAirport || '');
  const runway = (flight.Runway || '');
  const stand = (flight.Stand || '');
  const star = (flight.Airway || '');
  const landingTicks = timeToTicks(flight.LandingTime || '', bdt);
  const inBlockTicks = timeToTicks(flight.InBlockTime || '', bdt);

  const lines = [];
  lines.push('                            {');
  lines.push(`                                "$id": ${legId},`);
  lines.push('                                "$type": "58|ContextCross.States.FlightPlanArrivalLegState, GroundATC.Core",');
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

function _buildFlightPlanDepartureLeg(flight, id, baseDateTicks) {
  const legId = id + 1;
  const bdt = baseDateTicks || FALLBACK_BASE_DATE_TICKS;
  const cs = (flight.CallSign || '').trim();
  const dest = (flight.ArrivalAirport || '');
  const runway = (flight.Runway || '');
  const stand = (flight.Stand || '');
  const obTicks = timeToTicks(flight.OffBlockTime || '', bdt);
  const totTicks = timeToTicks(flight.TakeoffTime || '', bdt);

  const lines = [];
  lines.push('                            {');
  lines.push(`                                "$id": ${legId},`);
  lines.push('                                "$type": "57|ContextCross.States.FlightPlanDepartureLegState, GroundATC.Core",');
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

// ─── Build complete FlightPlanState dictionary entry ──────────

function _buildFlightPlanStateEntry(flight, entryId, baseDateTicks) {
  const uuid = _generateGuid();
  const bdt = baseDateTicks || FALLBACK_BASE_DATE_TICKS;
  const reg = flight._Registration || flight.Registration || '';
  const acType = flight.AircraftType || '';
  const airline = flight.AirlineName || '';
  const voice = flight.Voice || '';
  const lang = flight.Language || '';

  const isArrival = (flight.isDeparture === false) ||
    (((flight.LandingTime || '').trim() && !(flight.OffBlockTime || '').trim()));

  const lines = [];
  lines.push('                {');
  lines.push(`                    "$k": "${uuid}",`);
  lines.push('                    "$v": {');
  lines.push(`                        "$id": ${entryId},`);
  lines.push('                        "$type": "56|ContextCross.States.FlightPlanState, GroundATC.Core",');
  lines.push(`                        "Guid": "${uuid}",`);
  lines.push('                        "Enabled": true,');
  if (reg) lines.push(`                        "Registration": "${reg}",`);
  else lines.push('                        "Registration": null,');
  lines.push(`                        "AircraftType": "${acType}",`);
  lines.push(`                        "AirlineName": "${airline}",`);
  lines.push(`                        "Voice": "${voice}",`);
  lines.push(`                        "Language": "${lang}",`);

  if (isArrival) {
    lines.push('                        "Arrival":');
    lines.push(_buildFlightPlanArrivalLeg(flight, entryId, bdt));
    lines.push('                        "Departure": null');
  } else {
    lines.push('                        "Arrival": null,');
    lines.push('                        "Departure":');
    lines.push(_buildFlightPlanDepartureLeg(flight, entryId, bdt));
  }

  lines.push('                    }');
  lines.push('                }');
  return lines.join('\n');
}

// ─── Rebuild WorldState.FlightPlans & Aircrafts from scratch ──

function _rebuildWorldStateSections(aclPath, flights, baseDateTicks, dynamicsTemplates, aclcfgStartTime) {
  const log = (msg) => console.log('[ACL-REBUILD]', msg);
  const text = fs.readFileSync(aclPath, 'utf-8');
  const bdt = baseDateTicks || _extractBaseDateFromText(text);
  // Extract ICAO from path: .../Airports/<ICAO>/Levels/...
  const icaoMatch = aclPath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
  const icao = icaoMatch ? icaoMatch[1] : '';
  // Fallback: read startTime from .aclcfg if not passed
  if (!aclcfgStartTime) {
    try {
      const cfgPath = aclPath.replace(/\.acl$/i, '.aclcfg');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        aclcfgStartTime = cfg.startTime || null;
      }
    } catch (_) {}
  }
  log('baseDateTicks: ' + bdt + '  flights: ' + (flights ? flights.length : 0) + ' dynamicsTemplates: ' + (dynamicsTemplates ? Object.keys(dynamicsTemplates).length : 0) + ' startTime: ' + aclcfgStartTime + ' icao: ' + icao);

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

  // 4. Build segments
  let segBefore = text.substring(0, acContentStart);
  let segBetween = text.substring(acContentEnd, fpContentStart);
  const segAfter = text.substring(fpContentEnd);

  // 5. Generate new FlightPlans entries (need to know GUIDs for Aircrafts linking)
  const fpEntries = [];
  const fpGuids = []; // parallel to flights array — GUID used for each FlightPlan
  for (let i = 0; i < flights.length; i++) {
    // Generate GUID first so we can link AircraftState to it
    const fpGuid = _generateGuid();
    fpGuids.push(fpGuid);
    fpEntries.push(_buildFlightPlanStateEntryWithGuid(flights[i], 90000 + i, bdt, fpGuid));
  }
  log('generated ' + fpEntries.length + ' FlightPlan entries');

  // 6. Build Aircrafts entries for arrivals with DynamicsParams templates
  const acEntries = [];
  if (dynamicsTemplates) {
    for (let i = 0; i < flights.length; i++) {
      const fl = flights[i];
      const isArrival = (fl.isDeparture === false) ||
        (((fl.LandingTime || '').trim() && !(fl.OffBlockTime || '').trim()));
      if (!isArrival) continue;

      const star = fl.Airway || '';
      const runway = fl.Runway || '';
      if (!star || !runway) continue;

      const key = star + '|' + runway;
      const template = dynamicsTemplates[key];
      if (!template) {
        log('  no template for "' + key + '", skipping Aircraft entry for Callsign=' + fl.CallSign);
        continue;
      }

      // Compute timeDiff = landingTime - startTime in seconds
      let timeDiff = 0;
      const landing = fl.LandingTime || '';
      const start = aclcfgStartTime || '';
      if (landing && start) {
        const _toSec = (t) => { const p = t.split(':'); return +p[0]*3600 + +p[1]*60 + +p[2]; };
        timeDiff = _toSec(landing) - _toSec(start);
      }
      // Temp validator: skip flights landing within 20 min of game start
      if (timeDiff < 1200) {
        log('  SKIP (td < 20min): Callsign=' + fl.CallSign + ' td=' + timeDiff);
        continue;
      }
      const progressRatio = calcProgressRatio(icao, runway, star, timeDiff);
      log('  build Aircraft entry: Callsign=' + fl.CallSign + ' STAR=' + star + ' RWY=' + runway + ' td=' + timeDiff + ' PR=' + progressRatio);

      if (progressRatio < 0.01) {
        log('  ProgressRatio < 0.01, skipping entry');
        continue;
      }

      const entryText = buildAircraftEntry(template, progressRatio, fpGuids[i]);
      acEntries.push(entryText);
    }
  }
  log('generated ' + acEntries.length + ' Aircraft entries');

  // 7. Update $rlength in Aircrafts
  const acMarker = segBefore.lastIndexOf('"Aircrafts"');
  if (acMarker >= 0) {
    const beforeAc = segBefore.substring(0, acMarker);
    const fromAc = segBefore.substring(acMarker);
    segBefore = beforeAc + fromAc.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${acEntries.length}`);
  }

  // 8. Update $rlength in FlightPlans
  const fpMarker = segBetween.indexOf('"FlightPlans"');
  if (fpMarker >= 0) {
    const beforeFp = segBetween.substring(0, fpMarker);
    const fromFp = segBetween.substring(fpMarker);
    segBetween = beforeFp + fromFp.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${fpEntries.length}`);
  }

  // 9. Assemble and write
  const acContent = acEntries.length > 0
    ? '\n' + acEntries.join(',\n') + '\n            '
    : '';

  const newText =
    segBefore + acContent + ']' +
    segBetween + '\n                ' +
    fpEntries.join(',\n                ') +
    '\n            ]' +
    segAfter;

  fs.writeFileSync(aclPath, newText, 'utf-8');
  log('SUCCESS – file written (' + (newText.length / 1024).toFixed(0) + ' KB)');
}

// ─── Build FlightPlanStateEntry with preset GUID ────────────────

function _buildFlightPlanStateEntryWithGuid(flight, entryId, baseDateTicks, fpGuid) {
  const bdt = baseDateTicks || FALLBACK_BASE_DATE_TICKS;
  const reg = flight._Registration || flight.Registration || '';
  const acType = flight.AircraftType || '';
  const airline = flight.AirlineName || '';
  const voice = flight.Voice || '';
  const lang = flight.Language || '';

  const isArrival = (flight.isDeparture === false) ||
    (((flight.LandingTime || '').trim() && !(flight.OffBlockTime || '').trim()));

  const lines = [];
  lines.push('                {');
  lines.push(`                    "$k": "${fpGuid}",`);
  lines.push('                    "$v": {');
  lines.push(`                        "$id": ${entryId},`);
  lines.push('                        "$type": "56|ContextCross.States.FlightPlanState, GroundATC.Core",');
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
    lines.push(_buildFlightPlanArrivalLeg(flight, entryId, bdt));
    lines.push('                        "Departure": null');
  } else {
    lines.push('                        "Arrival": null,');
    lines.push('                        "Departure":');
    lines.push(_buildFlightPlanDepartureLeg(flight, entryId, bdt));
  }

  lines.push('                    }');
  lines.push('                }');
  return lines.join('\n');
}

module.exports = {
  _parseWorldStateFlightPlans,
  _parseFlightPlanEntry,
  _syncFlightPlans,
  _applyFlightPlanChanges,
  _buildFlightPlanBlock,
  _buildFlightPlanStateEntry,
  _buildFlightPlanArrivalLeg,
  _buildFlightPlanDepartureLeg,
  _rebuildWorldStateSections,
};
