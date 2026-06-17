/**
 * Quick scan: $rlength of TaxiwaySegments & TaxiwayNodes across all ZSJN ACLs.
 * Usage: node tests/integration/scan_rlengths.js
 */
const fs = require('fs');
const path = require('path');

const levelsDir = process.argv[2] ||
  'D:/SteamLibrary/steamapps/common/Airport Control 25 Playtest/GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels';

const aclFiles = fs.readdirSync(levelsDir)
  .filter(f => f.endsWith('.acl'))
  .sort();

console.log('File'.padEnd(52) + 'Segments  Nodes   Delta');
console.log('-'.repeat(85));

let baselineSegs = null;

for (const f of aclFiles) {
  const text = fs.readFileSync(path.join(levelsDir, f), 'utf-8');

  let segs = null, nodes = null;

  // Find "TaxiwaySegments" section, then its "$rlength"
  const tsIdx = text.indexOf('"TaxiwaySegments"');
  if (tsIdx >= 0) {
    const chunk = text.substring(tsIdx, tsIdx + 500);
    const m = chunk.match(/"\$rlength"\s*:\s*(\d+)/);
    if (m) segs = parseInt(m[1], 10);
  }

  // Find "TaxiwayNodes" section, then its "$rlength"
  const tnIdx = text.indexOf('"TaxiwayNodes"');
  if (tnIdx >= 0) {
    const chunk = text.substring(tnIdx, tnIdx + 500);
    const m = chunk.match(/"\$rlength"\s*:\s*(\d+)/);
    if (m) nodes = parseInt(m[1], 10);
  }

  // Track baseline (first file with data)
  if (baselineSegs === null && segs !== null) baselineSegs = segs;

  const delta = (segs !== null && baselineSegs !== null) ? segs - baselineSegs : null;
  const deltaStr = delta !== null ? (delta > 0 ? `+${delta}` : delta === 0 ? ' 0' : `${delta}`) : '?';
  const flag = delta !== null && delta !== 0 ? ' ← DIFF' : '';

  console.log(
    f.padEnd(52) +
    String(segs ?? '?').padEnd(10) +
    String(nodes ?? '?').padEnd(8) +
    deltaStr + flag
  );
}

console.log('\nBaseline (first file): ' + baselineSegs + ' segments');
console.log('Files with different segment count may have incomplete taxiway data.');
