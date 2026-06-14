/**
 * SID (Type=2) and Missed Approach (Type=3) route path parsers.
 *
 * Mirrors the extractStarRunwayMappings + buildStarPaths pattern from approach.js,
 * extracting departure and go-around route polylines from SceneryData.Runways.
 *
 * Route types in SceneryData.Runways.Routes:
 *   Type 0 = STAR  (arrival transition)  — already parsed by approach.js
 *   Type 1 = RNAV approach procedure     — internal use (resolveApproachProcedureData)
 *   Type 2 = SID   (departure transition)
 *   Type 3 = Missed approach
 */

const { createTokenizer } = require('./tokenizer');

// ─── Helpers (inline to avoid circular deps on approach.js internals) ───

function _extractString(text, key) {
  const re = new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*"([^"]*)"');
  const m = text.match(re);
  return m ? m[1] : null;
}

function _extractInt(text, key) {
  const re = new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*(-?\\d+)');
  const m = text.match(re);
  return m ? parseInt(m[1], 10) : null;
}

function _extractNestedObject(text, key) {
  const keyIdx = text.indexOf('"' + key + '"');
  if (keyIdx < 0) return null;
  const colonIdx = text.indexOf(':', keyIdx);
  if (colonIdx < 0) return null;
  let start = colonIdx + 1;
  while (start < text.length && ' \t\n\r'.includes(text[start])) start++;
  if (start >= text.length || text[start] !== '{') return null;
  const t = createTokenizer(text);
  const end = t.findObjectEnd(start);
  return end !== null ? text.substring(start, end) : null;
}

// ─── A. Extract route mappings from SceneryData.Runways by Type ─────

/**
 * Extract route→runway mappings from SceneryData for a given route type.
 *
 * @param {string} aclText - raw ACL content
 * @param {number} routeType - 2 for SID, 3 for Missed Approach
 * @returns {{ routeRunwayMap: Object, runwayRouteMap: Object }}
 */
function _extractRouteMappingsByType(aclText, routeType) {
  const routeRunwayMap = {};  // { routeName → [runway, ...] }
  const runwayRouteMap = {};  // { runway → [routeName, ...] }

  if (!aclText) return { routeRunwayMap, runwayRouteMap };

  // 1. Navigate to SceneryData → Runways
  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return { routeRunwayMap, runwayRouteMap };
  const sdText = aclText.substring(sdIdx);
  const sdT = createTokenizer(sdText);
  const rwSec = sdT.findSection('Runways');
  if (!rwSec) return { routeRunwayMap, runwayRouteMap };

  const rwText = sdT.substring(rwSec.valueStart, rwSec.valueEnd);
  const rwT = createTokenizer(rwText);

  // 2. Find the MAIN $rcontent (skip nested ones like 'comparer')
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
        if (rwText[arrStart] === '[') { rwRcStart = arrStart; break; }
      }
    }
  }
  if (rwRcStart < 0) return { routeRunwayMap, runwayRouteMap };

  // 3. Iterate runway dictionary entries
  let pos = rwRcStart + 1;
  while (pos < rwText.length) {
    while (pos < rwText.length && ' \t\n\r'.includes(rwText[pos])) pos++;
    if (pos >= rwText.length || rwText[pos] === ']') break;
    if (rwText[pos] === ',') { pos++; continue; }
    if (rwText[pos] === '{') {
      const entryEnd = rwT.findObjectEnd(pos);
      if (entryEnd === null) break;
      const block = rwText.substring(pos, entryEnd);

      // Find $v block
      let runwayName = null;
      let physName = null;
      let routesBlock = null;
      const vKeyIdx = block.indexOf('"$v"');
      if (vKeyIdx >= 0) {
        const colonIdx = block.indexOf(':', vKeyIdx);
        if (colonIdx >= 0) {
          let vStart = colonIdx + 1;
          while (vStart < block.length && ' \t\n\r'.includes(block[vStart])) vStart++;
          if (vStart < block.length && block[vStart] === '{') {
            const vEnd = rwT.findObjectEnd(vStart);
            if (vEnd !== null) {
              const vBlock = block.substring(vStart, vEnd);
              runwayName = _extractString(vBlock, 'Name');
              physName = _extractString(vBlock, 'PhysicalName');
              routesBlock = _extractNestedObject(vBlock, 'Routes');
            }
          }
        }
      }

      if (runwayName && physName && physName.includes('/') && routesBlock) {
        const routesT = createTokenizer(routesBlock);
        const routesRc = routesT.findSection('$rcontent');
        if (routesRc) {
          let rp = routesRc.valueStart + 1;
          while (rp < routesBlock.length) {
            while (rp < routesBlock.length && ' \t\n\r'.includes(routesBlock[rp])) rp++;
            if (rp >= routesBlock.length || routesBlock[rp] === ']') break;
            if (routesBlock[rp] === ',') { rp++; continue; }
            if (routesBlock[rp] === '{') {
              const reEnd = routesT.findObjectEnd(rp);
              if (reEnd === null) break;
              const routeEntry = routesBlock.substring(rp, reEnd);
              const type = _extractInt(routeEntry, 'Type');
              if (type === routeType) {
                const routeName = _extractString(routeEntry, 'Name');
                if (routeName) {
                  if (!routeRunwayMap[routeName]) routeRunwayMap[routeName] = [];
                  if (!routeRunwayMap[routeName].includes(runwayName)) routeRunwayMap[routeName].push(runwayName);
                  if (!runwayRouteMap[runwayName]) runwayRouteMap[runwayName] = [];
                  if (!runwayRouteMap[runwayName].includes(routeName)) runwayRouteMap[runwayName].push(routeName);
                }
              }
              rp = reEnd;
            } else { rp++; }
          }
        }
      }
      pos = entryEnd;
    } else { pos++; }
  }

  return { routeRunwayMap, runwayRouteMap };
}

// ─── B. Build route polylines from AirwayNodes ──────────────────────

/**
 * Build route path polylines for a set of route→runway mappings.
 * Follows AirwayNode GUID chains via AirwaySegments (falling back to Runways.Routes).
 *
 * @param {string} aclText
 * @param {Object} routeRunwayMap — { routeName → [runway, ...] }
 * @returns {Object} — { [routeName]: [{ runway, points: Array<{x,z}> }] }
 */
function _buildRoutePaths(aclText, routeRunwayMap) {
  const paths = {};
  if (!aclText || !routeRunwayMap) return paths;

  // Resolve AirwayNodes once
  const { _parseAirwayNodes } = require('./approach');
  const airwayNodes = _parseAirwayNodes(aclText);

  // Find AirwaySegments section for route→GUID chain lookups
  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return paths;
  const sdText = aclText.substring(sdIdx);
  const sdT = createTokenizer(sdText);

  // Build a route name → AirwayNodeGuids map from AirwaySegments
  const asSec = sdT.findSection('AirwaySegments');
  const routeGuidMap = new Map(); // routeName → [guid, ...]
  if (asSec) {
    const asText = sdT.substring(asSec.valueStart, asSec.valueEnd);
    const asT = createTokenizer(asText);
    const rcSec = asT.findSection('$rcontent');
    if (rcSec) {
      let pos = rcSec.valueStart + 1;
      while (pos < asText.length) {
        while (pos < asText.length && ' \t\n\r'.includes(asText[pos])) pos++;
        if (pos >= asText.length || asText[pos] === ']') break;
        if (asText[pos] === ',') { pos++; continue; }
        if (asText[pos] === '{') {
          const entryEnd = asT.findObjectEnd(pos);
          if (entryEnd === null) break;
          const entry = asText.substring(pos, entryEnd);
          const name = _extractString(entry, 'Name');
          if (name) {
            const guids = [];
            const gRe = /"([a-f0-9-]{36})"/g;
            let m;
            while ((m = gRe.exec(entry)) !== null) guids.push(m[1]);
            if (guids.length > 0) routeGuidMap.set(name, guids);
          }
          pos = entryEnd;
        } else { pos++; }
      }
    }
  }

  // Also try Runways.Routes for entries not in AirwaySegments
  const rwSec = sdT.findSection('Runways');
  if (rwSec) {
    const rwText = sdT.substring(rwSec.valueStart, rwSec.valueEnd);
    const rwT = createTokenizer(rwText);
    let rwRcStart = -1, mainDepth = 0;
    for (let i = 0; i < rwText.length - 11; i++) {
      if (rwText[i] === '{') mainDepth++;
      else if (rwText[i] === '}') mainDepth--;
      else if (mainDepth === 1 && rwText.substring(i, i + 11) === '"$rcontent"') {
        const ci = rwText.indexOf(':', i + 11);
        if (ci >= 0) {
          let as = ci + 1;
          while (as < rwText.length && ' \t\n\r'.includes(rwText[as])) as++;
          if (rwText[as] === '[') { rwRcStart = as; break; }
        }
      }
    }
    if (rwRcStart >= 0) {
      let pos = rwRcStart + 1;
      while (pos < rwText.length) {
        while (pos < rwText.length && ' \t\n\r'.includes(rwText[pos])) pos++;
        if (pos >= rwText.length || rwText[pos] === ']') break;
        if (rwText[pos] === ',') { pos++; continue; }
        if (rwText[pos] === '{') {
          const ee = rwT.findObjectEnd(pos);
          if (ee === null) break;
          const block = rwText.substring(pos, ee);
          const vKeyIdx = block.indexOf('"$v"');
          if (vKeyIdx >= 0) {
            const ci2 = block.indexOf(':', vKeyIdx);
            if (ci2 >= 0) {
              let vs = ci2 + 1;
              while (vs < block.length && ' \t\n\r'.includes(block[vs])) vs++;
              if (vs < block.length && block[vs] === '{') {
                const ve = rwT.findObjectEnd(vs);
                if (ve !== null) {
                  const vb = block.substring(vs, ve);
                  const routesBlock = _extractNestedObject(vb, 'Routes');
                  if (routesBlock) {
                    const rtT = createTokenizer(routesBlock);
                    const rtRc = rtT.findSection('$rcontent');
                    if (rtRc) {
                      let rp = rtRc.valueStart + 1;
                      while (rp < routesBlock.length) {
                        while (rp < routesBlock.length && ' \t\n\r'.includes(routesBlock[rp])) rp++;
                        if (rp >= routesBlock.length || routesBlock[rp] === ']') break;
                        if (routesBlock[rp] === ',') { rp++; continue; }
                        if (routesBlock[rp] === '{') {
                          const re = rtT.findObjectEnd(rp);
                          if (re === null) break;
                          const reBlock = routesBlock.substring(rp, re);
                          const rName = _extractString(reBlock, 'Name');
                          if (rName && !routeGuidMap.has(rName)) {
                            const guids = [];
                            const gRe2 = /"([a-f0-9-]{36})"/g;
                            let m2;
                            while ((m2 = gRe2.exec(reBlock)) !== null) guids.push(m2[1]);
                            if (guids.length > 0) routeGuidMap.set(rName, guids);
                          }
                          rp = re;
                        } else { rp++; }
                      }
                    }
                  }
                }
              }
            }
          }
          pos = ee;
        } else { pos++; }
      }
    }
  }

  // Build polylines
  for (const [routeName, runways] of Object.entries(routeRunwayMap)) {
    const guids = routeGuidMap.get(routeName);
    if (!guids || guids.length === 0) continue;

    const points = [];
    for (const guid of guids) {
      const node = airwayNodes.get(guid);
      if (node && node.position) {
        points.push({ x: node.position.x, z: node.position.z });
      }
    }

    if (points.length >= 2) {
      paths[routeName] = runways.map(runway => ({ runway, points }));
    }
  }

  return paths;
}

// ─── C. Public API ──────────────────────────────────────────────────

function extractSidRunwayMappings(aclText) {
  const { routeRunwayMap, runwayRouteMap } = _extractRouteMappingsByType(aclText, 2);
  return { sidRunwayMap: routeRunwayMap, runwaySidMap: runwayRouteMap };
}

function extractMissedApproachMappings(aclText) {
  const { routeRunwayMap, runwayRouteMap } = _extractRouteMappingsByType(aclText, 3);
  return { missedAppMap: routeRunwayMap, runwayMissedAppMap: runwayRouteMap };
}

function buildSidPaths(aclText, sidRunwayMap) {
  return _buildRoutePaths(aclText, sidRunwayMap);
}

function buildMissedApproachPaths(aclText, missedAppMap) {
  return _buildRoutePaths(aclText, missedAppMap);
}

module.exports = {
  extractSidRunwayMappings,
  extractMissedApproachMappings,
  buildSidPaths,
  buildMissedApproachPaths,
};
