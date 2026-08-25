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

  // v4 schema: use pkIndex for systematic extraction (avoids manual text scanning)
  const { buildPkIndex, extractStringFromV4 } = require('./v4_pk_index');
  const pkIndex = buildPkIndex(text);

  // Runways: pkIndex.byType.get('runway') → extractStringFromV4(block, 'Name')
  const rwMap = pkIndex.byType.get('runway');
  if (rwMap) {
    for (const [pk, entry] of rwMap) {
      const name = extractStringFromV4(entry.block, 'Name');
      if (name) {
        runwayNameToGuid[name] = pk;
        runwayGuidToName[pk] = name;
      }
    }
  }

  // Stands: pkIndex.byType.get('stand') → extractStringFromV4(block, 'Identifier')
  const stMap = pkIndex.byType.get('stand');
  if (stMap) {
    for (const [pk, entry] of stMap) {
      const id = extractStringFromV4(entry.block, 'Identifier');
      if (id) {
        standIdToGuid[id] = pk;
        standGuidToId[pk] = id;
      }
    }
  }

  return { runwayNameToGuid, standIdToGuid, runwayGuidToName, standGuidToId };
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
  // v4: stand positions from PKStaticEntities (TailPosition/NosePosition $iref)
  const { buildPkIndex, getPkEntriesByType, resolveIref, extractVector3FromV4, extractStringFromV4, extractSingleIref } = require('./v4_pk_index');
  const pkIndex = buildPkIndex(text);
  const stands = getPkEntriesByType(pkIndex, 'stand');
  const result = {};

  for (const st of stands) {
    const identifier = extractStringFromV4(st.block, 'Identifier');
    if (!identifier) continue;

    // Extract TailPosition/NosePosition $iref — structural, no regex
    const tailIref = extractSingleIref(st.block, 'TailPosition');
    const noseIref = extractSingleIref(st.block, 'NosePosition');

    if (tailIref !== null && noseIref !== null) {
      const tailRef = resolveIref(pkIndex, tailIref);
      const noseRef = resolveIref(pkIndex, noseIref);
      const tailPos = tailRef ? extractVector3FromV4(tailRef.block) : null;
      const nosePos = noseRef ? extractVector3FromV4(noseRef.block) : null;
      if (tailPos && nosePos) {
        const dx = nosePos.x - tailPos.x;
        const dz = nosePos.z - tailPos.z;
        let heading = Math.atan2(-dz, dx) * RAD_TO_DEG;
        heading = ((heading % 360) + 360) % 360;
        result[identifier] = {
          x: (tailPos.x + nosePos.x) / 2,
          y: (tailPos.z + nosePos.z) / 2, // z in 3D = y in 2D map
          heading,
          tailX: tailPos.x, tailZ: tailPos.z,
          noseX: nosePos.x, noseZ: nosePos.z,
        };
        continue;
      }
    }

    // Fallback: use whichever position is available
    if (tailIref !== null) {
      const tailRef = resolveIref(pkIndex, tailIref);
      const tailPos = tailRef ? extractVector3FromV4(tailRef.block) : null;
      if (tailPos) {
        result[identifier] = { x: tailPos.x, y: tailPos.z, heading: 0 };
        continue;
      }
    }
    if (noseIref !== null) {
      const noseRef = resolveIref(pkIndex, noseIref);
      const nosePos = noseRef ? extractVector3FromV4(noseRef.block) : null;
      if (nosePos) {
        result[identifier] = { x: nosePos.x, y: nosePos.z, heading: 0 };
        continue;
      }
    }

    // Neither position resolved — skip this stand
    continue;
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
  // v4: areas are in StaticData.$blobdoc.NonPKStaticEntities.$rcontent
  const t = createTokenizer(text);
  const sdSec = t.findSection('StaticData');
  if (!sdSec) return {};

  const sdText = t.substring(sdSec.valueStart, sdSec.valueEnd);
  const sdT = createTokenizer(sdText);

  const bdSec = sdT.findSection('$blobdoc');
  if (!bdSec) return {};

  const bdText = sdT.substring(bdSec.valueStart, bdSec.valueEnd);
  const bdT = createTokenizer(bdText);

  const npkSec = bdT.findSection('NonPKStaticEntities');
  if (!npkSec) return {};

  const npkText = bdT.substring(npkSec.valueStart, npkSec.valueEnd);
  const npkT = createTokenizer(npkText);

  const rcSec = npkT.findSection('$rcontent');
  if (!rcSec) return {};

  const rcStart = rcSec.valueStart;
  if (npkText[rcStart] !== '[') return {};

  const rcEnd = npkT.findArrayEnd(rcStart);
  if (!rcEnd) return {};

  // Extract content between [ and ]
  const contentText = npkText.substring(rcStart + 1, rcEnd);

  const result = {};
  const contentT = createTokenizer(contentText);
  let pos = 0;

  while (pos < contentText.length) {
    // Skip whitespace and commas
    while (pos < contentText.length && ' \t\n\r,'.includes(contentText[pos])) pos++;
    if (pos >= contentText.length) break;
    if (contentText[pos] !== '{') { pos++; continue; }

    const entryEnd = contentT.findObjectEnd(pos);
    if (!entryEnd) break;
    const entryBlock = contentText.substring(pos, entryEnd);

    // Filter: only Area entities (v4: 30, v5: 31 = ContextCross.Models.Area)
    // v5 changed type number from 30 to 31 — check by name instead of hard-coded number
    let isAreaEntity = false;
    if (entryBlock.includes('ContextCross.Models.Area')) {
      isAreaEntity = true;
    } else {
      const typeIdx = entryBlock.indexOf('"$type"');
      if (typeIdx >= 0) {
        const colonIdx = entryBlock.indexOf(':', typeIdx);
        if (colonIdx >= 0) {
          let vs = colonIdx + 1;
          while (vs < entryBlock.length && ' \t\n\r'.includes(entryBlock[vs])) vs++;
          if (vs < entryBlock.length && entryBlock[vs] === '"') {
            vs++;
            if (entryBlock.substring(vs, vs + 2) === '30' || entryBlock.substring(vs, vs + 2) === '31') isAreaEntity = true;
          } else {
            let numEnd = vs;
            while (numEnd < entryBlock.length && entryBlock[numEnd] >= '0' && entryBlock[numEnd] <= '9') numEnd++;
            const num = parseInt(entryBlock.substring(vs, numEnd), 10);
            if (num === 30 || num === 31) isAreaEntity = true;
          }
        }
      }
    }
    if (!isAreaEntity) {
      pos = entryEnd;
      continue;
    }

    // Extract $id → guid (structural, no regex)
    let guid = null;
    const idKeyIdx = entryBlock.indexOf('"$id"');
    if (idKeyIdx >= 0) {
      const colonIdx = entryBlock.indexOf(':', idKeyIdx);
      if (colonIdx >= 0) {
        let vs = colonIdx + 1;
        while (vs < entryBlock.length && ' \t\n\r'.includes(entryBlock[vs])) vs++;
        let numStart = vs;
        while (vs < entryBlock.length && entryBlock[vs] >= '0' && entryBlock[vs] <= '9') vs++;
        if (vs > numStart) {
          guid = entryBlock.substring(numStart, vs);
        }
      }
    }

    // Extract AreaType (integer 0, 1, or 2) — structural, no regex
    let areaType = null;
    const atIdx = entryBlock.indexOf('"AreaType"');
    if (atIdx >= 0) {
      const colonIdx = entryBlock.indexOf(':', atIdx);
      if (colonIdx >= 0) {
        let vs = colonIdx + 1;
        while (vs < entryBlock.length && ' \t\n\r'.includes(entryBlock[vs])) vs++;
        if (vs < entryBlock.length && entryBlock[vs] === '-') vs++;
        let numStart = vs;
        while (vs < entryBlock.length && entryBlock[vs] >= '0' && entryBlock[vs] <= '9') vs++;
        if (vs > numStart) {
          areaType = parseInt(entryBlock.substring(numStart, vs), 10);
        }
      }
    }

    // Extract NodePositions → points
    let points = [];
    const npIdx = entryBlock.indexOf('"NodePositions"');
    if (npIdx >= 0) {
      const colonIdx = entryBlock.indexOf(':', npIdx);
      if (colonIdx >= 0) {
        let valStart = colonIdx + 1;
        while (valStart < entryBlock.length && ' \t\n\r'.includes(entryBlock[valStart])) valStart++;
        if (valStart < entryBlock.length && entryBlock[valStart] === '{') {
          // Skip outer ReactiveProperty brace — find second { (unnamed List<Vector3>)
          const afterOuter = entryBlock.substring(valStart);
          let braceCount = 0;
          let innerStart = -1;
          for (let i = 1; i < afterOuter.length; i++) {
            if (afterOuter[i] === '{') {
              if (braceCount === 0) { innerStart = valStart + i; break; }
              braceCount++;
            } else if (afterOuter[i] === '}') {
              braceCount--;
            }
          }
          if (innerStart >= 0) {
            // Within inner List<Vector3> object, find $rcontent array
            const innerBlock = entryBlock.substring(innerStart);
            const rcIdxV3 = innerBlock.indexOf('"$rcontent"');
            if (rcIdxV3 >= 0) {
              const arrBracket = innerBlock.indexOf('[', rcIdxV3);
              if (arrBracket >= 0) {
                const innerT = createTokenizer(innerBlock);
                const arrEnd = innerT.findArrayEnd(arrBracket);
                if (arrEnd) {
                  const arrText = innerBlock.substring(arrBracket + 1, arrEnd);
                  points = _parseVec3Array_v4(arrText);
                }
              }
            }
          }
        }
      }
    }

    // Assemble if all required fields are present
    if (areaType !== null && guid !== null && points.length >= 3) {
      if (!result[areaType]) result[areaType] = [];
      result[areaType].push({ guid, enabled: true, points });
    }

    pos = entryEnd;
  }

  console.log('[scenery] _parseAreas v4: found',
    (result[0]?.length || 0), 'Type0,',
    (result[1]?.length || 0), 'Type1,',
    (result[2]?.length || 0), 'Type2,',
    'areas from NonPKStaticEntities');
  return result;
}

/**
 * Parse v4 Vector3 array elements into {x, z} points.
 * Each element: { "$type": 5, x, 0, z } or { "$type": "5|...", x, 0, z }
 * Structural (regex-free) parsing via brace-counting and char scanning.
 * @param {string} arrText - Content between [ and ] of a $rcontent array
 * @returns {Array<{x: number, z: number}>}
 */
function _parseVec3Array_v4(arrText) {
  const points = [];
  let i = 0;

  while (i < arrText.length) {
    // Skip to next opening brace
    while (i < arrText.length && arrText[i] !== '{') i++;
    if (i >= arrText.length) break;

    // Find matching closing brace (simple counter — Vector3 has no nested braces)
    const objStart = i;
    let depth = 1;
    i++;
    while (i < arrText.length && depth > 0) {
      if (arrText[i] === '{') depth++;
      else if (arrText[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) break;

    const vecBlock = arrText.substring(objStart, i);

    // Strip "$type" field — structural, no regex
    let numText = vecBlock;
    const typeIdx = numText.indexOf('"$type"');
    if (typeIdx >= 0) {
      const colon = numText.indexOf(':', typeIdx);
      if (colon >= 0) {
        let after = colon + 1;
        while (after < numText.length && ' \t\n\r'.includes(numText[after])) after++;
        // Skip $type value (quoted "5|..." or bare 5)
        if (after < numText.length && numText[after] === '"') {
          const qEnd = numText.indexOf('"', after + 1);
          if (qEnd >= 0) after = qEnd + 1;
        } else {
          while (after < numText.length && numText[after] >= '0' && numText[after] <= '9') after++;
        }
        // Skip whitespace and comma after $type value
        while (after < numText.length && ' \t\n\r'.includes(numText[after])) after++;
        if (after < numText.length && numText[after] === ',') after++;
        // Skip leading whitespace of the first value
        while (after < numText.length && ' \t\n\r'.includes(numText[after])) after++;
        numText = numText.substring(after);
      }
    }

    // Strip surrounding whitespace, commas, braces
    let start = 0, end = numText.length;
    while (start < end && ' \t\n\r,'.includes(numText[start])) start++;
    while (end > start && ' \t\n\r,'.includes(numText[end - 1])) end--;

    // Clean text now should be "x, 0, z" or "x, y, z"
    const cleanText = numText.substring(start, end);
    const parts = cleanText.split(',').map(s => parseFloat(s.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every(p => !isNaN(p))) {
      points.push({ x: parts[0], z: parts[2] }); // parts[1] is y (elevation), ignore
    }
  }

  return points;
}

module.exports = {
  _parseSceneryData,
  _parseStandPositions,
  _parseAreas,
};
