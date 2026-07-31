/**
 * End-to-end test: _rebuildStaticDataSections
 *
 * Verify that _rebuildStaticDataSections correctly rebuilds the flight-plan
 * and static sections from flight data, preserving all other ACL content.
 *
 * Usage: node test/test_rebuild_sections.js --acl <path-to-.acl-file>
 *
 * The test copies the ACL to a temp file in test/, modifies one flight,
 * runs _rebuildStaticDataSections, and validates the output.
 */
const fs = require('fs');
const path = require('path');
const parser = require('../../src/acl/parser');
const { readAclText } = require('../../src/acl/gatcarc');

// ─── CLI ──────────────────────────────────────────────────────
let aclSrc = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--acl' && i + 1 < process.argv.length) {
    aclSrc = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node test/test_rebuild_sections.js --acl <path-to-.acl-file>');
    process.exit(0);
  }
}
if (!aclSrc) {
  console.error('ERROR: --acl <path> is required.');
  console.error('Usage: node test/test_rebuild_sections.js --acl <path-to-.acl-file>');
  process.exit(1);
}
if (!fs.existsSync(aclSrc)) {
  console.error('ERROR: File not found: ' + aclSrc);
  process.exit(1);
}

const ACL_TEMP = path.join(__dirname, '_e2e_temp_rebuild_sections.acl');

// ─── Helpers ──────────────────────────────────────────────────

function check(condition, label) {
  if (condition) { console.log('  ✓ ' + label); return true; }
  else { console.log('  ✗ ' + label); return false; }
}

function cleanup() {
  try { if (fs.existsSync(ACL_TEMP)) fs.unlinkSync(ACL_TEMP); } catch (_) {}
}

// ─── Main ─────────────────────────────────────────────────────

console.log('Test: _rebuildStaticDataSections');
console.log('ACL:  ' + aclSrc);
console.log('Temp: ' + path.basename(ACL_TEMP) + '\n');

// [1] Parse source ACL
console.log('[1] Reading source ACL...');
const srcText = readAclText(aclSrc);
console.log('  Source size: ' + (srcText.length / 1024).toFixed(0) + ' KB');

// Parse FlightPlans to get existing flights
const fpData = parser._parseWorldStateFlightPlans(srcText);
if (!fpData || !fpData.flights || fpData.flights.length === 0) {
  console.error('  FAILED: Could not parse FlightPlans from source');
  process.exit(1);
}
console.log('  Parsed ' + fpData.flights.length + ' flights from FlightPlans');

// [2] Simulate edit (modify first flight)
console.log('\n[2] Simulating edit...');
const testFlights = [...fpData.flights];
const changedFlight = { ...testFlights[0] };
changedFlight.AirlineName = (changedFlight.AirlineName || 'TEST') + '_EDITED';
changedFlight.Voice = 'ChangedVoice';
testFlights[0] = changedFlight;
console.log('  Modified flight: ' + changedFlight.CallSign + ' → Airline=' + changedFlight.AirlineName);

// [3] Copy to temp
console.log('\n[3] Copying to temp...');
fs.copyFileSync(aclSrc, ACL_TEMP);

// [4] Run rebuild
console.log('\n[4] Running _rebuildStaticDataSections...');
try {
  // The rebuild needs the approach cache for jetway DockingPositions,
  // same as the app's save path (electron/main.js).
  let approachCache = null;
  try { approachCache = require('../../src/acl/approach').buildApproachCache(path.dirname(aclSrc)); } catch (_) {}
  const cfg = parser._extractConfig(srcText) || {};
  parser._rebuildStaticDataSections(ACL_TEMP, testFlights, undefined, approachCache, cfg.startTime || null, null);
  console.log('  Rebuild completed');
} catch (err) {
  console.error('  FAILED: ' + err.message);
  cleanup();
  process.exit(1);
}

// [5] Validate output
console.log('\n[5] Validating output...');
const outText = readAclText(ACL_TEMP);
const outSize = outText.length;
console.log('  Output size: ' + (outSize / 1024).toFixed(0) + ' KB (source: ' + (srcText.length / 1024).toFixed(0) + ' KB)');

let allPassed = true;

// ── v4 validation: StaticItems rebuild + binary roundtrip ──
allPassed &= check(outText.includes('"StaticData"'), 'StaticData section present');

// Edited data present
allPassed &= check(outText.includes(changedFlight.AirlineName), 'Edited AirlineName present in output');
allPassed &= check(outText.includes('ChangedVoice'), 'Changed Voice present in output');

// Scenery preserved — v4 has no "SceneryData" section; scenery entities live
// inside StaticData.$blobdoc (taxiways, osm road entities)
allPassed &= check(outText.includes('"TaxiwayName"'), 'Scenery (taxiways) preserved');
allPassed &= check(outText.includes('"OsmId"'), 'Scenery (osm entities) preserved');

// RunwayTimeline preserved
allPassed &= check(outText.includes('"RunwayTimeline"'), 'RunwayTimeline section preserved');

// Reload through the v4 decode path: flight count + edited data must survive
// the binary re-encode (readAclText above already proved the container decodes)
const reloaded = parser.loadFlights(ACL_TEMP);
const reloadCount = reloaded && reloaded.flights ? reloaded.flights.length : 0;
allPassed &= check(reloadCount === testFlights.length,
  'Reload flight count == ' + testFlights.length + ' (got ' + reloadCount + ')');
const editedReloaded = reloaded && reloaded.flights.some(f => f.AirlineName === changedFlight.AirlineName);
allPassed &= check(!!editedReloaded, 'Edited AirlineName present after reload');

// [6] Cleanup
console.log('\n[6] Cleaning up temp file...');
cleanup();
console.log('  Removed temp file');

console.log('\n' + (allPassed ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'));
process.exit(allPassed ? 0 : 1);
