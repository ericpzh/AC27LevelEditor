/**
 * Taxiway path parser — extracts taxiway centerline segments from SceneryData.
 *
 * TaxiwaySegments is a $k/$v dictionary in SceneryData where each $v block
 * contains a Nodes.$rcontent array (GUIDs of TaxiwayNode endpoints forming a
 * single line segment) and an optional Name for the taxiway segment.
 *
 * Nodes are resolved via the existing _parseTaxiwayNodes() helper.
 * Stand-access segments (nodes touching stand positions) are marked with
 * isStandAccess: true so the renderer can style them differently.
 */

const { createTokenizer } = require('./tokenizer');
const { _parseTaxiwayNodes, _detectSchemaVersion } = require('./approach');

// ─── Helpers (structural, no regex) ────────────────────────────

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

/**
 * Extract a GUID array from a Nodes block inside a $v entry.
 */
function _extractNodesGuids(text) {
  const nodesIdx = text.indexOf('"Nodes"');
  if (nodesIdx < 0) return null;

  const rcIdx = text.indexOf('"$rcontent"', nodesIdx);
  if (rcIdx < 0) return null;

  const bracketIdx = text.indexOf('[', rcIdx);
  if (bracketIdx < 0) return null;

  let depth = 0;
  let endIdx = bracketIdx;
  for (let i = bracketIdx; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }

  const arrText = text.substring(bracketIdx, endIdx);
  const guids = [];
  const gRe = /"([a-f0-9-]{36})"/g;
  let m;
  while ((m = gRe.exec(arrText)) !== null) guids.push(m[1]);
  return guids.length > 0 ? guids : null;
}

/**
 * Build a Set of node GUIDs that are used by stand positions
 * (TailPositionGuid + NosePositionGuid) so we can mark taxiway
 * segments as stand-access stubs for differentiated rendering.
 */
function _extractStandNodeGuids(sdText, sdT) {
  const standGuids = new Set();

  const standsSec = sdT.findSection('Stands');
  if (!standsSec) return standGuids;

  const standsText = sdT.substring(standsSec.valueStart, standsSec.valueEnd);
  const gRe = /"(?:TailPositionGuid|NosePositionGuid)"\s*:\s*"([a-f0-9-]+)"/g;
  let m;
  while ((m = gRe.exec(standsText)) !== null) {
    standGuids.add(m[1]);
  }
  return standGuids;
}

// ─── Main parser ────────────────────────────────────────────────

/**
 * Parse taxiway centerline segments from SceneryData.TaxiwaySegments.
 *
 * Each entry is a $k/$v pair where $v contains:
 *   Name:   string (may be empty)
 *   Nodes:  { $rcontent: [nodeGuid1, nodeGuid2] }
 *   Flags:  integer (1=standard, 2=wider, 4=special)
 *
 * Stand-access segments (touching stand-position nodes) are marked with
 * isStandAccess: true for differentiated rendering (thicker lines).
 *
 * @param {string} aclText - raw ACL file content
 * @param {Map<string,{x:number,y:number,z:number}>} [existingNodesMap] - pre-parsed node map (avoids re-parsing TaxiwayNodes)
 * @returns {{ paths: Array<{ name: string, flags: number, isStandAccess?: boolean, points: Array<{x: number, z: number}> }> }}
 */
function parseTaxiwayPaths(aclText, existingNodesMap, isV4) {
  const paths = [];

  // Auto-detect for backward compat
  if (isV4 === undefined) {
    isV4 = _detectSchemaVersion(aclText) === 4;
  }

  if (isV4) {
    // v4: iterate taxiway-segment:* entries from PKStaticEntities
    const { buildPkIndex, getPkEntriesByType, resolveIref, extractVector3FromV4, extractStringFromV4, extractIrefArray, extractIntFromV4, extractSingleIref } = require('./v4_pk_index');
    const pkIndex = buildPkIndex(aclText);

    // Build set of stand-associated node $ids for marking stand-access segments
    const standNodeIds = new Set();
    const stands = getPkEntriesByType(pkIndex, 'stand');
    for (const st of stands) {
      // TailPosition and NosePosition are $iref references — structural, no regex
      const tailIref = extractSingleIref(st.block, 'TailPosition');
      const noseIref = extractSingleIref(st.block, 'NosePosition');
      if (tailIref !== null) standNodeIds.add(tailIref);
      if (noseIref !== null) standNodeIds.add(noseIref);
    }

    // Iterate taxiway segments
    const segments = getPkEntriesByType(pkIndex, 'taxiway-segment');
    for (const seg of segments) {
      const name = extractStringFromV4(seg.block, 'Name') || '';
      const flags = extractIntFromV4(seg.block, 'Flags') || 1;
      const nodeIrefs = extractIrefArray(seg.block, 'Nodes');

      if (nodeIrefs.length >= 2) {
        const segPoints = [];
        for (const iref of nodeIrefs) {
          const resolved = resolveIref(pkIndex, iref);
          if (resolved) {
            const pos = extractVector3FromV4(resolved.block);
            if (pos) segPoints.push({ x: pos.x, z: pos.z });
          }
        }
        if (segPoints.length >= 2) {
          const isStandAccess = nodeIrefs.some(id => standNodeIds.has(id));
          paths.push({ name, flags, points: segPoints, ...(isStandAccess && { isStandAccess: true }) });
        }
      }
    }

    return { paths };
  }

  // v2/v3: SceneryData.TaxiwaySegments
  const sdIdx = aclText.indexOf('"SceneryData"');
  if (sdIdx < 0) return { paths };

  // Resolve nodes — use pre-parsed map if provided (avoids expensive re-parse)
  const nodesMap = existingNodesMap || _parseTaxiwayNodes(aclText);
  if (nodesMap.size === 0) return { paths };

  const sdText = aclText.substring(sdIdx);
  const sdT = createTokenizer(sdText);

  // Build set of stand-associated node GUIDs for marking stand-access segments
  const standNodeGuids = _extractStandNodeGuids(sdText, sdT);

  // Only look for TaxiwaySegments
  const tsSec = sdT.findSection('TaxiwaySegments');
  if (!tsSec) return { paths };

  const tsText = sdT.substring(tsSec.valueStart, tsSec.valueEnd);
  const tsT = createTokenizer(tsText);

  const rcSec = tsT.findSection('$rcontent');
  if (!rcSec) return { paths };

  // Iterate $k/$v entries
  let pos = rcSec.valueStart + 1;
  while (pos < tsText.length) {
    while (pos < tsText.length && ' \t\n\r'.includes(tsText[pos])) pos++;
    if (pos >= tsText.length || tsText[pos] === ']') break;
    if (tsText[pos] === ',') { pos++; continue; }
    if (tsText[pos] === '{') {
      const entryEnd = tsT.findObjectEnd(pos);
      if (entryEnd === null) break;
      const block = tsText.substring(pos, entryEnd);

      // Find the $v block value
      let actualVBlock = null;
      const vKeyIdx = block.indexOf('"$v"');
      if (vKeyIdx >= 0) {
        const colonIdx = block.indexOf(':', vKeyIdx);
        if (colonIdx >= 0) {
          let vStart = colonIdx + 1;
          while (vStart < block.length && ' \t\n\r'.includes(block[vStart])) vStart++;
          if (vStart < block.length && block[vStart] === '{') {
            const vEnd = tsT.findObjectEnd(vStart);
            if (vEnd !== null) actualVBlock = block.substring(vStart, vEnd);
          }
        }
      }
      if (!actualVBlock) actualVBlock = block;

      const name = _extractString(actualVBlock, 'Name', isV4) || '';
      const flags = _extractInt(actualVBlock, 'Flags', isV4) || 1;
      const guids = _extractNodesGuids(actualVBlock);

      // Keep all segments, mark stand-access stubs for differentiated rendering
      if (guids && guids.length >= 2) {
        const points = [];
        for (const guid of guids) {
          const node = nodesMap.get(guid);
          if (node) points.push({ x: node.x, z: node.z !== undefined ? node.z : node.y });
        }
        if (points.length >= 2) {
          const isStandAccess = standNodeGuids.size > 0 && guids.some(g => standNodeGuids.has(g));
          paths.push({ name, flags, points, ...(isStandAccess && { isStandAccess: true }) });
        }
      }

      pos = entryEnd;
    } else {
      pos++;
    }
  }

  return { paths };
}

module.exports = { parseTaxiwayPaths };
