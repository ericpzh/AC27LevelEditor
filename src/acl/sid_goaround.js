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

function _extractString(text, key, isV4) {
  if (isV4) {
    const t = createTokenizer(text);
    const sec = t.findSection(key);
    if (!sec || text[sec.valueStart] !== '"') return null;
    const strEnd = t.skipString(sec.valueStart);
    if (strEnd === null) return null;
    return text.substring(sec.valueStart + 1, strEnd - 1);
  } else {
    const re = new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*"([^"]*)"');
    const m = text.match(re);
    return m ? m[1] : null;
  }
}

function _extractInt(text, key, isV4) {
  if (isV4) {
    const t = createTokenizer(text);
    const sec = t.findSection(key);
    if (!sec) return null;
    return parseInt(text.substring(sec.valueStart, sec.valueEnd), 10);
  } else {
    const re = new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*(-?\\d+)');
    const m = text.match(re);
    return m ? parseInt(m[1], 10) : null;
  }
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
function _extractRouteMappingsByType(aclText, routeType, isV4) {
  const routeRunwayMap = {};  // { routeName → [runway, ...] }
  const runwayRouteMap = {};  // { runway → [routeName, ...] }

  if (!aclText) return { routeRunwayMap, runwayRouteMap };

  // Lazily import helpers from approach.js (inside function body, not module-level,
  // to avoid circular dependency at module load time).
  const { _extractValueBlock, _detectSchemaVersion } = require('./approach');

  // Auto-detect for backward compat
  if (isV4 === undefined) {
    isV4 = _detectSchemaVersion(aclText) === 4;
  }

  // RouteType values are identical across all file formats:
  // 0=STAR, 1=Approach, 2=SID, 3=Missed Approach
  const targetType = routeType;
  const typeField = isV4 ? 'RouteType' : 'Type';

  if (isV4) {
    // v4: iterate runway:* entries from PKStaticEntities
    const { buildPkIndex, getPkEntriesByType, extractStringFromV4 } = require('./v4_pk_index');
    const pkIndex = buildPkIndex(aclText);
    const runways = getPkEntriesByType(pkIndex, 'runway');

    for (const rw of runways) {
      const runwayName = extractStringFromV4(rw.block, 'Name');
      const physName = extractStringFromV4(rw.block, 'PhysicalName');
      if (!runwayName || !physName || !physName.includes('/')) continue;

      // Navigate Routes.$rcontent
      const { createTokenizer: ct } = require('./tokenizer');
      const routesBlock = _extractNestedObject(rw.block, 'Routes');
      if (!routesBlock) continue;

      const routesT = ct(routesBlock);
      const routesRc = routesT.findSection('$rcontent');
      if (!routesRc) continue;

      let rp = routesRc.valueStart + 1;
      while (rp < routesBlock.length) {
        while (rp < routesBlock.length && ' \t\n\r'.includes(routesBlock[rp])) rp++;
        if (rp >= routesBlock.length || routesBlock[rp] === ']') break;
        if (routesBlock[rp] === ',') { rp++; continue; }
        if (routesBlock[rp] === '{') {
          const reEnd = routesT.findObjectEnd(rp);
          if (reEnd === null) break;
          const routeEntry = routesBlock.substring(rp, reEnd);
          const rt = _extractInt(routeEntry, typeField, isV4);
          if (rt === targetType) {
            const routeName = _extractString(routeEntry, 'Name', isV4);
            if (routeName) {
              // Check for AirwayNodes data
              const { extractIrefArray } = require('./v4_pk_index');
              const irefs = extractIrefArray(routeEntry, 'AirwayNodes');
              if (irefs.length > 0) {
                if (!routeRunwayMap[routeName]) routeRunwayMap[routeName] = [];
                if (!routeRunwayMap[routeName].includes(runwayName)) routeRunwayMap[routeName].push(runwayName);
                if (!runwayRouteMap[runwayName]) runwayRouteMap[runwayName] = [];
                if (!runwayRouteMap[runwayName].includes(routeName)) runwayRouteMap[runwayName].push(routeName);
              }
            }
          }
          rp = reEnd;
        } else { rp++; }
      }
    }
    return { routeRunwayMap, runwayRouteMap };
  }

  // v2/v3: SceneryData → Runways
  // (helpers already imported at top of function)

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

      // Use _extractValueBlock (same as STAR extraction in approach.js) —
      // creates a tokenizer on the block itself, avoiding the position-offset
      // bug that previously broke SID/missed-approach extraction.
      const vBlock = _extractValueBlock(block);
      if (vBlock) {
        // Depth-aware Name extraction (same as approach.js:1107-1124)
        // avoids picking up nested Entry/route names like "A14" from
        // comparer entries instead of the runway designator.
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
        const physName = _extractString(vBlock, 'PhysicalName', isV4);

        // Only process actual runway entries (PhysicalName contains '/')
        if (runwayName && physName && physName.includes('/')) {
          // 4. Extract the Routes block and find Type=type entries
          const routesBlock = _extractNestedObject(vBlock, 'Routes');
          if (routesBlock) {
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
                  const type = _extractInt(routeEntry, 'Type', isV4);
                  if (type === routeType) {
                    const routeName = _extractString(routeEntry, 'Name', isV4);
                    // Skip stub routes with no waypoint data ($rlength: 0)
                    const guids = [];
                    const gReG = /"([a-f0-9-]{36})"/g;
                    let mG;
                    while ((mG = gReG.exec(routeEntry)) !== null) guids.push(mG[1]);
                    if (routeName && guids.length > 0) {
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
function _buildRoutePaths(aclText, routeRunwayMap, isV4) {
  const paths = {};
  if (!aclText || !routeRunwayMap) return paths;

  // Lazily import helpers from approach.js (inside function body to avoid
  // circular dependency at module load time).
  const { _parseAirwayNodes, _extractValueBlock, _detectSchemaVersion } = require('./approach');

  // Auto-detect for backward compat
  if (isV4 === undefined) {
    isV4 = _detectSchemaVersion(aclText) === 4;
  }

  if (isV4) {
    // v4: resolve paths per-runway from routeRunwayMap
    // Each runway's Routes array is the authoritative source for that runway's
    // AirwayNodes — same route name may have different node counts per runway.
    const { buildPkIndex, getPkEntriesByType, resolveIref, extractVector3FromV4, extractStringFromV4, extractIrefArray } = require('./v4_pk_index');
    const pkIndex = buildPkIndex(aclText);

    for (const [routeName, runways] of Object.entries(routeRunwayMap)) {
      const runwaySegments = [];

      for (const runway of runways) {
        // Find this specific runway entry by Name
        const allRunways = getPkEntriesByType(pkIndex, 'runway');
        let rwEntry = null;
        for (const rw of allRunways) {
          const rwName = extractStringFromV4(rw.block, 'Name');
          if (rwName === runway) { rwEntry = rw; break; }
        }
        if (!rwEntry) continue;

        // Navigate this runway's Routes to find the route by Name
        const routesBlock = _extractNestedObject(rwEntry.block, 'Routes');
        if (!routesBlock) continue;

        const routesT = createTokenizer(routesBlock);
        const routesRc = routesT.findSection('$rcontent');
        if (!routesRc) continue;

        let routeIrefs = null;
        let rp = routesRc.valueStart + 1;
        while (rp < routesBlock.length) {
          while (rp < routesBlock.length && ' \t\n\r'.includes(routesBlock[rp])) rp++;
          if (rp >= routesBlock.length || routesBlock[rp] === ']') break;
          if (routesBlock[rp] === ',') { rp++; continue; }
          if (routesBlock[rp] === '{') {
            const entryEnd = routesT.findObjectEnd(rp);
            if (entryEnd === null) break;
            const entry = routesBlock.substring(rp, entryEnd);
            const name = _extractString(entry, 'Name', isV4);
            if (name === routeName) {
              routeIrefs = extractIrefArray(entry, 'AirwayNodes');
              break;
            }
            rp = entryEnd;
          } else { rp++; }
        }

        if (!routeIrefs || routeIrefs.length === 0) continue;

        // Resolve each $iref to a position
        const points = [];
        for (const iref of routeIrefs) {
          const resolved = resolveIref(pkIndex, iref);
          if (resolved) {
            const pos = extractVector3FromV4(resolved.block);
            if (pos) points.push({ x: pos.x, z: pos.z });
          }
        }

        if (points.length >= 2) {
          runwaySegments.push({ runway, points });
        }
      }

      if (runwaySegments.length > 0) {
        paths[routeName] = runwaySegments;
      }
    }
    return paths;
  }

  // v2/v3: SceneryData
  // Resolve AirwayNodes and _extractValueBlock once
  // (helpers already imported at top of function)
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
          const name = _extractString(entry, 'Name', isV4);
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
          // Use _extractValueBlock — creates a tokenizer on the block itself,
          // avoiding the position-offset bug the original manual $v extraction had
          const vb = _extractValueBlock(block);
          if (vb) {
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

function extractSidRunwayMappings(aclText, isV4) {
  const { routeRunwayMap, runwayRouteMap } = _extractRouteMappingsByType(aclText, 2, isV4);
  return { sidRunwayMap: routeRunwayMap, runwaySidMap: runwayRouteMap };
}

function extractMissedApproachMappings(aclText, isV4) {
  const { routeRunwayMap, runwayRouteMap } = _extractRouteMappingsByType(aclText, 3, isV4);
  return { missedAppMap: routeRunwayMap, runwayMissedAppMap: runwayRouteMap };
}

function buildSidPaths(aclText, sidRunwayMap, isV4) {
  return _buildRoutePaths(aclText, sidRunwayMap, isV4);
}

function buildMissedApproachPaths(aclText, missedAppMap, isV4) {
  return _buildRoutePaths(aclText, missedAppMap, isV4);
}

function extractApprRunwayMappings(aclText, isV4) {
  const { routeRunwayMap, runwayRouteMap } = _extractRouteMappingsByType(aclText, 1, isV4);
  return { apprRunwayMap: routeRunwayMap, runwayApprMap: runwayRouteMap };
}

function buildApprPaths(aclText, apprRunwayMap, isV4) {
  return _buildRoutePaths(aclText, apprRunwayMap, isV4);
}

module.exports = {
  extractSidRunwayMappings,
  extractMissedApproachMappings,
  buildSidPaths,
  buildMissedApproachPaths,
  extractApprRunwayMappings,
  buildApprPaths,
};
