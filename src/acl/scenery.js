/**
 * SceneryData parser — extracts Runway Name→GUID and Stand Identifier→GUID maps.
 *
 * Uses the tokenizer to find structural boundaries instead of arbitrary
 * character lookahead windows, fixing the 3000-char window fragility.
 */

const { createTokenizer } = require('./tokenizer');
const { RAD_TO_DEG } = require('./constants');
const { _detectSchemaVersion } = require('./approach');

// ─── SceneryData parser ───────────────────────────────────────────

function _parseSceneryData(text, isV4) {
  // Auto-detect for backward compat with callers that don't pass isV4
  if (isV4 === undefined) {
    isV4 = _detectSchemaVersion(text) === 4;
  }
  const runwayNameToGuid = {};
  const standIdToGuid = {};
  const runwayGuidToName = {};
  const standGuidToId = {};

  if (isV4) {
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

  // v2/v3 schema: SceneryData section
  const t = createTokenizer(text);
  const sdSec = t.findSection('SceneryData');
  if (!sdSec) return { runwayNameToGuid, standIdToGuid, runwayGuidToName, standGuidToId };

  const sdText = t.substring(sdSec.valueStart, sdSec.valueEnd);
  const sdT = createTokenizer(sdText);

  // Parse Runways section — each entry is a $k (GUID) / $v (runway data) pair
  _extractDictEntries(sdText, sdT, 'Runways', 'Name', runwayNameToGuid, runwayGuidToName);

  // Parse Stands section — each entry is a $k (GUID) / $v (stand data) pair
  _extractDictEntries(sdText, sdT, 'Stands', 'Identifier', standIdToGuid, standGuidToId);

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
function _parseStandPositions(text, isV4) {
  // Auto-detect for backward compat with callers that don't pass isV4
  if (isV4 === undefined) {
    isV4 = _detectSchemaVersion(text) === 4;
  }
  if (isV4) {
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

      let x = null, y = null;
      if (tailIref !== null && noseIref !== null) {
        const tailRef = resolveIref(pkIndex, tailIref);
        const noseRef = resolveIref(pkIndex, noseIref);
        const tailPos = tailRef ? extractVector3FromV4(tailRef.block) : null;
        const nosePos = noseRef ? extractVector3FromV4(noseRef.block) : null;
        if (tailPos && nosePos) {
          // Midpoint of tail and nose positions
          x = (tailPos.x + nosePos.x) / 2;
          y = (tailPos.z + nosePos.z) / 2; // z in 3D = y in 2D map
        }
      }

      if (x === null || y === null) continue;
      result[identifier] = { x, y };
    }
    return result;
  }

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
function _parseAreas(text, isV4) {
  // Auto-detect for backward compat with callers that don't pass isV4
  if (isV4 === undefined) {
    isV4 = _detectSchemaVersion(text) === 4;
  }
  if (isV4) {
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

      // Filter: only Area entities (type alias 30 = ContextCross.Models.Area)
      let isAreaEntity = false;
      const typeIdx = entryBlock.indexOf('"$type"');
      if (typeIdx >= 0) {
        const colonIdx = entryBlock.indexOf(':', typeIdx);
        if (colonIdx >= 0) {
          let vs = colonIdx + 1;
          while (vs < entryBlock.length && ' \t\n\r'.includes(entryBlock[vs])) vs++;
          if (vs < entryBlock.length && entryBlock[vs] === '"') {
            // Quoted form: "30" or "30|ContextCross.Models.Area,..."
            vs++;
            if (entryBlock.substring(vs, vs + 2) === '30') isAreaEntity = true;
          } else {
            // Bare form: 30
            let numEnd = vs;
            while (numEnd < entryBlock.length && entryBlock[numEnd] >= '0' && entryBlock[numEnd] <= '9') numEnd++;
            if (parseInt(entryBlock.substring(vs, numEnd), 10) === 30) isAreaEntity = true;
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
