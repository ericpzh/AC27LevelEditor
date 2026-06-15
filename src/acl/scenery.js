/**
 * SceneryData parser — extracts Runway Name→GUID and Stand Identifier→GUID maps.
 *
 * Uses the tokenizer to find structural boundaries instead of arbitrary
 * character lookahead windows, fixing the 3000-char window fragility.
 */

const { createTokenizer } = require('./tokenizer');
const { RAD_TO_DEG } = require('./constants');

// ─── SceneryData parser ───────────────────────────────────────────

function _parseSceneryData(text) {
  const runwayNameToGuid = {};
  const standIdToGuid = {};
  const runwayGuidToName = {};
  const standGuidToId = {};

  const t = createTokenizer(text);
  const sdSec = t.findSection('SceneryData');
  if (!sdSec) {
    return { runwayNameToGuid, standIdToGuid, runwayGuidToName, standGuidToId };
  }

  const sdText = t.substring(sdSec.valueStart, sdSec.valueEnd);
  const sdT = createTokenizer(sdText);

  // Parse Runways section — each entry is a $k (GUID) / $v (runway data) pair
  _extractDictEntries(sdText, sdT, 'Runways', 'Name', runwayNameToGuid, runwayGuidToName);

  // Parse StandGroup stands section
  _extractDictEntries(sdText, sdT, 'StandGroup', 'Identifier', standIdToGuid, standGuidToId);

  return { runwayNameToGuid, standIdToGuid, runwayGuidToName, standGuidToId };
}

/**
 * Extract key→value mappings from a Unity $k/$v dictionary section.
 *
 * For each $k entry (GUID), finds its matching $v block and extracts
 * the named field via regex within that block.
 *
 * @param {string} parentText - Text of the parent section (SceneryData)
 * @param {object} parentT - Tokenizer for parentText
 * @param {string} dictKey - Section key name (e.g. "Runways", "StandGroup")
 * @param {string} valueField - Field name to extract from each $v block
 * @param {object} nameToGuid - Map to populate (field value → GUID)
 * @param {object} guidToName - Reverse map to populate (GUID → field value)
 */
function _extractDictEntries(parentText, parentT, dictKey, valueField, nameToGuid, guidToName) {
  const sec = parentT.findSection(dictKey);
  if (!sec) return;

  const secText = parentT.substring(sec.valueStart, sec.valueEnd);
  const secT = createTokenizer(secText);

  // Scan for $k entries (GUIDs)
  const kRe = /"\$k"\s*:\s*"([a-f0-9-]+)"/g;
  let km;
  while ((km = kRe.exec(secText)) !== null) {
    const guid = km[1];

    // Find the $v block for this $k entry
    const vKeyIdx = secText.indexOf('"$v"', km.index);
    if (vKeyIdx < 0) continue;

    const colonIdx = secText.indexOf(':', vKeyIdx);
    if (colonIdx < 0) continue;

    let vBlockStart = colonIdx + 1;
    while (vBlockStart < secText.length && ' \t\n\r'.includes(secText[vBlockStart])) vBlockStart++;

    if (vBlockStart >= secText.length || secText[vBlockStart] !== '{') continue;

    // Use tokenizer to find matching } — no arbitrary window needed
    const vBlockEnd = secT.findObjectEnd(vBlockStart);
    if (vBlockEnd === null) continue;

    const vBlock = secText.substring(vBlockStart, vBlockEnd);

    // Extract the desired field from the parsed $v block
    const fieldRe = new RegExp('"' + valueField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*"([^"]*)"');
    const fieldMatch = vBlock.match(fieldRe);
    if (fieldMatch) {
      nameToGuid[fieldMatch[1]] = guid;
      guidToName[guid] = fieldMatch[1];
    }
  }
}

/**
 * Extract stand (x, y) positions from SceneryData.
 *
 * Walks the Stands dictionary to get each stand's Identifier →
 * {TailPositionGuid, NosePositionGuid}, then looks up those GUIDs in
 * TaxiwayNodes to get actual Vector3 positions.  Returns the midpoint
 * of tail and nose as the stand centre.
 *
 * @param {string} text - Full .acl file text (raw, before pre-processing)
 * @returns {{ [standId: string]: { x: number, y: number } }}
 */
function _parseStandPositions(text) {
  const t = createTokenizer(text);
  const sdSec = t.findSection('SceneryData');
  if (!sdSec) return {};

  const sdText = t.substring(sdSec.valueStart, sdSec.valueEnd);
  const sdT = createTokenizer(sdText);

  // ── Step 1: Stands → { guid: { identifier, tailGuid, noseGuid } } ──
  const standsMap = {};

  const standsSec = sdT.findSection('Stands');
  if (standsSec) {
    const standsText = sdT.substring(standsSec.valueStart, standsSec.valueEnd);
    const standsStr = standsText;
    const kRe = /"\$k"\s*:\s*"([a-f0-9-]+)"/g;
    let km;

    while ((km = kRe.exec(standsStr)) !== null) {
      const guid = km[1];

      // Find the $v block
      const vKeyIdx = standsStr.indexOf('"$v"', km.index);
      if (vKeyIdx < 0) continue;
      const colonIdx = standsStr.indexOf(':', vKeyIdx);
      if (colonIdx < 0) continue;

      let vBlockStart = colonIdx + 1;
      while (vBlockStart < standsStr.length && ' \t\n\r'.includes(standsStr[vBlockStart])) vBlockStart++;
      if (vBlockStart >= standsStr.length || standsStr[vBlockStart] !== '{') continue;

      const vBlockEnd = _findObjectEnd(standsStr, vBlockStart);
      if (vBlockEnd === null) continue;
      const vBlock = standsStr.substring(vBlockStart, vBlockEnd);

      const idMatch = vBlock.match(/"Identifier"\s*:\s*"([^"]*)"/);
      if (!idMatch) continue;

      const tailMatch = vBlock.match(/"TailPositionGuid"\s*:\s*"([^"]*)"/);
      const noseMatch = vBlock.match(/"NosePositionGuid"\s*:\s*"([^"]*)"/);

      standsMap[guid] = {
        identifier: idMatch[1],
        tailGuid: tailMatch ? tailMatch[1] : null,
        noseGuid: noseMatch ? noseMatch[1] : null,
      };
    }
  }

  if (Object.keys(standsMap).length === 0) return {};

  // ── Step 2: TaxiwayNodes → { guid: { x, y } } ──────────────
  const nodesMap = {};

  const nodesSec = sdT.findSection('TaxiwayNodes');
  if (nodesSec) {
    const nodesText = sdT.substring(nodesSec.valueStart, nodesSec.valueEnd);
    const kRe = /"\$k"\s*:\s*"([a-f0-9-]+)"/g;
    let km;

    while ((km = kRe.exec(nodesText)) !== null) {
      const guid = km[1];

      const vKeyIdx = nodesText.indexOf('"$v"', km.index);
      if (vKeyIdx < 0) continue;
      const colonIdx = nodesText.indexOf(':', vKeyIdx);
      if (colonIdx < 0) continue;

      let vBlockStart = colonIdx + 1;
      while (vBlockStart < nodesText.length && ' \t\n\r'.includes(nodesText[vBlockStart])) vBlockStart++;
      if (vBlockStart >= nodesText.length || nodesText[vBlockStart] !== '{') continue;

      const vBlockEnd = _findObjectEnd(nodesText, vBlockStart);
      if (vBlockEnd === null) continue;
      const vBlock = nodesText.substring(vBlockStart, vBlockEnd);

      // Extract Position block
      const posIdx = vBlock.indexOf('"Position"');
      if (posIdx < 0) continue;

      const colonAfterPos = vBlock.indexOf(':', posIdx);
      if (colonAfterPos < 0) continue;

      let posStart = colonAfterPos + 1;
      while (posStart < vBlock.length && ' \t\n\r'.includes(vBlock[posStart])) posStart++;
      if (posStart >= vBlock.length || vBlock[posStart] !== '{') continue;

      const posEnd = _findObjectEnd(vBlock, posStart);
      if (posEnd === null) continue;
      const posBlock = vBlock.substring(posStart, posEnd);

      // Extract numeric values from Position.
      // Strip the $type field first (handles both "16" and "16|Full.Name" forms).
      const cleaned = posBlock.replace(/"\$type"\s*:\s*(?:\d+|\"[^\"]*\"),?\s*/, '');
      const nums = cleaned.match(/(-?[\d.eE+-]+)/g);
      if (nums && nums.length >= 3) {
        const x = parseFloat(nums[0]);
        const z = parseFloat(nums[2]); // nums[1] is elevation — ignore
        if (!isNaN(x) && !isNaN(z)) {
          nodesMap[guid] = { x, y: z };
        }
      }
    }
  }

  if (Object.keys(nodesMap).length === 0) return {};

  // ── Step 3: Compute stand centres ──────────────────────────
  const result = {};
  for (const [, stand] of Object.entries(standsMap)) {
    const tailPos = stand.tailGuid ? nodesMap[stand.tailGuid] : null;
    const nosePos = stand.noseGuid ? nodesMap[stand.noseGuid] : null;

    if (tailPos && nosePos) {
      const dx = nosePos.x - tailPos.x;
      const dz = nosePos.y - tailPos.y;  // pos.y is ACL-Z in nodesMap
      let heading = Math.atan2(-dz, dx) * RAD_TO_DEG;
      heading = ((heading % 360) + 360) % 360;  // normalize to [0, 360)
      result[stand.identifier] = {
        x: (tailPos.x + nosePos.x) / 2,
        y: (tailPos.y + nosePos.y) / 2,
        heading,
        tailX: tailPos.x, tailZ: tailPos.y,
        noseX: nosePos.x, noseZ: nosePos.y,
      };
    } else if (tailPos) {
      result[stand.identifier] = { x: tailPos.x, y: tailPos.y, heading: 0 };
    } else if (nosePos) {
      result[stand.identifier] = { x: nosePos.x, y: nosePos.y, heading: 0 };
    }
    // If neither position found, skip this stand
  }

  return result;
}

/**
 * Parse Area polygons from SceneryData.Areas.
 *
 * Areas is a Unity Dictionary<string, AreaState> serialized with $k/$v
 * entries inside a $rcontent array. Each $v block contains:
 *   - Guid (redundant with $k)
 *   - Enabled (boolean)
 *   - NodePositions: { $type: 15, $rlength: N, $rcontent: [Vector3, ...] }
 *   - AreaType: 0 (airport boundary), 1 (stand/apron), 2 (special)
 *
 * @param {string} text - Full .acl file text
 * @returns {{ [areaType: number]: Array<{ guid: string, enabled: boolean, points: Array<{x: number, z: number}> }> }}
 *   Groups areas by AreaType (0, 1, 2). Each area has a polygon of {x,z} game-unit coordinates.
 */
function _parseAreas(text) {
  const t = createTokenizer(text);
  const sdSec = t.findSection('SceneryData');
  if (!sdSec) return {};

  const sdText = t.substring(sdSec.valueStart, sdSec.valueEnd);
  const sdT = createTokenizer(sdText);

  const areasSec = sdT.findSection('Areas');
  if (!areasSec) return {};

  const areasText = sdT.substring(areasSec.valueStart, areasSec.valueEnd);
  if (!areasText) return {};

  // Find the $rcontent array enclosing the $k/$v entries
  const rcIdx = areasText.indexOf('"$rcontent"');
  if (rcIdx < 0) return {};

  const bracketIdx = areasText.indexOf('[', rcIdx);
  if (bracketIdx < 0) return {};

  const areasT = createTokenizer(areasText);
  const rcEnd = areasT.findArrayEnd(bracketIdx);
  if (!rcEnd) return {};

  const result = {};

  // Regex for Vector3 nodes inside NodePositions $rcontent arrays.
  // Form: { "$type": 16, x, 0, z } or { "$type": "16|...", x, 0, z }
  const VEC3_RE = /\{\s*"\$type"\s*:\s*(?:16|"16\|[^"]+")\s*,\s*([\d.eE+\-]+)\s*,\s*([\d.eE+\-]+)\s*,\s*([\d.eE+\-]+)\s*\}/g;

  // Walk the $rcontent array — each entry is { $k: "guid", $v: { ... } }
  const contentText = areasText.substring(bracketIdx + 1, rcEnd - 1);
  let pos = 0;
  while (pos < contentText.length) {
    // Skip whitespace and commas
    if (' \t\n\r,'.includes(contentText[pos])) { pos++; continue; }
    if (contentText[pos] !== '{') { pos++; continue; }

    const entryEnd = _findObjectEnd(contentText, pos);
    if (!entryEnd) break;

    const entryBlock = contentText.substring(pos, entryEnd);

    // Extract $k (GUID)
    const kMatch = entryBlock.match(/"\$k"\s*:\s*"([a-f0-9-]+)"/);
    const guid = kMatch ? kMatch[1] : null;

    // Find $v block within the entry
    const vKeyIdx = entryBlock.indexOf('"$v"');
    if (vKeyIdx >= 0 && guid) {
      const colonIdx = entryBlock.indexOf(':', vKeyIdx);
      if (colonIdx >= 0) {
        let vStart = colonIdx + 1;
        while (vStart < entryBlock.length && ' \t\n\r'.includes(entryBlock[vStart])) vStart++;
        if (vStart < entryBlock.length && entryBlock[vStart] === '{') {
          const vEnd = _findObjectEnd(entryBlock, vStart);
          if (vEnd) {
            const vBlock = entryBlock.substring(vStart, vEnd);

            // Extract AreaType (integer 0, 1, or 2)
            const atMatch = vBlock.match(/"AreaType"\s*:\s*(-?\d+)/);
            const areaType = atMatch ? parseInt(atMatch[1], 10) : null;

            // Extract Enabled (default true)
            const enabled = !(/["']Enabled["']\s*:\s*false/.test(vBlock));

            // Extract NodePositions array
            const npIdx = vBlock.indexOf('"NodePositions"');
            if (npIdx >= 0) {
              const npRcMatch = vBlock.substring(npIdx).match(/"\$rcontent"\s*:\s*\[/);
              if (npRcMatch) {
                const absRc = npIdx + npRcMatch.index + npRcMatch[0].length;
                const npEnd = _findArrayEndSimple(vBlock, absRc);
                if (npEnd) {
                  const arr = vBlock.substring(absRc, npEnd);
                  const points = [];
                  // Parse each Vector3 within this NodePositions array
                  let vm;
                  while ((vm = VEC3_RE.exec(arr)) !== null) {
                    points.push({ x: parseFloat(vm[1]), z: parseFloat(vm[3]) });
                  }
                  // Reset lastIndex for the next area entry (global regex)
                  VEC3_RE.lastIndex = 0;
                  if (points.length >= 3 && areaType !== null) {
                    if (!result[areaType]) result[areaType] = [];
                    result[areaType].push({ guid, enabled, points });
                  }
                }
              }
            }
          }
        }
      }
    }
    pos = entryEnd;
  }

  return result;
}

/**
 * Simple array end finder (not string-aware) — follows [ ] nesting.
 */
function _findArrayEndSimple(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * Simple brace-matcher (not string-aware) — safe for vBlock boundaries
 * because the tokenizer already found the correct start/end positions.
 */
function _findObjectEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

module.exports = {
  _parseSceneryData,
  _parseStandPositions,
  _parseAreas,
};
