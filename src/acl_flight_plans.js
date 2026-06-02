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

// ─── Rebuild Timeline Sections (WindFrames, WeatherFrames, RunwayTimeline) ──

/** Extract an object section from raw ACL text by brace-matching from sectionKey. */
function _extractSection(text, sectionKey) {
  const idx = text.indexOf('"' + sectionKey + '"');
  if (idx < 0) return null;
  const colonIdx = text.indexOf(':', idx);
  if (colonIdx < 0) return null;
  let braceIdx = colonIdx + 1;
  while (braceIdx < text.length && text[braceIdx] !== '{') braceIdx++;
  if (braceIdx >= text.length) return null;
  const between = text.substring(colonIdx + 1, braceIdx).trim();
  if (between.startsWith('null')) return null;
  let depth = 0, endIdx = braceIdx;
  for (let i = braceIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
  }
  return { start: idx, end: endIdx, content: text.substring(braceIdx, endIdx) };
}

function _parseTypeNum(typeStr) {
  if (!typeStr) return null;
  const m = typeStr.match(/^"?(\d+)/);
  return m ? parseInt(m[1], 10) : null;
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
function _rebuildTimelineSections(aclPath, weatherTimeline, windTimeline, runwayTimeline) {
  const log = (msg) => console.log('[ACL-TIMELINE]', msg);
  let text = fs.readFileSync(aclPath, 'utf-8');

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

  fs.writeFileSync(aclPath, text, 'utf-8');
  log('Timeline sections written to ACL');
}

module.exports = {
  _parseWorldStateFlightPlans,
  _parseFlightPlanEntry,
  _buildFlightPlanArrivalLeg,
  _buildFlightPlanDepartureLeg,
  _rebuildWorldStateSections,
  _rebuildTimelineSections,
  _generateFramesSection,
  _generateRunwayTimelineSection,
};
