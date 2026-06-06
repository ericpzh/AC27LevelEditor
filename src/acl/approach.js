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

// ─── ACL text parsing helpers ─────────────────────────────────────

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

function _extractValueBlock(block) {
  const vIdx = block.indexOf('"$v"');
  if (vIdx < 0) return null;
  const colon = block.indexOf(':', vIdx);
  const brace = block.indexOf('{', colon);
  let depth = 1, end = brace + 1;
  for (; end < block.length; end++) {
    if (block[end] === '{') depth++;
    else if (block[end] === '}') { depth--; if (depth === 0) break; }
  }
  return block.substring(brace, end + 1);
}

function _extractNestedObject(text, key) {
  const idx = text.indexOf('"' + key + '"');
  if (idx < 0) return null;
  const colon = text.indexOf(':', idx);
  const brace = text.indexOf('{', colon);
  if (brace < 0) return null;
  let depth = 1, end = brace + 1;
  for (; end < text.length; end++) {
    if (text[end] === '{') depth++;
    else if (text[end] === '}') { depth--; if (depth === 0) break; }
  }
  return text.substring(brace, end + 1);
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
      position: position || { x: 0, y: 15.24, z: 0 },
    });
  }

  return results;
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

  // Read the RunwayState entry's Routes array
  const rwEntry = _findDictionaryEntry(aclText.substring(sdIdx), runwayGuid);
  if (!rwEntry) return [];

  const routesBlock = _extractNestedObject(rwEntry, 'Routes');
  if (!routesBlock) return [];

  // Find route with matching Name
  const routeRe = new RegExp('"Name"\\s*:\\s*"' + _escapeRegex(route) + '"');
  let matchPos = 0;
  let routeEntry = null;
  while (true) {
    const m = routeRe.exec(routesBlock.substring(matchPos));
    if (!m) break;
    // Find the enclosing { ... } for this Route entry
    const entryStart = _findEnclosingBrace(routesBlock, matchPos + m.index);
    if (entryStart >= 0) {
      const candidate = routesBlock.substring(entryStart);
      const entryEnd = _findMatchingBrace(candidate, 0);
      if (entryEnd >= 0) {
        routeEntry = candidate.substring(0, entryEnd + 1);
        break;
      }
    }
    matchPos += m.index + m[0].length;
  }

  if (!routeEntry) {
    // Fallback: find by AirwaySegments name
    return _resolveFromAirwaySegments(aclText, route);
  }

  // Extract AirwayNodeGuids array
  const guids = _extractGuidArray(routeEntry, 'AirwayNodeGuids');
  if (!guids || guids.length === 0) return [];

  // Resolve each GUID to AirwayNode Position
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
  const rwIdx = sdText.indexOf('"Runways"');
  if (rwIdx < 0) return null;
  const rwSection = sdText.substring(rwIdx);

  // Parse the Runways dictionary entries: each is {"$k": "guid", "$v": { ... RunwayState ... }}
  // We need to find the RunwayState whose Name or PhysicalName matches runwayName
  const rcMatch = rwSection.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return null;
  const absRc = rcMatch.index + rcMatch[0].length;
  const endPos = _findArrayEnd(rwSection, absRc);
  if (!endPos) return null;
  const arr = rwSection.substring(absRc, endPos);

  // Each entry: { "$k": "guid", "$v": { ... } }
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
          const name = _extractString(vBlock, 'Name');
          const physName = _extractString(vBlock, 'PhysicalName');
          // Match either Name or PhysicalName containing runwayName
          if (name === runwayName || (physName && physName.includes(runwayName))) {
            return kMatch[1];
          }
        }
        start = -1;
      }
    }
  }
  return null;
}

function _findDictionaryEntry(sectionText, keyGuid) {
  const re = new RegExp('"\\$k"\\s*:\\s*"' + _escapeRegex(keyGuid) + '"');
  const m = re.exec(sectionText);
  if (!m) return null;
  const vIdx = sectionText.indexOf('"$v"', m.index);
  if (vIdx < 0) return null;
  const colon = sectionText.indexOf(':', vIdx);
  const brace = sectionText.indexOf('{', colon);
  let depth = 1, end = brace + 1;
  for (; end < sectionText.length; end++) {
    if (sectionText[end] === '{') depth++;
    else if (sectionText[end] === '}') { depth--; if (depth === 0) break; }
  }
  return sectionText.substring(brace, end + 1);
}

function _findEnclosingBrace(text, pos) {
  // Go backwards to find the opening { of the enclosing object
  let depth = 0;
  for (let i = pos; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

function _findMatchingBrace(text, start) {
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function _extractGuidArray(text, key) {
  const idx = text.indexOf('"' + key + '"');
  if (idx < 0) return null;
  const rcMatch = text.substring(idx).match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return null;
  const absRc = idx + rcMatch.index + rcMatch[0].length;
  const endPos = _findArrayEnd(text, absRc);
  if (!endPos) return null;

  const arr = text.substring(absRc, endPos);
  const guids = [];
  const gRe = /"([a-f0-9-]{36})"/g;
  let m;
  while ((m = gRe.exec(arr)) !== null) {
    guids.push(m[1]);
  }
  return guids;
}

function _resolveFromAirwaySegments(aclText, route) {
  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return [];
  const sdText = aclText.substring(sdIdx);

  const asIdx = sdText.indexOf('"AirwaySegments"');
  if (asIdx < 0) return [];

  const asSection = sdText.substring(asIdx);
  const nameRe = new RegExp('"Name"\\s*:\\s*"' + _escapeRegex(route) + '"');
  const nm = nameRe.exec(asSection);
  if (!nm) return [];

  const entryStart = _findEnclosingBrace(asSection, nm.index);
  if (entryStart < 0) return [];
  const entryBlock = asSection.substring(entryStart);
  const entryEnd = _findMatchingBrace(entryBlock, 0);
  if (entryEnd < 0) return [];
  const routeEntry = entryBlock.substring(0, entryEnd + 1);

  const guids = _extractGuidArray(routeEntry, 'Nodes');
  if (!guids || guids.length === 0) return [];

  const airwayNodes = _parseAirwayNodes(aclText);
  const points = [];
  for (const guid of guids) {
    const node = airwayNodes.get(guid);
    if (node) points.push(node.position);
  }
  return points;
}

function _parseAirwayNodes(aclText) {
  const map = new Map(); // guid → { name, position }
  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return map;
  const sdText = aclText.substring(sdIdx);

  const anIdx = sdText.indexOf('"AirwayNodes"');
  if (anIdx < 0) return map;

  const anSection = sdText.substring(anIdx);
  const rcMatch = anSection.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return map;

  const absRc = anIdx + rcMatch.index + rcMatch[0].length;
  const endPos = _findArrayEnd(sdText, absRc);
  if (!endPos) return map;

  const arr = sdText.substring(absRc, endPos);
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
          const name = _extractString(vBlock, 'Name');
          const pos = _extractVector3(vBlock);
          if (pos) {
            map.set(kMatch[1], { name: name || '', position: pos });
          }
        }
        start = -1;
      }
    }
  }
  return map;
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
function buildFullPath(flyApproachPoints, appPoints) {
  return [...(flyApproachPoints || []), ...(appPoints || [])];
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
  if (!points || points.length === 0) return { x: 0, y: 15.24, z: 0 };
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
 * Compute Position from ProgressRatio along combined FlyApproach + App path.
 */
function computePosition(flyApproachPoints, appPoints, progressRatio) {
  const fullPath = buildFullPath(flyApproachPoints, appPoints);
  const totalLen = computePathLength(fullPath);
  const targetDist = totalLen * progressRatio;
  const pos = _interpolateAlongPath(fullPath, targetDist);
  pos.y = 15.24; // constant approach altitude
  return pos;
}

/**
 * Compute Direction (normalized XZ tangent) from ProgressRatio along combined path.
 */
function computeDirection(flyApproachPoints, appPoints, progressRatio) {
  const fullPath = buildFullPath(flyApproachPoints, appPoints);
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
    nextId = 5001,
  } = opts;

  const guid = _generateGuid();
  let id = nextId;

  // Use namespace-qualified $type strings to bypass the game's integer type registry.
  // This ensures all types resolve correctly regardless of $id continuity.
  const ns = (num, name, asm = 'GroundATC.Core') => `"${num}|${name}, ${asm}"`;
  const T = {
    ac: ns(opts.acTypeNum || 33, 'ContextCross.States.AircraftState'),
    spec: ns(opts.acTypeNum === 35 ? 36 : 34, 'ContextCross.States.AircraftSpecificationState'),
    dyn: ns(opts.acTypeNum === 35 ? 40 : 38, 'ContextCross.Dynamics.DynamicInternalState'),
    dynParams: ns(opts.acTypeNum === 35 ? 51 : 47, 'ContextCross.Dynamics.States.FlyApproachDynamicsParams'),
    acRwy: ns(opts.acTypeNum === 35 ? 43 : 42, 'ContextCross.States.AircraftRunwayCoordinateState'),
    float3: ns(opts.acTypeNum === 35 ? 37 : 35, 'Unity.Mathematics.float3', 'Unity.Mathematics'),
    vec4: ns(opts.acTypeNum === 35 ? 39 : 37, 'UnityEngine.Vector4', 'UnityEngine.CoreModule'),
    dockArr: ns(opts.acTypeNum === 35 ? 38 : 36, 'UnityEngine.Vector4[]', 'UnityEngine.CoreModule'),
    waitCmd: ns(opts.acTypeNum === 35 ? 47 : 43, 'ContextCross.Enums.ECommand[]'),
    recvEvt: ns(opts.acTypeNum === 35 ? 48 : 44, 'ContextCross.Events.AircraftEvent[]'),
  };

  // Format helpers — use namespace-qualified types everywhere
  const nsVec3 = '"16|UnityEngine.Vector3, UnityEngine.CoreModule"';
  const nsListVec3 = '"42|System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib"';
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
  const pos = computePosition(flyPoints, appPoints, progressRatio);
  const dir = computeDirection(flyPoints, appPoints, progressRatio);

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
    "JurisdictionRadioChannelGuid": null,
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

function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

// ─── 10. Approach Cache Builder ────────────────────────────────────

/**
 * Scan all production .acl files for an airport and build the approach cache.
 * @param {string} airportDir - path to .../Airports/<ICAO>/Levels/
 * @returns {{specDB: Map, appPointMap: Map, totalApproachTimes: Map, designatorMap: Map}}
 */
function buildApproachCache(airportDir) {
  const fs = require('fs');
  const path = require('path');
  const log = (msg) => console.log('[APPROACH-CACHE]', msg);

  // Find all .acl files (include demo, test, tutorial, endless, perfbench variants)
  let aclFiles = [];
  try {
    const files = fs.readdirSync(airportDir);
    aclFiles = files
      .filter(f => f.endsWith('.acl'))
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

  for (const aclPath of aclFiles) {
    try {
      const text = fs.readFileSync(aclPath, 'utf-8');
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

      log('  ' + path.basename(aclPath) + ': ' + entries.length + ' approach a/c, ' + fileSpecs.size + ' specs');
    } catch (e) {
      log('  SKIP ' + path.basename(aclPath) + ': ' + e.message);
    }
  }

  if (allEntries.length === 0) {
    log('WARNING: no approach aircraft found in any file');
    return null;
  }

  const appPointMap = buildAppPointMap(allEntries);
  const totalApproachTimes = computeTotalApproachTimes(allEntries, (e) => e._file);

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
      saveTimeOffsets.size + ' file saveTime offsets');

  // Clean up _file property from entries
  for (const e of allEntries) delete e._file;

  return { specDB, appPointMap, totalApproachTimes, designatorMap, saveTimeOffsets };
}

// ─── 9b. AircraftAnimators Block Builder ──────────────────────────

function buildAnimatorBlock(aircraftGuid, opts) {
  const { nextId = 80000, acTypeNum = 33 } = opts || {};
  const isKJFK = acTypeNum === 35;
  const ns = (num, name) => `"${num}|${name}, GroundATC.Core"`;
  const animType = ns(isKJFK ? 53 : 53, 'ContextCross.States.AircraftAnimatorState');
  const stateType = ns(isKJFK ? 54 : 54, 'ContextCross.States.AircraftAnimState');
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
  const gtIdx = aclText.indexOf('"GameTime"');
  if (gtIdx < 0) return null;
  const sub = aclText.substring(gtIdx, gtIdx + 2000);
  // Match both short-form "$type": 3, <ticks> and expanded "$type": "3|...", <ticks>
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
  if (cache.appPointMap) { out.appPointMap = {}; for (const [k, v] of cache.appPointMap) out.appPointMap[k] = v; }
  if (cache.totalApproachTimes) { out.totalApproachTimes = {}; for (const [k, v] of cache.totalApproachTimes) out.totalApproachTimes[k] = v; }
  if (cache.designatorMap) { out.designatorMap = {}; for (const [k, v] of cache.designatorMap) out.designatorMap[k] = v; }
  if (cache.saveTimeOffsets) { out.saveTimeOffsets = {}; for (const [k, v] of cache.saveTimeOffsets) out.saveTimeOffsets[k] = v; }
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
  if (json.appPointMap && typeof json.appPointMap === 'object') { cache.appPointMap = new Map(Object.entries(json.appPointMap)); }
  if (json.totalApproachTimes && typeof json.totalApproachTimes === 'object') { cache.totalApproachTimes = new Map(Object.entries(json.totalApproachTimes)); }
  if (json.designatorMap && typeof json.designatorMap === 'object') { cache.designatorMap = new Map(Object.entries(json.designatorMap)); }
  if (json.saveTimeOffsets && typeof json.saveTimeOffsets === 'object') { cache.saveTimeOffsets = new Map(Object.entries(json.saveTimeOffsets)); }
  return cache;
}

// ─── Public API ──────────────────────────────────────────────────

module.exports = {
  // Data extraction
  extractSpecificationDB,
  extractApproachData,
  buildAppPointMap,
  computeTotalApproachTimes,

  // Path resolution
  resolveFlyApproachPoints,

  // Computation
  computeProgressRatio,
  computePosition,
  computeDirection,
  buildFullPath,
  computePathLength,

  // Designator mapping & cache
  buildDesignatorMapping,
  buildApproachCache,
  extractSaveTime,
  extractGameTime,
  serializeApproachCache,
  deserializeApproachCache,

  // Assembly
  buildApproachAircraftBlock,
  buildAnimatorBlock,

  // Internal exports (for testing)
  _vec3Sub, _vec3Add, _vec3Scale, _vec3Length, _vec3Normalize, _vec3Dist,
  _interpolateAlongPath, _tangentAlongPath,
  _findArrayEnd, _extractValueBlock, _extractNestedObject,
  _extractFloat, _extractInt, _extractString, _extractVector3, _extractVector3Array,
  _parseAircraftEntries, _parseFlightPlanData, _parseAirwayNodes,
  _resolveFromAirwaySegments, _findRunwayGuid,
};
