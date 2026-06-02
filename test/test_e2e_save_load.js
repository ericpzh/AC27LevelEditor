/**
 * End-to-End Save/Load Test
 *
 * Verifies that load → snapshot → sort → save → load produces the same flight data.
 * The test NEVER modifies the original files — all writes go to temp files in test/.
 *
 * Usage: node test/test_e2e_save_load.js --acl <path-to-.acl-file>
 *
 * The test needs the .acl file + its paired .csv and .aclcfg (derived automatically).
 */
const fs = require('fs');
const path = require('path');
const parser = require('../src/acl_parser');

// ─── CLI ──────────────────────────────────────────────────────
let aclOriginal = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--acl' && i + 1 < process.argv.length) {
    aclOriginal = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node test/test_e2e_save_load.js --acl <path-to-.acl-file>');
    console.log('  --acl   Path to the .acl file to round-trip test.');
    console.log('          CSV and .aclcfg paths are derived from the .acl path.');
    process.exit(0);
  }
}
if (!aclOriginal) {
  console.error('ERROR: --acl <path> is required.');
  console.error('Usage: node test/test_e2e_save_load.js --acl <path-to-.acl-file>');
  process.exit(1);
}

const TEST_DIR = __dirname;
const aclBase = path.basename(aclOriginal, '.acl');
const ACL_TEMP = path.join(TEST_DIR, '_e2e_temp_' + aclBase + '.acl');
const CSV_TEMP = path.join(TEST_DIR, '_e2e_temp_' + aclBase + '.csv');
const CFG_TEMP = path.join(TEST_DIR, '_e2e_temp_' + aclBase + '.aclcfg');

// Derive CSV path: from .aclcfg, or by convention
function findCsvPath(aclPath) {
  const cfgPath = aclPath.replace(/\.acl$/i, '.aclcfg');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.flightScheduleFile) {
        const csvPath = path.join(path.dirname(aclPath), cfg.flightScheduleFile + '.csv');
        if (fs.existsSync(csvPath)) return csvPath;
      }
    } catch (_) {}
  }
  // Fallback: look for flight_schedule_*.csv in same directory
  const dir = path.dirname(aclPath);
  const match = aclBase.match(/(\d{2})-(\d{2})/);
  if (match) {
    const csvPath = path.join(dir, 'flight_schedule_' + match[1] + '-' + match[2] + '.csv');
    if (fs.existsSync(csvPath)) return csvPath;
  }
  return null;
}

const CSV_ORIGINAL = findCsvPath(aclOriginal);
if (!CSV_ORIGINAL) {
  console.error('ERROR: Could not find CSV file for ' + aclOriginal);
  console.error('Make sure a flight_schedule_*.csv or .aclcfg with flightScheduleFile exists.');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────

function check(condition, label) {
  if (condition) { console.log('  ✓ ' + label); return true; }
  else { console.log('  ✗ ' + label); return false; }
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function compareFlights(original, roundtripped, label) {
  const diffs = [];
  if (original.length !== roundtripped.length) {
    diffs.push('Flight count mismatch: original=' + original.length + ' vs roundtripped=' + roundtripped.length);
    return diffs;
  }
  for (let i = 0; i < original.length; i++) {
    const a = original[i];
    const b = roundtripped[i];
    const prefix = label + ' [' + i + '] ' + (a.CallSign || b.CallSign || '?');
    if ((a.CallSign || '') !== (b.CallSign || ''))
      diffs.push(prefix + ': CallSign "' + a.CallSign + '" vs "' + b.CallSign + '"');
    for (const f of ['DepartureAirport', 'ArrivalAirport', 'Stand', 'Runway',
                      'AirlineName', 'AircraftType', 'Airway', 'Voice', 'Language']) {
      const va = (a[f] || '').trim();
      const vb = (b[f] || '').trim();
      if (va !== vb) diffs.push(prefix + ': ' + f + ' "' + va + '" vs "' + vb + '"');
    }
    for (const f of ['OffBlockTime', 'TakeoffTime', 'LandingTime', 'InBlockTime']) {
      const ta = (a[f] || '').trim();
      const tb = (b[f] || '').trim();
      if (ta !== tb) diffs.push(prefix + ': ' + f + ' "' + ta + '" vs "' + tb + '"');
    }
    const ra = a._Registration || '';
    const rb = b._Registration || '';
    if (ra !== rb) diffs.push(prefix + ': _Registration "' + ra + '" vs "' + rb + '"');
    if (!!a.isDeparture !== !!b.isDeparture)
      diffs.push(prefix + ': isDeparture ' + a.isDeparture + ' vs ' + b.isDeparture);
  }
  return diffs;
}

function cleanup() {
  for (const p of [ACL_TEMP, CSV_TEMP, CFG_TEMP]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }
  console.log('[cleanup] Removed temp files');
}

// ─── Main ─────────────────────────────────────────────────────

console.log('=== E2E Save/Load Test ===');
console.log('ACL:  ' + aclOriginal);
console.log('CSV:  ' + CSV_ORIGINAL);
console.log('Temp: ' + path.basename(ACL_TEMP));

// [1] Load original
console.log('\n[1] Loading original ACL...');
const originalData = parser.loadFlights(aclOriginal);
console.log('    Flights: ' + originalData.flights.length);
console.log('    Mode: ' + (originalData._fromFlightPlans ? 'FlightPlans' : originalData._fromWorldState ? 'WorldState' : 'Unknown'));

// [2] Snapshot (deep clone)
console.log('\n[2] Snapshotting flights (deep clone)...');
const snapshotFlights = deepClone(originalData.flights);

// [3] Sort chronologically
console.log('\n[3] Sorting snapshot chronologically...');
const sortedFlights = parser.sortFlightsChronologically(snapshotFlights);
console.log('    Sorted ' + sortedFlights.length + ' flights');

// [4] Copy to temp (patch .aclcfg to point to temp CSV name)
console.log('\n[4] Copying original → temp...');
fs.copyFileSync(aclOriginal, ACL_TEMP);
fs.copyFileSync(CSV_ORIGINAL, CSV_TEMP);
const origCfg = aclOriginal.replace(/\.acl$/i, '.aclcfg');
if (fs.existsSync(origCfg)) {
  let cfgText = fs.readFileSync(origCfg, 'utf-8');
  // Point flightScheduleFile to the temp CSV (strip .csv extension)
  const csvBase = path.basename(CSV_TEMP, '.csv');
  cfgText = cfgText.replace(/"flightScheduleFile"\s*:\s*"[^"]*"/, '"flightScheduleFile": "' + csvBase + '"');
  fs.writeFileSync(CFG_TEMP, cfgText);
}

// [5] Run generateFullAcl on temp
console.log('\n[5] Running generateFullAcl on temp copy...');
try {
  parser.generateFullAcl(
    ACL_TEMP,
    sortedFlights,
    originalData.before,
    originalData.after,
    originalData.originalBlocks,
    originalData.worldStateData,
    originalData.sceneryMaps,
    originalData._fromWorldState,
    originalData._fromFlightPlans
  );
  console.log('    Save complete.');
} catch (err) {
  console.error('    SAVE FAILED: ' + err.message);
  cleanup();
  process.exit(1);
}

// [6] Load the saved temp file back
console.log('\n[6] Loading saved temp file back...');
const roundtrippedData = parser.loadFlights(ACL_TEMP);
console.log('    Flights: ' + roundtrippedData.flights.length);

// [7] Sort both arrays identically for comparison
console.log('\n[7] Sorting both arrays identically for comparison...');
const originalSorted = parser.sortFlightsChronologically(deepClone(originalData.flights));
const roundtrippedSorted = parser.sortFlightsChronologically(deepClone(roundtrippedData.flights));

// [8] Compare
console.log('\n[8] Comparing flights...');
const diffs = compareFlights(originalSorted, roundtrippedSorted, 'Flight');

// [9] Cleanup
cleanup();

// [10] Report
console.log('\n=== Results ===');
if (diffs.length === 0) {
  console.log('✓ PASS — Load → Save → Load produces identical flight data');
  console.log('  ' + originalData.flights.length + ' flights matched perfectly');
  process.exit(0);
} else {
  console.log('✗ FAIL — ' + diffs.length + ' difference(s) found:');
  for (const d of diffs) console.log('  - ' + d);
  process.exit(1);
}
