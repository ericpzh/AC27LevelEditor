/**
 * End-to-end test: _rebuildWorldStateSections
 * 
 * 1. Copies KJFK_07-09.acl → temp
 * 2. Parses existing FlightPlans to build test flights
 * 3. Modifies one flight (simulates editor edit)
 * 4. Calls _rebuildWorldStateSections
 * 5. Validates output
 */
const fs = require('fs');
const path = require('path');

const ACL_SRC = path.join(__dirname, '..', '..', 'GroundATC_Data', 'StreamingAssets', 'Airports', 'KJFK', 'Levels', 'KJFK_07-09.acl');
const ACL_TEMP = path.join(__dirname, '..', '..', 'GroundATC_Data', 'StreamingAssets', 'Airports', 'KJFK', 'Levels', '_test_rebuild.acl');

const parser = require('../src/acl_parser');

function check(condition, label) {
  if (condition) { console.log('  ✓ ' + label); return true; }
  else { console.log('  ✗ ' + label); return false; }
}

async function run() {
  console.log('Test: _rebuildWorldStateSections\n');

  // ── Step 1: Parse source ACL ──
  console.log('[1] Reading source ACL...');
  const srcText = fs.readFileSync(ACL_SRC, 'utf-8');
  console.log('  Source size: ' + (srcText.length / 1024).toFixed(0) + ' KB');

  // Parse FlightPlans to get existing flights
  const fpData = parser._parseWorldStateFlightPlans(srcText);
  if (!fpData || !fpData.flights || fpData.flights.length === 0) {
    console.error('  FAILED: Could not parse FlightPlans from source');
    process.exit(1);
  }
  console.log('  Parsed ' + fpData.flights.length + ' flights from FlightPlans');

  // ── Step 2: Simulate edit (modify first flight's airline) ──
  console.log('\n[2] Simulating edit...');
  const testFlights = [...fpData.flights];
  const changedFlight = { ...testFlights[0] };
  changedFlight.AirlineName = (changedFlight.AirlineName || 'TEST') + '_EDITED';
  changedFlight.Voice = 'ChangedVoice';
  testFlights[0] = changedFlight;
  console.log('  Modified flight: ' + changedFlight.CallSign + ' → Airline=' + changedFlight.AirlineName);

  // ── Step 3: Copy to temp ──
  console.log('\n[3] Copying to temp...');
  fs.copyFileSync(ACL_SRC, ACL_TEMP);
  console.log('  Copied to: ' + path.basename(ACL_TEMP));

  // ── Step 4: Run rebuild ──
  console.log('\n[4] Running _rebuildWorldStateSections...');
  try {
    parser._rebuildWorldStateSections(ACL_TEMP, testFlights);
    console.log('  Rebuild completed');
  } catch (err) {
    console.error('  FAILED:', err.message);
    process.exit(1);
  }

  // ── Step 5: Validate output ──
  console.log('\n[5] Validating output...');
  const outText = fs.readFileSync(ACL_TEMP, 'utf-8');
  const outSize = outText.length;
  console.log('  Output size: ' + (outSize / 1024).toFixed(0) + ' KB (source: ' + (srcText.length / 1024).toFixed(0) + ' KB)');

  let allPassed = true;

  // Check WorldState still exists
  allPassed &= check(outText.includes('"WorldState"'), 'WorldState section present');

  // Check Aircrafts is empty
  const acMatch = outText.match(/"Aircrafts"[\s\S]*?"\$rlength"\s*:\s*(\d+)/);
  if (acMatch) {
    const acRl = parseInt(acMatch[1], 10);
    allPassed &= check(acRl === 0, 'Aircrafts $rlength == 0 (got ' + acRl + ')');
  } else {
    allPassed &= check(false, 'Aircrafts $rlength found');
  }

  // Check FlightPlans has correct count
  const fpMatch = outText.match(/"FlightPlans"[\s\S]*?"\$rlength"\s*:\s*(\d+)/);
  if (fpMatch) {
    const fpRl = parseInt(fpMatch[1], 10);
    allPassed &= check(fpRl === testFlights.length, 'FlightPlans $rlength == ' + testFlights.length + ' (got ' + fpRl + ')');
  } else {
    allPassed &= check(false, 'FlightPlans $rlength found');
  }

  // Check the edited airline exists in output
  allPassed &= check(outText.includes(changedFlight.AirlineName), 'Edited AirlineName present in output');
  allPassed &= check(outText.includes('ChangedVoice'), 'Changed Voice present in output');

  // Check SceneryData is preserved (not touched)
  allPassed &= check(outText.includes('"SceneryData"'), 'SceneryData section preserved');
  allPassed &= check(outText.includes('"Runways"'), 'SceneryData.Runways preserved');

  // Check RunwayTimeline (embedded in ACL) is preserved
  allPassed &= check(outText.includes('"RunwayTimeline"'), 'RunwayTimeline section preserved');

  // Locate FlightPlans section boundary (used for multiple checks below)
  const fpStartIdx = outText.indexOf('"FlightPlans"');
  const afterFp = outText.substring(fpStartIdx);
  const fpEndIdx = afterFp.search(/\]\s*\}/);
  const fpSection = afterFp.substring(0, fpEndIdx);

  // Check no orphan entries: old FlightPlan GUIDs should NOT appear in FlightPlans section
  const oldGuidInFp = fpSection.includes('519e85a8-394b-43c7-be53-abd3940d0bcc');
  allPassed &= check(!oldGuidInFp, 'Old FlightPlan GUID NOT present in new FlightPlans');

  // Check zero $k entries in Aircrafts $rcontent
  const acStartIdx = outText.indexOf('"Aircrafts"');
  const afterAc = outText.substring(acStartIdx);
  const acEndIdx = afterAc.search(/\]\s*\}/);
  const acKCount = (afterAc.substring(0, acEndIdx).match(/"\$k":/g) || []).length;
  allPassed &= check(acKCount === 0, 'Aircrafts $rcontent has 0 $k entries (got ' + acKCount + ')');

  // Check FlightPlans $k count matches test flights
  const fpKCount = (fpSection.match(/"\$k":/g) || []).length;
  allPassed &= check(fpKCount === testFlights.length, 'FlightPlans $k entries == ' + testFlights.length + ' (got ' + fpKCount + ')');

  // ── Step 6: Cleanup ──
  console.log('\n[6] Cleaning up temp file...');
  try { fs.unlinkSync(ACL_TEMP); console.log('  Removed temp file'); } catch (_) {}

  console.log('\n' + (allPassed ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'));
  process.exit(allPassed ? 0 : 1);
}

run();
