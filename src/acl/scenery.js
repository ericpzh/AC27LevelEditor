/**
 * SceneryData parser — extracts Runway Name→GUID and Stand Identifier→GUID maps.
 *
 * Uses the tokenizer to find structural boundaries instead of arbitrary
 * character lookahead windows, fixing the 3000-char window fragility.
 */

const { createTokenizer } = require('./tokenizer');

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

module.exports = {
  _parseSceneryData,
};
