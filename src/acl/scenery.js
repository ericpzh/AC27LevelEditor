/**
 * SceneryData parser — extracts Runway Name→GUID and Stand Identifier→GUID maps.
 */

// ─── SceneryData parser ───────────────────────────────────────

function _parseSceneryData(text) {
  const runwayNameToGuid = {};
  const standIdToGuid = {};
  const runwayGuidToName = {};
  const standGuidToId = {};

  const sdIdx = text.indexOf('"SceneryData"');
  if (sdIdx < 0) return { runwayNameToGuid, standIdToGuid, runwayGuidToName, standGuidToId };

  const sdText = text.substring(sdIdx);

  // Parse Runways section
  const rwIdx = sdText.indexOf('"Runways"');
  if (rwIdx >= 0) {
    const rwSection = sdText.substring(rwIdx);
    const kRe = /"\$k"\s*:\s*"([a-f0-9-]+)"/g;
    let km;
    while ((km = kRe.exec(rwSection)) !== null) {
      const guid = km[1];
      const ahead = rwSection.substring(km.index, km.index + 3000);
      const nameMatch = ahead.match(/"Name"\s*:\s*"([^"]+)"/);
      if (nameMatch) {
        runwayNameToGuid[nameMatch[1]] = guid;
        runwayGuidToName[guid] = nameMatch[1];
      }
    }
  }

  // Parse StandGroup / Stands section
  const sgIdx = sdText.indexOf('"StandGroup"');
  if (sgIdx >= 0) {
    const sgSection = sdText.substring(sgIdx);
    const kRe = /"\$k"\s*:\s*"([a-f0-9-]+)"/g;
    let km;
    while ((km = kRe.exec(sgSection)) !== null) {
      const guid = km[1];
      const ahead = sgSection.substring(km.index, km.index + 3000);
      const idMatch = ahead.match(/"Identifier"\s*:\s*"([^"]+)"/);
      if (idMatch) {
        standIdToGuid[idMatch[1]] = guid;
        standGuidToId[guid] = idMatch[1];
      }
    }
  }

  return { runwayNameToGuid, standIdToGuid, runwayGuidToName, standGuidToId };
}

module.exports = {
  _parseSceneryData,
};
