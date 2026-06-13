/**
 * Approach AircraftState constructor — builds State=30 (Flying/Approach) entries.
 *
 * Implements verified findings from 8 production .acl file audit (ZSJN + KJFK):
 *   - Specification is fixed per Designator (extractable from any .acl)
 *   - AppPointList = f(Route, Runway) — fixed mapping, confirmed on 34 aircraft
 *   - FlyApproachPathPointList = AirwayNode Positions via STAR GUID chain
 *   - ProgressRatio = 1 − (LandingTime − saveTime) / totalApproachTime(Route)
 *   - Position = interpolated along FlyApproach + App combined path
 *   - Direction = path tangent at current position
 */

const { createTokenizer } = require('./tokenizer');
const { preprocessUnityJson } = require('./acl_json');
const { APPROACH_EFFECTIVE_SPEED, APPROACH_SPEED_MS, DEFAULT_AIRPORT_SCALE, APPROACH_CEILING_M } = require('./constants');

// ─── GUID generator (inlined to avoid ESM import chain issues in tests) ──

let _cryptoRandomUUID;
try { _cryptoRandomUUID = require('crypto').randomUUID; } catch (_) {}

function _generateGuid() {
  if (_cryptoRandomUUID) return _cryptoRandomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── Vector math helpers ──────────────────────────────────────────

function _vec3Sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function _vec3Add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function _vec3Scale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function _vec3Length(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function _vec3Normalize(v) {
  const len = _vec3Length(v);
  if (len < 1e-12) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function _vec3Dist(a, b) {
  return _vec3Length(_vec3Sub(a, b));
}

// ─── Runway name normalization ──────────────────────────────────

/**
 * Normalize a runway name by stripping leading zeros from the numeric portion.
 * "01" → "1", "01L" → "1L", "19" → "19", "19R" → "19R"
 * Returns the original string if it doesn't match the runway format.
 * Idempotent — normalizing an already-normalized name is a no-op.
 */
function _normalizeRunway(name) {
  if (!name) return name;
  const match = name.match(/^0*(\d+)([LCR]?)$/);
  if (match) {
    return match[1] + (match[2] || '');
  }
  return name;
}

// ─── ACL text parsing helpers ─────────────────────────────────────

// ═══ Shared ACL text parsing helpers ══════════════════════════════
// These were previously duplicated across approach.js and flight_plans.js.
// They now delegate to the string-aware tokenizer to avoid the
// "brace-in-string" fragility.

function _findArrayEnd(text, startPos) {
  const t = createTokenizer(text);
  return t.findArrayEnd(startPos);
}

function _extractValueBlock(block) {
  const t = createTokenizer(block);
  const vSec = t.findSection('$v');
  if (!vSec) return null;
  return t.substring(vSec.valueStart, vSec.valueEnd);
}

function _extractNestedObject(text, key) {
  const t = createTokenizer(text);
  const sec = t.findSection(key);
  if (!sec) return null;
  return t.substring(sec.valueStart, sec.valueEnd);
}

function _extractFloat(text, key) {
  const re = new RegExp('"' + key + '"\\s*:\\s*([\\d.eE+\\-]+)');
  const m = text.match(re);
  return m ? parseFloat(m[1]) : null;
}

function _extractInt(text, key) {
  // Try direct: "key": value
  let re = new RegExp('"' + key + '"\\s*:\\s*(-?\\d+)');
  let m = text.match(re);
  if (m) return parseInt(m[1], 10);
  // Try DateTime format: "key": { "$type": 3, value }
  re = new RegExp('"' + key + '"\\s*:\\s*\\{\\s*"\\$type"\\s*:\\s*3\\s*,\\s*(-?\\d+)\\s*\\}');
  m = text.match(re);
  if (m) return parseInt(m[1], 10);
  return null;
}

function _extractString(text, key) {
  const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"');
  const m = text.match(re);
  return m ? m[1] : null;
}

function _extractVector3(objText) {
  // The Position or Direction in AircraftState is a direct Vector3: { "x": 1.0, "y": 0, "z": 2.0 }
  // or "$type": 16, x, y, z format
  const m16 = objText.match(/"\$type"\s*:\s*(?:16|"16\|[^"]+")\s*,\s*([\d.eE+\-]+)\s*,\s*([\d.eE+\-]+)\s*,\s*([\d.eE+\-]+)/);
  if (m16) return { x: parseFloat(m16[1]), y: parseFloat(m16[2]), z: parseFloat(m16[3]) };
  // Try "x":, "y":, "z": format (float3 type 35)
  const xm = objText.match(/"x"\s*:\s*([\d.eE+\-]+)/);
  const ym = objText.match(/"y"\s*:\s*([\d.eE+\-]+)/);
  const zm = objText.match(/"z"\s*:\s*([\d.eE+\-]+)/);
  if (xm && ym && zm) return { x: parseFloat(xm[1]), y: parseFloat(ym[1]), z: parseFloat(zm[1]) };
  return null;
}

function _extractVector3Array(text, key) {
  // Find array of Vector3 under key
  const idx = text.indexOf('"' + key + '"');
  if (idx < 0) return null;
  const rcMatch = text.substring(idx).match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return null;
  const absRc = idx + rcMatch.index + rcMatch[0].length;
  const endPos = _findArrayEnd(text, absRc);
  if (!endPos) return null;

  const arr = text.substring(absRc, endPos);
  const points = [];
  // Each Vector3: integer format { "$type": 16, x, 0.0, z } or namespace format
  const vecRe = /\{\s*"\$type"\s*:\s*(?:16|"16\|[^"]+")\s*,\s*([\d.eE+\-]+)\s*,\s*([\d.eE+\-]+)\s*,\s*([\d.eE+\-]+)\s*\}/g;
  let m;
  while ((m = vecRe.exec(arr)) !== null) {
    points.push({ x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) });
  }
  return points.length > 0 ? points : null;
}

// ─── 1. Specification DB ──────────────────────────────────────────

/**
 * Extract a complete Designator → AircraftSpecificationState mapping from ACL text.
 * Returns Map<string, object> where keys are Designator codes (e.g., "B738").
 */
function extractSpecificationDB(aclText) {
  const db = new Map();
  const acEntries = _parseAircraftEntries(aclText);

  for (const entry of acEntries) {
    const vBlock = entry.vBlock;
    // Look for Specification sub-object
    const specObj = _extractNestedObject(vBlock, 'Specification');
    if (!specObj) continue;

    const des = _extractString(specObj, 'Designator');
    if (!des || db.has(des)) continue; // already collected

    const spec = {
      Designator: des,
      AerodromeCode: _extractInt(specObj, 'AerodromeCode') || 67,
      WakeTurbulenceCategory: _extractInt(specObj, 'WakeTurbulenceCategory') || 77,
      WheelBase: _extractFloat(specObj, 'WheelBase') || 0,
      WingSpan: _extractFloat(specObj, 'WingSpan') || 0,
      RunwayVRSpeed: _extractInt(specObj, 'RunwayVRSpeed') || 140,
      RunwayTakeOffLength: _extractInt(specObj, 'RunwayTakeOffLength') || 2000,
      ModelOffset: _extractVector3(specObj) || { x: 0.19, y: -0.05, z: -0.20 },
      DockingPositions: _extractVector4Array(specObj, 'DockingPositions') || [],
    };
    db.set(des, spec);
  }
  return db;
}

function _extractVector4Array(text, key) {
  const idx = text.indexOf('"' + key + '"');
  if (idx < 0) return null;
  const rcMatch = text.substring(idx).match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return null;
  const absRc = idx + rcMatch.index + rcMatch[0].length;
  const endPos = _findArrayEnd(text, absRc);
  if (!endPos) return null;

  const arr = text.substring(absRc, endPos);
  const results = [];
  // Vector4: { "$type": 37, a, b, c, d }
  const v4Re = /\{\s*"\$type"\s*:\s*(?:37|39|"37\|[^"]+"|"39\|[^"]+")\s*,\s*([\d.eE+\-]+)\s*,\s*([\d.eE+\-]+)\s*,\s*([\d.eE+\-]+)\s*,\s*([\d.eE+\-]+)\s*\}/g;
  let m;
  while ((m = v4Re.exec(arr)) !== null) {
    results.push({ x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]), w: parseFloat(m[4]) });
  }
  return results;
}

// ─── 2. Approach Data Extraction ─────────────────────────────────

/**
 * Extract all State=30 approach aircraft data from ACL text.
 * Returns array of { guid, route, runway, flightPlanGuid, progressRatio, landingTimeTicks,
 *                     flyApproachPoints, appPoints, designator, callsign, direction, position }
 */
function extractApproachData(aclText) {
  const results = [];
  const fpMap = _parseFlightPlanData(aclText); // guid → { star, runway, landingTimeTicks, callsign }
  const acEntries = _parseAircraftEntries(aclText); // all aircraft

  for (const entry of acEntries) {
    const vBlock = entry.vBlock;
    const state = _extractInt(vBlock, 'State');
    if (state !== 30) continue;

    const fpGuid = _extractString(vBlock, 'FlightPlanGuid');
    const route = _extractString(vBlock, 'Route') || '';
    const fpData = fpGuid ? fpMap.get(fpGuid) : null;

    // Extract FlyApproachPathPointList from DynamicsParams
    const dpObj = _extractNestedObject(vBlock, 'DynamicsParams');
    const flyPoints = dpObj ? _extractVector3Array(dpObj, 'FlyApproachPathPointList') : null;
    const appPoints = dpObj ? _extractVector3Array(dpObj, 'AppPointList') : null;
    const progressRatio = dpObj ? _extractFloat(dpObj, 'ProgressRatio') : 0;

    // Extract Specification for Designator
    const specObj = _extractNestedObject(vBlock, 'Specification');
    const designator = specObj ? _extractString(specObj, 'Designator') : '';

    // Extract Position (nested object) and Direction (direct Vector3 in vBlock)
    const posObj = _extractNestedObject(vBlock, 'Position');
    const position = posObj ? _extractVector3(posObj) : null;
    const dirObj = _extractNestedObject(vBlock, 'Direction');
    const direction = dirObj ? _extractVector3(dirObj) : null;

    results.push({
      guid: entry.guid,
      route: route,
      runway: fpData ? fpData.runway : '',
      flightPlanGuid: fpGuid,
      progressRatio: progressRatio || 0,
      landingTimeTicks: fpData ? fpData.landingTimeTicks : 0,
      flyApproachPoints: flyPoints || [],
      appPoints: appPoints || [],
      designator: designator,
      callsign: fpData ? fpData.callsign : '',
      direction: direction || { x: 0, y: 0, z: 1 },
      position: position || { x: 0, y: APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE, z: 0 },
    });
  }

  return results;
}

// ─── 2b. State=5 Data Extraction ────────────────────────────────

/**
 * Extract all State=5 (Sub-type A: in-air, on Tower frequency) aircraft data from ACL text.
 * Only returns entries that have ApproachDynamicsParams (DynamicsParams present, no
 * TaxiArrivalToHoldingPointPath) — these are aircraft still in the air after handoff.
 *
 * Returns array of { route, runway, touchDownPosition, approachDirection,
 *                     initialPosition, pathPointList }
 */
function extractState5Data(aclText) {
  const results = [];
  const fpMap = _parseFlightPlanData(aclText);
  const acEntries = _parseAircraftEntries(aclText);

  for (const entry of acEntries) {
    const vBlock = entry.vBlock;
    const state = _extractInt(vBlock, 'State');
    if (state !== 5) continue;

    // Sub-type A check: must have DynamicsParams (ApproachDynamicsParams)
    const disObj = _extractNestedObject(vBlock, 'DynamicInternalState');
    if (!disObj) continue;
    const dpObj = _extractNestedObject(disObj, 'DynamicsParams');
    if (!dpObj) continue; // Sub-type B has no DynamicsParams — skip

    // Must NOT have TaxiArrivalToHoldingPointPath (would be Sub-type B)
    // _extractNestedObject returns the raw text — check for non-null object
    const taxiPathRaw = _extractNestedObject(disObj, 'TaxiArrivalToHoldingPointPath');
    if (taxiPathRaw && taxiPathRaw.trim() !== 'null') continue;

    const route = _extractString(vBlock, 'Route') || '';
    const fpGuid = _extractString(vBlock, 'FlightPlanGuid');
    const fpData = fpGuid ? fpMap.get(fpGuid) : null;
    const runway = fpData ? fpData.runway : '';

    // Must have at least a runway — can't key into cache otherwise
    if (!runway) continue;

    // Extract ApproachDynamicsParams fields
    const tdObj = _extractNestedObject(dpObj, 'TouchDownPosition');
    const touchDownPosition = tdObj ? _extractVector3(tdObj) : null;
    const adObj = _extractNestedObject(dpObj, 'ApproachDirection');
    const approachDirection = adObj ? _extractVector3(adObj) : null;
    const ipObj = _extractNestedObject(dpObj, 'InitialPosition');
    const initialPosition = ipObj ? _extractVector3(ipObj) : null;
    const pathPointList = _extractVector3Array(dpObj, 'PathPointList') || [];

    if (!touchDownPosition || !approachDirection || !initialPosition || pathPointList.length === 0) continue;

    results.push({
      route,
      runway,
      touchDownPosition,
      approachDirection,
      initialPosition,
      pathPointList,
    });
  }

  return results;
}

/**
 * Build Map<(route, runway), State5Params> from extracted State=5 data.
 * Stores entries under BOTH keys:
 *   1. "<approach-route>|<runway>" — the State=5 Route field (e.g. "RNAV ILS Z Rwy 19|19")
 *   2. "<runway>" — runway-only key, for lookup during save when we only have the runway
 * First occurrence wins for each key.
 */
function buildState5ParamsMap(state5Entries) {
  const map = new Map();
  for (const entry of state5Entries) {
    if (!entry.runway) continue;
    const runwayKey = entry.runway; // Each runway maps to exactly one approach procedure
    const params = {
      touchDownPosition: entry.touchDownPosition,
      approachDirection: entry.approachDirection,
      initialPosition: entry.initialPosition,
      pathPointList: entry.pathPointList,
    };
    // Always store by runway (primary lookup during save since STAR ≠ approach route name)
    if (!map.has(runwayKey)) {
      map.set(runwayKey, params);
    }
    // Also store by route|runway if route is non-empty (for completeness)
    if (entry.route) {
      const routeKey = entry.route + '|' + entry.runway;
      if (!map.has(routeKey)) {
        map.set(routeKey, params);
      }
    }
  }
  return map;
}

// ─── 3. Build (Route, Runway) → AppPointList Map ─────────────────

/**
 * Build Map<(route, runway), AppPointList> from extracted approach data.
 * Uses first occurrence for each (route, runway) — verified consistent across all 34 aircraft.
 */
function buildAppPointMap(approachEntries) {
  const map = new Map();
  for (const entry of approachEntries) {
    if (!entry.route || !entry.runway || !entry.appPoints || entry.appPoints.length === 0) continue;
    const key = entry.route + '|' + entry.runway;
    if (!map.has(key)) {
      map.set(key, entry.appPoints);
    }
  }
  return map;
}

// ─── 4. Compute totalApproachTime per Route ──────────────────────

/**
 * Compute totalApproachTime for each Route using dTime/dPR.
 * Groups entries by (groupId, route) to ensure pairs share the same save context.
 * totalApproachTime = median of (LT_B − LT_A) / (PR_B − PR_A) across all within-group pairs.
 *
 * @param {Array} approachEntries - from extractApproachData
 * @param {Function} [getGroupId] - optional grouping function, default uses no grouping
 * @returns {Map<string, number>} Route name → totalApproachTime (seconds)
 */
function computeTotalApproachTimes(approachEntries, getGroupId) {
  // Group by Route first, then within each Route by groupId
  const routeGroups = new Map();
  for (const entry of approachEntries) {
    if (!entry.route) continue;
    if (!routeGroups.has(entry.route)) routeGroups.set(entry.route, []);
    routeGroups.get(entry.route).push(entry);
  }

  const result = new Map();
  for (const [route, entries] of routeGroups) {
    // Further group by groupId if provided
    let subGroups;
    if (getGroupId) {
      subGroups = new Map();
      for (const e of entries) {
        const gid = getGroupId(e);
        if (!subGroups.has(gid)) subGroups.set(gid, []);
        subGroups.get(gid).push(e);
      }
    } else {
      subGroups = new Map([['all', entries]]);
    }

    const ratios = [];
    for (const [gid, groupEntries] of subGroups) {
      if (groupEntries.length < 2) continue;
      for (let i = 0; i < groupEntries.length; i++) {
        for (let j = i + 1; j < groupEntries.length; j++) {
          const dPR = Math.abs(groupEntries[i].progressRatio - groupEntries[j].progressRatio);
          const dLT = Math.abs(groupEntries[i].landingTimeTicks - groupEntries[j].landingTimeTicks);
          if (dPR > 0.001 && dLT > 0) {
            const dSeconds = dLT / 10000000;
            ratios.push(dSeconds / dPR);
          }
        }
      }
    }

    if (ratios.length > 0) {
      ratios.sort((a, b) => a - b);
      const median = ratios[Math.floor(ratios.length / 2)];
      result.set(route, Math.round(median));
    } else {
      result.set(route, 1600); // default ~26-27 min
    }
  }

  return result;
}

/**
 * Compute totalApproachTimes from SceneryData path lengths.
 *
 * For STARs that already have an aircraft-derived TAT in refTatMap, that value is
 * preserved (it's the most accurate). For STARs without, estimates TAT using the
 * path-length ratio from a reference STAR on the same runway:
 *
 *   estTAT = refTAT × (totalPathLen / refPathLen)
 *
 * where refTAT is the aircraft-derived TAT for the reference STAR, and path lengths
 * are computed from SceneryData (FlyApproach + AppPointList).
 *
 * Falls back to defaultTAT (1600s) when no reference STAR exists for a runway.
 */
function computeApproachTimesFromScenery(aclText, starMappings, appPointMap, refTatMap, defaultTAT, airportScale) {
  const result = new Map();
  const fallbackTAT = defaultTAT || 1600;

  if (!aclText || !starMappings || !starMappings.starRunwayMap) return result;

  // First, copy aircraft-derived TATs (most accurate)
  if (refTatMap) {
    for (const [star, tat] of refTatMap) {
      result.set(star, tat);
    }
  }

  // Then fill missing STARs using path-length ratios from reference STARs on the same runway
  for (const [starName, runways] of Object.entries(starMappings.starRunwayMap)) {
    if (result.has(starName)) continue; // already have aircraft-derived TAT

    let bestTAT = 0;
    for (const runway of runways) {
      // Compute full terminal path (FlyApproach + procedure + touchdown distance)
      const pathInfo = computeFullTerminalPath(aclText, starName, runway);
      const totalLen = pathInfo.total;
      if (totalLen <= 0) continue;

      // Find a reference STAR on this runway with a known TAT
      const runwayStars = starMappings.runwayStarMap
        ? (starMappings.runwayStarMap[runway] || [])
        : [];
      let refTAT = 0;
      let refLen = 0;
      for (const refStar of runwayStars) {
        if (refStar === starName) continue;
        const refTat = result.get(refStar);
        if (!refTat || refTat <= 0) continue;

        const refPathInfo = computeFullTerminalPath(aclText, refStar, runway);
        refLen = refPathInfo.total;
        if (refLen > 0) {
          refTAT = refTat;
          break;
        }
      }

      let estTAT = 0;
      if (refTAT > 0 && refLen > 0) {
        // Estimate TAT from path-length ratio using aircraft-derived reference
        estTAT = Math.round(refTAT * (totalLen / refLen));
      } else if (airportScale && airportScale > 0) {
        // Physics-based: scale game path to real meters, divide by 240 kts
        estTAT = Math.round(totalLen * airportScale / APPROACH_SPEED_MS);
      } else {
        // Fallback: old effective-speed method (deprecated)
        estTAT = Math.round(totalLen / APPROACH_EFFECTIVE_SPEED);
      }
      if (estTAT > bestTAT) bestTAT = estTAT;
    }

    if (bestTAT > 0) {
      result.set(starName, bestTAT);
    } else {
      result.set(starName, fallbackTAT);
    }
  }

  return result;
}

// ─── 5. Resolve FlyApproachPathPointList from SceneryData ────────

/**
 * Resolve FlyApproachPathPointList from SceneryData AirwayNodes.
 * Traces: Runways[runway].Routes[route].AirwayNodeGuids → AirwayNodes[guid].Position
 * Returns Vector3[] or empty array if not found.
 */
function resolveFlyApproachPoints(aclText, route, runway) {
  if (!route || !runway) return [];

  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return [];

  // Find the Runways section → Routes[] matching the route name
  const runwayGuid = _findRunwayGuid(aclText, runway);
  if (!runwayGuid) return [];

  // Read the RunwayState entry's Routes array (uses tokenizer internally)
  const rwEntry = _findDictionaryEntry(aclText.substring(sdIdx), runwayGuid);
  if (!rwEntry) return [];

  const routesBlock = _extractNestedObject(rwEntry, 'Routes');
  if (!routesBlock) {
    // Fallback: find by AirwaySegments name
    return _resolveFromAirwaySegments(aclText, route);
  }

  // Parse Routes $rcontent array using tokenizer to find route by Name
  const routesT = createTokenizer(routesBlock);
  const routesRc = routesT.findSection('$rcontent');

  let routeEntry = null;
  if (routesRc) {
    let pos = routesRc.valueStart + 1; // skip opening [
    while (pos < routesBlock.length) {
      while (pos < routesBlock.length && ' \t\n\r'.includes(routesBlock[pos])) pos++;
      if (pos >= routesBlock.length || routesBlock[pos] === ']') break;
      if (routesBlock[pos] === ',') { pos++; continue; }
      if (routesBlock[pos] === '{') {
        const entryEnd = routesT.findObjectEnd(pos);
        if (entryEnd === null) break;
        const candidate = routesBlock.substring(pos, entryEnd);
        const name = _extractString(candidate, 'Name');
        if (name === route) {
          routeEntry = candidate;
          break;
        }
        pos = entryEnd;
      } else {
        pos++;
      }
    }
  }

  if (!routeEntry) {
    // Fallback: find by AirwaySegments name
    return _resolveFromAirwaySegments(aclText, route);
  }

  // Extract AirwayNodeGuids array (uses tokenizer internally)
  const guids = _extractGuidArray(routeEntry, 'AirwayNodeGuids');
  if (!guids || guids.length === 0) return [];

  // Resolve each GUID to AirwayNode Position (uses tokenizer internally)
  const airwayNodes = _parseAirwayNodes(aclText);
  const points = [];
  for (const guid of guids) {
    const node = airwayNodes.get(guid);
    if (node) points.push(node.position);
  }
  return points;
}

function _findRunwayGuid(text, runwayName) {
  const sdIdx = text.indexOf('"SceneryData"');
  if (sdIdx < 0) return null;
  const sdText = text.substring(sdIdx);
  const sdT = createTokenizer(sdText);
  const rwSec = sdT.findSection('Runways');
  if (!rwSec) return null;

  const rwText = sdT.substring(rwSec.valueStart, rwSec.valueEnd);
  const rwT = createTokenizer(rwText);

  // Find the MAIN $rcontent (skip nested ones like 'comparer' by counting brace depth)
  let mainRcStart = -1;
  let depth = 0;
  for (let i = 0; i < rwText.length - 11; i++) {
    if (rwText[i] === '{') depth++;
    else if (rwText[i] === '}') depth--;
    else if (depth === 1 && rwText.substring(i, i + 11) === '"$rcontent"') {
      const ci = rwText.indexOf(':', i + 11);
      if (ci >= 0) {
        let as = ci + 1;
        while (as < rwText.length && ' \t\n\r'.includes(rwText[as])) as++;
        if (rwText[as] === '[') { mainRcStart = as; break; }
      }
    }
  }
  if (mainRcStart < 0) return null;

  // Iterate Runways dictionary entries using tokenizer for block boundaries
  let _physFallback = null;
  let pos = mainRcStart + 1; // skip opening [
  while (pos < rwText.length) {
    while (pos < rwText.length && ' \t\n\r'.includes(rwText[pos])) pos++;
    if (pos >= rwText.length || rwText[pos] === ']') break;
    if (rwText[pos] === ',') { pos++; continue; }
    if (rwText[pos] === '{') {
      const entryEnd = rwT.findObjectEnd(pos);
      if (entryEnd === null) break;
      const block = rwText.substring(pos, entryEnd);
      const kMatch = block.match(/"\$k"\s*:\s*"([a-f0-9-]+)"/);
      const vBlock = _extractValueBlock(block);
      if (kMatch && vBlock) {
        // Use depth-aware Name extraction (same pattern as extractStarRunwayMappings).
        // _extractString(vBlock, 'Name') would grab the FIRST "Name" anywhere in the
        // vBlock, which is often a nested Entry/route name like "A14" or "A1" inside
        // the Routes[] array — NOT the runway designator like "19" or "01". Only
        // depth-1 scanning finds the actual runway Name.
        let name = null;
        let rwyDepth = 0;
        for (let si = 0; si < vBlock.length - 8; si++) {
          if (vBlock[si] === '{') rwyDepth++;
          else if (vBlock[si] === '}') rwyDepth--;
          else if (rwyDepth === 1 && vBlock.substring(si, si + 6) === '"Name"') {
            const colonPos = vBlock.indexOf(':', si + 6);
            if (colonPos > 0) {
              let vs = colonPos + 1;
              while (vs < vBlock.length && ' \t\n\r'.includes(vBlock[vs])) vs++;
              if (vBlock[vs] === '"') {
                const ve = vBlock.indexOf('"', vs + 1);
                if (ve > vs) { name = vBlock.substring(vs + 1, ve); }
              }
            }
            break;
          }
        }
        const physName = _extractString(vBlock, 'PhysicalName');
        // Prefer exact Name match over PhysicalName fallback.
        // Normalize both sides so "1" matches "01" and vice versa.
        if (name && _normalizeRunway(name) === _normalizeRunway(runwayName)) {
          return kMatch[1];
        }
        // Fallback: split PhysicalName by "/" and compare each runway end
        // using normalized names. This avoids false positives where
        // physName.includes("1") matches both "01" and "19" in "01/19".
        if (physName && !_physFallback) {
          const normTarget = _normalizeRunway(runwayName);
          if (normTarget) {
            const runwayEnds = physName.split('/');
            for (const end of runwayEnds) {
              if (_normalizeRunway(end.trim()) === normTarget) {
                _physFallback = kMatch[1];
                break;
              }
            }
          }
        }
      }
      pos = entryEnd;
    } else {
      pos++;
    }
  }
  return _physFallback || null;
}

function _findDictionaryEntry(sectionText, keyGuid) {
  // Iterate $rcontent array entries using tokenizer for string-aware block boundaries
  const t = createTokenizer(sectionText);
  const rcSec = t.findSection('$rcontent');
  if (!rcSec) return null;

  let pos = rcSec.valueStart + 1; // skip opening [
  while (pos < sectionText.length) {
    while (pos < sectionText.length && ' \t\n\r'.includes(sectionText[pos])) pos++;
    if (pos >= sectionText.length || sectionText[pos] === ']') break;
    if (sectionText[pos] === ',') { pos++; continue; }
    if (sectionText[pos] === '{') {
      const entryEnd = t.findObjectEnd(pos);
      if (entryEnd === null) break;
      const block = sectionText.substring(pos, entryEnd);
      const kMatch = block.match(/"\$k"\s*:\s*"([^"]+)"/);
      if (kMatch && kMatch[1] === keyGuid) {
        return _extractValueBlock(block);
      }
      pos = entryEnd;
    } else {
      pos++;
    }
  }
  return null;
}

function _extractGuidArray(text, key) {
  // Use tokenizer for string-aware key lookup
  const t = createTokenizer(text);
  const keySec = t.findSection(key);
  if (!keySec) return null;

  // The value should be an object containing $rcontent; find the GUID array within it
  const valText = t.substring(keySec.valueStart, keySec.valueEnd);
  const valT = createTokenizer(valText);
  const rcSec = valT.findSection('$rcontent');
  if (!rcSec) return null;

  // $rcontent is a string array of GUIDs
  let pos = rcSec.valueStart + 1; // skip opening [
  // Find the array end (string-aware)
  const arrEnd = valT.findArrayEnd(rcSec.valueStart);
  if (arrEnd === null) return null;

  const arr = valT.substring(rcSec.valueStart, arrEnd);
  const guids = [];
  const gRe = /"([a-f0-9-]{36})"/g;
  let m;
  while ((m = gRe.exec(arr)) !== null) {
    guids.push(m[1]);
  }
  return guids;
}

function _resolveFromAirwaySegments(aclText, route) {
  // Find route by Name in AirwaySegments using tokenizer for all boundaries
  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return [];
  const sdText = aclText.substring(sdIdx);
  const sdT = createTokenizer(sdText);
  const asSec = sdT.findSection('AirwaySegments');
  if (!asSec) return [];

  const asText = sdT.substring(asSec.valueStart, asSec.valueEnd);
  const asT = createTokenizer(asText);
  const rcSec = asT.findSection('$rcontent');
  if (!rcSec) return [];

  // Iterate AirwaySegments entries to find route by Name
  let pos = rcSec.valueStart + 1; // skip opening [
  while (pos < asText.length) {
    while (pos < asText.length && ' \t\n\r'.includes(asText[pos])) pos++;
    if (pos >= asText.length || asText[pos] === ']') break;
    if (asText[pos] === ',') { pos++; continue; }
    if (asText[pos] === '{') {
      const entryEnd = asT.findObjectEnd(pos);
      if (entryEnd === null) break;
      const entry = asText.substring(pos, entryEnd);
      const vBlock = _extractValueBlock(entry);
      if (vBlock) {
        const name = _extractString(vBlock, 'Name');
        if (name === route) {
          const guids = _extractGuidArray(vBlock, 'Nodes');
          if (guids && guids.length > 0) {
            const airwayNodes = _parseAirwayNodes(aclText);
            const points = [];
            for (const guid of guids) {
              const node = airwayNodes.get(guid);
              if (node) points.push(node.position);
            }
            return points;
          }
        }
      }
      pos = entryEnd;
    } else {
      pos++;
    }
  }
  return [];
}

function _parseAirwayNodes(aclText) {
  const map = new Map(); // guid → { name, position }
  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return map;
  const sdText = aclText.substring(sdIdx);
  const sdT = createTokenizer(sdText);
  const anSec = sdT.findSection('AirwayNodes');
  if (!anSec) return map;

  const anText = sdT.substring(anSec.valueStart, anSec.valueEnd);
  const anT = createTokenizer(anText);
  const rcSec = anT.findSection('$rcontent');
  if (!rcSec) return map;

  // Iterate dictionary entries using tokenizer for block boundaries
  let pos = rcSec.valueStart + 1; // skip opening [
  while (pos < anText.length) {
    while (pos < anText.length && ' \t\n\r'.includes(anText[pos])) pos++;
    if (pos >= anText.length || anText[pos] === ']') break;
    if (anText[pos] === ',') { pos++; continue; }
    if (anText[pos] === '{') {
      const entryEnd = anT.findObjectEnd(pos);
      if (entryEnd === null) break;
      const block = anText.substring(pos, entryEnd);
      const kMatch = block.match(/"\$k"\s*:\s*"([a-f0-9-]+)"/);
      const vBlock = _extractValueBlock(block);
      if (kMatch && vBlock) {
        const name = _extractString(vBlock, 'Name');
        const posVec = _extractVector3(vBlock);
        if (posVec) {
          map.set(kMatch[1], { name: name || '', position: posVec });
        }
      }
      pos = entryEnd;
    } else {
      pos++;
    }
  }
  return map;
}

/**
 * Parse TaxiwayNodes from SceneryData into a Map<guid, Position>.
 * Used to resolve TouchDownPointGuid → TouchDownPosition for approach procedures.
 */
function _parseTaxiwayNodes(aclText) {
  const map = new Map();
  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return map;
  const sdText = aclText.substring(sdIdx);
  const sdT = createTokenizer(sdText);
  const tnSec = sdT.findSection('TaxiwayNodes');
  if (!tnSec) return map;

  const tnText = sdT.substring(tnSec.valueStart, tnSec.valueEnd);
  const tnT = createTokenizer(tnText);
  const rcSec = tnT.findSection('$rcontent');
  if (!rcSec) return map;

  let pos = rcSec.valueStart + 1;
  while (pos < tnText.length) {
    while (pos < tnText.length && ' \t\n\r'.includes(tnText[pos])) pos++;
    if (pos >= tnText.length || tnText[pos] === ']') break;
    if (tnText[pos] === ',') { pos++; continue; }
    if (tnText[pos] === '{') {
      const entryEnd = tnT.findObjectEnd(pos);
      if (entryEnd === null) break;
      const block = tnText.substring(pos, entryEnd);
      const kMatch = block.match(/"\$k"\s*:\s*"([a-f0-9-]+)"/);
      const vBlock = _extractValueBlock(block);
      if (kMatch && vBlock) {
        const posVec = _extractVector3(vBlock);
        if (posVec) {
          map.set(kMatch[1], posVec);
        }
      }
      pos = entryEnd;
    } else {
      pos++;
    }
  }
  return map;
}

// ─── 5c. Parse Runway Thresholds from SceneryData ──────────────

/**
 * Extract runway threshold positions from SceneryData.Runways.
 * Each runway entry has "ThresholdPointGuids" (2 GUIDs) referencing
 * AirwayNodes — these are the exact runway endpoints.
 *
 * @param {string} aclText - raw ACL text
 * @returns {{[name: string]: {thresholds: Array<{x: number, z: number}>}}}
 */
function _parseRunwayThresholds(aclText) {
  const result = {};
  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return result;
  const sdText = aclText.substring(sdIdx);
  const sdT = createTokenizer(sdText);

  // Parse AirwayNodes + TaxiwayNodes for GUID→position lookup
  const airwayNodes = _parseAirwayNodes(aclText);
  const taxiwayNodes = _parseTaxiwayNodes(aclText);

  // Find Runways section
  const rwSec = sdT.findSection('Runways');
  console.log('[RUNWAY-THRESHOLDS] found Runways section:', !!rwSec);
  if (!rwSec) return result;

  const rwText = sdT.substring(rwSec.valueStart, rwSec.valueEnd);
  const rwT = createTokenizer(rwText);
  const rcSec = rwT.findSection('$rcontent');
  console.log('[RUNWAY-THRESHOLDS] found $rcontent:', !!rcSec, 'airwayNodes:', airwayNodes.size, 'taxiwayNodes:', taxiwayNodes.size);
  if (!rcSec) return result;

  // Resolve GUID to position: try AirwayNodes ({name, position}) then TaxiwayNodes (Vector3 directly)
  const resolveNode = (guid) => {
    const an = airwayNodes.get(guid);
    if (an && an.position) return an.position;
    const tn = taxiwayNodes.get(guid);
    if (tn && tn.x !== undefined) return tn;
    return null;
  };

  // Iterate runway entries
  let pos = rcSec.valueStart + 1;
  let entryCount = 0;
  while (pos < rwText.length) {
    while (pos < rwText.length && ' \t\n\r'.includes(rwText[pos])) pos++;
    const charAtPos = pos < rwText.length ? rwText[pos] : 'EOF';
    const snippet = rwText.substring(pos, Math.min(pos + 60, rwText.length)).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    console.log('[RUNWAY-THRESHOLDS] LOOP iter=' + entryCount + ' pos=' + pos + ' char=' + charAtPos + ' snippet=' + snippet);
    if (pos >= rwText.length || rwText[pos] === ']') { console.log('[RUNWAY-THRESHOLDS] BREAK at ] or EOF'); break; }
    if (rwText[pos] === ',') { pos++; continue; }
    if (rwText[pos] === '{') {
      const entryEnd = rwT.findObjectEnd(pos);
      console.log('[RUNWAY-THRESHOLDS]   entryEnd=' + entryEnd);
      if (entryEnd === null) { console.log('[RUNWAY-THRESHOLDS] BREAK entryEnd null'); break; }
      const block = rwText.substring(pos, entryEnd);
      const vBlock = _extractValueBlock(block);
      if (vBlock) {
        const physName = _extractString(vBlock, 'PhysicalName');
        // Only actual runways have PhysicalName with "/" (e.g. "13L/31R") — taxiways don't.
        // Each runway pair has 2 entries sharing the same threshold points; deduplicate by physName.
        if (physName && physName.includes('/') && !result[physName]) {
          const tpgGuids = _extractGuidArray(vBlock, 'ThresholdPointGuids');
          console.log('[RUNWAY-THRESHOLDS]   entry ' + entryCount + ' physName=' + physName + ' tpgGuids=' + (tpgGuids ? tpgGuids.length : 0));
          if (tpgGuids && tpgGuids.length >= 2) {
            const thresholds = [];
            for (const guid of tpgGuids) {
              const pt = resolveNode(guid);
              if (pt) thresholds.push({ x: pt.x, z: pt.z });
            }
            if (thresholds.length === 2) {
              result[physName] = { thresholds };
              console.log('[RUNWAY-THRESHOLDS]   ADDED ' + physName);
            }
          }
        }
      }
      entryCount++;
      pos = entryEnd;
    } else {
      console.log('[RUNWAY-THRESHOLDS] UNEXPECTED char, advancing');
      pos++;
    }
  }
  console.log('[RUNWAY-THRESHOLDS] DONE: ' + entryCount + ' entries, result keys: ' + Object.keys(result).join(', '));
  return result;
}

/**
 * Returns the uniform coordinate scale factor (m/game-unit).
 *
 * All axes (XYZ) use a fixed 100 m/unit scale — confirmed by original game
 * files using Y=15.24 (= 5000ft) at every airport regardless of runway geometry.
 *
 * @returns {number} DEFAULT_AIRPORT_SCALE (100)
 */
function computeAirportScale(aclText) {
  // All axes use a uniform 100 m/unit scale. The per-airport runway-length
  // ratio was a mistaken assumption — the game's coordinate system is fixed.
  return DEFAULT_AIRPORT_SCALE;
}

/**
 * Compute the approach altitude ceiling in game units from the per-airport
 * coordinate scale. Uses a real-world ceiling of 5000ft (1524m) — the standard
 * ILS approach ceiling — and converts to game units via the airport scale.
 *
 *   approachCap = APPROACH_CEILING_M / airportScale
 *
 * At the default scale (100 m/unit): 1524/100 = 15.24 (backward compatible).
 *
 * @param {number} [airportScale] - m/game-unit from computeAirportScale()
 * @returns {number} approach ceiling in game units
 */
function computeApproachCap(airportScale) {
  // All axes use a fixed 100 m/unit scale. Every original game file
  // stores Y=15.24 (= 5000ft) regardless of airport.
  return APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE;  // 15.24
}

/**
 * Compute the full terminal path length for a STAR+runway combination.
 *
 * Combines three segments from SceneryData:
 *   1. FlyApproach points (Type=0 STAR route) via resolveFlyApproachPoints
 *   2. Approach procedure points (Type=1 route) via resolveApproachProcedureData
 *   3. Touchdown distance from last procedure point to runway threshold
 *
 * Returns { flyLen, procLen, tdDist, total } in game units.
 */
function computeFullTerminalPath(aclText, star, runway) {
  let flyLen = 0;
  let procLen = 0;
  let tdDist = 0;

  const flyPoints = resolveFlyApproachPoints(aclText, star, runway);
  if (flyPoints && flyPoints.length >= 2) {
    flyLen = computePathLength(flyPoints);
  }

  const procData = resolveApproachProcedureData(aclText, runway);
  if (procData && procData.pathPointList && procData.pathPointList.length >= 2) {
    procLen = computePathLength(procData.pathPointList);

    // Touchdown distance: last procedure point → threshold
    if (procData.touchDownPosition) {
      const last = procData.pathPointList[procData.pathPointList.length - 1];
      const td = procData.touchDownPosition;
      tdDist = Math.sqrt((last.x - td.x) ** 2 + (last.z - td.z) ** 2);
    }
  }

  const total = flyLen + procLen + tdDist;
  return { flyLen, procLen, tdDist, total };
}

// ─── 5b. STAR-Runway Mapping from SceneryData ─────

/**
 * Extract ALL valid STAR↔runway combinations directly from SceneryData.Runways.
 *
 * This is the authoritative source: each runway entry has a Routes array where
 * Type=0 entries are STARs (arrival transitions) and Type=2 entries are SIDs
 * (departure transitions). We extract only Type=0 entries.
 *
 * Unlike appPointMap (built from State=30 aircraft at snapshot time), this
 * captures EVERY combo defined in the scenery, regardless of whether any
 * .acl file has an active approach aircraft for it.
 *
 * @param {string} aclText - raw ACL file content
 * @returns {{starRunwayMap: Object<string, string[]>, runwayStarMap: Object<string, string[]>}}
 */
function extractStarRunwayMappings(aclText) {
  const starRunwayMap = {};  // { starName → [runway, ...] }
  const runwayStarMap = {};  // { runway → [starName, ...] }
  if (!aclText) return { starRunwayMap, runwayStarMap };

  // 1. Navigate to SceneryData → Runways
  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return { starRunwayMap, runwayStarMap };
  const sdText = aclText.substring(sdIdx);
  const sdT = createTokenizer(sdText);
  const rwSec = sdT.findSection('Runways');
  if (!rwSec) return { starRunwayMap, runwayStarMap };

  const rwText = sdT.substring(rwSec.valueStart, rwSec.valueEnd);
  const rwT = createTokenizer(rwText);

  // 2. Find the MAIN $rcontent (skip nested ones like 'comparer' by counting brace depth)
  let rwRcStart = -1;
  let mainDepth = 0;
  for (let i = 0; i < rwText.length - 11; i++) {
    if (rwText[i] === '{') mainDepth++;
    else if (rwText[i] === '}') mainDepth--;
    else if (mainDepth === 1 && rwText.substring(i, i + 11) === '"$rcontent"') {
      const colonIdx = rwText.indexOf(':', i + 11);
      if (colonIdx >= 0) {
        let arrStart = colonIdx + 1;
        while (arrStart < rwText.length && ' \t\n\r'.includes(rwText[arrStart])) arrStart++;
        if (rwText[arrStart] === '[') {
          rwRcStart = arrStart;
          break;
        }
      }
    }
  }
  if (rwRcStart < 0) return { starRunwayMap, runwayStarMap };

  // 3. Iterate runway dictionary entries
  let pos = rwRcStart + 1; // skip opening [
  while (pos < rwText.length) {
    while (pos < rwText.length && ' \t\n\r'.includes(rwText[pos])) pos++;
    if (pos >= rwText.length || rwText[pos] === ']') break;
    if (rwText[pos] === ',') { pos++; continue; }
    if (rwText[pos] === '{') {
      const entryEnd = rwT.findObjectEnd(pos);
      if (entryEnd === null) break;
      const block = rwText.substring(pos, entryEnd);
      const vBlock = _extractValueBlock(block);
      if (vBlock) {
        // Find the runway Name at depth 1 of the $v block. _extractString
        // would match the FIRST "Name" anywhere, which in KJFK comparer
        // entries picks up nested Entry names like "Z" instead of the real
        // runway designator like "31L" deeper in the block. Depth-aware
        // scanning ensures we always get the runway designator.
        let runwayName = null;
        let rwyDepth = 0;
        for (let i = 0; i < vBlock.length - 8; i++) {
          if (vBlock[i] === '{') rwyDepth++;
          else if (vBlock[i] === '}') rwyDepth--;
          else if (rwyDepth === 1 && vBlock.substring(i, i + 6) === '"Name"') {
            const colonPos = vBlock.indexOf(':', i + 6);
            if (colonPos > 0) {
              let vs = colonPos + 1;
              while (vs < vBlock.length && ' \t\n\r'.includes(vBlock[vs])) vs++;
              if (vBlock[vs] === '"') {
                const ve = vBlock.indexOf('"', vs + 1);
                if (ve > vs) runwayName = vBlock.substring(vs + 1, ve);
              }
            }
            break;
          }
        }
        const physName = _extractString(vBlock, 'PhysicalName');
        // Only process actual runway entries (PhysicalName contains '/')
        if (runwayName && physName && physName.includes('/')) {
          // 4. Extract the Routes block and find Type=0 entries
          const routesBlock = _extractNestedObject(vBlock, 'Routes');
          if (routesBlock) {
            const routesT = createTokenizer(routesBlock);
            const routesRc = routesT.findSection('$rcontent');
            if (routesRc) {
              let rp = routesRc.valueStart + 1; // skip opening [
              while (rp < routesBlock.length) {
                while (rp < routesBlock.length && ' \t\n\r'.includes(routesBlock[rp])) rp++;
                if (rp >= routesBlock.length || routesBlock[rp] === ']') break;
                if (routesBlock[rp] === ',') { rp++; continue; }
                if (routesBlock[rp] === '{') {
                  const reEnd = routesT.findObjectEnd(rp);
                  if (reEnd === null) break;
                  const routeEntry = routesBlock.substring(rp, reEnd);
                  const type = _extractInt(routeEntry, 'Type');
                  if (type === 0) {
                    const starName = _extractString(routeEntry, 'Name');
                    // Skip routes with no waypoint data ($rlength: 0) — these are
                    // stub entries that don't have actual approach path nodes and
                    // cannot be used by the game. Including them would let the
                    // editor offer STARs that result in unrendered aircraft.
                    const guids = _extractGuidArray(routeEntry, 'AirwayNodeGuids');
                    if (starName && guids && guids.length > 0) {
                      if (!starRunwayMap[starName]) starRunwayMap[starName] = [];
                      if (!starRunwayMap[starName].includes(runwayName)) starRunwayMap[starName].push(runwayName);
                      if (!runwayStarMap[runwayName]) runwayStarMap[runwayName] = [];
                      if (!runwayStarMap[runwayName].includes(starName)) runwayStarMap[runwayName].push(starName);
                    }
                  }
                  rp = reEnd;
                } else {
                  rp++;
                }
              }
            }
          }
        }
      }
      pos = entryEnd;
    } else {
      pos++;
    }
  }
  return { starRunwayMap, runwayStarMap };
}

// ─── 5c. Resolve Approach Procedure Data from SceneryData ─────

/**
 * Resolve State=5 approach procedure data from SceneryData for a given runway.
 * Extracts PathPointList, TouchDownPosition, ApproachDirection, and InitialPosition
 * from the approach procedure route (Type=1) and the runway's TouchDownPointGuid.
 *
 * Unlike extractState5Data() which relies on existing State=5 aircraft entries,
 * this extracts data from SceneryData which has approach procedures for ALL runways
 * regardless of whether any file contains a State=5 aircraft for that runway.
 *
 * When hintPosition is provided and multiple Type=1 variants exist for the runway,
 * picks the variant whose first AirwayNode is closest to hintPosition. This ensures
 * each STAR gets the correct approach procedure variant (e.g. ZSJN runway 01 has
 * three "RNAV ILS Z Rwy 01" variants starting at JN207, DALIM, JN209).
 *
 * @param {string} aclText - raw ACL file content
 * @param {string} runway - runway name, e.g. "22L"
 * @param {{x:number, z:number}} [hintPosition] - optional last FlyApproach point
 *   of the STAR; used to select the correct variant when multiple exist
 * @returns {{pathPointList, touchDownPosition, approachDirection, initialPosition} | null}
 */
function resolveApproachProcedureData(aclText, runway, hintPosition) {
  if (!runway) return null;

  // 1. Find the Runway entry GUID
  const runwayGuid = _findRunwayGuid(aclText, runway);
  if (!runwayGuid) return null;

  // 2. Navigate to the Runways dictionary within SceneryData.
  // The Runways dictionary has nested $rcontent arrays (e.g. in 'comparer'),
  // so we must find the OUTERMOST $rcontent that belongs to Runways itself.
  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return null;
  const sdText = aclText.substring(sdIdx);
  const sdT = createTokenizer(sdText);
  const rwSec = sdT.findSection('Runways');
  if (!rwSec) return null;

  const rwText = sdT.substring(rwSec.valueStart, rwSec.valueEnd);
  const rwT = createTokenizer(rwText);

  // Find the MAIN $rcontent (skip nested ones by counting brace depth)
  let rwRcStart = -1;
  let mainDepth = 0;
  for (let i = 0; i < rwText.length - 11; i++) {
    if (rwText[i] === '{') mainDepth++;
    else if (rwText[i] === '}') mainDepth--;
    else if (mainDepth === 1 && rwText.substring(i, i + 11) === '"$rcontent"') {
      const colonIdx = rwText.indexOf(':', i + 11);
      if (colonIdx >= 0) {
        let arrStart = colonIdx + 1;
        while (arrStart < rwText.length && ' \t\n\r'.includes(rwText[arrStart])) arrStart++;
        if (rwText[arrStart] === '[') {
          rwRcStart = arrStart;
          break;
        }
      }
    }
  }
  if (rwRcStart < 0) return null;

  // Search within the main Runways $rcontent for the matching runway GUID
  let rwEntry = null;
  let pos = rwRcStart + 1; // skip opening [
  while (pos < rwText.length) {
    while (pos < rwText.length && ' \t\n\r'.includes(rwText[pos])) pos++;
    if (pos >= rwText.length || rwText[pos] === ']') break;
    if (rwText[pos] === ',') { pos++; continue; }
    if (rwText[pos] === '{') {
      const entryEnd = rwT.findObjectEnd(pos);
      if (entryEnd === null) break;
      const block = rwText.substring(pos, entryEnd);
      const kMatch = block.match(/"\$k"\s*:\s*"([a-f0-9-]+)"/);
      if (kMatch && kMatch[1] === runwayGuid) {
        const vBlock = _extractValueBlock(block);
        if (vBlock) rwEntry = vBlock;
        break;
      }
      pos = entryEnd;
    } else {
      pos++;
    }
  }
  if (!rwEntry) return null;

  // 3. Extract TouchDownPointGuid
  const tdGuid = _extractString(rwEntry, 'TouchDownPointGuid');
  if (!tdGuid) return null;

  // 4. Find ALL approach procedure routes (Type=1) in Routes[]
  const routesBlock = _extractNestedObject(rwEntry, 'Routes');
  if (!routesBlock) return null;

  const routesT = createTokenizer(routesBlock);
  const routesRc = routesT.findSection('$rcontent');
  if (!routesRc) return null;

  // Collect all Type=1 route variants with their resolved pathPointLists
  const airwayNodes = _parseAirwayNodes(aclText);
  const variants = [];
  let rp = routesRc.valueStart + 1; // skip opening [
  while (rp < routesBlock.length) {
    while (rp < routesBlock.length && ' \t\n\r'.includes(routesBlock[rp])) rp++;
    if (rp >= routesBlock.length || routesBlock[rp] === ']') break;
    if (routesBlock[rp] === ',') { rp++; continue; }
    if (routesBlock[rp] === '{') {
      const entryEnd = routesT.findObjectEnd(rp);
      if (entryEnd === null) break;
      const routeEntry = routesBlock.substring(rp, entryEnd);
      const type = _extractInt(routeEntry, 'Type');
      if (type === 1) {
        // Resolve PathPointList directly from AirwayNodeGuids (like
        // resolveFlyApproachPoints does for Type=0 routes). This avoids
        // the issue of _resolveFromAirwaySegments always returning the
        // first AirwaySegments entry when multiple share the same Name.
        const guids = _extractGuidArray(routeEntry, 'AirwayNodeGuids');
        if (guids && guids.length >= 2) {
          const points = [];
          for (const guid of guids) {
            const node = airwayNodes.get(guid);
            if (node) points.push(node.position);
          }
          if (points.length >= 2) {
            variants.push({
              pathPointList: points,
              firstPoint: points[0],
            });
          }
        }
      }
      rp = entryEnd;
    } else {
      rp++;
    }
  }

  if (variants.length === 0) return null;

  // 5. Pick the correct variant
  let pathPointList;
  if (hintPosition && variants.length > 1) {
    // Find variant whose first AirwayNode is closest to the hint
    let bestDist = Infinity;
    for (const v of variants) {
      const dx = v.firstPoint.x - hintPosition.x;
      const dz = v.firstPoint.z - hintPosition.z;
      const dist = dx * dx + dz * dz; // squared distance (avoid sqrt)
      if (dist < bestDist) {
        bestDist = dist;
        pathPointList = v.pathPointList;
      }
    }
  } else {
    pathPointList = variants[0].pathPointList;
  }

  // 6. Resolve TouchDownPosition from TaxiwayNodes
  const taxiNodes = _parseTaxiwayNodes(aclText);
  const tdPos = taxiNodes.get(tdGuid);
  if (!tdPos) return null;

  // 7. Compute ApproachDirection from last segment of PathPointList
  const lastPt = pathPointList[pathPointList.length - 1];
  const prevPt = pathPointList[pathPointList.length - 2];
  const approachDirection = _vec3Normalize(_vec3Sub(lastPt, prevPt));

  // 8. InitialPosition = first PathPointList point (entry to final approach)
  const initialPosition = { ...pathPointList[0] };

  return {
    pathPointList,
    touchDownPosition: tdPos,
    approachDirection,
    initialPosition,
  };
}

// ─── 6. ProgressRatio Computation ────────────────────────────────

/**
 * Compute ProgressRatio for an approach aircraft.
 * Formula: 1 − (landingTimeTicks − saveTimeTicks) / (totalApproachTime × 10^7)
 * Clamped to [0.0, 1.0].
 */
function computeProgressRatio(landingTimeTicks, saveTimeTicks, totalApproachTimeSeconds) {
  if (totalApproachTimeSeconds <= 0) return 0;
  const timeToLandingTicks = landingTimeTicks - saveTimeTicks;
  const totalApproachTicks = totalApproachTimeSeconds * 10000000;
  const ratio = 1.0 - (timeToLandingTicks / totalApproachTicks);
  return Math.max(0, Math.min(1, ratio));
}

// ─── 7. Path Interpolation ───────────────────────────────────────

/**
 * Combine FlyApproach + App points into one full path.
 */
function buildFullPath(flyApproachPoints, appPoints, touchDownPosition) {
  const all = [...(flyApproachPoints || []), ...(appPoints || [])];
  if (touchDownPosition) {
    // Avoid zero-length tail segment which would cause div-by-zero in
    // _interpolateAlongPath / _tangentAlongPath.
    const last = all.length > 0 ? all[all.length - 1] : null;
    if (!last || _vec3Dist(last, touchDownPosition) > 0.001) {
      all.push(touchDownPosition);
    }
  }
  return all;
}

/**
 * Deduplicate the IAF join between STAR FlyApproach and procedure PathPointList.
 * Both segments meet at the Initial Approach Fix — if the last flyPoint and first
 * ppList point are the same (within 0.1m), trim the duplicate from flyPoints to
 * avoid a zero-length segment that would cause NaN in _interpolateAlongPath.
 */
function _dedupeIafJoin(flyPoints, ppList) {
  if (!flyPoints || flyPoints.length === 0 || !ppList || ppList.length === 0) {
    return flyPoints || [];
  }
  const lastFly = flyPoints[flyPoints.length - 1];
  const firstPP = ppList[0];
  if (_vec3Dist(lastFly, firstPP) < 0.1) {
    return flyPoints.slice(0, -1);
  }
  return flyPoints;
}

/**
 * Compute total path length (sum of segment distances).
 */
function computePathLength(points) {
  if (!points || points.length < 2) return 0;
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += _vec3Dist(points[i - 1], points[i]);
  }
  return len;
}

/**
 * Interpolate position along a path given a distance from start.
 */
function _interpolateAlongPath(points, targetDist) {
  if (!points || points.length === 0) return { x: 0, y: APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE, z: 0 };
  if (points.length === 1) return { ...points[0] };

  let traveled = 0;
  for (let i = 1; i < points.length; i++) {
    const segLen = _vec3Dist(points[i - 1], points[i]);
    if (traveled + segLen >= targetDist) {
      const t = (targetDist - traveled) / segLen;
      return _vec3Add(points[i - 1], _vec3Scale(_vec3Sub(points[i], points[i - 1]), t));
    }
    traveled += segLen;
  }
  return { ...points[points.length - 1] };
}

/**
 * Compute tangent direction at a given distance along the path.
 */
function _tangentAlongPath(points, targetDist) {
  if (!points || points.length < 2) return { x: 0, y: 0, z: 1 };

  let traveled = 0;
  for (let i = 1; i < points.length; i++) {
    const segLen = _vec3Dist(points[i - 1], points[i]);
    if (traveled + segLen >= targetDist || i === points.length - 1) {
      return _vec3Normalize(_vec3Sub(points[i], points[i - 1]));
    }
    traveled += segLen;
  }
  return _vec3Normalize(_vec3Sub(points[points.length - 1], points[points.length - 2]));
}

/**
 * Compute Position from ProgressRatio along combined FlyApproach + App + TouchDown path.
 * Touchdown IS included in the interpolation path so the XZ position is accurate
 * all the way to the runway threshold. It also drives the 3° ILS glideslope Y.
 */
function computePosition(flyApproachPoints, appPoints, progressRatio, touchDownPosition, approachCap) {
  const fullPath = buildFullPath(flyApproachPoints, appPoints, touchDownPosition);
  const totalLen = computePathLength(fullPath);
  const targetDist = totalLen * progressRatio;
  const pos = _interpolateAlongPath(fullPath, targetDist);
  // Y from 3° ILS glideslope using REMAINING PATH DISTANCE (not straight-line).
  // Path distance follows the approach route through turns — correct for
  // curved approaches like KJFK SIE.CAMRM5. Capped at the runway's approach
  // ceiling (cached per runway, NOT hardcoded).
  if (touchDownPosition && approachCap != null) {
    // Remaining distance: path left from current position to touchdown
    // (touchdown is now the last point in fullPath).
    const remainingPathDist = totalLen - targetDist;
    const glideY = remainingPathDist * Math.tan(3 * Math.PI / 180);
    pos.y = Math.min(approachCap, glideY);
  } else {
    pos.y = APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE; // fallback for callers without runway data (tests, legacy)
  }
  return pos;
}

/**
 * Compute Direction (normalized XZ tangent) from ProgressRatio along combined path.
 * @param {Vector3[]} flyApproachPoints
 * @param {Vector3[]} appPoints
 * @param {number} progressRatio - 0..1
 * @param {Vector3} [touchDownPosition] - optional runway threshold, included in path
 *   so heading points toward the runway when near the end of the approach
 */
function computeDirection(flyApproachPoints, appPoints, progressRatio, touchDownPosition) {
  const fullPath = buildFullPath(flyApproachPoints, appPoints, touchDownPosition || null);
  const totalLen = computePathLength(fullPath);
  const targetDist = totalLen * progressRatio;
  const dir = _tangentAlongPath(fullPath, targetDist);
  dir.y = 0; // level flight
  return _vec3Normalize(dir);
}

// ─── 8. AircraftState Assembly ───────────────────────────────────

/**
 * Build a complete AircraftState $k/$v block for a State=30 approach aircraft.
 *
 * @param {Object} opts
 * @param {string} opts.flightPlanGuid - links to FlightPlans dictionary
 * @param {string} opts.route - STAR/approach route name
 * @param {Object[]} opts.flyPoints - FlyApproachPathPointList positions
 * @param {Object[]} opts.appPoints - AppPointList positions
 * @param {number} opts.progressRatio - [0.0, 1.0]
 * @param {Object} opts.spec - Specification from specDB
 * @param {string} [opts.radioChannelGuid] - radio channel GUID
 * @param {number} [opts.nextId] - starting $id counter (default 5001)
 * @param {number} [opts.acTypeNum] - AircraftState $type number: 33 (ZSJN) or 35 (KJFK). Default 33.
 * @returns {{guid: string, block: string, nextId: number}} entry text for $rcontent
 */
function buildApproachAircraftBlock(opts) {
  const {
    flightPlanGuid,
    route,
    flyPoints,
    appPoints,
    progressRatio,
    spec,
    radioChannelGuid = '',
    touchDownPosition = null,
    approachCap = null,
    nextId = 5001,
  } = opts;

  const guid = _generateGuid();
  let id = nextId;

  // Use namespace-qualified $type strings to bypass the game's integer type registry.
  // This ensures all types resolve correctly regardless of $id continuity.
  const tn = opts.typeNums || {};
  const ns = (num, name, asm = 'GroundATC.Core') => `"${num}|${name}, ${asm}"`;
  const T = {
    ac:      ns(tn.acType      || opts.acTypeNum || 33, 'ContextCross.States.AircraftState'),
    spec:    ns(tn.spec        || 34, 'ContextCross.States.AircraftSpecificationState'),
    dyn:     ns(tn.dynInternal || 38, 'ContextCross.Dynamics.DynamicInternalState'),
    dynParams: ns(tn.dynParams || 47, 'ContextCross.Dynamics.States.FlyApproachDynamicsParams'),
    acRwy:   ns(tn.acRwy       || 42, 'ContextCross.States.AircraftRunwayCoordinateState'),
    float3:  ns(tn.float3      || 35, 'Unity.Mathematics.float3', 'Unity.Mathematics'),
    vec4:    ns(tn.vec4        || 37, 'UnityEngine.Vector4', 'UnityEngine.CoreModule'),
    dockArr: ns(tn.vec4Arr     || 36, 'UnityEngine.Vector4[]', 'UnityEngine.CoreModule'),
    waitCmd: ns(tn.waitCmd     || 43, 'ContextCross.Enums.ECommand[]'),
    recvEvt: ns(tn.recvEvt     || 44, 'ContextCross.Events.AircraftEvent[]'),
  };

  // Format helpers — use namespace-qualified types everywhere.
  // BCL types (Vector3=16, String[]=8) are stable across Unity versions and safe as-is.
  const nsVec3 = '"16|UnityEngine.Vector3, UnityEngine.CoreModule"';
  const nsListVec3 = `"${tn.listVec3 || 46}|System.Collections.Generic.List\`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib"`;
  const nsStrArr = '"8|System.String[], mscorlib"';

  const fmtV3 = (v) => `{\n  "$type": ${nsVec3},\n  ${v.x},\n  0,\n  ${v.z}\n}`;
  const fmtFloat3 = (v) => `{\n  "$type": ${T.float3},\n  "x": ${v.x},\n  "y": ${v.y},\n  "z": ${v.z}\n}`;

  // Build FlyApproachPathPointList
  let flyPointsStr = '';
  if (flyPoints && flyPoints.length > 0) {
    const pts = flyPoints.map((p, i) => `${i === 0 ? '' : ',\n'}{"$type": ${nsVec3}, ${p.x}, 0, ${p.z}}`).join('');
    flyPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": ${flyPoints.length},\n"$rcontent": [\n${pts}\n]\n}`;
  } else {
    flyPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": 0,\n"$rcontent": []\n}`;
  }

  // Build AppPointList
  let appPointsStr = '';
  if (appPoints && appPoints.length > 0) {
    const pts = appPoints.map((p, i) => `${i === 0 ? '' : ',\n'}{"$type": ${nsVec3}, ${p.x}, 0, ${p.z}}`).join('');
    appPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": ${appPoints.length},\n"$rcontent": [\n${pts}\n]\n}`;
  } else {
    appPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": 0,\n"$rcontent": []\n}`;
  }

  // Build DockingPositions
  let dockStr = '';
  const dp = spec.DockingPositions || [];
  if (dp.length > 0) {
    const dpts = dp.map((d, i) => `${i === 0 ? '' : ',\n'}{"$type": ${T.vec4}, ${d.x}, ${d.y}, ${d.z}, ${d.w}}`).join('');
    dockStr = `{\n"$id": ${id++},\n"$type": ${T.dockArr},\n"$rlength": ${dp.length},\n"$rcontent": [\n${dpts}\n]\n}`;
  } else {
    dockStr = `{\n"$id": ${id++},\n"$type": ${T.dockArr},\n"$rlength": 0,\n"$rcontent": []\n}`;
  }

  // Position and Direction
  const pos = computePosition(flyPoints, appPoints, progressRatio, touchDownPosition, approachCap);
  const dir = computeDirection(flyPoints, appPoints, progressRatio, touchDownPosition);

  const block = `{
    "$id": ${id++},
    "$type": ${T.ac},
    "Guid": "${guid}",
    "Enabled": true,
    "State": 30,
    "Specification": {
      "$id": ${id++},
      "$type": ${T.spec},
      "Guid": null,
      "Enabled": false,
      "Designator": "${spec.Designator}",
      "AerodromeCode": ${spec.AerodromeCode},
      "WakeTurbulenceCategory": ${spec.WakeTurbulenceCategory},
      "WheelBase": ${spec.WheelBase},
      "ModelOffset": ${fmtFloat3(spec.ModelOffset)},
      "WingSpan": ${spec.WingSpan},
      "DockingPositions": ${dockStr},
      "RunwayVRSpeed": ${spec.RunwayVRSpeed},
      "RunwayTakeOffLength": ${spec.RunwayTakeOffLength}
    },
    "Direction": ${fmtV3(dir, T)},
    "DynamicInternalState": {
      "$type": ${T.dyn},
      "DynamicsState": 1,
      "TaxiSpeed": 240,
      "ForwardSpeed": true,
      "TargetTaxiSpeed": 240,
      "PositiveTaxiAcceleration": 1,
      "NegativeTaxiAcceleration": -2,
      "TaxiArrivalToSpotPath": null,
      "TaxiArrivalToHoldingPointPath": null,
      "FrontWheelSteeringAngle": 0,
      "DynamicsParams": {
        "$id": ${id++},
        "$type": ${T.dynParams},
        "ProgressRatio": ${progressRatio},
        "FlyApproachPathPointList": ${flyPointsStr},
        "AppPointList": ${appPointsStr}
      }
    },
    "AircraftRunwayCoordinateState": {
      "$id": ${id++},
      "$type": ${T.acRwy},
      "Guid": null,
      "Enabled": false,
      "TaxiPathUnPassedIntersectionRunwayNames": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "TaxiBlockingRunwayNames": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwayFenceCurrentEnterRunways": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwayGuardCurrentEnterRunways": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "CrossRunwayPermissions": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwaySetterIdx": 0
    },
    "FlightPlanGuid": "${flightPlanGuid}",
    "ActiveFlightDirection": 1,
    "Position": {
      "$type": ${nsVec3},
      ${pos.x},
      ${pos.y},
      ${pos.z}
    },
    "RadioChannelGuid": "${radioChannelGuid}",
    "JurisdictionRadioChannelGuid": "${radioChannelGuid}",
    "TaxiPathStartingPosition": { "$type": ${nsVec3}, 0, 0, 0 },
    "TaxiPath": null,
    "RollingPresetTaxiPathStartingPosition": { "$type": ${nsVec3}, 0, 0, 0 },
    "RollingPresetTaxiPath": null,
    "SelectedRunwayEntryIndex": -1,
    "SelectedRunwayEntryRunwayGuid": null,
    "SelectedRunwayExitIndex": -1,
    "SelectedTaxiPushBackNodeGuid": null,
    "SelectedTowNavigationPointGuid": null,
    "IsFirstTaxi": false,
    "WaitingForCommands": {
      "$id": ${id++},
      "$type": ${T.waitCmd},
      "$rlength": 0,
      "$rcontent": []
    },
    "ReceivedEvents": {
      "$id": ${id++},
      "$type": ${T.recvEvt},
      "$rlength": 0,
      "$rcontent": []
    },
    "Route": "${route}"
  }`;

  return {
    guid,
    block,
    nextId: id,
  };
}

// ─── 8b. State=5 Aircraft Block Builder ────────────────────────────

/**
 * Build a State=5 (Approach/Tower, in-air) aircraft entry JSON block.
 * Uses ApproachDynamicsParams with cached PathPointList instead of
 * FlyApproachDynamicsParams (which State=30 uses).
 *
 * @param {Object} opts
 * @param {string} opts.flightPlanGuid - GUID of the matching FlightPlanState
 * @param {string} opts.route - approach procedure name (e.g., "RNAV ILS Z Rwy 19")
 * @param {number} opts.state5PR - DEPRECATED: hardcoded to 0; game recalculates path-based PR
 * @param {Object} opts.spec - AircraftSpec from specDB
 * @param {string} opts.towerChannelGuid - Tower radio channel GUID
 * @param {Object} opts.state5Params - cached { touchDownPosition, approachDirection, initialPosition, pathPointList }
 * @param {number} [opts.approachCap] - approach altitude ceiling in game units (default: computed from 5000ft / airportScale)
 * @param {number} [opts.nextId=5001] - starting $id counter
 * @param {Object} [opts.typeNums] - per-file type number overrides
 * @param {number} [opts.acTypeNum] - AircraftState $type number
 * @returns {{guid: string, block: string, nextId: number}}
 */
function buildState5AircraftBlock(opts) {
  const {
    flightPlanGuid,
    route,
    spec,
    towerChannelGuid = '',
    state5Params,
    flyPoints = null,
    fullPR = null,
    waitingForCommand = 22,
    selectedRunwayExitIndex = -1,
    approachCap: _explicitCap,
    nextId = 5001,
  } = opts;

  const guid = _generateGuid();
  let id = nextId;

  // Use namespace-qualified $type strings to bypass the game's integer type registry.
  const tn = opts.typeNums || {};
  const ns = (num, name, asm = 'GroundATC.Core') => `"${num}|${name}, ${asm}"`;
  const T = {
    ac:          ns(tn.acType            || opts.acTypeNum || 33, 'ContextCross.States.AircraftState'),
    spec:        ns(tn.spec              || 34, 'ContextCross.States.AircraftSpecificationState'),
    dyn:         ns(tn.dynInternal       || 38, 'ContextCross.Dynamics.DynamicInternalState'),
    approachDyn: ns(tn.approachDynParams || 47, 'ContextCross.Dynamics.States.ApproachDynamicsParams'),
    acRwy:       ns(tn.acRwy             || 42, 'ContextCross.States.AircraftRunwayCoordinateState'),
    float3:      ns(tn.float3            || 35, 'Unity.Mathematics.float3', 'Unity.Mathematics'),
    vec4:        ns(tn.vec4              || 37, 'UnityEngine.Vector4', 'UnityEngine.CoreModule'),
    dockArr:     ns(tn.vec4Arr           || 36, 'UnityEngine.Vector4[]', 'UnityEngine.CoreModule'),
    waitCmd:     ns(tn.waitCmd           || 43, 'ContextCross.Enums.ECommand[]'),
    recvEvt:     ns(tn.recvEvt           || 44, 'ContextCross.Events.AircraftEvent[]'),
  };

  const nsVec3 = '"16|UnityEngine.Vector3, UnityEngine.CoreModule"';
  const nsListVec3 = `"${tn.listVec3 || 46}|System.Collections.Generic.List\`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib"`;
  const nsStrArr = '"8|System.String[], mscorlib"';

  const fmtV3 = (v) => `{\n  "$type": ${nsVec3},\n  ${v.x},\n  0,\n  ${v.z}\n}`;
  const fmtFloat3 = (v) => `{\n  "$type": ${T.float3},\n  "x": ${v.x},\n  "y": ${v.y},\n  "z": ${v.z}\n}`;

  // Standard ILS glideslope — 3 degrees.
  // All AirwayNodes and PathPointList points have y=0 in the ACL
  // (Unity stores positions in the XZ plane). The game computes actual
  // altitude from the glideslope using REMAINING PATH DISTANCE (not
  // straight-line) to follow the approach route through turns.
  // Capped at the runway's approach ceiling (5000ft real-world, converted
  // to game units via per-airport coordinate scale).
  const TAN_3_DEG = Math.tan(3 * Math.PI / 180); // ≈ 0.052408
  const tdPos = state5Params.touchDownPosition || { x: 0, y: 0, z: 0 };
  const approachCap = (_explicitCap != null) ? _explicitCap : computeApproachCap();

  // Build PathPointList with glideslope-computed Y (not the stored Y=0).
  // Each point's Y = min(approachCap, pathDistanceToTD × tan(3°)).
  const ppList = state5Params.pathPointList || [];
  let pathPointsStr = '';

  // Pre-compute path distances from each point to touchdown.
  // Walk backwards through the path + tdPos to get cumulative distance.
  const fullPathPoints = ppList.length > 0 ? [...ppList, tdPos] : [tdPos];
  const pointDists = new Array(ppList.length);
  let cumDist = 0;
  for (let i = fullPathPoints.length - 2; i >= 0; i--) {
    cumDist += _vec3Dist(fullPathPoints[i], fullPathPoints[i + 1]);
    pointDists[i] = cumDist;
  }

  if (ppList.length > 0) {
    const pts = ppList.map((p, i) => {
      const pY = Math.min(approachCap, pointDists[i] * TAN_3_DEG);
      // TEMP: hardcode Y=0 — original game files store PathPointList points with Y=0
      // (flat XZ plane). The game computes altitude internally from the glideslope.
      // Non-zero Y values differ from the game's expected format.
      return `${i === 0 ? '' : ',\n'}{"$type": ${nsVec3}, ${p.x}, 0, ${p.z}}`; // TEMP: 0 instead of ${pY}
    }).join('');
    pathPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": ${ppList.length},\n"$rcontent": [\n${pts}\n]\n}`;
  } else {
    pathPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": 0,\n"$rcontent": []\n}`;
  }

  // Build DockingPositions
  let dockStr = '';
  const dp = spec.DockingPositions || [];
  if (dp.length > 0) {
    const dpts = dp.map((d, i) => `${i === 0 ? '' : ',\n'}{"$type": ${T.vec4}, ${d.x}, ${d.y}, ${d.z}, ${d.w}}`).join('');
    dockStr = `{\n"$id": ${id++},\n"$type": ${T.dockArr},\n"$rlength": ${dp.length},\n"$rcontent": [\n${dpts}\n]\n}`;
  } else {
    dockStr = `{\n"$id": ${id++},\n"$type": ${T.dockArr},\n"$rlength": 0,\n"$rcontent": []\n}`;
  }

  // Position: interpolate along the full path (STAR FlyApproach → PathPointList → TouchDown).
  // flyPoints = STAR FlyApproach path (ending at IAF)
  // ppList = approach procedure PathPointList (starting at IAF)
  // tdPos = runway touchdown threshold
  //
  // Deduplicate the IAF join: if the last STAR flyPoint is very close to the
  // first PathPointList point, trim the duplicate to avoid a zero-length segment.
  const dedupedFlyPoints = _dedupeIafJoin(flyPoints, ppList);
  const posFullPath = buildFullPath(dedupedFlyPoints, ppList, tdPos);
  const posPR = fullPR != null ? fullPR : 0;
  const totalPathLen = computePathLength(posFullPath);
  const targetDist = totalPathLen * Math.max(0, Math.min(1, posPR));
  const pos = _interpolateAlongPath(posFullPath, targetDist);
  // Y from 3° ILS glideslope using REMAINING PATH DISTANCE to touchdown.
  const remainingPathDist = totalPathLen - targetDist;
  const glideY = remainingPathDist * TAN_3_DEG;
  pos.y = Math.min(approachCap, glideY);

  // Direction: path tangent at current position along the full path.
  // The tangent naturally converges to the runway heading at touchdown but
  // follows the approach path through turns before that (e.g., SIE.CAMRM5→13L).
  const dir = _tangentAlongPath(posFullPath, targetDist);

  const block = `{
    "$id": ${id++},
    "$type": ${T.ac},
    "Guid": "${guid}",
    "Enabled": true,
    "State": 5,
    "Specification": {
      "$id": ${id++},
      "$type": ${T.spec},
      "Guid": null,
      "Enabled": false,
      "Designator": "${spec.Designator}",
      "AerodromeCode": ${spec.AerodromeCode},
      "WakeTurbulenceCategory": ${spec.WakeTurbulenceCategory},
      "WheelBase": ${spec.WheelBase},
      "ModelOffset": ${fmtFloat3(spec.ModelOffset)},
      "WingSpan": ${spec.WingSpan},
      "DockingPositions": ${dockStr},
      "RunwayVRSpeed": ${spec.RunwayVRSpeed},
      "RunwayTakeOffLength": ${spec.RunwayTakeOffLength}
    },
    "Direction": ${fmtV3(dir)},
    "DynamicInternalState": {
      "$type": ${T.dyn},
      "DynamicsState": 2,
      "TaxiSpeed": 240,
      "ForwardSpeed": true,
      "TargetTaxiSpeed": 240,
      "PositiveTaxiAcceleration": 1,
      "NegativeTaxiAcceleration": -2,
      "TaxiArrivalToSpotPath": null,
      "TaxiArrivalToHoldingPointPath": null,
      "FrontWheelSteeringAngle": 0,
      "DynamicsParams": {
        "$id": ${id++},
        "$type": ${T.approachDyn},
        "ProgressRatio": 0,
        "TouchDownPosition": ${fmtV3(state5Params.touchDownPosition || { x:0, z:0 })},
        "ApproachDirection": ${fmtV3(state5Params.approachDirection || { x:0, z:-1 })},
        "CommandedGoAround": false,
        "InitialPosition": {
          "$type": ${nsVec3},
          ${ppList.length > 0 ? ppList[0].x : 0},
          ${ppList.length > 0 ? Math.min(approachCap, pointDists[0] * TAN_3_DEG) : approachCap},
          ${ppList.length > 0 ? ppList[0].z : 0}
        },
        "PathPointList": ${pathPointsStr}
      }
    },
    "AircraftRunwayCoordinateState": {
      "$id": ${id++},
      "$type": ${T.acRwy},
      "Guid": null,
      "Enabled": false,
      "TaxiPathUnPassedIntersectionRunwayNames": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "TaxiBlockingRunwayNames": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwayFenceCurrentEnterRunways": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwayGuardCurrentEnterRunways": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "CrossRunwayPermissions": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwaySetterIdx": 0
    },
    "FlightPlanGuid": "${flightPlanGuid}",
    "ActiveFlightDirection": 1,
    "Position": {
      "$type": ${nsVec3},
      ${pos.x},
      ${pos.y},
      ${pos.z}
    },
    "RadioChannelGuid": "${towerChannelGuid}",
    "JurisdictionRadioChannelGuid": "${towerChannelGuid}",
    "TaxiPathStartingPosition": { "$type": ${nsVec3}, 0, 0, 0 },
    "TaxiPath": null,
    "RollingPresetTaxiPathStartingPosition": { "$type": ${nsVec3}, 0, 0, 0 },
    "RollingPresetTaxiPath": null,
    "SelectedRunwayEntryIndex": -1,
    "SelectedRunwayEntryRunwayGuid": null,
    "SelectedRunwayExitIndex": ${selectedRunwayExitIndex},
    "SelectedTaxiPushBackNodeGuid": null,
    "SelectedTowNavigationPointGuid": null,
    "IsFirstTaxi": false,
    "WaitingForCommands": {
      "$id": ${id++},
      "$type": ${T.waitCmd},
      "$rlength": ${waitingForCommand === 0 ? 0 : 1},
      "$rcontent": [${waitingForCommand === 0 ? '' : waitingForCommand}]
    },
    "ReceivedEvents": {
      "$id": ${id++},
      "$type": ${T.recvEvt},
      "$rlength": 0,
      "$rcontent": []
    },
    "Route": "${route}"
  }`;

  return {
    guid,
    block,
    nextId: id,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────

function _parseAircraftEntries(text) {
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
        const kMatch = block.match(/"\$k"\s*:\s*"([a-f0-9-]+)"/);
        const vBlock = _extractValueBlock(block);
        if (kMatch && vBlock) {
          entries.push({ guid: kMatch[1], block, vBlock });
        }
        start = -1;
      }
    }
  }
  return entries;
}

function _parseFlightPlanData(text) {
  const map = new Map(); // guid → { star, runway, landingTimeTicks, callsign }
  const fpIdx = text.indexOf('"FlightPlans"');
  if (fpIdx < 0) return map;

  const afterFp = text.substring(fpIdx);
  const rcMatch = afterFp.match(/"\$rcontent"\s*:\s*\[/);
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
        const vBlock = _extractValueBlock(block);
        if (vBlock) {
          const g = _extractString(vBlock, 'Guid');
          if (g) {
            const arrObj = _extractNestedObject(vBlock, 'Arrival');
            if (arrObj) {
              map.set(g, {
                star: _extractString(arrObj, 'STAR') || '',
                runway: _extractString(arrObj, 'Runway') || '',
                landingTimeTicks: _extractInt(arrObj, 'LandingTime') || 0,
                callsign: _extractString(arrObj, 'CallSign') || '',
              });
            }
          }
        }
        start = -1;
      }
    }
  }
  return map;
}

// ─── 9. Designator Mapping ────────────────────────────────────────

/**
 * Build AircraftType (full name) → Designator (ICAO code) mapping.
 * Cross-references FlightPlans with AircraftStates in ACL text.
 * Returns Map<string, string> e.g., "BOEING 737-800" → "B738".
 */
function buildDesignatorMapping(aclText) {
  const map = new Map();
  const fpMap = new Map(); // guid → AircraftType
  const fpIdx = aclText.indexOf('"FlightPlans"');
  if (fpIdx < 0) return map;

  const afterFp = aclText.substring(fpIdx);
  const rcMatch = afterFp.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return map;

  const absRc = fpIdx + rcMatch.index + rcMatch[0].length;
  const endPos = _findArrayEnd(aclText, absRc);
  if (!endPos) return map;

  const arr = aclText.substring(absRc, endPos);
  let depth = 0, start = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (arr[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const block = arr.substring(start, i + 1);
        const vBlock = _extractValueBlock(block);
        if (vBlock) {
          const guid = _extractString(vBlock, 'Guid');
          const at = _extractString(vBlock, 'AircraftType');
          if (guid && at) fpMap.set(guid, at);
        }
        start = -1;
      }
    }
  }

  // Now scan ALL Aircrafts entries (not just State=30) to get Designator
  // Some types only appear in parked (State=10) aircraft, not approach (State=30)
  const acEntries = _parseAircraftEntries(aclText);
  for (const entry of acEntries) {
    const vBlock = entry.vBlock;
    const fpGuid = _extractString(vBlock, 'FlightPlanGuid');
    if (!fpGuid || !fpMap.has(fpGuid)) continue;
    const specObj = _extractNestedObject(vBlock, 'Specification');
    const designator = specObj ? _extractString(specObj, 'Designator') : null;
    if (designator) {
      map.set(fpMap.get(fpGuid), designator);
    }
  }
  return map;
}

// ─── 9c. Type Map Extraction ──────────────────────────────────────

/**
 * Extract the type number → type name map from an ACL file.
 * Unity's JSON serializer assigns type numbers per-file sequentially — they are
 * NOT consistent across airports or even levels of the same airport. This function
 * captures ALL fully-qualified $type declarations so they can be preserved during
 * save, preventing type numbering drift.
 *
 * @param {string} aclText - raw ACL file content
 * @returns {Map<number, string>} type number → fully-qualified type name
 */
function extractTypeMap(aclText) {
  const typeMap = new Map();
  const typeDeclRegex = /"\$type":\s*"(\d+)\|([^"]+)"/g;
  let m;
  while ((m = typeDeclRegex.exec(aclText)) !== null) {
    const num = parseInt(m[1], 10);
    // First declaration wins — earliest in file is canonical
    if (!typeMap.has(num)) {
      typeMap.set(num, m[2]);
    }
  }
  return typeMap;
}

// ─── 9c. STAR Path Visualization Data ──────────────────────────────

/**
 * Build STAR path visualization data from appPointMap + SceneryData.
 * Groups appPointMap entries by STAR name, resolves full flight paths
 * (fly approach + app points) for each (STAR, runway) combo.
 *
 * Reuses resolveFlyApproachPoints() and buildFullPath() — the same
 * path-resolution functions used by computePosition() for approach aircraft.
 *
 * @param {string} aclText - raw ACL text containing SceneryData
 * @param {Map<string, Vector3[]>} appPointMap - Map<"STAR|Runway", Vector3[]> (may be null/empty)
 * @param {Object<string, string[]>} [starRunwayMap] - { starName → [runway, ...] } from SceneryData
 * @returns {{[starName: string]: Array<{runway: string, points: Vector3[]}>}}
 */
function buildStarPaths(aclText, appPointMap, starRunwayMap) {
  if (!aclText) return {};

  const starPaths = {};

  // ── Pass 1: appPointMap-driven paths (from State=30 aircraft) ──
  if (appPointMap && appPointMap.size > 0) {
    // Group appPointMap entries by STAR name
    const starGroups = new Map(); // starName -> [{runway, appPoints}]
    for (const [key, points] of appPointMap) {
      const pipeIdx = key.lastIndexOf('|');
      if (pipeIdx === -1) continue;
      const route = key.substring(0, pipeIdx);
      const runway = key.substring(pipeIdx + 1);
      if (!route || !runway) continue;
      if (!starGroups.has(route)) starGroups.set(route, []);
      starGroups.get(route).push({ runway, appPoints: points });
    }

    for (const [route, entries] of starGroups) {
      const routePaths = [];
      for (const { runway, appPoints } of entries) {
        // Resolve fly approach points from SceneryData AirwayNodes
        const flyPoints = resolveFlyApproachPoints(aclText, route, runway);
        // Build full path: fly approach + final approach points
        const fullPath = buildFullPath(flyPoints, appPoints, null);
        if (fullPath.length >= 2) {
          routePaths.push({ runway, points: fullPath });
        } else if (appPoints.length >= 2) {
          // Fallback: use appPoints alone if fly points couldn't be resolved
          routePaths.push({ runway, points: appPoints });
        }
      }
      if (routePaths.length > 0) {
        starPaths[route] = routePaths;
      }
    }
  }

  // ── Pass 2: starRunwayMap-driven paths (from SceneryData Routes Type=0) ──
  // Covers STAR+runway combos that exist in SceneryData but have no State=30
  // aircraft (so they're absent from appPointMap). Paths use only FlyApproach
  // waypoints from AirwayNodes — no AppPointList available.
  if (starRunwayMap) {
    for (const [starName, runways] of Object.entries(starRunwayMap)) {
      const existingRunways = new Set(
        (starPaths[starName] || []).map(v => v.runway)
      );
      for (const runway of runways) {
        if (existingRunways.has(runway)) continue; // already handled by Pass 1
        const flyPoints = resolveFlyApproachPoints(aclText, starName, runway);
        if (flyPoints.length >= 2) {
          if (!starPaths[starName]) starPaths[starName] = [];
          starPaths[starName].push({ runway, points: flyPoints });
        }
      }
    }
  }

  return starPaths;
}

// ─── 10. Approach Cache Builder ────────────────────────────────────

/**
 * Scan all production .acl files for an airport and build the approach cache.
 * @param {string} airportDir - path to .../Airports/<ICAO>/Levels/
 * @returns {{specDB: Map, appPointMap: Map, totalApproachTimes: Map, designatorMap: Map, typeMap: Map}}
 */
function buildApproachCache(airportDir) {
  const fs = require('fs');
  const path = require('path');
  const log = (msg) => console.log('[APPROACH-CACHE]', msg);

  // Find all .acl files (include demo, test, tutorial, endless, perfbench variants,
  // and .bak backups — needed for correct saveTimeOffsets computation).
  let aclFiles = [];
  try {
    const files = fs.readdirSync(airportDir);
    aclFiles = files
      .filter(f => f.endsWith('.acl') || f.endsWith('.acl.bak'))
      .map(f => path.join(airportDir, f));
  } catch (_) { return null; }

  if (aclFiles.length === 0) {
    log('WARNING: no .acl files found in ' + airportDir);
    return null;
  }

  log('Scanning ' + aclFiles.length + ' production files...');

  // Collect all approach entries from all files
  const allEntries = [];
  let specDB = new Map();
  let designatorMap = new Map();
  const typeMap = new Map(); // per-airport: type_number → type_name
  const fileTypeMaps = new Map(); // per-file: basename → Map<number, string>
  let firstAclText = null;

  for (const aclPath of aclFiles) {
    try {
      const text = fs.readFileSync(aclPath, 'utf-8');
      if (!firstAclText) firstAclText = text;
      const entries = extractApproachData(text);
      for (const e of entries) e._file = path.basename(aclPath);
      allEntries.push(...entries);

      // Merge specDB from each file (byte-identical per Designator, safe to merge)
      const fileSpecs = extractSpecificationDB(text);
      for (const [k, v] of fileSpecs) {
        if (!specDB.has(k)) specDB.set(k, v);
      }

      // Designator mapping from each file
      const dm = buildDesignatorMapping(text);
      for (const [k, v] of dm) designatorMap.set(k, v);

      // Type map from each file (first-write-wins across files within this airport)
      const fileTypeMap = extractTypeMap(text);
      for (const [k, v] of fileTypeMap) {
        if (!typeMap.has(k)) typeMap.set(k, v);
      }

      // Store per-file typeMap (keyed by basename) for save-time expansion.
      // Type numbers are per-file in Unity's JSON serialization — each .acl file
      // gets its own assignments. The per-file map survives repeated saves.
      fileTypeMaps.set(path.basename(aclPath), fileTypeMap);

      log('  ' + path.basename(aclPath) + ': ' + entries.length + ' approach a/c, ' + fileSpecs.size + ' specs, ' + fileTypeMap.size + ' types');
    } catch (e) {
      log('  SKIP ' + path.basename(aclPath) + ': ' + e.message);
    }
  }

  if (allEntries.length === 0) {
    log('WARNING: no approach aircraft found in any file');
    return null;
  }

  // ── Derive path data from SceneryData (NOT from Aircraft section) ──

  // Extract authoritative STAR↔runway mappings from SceneryData.
  // This captures ALL valid combos (not just those with State=30 aircraft).
  const starMappings = firstAclText
    ? extractStarRunwayMappings(firstAclText)
    : { starRunwayMap: {}, runwayStarMap: {} };

  // Build state5ParamsMap from SceneryData for all runways.
  // No dependency on State=5 aircraft — touchDownPosition, approachDirection,
  // pathPointList, and initialPosition all come from the scenery's approach procedures.
  // For runways with multiple Type=1 variants (e.g. ZSJN 01 has three
  // "RNAV ILS Z Rwy 01" variants), the first variant is stored under the
  // runway-only key as fallback. STAR-specific keys ("STAR|runway") are
  // added below in the appPointMap loop with variant-correct data.
  const state5ParamsMap = new Map();
  if (firstAclText && starMappings.runwayStarMap) {
    for (const runway of Object.keys(starMappings.runwayStarMap)) {
      const data = resolveApproachProcedureData(firstAclText, runway);
      if (data) {
        state5ParamsMap.set(runway, data);
        const normalized = _normalizeRunway(runway);
        if (normalized !== runway && !state5ParamsMap.has(normalized)) {
          state5ParamsMap.set(normalized, data);
        }
      }
    }
  }

  // Build appPointMap from SceneryData (Type=1 approach procedure routes).
  // Each STAR gets the approach procedure variant whose first AirwayNode is
  // closest to the STAR's last FlyApproach point — resolving the correct
  // variant when multiple "RNAV ILS Z Rwy XX" entries exist.
  const appPointMap = new Map();
  for (const [runway, stars] of Object.entries(starMappings.runwayStarMap)) {
    for (const star of stars) {
      // Resolve FlyApproach points to find the STAR's exit (IAF) point
      const flyPoints = resolveFlyApproachPoints(firstAclText, star, runway);
      const hintPos = (flyPoints && flyPoints.length > 0)
        ? flyPoints[flyPoints.length - 1]
        : null;

      // Get variant-correct approach procedure data for this STAR
      const s5 = resolveApproachProcedureData(firstAclText, runway, hintPos);
      if (!s5 || !s5.pathPointList || s5.pathPointList.length < 2) continue;

      appPointMap.set(star + '|' + runway, s5.pathPointList);

      // Also store STAR-specific state5Params entry for State=5 generation
      const s5Key = star + '|' + runway;
      if (!state5ParamsMap.has(s5Key)) {
        state5ParamsMap.set(s5Key, s5);
      }
    }
    // Also register normalized runway variant (e.g. "1" for "01")
    const normRunway = _normalizeRunway(runway);
    if (normRunway !== runway) {
      for (const star of stars) {
        const flyPoints = resolveFlyApproachPoints(firstAclText, star, normRunway);
        const hintPos = (flyPoints && flyPoints.length > 0)
          ? flyPoints[flyPoints.length - 1]
          : null;
        const s5n = resolveApproachProcedureData(firstAclText, normRunway, hintPos);
        if (!s5n || !s5n.pathPointList) continue;
        const key = star + '|' + normRunway;
        if (!appPointMap.has(key)) appPointMap.set(key, s5n.pathPointList);
        const s5Key = star + '|' + normRunway;
        if (!state5ParamsMap.has(s5Key)) {
          state5ParamsMap.set(s5Key, s5n);
        }
      }
    }
  }

  // Build starPaths from appPointMap and starRunwayMap.
  // Pass 1 uses appPointMap (now SceneryData-derived, covers all STARs).
  // Pass 2 uses starRunwayMap to add any STARs still missing (FlyApproach-only).
  const starPaths = firstAclText
    ? buildStarPaths(firstAclText, appPointMap, starMappings.starRunwayMap)
    : {};
  const runwayThresholds = firstAclText
    ? _parseRunwayThresholds(firstAclText)
    : {};

  // Compute per-airport coordinate scale from runway threshold geometry
  const airportScale = firstAclText
    ? computeAirportScale(firstAclText)
    : DEFAULT_AIRPORT_SCALE;

  // Compute totalApproachTimes from SceneryData path-length estimates.
  // Uses physics-based formula: TAT = totalGamePath × airportScale / 240kts
  // with ratio estimation from reference STARs on the same runway where available.
  const totalApproachTimes = computeApproachTimesFromScenery(
    firstAclText, starMappings, appPointMap, null, 1600, airportScale
  );

  // Compute per-file saveTime offsets from approach entries.
  // saveTime = LandingTime - (1 - PR) * totalApproachTime  → seconds since midnight
  const saveTimeOffsets = new Map(); // filename -> saveSec
  const fileGroups = new Map();
  for (const e of allEntries) {
    if (!e._file) continue;
    if (!fileGroups.has(e._file)) fileGroups.set(e._file, []);
    fileGroups.get(e._file).push(e);
  }
  const _toSec = (t) => { const p = String(t).split(':'); return +p[0]*3600 + +p[1]*60 + (+p[2]||0); };
  for (const [filename, entries] of fileGroups) {
    const offsets = [];
    for (const e of entries) {
      const tat = totalApproachTimes.get(e.route) || 1600;
      const lt = e.landingTimeTicks;
      if (!lt || lt === 0) continue;
      const baseTicks = Math.floor(lt / 864000000000) * 864000000000;
      const ltSec = (lt - baseTicks) / 10000000;
      const saveSec = ltSec - (1 - e.progressRatio) * tat;
      offsets.push(saveSec);
    }
    if (offsets.length > 0) {
      offsets.sort((a, b) => a - b);
      saveTimeOffsets.set(filename, Math.round(offsets[Math.floor(offsets.length / 2)]));
    }
  }

  log('Done: ' + specDB.size + ' specs, ' + appPointMap.size + ' route combos, ' +
      totalApproachTimes.size + ' routes, ' + designatorMap.size + ' type mappings, ' +
      saveTimeOffsets.size + ' file saveTime offsets, ' + typeMap.size + ' type declarations, ' +
      fileTypeMaps.size + ' file typeMaps, ' + state5ParamsMap.size + ' state5 route combos, ' +
      Object.keys(starPaths).length + ' star paths (' +
      Object.keys(starMappings.starRunwayMap).length + ' STARs from SceneryData), ' +
      'airportScale=' + (airportScale ? airportScale.toFixed(1) : 'N/A') + ', ' +
      Object.keys(runwayThresholds).length + ' runways');

  // Clean up _file property from entries
  for (const e of allEntries) delete e._file;

  return {
    specDB, appPointMap, totalApproachTimes, designatorMap,
    saveTimeOffsets, typeMap, fileTypeMaps, state5ParamsMap,
    starPaths, runwayThresholds, airportScale,
    starRunwayMap: starMappings.starRunwayMap,
    runwayStarMap: starMappings.runwayStarMap,
  };
}

// ─── 9b. AircraftAnimators Block Builder ──────────────────────────

function buildAnimatorBlock(aircraftGuid, opts) {
  const { nextId = 80000, acTypeNum = 33, typeNums = null } = opts || {};
  const tn = typeNums || {};
  const ns = (num, name) => `"${num}|${name}, GroundATC.Core"`;
  const animType = ns(tn.animState || 51, 'ContextCross.States.AircraftAnimatorState');
  const stateType = ns(tn.animSubState || 52, 'ContextCross.States.AircraftAnimState');
  let id = nextId;

  const block = `{
    "$id": ${id++},
    "$type": ${animType},
    "Guid": "ac_anim::${aircraftGuid}",
    "Enabled": true,
    "AircraftGuid": "${aircraftGuid}",
    "AnimState": {
      "$id": ${id++},
      "$type": ${stateType},
      "Version": 2,
      "HasSnapshot": true,
      "FlapRatio": 0.5,
      "SlatRatio": 0.75,
      "GearRatio": 1,
      "IsGearMoving": false,
      "GearTargetRatio": 1,
      "GoAroundPhase": 0,
      "HasGoAroundCommandTick": false,
      "GoAroundCommandTick": 0,
      "GearRetractIssued": false
    }
  }`;

  return { guid: 'ac_anim::' + aircraftGuid, block, nextId: id };
}

// ─── 10b. Extract GameTime from ACL text ──────────────────────────

function extractGameTime(aclText) {
  // Use tokenizer to find GameTime section, then pre-processor + JSON.parse
  const t = createTokenizer(aclText);
  const gtSec = t.findSection('GameTime');
  if (!gtSec) return null;

  const gtText = t.substring(gtSec.valueStart, gtSec.valueEnd);
  try {
    const cleaned = preprocessUnityJson(gtText);
    const parsed = JSON.parse(cleaned);
    const cdt = parsed.CurrentDateTime;
    if (cdt && cdt.__v && cdt.__v.length > 0) {
      const ticks = BigInt(cdt.__v[0]);
      const baseTicks = (ticks / 864000000000n) * 864000000000n;
      return Number((ticks - baseTicks) / 10000000n);
    }
  } catch (_) {
    // Fallback to regex
  }

  // Fallback: regex extraction
  const gtIdx = aclText.indexOf('"GameTime"');
  if (gtIdx < 0) return null;
  const sub = aclText.substring(gtIdx, gtIdx + 2000);
  const cdtMatch = sub.match(/"CurrentDateTime"[\s\S]{0,200}?"\$type":\s*(?:"\d+\|[^"]*"|\d+)\s*,\s*(-?\d+)/);
  if (!cdtMatch) return null;
  const ticks = parseInt(cdtMatch[1]);
  const baseTicks = Math.floor(ticks / 864000000000) * 864000000000;
  return Math.round((ticks - baseTicks) / 10000000); // seconds since midnight
}

// ─── 10c. Extract saveTime from ACL approach entries ──────────────

function extractSaveTime(aclText, totalApproachTimes) {
  const wsIdx = aclText.indexOf('"WorldState"');
  if (wsIdx < 0) return null;
  const acIdx = aclText.indexOf('"Aircrafts"', wsIdx);
  if (acIdx < 0) return null;

  // Find first State=30 entry: PR, Route, FlightPlanGuid
  const stMatch = aclText.substring(acIdx).match(/"State":\s*30\b/);
  if (!stMatch) return null;

  // Extract the $v block containing this State=30
  const pos = acIdx + stMatch.index;
  const vTag = aclText.lastIndexOf('"$v"', pos);
  if (vTag < 0) return null;
  const vOpen = aclText.indexOf('{', vTag);
  let d = 1, e = vOpen + 1;
  for (; e < aclText.length; e++) { if (aclText[e] === '{') d++; else if (aclText[e] === '}') { d--; if (d === 0) break; } }
  const vBlock = aclText.substring(vOpen, e + 1);

  const prMatch = vBlock.match(/"ProgressRatio":\s*([\d.eE+\-]+)/);
  const routeMatch = vBlock.match(/"Route":\s*"([^"]*)"/);
  const fpMatch = vBlock.match(/"FlightPlanGuid":\s*"([^"]+)"/);
  if (!prMatch || !fpMatch) return null;

  const pr = parseFloat(prMatch[1]);
  const route = routeMatch ? routeMatch[1] : '';
  const tat = (totalApproachTimes && totalApproachTimes.get(route)) || 1600;

  // Find this FlightPlan's LandingTime
  const fpIdx = aclText.indexOf('"FlightPlans"');
  if (fpIdx < 0) return null;
  const fpText = aclText.substring(fpIdx);
  const fpRe = new RegExp('"Guid":\\s*"' + fpMatch[1] + '"[\\s\\S]{0,2000}?"LandingTime":\\s*\\{\\s*"\\$type":\\s*3\\s*,\\s*(-?\\d+)\\s*\\}');
  const ltMatch = fpText.match(fpRe);
  if (!ltMatch) return null;

  const origLT = parseInt(ltMatch[1]);
  const baseTicks = Math.floor(origLT / 864000000000) * 864000000000;
  const saveTicks = origLT - (1 - pr) * tat * 10000000;
  const saveSec = Math.round((saveTicks - baseTicks) / 10000000);
  return saveSec;
}

// ─── 11. Cache Serialization ──────────────────────────────────────

/**
 * Serialize approach cache to JSON-safe plain objects.
 * Converts Map objects to plain { key: value } for disk storage.
 */
function serializeApproachCache(cache) {
  if (!cache) return null;
  const out = {};
  if (cache.specDB) { out.specDB = {}; for (const [k, v] of cache.specDB) out.specDB[k] = v; }
  if (cache.designatorMap) { out.designatorMap = {}; for (const [k, v] of cache.designatorMap) out.designatorMap[k] = v; }
  if (cache.saveTimeOffsets) { out.saveTimeOffsets = {}; for (const [k, v] of cache.saveTimeOffsets) out.saveTimeOffsets[k] = v; }
  if (cache.typeMap) { out.typeMap = {}; for (const [k, v] of cache.typeMap) out.typeMap[String(k)] = v; }
  if (cache.fileTypeMaps) { out.fileTypeMaps = {}; for (const [fileName, tm] of cache.fileTypeMaps) { const obj = {}; for (const [k, v] of tm) obj[String(k)] = v; out.fileTypeMaps[fileName] = obj; } }
  if (cache.totalApproachTimes) { out.totalApproachTimes = {}; for (const [k, v] of cache.totalApproachTimes) out.totalApproachTimes[k] = v; }
  if (cache.appPointMap) { out.appPointMap = {}; for (const [k, v] of cache.appPointMap) out.appPointMap[k] = v; }
  if (cache.state5ParamsMap) { out.state5ParamsMap = {}; for (const [k, v] of cache.state5ParamsMap) out.state5ParamsMap[k] = v; }
  if (cache.starPaths) { out.starPaths = cache.starPaths; }
  if (cache.runwayThresholds) { out.runwayThresholds = cache.runwayThresholds; }
  if (cache.airportScale != null) { out.airportScale = cache.airportScale; }
  if (cache.starRunwayMap) { out.starRunwayMap = cache.starRunwayMap; }
  if (cache.runwayStarMap) { out.runwayStarMap = cache.runwayStarMap; }
  return out;
}

/**
 * Deserialize approach cache from JSON.
 * Reconstructs Map objects from plain { key: value } objects.
 */
function deserializeApproachCache(json) {
  if (!json) return null;
  const cache = {};
  if (json.specDB && typeof json.specDB === 'object') { cache.specDB = new Map(Object.entries(json.specDB)); }
  if (json.designatorMap && typeof json.designatorMap === 'object') { cache.designatorMap = new Map(Object.entries(json.designatorMap)); }
  if (json.saveTimeOffsets && typeof json.saveTimeOffsets === 'object') { cache.saveTimeOffsets = new Map(Object.entries(json.saveTimeOffsets)); }
  if (json.typeMap && typeof json.typeMap === 'object') { cache.typeMap = new Map(Object.entries(json.typeMap).map(([k, v]) => [parseInt(k, 10), v])); }
  if (json.fileTypeMaps && typeof json.fileTypeMaps === 'object') { cache.fileTypeMaps = new Map(Object.entries(json.fileTypeMaps).map(([name, obj]) => [name, new Map(Object.entries(obj).map(([k, v]) => [parseInt(k, 10), v]))])); }
  if (json.totalApproachTimes && typeof json.totalApproachTimes === 'object') { cache.totalApproachTimes = new Map(Object.entries(json.totalApproachTimes)); }
  if (json.appPointMap && typeof json.appPointMap === 'object') { cache.appPointMap = new Map(Object.entries(json.appPointMap)); }
  if (json.state5ParamsMap && typeof json.state5ParamsMap === 'object') { cache.state5ParamsMap = new Map(Object.entries(json.state5ParamsMap)); }
  if (json.starPaths && typeof json.starPaths === 'object') { cache.starPaths = json.starPaths; }
  if (json.runwayThresholds && typeof json.runwayThresholds === 'object') { cache.runwayThresholds = json.runwayThresholds; }
  if (json.airportScale != null && typeof json.airportScale === 'number') { cache.airportScale = json.airportScale; }
  if (json.starRunwayMap && typeof json.starRunwayMap === 'object') { cache.starRunwayMap = json.starRunwayMap; }
  if (json.runwayStarMap && typeof json.runwayStarMap === 'object') { cache.runwayStarMap = json.runwayStarMap; }
  return cache;
}

// ─── Public API ──────────────────────────────────────────────────

module.exports = {
  // Data extraction
  extractSpecificationDB,
  extractApproachData,
  extractState5Data,
  extractTypeMap,
  buildAppPointMap,
  buildState5ParamsMap,

  // Path resolution
  resolveFlyApproachPoints,
  resolveApproachProcedureData,

  // Computation
  computeProgressRatio,
  computePosition,
  computeDirection,
  buildFullPath,
  computePathLength,
  computeApproachTimesFromScenery,
  computeAirportScale,
  computeApproachCap,
  computeFullTerminalPath,

  // Designator mapping & cache
  buildDesignatorMapping,
  buildApproachCache,
  buildStarPaths,
  extractStarRunwayMappings,
  extractSaveTime,
  extractGameTime,
  serializeApproachCache,
  deserializeApproachCache,

  // Assembly
  buildApproachAircraftBlock,
  buildState5AircraftBlock,
  buildAnimatorBlock,

  // Internal exports (for testing)
  _normalizeRunway,
  _vec3Sub, _vec3Add, _vec3Scale, _vec3Length, _vec3Normalize, _vec3Dist,
  _interpolateAlongPath, _tangentAlongPath,
  _findArrayEnd, _extractValueBlock, _extractNestedObject,
  _extractFloat, _extractInt, _extractString, _extractVector3, _extractVector3Array,
  _parseAircraftEntries, _parseFlightPlanData, _parseAirwayNodes, _parseTaxiwayNodes,
  _parseRunwayThresholds,
  _resolveFromAirwaySegments, _findRunwayGuid,
};
