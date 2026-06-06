/**
 * ACL Dynamics Templates — capture & build Aircrafts DynamicsParams entries.
 */
const fs = require('fs');
const { _generateGuid } = require('./world_state');
const { scanGameRoot } = require('./scanner');

// ─── calcProgressRatio ─────────────────────────────────────────────

function calcProgressRatio(airport, arrivalRunway, arrivalSTAR, timeDiff) {
  return 0;
}

// ─── Capture ─────────────────────────────────────────────────────

function captureAllDynamicsTemplates(gameRoot) {
  const log = (msg) => console.log('[DYNAMICS]', msg);
  log('captureAllDynamicsTemplates START, root=' + gameRoot);
  const scan = scanGameRoot(gameRoot);
  if (scan.errorCode) { log('scan error: ' + scan.errorCode + (scan.errorPath ? ' ' + scan.errorPath : '')); return {}; }

  const templates = {}; // "STAR|Runway" → { type, vBlock }

  for (const airport of scan.airports) {
    for (const aclFile of airport.aclFiles) {
      try {
        const text = fs.readFileSync(aclFile.path, 'utf-8');
        const fpMap = _parseFlightPlanArrivalData(text);
        if (!fpMap || fpMap.size === 0) continue;
        const entries = _parseAircraftsEntries(text);
        for (const ac of entries) {
          if (ac.fpGuid && fpMap.has(ac.fpGuid)) {
            const ad = fpMap.get(ac.fpGuid);
            if (ad.star && ad.runway) {
              const key = ad.star + '|' + ad.runway;
              if (!templates[key]) {
                let dType = 52;
                if (ac.vBlock.includes('FlyApproachDynamicsParams')) dType = 53;
                templates[key] = { type: dType, vBlock: ac.vBlock };
                log('  NEW [' + airport.icao + '] "' + key + '" type=' + dType);
              }
            }
          }
        }
      } catch (e) {
        log('  ERR ' + aclFile.filename + ': ' + e.message);
      }
    }
  }
  log('DONE — ' + Object.keys(templates).length + ' templates');
  return templates;
}

// ─── Build ───────────────────────────────────────────────────────

function buildAircraftEntry(template, progressRatio, flightPlanGuid) {
  const newGuid = _generateGuid();

  // Clone template $v block with new UUIDs
  let vText = template.vBlock;

  // Replace all Guid values (the parent Guid and FlightPlanGuid)
  // Pattern: "Guid": "any-uuid"
  vText = vText.replace(/"Guid"\s*:\s*"[^"]*"/g, `"Guid": "${newGuid}"`);
  vText = vText.replace(/"FlightPlanGuid"\s*:\s*"[^"]*"/g, `"FlightPlanGuid": "${flightPlanGuid}"`);
  vText = vText.replace(/"OnBoardFlightPlanGuid"\s*:\s*"[^"]*"/g, `"OnBoardFlightPlanGuid": "${flightPlanGuid}"`);

  // Update $id — increment all $id fields to avoid collisions
  // Simple: replace "$id": NNNN, with "$id": NNNN+100000,
  vText = vText.replace(/"\$id"\s*:\s*(\d+)/g, (m, n) => `"$id": ${parseInt(n, 10) + 100000}`);

  // Force DynamicsParams $type to ApproachDynamicsParams (50)
  vText = vText.replace(
    /"\$type"\s*:\s*"[^"]*ContextCross\.Dynamics\.States\.[^"]*"/g,
    '"$type": "50|ContextCross.Dynamics.States.ApproachDynamicsParams, GroundATC.Core"'
  );

  // Update ProgressRatio
  vText = vText.replace(/"ProgressRatio"\s*:\s*[\d.eE+-]+/g, `"ProgressRatio": ${progressRatio}`);

  // Reset DynamicsState to 0, TaxiSpeed to 0, etc.
  vText = vText.replace(/"DynamicsState"\s*:\s*\d+/g, '"DynamicsState": 0');
  vText = vText.replace(/"TaxiSpeed"\s*:\s*[\d.eE+-]+/g, '"TaxiSpeed": 0');
  vText = vText.replace(/"ForwardSpeed"\s*:\s*(true|false)/g, '"ForwardSpeed": false');
  vText = vText.replace(/"TargetTaxiSpeed"\s*:\s*[\d.eE+-]+/g, '"TargetTaxiSpeed": 0');
  vText = vText.replace(/"FrontWheelSteeringAngle"\s*:\s*[\d.eE+-]+/g, '"FrontWheelSteeringAngle": 0');

  return '                {\n                    "$k": "' + newGuid + '",\n                    "$v": ' + vText + '\n                }';
}

// ─── Internal: parse FlightPlans → guid → {star, runway} ─────────

function _parseFlightPlanArrivalData(text) {
  const map = new Map();
  const fpIdx = text.indexOf('"FlightPlans"');
  const wsIdx = text.indexOf('"WorldState"');
  if (fpIdx < 0 || wsIdx < 0) return map;

  const afterFP = text.substring(fpIdx);
  const rcMatch = afterFP.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return map;

  const absRc = fpIdx + rcMatch.index + rcMatch[0].length;
  const endPos = _findArrayEnd(text, absRc);
  if (!endPos) return map;

  const arr = text.substring(absRc, endPos);
  let depth = 0, start = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (arr[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const block = arr.substring(start, i + 1);
        const vIdx = block.indexOf('"$v"');
        if (vIdx >= 0) {
          const colon = block.indexOf(':', vIdx);
          const brace = block.indexOf('{', colon);
          let vd = 1, ve = brace + 1;
          for (; ve < block.length; ve++) {
            if (block[ve] === '{') vd++;
            else if (block[ve] === '}') { vd--; if (vd === 0) break; }
          }
          const vBlock = block.substring(brace, ve + 1);
          const g = vBlock.match(/"Guid"\s*:\s*"([^"]+)"/);
          const aM = vBlock.match(/"Arrival"\s*:\s*\{/);
          if (g && aM) {
            const aS = aM.index + aM[0].length;
            let ad = 1, ae = aS;
            for (; ae < vBlock.length; ae++) {
              if (vBlock[ae] === '{') ad++;
              else if (vBlock[ae] === '}') { ad--; if (ad === 0) break; }
            }
            const aObj = vBlock.substring(aS, ae);
            const s = aObj.match(/"STAR"\s*:\s*"([^"]*)"/);
            const r = aObj.match(/"Runway"\s*:\s*"([^"]*)"/);
            if (s && r) map.set(g[1], { star: s[1], runway: r[1] });
          }
        }
        start = -1;
      }
    }
  }
  return map;
}

// ─── Internal: parse Aircrafts → [{fpGuid, vBlock}] ─────────────

function _parseAircraftsEntries(text) {
  const entries = [];
  const wsIdx = text.indexOf('"WorldState"');
  if (wsIdx < 0) return entries;
  const wsText = text.substring(wsIdx);
  const acIdx = wsText.indexOf('"Aircrafts"');
  if (acIdx < 0) return entries;

  const acSect = wsText.substring(acIdx);
  const rcMatch = acSect.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return entries;

  const absRc = wsIdx + acIdx + rcMatch.index + rcMatch[0].length;
  const endPos = _findArrayEnd(text, absRc);
  if (!endPos) return entries;

  const arr = text.substring(absRc, endPos);
  let depth = 0, start = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (arr[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const block = arr.substring(start, i + 1);
        if (block.includes('"$type": 35,') || block.includes('"$type": "35|')) {
          const fpg = block.match(/"FlightPlanGuid"\s*:\s*"([^"]+)"/);
          const vIdx = block.indexOf('"$v"');
          if (vIdx >= 0) {
            const colon = block.indexOf(':', vIdx);
            const brace = block.indexOf('{', colon);
            let vd = 1, ve = brace + 1;
            for (; ve < block.length; ve++) {
              if (block[ve] === '{') vd++;
              else if (block[ve] === '}') { vd--; if (vd === 0) break; }
            }
            entries.push({
              fpGuid: fpg ? fpg[1] : null,
              vBlock: block.substring(brace, ve + 1), // the content inside $v: { ... }
            });
          }
        }
        start = -1;
      }
    }
  }
  return entries;
}

// ─── Internal: find outermost array end bracket ────────────────────

function _findArrayEnd(text, startPos) {
  let depth = 0;
  for (let i = startPos; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
        if (j < text.length && text[j] === ']') return j + 1;
      }
    } else if (c === ']' && depth === 0) return i + 1;
  }
  return null;
}

module.exports = {
  calcProgressRatio,
  captureAllDynamicsTemplates,
  buildAircraftEntry,
};
