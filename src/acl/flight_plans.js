/**
 * ACL FlightPlans parser — new game format (type 37/52), ArrivalLeg (type 58), DepartureLeg (type 57).
 */
const fs = require('fs');
const path = require('path');
import { FALLBACK_BASE_DATE_TICKS } from './constants';
const { ticksToTime, timeToTicks, _extractBaseDateFromText } = require('../utils/timeUtils');
const { _generateGuid } = require('./world_state');
const { computeProgressRatio, resolveFlyApproachPoints, buildApproachAircraftBlock, buildAnimatorBlock } = require('./approach');

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
  const text = fs.readFileSync(aclPath, 'utf-8');
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
  const typeMap = new Map();
  const typeDeclRegex = /"\$type":\s*"(\d+)\|([^"]+)"/g;
  let tdMatch;
  while ((tdMatch = typeDeclRegex.exec(text)) !== null) {
    const num = parseInt(tdMatch[1], 10);
    // First declaration wins — earliest in file is canonical
    if (!typeMap.has(num)) {
      typeMap.set(num, tdMatch[2]);
    }
  }
  log('typeMap: ' + typeMap.size + ' type declarations');

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

  // Extract type numbers from original FlightPlans $rcontent.
  // Unity's JSON serializer assigns type numbers per-file — they are NOT
  // consistent across airports or even levels. Hardcoding them causes type-ID
  // conflicts (e.g., Dictionary and FlightPlanState both claiming type 56).
  // We extract the canonical numbers from the original file's first full
  // declarations so regenerated entries use the correct IDs.
  const _origFpContent = text.substring(fpContentStart, fpContentEnd);
  // Escape for regex literal: only . and \ need escaping in .NET type names
  const _escapeRegex = (s) => s.replace(/[.\\]/g, '\\$&');
  const _extractTypeNum = (namespaceName) => {
    // Match: "$type": "N|NamespaceName, GroundATC.Core"
    // The type name is followed by ", GroundATC.Core" — this anchors us to the
    // exact type, not a longer type that contains namespaceName as a substring
    // (e.g. Dictionary`2[[...],[FlightPlanState, ...]]).
    const pat = '"\\$type":\\s*"(\\d+)\\|' + _escapeRegex(namespaceName) + ',\\s*GroundATC\\.Core"';
    const re = new RegExp(pat);
    const m = _origFpContent.match(re);
    return m ? parseInt(m[1], 10) : null;
  };
  const _fpTypeNum = _extractTypeNum('ContextCross.States.FlightPlanState') || 56;
  const _fpArrTypeNum = _extractTypeNum('ContextCross.States.FlightPlanArrivalLegState') || 58;
  const _fpDepTypeNum = _extractTypeNum('ContextCross.States.FlightPlanDepartureLegState') || 57;
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
    fpEntries.push(_buildFlightPlanStateEntryWithGuid(flights[i], 90000 + i, bdt, fpGuid, _fpTypeNum, _fpArrTypeNum, _fpDepTypeNum));
  }
  log('generated ' + fpEntries.length + ' FlightPlan entries');

  // 6. Generate Aircrafts entries — only State=30 approach aircraft
  // Non-approach entries (State 10/31/5) are NOT preserved: their FlightPlanGuids
  // become stale when FlightPlans are regenerated with new GUIDs.

  // Detect AircraftState $type number from original file (ZSJN=33, KJFK=35)
  // Find the first $v block containing State=30 and extract its first $type
  const _existingAcContent = text.substring(acContentStart, acContentEnd);
  let _acTypeNum = 33; // default ZSJN
  const _st30Block = _existingAcContent.match(/"\$v":\s*\{[\s\S]{0,300}?"\$type":\s*(\d+)[\s\S]{0,500}?"State":\s*30\b/);
  if (_st30Block) _acTypeNum = parseInt(_st30Block[1], 10);

  // Extract the Approach radio channel GUID from the Channels section.
  // We previously tried to extract it from the Aircrafts section, but that fails
  // when the first State=30 entry is a taxiing aircraft (RadioChannelGuid: null)
  // or on re-saves (all RadioChannelGuid values already empty).
  // The Channels section lives in segAfter and is always preserved verbatim.
  const _radioChannelGuid = _extractAppChannelGuid(segAfter);

  const acEntries = [];
  const animEntries = [];
  if (approachCache && approachCache.appPointMap && approachCache.specDB) {
    // saveTime = scenario start (gameplay begins at Config.startTime + warmup)
    // The game fast-forwards from startTime through warmup before showing the player
    const _toSec = (t) => { const p = String(t).split(':'); return +p[0]*3600 + +p[1]*60 + (+p[2]||0); };
    const startSec = aclcfgStartTime ? _toSec(aclcfgStartTime) : 0;
    const WARMUP_SEC = 780; // 13 min — game advances from Config.startTime to first flight time
    const saveSec = (_saveSec != null) ? _saveSec : startSec + WARMUP_SEC;
    log('saveTime=' + saveSec + 's (' + (_saveSec != null ? 'from file' : 'startTime=' + startSec + 's +13min warmup') + ')');

    for (let i = 0; i < flights.length; i++) {
      const fl = flights[i];
      const isArrival = (fl.isDeparture === false) ||
        (((fl.LandingTime || '').trim() && !(fl.OffBlockTime || '').trim()));
      if (!isArrival) continue;

      const star = fl.Airway || '';
      const runway = fl.Runway || '';
      if (!star || !runway) continue;

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
      const progressRatio = 1.0 - (timeToLanding / totalApproachTime);

      // Gate: only generate if aircraft is mid-approach at snapshot time
      if (progressRatio <= 0.0) {
        log('  SKIP (PR=' + progressRatio.toFixed(3) + ' ≤ 0, not started approach): ' + fl.CallSign);
        continue;
      }
      if (progressRatio >= 1.0) {
        log('  SKIP (PR=' + progressRatio.toFixed(3) + ' ≥ 1, already landed): ' + fl.CallSign);
        continue;
      }

      // Resolve FlyApproachPathPointList from SceneryData in the ACL text
      const flyPoints = resolveFlyApproachPoints(text, star, runway);
      if (!flyPoints || flyPoints.length === 0) {
        log('  could not resolve FlyApproach points for ' + star + '/' + runway + ', skipping');
        continue;
      }

      log('  build Aircraft entry: ' + fl.CallSign + ' ' + star + '/' + runway +
          ' td=' + timeToLanding + 's PR=' + progressRatio.toFixed(3) +
          ' flyPts=' + flyPoints.length + ' appPts=' + appPoints.length);

      const result = buildApproachAircraftBlock({
        flightPlanGuid: fpGuids[i],
        route: star,
        flyPoints: flyPoints,
        appPoints: appPoints,
        progressRatio: progressRatio,
        spec: spec,
        radioChannelGuid: _radioChannelGuid,
        nextId: 70000 + i * 1000,
        acTypeNum: _acTypeNum,
      });
      // Wrap in $k/$v dictionary entry format to match original file
      const entry = '{"$k": "' + result.guid + '", "$v": ' + result.block + '}';
      acEntries.push(entry);

      // Generate matching AircraftAnimators entry
      const animResult = buildAnimatorBlock(result.guid, {
        nextId: 80000 + i * 100,
        acTypeNum: _acTypeNum,
      });
      const animEntry = '{"$k": "' + animResult.guid + '", "$v": ' + animResult.block + '}';
      animEntries.push(animEntry);
    }
  }
  log('generated ' + acEntries.length + ' Aircraft entries + ' + animEntries.length + ' Animator entries');

  // 6b. Expand short-form $type references in preserved segments.
  // The regenerated Aircrafts/FlightPlans sections use full-form types, but
  // segBefore and segAfter (copied verbatim from the original file) may contain
  // short-form "$type": N references to types whose full declarations were in
  // the now-replaced Aircrafts $rcontent. Expanding them to full form ensures
  // the game's JSON deserializer can resolve every type in the output file.
  if (typeMap.size > 0) {
    segBefore = _expandShortFormTypes(segBefore, typeMap);
    preAnimators = _expandShortFormTypes(preAnimators, typeMap);
    postAnimators = _expandShortFormTypes(postAnimators, typeMap);
    segAfter = _expandShortFormTypes(segAfter, typeMap);
    log('Expanded short-form $type refs in preserved segments');
  }

  // Reset docking state on Jetways entries that reference old aircraft GUIDs.
  // The Aircrafts section is rebuilt with new GUIDs, so DockingAircraftGuid
  // values in the preserved Jetways section become orphaned and cause
  // NullReferenceException in the game. Must run unconditionally.
  segAfter = _resetJetwayDockingState(segAfter, log);

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

  const newText =
    segBeforeMod + acContent + ']' +
    preAnimators + animContent + ']' +
    segBetweenMod + '\n                ' +
    fpEntries.join(',\n                ') +
    '\n            ]' +
    segAfter;

  fs.writeFileSync(aclPath, newText, 'utf-8');
  log('SUCCESS – file written (' + (newText.length / 1024).toFixed(0) + ' KB)');
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

/** Extract level config (startTime, endTime, file paths) from ACL's Config block. */
function _extractConfig(aclText) {
  const sec = _extractSection(aclText, 'Config');
  if (!sec) { console.log('[CONFIG-EXTRACT] Config section NOT FOUND in ACL text (len=' + (aclText ? aclText.length : 0) + ')'); return null; }
  // Use regex extraction instead of JSON.parse — the Unity-serialized Config block
  // may contain non-standard JSON (unquoted keys, trailing commas, NaN, etc.)
  const getStr = (name) => {
    const re = new RegExp('"' + name + '"\\s*:\\s*"([^"]*)"');
    const m = sec.content.match(re);
    return m ? m[1] : null;
  };
  const result = {
    startTime: getStr('startTime'),
    endTime: getStr('endTime'),
    flightScheduleFile: getStr('flightScheduleFile'),
    runwayTimelineFile: getStr('runwayTimelineFile'),
  };
  console.log('[CONFIG-EXTRACT] startTime=' + result.startTime + ' endTime=' + result.endTime + ' flightScheduleFile=' + result.flightScheduleFile + ' runwayTimelineFile=' + result.runwayTimelineFile);
  return result;
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
    // Check for Type=5 (Approach) or ShortCode "APP"
    if (/"Type":\s*5\b/.test(block) || /"ShortCode":\s*"APP"/.test(block)) {
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

// ─── Parse timeline sections from ACL text ────────────────────

/** Parse $rcontent entries from a frames section (WeatherFrames/WindFrames). */
function _parseFramesSection(sectionContent) {
  if (!sectionContent) return [];
  const entries = [];
  const rcIdx = sectionContent.indexOf('"$rcontent"');
  if (rcIdx < 0) return entries;
  const colonIdx = sectionContent.indexOf(':', rcIdx);
  const bracketIdx = sectionContent.indexOf('[', colonIdx);
  if (bracketIdx < 0) return entries;

  let depth = 0, blockStart = -1;
  for (let i = bracketIdx + 1; i < sectionContent.length; i++) {
    if (sectionContent[i] === '{') {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (sectionContent[i] === '}') {
      depth--;
      if (depth === 0 && blockStart >= 0) {
        const block = sectionContent.substring(blockStart, i + 1);
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
        blockStart = -1;
      }
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

module.exports = {
  _parseWorldStateFlightPlans,
  _parseFlightPlanEntry,
  _buildFlightPlanArrivalLeg,
  _buildFlightPlanDepartureLeg,
  _rebuildWorldStateSections,
  _rebuildTimelineSections,
  _extractSection, _extractConfig,
  _generateFramesSection,
  _generateRunwayTimelineSection,
  _parseWeatherFrames,
  _parseWindFrames,
  _parseRunwayTimeline,
};
