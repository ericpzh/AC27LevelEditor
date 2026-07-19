/**
 * V4 PKStaticEntities Index — builds a structured lookup from the flat
 * StaticData.$blobdoc.PKStaticEntities.$rcontent array.
 *
 * In v4, all scenery entities (runways, stands, taxiway/airway nodes,
 * taxiway segments, jetways, etc.) live in a single flat array with
 * type-prefixed keys. Entities reference each other via $iref (pointing
 * to $id values) instead of v3's GUID strings.
 *
 * This module builds:
 *   byType  — Map<typePrefix, Map<pk, { block, id }>>
 *   byId    — Map<$id, { type, pk, block }>
 *
 * Cache: WeakMap<text, index> — a single ACL text string is parsed once
 * per buildApproachCache cycle.
 */

const { createTokenizer } = require('./tokenizer');

// ── Cache ─────────────────────────────────────────────────────────

const _cache = new Map();

// ── Public API ────────────────────────────────────────────────────

/**
 * Build (or retrieve from cache) the PK index for an ACL text.
 * @param {string} aclText - Raw decoded ACL text
 * @returns {{ byType: Map<string, Map<string, {block: string, id: number}>>, byId: Map<number, {type: string, pk: string, block: string}> }}
 */
function buildPkIndex(aclText) {
  let idx = _cache.get(aclText);
  if (idx) return idx;

  const byType = new Map();
  const byId = new Map();

  const arrayContent = _getPkArrayContent(aclText);
  if (!arrayContent) {
    idx = { byType, byId };
    _cache.set(aclText, idx);
    return idx;
  }

  const t = createTokenizer(arrayContent);
  let pos = 1; // skip opening [

  while (pos < arrayContent.length) {
    // Skip whitespace
    while (pos < arrayContent.length && ' \t\n\r'.includes(arrayContent[pos])) pos++;
    if (pos >= arrayContent.length || arrayContent[pos] === ']') break;
    if (arrayContent[pos] === ',') { pos++; continue; }
    if (arrayContent[pos] !== '{') { pos++; continue; }

    const entryEnd = t.findObjectEnd(pos);
    if (entryEnd === null) break;
    const entryBlock = arrayContent.substring(pos, entryEnd);

    // Extract $k (type-prefixed PK, e.g. "runway:01") — structural, no regex
    const entryT = createTokenizer(entryBlock);
    const kSec = entryT.findSection('$k');
    if (!kSec) { pos = entryEnd; continue; }
    // valueStart points to the opening " — skipString to extract value
    const kStrEnd = entryT.skipString(kSec.valueStart);
    if (!kStrEnd) { pos = entryEnd; continue; }
    const pk = entryBlock.substring(kSec.valueStart + 1, kStrEnd - 1);

    // Extract $v block
    const vBlock = _extractValueBlock(entryBlock, arrayContent, pos, entryEnd);
    if (!vBlock) { pos = entryEnd; continue; }

    // Extract $id — structural, no regex
    let id = null;
    const vT = createTokenizer(vBlock);
    const idSec = vT.findSection('$id');
    if (idSec) {
      const idText = vBlock.substring(idSec.valueStart, idSec.valueEnd);
      id = parseInt(idText, 10);
    }

    // Determine type from the pk prefix
    const colonIdx = pk.indexOf(':');
    const typePrefix = colonIdx >= 0 ? pk.substring(0, colonIdx) : pk;

    // Index by type
    if (!byType.has(typePrefix)) {
      byType.set(typePrefix, new Map());
    }
    byType.get(typePrefix).set(pk, { block: vBlock, id });

    // Index by $id
    if (id !== null) {
      byId.set(id, { type: typePrefix, pk, block: vBlock });
    }

    pos = entryEnd;
  }

  idx = { byType, byId };
  _cache.set(aclText, idx);
  return idx;
}

/**
 * Get all entries of a given type prefix.
 * @returns {Array<{pk: string, block: string, id: number|null}>}
 */
function getPkEntriesByType(pkIndex, typePrefix) {
  const typeMap = pkIndex.byType.get(typePrefix);
  if (!typeMap) return [];
  const entries = [];
  for (const [pk, { block, id }] of typeMap) {
    entries.push({ pk, block, id });
  }
  return entries;
}

/**
 * Resolve an $iref value to the referenced entity.
 * @param {object} pkIndex
 * @param {number|string} irefValue - The $iref target (e.g. 12345 or "12345")
 * @returns {{ type: string, pk: string, block: string } | null}
 */
function resolveIref(pkIndex, irefValue) {
  if (irefValue == null) return null;
  const id = typeof irefValue === 'number' ? irefValue : parseInt(irefValue, 10);
  if (isNaN(id)) return null;
  return pkIndex.byId.get(id) || null;
}

/**
 * Extract a PK-only lookup (no $iref resolution needed) for a given type.
 * Returns Map<pk, {block, id}> directly.
 */
function getTypeMap(pkIndex, typePrefix) {
  return pkIndex.byType.get(typePrefix) || new Map();
}

// ── Field extraction helpers ──────────────────────────────────────

/**
 * Extract a Vector3 from a v4 entity block.
 * Handles both:
 *   "Position": { "$type": 5, x, y, z }                  (AirwayNode)
 *   "ReactivePosition": { "$type": 4, { "$type": 5, x, y, z } }  (TaxiwayNode)
 * @returns {{x:number, y:number, z:number} | null}
 */
function extractVector3FromV4(block) {
  // Try bare Position first (AirwayNode)
  let match = _extractBareVector3(block, 'Position');
  if (match) return match;

  // Try ReactivePosition wrapper (TaxiwayNode) — contains nested {x,y,z}
  const rpIdx = block.indexOf('"ReactivePosition"');
  if (rpIdx >= 0) {
    // Skip past the wrapper object to find the inner Vector3
    // Pattern: "ReactivePosition": { "$type": 4, { "$type": 5, x, y, z } }
    const afterRp = block.substring(rpIdx);
    // Find the second opening brace (the inner Vector3)
    let braceCount = 0;
    let innerStart = -1;
    for (let i = afterRp.indexOf('{') + 1; i < afterRp.length; i++) {
      if (afterRp[i] === '{') {
        if (braceCount === 0) { innerStart = i; break; }
        braceCount++;
      } else if (afterRp[i] === '}') {
        braceCount--;
      }
    }
    if (innerStart >= 0) {
      // Now extract x, y, z from this position
      const innerBlock = afterRp.substring(innerStart);
      return _extractBareVector3(innerBlock, null);
    }
  }

  return null;
}

function _extractBareVector3(block, keyName) {
  // If keyName provided, search from that key. Otherwise parse from start of block.
  let searchText = block;
  if (keyName) {
    const keyIdx = block.indexOf('"' + keyName + '"');
    if (keyIdx < 0) return null;
    searchText = block.substring(keyIdx);
  }

  // Find the first opening brace
  let pos = searchText.indexOf('{');
  if (pos < 0) return null;

  // Find the matching closing brace (string-aware)
  let braceStart = -1;
  let depth = 0;
  for (let i = 0; i < searchText.length; i++) {
    if (searchText[i] === '{') {
      depth++;
      if (braceStart < 0) braceStart = i;
    } else if (searchText[i] === '}') {
      depth--;
      if (depth === 0 && braceStart >= 0) {
        // Found the object — extract numbers from between braces
        const objText = searchText.substring(braceStart + 1, i);

        // Skip optional "$type": N, part — structural, no regex
        let numText = objText;
        const tTypeIdx = numText.indexOf('"$type"');
        if (tTypeIdx >= 0) {
          const tColon = numText.indexOf(':', tTypeIdx);
          if (tColon >= 0) {
            let tAfter = tColon + 1;
            while (tAfter < numText.length && ' \t\n\r'.includes(numText[tAfter])) tAfter++;
            // Skip the $type value (quoted string or bare number)
            if (tAfter < numText.length && numText[tAfter] === '"') {
              const tStrEnd = numText.indexOf('"', tAfter + 1);
              if (tStrEnd >= 0) tAfter = tStrEnd + 1;
            } else {
              while (tAfter < numText.length && (numText[tAfter] >= '0' && numText[tAfter] <= '9')) tAfter++;
            }
            // Skip trailing comma after $type value
            while (tAfter < numText.length && ' \t\n\r'.includes(numText[tAfter])) tAfter++;
            if (tAfter < numText.length && numText[tAfter] === ',') tAfter++;
            numText = numText.substring(tAfter);
          }
        }

        // Strip leading/trailing commas and whitespace — structural, no regex
        let cStart = 0, cEnd = numText.length;
        while (cStart < cEnd && ' \t\n\r,'.includes(numText[cStart])) cStart++;
        while (cEnd > cStart && ' \t\n\r,'.includes(numText[cEnd - 1])) cEnd--;
        const cleanText = numText.substring(cStart, cEnd);

        const parts = cleanText.split(',').map(s => parseFloat(s.trim()));
        if (parts.length >= 3 && parts.slice(0, 3).every(p => !isNaN(p))) {
          return { x: parts[0], y: parts[1], z: parts[2] };
        }
        return null;
      }
    }
  }
  return null;
}

/**
 * Extract a string value from a v4 $v block at depth 1 only.
 * Avoids matching nested fields with the same name (e.g. route "Name"
 * inside runway Routes array).
 * @param {string} block - The $v block text
 * @param {string} key - The field name to extract
 * @returns {string | null}
 */
function extractStringFromV4(block, key) {
  let depth = 0;
  const searchStr = '"' + key + '"';
  for (let i = 0; i < block.length - searchStr.length; i++) {
    if (block[i] === '{') depth++;
    else if (block[i] === '}') depth--;
    else if (depth === 1 && block.substring(i, i + searchStr.length) === searchStr) {
      const colonPos = block.indexOf(':', i + searchStr.length);
      if (colonPos > 0) {
        let vs = colonPos + 1;
        while (vs < block.length && ' \t\n\r'.includes(block[vs])) vs++;
        if (block[vs] === '"') {
          const ve = block.indexOf('"', vs + 1);
          if (ve > vs) return block.substring(vs + 1, ve);
        }
      }
      return null;
    }
  }
  return null;
}

/**
 * Extract an array of $iref values from a nested $rcontent block.
 * e.g., "AirwayNodes": { "$rcontent": [$iref:11620, $iref:11619, ...] }
 * @param {string} block - Parent block containing the key
 * @param {string} key - The field name (e.g. "AirwayNodes", "Nodes")
 * @returns {number[]} Array of $iref target IDs
 */
function extractIrefArray(block, key) {
  const keyIdx = block.indexOf('"' + key + '"');
  if (keyIdx < 0) return [];

  const afterKey = block.substring(keyIdx);
  const rcIdx = afterKey.indexOf('"$rcontent"');
  if (rcIdx < 0) return [];

  const bracketIdx = afterKey.indexOf('[', rcIdx);
  if (bracketIdx < 0) return [];

  // Find matching ]
  let depth = 0;
  let endIdx = bracketIdx;
  for (let i = bracketIdx; i < afterKey.length; i++) {
    if (afterKey[i] === '[') depth++;
    else if (afterKey[i] === ']') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }

  const arrText = afterKey.substring(bracketIdx, endIdx);
  const irefs = [];
  // Manual scan for $iref:N — structural, no regex
  let si = 0;
  while ((si = arrText.indexOf('$iref:', si)) !== -1) {
    si += 6; // skip past "$iref:"
    // Optional space after colon
    while (si < arrText.length && ' \t'.includes(arrText[si])) si++;
    let numStart = si;
    while (si < arrText.length && arrText[si] >= '0' && arrText[si] <= '9') si++;
    if (si > numStart) {
      irefs.push(parseInt(arrText.substring(numStart, si), 10));
    }
  }
  return irefs;
}

/**
 * Extract an integer value at depth 1 from a v4 $v block.
 */
function extractIntFromV4(block, key) {
  let depth = 0;
  const searchStr = '"' + key + '"';
  for (let i = 0; i < block.length - searchStr.length; i++) {
    if (block[i] === '{') depth++;
    else if (block[i] === '}') depth--;
    else if (depth === 1 && block.substring(i, i + searchStr.length) === searchStr) {
      const colonPos = block.indexOf(':', i + searchStr.length);
      if (colonPos > 0) {
        // Manual number parsing — structural, no regex
        let vs = colonPos + 1;
        while (vs < block.length && ' \t\n\r'.includes(block[vs])) vs++;
        if (vs < block.length) {
          let sign = 1;
          if (block[vs] === '-') { sign = -1; vs++; }
          let numStart = vs;
          while (vs < block.length && block[vs] >= '0' && block[vs] <= '9') vs++;
          if (vs > numStart) return sign * parseInt(block.substring(numStart, vs), 10);
        }
      }
      return null;
    }
  }
  return null;
}

// ── Internal helpers ──────────────────────────────────────────────

/**
 * Navigate to StaticData.$blobdoc.PKStaticEntities.$rcontent and return
 * the array content string, or null.
 */
function _getPkArrayContent(text) {
  const t = createTokenizer(text);
  const sdSec = t.findSection('StaticData');
  if (!sdSec) return null;

  const sdText = t.substring(sdSec.valueStart, sdSec.valueEnd);
  const sdT = createTokenizer(sdText);

  const bdSec = sdT.findSection('$blobdoc');
  if (!bdSec) return null;

  const bdText = sdT.substring(bdSec.valueStart, bdSec.valueEnd);
  const bdT = createTokenizer(bdText);

  const pkSec = bdT.findSection('PKStaticEntities');
  if (!pkSec) return null;

  const pkText = bdT.substring(pkSec.valueStart, pkSec.valueEnd);
  const pkT = createTokenizer(pkText);

  const rcSec = pkT.findSection('$rcontent');
  if (!rcSec) return null;

  const rcStart = rcSec.valueStart;
  if (pkText[rcStart] !== '[') return null;

  const rcEnd = pkT.findArrayEnd(rcStart);
  if (rcEnd === null) return null;

  return pkText.substring(rcStart, rcEnd);
}

function _extractValueBlock(entryBlock, fullArrayContent, entryStart, entryEnd) {
  // Find "$v" key within this entry
  const vIdx = entryBlock.indexOf('"$v"');
  if (vIdx < 0) return null;

  let colonIdx = vIdx;
  while (colonIdx < entryBlock.length && entryBlock[colonIdx] !== ':') colonIdx++;
  let vStart = colonIdx + 1;
  while (vStart < entryBlock.length && ' \t\n\r'.includes(entryBlock[vStart])) vStart++;
  if (vStart >= entryBlock.length || entryBlock[vStart] !== '{') return null;

  // Use tokenizer to find matching }
  const t = createTokenizer(entryBlock);
  const vEnd = t.findObjectEnd(vStart);
  if (vEnd === null) return null;

  return entryBlock.substring(vStart, vEnd);
}

/**
 * Extract a single $iref value from a named field in a v4 $v block.
 * Handles fields whose value is directly $iref:N (e.g. TailPosition, NosePosition).
 * @param {string} block - The $v block text
 * @param {string} key - The field name (e.g. "TailPosition")
 * @returns {number | null}
 */
function extractSingleIref(block, key) {
  const keyIdx = block.indexOf('"' + key + '"');
  if (keyIdx < 0) return null;
  let pos = block.indexOf(':', keyIdx);
  if (pos < 0) return null;
  pos++;
  while (pos < block.length && ' \t\n\r'.includes(block[pos])) pos++;
  // Check for $iref:N format
  if (pos + 6 <= block.length && block.substring(pos, pos + 6) === '$iref:') {
    pos += 6;
    while (pos < block.length && ' \t'.includes(block[pos])) pos++;
    let numStart = pos;
    while (pos < block.length && block[pos] >= '0' && block[pos] <= '9') pos++;
    if (pos > numStart) return parseInt(block.substring(numStart, pos), 10);
  }
  return null;
}

module.exports = {
  buildPkIndex,
  getPkEntriesByType,
  getTypeMap,
  resolveIref,
  extractVector3FromV4,
  extractStringFromV4,
  extractIrefArray,
  extractSingleIref,
  extractIntFromV4,
};
