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
  const t = createTokenizer(text);
  const sec = t.findSection(key);
  if (!sec || text[sec.valueStart] !== '"') return null;
  const strEnd = t.skipString(sec.valueStart);
  if (strEnd === null) return null;
  return text.substring(sec.valueStart + 1, strEnd - 1);
}

function _extractInt(text, key) {
  const t = createTokenizer(text);
  const sec = t.findSection(key);
  if (!sec) return null;
  return parseInt(text.substring(sec.valueStart, sec.valueEnd), 10);
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

  // RouteType values are identical across all file formats:
  // 0=STAR, 1=Approach, 2=SID, 3=Missed Approach
  const targetType = routeType;
  const typeField = 'RouteType';

  // v4: iterate runway:* entries from PKStaticEntities
  const { buildPkIndex, getPkEntriesByType, extractStringFromV4 } = require('./v4_pk_index');
  const pkIndex = buildPkIndex(aclText);
  const runways = getPkEntriesByType(pkIndex, 'runway');

  for (const rw of runways) {
    const runwayName = extractStringFromV4(rw.block, 'Name');
    // v5: PhysicalName is inside nested PhysicalRunwayStaticItem (inline $id or $iref to inline)
    let physName = null;
    const physBlock = _extractNestedObject(rw.block, 'PhysicalRunwayStaticItem');
    if (physBlock) {
      const trimmed = physBlock.trim();
      if (trimmed.startsWith('$iref:')) {
        const iref = parseInt(trimmed.slice(6).trim(), 10);
        // Try PK index first, then fallback to raw text search for inline $id (e.g. ZSJN runway 01 $iref:8541)
        let resolved = require('./v4_pk_index').resolveIref(pkIndex, iref);
        if (resolved) {
          physName = extractStringFromV4(resolved.block, 'PhysicalName');
          if (!physName && resolved.block.trim().startsWith('$iref:')) {
            const iref2 = parseInt(resolved.block.trim().slice(6).trim(), 10);
            const resolved2 = require('./v4_pk_index').resolveIref(pkIndex, iref2);
            if (resolved2) physName = extractStringFromV4(resolved2.block, 'PhysicalName');
          }
        }
        if (!physName && aclText) {
          const idStr = '"$id": ' + iref;
          const idx = aclText.indexOf(idStr);
          if (idx >= 0) {
            const snippet = aclText.substring(Math.max(0, idx - 500), idx + 2000);
            const m = snippet.match(/"PhysicalName":\s*"([^"]+)"/);
            if (m) physName = m[1];
          }
        }
      } else {
        physName = extractStringFromV4(physBlock, 'PhysicalName');
      }
    }
    if (!physName) physName = extractStringFromV4(rw.block, 'PhysicalName');
    if (!runwayName) continue;
    if (physName && !physName.includes('/')) continue;
    if (!physName) physName = runwayName; // fallback for v5 $iref to inline case

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
        const rt = _extractInt(routeEntry, typeField);
        if (rt === targetType) {
          const routeName = _extractString(routeEntry, 'Name');
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
          const name = _extractString(entry, 'Name');
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

function extractApprRunwayMappings(aclText) {
  const { routeRunwayMap, runwayRouteMap } = _extractRouteMappingsByType(aclText, 1);
  return { apprRunwayMap: routeRunwayMap, runwayApprMap: runwayRouteMap };
}

function buildApprPaths(aclText, apprRunwayMap) {
  return _buildRoutePaths(aclText, apprRunwayMap);
}

module.exports = {
  extractSidRunwayMappings,
  extractMissedApproachMappings,
  buildSidPaths,
  buildMissedApproachPaths,
  extractApprRunwayMappings,
  buildApprPaths,
};
