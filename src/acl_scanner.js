/**
 * ACL Scanner - scans game root for all airports and their .acl levels.
 */
const fs = require('fs');
const path = require('path');

/**
 * Scan the game root directory for all .acl files.
 * @param {string} gameRoot - path to "Airport Control 25 Playtest"
 * @returns {{ airports: Array, totalFiles: number, error?: string }}
 */
function scanGameRoot(gameRoot) {
  const airportsDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports');
  if (!fs.existsSync(airportsDir)) {
    return { airports: [], totalFiles: 0, error: `Airports directory not found at: ${airportsDir}` };
  }

  const airports = [];
  const entries = fs.readdirSync(airportsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const airportIcao = entry.name;
    const levelsDir = path.join(airportsDir, airportIcao, 'Levels');
    if (!fs.existsSync(levelsDir)) continue;

    // Build set of .aclcfg base names (without extension)
    const cfgFiles = new Set();
    const levelEntries = fs.readdirSync(levelsDir, { withFileTypes: true });
    for (const le of levelEntries) {
      if (le.isFile() && le.name.endsWith('.aclcfg')) {
        cfgFiles.add(le.name.replace(/\.aclcfg$/, ''));
      }
    }

    // Only include .acl files that have a matching .aclcfg
    const aclFiles = [];
    for (const le of levelEntries) {
      if (le.isFile() && le.name.endsWith('.acl')) {
        const baseName = le.name.replace(/\.acl$/, '');
        if (cfgFiles.has(baseName)) {
          const aclPath = path.join(levelsDir, le.name);
          const cfgPath = path.join(levelsDir, baseName + '.aclcfg');
          aclFiles.push({
            filename: le.name,
            path: aclPath,
            cfgPath: cfgPath,
          });
        }
      }
    }

    if (aclFiles.length > 0) {
      airports.push({
        icao: airportIcao,
        levelsDir,
        aclFiles,
      });
    }
  }

  const totalFiles = airports.reduce((sum, a) => sum + a.aclFiles.length, 0);
  return { airports, totalFiles };
}

module.exports = { scanGameRoot };
