/**
 * End-to-end test: _rebuildWorldStateSections
 *
 * Verify that _rebuildWorldStateSections correctly rebuilds the FlightPlans and
 * Aircrafts sections from flight data, preserving all other ACL content.
 *
 * Usage: node test/test_rebuild_sections.js --acl <path-to-.acl-file>
 *
 * The test copies the ACL to a temp file in test/, modifies one flight,
 * runs _rebuildWorldStateSections, and validates the output.
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

console.log('Test: _rebuildWorldStateSections');
console.log('ACL:  ' + aclSrc);
console.log('Temp: ' + path.basename(ACL_TEMP) + '\n');

// [1] Parse source ACL
console.log('[1] Reading source ACL...');
const srcText = readAclText(aclSrc);
console.log('  Source size: ' + (srcText.length / 1024).toFixed(0) + ' KB');

// Parse FlightPlans to get existing flights
const fpData = parser._parseWorldStateFlightPlans(srcText, false);
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
console.log('\n[4] Running _rebuildWorldStateSections...');
try {
  parser._rebuildWorldStateSections(ACL_TEMP, testFlights);
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

// WorldState still exists
allPassed &= check(outText.includes('"WorldState"'), 'WorldState section present');

// Aircrafts is empty
const acMatch = outText.match(/"Aircrafts"[\s\S]*?"\$rlength"\s*:\s*(\d+)/);
if (acMatch) {
  allPassed &= check(parseInt(acMatch[1], 10) === 0, 'Aircrafts $rlength == 0 (got ' + acMatch[1] + ')');
} else {
  allPassed &= check(false, 'Aircrafts $rlength found');
}

// FlightPlans has correct count
const fpMatch = outText.match(/"FlightPlans"[\s\S]*?"\$rlength"\s*:\s*(\d+)/);
if (fpMatch) {
  allPassed &= check(parseInt(fpMatch[1], 10) === testFlights.length,
    'FlightPlans $rlength == ' + testFlights.length + ' (got ' + fpMatch[1] + ')');
} else {
  allPassed &= check(false, 'FlightPlans $rlength found');
}

// Edited data present
allPassed &= check(outText.includes(changedFlight.AirlineName), 'Edited AirlineName present in output');
allPassed &= check(outText.includes('ChangedVoice'), 'Changed Voice present in output');

// SceneryData preserved
allPassed &= check(outText.includes('"SceneryData"'), 'SceneryData section preserved');
allPassed &= check(outText.includes('"Runways"'), 'SceneryData.Runways preserved');

// RunwayTimeline preserved
allPassed &= check(outText.includes('"RunwayTimeline"'), 'RunwayTimeline section preserved');

// Locate FlightPlans section for deeper checks
const fpStartIdx = outText.indexOf('"FlightPlans"');
const afterFp = outText.substring(fpStartIdx);
const fpEndIdx = afterFp.search(/\]\s*\}/);
const fpSection = afterFp.substring(0, fpEndIdx);

// No orphan GUIDs
const oldGuidInFp = fpSection.includes('519e85a8-394b-43c7-be53-abd3940d0bcc');
allPassed &= check(!oldGuidInFp, 'Old FlightPlan GUID NOT present in new FlightPlans');

// Zero $k entries in Aircrafts
const acStartIdx = outText.indexOf('"Aircrafts"');
const afterAc = outText.substring(acStartIdx);
const acEndIdx = afterAc.search(/\]\s*\}/);
const acKCount = (afterAc.substring(0, acEndIdx).match(/"\$k":/g) || []).length;
allPassed &= check(acKCount === 0, 'Aircrafts $rcontent has 0 $k entries (got ' + acKCount + ')');

// FlightPlans $k matches test flights
const fpKCount = (fpSection.match(/"\$k":/g) || []).length;
allPassed &= check(fpKCount === testFlights.length,
  'FlightPlans $k entries == ' + testFlights.length + ' (got ' + fpKCount + ')');

// [6] Cleanup
console.log('\n[6] Cleaning up temp file...');
cleanup();
console.log('  Removed temp file');

console.log('\n' + (allPassed ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'));
process.exit(allPassed ? 0 : 1);
